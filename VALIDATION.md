# Validation

Current extension version: **0.1.6**. Validation completed on 2 November 2026.

## Automated checks

| Check | Result |
| --- | --- |
| Vitest extension/core/UI tests | 220 passed on v0.1.6 |
| Executable Python runner tests | 89 passed |
| Playwright Chromium extension tests | Six passed in the full security-review run; the native-sidebar case passed after the focused-sidebar change |
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

The dedicated preview-header tests use local fixtures. They do not establish deployment of the separate API change.

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

- The default release has `previewAuthVerified:false` and uses existing private browser-login previews. Setup and terminals work without the companion API change.
- Seamless preview-header injection remains disabled pending deployed API qualification for warm/cold HTTP replay, subresources, WebSockets, invalid/revoked/wrong-organization credentials, temporary validation failures, and public-setting drift.
- The unpacked extension is built in `dist/`; `npm run package` creates `artifacts/sprites-launch-extension-0.1.6.zip`.
- Chrome Web Store publication and the companion API deployment are separate release steps.
