"""Hermes source-dashboard tests with executable, offline PM/build fixtures."""
import copy
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import unittest
from unittest.mock import patch

import bootstrap as boot
import test_bootstrap as fixtures


class HermesTest(unittest.TestCase):
    setUp = fixtures.RunnerTest.setUp
    tearDown = fixtures.RunnerTest.tearDown
    save_manifest = fixtures.RunnerTest.save_manifest
    file = fixtures.RunnerTest.file
    runner = fixtures.RunnerTest.runner

    def fixture(self):
        self.file("package.json", json.dumps({"name": "hermes-agent", "workspaces": ["apps/*", "web"], "engines": {"node": ">=26"}}))
        self.file("pyproject.toml", '[project]\nname = "hermes-agent"\nrequires-python = ">=3.11,<3.15"\n')
        for path in ("web/package.json", "apps/shared/package.json", "package-lock.json", "pm/lock.json", "uv.lock"):
            self.file(path, "{}")
        for path in ("hermes_cli/__init__.py", "hermes_cli/web_server.py", "web/vite.config.ts", "web/public/favicon.ico", "scripts/build/node-deps.mjs", "scripts/build/web.mjs", "pm/__init__.py"):
            self.file(path)
        # The fixture PM resolves its selected Python exactly as upstream does.
        self.file("pm/environments.py", "from pathlib import Path\nimport sys\ndef project_python(root): return Path(sys.executable)\n")
        self.events = self.launch / "fixture-events.jsonl"
        tool_bin = self.root / "fixture-tools"
        node = self.file("fixture-tools/node", "#!" + sys.executable + "\n" +
                         "import json,sys\nfrom pathlib import Path\n" +
                         "with Path(" + repr(str(self.events)) + ").open('a') as out: out.write(json.dumps(sys.argv[1:])+'\\n')\n" +
                         "if Path(sys.argv[1]).name == 'web.mjs':\n"
                         " out=Path(sys.argv[sys.argv.index('--out')+1]);out.mkdir(parents=True,exist_ok=True);(out/'index.html').write_text('<h1>Hermes fixture</h1>')\n")
        node.chmod(0o700)
        self.file("pm/cli.py", "import json,sys\nfrom pathlib import Path\n" +
                  "if sys.argv[1:] == ['env','npm']: print(json.dumps({'PATH':" + repr(str(tool_bin)) + "}))\n" +
                  "elif sys.argv[1:] == ['install','npm','--extra','web']:\n"
                  " with Path(" + repr(str(self.events)) + ").open('a') as out: out.write(json.dumps(['pm-install']+sys.argv[1:])+'\\n')\n" +
                  "else: raise SystemExit('Unexpected PM arguments')\n")
        # Production imports Hermes' own strict YAML loader. JSON is a YAML
        # subset, sufficient for exercising the emitted auth configuration.
        self.file("hermes_yaml.py", "import json\ndef safe_load(value): return json.loads(value)\ndef safe_dump(value,**kwargs): return json.dumps(value)\n")
        self.file("hermes_cli/main.py", "import json,os,sys\nprint(json.dumps({'argv':sys.argv[1:],'home':os.environ.get('HERMES_HOME'),'runtime':os.environ.get('HERMES_RUNTIME_DIR')}))\n")

    def detect(self, runner=None):
        runner = runner or self.runner()
        original = runner.run_command
        def command(argv, **kwargs):
            if argv == [sys.executable, "--version"]:
                return "Python 3.14.4"
            return original(argv, **kwargs)
        runner.run_command = command
        original_which = boot.shutil.which
        def which(binary, **kwargs):
            return sys.executable if binary == "python3.14" else original_which(binary, **kwargs)
        with patch.object(boot.shutil, "which", side_effect=which):
            recipe = runner.detect()
        return runner, recipe

    def install(self):
        runner, recipe = self.detect()
        for argv in recipe.install:
            runner.run_hermes_command(argv, recipe)
        runner.prepare_hermes_service(recipe)
        return runner, recipe

    def recorded(self):
        return [json.loads(line) for line in self.events.read_text().splitlines()]

    def test_complete_hermes_source_precedes_workspace_guard(self):
        self.fixture()
        runner, recipe = self.detect()
        self.assertEqual(recipe.name, "hermes")
        self.assertEqual(recipe.health_path, "/api/health")
        self.assertEqual(recipe.install[0], [sys.executable, "-m", "pm.cli", "install", "npm", "--extra", "web"])
        self.assertEqual(recipe.env["HERMES_HOME"], str(self.launch / "hermes-home"))
        self.assertEqual(recipe.env["HERMES_RUNTIME_DIR"], str(self.launch / "hermes-runtime"))
        self.assertEqual(recipe.env["HERMES_WEB_BUILD_LIGHT"], "1")
        self.assertFalse((self.launch / "hermes-connection.json").exists())
        compile(boot.HERMES_HELPER, "hermes-launch.py", "exec")

    def test_incomplete_or_unrelated_workspace_still_requires_directory(self):
        self.fixture()
        for path in ("pm/lock.json", "hermes_cli/web_server.py", "scripts/build/web.mjs"):
            original = (self.root / path).read_text()
            (self.root / path).unlink()
            with self.assertRaisesRegex(boot.NeedsConfiguration, "Choose the application directory"):
                self.detect()
            self.file(path, original)
        self.file("pyproject.toml", '[project]\nname="other-project"\n')
        with self.assertRaisesRegex(boot.NeedsConfiguration, "Choose the application directory"):
            self.detect()

    def test_python_314_is_required_without_replacing_system_runtime(self):
        self.fixture()
        runner = self.runner()
        with patch.object(boot.shutil, "which", return_value=None):
            with self.assertRaisesRegex(boot.NeedsConfiguration, "requires Python 3.14"):
                runner.detect()
        runner.run_command = lambda *args, **kwargs: "Python 3.13.9"
        with patch.object(boot.shutil, "which", return_value="/installed/python3.14"):
            with self.assertRaisesRegex(boot.NeedsConfiguration, "requires Python 3.14"):
                runner.detect()
        self.assertFalse(self.events.exists())

    def test_inherited_account_and_model_credentials_are_not_used(self):
        self.fixture()
        names = {"OPENAI_API_KEY": "account-secret", "ANTHROPIC_AUTH_TOKEN": "account-secret", "GH_TOKEN": "account-secret", "CUSTOM_API_TOKEN": "account-secret", "HERMES_HOME": "/other/account", "HERMES_WEB_DIST": "/other/assets", "npm_execpath": "/other/npm.js", "VIRTUAL_ENV": "/other/venv", "PYTHONPATH": "/other/modules"}
        with patch.dict(os.environ, names):
            runner, recipe = self.detect()
        for name in names:
            self.assertNotIn(name, runner.environment)
        self.assertNotIn("account-secret", json.dumps(recipe.env))
        self.assertEqual(recipe.env["HERMES_HOME"], str(self.launch / "hermes-home"))

    def test_build_and_auth_are_executable_and_survive_retry(self):
        self.fixture()
        runner, recipe = self.install()
        records = self.recorded()
        self.assertEqual(records[0], ["pm-install", "install", "npm", "--extra", "web"])
        self.assertEqual(records[1], [str(self.root / "scripts/build/node-deps.mjs"), "--source", str(self.root), "--reuse", "--workspace", "web"])
        self.assertEqual(records[2], [str(self.root / "scripts/build/web.mjs"), "--source", str(self.root), "--icons", str(self.root), "--out", str(self.launch / "web-dist")])
        connection_path = self.launch / "hermes-connection.json"
        config_path = self.launch / "hermes-home/config.yaml"
        credentials = json.loads(connection_path.read_text())
        config = json.loads(config_path.read_text())
        self.assertEqual(credentials["username"], "sprite")
        self.assertGreaterEqual(len(credentials["password"]), 40)
        self.assertEqual(config["dashboard"]["public_url"], "https://" + self.manifest["hostname"])
        self.assertEqual(config["terminal"], {"backend": "local", "cwd": str(self.root)})
        self.assertNotIn(credentials["password"], config_path.read_text())
        self.assertEqual(config["dashboard"]["trusted_proxies"], ["10.0.0.2/32", "fdf::2/128"])
        helper = {"__name__": "fixture"}
        exec(compile(boot.HERMES_HELPER, "hermes-launch.py", "exec"), helper)
        self.assertTrue(helper["password_matches"](credentials["password"], config["dashboard"]["basic_auth"]["password_hash"]))
        for path in (connection_path, config_path, self.launch / "hermes-runtime.json"):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        original = (connection_path.read_bytes(), config_path.read_bytes())
        runner.prepare_hermes_service(recipe)
        self.assertEqual(original, (connection_path.read_bytes(), config_path.read_bytes()))
        self.assertEqual(len(self.recorded()), 3)
        self.assertEqual(recipe.start[1:], ["-m", "hermes_cli.main", "dashboard", "--no-open", "--host", "0.0.0.0", "--port", "8080", "--skip-build"])

    def test_retained_unsafe_auth_is_refused_without_overwriting(self):
        self.fixture()
        runner, recipe = self.install()
        path = self.launch / "hermes-home/config.yaml"
        original = json.loads(path.read_text())
        invalid = []
        for key, value in (("dashboard", []), ("terminal", "remote")):
            item = copy.deepcopy(original); item[key] = value; invalid.append(item)
        for key, value in (("basic_auth", []), ("public_url", "https://other.example"), ("trusted_proxies", "*")):
            item = copy.deepcopy(original); item["dashboard"][key] = value; invalid.append(item)
        for key, value in (("username", ["sprite"]), ("password_hash", "changed"), ("secret", {}), ("secret", "$(openssl rand -hex 32)" + "x" * 32), ("password", "unexpected")):
            item = copy.deepcopy(original); item["dashboard"]["basic_auth"][key] = value; invalid.append(item)
        for item in invalid:
            content = json.dumps(item)
            path.write_text(content)
            with self.assertRaises(boot.NeedsConfiguration):
                runner.prepare_hermes_service(recipe)
            self.assertEqual(path.read_text(), content)
        path.write_text("null")
        with self.assertRaisesRegex(boot.NeedsConfiguration, "must be a mapping"):
            runner.prepare_hermes_service(recipe)

    def test_missing_credential_record_does_not_rotate_retained_account(self):
        self.fixture()
        runner, recipe = self.install()
        (self.launch / "hermes-connection.json").unlink()
        config_path = self.launch / "hermes-home/config.yaml"
        original = config_path.read_bytes()
        with self.assertRaisesRegex(boot.NeedsConfiguration, "no matching launch credentials"):
            runner.prepare_hermes_service(recipe)
        self.assertEqual(config_path.read_bytes(), original)
        self.assertFalse((self.launch / "hermes-connection.json").exists())

    def test_interruption_after_password_publication_retains_password(self):
        self.fixture()
        saved = {"username": "sprite", "password": "retained-password-value"}
        (self.launch / "hermes-connection.json").write_text(json.dumps(saved))
        self.install()
        self.assertEqual(json.loads((self.launch / "hermes-connection.json").read_text()), saved)

    def test_fingerprint_covers_hermes_locks_and_frontend_dependencies(self):
        self.fixture()
        runner, recipe = self.detect()
        expected = runner.install_key(recipe)
        for name in ("uv.lock", "pm/lock.json", "web/package.json", "apps/shared/package.json"):
            original = (self.root / name).read_text()
            self.file(name, original + "\n")
            self.assertNotEqual(runner.install_key(recipe), expected, name)
            self.file(name, original)
        (self.launch / "hermes-connection.json").write_text('{"password":"changed"}')
        self.assertEqual(runner.install_key(recipe), expected)

    def test_terminal_cli_keeps_context_from_another_working_directory(self):
        self.fixture()
        runner, recipe = self.install()
        environment = {**boot.clean_environment(), **recipe.env}
        result = subprocess.run(["hermes", "--help"], cwd=self.launch, env=environment, text=True, capture_output=True, check=True)
        value = json.loads(result.stdout)
        self.assertEqual(value, {"argv": ["--help"], "home": str(self.launch / "hermes-home"), "runtime": str(self.launch / "hermes-runtime")})

    def test_retry_revalidates_auth_while_skipping_completed_dependencies(self):
        self.fixture()
        runner, recipe = self.install()
        runner.complete(runner.install_key(recipe))
        retried, retried_recipe = self.detect()
        retried.clone = lambda: None
        retried.detect = lambda: retried_recipe
        started = []
        retried.service = lambda recipe: started.append(recipe)
        self.assertEqual(retried.execute(), 0)
        self.assertEqual(len(self.recorded()), 3)
        self.assertEqual(len(started), 1)
        config = self.launch / "hermes-home/config.yaml"
        config.write_text('{"dashboard":{"basic_auth":false}}')
        retried, retried_recipe = self.detect()
        retried.clone = lambda: None
        retried.detect = lambda: retried_recipe
        retried.service = lambda recipe: self.fail("Unsafe app auth must prevent startup")
        self.assertEqual(retried.execute(), 0)
        self.assertEqual(retried.state["phase"], "needs_configuration")
        self.assertEqual(len(self.recorded()), 3)

    def test_missing_built_assets_recover_even_with_completed_install(self):
        self.fixture()
        runner, recipe = self.install()
        runner.complete(runner.install_key(recipe))
        (self.launch / "web-dist/index.html").unlink()
        retried, retried_recipe = self.detect()
        retried.clone = lambda: None
        retried.detect = lambda: retried_recipe
        retried.service = lambda recipe: None
        self.assertEqual(retried.execute(), 0)
        self.assertTrue((self.launch / "web-dist/index.html").exists())
        self.assertEqual(len(self.recorded()), 6)

    def test_pm_environment_names_cannot_become_shell_syntax(self):
        self.fixture()
        runner, recipe = self.install()
        path = self.launch / "hermes-runtime.json"
        value = json.loads(path.read_text())
        value["environment"]["BAD; echo unsafe"] = "value"
        path.write_text(json.dumps(value))
        self.assertIsNone(runner.hermes_context())


if __name__ == "__main__":
    unittest.main()
