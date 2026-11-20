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
#   6. The desktop's recovery phrase on the device, as the app restores it (`names module restore`
#      reading the phrase on standard input, the desktop's own restore): the same first public
#      account and public key as the desktop wallet `names setup` made; the phrase is never printed
#      back. Then the restored account sends to an account by its id and pays a name (`pay --public`).
#   7. NFTs (when the reference NFT program was built, NFT_ELF): the device makes its account ready
#      for a collection (InitializeHolding: Receive), takes the master from the host, and sends it on
#      to another ready account, all unchecked with the fixed NFT cap.
#   Every JSON-RPC method the device calls goes through a logging proxy here: the list is what the
#   app's forwarder must pass (methods.txt in the logs).
#
# The funded account is LEZ's published local-test genesis key (as in logos-names'
# scripts/wallet-e2e.sh): it exists only on a fresh local chain.
#
# Inputs (environment): SEQ_BIN, SEQ_CONFIG, HOST_NAMES (x86_64 names from the same source),
# NAMES_ELF (registry guest), SHORTLIST (shortlist.bin), DEV_NAMES (the Android binary),
# DEV_NAMES_LP (optional, the local-prove Android binary), NFT_ELF (optional, the NFT program's guest),
# WORK (new empty dir).
set -euo pipefail
for v in SEQ_BIN SEQ_CONFIG HOST_NAMES NAMES_ELF SHORTLIST DEV_NAMES WORK; do
  [ -n "${!v:-}" ] || { echo "set $v" >&2; exit 2; }
done
RPC_PORT=${RPC_PORT:-3230}
METRICS_PORT=${METRICS_PORT:-9230}
RPC=http://127.0.0.1:$RPC_PORT
DEV_RPC_PORT=$((RPC_PORT + 1))                       # the device's calls go through a logging proxy
DEV_RPC=http://127.0.0.1:$DEV_RPC_PORT
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
SEQ_PID=; PROXY_PID=
cleanup() { [ -n "$SEQ_PID" ] && kill "$SEQ_PID" 2>/dev/null || true; [ -n "$PROXY_PID" ] && kill "$PROXY_PID" 2>/dev/null || true; rm -f "$WORK/phrase.txt"; }
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

# Deploys an ELF at a new header account: the loader says how many segments it splits into (not always size / 96 KiB:
# logos-names CI 44617200987), so as many are made as the size asks, plus one, and the count it names is used.
deploy_elf() {
  local elf=$1 size count n out; size=$(wc -c < "$elf" | tr -d ' '); count=$(( (size + SEGMENT - 1) / SEGMENT + 1 ))
  DEPLOYED=$(H wallet account new public | id_of Public); local segs=()
  for _ in $(seq 1 "$count"); do segs+=("Public/$(H wallet account new public | id_of Public)"); done
  out=$(H wallet program-loader deploy --elf "$elf" --header "Public/$DEPLOYED" --segments "${segs[@]}" --payer "Public/$F" 2>&1) || true
  n=$(echo "$out" | grep -oE 'splits into [0-9]+ segment' | grep -oE '[0-9]+' | head -1)
  if [ -n "$n" ]; then
    echo "the loader splits $(basename "$elf") into $n segments"
    H wallet program-loader deploy --elf "$elf" --header "Public/$DEPLOYED" --segments "${segs[@]:0:$n}" --payer "Public/$F" | quiet
  else
    echo "$out" | quiet
  fi
}

say "deploy and configure the registry (from the host)"
deploy_elf "$NAMES_ELF"; REG=$DEPLOYED
export LOGOS_NAMES_PROGRAM=$REG
for _ in $(seq 1 30); do H settings >/dev/null 2>&1 && break; sleep 5; done
H wallet auth-transfer send --from "Public/$F" --to "Public/$REG" --amount 10000000 | quiet
H configure --admin "$F" --treasury "$F" --mode deposit --deposits 1000000,3000000 | quiet
H settings | grep -q "$F" || fail "the registry is not configured"
echo "registry $REG"

# The app's forwarder passes only signer04.RPC_METHODS, at most 20 calls in a batch: this proxy does the same, so a
# method the tool needs and the app would refuse fails this run.
ALLOWED=$(cd "$(dirname "$0")/.." && python3 -c 'import sys; sys.path.insert(0, "app"); import signer04; print(",".join(sorted(signer04.RPC_METHODS)))')
[ -n "$ALLOWED" ] || fail "can't read the app's forwarder allowlist"
say "a proxy for the device's calls on $DEV_RPC: the app's forwarder allowlist ($ALLOWED), every method logged"
python3 - "$DEV_RPC_PORT" "$RPC" "$WORK/methods.log" "$ALLOWED" <<'PY' &
import http.server, json, sys, urllib.request
port, up, log, allowed = int(sys.argv[1]), sys.argv[2], sys.argv[3], set(sys.argv[4].split(","))
class P(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            body = json.loads(raw)
            calls = body if isinstance(body, list) else [body]
            with open(log, "a") as f:
                for c in calls:
                    f.write(str(c.get("method")) + ("" if c.get("method") in allowed else " REFUSED") + "\n")
            if len(calls) > 20 or not all(c.get("method") in allowed for c in calls):
                out = json.dumps({"error": "That method isn't forwarded."}).encode()
                self.send_response(403); self.send_header("Content-Length", str(len(out))); self.end_headers(); self.wfile.write(out)
                return
        except Exception:
            pass
        req = urllib.request.Request(up, data=raw, headers={"Content-Type": "application/json"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                code, out = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, out = e.code, e.read()
        self.send_response(code); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(out)))
        self.end_headers(); self.wfile.write(out)
    def log_message(self, *a):
        pass
http.server.ThreadingHTTPServer(("127.0.0.1", port), P).serve_forever()
PY
PROXY_PID=$!
for _ in $(seq 1 20); do curl -sf -m 5 -X POST "$DEV_RPC" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"getLastBlockId","params":[]}' >/dev/null && break; sleep 1; done
: > "$WORK/methods.log"

say "the device: Android $(adb shell getprop ro.build.version.release) API $(adb shell getprop ro.build.version.sdk), $(adb shell getprop ro.product.cpu.abilist)"
adb reverse "tcp:$DEV_RPC_PORT" "tcp:$DEV_RPC_PORT"
adb shell "rm -rf $DEV && mkdir -p $DEV/home $DEV/wallet"
adb push "$DEV_NAMES" "$DEV/names" > /dev/null
adb push "$SHORTLIST" "$DEV/shortlist.bin" > /dev/null
RPC=$DEV_RPC wallet_config > "$WORK/dev_wallet_config.json"
adb push "$WORK/dev_wallet_config.json" "$DEV/wallet/wallet_config.json" > /dev/null
adb shell "chmod 755 $DEV/names"
if [ -n "${DEV_NAMES_LP:-}" ]; then adb push "$DEV_NAMES_LP" "$DEV/names-lp" > /dev/null; adb shell "chmod 755 $DEV/names-lp"; fi
adb shell "ls /system/bin/linker64 /proc/sys/fs/binfmt_misc 2>&1 | head -20" || true
# One device command, exit status kept. The app's own environment carries no RISC0_* variable.
D() { adb shell "cd $DEV && HOME=$DEV/home TMPDIR=$DEV/home LEE_WALLET_HOME_DIR=${DEV_WALLET:-$DEV/wallet} LEE_WALLET_PASSWORD= LOGOS_NAMES_RPC=$DEV_RPC LOGOS_NAMES_PROGRAM=$REG NAMES_SHORTLIST=$DEV/shortlist.bin ${DEV_ENV:-} $*"; }

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

say "6. the desktop's recovery phrase, typed on the device: the same accounts"
DESK=$WORK/desktop; mkdir -p "$DESK"; wallet_config > "$DESK/wallet_config.json"
LEE_WALLET_HOME_DIR=$DESK "$HOST_NAMES" setup --shield=0 > "$WORK/desk-setup.out" 2>&1 || { grep -v -i phrase "$WORK/desk-setup.out" | tail -5; fail "names setup (the desktop's wallet)"; }
PHRASE=$(awk '/the only way to get the wallet back/{f=1;next} f&&NF{print;exit}' "$WORK/desk-setup.out" | tr -d '\r')
DPUB=$(sed -nE 's/^public account +Public\/([1-9A-HJ-NP-Za-km-z]{32,44}).*/\1/p' "$WORK/desk-setup.out" | head -1)
rm -f "$WORK/desk-setup.out"
nw=$(echo "$PHRASE" | wc -w | tr -d ' ')
[ "$nw" -ge 12 ] && [ "$nw" -le 24 ] && [ -n "$DPUB" ] || fail "no phrase ($nw words) or public account from names setup"
DPK=$(LEE_WALLET_HOME_DIR=$DESK "$HOST_NAMES" wallet account get --account-id "Public/$DPUB" --keys | sed -n 's/^pk //p')
echo "the desktop wallet: Public/$DPUB, a $nw-word phrase (not shown)"
( umask 077; printf '%s\n' "$PHRASE" > "$WORK/phrase.txt" )
adb push "$WORK/phrase.txt" "$DEV/phrase.txt" > /dev/null; rm -f "$WORK/phrase.txt"
adb shell "mkdir -p $DEV/w04"
adb push "$WORK/dev_wallet_config.json" "$DEV/w04/wallet_config.json" > /dev/null
DEV_WALLET=$DEV/w04 D "./names module restore < $DEV/phrase.txt; echo exit=\$?; rm -f $DEV/phrase.txt" > "$WORK/restore.out" 2>&1 || true
grep -q '^exit=0' "$WORK/restore.out" || { grep -vF "$PHRASE" "$WORK/restore.out" | tail -5; fail "names module restore on the device"; }
! grep -qF "$PHRASE" "$WORK/restore.out" || fail "the restore printed the phrase back"
first=$(python3 -c 'import json,sys
line = [l for l in open(sys.argv[1]).read().splitlines() if "{" in l and "\"public\"" in l][-1]
d = json.loads(line[line.index("{"):])      # (it may follow the prompt on its line; keys sorted: moved, private, public)
print(d["public"][0], len(d["public"]))' "$WORK/restore.out")
echo "restored on the device: $first"
[ "${first%% *}" = "$DPUB" ] || fail "the device's first public account ${first%% *} isn't the desktop's $DPUB"
DEV_WALLET=$DEV/w04 D ./names module account-list > "$WORK/account-list.json"
python3 -c 'import json,sys; rows=json.loads(open(sys.argv[1]).read().strip().splitlines()[-1]); r=[x for x in rows if x["account"].endswith(sys.argv[2])][0]; assert r["public_key"]==sys.argv[3] and r["kind"]=="public", r; print("account-list: public key matches the desktop'"'"'s")' "$WORK/account-list.json" "$DPUB" "$DPK"
H wallet auth-transfer send --from "Public/$F" --to-pk "$DPK" --amount 30000000 | quiet
[ "$(balance "$DPUB")" = 30000000 ] || fail "the restored account was not funded"
say "6b. the restored account sends to an account by its id, and pays a name publicly"
F0=$(balance "$F")
DEV_WALLET=$DEV/w04 D ./names wallet auth-transfer send --from "Public/$DPUB" --to "Public/$F" --amount 4321 | quiet
[ "$(balance "$F")" -eq $((F0 + 4321)) ] || fail "F was not credited 4321 by the restored account"
H set-account "$NAME" "Public/$F" | quiet | tee "$WORK/set-account-host.log"     # F holds the name since step 3
grep -q '^applied in block' "$WORK/set-account-host.log" || fail "the host's set-account did not apply"
F0=$(balance "$F")
DEV_WALLET=$DEV/w04 D ./names pay --public --from=Public/$DPUB $NAME 777 | quiet | tee "$WORK/pay.log"
[ "$(balance "$F")" -eq $((F0 + 777)) ] || fail "$NAME's account (F) was not paid 777"

if [ -n "${NFT_ELF:-}" ] && [ -f "$NFT_ELF" ]; then
  say "7. NFTs: the device receives (makes its account ready), takes the master, and sends it on"
  deploy_elf "$NFT_ELF"; NFTP=$DEPLOYED
  export NAMES_NFT_PROGRAM=$NFTP
  for _ in $(seq 1 30); do H nft list >/dev/null 2>&1 && break; sleep 5; done
  H nft create "CI art" 3 --payer "Public/$F" | quiet | tee "$WORK/nft-create.log"
  COL=$(sed -nE 's/^collection ([1-9A-HJ-NP-Za-km-z]{32,44}).*/\1/p' "$WORK/nft-create.log"); MASTER=$(sed -nE 's/^master ([1-9A-HJ-NP-Za-km-z]{32,44}).*/\1/p' "$WORK/nft-create.log")
  [ -n "$COL" ] && [ -n "$MASTER" ] || fail "no collection made"
  DEV_WALLET=$DEV/w04 D ./names --nft-program $NFTP nft init --definition $COL --account $DPUB | quiet | tee "$WORK/nft-init.log"
  grep -q '^applied in block' "$WORK/nft-init.log" || fail "the device's InitializeHolding did not apply"
  grep -q "can't check the NFT call first" "$WORK/nft-init.log" || fail "the NFT call was not sent unchecked"
  H nft send --from "$MASTER" --to "Public/$DPUB" --fee-payer "$F" | quiet | tee "$WORK/nft-host-send.log"
  grep -q '^applied in block' "$WORK/nft-host-send.log" || fail "the host's send of the master to the device did not apply"
  X=$(H wallet account new public | id_of Public)
  H nft init --definition "$COL" --account "$X" --fee-payer "$F" | quiet | tee "$WORK/nft-host-init.log"
  grep -q '^applied in block' "$WORK/nft-host-init.log" || fail "the host's InitializeHolding did not apply"
  DEV_WALLET=$DEV/w04 D ./names --nft-program $NFTP nft send --from $DPUB --to Public/$X | quiet | tee "$WORK/nft-send.log"
  grep -q '^applied in block' "$WORK/nft-send.log" || fail "the device's NFT send did not apply"
  H nft list --json > "$WORK/nft-host.json"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); r=[h for h in d["holdings"] if h["account"].endswith(sys.argv[2])]; assert r and r[0].get("holds") and r[0]["state"]=="master", d; print("the host account holds the master the device sent")' "$WORK/nft-host.json" "$X"
else
  say "7. NFTs: skipped (the NFT program's guest wasn't built)"
fi

sort "$WORK/methods.log" | uniq -c | sort -rn | tee "$WORK/methods.txt"
! grep -q REFUSED "$WORK/methods.log" || fail "the tool asked for a method the app's forwarder refuses"
say "PASS: the Android build signed and sent every public call above, and each applied"
