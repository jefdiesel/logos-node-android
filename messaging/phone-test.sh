#!/usr/bin/env bash
# Runs the built node on a phone over adb, as the shell user, for a few minutes, and
# samples its memory. Run on the computer the phone is attached to.
#
# usage: phone-test.sh <artifact dir> [seconds] [config.json]
# env:   ADB (default adb), SERIAL (adb serial), DIR (default /data/local/tmp/waku-native),
#        TOPIC (a content topic of your own; the runner publishes a test message to it once a
#        minute; empty = no publishing)
set -euo pipefail
ART=$1; SECS=${2:-240}; CONF=${3:-$ART/logos-test.json}
ADB=${ADB:-adb}; DIR=${DIR:-/data/local/tmp/waku-native}
TOPIC=${TOPIC-/logos-node-android/1/waku-runner-test/proto}
A=("$ADB"); [ -n "${SERIAL:-}" ] && A+=(-s "$SERIAL")
sh_() { "${A[@]}" shell "$@"; }

sh_ "mkdir -p $DIR/data"
"${A[@]}" push "$ART/waku-runner" "$ART/liblogosdelivery.so" "$ART/librln.so" "$DIR/" >/dev/null
"${A[@]}" push "$CONF" "$DIR/config.json" >/dev/null
sh_ "chmod 755 $DIR/waku-runner"
sh_ "LD_LIBRARY_PATH=$DIR $DIR/waku-runner --version"
sh_ "grep MemAvailable /proc/meminfo"

ARGS="config.json --duration $SECS --status-every 30"
[ -n "$TOPIC" ] && ARGS="$ARGS --topic $TOPIC --send-every 60"
# started detached on the phone; output goes to run.log next to it
sh_ "cd $DIR && (LD_LIBRARY_PATH=$DIR nohup ./waku-runner $ARGS > run.log 2>&1 &) ; sleep 1; pidof waku-runner"

END=$(( $(date +%s) + SECS + 60 ))
while [ "$(date +%s)" -lt "$END" ]; do
  PID=$(sh_ "pidof waku-runner" | tr -d '\r' || true)
  [ -z "$PID" ] && break
  echo "$(date -u +%H:%M:%S) pid $PID $(sh_ "grep -E 'VmRSS|VmHWM|Threads' /proc/$PID/status" | tr -s ' \r\n' ' ')"
  sleep 30
done
PID=$(sh_ "pidof waku-runner" | tr -d '\r' || true)
if [ -n "$PID" ]; then echo "still running, sending SIGTERM"; sh_ "kill $PID"; sleep 20; fi
sh_ "pidof waku-runner" || echo "waku-runner is not running"
"${A[@]}" pull "$DIR/run.log" "./run-$(date +%Y%m%d-%H%M%S).log"
