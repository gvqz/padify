# Credential rotation — a self-serve reference

This is the runbook for changing every password, token and key Padify's
production setup uses — written so you can do it yourself, in a browser,
without anyone's help, and know at each step what depends on what and what
to check afterwards.

It exists because credentials occasionally need rotating (after a possible
exposure, or just as hygiene before handing the project over, starting a
fresh chat, or sharing the machine). The good news up front: **production
does not depend on any secret held in a chat workspace or a developer's
laptop.** The two deployments run on credentials that live in exactly two
places — the AlwaysData account and the GitHub repo's settings — and every
one of them can be swapped in a few minutes.

## The mental model: a "pull" host and a "push" box

Padify is deployed twice, and the two hosts get their code in opposite
ways. Understanding this one picture makes the whole rotation plan obvious:

- **Netlify is the "pull" host.** It watches the GitHub repo and pulls the
  latest build whenever `main` changes. It connects to GitHub through a
  standard OAuth integration — the kind you authorize once in the browser.
  You hold **no password, no token, no key** for Netlify that Padify needs.
  Rotating anything in this document does not affect Netlify at all.
- **The AlwaysData box is the "push" target.** When a pull request merges,
  a GitHub Actions workflow (`deploy-box.yml`) builds the site and pushes
  it to the box over SSH, then restarts the API. The workflow signs in
  with a dedicated **SSH deploy key** stored as the GitHub Actions secret
  `AD_SSH_KEY`. That key, the AlwaysData account, and two API tokens
  (Turso, Spotify) are the complete list of production credentials.

One more habit worth knowing before you rotate anything: GitHub's Actions
secrets page shows every secret as an **empty box**. That is normal —
secrets are write-only, so no one (not even you) can read them back after
saving. The page still tells you a value exists and when it was last
updated; the way to *prove* a new secret works is to watch a deploy run,
not to read the page.

## What needs rotating, and what a rotation breaks

| # | Credential | Where it lives | If rotated, what must be updated | Production impact while outdated |
|---|------------|----------------|----------------------------------|----------------------------------|
| 1 | Turso DB token | box `~/padify/server/.env` + panel Environment field | both places + site restart | **Cloud sync stops working** until updated (the app itself keeps working from browser storage) |
| 2 | Spotify client secret | box `~/padify/server/.env` + panel Environment field | both places + site restart | none today — the feature falls back to its public fallback and is currently dormant |
| 3 | SSH deploy key | GitHub secret `AD_SSH_KEY` + box `~/.ssh/authorized_keys` | add new key first, then swap the secret, then delete the old key | **Box deploys stop working** between removing the old key and adding the new one, if done in the wrong order |
| 4 | AlwaysData account password | the panel login | nothing — no automation uses it | none |
| 5 | AlwaysData SSH user password | SSH login | nothing — every deploy and script already uses the key | none |
| 6 | GitHub PAT | your GitHub account | the local clone's remote URL, if you still use one | you can't push code until the credential is updated wherever it's used |

Rotate in that order — token, secret, key, passwords, PAT — and the only
moment anything is ever "down" is the minutes between rotating the Turso
token and updating the box. (The order exists because rotating the SSH key
and the PAT are easiest to verify from a position where everything else
already works. The PAT goes last because it is the master key for making
code changes: while it is valid, you can always fix a botched deploy.)

## Prerequisites (all browser-based)

You need to be able to log in to four dashboards. Nothing else:

- **AlwaysData** — <https://admin.alwaysdata.com> (account login; the SSH
  password does *not* work here — this login is the account's own email +
  password)
- **GitHub** — <https://github.com/gvqz/padify>
- **Turso** — <https://turso.tech> (the account that owns the `padify` database)
- **Spotify** — <https://developer.spotify.com/dashboard> (only for step 2)

## Step 1 — Turso database token

The API uses a database-scoped token to reach the notes database. Rotating
it is the only rotation where something user-visible (cloud sync) pauses
briefly.

1. In the Turso dashboard, create a new token for the `padify` database:
   the CLI equivalent is `turso db tokens create padify`. Copy the new
   token — it is shown once.
2. Open the AlwaysData panel's **file browser** (Web → File browser) and
   edit `~/padify/server/.env`: replace the `TURSO_AUTH_TOKEN=` value with
   the new token. Save.
3. If the panel also lists these values under the site's **Environment**
   settings, update the same field there too — the `.env` on the box and
   the panel's copy are meant to be mirrors of each other.
4. **Restart the site** in the panel (Web → Sites → the padify site →
   Restart). The API only reads the token at startup, which is why the
   restart is required, not optional.
5. (Optional, hygiene) In Turso, invalidate the old token if the dashboard
   offers token management — this is what actually locks the old value out.

**Verify:** open <https://functionhost.alwaysdata.net/padifyapi/api/health>
— it should answer `{"ok":true}`. Then sign in to the app and confirm a
note appears (that exercises the database for real). The daily database
backup reads the same `.env` file, so it picks the new token up on its next
run with no action needed.

## Step 2 — Spotify client secret

The music search feature can use Spotify app credentials; on this account
it is dormant (no Premium subscription, and search falls back to its
public source). Rotating is the same two places as the Turso token, minus
any urgency:

1. In the Spotify developer dashboard, open the app and either rotate the
   secret or create a new app; copy the new client secret.
2. Update `SPOTIFY_CLIENT_SECRET` in `~/padify/server/.env` (AlwaysData
   file browser) and the panel Environment mirror, if present.
3. Restart the site, same as step 1.

**Verify:** the health check from step 1 still answers `{"ok":true}`. That
is all — nothing user-facing depends on this credential today.

## Step 3 — SSH deploy key

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
2. Install the **public** key: in the AlwaysData file browser, edit
   `~/.ssh/authorized_keys` and *append* the new `padify-deploy` public
   key as its own line. Keep the old line for now.
3. Update the GitHub secret: repo → Settings → Secrets and variables →
   Actions → `AD_SSH_KEY` → Update — paste the **private** key file's full
   contents (`padify-deploy-2026`, the one without `.pub`). The page
   showing an empty value afterwards is normal (see "write-only" above).
4. Prove the new key works **before** removing the old one: merge any
   open PR, or repo → Actions → *Deploy to the AlwaysData box* → Run
   workflow. Watch the run finish green — its logs end with a deploy-done
   marker when the box answered the new key.
5. Now delete the old key's line from `~/.ssh/authorized_keys` (file
   browser). The old key is dead from that moment.

**Verify:** the Actions run from step 4 went green, and the box still
serves the app: <https://functionhost.alwaysdata.net/> loads.

## Step 4 — AlwaysData passwords (account + SSH user)

Two passwords, zero impact:

- **The account password** (the panel login) is used by nothing automated.
  Change it in the panel (Account → password) whenever you like.
- **The SSH user password** used to be the fallback for local deploy
  scripts; those scripts now authenticate with the deploy key only
  (key auth — see the glossary). Changing the SSH password in the panel
  therefore breaks nothing. If you ever SSH by hand with a password, you
  simply use the new one.

**Verify:** the health check answers `{"ok":true}` — nothing to re-check
beyond that, but it costs five seconds and confirms no surprise.

## Step 5 — GitHub PAT (last)

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

After all five steps, spend two minutes confirming the whole machine still
runs itself — this is the same list the automation checks, and it fits in
a browser tab each:

1. <https://padify.netlify.app/> loads and can sign in (pull host — proves
   GitHub + Netlify wiring).
2. <https://functionhost.alwaysdata.net/> loads and can sign in (push
   host, user data).
3. <https://functionhost.alwaysdata.net/padifyapi/api/health> answers
   `{"ok":true}` (box API + new Turso token).
4. Repo → Actions: the latest *Deploy to the AlwaysData box* run is green
   (new SSH key + PAT era).

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
AlwaysData panel (sites, files, environment) about the *box*, and the two
health URLs above tell you whether the box's API and the pull host are
alive.
