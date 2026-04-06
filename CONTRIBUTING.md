# Contributing to Anima

Solo project. These conventions exist to keep the history readable and PRs reviewable.

---

## Branch Strategy

- All work happens on **feature branches** off `main`.
- Branch naming: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `refactor/<slug>`
- Merge via pull request — self-review is fine; just write the PR description.
- `main` stays green. Nothing merges that breaks the build.
- No direct commits to `main`.

## Issue Tracking

GitHub Issues. Three labels:

| Label | Use |
|-------|-----|
| `bug` | Something broken or wrong |
| `feature` | New capability |
| `chore` | Maintenance, deps, tooling, docs |

Keep issues small and scoped. Close them in the PR that fixes them (`Closes #N` in the PR body).

## Commit Convention

[Conventional Commits](https://www.conventionalcommits.org/) — format: `type: description`

Types: `feat` · `fix` · `chore` · `refactor` · `style` · `docs` · `test`

```
feat: add familiar profile card with Marvel trading card layout
fix: sprite alignment off by 1px for cactus species
chore: add CONTRIBUTING.md
```

- Present tense, lowercase, no period.
- Body is optional — use it for the *why*, not the *what*.
- Breaking changes: add `!` after type or a `BREAKING CHANGE:` footer.

## Pull Requests

- PR title = the primary commit message (conventional commits format).
- Description: what changed + how to test it.
- One feature per PR. Squash or rebase to clean up noise commits before merge.
