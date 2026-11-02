# Validation

Current source version: **0.1.8**. Published prerelease: **0.1.7**. Validation updated on 2 November 2026.

## Automated checks

| Check | Result |
| --- | --- |
| Vitest extension/core/UI tests | 260 passed on v0.1.8 |
| Executable Python runner tests | 89 passed |
| Playwright Chromium extension tests | Six passed on v0.1.8 |
| TypeScript, production build, packaged ZIP integrity | Passed |
| Locked npm dependency advisory scan | Zero known advisories at review time |

The v0.1.6 change hides the launch form while the sidebar tracks a launch. **Launch another repo** explicitly reveals a blank form. The normal workspace view, provisioning engine, and credential boundaries are unchanged.

## Browser coverage

Browser tests load the built extension in an isolated Chromium profile against local TLS, HTTP, and WebSocket fixtures. They cover:

- GitHub navigation, trusted clicks, duplicate-button prevention, source pinning, and launch reuse.
- Browser sign-in, trusted storage, exact extension/API exec paths, and unrelated origin/tab isolation.
- A genuine native Chrome `SIDE_PANEL` context acknowledging setup while the normal workspace tab is closed.
- GitHub retaining focus through readiness, background previews, and explicit workspace-tab opening.
- Plain-text logs, stale selection/credential protection, and 360-pixel light/dark layouts without horizontal overflow.

The preview-header browser tests use local fixtures. They do not qualify the existing API header on every deployed route or organization.

## Live qualification

Live tests used disposable resources in a designated test organization. Resource identities were verified before cleanup, and only resources created by those tests were deleted. User workspaces were retained.

| App or scenario | Result |
| --- | --- |
| Static, generic Node, Vite, Next.js, Flask, FastAPI, Go | Real dependencies, service registration, and HTTP readiness passed |
| Django, Rails, Phoenix with SQLite and PostgreSQL | Local database setup, migrations, and HTTP readiness passed |
| Exact-revision checkout | Public repository resolved to an immutable SHA, checked out, and verified |
| OpenClaw | Pinned package manager, source/runtime build, authenticated Gateway/dashboard, source CLI, and VM-restart recovery passed |
| Hermes Agent | Pinned Python/Node tools, compiled dashboard, private sign-in, cookie sessions, single-use WebSocket tickets, retry reuse, and VM-restart recovery passed |
| Focused Rails security regression | SQLite and PostgreSQL migrations/readiness passed with deliberately injected foreign libpq routing overrides |

Framework-matrix fixtures prepare their source locally inside the test Sprite; exact-revision cloning is tested separately. Automatic model-provider configuration and model calls are outside these checks.

## Reproducing checks

```sh
npm ci
npm test
npm run test:runner
npm run build
npx playwright install chromium
npm run test:browser
```

Runner HTTP/process tests require loopback binding and process inspection. The runner test command selects an installed Python 3.11+ with `hashlib.scrypt`; set `SPRITES_TEST_PYTHON` to select an interpreter. See the main README and `runner/README.md` for opt-in live tests and their prerequisites.

Build outputs, browser screenshots, raw test receipts, and local diagnostic history are intentionally excluded from Git. Running the build and test commands generates local output.

## Release state

- The [v0.1.7 beta prerelease](https://github.com/superfly/sprites-launch-extension/releases/tag/v0.1.7) contains the ZIP from successful CI run `41371164502`, commit `fec8a5ce730206977404190291f4eef769704ce9`. Its SHA-256 is `5f12e58b7179cfe9fdb53acb750d1119e7e55d178664843146c4aaa886843142`.
- The published release has `previewAuthVerified:false` and uses existing private browser-login previews. Setup and terminals do not depend on preview-header authentication. Current default builds also record an empty `previewAuthOrgIds` list.
- Seamless preview-header injection remains disabled pending deployed API qualification for warm/cold HTTP replay, subresources, WebSockets, invalid/revoked/wrong-organization credentials, temporary validation failures, and public-setting drift.
- The unpacked extension is built in `dist/`; `npm run package` currently creates `artifacts/sprites-launch-extension-0.1.8.zip`. This source version is not yet a published release.
- Chrome Web Store publication and qualification of the existing API organization feature are separate release steps.

## Existing preview header qualification

The extension now targets `X-Sprite-Authorization`, the existing API protocol, rather than the proposed plural header. Upstream source review confirmed support for private legacy and service URLs when the destination organization has `target_header_routing` enabled. It also confirmed credential removal through HTTP replay and WebSocket proxying, preserving distinct app authorization. Private failures are generally 401, including wrong-organization credentials; validation outages are 503. Public destinations remain public even with invalid dedicated credentials.

A disposable live test in the designated test organization verified dedicated-header removal and distinct app-authorization preservation for warm and cold HTTP/WebSocket requests, with a changed VM boot ID. Inert credentials were used for the public recording-app checks before any real credential was sent to the private URL.

The private dedicated-header request returned HTTP 302, while an ordinary bearer control returned HTTP 200. The existing header was therefore not active for private authentication on the tested deployed organization/route. Private negative-token and outage behavior was reviewed in source but not live-qualified through an active dedicated-header path. No feature flags or deployments were changed. The disposable Sprite was identity checked, deleted, and confirmed absent with HTTP 404.

`previewAuthVerified:false` remains the default. The optional local receipt is `artifacts/existing-preview-header-live-2026-11-02.json`; raw account credentials and header traces are not saved. No new API merge is required for the existing protocol, and the superseded local API patch is not part of this repository.

## Scoped preview qualification guard

Enabled builds now require an explicit allowlist of qualified numeric organization IDs. Eligibility uses the numeric authority in an API-validated token rather than its descriptive slug. An unqualified, missing, or unrecognized token retains browser sign-in, including when reopening a saved preview. Rules enforce eligibility inside their serialized installation queue, alongside the current credential check.

The build and runtime share one parser and frozen policy. `release-status.json` records the same allowlist embedded in the bundles. Tests reject empty, malformed, wildcard, and ambiguous enabled settings before the build mutates output; they also cover slug aliases, large integer identities, cross-organization selection, restored previews, and terminal independence. No organization is included in the build defaults. Deployed-route qualification is tracked separately from these code-level controls.

Isolated builds using a synthetic organization ID verified that an enabled allowlist installs one scoped rule, while a disabled switch installs none. Both `.env.production` and explicit environment settings were exercised in each direction; bundled runtime behavior matched the release metadata. These checks left the installed extension output unchanged.
