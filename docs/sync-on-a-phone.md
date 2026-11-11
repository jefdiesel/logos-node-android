# Sync measurements on the test phone

All on one phone: Pixel 8, 8 GB RAM, Android 17, Linux Terminal route, `logos-blockchain-node` 0.3.4 (the unmodified `linux-aarch64` release).

## Syncing from the first block

- Speed: about 600 to 800 blocks a minute on one core.
- Memory grows with the chain during the first catch-up: about 57 MB per 1,000 blocks, 2.0 GB at block 32,000. That projects to about 4.7 GB at block 82,000.
- The sync did not finish. Android stopped the Linux box three times:
  1. Android's low-memory killer, with the Linux box set to 5.3 GB (the most the Terminal app offered).
  2. The low-memory killer again, with the box at 4 GB, when Chrome was opened.
  3. A background "excessive cpu" kill of the Terminal app's child process, four minutes after another app was put in front of it. Developer options → **Disable child process restrictions** stops this one.

## Restarts

Every restart replays all blocks stored since the last final block before the node answers again (a final block is one the network has settled for good):

- 17,211 blocks took 12.5 minutes.
- A replay of 33,003 blocks never finished before the next kill.
- After the [start from a synced node's database](start-from-a-synced-database.md), the node replayed only about 1,000 blocks and was Online in about a minute.

## Memory once synced

- A desktop reference node that had been up 8 days: 927 MB.
- The phone's node, after the start from a synced database: settled around 1.4 to 1.6 GB.

## Our explanation, not confirmed

During the first catch-up nothing becomes final, so the node releases nothing: memory keeps growing and the replay after each restart keeps getting longer. **This is an inference from the measurements above. It has not been confirmed in the node's source.**

## Phone settings

- Terminal → gear → Advanced → Memory size about 2500 MB left the phone about 1 GB free. At 4000 MB it had about 450 MB free, and Android killed the Linux box when another app opened.
- Terminal → gear → Advanced → Keep awake (it offers up to 1 day).
- After changing a setting, the Terminal app's own "Restart" left the port pass-through broken: the page refused connections although Port control showed the port on. Fully closing the Terminal app and opening it again fixed it.
