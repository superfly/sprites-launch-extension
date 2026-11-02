# Contributing

Open a pull request against `main`. Merging requires one approving review from
someone other than the last person to push, resolved review conversations, an
up-to-date branch, and the GitHub Actions **CI passed** check. New reviewable
commits dismiss earlier approvals. Use squash merge; merged feature branches
are deleted automatically. Direct pushes, force pushes, and deletion of `main`
are blocked, including for administrators.

## Checks

CI runs on pull requests and pushes to `main`, using read-only repository
permissions and official actions pinned to immutable commits. It does not need
Sprites credentials, live resources, deployment secrets, or a Chrome Web Store
account.

- **Extension checks:** locked dependency install and advisory check, Vitest,
  TypeScript/build/package, ZIP validation, and a downloadable extension ZIP.
- **Runner tests:** Python 3.14, Node 24, and real Ruby/Rake fixtures. Required
  runtimes are checked so missing tools cannot silently skip coverage.
- **Chromium checks:** real extension, native side panel, private-preview header
  boundaries, terminal WebSockets, and browser traces/screenshots.
- **CI passed:** always runs and fails unless all three jobs succeed.

Run the commands in the README before submitting. Browser diagnostic artifacts
are retained for seven days and extension ZIPs for fourteen days. CI packages
must keep preview credential injection disabled.

## Repository policies

`main-ruleset.json`, `repository-settings.json`, and `actions-policy.json`
describe the repository configuration. They are applied by an administrator, not by CI; no
administration token belongs in a workflow. The required check is bound to the
GitHub Actions app. There is no permanent bypass list. Repository administrators
can explicitly edit policy during an emergency.
