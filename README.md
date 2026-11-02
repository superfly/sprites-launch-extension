# Launch on a Sprite

A standalone Manifest V3 Chrome extension that launches public GitHub repositories and pull request heads in persistent Sprite workspaces.

After connecting a Sprite organization, click **Launch on a Sprite** on GitHub. The extension pins the selected revision, creates a Sprite, installs dependencies, sets up a supported local database, and starts the application. A native Chrome side panel shows progress and logs beside GitHub, with configuration and a reconnectable terminal. **Open workspace tab** opens the larger view. Repeated launches reuse the same organization/repository/commit; **New Sprite** makes a separate workspace.

## Install locally

Development requires Node 22.12+ on the 22.x line, Node 24.x, or Node 26+.

```sh
npm ci
npm run package
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select this project's `dist` directory. The distributable ZIP is `artifacts/sprites-launch-extension-0.1.6.zip`.

The GitHub button and Chrome toolbar action open the progress side panel. While tracking a launch, the panel focuses on progress; **Launch another repo** explicitly opens the repository form. It keeps GitHub selected through setup; automatic previews open in a background browser tab, and **Open private preview** brings a preview forward. If Chrome cannot open the panel, the full workspace tab remains the fallback. Closing the panel retains the Sprite and setup.

Use **Connect Sprites** to sign in through the existing browser login flow and select an organization. Manual org token entry is also available. No GitHub login, local Sprite CLI, or separately hosted extension backend is required for normal use. Tokens remain in trusted extension storage on this device, are never synced, and never enter the Sprite or GitHub page.

## Preview release gate

The default build **does not inject credentials into preview sites**. It opens private previews using the existing Sprite browser sign-in flow, which can require another sign-in. Interactive terminals and automatic setup still work directly through the API.

Seamless private previews require the companion `sprites-api` patch adding `X-Sprites-Authorization`. That header must fail closed and be removed by the proxy before any app request is replayed, including WebSocket requests. Deploy and verify that patch before producing an enabled build:

```sh
VITE_PREVIEW_AUTH_VERIFIED=true npm run package
```

This is a build-time release switch, not a user preference. Check `dist/release-status.json`. Do not enable it based only on passing local unit tests. Deployment qualification must include an app recording received headers on warm/cold HTTP, subresources, and HMR WebSocket requests; invalid/revoked/wrong-org credentials; temporary validation failure; and public-setting drift.

Chrome requires explicit WSS host permissions. Actual Chromium testing also established that setup WebSockets must originate in an extension document: header injection is unreliable for service-worker-created WebSockets. A trusted launch-page port performs only the session acknowledgement; setup then continues remotely even when the page closes.

## Supported automatic recipes

| App | Automatic detection |
| --- | --- |
| Static | Root `index.html` |
| Vite / Next.js | Framework dependency in root `package.json` |
| Node | Start script and an identifiable HTTP port |
| OpenClaw | Build source and Control UI, then run its authenticated Gateway |
| Hermes Agent | Install its pinned Python/Node tools and build its authenticated dashboard |
| Flask | Flask dependency and one conventional `app.py` or `wsgi.py` |
| FastAPI | FastAPI dependency and `app` in `main.py` or `app/main.py` |
| Django | `manage.py` and an identifiable settings module |
| Go | A single root or immediate `cmd/` executable package |
| Rails | Rails Gemfile and `bin/rails` |
| Phoenix | Identifiable Phoenix application and endpoint |

The runner provisions missing or mismatched npm, pnpm, and Yarn versions in the launch directory, preserving the repository’s exact package-manager version and optional integrity hash through Corepack. It honors lockfiles, probes installed runtime versions, configures the exact Sprite preview hostname, and keeps generated launch configuration outside the source checkout. Python supports requirements files and installable standard `pyproject.toml` projects. Missing/incompatible runtimes, conflicting lockfiles, ambiguous monorepos, secrets, unsupported database adapters, Docker-only applications, and nonstandard entrypoints show **Needs configuration**. The checkout and terminal remain available. General framework recipes do not automatically replace language runtimes. Hermes uses its own pinned, launch-local tool manager.

SQLite and PostgreSQL are launch-local. PostgreSQL is installed when needed, binds loopback on port 15432, uses generated credentials, and runs as a persistent Sprite service. Framework migration wrappers check effective database connections before migrating. Automatic launch does not run seed commands or use a repository's external database URL. Repository install scripts and application code execute inside the fresh Sprite as part of launch.

### OpenClaw

OpenClaw uses its dedicated source-build recipe rather than its Vite development dependency or CLI-only start script. The runner installs dependencies, uses the supported `build:runtime` profile when available (otherwise `build` and `ui:build`), and serves the Gateway on the Sprite HTTP port. The runtime profile includes plugins and the Control UI while skipping package declarations. Its private config and state live outside the checkout; normal Gateway token authentication and browser device pairing stay enabled. Use **Show connection token** in the extension to retrieve the app’s token when connecting the dashboard, then configure model access in OpenClaw. App credentials are fetched only on demand and never saved in extension snapshots or sent to GitHub. New terminal sessions inherit the launch’s package-tool PATH and isolated config/state paths. After the source build, a launch-local `openclaw` command is available in a new shell, so the dashboard’s standard device-pairing commands work.

OpenClaw trusts only the Sprite runtime’s exact proxy peers (`10.0.0.2/32` and `fdf::2/128`) and keeps `X-Real-IP` fallback disabled. A retry fills missing proxy settings in older launch configs and restarts the owned app service without reinstalling completed dependencies. Existing explicit proxy settings are preserved. The platform appends a non-spoofable internal hop to `X-Forwarded-For`, so OpenClaw may attribute multiple clients to that shared proxy for IP-based rate limiting; it does not treat these requests as direct local connections.

To upgrade an existing unpacked installation, reload it in `chrome://extensions`, refresh the launch tab, and choose **Retry setup** on the retained launch.

### Hermes Agent

The Hermes recipe recognizes the complete `NousResearch/hermes-agent` source tree before the generic Node workspace check. It uses Hermes’ own pinned package manager to install the backend and web dependencies, builds the dashboard, and starts it as a persistent service. Python 3.14 must be available to bootstrap the tool manager. The selected Python and Node runtimes, generated dashboard, configuration, and state stay under the launch directory. Optional browser automation tools and model providers are not provisioned.

The dashboard requires a generated username and password. Once ready, choose **Show sign-in details** in the extension, then use those details on the private preview’s Hermes sign-in page. Credentials are retrieved only on demand and remain stable across retries and restarts. Configure model access in Hermes after signing in. A launch-local `hermes` command is available in a new terminal shell. Other ambiguous workspaces still require an application directory.

## Persistence and recovery

- Each launch records its intended Sprite name before provisioning and reconciles unknown results. Resource identity checks prevent modifying a different Sprite recreated under an old name.
- Source is fetched by immutable SHA and verified. Existing files, changed HEADs, and different Git origins are retained rather than reset.
- Runner state, logs, per-attempt deadlines, completed phases, and local databases persist under `/home/sprite/.sprite-launch/<launch-id>`. The checkout is `/home/sprite/project`.
- Setup has a remote 20-minute deadline, a five-minute Task lease refreshed every minute, process-group cancellation, and a bounded recovery retry count. Explicit retry uses the same Sprite with a new attempt identifier.
- App and database services survive cold wakes. Completed launches are not polled in the background. Cancelling or closing a tab retains the workspace; deletion requires an explicit action.

## Validation

```sh
npm test
npm run test:runner
npm run build
npm run test:browser
```

Runner checks select an installed Python 3.11+ with `hashlib.scrypt`; use `SPRITES_TEST_PYTHON` to choose one explicitly.

Browser tests load the real packaged extension in Chromium against ephemeral local TLS/HTTP/WebSocket fixtures. They exercise GitHub injection, trusted storage boundaries, source resolution, setup acknowledgement, actual header rules, preview navigation, HMR, and unrelated tabs/hosts. Install Chromium with `npx playwright install chromium` if needed.

The opt-in live checkout smoke test requires a locally authenticated Sprite CLI and an explicitly selected test organization:

```sh
SPRITES_LIVE_TEST_ORG=sprites-test python3 scripts/live_smoke.py
```

It creates one UUID-named Sprite, clones a public fixture at an exact SHA, checks HTTP readiness, lease cleanup, and recovery across a VM reboot, then deletes only that Sprite. `runner/smoke_matrix.py` is an additional opt-in in-Sprite matrix that validates conventional framework fixtures, real dependencies, local databases, migrations, and services. It bypasses cloning solely to prepare fixture source; the separate live smoke test validates real checkout.

See `SECURITY_REVIEW.md` for the security review and `VALIDATION.md` for the results and release limitations of this implementation. No Chrome Web Store publication or production API deployment is included.
