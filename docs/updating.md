# Updating the web app

The web app (status and wallet on http://127.0.0.1:8090) can update itself. The node is not part of
this: it keeps running and is never restarted by an update.

## How it works

- Updates come from this project's GitHub repository: `app/release.json` on the `main` branch lists the
  version and the SHA-256 of every app file.
- The app looks at that list when it starts and then every 6 hours, or when you tap **Check for updates**
  in the unlocked wallet. When a newer version exists, the page shows it at the top with an **Update** button.
- Updating needs the wallet unlocked and your PIN. The app then downloads every file, checks each one
  against the list, and checks that the Python code compiles. If anything doesn't match, nothing is changed.
- Only then does it keep each current file as `<name>.prev`, put the new files in place and restart itself.
  The page notices the new version and offers **Reload** (it reloads by itself while the wallet is locked).
- Your PIN, fingerprint keys, history, event log and backup reminder are kept: they are in files the
  update never touches (`wallet-*`).

## Going back to the previous version by hand

The previous files are next to the new ones, with `.prev` added: `server.py.prev`, `index.html.prev`,
`release.json.prev`, and the same inside `names/`. To go back:

Android Linux Terminal:

```sh
cd ~/node/app
for f in $(find . -name '*.prev'); do cp "$f" "${f%.prev}"; done
sudo systemctl restart logos-node-app
```

Termux (the app runs inside the Ubuntu that Termux starts):

```sh
proot-distro login ubuntu -- sh -c 'cd /root/node/app && for f in $(find . -name "*.prev"); do cp "$f" "${f%.prev}"; done'
```

then stop the node with Ctrl-C and start it again with `~/logos-node`, which starts the app too.

Only one step back is kept: the next update replaces the `.prev` files. The app offers the newer version
again until you update.

## For maintainers

Every change meant to reach phones needs a higher version:

```sh
python3 tools/release.py bump 0.8.0     # sets APP_VERSION in app/server.py and rewrites app/release.json
```

CI (`python3 tools/release.py check`) fails if `release.json` doesn't match the files or if an installer's
file list differs from it. If a change should not be offered to phones yet, run `python3 tools/release.py write`
instead, which keeps the version.
