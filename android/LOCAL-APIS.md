# Local APIs: what other apps on the phone can reach

The app runs three local HTTP servers:

| Where | What | Who uses it |
|---|---|---|
| **Unix socket `files/node/api/api.sock`** (a 0700 folder in the app's files; app 0.5.16 and later) — before: `127.0.0.1:18180` | the blockchain node's own API (node 0.3.4 with patch 0002) | `server.py`; the app's Kotlin status calls (NodeService, Battery's open timer, NodeActivity) |
| **Unix socket `files/waku/api/api.sock`** (0700 folder; 0.5.16) — before: `127.0.0.1:18645` | the messaging (Waku) node: the runner's own API (before: the library's REST API) | `server.py` only |
| `127.0.0.1:18190` | the wallet server, `app/server.py` in the app's `:wallet` process | the app's WebView; the app's `names` child (`/lez-rpc/<secret>` only) |

## The node the app ships

The app runs the **Logos blockchain node source at a pinned commit**, plus **one published
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
| Pinned | `android/node.properties`: `variant=api`, `commit`, the native-build run (43452854309) and the binary's sha256 (`f772344c0ce03e1da7fbefaf29f61ea1480862f5a41bffc98d63b8fcbc848533`), patch-set id `a08732b12cf8e33c`. The APK build refuses a binary that differs, or whose `SOURCE.txt`/`PATCHES.txt` name another commit or any other patch; the Node screen shows the variant and sha256 |

**To check a binary yourself:**

1. The workflow refuses to build unless the tag is the pinned commit (`native/check-source.sh`), and
   records version, commit, variant and patch-set id in `SOURCE.txt` inside the artifact, covered by
   its `SHA256SUMS`.
2. The **patch-set id** is the first 16 hex digits of the sha256 of `PATCHES.txt`, the list of the
   applied patch files with their sha256 (`native/apply-patches.sh`); `native/check-binary.sh api`
   checks that the binary contains patch 0002's name and that id, and not patch 0001.
3. Compare the binary's sha256 with `android/node.properties` (`api.sha256`), with `SHA256SUMS` in
   the artifact of the run named there, and with `lib/arm64-v8a/liblogosnode.so` in the APK.
4. To rebuild: run `native-build` (or the same steps by hand) at that commit with that patch. The
   builds are reproducible in practice: the `api` binary came out byte-identical in two separate runs
   (43442276482 and 43452854309, the second with `cargo build --locked`), and so did the unpatched one
   (also in 43280916866).

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
4. **The node's API must not be on 127.0.0.1:18180.** Any app can listen on that port, and nothing of ours
   connects there in socket mode, so whoever is there gets nothing from us. Since 0.5.20 the app **never reads
   anything from that port**: it only checks whether a connection is accepted (connect, then close).
   - Before a start, something accepting there is only logged.
   - While the node runs (10 s after the start, then every 15 s, `NodeApi.TcpGuard`): if something accepts on
     18180, the app tries to connect to the node's own socket. A socket that accepts proves patch 0002 serves
     the API there, and the patch never binds TCP then, so whatever is on 18180 is a stranger: logged once,
     ignored. Only if the socket accepts nothing, four checks in a row (about a minute), is the node stopped
     (it may be running without its socket); then it is not restarted, and the notification and Node screen
     show one line saying why. The thread catches everything, so nothing on it can take the process down.
   - Strikes are counted only once the node has started its services: it prints "Running chain" (read from its
     output, as the app reads its other lines), or ten minutes have passed without that line. Until then its API
     may not be bound yet, so a stranger on 18180 proves nothing (review E1). An unpatched node prints the same
     line, so a node running without its socket is still caught.
   - `server.py` sends everything over the socket and never looks at TCP.
   - History, so it is not repeated: 0.5.16 stopped the node whenever anything answered there (any app could
     stop the node and block sends). 0.5.17 to 0.5.19 read the answer on that port to judge it: any app could
     then crash the app's main process (node and messaging) by streaming endless bytes there (review M1), and
     an app imitating the node's answer could get the node stopped on any start whose block replay runs past
     about a minute (review D1). 0.5.17 to 0.5.19 also refused sends while a stranger was on that port and the
     node was slow (review D3). None of these builds reached the phone.
   - What remains: a stranger on 18180 while the node's socket accepts nothing for a minute after its services
     started (the node wedged) gets the node stopped. On the phone the socket accepted 3 s after a start (phone
     check, 0.5.20); the API service binds it as soon as services start, before the block replay.
5. `cors_origins` stays in the config: harmless, and it matters again if the app ever goes back to
   a TCP node.

Builds with another variant (`unpatched`, or the older `patched` without 0002) keep TCP on 18180, as
before (`NodeApi.onSocket` is true only for `api`).

## The messaging API: on the runner's own socket since 0.5.16

The REST server is the library's (presto, TCP only, no authentication); the process around it is our
own runner (`messaging/runner/waku_runner.c`), which drives the library's C API (`subscribe`,
`unsubscribe`, `send`, connection status, and the `onMessageReceived`, `onMessageSent`,
`onMessagePropagated`, `onMessageError`, `onMessageQueued` events).

- *stdin/stdout or a socketpair*: no. The runner is a child of NodeService (main process); `server.py`
  is in the `:wallet` process.
- *An abstract-namespace Unix socket*: no. Who may connect would rest on SELinux policy details, not
  on file permissions.
- **Chosen: REST off (`"rest": false`) and the runner serves the calls `server.py` makes, as HTTP over
  a file-system Unix socket `files/waku/api/api.sock` (folder 0700, socket 0600):** `GET /health`,
  `GET`/`POST`/`DELETE /messaging/v1/subscriptions`, `POST /messaging/v1/messages`,
  `GET /messaging/v1/events/received`, `GET /messaging/v1/events/send/<id>`, with the same paths and
  answers as the library's REST API at the pinned commit, evict-after-poll included (with a byte bound:
  the runner keeps at most 256 received messages and at most 2 MiB of them, oldest dropped first and
  counted as missed, so an answer always fits what `server.py` reads; since 0.5.20 `server.py` takes an
  answer only whole: one that ends short of its Content-Length or chunked end is no answer), built from the
  library's events as the REST API's own buffers are (`messaging/runner/api_socket.h`,
  `messaging/README.md`). The socket must be in a private directory; a live socket is never taken
  over; if the socket can't be opened the runner stops the node and exits.
- `server.py` changes only its transport: `waku()` and `_loopback_url` accept `unix:<absolute path>`
  (the Linux route has no messaging node). The app tells it `set_waku_api("unix:<path>")`.
- **Tests:** `messaging/runner/test_api_socket.py` (the socket code with a stand-in library: where the
  socket may be made, every call, evict-after-poll, error text escaping, limits), run by `waku-build`
  before the Android build; `tests/messaging_socket_test.py` (the app's messaging loop over the socket:
  subscribe, a message from another sender arrives, a send reaches "sent").
- **Not verified:** the runner with the real library on the phone (the rc3 library itself has not run
  on the phone yet, `messaging/README.md`). `"rest": false` is the option's own default
  (`tools/confutils/cli_args.nim` at the pinned commit: `defaultValue: false, name: "rest"`).
- What another app could do before: take or delay sealed messages, drop the inbox subscription until
  the next round, publish (which anyone on the messaging network can do anyway; the page checks that a
  message's sender holds the key it names, the `auth` field in `app/messages/msg-crypto.js`).

## Unverified until tried on the phone

None of this has run on a device yet (the real node with patch 0002 does run in CI on Linux, install-test
job `node-socket`). To check on the phone, in this order:

- The node starts with the socket: the log line `logos-node-android patched node: the HTTP API listens on
  this Unix socket only`, `files/node/api` is 0700 and `api.sock` is 0600, and nothing listens on
  127.0.0.1:18180 (`ss -ltn` from adb, or the app's own check staying quiet).
- The app's own processes reach the socket: the Node screen shows height and peers (NodeService and
  NodeActivity), the wallet page shows the node's status and can send (`server.py` in `:wallet`), the
  open timer writes `open-times.txt`.
- The messaging runner opens `files/waku/api/api.sock`, nothing
  listens on 127.0.0.1:18645, and messages still arrive and go out.
- Another app can't: `connect()` to either socket from a second test app should fail (EACCES), from
  directory permissions and SELinux categories (`levelFrom=all`); expected, not tried.
- The WebView takes the `app_key` cookie through `CookieManager` (tested in desktop Chrome only), and
  whether it writes it to its cookie database on disk (in the app's private data; an old key is dead,
  so harmless either way). The key is never written to a file or a log by the app's own code.
- Whether WebView content debugging is on for this debuggable build (no `setWebContentsDebuggingEnabled`
  call; check `chrome://inspect` over adb). Either way only adb or the app's own user can reach it.
- `.WalletDebug` starts from `adb shell am start` and not from another app.
- With another app holding 18190 before the wallet starts: the cover's text, and the page opening by
  itself once that app lets the port go.
- With another program listening on 127.0.0.1:18180 (`nc`), even one answering every connection with endless
  bytes: the node starts and keeps running, the app doesn't crash, the log says once "another program holds
  127.0.0.1:18180; ignored", and sends work, also in the first minute after a start (review S1, M1, D3).
- When the node's socket first accepts a connection after a start, and when `/cryptarchia/info` first answers
  (how long the block replay takes with the `api` variant): the guard depends on the first (review D1).
- Many messages in a short time: they keep arriving, and the runner keeps up with concurrent calls
  (review S8: up to 16 connections call the library at once; if anything stalls, serialize the calls).
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
  `getTcp` (bounded, no redirects, 0.5.20), `tcpAnswers`, `socketAccepts` and `TcpGuard` (0.5.20), `TCP_BLOCK_LINE`, `request`, `parse`, `dechunk`.
- `NodeFiles.kt`: `apiDir`, `apiSocket`, `privateApiDir()`.
- `NodeService.kt`: `nodeJson` through `NodeApi`; in `supervise()` the check before the start; in
  `runNode()` the socket folder and `LOGOS_API_UNIX_SOCKET`, then `watchTcp`; `watchTcp()`, `blockApi()`.
- `Battery.kt` (`OpenTimer.get`, `probe`) and `NodeActivity.kt` (`get`, the info line) through `NodeApi`.
- `LogosApp.kt`: `NODE_API` for `server.py`; `serving()`, `portTaken()`,
  `stateFile()`, `watchPortState()`, `recordedState()`, `describe()`.
- `WalletActivity.kt`: the cover's text when another app holds the port; `walletSetting()` only when
  `ours()`; `debugAllowed()` (the `.WalletDebug` alias) for the debug extras.
- `AndroidManifest.xml`: `.WalletDebug` alias, guarded by `android.permission.DUMP`.
- `app/server.py`: `_UnixHTTPConnection`, the `unix:` branch of `node()`,
  `Handler.timeout` (`APP_IDLE_TIMEOUT`, 30 s), the bind retry in `main()` (Android only).
- Tests: `tests/node_socket_test.py`, `NodeApiTest.kt`; `app_key_test.py` parts 4 (the port freed
  later) and 5 (idle connections).
- Messaging (merged from branch `waku-socket`): `messaging/runner/api_socket.h` (new), `waku_runner.c`
  (`--api-socket`, `be_*` backend, `on_event` feeding the buffers, `onMessageQueued`),
  `api_socket_harness.c` and `test_api_socket.py` (tests), `logos-test-socket.json`; `Messaging.kt`
  (`MessagingSettings.REST`, `MessagingFiles.apiDir`/`apiSocket`/`wakuApi`/`privateApiDir`, the config
  and its check), `NodeService.setUpMessaging` (`--api-socket`), `LogosApp.watchMessaging`
  (`set_waku_api(unix:...)`), `NodeActivity` (the API line); `server.py`: `unix_http()`, the `unix:` branch
  of `waku()`, `_loopback_url` accepting `unix:<absolute path>`; `android/messaging-run.txt` and
  `messaging.sha256`: waku-build run 43445078866 (branch `waku-socket`), runner sha256
  `ebe88149ecc2ea0df0327d7c6fe244974d69d96d85a76a7cffdfe11fbc65dc7e`, library unchanged and byte-identical
  to the earlier build (`c2a6b96c…e340`); tests `tests/messaging_socket_test.py`, `MessagingTest`.

0.5.17 (branch `sockets-on-0514`, merged onto the phone's build `android-app` 9893d61): review S1 (the
guard above), S2 (`build.gradle.kts` fails unless `-PnodeVariant` is api, patched or unpatched; CI checks
it), S3 (runner buffer bounded to 2 MiB; `unix_http` reads up to 16 MiB;
`tests/messaging_batch_test.py`), S4 (the runner refuses a config that turns on REST, its admin routes,
the metrics server or websockets), S5 (`--locked` for the Android node build), S6 (install-test job
`node-socket`: the real node with patch 0002, built for Linux from the same commit, on its socket; bad
socket settings stop it and nothing opens on TCP; a real transfer through the web app over the socket).

0.5.20 (branch `sockets-on-0518`, the phone's msg-hotfix merged in): review M1 and D1 (the TCP guard never
reads from TCP; the proof is that the node's socket accepts a connection; the guard thread catches
everything; `getTcp`, used only by TCP builds, reads at most 4 MiB of body within a deadline and follows no
redirect; unit tests with a listener streaming endless bytes, a redirect and a drip), D3 (`server.py`'s
send guard and `NODE_TCP_GUARD` removed), D4 (`unix_http` takes an answer only whole; test with a node that
dies mid-answer), D2 (the runner's config refusal compares keys as the library reads them and refuses any
value but false or null), D5 (these docs), D6 (Gradle also refuses a variant that doesn't match the bundled
binary's patches; CI checks it).

After 0.5.20 (branch `sockets-e`, versions unchanged; review of 503b141, E1 to E5):
- E1: guard strikes count only after the node's "Running chain" line (or ten minutes); `TcpGuard.observe(...,
  counting)`, `NodeApi.guardRound`, `NodeService.servicesStarted`. Tests: `noStrikesBeforeTheNodeHasStartedItsServices`,
  and `theGuardNeverWritesToOrReadsFromTheTcpPort` (one guard round against a listener streaming endless bytes:
  not one byte sent to it, closed at once).
- E2/E4: the runner refuses any `/` outside a string in its config (comments), and removes the network-option
  environment variables before creating the node; the app writes all five network keys as `false` and checks them.
- E3: `getTcp` (TCP builds only) reads the whole answer, status line and headers included, through one size cap and
  one deadline over a plain socket. Test: `theTcpPathGivesUpOnDrippingHeaders`.
- E5: a transfer the node gave no answer about (status 0: a timeout or an answer cut short) says it may have been
  sent; the next send from that account is refused until its balance moves or three minutes pass; the page doesn't
  re-enable Send on that review. (Replaced on branch `send-hold-2`: see "Transfers" below.)
- `tests/node_socket_test.py` now counts connections to the old TCP port (with `NODE_TCP_GUARD` set as 0.5.17-0.5.19
  set it): zero; it fails on the 0.5.17 server.py.

## Transfers: known by what they spend and by their hash (branch `send-hold-2`)

Reviews DELTA4 to DELTA6 failed on one thing: telling a transfer's fate from the account's total. The app no longer
does that. Every transfer from a wallet key (a send, or setting an amount aside for a bridge) is made in the two
steps the node's API has, and is settled by its own identity.

What the real node does (CI probe runs 43494895877 and 43496529313, the pinned "api" node, Linux arm64; source at
f7ab0323):
- `POST /wallet/fund` builds, funds and signs a transfer and **submits nothing** (`handlers.rs` `fund`). Its answer
  names the notes it spends, in the form `/wallet/{pk}/balance` lists them, and the outputs (the payment and the
  change). It keeps those notes apart in memory: a second fund can't use them until they are seen spent, 10
  finalised blocks pass, or the node restarts (`services/wallet/src/lib.rs`, `pending_note_expiry_blocks`).
- `POST /mempool/add/tx` submits a signed transfer and answers **200 with an empty body**, also for one already in
  the pool, and for one whose notes are already spent. Its answer proves nothing.
- The same signed transfer submitted twice is in the pool once and lands once. Two different transfers that spend
  a common note can both be in the pool; exactly one lands.
- The hash is blake2b-256 of `MANTLE_TXHASH_V1` and the ops' binary encoding. The app computes it before it
  submits (`xfer_hash`); it matched the node's hash on every transfer tried, and the node's own test vectors
  (`tests/xfer_test.py`).
- `GET /cryptarchia/transaction/{hash}` only reads the pool's store (it answered 200 for a transfer that never
  landed), so it isn't used. `GET /cryptarchia/blocks_range` (one JSON object per line) lists the blocks with their
  transactions' hashes: that is the proof.
- The pool keeps a transfer 9 hours (`DEFAULT_TX_TTL`).

What the app does (`app/server.py`, "transfers from the wallet"):
1. Records the transfer (fsync'd) and its Activity entry, then asks `/wallet/fund`. Any failure of the fund sent
   nothing: the entry goes, the account is free.
2. Checks the funded transfer is the one asked for (its notes are the account's, one output of the amount to the
   recipient, the rest back to the account, a fee within 100,000), computes its hash, and saves the whole signed
   transfer. If it can't be saved, it isn't submitted.
3. Submits it. Whatever the answer, it submits **the same saved transfer** again every minute until its hash is in a
   block, or 30 minutes pass. It never funds a new one for the same send. A crash between steps 2 and 3 is picked up
   at the next start: the saved transfer is submitted then (CI job `node-socket`: `tests/xfer_real.py`, with the
   real node, kills the app there, starts it again, and the transfer lands once).
4. When one of its notes leaves the balance, it reads the chain since the transfer was funded: its hash in a block
   gives "in block" with the fee the funded transfer names. If the chain was read to its tip without the hash, a note
   it needs went elsewhere and it can never land: "not in a block". If the chain can't be read, nothing changes.
5. One transfer at a time per account: while one is unsettled and younger than 30 minutes, sends and bridges from that
   account are refused, with no text asking to send again.
6. At 30 minutes an unsettled transfer reads "can't tell: check your balance" and stops holding the account. It is
   no longer submitted, but it is watched until 10 hours after its last submit (the pool's 9 and one more): if it
   lands it reads "in block". Meanwhile a new transfer from that account goes to the network **only if it spends a
   note the old one spends** (then at most one of the two can land); otherwise nothing is sent and the page says why.
   At 10 hours it reads "not in a block".
7. A bridge deposit (`/channel/deposit`, unchanged) is settled by its note; any "sent" entry no record settles reads
   "can't tell" after 40 minutes. Nothing stays pending for good (DELTA6 M1, S4). Stopping a bridge during its split
   leaves the split to its own record (S2).

Time is the boot clock within the same boot (kernel boot id; where it can't be read, a boot clock not behind the
record), else the wall clock (S1). Records: `DATA_DIR/wallet-transfers.json`, owner-only, fsync'd; a file that can't
be read holds every account for 30 minutes.

Tests (`tests/xfer_test.py`, against `tests/fake_chain.py`, which models the pool, the 10-block reservation, a
restart dropping it, conflicting transfers of which exactly one lands, 200-with-nothing answers, lost answers and
realistic fees): the encoder vectors; fixed cases for DELTA6 P1, P1b (M1), P2, P3, P4, P5b, P5c/d, P6 (S1), P8 (S2),
a crash at every step, an outside spend, an unreadable chain and an unreadable file; and 2,000 seeded random runs
(5,000 run locally) checking after every step:
- I1: no new transfer reaches the pool beside one of the same account that may still land unless they share a note,
  and no payment made again after "can't tell" is paid twice;
- I2: no entry reads "in block" unless its hash is in a block;
- I3: no entry stays pending past 30 minutes;
- I4: the account is free within 30 minutes.
Each invariant was checked to fail when the code is broken the matching way (no overlap rule, settling on the
balance, no cap, funding anew, no hold).

Not covered: a wall clock set back and then a reboot, where the boot id can't be read (the age then reads short, and
the account is held longer than 30 minutes). Past 30 minutes, a new transfer that the node funds from other notes than
a transfer still in the pool is refused until that one settles (up to 10 hours): the money-safe side of I1 over I4.
