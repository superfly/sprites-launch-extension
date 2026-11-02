#!/usr/bin/env python3
"""Optional real-framework validation INSIDE A DISPOSABLE SPRITE.

Upload this file next to bootstrap.py, then run `python3 smoke_matrix.py`.
Requires working /.sprite/api.sock, outbound package downloads, available
language runtimes, and passwordless sudo for the PostgreSQL cases. This installs
dependencies and runs fixture apps. It never needs a Sprites account credential.

The immutable real-Git checkout path is covered separately. Here only clone is
replaced with prepared fixture files, while detection, dependency installation,
database setup/migrations, services, and HTTP readiness use real runner code.
"""
import argparse
import contextlib
import json
from pathlib import Path
import sqlite3
import sys
import time
import uuid

from bootstrap import Management, Runner, read_json


def fixtures():
    result = {}
    result["static"] = {"index.html": "<h1>Static fixture</h1>"}
    result["node"] = {
        "package.json": json.dumps({"name": "launch-node-fixture", "private": True, "scripts": {"start": "node server.cjs"}}),
        "server.cjs": "require('http').createServer((req,res)=>res.end('Node fixture')).listen(Number(process.env.PORT),'0.0.0.0');\n",
    }
    result["vite"] = {
        "package.json": json.dumps({"name": "launch-vite-fixture", "private": True, "type": "module", "devDependencies": {"vite": "^6.0.0"}, "scripts": {"dev": "vite"}}),
        "index.html": '<h1>Vite fixture</h1><script type="module" src="/main.js"></script>',
        "main.js": "document.querySelector('h1').dataset.ready='true';\n",
    }
    result["next"] = {
        "package.json": json.dumps({"name": "launch-next-fixture", "private": True, "dependencies": {"next": "^15.0.0", "react": "^19.0.0", "react-dom": "^19.0.0"}, "scripts": {"dev": "next dev"}}),
        "app/layout.jsx": "export default function Layout({children}){return <html><body>{children}</body></html>}\n",
        "app/page.jsx": "export default function Page(){return <h1>Next fixture</h1>}\n",
    }
    result["flask"] = {
        "requirements.txt": "Flask>=3.0,<4\n",
        "app.py": "from flask import Flask\napp=Flask(__name__)\n@app.get('/')\ndef home(): return 'Flask fixture'\n",
    }
    result["fastapi"] = {
        "requirements.txt": "fastapi>=0.115,<1\nuvicorn>=0.30,<1\n",
        "main.py": "from fastapi import FastAPI\napp = FastAPI()\n@app.get('/')\ndef home(): return {'fixture':'FastAPI'}\n",
    }
    result["go"] = {
        "go.mod": "module example.invalid/launchfixture\ngo 1.22\n",
        "main.go": 'package main\nimport("net/http";"os")\nfunc main(){http.HandleFunc("/",func(w http.ResponseWriter,r *http.Request){w.Write([]byte("Go fixture"))});http.ListenAndServe(":"+os.Getenv("PORT"),nil)}\n',
    }
    for kind in ("sqlite", "postgres"):
        engine = "sqlite3" if kind == "sqlite" else "postgresql"
        result["django-" + kind] = {
            "requirements.txt": "Django>=5.1,<6\n" + ("psycopg[binary]>=3,<4\n" if kind == "postgres" else ""),
            "manage.py": "import os,sys\nos.environ.setdefault('DJANGO_SETTINGS_MODULE','project.settings')\nfrom django.core.management import execute_from_command_line\nexecute_from_command_line(sys.argv)\n",
            "project/__init__.py": "",
            "project/settings.py": "SECRET_KEY='fixture-only-secret'\nDEBUG=True\nROOT_URLCONF='project.urls'\nINSTALLED_APPS=['django.contrib.contenttypes','smokeapp']\nDATABASES={'default':{'ENGINE':'django.db.backends." + engine + "','NAME':'fixture-should-be-overridden'}}\nDEFAULT_AUTO_FIELD='django.db.models.AutoField'\n",
            "project/urls.py": "from django.urls import path\nfrom django.http import HttpResponse\nurlpatterns=[path('',lambda request: HttpResponse('Django fixture'))]\n",
            "smokeapp/__init__.py": "",
            "smokeapp/models.py": "from django.db import models\nclass Item(models.Model):\n    name=models.CharField(max_length=20)\n",
            "smokeapp/migrations/__init__.py": "",
            "smokeapp/migrations/0001_initial.py": "from django.db import migrations,models\nclass Migration(migrations.Migration):\n    initial=True\n    dependencies=[]\n    operations=[migrations.CreateModel(name='Item',fields=[('id',models.AutoField(primary_key=True)),('name',models.CharField(max_length=20))])]\n",
        }
        adapter = "sqlite3" if kind == "sqlite" else "postgresql"
        result["rails-" + kind] = {
            "Gemfile": 'source "https://rubygems.org"\ngem "rails", "~> 7.2.0"\ngem "puma", "~> 6.0"\ngem "' + ("sqlite3" if kind == "sqlite" else "pg") + '"\n',
            "bin/rails": "#!/usr/bin/env ruby\nAPP_PATH=File.expand_path('../config/application',__dir__)\nrequire_relative '../config/boot'\nrequire 'rails/commands'\n",
            "config/boot.rb": "ENV['BUNDLE_GEMFILE'] ||= File.expand_path('../Gemfile',__dir__)\nrequire 'bundler/setup'\n",
            "config/application.rb": "require_relative 'boot'\nrequire 'rails'\nrequire 'active_record/railtie'\nrequire 'action_controller/railtie'\nBundler.require(*Rails.groups)\nmodule Smoke\n class Application < Rails::Application\n  config.load_defaults 7.2\n  config.eager_load=false\n  config.secret_key_base='fixture-only-secret-which-is-long-enough-for-the-development-server'\n end\nend\n",
            "config/environment.rb": "require_relative 'application'\nRails.application.initialize!\n",
            "config/environments/development.rb": "Rails.application.configure do\n config.eager_load=false\n config.consider_all_requests_local=true\nend\n",
            "config/routes.rb": "Rails.application.routes.draw do\n get '/', to: ->(env) { [200, {'content-type'=>'text/plain'}, ['Rails fixture']] }\nend\n",
            "config/database.yml": "development:\n  adapter: " + adapter + "\n  database: fixture_should_be_overridden\n",
            "config.ru": "require_relative 'config/environment'\nrun Rails.application\n",
            "db/migrate/20260101000000_create_items.rb": "class CreateItems < ActiveRecord::Migration[7.2]\n def change\n  create_table :items do |t|\n   t.string :name\n  end\n end\nend\n",
        }
        driver = '{:ecto_sqlite3, "~> 0.17"}' if kind == "sqlite" else '{:postgrex, "~> 0.19"}'
        adapter = "SQLite3" if kind == "sqlite" else "Postgres"
        result["phoenix-" + kind] = {
            "mix.exs": 'defmodule Smoke.MixProject do\n use Mix.Project\n def project, do: [app: :launch_smoke, version: "0.1.0", elixir: "~> 1.14", deps: deps()]\n def application, do: [extra_applications: [:logger], mod: {Smoke.Application, []}]\n defp deps, do: [{:phoenix, "~> 1.7.0"}, {:plug_cowboy, "~> 2.7"}, {:ecto_sql, "~> 3.12"}, ' + driver + ']\nend\n',
            "config/config.exs": 'import Config\nconfig :launch_smoke, ecto_repos: [Smoke.Repo]\nconfig :launch_smoke, SmokeWeb.Endpoint, adapter: Phoenix.Endpoint.Cowboy2Adapter, url: [host: "localhost"], http: [ip: {127,0,0,1}, port: 4000], secret_key_base: "fixture-only-secret-which-is-long-enough-for-phoenix-development", server: false\nconfig :launch_smoke, Smoke.Repo, database: "fixture_should_be_overridden"\n',
            "lib/smoke/application.ex": "defmodule Smoke.Application do\n use Application\n def start(_type,_args), do: Supervisor.start_link([Smoke.Repo, SmokeWeb.Endpoint], strategy: :one_for_one, name: Smoke.Supervisor)\nend\n",
            "lib/smoke/repo.ex": "defmodule Smoke.Repo do\n use Ecto.Repo, otp_app: :launch_smoke, adapter: Ecto.Adapters." + adapter + "\nend\n",
            "lib/smoke_web/endpoint.ex": "defmodule SmokeWeb.Endpoint do\n use Phoenix.Endpoint, otp_app: :launch_smoke\n plug :fixture\n defp fixture(conn,_opts), do: Plug.Conn.send_resp(conn,200,\"Phoenix fixture\")\nend\n",
            "priv/repo/migrations/20260101000000_create_items.exs": "defmodule Smoke.Repo.Migrations.CreateItems do\n use Ecto.Migration\n def change, do: create(table(:items))\nend\n",
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="Comma-separated fixture names; default: all")
    args = parser.parse_args()
    cases = fixtures()
    selected = args.only.split(",") if args.only else list(cases)
    if any(name not in cases for name in selected):
        parser.error("Unknown fixture. Available: " + ",".join(cases))
    run_root = Path("/home/sprite/.sprite-launch-matrix") / ("run-" + uuid.uuid4().hex[:8])
    run_root.mkdir(parents=True)
    outcomes = []
    for name in selected:
        print(json.dumps({"fixture": name, "status": "starting"}), flush=True)
        started = time.monotonic()
        fixture_root = run_root / name
        checkout = fixture_root / "project"
        launch = fixture_root / "launch"
        checkout.mkdir(parents=True)
        launch.mkdir()
        for relative, text in cases[name].items():
            path = checkout / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        launch_id = str(uuid.uuid4())
        manifest = {"version": 1, "launchId": launch_id, "attemptId": str(uuid.uuid4()), "hostname": "fixture.sprites.app", "target": {"owner": "fixture", "repo": name, "kind": "commit", "ref": "a" * 40, "sha": "a" * 40, "cloneUrl": f"https://github.com/fixture/{name}.git", "fetchRef": "a" * 40, "sourceUrl": f"https://github.com/fixture/{name}"}}
        manifest_path = launch / "manifest.json"
        manifest_path.write_text(json.dumps(manifest))
        runner = Runner(manifest_path, checkout=checkout)
        runner.clone = lambda: None
        try:
            code = runner.execute()
            state = read_json(launch / "state.json", {})
            if state.get("phase") == "ready" and runner.database:
                expected_table = "smokeapp_item" if name.startswith("django") else "items"
                if runner.database["kind"] == "sqlite":
                    with sqlite3.connect(runner.database["database"]) as connection:
                        exists = connection.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (expected_table,)).fetchone()
                else:
                    db = runner.database
                    exists = runner.run_command(["psql", "-Atc", "SELECT to_regclass('" + expected_table + "')", "-d", db["database"]], env={"PGHOST": "127.0.0.1", "PGPORT": str(db["port"]), "PGUSER": db["user"], "PGPASSWORD": db["password"]}, capture=True)
                if not exists:
                    state = {"phase": "failed", "message": "Migration did not create expected fixture table: " + expected_table}
                    code = 1
            outcome = {"fixture": name, "code": code, "phase": state.get("phase"), "message": state.get("message"), "seconds": round(time.monotonic() - started, 1), "logs": str(launch / "launch.log")}
            outcomes.append(outcome)
            print(json.dumps(outcome), flush=True)
            if state.get("phase") != "ready":
                print((launch / "launch.log").read_text(errors="replace")[-12000:], flush=True)
        except Exception as exc:
            outcome = {"fixture": name, "code": 1, "phase": "failed", "message": str(exc), "seconds": round(time.monotonic() - started, 1), "logs": str(launch / "launch.log")}
            outcomes.append(outcome)
            print(json.dumps(outcome), flush=True)
        finally:
            for service in (runner.app_service, runner.pg_service):
                with contextlib.suppress(Exception):
                    runner.management.request("POST", f"/v1/services/{service}/stop?duration=100ms")
                with contextlib.suppress(Exception):
                    runner.management.request("DELETE", f"/v1/services/{service}")
    (run_root / "results.json").write_text(json.dumps(outcomes, indent=2))
    print(json.dumps({"results": outcomes, "directory": str(run_root)}), flush=True)
    return 0 if all(item["phase"] == "ready" for item in outcomes) else 1


if __name__ == "__main__":
    sys.exit(main())
