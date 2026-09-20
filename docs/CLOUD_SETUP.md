# Cloud sync — setup guide

Padify keeps notes in the browser (localStorage) so everything works offline.
Cloud sync adds a durable backup on top: signed-in users get their notes
restored on any device, and offline edits upload automatically once the
device is back online.

The stack is [Supabase](https://supabase.com) (Postgres + auth + REST), which
has a free tier that comfortably covers a notepad. Nothing else is required —
no server to run, no other service.

## 1. Create the Supabase project

1. Create a free account at [supabase.com](https://supabase.com) and click
   **New project**.
2. Pick any name (e.g. `padify`), set a database password, choose the region
   closest to most of your users.
3. Wait ~2 minutes for provisioning.

## 2. Create the tables

1. In the project dashboard open **SQL Editor → New query**.
2. Paste the contents of [`supabase/schema.sql`](../supabase/schema.sql) and
   click **Run**.
3. You should see `Success. No rows returned` — the `notes` and `drawings`
   tables now exist with row level security enabled.

## 3. Allow the app's origin (for password reset links)

1. Go to **Authentication → URL Configuration**.
2. Set **Site URL** to your padify URL (for Netlify: `https://<your-site>.netlify.app`,
   or your custom domain).
3. Under **Redirect URLs** add the same URL.

Without this, sign-up confirmations and password resets still send, but the
links land on the Supabase-hosted page instead of returning to the app.

### Email limits (free tier)

The free tier sends up to ~2 emails per hour (confirmations, resets). For a
small user base this is fine; if sign-ups pick up, add custom SMTP under
**Project Settings → Authentication → SMTP** or turn off email confirmation:

- **Authentication → Providers → Email → Confirm email**: toggle off.

With confirmation off, new accounts can sign in immediately (the app handles
both cases).

## 4. Point padify at the project

1. Go to **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open `src/cloud/config.ts` and fill in the constants:

   ```ts
   export const CLOUD_BUILD_CONFIG: CloudConfig = {
     url: 'https://your-project-ref.supabase.co',
     anonKey: 'eyJhbGciOi…'
   };
   ```

4. Rebuild and deploy (`npm run build` — Netlify does this on push).

That's it. The **Cloud sync** icon appears in the padify navbar, Settings
gains a "Cloud sync" section, and users can create accounts and sync.

> The anon key is *designed* to be public — it ships in every Supabase
> client bundle. It cannot read or write anything without a signed-in user,
> and row level security scopes every request to that user's own rows.

## 5. Verify

1. Open padify, click the cloud icon in the navbar.
2. Create an account with any email/password (check the inbox if email
   confirmation is on).
3. Write something — within a couple of seconds the navbar dot turns green
   ("up to date") and the row appears in Supabase → **Table Editor → notes**.
4. Open padify in another browser, sign in with the same account, and your
   tabs should appear within seconds.

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
- **Scope:** note tabs and the drawing pad scene. Snapshots, settings and
  the mini tools stay on the device (roadmap: sync snapshots too).

## Testing without touching production

A runtime override lets you point a dev build at a different project (or a
mock) without editing source:

```js
localStorage.setItem('padifyCloudConfig', JSON.stringify({
  url: 'http://localhost:3040',
  anonKey: 'test-anon-key'
}));
```

Remove the key (or set build-time config) to go back to production.
