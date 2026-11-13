"""Runs the web app's own server.py inside the Android app (Chaquopy), unchanged.

server.py is the repository's app/server.py, shipped as assets and copied to the app's files by the
Kotlin side. Its settings come from the environment (APP_EMBEDDED=android among them), set before it
is imported; then its main() serves in a background thread of this process, on 127.0.0.1 only. The
module stays loaded, so the app can call native_unlock() in the same process after the phone's
fingerprint check.
"""
import json
import os
import sys
import threading
import traceback

_server = None


def _crash(app_dir):
    crash = os.path.join(os.environ.get("APP_DATA", app_dir), "server-crash.log")
    with open(crash, "a") as f:
        traceback.print_exc(file=f)
    traceback.print_exc()


def start(app_dir, env_json):
    """Imports <app_dir>/server.py with the given environment and runs its main() in a daemon thread, once."""
    global _server
    if _server is not None:
        return False
    for key, value in json.loads(env_json).items():
        os.environ[str(key)] = str(value)
    if app_dir not in sys.path:
        sys.path.insert(0, app_dir)
    try:
        import server
    except BaseException:
        _crash(app_dir)
        raise
    _server = server

    def run():
        try:
            server.main()
        except BaseException:
            _crash(app_dir)

    threading.Thread(target=run, name="wallet-server", daemon=True).start()
    return True


def set_env(name, value):
    """Sets (or, with value None, removes) one environment variable of this process, e.g. WAKU_API
    while the messaging node runs. The web app reads it from os.environ."""
    if value is None:
        os.environ.pop(str(name), None)
    else:
        os.environ[str(name)] = str(value)


def set_waku_api(url):
    """Where the messaging node's REST API is now (a loopback URL), or None while it is off. Uses the web
    app's set_waku_api() (0.8.0 and later), else the WAKU_API environment variable. True if it was taken."""
    if _server is not None and hasattr(_server, "set_waku_api"):
        return bool(_server.set_waku_api(url))
    set_env("WAKU_API", url)
    return True


def serving():
    """True only while this process's server.py holds its port and serves it (web app 0.9.16), so the app never
    takes another program answering on that port for its own wallet. Older web apps: whether it was started."""
    if _server is None:
        return False
    flag = getattr(_server, "SERVING", None)
    return flag.is_set() if flag is not None else True


def native_unlock():
    """server.native_unlock(): a session token after the phone's fingerprint check, or None."""
    return _server.native_unlock() if _server is not None else None


def native_fingerprint_reset():
    """The phone's enrolled fingerprints changed: server.native_fingerprint_reset() (web app 0.7.7) turns
    fingerprint unlock off and locks the wallet, so only the PIN can turn it on again."""
    return bool(_server.native_fingerprint_reset()) if _server is not None else False
