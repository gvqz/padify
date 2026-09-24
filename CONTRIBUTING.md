# Contributing to padify

## Commit identity (required)

Every commit pushed to this repository must be authored **and** committed as:

```
gvqz <119090177+gvqz@users.noreply.github.com>
```

This is the GitHub account's canonical privacy-preserving address
(`Settings → Emails → Keep my email addresses private`). Using any other
name or email produces commits that do not link to the account.

Set it locally (per repo, or drop `--local` for global):

```sh
git config --local user.name  "gvqz"
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
  through the web UI, "Update branch" clicks). GitHub writes those with the
  profile's display name, which may legitimately differ; their author email
  must still be the canonical noreply address above.
- **Historical commits** are not retroactively audited — only commits that
  arrive in a new push or PR are checked.

If the workflow blocks a push, its log names the offending commit and shows
the two `git config` commands to fix. Amend or re-commit after setting the
identity, then push again.

Recommended: enable branch protection on `main` with the
*Enforce commit identity* check as a required status check, so direct pushes
cannot bypass CI.

## Everything else

- **Runtime**: Node 22 for tooling; Bun owns the lockfile
  (`bun install --frozen-lockfile`).
- **Quality gates** (same as CI): `npm run typecheck`, `npm run lint`,
  `npm run format:check`, `npm run test`, `npm run build`.
- **Commit style**: conventional commits (`feat:`, `fix:`, `chore:`,
  `refactor:`, `ci:`, `docs:` …).
