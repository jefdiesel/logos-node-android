# Runs app/server.py the way Android constrains the app's own Python, for tests: hard links are refused
# (Android's SELinux policy: neverallow all_untrusted_apps file_type:file link). REAL_SERVER_PY names the
# server to run. tests/chat_world.mjs starts every test app through this.
#
# Test hook: while <APP_DATA>/FAILKEY exists, writing the messaging key file fails as on a full disk (ENOSPC).
import errno, os, runpy, sys


def _refused(*a, **k):
    raise PermissionError(errno.EACCES, "Permission denied (hard links are refused to apps on Android)")


os.link = _refused
_replace = os.replace


def _replace_or_full(a, b, *k, **kw):
    data = os.environ.get("APP_DATA", "")
    if data and str(b).endswith("wallet-msgkey.json") and os.path.exists(os.path.join(data, "FAILKEY")):
        raise OSError(errno.ENOSPC, "No space left on device")
    return _replace(a, b, *k, **kw)


os.replace = _replace_or_full
real = os.environ["REAL_SERVER_PY"]
sys.argv[0] = real
sys.path.insert(0, os.path.dirname(real))
runpy.run_path(real, run_name="__main__")
