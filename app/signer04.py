"""The LEZ 0.4 signer: the names project's LEZ 0.4 command line (`names`, built bare for Android: libnames04.so),
for PUBLIC sends on our LEZ 0.4. Android app only; see android/NAMES04.md.

What it does, and nothing else:
- Restores the phone's LEZ 0.4 accounts from the recovery phrase the person types: the SAME phrase as their desktop
  Names Wallet, so the same accounts, names and NFTs (`names module restore`, the desktop's own restore, the phrase on
  standard input). The phrase is held in memory for that one call: never in argv, the environment, a file, a log, an
  event or a reply. What `names` prints while restoring is dropped except its last line (the account ids, as JSON).
  Only once, on a phone with no LEZ 0.4 wallet yet; never over one.
- Sends from those accounts, one job at a time, `names` started with fixed arguments: native LEZ to an account, a
  public key or an LNS name; an NFT made ready to receive (InitializeHolding) and sent; an LNS name's free NFT
  claimed (`names deed claim`). All public. Nothing private: a phone has no prover.
- Asks the LEZ 0.4 faucet (`bridge_faucet` on our proxy) for free test LEZ, once per wallet.
- Forwards the calls of `names` to the network over HTTPS (it can't check TLS outside an app's Java runtime, the same
  as the LEZ 0.3 tool: android/NAMES.md "HTTPS"), at a secret path, only the methods it needs, paced with every other
  call this app makes there (the proxy allows 50 requests per 10 s per address).

The keys stay in this module's wallet folder (`.lez04-wallet` in the app's data folder, 0700, files 0600), written by
`names` itself, as the LEZ 0.3 key is (android/NAMES.md "Where the key lives"). This module never reads them. Of what
`names` prints, only fixed progress texts and fixed error texts (allowlists below), account ids and a public key ever
reach a reply, a log or the page.
"""
import hashlib
import http.client
import json
import os
import re
import secrets
import shutil
import subprocess
import threading
import time
import urllib.parse

B58_ID = r"[1-9A-HJ-NP-Za-km-z]{32,44}"
ID_RE = re.compile(r"\A" + B58_ID + r"\Z")
HEX64_RE = re.compile(r"\A[0-9a-f]{64}\Z")
NAME_RE = re.compile(r"\A(?!-)[a-z0-9-]{1,32}(?<!-)\Z")
AMOUNT_RE = re.compile(r"\A[0-9]{1,39}\Z")
ANSI_RE = re.compile(rb"\x1b\[[0-9;]*m")
U128 = (1 << 128) - 1
PHRASE_WORDS = (12, 24)
RESTORED = 16                    # public accounts a restore brings back (`names module restore`'s default, as the desktop)

# The locked-name list: `names deed claim` proves the name's tier with it (the registry checks the proof). `names`
# would download it itself, but its HTTPS client can't check certificates outside an app's Java runtime; so it is
# fetched here, once, and checked against its pinned sha256 before `names` is told where it is (`names` then checks it
# rebuilds to the root the registry commits to). The release asset of logos-names' shortlist-9778bed4.
SHORTLIST_URL = "https://github.com/jefdiesel/logos-names/releases/download/shortlist-9778bed4/shortlist.bin"
SHORTLIST_SHA256 = "ab03310848df6618943e81cf48e6c592fe2d8721de480906053dc295d5432a97"
SHORTLIST_SIZE = 60892524
SHORTLIST_REDIRECT_HOSTS = (".githubusercontent.com",)

# Methods `names` may call through the forwarder: the LEZ 0.3 forwarder's list (every one also on our LEZ 0.4 proxy's
# allowlist), nothing that changes anything but sendTransaction. The emulator test's proxy passes only these
# (tests/names04_emulator_e2e.sh), so a method the tool needs and this list lacks fails that run.
RPC_METHODS = {"sendTransaction", "getFeeState", "checkHealth", "getBlock", "getBlockRange", "getLastBlockId",
               "getAccountBalance", "getTransaction", "getAccountsNonces", "getAccountView", "getProofsAndRoot",
               "getAccount", "getProgramIds", "getChannelId"}
RPC_MAX = 2 * 1048576            # one request from `names`
RPC_REPLY_MAX = 16 * 1048576     # one answer (a program's bytecode comes in segments of 96 KiB, as JSON numbers)
RPC_BATCH_MAX = 20               # the proxy's own cap on a batch
PACE = float(os.environ.get("LEZ04_PACE_SECONDS", "0.25"))   # at most 4 requests a second from this app: 40 in 10 s

# How long a job may run: a send waits for its block (the wallet polls 5 rounds of 12 s by the config below), a claim
# may first fetch the 61 MB list.
JOB_TIMEOUT = {"send": 10 * 60, "nft_init": 10 * 60, "nft_send": 10 * 60, "claim": 30 * 60}
WALLET_CONFIG = {"gas_limit": 2000000, "fee_headroom_blocks": 5, "seq_block_poll_max_amount": 100, "seq_poll_max_retries": 5,
                 "seq_poll_timeout": "12s", "seq_tx_poll_max_blocks": 5}

_N = r"([0-9]{1,40})"
_NAME = r"([a-z0-9-]{1,32})"
_ID = "(" + B58_ID + ")"
# What may be shown of `names` output: a line that matches one of these, shown as the fixed text beside it (with only
# the captured digits, name or account). Everything else it prints is dropped.
PROGRESS = [
    (re.compile(r"\ATransaction hash is [0-9a-f]{64}\Z"), "sent; waiting for a block"),
    (re.compile(r"\ATransaction is included in block " + _N + r"\Z"), "in block {0}"),
    (re.compile(r"\Asubmitted [0-9a-f]{64}\Z"), "sent; waiting for a block"),
    (re.compile(r"\Aapplied in block " + _N + r"\Z"), "in block {0}"),
    (re.compile(r"\Apaying " + _N + r" to " + _NAME + r"\b.{0,80}\Z"), "paying {1}"),
    (re.compile(r"\Aclaiming the deed of " + _NAME + r" \(free\).{0,120}\Z"), "claiming {0}'s NFT"),
    (re.compile(r"\Areading the registry's bytecode from the chain\Z"), "reading the LNS registry from the network"),
    (re.compile(r"\Areading the NFT program deeds are minted on's bytecode from the chain\Z"), "reading the NFT program from the network"),
    (re.compile(r"\AThis computer can't check (?:the|the NFT) call first.{0,200}\Z"), "sending it with its fixed fee cap"),
    (re.compile(r"\Amaking (?:Public/)?" + _ID + r" ready for .{0,80}\Z"), "making {0} ready for the collection"),
    (re.compile(r"\Asending the NFT of .{0,80} from (?:Public/)?" + _ID + r" to .{0,120}\Z"), "sending the NFT"),
    (re.compile(r"\Anew account Public/" + _ID + r"\Z"), "a new account: {0}"),
]
ERRORS = [
    (re.compile(r"\b" + _NAME + r" already has a deed"), "{0} already has its NFT."),
    (re.compile(r"\b" + _NAME + r" is locked"), "{0} is locked (one to four characters, or reserved), so it has no NFT."),
    (re.compile(r"this wallet does not hold " + _NAME), "None of this wallet's accounts holds {0}."),
    (re.compile(r"\b" + _NAME + r" is not registered"), "{0} isn't registered on this network."),
    (re.compile(r"Public/" + _ID + r" holds " + _N + r"; this takes " + _N + r", and about " + _N + r" more is held"),
     "Public/{0} holds {1}; this takes {2}, and about {3} more is held for the fee while it runs. Add test LEZ first."),
    (re.compile(r"Public/" + _ID + r" holds " + _N + r"; about " + _N + r" is held for the fee"),
     "Public/{0} holds {1}; about {2} is held for the fee while this runs. Add test LEZ to it first."),
    (re.compile(r"fees are too high right now"), "The network's fees are too high right now. Try again later."),
    (re.compile(r"has never been used on this chain"), "That name's account has never been used on this network, so it can't be paid publicly yet."),
    (re.compile(r"has no public account set"), "That name has no public account to pay."),
    (re.compile(r"That account isn't ready for this collection"), "That account isn't ready for this collection: it has to receive a holding first."),
    (re.compile(r"That account already holds an NFT of this collection"), "That account already holds an NFT of this collection."),
    (re.compile(r"tied to another collection under this NFT program"), "That account is tied to another collection under this NFT program; use another account."),
    (re.compile(r"is a collection's definition"), "That account is a collection's definition; it can't hold an NFT."),
    (re.compile(r"holds no NFT to send"), "This account holds no NFT to send."),
    (re.compile(r"would be sending to itself"), "That is the account the NFT is in already."),
    (re.compile(r"is already ready for"), "That account is ready for this collection already."),
    (re.compile(r"NFT state can't be read"), "That account's NFT state can't be read, so it isn't used."),
    (re.compile(r"is not a deployed program|not the one deeds are pinned to"), "The NFT program isn't on this network as expected, so nothing was sent."),
    (re.compile(r"Insufficient|insufficient|not enough", re.I), "The account doesn't hold enough for this and its fee."),
    (re.compile(r"was included in block " + _N + r" but its changes were not"), "It was included in block {0} but didn't take effect."),
    (re.compile(r"was not included in a block|not applied"), "The network didn't include it in a block in time. Check before trying again."),
    (re.compile(r"did not accept the transaction"), "The network didn't accept it."),
    (re.compile(r"locked-name list"), "The list of locked names couldn't be used. Try again."),
    (re.compile(r"failed to read|isn't answering|error sending request|connection|timed out", re.I), "The network didn't answer. Try again."),
]
ERROR_OTHER = "It stopped with an error this app doesn't show. Check the account's balance, then try again."

TEXT = {
    "busy": "Wait until the send that is running now has finished.",
    "not_ready": "Restore your LEZ 0.4 accounts from your recovery phrase first (Wallet, on LEZ 0.4).",
    "no_tool": "The LEZ 0.4 signer isn't in this build of the app.",
    "phrase": "A recovery phrase is 12 to 24 words, in lowercase letters, with spaces between them.",
    "have_wallet": "This phone already has LEZ 0.4 accounts, so nothing was restored or changed.",
    "restore_failed": "The accounts couldn't be restored from that phrase. Nothing was kept. Check the words and try again.",
    "faucet_once": "This wallet already got its free test LEZ: once per wallet.",
    "unused": "That account has never been used on this network, so it can only be paid by its public key. Ask for the key "
              "(Receive shows it), or pay their LNS name.",
    "to": "Send to an account (Public/… or its ID), a public key (64 hexadecimal characters), or an LNS name.",
    "amount": "Enter an amount above 0, in whole units (digits only).",
    "unreachable": "Can't reach LEZ 0.4 right now. Nothing was sent. Try again.",
}


class Pacer:
    """At most one request every `gap` seconds, for every caller together (the network counts them per address)."""

    def __init__(self, gap):
        self.gap, self.lock, self.next = gap, threading.Lock(), 0.0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            at = max(now, self.next)
            self.next = at + self.gap
        if at > now:
            time.sleep(at - now)


def clean_line(line):
    """One line of `names` output as it may be shown: the fixed text of a known progress line, else None."""
    s = ANSI_RE.sub(b"", line if isinstance(line, bytes) else line.encode()).decode("utf-8", "replace").strip()
    for pattern, shown in PROGRESS:
        m = pattern.fullmatch(s)
        if m:
            return shown.format(*m.groups())
    return None


def error_text(lines):
    """What went wrong, as one of the fixed ERRORS texts, from the last `Error:` block `names` printed."""
    text = [ANSI_RE.sub(b"", l if isinstance(l, bytes) else l.encode()).decode("utf-8", "replace").strip() for l in lines]
    for i in range(len(text) - 1, -1, -1):
        if text[i].startswith("Error:"):
            block = " ".join(t for t in text[i:i + 12] if not t.startswith("Stack backtrace"))
            for pattern, shown in ERRORS:
                m = pattern.search(block)
                if m:
                    return shown.format(*m.groups())
            return ERROR_OTHER
    return "It stopped without saying why."


def phrase_ok(phrase):
    """The phrase in its one form (lowercase words, single spaces), or None. Never logged."""
    if not isinstance(phrase, str) or len(phrase) > 400:
        return None
    words = phrase.split()
    if not PHRASE_WORDS[0] <= len(words) <= PHRASE_WORDS[1] or not all(w.isascii() and w.isalpha() and w.islower() for w in words):
        return None
    return " ".join(words)


def account_of(text):
    """`Public/<id>` or a bare id, as the bare id, or None."""
    if not isinstance(text, str):
        return None
    t = text.strip()
    if t.startswith("Public/"):
        t = t[len("Public/"):]
    return t if ID_RE.fullmatch(t) else None


class Signer04:
    """`fetch(url, body, cap, total)` -> (status, bytes) is the app's outside fetch (HTTPS, no redirects, capped);
    `config()` the LEZ 0.4 settings (lez04.json with its override); `forward_url()` where `names` reaches the forwarder;
    `pacer` the one Pacer every call to the 0.4 network goes through; `event(name, **detail)` the app's event log."""

    def __init__(self, data_dir, bin_path, fetch, config, forward_url, pacer, event=lambda *a, **k: None, clock=time.time,
                 on_done=lambda kind: None):
        self.data_dir, self.bin, self.fetch, self.config, self.forward_url = data_dir, bin_path, fetch, config, forward_url
        self.pacer, self.event, self.clock, self.on_done = pacer, event, clock, on_done
        self.home = os.path.join(data_dir, ".lez04-wallet")
        self.state_file = os.path.join(data_dir, "wallet-lez04.json")
        self.shortlist = os.path.join(self.home, "cache", "shortlist-9778bed4.bin")
        self.secret = secrets.token_hex(16)
        self.lock = threading.Lock()                # guards self.job
        self.change = threading.Lock()              # one change at a time: a restore or a job
        self.job = {"kind": None, "state": "idle"}
        self.faucet_info_cache = {"at": 0.0, "value": None}

    # ---- files ----
    def available(self):
        return bool(self.bin) and os.path.isfile(self.bin) and os.access(self.bin, os.X_OK)

    def state(self):
        try:
            with open(self.state_file) as f:
                d = json.load(f)
        except Exception:
            d = {}
        d = d if isinstance(d, dict) else {}
        accts = [a for a in d.get("accounts", []) if isinstance(a, str) and ID_RE.fullmatch(a)] if isinstance(d.get("accounts"), list) else []
        main = d.get("main") if isinstance(d.get("main"), str) and d.get("main") in accts else (accts[0] if accts else None)
        pk = d.get("public_key") if isinstance(d.get("public_key"), str) and HEX64_RE.fullmatch(d["public_key"]) else None
        faucet = d.get("faucet") if isinstance(d.get("faucet"), dict) else None
        return {"accounts": accts, "main": main, "public_key": pk, "faucet": faucet}

    def save(self, **changes):
        d = self.state()
        d.update(changes)
        tmp = self.state_file + ".tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(d, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, self.state_file)

    def storage(self):
        return os.path.join(self.home, "storage.json")

    def ready(self):
        st = self.state()
        return bool(st["main"]) and os.path.isfile(self.storage())

    def lockdown(self):
        os.makedirs(self.home, mode=0o700, exist_ok=True)
        os.chmod(self.home, 0o700)
        for f in os.listdir(self.home):
            p = os.path.join(self.home, f)
            if os.path.isfile(p) and not os.path.islink(p):
                os.chmod(p, 0o600)

    def write_config(self):
        """The wallet's config: the forwarder of this start (its secret changes each start) and the polling the
        emulator test ran with."""
        cfg = dict(WALLET_CONFIG, sequencer={"sequencer_addr": self.forward_url() + "/"})
        tmp = os.path.join(self.home, "wallet_config.json.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(cfg, f, indent=2)
        os.replace(tmp, os.path.join(self.home, "wallet_config.json"))

    def env(self, extra=None):
        """The whole environment of `names`: its wallet folder, the forwarder, the registry. Nothing of this process's
        own environment goes along (no RISC0_* variable: the bare build sends public calls with fixed caps)."""
        c = self.config()
        e = {"PATH": "/system/bin:/usr/bin:/bin", "HOME": self.home, "TMPDIR": self.home, "LEE_WALLET_HOME_DIR": self.home,
             "LEE_WALLET_PASSWORD": "", "LOGOS_NAMES_RPC": self.forward_url(), "NO_COLOR": "1", "RUST_BACKTRACE": "0"}
        reg = c.get("lns_registry")
        if isinstance(reg, str) and ID_RE.fullmatch(reg):
            e["LOGOS_NAMES_PROGRAM"] = reg
        e.update(extra or {})
        return e

    # ---- the forwarder ----
    def forward(self, raw):
        """(http status, bytes or object) for one call of `names` to the network. A read refused for its rate (429) is
        tried again after a pause, at most twice; a send is never sent twice."""
        try:
            body = json.loads(raw)
        except Exception:
            return 400, {"error": "bad request"}
        calls = body if isinstance(body, list) else [body]
        if not calls or len(calls) > RPC_BATCH_MAX or not all(isinstance(c, dict) and isinstance(c.get("method"), str)
                                                              and c["method"] in RPC_METHODS for c in calls):
            return 403, {"error": "That method isn't forwarded."}
        url = self.config().get("rpc_url")
        if not isinstance(url, str) or not url:
            return 502, {"error": "no LEZ 0.4 network set"}
        sends = any(c["method"] == "sendTransaction" for c in calls)
        for attempt in range(3):
            self.pacer.wait()
            try:
                code, data = self.fetch(url, body, RPC_REPLY_MAX, 60)
            except Exception:
                return 502, {"error": "LEZ 0.4 isn't answering."}
            if code != 429 or sends or attempt == 2:
                return code, data
            time.sleep(2.0 * (attempt + 1))
        return code, data

    def rpc(self, method, params, total=15):
        """One read of the 0.4 network (paced), its result, or raises."""
        url = self.config().get("rpc_url")
        self.pacer.wait()
        code, data = self.fetch(url, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}, 1048576, total)
        reply = json.loads(data)
        if code != 200 or not isinstance(reply, dict) or reply.get("error") is not None or "result" not in reply:
            raise ValueError("no answer")
        return reply["result"]

    # ---- running `names` ----
    def run(self, args, stdin=None, timeout=120, extra_env=None):
        """(exit code, stdout bytes, stderr bytes) of one short run; stdin, if given, is written and closed."""
        self.lockdown()
        p = subprocess.run([self.bin] + args, env=self.env(extra_env), cwd=self.home, input=stdin,
                           stdin=None if stdin is not None else subprocess.DEVNULL, capture_output=True, timeout=timeout, umask=0o077)
        return p.returncode, p.stdout, p.stderr

    def restore(self, phrase):
        """(http status, reply). The accounts the desktop's phrase derives (`names module restore`: 16 public, as the
        desktop restores), on a phone with no LEZ 0.4 wallet yet. The phrase is in memory only, for this call."""
        if not self.available():
            return 404, {"error": TEXT["no_tool"]}
        words = phrase_ok(phrase)
        phrase = None                                       # (the caller's copy goes when its request ends)
        if words is None:
            return 400, {"error": TEXT["phrase"]}
        if not self.change.acquire(blocking=False):
            words = None
            return 409, {"error": TEXT["busy"]}
        try:
            if self.ready() or os.path.exists(self.storage()):
                return 409, {"error": TEXT["have_wallet"]}
            self.lockdown()
            self.write_config()
            try:
                code, out, err = self.run(["module", "restore"], stdin=(words + "\n").encode(), timeout=300)
            except Exception:
                code, out, err = -1, b"", b""
            words = None
            last = ""          # the JSON line (it may follow the prompt on its line; its keys come sorted: moved, private, public)
            for line in reversed(out.decode("utf-8", "replace").splitlines()):
                at = line.find("{")
                if at >= 0 and '"public"' in line:
                    last = line[at:].strip()
                    break
            del out, err                                    # the prompt and whatever the wallet printed: dropped
            try:
                made = json.loads(last) if code == 0 else None
                public = [a for a in made.get("public", []) if isinstance(a, str) and ID_RE.fullmatch(a)]
            except Exception:
                public = []
            if not public:
                self.discard()
                return 502, {"error": TEXT["restore_failed"]}
            self.save(accounts=public, main=public[0], public_key=None, faucet=None)
            pk = self.public_key_of(public[0])
            if pk:
                self.save(public_key=pk)
            self.event("lez04 accounts restored from a recovery phrase", account=public[0], accounts=len(public))
            return 200, self.view()
        finally:
            self.lockdown()
            self.change.release()

    def discard(self):
        """A restore that failed part way leaves no wallet behind (it held only what the phrase derives)."""
        for f in ("storage.json", "names.json", "names-wallet.lock"):
            try:
                os.remove(os.path.join(self.home, f))
            except OSError:
                pass

    def public_key_of(self, account):
        """The account's public key (64 hex), as `names wallet account get --keys` prints it (pk only, for a public
        account), or None."""
        try:
            code, out, _ = self.run(["wallet", "account", "get", "--account-id", "Public/" + account, "--keys"], timeout=60)
        except Exception:
            return None
        m = re.search(rb"^pk ([0-9a-f]{64})\s*$", out, re.M) if code == 0 else None
        return m.group(1).decode() if m else None

    # ---- the view ----
    def view(self, channel=None):
        """`channel`: the LEZ 0.4 network's chain id as last read; a faucet grant on another chain (before a reset)
        doesn't count as used."""
        st = self.state()
        with self.lock:
            job = {k: self.job.get(k) for k in ("kind", "state", "progress", "error", "started", "finished", "name", "to",
                                                  "amount", "account", "said")}
        f = st["faucet"] or {}
        if channel and f.get("channel") and f["channel"] != channel:
            f = {}                                          # the network was reset since: the faucet can be asked again
        return {"available": self.available(), "ready": self.ready(), "account": st["main"], "public_key": st["public_key"],
                "accounts": st["accounts"], "job": job,
                "faucet": {"used": bool(f.get("ok")), "amount": f.get("amount"), "at": f.get("at")},
                "shortlist": os.path.isfile(self.shortlist)}

    # ---- jobs ----
    def start(self, kind, args, extra_env=None, before=None, **shown):
        """Starts one job (refused while another runs). `before()` runs first on the job's thread (the shortlist)."""
        if not self.change.acquire(blocking=False):
            return 409, {"error": TEXT["busy"]}
        job = dict(kind=kind, state="running", progress="starting", error="", started=self.clock(), finished=None,
                   name="", to="", amount="", account="", said="")
        job.update(shown)
        with self.lock:
            self.job = job
        threading.Thread(target=self._run_job, args=(kind, args, extra_env, before), name="lez04-" + kind, daemon=True).start()
        return 200, self.view()

    def _set(self, **k):
        with self.lock:
            self.job.update(k)

    def _run_job(self, kind, args, extra_env, before):
        ok, tail, final = False, [], {"state": "failed", "error": "The signer didn't run."}
        try:
            if before is not None:
                why = before()
                if why:
                    final = {"state": "failed", "error": why}
                    return
            self.lockdown()
            self.write_config()
            proc = subprocess.Popen([self.bin] + args, env=self.env(extra_env), cwd=self.home, stdin=subprocess.DEVNULL,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, umask=0o077)
            timer = threading.Timer(JOB_TIMEOUT.get(kind, 600), proc.kill)
            timer.daemon = True
            timer.start()
            new_account = None
            for line in proc.stdout:
                tail = (tail + [line])[-40:]
                shown = clean_line(line)
                if shown:
                    m = re.match(r"a new account: (" + B58_ID + ")", shown)
                    if m:
                        new_account = m.group(1)
                    self._set(progress=shown)
            code = proc.wait(timeout=60)
            timer.cancel()
            ok = code == 0
            if new_account:
                st = self.state()
                if new_account not in st["accounts"]:
                    self.save(accounts=st["accounts"] + [new_account])
                self._set(account=new_account)
            final = {"state": "done", "progress": "done"} if ok else {"state": "failed", "error": error_text(tail)}
            if ok:
                try:
                    self.on_done(kind)
                except Exception:
                    pass
            self.event("lez04 job ended", kind=kind, ok="yes" if ok else "no")
        except Exception:
            pass
        finally:
            tail = None
            try:
                self.lockdown()
            except Exception:
                pass
            with self.lock:                 # the job's end is shown and the next one allowed together
                self.job.update(final, finished=self.clock())
                self.change.release()

    def send(self, body):
        """Native LEZ from the main account: to `Public/<id>` (an account the network has seen), a 64-hex public key
        (any account), or an LNS name (its public account, `names pay --public`)."""
        if not self.ready():
            return 409, {"error": TEXT["not_ready"]}
        main = self.state()["main"]
        amount = str(body.get("amount", "")).replace(",", "").strip()
        if not AMOUNT_RE.fullmatch(amount) or not 0 < int(amount) <= U128:
            return 400, {"error": TEXT["amount"]}
        to = body.get("to")
        to = to.strip() if isinstance(to, str) else ""
        pk = to.lower() if HEX64_RE.fullmatch(to.lower()) else None
        acct = account_of(to) if not pk else None
        name = to.lower().lstrip("@") if not pk and not acct and NAME_RE.fullmatch(to.lower().lstrip("@")) else None
        if acct == main:
            return 400, {"error": "That is this account. Send to another one."}
        if acct:
            try:
                seen = self.rpc("getAccount", [acct]) is not None
            except Exception:
                return 503, {"error": TEXT["unreachable"]}
            if not seen:
                return 409, {"error": TEXT["unused"], "unused": True}
            args = ["wallet", "auth-transfer", "send", "--from", "Public/" + main, "--to", "Public/" + acct, "--amount", amount]
            shown_to = "Public/" + acct
        elif pk:
            args = ["wallet", "auth-transfer", "send", "--from", "Public/" + main, "--to-pk", pk, "--amount", amount]
            shown_to = "public key " + pk[:8] + "…" + pk[-4:]
        elif name:
            args = ["pay", "--public", "--from=Public/" + main, "--", name, amount]
            shown_to = name
        else:
            return 400, {"error": TEXT["to"]}
        return self.start("send", args, to=shown_to, amount=amount)

    def nft_init(self, body):
        """Receive: makes an account of this wallet ready for a collection (InitializeHolding). The main account when it
        holds nothing under that program yet, else a new account (paid by the main one)."""
        if not self.ready():
            return 409, {"error": TEXT["not_ready"]}
        program, definition = account_of(body.get("program")), account_of(body.get("definition"))
        if not program or not definition:
            return 400, {"error": "Give the NFT program and the collection, each by its account ID."}
        main = self.state()["main"]
        try:
            view = self.rpc("getAccountView", [{"account_id": main, "program_account_id": program}])
            used = bool(((view or {}).get("data") or {}).get("actor_states", {}).get(program))
        except Exception:
            return 503, {"error": TEXT["unreachable"]}
        args = ["--nft-program", program, "nft", "init", "--definition", definition]
        args += ["--new", "public", "--fee-payer", main] if used else ["--account", main]
        return self.start("nft_init", args, account="" if used else main, to=definition)

    def nft_send(self, body):
        """Sends the NFT one of this wallet's accounts holds (public to public); the main account pays when another
        one sends."""
        if not self.ready():
            return 409, {"error": TEXT["not_ready"]}
        st = self.state()
        program, frm = account_of(body.get("program")), account_of(body.get("from"))
        if not program or not frm or frm not in st["accounts"]:
            return 400, {"error": "That NFT isn't held by an account of this wallet."}
        to = body.get("to")
        to = to.strip() if isinstance(to, str) else ""
        acct = account_of(to)
        name = to.lower().lstrip("@") if not acct and NAME_RE.fullmatch(to.lower().lstrip("@")) else None
        if not acct and not name:
            return 400, {"error": "Send it to an account (Public/… or its ID) or an LNS name."}
        if acct == frm:
            return 400, {"error": "That is the account the NFT is in already."}
        args = ["--nft-program", program, "nft", "send", "--from", frm, "--to", "Public/" + acct if acct else name]
        if frm != st["main"]:
            args += ["--fee-payer", st["main"]]
        return self.start("nft_send", args, to="Public/" + acct if acct else name, account=frm)

    def claim(self, name, holder):
        """The free NFT of the LNS name `name`, held by `holder` (one of this wallet's accounts, read from the name's
        record): `names deed claim`, which finds the holder itself and pays the fee from it."""
        if not self.ready():
            return 409, {"error": TEXT["not_ready"]}
        if not isinstance(name, str) or not NAME_RE.fullmatch(name):
            return 400, {"error": "That isn't an LNS name."}
        if not 5 <= len(name) <= 32:
            return 400, {"error": name + " is locked (one to four characters), so it has no NFT."}
        if holder not in self.state()["accounts"]:
            return 409, {"error": "None of this wallet's accounts holds " + name + "."}
        return self.start("claim", ["deed", "claim", name], extra_env={"NAMES_SHORTLIST": self.shortlist},
                          before=self.fetch_shortlist, name=name, account=holder)

    # ---- the locked-name list (for a claim) ----
    def fetch_shortlist(self):
        """Makes sure the list is here and whole (None), or says why not. Runs on a job's thread."""
        if os.path.isfile(self.shortlist):
            return None
        self._set(progress="getting the list of locked names (61 MB, once)")
        os.makedirs(os.path.dirname(self.shortlist), mode=0o700, exist_ok=True)
        part = self.shortlist + ".part"
        try:
            got = download(SHORTLIST_URL, part, SHORTLIST_SIZE, SHORTLIST_REDIRECT_HOSTS,
                           lambda n: self._set(progress="getting the list of locked names (%d of 61 MB, once)" % (n // 1000000)))
            if got != SHORTLIST_SHA256:
                raise ValueError("wrong file")
            os.replace(part, self.shortlist)
            os.chmod(self.shortlist, 0o600)
            return None
        except Exception:
            try:
                os.remove(part)
            except OSError:
                pass
            return "The list of locked names couldn't be downloaded (it is needed once, to claim). Nothing was sent. Try again."

    # ---- the faucet ----
    def faucet_info(self):
        c = self.faucet_info_cache
        if self.clock() - c["at"] < 60 and c["value"] is not None:
            return c["value"]
        try:
            r = self.rpc("bridge_faucetInfo", [], total=10)
            v = {"amount": str(r.get("amount")) if isinstance(r, dict) and str(r.get("amount", "")).isdigit() else None,
                 "available": bool(r.get("available")) if isinstance(r, dict) else False}
        except Exception:
            v = {"amount": None, "available": None}
        c.update(at=self.clock(), value=v)
        return v

    def faucet(self):
        """(http status, reply). Asks the faucet once per wallet: [public key, null, the wallet's account], as the LNS
        page does; the faucet sends once its transfer is in a block (up to 2 minutes)."""
        if not self.ready():
            return 409, {"error": TEXT["not_ready"]}
        st = self.state()
        try:
            channel = self.rpc("getChannelId", [], total=10)
            channel = channel if isinstance(channel, str) and len(channel) <= 128 else None
        except Exception:
            channel = None
        f = st["faucet"] or {}
        if f.get("ok") and (not channel or not f.get("channel") or f["channel"] == channel):
            return 409, {"error": TEXT["faucet_once"], "code": "already_used"}
        pk = st["public_key"] or self.public_key_of(st["main"])
        if not pk:
            return 502, {"error": "This account's public key couldn't be read. Try again."}
        if pk != st["public_key"]:
            self.save(public_key=pk)
        url = self.config().get("rpc_url")
        self.pacer.wait()
        try:
            code, data = self.fetch(url, {"jsonrpc": "2.0", "id": 1, "method": "bridge_faucet", "params": [pk, None, st["main"]]}, 65536, 150)
            reply = json.loads(data)
        except Exception:
            return 503, {"error": "The faucet isn't answering. Try again in a minute."}
        if code == 429:
            return 429, {"error": "Too many requests to LEZ 0.4 just now. Try again in a minute.", "code": "rate_limited"}
        res = reply.get("result") if isinstance(reply, dict) else None
        if code != 200 or not isinstance(res, dict):
            err = reply.get("error") if isinstance(reply, dict) else None
            msg = err.get("message") if isinstance(err, dict) and isinstance(err.get("message"), str) else ""
            return 502, {"error": "The faucet refused: " + plain(msg) if msg else "The faucet didn't give an answer."}
        if res.get("ok") is True:
            amount = str(res.get("amount")) if str(res.get("amount", "")).isdigit() else None
            self.save(faucet={"ok": True, "amount": amount, "at": int(self.clock()), "channel": channel})
            self.event("lez04 faucet paid", account=st["main"], amount=amount or "?")
            return 200, {"ok": True, "amount": amount, "account": st["main"]}
        codes = {"already_used", "already_today", "faucet_empty", "busy", "rate_limited", "bad_key"}
        c = res.get("code") if res.get("code") in codes else "refused"
        if c == "already_used":
            self.save(faucet={"ok": True, "amount": None, "at": int(self.clock()), "before": True, "channel": channel})
        return 409, {"error": plain(res.get("reason")) or "The faucet refused.", "code": c, "retry": res.get("retry") is True}


def plain(text):
    """Someone else's sentence, as it may be shown: printable, at most 200 characters."""
    if not isinstance(text, str):
        return ""
    return "".join(ch for ch in text if ch.isprintable())[:200].strip()


def download(url, path, size, redirect_hosts, progress, total=900):
    """Downloads `url` to `path` (HTTPS only; at most one redirect, to a host ending in one of `redirect_hosts`; exactly
    `size` bytes or refused), and returns its sha256 (hex). TLS is checked with the default context."""
    import ssl
    end = time.monotonic() + total
    for hop in range(2):
        u = urllib.parse.urlsplit(url)
        if u.scheme != "https" or not u.hostname:
            raise ValueError("refused URL")
        conn = http.client.HTTPSConnection(u.hostname, u.port, timeout=30, context=ssl.create_default_context())
        try:
            conn.request("GET", u.path + ("?" + u.query if u.query else ""), headers={"User-Agent": "logos-node-app"})
            r = conn.getresponse()
            if r.status in (301, 302, 303, 307, 308) and hop == 0:
                loc = r.getheader("Location") or ""
                host = urllib.parse.urlsplit(loc).hostname or ""
                if not loc.startswith("https://") or not any(host.endswith(h) for h in redirect_hosts):
                    raise ValueError("redirected elsewhere")
                url = loc
                continue
            if r.status != 200:
                raise ValueError("HTTP %d" % r.status)
            h, n, last = hashlib.sha256(), 0, 0
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as f:
                while True:
                    if time.monotonic() > end:
                        raise TimeoutError("too slow")
                    piece = r.read(65536)
                    if not piece:
                        break
                    n += len(piece)
                    if n > size:
                        raise ValueError("too big")
                    h.update(piece)
                    f.write(piece)
                    if n - last >= 5000000:
                        last = n
                        progress(n)
            if n != size:
                raise ValueError("cut short")
            return h.hexdigest()
        finally:
            conn.close()
    raise ValueError("too many redirects")
