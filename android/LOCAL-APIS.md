# Local APIs: what other apps on the phone can reach

The app runs three HTTP servers on the phone's loopback address:

| Port | What | Who uses it |
|---|---|---|
| `127.0.0.1:18180` | the blockchain node's own API (node 0.3.4) | `server.py`; the app's Kotlin status calls (NodeService, Battery, NodeActivity) |
| `127.0.0.1:18645` | the messaging (Waku) node's REST API, from `liblogosdelivery` | `server.py` only |
| `127.0.0.1:18190` | the wallet server, `app/server.py` in the app's `:wallet` process | the app's WebView; the app's `names` child (`/lez-rpc/<secret>` only) |

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
| 18180 from a website | Before this change the node answered CORS with `Access-Control-Allow-Origin: *` (with no `cors_origins` configured, `backend.rs` uses `allow_origin(Any)`, and the app configured none), so a page in the phone's browser could send the same JSON POSTs, subject only to the browser's local-network rules. | Source (`backend.rs`, `serve`). With the fix, the probe's preflight from another origin gets `Access-Control-Allow-Origin: http://127.0.0.1:8090` (the configured origin, whatever the request's), which a browser refuses for any other page. |
| 18645 messaging REST | **Take incoming messages away**: `GET /messaging/v1/events/received` returns the buffered messages *and clears them* ("evict-after-poll", `rest/messaging_api/event_cache.nim` at logos-delivery `57e04dc`), so an app polling it gets the sealed messages and the wallet never sees them. The same for `/messaging/v1/events/send` (send status). Publish on any topic, unsubscribe the wallet's inbox topic (`server.py` subscribes again on its next round), read the subscribed topics. The payloads are sealed by the page, so it reads ciphertext, not chats. | Source (upstream REST handlers and event cache at the pinned commit; `Messaging.kt` writes `"rest": true`, `127.0.0.1:18645`). Not run on a phone. |
| 18645 from a website | The drain above is a plain GET, which a page can send without CORS (it never sees the answer, but the buffer is cleared all the same), subject to the browser's local-network rules (not verified). | Source; not run. |
| 18190 wallet server | Before a PIN exists: **set the PIN** and get a session, then do anything a session allows (send, export the messaging key). Any time: guess PINs (5 tries, then 5 minutes), lock the wallet, read `/api/status`, `/api/wallet`, `/cryptarchia/info`, `/network/info`. Not: read the WebView's session token; call `/lez-rpc/` without its secret. | **Reproduced** from a second process on a computer, against `server.py` 0.9.13 in Android mode: `POST /api/wallet/setup` with forged `Host`/`Origin` returned a session; `POST /api/wallet/lock` and `GET /api/status` answered. |

## The wallet server (18190): closed in this branch

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
the port answering). Otherwise the cover stays up and says the wallet didn't start. Left open: if the
app's own server stopped while the page is shown and another app took the port within the watchdog's
interval, a few requests (with the cookie) could reach it before the cover comes up; the key is useless
to it, since the server it guards is gone.

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

## The node API (18180): needs a node patch

Node 0.3.4 cannot be configured to close it: `api.backend.listen_address` is a TCP socket address
(`config/api/serde.rs`, `core::net::SocketAddr`), the backend binds a `TcpListener` (`backend.rs`),
and there is no authentication setting. The route table is fixed at compile time (`api_routes!`), so
the wallet routes can't be turned off by configuration either.

| Option | Protects | Costs | Verdict |
|---|---|---|---|
| (a) **Unix domain socket** in the app's private files directory | every other app (file mode 0600 inside a 0700 directory with the app's own SELinux category); websites (no TCP port at all) | node patch (small: the router is the same, only the listener changes; axum 0.8 serves a `UnixListener`); every client must speak HTTP over the socket: `server.py`'s `node()` and three Kotlin call sites | **Recommended.** Patch written: `0002-api-unix-socket` |
| (b) Bearer token on every request, TCP kept | every other app that can't read the token | node patch (a middleware); the token must reach the node (environment or config file) and every client; the port stays open, so the HTTP parser stays exposed and a leaked token is enough | second choice |
| (c) An authenticating reverse proxy in front | nothing: the node's own port stays reachable beside the proxy | — | does not help |
| (d) TCP plus a peer check (SO_PEERCRED is Unix-socket only; on TCP, matching `/proc/net/tcp` uids is racy) | — | patch, fragile | no; on a Unix socket the file mode already does it |
| (e) No listener: HTTP over stdin/stdout or a socketpair inherited from the parent | every other app | a larger patch, and only the parent process (NodeService, main process) could talk to it, while `server.py` lives in the `:wallet` process | no |
| (f) No patch: firewall the port | — | needs root (iptables owner match) | impossible in an app |

**Can the wallet endpoints be disabled and signing done elsewhere?** Not without a patch, and not as
a short-term plan: the node selects notes and makes the zero-knowledge signatures with the keys it
loaded; moving that into the app means reimplementing the wallet.

**Can the keys stay out of the node until a send?** No. The node reads its keystore once at start
(`config/keystore.rs`); no API adds a key at run time; the keystore also holds the node's own keys.
Keeping them out would mean restarting the node for each send, minutes of replay each time on a phone.

**The patch** (branch `node-patches-api`, `native/patches/0002-api-unix-socket.patch`, README entry
in `native/patches/README.md`): with `LOGOS_API_UNIX_SOCKET=<path>` set for the node process, the API
listens on that socket (0600; a stale socket is replaced, any other file is left alone) and on **no**
TCP port. Unset: upstream behaviour. Routes, handlers, wallet logic and formats are unchanged. It is
built alone as the `-api` variant (`apply-patches.sh --only`), so it can ship without patch 0001, and
together with 0001 in `-patched`. Its tests run in `patched-crate-tests`. **The app does not use it
yet**: a patched node needs an independent review first. **Not verified on a device**: creating and
connecting to a Unix socket inside the app's files directory under Android's app sandbox and SELinux
(expected to work, as the app's own user in its own directory, but not tried).

**Switching the app over, after review** (not done):

1. `android/node.properties`: the `api` variant (or `patched`) and its sha256.
2. `NodeService`: start the node with `LOGOS_API_UNIX_SOCKET=<files>/node/api.sock` (about 50
   characters, well under the 108-byte limit).
3. `server.py` `node()`: when `NODE_API` is `unix:<path>`, HTTP over an `AF_UNIX` socket
   (`http.client.HTTPConnection` with its `connect` replaced); Linux keeps `http://`.
4. Kotlin: the three status calls (`NodeService.kt`, `Battery.kt`, `NodeActivity.kt`) through a small
   HTTP/1.1 client over `android.net.LocalSocket` (file-system namespace).
5. A check that nothing listens on 18180 any more.

**Interim, until then:** nothing real is possible without the patch. A random port chosen at each
start is **obscurity only**: an app finds it by trying the 64,000 loopback ports, which takes about a
second; it is not done. What is done now is real but narrow: the node's CORS lists only the wallet
page's origin (`cors_origins` in the config the app writes, as `install.sh` does with
`--http-cors-origin`), so a website can no longer have the browser send JSON to the wallet endpoints.
Two POST routes take no JSON body (`/leader/claim`, `/pow/claim`); a website can still trigger those
as "simple" requests whatever CORS says. They claim rewards for the node's own configured target and
move nothing out.

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

## Linux and Termux

`server.py` is shared. On Linux the app is for the computer's own browser; another program running as
any user on that computer can reach `127.0.0.1:8090` the same way, which the Linux install accepts
(a desktop is one user's machine, and the browser can't be given a secret by an app). **Termux runs
on Android**, so a Termux install has exactly the phone exposure described above on `8080` (node)
and `8090` (wallet) and nothing in this branch changes it: Chrome there can't be handed a cookie. A
fix for Termux would print a one-time link that sets the cookie on first visit; not done. The node
patch helps Termux only if Termux runs the patched node.

## What this branch changes, for review

- `app/server.py`: `APP_KEY`/`APP_KEY_COOKIE`/`SERVING` (top), `Handler.key_ok`, `Handler.public_file`,
  `Handler.KEY_REFUSED`, one check at the top of `do_GET` and one in `do_POST` after the forwarder,
  `SERVING` set and cleared around `serve_forever()` in `main()`.
- `logos_embed.py`: `serving()`.
- `LogosApp.kt`: `WalletServer.appKey`, `APP_KEY_COOKIE`, `appKeyCookie()`, `ours()`, `APP_KEY` in the
  environment given to `server.py`, the start-up log waits for `ours()`.
- `WalletActivity.kt`: the page loads only when `ours()`, with the cookie set first (`loadWhenReady`);
  the watchdog reloads when not `ours()`; `walletSetting()` sends the cookie.
- `NodeFiles.kt`: `cors_origins` in the node config.
- Tests: `tests/app_key_test.py`, `tests/app_key_ui.mjs`, `tests/local_api_probe.py`, wired into
  `install-test.yml`; the `wallet-send` job's node config now carries `cors_origins` in the app's
  shape and is checked with `--check-config`.
