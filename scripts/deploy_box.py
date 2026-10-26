#!/usr/bin/env python3
"""Deploy the padify site + API code to the alwaysdata box over SSH.

Runs from GitHub Actions ("Deploy (alwaysdata box)" workflow) and locally.
Credentials come from the environment — the deploy key is the ONLY secret:

    AD_SSH_KEY   private key (OpenSSH format)  [required]
    AD_SSH_HOST  defaults: ssh-functionhost.alwaysdata.net
    AD_SSH_USER  defaults: functionhost

What it does (idempotent — re-running with nothing changed uploads nothing):

  1. Scans the box with one batched md5sum over site/, server/ and shared/.
  2. Uploads only the files whose md5 differs (one reused SFTP session —
     the box throttles new channels hard; opening one per file costs
     ~20s/file).
  3. Verifies every planned file's md5 after upload.
  4. Prunes stale hashed/mirrored trees (assets/, sounds/).
  5. SIGTERMs bun so the supervisor cold-boots the new server code.

The site must already be built into dist/ with the box recipe
(docs/CLOUD_SETUP.md §3):

    VITE_BASE_PATH=/padify/ \\
    VITE_API_BASE=https://functionhost.alwaysdata.net/padifyapi npm run build
"""
import hashlib
import io
import json
import os
import posixpath
import shlex
import subprocess
import sys
import time
import urllib.request

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(REPO, "dist")
REMOTE_ROOT = "/home/functionhost/padify"
REMOTE_SITE = f"{REMOTE_ROOT}/www/site"
REMOTE_SERVER = f"{REMOTE_ROOT}/server"
REMOTE_SHARED = f"{REMOTE_ROOT}/shared"

# The public face of the API — the deploy's restart verification polls it
# until the RUNNING process reports the build the script just uploaded.
HEALTH_URL = os.environ.get(
    "AD_HEALTH_URL", "https://functionhost.alwaysdata.net/padifyapi/api/health"
)


def md5(local):
    with open(local, "rb") as f:
        return hashlib.md5(f.read()).hexdigest()


def collect(root, only_ts=False):
    """rel-path -> absolute local path for every file under root."""
    out = {}
    for cur, _, files in os.walk(root):
        for name in files:
            if only_ts and not name.endswith(".ts"):
                continue
            local = os.path.join(cur, name)
            out[os.path.relpath(local, root)] = local
    return out


def connect():
    key_text = os.environ.get("AD_SSH_KEY", "").strip()
    if not key_text:
        raise SystemExit("AD_SSH_KEY is not set — see the workflow or the script header")
    # Tolerate a web-UI-style flattened key ("\n" escape sequences).
    if "\\n" in key_text:
        key_text = key_text.replace("\\n", "\n")
    try:
        key = paramiko.Ed25519Key.from_private_key(io.StringIO(key_text))
    except paramiko.SSHException:
        key = paramiko.RSAKey.from_private_key(io.StringIO(key_text))

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client.connect(
        os.environ.get("AD_SSH_HOST", "ssh-functionhost.alwaysdata.net"),
        username=os.environ.get("AD_SSH_USER", "functionhost"),
        pkey=key,
        look_for_keys=False,
        allow_agent=False,
        timeout=25,
    )
    return client


def run(client, cmd, timeout=300):
    _, stdout, stderr = client.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace")
    err = stderr.read().decode(errors="replace")
    code = stdout.channel.recv_exit_status()
    if code != 0:
        raise SystemExit(f"remote command failed ({code}): {cmd}\n{err[:500]}")
    return out


def remote_md5s(client, dirs):
    """One batched md5sum over several remote dirs -> {relpath: md5}."""
    script = " ; ".join(f"cd {shlex.quote(d)} && find . -type f -exec md5sum {{}} +" for d in dirs)
    result = {}
    for line in run(client, script).splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2:
            result[parts[1].strip().lstrip("./")] = parts[0]
    return result


def running_build(allow_errors=False):
    """(build_id, stale, reachable) from the box's public health endpoint.
    unreachable -> (None, False, False); a missing/old field ->
    (None, False, True). With allow_errors the unreachable case also
    returns (None, False, True) — "the API is down" is a legitimate
    intermediate state while bun is dying or cold-booting, and only the
    CALLER's deadline decides."""
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=6) as response:
            body = json.loads(response.read().decode("utf-8"))
            return body.get("build"), bool(body.get("stale")), True
    except Exception:
        return (None, False, True if allow_errors else False)


def ensure_self_retire(client):
    """Arm the server's self-retire so future deploys verify green.

    The health handler (server/routes.ts handleHealth) reads the stamp
    the deploy just wrote; with PADIFY_EXIT_ON_NEW_BUILD=1 in its
    environment, a RUNNING server that sees a newer stamp answers once
    more (stale: true) and exits — the supervisor cold-boots the fresh
    code, and the verification below converges WITHOUT this script
    having to signal a process it cannot even see (the serving bun has
    been observed on the platform's web node, outside the SSH user's
    process table). October's deploys failed exactly there: the files
    were fresh, the running process was not, and nothing this user
    could signal was the process that answered.

    Idempotent: patches the site's run.sh once (a timestamped backup
    rides along), skips silently when the export is already there.
    """
    path = f"{REMOTE_SERVER}/run.sh"
    current = run(client, f"cat {shlex.quote(path)} 2>/dev/null")
    if not current.strip():
        print("[retire] run.sh not found — the start command lives elsewhere; skipping")
        return
    if "PADIFY_EXIT_ON_NEW_BUILD" in current:
        print("[retire] run.sh already exports PADIFY_EXIT_ON_NEW_BUILD")
        return
    lines = current.splitlines(keepends=True)
    for i, line in enumerate(lines):
        if line.lstrip().startswith("exec "):
            lines.insert(i, "export PADIFY_EXIT_ON_NEW_BUILD=1\n")
            break
    else:
        print("[retire] no exec line in run.sh — skipping (unexpected shape)")
        return
    run(client, f"cp {shlex.quote(path)} {shlex.quote(path)}.bak-deploy")
    sftp = client.open_sftp()
    try:
        with sftp.open(path, "w") as handle:
            handle.write("".join(lines))
    finally:
        sftp.close()
    back = run(client, f"cat {shlex.quote(path)}")
    if "PADIFY_EXIT_ON_NEW_BUILD" not in back:
        raise SystemExit("run.sh patch did not stick — the self-retire would stay unarmed")
    print("[retire] run.sh now exports PADIFY_EXIT_ON_NEW_BUILD=1")


def restart_server(client, expected_build):
    """Kill the running bun and WAIT until the box serves this deploy.

    The old tail just SIGTERMed bun and trusted the supervisor's
    cold-boot — and one October deploy proved that trust misplaced: the
    files md5-verified fresh while the box kept answering from the
    previous process, and the share-expiry PATCH silently hit the legacy
    revoke branch (the user saw "update link" cancel their link).
    Kills are now followed by a probe-until-converged loop, escalating
    TERM -> KILL, and the deploy FAILS if the public health endpoint
    does not name `expected_build`.

    The kill targets `bun ... server/index.ts` specifically — the loose
    `pgrep -f bun` of the old tail matched anything with "bun" in its
    command line, and a kill that lands on the wrong pid is exactly the
    silent no-op this step exists to prevent. Every signal prints the
    cmdlines it is aimed at, and a failed verification dumps the box's
    full process table so the NEXT run's log explains itself.
    """
    deadline = time.time() + 480

    def server_pids():
        # Every user's match — the serving bun has been observed running
        # OUTSIDE the SSH user (functionhost's own table sat empty while
        # health answered). The kill below still sends what this user may
        # lawfully signal; an EPERM shows up in the kill's stderr and the
        # final dump names the owner for the next run.
        out = run(client, "pgrep -f 'bun.*server/index[.]ts' || true")
        return out.split()

    def describe(pids):
        if not pids:
            return "(none)"
        quoted = " ".join(shlex.quote(pid) for pid in pids)
        return run(client, f"ps -o pid=,args= -p {quoted} || true").strip() or "(gone)"

    def dump_process_table():
        # The serving process has already been proven to NOT belong to the
        # SSH user (functionhost's table was empty while health answered)
        # — dump EVERY user's bun/node/padify processes, then the match
        # with command lines, so the log names the real owner.
        for label, cmd in (
            ("every bun/node/padify process (any user)", "ps -eo user,pid,ppid,etime,args 2>/dev/null | grep -Ei 'bun|node|padify' | grep -v grep | head -30 || true"),
            ("any process matching server/index (any user)", "pgrep -a -f 'server/index' 2>/dev/null | head -10 || true"),
        ):
            out = run(client, cmd, timeout=60)
            print(f"[server] {label}:")
            if out.strip():
                for line in out.splitlines():
                    print(f"    {line}")
            else:
                print("    (none)")

    stage = "TERM"
    while time.time() < deadline:
        live = server_pids()
        if live:
            print(f"[server] kill -{stage} -> {describe(live)}")
            result = run(client, f"kill -{stage} {' '.join(live)} 2>&1 || true")
            if result.strip():
                print(f"[server] kill said: {result.strip()}")
            # Give the signal a beat to act, then look again.
            for _ in range(20):
                time.sleep(3)
                build, stale, _reachable = running_build(allow_errors=True)
                if build == expected_build:
                    print(f"[server] box serves build {expected_build} (after {stage})")
                    return
                if stale:
                    # The server read the new stamp and is exiting itself
                    # (PADIFY_EXIT_ON_NEW_BUILD=1) — the next boot is ours.
                    print("[server] running server saw the new stamp — exiting for the supervisor")
                if not server_pids():
                    break  # process is gone — let the supervisor boot the new code
        else:
            # Nothing matching is running: the next request cold-boots the
            # fresh code. If the endpoint KEEPS answering without ever
            # naming this build, whatever serves it is not the program we
            # just stamped — dump the table and say so. The window is a
            # generous two minutes: the supervisor's boot has been
            # observed slower than the old 12-second budget while the
            # platform kept the previous process warm.
            for _ in range(40):
                time.sleep(3)
                build, stale, _reachable = running_build(allow_errors=True)
                if build == expected_build:
                    print(f"[server] box serves build {expected_build} (cold boot)")
                    return
        if stage == "TERM":
            stage = "KILL"

    build, stale, reachable = running_build(allow_errors=True)
    print(f"[server] verification failed: endpoint answered build={build!r} stale={stale}, expected {expected_build!r}")
    print(f"[server] processes matching server/index.ts now: {describe(server_pids())}")
    dump_process_table()
    raise SystemExit(
        "RESTART VERIFICATION FAILED — the box is "
        + (f"serving build {build!r}" if reachable else "not answering")
        + f", expected {expected_build}. The files ARE fresh; the RUNNING "
        "process is not, and it runs on the platform's web node where "
        "neither SSH pids nor kills reach. One-time fix: restart the site "
        "from the alwaysdata panel (Web > Sites > Restart). For hands-off "
        "deploys from here on, add PADIFY_EXIT_ON_NEW_BUILD=1 to the "
        "site's start command — the server then exits itself when a "
        "deploy stamps a newer build, and this verification goes green."
    )


def deployed_sha():
    """The commit this checkout will deploy — the health endpoint reports
    it back after the restart. A timestamp stands in when git is not
    available (running outside a checkout); the verification only needs
    SOME string that changes with every deploy."""
    try:
        out = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=15,
        )
        sha = out.stdout.strip()
        if sha:
            return sha
    except Exception:
        pass
    return "local-" + time.strftime("%Y%m%dT%H%M%S")


def main():
    site = collect(DIST)
    server = collect(os.path.join(REPO, "server"), only_ts=True)
    shared = {"wire.ts": os.path.join(REPO, "shared", "wire.ts")}

    plan = {}  # remote abs path -> (local path, md5)
    for rel, local in site.items():
        plan[f"{REMOTE_SITE}/{rel}"] = (local, md5(local))
    for rel, local in server.items():
        plan[f"{REMOTE_SERVER}/{rel}"] = (local, md5(local))
    for rel, local in shared.items():
        plan[f"{REMOTE_SHARED}/{rel}"] = (local, md5(local))

    client = connect()
    print(f"[plan] {len(plan)} local files "
          f"({len(site)} site, {len(server)} server, {len(shared)} shared)")

    existing = remote_md5s(client, [REMOTE_SITE, REMOTE_SERVER, REMOTE_SHARED])
    existing_abs = {}
    for rel, digest in existing.items():
        for prefix in (REMOTE_SITE, REMOTE_SERVER, REMOTE_SHARED):
            existing_abs[f"{prefix}/{rel}"] = digest
    print(f"[scan] remote has {len(existing)} files")

    todo = [(rp, lp) for rp, (lp, d) in plan.items() if existing_abs.get(rp) != d]
    print(f"[diff] {len(todo)} files to upload")

    dirs_needed = sorted({posixpath.dirname(rp) for rp, _ in todo})
    if dirs_needed:
        run(client, "mkdir -p " + " ".join(shlex.quote(d) for d in dirs_needed), timeout=120)

    sftp = client.open_sftp()
    for i, (rp, lp) in enumerate(todo, 1):
        sftp.put(lp, rp)
        print(f"[put] ({i}/{len(todo)}) {rp}")
    sftp.close()

    problems = [rp for rp, (_, d) in plan.items()
                 if run(client, f"md5sum {shlex.quote(rp)} 2>/dev/null").split()[:1] != [d]]
    if problems:
        raise SystemExit(f"MD5 MISMATCH after deploy: {problems}")
    print(f"[verify] all {len(plan)} files md5-OK")

    # Prune stale files inside the derived trees only (assets/ = hashed
    # names, sounds/ = mirrored); css/, share/, fonts/ are managed by name.
    local_site_rels = set(site)
    stale = [f"{REMOTE_SITE}/{rel}" for rel in existing
             if rel not in local_site_rels and rel.split("/")[0] in ("assets", "sounds")]
    if stale:
        run(client, "rm -f " + " ".join(shlex.quote(p) for p in stale), timeout=120)
        print(f"[clean] {len(stale)} stale assets/sounds removed")
    else:
        print("[clean] no stale files")

    # Stamp the server tree with THIS deploy's identity. The API reads it
    # at boot (server/routes.ts handleHealth) so the restart verification
    # below can tell "the new process" from "the old one still standing".
    build_id = deployed_sha()
    run(client, "printf '%s\\n' " + shlex.quote(build_id) + " > " + shlex.quote(f"{REMOTE_SERVER}/.build-id"))
    print(f"[server] build id stamped: {build_id[:12]}")

    # Arm the self-retire BEFORE the restart: this boot's server runs the
    # code just uploaded, so from the next stamp on the process retires
    # itself instead of depending on signals the SSH side cannot deliver.
    ensure_self_retire(client)

    # Kill the running bun and wait until the PUBLIC health endpoint
    # answers with this build — see restart_server for the failure story
    # that made the wait non-negotiable.
    restart_server(client, build_id)

    client.close()
    print("DEPLOY DONE")


if __name__ == "__main__":
    main()
