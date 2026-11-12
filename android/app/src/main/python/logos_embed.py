"""Starts the web app's own server.py inside the Android app (Chaquopy), unchanged.

server.py is the repository's app/server.py, shipped as assets and copied to the app's files by the
Kotlin side. It is run exactly as `python3 server.py` would run it, with its settings in the
environment, in a background thread of this process; it listens on 127.0.0.1 only.
"""
import json
import os
import runpy
import threading
import traceback

_started = False


def start(app_dir, env_json):
    """Runs <app_dir>/server.py as __main__ in a daemon thread, once per process."""
    global _started
    if _started:
        return False
    _started = True
    for key, value in json.loads(env_json).items():
        os.environ[str(key)] = str(value)
    path = os.path.join(app_dir, "server.py")

    def run():
        try:
            runpy.run_path(path, run_name="__main__")
        except BaseException:
            crash = os.path.join(os.environ.get("APP_DATA", app_dir), "server-crash.log")
            with open(crash, "a") as f:
                traceback.print_exc(file=f)
            traceback.print_exc()

    threading.Thread(target=run, name="wallet-server", daemon=True).start()
    return True
