# Cloud sync — setup guide (Turso)

Padify keeps notes in the browser (localStorage) so everything works offline.
Cloud sync adds a durable backup on top: signed-in users get their notes
restored on any device, and offline edits upload automatically once the
device is back online.

The stack has two pieces:

- **The padify API** (`server/` in this repo) — a tiny zero-dependency Bun
  service that handles accounts (email + password), note sync and share
  links.
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

The API runs anywhere Bun runs (a VPS, Fly.io, Railway, Render, a home
server — anything that can keep a small process alive):

```bash
cd server
PORT=3041 \
TURSO_DATABASE_URL='libsql://padify-<you>.turso.io' \
TURSO_AUTH_TOKEN='<token from step 1>' \
ALLOWED_ORIGINS='https://your-padify-site.example' \
bun run start
```

- `PORT` — defaults to `3041`.
- `TURSO_DATABASE_URL` — omit it (or use `file:`) to run with a local SQLite
  file at `server/local.db` instead of Turso (great for local dev).
- `ALLOWED_ORIGINS` — comma-separated origins allowed to call the API from a
  browser. Not needed when the API is served under the same origin as the
  app (see below).

Keep it alive with your platform's process manager, or wrap it in a systemd
unit / Docker container — it is a single `bun index.ts` process with no
build step.

## 3. Route the app to the API

The frontend calls the API at `apiBase` (default `''` = same origin, i.e.
`/api/...` on your site). Easiest production setup: reverse-proxy `/api/*`
from your static host to the API so everything is same-origin.

**Netlify** — add a redirect to `netlify.toml`:

```toml
[[redirects]]
  from = "/api/*"
  to = "https://your-api-host.example/:splat"
  status = 200
  force = true
```

**Or point at a separate host** — set the build-time constant in
`src/cloud/config.ts`:

```ts
export const CLOUD_BUILD_CONFIG: CloudConfig = {
  apiBase: 'https://your-api-host.example'
};
```

Rebuild and deploy (`npm run build` — Netlify does this on push). That's it:
the **Cloud sync** icon appears in the padify navbar, Settings gains a
"Cloud sync" section, and users can create accounts and sync.

## 4. Enable share links (/share/)

Share links let signed-in users publish a read-only copy of a note at
`https://your-site/share/?t=<token>`, with a chosen expiry (1/7/30/90 days)
and instant cancellation. The API and the `shares` table are already
configured for it.

The share page is static, so it cannot read `src/cloud/config.ts` — it has
its own config file. With the same-origin proxy from step 3 the shipped
default already works; otherwise open `public/share/config.js`:

```js
window.PADIFY_SHARE_CONFIG = {
  apiBase: 'https://your-api-host.example'
};
```

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

- **Local-first.** localStorage stays the source of truth; the app never
  waits on the network. Signed-out installs behave exactly like before.
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

Remove the key (or rely on the Vite proxy — `vite.config.ts` already proxies
`/api` to `localhost:3041` in dev) to go back to the default.
