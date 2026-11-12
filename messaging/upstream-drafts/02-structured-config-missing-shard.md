# Library config: `shard` (and `rest`, `filter`, `lightpush`) only work in the legacy flat shape

**Versions:** v0.39.2 and v0.40.0-rc.3, `liblogosdelivery` (C library).

## What happens

`logosdelivery_create_node` accepts two config shapes (`logos_delivery_conf_json.nim`):

- the structured shape, `{"mode", "preset", "messagingOverrides", "channelsOverrides"}`, which
  `library/README.md` documents;
- the flat shape, with node options at the top level, which the parser marks as legacy
  (`[Legacy flat JSON config] ... Delete this proc and its call site to drop support`).

`messagingOverrides` only accepts `MessagingClientConf` fields. Passing `shard`, `rest`,
`rest-address`, `rest-port`, `filter` or `lightpush` there fails with, for example:

```
failed parseLogosDeliveryConf Unrecognized messagingOverrides option(s) found: rest-address, rest-port, rest
```

The same keys work in the flat shape, for example:

```json
{"mode":"Core","preset":"logos.test","shard":[7],"filter":false,"lightpush":false,
 "rest":true,"rest-address":"127.0.0.1","rest-port":18645}
```

## Why it matters

Since PR #4513 (v0.40.0), `--shard` limits a relay node to the shards it names. That is the
single biggest bandwidth lever for a relay node. On `logos.test`, measured on one afternoon,
a relay on all 8 shards moved tens of MB per minute, while a relay on one quiet shard moved
under 1 MB per minute.

A library user (a mobile app embedding the node) can only reach that lever through the shape
that is marked for removal. With the structured shape, the node always relays every shard.

## Request

- Add `shard` (subscribed shards) to `messagingOverrides`, or another supported key that limits
  the relay shards.
- Consider adding `rest`, `rest-address`, `rest-port`, `filter` and `lightpush` as well. Mobile
  relay nodes want filter and lightpush serving off and a local REST port.
- Until then, keep the flat shape, or document which options are only reachable through it.
