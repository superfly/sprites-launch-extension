#!/usr/bin/env python3
"""Verify the CI distributable and its default authentication release gate."""
import json
from pathlib import Path, PurePosixPath
import stat
import zipfile

ROOT = Path(__file__).resolve().parents[1]
version = json.loads((ROOT / "package.json").read_text())["version"]
archive = ROOT / "artifacts" / f"sprites-launch-extension-{version}.zip"
dist = ROOT / "dist"

with zipfile.ZipFile(archive) as package:
    assert package.testzip() is None, "ZIP integrity check failed"
    files = [item for item in package.infolist() if not item.is_dir()]
    names = [item.filename for item in files]
    assert len(names) == len(set(names)), "ZIP contains duplicate files"
    for item in files:
        path = PurePosixPath(item.filename)
        assert not path.is_absolute() and ".." not in path.parts and "\\" not in item.filename and ":" not in item.filename, "Unsafe ZIP path"
        assert not stat.S_ISLNK(item.external_attr >> 16), "ZIP contains a symbolic link"
    expected = {path.relative_to(dist).as_posix() for path in dist.rglob("*") if path.is_file()}
    assert set(names) == expected, "ZIP does not match dist/"
    for name in names:
        assert package.read(name) == (dist / name).read_bytes(), "ZIP content differs from dist/"
    for name in ("manifest.json", "index.html", "background.js", "content.js", "release-status.json"):
        assert name in names, "Missing required extension file: " + name
    manifest = json.loads(package.read("manifest.json"))
    release = json.loads(package.read("release-status.json"))
    assert manifest["manifest_version"] == 3, "Manifest V3 required"
    assert manifest["version"] == release["version"] == version, "Version mismatch"
    assert release["previewAuthVerified"] is False, "Preview credential injection must stay disabled in CI packages"
    references = [manifest["background"]["service_worker"]]
    references += list(manifest["icons"].values())
    references += list(manifest["action"]["default_icon"].values())
    references += manifest["content_scripts"][0]["js"]
    references += [manifest["side_panel"]["default_path"].split("?", 1)[0]]
    assert all(name in names for name in references), "Manifest references a missing file"

print(f"Verified {archive.name}: complete Manifest V3 package; preview injection disabled.")
