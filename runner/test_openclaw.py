"""OpenClaw source checkout, Gateway auth and Vite disambiguation regressions."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

import bootstrap as boot
from test_bootstrap import LocalManagement


class OpenClawRecipeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="openclaw-launch-test-")
        self.base = Path(self.temp.name).resolve()
        self.root = self.base / "project"
        self.launch = self.base / "launch"
        self.root.mkdir()
        self.launch.mkdir()
        self.management = LocalManagement()
        self.manifest = {"version": 1, "launchId": "12345678-abcd-1234-abcd-123456789abc", "hostname": "openclaw-test.sprites.app",
                         "target": {"owner": "openclaw", "repo": "openclaw", "sha": "a" * 40, "cloneUrl": "https://github.com/openclaw/openclaw.git"}}
        self.path = self.launch / "manifest.json"
        self.path.write_text(json.dumps(self.manifest))

    def tearDown(self):
        self.management.close()
        self.temp.cleanup()

    def package(self, **changes):
        package = {"name": "openclaw", "packageManager": "pnpm@12.15.0", "engines": {"node": ">=24.16.0 <25 || >=26.1.0"},
                   "devDependencies": {"vite": "8.3.4"}, "scripts": {"start": "node openclaw.mjs", "build": "node scripts/build.mjs", "ui:build": "node scripts/ui.mjs"}}
        package.update(changes)
        (self.root / "package.json").write_text(json.dumps(package))
        (self.root / "openclaw.mjs").write_text("// fixture CLI")

    def detect(self):
        runner = boot.Runner(self.path, checkout=self.root, management=self.management)
        runner.ensure_package_manager = lambda package, manager: None
        runner.run_command = lambda argv, **kwargs: {"node": "v24.22.1", "pnpm": "12.15.0", "npm": "12.0.2"}.get(argv[0], "")
        with patch.object(boot.shutil, "which", return_value="/fake/tool"):
            recipe = runner.detect()
        return runner, recipe

    def test_openclaw_uses_built_gateway_instead_of_vite_dependency(self):
        self.package()
        runner, recipe = self.detect()
        self.assertEqual(recipe.name, "openclaw")
        self.assertIn(["pnpm", "run", "build"], recipe.install)
        self.assertIn(["pnpm", "run", "ui:build"], recipe.install)
        self.assertEqual(recipe.start, ["node", str(self.root / "openclaw.mjs"), "gateway", "--bind", "lan", "--port", "8080"])
        self.assertFalse((self.launch / "vite.config.mjs").exists())

    def test_gateway_auth_is_local_private_exact_origin_and_preserved_on_retry(self):
        self.package()
        _, recipe = self.detect()
        path = self.launch / "openclaw.json"
        config = json.loads(path.read_text())
        self.assertEqual(config["gateway"]["mode"], "local")
        self.assertEqual(config["gateway"]["auth"]["mode"], "token")
        self.assertGreaterEqual(len(config["gateway"]["auth"]["token"]), 32)
        self.assertEqual(config["gateway"]["trustedProxies"], ["10.0.0.2/32", "fdf::2/128"])
        self.assertIs(config["gateway"]["allowRealIpFallback"], False)
        self.assertEqual(config["gateway"]["controlUi"], {"enabled": True, "allowedOrigins": ["https://openclaw-test.sprites.app"]})
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertNotIn(config["gateway"]["auth"]["token"], json.dumps(recipe.start) + json.dumps(recipe.env))
        self.assertEqual(recipe.env["OPENCLAW_CONFIG_PATH"], str(path))
        self.assertEqual(recipe.env["OPENCLAW_STATE_DIR"], str(self.launch / "openclaw-state"))
        self.detect()
        self.assertEqual(json.loads(path.read_text()), config)

    def test_supported_runtime_profile_builds_gateway_and_ui_without_declarations(self):
        self.package(scripts={"build:runtime": "node scripts/build-all.mts runtime"})
        _, recipe = self.detect()
        self.assertEqual(recipe.install[-1], ["pnpm", "run", "build:runtime"])
        self.assertNotIn(["pnpm", "run", "build"], recipe.install)
        self.assertNotIn(["pnpm", "run", "ui:build"], recipe.install)

    def test_retained_auth_configuration_is_not_silently_overwritten(self):
        self.package()
        config = {"gateway": {"auth": {"mode": "none"}}}
        (self.launch / "openclaw.json").write_text(json.dumps(config))
        with self.assertRaises(boot.NeedsConfiguration):
            self.detect()
        self.assertEqual(json.loads((self.launch / "openclaw.json").read_text()), config)

    def test_interrupted_proxy_migration_restarts_owned_gateway_without_reinstalling(self):
        self.package()
        runner, recipe = self.detect()
        connection = MagicMock()
        connection.getresponse.return_value.status = 200
        with patch.object(boot.http.client, "HTTPConnection", return_value=connection):
            runner.service(recipe)
        runner.complete(runner.install_key(recipe))
        path = self.launch / "openclaw.json"
        config = json.loads(path.read_text())
        del config["gateway"]["trustedProxies"]
        del config["gateway"]["allowRealIpFallback"]
        path.write_text(json.dumps(config))

        # Simulate disconnect after migration but before the running service
        # has loaded it. A new runner must retain the pending reload intent.
        migrating, migrated_recipe = self.detect()
        migrated = json.loads(path.read_text())
        self.assertEqual(migrated["gateway"]["auth"], config["gateway"]["auth"])
        self.assertEqual(migrated["gateway"]["controlUi"], config["gateway"]["controlUi"])
        self.assertEqual(migrated["gateway"]["trustedProxies"], ["10.0.0.2/32", "fdf::2/128"])
        self.assertIs(migrated["gateway"]["allowRealIpFallback"], False)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertTrue(migrating.config_changed)
        self.assertEqual(migrating.install_key(migrated_recipe), runner.install_key(recipe))

        retry, _ = self.detect()
        self.assertTrue(retry.config_changed)
        retry.clone = lambda: None
        self.management.calls.clear()
        with patch.object(retry, "run_command", wraps=retry.run_command) as commands, patch.object(boot.http.client, "HTTPConnection", return_value=connection):
            self.assertEqual(retry.execute(), 0)
        self.assertFalse(any(call.args[0][1:2] in (["install"], ["run"]) for call in commands.call_args_list))
        app_path = "/v1/services/" + retry.app_service
        changes = [(method, request_path) for method, request_path, _ in self.management.calls if request_path.startswith(app_path) and method != "GET"]
        self.assertEqual(changes, [("POST", app_path + "/stop"), ("DELETE", app_path), ("PUT", app_path)])
        self.assertFalse((self.launch / "openclaw-config-restart.json").exists())
        self.assertFalse(retry.config_changed)

        # A completed migration is idempotent: reconnecting again neither
        # reinstalls dependencies nor replaces the already-correct service.
        again, _ = self.detect()
        self.assertFalse(again.config_changed)
        again.clone = lambda: None
        self.management.calls.clear()
        with patch.object(again, "run_command", wraps=again.run_command) as commands, patch.object(boot.http.client, "HTTPConnection", return_value=connection):
            self.assertEqual(again.execute(), 0)
        self.assertFalse(any(call.args[0][1:2] in (["install"], ["run"]) for call in commands.call_args_list))
        self.assertFalse(any(method != "GET" and request_path.startswith(app_path) for method, request_path, _ in self.management.calls))

    def test_custom_proxy_policy_is_preserved(self):
        self.package()
        for peers in (["192.0.2.3/32"], []):
            with self.subTest(peers=peers):
                config = {"gateway": {"auth": {"mode": "token", "token": "keep-this-token"}, "trustedProxies": peers, "allowRealIpFallback": True}}
                path = self.launch / "openclaw.json"
                path.write_text(json.dumps(config))
                self.detect()
                self.assertEqual(json.loads(path.read_text()), config)
                self.assertFalse((self.launch / "openclaw-config-restart.json").exists())

    def test_invalid_retained_proxy_types_require_configuration_without_rewriting(self):
        self.package()
        for settings in ({"trustedProxies": "10.0.0.2"}, {"trustedProxies": None}, {"trustedProxies": [123]}, {"trustedProxies": [""]}, {"allowRealIpFallback": "false"}, {"allowRealIpFallback": 0}):
            with self.subTest(settings=settings):
                config = {"gateway": {"auth": {"mode": "token", "token": "keep-this-token"}, **settings}}
                path = self.launch / "openclaw.json"
                path.write_text(json.dumps(config))
                with self.assertRaises(boot.NeedsConfiguration):
                    self.detect()
                self.assertEqual(json.loads(path.read_text()), config)
                self.assertFalse((self.launch / "openclaw-config-restart.json").exists())

    def test_pending_config_restart_does_not_replace_user_modified_service(self):
        self.package()
        runner, recipe = self.detect()
        runner.ensure_service(runner.app_service, {"cmd": "node", "args": ["old.js"], "dir": str(self.root)})
        self.management.services[runner.app_service]["args"] = ["user.js"]
        with self.assertRaises(boot.NeedsConfiguration):
            runner.service(recipe)
        self.assertEqual(self.management.services[runner.app_service]["args"], ["user.js"])
        self.assertTrue((self.launch / "openclaw-config-restart.json").exists())

    def test_vite_dev_dependency_alone_does_not_make_a_node_server_a_vite_app(self):
        self.package(name="some-server", packageManager="npm@12.0.2", scripts={"start": "node server.cjs", "build": "vite build"})
        (self.root / "server.cjs").write_text("server.listen(process.env.PORT)")
        _, recipe = self.detect()
        self.assertEqual(recipe.name, "node")
        self.assertFalse((self.launch / "vite.config.mjs").exists())

    def test_terminal_context_uses_the_app_config_and_tools_without_copying_gateway_token(self):
        self.package()
        runner, recipe = self.detect()
        connection = MagicMock()
        connection.getresponse.return_value.status = 200
        with patch.object(boot.http.client, "HTTPConnection", return_value=connection):
            runner.service(recipe)
        context = (self.launch / "launch-env.sh").read_text()
        self.assertIn("export OPENCLAW_CONFIG_PATH=", context)
        self.assertIn(str(self.launch / "openclaw.json"), context)
        self.assertIn("export PATH=", context)
        secret = json.loads((self.launch / "openclaw.json").read_text())["gateway"]["auth"]["token"]
        self.assertNotIn(secret, context)
        self.assertIn(str(self.launch / "launch-env.sh"), (self.launch / "terminal-rc.sh").read_text())
        self.assertEqual(stat.S_IMODE((self.launch / "launch-env.sh").stat().st_mode), 0o600)

    def test_source_cli_shim_forwards_arguments_with_private_context_and_spaced_paths(self):
        self.root = self.base / "project with spaces"
        self.launch = self.base / "launch with spaces"
        self.root.mkdir()
        self.launch.mkdir()
        self.path = self.launch / "manifest.json"
        self.path.write_text(json.dumps(self.manifest))
        self.package()
        runner, recipe = self.detect()
        # Detection stubs package-manager setup, so the source shim must add
        # its PATH independently of whether package tools created any shims.
        self.assertFalse((self.launch / "tools/bin").exists())
        runtime = self.base / "installed runtime with spaces"
        runtime.mkdir()
        node = runtime / "node"
        node.write_text("#!" + sys.executable + "\nimport json,os,sys\nprint(json.dumps({'argv':sys.argv[1:],'config':os.environ.get('OPENCLAW_CONFIG_PATH'),'state':os.environ.get('OPENCLAW_STATE_DIR')}))\n")
        node.chmod(0o700)
        runner.environment["PATH"] = str(runtime) + os.pathsep + runner.environment["PATH"]
        install_key = runner.install_key(recipe)
        config = json.loads((self.launch / "openclaw.json").read_text())
        token = config["gateway"]["auth"]["token"]
        connection = MagicMock()
        connection.getresponse.return_value.status = 200
        with patch.object(boot.http.client, "HTTPConnection", return_value=connection):
            runner.service(recipe)
        wrapper = self.launch / "tools/bin/openclaw"
        arguments = ["devices", "approve", "request id; $(do-not-run)", "quote'and\"double"]
        result = subprocess.run([str(wrapper), *arguments], capture_output=True, text=True, check=True,
                                env={"PATH": "/usr/bin:/bin", "OPENCLAW_CONFIG_PATH": "/wrong-config", "OPENCLAW_STATE_DIR": "/wrong-state"})
        self.assertEqual(json.loads(result.stdout), {"argv": [str(self.root / "openclaw.mjs"), *arguments],
                         "config": str(self.launch / "openclaw.json"), "state": str(self.launch / "openclaw-state")})
        self.assertEqual(stat.S_IMODE(wrapper.stat().st_mode), 0o700)
        self.assertNotIn(token, wrapper.read_text())
        self.assertNotIn(token, (self.launch / "launch-env.sh").read_text())
        service = self.management.services[runner.app_service]
        self.assertEqual(service["env"]["PATH"].split(os.pathsep)[0], str(wrapper.parent))
        self.assertIn(str(wrapper.parent), (self.launch / "launch-env.sh").read_text())
        service_cli = subprocess.run(["openclaw", *arguments], cwd=self.base, capture_output=True, text=True, check=True,
                                     env=service["env"])
        self.assertEqual(json.loads(service_cli.stdout), json.loads(result.stdout))
        terminal_cli = subprocess.run(["/bin/sh", "-c", '. "$1"; shift; exec openclaw "$@"', "source-cli-test",
                                       str(self.launch / "launch-env.sh"), *arguments], cwd=self.base,
                                      capture_output=True, text=True, check=True, env={"PATH": "/usr/bin:/bin"})
        self.assertEqual(json.loads(terminal_cli.stdout), json.loads(result.stdout))
        self.assertEqual(json.loads((self.launch / "openclaw.json").read_text()), config)
        self.assertEqual(runner.install_key(recipe), install_key)
        with patch.object(boot.http.client, "HTTPConnection", return_value=connection):
            runner.service(recipe)
        self.assertEqual(runner.environment["PATH"].split(os.pathsep).count(str(wrapper.parent)), 1)


if __name__ == "__main__":
    unittest.main()
