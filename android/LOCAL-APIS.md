# Local APIs: what other apps on the phone can reach

The app runs three local HTTP servers:

| Where | What | Who uses it |
|---|---|---|
| **Unix socket `files/node/api/api.sock`** (a 0700 folder in the app's files; app 0.5.16 and later) — before: `127.0.0.1:18180` | the blockchain node's own API (node 0.3.4 with patch 0002) | `server.py`; the app's Kotlin status calls (NodeService, Battery's open timer, NodeActivity) |
| `127.0.0.1:18645` | the messaging (Waku) node's REST API, from `liblogosdelivery` | `server.py` only |
| `127.0.0.1:18190` | the wallet server, `app/server.py` in the app's `:wallet` process | the app's WebView; the app's `names` child (`/lez-rpc/<secret>` only) |

## The node the app ships

The app runs the **official Logos blockchain node source at a pinned commit**, plus **one published
patch** that moves the node's local control interface (its HTTP API) from a network port to a private
socket file. Nothing about the chain rules, block checking or peer networking is changed: the patch
touches only how the API listens (`nodes/node/binary/src/api/unix_socket.rs`, new, and a few lines in
`api/backend.rs`), not its routes, handlers or wallet logic. The fast-replay patch 0001 is **not** in
this build.

| | |
|---|---|
| Source | [logos-blockchain/logos-blockchain](https://github.com/logos-blockchain/logos-blockchain), tag `0.3.4`, commit `f7ab0323346d36840660908be049d5a62c905516` |
| Patch | `native/patches/0002-api-unix-socket.patch` (branch `node-patches-api`), explained in `native/patches/README.md` |
| Build | the `native-build` workflow, variant `api` (`native/apply-patches.sh node --only native/patches/0002-api-unix-socket.patch`), artifact `logos-blockchain-node-android-arm64-0.3.4-api` |
| Pinned | `android/node.properties`: `variant=api`, the native-build run, and the binary's sha256; the APK build refuses a binary that differs, and the Node screen shows the variant and sha256 |

**To check a binary yourself:**

1. The workflow refuses to build unless the tag is the pinned commit (`native/check-source.sh`), and
   records version, commit, variant and patch-set id in `SOURCE.txt` inside the artifact, covered by
   its `SHA256SUMS`.
2. The **patch-set id** is the first 16 hex digits of the sha256 of `PATCHES.txt`, the list of the
   applied patch files with their sha256 (`native/apply-patches.sh`); `native/check-binary.sh api`
   checks that the binary contains patch 0002's name and that id, and not patch 0001.
3. Compare the binary's sha256 with `android/node.properties` (`api.sha256`), with `SHA256SUMS` in
   the artifact of the run named there, and with `lib/arm64-v8a/liblogosnode.so` in the APK.
4. To rebuild: run `native-build` (or the same steps by hand) at that commit with that patch. Whether
   a rebuild is byte-for-byte identical was not checked; the commit, the patch file's sha256 and the
   patch-set id identify what was built.

**Android does not keep other apps away from them.** Its own security guidance says so:
"Some applications use localhost network ports for handling sensitive IPC. Don't use this approach,
because these interfaces are accessible by other applications on the device"
([Security tips](https://developer.android.com/privacy-and-security/security-tips), section on
IPC). Any app with the `INTERNET` permission (a normal permission, granted at install without a
prompt) can open a TCP connection to `127.0.0.1` and send any request, with any `Host` and `Origin`
header. Nothing in this app limits that: the manifest declares no permission for it (ports are not
components), and `network_security_config.xml` only governs the app's own outgoing connections
(cleartext to 127.0.0.1 allowed); it has no say over who connects in. A firewall rule per port
would need root. The per-app sandbox protects files, not loopback sockets.

A web page open in the phone's browser is a second, weaker route: it can only send what CORS and
the browser's own rules allow. Whether Chrome on Android applies its new Local Network Access
prompt to pages that call `127.0.0.1` was not verified here; this document does not count on it.

## What another app could do, before this change

| Port | What another app can do | How it was shown |
|---|---|---|
| 18180 node API | **Spend the wallet's coins without the PIN**: `POST /wallet/transactions/transfer-funds` (the node signs with its own keystore and submits), `POST /channel/deposit`, `POST /wallet/sign/ed25519` and `/wallet/sign/zk` (a signing service for the node's keys), `/wallet/fund`, the SDP declaration and withdrawal routes, `/leader/claim`, `/pow/claim`, `PUT /pow/mining/*`, `PUT /admin/tracing/filter`. Read balances, notes, the mempool. | **Proven on a real node.** Source at tag 0.3.4: the router (`nodes/node/binary/src/api/routes.rs`, `backend.rs`) has no authentication layer and the handlers take no credential (`handlers.rs`, `post_transactions_transfer_funds`). CI job `wallet-send` now runs `tests/local_api_probe.py` against the real 0.3.4 node: a plain HTTP request with no credential makes a transfer (install-test run 43434916054: the node answered `201` with a transaction hash). |
| 18180 from a website | The node answered CORS with `Access-Control-Allow-Origin: *` (no `cors_origins` configured: `backend.rs` uses `allow_origin(Any)`), so a page in the phone's browser could send the same JSON POSTs. Since 0.5.15 the config lists only the wallet page's origin, which stops cross-origin pages, **but not DNS rebinding**: node 0.3.4 has no `Host` check, so a website that points its own name at 127.0.0.1 is same-origin with the port, CORS never applies, and it can call every route. Only the browser's own local-network rules stand in the way (not verified on Android). **The socket (0.5.16) closes this: there is no TCP port to reach.** | Source (`backend.rs`, `serve`; no `Host` check anywhere in the node's API at 0.3.4). The CI probe shows the CORS answer: `Access-Control-Allow-Origin: http://127.0.0.1:8090` for another origin. |
| 18645 messaging REST | **Take incoming messages away**: `GET /messaging/v1/events/received` returns the buffered messages *and clears them* ("evict-after-poll", `rest/messaging_api/event_cache.nim` at logos-delivery `57e04dc`), so an app polling it gets the sealed messages and the wallet never sees them. The same for `/messaging/v1/events/send` (send status). Publish on any topic, unsubscribe the wallet's inbox topic (`server.py` subscribes again on its next round), read the subscribed topics. The payloads are sealed by the page, so it reads ciphertext, not chats. | Source (upstream REST handlers and event cache at the pinned commit; `Messaging.kt` writes `"rest": true`, `127.0.0.1:18645`). Not run on a phone. |
| 18645 from a website | The drain above is a plain GET, which a page can send without CORS (it never sees the answer, but the buffer is cleared all the same), subject to the browser's local-network rules (not verified). | Source; not run. |
| 18190 wallet server | Before a PIN exists: **set the PIN** and get a session, then do anything a session allows (send, export the messaging key). Any time: guess PINs (5 tries, then 5 minutes), lock the wallet, read `/api/status`, `/api/wallet`, `/cryptarchia/info`, `/network/info`. Not: read the WebView's session token; call `/lez-rpc/` without its secret. | **Reproduced** from a second process on a computer, against `server.py` 0.9.13 in Android mode: `POST /api/wallet/setup` with forged `Host`/`Origin` returned a session; `POST /api/wallet/lock` and `GET /api/status` answered. |

## The wallet server (18190): closed since 0.5.15

**Options considered**

1. *A per-start secret in the URL path* (`http://127.0.0.1:18190/<secret>/`). Works, but every
   `fetch("/api/...")` in the page uses absolute paths, so the page would change everywhere, and the
   Linux page would carry it too.
2. *A header the WebView adds.* `loadUrl(url, headers)` adds headers to the top-level load only, not
   to the page's own `fetch` calls.
3. *No TCP port at all: answer the WebView in-process* (`shouldInterceptRequest`, the
   `WebViewAssetLoader` approach, dispatching to `server.py` through Chaquopy). Rejected for now:
   `WebResourceRequest` exposes the method, URL and headers but **not the request body**
   ([reference](https://developer.android.com/reference/android/webkit/WebResourceRequest)), so POSTs
   (PIN, send, everything that changes something) can't be served that way without rewriting the
   page's requests into a JavaScript bridge. The `names` child also needs an HTTP endpoint. Worth
   doing later (a `postWebMessage` channel would carry bodies), not as the smallest fix.
4. **A per-start secret as a cookie (chosen).** At each start of the `:wallet` process the app makes
   32 random bytes (`WalletServer.appKey`), passes them to `server.py` as `APP_KEY`, and sets them in
   the WebView's cookie store before the first load: `app_key=<hex>; Path=/; HttpOnly; SameSite=Strict`
   for `http://127.0.0.1:18190/`. The WebView then sends it with every request of the page, GET and
   POST, with no change to the page. Another app has no way to read the WebView's cookie store (it is
   in this app's private data) or the process's memory.

**What `server.py` does with `APP_KEY` set** (only the Android app sets it):

- every request needs the cookie, compared in constant time, **except** the page's public files
  (`/`, the page's scripts under `/messages/`, `/noble-curves/`, `/names/`, `/lns/lns.js`,
  `/qr/qrcode.js`, the manifest and icons: the same for everyone, from this repository) and the
  names forwarder `/lez-rpc/<secret>` (it has its own secret path, and the `names` child sends no
  cookie). A request without it gets `403 {"error": "this app only answers its own page", "app_key": false}`;
- so `/api/wallet/setup`, unlock, lock, status, every `/api/messages/*` route including
  `GET /api/messages/key`, `/cryptarchia/info` and `/network/info` answer only the app's own page;
- the existing `Host`, `Origin`, `Content-Type` and session checks stay as they were;
- `server.py` takes `APP_KEY` out of its environment at import, so the processes it starts (the node
  binary, `names`, `pkill`) don't inherit it.

Without `APP_KEY` (Linux, Termux) nothing changes: the browser there can't be handed a cookie by an
app, so those installs keep the `Host`/`Origin` checks only (see "Linux and Termux" below).

**Another app on the port first.** If another app listens on 18190 before the wallet process starts,
`server.py` can't bind, but the port still answers. Before this change the WebView would then have
loaded that app's page, with the native bridge (`window.LogosAndroid`, whose `isOwnPage` checks only
the address): a PIN-phishing page with the app's own bridge. Now `server.py` sets `SERVING` while it
holds the port (`main()`), `logos_embed.serving()` reports it in-process, and the app loads the page,
sets the cookie and keeps the page shown only while `WalletServer.ours()` (its own server serving and
the port answering). Otherwise the cover stays up and says so: "Another app is using the wallet's
port …" when something else answers there; `server.py` keeps trying to bind every 5 s (inside the
Android app) and the page opens by itself once the port is free. The Node screen (another process)
says "answering" only when the wallet process recorded that the port is its own
(`files/wallet/server-state.txt`, with the wallet process's pid, checked alive). Left open: if the
app's own server stopped while the page is shown and another app took the port within the watchdog's
interval, a few requests (with the cookie) could reach it before the cover comes up; the key is useless
to it, since the server it guards is gone.

**Idle connections.** Each connection to `server.py` is closed after 30 s without data
(`Handler.timeout`), so another app can't hold the server's threads with idle connections.

**Debug extras.** The debug build's `probe` and `crashrenderer` extras are honoured only when the
wallet screen is started through `.WalletDebug`, an alias that only holders of
`android.permission.DUMP` (the adb shell) can start: `am start -n io.github.jefdiesel.logosnode/.WalletDebug --ez probe true`.
Another app starting the launcher entry with those extras gets the ordinary screen.

**What it protects against:** every other app on the phone, whatever headers it sends. **What it
doesn't:** anything running as this app's own user (it can read the keys anyway), root, USB
debugging on this debug build (`run-as`, WebView remote debugging).

**What it breaks:** nothing found. If the WebView ever failed to take the cookie, the page would load
(a public file) and say "this app only answers its own page"; the app logs it.

**Tests:** `tests/app_key_test.py` (every route class with and without the key, wrong keys, forged
headers, the first PIN, the forwarder, unchanged without `APP_KEY`, the environment, `serving()` with
its own server and with another program on the port), and
`tests/app_key_ui.mjs` (headless Chrome: the cookie set the way the WebView gets it, the page's GET
and POST carry it, its scripts can't read it, without it the page explains). **Not run on a phone**:
the WebView's `CookieManager` path is the same Chromium cookie store, but was not exercised on a
device by this change.

### `GET /api/messages/key`: the PIN rule, not built here

The audit asks that handing out the messaging secret need the PIN again, like backup export. With
the app key, only the app's own page can call it now. Asking for the PIN on that call is a change to
the page as much as to the server: `app/messages/messages.js` fetches the key whenever it has none in
memory (after every unlock and every reload, on a 4-second refresh timer), because the page does the
messaging cryptography. A PIN on that GET would lock out fingerprint sessions and, because a refused
call reads as "locked", would lock the wallet on a reload. **Recommended, coordinated with the
messages code:** the page asks for the key once per unlock and keeps it in memory; the server hands it
out once per session (a second call in the same session needs the PIN, or a fresh unlock); a
fingerprint session gets it as today, which the backup comment already accepts for reading chats.

## The node API: on a private socket since 0.5.16

Node 0.3.4 cannot be configured to close its TCP port: `api.backend.listen_address` is a TCP socket
address (`config/api/serde.rs`, `core::net::SocketAddr`), the backend binds a `TcpListener`
(`backend.rs`), and there is no authentication or `Host` setting. The route table is fixed at compile
time (`api_routes!`), so the wallet routes can't be turned off by configuration either.

| Option | Protects | Costs | Verdict |
|---|---|---|---|
| (a) **Unix domain socket** in the app's private files directory | every other app (a 0700 directory with the app's own SELinux category; the socket 0600); websites, rebinding included (no TCP port at all) | node patch (small: the router is the same, only the listener changes; axum 0.8 serves a `UnixListener`); every client speaks HTTP over the socket | **Chosen.** Patch `0002-api-unix-socket` |
| (b) Bearer token on every request, TCP kept | every other app that can't read the token | node patch (a middleware); the token must reach the node and every client; the port stays open, so the HTTP parser stays exposed and a leaked token is enough | second choice |
| (c) An authenticating reverse proxy in front | nothing: the node's own port stays reachable beside the proxy | — | does not help |
| (d) TCP plus a peer check (SO_PEERCRED is Unix-socket only; on TCP, matching `/proc/net/tcp` uids is racy) | — | patch, fragile | no; on a Unix socket the directory and file mode already do it |
| (e) No listener: HTTP over stdin/stdout or a socketpair inherited from the parent | every other app | a larger patch, and only the parent process (NodeService, main process) could talk to it, while `server.py` lives in the `:wallet` process | no |
| (f) No patch: firewall the port | — | needs root (iptables owner match) | impossible in an app |
| A random port per start | nothing real: an app finds it by trying the 64,000 loopback ports in about a second | — | obscurity, not done |

**Can the wallet endpoints be disabled and signing done elsewhere?** Not without a patch, and not as
a short-term plan: the node selects notes and makes the zero-knowledge signatures with the keys it
loaded; moving that into the app means reimplementing the wallet.

**Can the keys stay out of the node until a send?** No. The node reads its keystore once at start
(`config/keystore.rs`); no API adds a key at run time; the keystore also holds the node's own keys.
Keeping them out would mean restarting the node for each send, minutes of replay each time on a phone.

**The patch** (`native/patches/0002-api-unix-socket.patch`; details in `native/patches/README.md`):
with `LOGOS_API_UNIX_SOCKET=<path>` set, the node serves its API on that socket and on **no** TCP port.

- The value must be an absolute path in a directory owned by the node's user with no group or other
  access; the socket is created under umask 077 and set to 0600.
- A socket left by an earlier run is removed only if nothing answers on it; a live socket (another
  node) or any other file is left alone.
- **Once the variable is set the node never opens TCP for its API**: if anything about the socket is
  wrong (empty or relative value, shared directory, live socket, other file, bind error) the node
  stops.
- Unset: upstream behaviour.

**What the app does (0.5.16, variant `api`):**

1. NodeService creates `files/node/api` with mode 0700 and starts the node with
   `LOGOS_API_UNIX_SOCKET=<files>/node/api/api.sock` (about 62 bytes, under the 108-byte limit).
2. `server.py` gets `NODE_API=unix:<that path>` and talks HTTP over `AF_UNIX`
   (`_UnixHTTPConnection` in `node()`); Linux and Termux keep `http://`.
3. The Kotlin status calls (NodeService, Battery's open timer, NodeActivity) go through `NodeApi`: a
   small HTTP/1.1 client over `android.net.LocalSocket` in the **file-system** namespace (never the
   abstract one).
4. **Nothing may answer on 127.0.0.1:18180.** NodeService checks just before each start (after
   stopping any node left over from an earlier run), 10 s after it, and every 15 s while the node runs.
   If something answers (the node opened TCP after all, or another app is there), the node is stopped,
   not restarted, and the notification and Node screen show one line saying why; it starts again only
   when started by hand, and the check runs again then. `server.py` independently refuses to send
   anything to the node (every POST: transfers, deposits) while something answers there
   (`NODE_TCP_GUARD`), and logs it.
5. `cors_origins` stays in the config: harmless, and it matters again if the app ever goes back to
   a TCP node.

Builds with another variant (`unpatched`, or the older `patched` without 0002) keep TCP on 18180, as
before (`NodeApi.onSocket` is true only for `api`).

## The messaging REST API (18645): ours to change, not built here

The REST server is the library's (presto, TCP only, no authentication); the process around it is our
own runner (`messaging/runner/waku_runner.c`), which already drives the library's C API
(`subscribe`, `unsubscribe`, `send`, connection status, and the `onMessageReceived`, `onMessageSent`,
`onMessagePropagated`, `onMessageError` events).

- *stdin/stdout or a socketpair*: no. The runner is a child of NodeService (main process); `server.py`
  is in the `:wallet` process.
- *An abstract-namespace Unix socket*: no. Who may connect would rest on SELinux policy details, not
  on file permissions.
- **Recommended: REST off (`"rest": false` in `Messaging.kt`'s config) and the runner serves the
  calls `server.py` makes, as HTTP over a file-system Unix socket `files/waku/api.sock` (0600).**
  `server.py` uses seven calls: `GET /health`, `GET`/`POST`/`DELETE /messaging/v1/subscriptions`,
  `POST /messaging/v1/messages`, `GET /messaging/v1/events/received`,
  `GET /messaging/v1/events/send/<id>`. The runner keeps the same evict-after-poll buffers from the
  events (the upstream REST does exactly that from the same events), so `server.py` changes only in
  its transport (`waku()` and `_loopback_url` accept `unix:<path>`); the Linux route has no messaging
  node. Effort: about 300 lines of C in the runner (socket accept loop, minimal HTTP/1.1, JSON for the
  event records), a `waku-build` run, a new pin, and a test on a phone, which is why it is not in this
  branch: the rc3 library itself has not run on the phone yet (`messaging/README.md`), and a runner
  change that can't be tried on a device would put messages at risk for a fix whose worst case is
  losing or delaying sealed messages, not coins.
- Until then: what another app can do here is denial of service (taking or delaying sealed messages,
  dropping the inbox subscription until the next round) and publishing, which anyone on the messaging
  network can do anyway (the page checks that a message's sender holds the key it names, the `auth`
  field in `app/messages/msg-crypto.js`).

## Unverified until tried on the phone

None of this has run on a device yet. To check there, in this order:

- The node starts with the socket: the log line `logos-node-android patched node: the HTTP API listens on
  this Unix socket only`, `files/node/api` is 0700 and `api.sock` is 0600, and nothing listens on
  127.0.0.1:18180 (`ss -ltn` from adb, or the app's own check staying quiet).
- The app's own processes reach the socket: the Node screen shows height and peers (NodeService and
  NodeActivity), the wallet page shows the node's status and can send (`server.py` in `:wallet`), the
  open timer writes `open-times.txt`.
- Another app can't: `connect()` to the socket from a second test app should fail (EACCES), from
  directory permissions and SELinux categories (`levelFrom=all`); expected, not tried.
- The WebView takes the `app_key` cookie through `CookieManager` (tested in desktop Chrome only), and
  whether it writes it to its cookie database on disk (in the app's private data; an old key is dead,
  so harmless either way). The key is never written to a file or a log by the app's own code.
- Whether WebView content debugging is on for this debuggable build (no `setWebContentsDebuggingEnabled`
  call; check `chrome://inspect` over adb). Either way only adb or the app's own user can reach it.
- `.WalletDebug` starts from `adb shell am start` and not from another app.
- With another app holding 18190 before the wallet starts: the cover's text, and the page opening by
  itself once that app lets the port go.
- Chrome on Android's local-network rules (whether a website can reach 127.0.0.1 at all): not relied on.

## Linux and Termux

`server.py` is shared. On Linux the app is for the computer's own browser; another program running as
any user on that computer can reach `127.0.0.1:8090` the same way, which the Linux install accepts
(a desktop is one user's machine, and the browser can't be given a secret by an app). **Termux runs
on Android**, so a Termux install has exactly the phone exposure described above on `8080` (node)
and `8090` (wallet) and nothing in this branch changes it: Chrome there can't be handed a cookie. A
fix for Termux would print a one-time link that sets the cookie on first visit; not done. The node
patch helps Termux only if Termux runs the patched node with `LOGOS_API_UNIX_SOCKET` set.

## What changed, for review

0.5.15 (branch `local-apis`):

- `app/server.py`: `APP_KEY`/`APP_KEY_COOKIE`/`SERVING` (top), `Handler.key_ok`, `Handler.public_file`,
  `Handler.KEY_REFUSED`, one check at the top of `do_GET` and one in `do_POST` after the forwarder,
  `SERVING` set and cleared around `serve_forever()` in `main()`.
- `logos_embed.py`: `serving()`.
- `LogosApp.kt`: `WalletServer.appKey`, `APP_KEY_COOKIE`, `appKeyCookie()`, `ours()`, `APP_KEY` in the
  environment given to `server.py`.
- `WalletActivity.kt`: the page loads only when `ours()`, with the cookie set first (`loadWhenReady`);
  the watchdog reloads when not `ours()`; `walletSetting()` sends the cookie.
- `NodeFiles.kt`: `cors_origins` in the node config.
- Tests: `tests/app_key_test.py`, `tests/app_key_ui.mjs`, `tests/local_api_probe.py`.

0.5.16 (branch `local-apis-2`):

- `android/node.properties`: variant `api`.
- `NodeApi.kt` (new): `onSocket`, `get`, `json`, `getUnix` (LocalSocket, file-system namespace),
  `getTcp`, `tcpAnswers`, `TCP_BLOCK_LINE`, `request`, `parse`, `dechunk`.
- `NodeFiles.kt`: `apiDir`, `apiSocket`, `privateApiDir()`.
- `NodeService.kt`: `nodeJson` through `NodeApi`; in `supervise()` the check before the start; in
  `runNode()` the socket folder and `LOGOS_API_UNIX_SOCKET`, then `watchTcp`; `watchTcp()`, `blockApi()`.
- `Battery.kt` (`OpenTimer.get`, `probe`) and `NodeActivity.kt` (`get`, the info line) through `NodeApi`.
- `LogosApp.kt`: `NODE_API`/`NODE_TCP_GUARD` for `server.py`; `serving()`, `portTaken()`,
  `stateFile()`, `watchPortState()`, `recordedState()`, `describe()`.
- `WalletActivity.kt`: the cover's text when another app holds the port; `walletSetting()` only when
  `ours()`; `debugAllowed()` (the `.WalletDebug` alias) for the debug extras.
- `AndroidManifest.xml`: `.WalletDebug` alias, guarded by `android.permission.DUMP`.
- `app/server.py`: `_UnixHTTPConnection`, `node_tcp_taken()`, the `unix:` branch of `node()`,
  `Handler.timeout` (`APP_IDLE_TIMEOUT`, 30 s), the bind retry in `main()` (Android only).
- Tests: `tests/node_socket_test.py`, `NodeApiTest.kt`; `app_key_test.py` parts 4 (the port freed
  later) and 5 (idle connections).
