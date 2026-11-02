"""Offline runner tests; real Git checkout, HTTP service, and process cleanup.

No Sprites account is used. Framework detection tests use conventional project
fixtures and inspect the emitted commands/configuration. Static and Node tests
execute actual application servers through the same runner/service lifecycle.
"""
import contextlib
import copy
import http.client
import importlib.util
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from unittest.mock import patch

import bootstrap as boot


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class LocalManagement:
    """A local test double for the real management API, running real services."""
    def __init__(self, execute=False):
        self.calls = []
        self.services = {}
        self.processes = {}
        self.execute = execute
        self.output = open(os.devnull, "wb")

    def request(self, method, path, body=None):
        path = path.split("?", 1)[0]
        self.calls.append((method, path, copy.deepcopy(body)))
        if path.startswith("/v1/tasks/"):
            return {}
        name = path.split("/")[3]
        if path.endswith("/stop"):
            self.stop(name)
            return {}
        if path.endswith("/start"):
            self.start(name)
            return {}
        if method == "GET":
            if name not in self.services:
                raise boot.ManagementError(404, "not found")
            result = copy.deepcopy(self.services[name])
            process = self.processes.get(name)
            result["state"] = {"status": "running" if not self.execute or (process and process.poll() is None) else "stopped"}
            return result
        if method == "DELETE":
            self.stop(name)
            self.services.pop(name, None)
            return {}
        if method == "PUT":
            self.services[name] = copy.deepcopy(body)
            self.start(name)
            return {}
        raise AssertionError((method, path, body))

    def start(self, name):
        if not self.execute:
            return
        process = self.processes.get(name)
        if process and process.poll() is None:
            return
        body = self.services[name]
        env = boot.clean_environment()
        env.update(body.get("env", {}))
        self.processes[name] = subprocess.Popen([body["cmd"]] + body.get("args", []), cwd=body["dir"], env=env, stdout=self.output, stderr=self.output, start_new_session=True)

    def stop(self, name):
        process = self.processes.pop(name, None)
        if process and process.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)

    def close(self):
        for name in list(self.processes):
            self.stop(name)
        self.output.close()


class RunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sprite-launch-test-")
        self.base = Path(self.temp.name).resolve()
        self.launch = self.base / "launch"
        self.root = self.base / "project"
        self.launch.mkdir()
        self.root.mkdir()
        self.management = LocalManagement()
        self.manifest = {"version": 1, "launchId": "12345678-abcd-1234-abcd-123456789abc", "hostname": "fixture-abcdef.sprites.app", "target": {"owner": "fixture", "repo": "example", "kind": "branch", "ref": "main", "fetchRef": "refs/heads/main", "sha": "a" * 40, "cloneUrl": "https://github.com/fixture/example.git", "sourceUrl": "https://github.com/fixture/example"}}
        self.manifest_path = self.launch / "manifest.json"
        self.save_manifest()

    def tearDown(self):
        self.management.close()
        self.temp.cleanup()

    def save_manifest(self):
        self.manifest_path.write_text(json.dumps(self.manifest))

    def file(self, name, content=""):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        return path

    def runner(self, **kwargs):
        self.save_manifest()
        return boot.Runner(self.manifest_path, checkout=self.root, management=self.management, **kwargs)

    def detected(self):
        runner = self.runner()
        # Framework/runtime matrix is independent of developer machine versions.
        runner.run_command = lambda argv, **kw: {"node": "v22.0.0", "npm": "10.0.0", "python3": "Python 3.12.0", "ruby": "ruby 3.3.0", "go": "go version go1.25.0 linux/amd64", "elixir": "Elixir 1.18.0"}.get(argv[0], "")
        with patch.object(boot.shutil, "which", return_value="/fake/tool"):
            recipe = runner.detect()
        return runner, recipe

    def test_manifest_rejects_repo_url_credentials_and_non_sha(self):
        for change in ({"cloneUrl": "https://user:secret@github.com/fixture/example.git"}, {"sha": "main"}, {"owner": "../evil"}):
            manifest = copy.deepcopy(self.manifest)
            manifest["target"].update(change)
            with self.assertRaises(ValueError):
                boot.validate_manifest(manifest)

    def test_manifest_rejects_injected_hostname_and_invalid_port(self):
        for hostname in ("example.com", "fixture.sprites.app\nX: value", "fixture.sprites.app/elsewhere"):
            manifest = {**self.manifest, "hostname": hostname}
            with self.assertRaises(ValueError):
                boot.validate_manifest(manifest)
        self.manifest["overrides"] = {"port": True}
        with self.assertRaises(ValueError):
            boot.validate_manifest(self.manifest)

    def test_management_tokens_are_removed_from_command_environment(self):
        with patch.dict(os.environ, {"SPRITE_TOKEN": "SECRET", "FLY_API_TOKEN": "SECRET", "AUTHED_SPRITE_ORG_TOKEN": "SECRET", "ORDINARY": "yes"}):
            env = boot.clean_environment()
        self.assertNotIn("SPRITE_TOKEN", env)
        self.assertNotIn("FLY_API_TOKEN", env)
        self.assertNotIn("AUTHED_SPRITE_ORG_TOKEN", env)
        self.assertEqual(env["ORDINARY"], "yes")

    def test_static_recipe(self):
        self.file("index.html", "<h1>Fixture</h1>")
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "static")
        self.assertEqual(recipe.install, [])
        self.assertIn("0.0.0.0", recipe.start)

    def test_vite_keeps_repo_config_and_exact_host_hmr(self):
        self.file("package.json", json.dumps({"devDependencies": {"vite": "^6.0.0"}, "scripts": {"dev": "vite"}}))
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "vite")
        generated = (self.launch / "vite.config.mjs").read_text()
        self.assertIn("loadConfigFromFile", generated)
        self.assertIn('"allowedHosts": ["fixture-abcdef.sprites.app"]', generated)
        self.assertIn('"clientPort": 443', generated)
        self.assertNotIn('"allowedHosts": true', generated)

    @unittest.skipUnless(boot.shutil.which("node"), "Node unavailable")
    def test_vite_wrapper_accepts_commonjs_default_namespace(self):
        self.file("package.json", json.dumps({"devDependencies": {"vite": "^6.0.0"}}))
        self.file("index.html", "<h1>Vite fixture</h1>")
        self.file("node_modules/vite/package.json", json.dumps({"name": "vite", "main": "index.cjs"}))
        self.file("node_modules/vite/index.cjs", "module.exports={loadConfigFromFile:async()=>({config:{fixture:true}}),mergeConfig:(left,right)=>({...left,...right})};")
        self.detected()
        module_url = (self.launch / "vite.config.mjs").as_uri()
        process = subprocess.run(["node", "--input-type=module", "-e", "const config=(await import(" + json.dumps(module_url) + ")).default;console.log(JSON.stringify(config));"], capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        config = json.loads(process.stdout)
        self.assertTrue(config["fixture"])
        self.assertEqual(config["server"]["allowedHosts"], [self.manifest["hostname"]])

    def test_next_preserves_config_and_websocket_upgrades(self):
        self.file("package.json", json.dumps({"dependencies": {"next": "15.0.0"}}))
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "next")
        generated = (self.launch / "next-server.cjs").read_text()
        self.assertIn("loadConfig", generated)
        self.assertIn('allowedDevOrigins=["fixture-abcdef.sprites.app"]', generated)
        self.assertIn("getUpgradeHandler", generated)
        if boot.shutil.which("node"):
            subprocess.run(["node", "--check", str(self.launch / "next-server.cjs")], check=True, capture_output=True)

    def test_generic_node_requires_identifiable_port(self):
        self.file("package.json", json.dumps({"scripts": {"start": "node server.js"}}))
        with self.assertRaises(boot.NeedsConfiguration):
            self.detected()
        self.file("server.js", "process.env.PORT")
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "node")
        self.assertEqual(recipe.port, 8080)

    def test_generic_node_reads_commonjs_and_module_entrypoints(self):
        self.file("package.json", json.dumps({"scripts": {"start": "node server.cjs"}}))
        self.file("server.cjs", "require('http').createServer().listen(process.env.PORT)")
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "node")
        (self.root / "server.cjs").unlink()
        self.file("server.mjs", "server.listen(process.env.PORT)")
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "node")

    def test_package_manager_uses_matching_lockfile(self):
        self.file("pnpm-lock.yaml", "lockfileVersion: 9")
        manager, command = boot.package_manager(self.root, {})
        self.assertEqual(manager, "pnpm")
        self.assertIn("--frozen-lockfile", command)
        self.file("package-lock.json", "{}")
        with self.assertRaises(boot.NeedsConfiguration):
            boot.package_manager(self.root, {})

    def test_package_manager_declaration_must_match_lockfile(self):
        self.file("yarn.lock", "# lock")
        with self.assertRaises(boot.NeedsConfiguration):
            boot.package_manager(self.root, {"packageManager": "pnpm@9.0.0"})
        _, args = boot.package_manager(self.root, {"packageManager": "yarn@4.0.0"})
        self.assertIn("--immutable", args)

    def tool_fixture(self, pin="pnpm@12.15.0", installed=None, corepack=None, fail=False):
        self.file("package.json", json.dumps({"packageManager": pin, "scripts": {"start": "node server.cjs"}}))
        self.file("server.cjs", "require('http').createServer().listen(process.env.PORT)")
        runner = self.runner()
        calls = []
        wanted = pin.split("@", 1)[1].split("+", 1)[0]

        def which(binary, path=None):
            wrapper = self.launch / "tools/bin" / binary
            if wrapper.is_file() and str(wrapper.parent) in (path or ""):
                return str(wrapper)
            return {"node": "/fake/node", "npm": "/fake/npm", "corepack": corepack, "pnpm": "/fake/pnpm" if installed else None}.get(binary)

        def run(argv, **kwargs):
            calls.append((list(argv), dict(kwargs)))
            if argv == ["node", "--version"]:
                return "v24.22.1"
            if argv == ["pnpm", "--version"]:
                return wanted if (self.launch / "tools/bin/pnpm").is_file() else installed or ""
            if "install" in argv and any(item.startswith("corepack@") for item in argv):
                if fail:
                    raise RuntimeError("Package-tool download failed")
                binary = self.launch / "tools/corepack/node_modules/.bin/corepack"
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_text("fixture corepack")
                return ""
            if argv[0].endswith("corepack"):
                return wanted
            return ""

        runner.run_command = run
        return runner, calls, which

    def test_missing_pnpm_is_provisioned_locally_at_exact_version_and_integrity(self):
        pin = "pnpm@12.15.0+sha512." + "a" * 128
        runner, calls, which = self.tool_fixture(pin)
        original = (self.root / "package.json").read_text()
        with patch.object(boot.shutil, "which", side_effect=which):
            recipe = runner.detect()
        self.assertEqual(recipe.name, "node")
        installs = [argv for argv, _ in calls if "corepack@0.36.0" in argv]
        self.assertEqual(len(installs), 1)
        self.assertIn("--prefix", installs[0])
        self.assertNotIn("--global", installs[0])
        self.assertTrue(any(pin in argv for argv, _ in calls))
        wrapper = (self.launch / "tools/bin/pnpm").read_text()
        self.assertIn(pin, wrapper)
        self.assertIn("COREPACK_ENABLE_DOWNLOAD_PROMPT=0", wrapper)
        self.assertIn("COREPACK_ENABLE_AUTO_PIN=0", wrapper)
        self.assertIn(str(self.launch / "tools/corepack-cache"), wrapper)
        self.assertIn("npm_config_store_dir=", wrapper)
        self.assertIn("pnpm_config_store_dir=", wrapper)
        self.assertIn(str(self.launch / "tools/pnpm-store"), wrapper)
        marker = json.loads((self.launch / "tools/pnpm.json").read_text())
        self.assertEqual(marker["environment"]["npm_config_store_dir"], str(self.launch / "tools/pnpm-store"))
        self.assertEqual(marker["environment"]["pnpm_config_store_dir"], str(self.launch / "tools/pnpm-store"))
        self.assertEqual((self.root / "package.json").read_text(), original)
        self.assertTrue(runner.environment["PATH"].startswith(str(self.launch / "tools/bin") + os.pathsep))

    def test_available_compatible_corepack_is_used_without_npm_install(self):
        runner, calls, which = self.tool_fixture(corepack="/fake/corepack")
        with patch.object(boot.shutil, "which", side_effect=which):
            runner.detect()
        self.assertTrue(any(argv[0] == "/fake/corepack" and "pnpm@12.15.0" in argv for argv, _ in calls))
        self.assertFalse(any("install" in argv for argv, _ in calls))

    def test_wrong_installed_pnpm_is_replaced_only_in_launch_path(self):
        runner, calls, which = self.tool_fixture(installed="9.0.0")
        with patch.object(boot.shutil, "which", side_effect=which):
            runner.detect()
        self.assertTrue((self.launch / "tools/bin/pnpm").is_file())
        self.assertFalse(any("uninstall" in argv or "--global" in argv for argv, _ in calls))

    def test_matching_installed_pnpm_does_not_bootstrap_unnecessarily(self):
        runner, calls, which = self.tool_fixture(installed="12.15.0")
        with patch.object(boot.shutil, "which", side_effect=which):
            runner.detect()
        self.assertIn("exec /fake/pnpm", (self.launch / "tools/bin/pnpm").read_text())
        self.assertIn("pnpm_config_store_dir=", (self.launch / "tools/bin/pnpm").read_text())
        self.assertEqual([argv for argv, _ in calls], [["pnpm", "--version"]])

    def test_recovery_reuses_verified_tool_cache(self):
        pin = "pnpm@12.15.0+sha512." + "a" * 128
        runner, calls, which = self.tool_fixture(pin)
        with patch.object(boot.shutil, "which", side_effect=which):
            runner.detect()
            runner.environment = boot.clean_environment()
            runner.detect()
        self.assertEqual(sum("corepack@0.36.0" in argv for argv, _ in calls), 1)
        self.assertEqual(sum("pnpm@12.15.0+sha512." + "a" * 128 in argv for argv, _ in calls), 1)

    def test_old_cached_wrapper_is_migrated_to_private_store_without_reinstall(self):
        pin = "pnpm@12.15.0+sha512." + "a" * 128
        runner, calls, which = self.tool_fixture(pin)
        with patch.object(boot.shutil, "which", side_effect=which):
            runner.detect()
            marker_path = self.launch / "tools/pnpm.json"
            marker = json.loads(marker_path.read_text())
            marker.pop("environment")
            marker.pop("wrapperVersion")
            marker_path.write_text(json.dumps(marker))
            (self.launch / "tools/bin/pnpm").write_text("#!/bin/sh\n# legacy wrapper without private store\n")
            runner.environment = boot.clean_environment()
            runner.detect()
        self.assertEqual(sum("corepack@0.36.0" in argv for argv, _ in calls), 1)
        self.assertIn("pnpm_config_store_dir=", (self.launch / "tools/bin/pnpm").read_text())
        self.assertEqual(json.loads(marker_path.read_text())["wrapperVersion"], 2)

    def test_package_tool_failure_retains_checkout_and_releases_lease(self):
        runner, _, which = self.tool_fixture(fail=True)
        runner.clone = lambda: None
        with patch.object(boot.shutil, "which", side_effect=which):
            self.assertEqual(runner.execute(), 1)
        self.assertEqual(json.loads((self.launch / "state.json").read_text())["phase"], "failed")
        self.assertTrue((self.root / "server.cjs").exists())
        self.assertTrue(any(method == "DELETE" and path.startswith("/v1/tasks/") for method, path, _ in self.management.calls))
        self.assertFalse((self.launch / "tools/bin/pnpm").exists())

    def test_lockfile_only_pnpm_selects_a_compatible_fixed_release(self):
        self.file("pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
        self.assertEqual(boot.package_manager_pin(self.root, {}, "pnpm"), "pnpm@10.20.0")
        self.file("pnpm-lock.yaml", "lockfileVersion: 6.0\n")
        self.assertEqual(boot.package_manager_pin(self.root, {}, "pnpm"), "pnpm@8.15.9")
        self.file("pnpm-lock.yaml", "lockfileVersion: 99\n")
        with self.assertRaises(boot.NeedsConfiguration):
            boot.package_manager_pin(self.root, {}, "pnpm")

    def test_package_manager_bootstrap_refuses_unpinned_or_url_specs(self):
        for pin in ("pnpm@latest", "pnpm@12.15.0/../../escape", "pnpm@12.15.0+https://evil.test"):
            with self.assertRaises(boot.NeedsConfiguration):
                boot.package_manager_pin(self.root, {"packageManager": pin}, "pnpm")

    def test_node_runtime_requirement_is_enforced(self):
        self.file("package.json", json.dumps({"dependencies": {"vite": "*"}, "engines": {"node": ">=24"}}))
        with self.assertRaises(boot.NeedsConfiguration):
            self.detected()

    def test_workspaces_require_app_selection(self):
        self.file("package.json", json.dumps({"workspaces": ["apps/*"], "dependencies": {"vite": "*"}}))
        with self.assertRaises(boot.NeedsConfiguration):
            self.detected()

    def test_flask_recipe(self):
        self.file("requirements.txt", "Flask==3.1.0\n")
        self.file("app.py", "from flask import Flask\napp=Flask(__name__)\n")
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "flask")
        self.assertIn("--app", recipe.start)
        self.assertIn("-r", recipe.install[1])

    def test_fastapi_recipe_and_ambiguous_entrypoints(self):
        self.file("requirements.txt", "fastapi\nuvicorn\n")
        self.file("main.py", "from fastapi import FastAPI\napp = FastAPI()\n")
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "fastapi")
        self.assertIn("main:app", recipe.start)
        self.file("app/main.py", "app = FastAPI()\n")
        with self.assertRaises(boot.NeedsConfiguration):
            self.detected()

    def django_fixture(self, engine="sqlite3"):
        self.file("requirements.txt", "Django\n")
        self.file("manage.py", "import os\nos.environ.setdefault('DJANGO_SETTINGS_MODULE', 'project.settings')\n")
        self.file("project/__init__.py")
        self.file("project/settings.py", "DATABASES={'default': {'ENGINE': 'django.db.backends." + engine + "','NAME': '/production/never-touch.sqlite3'}}\n")

    def test_django_sqlite_overlay_avoids_original_db_and_exact_host(self):
        self.django_fixture()
        runner, recipe = self.detected()
        self.assertEqual(recipe.name, "django")
        runner.configure_database(recipe)
        with patch.dict(sys.modules, {"project": types.ModuleType("project"), "project.settings": types.ModuleType("project.settings")}):
            namespace = {}
            exec((self.launch / "launch_django_settings.py").read_text(), namespace)
        self.assertEqual(namespace["DATABASES"]["default"]["NAME"], str(self.launch / "database.sqlite3"))
        self.assertIn(self.manifest["hostname"], namespace["ALLOWED_HOSTS"])
        self.assertEqual(len(recipe.migrate), 1)
        migration = (self.launch / "django-migrate.py").read_text()
        self.assertIn("Refusing nonlocal migration", migration)
        self.assertLess(migration.index("django.setup()"), migration.index("for connection in connections.all()"))
        self.assertGreater(migration.index("call_command('migrate'"), migration.index("for connection in connections.all()"))

    def test_backend_framework_has_priority_over_asset_package_json(self):
        self.django_fixture()
        self.file("package.json", json.dumps({"devDependencies": {"esbuild": "*"}}))
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "django")

    def test_django_postgres_override_only_uses_loopback(self):
        self.django_fixture("postgresql")
        runner, recipe = self.detected()
        runner.ensure_postgres = lambda: {"kind": "postgres", "host": "127.0.0.1", "port": 15432, "user": "launch_test", "password": "local-only", "database": "launch_app"}
        runner.configure_database(recipe)
        generated = (self.launch / "launch_django_settings.py").read_text()
        self.assertIn("'HOST': '127.0.0.1'", generated)
        self.assertIn("'PORT': 15432", generated)
        self.assertNotIn("production", generated)
        self.assertIn("@127.0.0.1:15432/launch_app", recipe.env["DATABASE_URL"])

    def test_django_ready_database_rewrite_is_blocked_before_migration(self):
        self.django_fixture()
        runner, recipe = self.detected()
        runner.configure_database(recipe)
        fake = self.base / "fake-dependencies"
        marker = self.base / "migration-was-run"
        modules = {
            "django/__init__.py": "def setup():\n from django.conf import settings\n settings.DATABASES['default']['NAME']='/external/database.sqlite3'\n",
            "django/conf.py": "import importlib\nsettings=importlib.import_module('launch_django_settings')\n",
            "django/db.py": "from types import SimpleNamespace\nfrom django.conf import settings\nclass Connection:\n connection=None\n @property\n def settings_dict(self): return settings.DATABASES['default']\n def get_connection_params(self): return {'database': self.settings_dict['NAME']}\nconnections=SimpleNamespace(all=lambda:[Connection()])\n",
            "django/core/__init__.py": "",
            "django/core/management.py": "from pathlib import Path\ndef call_command(*args,**kwargs): Path(" + repr(str(marker)) + ").write_text('unsafe')\n",
        }
        for name, content in modules.items():
            path = fake / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content)
        env = dict(os.environ)
        env["PYTHONPATH"] = os.pathsep.join([str(fake), str(self.launch), str(self.root)])
        process = subprocess.run([sys.executable, str(self.launch / "django-migrate.py")], env=env, capture_output=True, text=True)
        self.assertNotEqual(process.returncode, 0)
        self.assertIn("Refusing nonlocal migration", process.stderr)
        self.assertFalse(marker.exists())

    def test_rails_overlay_and_migration_do_not_seed(self):
        self.file("Gemfile", "gem 'rails'\ngem 'sqlite3'\n")
        self.file("bin/rails", "#!/usr/bin/env ruby")
        self.file("config/database.yml", "development:\n  adapter: sqlite3\n  database: production.sqlite3\n")
        runner, recipe = self.detected()
        self.assertEqual(recipe.name, "rails")
        runner.configure_database(recipe)
        generated = (self.launch / "rails-launch.rb").read_text()
        self.assertIn("Refusing nonlocal migration", generated)
        self.assertIn("Rake::Task['db:migrate']", generated)
        self.assertIn(str(self.root / "config/environment"), generated)
        self.assertNotIn("Rails.application.initialize!", generated)
        self.assertNotIn("db:seed", generated)
        self.assertNotIn("db:prepare", generated)
        self.assertIn(self.manifest["hostname"], generated)
        config = json.loads((self.launch / "rails-database.yml").read_text())
        self.assertEqual(config["development"]["database"], str(self.launch / "database.sqlite3"))
        if boot.shutil.which("ruby"):
            subprocess.run(["ruby", "-c", str(self.launch / "rails-launch.rb")], check=True, capture_output=True)

    @unittest.skipUnless(boot.shutil.which("ruby"), "Ruby unavailable")
    def test_rails_rake_environment_does_not_initialize_application_twice(self):
        self.file("Gemfile", "gem 'rails'\ngem 'sqlite3'\n")
        self.file("bin/rails", "fixture")
        self.file("config/database.yml", "development:\n  adapter: sqlite3\n  database: never_touch.sqlite3\n")
        runner, recipe = self.detected()
        runner.configure_database(recipe)
        fake = self.base / "fake-ruby"
        (fake / "bundler").mkdir(parents=True)
        (fake / "bundler/setup.rb").write_text("")
        marker = self.base / "migration-ran"
        self.file("config/application.rb", "require 'json'\nmodule Rails\n class App\n  def config; @config ||= Struct.new(:hosts,:paths).new([],{}); end\n  def initialize!; raise 'initialized twice' if @initialized; @initialized=true; end\n  def load_tasks; end\n end\n def self.application; @app ||= App.new; end\nend\nmodule ActiveRecord\n class Base\n  def self.configurations; Configurations.new; end\n end\n class Configurations\n  def configs_for(env_name:)\n   config=JSON.parse(File.read(Rails.application.config.paths['config/database']),symbolize_names:true)[:development]\n   [Struct.new(:configuration_hash).new(config)]\n  end\n end\nend\nmodule Rake\n class Task\n  def self.[](name); new; end\n  def prerequisite_tasks; []; end\n  def invoke\n   require " + json.dumps(str(self.root / "config/environment")) + "\n   File.write(" + json.dumps(str(marker)) + ",'migrated')\n  end\n end\nend\n")
        self.file("config/environment.rb", "Rails.application.initialize!\n")
        process = subprocess.run(["ruby", "-I", str(fake), str(self.launch / "rails-launch.rb"), "launch-migrate"], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(marker.read_text(), "migrated")
        # bin/rails normally provides APP_PATH. Our external command wrapper
        # must supply the same boot contract for Rails::Command::ServerCommand.
        (fake / "rails").mkdir()
        (fake / "rails/commands.rb").write_text("module Rails\n module Command\n  class ServerCommand\n   raise 'APP_PATH missing' unless File.file?(APP_PATH + '.rb')\n   File.write(" + json.dumps(str(marker)) + ",APP_PATH)\n  end\n end\nend\n")
        process = subprocess.run(["ruby", "-I", str(fake), str(self.launch / "rails-launch.rb"), "server"], cwd=self.root, capture_output=True, text=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertEqual(marker.read_text(), str(self.root / "config/application"))

    def test_phoenix_endpoint_db_and_origin_overlay(self):
        self.file("mix.exs", 'defmodule Demo.MixProject do\n def project, do: [app: :demo, elixir: "~> 1.14", deps: [{:phoenix, "~> 1.7"}]]\nend\n')
        self.file("config/dev.exs", "import Config\nconfig :demo, DemoWeb.Endpoint, http: [port: 4000]\n")
        self.file("lib/demo/repo.ex", "defmodule Demo.Repo do\n use Ecto.Repo, otp_app: :demo, adapter: Ecto.Adapters.Postgres\nend\n")
        runner, recipe = self.detected()
        self.assertEqual(recipe.name, "phoenix")
        runner.ensure_postgres = lambda: {"kind": "postgres", "host": "127.0.0.1", "port": 15432, "user": "launch_test", "password": "local-only", "database": "launch_app"}
        runner.configure_database(recipe)
        generated = (self.launch / "phoenix-launch.exs").read_text()
        self.assertIn('check_origin: ["https://fixture-abcdef.sprites.app"]', generated)
        self.assertIn('hostname: "127.0.0.1"', generated)
        self.assertIn("Application.ensure_all_started(:demo)", generated)
        migration = (self.launch / "phoenix-migrate.exs").read_text()
        self.assertIn("Refusing nonlocal migration", migration)
        self.assertNotIn("ecto.setup", migration)

    def test_go_recipe_and_multiple_executables(self):
        self.file("go.mod", "module fixture.example/app\ngo 1.20\n")
        self.file("main.go", 'package main\nimport "net/http"\nfunc main(){http.ListenAndServe(":8080", nil)}\n')
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "go")
        self.assertEqual(recipe.port, 8080)
        self.file("cmd/other/main.go", "package main\nfunc main(){}")
        with self.assertRaises(boot.NeedsConfiguration):
            self.detected()

    def test_custom_commands_are_explicit_shell_commands(self):
        self.manifest["overrides"] = {"directory": ".", "installCommand": "echo install", "startCommand": "python3 app.py", "port": 9000}
        _, recipe = self.detected()
        self.assertEqual(recipe.name, "custom")
        self.assertEqual(recipe.start, ["bash", "-lc", "python3 app.py"])
        self.assertEqual(recipe.port, 9000)

    def test_directory_traversal_and_symlink_outside_checkout_refused(self):
        for directory in ("../", str(self.base)):
            self.manifest["overrides"] = {"directory": directory}
            with self.assertRaises(boot.NeedsConfiguration):
                self.runner().detect()
        (self.root / "outside").symlink_to(self.base)
        self.manifest["overrides"] = {"directory": "outside"}
        with self.assertRaises(boot.NeedsConfiguration):
            self.runner().detect()

    def test_missing_runtime_is_configuration_required(self):
        self.file("index.html", "hello")
        runner = self.runner()
        with patch.object(boot.shutil, "which", return_value=None):
            with self.assertRaises(boot.NeedsConfiguration):
                runner.detect()

    def test_unsupported_database_does_not_run_any_commands(self):
        with self.assertRaises(boot.NeedsConfiguration):
            boot.database_kind("adapter: mysql2")
        self.assertEqual(self.management.calls, [])

    def test_service_reconfiguration_replaces_own_service(self):
        runner = self.runner()
        first = {"cmd": "python3", "args": ["old.py"], "dir": str(self.root), "env": {"PORT": "8000"}, "http_port": 8000}
        second = {**first, "args": ["new.py"], "http_port": 9000}
        runner.ensure_service("owned", first)
        runner.ensure_service("owned", second)
        self.assertEqual(self.management.services["owned"], second)
        self.assertTrue(any(method == "DELETE" and path.endswith("/owned") for method, path, _ in self.management.calls))

    def test_service_reconciliation_does_not_overwrite_user_changes(self):
        runner = self.runner()
        body = {"cmd": "python3", "args": ["app.py"], "dir": str(self.root)}
        runner.ensure_service("owned", body)
        self.management.services["owned"]["args"] = ["user-work.py"]
        with self.assertRaises(boot.NeedsConfiguration):
            runner.ensure_service("owned", body)

    def test_service_reconciliation_normalizes_omitted_empty_fields(self):
        runner = self.runner()
        body = {"cmd": "python3", "args": [], "dir": str(self.root), "env": {}, "needs": []}
        runner.ensure_service("owned", body)
        self.management.services["owned"].pop("env")
        self.management.services["owned"].pop("needs")
        runner.ensure_service("owned", body)
        self.assertEqual(sum(method == "PUT" and path.endswith("/owned") for method, path, _ in self.management.calls), 1)

    def test_cancellation_releases_task_and_preserves_files(self):
        (self.launch / "cancel").touch()
        self.file("keep.txt", "user work")
        runner = self.runner()
        self.assertEqual(runner.execute(), 0)
        self.assertEqual(boot.read_json(self.launch / "state.json")["phase"], "cancelled")
        self.assertEqual((self.root / "keep.txt").read_text(), "user work")
        self.assertTrue(any(method == "DELETE" and "/tasks/" in path for method, path, _ in self.management.calls))

    def test_deadline_kills_child_process_group_and_releases_task(self):
        runner = self.runner(timeout=0.3)
        runner.clone = lambda: None
        self.file("index.html", "hello")
        marker = self.launch / "child.pid"
        runner.detect = lambda: boot.Recipe("test", [[sys.executable, "-c", "import subprocess,time,pathlib; p=subprocess.Popen(['sleep','60']); pathlib.Path(" + repr(str(marker)) + ").write_text(str(p.pid)); time.sleep(60)"]], ["unused"])
        self.assertEqual(runner.execute(), 1)
        state = boot.read_json(self.launch / "state.json")
        self.assertEqual(state["phase"], "failed")
        self.assertIn("deadline", state["error"])
        pid = int(marker.read_text())
        # A killed child may briefly be a zombie until its reaper runs.
        result = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True)
        self.assertTrue(result.returncode != 0 or result.stdout.strip().startswith("Z"), result.stdout)
        self.assertTrue(any(method == "DELETE" and "/tasks/" in path for method, path, _ in self.management.calls))

    def test_setup_lock_prevents_concurrent_work(self):
        import fcntl
        with open(self.launch / "setup.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertEqual(self.runner().execute(), 0)
        self.assertEqual(self.management.calls, [])

    def test_attempt_id_in_state_and_deadline_survives_recovery(self):
        self.manifest["attemptId"] = "attempt-original"
        self.manifest["setupStartedAt"] = "2000-01-01T00:00:00Z"
        self.save_manifest()
        runner = self.runner()
        runner.clone = lambda: self.fail("Expired setup must not clone or install")
        self.assertEqual(runner.execute(), 1)
        state = boot.read_json(self.launch / "state.json")
        self.assertEqual(state["attemptId"], "attempt-original")
        self.assertIn("deadline", state["error"])
        started = boot.read_json(self.launch / "attempt.json")["started"]
        # A recovered session with no timestamp cannot reset a saved deadline.
        self.manifest.pop("setupStartedAt")
        self.assertEqual(self.runner().execute(), 1)
        self.assertEqual(boot.read_json(self.launch / "attempt.json")["started"], started)

    def test_new_explicit_attempt_has_new_generation_and_deadline(self):
        boot.atomic_json(self.launch / "attempt.json", {"attemptId": "old-attempt", "started": 1})
        self.manifest["attemptId"] = "new-attempt"
        self.file("index.html", "hello")
        runner = self.runner()
        runner.clone = lambda: None
        runner.service = lambda recipe: runner.update("ready", "fixture")
        self.assertEqual(runner.execute(), 0)
        self.assertEqual(boot.read_json(self.launch / "state.json")["attemptId"], "new-attempt")
        self.assertGreater(boot.read_json(self.launch / "attempt.json")["started"], 1)

    def test_install_failure_releases_lease_and_preserves_checkout(self):
        self.manifest["overrides"] = {"directory": ".", "installCommand": "exit 7", "startCommand": "python3 server.py", "port": 8080}
        self.file("keep.txt", "retained")
        runner = self.runner()
        runner.clone = lambda: None
        self.assertEqual(runner.execute(), 1)
        self.assertEqual((self.root / "keep.txt").read_text(), "retained")
        self.assertEqual(boot.read_json(self.launch / "state.json")["phase"], "failed")
        self.assertTrue(any(method == "DELETE" and "/tasks/" in path for method, path, _ in self.management.calls))

    def test_generated_lockfile_does_not_repeat_completed_install(self):
        self.file("package.json", json.dumps({"scripts": {"start": "node app.js"}}))
        self.file("app.js", "process.env.PORT")
        calls = []
        def fake_install(argv, **kwargs):
            calls.append(argv)
            self.file("package-lock.json", '{"lockfileVersion":3}')
            return ""
        def configured_runner():
            runner = self.runner()
            runner.clone = lambda: None
            runner.detect = lambda: boot.Recipe("fixture", [["install-tool"]], ["server"])
            runner.run_command = fake_install
            runner.service = lambda recipe: runner.update("ready", "fixture")
            return runner
        self.assertEqual(configured_runner().execute(), 0)
        self.assertEqual(configured_runner().execute(), 0)
        self.assertEqual(calls, [["install-tool"]])

    def test_real_static_server_persistent_service_and_retry(self):
        self.management.execute = True
        self.file("index.html", "<h1>Runner fixture is live</h1>")
        self.manifest["overrides"] = {"directory": ".", "port": free_port()}
        runner = self.runner()
        runner.clone = lambda: None
        self.assertEqual(runner.execute(), 0)
        state = boot.read_json(self.launch / "state.json")
        self.assertEqual(state["phase"], "ready")
        self.assertEqual(state["recipe"], "static")
        self.assertIn("setupPid", state)
        connection = http.client.HTTPConnection("127.0.0.1", self.manifest["overrides"]["port"])
        connection.request("GET", "/")
        self.assertIn(b"Runner fixture is live", connection.getresponse().read())
        connection.close()
        original_pid = self.management.processes[runner.app_service].pid
        rerun = self.runner()
        rerun.clone = lambda: None
        self.assertEqual(rerun.execute(), 0)
        self.assertEqual(self.management.processes[runner.app_service].pid, original_pid)

    @unittest.skipUnless(boot.shutil.which("node") and boot.shutil.which("npm"), "Node/npm unavailable")
    def test_real_node_server_uses_port_and_preserves_app_host(self):
        self.management.execute = True
        self.file("package.json", json.dumps({"scripts": {"start": "node server.cjs"}}))
        self.file("server.cjs", "require('http').createServer((req,res)=>res.end(req.headers.host)).listen(Number(process.env.PORT),'0.0.0.0');")
        self.manifest["overrides"] = {"directory": ".", "port": free_port()}
        runner = self.runner()
        runner.clone = lambda: None
        self.assertEqual(runner.execute(), 0)
        state = boot.read_json(self.launch / "state.json")
        self.assertEqual(state["phase"], "ready")
        self.assertEqual(state["recipe"], "node")
        connection = http.client.HTTPConnection("127.0.0.1", state["port"])
        connection.request("GET", "/", headers={"Host": self.manifest["hostname"]})
        self.assertEqual(connection.getresponse().read().decode(), self.manifest["hostname"])
        connection.close()
        rerun = self.runner()
        rerun.clone = lambda: None
        self.assertEqual(rerun.execute(), 0)
        installs = [line for line in (self.launch / "launch.log").read_text().splitlines() if line.startswith("$ npm ")]
        self.assertEqual(len(installs), 1, installs)

    def test_real_git_fetch_checks_exact_sha_and_preserves_dirty_files(self):
        origin = self.base / "origin"
        origin.mkdir()
        def git(*args, cwd=origin):
            return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.DEVNULL).decode().strip()
        git("init")
        (origin / "index.html").write_text("first commit")
        git("add", ".")
        git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture")
        sha = git("rev-parse", "HEAD")
        self.manifest["target"]["sha"] = sha
        git("init", str(self.root))
        git("remote", "add", "origin", self.manifest["target"]["cloneUrl"], cwd=self.root)
        git("config", f"url.{origin}.insteadOf", self.manifest["target"]["cloneUrl"], cwd=self.root)
        runner = self.runner()
        with open(self.launch / "launch.log", "ab", buffering=0) as log:
            runner.log_handle = log
            runner.clone()
            self.assertEqual(git("rev-parse", "HEAD", cwd=self.root), sha)
            (self.root / "index.html").write_text("local edits")
            runner.clone()
            self.assertEqual((self.root / "index.html").read_text(), "local edits")
            # A subsequent user commit is retained instead of reset by retry.
            git("add", ".", cwd=self.root)
            git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "user work", cwd=self.root)
            with self.assertRaises(boot.NeedsConfiguration):
                runner.clone()


class VersionTests(unittest.TestCase):
    def test_supported_ranges(self):
        cases = [("22.1.0", ">=18 <24", True), ("22.1.0", "^22.0.0", True), ("23.0.0", "^22.0.0", False), ("3.12.0", ">=3.10,<4", True), ("3.3.0", "~>3.2", True), ("3.3.0", "~>3.2.0", False), ("1.18.0", "~>1.14", True), ("20.0.0", "18.x || 20.x", True), ("22.0.0", "18.x || 20.x", False)]
        for version, requirement, expected in cases:
            with self.subTest(version=version, requirement=requirement):
                self.assertEqual(boot.version_satisfies(version, requirement), expected)

    def test_unknown_range_is_not_ignored(self):
        with self.assertRaises(boot.NeedsConfiguration):
            boot.version_satisfies("22.0.0", "latest")


if __name__ == "__main__":
    unittest.main()
