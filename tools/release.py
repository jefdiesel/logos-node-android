#!/usr/bin/env python3
"""Keeps app/release.json, the list phones update from, in step with the app files.

  python3 tools/release.py bump 0.8.0     set APP_VERSION in app/server.py and rewrite app/release.json
  python3 tools/release.py write          rewrite app/release.json for the files as they are now
  python3 tools/release.py check          (CI) release.json matches the files, the version and both installers

--dir DIR works on another copy of the app folder (the update tests use it).
A phone updates only when the version goes up, so bump the version for every change meant to reach phones.
"""
import argparse, hashlib, json, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RELEASE_URL = "https://raw.githubusercontent.com/jefdiesel/logos-node-android/release/app/"
VERSION_LINE = re.compile(r'^APP_VERSION = "([0-9.]+)"', re.M)


def app_files(app_dir):
    """Every file that belongs to a release, relative to the app folder, sorted."""
    out = []
    for top, dirs, files in os.walk(app_dir):
        dirs[:] = sorted(d for d in dirs if not d.startswith((".", "__pycache__")))
        for f in files:
            rel = os.path.relpath(os.path.join(top, f), app_dir).replace(os.sep, "/")
            if f.startswith((".", "wallet-")) or f.endswith((".pyc", ".prev", ".tmp")) or rel == "release.json":
                continue
            out.append(rel)
    return sorted(out)


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def version_of(app_dir):
    with open(os.path.join(app_dir, "server.py")) as f:
        m = VERSION_LINE.search(f.read())
    if not m:
        sys.exit("no APP_VERSION line in server.py")
    return m.group(1)


def release_for(app_dir):
    return {"version": version_of(app_dir), "files": {f: sha256(os.path.join(app_dir, f)) for f in app_files(app_dir)}}


def write(app_dir):
    rel = release_for(app_dir)
    with open(os.path.join(app_dir, "release.json"), "w") as f:
        json.dump(rel, f, indent=1, sort_keys=True)
        f.write("\n")
    return rel


def installer_files(path):
    with open(path) as f:
        m = re.search(r'^APP_FILES="([^"]*)"', f.read(), re.M)
    return sorted(m.group(1).split()) if m else None


def check(app_dir):
    problems = []
    try:
        with open(os.path.join(app_dir, "release.json")) as f:
            have = json.load(f)
    except Exception as e:
        sys.exit("can't read release.json: %s" % e)
    want = release_for(app_dir)
    if have.get("version") != want["version"]:
        problems.append("release.json says version %s, server.py says %s" % (have.get("version"), want["version"]))
    for f in sorted(set(want["files"]) | set(have.get("files", {}))):
        if have.get("files", {}).get(f) != want["files"].get(f):
            problems.append("%s: %s" % (f, "not in release.json" if f not in have.get("files", {}) else
                                        "listed but missing" if f not in want["files"] else "hash differs"))
    # devices only ever get app files from the `release` branch, which CI moves after a green run
    with open(os.path.join(app_dir, "server.py")) as f:
        if 'os.environ.get("UPDATE_URL", "%s")' % RELEASE_URL not in f.read():
            problems.append("server.py's default update source isn't %s" % RELEASE_URL)
    for inst in ("install.sh", "install-termux.sh"):
        with open(os.path.join(ROOT, inst)) as f:
            text = f.read()
        if RELEASE_URL + "$f" not in text or "/main/app/" in text:
            problems.append("%s doesn't download the app from %s" % (inst, RELEASE_URL))
        listed = installer_files(os.path.join(ROOT, inst))
        if listed != sorted(list(want["files"]) + ["release.json"]):
            problems.append("%s installs %s, the release has %s" % (inst, listed, sorted(list(want["files"]) + ["release.json"])))
    for p in problems:
        print("release.json is out of date: " + p)
    if problems:
        sys.exit("run: python3 tools/release.py write   (or bump <version>)")
    print("release.json matches version %s and %d files" % (want["version"], len(want["files"])))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("action", choices=["bump", "write", "check"])
    ap.add_argument("version", nargs="?")
    ap.add_argument("--dir", default=os.path.join(ROOT, "app"))
    a = ap.parse_args()
    if a.action == "bump":
        if not a.version or not re.match(r"^\d+(\.\d+){0,3}$", a.version):
            sys.exit("bump needs a version like 0.8.0")
        path = os.path.join(a.dir, "server.py")
        with open(path) as f:
            text = f.read()
        with open(path, "w") as f:
            f.write(VERSION_LINE.sub('APP_VERSION = "%s"' % a.version, text, count=1))
    if a.action in ("bump", "write"):
        rel = write(a.dir)
        print("release.json: version %s, %d files" % (rel["version"], len(rel["files"])))
    else:
        check(a.dir)


if __name__ == "__main__":
    main()
