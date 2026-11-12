#!/data/data/com.termux/files/usr/bin/sh
# Logos blockchain node on Android through Termux, for phones without the Linux Terminal app.
# Run once inside Termux:   sh install-termux.sh      then start the node with:   ~/logos-node
#
# Termux can't run the official node directly (it is built for normal Linux), so this installs
# a small Ubuntu inside Termux (proot-distro) and runs the node there. No root needed.
set -e
V=${NODE_VERSION:-0.3.4}
[ "$(uname -m)" = aarch64 ] || { echo "this needs a 64-bit ARM phone"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

pkg install -y proot-distro curl
proot-distro install ubuntu || echo "(ubuntu is already installed, continuing)"

proot-distro login ubuntu ${APP_SRC:+--bind "$APP_SRC:/appsrc"} -- env V="$V" APP_SRC="${APP_SRC:+/appsrc}" sh -s <<'IN'
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates python3 >/dev/null
mkdir -p /root/node/run && cd /root/node
if [ ! -x logos-blockchain-node ]; then
  echo "downloading the official node $V..."
  curl -fL -o node.tgz "https://github.com/logos-blockchain/logos-blockchain/releases/download/$V/logos-blockchain-node-linux-aarch64-$V.tar.gz"
  tar xzf node.tgz && rm node.tgz
fi
./logos-blockchain-node --version

cd /root/node/run
[ -f keystore.yaml ] || ../logos-blockchain-node init-config -o user_config.yaml
cat > user_config.yaml <<'Y'
network:
  backend:
    initial_peers:
    - /ip4/65.109.51.37/udp/3000/quic-v1/p2p/12D3KooWFrouXfmrR4nsLMtE7wu15DoMJ6VtoUtHinREZCvbWHar
    - /ip4/65.109.51.37/udp/3001/quic-v1/p2p/12D3KooWJRGau8M1rjT7R5e4YYsgdFhsMX35nRDtMwCDjxQkXAHz
    - /ip4/65.109.51.37/udp/3002/quic-v1/p2p/12D3KooWQXJavMDTRscjauFSgVAB1VLB6Rzpy2uY5SU9Tk7927tb
    - /ip4/65.109.51.37/udp/50001/quic-v1/p2p/12D3KooWSQc7CcGtvWDPF1yCbBthFnQjprfCVHmfmNDUrSmqQsU1
api:
  backend:
    listen_address: 127.0.0.1:8080
tracing:
  logger:
    file:
      directory: /root/node/run/logs
      prefix: node
state:
  base_folder: /root/node/run/state
Y
mkdir -p logs
../logos-blockchain-node --check-config user_config.yaml | tail -1

# the web app: node status plus a PIN-protected wallet, on 127.0.0.1:8090 only
# (names/ is the Logos Names resolver the page uses to look up names, messages/ the messages between names;
#  both vendored from the names project. messages/ is only used where a messaging node runs.)
APP_FILES="server.py index.html release.json messages/VENDORED.txt messages/messages.js messages/msg-crypto.js messages/noble-ciphers/LICENSE messages/noble-ciphers/_arx.js messages/noble-ciphers/_poly1305.js messages/noble-ciphers/chacha.js messages/noble-ciphers/utils.js messages/noble-hashes/LICENSE messages/noble-hashes/_md.js messages/noble-hashes/_u64.js messages/noble-hashes/hkdf.js messages/noble-hashes/hmac.js messages/noble-hashes/sha2.js messages/noble-hashes/utils.js names/LICENSE-APACHE names/LICENSE-MIT names/lookup.js names/names.js names/noble-hashes/LICENSE names/noble-hashes/_blake.js names/noble-hashes/_md.js names/noble-hashes/_u64.js names/noble-hashes/argon2.js names/noble-hashes/blake2.js names/noble-hashes/utils.js noble-curves/LICENSE noble-curves/abstract/curve.js noble-curves/abstract/edwards.js noble-curves/abstract/fft.js noble-curves/abstract/frost.js noble-curves/abstract/hash-to-curve.js noble-curves/abstract/modular.js noble-curves/abstract/montgomery.js noble-curves/abstract/oprf.js noble-curves/ed25519.js noble-curves/utils.js"
for f in $APP_FILES; do
  mkdir -p "$(dirname /root/node/app/$f)"
  if [ -n "$APP_SRC" ]; then cp "$APP_SRC/$f" /root/node/app/$f; else curl -fsSL -o /root/node/app/$f "https://raw.githubusercontent.com/jefdiesel/logos-node-android/release/app/$f"; fi
done

cat > /root/node/start.sh <<'S'
#!/bin/sh
# web app on 127.0.0.1:8090, then the node in the foreground
cd /root/node/run
python3 /root/node/app/server.py >/dev/null 2>&1 &
# --http-cors-origin: the node API then only accepts the status page, not other websites
exec /root/node/logos-blockchain-node --http-cors-origin http://127.0.0.1:8090 user_config.yaml
S
chmod +x /root/node/start.sh
IN

cat > "$HOME/logos-node" <<'L'
#!/data/data/com.termux/files/usr/bin/sh
# Starts the Logos node. Keep Termux open; Ctrl-C stops the node.
[ -z "$NO_WAKE_LOCK" ] && command -v termux-wake-lock >/dev/null && termux-wake-lock
exec proot-distro login ubuntu -- /root/node/start.sh
L
chmod +x "$HOME/logos-node"

echo
echo "done. start the node with:  ~/logos-node"
echo "then open http://localhost:8090 in the phone's browser (localhost, not 127.0.0.1: fingerprint unlock only works there)."
