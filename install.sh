#!/bin/sh
# Logos blockchain node on an Android phone, inside Android's Linux Terminal app.
# Run once, inside the Terminal app:   sh install.sh
# It downloads the official node, makes fresh keys, joins the testnet, and sets the node and a
# small web app (status and wallet) to start whenever the Linux box starts. No computer is needed after this.
#
# Before running: Terminal app -> gear -> Advanced -> Memory size: about 4000 MB on an 8 GB phone.
# After running:  Terminal app -> gear -> Port control -> allow 8090 (leave 8080 off),
#                 then open http://127.0.0.1:8090 in the phone's browser.
set -e
V=${NODE_VERSION:-0.3.4}
SWAP_GB=${SWAP_GB:-5}
[ "$(uname -m)" = aarch64 ] || { echo "this needs an arm64 Linux box"; exit 1; }

mkdir -p ~/node/run && cd ~/node
if [ ! -x logos-blockchain-node ]; then
  echo "downloading the official node $V..."
  curl -fL -o node.tgz "https://github.com/logos-blockchain/logos-blockchain/releases/download/$V/logos-blockchain-node-linux-aarch64-$V.tar.gz"
  tar xzf node.tgz && rm node.tgz
fi
./logos-blockchain-node --version

cd ~/node/run
[ -f keystore.yaml ] || ../logos-blockchain-node init-config -o user_config.yaml
cat > user_config.yaml <<Y
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
      directory: $HOME/node/run/logs
      prefix: node
state:
  base_folder: $HOME/node/run/state
Y
mkdir -p logs
../logos-blockchain-node --check-config user_config.yaml | tail -1

# swap space: the node needs several GB of memory while it syncs from the first block
if [ ! -f /swapfile ]; then
  sudo fallocate -l ${SWAP_GB}G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile >/dev/null && sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

# the web app: node status plus a PIN-protected wallet, on 127.0.0.1:8090 only
# (names/ is the Logos Names resolver the page uses to look up names, vendored from the names project)
APP_FILES="server.py index.html names/names.js names/lookup.js names/LICENSE-MIT names/LICENSE-APACHE names/noble-hashes/LICENSE names/noble-hashes/argon2.js names/noble-hashes/blake2.js names/noble-hashes/_blake.js names/noble-hashes/_md.js names/noble-hashes/_u64.js names/noble-hashes/utils.js"
for f in $APP_FILES; do
  mkdir -p "$(dirname ~/node/app/$f)"
  if [ -n "$APP_SRC" ]; then cp "$APP_SRC/$f" ~/node/app/$f; else curl -fsSL -o ~/node/app/$f "https://raw.githubusercontent.com/jefdiesel/logos-node-android/main/app/$f"; fi
done

unit() { # name, description, command, environment (optional)
  sudo tee /etc/systemd/system/$1.service >/dev/null <<U
[Unit]
Description=$2
After=network-online.target
[Service]
User=$USER
WorkingDirectory=$HOME/node/run
${4:+Environment=$4}
ExecStart=$3
Restart=always
RestartSec=10
Nice=10
[Install]
WantedBy=multi-user.target
U
}
# --http-cors-origin: the node API then only accepts the status page below, not other websites
unit logos-node "Logos blockchain node" "$HOME/node/logos-blockchain-node --http-cors-origin http://127.0.0.1:8090 user_config.yaml"
# NODE_RESTART_CMD: after restoring a wallet backup the app restarts the node with this (passwordless sudo, as in this install)
unit logos-node-app "Logos node web app (status and wallet) on 127.0.0.1:8090" "/usr/bin/python3 $HOME/node/app/server.py" \
  '"NODE_RESTART_CMD=sudo -n systemctl restart logos-node"'
sudo systemctl daemon-reload
# an older version of this script called the web app logos-node-status
sudo systemctl disable --now logos-node-status.service 2>/dev/null || true
sudo systemctl enable --now logos-node.service logos-node-app.service
sudo systemctl restart logos-node-app.service

echo
echo "done. the node is syncing. it starts by itself whenever the Terminal app starts the Linux box."
echo "next: Terminal app -> gear -> Port control -> allow 8090, then open http://127.0.0.1:8090 in the browser."
echo "logs: journalctl -u logos-node -f     stop: sudo systemctl stop logos-node"
