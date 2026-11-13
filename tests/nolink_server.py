# Runs app/server.py with hard links refused, as Android's SELinux policy refuses them to every app
# (neverallow all_untrusted_apps file_type:file link). For tests: REAL_SERVER_PY names the server to run.
import errno, os, runpy, sys


def _refused(*a, **k):
    raise PermissionError(errno.EACCES, "Permission denied (hard links are refused to apps on Android)")


os.link = _refused
real = os.environ["REAL_SERVER_PY"]
sys.argv[0] = real
sys.path.insert(0, os.path.dirname(real))
runpy.run_path(real, run_name="__main__")
