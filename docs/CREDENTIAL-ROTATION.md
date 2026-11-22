# Credential rotation — a self-serve reference

This is the runbook for changing every password, token and key Padify's
production setup uses — written so you can do it yourself, in a browser,
without anyone's help, and know at each step what depends on what and what
to check afterwards.

It exists because credentials occasionally need rotating (after a possible
exposure, or just as hygiene before handing the project over, starting a
fresh chat, or sharing the machine). The good news up front: **production
does not depend on any secret held in a chat workspace or a developer's
laptop.** The automation holds exactly one secret — the SSH deploy key in
the GitHub repo's Actions settings — and the box holds its own `.env`.
Everything can be swapped in a few minutes.

## The mental model: a "pull" host and a "push" box

Padify is deployed twice, and the two hosts get their code in opposite
ways. Understanding this one picture makes the whole rotation plan obvious:

- **Netlify is the "pull" host.** It builds straight from the GitHub repo
  (`netlify.toml` is the entire config — including the `/api/*` proxy that
  points at the box) whenever `main` changes. Nothing in this repo holds
  or uses a Netlify credential, so no step below touches Netlify at all.
- **The AlwaysData box is the "push" target.** When a push to `main`
  passes CI (and is still the tip of `main` when CI finishes), the
  *Deploy (alwaysdata box)* workflow builds the site and pushes it to the
  box over SSH, then verifies the API came back by polling the public
  health endpoint until it names the deployed commit — a green run ends
  with a `DEPLOY DONE` line. The **box watchdog** uses the same login:
  every 30 minutes it probes health and revives a dead API over SSH. Both
  sign in with one dedicated **SSH deploy key**, stored as the GitHub
  Actions secret `AD_SSH_KEY` — the repo's only secret.

Nothing anywhere uses an AlwaysData API token: no workflow, script or doc
in this repo calls `api.alwaysdata.com` (the secret inventory above really
is the whole list), so automation reaches the box exclusively over SSH.
If you ever mint yourself a panel API token, it becomes a new credential
to manage — nothing today depends on one.

One more habit worth knowing before you rotate anything: GitHub's Actions
secrets page shows every secret as an **empty box**. That is normal —
secrets are write-only, so no one (not even you) can read them back after
saving. The page still tells you a value exists and when it was last
updated; the way to *prove* a new secret works is to watch a deploy run,
not to read the page.

## What needs rotating, and what a rotation breaks

| # | Credential | Where it lives | If rotated, what must be updated | Production impact while outdated |
|---|------------|----------------|----------------------------------|----------------------------------|
| 1 | Turso DB token | box `~/padify/server/.env` — the only copy | edit + site restart | **Cloud sync stops working** until updated (the app itself keeps working from browser storage) |
| 2 | SSH deploy key | GitHub secret `AD_SSH_KEY` + box `~/.ssh/authorized_keys` | add new key first, then swap the secret, then delete the old key | **Box deploys and the watchdog stop working** if the old key is removed before the new one answers |
| 3 | AlwaysData account password | the panel login | nothing — no automation uses it | none |
| 4 | AlwaysData SSH user password | SSH login | nothing — every deploy and script already uses the key | none |
| 5 | GitHub PAT | your GitHub account | the local clone's remote URL, if you still use one | you can't push code until the credential is updated wherever it's used |

Optional credentials that are **not in play**: `SPOTIFY_CLIENT_ID` /
`SPOTIFY_CLIENT_SECRET` would switch music search onto the Spotify catalog
(`server/music.ts`), but none are configured on this box — a live search
today answers through the yt-dlp fallback with YouTube ids (checked
2026-11-22). Nothing to rotate. If you ever set them, they live in the
same `.env` and rotate exactly like the Turso token below.

Rotate in that order — token, key, passwords, PAT — and the only moment
anything is ever "down" is the minutes between rotating the Turso token
and updating the box. (The PAT goes last because it is the master key for
making code changes: while it is valid, you can always fix a botched
deploy.)

## Prerequisites (all browser-based)

You need to be able to log in to three dashboards, plus whatever you
personally push code from:

- **AlwaysData** — <https://admin.alwaysdata.com> (the account's own
  email + password; the SSH user password does *not* work here)
- **GitHub** — <https://github.com/gvqz/padify>
- **Turso** — <https://turso.tech> (the account that owns the `padify`
  database)

## Step 1 — Turso database token

The API uses a database-scoped token to reach the notes database. Rotating
it is the only rotation where something user-visible (cloud sync) pauses
briefly.

1. In the Turso dashboard, create a new token for the `padify` database:
   the CLI equivalent is `turso db tokens create padify`. Copy the new
   token — it is shown once.
2. Edit `~/padify/server/.env` on the box: SSH in
   (`ssh functionhost@ssh-functionhost.alwaysdata.net` — the SSH user
   password, or a key of your own) and edit the file with `nano`/`vi`:
   replace the `TURSO_AUTH_TOKEN=` value with the new token. The site's
   **Environment** field in the panel is empty on this account (verified
   2026-11-22) — the `.env` file is the only copy, so there is no second
   place to update.
3. **Restart the site** in the panel (Web → Sites → the padify site →
   Restart). The API only reads the token at startup — Bun snapshots
   `.env` when the process boots — which is why the restart is required,
   not optional.
4. (Optional, hygiene) In Turso, invalidate the old token if the dashboard
   offers token management — that is what actually locks the old value
   out; until then, both tokens work.

**Verify:** <https://functionhost.alwaysdata.net/padifyapi/api/health>
answers `{"ok":true,…}`, then sign in to the app and confirm a note
appears (that exercises the database for real). The nightly backup
(`server/backup.sh`) loads the same `.env`, so it picks the new token up
on its next run with no action needed.

## Step 2 — SSH deploy key

This is the one rotation with an *order* to respect: **add the new key
before you remove the old one.** The key pair is how GitHub Actions logs
in to the box; if the box ends up with neither key, deploys fail until you
fix it over the panel.

1. Generate a fresh Ed25519 key pair on any machine with `ssh`:
   `ssh-keygen -t ed25519 -f padify-deploy-2026 -C "padify-deploy"`.
   Press return on the passphrase prompt — the key must be
   passphrase-less, because a robot (the deploy workflow) uses it and
   cannot type a passphrase. That is a deliberate trade: the key is one
   gate (an entry in one file on one box), grants access to nothing else,
   and revoking it is deleting that one line.
2. Install the **public** key: SSH into the box (the SSH user password,
   or a key of your own) and *append* the new `padify-deploy` public key
   to `~/.ssh/authorized_keys` as its own line:
   `echo '<the public key line>' >> ~/.ssh/authorized_keys`.
   Keep the old line for now.
3. Update the GitHub secret: repo → Settings → Secrets and variables →
   Actions → `AD_SSH_KEY` → Update — paste the **private** key file's full
   contents (`padify-deploy-2026`, the one without `.pub`). The page
   showing an empty value afterwards is normal (see "write-only" above).
4. Prove the new key works **before** removing the old one: repo →
   Actions → *Deploy (alwaysdata box)* → Run workflow (on `main`). Watch
   the run finish green — it prints `DEPLOY DONE` only after the box's
   health endpoint named the deployed commit, which is the proof the new
   key carried a build there.
5. Now delete the old key's line from `~/.ssh/authorized_keys` — over
   SSH, like every other edit in this runbook (the panel's web file
   browser no longer exists). The old key is dead from that moment.

**Verify:** the Actions run from step 4 went green, and
<https://functionhost.alwaysdata.net/padify/> loads and can sign in —
that subpath is the box's copy of the app (the account root itself
answers 404).

## Step 3 — AlwaysData passwords (account + SSH user)

Two passwords, zero impact:

- **The account password** (the panel login) is used by nothing
  automated. Change it in the panel (Profile → AUTHENTICATION) whenever
  you like. 2026-11-22: it was pasted into a support chat so an agent
  could inspect the panel — worth rotating on principle, and nothing
  automated will notice the change.
- **The SSH user password** used to be the fallback for local deploy
  scripts; those scripts now authenticate with the deploy key only (key
  auth — see the glossary). Changing the SSH password in the panel
  therefore breaks nothing. If you ever SSH by hand with a password, you
  simply use the new one.

**Verify:** the health check answers `{"ok":true}` — nothing to re-check
beyond that, but it costs five seconds and confirms no surprise.

## Step 4 — GitHub PAT (last)

The personal access token is the master key for code: pushing branches,
opening PRs, updating the repo. Rotate it last so that every other step
could still be verified through it.

1. GitHub → your avatar → Settings → Developer settings → Personal access
   tokens. Generate a new token with the `repo` scope (that is what the
   project's history uses; add nothing extra — least privilege).
2. Put it wherever you personally push code from — for a plain local
   clone that means the remote URL:
   `git remote set-url origin https://<NEW_TOKEN>@github.com/gvqz/padify.git`.
3. Delete the old token in the same dashboard page. Deleting it is what
   revokes it — everywhere, immediately.

**Verify:** `git push` from your clone works, or simply open a PR and see
it land.

## Full-rotation smoke test

After all four steps, spend two minutes confirming the whole machine still
runs itself — one browser tab each:

1. <https://padify.netlify.app/> loads and can sign in (pull host —
   proves GitHub + Netlify wiring).
2. <https://padify.netlify.app/api/health> answers `{"ok":true}` (the
   Netlify `/api` proxy reaching the box — new Turso token behind it).
3. <https://functionhost.alwaysdata.net/padify/> loads and can sign in
   (push host, user data).
4. Repo → Actions: the latest *Deploy (alwaysdata box)* run is green (new
   SSH key + PAT era).

And the fastest "is production current?" check there is: the health
endpoint's `build` field names the commit the box is running —
`{"ok":true,"build":"33f6519…"}` — diff it against the tip of `main` on
GitHub (both hosts answered with that day's tip when this was verified,
2026-11-22).

## Glossary

- **The box** — the AlwaysData account's little always-on server that runs
  the Padify API and mirrors the site. "The box" because from the repo's
  point of view it is one machine that code gets shipped *to*.
- **Pull host vs push target** — Netlify *pulls* from GitHub whenever
  `main` moves (zero secrets held by you); the GitHub Actions workflow
  *pushes* builds to the box over SSH (one key, one secret).
- **Key auth vs password auth** — SSH can accept either. Key auth means
  the login presents a private key file whose public half sits in the
  server's `authorized_keys`; there is no password to leak or mistype,
  and removing the public-key line instantly revokes that key alone.
  Password auth still exists on the box for humans; the automation
  simply no longer uses it.
- **Write-only secret** — GitHub stores Actions secrets so they can be
  *set* but never *read back* (they are injected into workflows at run
  time and masked in logs). An empty-looking secret page is the design,
  not a problem.
- **Passphrase-less deploy key** — a deliberate trade for robot-owned
  keys: the protection is that the key only opens the box, only for
  deploys, and dies with one deleted line. A passphrase would mean the
  workflow could never use the key.

If a step ever misbehaves, the recovery path is the same picture: GitHub
(workflow logs, secrets, PRs) tells you about the *push* side, the
AlwaysData panel (sites, SSH accounts, environment) about the *box*, and
the two health URLs above tell you whether the box's API and the pull host
are alive.
