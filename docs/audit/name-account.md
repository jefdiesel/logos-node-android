# The LEZ name account, as implemented

Commit `d00ee0f`, `app/server.py` unless another file is named. The design notes are in `android/NAMES.md`;
this document follows the code, and lists where the two differ at the end.

## 1. What it is

The Android app can hold one **public LEZ account** (the "name account") and use it to register one LNS
name and set two of the name's text entries: `blockchain` (this wallet's Main address) and `msg` (this
phone's messaging key) (lines 292-298, 305). It exists only inside the Android app with the signer bundled:
`lns_available()` is `APP_EMBEDDED == "android"` and an executable `NAMES_BIN` (lines 360-361); every route
answers 404 otherwise (lines 4420-4432, 4662-4667).

All signing is done by `names`, the names project's command line built for Android (`libnames.so`, pinned by
SHA-256 in `android/names.properties` and checked in CI, `.github/workflows/android-app.yml:62-75`).
`server.py` never reads the key (lines 295-296); it starts `names` with fixed arguments and forwards its
network calls.

## 2. Files

| path (under `APP_DATA`, `files/wallet` on Android) | content | written by |
|---|---|---|
| `.lns-wallet/storage.json` | the LEZ wallet: seed and signing key, **plain JSON** | `names` |
| `.lns-wallet/names.json` | names held and commitments in progress (`pending`) | `names` |
| `.lns-wallet/wallet_config.json` | gas limit, poll timeout; no key | `names`, then `lns_set_gas` (lines 641-653) |
| `.lns-wallet/<file>.prev` | snapshot of `storage.json` / `names.json` before each job | `lns_snapshot` (474-481) |
| `.lns-wallet/<file>.replaced-<UTC time>-<6 hex>` | a file set aside by a put-back or a restore; never deleted | `lns_keep_aside` (2243-2253) |
| `wallet-lns.json` | `{account, name, reg_pending?, restoring?, names_pending?}`: public facts and restore markers | `lns_state_save` (392-406), fsynced |
| `wallet-lns-flow.json` | the one-tap job (§7) | `lns_flow_save` (1736-1744), fsynced |
| `wallet-lez-activity.json` | the last 100 LEZ actions for the page | `lez_act_*` (993-1038) |
| `wallet-bridge.json` | a bridge under way (§8) | `bridge_save` (1267-1278) |

`lns_lockdown()` makes the folder 0700 and every regular file in it 0600 after each change (lines 445-452).
`names` runs with umask 077 (lines 621-622, 703-704, 879-880). Writes by `server.py` go to `<file>.tmp`,
are fsynced, then renamed (lines 455-462); the folder itself is not fsynced.

## 3. Making the account

`POST /api/wallet/lns/account` → `lns_make_account()` (lines 680-720):

1. Takes the change lock (`lns_change`, non-blocking: a second caller gets 409 "Wait until…"), refuses while
   a job runs (lines 683-688).
2. Refuses if the state names an account and `storage.json` exists (689-691).
3. Lockdown, repair (§6); refuses if the key survives only in a `.prev` copy (692-695).
4. If `storage.json` exists without a recorded account: lists the accounts with `names wallet account list`
   and records the one at chain index `/0` (697-701, 611-638).
5. Otherwise runs `names wallet account new public` (703-704). Of its output only the `Public/<id>` address
   is read (705-707). **`names` prints a recovery phrase for a new wallet; the app drops it** (comment at
   706, `android/NAMES.md` "Where the key lives"). There is therefore no recovery phrase: a backup is the
   only way back to this key.
6. Saves `{account}` to `wallet-lns.json` (717).

## 4. Jobs: one change at a time

`lns_start(kind, build, job_id)` (lines 845-893) runs every signing command:

- Holds `lns_change` while it checks and starts; refuses while another job runs (849-854).
- Repairs, refuses if the key survives only in `.prev`, if there is no account or file, or if
  `storage.json` is not a JSON object (855-862).
- `build(state)` returns the `names` arguments (or a refusal); then: activity entry, job record with an id,
  `lns_snapshot()`, `lns_set_gas(LNS_GAS[kind])` (gas 250,000 register, 120,000 text, 1,000 send, line 303;
  `seq_poll_timeout` 30 s, line 652), and `Popen([NAMES_BIN] + args)` with `lns_env()` (869-880).
- `lns_watch` reads the output in a thread, keeps only allowlisted progress lines (`LNS_PROGRESS`, 323-334),
  kills the process at its timeout (45 min register, 20 min text, 10 min send; line 306), repairs, runs the
  success callback, and turns the last `Error:` block into one of the fixed `LNS_ERRORS` texts (337-351,
  666-677, 770-842).

| route | function | `names` arguments |
|---|---|---|
| `POST /api/wallet/lns/register {name}` | `lns_register` (896-907) | `register <name> --owner Public/<account> --term 1y --wait`; sets `reg_pending` first, `name` on success |
| `POST /api/wallet/lns/text {entry}` | `lns_text` (931-958) | `set-text <name> <entry> <value>`; `entry` only `blockchain` or `msg`; value is this wallet's Main address or this phone's messaging public key, never from the request |
| `POST /api/wallet/lns/send {to, amount, confirm}` | `lns_send` (1410-1471) | `wallet auth-transfer send --from Public/<account> --to Public/<id> --amount <n>`; refused unless balance and fee are known and cover it, and keeps what an unfinished registration needs |
| `POST /api/wallet/lns/name {name}` | `lns_link` (910-928) | none: records a name as this phone's **without reading the chain**; refused while a one-tap job exists |

All need an unlocked session and the page's Origin (§ threat model B1); none asks for the PIN again
(lines 4662-4707).

## 5. The forwarder (the signer's only way out)

`names` is given `LOGOS_NAMES_RPC=http://127.0.0.1:18190/lez-rpc/<LNS_RPC_SECRET>` and nothing else of the
app's environment (lines 602-608). `LNS_RPC_SECRET` is 16 random bytes in hex, new at every start
(line 310).

`Handler.lez_rpc` (4450-4463) answers 404 unless the app has the signer, the `Host` is the app's, and the
path's secret matches (constant-time compare). The body must be 1 byte to 2 MiB. `lns_forward`
(2352-2370) then:

- parses JSON; accepts one call or a batch of 1 to 64;
- refuses (403) unless every call is an object whose `method` is a string in the allowlist (lines 311-313):
  `sendTransaction`, `getFeeState`, `checkHealth`, `getBlock`, `getBlockRange`, `getLastBlockId`,
  `getAccountBalance`, `getTransaction`, `getAccountsNonces`, `getAccountView`, `getProofsAndRoot`,
  `getAccount`, `getProgramIds`, `getChannelId`;
- marks the running job "relayed" when a batch holds `sendTransaction` (used to judge a send whose answer
  was lost, lines 1450-1463);
- posts the body unchanged to `NAMES_RPC_URL` (line 265) over HTTPS, no redirects, answer capped at 16 MiB,
  60 s timeout (lines 227-256).

The content of `sendTransaction` is not inspected: the forwarder limits which methods, not which
transactions.

## 6. Keeping the key safe across crashes

`names` rewrites its files in place (truncate, write). The app guards against a job killed half-way:

- **Snapshot** before every job: each of `storage.json`, `names.json` that is a JSON object is copied to
  `.prev` (474-481).
- **Repair** `lns_repair()` (513-551), run at start, after each job, before each change and restore: a torn
  `wallet_config.json` is deleted (it holds no key); a file that does not parse is put back from `.prev`; for
  `storage.json` only if the signer finds the state's account in the copy (or the state lost its account).
  A missing `storage.json` is never filled in.
- **Saved-copy rule** `lns_saved_copy()` (503-507): while `storage.json` is unreadable and `.prev` is good,
  nothing may make, start, restore or overwrite (refusals at 694-695, 857-858, 1798-1799, 2284-2285).
- **Put back** `POST /api/wallet/lns/putback` → `lns_putback()` (413-442): the user puts `.prev` back after
  the signer confirms it holds the state's account; the unreadable file is kept aside.
- **At start** (`main`, 4717-4727): `lns_sweep()` removes temporary check folders and `.tmp` files (582-599);
  `lns_reconcile()` finishes or undoes a restore that stopped half-way (554-579); then `lns_repair()`.

## 7. The one-tap job ("Get this name")

`POST /api/wallet/lns/get {name, mode}` (`lns_get`, 1784-1808), `mode` `register` or `link`. The job lives in
`wallet-lns-flow.json` and is moved on by a background thread every 5 s or when woken (`lns_flow_loop`,
2150-2157), **whether or not the wallet is unlocked** (comment at 1708; `android/NAMES.md:181`).

### 7.1 States

```
            tap (lns_get)
                │
                ▼
            account ──(mode link: signer confirms the account holds the name)──┐
                │ (mode register)                                          │
                ▼                                                          │
              fund ── waits until balance ≥ need (checked every 60 s)       │
                │                                                          │
                ▼                                                          │
            register ── names register … --wait (commit, wait, reveal)     │
                │                                                          │
                ▼                                                          ▼
           blockchain ── set-text <name> blockchain <Main address> ◀───────┘
                │
                ▼
               msg ── set-text <name> msg <messaging key>   (no messaging key: done, msg_later = true)
                │
                ▼
              done

 any step ──(final refusal, or tries used up, or a brake)──▶ failed ──(Try again)──▶ the failed step
 Stop (no job running): the flow file is deleted
```

Each round (`lns_flow_round_locked`, 2022-2147):

- does nothing while `next_at` is ahead (a `next_at` more than an hour ahead is reset: a clock set back,
  2029-2030) or while a `names` job runs (2033-2039);
- stops the flow if 48 h have passed since the tap and no job runs (2035-2036), if the state's account
  changed (2041-2042), or, at the entry steps, if the phone's name changed (2043-2044);
- decides each step **from the chain**, never from how the last run ended: `register` asks the signer whether
  the account holds the name (`names resolve`, 1877-1891) and moves on if so; the entry steps read the
  name's entries (`lns_entries_read`) and move on if the entry already has the wanted value (2125-2135).

### 7.2 Brakes (persisted before anything is sent)

| brake | value | where |
|---|---|---|
| sends per step | register 2, blockchain 3, msg 3 | `LNS_FLOW_CAPS`, 1908; checked 1917-1918 |
| time between two sends of the flow | ≥ 60 s | `LNS_FLOW_GAP`, 1909; 1919-1920 |
| spend ceiling | balance at the first paid step minus balance now must not exceed deposit + fees at the fee ceiling + 1,000,000 | 1910, 1960-1978, 1921-1926 |
| tries per step | 5 (pauses 30 s, 2 min, 5 min, 10 min) | 1712-1713, 1856-1865 |
| refusals that end the flow at once | "is already registered", "is locked", "doesn't hold", "isn't registered", "someone else holds", "didn't take effect" | 1720-1721 |
| a failed register | tried once more, not four times (a failed reveal is billed its whole gas limit) | 2094-2099 |
| re-register after an earlier attempt | stops if the account's nonce moved since and no commitment is saved (the commit may have landed with its secret lost) | 2100-2109 |
| no send without a nonce | the account's nonce must be read before each send | 1992-1996 |
| unreadable chain | waits 15 s … 10 min, six times, then stops | 1724, 1950-1957 |
| waiting for LEZ | at most 24 h | `LNS_FLOW_FUND_MAX`, 1722, 2068-2070 |
| the whole job | at most 48 h from the tap | `LNS_FLOW_MAX`, 1723, 2035-2036 |

Before a send the flow writes the job id, the nonce read, the per-step count and the send time to disk, then
starts the signer (1997-2002). A job's result is matched to the flow by that id, never by time (1894-1904).

`POST /api/wallet/lns/get/retry` (1811-1819) resets tries, counts, ceiling and error and goes back to the
failed step. `POST /api/wallet/lns/get/stop` (1822-1836) deletes the flow file when no job runs. A new tap
is refused while a flow exists that is not `done` (1793-1794).

## 8. Getting LEZ into the account

- **Faucet** `POST /api/wallet/lns/faucet` (1222-1255): one POST of `{account}` to `LNS_FAUCET_URL`
  (line 968), HTTPS only. The faucet's refusal text is shown after control characters are removed, at most
  200 characters.
- **Bridge** `POST /api/wallet/lns/bridge {from, amount, confirm}` (1362-1404), loop 1486-1694: spends
  Logos Blockchain coins from one of this wallet's keys through the node's API (a split to the same key,
  then `POST /channel/deposit` of that note). Started with `confirm: true` from an unlocked page; continues
  after the wallet locks. One at a time; its state is saved before every node call (comment 961-966).

## 9. Backup and restore

**Backup** (`lns_backup`, 2187-2228, called by `backup_export`, 4046-4051). Inside the encrypted wallet
backup ([threat-model §4.8](threat-model.md#48-a-stolen-backup-file)), under `lns_wallet`:
`{storage, names, account, name, unconfirmed?}` with `storage.json` and `names.json` as text. Refused (409)
while a change runs. If the signer cannot list the accounts, the files still go along, marked
`unconfirmed`. `wallet-backup.json` remembers a hash of the account's files, account and name
(`lns_fingerprint`, 2160-2171) so the page can say "Make a new backup now" (`backup_needed`, 751).

**Restore** (`lns_restore`, 2256-2349, called by `restore_backup` at 3918 after the backup decrypts and the
node accepts its key file). Outcomes:

| outcome | when | effect |
|---|---|---|
| `added` | no account here | the backup's files in place |
| `same` | the signer finds the backup's account in this phone's file | this phone's (newer) files kept; state markers settled |
| `kept` | another account here, Replace not ticked | nothing changes |
| `replaced` | another account here, Replace ticked (`replace_name_account: true`) | the old files kept as `*.replaced-<stamp>`, the backup's in place |
| `busy` | a job, a one-tap flow step, or a bridge is under way | nothing changes |
| `unchecked` | the signer can't confirm the backup's account is in its wallet file, or can't read this phone's file, or the key is only in `.prev` | nothing changes |
| `failed` | an error part-way | `lns_reconcile` puts the state right; next start finishes it |

Before swapping files, the state is written with a `restoring` marker that names what was really in the
file, so a stop between the steps is undone or finished at the next start (2321-2335, 554-579). The node's
keystore swap in `restore_backup` goes ahead whatever the name-account outcome is (3918-3962); the reply
carries the outcome.

## 10. Where the code and `android/NAMES.md` or the code's comments differ

- The flow's header comment says the `msg` entry is set "later by itself" once Messages is on
  (`server.py:1702`). The code ends the flow at `done` with `msg_later` when there is no messaging key
  (2114-2118) and a finished flow does nothing (2026-2027); the `msg` entry is then set only by a tap.
  Setting the first messaging key wakes the flow thread (`server.py:3722-3723`), which finds it `done`.
- `lns_flow_ceiling`'s docstring says the spend brake "waits" for unknown parts (1961-1962). The code returns
  without a ceiling (1966-1968, 1972-1974), and `lns_flow_brake` then checks no spending at all
  (1921): a send can start without the ceiling.
- The comment on `LNS_FLOW_CAPS` says a register run is a commit and a reveal (1908); `names register` may
  retry the reveal itself ("the reveal did not land … trying again", line 328), so one run can send more than
  two transactions.
