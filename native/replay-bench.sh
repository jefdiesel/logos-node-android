#!/usr/bin/env bash
# Measures the startup replay of stored blocks on Linux arm64 (GitHub Actions runner):
# syncs a fresh testnet node for SYNC_MIN minutes, then restarts identical copies of its
# database with the unpatched node, the patched node doing a full replay (marker removed)
# and the patched node doing a fast replay (marker kept), and reports the replay times,
# the replay result lines and the peak memory of each.
#
# usage: replay-bench.sh <patched node> <unpatched node> <output dir>
set -euo pipefail
PATCHED=$(realpath "$1"); UPSTREAM=$(realpath "$2"); OUT=$(mkdir -p "$3" && realpath "$3")
SYNC_MIN=${SYNC_MIN:-10}
RUN_TIMEOUT_MIN=${RUN_TIMEOUT_MIN:-45}
API_PORT=18480
W=${BENCH_DIR:-$PWD/bench}; rm -rf "$W"; mkdir -p "$W/sync"; cd "$W/sync"

"$PATCHED" init-config -o user_config.yaml >/dev/null

config() { # <state dir> <log dir>
  cat <<Y
network:
  backend:
    initial_peers:
    - /ip4/65.109.51.37/udp/3000/quic-v1/p2p/12D3KooWFrouXfmrR4nsLMtE7wu15DoMJ6VtoUtHinREZCvbWHar
    - /ip4/65.109.51.37/udp/3001/quic-v1/p2p/12D3KooWJRGau8M1rjT7R5e4YYsgdFhsMX35nRDtMwCDjxQkXAHz
    - /ip4/65.109.51.37/udp/3002/quic-v1/p2p/12D3KooWQXJavMDTRscjauFSgVAB1VLB6Rzpy2uY5SU9Tk7927tb
    - /ip4/65.109.51.37/udp/50001/quic-v1/p2p/12D3KooWSQc7CcGtvWDPF1yCbBthFnQjprfCVHmfmNDUrSmqQsU1
api:
  backend:
    listen_address: 127.0.0.1:$API_PORT
tracing:
  logger:
    file:
      directory: $2
      prefix: node
state:
  base_folder: $1
Y
}

stop() { # <pid>
  kill -INT "$1" 2>/dev/null || true
  for _ in $(seq 60); do kill -0 "$1" 2>/dev/null || return 0; sleep 1; done
  kill -KILL "$1" 2>/dev/null || true
}

# 1. sync a fresh database (the patched node; network blocks are verified as upstream)
config "$W/sync/state" "$W/sync/logs" > user_config.yaml
mkdir -p logs
"$PATCHED" user_config.yaml > "$W/sync/stdout.log" 2>&1 &
pid=$!
sleep $((SYNC_MIN * 60))
curl -fsS "http://127.0.0.1:$API_PORT/cryptarchia/info" > "$OUT/sync-info.json" || true
stop "$pid"; wait "$pid" || true
echo "synced: $(cat "$OUT/sync-info.json" 2>/dev/null)"
du -sh "$W/sync/state"; ls -la "$W/sync/state"

# 2. replay identical copies
run() { # <name> <binary> <copy setup command> [env...]
  local name=$1 bin=$2 setup=$3; shift 3
  local d="$W/$name"
  rm -rf "$d"; mkdir -p "$d/logs"; cp -a "$W/sync/state" "$d/state"
  (cd "$d/state" && eval "$setup")
  ls -la "$d/state" > "$OUT/$name-state.txt"
  config "$d/state" "$d/logs" > "$d/user_config.yaml"
  cp "$W/sync/keystore.yaml" "$d/" 2>/dev/null || true
  sync; echo 3 | sudo tee /proc/sys/vm/drop_caches >/dev/null
  local t0; t0=$(date +%s.%N)
  (cd "$d" && env "$@" /usr/bin/time -v "$bin" user_config.yaml > "$d/stdout.log" 2> "$d/time.log") &
  local tpid=$! npid=""
  for _ in $(seq $((RUN_TIMEOUT_MIN * 60))); do
    [ -n "$npid" ] || npid=$(pgrep -f "^$bin user_config.yaml" | head -1 || true)
    if cat "$d"/logs/* "$d/stdout.log" 2>/dev/null | grep -q "Chain recovery finished"; then break; fi
    kill -0 "$tpid" 2>/dev/null || break
    sleep 1
  done
  local t1; t1=$(date +%s.%N)
  sleep 3   # let the summary lines reach the log
  [ -n "$npid" ] && stop "$npid"
  wait "$tpid" || true
  {
    echo "== $name ($(basename "$bin") $*)"
    echo "process start to 'Chain recovery finished' seen: $(python3 -c "print(round($t1 - $t0, 1))") s"
    grep -h -E "patched node|replay mode chosen|recovering Cryptarchia|loading stored blocks|stored blocks to replay|blocks replayed|replay timing|replay result|replay marker|failed to replay|panicked" "$d"/logs/* "$d/stdout.log" 2>/dev/null | cut -c1-600 || true
    grep -E "Maximum resident set size|Elapsed \(wall" "$d/time.log" || true
    echo
  } | tee -a "$OUT/summary.txt"
  ls -la "$d/state" > "$OUT/$name-state-after.txt"
}

run upstream "$UPSTREAM" "true"
run patched-full "$PATCHED" "rm -f db.replay-verified"
run patched-fast "$PATCHED" "true"
run patched-forced-full "$PATCHED" "true" LOGOS_REPLAY_VERIFY=full
echo "done"
