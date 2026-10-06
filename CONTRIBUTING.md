# Contributing to padify

## Commit identity (required)

Every commit pushed to this repository must be authored **and** committed
with the account's canonical privacy-preserving email:

```
119090177+gvqz@users.noreply.github.com
```

This is the GitHub account's canonical address
(`Settings → Emails → Keep my email addresses private`). The display
**name is free** — call yourself anything; the email is what links a
commit to the account. Using any other email produces commits that do not
link to it.

Set it locally (per repo, or drop `--local` for global):

```sh
git config --local user.email "119090177+gvqz@users.noreply.github.com"
```

Verify what a commit will be recorded as before pushing:

```sh
git log -1 --format='author %an <%ae>%ncommitter %cn <%ce>'
```

### Enforcement

The [Commit author policy](.github/workflows/commit-author.yml) workflow
fails the build when a commit does not carry that identity:

- **Pull requests** — every commit on the branch (`base..head`) is checked.
- **Pushes to `main`** — the commits in the push are checked.

Two deliberate exemptions:

- **GitHub web-flow commits** (merge commits and squash merges created
  through the web UI, "Update branch" clicks). GitHub writes those with a
  committer email of its own; their author email must still be the
  canonical noreply address above.
- **Historical commits** are not retroactively audited — only commits that
  arrive in a new push or PR are checked.

If the workflow blocks a push, its log names the offending commit and shows
the two `git config` commands to fix. Amend or re-commit after setting the
identity, then push again.

Recommended: enable branch protection on `main` with the
*Enforce commit identity* check as a required status check, so direct pushes
cannot bypass CI.

## Listener lifecycle

Padify is a long-lived singleton page, not a component tree that mounts
and unmounts. Every feature initializes once at boot and its DOM lives
until the page dies, so there is no teardown phase for event listeners —
the ~190 `addEventListener` calls against a handful of `removeEventListener`
is a *design*, not an accident. Two idioms keep it leak-free, and new
code must follow one of them:

- **Bind once at init** — listeners attach in a constructor or `initXxx()`
  (all of which are singleton-guarded) to DOM that never leaves the
  document: the modal shells, the navbar, `document` itself.
- **Delegate for dynamic content** — anything rendered through
  `innerHTML` (track rows, menus, search results) gets *no* per-node
  listeners; the nearest persistent ancestor owns one delegated handler,
  so dead nodes take their listeners with them into garbage collection.

The moment a feature introduces a *removable* surface — a picture-in-page
window, a teleprompter, a canvas that can close — that feature owns the
teardown: bind through an `AbortController` and call `.abort()` on close
(see `src/voice.ts` for the pattern). Do not add a global listener
registry for the singleton surfaces; it would be churn across every file
with no behavior to show for it.

## Everything else

- **Runtime**: Node 22 for tooling; Bun owns the lockfile
  (`bun install --frozen-lockfile`).
- **Quality gates** (same as CI): `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run test`, `npm run build`.
- **Commit style**: conventional commits (`feat:`, `fix:`, `chore:`,
  `refactor:`, `ci:`, `docs:` …).
