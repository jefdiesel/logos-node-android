# Sending on LEZ 0.4 from the phone (the LEZ 0.4 signer)

The app carries a second LNS command line, `names` from the logos-names 0.4 line, next to the LEZ 0.3 one
(android/NAMES.md), and sends PUBLIC transactions on our LEZ 0.4 (https://lez.nameswallet.app) with it. Private
actions stay off on the phone: they need a RISC Zero proof, and a phone has no prover ("not on this phone yet").

## The binary

- `lib/arm64-v8a/libnames04.so`, pinned in `android/names04.properties` (run and sha256), built by
  `.github/workflows/names04-build.yml` from jefdiesel/logos-names `wallet-1121` (78b5896: LNS name NFTs,
  `names deed claim/show`, version 7 records) with `names04-cli/patches/0001` (public NFT calls sent unchecked).
- **Bare**: no `r0vm`, no in-process executor. Before a public send the 0.4 tool normally runs the call's programs to
  size the gas; a bare build sends registry, token, NFT and deed calls unchecked with their measured caps instead
  (`unchecked_limit`, three times the measured run). A call the network refuses still pays its fee.
- The app never sets `RISC0_EXECUTOR`, `RISC0_PROVER` or any other `RISC0_*` for it (its environment is built from
  scratch: `signer04.Signer04.env`; `tests/sign04_test.py` checks).
- The emulator test (`tests/names04_emulator_e2e.sh`, in names04-build) runs this binary on an Android emulator
  against a throwaway LEZ v0.4.0-rc3 chain: register, set-account, transfer, a native send; the desktop's phrase
  restored with `names module restore` (the same first account and public key as `names setup` made on the host);
  a send by account id and a public pay of a name; NFT InitializeHolding, receive and send. `names deed claim` can't
  run there: the deeds' NFT program sits at a pinned header whose key isn't in CI.

## The accounts: the desktop's recovery phrase

The phone uses the SAME recovery phrase as the desktop Names Wallet for LEZ 0.4 (Jef, 2026-11-19): the same accounts,
names and NFTs. The phone's LEZ 0.3 name account has no phrase (NAMES.md "Where the key lives"), so the person types
the desktop's phrase once, on the Wallet on LEZ 0.4 ("Use your recovery phrase").

- `POST /api/wallet/lez04/restore {phrase}` (unlocked session). The server checks its form (12 to 24 lowercase
  words), then runs `names module restore` (the desktop's own restore: `cli_restore_wallet` → `run_restore_wallet`)
  with the phrase on standard input. It derives 16 public accounts (and one private one, unused here), as the desktop
  restores. Only on a phone with no LEZ 0.4 wallet yet; never over one.
- The phrase: in the request body and that one call's memory only. Never in argv, the environment, a file, a log, an
  event or a reply. What `names` prints while restoring is dropped except its last line (the account ids as JSON).
  The page empties the box as the request goes out, and a lock wipes every field.
- The keys: `names` writes them to `<data>/.lez04-wallet/storage.json` (folder 0700, files 0600), unencrypted inside the
  app's private storage, as the LEZ 0.3 key is. `<data>/wallet-lez04.json` keeps only public facts: the account ids,
  the first account's public key, whether the faucet was used.
- Not in the app's backup file: the phrase is the way back for LEZ 0.4.

## What it sends

One job at a time, `names` started with fixed arguments, its output shown only through allowlists
(`signer04.PROGRESS`, `signer04.ERRORS`):

| Press | Command |
|---|---|
| Send to `Public/<id>` | `wallet auth-transfer send --from Public/<first> --to Public/<id> --amount N` (refused first if the network hasn't seen that account: such a transfer reverts and still pays its fee) |
| Send to a public key | `wallet auth-transfer send --from Public/<first> --to-pk <hex> --amount N` |
| Send to an LNS name | `pay --public --from=Public/<first> -- <name> N` |
| Collectibles: Receive an NFT | `--nft-program P nft init --definition D --account <first>`, or `--new public --fee-payer <first>` when the first account already has a holding under P |
| Collectibles: Send | `--nft-program P nft send --from A --to Public/<id>\|<name>` (`--fee-payer <first>` when A isn't the first account) |
| Your LNS names: Claim NFT (free) | `deed claim <name>`: offered on a name held by one of the wallet's accounts (matched by its owner tag), 5-32 characters, with no NFT yet. The holder pays the fee. |

A claim needs the locked-name list (61 MB) for its length proof. The tool can't download it itself (its HTTPS client
can't check certificates outside an app's Java runtime), so the server downloads it once from logos-names' release
`shortlist-9778bed4` (one redirect, to `*.githubusercontent.com` only), checks its pinned sha256, keeps it at
`<data>/.lez04-wallet/cache/shortlist-9778bed4.bin` and hands it over as `NAMES_SHORTLIST`.

## The faucet

"Get free test LEZ": `bridge_faucet` on our proxy with `[public key, null, the first account]`, as the LNS page asks
(the faucet gives once per account and once per wallet, ever). The phone remembers a grant and doesn't ask again.

## HTTPS and the rate limit

`names` talks plain HTTP to `server.py` at `/lez04-rpc/<secret>` (a new secret each start, its own, not the LEZ 0.3
forwarder's); `server.py` forwards over HTTPS to the LEZ 0.4 network in use (lez04.json's `rpc_url`, or the network
entered in Settings → Network). Only the methods in `signer04.RPC_METHODS` pass; at most 20 calls in a batch.

Every call this app makes to LEZ 0.4 (the reader, the forwarder, the faucet) goes through one pacer: at most one every
0.25 s, 40 in 10 s, under the proxy's 50 per 10 s per address. A read refused with 429 is tried again twice after a
pause; `sendTransaction` is never sent twice.

## Not on the phone yet

Private accounts, sends and claims; printing and burning NFTs; registering on LEZ 0.4; bridged tokens' sends; a name's
records. Names the desktop holds are found by adding them under Collectibles → Your LNS names (a restored wallet has
no list of them).
