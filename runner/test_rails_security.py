"""Execute generated Rails migration guards with real Ruby/Rake lifecycle hooks.

ActiveRecord configurations and already-open native adapters are fixtures; no
database server or external connection is used by these refusal regressions.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import bootstrap as boot


@unittest.skipUnless(shutil.which("ruby"), "Ruby unavailable")
class RailsMigrationSecurityTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="rails-launch-guard-")
        self.base = Path(self.temporary.name)
        self.root = self.base / "project"
        self.launch = self.base / "launch"
        self.root.mkdir()
        self.launch.mkdir()
        (self.root / "config").mkdir()
        self.fake = self.base / "fake-ruby"
        (self.fake / "bundler").mkdir(parents=True)
        (self.fake / "bundler/setup.rb").write_text("")
        self.manifest = {"version": 1, "launchId": "12345678-abcd-1234-abcd-123456789abc", "hostname": "test-abcdef.sprites.app", "target": {"owner": "test", "repo": "repo", "sha": "a" * 40, "cloneUrl": "https://github.com/test/repo.git"}}
        path = self.launch / "manifest.json"
        path.write_text(json.dumps(self.manifest))
        self.runner = boot.Runner(path, checkout=self.root)
        self.runner.root = self.root
        self.result = self.base / "migration.json"
        (self.root / "config/environment.rb").write_text("")

    def tearDown(self):
        self.temporary.cleanup()

    def execute(self, *, kind="sqlite", hook=None, pool=None, native=None, migration_pool=None, empty=False, env=None):
        expected = {"adapter": "sqlite3", "database": str(self.launch / "database.sqlite3")} if kind == "sqlite" else {"adapter": "postgresql", "host": "127.0.0.1", "port": 15432, "username": "launch_test", "password": "fixture-password", "database": "launch_app"}
        self.runner.database = {"database": expected["database"]}
        recipe = boot.Recipe("rails", [], [], database=kind)
        self.runner.write_rails(recipe, expected)
        data = {"expected": expected, "hook": hook, "pool": pool or expected, "native": native, "migrationPool": migration_pool, "empty": empty, "result": str(self.result)}
        fixture = self.root / "fixture.json"
        fixture.write_text(json.dumps(data))
        source = r'''require 'json'
require 'rake'
DATA = JSON.parse(File.read(File.expand_path('../fixture.json', __dir__)), symbolize_names: true)
module ActiveRecord
  class Configurations
    attr_accessor :target
    def configs_for(env_name:)
      return [] if DATA[:empty]
      [Struct.new(:configuration_hash).new(@target || DATA[:expected])]
    end
  end
  class Native
    def conninfo_hash; DATA[:native]; end
    def execute(sql)
      raise 'Unexpected SQL' unless sql == 'PRAGMA database_list'
      return [{'seq'=>0, 'name'=>'main', 'file'=>DATA[:native][:database]}] if DATA[:native][:format] == 'hash'
      [[0, 'main', DATA[:native][:database]]]
    end
  end
  class Connection
    def connected?; true; end
    def raw_connection; Native.new; end
  end
  class Pool
    def initialize(config); @config=config; end
    def db_config; Struct.new(:configuration_hash).new(@config); end
    def connections; DATA[:native] ? [Connection.new] : []; end
  end
  class Base
    def self.configurations; @configs ||= Configurations.new; end
    def self.connection_pool; Pool.new(DATA[:pool]); end
  end
  module Tasks
    class DatabaseTasks
      def self.migration_connection_pool; Pool.new(DATA[:migrationPool] || DATA[:pool]); end
    end
  end
end
module Rails
  class App
    def config; @config ||= Struct.new(:hosts,:paths).new([], {}); end
    def load_tasks
      if DATA[:hook] == 'load_tasks'
        ActiveRecord::Base.configurations.target={adapter:'sqlite3', database:'external-production.sqlite3'}
      end
      Rake::Task.define_task('db:load_config') do
        if DATA[:hook] == 'prerequisite'
          ActiveRecord::Base.configurations.target={adapter:'sqlite3', database:'external-production.sqlite3'}
        end
      end
      Rake::Task.define_task('db:migrate' => 'db:load_config') do
        File.write(DATA[:result], JSON.generate({migrated:true}))
      end
    end
  end
  def self.application; @app ||= App.new; end
end
'''
        (self.root / "config/application.rb").write_text(source)
        environment = {k: v for k, v in os.environ.items() if not k.startswith("PG")}
        environment.update(env or {})
        return subprocess.run(["ruby", "-I", str(self.fake), str(self.launch / "rails-launch.rb"), "launch-migrate"], cwd=self.root, env=environment, capture_output=True, text=True)

    def refused(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Refusing nonlocal migration", result.stderr)
        self.assertFalse(self.result.exists(), "Migration ran against a refused target")

    def test_local_sqlite_migration_succeeds(self):
        result = self.execute(native={"database": str(self.launch / "database.sqlite3")})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(self.result.read_text())["migrated"])

    def test_local_postgres_migration_succeeds(self):
        result = self.execute(kind="postgres", native={"host": "127.0.0.1", "port": "15432", "dbname": "launch_app", "user": "launch_test", "hostaddr": "127.0.0.1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(self.result.read_text())["migrated"])

    def test_local_sqlite_native_hash_results_succeed(self):
        # Rails enables results_as_hash on its native SQLite connection.
        result = self.execute(native={"database": str(self.launch / "database.sqlite3"), "format": "hash"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(self.result.read_text())["migrated"])

    def test_task_loading_database_redirect_is_refused(self):
        self.refused(self.execute(hook="load_tasks"))

    def test_task_prerequisite_database_redirect_is_refused(self):
        self.refused(self.execute(hook="prerequisite"))

    def test_active_pool_database_redirect_is_refused(self):
        self.refused(self.execute(pool={"adapter": "sqlite3", "database": "external-production.sqlite3"}))

    def test_separate_migration_pool_database_redirect_is_refused(self):
        self.refused(self.execute(migration_pool={"adapter": "sqlite3", "database": "external-production.sqlite3"}))

    def test_already_open_sqlite_database_redirect_is_refused(self):
        self.refused(self.execute(native={"database": "external-production.sqlite3"}))

    def test_already_open_sqlite_hash_results_redirect_is_refused(self):
        self.refused(self.execute(native={"database": "external-production.sqlite3", "format": "hash"}))

    def test_postgres_config_hostaddr_redirect_is_refused(self):
        self.refused(self.execute(kind="postgres", pool={"adapter": "postgresql", "host": "127.0.0.1", "port": 15432, "username": "launch_test", "database": "launch_app", "hostaddr": "203.0.113.10"}))

    def test_already_open_postgres_hostaddr_redirect_is_refused(self):
        self.refused(self.execute(kind="postgres", native={"host": "127.0.0.1", "port": "15432", "dbname": "launch_app", "user": "launch_test", "hostaddr": "203.0.113.10"}))

    def test_postgres_environment_hostaddr_redirect_is_refused(self):
        self.refused(self.execute(kind="postgres", env={"PGHOSTADDR": "203.0.113.10"}))

    def test_missing_database_configuration_is_refused(self):
        self.refused(self.execute(empty=True))


class PostgresToolEnvironmentTest(unittest.TestCase):
    def test_local_management_tools_ignore_inherited_libpq_connection_overrides(self):
        with tempfile.TemporaryDirectory(prefix="postgres-env-guard-") as temporary:
            base = Path(temporary)
            tools = base / "postgresql/16/bin"
            tools.mkdir(parents=True)
            events = base / "events.jsonl"
            source = "#!" + os.sys.executable + "\n" + r'''
import json, os, pathlib, sys
name = pathlib.Path(sys.argv[0]).name
with pathlib.Path(EVENTS).open('a') as output:
    output.write(json.dumps({'tool':name,'argv':sys.argv[1:],'env':{key:value for key,value in os.environ.items() if key.startswith('PG')}})+'\n')
if name == 'initdb':
    data=pathlib.Path(sys.argv[sys.argv.index('-D')+1]);data.mkdir();(data/'PG_VERSION').write_text('16')
elif name == 'psql' and sys.argv[-1] == 'SELECT 1':
    print('1')
'''.replace("EVENTS", repr(str(events)))
            for tool in ("initdb", "psql", "createdb", "postgres"):
                target = tools / tool
                target.write_text(source)
                target.chmod(0o700)
            manifest = base / "manifest.json"
            manifest.write_text(json.dumps({"version": 1, "launchId": "12345678-abcd-1234-abcd-123456789abc", "hostname": "test-abcdef.sprites.app", "target": {"owner": "test", "repo": "repo", "sha": "a" * 40, "cloneUrl": "https://github.com/test/repo.git"}}))
            class Management:
                def request(self, method, path, body=None):
                    if method == "GET":
                        raise boot.ManagementError(404, "not found")
                    return {}
            runner = boot.Runner(manifest, checkout=base, management=Management())
            inherited = {key: "unsafe-inherited-value" for key in ("PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD", "PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "PGSYSCONFDIR", "PGPASSFILE", "PGOPTIONS")}
            runner.environment.update(inherited)
            original_glob = Path.glob
            def postgres_bins(path, pattern):
                return [tools] if path == Path("/usr/lib/postgresql") else original_glob(path, pattern)
            with patch.object(Path, "glob", postgres_bins), patch.object(boot.os, "geteuid", return_value=501):
                config = runner.ensure_postgres()
            observed = [json.loads(line) for line in events.read_text().splitlines()]
            self.assertEqual([event["tool"] for event in observed], ["initdb", "psql", "psql", "createdb"])
            self.assertEqual(observed[0]["env"], {})
            for event in observed[1:]:
                self.assertEqual(event["env"], {"PGHOST": "127.0.0.1", "PGPORT": "15432", "PGUSER": config["user"], "PGPASSWORD": config["password"]})
            self.assertEqual(observed[-1]["argv"], ["launch_app"])
            self.assertFalse(any(key.startswith("PG") for key in runner.environment))


if __name__ == "__main__":
    unittest.main()
