# Remote launch runner

`bootstrap.py` is uploaded unchanged to a fresh Sprite with a JSON manifest.
It uses Python's standard library and the Sprite's local management socket.
It does not receive an organization token.

```sh
python3 /home/sprite/.sprite-launch/<launch-id>/bootstrap.py \
  --manifest /home/sprite/.sprite-launch/<launch-id>/manifest.json
```

The manifest contains version `1`, `launchId`, `attemptId`, `setupStartedAt`
(ISO timestamp), the resolved `LaunchTarget`, the API-returned preview hostname,
and optional command overrides. See the extension's shared TypeScript types.

Each launch persists `state.json`, `launch.log`, its manifest, owned service
definitions, dependency-install fingerprints, and a deadline record. The
checkout lives at `/home/sprite/project`. Retries preserve local edits; a
different HEAD or origin requires manual attention rather than resetting it.
A setup lock prevents duplicate sessions. Recovery keeps the same attempt ID
and original deadline. An explicit retry gets a new attempt ID and clears the
`cancel` sentinel before starting.

Setup owns a five-minute Task lease, refreshed every minute, and has a remotely
enforced 20-minute total deadline. Cancellation and timeout terminate the active
subprocess group. Setup always attempts to release its Task lease. The app and
optional PostgreSQL server are persistent Sprite services; opening the extension
again does not depend on the old browser process remaining alive.

Automatic recipes cover conventional root-level static, Vite, Next.js, Node,
OpenClaw, Hermes Agent, Flask, FastAPI, Django, Go, Rails, and Phoenix projects. Missing/incompatible
runtimes, unsupported dependency formats, ambiguous entrypoints, conflicting
lockfiles, workspaces without an app directory, and unsupported database
adapters produce `needs_configuration`. Custom install/start commands are
deliberate shell commands entered by the user; repository identity is never
interpolated into a shell command.

Missing or mismatched npm/pnpm/Yarn versions are prepared through Corepack in
the launch directory. The exact `packageManager` version and optional integrity
hash are retained. No system-wide package manager or repository package metadata
is changed. The persistent service receives a launch-local wrapper/cache through
its PATH, so nested package commands still work after a reboot. Lockfile-only
pnpm projects use fixed compatible versions (lock v9: pnpm10.20.0; v6:8.15.9;
v5.3/v5.4:7.33.7); unknown formats require an explicit packageManager declaration.
pnpm's content-addressable store is also isolated under `tools/pnpm-store`.
Wrappers set both the legacy `npm_config_store_dir` and pnpm11+ native
`pnpm_config_store_dir` variables; old cached wrappers are migrated on retry.

SQLite databases are stored outside the checkout. PostgreSQL is installed with
Ubuntu's package manager when needed, then initialized in the launch directory
with generated credentials and a loopback-only service on port 15432. Framework
database overlays replace repository database settings. Automatic migrations
validate effective local targets, use no seeds, and do not use external URLs.
Django initializes its app registry and validates effective connections in the
same process that invokes migrations. Framework initialization and install hooks
are still repository code execution, as is starting the selected app.

## Tests

```sh
npm run test:runner
```

Run this command from the project root. It selects an installed Python 3.11+
with `hashlib.scrypt`; set `SPRITES_TEST_PYTHON` to choose an interpreter.

The test suite includes real local Git fetch/checkout, static/Node HTTP servers,
dependency-command and overlay checks for every recipe, retained-deadline and
generation checks, child-process cleanup, and a Django app-registry database
rewrite regression. Loopback servers and process inspection need an environment
that permits them.

For full framework/dependency/database validation, upload `smoke_matrix.py` next
to `bootstrap.py` **inside a disposable Sprite** and run:

```sh
python3 smoke_matrix.py
python3 smoke_matrix.py --only django-sqlite,django-postgres
```

The optional matrix installs real framework dependencies, configures real
SQLite/PostgreSQL databases, runs migrations, asserts fixture tables exist, and
starts each app through the actual management API. Only fixture checkout is
substituted; immutable Git checkout is tested separately. It cleans up its own
app/database services between cases and retains results and logs under
`/home/sprite/.sprite-launch-matrix/run-<id>`. Delete the disposable Sprite after
collecting results. These tests establish local service readiness; browser
preview authentication and HMR need the extension's browser/live tests too.
