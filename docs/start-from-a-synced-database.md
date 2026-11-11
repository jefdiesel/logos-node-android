# Starting from a synced node's database

This is how the test phone (Pixel 8, Linux Terminal route) reached the tip of the chain after syncing from the first block kept running out of memory (see [the README](../README.md#why-not-sync-from-the-first-block)). It is a method, not a download: **this repo does not publish a database copy.** You need access to another node that is already synced.

It was done on the Linux Terminal route only. The Termux route has not been tried.

## What you are trusting

The node stores the chain in a RocksDB database (an on-disk key-value store) in its `state/db` folder. If you start from someone else's copy, your node takes the history up to that point from them instead of checking it from the first block. You rely on whoever made the copy for that part of the history. From that point on, your node checks new blocks itself.

The copy holds no wallet keys: the phone's node keeps its own keys, which live outside `state/db`.

## 1. Copy the database of a synced node

- The source node must run the **same node version** as the phone (0.3.4 here) on the same network.
- Copy its `state/db` folder, **leaving out RocksDB's own `LOG*` files** (its text logs). At block 82,800 the copy was about 1 GB.
- On macOS with APFS, the files can be cloned with `cp -c` while the source node keeps running. Because the node keeps writing, repeat the copy until the folder listing is the same before and after it.

## 2. Put it in place on the phone

In the Terminal's Linux box, after running `install.sh`:

1. Stop the node: `sudo systemctl stop logos-node`
2. Move the node's own `~/node/run/state/db` out of the way (or delete it).
3. Get the copied folder into the Linux box and put it at `~/node/run/state/db`. The files must belong to your user in the Linux box, because the `logos-node` service runs as that user.
4. Start the node: `sudo systemctl start logos-node`

## What to expect

On the test phone the node replayed only about 1,000 stored blocks and was Online in about a minute, then followed the chain tip at the same height as a desktop reference node, with 130+ peers. Once synced it used around 1.4 to 1.6 GB of memory.

Keep the phone settings from the [install steps](../README.md#install-linux-terminal) (memory size about 2500 MB, Keep awake, child process restrictions off), so Android doesn't stop the Linux box.
