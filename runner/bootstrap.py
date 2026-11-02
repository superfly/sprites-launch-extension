#!/usr/bin/env python3
"""Bundled, credential-free Sprite launch runner (Python standard library only).

The management client talks only to /.sprite/api.sock. This file is uploaded by
the extension with a non-secret manifest; repository code never receives the
extension's Sprites credential. Run with --manifest /path/to/manifest.json.
"""
from __future__ import annotations

import argparse
import contextlib
import dataclasses
import datetime
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from typing import Any
import urllib.error
import urllib.parse
import urllib.request


class NeedsConfiguration(Exception):
    pass


class Cancelled(Exception):
    pass


class SetupTimeout(Exception):
    pass


class ManagementError(RuntimeError):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def read_json(path: Path, default: Any = None) -> Any:
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return default


def atomic_json(path: Path, value: Any) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as out:
        os.chmod(tmp, 0o600)
        json.dump(value, out)
    os.replace(tmp, path)


def write_private(path: Path, value: str) -> Path:
    path.write_text(value)
    path.chmod(0o600)
    return path


# This helper runs in the checkout's selected Python environment after Hermes'
# own pinned package manager prepares it. Keep it embedded: bootstrap.py is the
# only runner file uploaded to a Sprite.
HERMES_HELPER = r'''#!/usr/bin/env python3
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys

class ConfigurationError(Exception):
    pass

def private_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("w", encoding="utf-8") as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output)
    os.replace(temporary, path)

def mapping(parent, key):
    value = parent.get(key)
    if value is None and key not in parent:
        value = parent[key] = {}
    if not isinstance(value, dict):
        raise ConfigurationError("The retained Hermes " + key + " must be a mapping; inspect config.yaml in the terminal")
    return value

def password_hash(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
    return "scrypt$16384$8$1$" + base64.b64encode(salt).decode() + "$" + base64.b64encode(digest).decode()

def password_matches(password, encoded):
    try:
        scheme, n, r, p, salt, expected = encoded.split("$")
        if scheme != "scrypt" or (n, r, p) != ("16384", "8", "1"):
            return False
        salt = base64.b64decode(salt, validate=True)
        expected = base64.b64decode(expected, validate=True)
        if len(salt) != 16 or len(expected) != 32:
            return False
        actual = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False

def configure(data):
    # Parse with the same duplicate-key-rejecting YAML policy as Hermes.
    sys.path.insert(0, data["root"])
    from hermes_yaml import safe_load, safe_dump
    directory = Path(data["directory"])
    home = Path(os.environ["HERMES_HOME"])
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    home.chmod(0o700)
    config_path = home / "config.yaml"
    connection_path = directory / "hermes-connection.json"
    exists = config_path.exists()
    try:
        config = safe_load(config_path.read_text()) if exists else {}
    except Exception as exc:
        raise ConfigurationError("The retained Hermes config.yaml cannot be parsed; inspect it in the terminal") from exc
    if not isinstance(config, dict):
        raise ConfigurationError("The retained Hermes config.yaml must be a mapping; inspect it in the terminal")
    original = json.dumps(config, sort_keys=True, default=str)
    dashboard = mapping(config, "dashboard")
    basic = mapping(dashboard, "basic_auth")
    terminal = mapping(config, "terminal")
    if connection_path.exists():
        try:
            connection = json.loads(connection_path.read_text())
        except (ValueError, OSError) as exc:
            raise ConfigurationError("The retained Hermes connection credentials cannot be read; inspect them in the terminal") from exc
        if not isinstance(connection, dict) or connection.get("username") != "sprite" or not isinstance(connection.get("password"), str) or not connection["password"]:
            raise ConfigurationError("The retained Hermes connection credentials are invalid; inspect them in the terminal")
        connection_path.chmod(0o600)
    elif exists:
        raise ConfigurationError("The retained Hermes config has no matching launch credentials; configure authentication in the terminal")
    else:
        connection = {"username": "sprite", "password": secrets.token_urlsafe(36)}
        # Persist the password first so interruption before config publication
        # can reconstruct the same account instead of silently rotating it.
        private_json(connection_path, connection)
    if exists:
        if (basic.get("username") != connection["username"]
                or not isinstance(basic.get("password_hash"), str)
                or not password_matches(connection["password"], basic["password_hash"])
                or not isinstance(basic.get("secret"), str) or len(basic["secret"]) < 32
                or any(marker in basic["secret"] for marker in ("$(", "`", "openssl rand"))
                or ("password" in basic and basic["password"] not in (None, ""))):
            raise ConfigurationError("The retained Hermes authentication does not match this launch's password; inspect config.yaml in the terminal")
        if dashboard.get("public_url") != "https://" + data["hostname"]:
            raise ConfigurationError("The retained Hermes dashboard.public_url must match this Sprite's exact HTTPS hostname")
        if terminal.get("backend") != "local" or terminal.get("cwd") != data["root"]:
            raise ConfigurationError("The retained Hermes terminal must use the local backend and this checkout directory")
        if "trusted_proxies" in dashboard and (not isinstance(dashboard["trusted_proxies"], list) or any(not isinstance(value, str) or not value for value in dashboard["trusted_proxies"])):
            raise ConfigurationError("The retained Hermes dashboard.trusted_proxies must be a list of bounded proxy addresses")
    else:
        basic.update(username=connection["username"], password_hash=password_hash(connection["password"]), secret=secrets.token_hex(32))
        dashboard.update(public_url="https://" + data["hostname"], trusted_proxies=["10.0.0.2/32", "fdf::2/128"])
        terminal.update(backend="local", cwd=data["root"])
    if not exists or json.dumps(config, sort_keys=True, default=str) != original:
        private_json(directory / "hermes-config-restart.json", {"pending": True})
        temporary = config_path.with_suffix(".yaml.tmp")
        with temporary.open("w", encoding="utf-8") as output:
            os.chmod(temporary, 0o600)
            output.write(safe_dump(config, sort_keys=False))
        os.replace(temporary, config_path)
    config_path.chmod(0o600)

def build(data):
    root = Path(data["root"])
    directory = Path(data["directory"])
    # pm env emits a JSON object, not shell text. Its exports contain only
    # package context, so no inherited account credentials are persisted.
    exported = json.loads(subprocess.check_output([sys.executable, "-m", "pm.cli", "env", "npm"], cwd=root, text=True))
    if not isinstance(exported, dict) or any(not isinstance(k, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", k) or not isinstance(v, str) for k, v in exported.items()):
        raise ConfigurationError("Hermes PM returned an invalid tool environment")
    environment = dict(os.environ)
    for key, value in exported.items():
        environment[key] = value + (os.pathsep + environment.get("PATH", "") if key == "PATH" else "")
    sys.path.insert(0, str(root))
    from pm.environments import project_python
    python = str(project_python(root))
    if not Path(python).is_file():
        raise ConfigurationError("Hermes PM did not prepare its selected Python environment")
    node = shutil.which("node", path=environment.get("PATH"))
    if not node:
        raise ConfigurationError("Hermes PM did not prepare its pinned Node runtime")
    private_json(directory / "hermes-runtime.json", {"version": 1, "root": str(root), "python": python, "environment": exported})
    subprocess.run([python, __file__, "configure", str(directory / "hermes-launch-input.json")], cwd=root, env=environment, check=True)
    subprocess.run([node, str(root / "scripts/build/node-deps.mjs"), "--source", str(root), "--reuse", "--workspace", "web"], cwd=root, env=environment, check=True)
    subprocess.run([node, str(root / "scripts/build/web.mjs"), "--source", str(root), "--icons", str(root), "--out", os.environ["HERMES_WEB_DIST"]], cwd=root, env=environment, check=True)

if __name__ == "__main__":
    data_path = Path(sys.argv[2])
    data = json.loads(data_path.read_text())
    error_path = data_path.parent / "hermes-helper-error.json"
    error_path.unlink(missing_ok=True)
    try:
        if sys.argv[1] == "configure":
            configure(data)
        elif sys.argv[1] == "build":
            build(data)
        else:
            raise ConfigurationError("Unknown Hermes preparation step")
    except ConfigurationError as exc:
        private_json(error_path, {"message": str(exc)})
        print(str(exc), file=sys.stderr)
        sys.exit(78)
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode)
'''


class UnixHTTP(http.client.HTTPConnection):
    def __init__(self, path: str):
        super().__init__("sprite", timeout=10)
        self.path = path

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


class Management:
    def request(self, method: str, path: str, body: Any = None) -> Any:
        connection = UnixHTTP("/.sprite/api.sock")
        data = None if body is None else json.dumps(body).encode()
        try:
            connection.request(method, path, data, {"Content-Type": "application/json"})
            response = connection.getresponse()
            value = response.read()
            if response.status >= 300:
                if method == "DELETE" and response.status == 404:
                    return None
                raise ManagementError(response.status, f"Sprite management {method} {path}: HTTP {response.status}: {value[:500].decode(errors='replace')}")
            if not value:
                return None
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                # Service creation can stream NDJSON even without stream=false.
                return [json.loads(line) for line in value.splitlines() if line]
        finally:
            connection.close()


@dataclasses.dataclass
class Recipe:
    name: str
    install: list[list[str]]
    start: list[str]
    port: int = 8080
    env: dict[str, str] = dataclasses.field(default_factory=dict)
    database: str | None = None
    migrate: list[list[str]] = dataclasses.field(default_factory=list)
    runtime: str | None = None
    health_path: str = "/"


def validate_manifest(manifest: dict) -> None:
    if manifest.get("version") != 1:
        raise ValueError("Unsupported launch manifest version")
    if not re.fullmatch(r"[A-Za-z0-9-]{8,64}", str(manifest.get("launchId", ""))):
        raise ValueError("Invalid launch ID")
    target = manifest.get("target", {})
    for key in ("owner", "repo"):
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", str(target.get(key, ""))) or target[key] in (".", ".."):
            raise ValueError(f"Invalid repository {key}")
    if target.get("cloneUrl") != f"https://github.com/{target['owner']}/{target['repo']}.git":
        raise ValueError("Only public github.com HTTPS repository URLs are accepted")
    if not re.fullmatch(r"[0-9a-fA-F]{40}", str(target.get("sha", ""))):
        raise ValueError("An exact 40-character source SHA is required")
    if not re.fullmatch(r"[a-z0-9-]+(?:\.[a-z0-9-]+)*\.sprites\.app", str(manifest.get("hostname", ""))):
        raise ValueError("Invalid Sprite preview hostname")
    override = manifest.get("overrides")
    if override is not None:
        if not isinstance(override, dict):
            raise ValueError("Invalid launch overrides")
        port = override.get("port", 8080)
        if isinstance(port, bool) or not isinstance(port, int) or not 1 <= port <= 65535:
            raise ValueError("HTTP port must be between 1 and 65535")
        for key in ("directory", "installCommand", "startCommand"):
            if not isinstance(override.get(key, ""), str) or "\x00" in override.get(key, ""):
                raise ValueError(f"Invalid override: {key}")


def clean_environment() -> dict[str, str]:
    forbidden = {"SPRITE_TOKEN", "SPRITE_WORKER_TOKEN", "SPRITES_TOKEN", "FLY_API_TOKEN", "FLY_ORG_TOKEN"}
    env = {k: v for k, v in os.environ.items() if k not in forbidden and not k.startswith("AUTHED_SPRITE_ORG_")}
    env.update({"CI": "1", "GIT_TERMINAL_PROMPT": "0", "PIP_DISABLE_PIP_VERSION_CHECK": "1", "PYTHONUNBUFFERED": "1"})
    paths = []
    try:
        paths = [p for p in Path("/etc/profile.d/languages_paths").read_text().splitlines() if Path(p).is_dir()]
    except FileNotFoundError:
        pass
    env["PATH"] = os.pathsep.join(paths + [env.get("PATH", "/usr/local/bin:/usr/bin:/bin")])
    return env


def package_manager(root: Path, package: dict) -> tuple[str, list[str]]:
    declared = package.get("packageManager", "")
    matches = re.fullmatch(r"(npm|pnpm|yarn|bun)@([0-9][^\s]*)", declared) if declared else None
    if declared and not matches:
        raise NeedsConfiguration("Unrecognized packageManager declaration")
    lock_names = {"npm": ["package-lock.json", "npm-shrinkwrap.json"], "pnpm": ["pnpm-lock.yaml"], "yarn": ["yarn.lock"], "bun": ["bun.lock", "bun.lockb"]}
    locked = [manager for manager, names in lock_names.items() if any((root / name).exists() for name in names)]
    if len(locked) > 1:
        raise NeedsConfiguration("Conflicting package-manager lockfiles; choose an install command")
    manager = matches[1] if matches else (locked[0] if locked else "npm")
    if locked and manager != locked[0]:
        raise NeedsConfiguration("packageManager does not match the repository lockfile")
    if manager == "npm":
        return manager, [manager, "ci" if locked else "install", "--no-audit", "--no-fund"]
    if manager == "yarn":
        major = int(matches[2].split(".")[0]) if matches else None
        if major is None and (root / ".yarnrc.yml").exists():
            raise NeedsConfiguration("Declare the Yarn version in packageManager")
        return manager, [manager, "install"] + (["--immutable"] if locked and major and major >= 2 else (["--frozen-lockfile"] if locked else []))
    return manager, [manager, "install"] + (["--frozen-lockfile"] if locked else [])


def package_manager_pin(root: Path, package: dict, manager: str) -> str | None:
    """Keep repository integrity pins intact; never resolve a moving latest tag."""
    declared = package.get("packageManager")
    if declared:
        if not re.fullmatch(r"(?:npm|pnpm|yarn|bun)@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+sha(?:1|224|256|384|512)\.[a-fA-F0-9]+)?", declared):
            raise NeedsConfiguration("packageManager must specify an exact version and optional integrity hash")
        return declared
    if manager == "pnpm":
        lock = root / "pnpm-lock.yaml"
        match = re.search(r"(?m)^lockfileVersion:\s*['\"]?([0-9.]+)", lock.read_text() if lock.exists() else "")
        version = match[1] if match else ""
        if version in ("9", "9.0"):
            return "pnpm@10.20.0"
        if version in ("6", "6.0"):
            return "pnpm@8.15.9"
        if version in ("5.3", "5.4"):
            return "pnpm@7.33.7"
        raise NeedsConfiguration("Declare an exact packageManager version for this pnpm lockfile")
    if manager == "yarn":
        return "yarn@1.22.22"
    return None


def database_kind(text: str, *, default: str | None = None) -> str | None:
    # Refuse formats whose target we cannot confidently override.
    if re.search(r"mysql|mariadb|cockroach|sqlserver|oracle|mongodb", text, re.I):
        raise NeedsConfiguration("This database adapter requires manual configuration; automatic databases support SQLite and PostgreSQL")
    if re.search(r"postgres|psycopg|Postgrex", text, re.I):
        return "postgres"
    if re.search(r"sqlite", text, re.I):
        return "sqlite"
    return default


def version_satisfies(version: str, requirement: str) -> bool:
    """Conservative support for conventional semver/PEP-440 runtime ranges.

    Unrecognized syntax requires configuration instead of silently ignoring
    a repository's engine requirement. No external semver package is needed.
    """
    found = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", version)
    if not found:
        raise NeedsConfiguration("Cannot determine the installed runtime version")
    actual = tuple(int(v or 0) for v in found.groups())
    alternatives = requirement.split("||")
    for alternative in alternatives:
        tokens = re.findall(r"(?:>=|<=|>|<|==|=|\^|~>|~=|~)?\s*v?\d+(?:\.(?:\d+|[xX*])){0,2}", alternative)
        remainder = alternative
        for token in tokens:
            remainder = remainder.replace(token, "", 1)
        if not tokens or remainder.replace(",", "").strip():
            raise NeedsConfiguration(f"Cannot verify runtime requirement {requirement!r}")
        matches = True
        for token in tokens:
            item = re.fullmatch(r"(>=|<=|>|<|==|=|\^|~>|~=|~)?\s*v?(\d+(?:\.(?:\d+|[xX*])){0,2})", token)
            op, raw = item[1] or "=", item[2]
            pieces = raw.split(".")
            numeric = [int(v) for v in pieces if v.isdigit()]
            wanted = tuple(numeric + [0] * (3 - len(numeric)))
            if op in ("=", "=="):
                ok = actual[:len(numeric)] == tuple(numeric)
            elif op == ">=":
                ok = actual >= wanted
            elif op == ">":
                ok = actual > wanted
            elif op == "<=":
                ok = actual <= wanted
            elif op == "<":
                ok = actual < wanted
            else:
                if op == "^":
                    index = next((i for i, v in enumerate(wanted) if v), 2)
                elif op == "~":
                    index = min(1, len(numeric) - 1)
                else:  # Ruby/Elixir ~>, Python ~= use the penultimate part.
                    index = max(0, len(numeric) - 2)
                upper = list(wanted)
                upper[index] += 1
                upper[index + 1:] = [0] * (2 - index)
                ok = wanted <= actual < tuple(upper)
            matches = matches and ok
        if matches:
            return True
    return False


class Runner:
    def __init__(self, manifest_path: Path, *, checkout: Path | None = None, management: Management | None = None, timeout: float = 1200):
        self.manifest_path = manifest_path.resolve()
        self.manifest = read_json(self.manifest_path)
        validate_manifest(self.manifest)
        self.directory = self.manifest_path.parent
        self.checkout = (checkout or Path("/home/sprite/project")).resolve()
        self.root = self.checkout
        self.management = management or Management()
        self.deadline = time.monotonic() + timeout
        self.timeout = timeout
        self.attempt_id = str(self.manifest.get("attemptId", self.manifest["launchId"]))
        self.environment = clean_environment()
        self.state = read_json(self.directory / "state.json", {})
        self.completed = read_json(self.directory / "completed.json", {})
        self.stop = threading.Event()
        self.child: subprocess.Popen | None = None
        self.lock = threading.Lock()
        self.cancelled = False
        self.task = "launch-" + self.manifest["launchId"][:20]
        self.app_service = "launch-app-" + self.manifest["launchId"][:8]
        self.pg_service = "launch-pg-" + self.manifest["launchId"][:8]
        self.log_handle = None
        self.database = None
        # A config-only update must survive interruption before its service
        # reload, without changing the dependency installation fingerprint.
        self.config_changed = any((self.directory / name).exists() for name in ("openclaw-config-restart.json", "hermes-config-restart.json"))

    def log(self, message: str) -> None:
        if self.log_handle:
            self.log_handle.write((message + "\n").encode())
            self.log_handle.flush()

    def update(self, phase: str, message: str = "", **extra) -> None:
        self.state.update({"phase": phase, "message": message, "updatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "setupPid": os.getpid(), "attemptId": self.attempt_id})
        self.state.pop("error", None)
        self.state.update(extra)
        atomic_json(self.directory / "state.json", self.state)
        self.log(f"[{phase}] {message}")

    def check(self) -> None:
        if self.cancelled or (self.directory / "cancel").exists():
            raise Cancelled("Setup cancelled. The workspace has been retained.")
        if time.monotonic() >= self.deadline:
            raise SetupTimeout("Setup exceeded its 20-minute deadline. The checkout and logs have been retained.")

    def terminate_child(self) -> None:
        with self.lock:
            child = self.child
        if child and child.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(2)
            except subprocess.TimeoutExpired:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait()

    def heartbeat(self) -> None:
        next_refresh = time.monotonic() + 60
        while not self.stop.wait(0.25):
            try:
                self.check()
            except (Cancelled, SetupTimeout):
                self.terminate_child()
                return
            if time.monotonic() >= next_refresh:
                try:
                    self.management.request("PUT", f"/v1/tasks/{self.task}", {"expire": "5m"})
                except Exception as exc:
                    self.log(f"Task lease refresh failed: {type(exc).__name__}")
                next_refresh = time.monotonic() + 60

    def run_command(self, argv: list[str], *, env: dict[str, str] | None = None, cwd: Path | None = None, capture: bool = False) -> str:
        self.check()
        command_env = dict(self.environment)
        command_env.update(env or {})
        if not shutil.which(argv[0], path=command_env.get("PATH")) and not Path(argv[0]).is_file():
            raise NeedsConfiguration(f"Required command is unavailable: {argv[0]}")
        self.log("$ " + shlex.join(argv))
        # Capture to a temporary file rather than a pipe so a noisy child cannot
        # deadlock while the cancellation/deadline loop waits for it.
        temp = self.directory / ".command-output"
        with open(temp, "wb") if capture else contextlib.nullcontext(self.log_handle) as output:
            child = subprocess.Popen(argv, cwd=str(cwd or self.root), env=command_env, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            with self.lock:
                self.child = child
            try:
                while child.poll() is None:
                    self.check()
                    time.sleep(0.1)
                self.check()
            finally:
                if child.poll() is None:
                    self.terminate_child()
                with self.lock:
                    self.child = None
        value = temp.read_text(errors="replace") if capture else ""
        if capture:
            self.log(value.rstrip())
            temp.unlink(missing_ok=True)
        if child.returncode:
            raise RuntimeError(f"Command failed ({child.returncode}): {argv[0]}. See launch.log for output.")
        return value.strip()

    def complete(self, key: str) -> None:
        self.completed[key] = True
        atomic_json(self.directory / "completed.json", self.completed)

    def install_key(self, recipe: Recipe) -> str:
        dependency_files = ("package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "requirements.txt", "pyproject.toml", "Gemfile", "Gemfile.lock", "mix.exs", "mix.lock", "go.mod", "go.sum")
        hashes = {name: hashlib.sha256((self.root / name).read_bytes()).hexdigest() for name in dependency_files if (self.root / name).is_file()}
        if recipe.name == "hermes":
            for name in ("uv.lock", "pm/lock.json", "web/package.json", "apps/shared/package.json"):
                if (self.root / name).is_file():
                    hashes[name] = hashlib.sha256((self.root / name).read_bytes()).hexdigest()
            hashes["launch-helper"] = hashlib.sha256(HERMES_HELPER.encode()).hexdigest()
        if recipe.name == "go":
            hashes.update({str(p.relative_to(self.root)): hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob("*.go") if ".git" not in p.parts})
        commands = []
        for argv in recipe.install:
            if len(argv) >= 2 and argv[0] in ("npm", "pnpm", "yarn", "bun") and argv[1] in ("install", "ci"):
                commands.append([argv[0], "dependencies"] + [arg for arg in argv[2:] if arg not in ("--frozen-lockfile", "--immutable")])
            else:
                commands.append(argv)
        fingerprint = hashlib.sha256(json.dumps({"name": recipe.name, "install": commands, "root": str(self.root), "files": hashes}, sort_keys=True).encode()).hexdigest()
        return "install:" + fingerprint

    def ensure_service(self, name: str, body: dict, *, restart: bool = False) -> None:
        """Reconcile only services this launch recorded ownership of.

        PUT is create-only in sprite-env: equal binaries do not update args,
        environment, or directory. Explicitly replace our own changed config.
        """
        self.check()
        saved_path = self.directory / (name + ".json")
        previous = read_json(saved_path)
        try:
            existing = self.management.request("GET", f"/v1/services/{name}")
        except ManagementError as exc:
            if exc.status != 404:
                raise
            existing = None
        if existing:
            def normalized(spec):
                return {"cmd": spec.get("cmd"), "args": spec.get("args") or [], "dir": spec.get("dir") or "", "env": spec.get("env") or {}, "needs": spec.get("needs") or [], "http_port": spec.get("http_port")}
            if previous is None or normalized(existing) != normalized(previous):
                raise NeedsConfiguration(f"Service {name} has an unrecognized owner; refusing to replace it")
            if previous == body and not restart:
                if existing.get("state", {}).get("status") != "running":
                    self.management.request("POST", f"/v1/services/{name}/start?duration=100ms")
                return
            self.management.request("POST", f"/v1/services/{name}/stop?duration=100ms")
            self.management.request("DELETE", f"/v1/services/{name}")
        atomic_json(saved_path, body)
        self.management.request("PUT", f"/v1/services/{name}?duration=100ms", body)

    def clone(self) -> None:
        self.update("cloning", "Checking out the exact selected revision")
        target = self.manifest["target"]
        self.checkout.mkdir(parents=True, exist_ok=True)
        if not (self.checkout / ".git").exists():
            if any(self.checkout.iterdir()):
                raise NeedsConfiguration("The project directory already contains files; refusing to replace them")
            self.run_command(["git", "init", str(self.checkout)], cwd=self.directory)
            self.run_command(["git", "remote", "add", "origin", target["cloneUrl"]], cwd=self.checkout)
        remote = self.run_command(["git", "config", "--get", "remote.origin.url"], cwd=self.checkout, capture=True)
        if remote != target["cloneUrl"]:
            raise NeedsConfiguration("Existing checkout has a different origin; it has been retained")
        try:
            head = self.run_command(["git", "rev-parse", "--verify", "HEAD"], cwd=self.checkout, capture=True)
        except RuntimeError:
            head = ""
        if head:
            if head.lower() != target["sha"].lower():
                raise NeedsConfiguration("Existing checkout has a different revision; refusing to overwrite local work")
            self.complete("clone")
            return
        # Fetch the immutable SHA, not a branch name that could change after the
        # user clicked. GitHub retains PR objects even after fork deletion.
        self.run_command(["git", "fetch", "--depth", "1", "origin", target["sha"]], cwd=self.checkout)
        fetched = self.run_command(["git", "rev-parse", "FETCH_HEAD^{commit}"], cwd=self.checkout, capture=True)
        if fetched.lower() != target["sha"].lower():
            raise RuntimeError("Fetched commit does not match the requested SHA")
        self.run_command(["git", "checkout", "--detach", target["sha"]], cwd=self.checkout)
        if self.run_command(["git", "rev-parse", "HEAD"], cwd=self.checkout, capture=True).lower() != target["sha"].lower():
            raise RuntimeError("Checkout verification failed")
        self.complete("clone")

    def select_root(self) -> None:
        override = self.manifest.get("overrides") or {}
        selected = override.get("directory") or "."
        self.root = (self.checkout / selected).resolve()
        if not self.root.is_relative_to(self.checkout) or not self.root.is_dir():
            raise NeedsConfiguration("App directory must exist inside the checkout")

    def require_runtime(self, binary: str, pin_files: list[str], version_flag: str = "--version") -> None:
        if not shutil.which(binary, path=self.environment["PATH"]):
            raise NeedsConfiguration(f"{binary} is not installed in this Sprite")
        pin = next(((self.root / name).read_text().strip() for name in pin_files if (self.root / name).is_file()), "")
        if not pin:
            return
        expected = re.fullmatch(r"v?(\d+)(?:\.(\d+))?(?:\.(\d+))?", pin)
        if not expected:
            raise NeedsConfiguration(f"Cannot verify the runtime pin {pin!r}; choose a compatible runtime in the terminal")
        output = self.run_command([binary, version_flag], capture=True)
        found = re.search(r"(?:v|\b)(\d+)\.(\d+)(?:\.(\d+))?", output)
        if not found or any(value is not None and value != found[index] for index, value in enumerate(expected.groups(), 1)):
            raise NeedsConfiguration(f"Installed {binary} does not satisfy the repository runtime pin {pin}")

    def python_install(self) -> tuple[list[list[str]], str]:
        self.require_runtime("python3", [".python-version"])
        project = self.root / "pyproject.toml"
        if project.exists():
            pin = re.search(r'requires-python\s*=\s*["\']([^"\']+)["\']', project.read_text())
            if pin and not version_satisfies(self.run_command(["python3", "--version"], capture=True), pin[1]):
                raise NeedsConfiguration(f"Installed Python does not satisfy requires-python {pin[1]}")
        venv = self.directory / "venv"
        python = str(venv / "bin/python")
        install = [["python3", "-m", "venv", str(venv)]]
        if (self.root / "requirements.txt").exists():
            install.append([python, "-m", "pip", "install", "-r", "requirements.txt"])
        elif (self.root / "pyproject.toml").exists():
            text = (self.root / "pyproject.toml").read_text()
            if not re.search(r"(?m)^\[project\]", text):
                raise NeedsConfiguration("This pyproject format needs an explicit install command")
            install.append([python, "-m", "pip", "install", "."])
        else:
            raise NeedsConfiguration("Python app needs requirements.txt or an installable pyproject.toml")
        return install, python

    def ensure_package_manager(self, package: dict, manager: str) -> None:
        """Provision launch-local, pinned package tools rather than editing Node's installation.

        Corepack verifies a packageManager integrity suffix. Our small wrapper
        pins both the request and cache location even in a persistent service,
        where the setup process's environment is otherwise no longer present.
        """
        pin = package_manager_pin(self.root, package, manager)
        desired = pin.split("@", 1)[1].split("+", 1)[0] if pin else None
        tools = self.directory / "tools"
        shims = tools / "bin"
        wrapper = shims / manager
        marker_path = tools / (manager + ".json")
        cached = read_json(marker_path, {})
        cp_env = {"COREPACK_HOME": str(tools / "corepack-cache"), "COREPACK_ENABLE_DOWNLOAD_PROMPT": "0", "COREPACK_ENABLE_AUTO_PIN": "0", "COREPACK_DEFAULT_TO_LATEST": "0"}
        if manager == "pnpm":
            # pnpm 11+ reads pnpm_config_*; <=10 uses npm_config_*.
            # Emit both so every pinned major gets an isolated, persistent store.
            cp_env.update({"npm_config_store_dir": str(tools / "pnpm-store"), "pnpm_config_store_dir": str(tools / "pnpm-store")})
        wrapper_path = str(shims) + os.pathsep + self.environment["PATH"]

        def write_wrapper(binary: str, arguments: list[str]) -> None:
            shims.mkdir(parents=True, exist_ok=True)
            exports = "".join("export " + key + "=" + shlex.quote(value) + "\n" for key, value in cp_env.items())
            command = shlex.join([binary] + arguments)
            write_private(wrapper, "#!/bin/sh\n" + exports + "exec " + command + ' "$@"\n')
            wrapper.chmod(0o700)
            atomic_json(marker_path, {"pin": pin, "corepack": binary if arguments else None, "binary": binary, "arguments": arguments, "environment": cp_env, "wrapperVersion": 2})
            self.environment["PATH"] = wrapper_path

        existing = shutil.which(manager, path=self.environment["PATH"])
        if existing and not pin:
            return
        if existing and desired and "+sha" not in pin:
            actual = self.run_command([manager, "--version"], capture=True).splitlines()
            if actual and actual[-1].strip() == desired:
                if manager != "pnpm":
                    return
                # Reuse a compatible installed pnpm, but still isolate its store.
                if Path(existing) != wrapper:
                    write_wrapper(existing, [])
                    return
                if cached.get("pin") == pin and cached.get("arguments") == [] and cached.get("binary"):
                    write_wrapper(cached["binary"], [])
                    return
        if manager == "bun":
            raise NeedsConfiguration(f"Install the required Bun version {desired or ''} in the terminal")
        if manager not in ("npm", "pnpm", "yarn") or pin is None:
            raise NeedsConfiguration(f"Required package tool is unavailable: {manager}")

        shims.mkdir(parents=True, exist_ok=True)
        if cached.get("pin") == pin and cached.get("environment") == cp_env and cached.get("wrapperVersion") == 2 and wrapper.is_file():
            self.environment["PATH"] = wrapper_path
            actual = self.run_command([manager, "--version"], capture=True).splitlines()
            if actual and actual[-1].strip() == desired:
                return

        self.update("installing", f"Preparing {manager} {desired}")
        installed = tools / "corepack" / "node_modules" / ".bin" / "corepack"
        corepack = str(installed) if installed.is_file() else shutil.which("corepack", path=self.environment["PATH"])

        def verified(binary: str) -> bool:
            try:
                lines = self.run_command([binary, pin, "--version"], env=cp_env, cwd=self.directory, capture=True).splitlines()
                return bool(lines and lines[-1].strip() == desired)
            except RuntimeError:
                return False

        if not corepack or not verified(corepack):
            npm = shutil.which("npm", path=self.environment["PATH"])
            if not npm:
                raise NeedsConfiguration(f"Preparing {manager} requires npm or a compatible Corepack installation")
            node = self.run_command(["node", "--version"], capture=True)
            if version_satisfies(node, "^22.22.2 || ^24.15.0 || >=26.0.0"):
                corepack_version = "0.36.0"
            elif version_satisfies(node, "^20.10.0 || ^22.11.0 || >=24.0.0"):
                corepack_version = "0.34.0"
            elif version_satisfies(node, "^18.17.1 || ^20.10.0 || >=22.11.0"):
                corepack_version = "0.31.0"
            else:
                raise NeedsConfiguration("This Node version is too old to bootstrap a supported Corepack; choose a compatible runtime")
            self.run_command([npm, "install", "--prefix", str(tools / "corepack"), "--registry=https://registry.npmjs.org", "--no-audit", "--no-fund", "--ignore-scripts", "--package-lock=false", "--save=false", f"corepack@{corepack_version}"], env=cp_env, cwd=self.directory)
            corepack = str(installed)
            if not verified(corepack):
                raise RuntimeError(f"Could not provision verified {pin}; see launch.log for the Corepack error")

        write_wrapper(corepack, [pin])

    def is_hermes(self, package: dict) -> bool:
        """Recognize the complete source dashboard, not an arbitrary workspace."""
        if package.get("name") != "hermes-agent":
            return False
        markers = ("hermes_cli/main.py", "hermes_cli/web_server.py", "web/package.json", "web/vite.config.ts", "web/public/favicon.ico", "scripts/build/node-deps.mjs", "scripts/build/web.mjs", "pm/cli.py", "pm/lock.json", "uv.lock", "pyproject.toml", "package-lock.json")
        if not all((self.root / name).is_file() for name in markers):
            return False
        project = (self.root / "pyproject.toml").read_text()
        section = re.search(r"(?ms)^\[project\]\s*(.*?)(?=^\[|\Z)", project)
        return bool(section and re.search(r'(?m)^name\s*=\s*["\']hermes-agent["\']\s*$', section[1]))

    def hermes_recipe(self, port: int) -> Recipe:
        python = shutil.which("python3.14", path=self.environment["PATH"])
        if not python or not version_satisfies(self.run_command([python, "--version"], capture=True), ">=3.14,<3.15"):
            raise NeedsConfiguration("Hermes Agent requires Python 3.14; install a compatible runtime in the terminal")
        # A fresh Hermes home must not discover inherited host credentials or
        # runtime/config overrides. Its service receives only explicit context.
        for key in list(self.environment):
            if (key.startswith(("HERMES_", "OPENAI_", "ANTHROPIC_", "OPENROUTER_", "NOUS_", "GEMINI_", "GOOGLE_", "AWS_", "AZURE_", "HF_", "COHERE_", "MISTRAL_", "GROQ_", "XAI_", "DEEPSEEK_"))
                    or key in ("GH_TOKEN", "GITHUB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "UV_PROJECT_ENVIRONMENT", "UV_PYTHON", "NODE_PATH", "npm_execpath", "npm_node_execpath")
                    or re.search(r"(?:^|_)(?:API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|SECRET_KEY)$", key)):
                self.environment.pop(key)
        environment = {"HERMES_HOME": str(self.directory / "hermes-home"), "HERMES_RUNTIME_DIR": str(self.directory / "hermes-runtime"), "HERMES_WEB_DIST": str(self.directory / "web-dist"), "HERMES_WEB_BUILD_LIGHT": "1"}
        helper = write_private(self.directory / "hermes-launch.py", HERMES_HELPER)
        atomic_json(self.directory / "hermes-launch-input.json", {"version": 1, "root": str(self.root), "directory": str(self.directory), "hostname": self.manifest["hostname"]})
        return Recipe("hermes", [[python, "-m", "pm.cli", "install", "npm", "--extra", "web"], [python, str(helper), "build", str(self.directory / "hermes-launch-input.json")]], [], port, environment, runtime="python3.14", health_path="/api/health")

    def hermes_context(self) -> dict | None:
        try:
            context = read_json(self.directory / "hermes-runtime.json")
        except (ValueError, OSError):
            return None
        if (not isinstance(context, dict) or context.get("version") != 1 or context.get("root") != str(self.root)
                or not isinstance(context.get("python"), str) or not Path(context["python"]).is_file()
                or not isinstance(context.get("environment"), dict)
                or any(not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key) or not isinstance(value, str) for key, value in context["environment"].items())):
            return None
        return context

    def run_hermes_command(self, argv: list[str], recipe: Recipe) -> None:
        (self.directory / "hermes-helper-error.json").unlink(missing_ok=True)
        try:
            self.run_command(argv, env=recipe.env)
        except RuntimeError:
            error = read_json(self.directory / "hermes-helper-error.json", {})
            if isinstance(error, dict) and isinstance(error.get("message"), str) and error["message"]:
                raise NeedsConfiguration(error["message"]) from None
            raise

    def prepare_hermes_service(self, recipe: Recipe) -> None:
        context = self.hermes_context()
        if context is None:
            raise NeedsConfiguration("Hermes' selected Python environment is missing; retry setup to repair it")
        exported = context["environment"]
        environment = {key: value for key, value in exported.items() if key != "PATH"}
        environment["PATH"] = os.pathsep.join(dict.fromkeys((exported.get("PATH", "") + os.pathsep + self.environment["PATH"]).split(os.pathsep)))
        # The recipe owns these paths even if PM acquires new runtime exports.
        recipe.env = {**environment, **recipe.env}
        self.environment["PATH"] = recipe.env["PATH"]
        self.run_hermes_command([context["python"], str(self.directory / "hermes-launch.py"), "configure", str(self.directory / "hermes-launch-input.json")], recipe)
        recipe.start = [context["python"], "-m", "hermes_cli.main", "dashboard", "--no-open", "--host", "0.0.0.0", "--port", str(recipe.port), "--skip-build"]
        self.config_changed = self.config_changed or (self.directory / "hermes-config-restart.json").exists()
        shims = self.directory / "tools" / "bin"
        shims.mkdir(parents=True, exist_ok=True)
        self.environment["PATH"] = os.pathsep.join(dict.fromkeys([str(shims)] + self.environment["PATH"].split(os.pathsep)))
        recipe.env["PATH"] = self.environment["PATH"]
        exports = "".join("export " + key + "=" + shlex.quote(value) + "\n" for key, value in recipe.env.items())
        command = shlex.join([context["python"], "-m", "hermes_cli.main"])
        # -m needs the checkout on sys.path even from an arbitrary terminal cwd.
        wrapper = write_private(shims / "hermes", "#!/bin/sh\n" + exports + "export PYTHONPATH=" + shlex.quote(str(self.root)) + '"${PYTHONPATH:+:$PYTHONPATH}"\nexec ' + command + ' "$@"\n')
        wrapper.chmod(0o700)

    def detect(self) -> Recipe:
        self.update("detecting", "Detecting framework, dependencies, and local database requirements")
        self.select_root()
        override = self.manifest.get("overrides") or {}
        port = override.get("port", 8080)
        host = self.manifest["hostname"]
        package = read_json(self.root / "package.json")
        # Backend frameworks frequently carry a package.json for asset tools.
        # Their server owns the application and must take precedence.
        if (self.root / "manage.py").exists() or ((self.root / "Gemfile").exists() and (self.root / "bin/rails").exists()) or ((self.root / "mix.exs").exists() and "phoenix" in (self.root / "mix.exs").read_text()):
            package = None
        if override.get("startCommand", "").strip():
            install = [["bash", "-lc", override["installCommand"]]] if override.get("installCommand", "").strip() else []
            return Recipe("custom", install, ["bash", "-lc", override["startCommand"]], port, {"PORT": str(port), "HOST": "0.0.0.0"})
        if package is not None:
            if not isinstance(package, dict):
                raise NeedsConfiguration("Invalid package.json")
            if self.is_hermes(package):
                return self.hermes_recipe(port)
            if package.get("workspaces") and not override.get("directory"):
                raise NeedsConfiguration("Choose the application directory within this workspace")
            manager, install = package_manager(self.root, package)
            self.require_runtime("node", [".node-version", ".nvmrc"])
            engines = package.get("engines", {}).get("node")
            if engines:
                if not version_satisfies(self.run_command(["node", "--version"], capture=True), engines):
                    raise NeedsConfiguration(f"Installed Node does not satisfy engines.node {engines}")
                install = install + (["--engine-strict"] if manager == "npm" else [])
            self.ensure_package_manager(package, manager)
            deps = {**package.get("dependencies", {}), **package.get("devDependencies", {})}
            env = {"PORT": str(port), "HOST": "0.0.0.0", "NODE_ENV": "development"}
            if package.get("name") == "openclaw" and (self.root / "openclaw.mjs").is_file():
                scripts = package.get("scripts", {})
                if scripts.get("build:runtime"):
                    # OpenClaw's runtime profile includes the Control UI and
                    # plugin assets, without publishing-only declarations.
                    build = [[manager, "run", "build:runtime"]]
                elif scripts.get("build") and scripts.get("ui:build"):
                    build = [[manager, "run", "build"], [manager, "run", "ui:build"]]
                else:
                    raise NeedsConfiguration("This OpenClaw checkout needs a runtime build or explicit build and ui:build commands")
                config_path = self.directory / "openclaw.json"
                state_path = self.directory / "openclaw-state"
                state_path.mkdir(mode=0o700, exist_ok=True)
                write_config = False
                if not config_path.exists():
                    config = {"gateway": {"mode": "local", "bind": "lan", "port": port,
                                "auth": {"mode": "token", "token": secrets.token_urlsafe(36)},
                                "trustedProxies": ["10.0.0.2/32", "fdf::2/128"],
                                "allowRealIpFallback": False,
                                "controlUi": {"enabled": True, "allowedOrigins": ["https://" + host]}}}
                    write_config = True
                else:
                    config = read_json(config_path)
                    gateway = config.get("gateway") if isinstance(config, dict) else None
                    auth = gateway.get("auth") if isinstance(gateway, dict) else None
                    if not isinstance(auth, dict) or auth.get("mode") != "token" or not isinstance(auth.get("token"), str) or not auth["token"]:
                        raise NeedsConfiguration("The retained OpenClaw config needs Gateway token authentication; inspect it in the terminal")
                    if "trustedProxies" in gateway and (not isinstance(gateway["trustedProxies"], list) or any(not isinstance(value, str) or not value.strip() for value in gateway["trustedProxies"])):
                        raise NeedsConfiguration("The retained OpenClaw gateway.trustedProxies must be a list of IP addresses or CIDRs; inspect it in the terminal")
                    if "allowRealIpFallback" in gateway and not isinstance(gateway["allowRealIpFallback"], bool):
                        raise NeedsConfiguration("The retained OpenClaw gateway.allowRealIpFallback must be a boolean; inspect it in the terminal")
                    if "trustedProxies" not in gateway:
                        # The runtime connects from these two namespace peers.
                        # Preserve an explicit user policy, including an empty list.
                        gateway["trustedProxies"] = ["10.0.0.2/32", "fdf::2/128"]
                        gateway.setdefault("allowRealIpFallback", False)
                        write_config = True
                if write_config:
                    # Record intent first: reconnection must reload the existing
                    # owned Gateway even if this setup exits after the file write.
                    atomic_json(self.directory / "openclaw-config-restart.json", {"pending": True})
                    atomic_json(config_path, config)
                    self.config_changed = True
                env.update({"OPENCLAW_CONFIG_PATH": str(config_path), "OPENCLAW_STATE_DIR": str(state_path)})
                if manager == "pnpm":
                    # OpenClaw installs a large workspace with native SDKs.
                    # Bound concurrent downloads/builds within a Sprite.
                    install = install + ["--network-concurrency=4"]
                    declared_major = re.match(r"pnpm@(\d+)\.", package.get("packageManager", ""))
                    if declared_major and int(declared_major[1]) >= 12:
                        install.append("--workspace-concurrency=1")
                    env.update({"npm_config_child_concurrency": "1", "npm_config_workspace_concurrency": "1", "pnpm_config_workspace_concurrency": "1"})
                return Recipe("openclaw", [install] + build,
                              ["node", str(self.root / "openclaw.mjs"), "gateway", "--bind", "lan", "--port", str(port)],
                              port, env, runtime="node")
            vite_script = any(re.search(r"(?:^|[\s;&|])vite(?:\s|$)", str(package.get("scripts", {}).get(name, ""))) for name in ("dev", "start", "serve"))
            if "vite" in deps and ((self.root / "index.html").is_file() or vite_script):
                wrapper = self.directory / "vite.config.mjs"
                wrapper.write_text("import {createRequire} from 'node:module';\nimport {pathToFileURL} from 'node:url';\n" +
                    f"const require=createRequire({json.dumps(str(self.root / 'package.json'))});\n" +
                    "const namespace=await import(pathToFileURL(require.resolve('vite')).href);const vite={...namespace.default,...namespace};\n" +
                    f"const loaded=await vite.loadConfigFromFile({{command:'serve',mode:'development'}},undefined,{json.dumps(str(self.root))});\n" +
                    "export default vite.mergeConfig(loaded?.config || {}," + json.dumps({"server": {"host": "0.0.0.0", "port": port, "strictPort": True, "allowedHosts": [host], "hmr": {"host": host, "protocol": "wss", "clientPort": 443}}}) + ");\n")
                return Recipe("vite", [install], [str(self.root / "node_modules/.bin/vite"), "--config", str(wrapper)], port, env, runtime="node")
            if "next" in deps:
                wrapper = self.directory / "next-server.cjs"
                wrapper.write_text("const {createRequire}=require('node:module');\n" +
                    f"const req=createRequire({json.dumps(str(self.root / 'package.json'))});\n" +
                    "const next=req('next');const http=require('node:http');\n" +
                    "const loadConfig=req('next/dist/server/config').default;\nconst {PHASE_DEVELOPMENT_SERVER}=req('next/constants');\n" +
                    f"(async()=>{{const dir={json.dumps(str(self.root))};const conf=await loadConfig(PHASE_DEVELOPMENT_SERVER,dir);\n" +
                    f"conf.allowedDevOrigins=[{json.dumps(host)}];const app=next({{dev:true,dir,hostname:'0.0.0.0',port:{port},conf}});\n" +
                    f"await app.prepare();const server=http.createServer(app.getRequestHandler());server.on('upgrade',app.getUpgradeHandler());server.listen({port},'0.0.0.0');}})().catch(e=>{{console.error(e);process.exit(1)}});\n")
                return Recipe("next", [install], ["node", str(wrapper)], port, env, runtime="node")
            scripts = package.get("scripts", {})
            start = scripts.get("start", "")
            if start:
                declared_port = re.search(r"(?:PORT\s*=\s*|--port(?:=|\s+)|-p\s+)(\d{2,5})\b", start)
                sources = "\n".join(p.read_text(errors="replace")[:100000] for p in sorted(self.root.iterdir())[:200] if p.is_file() and p.suffix in (".js", ".cjs", ".mjs", ".ts", ".cts", ".mts"))
                if "PORT" not in start + sources and not declared_port and "port" not in override:
                    raise NeedsConfiguration("Node start script has no identifiable port; enter its HTTP port")
                if declared_port and "port" not in override:
                    port = int(declared_port[1]); env["PORT"] = str(port)
                return Recipe("node", [install], [manager, "run", "start"], port, env, runtime="node")
            raise NeedsConfiguration("No recognized web framework or start script in package.json")
        if (self.root / "manage.py").exists():
            install, python = self.python_install()
            manage = (self.root / "manage.py").read_text()
            settings = re.search(r"(?:setdefault\(\s*|DJANGO_SETTINGS_MODULE[\"']?\s*[=:]\s*)[\"']DJANGO_SETTINGS_MODULE[\"']\s*,\s*[\"']([\w.]+)[\"']", manage)
            if not settings:
                settings = re.search(r"setdefault\(\s*[\"']DJANGO_SETTINGS_MODULE[\"']\s*,\s*[\"']([\w.]+)[\"']", manage)
            if not settings:
                raise NeedsConfiguration("Cannot identify the Django settings module")
            module = settings[1]
            paths = [self.root / (module.replace(".", "/") + ".py"), self.root / module.replace(".", "/")]
            content = "\n".join(p.read_text(errors="replace") for candidate in paths for p in ([candidate] if candidate.is_file() else candidate.glob("*.py")))
            kind = database_kind(content)
            if "DATABASES" in content and kind is None:
                raise NeedsConfiguration("Cannot identify the Django database adapter")
            env = {"DJANGO_SETTINGS_MODULE": "launch_django_settings", "PYTHONPATH": str(self.directory) + os.pathsep + str(self.root)}
            self.django_module = module
            return Recipe("django", install, [python, "manage.py", "runserver", f"0.0.0.0:{port}", "--noreload"], port, env, kind, runtime="python3")
        python_text = "\n".join((self.root / name).read_text() for name in ("requirements.txt", "pyproject.toml") if (self.root / name).exists())
        if re.search(r"\bfastapi\b", python_text, re.I):
            install, python = self.python_install()
            candidates = [(name[:-3].replace("/", "."), self.root / name) for name in ("main.py", "app/main.py") if (self.root / name).is_file() and re.search(r"(?m)^app\s*(?::[^=]+)?=\s*FastAPI\s*\(", (self.root / name).read_text())]
            if len(candidates) != 1:
                raise NeedsConfiguration("Choose the FastAPI ASGI entrypoint")
            return Recipe("fastapi", install, [python, "-m", "uvicorn", candidates[0][0] + ":app", "--host", "0.0.0.0", "--port", str(port)], port, runtime="python3", health_path="/docs")
        if re.search(r"\bflask\b", python_text, re.I):
            install, python = self.python_install()
            candidates = [name for name in ("app", "wsgi") if (self.root / (name + ".py")).exists()]
            if len(candidates) != 1:
                raise NeedsConfiguration("Choose the Flask app entrypoint")
            return Recipe("flask", install, [python, "-m", "flask", "--app", candidates[0], "run", "--host", "0.0.0.0", "--port", str(port)], port, runtime="python3")
        if (self.root / "Gemfile").exists() and (self.root / "bin/rails").exists():
            self.require_runtime("ruby", [".ruby-version"])
            gemfile = (self.root / "Gemfile").read_text()
            pin = re.search(r'(?m)^\s*ruby\s+["\']([^"\']+)["\']', gemfile)
            if pin and not version_satisfies(self.run_command(["ruby", "--version"], capture=True), pin[1]):
                raise NeedsConfiguration(f"Installed Ruby does not satisfy Gemfile ruby {pin[1]}")
            if "rails" not in (self.root / "Gemfile").read_text():
                raise NeedsConfiguration("Gemfile is not a recognized Rails application")
            config = self.root / "config/database.yml"
            kind = database_kind(config.read_text() if config.exists() else "")
            if config.exists() and kind is None:
                raise NeedsConfiguration("Cannot identify the Rails database adapter")
            wrapper = str(self.directory / "rails-launch.rb")
            env = {"RAILS_ENV": "development", "RAILS_LOG_TO_STDOUT": "1"}
            return Recipe("rails", [["bundle", "install"]], ["bundle", "exec", "ruby", wrapper, "server", "-b", "0.0.0.0", "-p", str(port)], port, env, kind, runtime="ruby")
        if (self.root / "mix.exs").exists() and re.search(r"\bphoenix\b", (self.root / "mix.exs").read_text()):
            self.require_runtime("elixir", [])
            pins = self.root / ".tool-versions"
            if pins.exists():
                for binary, label, flag in (("elixir", "Elixir", "--version"), ("erl", "Erlang/OTP", "-version")):
                    pin = re.search(rf"(?m)^{binary if binary != 'erl' else 'erlang'}\s+(\S+)", pins.read_text())
                    if pin:
                        output = self.run_command([binary, flag], capture=True) if binary != "erl" else self.run_command(["erl", "-noshell", "-eval", 'R=code:root_dir(),V=erlang:system_info(otp_release),{ok,B}=file:read_file(filename:join([R,"releases",V,"OTP_VERSION"])),io:put_chars(B),halt().'], capture=True)
                        expected = pin[1].split("-", 1)[0]
                        if not re.search(r"\b" + re.escape(expected) + r"(?:\b|\.)", output):
                            raise NeedsConfiguration(f"Installed {label} does not satisfy .tool-versions ({pin[1]})")
            mix = (self.root / "mix.exs").read_text()
            elixir_requirement = re.search(r'elixir:\s*"([^"\n]+)"', mix)
            if elixir_requirement and not version_satisfies(self.run_command(["elixir", "--version"], capture=True).split("Elixir", 1)[-1], elixir_requirement[1]):
                raise NeedsConfiguration(f"Installed Elixir does not satisfy {elixir_requirement[1]}")
            app = re.search(r"\bapp:\s*:([a-z][a-z0-9_]*)", mix)
            configs = "\n".join(p.read_text(errors="replace") for p in (self.root / "config").glob("*.exs"))
            endpoints = set(re.findall(r"config\s+:([a-z][a-z0-9_]*),\s*([A-Z][\w.]*\.Endpoint)\b", configs))
            if not app or len(endpoints) != 1:
                raise NeedsConfiguration("Choose one Phoenix application and endpoint")
            endpoint_app, endpoint = next(iter(endpoints))
            repos = list((self.root / "lib").rglob("repo.ex"))
            repo_content = "\n".join(p.read_text(errors="replace") for p in repos)
            kind = database_kind(repo_content, default=None)
            if repos and not kind:
                raise NeedsConfiguration("Cannot identify the Ecto repository adapter")
            self.phoenix = {"app": app[1], "endpoint_app": endpoint_app, "endpoint": endpoint}
            return Recipe("phoenix", [["mix", "local.hex", "--force"], ["mix", "local.rebar", "--force"], ["mix", "deps.get"], ["mix", "compile"]], ["mix", "run", "--no-start", str(self.directory / "phoenix-launch.exs")], port, {"MIX_ENV": "dev", "PHX_SERVER": "true", "PORT": str(port)}, kind, runtime="elixir")
        if (self.root / "go.mod").exists():
            self.require_runtime("go", [], "version")
            module = (self.root / "go.mod").read_text()
            pin = re.search(r"(?m)^go\s+(\d+\.\d+(?:\.\d+)?)", module)
            if pin:
                actual = self.run_command(["go", "version"], capture=True)
                found = re.search(r"go(\d+\.\d+(?:\.\d+)?)", actual)
                def parts(value):
                    return tuple(int(v) for v in value.split(".")) + (0,) * (3 - len(value.split(".")))
                if not found or parts(found[1]) < parts(pin[1]):
                    raise NeedsConfiguration(f"Go {pin[1]} or newer is required")
            self.environment["GOTOOLCHAIN"] = "local"
            candidates = []
            for candidate in [self.root] + sorted((self.root / "cmd").glob("*")):
                if candidate.is_dir() and any(re.search(r"(?m)^package\s+main\b", p.read_text(errors="replace")) for p in candidate.glob("*.go") if not p.name.endswith("_test.go")):
                    candidates.append(candidate)
            if len(candidates) != 1:
                raise NeedsConfiguration("Choose one Go executable package")
            sources = "\n".join(p.read_text(errors="replace") for p in candidates[0].glob("*.go"))
            literal = re.search(r'ListenAndServe(?:TLS)?\(\s*"(?:0\.0\.0\.0|127\.0\.0\.1|localhost)?:(\d+)"', sources)
            if "PORT" not in sources and not literal and "port" not in override:
                raise NeedsConfiguration("Cannot identify the Go HTTP port; enter the app's port")
            if literal and "port" not in override:
                port = int(literal[1])
            binary = str(self.directory / "go-app")
            relative = "./" + str(candidates[0].relative_to(self.root))
            return Recipe("go", [["go", "mod", "download"], ["go", "build", "-o", binary, relative]], [binary], port, {"PORT": str(port), "GOTOOLCHAIN": "local"}, runtime="go")
        if (self.root / "index.html").is_file():
            self.require_runtime("python3", [])
            return Recipe("static", [], ["python3", "-m", "http.server", str(port), "--bind", "0.0.0.0", "--directory", str(self.root)], port)
        raise NeedsConfiguration("No supported app at this directory. Enter install/start commands or choose an app directory.")

    def ensure_postgres(self) -> dict[str, Any]:
        # libpq accepts PGHOSTADDR and service files in addition to PGHOST.
        # Clear inherited connection settings before invoking any local DB
        # tools; each command receives this launch's explicit context below.
        for key in list(self.environment):
            if key.startswith("PG"):
                self.environment.pop(key)
        state_path = self.directory / "database.json"
        config = read_json(state_path)
        if not config:
            config = {"kind": "postgres", "host": "127.0.0.1", "port": 15432, "user": "launch_" + self.manifest["launchId"].replace("-", "")[:12], "password": secrets.token_urlsafe(32), "database": "launch_app"}
            atomic_json(state_path, config)
        bins = sorted(Path("/usr/lib/postgresql").glob("*/bin"), key=lambda p: [int(n) if n.isdigit() else n for n in re.split(r"(\d+)", str(p))])
        bin_path = next((p for p in reversed(bins) if (p / "initdb").exists()), None)
        if bin_path is None:
            if not shutil.which("sudo", path=self.environment["PATH"]) or not shutil.which("apt-get", path=self.environment["PATH"]):
                raise NeedsConfiguration("PostgreSQL installation requires Ubuntu apt-get and passwordless sudo")
            self.run_command(["sudo", "-n", "apt-get", "update"])
            self.run_command(["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "--no-install-recommends", "postgresql", "libpq-dev"])
            bins = sorted(Path("/usr/lib/postgresql").glob("*/bin"))
            bin_path = next((p for p in reversed(bins) if (p / "initdb").exists()), None)
        if bin_path is None or os.geteuid() == 0:
            raise NeedsConfiguration("PostgreSQL must run as the non-root Sprite user")
        data = self.directory / "postgres"
        password_path = write_private(self.directory / "postgres-password", config["password"] + "\n")
        if not (data / "PG_VERSION").exists():
            if data.exists() and any(data.iterdir()):
                raise NeedsConfiguration("PostgreSQL initialization was interrupted; inspect the retained data before retrying")
            self.run_command([str(bin_path / "initdb"), "-D", str(data), "--username", config["user"], "--pwfile", str(password_path), "--auth-local=scram-sha-256", "--auth-host=scram-sha-256"])
        self.ensure_service(self.pg_service, {"cmd": str(bin_path / "postgres"), "args": ["-D", str(data), "-h", "127.0.0.1", "-p", str(config["port"]), "-k", str(self.directory)], "dir": str(self.directory)})
        env = {"PGPASSWORD": config["password"], "PGHOST": "127.0.0.1", "PGPORT": str(config["port"]), "PGUSER": config["user"]}
        for _ in range(100):
            self.check()
            try:
                self.run_command([str(bin_path / "psql"), "-d", "postgres", "-Atc", "SELECT 1"], env=env, capture=True)
                break
            except RuntimeError:
                time.sleep(0.2)
        else:
            raise RuntimeError("Local PostgreSQL did not become ready")
        exists = self.run_command([str(bin_path / "psql"), "-d", "postgres", "-Atc", "SELECT 1 FROM pg_database WHERE datname = 'launch_app'"], env=env, capture=True)
        if exists != "1":
            self.run_command([str(bin_path / "createdb"), config["database"]], env=env)
        return config

    def configure_database(self, recipe: Recipe) -> None:
        if not recipe.database:
            return
        self.update("database", "Configuring launch-local " + recipe.database)
        if recipe.database == "postgres":
            self.database = self.ensure_postgres()
            db = self.database
            url = "postgresql://" + urllib.parse.quote(db["user"]) + ":" + urllib.parse.quote(db["password"]) + "@127.0.0.1:" + str(db["port"]) + "/" + db["database"]
            recipe.env["DATABASE_URL"] = url
        else:
            self.database = {"kind": "sqlite", "database": str(self.directory / "database.sqlite3")}
        db = self.database
        if recipe.name == "django":
            config = {"ENGINE": "django.db.backends.postgresql", "NAME": db["database"], "HOST": "127.0.0.1", "PORT": db.get("port"), "USER": db.get("user"), "PASSWORD": db.get("password")} if recipe.database == "postgres" else {"ENGINE": "django.db.backends.sqlite3", "NAME": db["database"]}
            self.write_django(recipe, config)
        elif recipe.name == "rails":
            config = {"adapter": "postgresql", "host": "127.0.0.1", "port": db["port"], "username": db["user"], "password": db["password"], "database": db["database"]} if recipe.database == "postgres" else {"adapter": "sqlite3", "database": db["database"]}
            self.write_rails(recipe, config)
        elif recipe.name == "phoenix":
            self.write_phoenix(recipe)

    def write_django(self, recipe: Recipe, config: dict | None = None) -> None:
        host = self.manifest["hostname"]
        settings = f"from {self.django_module} import *\nALLOWED_HOSTS = {repr([host, 'localhost', '127.0.0.1'])}\nCSRF_TRUSTED_ORIGINS = {repr(['https://' + host])}\nSECURE_PROXY_SSL_HEADER = ('HTTP_X_FORWARDED_PROTO', 'https')\n"
        if config is not None:
            settings += "DATABASES = " + repr({"default": config}) + "\n"
        write_private(self.directory / "launch_django_settings.py", settings)
        if config:
            # AppConfig.ready and custom manage.py are arbitrary repository
            # code. Initialize Django, then inspect effective connections in
            # the SAME process immediately before calling the migration API.
            migration = "import pathlib\nimport django\nfrom django.core.management import call_command\nfrom django.db import connections\ndjango.setup()\n" + "expected = " + repr(config) + "\n"
            migration += "def refuse():\n    raise RuntimeError('Refusing nonlocal migration')\nfor connection in connections.all():\n    config = connection.settings_dict\n    params = connection.get_connection_params()\n"
            if recipe.database == "postgres":
                migration += "    if config.get('ENGINE') != expected['ENGINE'] or config.get('OPTIONS'):\n        refuse()\n    if params.get('host') != '127.0.0.1' or str(params.get('port')) != '15432' or params.get('dbname', params.get('database')) != 'launch_app' or params.get('user') != expected['USER']:\n        refuse()\n    if params.get('service') or params.get('hostaddr') or params.get('dsn'):\n        refuse()\n    if connection.connection is not None:\n        native = connection.connection\n        info = native.get_dsn_parameters() if hasattr(native, 'get_dsn_parameters') else {key: getattr(native.info, key) for key in ('host','port','dbname','user')}\n        if info.get('host') != '127.0.0.1' or str(info.get('port')) != '15432' or info.get('dbname') != 'launch_app' or info.get('user') != expected['USER']:\n            refuse()\n"
            else:
                migration += "    if config.get('ENGINE') != expected['ENGINE'] or pathlib.Path(params.get('database', '')).resolve() != pathlib.Path(expected['NAME']).resolve():\n        refuse()\n    if connection.connection is not None:\n        databases = connection.connection.execute('PRAGMA database_list').fetchall()\n        if any(row[1] == 'main' and pathlib.Path(row[2]).resolve() != pathlib.Path(expected['NAME']).resolve() for row in databases):\n            refuse()\n"
            migration += "call_command('migrate', interactive=False)\n"
            migration_path = write_private(self.directory / "django-migrate.py", migration)
            python = str(self.directory / "venv/bin/python")
            recipe.migrate = [[python, str(migration_path)]]

    def write_rails(self, recipe: Recipe, config: dict | None = None) -> None:
        database_path = self.directory / "rails-database.yml"
        if config:
            write_private(database_path, json.dumps({"development": config}))
        script = "require 'bundler/setup'\n" + f"APP_PATH = {json.dumps(str(self.root / 'config/application'))} unless defined?(APP_PATH)\nrequire APP_PATH\n" + f"Rails.application.config.hosts << {json.dumps(self.manifest['hostname'])}\n"
        if config:
            script += f"Rails.application.config.paths['config/database'] = {json.dumps(str(database_path))}\n"
        script += "if ARGV.first == 'launch-migrate'\n  ARGV.shift\n  require " + json.dumps(str(self.root / "config/environment")) + "\n"
        # Loading repository Rake files and prerequisites can change database
        # settings. Run those hooks before checking the effective migration
        # target, then invoke the already-prepared task in this same process.
        script += "  Rails.application.load_tasks\n  migration_task = Rake::Task['db:migrate']\n  migration_task.prerequisite_tasks.each(&:invoke)\n"
        if config:
            if recipe.database == "postgres":
                check = "c[:adapter] == 'postgresql' && c[:host] == '127.0.0.1' && c[:port].to_s == '15432' && c[:database] == 'launch_app' && c[:username] == " + json.dumps(config["username"]) + " && [:url, :hostaddr, :service, :servicefile, :dsn].all? { |key| c[key].nil? || c[key] == '' }"
            else:
                check = "c[:adapter] == 'sqlite3' && c[:database].is_a?(String) && File.expand_path(c[:database]) == " + json.dumps(self.database["database"])
            script += "  validate_target = lambda do |c|\n    raise 'Refusing nonlocal migration' unless " + check + "\n  end\n"
            script += "  configs = ActiveRecord::Base.configurations.configs_for(env_name: 'development')\n  raise 'Refusing nonlocal migration' if configs.empty?\n  configs.each { |db| validate_target.call(db.configuration_hash) }\n"
            script += "  pools = []\n  pools << ActiveRecord::Base.connection_pool if ActiveRecord::Base.respond_to?(:connection_pool)\n  if defined?(ActiveRecord::Tasks::DatabaseTasks) && ActiveRecord::Tasks::DatabaseTasks.respond_to?(:migration_connection_pool)\n    pools << ActiveRecord::Tasks::DatabaseTasks.migration_connection_pool\n  end\n  pools.uniq.each do |pool|\n    validate_target.call(pool.db_config.configuration_hash)\n    pool.connections.each do |connection|\n      next unless connection.connected?\n      native = connection.raw_connection\n"
            if recipe.database == "postgres":
                script += "      actual = native.conninfo_hash\n      raise 'Refusing nonlocal migration' unless actual[:host] == '127.0.0.1' && actual[:port].to_s == '15432' && actual[:dbname] == 'launch_app' && actual[:user] == " + json.dumps(config["username"]) + " && [nil, '', '127.0.0.1'].include?(actual[:hostaddr])\n"
            else:
                script += "      databases = native.execute('PRAGMA database_list').map { |row| row.is_a?(Hash) ? [row['name'] || row[:name], row['file'] || row[:file]] : [row[1], row[2]] }\n      main = databases.find { |row| row[0] == 'main' }\n      raise 'Refusing nonlocal migration' unless main && main[1].is_a?(String) && File.expand_path(main[1]) == " + json.dumps(self.database["database"]) + "\n"
            script += "    end\n  end\n"
            if recipe.database == "postgres":
                # libpq's hostaddr overrides host even when host is supplied.
                script += "  raise 'Refusing nonlocal migration' unless [nil, '', '127.0.0.1'].include?(ENV['PGHOSTADDR']) && [nil, ''].include?(ENV['PGSERVICE'])\n"
        script += "  migration_task.invoke\nelse\n  require 'rails/commands'\nend\n"
        write_private(self.directory / "rails-launch.rb", script)
        if config:
            recipe.migrate = [["bundle", "exec", "ruby", str(self.directory / "rails-launch.rb"), "launch-migrate"]]

    def write_phoenix(self, recipe: Recipe) -> None:
        p = self.phoenix
        app, endpoint_app, endpoint = p["app"], p["endpoint_app"], p["endpoint"]
        host = self.manifest["hostname"]
        db = self.database
        config = ""
        if db:
            if recipe.database == "postgres":
                values = "[hostname: \"127.0.0.1\", port: 15432, username: " + json.dumps(db["user"]) + ", password: " + json.dumps(db["password"]) + ", database: \"launch_app\", ssl: false]"
            else:
                values = "[database: " + json.dumps(db["database"]) + "]"
            config = f"repos = Application.get_env(:{app}, :ecto_repos, [])\nEnum.each(repos, fn repo ->\n  previous = Application.get_env(:{app}, repo, []) |> Keyword.drop([:url, :socket_dir, :socket, :hostname, :port, :username, :password, :database, :ssl])\n  Application.put_env(:{app}, repo, Keyword.merge(previous, {values}))\nend)\n"
        settings = f"endpoint = {endpoint}\nprevious = Application.get_env(:{endpoint_app}, endpoint, [])\nApplication.put_env(:{endpoint_app}, endpoint, Keyword.merge(previous, [server: true, http: [ip: {{0,0,0,0}}, port: {recipe.port}], url: [scheme: \"https\", host: {json.dumps(host)}, port: 443], check_origin: [{json.dumps('https://' + host)}]]))\n" + config
        server = settings + f"{{:ok, _}} = Application.ensure_all_started(:{app})\nProcess.sleep(:infinity)\n"
        write_private(self.directory / "phoenix-launch.exs", server)
        if db:
            if recipe.database == "postgres":
                check = "config[:hostname] == \"127.0.0.1\" and config[:port] == 15432 and config[:database] == \"launch_app\" and is_nil(config[:url]) and is_nil(config[:socket_dir]) and is_nil(config[:socket]) and is_nil(config[:endpoints])"
                dependency = ":postgrex"
            else:
                check = "Path.expand(config[:database]) == " + json.dumps(db["database"]) + " and is_nil(config[:url])"
                dependency = ":ecto_sqlite3"
            migrate = settings + f"{{:ok, _}} = Application.ensure_all_started(:ecto_sql)\n{{:ok, _}} = Application.ensure_all_started({dependency})\nEnum.each(repos, fn repo ->\n  config = repo.config()\n  unless {check}, do: raise(\"Refusing nonlocal migration\")\n  Ecto.Migrator.with_repo(repo, fn started_repo ->\n    config = started_repo.config()\n    unless {check}, do: raise(\"Refusing nonlocal migration\")\n    Ecto.Migrator.run(started_repo, :up, all: true)\n  end)\nend)\n"
            write_private(self.directory / "phoenix-migrate.exs", migrate)
            recipe.migrate = [["mix", "run", "--no-start", str(self.directory / "phoenix-migrate.exs")]]

    def write_openclaw_cli(self, recipe: Recipe) -> None:
        """Expose the built source CLI with this launch's private config paths."""
        node = shutil.which("node", path=self.environment["PATH"])
        if not node:
            raise NeedsConfiguration("The OpenClaw source CLI requires the installed Node runtime")
        shims = self.directory / "tools" / "bin"
        shims.mkdir(parents=True, exist_ok=True)
        context = {key: recipe.env[key] for key in ("OPENCLAW_CONFIG_PATH", "OPENCLAW_STATE_DIR")}
        exports = "".join("export " + key + "=" + shlex.quote(value) + "\n" for key, value in context.items())
        command = shlex.join([str(Path(node).resolve()), str(self.root / "openclaw.mjs")])
        wrapper = write_private(shims / "openclaw", "#!/bin/sh\n" + exports + "exec " + command + ' "$@"\n')
        wrapper.chmod(0o700)
        self.environment["PATH"] = os.pathsep.join([str(shims)] + [path for path in self.environment["PATH"].split(os.pathsep) if path != str(shims)])

    def service(self, recipe: Recipe) -> None:
        self.update("starting", "Starting the app as a persistent Sprite service", recipe=recipe.name, port=recipe.port)
        if recipe.name == "openclaw":
            self.write_openclaw_cli(recipe)
        executable = shutil.which(recipe.start[0], path=self.environment["PATH"]) or recipe.start[0]
        context = {"PATH": self.environment["PATH"], **recipe.env}
        write_private(self.directory / "launch-env.sh", "".join("export " + key + "=" + shlex.quote(value) + "\n" for key, value in context.items()))
        write_private(self.directory / "terminal-rc.sh", '[ ! -r "$HOME/.bashrc" ] || . "$HOME/.bashrc"\n. ' + shlex.quote(str(self.directory / "launch-env.sh")) + "\n")
        body = {"cmd": executable, "args": recipe.start[1:], "dir": str(self.root), "env": {"PATH": self.environment["PATH"], **recipe.env}, "http_port": recipe.port}
        if recipe.database == "postgres":
            body["needs"] = [self.pg_service]
        self.ensure_service(self.app_service, body, restart=self.config_changed)
        if self.config_changed:
            (self.directory / "openclaw-config-restart.json").unlink(missing_ok=True)
            (self.directory / "hermes-config-restart.json").unlink(missing_ok=True)
            self.config_changed = False
        limit = min(self.deadline, time.monotonic() + 120)
        while time.monotonic() < limit:
            self.check()
            status = None
            connection = http.client.HTTPConnection("127.0.0.1", recipe.port, timeout=2)
            try:
                connection.request("GET", recipe.health_path, headers={"Host": self.manifest["hostname"]})
                status = connection.getresponse().status
            except (OSError, TimeoutError, http.client.HTTPException):
                pass
            finally:
                connection.close()
            if status in (400, 403):
                raise NeedsConfiguration(f"The app refused its preview hostname (HTTP {status}); inspect the host/origin configuration")
            if status is not None and status < 500:
                state = self.management.request("GET", f"/v1/services/{self.app_service}")
                live = state.get("state", {}) if isinstance(state, dict) else {}
                if live.get("status") == "running":
                    self.complete("service")
                    self.update("ready", "App is running" + (f" (HTTP {status} at {recipe.health_path})" if status >= 400 else ""), recipe=recipe.name, port=recipe.port)
                    return
            time.sleep(0.5)
        raise RuntimeError("App did not become HTTP-ready within two minutes. Inspect service logs and the terminal.")

    def execute(self) -> int:
        self.directory.mkdir(parents=True, exist_ok=True)
        with open(self.directory / "setup.lock", "a") as lock_file:
            try:
                fcntl.flock(lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return 0  # An existing session owns this setup; callers reattach.
            attempt_path = self.directory / "attempt.json"
            attempt = read_json(attempt_path, {})
            if attempt.get("attemptId") != self.attempt_id:
                started_at = self.manifest.get("setupStartedAt")
                if started_at:
                    started = datetime.datetime.fromisoformat(started_at.replace("Z", "+00:00")).timestamp()
                else:
                    started = time.time()
                attempt = {"attemptId": self.attempt_id, "started": min(started, time.time())}
                atomic_json(attempt_path, attempt)
            self.deadline = time.monotonic() + self.timeout - max(0, time.time() - attempt["started"])
            with open(self.directory / "launch.log", "ab", buffering=0) as log_handle:
                self.log_handle = log_handle
                thread = None
                try:
                    self.check()
                    self.management.request("PUT", f"/v1/tasks/{self.task}", {"expire": "5m"})
                    thread = threading.Thread(target=self.heartbeat, daemon=True)
                    thread.start()
                    self.clone()
                    recipe = self.detect()
                    override_install = (self.manifest.get("overrides") or {}).get("installCommand", "").strip()
                    if override_install:
                        recipe.install = [["bash", "-lc", override_install]]
                    elif recipe.name in ("rails", "phoenix", "django") and (self.root / "package.json").is_file():
                        package = read_json(self.root / "package.json")
                        manager, install_assets = package_manager(self.root, package)
                        self.require_runtime("node", [".node-version", ".nvmrc"])
                        self.ensure_package_manager(package, manager)
                        recipe.install.append(install_assets)
                        if package.get("scripts", {}).get("build"):
                            recipe.install.append([manager, "run", "build"])
                    if recipe.name == "phoenix" and not override_install:
                        mix = (self.root / "mix.exs").read_text()
                        if '"assets.setup"' in mix:
                            recipe.install.append(["mix", "assets.setup"])
                        if '"assets.build"' in mix:
                            recipe.install.append(["mix", "assets.build"])
                    # Install pg headers and force launch-local environment
                    # before framework install hooks can inspect DATABASE_URL.
                    self.configure_database(recipe)
                    install_key = self.install_key(recipe)
                    self.update("installing", "Installing " + recipe.name + " dependencies", recipe=recipe.name, port=recipe.port)
                    installed = bool(self.completed.get(install_key))
                    if recipe.name == "hermes":
                        installed = installed and self.hermes_context() is not None and (self.directory / "web-dist/index.html").is_file()
                    if not installed:
                        for argv in recipe.install:
                            if recipe.name == "hermes":
                                self.run_hermes_command(argv, recipe)
                            else:
                                self.run_command(argv, env=recipe.env)
                        self.complete(install_key)
                        # npm/bundler/Mix may create a lockfile on first install.
                        # Mark the resulting dependency snapshot completed too,
                        # so reconnection does not rerun finished install hooks.
                        self.complete(self.install_key(recipe))
                    # Host overlays are needed even for apps without databases.
                    if recipe.name == "django" and not recipe.database:
                        self.write_django(recipe)
                    elif recipe.name == "rails" and not recipe.database:
                        self.write_rails(recipe)
                    elif recipe.name == "phoenix" and not recipe.database:
                        self.write_phoenix(recipe)
                    elif recipe.name == "hermes":
                        self.prepare_hermes_service(recipe)
                    self.check()
                    for argv in recipe.migrate:
                        self.run_command(argv, env=recipe.env)
                    self.service(recipe)
                    return 0
                except NeedsConfiguration as exc:
                    self.update("needs_configuration", str(exc))
                    return 0
                except Cancelled as exc:
                    self.update("cancelled", str(exc))
                    return 0
                except Exception as exc:
                    self.update("failed", str(exc), error=str(exc))
                    return 1
                finally:
                    self.stop.set()
                    self.terminate_child()
                    if thread:
                        thread.join(timeout=11)
                    with contextlib.suppress(Exception):
                        self.management.request("DELETE", f"/v1/tasks/{self.task}")
                    self.log_handle = None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    runner = Runner(args.manifest)
    def on_signal(_signum, _frame):
        runner.cancelled = True
    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    return runner.execute()


if __name__ == "__main__":
    sys.exit(main())
