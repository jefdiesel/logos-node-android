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


def native_unlock():
    """server.native_unlock(): a session token after the phone's fingerprint check, or None."""
    return _server.native_unlock() if _server is not None else None


def native_fingerprint_reset():
    """The phone's enrolled fingerprints changed: turn fingerprint unlock off, so only the PIN can turn it on
    again. Uses server.native_fingerprint_reset() if the web app has it; otherwise does the same as the page's
    "turn off" (the setting, saved, and an event line)."""
    s = _server
    if s is None:
        return False
    if hasattr(s, "native_fingerprint_reset"):
        return bool(s.native_fingerprint_reset())
    s.wallet_settings["native_fingerprint"] = False
    s.settings_save()
    s.event("fingerprint unlock turned off", reason="fingerprints changed on the phone", source="android")
    return True
