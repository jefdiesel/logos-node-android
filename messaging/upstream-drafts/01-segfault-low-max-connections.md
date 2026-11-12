# Node crashes with SIGSEGV when `--max-connections` is below the relay-peer minimum

**Version:** v0.40.0-rc.3 (`logosdeliverynode` from the release's `nwaku-arm64-macos-v0.40.0-rc.3.tar.gz`), macOS arm64.

## What happens

Starting the node with a small `--max-connections` logs a configuration error and then crashes,
instead of exiting with that error:

```
logosdeliverynode --preset=logos.test --entry-layer=channels --shard=7 --max-connections=10 \
  --filter=false --lightpush=false --mix=false --enable-kad-discovery=false \
  --peer-exchange=false --rendezvous=false --nat=none ...
```

The log ends with:

```
INF ... Initializing node                          file=node_factory.nim:523
ERR ... Wrong relay peers config                   file=peer_manager.nim:1392 error="Doesn't fulfill minimum criteria for relay (which increases the chance of the node becoming isolated.)\n    relayPeers: 5, should be gre...
INF ... Initializing networking                    file=waku_node.nim:374 addrs="@[/ip4/0.0.0.0/tcp/..., /ip4/0.0.0.0/udp/.../quic-v1]"
SIGSEGV: Illegal storage access. (Attempt to read from nil?)
```

The process exits with signal 11. With `--max-connections=20` and the same other flags, the
node starts and runs normally.

## Expected

A clean exit with the configuration error, for example "max-connections=10 gives 5 relay peers,
the minimum is N; raise max-connections or relay-service-ratio". The error is already detected
(`peer_manager.nim:1392`), but start-up continues and then dereferences something nil.

## Why it matters

Mobile and other low-resource users lower `max-connections` to save bandwidth, so they are the
ones who hit this. It would also help to document the smallest value that works for a relay node.
