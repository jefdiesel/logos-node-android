# Slow or incomplete shutdown, and the node key is logged on a config parse error

**Version:** v0.39.2 (`liblogosdelivery`, C library, Android arm64 build of upstream's
`liblogosdelivery-android-arm64` target; and the `logosdeliverynode` macOS release). Some
observations on v0.40.0-rc.3 are noted below.

## 1. `logosdelivery_stop_node` never replies; `destroy` quarantines the context

A small C program creates a node, starts it, runs it for 1 to 16 minutes, then calls
`logosdelivery_ctx_stop_node` and waits for the reply. In every run (4 runs, Android arm64) the
reply callback never fired within 15 to 30 seconds. `logosdelivery_ctx_destroy` then logged:

```
ERR recycle drain timed out; the teardown never ran inFlight=1 timeoutMs=1500
ERR context quarantined; the pool slot and its threads leak, the library stays alive and its callbacks can still fire reason="in-flight handlers did not drain" cause=DrainTimeout
```

The process exits normally afterwards, but a clean stop takes about 20 seconds and does not
complete. An embedding app has to wait for that time, or kill the process.

The `logosdeliverynode` CLI on macOS behaves similarly:
- v0.39.2: it did not exit within 25 seconds of SIGTERM in any run (about 15 runs) and needed
  SIGKILL.
- v0.40.0-rc.3: it exited on SIGTERM in most runs, but not in 3 of about 14.

**Expected:** `stop_node` replies once the node has stopped, and SIGTERM stops the CLI within a
few seconds.

## 2. The whole configuration JSON, node key included, is logged on a parse error

When `logosdelivery_create_node` gets a configuration it cannot parse, it logs the full input:

```
ERR Failed to parse Logos Delivery configuration JSON error="Unrecognized messagingOverrides option(s) found: ..." configJson="{... \"nodekey\":\"<64 hex digits>\" ...}"
```

`nodekey` is the node's private key. On Android, that log line can end up in logcat or in app
logs that users share in bug reports.

**Expected:** log the error and the offending key names only, or redact `nodekey` (and any other
secret fields) before logging the configuration.
