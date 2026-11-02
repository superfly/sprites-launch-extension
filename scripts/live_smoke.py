#!/usr/bin/env python3
"""Opt-in live test. Uses the existing CLI keyring; never writes credentials.

SPRITES_LIVE_TEST_ORG must match the CLI's currently selected test organization.
Creates one UUID-named Sprite and deletes only that Sprite in finally.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request
import urllib.parse
import uuid


ROOT = Path(__file__).resolve().parents[1]


def command(args, timeout=180):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f"Command {args[0]} {args[1]} failed: {result.stderr[-1500:]}")
    return result.stdout


def api(path, method="GET", payload=None):
    args = ["sprite", "api", path, "--", "-sS", "--fail-with-body", "-X", method]
    if payload is not None:
        args += ["-H", "Content-Type: application/json", "--data-binary", json.dumps(payload)]
    output = command(args)
    start = output.find("{")
    if start < 0:
        return {}
    return json.JSONDecoder().raw_decode(output[start:])[0]


def github(path):
    request = urllib.request.Request("https://api.github.com" + path, headers={"User-Agent": "sprites-launch-extension-smoke", "Accept": "application/vnd.github+json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def main():
    expected = os.environ.get("SPRITES_LIVE_TEST_ORG")
    if not expected or "test" not in expected.lower():
        raise SystemExit("Set SPRITES_LIVE_TEST_ORG to a dedicated test organization.")
    listing = api("/v1/sprites?max_results=1")
    if listing.get("name") != expected:
        raise SystemExit("Selected CLI organization does not match the requested test organization.")
    repository = github("/repos/mdn/beginner-html-site-styled")
    revision = github("/repos/mdn/beginner-html-site-styled/commits/" + repository["default_branch"])["sha"]
    launch_id = str(uuid.uuid4())
    name = "gh-ext-smoke-" + launch_id[:8]
    directory = "/home/sprite/.sprite-launch/" + launch_id
    created = False
    try:
        sprite = api("/v1/sprites", "POST", {"name": name, "url_settings": {"auth": "sprite"}})
        created = True
        if sprite.get("name") != name or not sprite.get("url", "").startswith("https://"):
            raise RuntimeError("Unexpected Sprite creation response.")
        print("Created disposable Sprite:", name, flush=True)
        manifest = {"version": 1, "launchId": launch_id, "attemptId": str(uuid.uuid4()), "hostname": urllib.parse.urlparse(sprite["url"]).hostname,
                    "target": {"owner": "mdn", "repo": "beginner-html-site-styled", "kind": "branch", "ref": repository["default_branch"], "sha": revision,
                               "cloneUrl": "https://github.com/mdn/beginner-html-site-styled.git", "fetchRef": "refs/heads/" + repository["default_branch"],
                               "sourceUrl": "https://github.com/mdn/beginner-html-site-styled"}}
        with tempfile.TemporaryDirectory(prefix="sprites-launch-live-") as temp:
            path = Path(temp) / "manifest.json"
            path.write_text(json.dumps(manifest))
            output = command(["sprite", "exec", "-s", name, "--no-port-forward", "--file", str(ROOT / "runner/bootstrap.py") + ":" + directory + "/bootstrap.py",
                              "--file", str(path) + ":" + directory + "/manifest.json", "--", "python3", directory + "/bootstrap.py", "--manifest", directory + "/manifest.json"], timeout=300)
        state = json.loads(command(["sprite", "exec", "-s", name, "--no-port-forward", "--", "cat", directory + "/state.json"]))
        if state["phase"] != "ready":
            print(output[-5000:])
            raise RuntimeError("Runner did not become ready: " + json.dumps(state))
        checks = command(["sprite", "exec", "-s", name, "--no-port-forward", "--", "python3", "-c",
                          "import json,urllib.request,subprocess; print(json.dumps({'http':urllib.request.urlopen('http://127.0.0.1:8080').status,'sha':subprocess.check_output(['git','-C','/home/sprite/project','rev-parse','HEAD'],text=True).strip()}))"])
        result = json.loads(checks)
        assert result["http"] == 200 and result["sha"] == revision, result
        print("PASS: public checkout pinned to SHA; static service returns HTTP 200; runner ready.", flush=True)
        tasks = command(["sprite", "exec", "-s", name, "--no-port-forward", "--", "sprite-env", "curl", "/v1/tasks"])
        assert "launch-" + launch_id not in tasks, "Setup Task lease was not released"
        print("PASS: setup Task lease released.", flush=True)
        boot = command(["sprite", "exec", "-s", name, "--no-port-forward", "--", "cat", "/proc/sys/kernel/random/boot_id"]).strip()
        api("/v1/sprites/" + name + "/restart", "POST", {})
        deadline = time.monotonic() + 120
        restarted = False
        while time.monotonic() < deadline:
            try:
                check = json.loads(command(["sprite", "exec", "-s", name, "--no-port-forward", "--", "python3", "-c",
                                           "import json,pathlib,urllib.request; print(json.dumps({'boot':pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip(),'http':urllib.request.urlopen('http://127.0.0.1:8080',timeout=5).status}))"], timeout=30))
                if check["boot"] != boot and check["http"] == 200:
                    restarted = True
                    break
            except (RuntimeError, subprocess.TimeoutExpired):
                pass
            time.sleep(1)
        assert restarted, "App service did not recover across a verified VM reboot"
        print("PASS: changed VM boot ID and persistent app service returns HTTP 200 after restart.", flush=True)
    finally:
        if created:
            api("/v1/sprites/" + name, "DELETE")
            print("Deleted disposable Sprite:", name, flush=True)


if __name__ == "__main__":
    main()
