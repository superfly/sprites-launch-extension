# Security and quality review

Reviewed 2 November 2026 for extension v0.1.5. This is a bounded source review with executable regression tests, browser transport tests, dependency advisories, and focused live framework qualification.

## Findings fixed

| Area | Issue and correction | Evidence |
| --- | --- | --- |
| Preview ownership and privacy | A saved preview could open without checking whether the Sprite had been recreated or made public. Opening and restoring previews now recheck the current Sprite ID, private URL settings, and API-returned hostname before navigation or credential rules. Automatic previews open in a background tab; explicit previews take focus. | `tests/preview-ownership.test.ts` |
| Logout and credential replacement | Slow terminal or preview work could reinstall a captured bearer rule after logout cleared rules. Rule installation now checks the current organization/token inside the same serialized queue as rule removal. | `tests/rules.test.ts` exercises logout before and during installation, replacement, and organization mismatch. |
| Private app errors | OpenClaw private-file read/JSON parsing errors could contain configuration fragments. Failures now return a generic error, as the Hermes path already does. | Credential-bearing malformed JSON and read failures in `tests/preview-ownership.test.ts`. |
| GitHub message boundary | GitHub needs launch acknowledgement, not persisted command overrides or detailed failures. Page responses now contain only launch ID/phase or a generic error. Subframe requests and page-supplied panel routing are rejected. | `tests/background.test.ts`, `tests/security.test.ts`, and real Chromium storage/header checks. |
| Rails migration target | Task loading or prerequisites could change database settings after an earlier check. The wrapper now checks after these hooks, including effective pools and already-open native connections, before invoking the prepared migration task. | Real Ruby/Rake refusal fixtures in `runner/test_rails_security.py`; focused live Rails/SQLite/PostgreSQL qualification. |
| PostgreSQL management | Inherited libpq variables could override the local host or service used by initialization tools. All inherited `PG*` values are discarded before explicit launch-local parameters are supplied. | Executable subprocess-environment regressions and live PostgreSQL fixture with injected routing overrides. |
| Development dependencies | Advisory checks identified vulnerable Vitest test-tool dependencies. Vitest was updated to 5.0.5, preserving Vite 6 compatibility. The locked full dependency audit then reported zero known advisories. | `artifacts/npm-audit-2026-11-02.json`; all extension tests rerun under Vitest 5. |

## Sidebar boundary

The progress UI is a native Chrome side panel at the extension's own origin. No iframe, credentials, logs, or privileged controls are injected into GitHub's DOM. The content script remains a launch-only entry point with trusted-click handling. Panel context is scoped to a Chrome window in trusted session storage; stale lookups cannot replace a newer launch selection. GitHub navigation does not trigger another launch. Closing the panel preserves remote setup and the workspace.

The panel reuses the trusted setup WebSocket bridge. Chromium verification opens a genuine `SIDE_PANEL` context with the normal workspace tab closed, proving that the native panel itself can acknowledge remote setup. Rendering checks use a separate bundled extension document at 360 px; they are not screenshots of the native Chrome frame.

## Retained boundaries

- Organization API credentials remain in trusted, device-local extension storage and scoped session header rules. They are never copied into GitHub, Chrome Sync, the repository, or the Sprite.
- Generated application credentials are separate: private launch-local files support the app's own authentication and are retrieved only on explicit request in the trusted UI.
- REST requests reject redirects; terminal rules target this extension's origin and exact API exec paths. Preview rules target one exact API-returned hostname and tab.
- Repository install scripts, tasks, and application code run with the normal Sprite user's permissions. Database guards prevent automatic migrations against an unintended effective target; they do not sandbox actively malicious repository code from itself.
- Source resolution remains public-GitHub-only and pinned to a verified SHA. Retry/cancel retain files, and deletion is explicit and identity checked.
- Seamless preview credential injection remains disabled. The companion API change has not been deployed or qualified; existing private browser-cookie authentication remains in use.

## Validation receipts

Build outputs and local receipts under `artifacts/` are not committed. The references below identify local review evidence; use the documented commands to generate fresh results.

See `VALIDATION.md` for final counts and delivery, `artifacts/npm-audit-2026-11-02.json` for the point-in-time dependency audit, and `artifacts/security-rails-live-2026-11-02.json` for the focused disposable-Sprite tests and cleanup receipt. Browser fixtures prove extension behavior locally; they do not establish deployment of the separate preview-header API change.
