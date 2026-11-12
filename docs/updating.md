# Updating the web app

The web app (status and wallet on http://localhost:8090) can update itself. The node is not part of
this: it keeps running and is never restarted by an update.

## How it works

- Updates come from this project's GitHub repository: `app/release.json` on the `release` branch lists the
  version and the SHA-256 of every app file. That branch only moves to a commit after every test passed
  on `main`, so a version reaches phones only once it is tested.
- The app looks at that list when it starts and then every 6 hours, or when you tap **Check for updates**
  in Settings (the gear at the top). When a newer version exists, the wallet shows "Version X is available";
  tapping it opens the update in Settings.
- Updating needs the wallet unlocked, and a fresh fingerprint confirmation (when fingerprint unlock is on and
  the page is open as `localhost`) or your PIN. Wrong PINs here count toward the same pause as unlocking;
  the message says how many tries are left. The app then downloads every file, checks each one against the
  list, and checks that the Python code compiles. If anything doesn't match, nothing is changed.
- Only then does it keep each current file as `<name>.prev`, put the new files in place and restart itself.
  The page notices the new version and offers **Reload** (it reloads by itself while the wallet is locked).
- Your PIN, fingerprint keys, history, event log and backup reminder are kept: they are in files the
  update never touches (`wallet-*`).

## What changes you'll see

- 0.9.2: a locked app shows one lock screen (the λ, your PIN, and fingerprint where it's on) instead of the
  wallet in a locked state, and Restore accepts backups made with Messages on (they were refused before).
- 0.9.3: the wallet's look changes: a "Wallet" header with the node's state as one icon, the balance first
  with Send and Receive, recent activity below, your addresses behind Receive, and one Settings page (Node,
  Security with Lock now, Backup, Restore, Updates, About). Stronger contrast in dark mode.
- 0.9.4: in Messages, a sent message has one mark (a clock while it waits, a tick once the network has it)
  and never claims it was delivered or read; nothing says "verified" any more, only problems show; New
  chat is a full screen with **+** in the header, and asks what to call someone who has no LNS name; the
  bar at the bottom steps aside while you type; clearer people icons; every button is at least 44 px. The
  backup texts say what a backup holds once Messages is on, and Messages asks for a new backup when the
  last one was made before Messages was turned on.
- 0.9.5: the lock screen is a splash with the λ and **Enter PIN**; with fingerprint unlock on, the phone's
  fingerprint prompt comes up over it by itself, and after a cancel the splash offers **Enter PIN** and
  **Use fingerprint**. The PIN is typed on the app's own number keypad (a physical keyboard works too), not
  in a text box. An eye beside the balance hides the amounts on the home screen, remembered on this
  device. The balance is a normal size and always fits on one line (the font gets smaller for long
  amounts); message details only say "the network holds it" once it does; a profile no longer says "Not
  verified" for someone you haven't written to yet; linking your name points to the Names app, with the
  terminal command folded away; people icons and every remaining button meet the size and contrast rules;
  the wallet says "accounts" instead of "keys".
- 0.9.6: Messages settings no longer read as if your LNS name can't take coins: the messaging address is
  for messages, coins go to your wallet address (Wallet, then Receive), and your LNS name can take both
  once it is set up for each. With the balance hidden, the Received pop-up and Send's "not enough" error
  no longer show amounts. On the keypad, Enter on a key reached with Tab presses that key, and after each
  key screen readers are told how many digits are in. Settings > Node says it in plain words: blocks on
  this device, nodes connected, new blocks a minute, and where the network is.

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

CI (`python3 tools/release.py check`) fails if `release.json` doesn't match the files, if an installer's
file list differs from it, or if the app or the installers would fetch from anywhere but the `release`
branch. If a change should not be offered to phones yet, run `python3 tools/release.py write` instead,
which keeps the version.

Phones never read `main`. After a push to `main`, the last CI job (`promote`, the only job allowed to
write) fast-forwards `release` to that commit once every other job passed. It never force-pushes: if
`release` has commits `main` doesn't, it stops and says so.

If `promote` can't run (for example the token lacks permission), move the branch by hand, but only to a
commit whose install-test run is fully green:

```sh
git push origin <green commit>:refs/heads/release
```
