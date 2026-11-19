#!/usr/bin/env bash
# The LEZ 0.4 `names` for Android arm64, run on an Android emulator against a throwaway LEZ
# v0.4.0-rc3 chain (standalone sequencer on this machine, fresh genesis, nothing real).
# CI only: .github/workflows/names04-build.yml, job `emulator-e2e`.
#
# What it shows, with the phone's own binary (no r0vm anywhere, as on the phone):
#   1. `names prover-status` says bare: the build can't run programs, so it sends public calls
#      unchecked with their fixed caps (cli/src/prover.rs in logos-names).
#   2. A public registration from the device: commit, the registry's 15-minute wait, reveal.
#      Both are registry program calls, signed on the device and applied on chain.
#   3. A public profile change (set-account) and a hand-over of the name (transfer).
#   4. A plain public native transfer from the device's account, balance checked on the host.
#   5. With the local-prove build too (if it was built): its prover-status, and the hand-over
#      run through its in-process executor first.
#
# The funded account is LEZ's published local-test genesis key (as in logos-names'
# scripts/wallet-e2e.sh): it exists only on a fresh local chain.
#
# Inputs (environment): SEQ_BIN, SEQ_CONFIG, HOST_NAMES (x86_64 names from the same source),
# NAMES_ELF (registry guest), SHORTLIST (shortlist.bin), DEV_NAMES (the Android binary),
# DEV_NAMES_LP (optional, the local-prove Android binary), WORK (new empty dir).
set -euo pipefail
for v in SEQ_BIN SEQ_CONFIG HOST_NAMES NAMES_ELF SHORTLIST DEV_NAMES WORK; do
  [ -n "${!v:-}" ] || { echo "set $v" >&2; exit 2; }
done
RPC_PORT=${RPC_PORT:-3230}
METRICS_PORT=${METRICS_PORT:-9230}
RPC=http://127.0.0.1:$RPC_PORT
LOCAL_TEST_KEY=10a26a9aec7d34b82364eeae45c5294dbb0a764b000b94eeb9b58511dc487c4d
SEGMENT=$((96 * 1024))
NAME=droidci
DEV=/data/local/tmp/n04

rpc() { curl -sf -m 10 -X POST "$RPC" -H 'Content-Type: application/json' \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":${2:-[]}}"; }
say() { echo; echo "## $(date -u +%H:%M:%S) $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
id_of() { grep -oE "$1/[1-9A-HJ-NP-Za-km-z]{32,44}" | head -1 | cut -d/ -f2; }
quiet() { grep -vE '^(Stored|Transaction data)' | cut -c1-220; }

mkdir -p "$WORK"; WORK=$(cd "$WORK" && pwd)
exec > >(tee -a "$WORK/e2e.log") 2>&1
SEQ_PID=
cleanup() { [ -n "$SEQ_PID" ] && kill "$SEQ_PID" 2>/dev/null || true; }
trap cleanup EXIT

say "no r0vm on this machine or the device"
! command -v r0vm || fail "an r0vm is on PATH"
[ ! -e "$HOME/.risc0" ] || fail "~/.risc0 exists"

say "fresh standalone sequencer on $RPC"
"$SEQ_BIN" setup "$WORK/seq" --config "$SEQ_CONFIG" \
  --funding-public-key 0101010101010101010101010101010101010101010101010101010101010100 --create-channel \
  > "$WORK/seq-setup.log" 2>&1 || { cat "$WORK/seq-setup.log"; fail "sequencer setup"; }
RUST_LOG=warn "$SEQ_BIN" start "$WORK/seq" --rpc-listen-address "127.0.0.1:$RPC_PORT" \
  --metrics-listen-address "127.0.0.1:$METRICS_PORT" >> "$WORK/sequencer.log" 2>&1 < /dev/null &
SEQ_PID=$!
for _ in $(seq 1 60); do rpc getLastBlockId >/dev/null 2>&1 && break; sleep 2; done
rpc getLastBlockId >/dev/null || { tail -40 "$WORK/sequencer.log"; fail "the sequencer did not answer"; }

export LEE_WALLET_PASSWORD=
export LOGOS_NAMES_RPC=$RPC
export NAMES_SHORTLIST=$SHORTLIST
wallet_config() {
  cat <<EOF
{
  "gas_limit": 2000000,
  "fee_headroom_blocks": 5,
  "seq_block_poll_max_amount": 100,
  "seq_poll_max_retries": 5,
  "seq_poll_timeout": "12s",
  "seq_tx_poll_max_blocks": 5,
  "sequencer": { "sequencer_addr": "$RPC/" }
}
EOF
}
MAIN=$WORK/wallet
mkdir -p "$MAIN"; wallet_config > "$MAIN/wallet_config.json"
H() { LEE_WALLET_HOME_DIR=$MAIN "$HOST_NAMES" "$@"; }
H wallet check-health > /dev/null
balance() { H wallet account get --account-id "Public/$1" | sed -nE 's/^Balance ([0-9]+).*/\1/p'; }
F=$(H wallet account import public --private-key "$LOCAL_TEST_KEY" | id_of Public)
[ -n "$F" ] || fail "import of the local-test key"
F_PK=$(H wallet account get --account-id "Public/$F" --keys | sed -n 's/^pk //p')
echo "F=$F holds $(balance "$F")"

say "deploy and configure the registry (from the host)"
size=$(wc -c < "$NAMES_ELF" | tr -d ' '); count=$(( (size + SEGMENT - 1) / SEGMENT ))
REG=$(H wallet account new public | id_of Public); segs=()
for _ in $(seq 1 "$count"); do segs+=("Public/$(H wallet account new public | id_of Public)"); done
H wallet program-loader deploy --elf "$NAMES_ELF" --header "Public/$REG" --segments "${segs[@]}" --payer "Public/$F" | quiet
export LOGOS_NAMES_PROGRAM=$REG
for _ in $(seq 1 30); do H settings >/dev/null 2>&1 && break; sleep 5; done
H wallet auth-transfer send --from "Public/$F" --to "Public/$REG" --amount 10000000 | quiet
H configure --admin "$F" --treasury "$F" --mode deposit --deposits 1000000,3000000 | quiet
H settings | grep -q "$F" || fail "the registry is not configured"
echo "registry $REG"

say "the device: Android $(adb shell getprop ro.build.version.release) API $(adb shell getprop ro.build.version.sdk), $(adb shell getprop ro.product.cpu.abilist)"
adb reverse "tcp:$RPC_PORT" "tcp:$RPC_PORT"
adb shell "rm -rf $DEV && mkdir -p $DEV/home $DEV/wallet"
adb push "$DEV_NAMES" "$DEV/names" > /dev/null
adb push "$SHORTLIST" "$DEV/shortlist.bin" > /dev/null
wallet_config > "$WORK/dev_wallet_config.json"
adb push "$WORK/dev_wallet_config.json" "$DEV/wallet/wallet_config.json" > /dev/null
adb shell "chmod 755 $DEV/names"
if [ -n "${DEV_NAMES_LP:-}" ]; then adb push "$DEV_NAMES_LP" "$DEV/names-lp" > /dev/null; adb shell "chmod 755 $DEV/names-lp"; fi
adb shell "ls /system/bin/linker64 /proc/sys/fs/binfmt_misc 2>&1 | head -20" || true
# One device command, exit status kept. The app's own environment carries no RISC0_* variable.
D() { adb shell "cd $DEV && HOME=$DEV/home TMPDIR=$DEV/home LEE_WALLET_HOME_DIR=$DEV/wallet LEE_WALLET_PASSWORD= LOGOS_NAMES_RPC=$RPC LOGOS_NAMES_PROGRAM=$REG NAMES_SHORTLIST=$DEV/shortlist.bin ${DEV_ENV:-} $*"; }

say "1. prover-status on the device"
D ./names --version
D ./names prover-status | tee "$WORK/prover-status.json"
python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); assert s["bare"] is True and s["run"] is False and s["prove"] is False, s; print("bare build:", s)' "$WORK/prover-status.json"

say "the device makes its account; the host funds it"
D ./names wallet check-health > /dev/null
A=$(D ./names wallet account new public | id_of Public)
[ -n "$A" ] || fail "no account on the device"
A_PK=$(D ./names wallet account get --account-id "Public/$A" --keys | sed -n 's/^pk //p' | tr -d '\r')
[ -n "$A_PK" ] || fail "no public key for the device's account"
H wallet auth-transfer send --from "Public/$F" --to-pk "$A_PK" --amount 50000000 | quiet
[ "$(balance "$A")" = 50000000 ] || fail "the device's account was not funded"
echo "device account $A holds 50000000"

say "2. the device registers $NAME publicly (commit, 15 minutes, reveal), unchecked"
D "nohup ./names register $NAME --owner Public/$A --wait > $DEV/register.log 2>&1; echo exit=\$? >> $DEV/register.log" &
REG_SHELL=$!
for i in $(seq 1 150); do
  sleep 10
  if D "grep -q '^exit=' $DEV/register.log" 2>/dev/null; then break; fi
  [ $((i % 12)) -eq 0 ] && echo "  waiting ($((i * 10))s): $(D "tail -1 $DEV/register.log" | cut -c1-160)"
done
wait "$REG_SHELL" 2>/dev/null || true
D "cat $DEV/register.log" | quiet | tee "$WORK/register.log"
grep -q '^exit=0' "$WORK/register.log" || fail "the device's registration failed"
grep -q "can't check the call first" "$WORK/register.log" || fail "the registration was not sent unchecked"
[ "$(grep -c '^applied in block' "$WORK/register.log")" -ge 2 ] || fail "commit and reveal did not both apply"
# held_by is filled in only by the wallet that holds the name (resolve matches the owner tag against its own accounts), so ask the device
D ./names resolve "$NAME" | quiet | tee "$WORK/resolve-1.json" | grep -q "\"held_by\": \"$A\"" || fail "$NAME is not held by the device's account"

say "3. the device: set-account, then hands the name to F"
D ./names set-account "$NAME" "Public/$A" | quiet | tee "$WORK/set-account.log"
grep -q '^applied in block' "$WORK/set-account.log" || fail "set-account did not apply"
if [ -n "${DEV_NAMES_LP:-}" ]; then
  say "5. the local-prove build: prover-status, then the hand-over checked by its in-process executor"
  DEV_ENV="RISC0_PROVER=ipc" D ./names-lp prover-status | tee "$WORK/prover-status-lp.json"
  python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); assert s["run"] is True and s["bare"] is False and s["prove"] is False, s; print("local-prove build, proofs refused:", s)' "$WORK/prover-status-lp.json"
  DEV_ENV="RISC0_PROVER=ipc" D ./names-lp transfer "$NAME" "Public/$F" | quiet | tee "$WORK/transfer.log"
  grep -q "can't check" "$WORK/transfer.log" && fail "the local-prove build sent unchecked"
else
  D ./names transfer "$NAME" "Public/$F" | quiet | tee "$WORK/transfer.log"
fi
grep -q '^applied in block' "$WORK/transfer.log" || fail "the transfer did not apply"
H resolve "$NAME" | grep -q "\"held_by\": \"$F\"" || fail "F does not hold $NAME after the device's transfer"

say "4. a public native transfer from the device to F"
A0=$(balance "$A"); F0=$(balance "$F")
D ./names wallet auth-transfer send --from "Public/$A" --to-pk "$F_PK" --amount 123456 | quiet
A1=$(balance "$A"); F1=$(balance "$F")
echo "device account $A0 -> $A1; F $F0 -> $F1"
[ "$F1" -eq $((F0 + 123456)) ] || fail "F was not credited 123456"
[ "$A1" -le $((A0 - 123456)) ] || fail "the device's account was not debited"

say "PASS: the Android build signed and sent every public call above, and each applied"
