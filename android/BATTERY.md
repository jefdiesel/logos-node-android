# Mobile mode (battery)

The app runs two native processes: the Logos blockchain node and the Messaging (Waku) node. Mobile
mode makes the blockchain node cheaper on battery and on mobile data **without any loss the user could
notice**. The node stays a correct, current follower, messages arrive as before, sending works at once,
and the wallet is correct the moment the app opens. Anything that trades quality for battery is listed
under "Options with a cost". None of those are built.

## What it costs today

One hour unplugged on a Pixel 8 (app 0.5.9, Wi-Fi, Messages on, screen on 4 min):

| Measure | Value |
| --- | --- |
| Battery | 100 → 95 %, 306 mAh in the hour (about 13 h from full to empty) |
| This app's estimated share | about 82 mAh: CPU 53.5, Wi-Fi 15.2, wake lock 13.1. The next app used 2.4 mAh. |
| App CPU, 59 min | 26 min user + 19 min kernel. The node was about 25 min of that, Waku about 8.5 min, wallet Python about 1.5 min. |
| Wake lock `logosnode:node` | held for 100 % of screen-off time, so the phone never slept |
| Wi-Fi | 94 MB received, 154 MB **sent**. The node serves blocks and gossip to about 130 peers. |

The node uploads more than it downloads and holds about 130 peers. So most of its cost is work it does
**for other nodes**. Mobile mode starts there.

## The setting

Settings → Node → **Mobile mode** offers three choices. The page shows it only inside the Android app.

- **Auto** (the default). The light profile runs on battery, and also on a metered network (mobile data)
  even while charging. The full profile runs only while plugged in **and** on an unmetered network.
- **Off**. The full profile always, as before this change.
- **Always lighter**. The light profile always.

Two other ways in:
- From adb:
  `am start-foreground-service -n io.github.jefdiesel.logosnode/.NodeService -a io.github.jefdiesel.logosnode.MOBILE_MODE --es mode auto|off|light`
- The Node screen shows a line with the setting and what it does now.

## The two profiles

| Profile | Node config (`user_config.yaml`) | Messaging node |
| --- | --- | --- |
| Full | the node's own defaults, as before | unchanged |
| Light | `network.backend.swarm.gossipsub.gossip_lazy: 3`, `gossip_factor: 0.0`; `network.backend.swarm.chain_sync.max_inbound_requests: 1` | unchanged |

The light profile changes only what the node **sends to others**. It changes nothing the node receives,
checks or publishes itself. The source for each lever is in the next section. libp2p file names refer to
`libp2p-gossipsub` 0.49.5, the version in the node's `Cargo.lock`. Node file names refer to
`logos-blockchain` tag `0.3.4`.

### Gossip fan-out: `gossip_lazy` 6 → 3, `gossip_factor` 0.25 → 0

- **What it does.** On every heartbeat (1 s), gossipsub sends IHAVE lists of recent message ids to
  `max(gossip_lazy, gossip_factor × non-mesh peers)` peers, per topic (`behaviour.rs:2563-2620`,
  `emit_gossip`). With about 130 peers that is about 31 peers a second for each topic. Each IHAVE can
  bring back an IWANT, which this phone then answers by uploading the whole message.
- **What it doesn't touch.** These two values are read **only** in `emit_gossip`.
  - Receiving IHAVE from other peers (`handle_ihave`, `behaviour.rs:1207`) does not use them.
  - Neither does asking for missing messages, or answering IWANT (`handle_iwant`, `behaviour.rs:1326`).
  - The mesh is unchanged, so blocks reach this phone over the same number of mesh links as before.
  - Its own messages (a wallet send) still go to every subscribed peer, because `flood_publish` stays on.
  - Recovery of a missed block through other peers' gossip depends on **their** settings, not this phone's.
- **Expected effect.** Fewer IHAVE packets (Wi-Fi wake-ups) and fewer IWANT uploads from this phone.
- **Risk.** None to this phone's view of the chain. The network keeps slightly less redundant gossip from
  one phone.
- **How to measure.** `uid_tx_bytes_*` and `node_cpu_ms_*` in the counters, light against full, together
  with the quality figures below.

### Serving blocks: `chain_sync.max_inbound_requests` 10 → 1

- **What it does.** This limits how many block downloads the node serves to **other** nodes at once, and
  how many inbound requests it reads at once. The default is 10 (`nodes/node/binary/src/config/network/serde/chainsync.rs:31-39`).
  The value is NonZero, so serving cannot be switched off.
- **What happens to the extra requests.** A request over the limit gets a clean close of its stream
  (`consensus/cryptarchia-sync/src/libp2p/behaviour.rs:282, 346`). Once a request has been read, tip
  requests are not counted against the download limit (`:354`). The read-phase limit (`:282`) applies to
  every incoming stream before its type is known, though. At 1, a second stream that arrives while one is
  still being read is closed, even if it is a tip request. Those requests come from other peers; the
  phone's own requests are not affected.
- **What it doesn't touch.** The phone's own downloads (catch-up, orphan blocks, tip poll) are outbound
  and are not counted against this limit. No code in the downloader or in chain-network's libp2p adapter
  bans or scores a peer for a rejected stream.
- **Expected effect.** Less upload when peers sync from this phone, which is where most of the 154 MB/h
  sent is suspected to come from.
- **Risk.** Peers that are syncing go to other providers. Nothing changes for this phone.
- **How to measure.** As above. For this lever alone, run with `light.max_inbound_requests=10` in
  `profile.txt` (see below) and compare.

## When the profile switches

A running node changes profile by restarting on the new config. A restart replays the blocks stored after
the last irreversible block (about 1,000 blocks, about 30 s of CPU). The node then goes back to Online.
That took under a minute on a phone running with `bootstrap.txt` overrides (60 s bootstrap, 24 h grace),
when the node was Online before and off for a short time. With the app's defaults (the node's own 1 h and
20 min) it is not measured yet, but a restart of seconds is well within the 20-minute grace period.
During that time the wallet cannot send. So a switch happens only when nobody can notice it:

- the charger and the network have held still for **60 s** (a loose cable never restarts anything);
- at least **5 min** have passed since the previous switch;
- the node has run for at least 3 min and has been **Online** on readings at least 90 s apart. The node
  saves its state once a minute, and a restart before a saved Online state would start the one-hour
  bootstrap wait again;
- the **screen is off**;
- the wallet is not busy, read from the wallet's own files without changing them:
  - not open: `files/node/wallet-visible` is touched every 10 s while the wallet screen shows;
  - no bridge in progress: `wallet-bridge.json` `state` is in `splitting|ready|depositing|sent`, with
    `updated` under 2 h old;
  - no send waiting for its block: `wallet-history.json` has a `kind: sent`, `status: pending` entry under
    1 h old;
  - no name change running: no `libnames.so` process.

These rules are `ProfileSwitch` and `WalletBusy` in `Battery.kt`, tested in `BatteryTest.kt`.

The user's own change in Settings skips the 60 s and 5 min waits, but none of the others. While a switch
waits, Settings and the Node screen say what it waits for.

A node that **starts** (app start, user's Start, crash restart) simply starts on the right profile, at no
extra cost. Setting `NodeService.SWITCH_BY_RESTART` to false makes that the only way a profile changes: mobile
mode then never restarts the node. A phone that stays up for days then keeps the profile it started with.

Two safeguards protect the light config:
- **Before first use.** It is checked with the node binary's own `--check-config`, on a copy next to
  `keystore.yaml`. The node refuses unknown keys (`config/mod.rs:192, 232`). If the check fails, the node
  runs full.
- **After two quick exits.** If the node stops twice within 90 s on the light profile, it runs full until
  the setting changes. The counters show `light_failed=true`.

**Wake lock.** As before, the wake lock is held while the supervisor runs the node. That includes the
config check, a profile restart and a crash restart's wait, because a phone asleep there could keep the
node down past its grace period. It is now let go while a snapshot import holds the node, which keeps its
own lock. The light profile does not let the phone sleep, because a sleeping node falls behind.

## Counters (for measuring)

All are under the app's `files/node/`. Read them with `adb shell run-as io.github.jefdiesel.logosnode cat files/node/<name>`.

**`battery-stats.txt`**, updated once a minute while the node runs. Every key ending `_full`, `_light`
or `_stopped` belongs to that profile.

| Key | Content |
| --- | --- |
| `seconds_*` | time spent in the profile |
| `node_cpu_ms_*`, `waku_cpu_ms_*`, `service_cpu_ms_*` | CPU of each process, from `/proc/<pid>/stat` |
| `uid_rx_bytes_*`, `uid_tx_bytes_*` | the app's network bytes (TrafficStats for the app's uid) |
| `waku_rx_bytes_*`, `waku_tx_bytes_*` | the messaging node's own counters. The node's bytes ≈ uid − waku. |
| `node_log_lines_*`, `node_log_bytes_*` | what the node printed to stdout |
| `tip_age_s_sum_*`, `tip_age_samples_*`, `tip_age_s_max_*` | the age of the node's latest block while Online (quality) |
| `switches` | profile restarts |
| `waits_busy` | minutes a switch waited on the wallet or the screen |
| `light_failed` | whether the light config was given up |
| `node_peers`, `node_connections`, `node_height`, `node_state` | the latest readings |
| `mode`, `profile`, `plugged`, `unmetered`, `why`, `waiting_for`, `wakelock_held`, `updated` | the latest state |

The other files:

- **`battery-samples.csv`**: one line a minute with time, profile, state, height, tip slot, current slot,
  tip age, peers, and the CPU used that minute. Use it for lag against a reference node at the same minutes.
- **`open-times.txt`**: one line each time the wallet screen opens. It gives the node's state and tip age
  then, and how long until it answered Online.

Reset everything with the MOBILE_MODE action and `--ez reset true`. The reset happens at the next minute's
count.

**`profile.txt`** holds per-phone overrides for measured runs: lines like `light.gossip_lazy=6`,
`light.max_inbound_requests=10`, `light.mesh_n=4`, `full.max_inbound_requests=4`.
- The keys allowed are `mesh_n`, `mesh_n_low`, `mesh_n_high`, `mesh_outbound_min`, `gossip_lazy`,
  `gossip_factor` and `max_inbound_requests`.
- Values gossipsub would refuse (`outbound_min <= low <= n <= high`, `2 × outbound_min <= n`,
  `config.rs:1109-1114`) are dropped.
- The file is read at each node start.

## What was looked at and left out

These are levers found in the source. None is in the light profile, because none can be shown free of
quality loss from the source alone. Each needs a measured run first.

| Lever | Evidence | Why it's out |
| --- | --- | --- |
| Peer and connection limit | The swarm has no connection-limits behaviour and no config for one (`libp2p/src/swarm.rs:72-94`). Idle connections close after 5 min (`:34, :93`). | Not configurable. Needs a node patch (upstream draft). |
| NAT port mapping (UPnP/PCP/NAT-PMP) | NAT is `traversal` by default, with mapping and an autonat server always on (`config/network/serde/nat.rs:13-22`, `libp2p/src/behaviour/mod.rs:52, 102`). The only alternative, `static`, needs a real public address. | A phone that maps a port on the home router becomes reachable and serves more peers. Probably the biggest lever, but there is no supported "off". Needs a patch or a check of the node's NAT log lines first. |
| Gossipsub mesh 6 (5..12) → 4 (3..6) | Valid by `config.rs:1109-1114`. Keep-alive applies only to mesh peers (`handler.rs:456`). | The mesh is how blocks reach the phone. Fewer links could make the first copy of a block arrive later. Try with `profile.txt` and compare tip age. |
| Kademlia periodic bootstrap (5 min default) → 30 min or off | `libp2p/src/config/kademlia.rs:52, 121`; user config `periodic_bootstrap_interval` | Discovery only, but fewer fresh peers over hours may slow catch-up. |
| Identify interval | user config `identify.interval` (libp2p default 5 min) | Small expected effect, untested. |
| Node log to stdout | INFO goes to both a file and stdout by default (`config/tracing/serde/logger.rs:29-30`). The app writes every stdout line to `output.log`. | Both have readers: the web app reads the file log (`app/server.py:103-121`), and the Node screen's start-up lines come from stdout. Measure `node_log_lines_*` first. |
| Blend | A node that is not a blend member runs edge mode, on demand, with no cover traffic (`services/blend/src/mode.rs:56-95`). | Nothing to save. |
| Tip-poll watchdog | On by default; it catches up when the tip lags 3 block intervals (`services/chain/chain-network/src/sync/config.rs:52-53`). | Kept as is: it is the backstop for every lever. |

### Messaging (Waku) node

The Messaging node is v0.40.0-rc.3, Core mode on shard 7, with filter and lightpush off (`Messaging.kt`
`MessagingSettings.EXTRA`).
- **Its preset, `logos.test`, turns on more.** It enables mix, Kademlia discovery, discv5 and p2p
  reliability (`logos_delivery/waku/factory/networks_config.nim:159-200`). `max-connections` defaults to
  150 (`tools/confutils/cli_args.nim:250`).
- **Where the CPU goes.** Its CPU (about 8.5 min an hour) is the relay itself, about 45 peers, and the
  discovery protocols.
- **Not changed in either profile:**
  - **`mix: false`.** Mix also changes how sends are routed (`messaging/delivery_service/send_service/mix_processor.nim`), so this is not free.
  - **`max-connections: 20`.** It works on rc3 on a desktop; 10 crashes it (`messaging/upstream-drafts/01-…`). It cuts peers to 20 or fewer. Message flow at 7–17 peers was seen on a desktop, but never measured on the phone.
  - **`rendezvous: false`.** It is not clear from the source whether this also stops the phone's own rendezvous lookups.
  - **Edge mode** (filter + lightpush + store instead of relay). About 0.32/0.04 MB/min against 0.57/0.45 on a desktop (`messaging/README.md`). It is a different delivery path, untested on rc3 on the phone.

## Options with a cost (not built)

These trade quality for battery. Each one needs the user's yes and a measured run.

- **Smaller mesh, slower discovery, fewer Waku peers.** See the tables above.
  - Expected cost: possibly slower block arrival or catch-up. Measure the tip age and the lag against a
    reference node.
- **Release the wake lock while the node runs.** The phone could sleep between packets. With about 130
  peers, packets arrive often, so the saving is uncertain.
  - QUIC connections time out while the CPU sleeps, and the node falls behind until the next wake-up.
  - Cost: a tip that lags by the sleep length, reconnects, and a wallet that may open behind.
- **Saver: sync in bursts.** The node pauses between catch-ups, for example 2 min running every 15 min.
  The Messaging node keeps running, so messages still arrive.
  - **Stop/start.** Each burst pays the restart: about 30 s of CPU to replay about 1,000 blocks, then up
    to a minute before Online. If the node was off longer than the grace period (default 20 min), it
    waits the whole prolonged bootstrap period (default 1 h) before it is Online and can send. The pause
    must stay under the grace period.
  - **SIGSTOP/SIGCONT.** Freezing the process avoids the replay and keeps the node's Online state. But
    peers drop it while frozen, and on resume it reconnects and catches up through tip poll. Whether its
    slot timers fire in a burst after a long freeze has not been read or measured.
  - **Saving.** The node used about 25 s of CPU per minute. A 13-minute pause saves at most about 5.5 min
    of CPU per cycle, minus the catch-up and reconnect cost.
  - **Quality cost.** The wallet is up to one pause behind until it catches up. Opening the app must
    resume the node at once (an intent from the wallet screen) and show "catching up" until Online and
    current. The time-to-usable figure in `open-times.txt` is the measure.
  - **Status.** Not built, because it is a visible loss.

## Measuring

The phone must be unplugged for a run, and USB counts as charging. So run no adb command between the
start and the end of a run.

### Before each run (plugged in)

```
adb shell am start-foreground-service -n io.github.jefdiesel.logosnode/.NodeService \
  -a io.github.jefdiesel.logosnode.MOBILE_MODE --es mode <off|light> --ez reset true
# wait 2 minutes: the mode applies once the screen is off and the node is Online; the reset at the next minute
adb shell input keyevent KEYCODE_SLEEP
adb shell run-as io.github.jefdiesel.logosnode cat files/node/battery-stats.txt   # profile= as wanted, light_failed=false
adb shell run-as io.github.jefdiesel.logosnode grep -A6 'swarm:' files/node/user_config.yaml   # light: the three keys; full: nothing
adb shell dumpsys batterystats --reset
adb shell dumpsys battery | grep -E 'level|charge counter'
```

### The runs

Do one hour unplugged for each, under the same conditions: Wi-Fi, Messages on, the screen off except for
the opening below.
- **Run A:** `mode off`, the full profile, the baseline.
- **Run B:** `mode light`, the light profile.

During each run:
- From a second wallet, send a Messages message to the phone's name every 10 minutes and note the send
  times.
- At about 55 min, open the app once (the time-to-usable reading), then lock it again.

### After each run (plug back in)

```
adb shell dumpsys battery | grep -E 'level|charge counter'
adb shell dumpsys batterystats --charged io.github.jefdiesel.logosnode > run.txt
adb shell run-as io.github.jefdiesel.logosnode cat files/node/battery-stats.txt
adb shell run-as io.github.jefdiesel.logosnode cat files/node/battery-samples.csv > samples.csv
adb shell run-as io.github.jefdiesel.logosnode cat files/node/open-times.txt
adb shell run-as io.github.jefdiesel.logosnode cat files/wallet/wallet-inbox.json \
  | python3 -c 'import json,sys; [print(i.get("received")) for i in json.load(sys.stdin)["items"]]'
adb shell run-as io.github.jefdiesel.logosnode grep -E 'mobile mode|node started on' files/node/output.log
```

### What to compare (A against B)

**Cost:**
- The app's mAh and the wake-lock time (`run.txt`).
- `node_cpu_ms_*` per hour.
- `uid_tx_bytes_*` and `uid_rx_bytes_*` minus the waku bytes.
- `node_peers`.

**Quality:**
- **Tip lag against the network.** For each minute in `samples.csv`, compare the phone's height with a
  reference node's height at the same minute (any other node's `/cryptarchia/info`, logged once a
  minute). Report the mean and maximum blocks behind.
- **Tip age.** Report `tip_age_s_sum / tip_age_samples` and `tip_age_s_max`.
- **Message delay.** The inbox `received` time minus the send time. That time is when the wallet's
  server took the message from the Messaging node. If the wallet's process wasn't running, that is when
  the app was opened, so open the app the same way in both runs. The Messaging node's config is the same
  in both profiles.
- **Time-to-usable.** `online_after_ms` in `open-times.txt`.

**What confirms the light profile:**
- the node's upload (uid tx − waku tx) is clearly lower in B;
- node CPU is lower or equal;
- the mean and maximum blocks behind, the tip age, the message delay and the time-to-usable are the same
  as in A, within the spread between two A runs.

**What refutes it:**
- any quality figure worse beyond that spread: switch the default to Off;
- or no cost difference: the lever does nothing, so drop it.

**To tell the two levers apart,** run B again with `light.gossip_lazy=6` and `light.gossip_factor=0.25`
in `files/node/profile.txt` (only `max_inbound_requests` changes), then with
`light.max_inbound_requests=10` (only the gossip changes).

**Logging and NAT.**
- `node_log_lines_*` per hour shows whether logging is worth a lever.
- `grep -iE 'nat|external addr|mapped|gateway' files/node/logs/*` shows whether the phone mapped a port
  on the router and became reachable.

### Checking the switch itself (plugged in, about 15 min)

1. Run `mode auto`, then `adb shell dumpsys battery unplug` and `adb shell input keyevent KEYCODE_SLEEP`.
   - After about 1 min plus the checks, `output.log` shows `restarting the node on the light profile`, then
     `node started on the light profile`.
2. Run `adb shell dumpsys battery reset`.
   - After 60 s it waits for the 5 min gap, then switches back to full.
3. Turn the screen on and open the wallet during a pending switch.
   - `waiting_for` shows `the screen is on` or `the wallet is open`, and no restart happens.
4. Mark the Wi-Fi network as metered in the phone's settings, while charging.
   - The node switches to light.
