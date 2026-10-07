# Cloud sync — setup guide (Turso)

Padify keeps notes in the browser (IndexedDB, with a localStorage fallback) so everything works offline.
Cloud sync adds a durable backup on top: signed-in users get their notes
restored on any device, and offline edits upload automatically once the
device is back online.

The stack has three pieces:

- **Netlify** — serves the built app (`dist/`) and proxies `/api/*` to the
  API below, so everything is same-origin.
- **The padify API** (`server/` in this repo) — a tiny zero-dependency Bun
  service that handles accounts (email + password), note sync and share
  links. It runs as one always-on process on **AlwaysData** (SSH + Bun;
  see step 2).
- **[Turso](https://turso.tech)** (libSQL/SQLite) — the database the API
  talks to. Free tier comfortably covers a notepad; the client's data lives
  in *your* Turso database.

The web app never talks to the database directly — every request goes
through the API, so no secrets ship in the browser bundle.

## 1. Create the Turso database

```bash
# Install the CLI once: curl -sSfL https://get.tur.so/install.sh | bash
turso auth signup          # or: turso auth login
turso db create padify
turso db show padify --url        # → libsql://padify-<you>.turso.io
turso db tokens create padify     # → eye-eye… (a database-scoped token)
```

The schema is applied automatically by the API on first boot. To do it by
hand instead:

```bash
turso db shell padify < server/schema.sql
```

## 2. Run the API

The API runs anywhere Bun runs. The recommended home is **AlwaysData** —
one small always-on process with SSH access; the rest of this section is
the AlwaysData recipe (any host that keeps a process alive works the same:
a VPS, Fly.io, Railway, a home server).

### 2a. AlwaysData, step by step

1. **Install Bun over SSH** (AlwaysData gives full SSH; Bun is not
   preinstalled but lands in your home directory):

   ```bash
   ssh your-account@ssh-YOUR-ACCOUNT.alwaysdata.net
   curl -fsSL https://bun.sh/install | bash
   # → ~/.bun/bin/bun  (log out/in or source ~/.bashrc to get it on PATH)
   ```

2. **Get the server code onto the box** — clone the repo (or `rsync` just
   `server/`; the API has zero npm dependencies, so there is nothing to
   `install`):

   ```bash
   git clone https://github.com/gvqz/padify.git ~/padify
   ```

3. **Launch it** with the Turso credentials from step 1:

   ```bash
   cd ~/padify/server
   PORT=3041 \
   TURSO_DATABASE_URL='libsql://padify-<you>.turso.io' \
   TURSO_AUTH_TOKEN='<token from step 1>' \
   ~/.bun/bin/bun index.ts
   ```

4. **Keep it alive** from the AlwaysData panel: create a site backed by
   your account whose start command is the launch line above (adapt the
   site type — a Node/program site with a custom command works; the exact
   naming depends on your plan). AlwaysData fronts sites with HTTPS on
   your account domain, which is what Netlify will proxy to (step 3).

### 2b. Memory footprint (measured, Bun 1.3)

| Stage | RSS |
|---|---|
| Idle after boot | ~46 MB |
| During a sign-up (scrypt hashing) | ~66 MB peak |

The peak is the password hash doing its job (scrypt is *designed* to be
memory-hard); it is transient and returns to the idle floor afterwards.
That fits a 128 MB process budget with roughly 2× headroom. (Bun's
`--smol` flag trims ~3 MB of RSS but runs a more aggressive GC — not
worth the trade; launch without it.) The server also has explicit
guardrails so memory cannot creep:

- request bodies are capped at 2 MB at the runtime level (rejected with
  413 before any handler runs);
- the per-IP rate-limit map sweeps expired entries every 5 minutes
  (IPs that never return cannot accumulate);
- note sync pushes batch all rows into one request (one round-trip to
  Turso instead of one per row);
- there is no caching of query results — rows exist only while a request
  is being served.

Other environment variables:

- `PORT` — defaults to `3041`. A supervisor-provided `PORT` wins (alwaysdata
  sites hand their assigned port over this way, along with the internal
  listen address in `IP`).
- `PATH_PREFIX` — the mount point when the API is served under a subpath of
  a shared domain (alwaysdata sites proxy the full original path to the
  process, so an app mounted at `host/padifyapi` receives
  `/padifyapi/api/health`; the prefix is stripped before routing). Unset or
  `/` = root deployment, nothing stripped.
- `TURSO_DATABASE_URL` — omit it (or use `file:`) to run with a local SQLite
  file at `server/local.db` instead of Turso (great for local dev).
- `ALLOWED_ORIGINS` — comma-separated origins allowed to call the API from a
  browser. Not needed when the API is served under the same origin as the
  app (see below — the Netlify redirect in step 3 makes everything
  same-origin).
- `TRUST_PROXY_HOPS` — how many proxies in front of this server you trust to
  report truthful client addresses. The rate limiter only reads
  `X-Forwarded-For` when this is set, and then uses the value the CLOSEST
  trusted proxy saw — never the first entry (which any client can forge).
  Default `0` trusts nothing: every caller shares one global bucket, which
  is over-strict but cannot be bypassed. Set `1` when exactly one known
  proxy fronts the API (the repo's `Caddyfile`, which sets
  `X-Forwarded-For` to the address it actually saw; a typical
  alwaysdata/nginx setup). Signed-in traffic is always rate-limited per
  account instead of per address, and failed sign-ins are counted per
  account (8 failures locks that account's sign-in for 15 minutes), so
  brute-force protection does not depend on this setting.

### 2c. Backups — the only durable copy

Sync is a *second* copy on the user's device — the database this server
writes is the only *durable* one. A nightly dump is the whole safety net
for "my laptop died" and "I deleted the wrong thing a week ago" alike:

```bash
# once, by hand, to prove it works:
cd server && ./backup.sh

# then nightly (crontab -e) — keeps 14 days by default:
15 3 * * * cd /path/to/padify/server && ./backup.sh >> backups/backup.log 2>&1
```

`server/backup.sh` dumps through the `turso` CLI (set `TURSO_DATABASE_NAME`
— the *name* from `turso db list`, the URL alone is not enough — plus a
read token) or plain `sqlite3` for a `file:` database, gzips the result
under `server/backups/`, refuses to keep a suspiciously small dump, and
prunes files older than `BACKUP_KEEP_DAYS` (default 14). Off-box copies
are still worth it: point the output directory at a mounted volume, or
`rsync`/`rclone` `server/backups/` elsewhere from a second cron line.

The API itself now exits politely: `SIGTERM`/`SIGINT` stop the listener,
wait for in-flight requests to drain (a hard ceiling of 10 s), then close
the database — panel restarts no longer cut a sync push mid-flight.

### Free music (no-login search + playback)

The music player runs through two extra public endpoints on this
API (`GET /api/music/search` and `GET /api/music/resolve` — see
`server/music.ts`). Both are optional: without them the player simply
says the music API is offline.

- `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` — your Spotify app's
  credentials. The server exchanges
  them for a Client-Credentials token to search Spotify's public catalog
  (no user login involved). Set them and `GET /api/music/capabilities`
  flips `search` to `true`.
- `SPOTIFY_MARKET` — optional market code (e.g. `US`) for catalog search.
- `yt-dlp` — install it on the host (`pip install yt-dlp` or a distro
  package) and `GET /api/music/capabilities` flips `resolve` to `true`. The
  server runs it with `--print` + `-f bestaudio` so only the ~10 KB text
  stream URL crosses the wire — audio flows browser → googlevideo.com
  directly, never through the API, keeping AlwaysData's 10 GB/month budget
  essentially untouched.
- `YTDLP_PATH` — override the yt-dlp binary location.
- `MUSIC_RESOLVE_CONCURRENCY` — simultaneous yt-dlp processes (default 2,
  capped at 4) to protect the 128 MB RAM budget.

Resolved stream URLs are cached in the `music_resolutions` table (TTL 3 h,
swept at boot), so repeat plays are one cheap SELECT and repeat requests for
the same track dedupe into a single yt-dlp run.

### Attachments (the blob store)

Voice notes and future media note types store their bytes on the API, in the
`attachments` table (user-scoped, 5 MB per attachment, bytes kept base64 in
a TEXT column — see `server/schema.sql` for the reasoning). Four routes, all
session-authenticated:

- `GET /api/attachments` — the caller's attachments as metas (no bytes).
- `POST /api/attachments` — raw bytes as the body; the client-chosen id
  rides in `x-padify-id` (retries with the same id and bytes are idempotent,
  same id with different bytes is a 409).
- `GET /api/attachments/:id` — the bytes, ETagged by their sha256
  (`If-None-Match` answers 304).
- `DELETE /api/attachments/:id` — idempotent.

No environment variables are needed. Clients upload pending attachments in
the background after each sync cycle and download other devices' attachments
on demand — blobs never ride along with note sync.

## 3. Point the site at the API

One variable — `VITE_API_BASE` — decides where the API lives for every
part of the deployment. The build bakes it into the client bundle
(`src/cloud/config.ts`), writes the share viewer's config
(`dist/share/config.js`), adds it to the CSP `connect-src`, and — on
Netlify — emits the `/api/*` proxy redirect (`dist/_redirects`). The parts
physically cannot disagree about the API's address:

- **unset or empty** (default) → same-origin `/api`: route `/api/*` to the
  API from whatever serves the site (the bundled `Caddyfile` already does
  this for self-hosting; the Vite dev server proxies to `localhost:3041`).
- **`https://api.example.com`** (an absolute URL) → the app and the share
  viewer call that origin directly (CORS), and the generated `_redirects`
  additionally proxies `/api/*` there so curl and tests on
  the same host work too.
- **`https://host.example.com/padifyapi`** (an absolute URL with a path) →
  for hosts that can only hand out subpaths of one shared domain
  (alwaysdata-style accounts): the front server maps the path onto the
  API and the app calls it in place. Same-origin, so no CORS involved,
  and the service worker carries the path in its network-only bypass so
  live data is never served from a cache.

Set it where the build runs (Netlify: Site settings → Environment
variables), rebuild, deploy. A malformed value — a relative URL, a URL
with a query or fragment — **fails the build** instead of shipping a site
whose parts guessed differently.

### Serving the app under a subpath (`VITE_BASE_PATH`)

Hosts that partition one domain by path — alwaysdata's free accounts, for
example, where an app lives at `functionhost.alwaysdata.net/padify` —
build with `VITE_BASE_PATH=/padify/`. Vite rebases every emitted URL onto
it, the service worker precaches and falls back under it, and share links
resolve inside it; the app itself is otherwise unaware of where it is
mounted. Leave the variable unset for a normal root deploy — both come
from the same source, which is exactly what keeps them from drifting.

That's it: the **Cloud sync** icon appears in the padify navbar, Settings
gains a "Cloud sync" section, and users can create accounts and sync.

## 4. Enable share links (/share/)

Share links let signed-in users publish a read-only copy of a note at
`https://your-site/share/?t=<token>`, with a chosen expiry (1/7/30/90 days)
and instant cancellation. The API and the `shares` table are already
configured for it.

The share page is static, so it cannot read `src/cloud/config.ts` — but
it doesn't need to: the build writes its config (`dist/share/config.js`)
from the same `VITE_API_BASE`, so the app and the share page always agree
on the API's address. Nothing to edit by hand.

Behaviour reference:

- The link holds a **copy** of the note; while the note is edited (and the
  owner is signed in) the copy refreshes automatically in the background.
- **Cancelling** a link (share modal → "Cancel link") cuts off access
  immediately, and so does **closing the note** it belongs to.
- Expired and cancelled links become unreadable to anonymous visitors — they
  see "This link isn't available". Owners keep seeing them in the modal so
  they can audit and copy old links.

## 5. Verify

1. Open padify, click the cloud icon in the navbar.
2. Create an account with any email and a password of 6+ characters.
3. Write something — within a couple of seconds the navbar dot turns green
   ("up to date") and the row appears in your Turso database
   (`turso db shell padify "select id, name from notes"`).
4. Open padify in another browser, sign in with the same account, and your
   tabs should appear within seconds.

## Accounts & passwords

- Sign-up is email + password (6+ characters), no confirmation email — the
  API has no mail service, which keeps the stack tiny. Password resets are
  manual for now (the owner can update or delete a user row via the API
  database); the "Forgot password?" link is therefore not shown.
- Passwords are stored as scrypt hashes with per-user salts.
- Sessions are 30-day bearer tokens; only their SHA-256 hash is stored, so a
  database leak cannot impersonate anyone. Signing out revokes the token.
- Sign-in and sign-up are rate-limited per IP (30/min); the rest of the API
  is capped at 300 req/min per IP.

## How sync works (reference)

- **Local-first.** The on-device IndexedDB store stays the source of
  truth; the app never waits on the network. Signed-out installs behave
  exactly like before.
- **Last-write-wins** per note using padify's existing `updatedAt` stamp.
  Editing the same note on two devices offline keeps the most recent edit.
  Snapshots (local) preserve every prior version either way.
- **Deletions are tombstoned** (`deleted = true`), so closing a tab on one
  device removes it everywhere — including devices that were offline.
- **Sync triggers:** debounced after every change (1.2s), on sign-in, on
  returning to the tab, on network reconnect, and every 30s while visible.
- **Scope:** note tabs on the main page. Snapshots, settings and the mini
  tools stay on the device (roadmap: sync snapshots too).

## Testing without touching production

A runtime override lets you point a dev build at a different API without
editing source:

```js
localStorage.setItem('padifyCloudConfig', JSON.stringify({
  apiBase: 'http://localhost:3041'
}));
```

(The storage layer reads this key through its mirrors, so the plain
localStorage call works. The override is a dev escape hatch: production
ships a CSP whose `connect-src` admits only the baked-in origin, so a
runtime override to a different origin works only where the headers are
absent — i.e. on `vite dev`/`vite preview`.)

Remove the key (or rely on the Vite proxy — `vite.config.ts` already proxies
`/api` to `localhost:3041` in dev) to go back to the default.
