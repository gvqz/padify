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
import os
import posixpath
import shlex
import sys

import paramiko

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(REPO, "dist")
REMOTE_ROOT = "/home/functionhost/padify"
REMOTE_SITE = f"{REMOTE_ROOT}/www/site"
REMOTE_SERVER = f"{REMOTE_ROOT}/server"
REMOTE_SHARED = f"{REMOTE_ROOT}/shared"


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

    # SIGTERM bun: the supervisor re-spawns it on the next request with
    # the fresh code (the box's own idle-stop semantics).
    pids = run(client, "pgrep -u functionhost -f 'bun' | head -5").split()
    if pids:
        # || true: bun idles out on its own — a pid may exit between the
        # pgrep and the kill, which is exactly the state we wanted anyway.
        run(client, f"kill {' '.join(pids)} || true")
        print(f"[server] SIGTERM sent to bun pid(s): {', '.join(pids)}")
    else:
        print("[server] no bun process running (idle) — next request cold-boots")

    client.close()
    print("DEPLOY DONE")


if __name__ == "__main__":
    main()
