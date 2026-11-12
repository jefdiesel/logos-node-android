// NOT SHIPPED (groups engine). Group chats between LNS names on MLS (RFC 9420, ts-mls 1.6.4 in ./mls.js), with
// one admin who makes every commit. No UI here: the page calls the functions below and listens to events.
// Spec: GROUPS-PLAN.md sections 6 and 10 (where they disagree, 10 wins). Paths assume app/messages/.
//
// Pinned to ts-mls 1.6.4. Behaviour this file depends on, to re-test on any version bump (tests/groups_test.mjs
// and tests/mls/ cover each):
//   - joinGroup rejects a valid Welcome after add-only commits once parent nodes have unmerged leaves (#860):
//     worked around by an empty admin commit before an Add whenever any parent node has unmerged leaves.
//   - applyProposals runs before the IncomingMessageCallback (#857 throws a TypeError there): every library
//     exception is caught and the message dropped and counted.
//   - external commits are PublicMessages and may remove anyone (#859): processPublicMessage is never called.
//   - epochs leaving the 4-epoch window are not zeroed in memory (#856): see wipeState() and the notes there.
//   - processPrivateMessage does not say who sent an application message: the sender comes from
//     internals["privateMessage.js"].decryptSenderData (an internal of 1.6.4, exported by our bundle).
//   - a commit that removes a leaf and adds a new one into the same slot is not seen as a removal by the removed
//     device (selfRemoved = "my slot is blank afterwards"): re-adds remove in one commit and add in the next.
//   - joinGroup returns the signature private key it was given BY REFERENCE inside the new state; the engine
//     only ever hands ts-mls copies of the device seed (seedCopy()).
//   - ts-mls enforces unique keys in the tree, not unique identities: the engine flags duplicate names itself.
//   - the admin is leaf 0 (the creator's leaf; nothing ever removes it).
//
// Security notes (what this design does and does not promise; the UI should say the parts users need):
//   - The name record is the identity. A member is "alice" because the chain says alice's `msg` key is the key of
//     that leaf. Whoever controls alice's msg record (a new device, or a new owner after a name transfer) can ask
//     to be re-added and the admin's device does it by itself, removing the old leaf.
//   - The admin is trusted for membership. A malicious admin can add anyone, send different commits or topics to
//     different members (split the group), and members can't detect it. Members do check every leaf against the
//     chain and flag duplicate or malformed identities, so a hidden extra leaf under someone's name shows up.
//   - If the admin's device is lost, the group can still talk but nobody can change its members.
//   - Private keys live in the page-encrypted state blob: the device seed inside every group's encoded MLS state,
//     and the HPKE private keys of joins in progress. They are protected only by the page's cipher. Strings
//     (base64 in the blob) can't be zeroed; wipeState() zeroes what decoded state it can reach (#856 limit:
//     epochs that already left ts-mls's 4-epoch window stay in memory until garbage collection).
//   - What relays see: the group topic (one stable topic per group between removals; it changes on every
//     remove), the group id, the epoch, the content type (message or commit) and sizes, in clear in every MLS
//     PrivateMessage. Inbox topics are computed from public keys, so anyone can see who receives control traffic.
//     A backup holds the group list (names of members and admins) in the clear inside the app's backup.
//   - No freshness check on v2 control messages beyond the seen list and the request ids they carry.
//   - "Verified" (a leaf's key = its name's msg on the chain) is rechecked on every commit, not continuously.
//   - Two tabs are safe only if storage.write is an atomic compare-and-swap across them (server.py's rev check).
//   - Messages from people no longer in the group can still arrive late (marked formerMember): the UI should
//     hide them or say "sent before they left".
//   - For the 7-day grace after a topic change, a removed member who watches the old topic still sees commit
//     timing, epochs and sizes there (no content).
//   - A member of group X who is admin of group Y can give Y's members X's topic, which then makes them refuse
//     X's Welcome as a topic collision (they can't join X later). Low impact; not prevented.
//   - acceptInvite clears a finished (left/removed) record of the same group id, even if the new invitation is
//     from another admin: the user chose to accept it.
//   - Invitation floods: a contact (the page's isContact) outranks any other name the chain vouches for, which
//     outranks an address (free keys), which outranks a sender claiming a name it doesn't hold (or unchecked);
//     addresses get at most 25 of the 50 places; a newcomer never pushes out a higher rank. LIMIT: without
//     isContact, or for a name the user never talked to, someone holding about 17 names (3 invitations each,
//     one deposit each) can still push a real name's invitation out. The engine can't tell a stranger's real
//     invitation from a squatter's; only the page knows contacts.
//   - Held flood (LIMIT): anyone who knows the current topic (members, relays) can still push a real held
//     message out of the 200-item / 512 KiB buffer with frames claiming the same next epoch. Old-topic arrivals
//     and the furthest epoch go first, but frames for the next epoch can't be authenticated before their commit
//     arrives, so no eviction order can tell junk from real: whatever it keeps, a flood of the same rank wins
//     over time. A pushed-out message is lost (resend answers carry commits, not messages). Bounds: no write
//     beyond one per batch, the buffer never grows past its budget.
//   - Members never update their own leaf: ONLY_ADMIN_COMMITS refuses every proposal and nothing sends an
//     Update, so a member's leaf key changes only when it is re-added. A member whose leaf key leaks gets no
//     post-compromise security until then (GROUPS-PLAN 6.4's 7-day member self-update is not built).
//   - A real message more than 2 epochs ahead of this device is dropped (not stored): it only sets the "behind"
//     marker that makes this device ask for the missed commits. Its content is lost and isn't counted in
//     missed-messages (which counts only generation gaps it saw).
//   - deleteGroup by the admin leaves the members in a group nobody can change; they get no event.
//   - A member that missed its own removal commit stays "active" and silent until a later frame makes it ask for
//     resends; those are refused (it is no longer a leaf), and after 7 days it gets needs-readd.
//   - Inbox messages handed back by incomingMany (the chain can't be read now) live only in the caller's memory
//     until handed in again; each is handed back at most lookupTries times. What must survive a restart is kept
//     in state instead: a key package waiting for the chain (in its invitation, retried by tick()), a re-add
//     request (asked again daily by tick()), and a new invitation (kept as unchecked).
//
// Review status (reviews are in the coordinator's notes, GROUPS-REVIEW-1.md, -2.md and -3.md):
//   Review 1 (5ba3171): all closed - M1 seed aliasing, M2 held flood, M3 stale leave, M4 invitations (finished in
//     review 2), S1 inbox writes, S2 topic rotation, S3 rejoin, S4 resend/outbox, S5 resolver, S6 Welcome binding,
//     S7 member list by leaf, S8 late messages (same-epoch renames fixed in review 2), S9 unverified invites,
//     S10 wipe on leave.
//   Review 2 (a34005f): closed - M1 resend answers carry the request's nonce and drop only held items received
//     before that request with an epoch above the answer's; useless/refused controls stay out of the seen list.
//     M2 a too-far-ahead item sets a "behind" marker (no bytes) that starts the rate-limited resend request and
//     the catching-up/needs-readd events. M3 every resend answer carries topicKey/topicEpoch, and every admin
//     commit repeats the current topic message on old topics still in their grace week. Should-fix 1 invite
//     ranking and the address share; 2 one control per write, retries then "unverified address", (name, key)
//     lookups cached 60 s (review 3 found this caused its M2 and S3: replaced, see below); 3 resends start at the
//     member's join epoch and back off on repeats (bypassed, review 3 S2: replaced); 4 held eviction
//     prefers old-topic and furthest-epoch items; 5 a pending re-add re-sends its kp-request, rate limit per
//     (name, key); 6 an unreadable or other-version state blob is refused (STATE_UNREADABLE), never overwritten.
//     Documented: the topic-collision effect, formerMember, grace-week visibility, acceptInvite clearing.
//   Review 3 (00f9a88) found 2 must-fix and 9 should-fix; all have a scenario in tests/groups/review3.mjs named
//   "review 3 <item>: ..." that fails at 00f9a88 and passes here. For each change: what else it changes.
//     M1 a control message that threw after building a commit was refused, but its half-made commit was saved and
//       posted (the admin split from its own group; any invitee or member could do it with one bad signature
//       bit). Now every step that can fail halfway runs all or nothing (_txn): each inbox control message, the
//       admin's add from a key package (removal, topic change, #860 empty commit, Add), the removal for leave
//       requests, and the daily self-update. A refused key package ends that invitation (invite-failed
//       BAD_KEY_PACKAGE); a failed self-update is retried after an hour; in _one the message is marked seen only
//       after everything it does is in place, and a non-library failure there aborts the batch's write.
//       Other effects: memory and CPU, one copy of the step's group per step (refusals that need no copy happen
//       first, so non-members' junk copies nothing); a failed leave removal drops that leave request (the admin
//       can remove by hand). Writes: none extra.
//     M2 three failed lookups turned the sender into "k:<key>", so a Welcome or key package that came during a
//       short outage was refused for good. Now welcome, kp, commits, resend-request and restore re-adds are
//       matched by the key this device recorded (join keyed by group + admin key, invitation's key, group's admin
//       key, the leaf's key): no lookup, so no outage can refuse them. A lookup failure is never another identity:
//       the message is handed back (names-unavailable event) at most lookupTries times; then a new invitation is
//       kept as unchecked (acceptInvite checks the name, RESOLVER_UNAVAILABLE until it can), a key-change re-add
//       request is refused and asked again daily by the requester, and a key package waits in its invitation
//       (invite-waiting) for tick() to retry once a minute. importBackup uses the backup's admin key when the
//       chain can't be read. Other effects: one write when a key package starts waiting (only the invitee can
//       cause it); one resolver call per name per incomingMany call while the chain is down; a stored key
//       package (~1 KB) per waiting invitation; hand-backs bounded per message.
//     S1 an old resend answer cleared a newer "far ahead" marker. Now the marker goes only if it is older than the
//       request answered and the admin's epoch is reached; a member still below the admin's epoch after an
//       answer keeps a marker and asks again. Other effects: more resend requests while behind, within the
//       member's back-off (to 1 h) and the admin's caps below.
//     S2 the resend back-off keyed on fromEpoch was bypassed by alternating it. Now per member whatever it asks:
//       the gap doubles to 1 h unless the member was quiet for longer than 10 min and twice the gap; at most
//       resendPerDay (12) answers in any 24 h; a capped answer says more: true and only its continuation (as the
//       admin recorded it) is answered at the base gap. tooOld (needs-readd) only when the log no longer reaches
//       back. Other effects: worst case per member ~12 answers of <= 32 commits a day (was ~1,440); a few dozen
//       bytes of answer times per member in the admin's state; an honest member far behind gets 32 commits about
//       every 2 minutes (its own tick timing).
//     S3 one state write per inbox control (review 2's fix) let one free key force a full rewrite per message.
//       Now all control messages of one incomingMany call are one write. A new request id from the same sender
//       for the same group is applied only if its sealed timestamp is newer (a replayed older one can't restore an
//       old id) and stays out of the seen list. LIMIT: many free keys (3 invitations each) can still fill the
//       seen list, at one write per batch; the flush is harmless (the replay it enabled is stopped by the resend
//       nonce and the topic-epoch rule; pinned by the 4,000-message scenario).
//     S4 a member publishing new keys got one re-add per key. Key-change re-adds are now also limited per name
//       (one a day). Other effects: an honest second key change within a day waits a day; the requester's
//       tick() asks again daily (one sealed message a day per pending request, for up to 30 days).
//     S5 a pending re-add re-sent its key-package request on every restore request. Now the first repeat is
//       sent at once, later ones at most every 10 minutes. Other effects: one write per re-send.
//     S6 a capped answer raised a false needs-readd (fixed with S2's more/tooOld), and a member told needs-readd
//       had no way to ask. New: requestReadd(groupId) (member; once a day; the admin's device re-adds by itself,
//       once a week per member and key) and readd(groupId, member) (admin; no limit). The member's device
//       answers the admin's key-package request for a group it still has only when it asked (its own pending
//       re-add, same admin key), and that Welcome may replace its record only if it is from the same admin key
//       and for a later epoch. Other effects: who can trigger it: only the member itself (its leaf key) or the
//       admin; a re-add costs the member the messages of the epochs between.
//     S7 a start with another seed silently replaced every group. Now it refuses (DEVICE_KEY_CHANGED, or
//       STATE_UNREADABLE with a seed-keyed cipher) and writes nothing; the page migrates a device key explicitly
//       with createGroupEngine({ ..., replaceDeviceKey: <old engine's exportBackup()> }), ignored if the stored
//       groups already belong to this key. Other effects: the page must handle the new code.
//     S8 names could push out a real name's invitation. Now the page may pass isContact; contacts outrank every
//       other name and are never pushed out by them. LIMIT (above): strangers' invitations still can be.
//     S9 held flood on the current topic: LIMIT, not fixed in the engine (why: above, "Held flood"). The
//       scenario pins its bounds and that old-topic junk goes first.
//   Also pinned as guards (sound at 00f9a88, must stay): hostile Welcomes, false names, hidden leaves, same-epoch
//   renames, what leave keeps, unreadable state. Not proven by a test: ts-mls refusals of a key package other
//   than a bad signature (the rollback catches any exception; only the flipped signature bit is exercised).
import * as mls from "./mls.js";
import { appCryptoProvider } from "./mls-provider.js";
import { ed25519 } from "../noble-curves/ed25519.js";
import { sha256 } from "./noble-hashes/sha2.js";
import { sealMessage, inboxTopic, MAX_TEXT } from "./msg-crypto.js";
import { sealControl, openControl, b64, unb64 } from "./msg-v2.js";

export const LIMITS = Object.freeze({
  members: 32, // leaves + invites not answered yet
  textChars: MAX_TEXT, // 2,000, as in 1:1
  groups: 20, // groups this device is in, plus joins in progress
  groupNameChars: 64,
  payloadBytes: 65536, // group topic messages and sealed control messages
  holdAhead: 2, // messages are held only for the next 2 epochs (they can't be checked before their commit)
  held: 200, // held messages per group, at most...
  heldBytes: 512 * 1024, // ...and this many bytes (base64); the oldest go first
  commitLog: 64, // commits the admin keeps for resends
  resendCommits: 32, // at most this many commits in one resend answer
  outboxBytes: 1024 * 1024, // above this, the admin stops answering resend requests until it has posted
  seen: 4000, // message ids remembered per group (and for the inbox)
  invites: 50, // invitations kept waiting for an answer, in all...
  invitesPerSender: 3, // ...and per sender key
  invitesAddress: 25, // address-only senders (free keys) get at most this many of the 50 places
  resendPerDay: 12, // resend answers per member per day, at most
  lookupTriesKept: 1000, // failed-lookup counters kept in memory (oldest dropped first)
});
export const STATE_VERSION = 2;
const SUITE = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";
const FRAME = 0x47; // "G": group topic payload = 0x47 ‖ MLSMessage
const ADMIN_LEAF = 0;
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const ADDR_RE = /^k:[0-9a-f]{64}$/;
const NAMELESS_RE = /^msg-[0-9a-f]{16}$/;
const DEFAULT_TIMINGS = {
  resendAfterMs: 120_000, // held messages this old: ask the admin for the missing commits
  resendGapMs: 60_000, // first gap between two resend requests for one group; doubles each time, to 1 h
  resendServeGapMs: 60_000, // the admin answers one resend request per member per minute...
  resendServeQuietMs: 600_000, // ...and doubles that gap (to 1 h) while a member asks again within 10 minutes
  needsReaddAfterMs: 7 * 86_400_000, // still behind after this long: say the admin must re-add this device
  heldTtlMs: 8 * 86_400_000, // held messages older than this are dropped
  adminRefreshMs: 86_400_000, // the admin commits a path (self-update) at most this often
  topicGraceMs: 7 * 86_400_000, // after a topic change, the old topic is still read (and commits posted there)
  inviteTtlMs: 30 * 86_400_000,
  rejoinKeyChangeGapMs: 86_400_000, // re-adds for a proven key change: one per member per day
  rejoinRestoreGapMs: 7 * 86_400_000, // re-adds for a restore with the same key: one per member per week
  rejoinAskAgainMs: 86_400_000, // a re-add request not answered yet is sent again this often (until inviteTtlMs)
  kpResendGapMs: 600_000, // a pending re-add re-sends its key-package request at most this often
  kpRetryMs: 60_000, // a key package that waits for the chain is retried by tick() at most this often
  selfUpdateRetryMs: 3_600_000, // an admin self-update that failed is tried again after this long
  lookupCacheMs: 60_000, // a (name, key) match from the chain is trusted this long for v2 senders
  lookupTries: 3, // a NEW INVITATION whose sender can't be looked up this many times is kept as unchecked
};

/** Errors the UI can show: err.code is one of the codes below. */
export class GroupError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.code = code;
  }
}
export const ERRORS = {
  LIMIT_MEMBERS: "A group has at most 32 members.",
  LIMIT_GROUPS: "This device can be in at most 20 groups.",
  TEXT_TOO_LONG: "A message has at most 2,000 characters.",
  EMPTY_TEXT: "The message is empty.",
  BAD_GROUP_NAME: "A group name has 1 to 64 characters.",
  BAD_MEMBER: "That isn't an LNS name or a messaging address.",
  NO_MSG_KEY: "That name has no messaging address.",
  KEY_CHANGED: "That name's messaging address changed.",
  UNKNOWN_GROUP: "No such group on this device.",
  UNKNOWN_INVITE: "No such invitation.",
  NOT_ADMIN: "Only the group's admin can do that.",
  NOT_ACTIVE: "You are no longer in this group.",
  NOT_MEMBER: "That person isn't in the group.",
  ALREADY_MEMBER: "Already in the group.",
  ADMIN_CANNOT_LEAVE: "The admin can't leave a group (delete it on this device instead).",
  STATE_CONFLICT: "Groups changed in another tab; try again.",
  RESOLVER_UNAVAILABLE: "Names can't be checked right now; try again.",
  STATE_UNREADABLE: "The saved groups can't be read by this version of the app (they were not changed).",
  DEVICE_KEY_CHANGED: "The saved groups belong to this device's previous messaging key (they were not changed).",
  BAD_KEY_PACKAGE: "That device's answer to the invitation was not valid.",
  UNSUPPORTED: "Groups need a newer Android System WebView.",
};
const fail = (code) => {
  throw new GroupError(code, ERRORS[code]);
};

// ---------- small helpers ----------
const te = new TextEncoder();
const td = new TextDecoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s) => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
const eqBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((x, i) => x === b[i]);
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const hashHex = (bytes) => hex(sha256(bytes)).slice(0, 16); // seen-message ids: 64 bits is plenty per group
const concat = (...p) => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of p) {
    out.set(x, o);
    o += x.length;
  }
  return out;
};
export const topicOf = (topicKey) => `/names/1/g-${hex(sha256(concat(te.encode("names/group/v1/topic"), topicKey))).slice(0, 16)}/proto`;
const leafMsgKey = (leaf) => ed25519.utils.toMontgomery(leaf.signaturePublicKey);
const leafPid = (leaf) => {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(leaf.credential.identity);
  } catch {
    return "�";
  }
};
function leaves(state) {
  const out = [];
  state.ratchetTree.forEach((n, i) => {
    if (n?.nodeType === "leaf") out.push({ index: i / 2, pid: leafPid(n.leaf), key: leafMsgKey(n.leaf) });
  });
  return out;
}
/** A well-formed identity: an LNS name, or "k:<hex>" whose hex is that leaf's own key. */
const wellFormed = (pid, key) => (NAME_RE.test(pid) && !NAMELESS_RE.test(pid)) || (ADDR_RE.test(pid) && pid.slice(2) === hex(key));
const needsPathFirst = (state) => state.ratchetTree.some((n) => n?.nodeType === "parent" && n.parent.unmergedLeaves.length > 0);
/** (epoch, generation) a is newer than the stored (epoch, generation) b; a missing generation counts as -1. */
const newer = (epoch, gen, bEpoch, bGen) => {
  const be = BigInt(bEpoch ?? "0");
  return epoch > be || (epoch === be && gen > (bGen ?? -1));
};
const pushCapped = (arr, x, cap) => {
  arr.push(x);
  if (arr.length > cap) arr.splice(0, arr.length - cap);
};

/** A member as the API takes it: "alice", "k:<64 hex>", "msg:<64 hex>" or 64 hex -> "alice" | "k:<hex>". */
export function normalizeMember(input) {
  const s = String(input ?? "").trim().toLowerCase();
  if (ADDR_RE.test(s)) return s;
  const m = s.match(/^(?:msg:)?([0-9a-f]{64})$/);
  if (m) return "k:" + m[1];
  if (NAME_RE.test(s) && !NAMELESS_RE.test(s)) return s;
  fail("BAD_MEMBER");
}

const clientConfig = {
  keyRetentionConfig: mls.defaultKeyRetentionConfig,
  lifetimeConfig: mls.defaultLifetimeConfig,
  keyPackageEqualityConfig: mls.defaultKeyPackageEqualityConfig,
  paddingConfig: mls.defaultPaddingConfig,
  authService: mls.defaultAuthenticationService,
};
// Accept only commits from the admin's leaf; refuse every proposal (this protocol never commits by reference).
const ONLY_ADMIN_COMMITS = (x) => (x.kind === "commit" && x.senderLeafIndex === ADMIN_LEAF ? "accept" : "reject");

/** Zeroes what can be zeroed in a decoded group state (secrets of every epoch it still holds). #856: epochs that
 * already left the window were dropped by ts-mls without zeroing and can't be reached from here; they stay in
 * memory until garbage collection. Strings (the stored base64) can't be zeroed at all. `keep` is a buffer that
 * must not be touched even if the state holds it (the engine passes its own seed). */
export function wipeState(state, keep) {
  const z = (b) => b instanceof Uint8Array && b !== keep && (!keep || b.buffer !== keep.buffer) && b.fill(0);
  const tree = (t) => (t ?? []).forEach((n) => n && [n.application, n.handshake].forEach((g) => g && (z(g.secret), Object.values(g.unusedGenerations ?? {}).forEach(z))));
  try {
    Object.values(state.keySchedule ?? {}).forEach(z);
    tree(state.secretTree);
    Object.values(state.privatePath?.privateKeys ?? {}).forEach(z);
    for (const h of state.historicalReceiverData?.values?.() ?? []) {
      tree(h.secretTree);
      z(h.senderDataSecret);
      z(h.resumptionPsk);
    }
    z(state.signaturePrivateKey); // the engine only ever hands ts-mls copies of the seed
  } catch {
    /* best effort */
  }
}

/** What this WebView offers for groups. provider "app" (default) needs X25519, HMAC-SHA256 and AES-GCM in
 * WebCrypto (Chrome/WebView 133+); "default" (ts-mls's own) also needs Ed25519 (137+). */
export async function checkCapabilities(provider = "app") {
  const s = globalThis.crypto?.subtle;
  const missing = [];
  const probe = async (name, fn) => {
    try {
      if ((await fn()) === false) missing.push(name);
    } catch {
      missing.push(name);
    }
  };
  if (!s) missing.push("crypto.subtle (needs a secure context such as http://127.0.0.1)");
  else {
    await probe("X25519", async () => {
      const a = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      const b = await s.generateKey({ name: "X25519" }, true, ["deriveBits"]);
      return (await s.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256)).byteLength === 32;
    });
    await probe("HMAC-SHA256", async () => {
      const k = await s.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return (await s.sign("HMAC", k, new Uint8Array(1))).byteLength === 32;
    });
    await probe("AES-GCM", async () => {
      const k = await s.importKey("raw", new Uint8Array(16), { name: "AES-GCM" }, false, ["encrypt"]);
      return (await s.encrypt({ name: "AES-GCM", iv: new Uint8Array(12), additionalData: new Uint8Array(1) }, k, new Uint8Array(1))).byteLength === 17;
    });
    if (provider === "default")
      await probe("Ed25519", async () => {
        const kp = await s.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        return s.verify("Ed25519", kp.publicKey, await s.sign("Ed25519", kp.privateKey, new Uint8Array(1)), new Uint8Array(1));
      });
  }
  return { ok: missing.length === 0, provider, missing, message: missing.length ? ERRORS.UNSUPPORTED : "" };
}

const emptyData = (me) => ({ v: STATE_VERSION, me, groups: {}, invites: {}, joins: {}, rejoin: {}, outbox: [], seen: [] });
const joinKey = (gid, adminKey) => `${gid}:${adminKey}`;

/**
 * createGroupEngine({ me, transport, resolver, storage, cipher, provider, now, timings }) -> engine
 *   me        { name: "alice" or "", seed: Uint8Array(32) }   the device's Ed25519 seed; its X25519 form is `msg`.
 *             The engine keeps its own copy and never writes to the caller's buffer.
 *   transport { post(topic, bytes): Promise, subscribe(topics[]): Promise, unsubscribe(topics[]): Promise }
 *             post resolves once the node took the message and throws if it didn't (the engine retries on tick).
 *             The caller hands every payload from the inbox and from engine.topics() to engine.incomingMany().
 *   resolver  { msgKey(name): Promise<Uint8Array(32) | null> }   the `msg` entry of an LNS name, from the chain;
 *             null = the name has none; throwing = can't tell now (the engine retries or shows "unknown").
 *   storage   { read(): Promise<{ version, blob } | null>, write(blob, baseVersion): Promise<{ ok, version }> }
 *             write must refuse (ok: false) unless baseVersion is the stored version (compare-and-swap)
 *   cipher    { encrypt(bytes): Promise<bytes>, decrypt(bytes): Promise<bytes> }   the page's own encryption
 *   isContact (optional) (name) -> boolean | Promise<boolean>: names the user has talked to. Their invitations are
 *             never pushed out by others'. Without it every name counts as a stranger (see "Invitation floods").
 *   replaceDeviceKey (optional) a backup (exportBackup() of an engine started with the PREVIOUS seed and cipher):
 *             only when the stored groups belong to another device key (DEVICE_KEY_CHANGED) or can't be read
 *             with this cipher (STATE_UNREADABLE), the stored groups are replaced by an empty state for this key
 *             and every admin in the backup is asked to re-add this device. Without it the engine refuses to
 *             start in those cases and writes nothing.
 */
export async function createGroupEngine(opts) {
  const e = new GroupEngine(opts);
  await e._init();
  return e;
}

class GroupEngine {
  constructor({ me, transport, resolver, storage, cipher, provider = "app", now = () => Date.now(), timings = {}, workaround860 = true, isContact, replaceDeviceKey }) {
    if (!(me?.seed instanceof Uint8Array) || me.seed.length !== 32) throw new Error("me.seed must be 32 bytes");
    this.seed = me.seed.slice(); // our own copy; ts-mls only ever gets copies of this one (seedCopy)
    this.sigPub = ed25519.getPublicKey(this.seed);
    this.msgKey = ed25519.utils.toMontgomery(this.sigPub);
    this.msgSecret = ed25519.utils.toMontgomerySecret(this.seed);
    this.keyHex = hex(this.msgKey);
    this.name = me.name ? normalizeMember(me.name) : "";
    if (ADDR_RE.test(this.name)) this.name = "";
    this.pid = this.name || "k:" + this.keyHex;
    this.from = this.name || "msg-" + this.keyHex.slice(0, 16); // `from` in sealed messages
    this.inbox = inboxTopic(this.msgKey);
    Object.assign(this, { transport, resolver, storage, cipher, now });
    this.providerName = provider;
    this.workaround860 = workaround860; // false only in the test that shows what #860 does without it
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.version = null;
    this.data = null;
    this.counts = {}; // dropped/refused counters: memory only, so hostile input never causes a state write
    this.lookups = new Map(); // "name|keyhex" -> time the chain last said that name has that key (v2 senders)
    this.tries = new Map(); // v2 message id -> calls in which its lookup failed (capped): handed back until lookupTries
    this.kpTried = new Map(); // "gid|pid" -> last time tick() retried a key package that waits for the chain
    this.isContact = typeof isContact === "function" ? isContact : null;
    this.replaceDeviceKey = replaceDeviceKey ?? null;
  }
  seedCopy() {
    return this.seed.slice();
  }

  // ---------- events ----------
  /** onEvent(cb) -> unsubscribe. Events (plain objects; member ids are "alice" or "k:<64 hex>"):
   *   created {groupId, name}                  joined {groupId, name, admin, adminVerified}   left {groupId}
   *   invite {inviteId, groupId, groupName, from, claimedName?, verified, unchecked?}   -> acceptInvite / declineInvite
   *          unchecked: the chain couldn't be read when it came; acceptInvite checks the name then
   *   invite-sent {groupId, member}            invite-failed {groupId, member, code}  (KEY_CHANGED, BAD_KEY_PACKAGE)
   *   invite-waiting {groupId, member, reason}  (admin: a key package waits for the chain; tick() retries it)
   *   names-unavailable {count}  (this many inbox messages were handed back: the chain can't be read now)
   *   message {groupId, from, address, text, ts, late, verified, formerMember, suspicious}
   *          late: opened after its epoch closed; formerMember: its sender's leaf is no longer in the group
   *   members {groupId, added[], removed[], members[]}           renamed {groupId, name}
   *   member-suspicious {groupId, leaf, member, duplicate, malformed}   (two leaves with one name, or a bad name)
   *   removed {groupId}   (this device was removed)               key-changed {groupId, member}
   *   topic-changed {groupId}                  catching-up {groupId} / caught-up {groupId}
   *   missed-messages {groupId, count, epoch}  needs-readd {groupId, reason}
   *   rejoin-request {groupId, member, reason} (admin; it re-adds by itself, rate-limited)
   *   rejoin-requested {groupId, name, admin}  admin-lost {groupId, name} (restored admin: the group can't change)
   *   joined {..., readd: true} (a re-add this device asked for replaced its record)
   *   removed {groupId, readding: true} (the old leaf's removal during a re-add this device asked for)
   *   dropped {code}   (refused or unreadable input; at most one per code per batch; never content)
   *   state-reloaded {} (another tab wrote) */
  onEvent(cb) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  _emit(ev) {
    for (const cb of this.listeners) {
      try {
        cb(ev);
      } catch {
        /* a listener's problem */
      }
    }
  }

  // ---------- state ----------
  async _init() {
    const provider = this.providerName === "default" ? mls.defaultCryptoProvider : appCryptoProvider;
    this.impl = await provider.getCiphersuiteImpl(mls.getCiphersuiteFromName(SUITE));
    let code = null;
    try {
      await this._reload();
      if (this.data.me?.key !== this.keyHex) code = "DEVICE_KEY_CHANGED";
    } catch (e) {
      if (e?.code !== "STATE_UNREADABLE") throw e;
      code = e.code;
    }
    if (code) {
      // Never replace stored groups by ourselves (a wrong or zeroed seed would destroy them all): only when the
      // page says so, with the old engine's backup in hand.
      if (!this.replaceDeviceKey) fail(code);
      this.version = this.readVersion;
      this.data = emptyData({ pid: this.pid, key: this.keyHex });
      if (!(await this._write(this.data))) fail("STATE_CONFLICT");
      await this.importBackup(this.replaceDeviceKey);
    }
    const topics = this.topics();
    if (topics.length) await this.transport.subscribe(topics).catch(() => {});
  }
  async _reload() {
    const r = await this.storage.read();
    if (!r) {
      this.version = 0;
      this.data = emptyData({ pid: this.pid, key: this.keyHex });
      return;
    }
    this.readVersion = r.version; // only an explicit replaceDeviceKey writes over a blob it couldn't use
    let d;
    try {
      d = JSON.parse(td.decode(await this.cipher.decrypt(r.blob)));
    } catch {
      d = null;
    }
    // Never start over on a blob we can't read: the next write would destroy it. Refuse and let the page say so.
    if (d?.v !== STATE_VERSION) fail("STATE_UNREADABLE");
    this.version = r.version;
    this.data = d;
  }
  async _write(d) {
    const blob = await this.cipher.encrypt(te.encode(JSON.stringify(d)));
    const r = await this.storage.write(blob, this.version);
    if (r?.ok) this.version = r.version;
    return !!r?.ok;
  }

  /** Runs fn(draft, ctx) on a copy of the state, saves it (compare-and-swap), and only then posts, subscribes
   * and emits. Nothing is written when fn changed nothing. On a conflict (another tab wrote first) it reloads and
   * runs fn again on the fresh state, up to 6 times with a short random pause; then STATE_CONFLICT. */
  _mutate(fn) {
    const run = async () => {
      for (let attempt = 0; attempt < 6; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 10 + Math.random() * 40 * attempt));
        const draft = structuredClone(this.data);
        const ctx = { posts: [], events: [], zero: [], subscribe: [], unsubscribe: [], dropped: new Set(), dropEvents: [] };
        const result = await fn(draft, ctx);
        for (const p of ctx.posts) draft.outbox.push({ id: hex(rand(8)), topic: p.topic, b: b64(p.bytes) });
        const unchanged = !ctx.posts.length && JSON.stringify(draft) === JSON.stringify(this.data);
        if (unchanged || (await this._write(draft))) {
          this.data = draft;
          for (const b of ctx.zero) if (b instanceof Uint8Array && b.buffer !== this.seed.buffer) b.fill(0);
          if (ctx.subscribe.length) await this.transport.subscribe(ctx.subscribe).catch(() => {});
          if (ctx.unsubscribe.length) await this.transport.unsubscribe?.(ctx.unsubscribe).catch(() => {});
          await this._flush();
          for (const ev of [...ctx.events, ...ctx.dropEvents]) this._emit(ev);
          return result;
        }
        await this._reload();
        this._emit({ type: "state-reloaded" });
      }
      fail("STATE_CONFLICT");
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  /** Posts what the outbox holds, oldest first; stops at the first failure (kept for the next tick). */
  async _flush() {
    const sent = [];
    for (const item of this.data.outbox) {
      try {
        await this.transport.post(item.topic, unb64(item.b));
        sent.push(item.id);
      } catch {
        break;
      }
    }
    if (!sent.length) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const draft = structuredClone(this.data);
      draft.outbox = draft.outbox.filter((x) => !sent.includes(x.id));
      if (await this._write(draft)) {
        this.data = draft;
        return;
      }
      await this._reload(); // another tab: it may post them again; receivers drop the repeat by its hash
    }
  }
  _outboxBytes(d) {
    return d.outbox.reduce((n, x) => n + x.b.length, 0);
  }

  /** Counts a dropped or refused input: memory only, and at most one content-free event per code per batch. */
  _count(code, ctx) {
    this.counts[code] = (this.counts[code] ?? 0) + 1;
    if (ctx && !ctx.dropped.has(code)) {
      ctx.dropped.add(code);
      ctx.dropEvents.push({ type: "dropped", code }); // shared with every _txn of the batch: kept if one fails
    }
  }

  /** All or nothing for one step that may fail halfway (a control message, an admin commit): fn(s, c) runs on a
   * copy of what one step can change (the top-level maps, the inbox seen list and the one group `gid`; a step
   * never touches another group) with its own posts, events and buffers to zero. Only if fn returns are they
   * merged into d and ctx (in place, so callers holding d's objects see the result). If it throws, nothing it did
   * is kept: no post, no event, no state, and nothing is zeroed (the stored state still uses those secrets).
   * Counters (memory) and their "dropped" events are kept either way. Cost: a copy of that group per step. */
  async _txn(d, ctx, gid, fn) {
    const s = { ...d, invites: structuredClone(d.invites), joins: structuredClone(d.joins), rejoin: structuredClone(d.rejoin), seen: d.seen.slice(), groups: { ...d.groups } };
    const own = gid && Object.hasOwn(d.groups, gid);
    if (own) s.groups[gid] = structuredClone(d.groups[gid]);
    const c = { posts: [], events: [], zero: [], subscribe: [], unsubscribe: [], dropped: ctx.dropped, dropEvents: ctx.dropEvents };
    const result = await fn(s, c);
    const into = (a, b) => {
      for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) delete a[k];
      Object.assign(a, b);
    };
    into(d.invites, s.invites);
    into(d.joins, s.joins);
    into(d.rejoin, s.rejoin);
    d.seen.splice(0, d.seen.length, ...s.seen);
    if (gid) {
      if (!Object.hasOwn(s.groups, gid)) delete d.groups[gid];
      else if (own) into(d.groups[gid], s.groups[gid]);
      else d.groups[gid] = s.groups[gid];
    }
    for (const k of ["posts", "events", "zero", "subscribe", "unsubscribe"]) ctx[k].push(...c[k]);
    return result;
  }
  _state(g) {
    const s = mls.decodeGroupState(unb64(g.mls), 0)?.[0];
    if (!s) throw new Error("stored group state unreadable");
    return { ...s, clientConfig };
  }
  _keep(g, state) {
    g.mls = b64(mls.encodeGroupState(state));
    g.epoch = String(state.groupContext.epoch);
  }
  _group(d, id) {
    const g = Object.hasOwn(d.groups, id) ? d.groups[id] : null;
    if (!g) fail("UNKNOWN_GROUP");
    return g;
  }
  /** The chain's msg key for a name: Uint8Array, or null when the name has none. Throws RESOLVER_UNAVAILABLE
   * when the lookup itself failed, so callers can tell "unknown" from "mismatch". */
  async _chain(name) {
    let k;
    try {
      k = await this.resolver.msgKey(name);
    } catch {
      fail("RESOLVER_UNAVAILABLE");
    }
    return k instanceof Uint8Array && k.length === 32 ? k : null;
  }
  async _keyOf(pid) {
    return ADDR_RE.test(pid) ? unhex(pid.slice(2)) : this._chain(pid);
  }
  _keyPackage() {
    return mls.generateKeyPackageWithKey(
      { credentialType: "basic", identity: te.encode(this.pid) },
      mls.defaultCapabilities(),
      mls.defaultLifetime,
      [],
      { signKey: this.seedCopy(), publicKey: this.sigPub },
      this.impl,
    );
  }
  _control(ctx, toHex, kind, obj) {
    const to = unhex(toHex);
    const bytes = sealControl({ to, from: this.from, fromSecret: this.msgSecret, kind, bytes: te.encode(JSON.stringify(obj)), ts: this.now() });
    ctx.posts.push({ topic: inboxTopic(to), bytes });
  }
  _groupsInUse(d) {
    return Object.values(d.groups).filter((g) => g.status === "active").length + Object.keys(d.joins).length;
  }
  _liveOld(g) {
    const now = this.now();
    return (g.oldTopics ?? []).filter((o) => o.until > now).map((o) => o.topic);
  }
  _topicInUse(d, topic, exceptGid) {
    return Object.values(d.groups).some((g) => g.id !== exceptGid && g.status === "active" && (g.topic === topic || this._liveOld(g).includes(topic)));
  }

  // ---------- reading ----------
  /** Group topics this device must be subscribed to (current topics, and old ones still in their grace time).
   * The caller also keeps its own inbox subscribed. */
  topics() {
    const out = [];
    for (const g of Object.values(this.data?.groups ?? {})) if (g.status === "active") out.push(g.topic, ...this._liveOld(g));
    return [...new Set(out)];
  }
  listGroups() {
    return Object.values(this.data.groups).map((g) => ({
      id: g.id,
      name: g.name,
      admin: g.admin,
      adminVerified: g.adminVerified !== false,
      role: g.role,
      status: g.status,
      epoch: g.epoch ?? null,
      topic: g.topic ?? null,
      catchingUp: !!g.behind,
      members: Object.entries(g.members ?? {}).map(([leaf, m]) => ({
        id: m.pid, leaf: Number(leaf), address: m.key, isAddress: ADDR_RE.test(m.pid), isAdmin: Number(leaf) === ADMIN_LEAF,
        verified: m.status === "verified" && !m.duplicate && !m.malformed, keyChanged: m.status === "changed", unknown: m.status === "unknown", duplicate: !!m.duplicate, malformed: !!m.malformed,
      })),
      invited: Object.keys(g.invites ?? {}),
    }));
  }
  listInvites() {
    return Object.values(this.data.invites).map(({ id, gid, groupName, from, claimedName, verified, ts, unchecked, contact }) => ({ id, groupId: gid, groupName, from, claimedName, verified, ts, unchecked: !!unchecked, contact: !!contact }));
  }
  stats() {
    return { ...this.counts };
  }

  // ---------- actions ----------
  /** createGroup(name, members[]) -> { id, invited: [ids], failed: [{ member, code }] }. You are the admin. */
  async createGroup(name, members = []) {
    name = String(name ?? "").trim();
    if (!name || name.length > LIMITS.groupNameChars) fail("BAD_GROUP_NAME");
    const pids = [...new Set(members.map(normalizeMember))].filter((p) => p !== this.pid);
    if (pids.length + 1 > LIMITS.members) fail("LIMIT_MEMBERS");
    const id = await this._mutate(async (d, ctx) => {
      if (this._groupsInUse(d) >= LIMITS.groups) fail("LIMIT_GROUPS");
      const kp = await this._keyPackage();
      const gid = rand(32);
      const state = await mls.createGroup(gid, kp.publicPackage, kp.privatePackage, [], this.impl, clientConfig);
      const topicKey = rand(32);
      const g = {
        id: hex(gid), name, nameEpoch: "0", admin: this.pid, adminKey: this.keyHex, adminVerified: true, role: "admin", status: "active",
        topicKey: hex(topicKey), topic: topicOf(topicKey), topicEpoch: "0", oldTopics: [], mls: "", epoch: "0", seen: [], held: [], commitLog: [], invites: {},
        members: {}, lastPath: this.now(), created: this.now(), served: {},
      };
      this._keep(g, state);
      await this._roster(g, state, ctx);
      d.groups[g.id] = g;
      ctx.subscribe.push(g.topic);
      ctx.events.push({ type: "created", groupId: g.id, name });
      return g.id;
    });
    const out = { id, invited: [], failed: [] };
    for (const p of pids) {
      try {
        await this.invite(id, p);
        out.invited.push(p);
      } catch (e) {
        out.failed.push({ member: p, code: e.code ?? "ERROR" });
      }
    }
    return out;
  }

  /** invite(groupId, member): admin only. Asks the member's device for a KeyPackage (sealed v2) and sends a plain
   * v1 line for apps that only read v1. A member whose name's key changed is re-added (old leaf removed). */
  async invite(groupId, member) {
    const pid = normalizeMember(member);
    const key = await this._keyOf(pid);
    if (!key) fail("NO_MSG_KEY");
    return this._mutate(async (d, ctx) => this._inviteIn(d, ctx, this._group(d, groupId), pid, key));
  }

  /** readd(groupId, member): admin only. Re-adds a current member under its name's key on the chain (its old leaf
   * is removed when its new key package comes). The member's device answers by itself only if it asked to be
   * re-added (requestReadd, or a restore); a device that no longer has the group sees an invitation; a device
   * that still has the group and didn't ask ignores it (nothing changes). No rate limit: the admin chooses. */
  async readd(groupId, member) {
    const pid = normalizeMember(member);
    const key = await this._keyOf(pid);
    if (!key) fail("NO_MSG_KEY");
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role !== "admin") fail("NOT_ADMIN");
      if (!leaves(this._state(g)).some((l) => l.pid === pid && l.index !== ADMIN_LEAF)) fail("NOT_MEMBER");
      return this._inviteIn(d, ctx, g, pid, key, true);
    });
  }

  /** requestReadd(groupId): a member that can't follow the group any more (needs-readd) asks the admin to
   * re-add this device. The admin's device does it by itself, at most once a week per member (or when the admin
   * calls readd). Asked again by tick() once a day until answered or 30 days pass. -> { asked } */
  async requestReadd(groupId) {
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role === "admin") fail("NOT_ADMIN");
      if (g.status !== "active") fail("NOT_ACTIVE");
      const cur = Object.hasOwn(d.rejoin, g.id) ? d.rejoin[g.id] : null;
      if (cur && this.now() - (cur.asked ?? cur.ts) < this.timings.rejoinAskAgainMs) return { asked: false };
      d.rejoin[g.id] = { admin: g.admin, adminKey: g.adminKey, adminVerified: g.adminVerified !== false, name: g.name, ts: cur?.ts ?? this.now(), asked: this.now(), readd: true };
      this._control(ctx, g.adminKey, "rejoin-request", { gid: g.id, restore: true });
      ctx.events.push({ type: "rejoin-requested", groupId: g.id, name: g.name, admin: g.admin });
      return { asked: true };
    });
  }
  _inviteIn(d, ctx, g, pid, key, rejoin = false) {
    if (g.role !== "admin") fail("NOT_ADMIN");
    if (g.status !== "active") fail("NOT_ACTIVE");
    if (pid === this.pid) fail("ALREADY_MEMBER");
    const state = this._state(g);
    const current = leaves(state).find((l) => l.pid === pid);
    if (current && eqBytes(current.key, key) && !rejoin) fail("ALREADY_MEMBER");
    const pending = Object.keys(g.invites).filter((p) => p !== pid).length;
    if (!current && leaves(state).length + pending + 1 > LIMITS.members) fail("LIMIT_MEMBERS");
    // inviting the same device again re-uses the request id, so an answer to the first request still counts
    const prev = Object.hasOwn(g.invites, pid) && g.invites[pid].key === hex(key) ? g.invites[pid] : null;
    const req = prev?.req ?? hex(rand(16));
    g.invites[pid] = { key: hex(key), req, ts: this.now() };
    this._control(ctx, hex(key), "kp-request", { gid: g.id, name: g.name, req });
    if (!rejoin) {
      const text = `${this.name || "Someone"} invited you to the group "${g.name}". Open the Logos node app to join.`;
      ctx.posts.push({ topic: inboxTopic(key), bytes: sealMessage({ to: key, from: this.from, fromSecret: this.msgSecret, text: text.slice(0, MAX_TEXT), ts: this.now() }) });
    }
    ctx.events.push({ type: "invite-sent", groupId: g.id, member: pid });
    return { member: pid };
  }

  /** acceptInvite(inviteId): answers an invitation with this device's KeyPackage; joined when the Welcome comes.
   * An invitation whose sender's key isn't the claimed name's shows `from: "k:<key>"`, `verified: false`, and the
   * group it leads to shows its admin as that address. A finished record of the same group (left, removed) is
   * cleared by accepting; an active one is refused. */
  async acceptInvite(inviteId) {
    return this._mutate(async (d, ctx) => {
      const inv = Object.hasOwn(d.invites, inviteId) ? d.invites[inviteId] : null;
      if (!inv) fail("UNKNOWN_INVITE");
      const old = Object.hasOwn(d.groups, inv.gid) ? d.groups[inv.gid] : null;
      if (old?.status === "active") fail("ALREADY_MEMBER");
      if (this._groupsInUse(d) >= LIMITS.groups) fail("LIMIT_GROUPS");
      if (inv.unchecked) {
        // the chain couldn't be read when it came: check the name now (RESOLVER_UNAVAILABLE: try again later),
        // so an outage never makes the group's admin a bare address for good
        const ok = eqBytes(await this._chain(inv.claimedName), unhex(inv.fromKey));
        if (ok) Object.assign(inv, { from: inv.claimedName, verified: true });
        if (ok) delete inv.claimedName;
        delete inv.unchecked;
      }
      if (old) delete d.groups[inv.gid];
      await this._answerInvite(d, ctx, inv);
      delete d.invites[inviteId];
    });
  }
  async declineInvite(inviteId) {
    return this._mutate(async (d) => {
      if (!Object.hasOwn(d.invites, inviteId)) fail("UNKNOWN_INVITE");
      delete d.invites[inviteId];
    });
  }
  async _answerInvite(d, ctx, inv) {
    const kp = await this._keyPackage();
    const k = joinKey(inv.gid, inv.fromKey);
    d.joins[k] = {
      gid: inv.gid, admin: inv.from, adminKey: inv.fromKey, adminVerified: inv.verified, req: inv.req, name: inv.groupName, ts: this.now(),
      kp: b64(mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_key_package", keyPackage: kp.publicPackage })),
      init: hex(kp.privatePackage.initPrivateKey), hpke: hex(kp.privatePackage.hpkePrivateKey),
    };
    if (inv.readd) d.joins[k].readd = true; // a re-add we asked for: its Welcome may replace our record
    this._control(ctx, inv.fromKey, "kp", { gid: inv.gid, req: inv.req, kp: d.joins[k].kp });
  }

  /** remove(groupId, member): admin only; one commit, then a new topic for those who stay. */
  async remove(groupId, member) {
    const pid = normalizeMember(member);
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role !== "admin") fail("NOT_ADMIN");
      if (g.status !== "active") fail("NOT_ACTIVE");
      if (pid === this.pid) fail("ADMIN_CANNOT_LEAVE");
      if (Object.hasOwn(g.invites, pid)) {
        delete g.invites[pid];
        return;
      }
      let state = this._state(g);
      const gone = leaves(state).filter((l) => l.pid === pid && l.index !== ADMIN_LEAF);
      if (!gone.length) fail("NOT_MEMBER");
      state = await this._removeLeaves(d, ctx, g, state, gone.map((l) => l.index));
      this._keep(g, state);
    });
  }

  /** Commits the removal of these leaves, then moves those who stay to a new topic (in the new epoch, which the
   * removed can't read). */
  async _removeLeaves(d, ctx, g, state, indices) {
    state = (await this._commit(d, ctx, g, state, indices.map((i) => ({ proposalType: "remove", remove: { removed: i } })), false)).state;
    state = await this._rotateTopic(ctx, g, state);
    await this._roster(g, state, ctx);
    return state;
  }
  async _rotateTopic(ctx, g, state) {
    const key = rand(32);
    const old = g.topic;
    state = await this._appMsg(ctx, g, state, { t: "topic", k: hex(key) }, [old, ...this._liveOld(g)]);
    this._switchTopic(ctx, g, key, state.groupContext.epoch);
    return state;
  }
  _switchTopic(ctx, g, key, epoch) {
    const now = this.now();
    g.oldTopics = [...(g.oldTopics ?? []).filter((o) => o.until > now && o.topic !== g.topic), { topic: g.topic, until: now + this.timings.topicGraceMs }];
    g.topicKey = hex(key);
    g.topic = topicOf(key);
    g.topicEpoch = String(epoch);
    ctx.subscribe.push(g.topic);
    ctx.events.push({ type: "topic-changed", groupId: g.id });
  }

  /** leave(groupId): asks the admin to remove this device, then forgets the group here. */
  async leave(groupId) {
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role === "admin") fail("ADMIN_CANNOT_LEAVE");
      if (g.status !== "active") fail("NOT_ACTIVE");
      await this._app(ctx, g, { t: "leave" });
      this._forget(g, ctx, "left");
      ctx.events.push({ type: "left", groupId });
    });
  }

  /** deleteGroup(groupId): forgets a group on this device (any role); nothing is sent. */
  async deleteGroup(groupId) {
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.status === "active") this._forget(g, ctx, "deleted");
      delete d.groups[groupId];
    });
  }

  /** rename(groupId, name): admin only; members show the new name. */
  async rename(groupId, name) {
    name = String(name ?? "").trim();
    if (!name || name.length > LIMITS.groupNameChars) fail("BAD_GROUP_NAME");
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.role !== "admin") fail("NOT_ADMIN");
      if (g.status !== "active") fail("NOT_ACTIVE");
      await this._app(ctx, g, { t: "rn", name });
      g.name = name;
      g.nameEpoch = g.epoch;
      g.nameGen = Number.MAX_SAFE_INTEGER; // the admin's own name is always current on its device
      ctx.events.push({ type: "renamed", groupId, name });
    });
  }

  /** send(groupId, text) -> { ts }. */
  async send(groupId, text) {
    if (typeof text !== "string" || !text.trim()) fail("EMPTY_TEXT");
    if (text.length > LIMITS.textChars) fail("TEXT_TOO_LONG");
    return this._mutate(async (d, ctx) => {
      const g = this._group(d, groupId);
      if (g.status !== "active") fail("NOT_ACTIVE");
      const ts = this.now();
      await this._app(ctx, g, { t: "m", text, ts });
      return { ts };
    });
  }

  async _app(ctx, g, obj) {
    this._keep(g, await this._appMsg(ctx, g, this._state(g), obj, [g.topic]));
  }
  async _appMsg(ctx, g, state, obj, topics) {
    const r = await mls.createApplicationMessage(state, te.encode(JSON.stringify(obj)), this.impl);
    const bytes = concat([FRAME], mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_private_message", privateMessage: r.privateMessage }));
    if (bytes.length > LIMITS.payloadBytes) fail("TEXT_TOO_LONG");
    pushCapped(g.seen, hashHex(bytes), LIMITS.seen); // our own copy comes back from the node
    for (const t of topics) ctx.posts.push({ topic: t, bytes });
    ctx.zero.push(...r.consumed);
    return r.newState;
  }

  /** An admin commit (after an empty one when #860 needs it), logged for resends and queued for posting on the
   * current topic and on old topics still in their grace time (members who haven't moved yet). */
  async _commit(d, ctx, g, state, proposals, repostTopic = true) {
    const addOnly = proposals.length > 0 && proposals.every((p) => p.proposalType === "add");
    if (addOnly && this.workaround860 && needsPathFirst(state)) state = (await this._commit(d, ctx, g, state, [], false)).state;
    const r = await mls.createCommit({ state, cipherSuite: this.impl }, { extraProposals: proposals, ratchetTreeExtension: true });
    const bytes = concat([FRAME], mls.encodeMlsMessage(r.commit));
    pushCapped(g.seen, hashHex(bytes), LIMITS.seen);
    pushCapped(g.commitLog, { e: String(state.groupContext.epoch), b: b64(bytes), t: this.now() }, LIMITS.commitLog);
    for (const t of [g.topic, ...this._liveOld(g)]) ctx.posts.push({ topic: t, bytes });
    ctx.zero.push(...r.consumed);
    if (!addOnly) g.lastPath = this.now();
    let next = r.newState;
    // a member who missed the topic-change message still follows commits on the old topic: tell it again there,
    // in the new epoch (readable by current members only)
    const old = this._liveOld(g);
    if (repostTopic && old.length) next = await this._appMsg(ctx, g, next, { t: "topic", k: g.topicKey }, old);
    return { state: next, welcome: r.welcome };
  }

  /** Leaves only what the UI needs to say "you left <name>": no keys, no topic, no member list. */
  _forget(g, ctx, status) {
    try {
      wipeState(this._state(g), this.seed);
    } catch {
      /* nothing to wipe */
    }
    if (g.topic) ctx.unsubscribe.push(g.topic, ...this._liveOld(g));
    const keep = { id: g.id, name: g.name, role: g.role, admin: g.admin, adminVerified: g.adminVerified, status, ended: this.now() };
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, keep);
  }

  /** Re-checks every leaf against the chain. Per leaf (keyed by leaf index): status "verified" (key = the name's
   * msg), "changed" (the chain says another key, or none), "unknown" (the lookup failed; no event). Two leaves with
   * one name, and names that aren't LNS names or self-certifying addresses, are flagged. */
  async _roster(g, state, ctx) {
    const before = g.members ?? {};
    const now = {};
    const count = new Map();
    const ls = leaves(state);
    for (const l of ls) count.set(l.pid, (count.get(l.pid) ?? 0) + 1);
    for (const l of ls) {
      const malformed = !wellFormed(l.pid, l.key);
      let status;
      if (malformed) status = "changed";
      else if (ADDR_RE.test(l.pid)) status = "verified";
      else {
        try {
          status = eqBytes(await this._chain(l.pid), l.key) ? "verified" : "changed";
        } catch {
          status = "unknown";
        }
      }
      const m = { pid: l.pid, key: hex(l.key), status };
      if (count.get(l.pid) > 1) m.duplicate = true;
      if (malformed) m.malformed = true;
      now[l.index] = m;
      const b = before[l.index];
      const same = b && b.pid === m.pid && b.key === m.key;
      if (status === "changed" && !malformed && !(same && b.status === "changed")) ctx.events.push({ type: "key-changed", groupId: g.id, member: l.pid });
      if ((m.duplicate || m.malformed) && !(same && (b.duplicate || b.malformed)))
        ctx.events.push({ type: "member-suspicious", groupId: g.id, leaf: l.index, member: malformed ? "k:" + m.key : l.pid, duplicate: !!m.duplicate, malformed });
    }
    const ids = (ms) => new Set(Object.values(ms).map((m) => `${m.pid}|${m.key}`));
    const a = ids(before);
    const b2 = ids(now);
    const added = Object.values(now).filter((m) => !a.has(`${m.pid}|${m.key}`)).map((m) => m.pid);
    const removed = Object.values(before).filter((m) => !b2.has(`${m.pid}|${m.key}`)).map((m) => m.pid);
    g.members = now;
    if (added.length || removed.length) ctx.events.push({ type: "members", groupId: g.id, added, removed, members: Object.values(now).map((m) => m.pid) });
  }

  // ---------- incoming ----------
  /** incoming(topic, bytes, meta) -> true when the payload was the group engine's (and is saved). Throws a
   * GroupError (STATE_CONFLICT or RESOLVER_UNAVAILABLE) when it couldn't be handled now: hand it in again later. */
  async incoming(topic, bytes, meta = {}) {
    const r = await this.incomingMany([{ topic, bytes, meta }]);
    if (r.failed.length) fail(r.error ?? "STATE_CONFLICT");
    return r.handled > 0;
  }

  /** incomingMany([{ topic, bytes, meta }]) -> { handled, failed, error }: how many payloads were the group
   * engine's, and the indices of those that could not be handled now (state conflict, names unavailable): hand
   * them in again; repeats are dropped by their hash. Input that fails authentication changes no stored state.
   * Payloads of one group are processed in epoch order (messages before the commit that closes their epoch).
   * Payloads that aren't the engine's (v1 messages, unknown topics) are left alone and not counted. */
  async incomingMany(items) {
    let handled = 0;
    let error;
    const failed = [];
    const controls = [];
    const byGroup = new Map();
    for (const [i, it] of items.entries()) {
      const bytes = it.bytes instanceof Uint8Array ? it.bytes : unb64(String(it.bytes));
      if (it.topic === this.inbox) {
        if (bytes[0] !== 2) continue; // v1: the chat's, not ours
        handled++;
        const h = hashHex(bytes);
        if (this.data.seen.includes(h)) {
          this._count("duplicate");
          continue;
        }
        const m = openControl(this.msgSecret, bytes); // authentication first, outside of any state write
        if (!m) {
          this._count("unreadable-control");
          continue;
        }
        controls.push({ i, h, m });
        continue;
      }
      const g = Object.values(this.data.groups).find((x) => x.status === "active" && (x.topic === it.topic || this._liveOld(x).includes(it.topic)));
      if (!g) continue;
      handled++;
      if (!byGroup.has(g.id)) byGroup.set(g.id, []);
      byGroup.get(g.id).push([i, bytes, it.topic !== g.topic]);
    }
    const onFail = (idx) => (e) => {
      failed.push(...idx);
      error = e?.code ?? "STATE_CONFLICT";
    };
    // All control messages of one call in ONE state write. Each runs all or nothing (_txn): one that fails halfway
    // leaves no trace, and one that can't be handled now (the chain can't be read) is handed back without holding
    // back the others. Only a message that had a lasting effect enters the seen list; a refused or useless one
    // changes nothing, so a repeat is harmless, and junk can't push real entries out of the list.
    if (controls.length) {
      await this._mutate(async (d, ctx) => {
        const later = []; // built on every attempt (a state conflict runs this again on the reloaded state)
        const down = new Set(); // names whose lookup failed in this call: not looked up again in it
        for (const c of controls) {
          if (d.seen.includes(c.h)) {
            this._count("duplicate");
            continue;
          }
          try {
            if ((await this._control_in(d, ctx, c.m, c.h, down)) === true) pushCapped(d.seen, c.h, LIMITS.seen);
          } catch (e) {
            if (e?.code !== "RESOLVER_UNAVAILABLE") throw e;
            later.push(c.i);
          }
        }
        if (later.length) ctx.events.push({ type: "names-unavailable", count: later.length });
        return later;
      }).then(
        (later) => {
          if (later.length) {
            failed.push(...later);
            error = "RESOLVER_UNAVAILABLE";
          }
        },
        onFail(controls.map((c) => c.i)),
      );
    }
    for (const [gid, list] of byGroup) {
      await this._mutate(async (d, ctx) => {
        const g = d.groups[gid];
        if (g?.status === "active") await this._groupBatch(d, ctx, g, list.map(([, b, old]) => ({ bytes: b, old })));
      }).catch(onFail(list.map(([i]) => i)));
    }
    return { handled, failed: failed.sort((a, b) => a - b), error };
  }

  _parse(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length < 2 || bytes.length > LIMITS.payloadBytes || bytes[0] !== FRAME) return null;
    const m = mls.decodeMlsMessage(bytes.subarray(1), 0)?.[0];
    if (!m || m.wireformat !== "mls_private_message") return { bytes, h: hashHex(bytes), bad: true };
    const pm = m.privateMessage;
    return { bytes, h: hashHex(bytes), pm, epoch: pm.epoch, commit: pm.contentType === "commit" };
  }

  /** Keeps a message that can't be checked before its commit: only for the next LIMITS.holdAhead epochs, within
   * a count and byte budget (the oldest go first), and nothing about it counts as "catching up" by itself. */
  _hold(g, it, ctx) {
    const b = b64(it.bytes);
    if (b.length > LIMITS.heldBytes) return this._count("held-too-big", ctx);
    const x = { h: it.h, e: String(it.epoch), b, t: this.now() };
    if (it.old) x.o = 1; // came on an old topic: only removed members and stragglers still post there
    g.held.push(x);
    let bytes = g.held.reduce((n, y) => n + y.b.length, 0);
    // over budget: evict what came on an old topic first, then the furthest epoch, then the oldest
    const rank = (y) => [y.o ? 0 : 1, -Number(BigInt(y.e) - BigInt(g.epoch)), y.t];
    const worse = (a, c) => {
      const ra = rank(a);
      const rc = rank(c);
      for (let i = 0; i < 3; i++) if (ra[i] !== rc[i]) return ra[i] < rc[i];
      return false;
    };
    while (g.held.length > LIMITS.held || bytes > LIMITS.heldBytes) {
      let w = 0;
      for (let i = 1; i < g.held.length; i++) if (worse(g.held[i], g.held[w])) w = i;
      bytes -= g.held.splice(w, 1)[0].b.length;
      this._count("held-evicted", ctx);
    }
  }

  async _groupBatch(d, ctx, g, list) {
    let state = this._state(g);
    const startEpoch = state.groupContext.epoch;
    const queue = [];
    for (const { bytes, old } of list) {
      let it;
      try {
        it = this._parse(bytes);
      } catch {
        it = null;
      }
      if (it) it.old = old;
      if (!it) {
        this._count("not-a-group-message", ctx);
        continue;
      }
      if (g.seen.includes(it.h) || g.held.some((x) => x.h === it.h)) {
        this._count("duplicate");
        continue;
      }
      if (it.bad) {
        this._count("not-a-private-message", ctx); // external commits and public messages: never processed
        continue;
      }
      if (hex(it.pm.groupId) !== g.id) {
        this._count("wrong-group", ctx);
        continue;
      }
      queue.push(it);
    }
    const order = (a, b) => (a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : (a.commit ? 1 : 0) - (b.commit ? 1 : 0));
    const leaving = [];
    queue.sort(order);
    while (queue.length && g.status === "active") {
      const it = queue.shift();
      if (g.seen.includes(it.h)) continue;
      const ahead = it.epoch - state.groupContext.epoch;
      if (ahead > BigInt(LIMITS.holdAhead)) {
        // unauthenticated, so not stored; but it may mean real commits were missed: a marker (no bytes) makes
        // tick() ask the admin (rate-limited), and the answer either catches up or clears it
        this._count("too-far-ahead", ctx);
        if (!g.ahead) g.ahead = { t: this.now() };
        continue;
      }
      if (ahead > 0n) {
        this._hold(g, it, ctx);
        continue;
      }
      const r = await this._one(d, ctx, g, state, it, leaving);
      state = r.state;
      if (r.epochChanged && g.status === "active") {
        const ready = g.held.filter((x) => BigInt(x.e) <= state.groupContext.epoch);
        g.held = g.held.filter((x) => BigInt(x.e) > state.groupContext.epoch);
        for (const x of ready) {
          const p = this._parse(unb64(x.b));
          if (p && !p.bad) queue.push(p);
        }
        queue.sort(order);
      }
    }
    if (g.status !== "active") return;
    // the admin removes members who asked to leave, if each leaf still holds the key that asked
    if (g.role === "admin" && leaving.length) {
      const ls = leaves(state).filter((l) => l.index !== ADMIN_LEAF && leaving.some((x) => x.index === l.index && x.key === hex(l.key)));
      if (ls.length) {
        // the messages above are kept even if this commit fails; the commit and its topic change are all or nothing
        this._keep(g, state);
        try {
          state = await this._txn(d, ctx, g.id, async (s, c) => {
            const g2 = s.groups[g.id];
            const st = await this._removeLeaves(s, c, g2, state, ls.map((l) => l.index));
            this._keep(g2, st);
            return st;
          });
        } catch (e) {
          this.lastLibraryError = String(e?.message ?? "");
          this._count("leave-commit-failed", ctx);
        }
      }
      if (ls.length < leaving.length) this._count("stale-leave", ctx);
    }
    this._keep(g, state);
    if (state.groupContext.epoch !== startEpoch) delete g.resendGap; // progress: resend back-off starts over
    if (g.behind && !g.held.length && !g.ahead) {
      delete g.behind;
      delete g.behindSince;
      ctx.events.push({ type: "caught-up", groupId: g.id });
    }
  }

  /** One message at or before the current epoch. Every library exception is caught: the message is dropped and
   * counted (memory only), the state stays as it was, and it isn't marked seen (it may be a forgery of a real id). */
  async _one(d, ctx, g, state, it, leaving) {
    const current = state.groupContext.epoch;
    let sender;
    let r;
    try {
      sender = await this._senderOf(state, it.pm);
      r = await mls.processPrivateMessage(state, it.pm, mls.makePskIndex(state, {}), this.impl, ONLY_ADMIN_COMMITS);
    } catch (e) {
      const msg = String(e?.message ?? "");
      this.lastLibraryError = msg; // memory only, for tests and debugging; never stored or emitted
      this._count(/too old|former epoch/.test(msg) ? "epoch-too-old" : /gen in the past/.test(msg) ? "already-read" : "library-error", ctx);
      return { state };
    }
    // Past this point nothing is caught: a failure aborts the whole batch's write (nothing half-applied), and
    // the message is marked seen only after everything it does is in place.
    ctx.zero.push(...r.consumed);
    let out = { state: r.newState };
    if (r.kind === "applicationMessage") this._onApp(d, ctx, g, r.newState, sender, r.message, it.epoch, it.epoch < current, leaving);
    else if (r.actionTaken === "reject") this._count(it.commit ? "commit-not-from-admin" : "proposal-refused", ctx);
    else if (it.commit) {
      const after = r.newState;
      if (after.groupActiveState?.kind === "removedFromGroup") {
        wipeState(after, this.seed);
        const readding = Object.values(d.joins).some((j) => j.gid === g.id && j.readd);
        this._forget(g, ctx, "removed");
        ctx.events.push({ type: "removed", groupId: g.id, ...(readding ? { readding: true } : {}) });
        return out; // the record is forgotten: no seen list left to update
      }
      this._trackGaps(g, ctx, current);
      await this._roster(g, after, ctx);
      out = { state: after, epochChanged: true };
    }
    pushCapped(g.seen, it.h, LIMITS.seen);
    return out;
  }

  async _senderOf(state, pm) {
    let sds = state.keySchedule.senderDataSecret;
    let tree = state.ratchetTree;
    if (pm.epoch !== state.groupContext.epoch) {
      const h = state.historicalReceiverData.get(pm.epoch);
      if (!h) throw new Error("epoch too old");
      sds = h.senderDataSecret;
      tree = h.ratchetTree;
    }
    const sd = await mls.internals["privateMessage.js"].decryptSenderData(pm, sds, this.impl);
    const node = tree[sd.leafIndex * 2];
    if (node?.nodeType !== "leaf") throw new Error("sender is not a leaf");
    return { index: sd.leafIndex, generation: sd.generation, pid: leafPid(node.leaf), key: leafMsgKey(node.leaf) };
  }

  /** Generation gaps per sender in an epoch = messages not (yet) received. Reported when the epoch closes. */
  _trackGaps(g, ctx, closedEpoch) {
    const gaps = g.gaps?.[String(closedEpoch)];
    if (gaps) {
      const missing = Object.values(gaps).reduce((n, x) => n + Math.max(0, x.max + 1 - x.got), 0);
      if (missing > 0) ctx.events.push({ type: "missed-messages", groupId: g.id, count: missing, epoch: String(closedEpoch) });
    }
    for (const e of Object.keys(g.gaps ?? {})) if (BigInt(e) < BigInt(closedEpoch) - 4n) delete g.gaps[e];
  }

  _onApp(d, ctx, g, state, sender, data, epoch, late, leaving) {
    let obj;
    try {
      obj = JSON.parse(td.decode(data));
    } catch {
      return this._count("bad-content", ctx);
    }
    g.gaps ??= {};
    const gaps = (g.gaps[String(epoch)] ??= {});
    const s = (gaps[sender.index] ??= { max: -1, got: 0 });
    if (!late) {
      s.max = Math.max(s.max, sender.generation);
      s.got++;
    }
    // who the sender is now: the leaf at that index must still hold the same name and key
    const m = g.members?.[sender.index];
    const stillHere = !!m && m.key === hex(sender.key) && m.pid === sender.pid;
    const fromAdmin = sender.index === ADMIN_LEAF && hex(sender.key) === g.adminKey;
    if (obj?.t === "m" && typeof obj.text === "string" && obj.text.length <= LIMITS.textChars) {
      const ok = wellFormed(sender.pid, sender.key);
      ctx.events.push({
        type: "message", groupId: g.id, from: ok ? sender.pid : "k:" + hex(sender.key), address: hex(sender.key), text: obj.text,
        ts: Number.isSafeInteger(obj.ts) ? obj.ts : null, late, verified: stillHere && m.status === "verified" && !m.duplicate,
        formerMember: !stillHere, suspicious: !ok || !!m?.duplicate,
      });
    } else if (obj?.t === "rn" && typeof obj.name === "string" && obj.name.length > 0 && obj.name.length <= LIMITS.groupNameChars) {
      if (!fromAdmin) return this._count("rename-not-from-admin", ctx);
      if (!newer(epoch, sender.generation, g.nameEpoch, g.nameGen)) return this._count("stale-rename", ctx); // a late rename never undoes a newer one
      g.name = obj.name;
      g.nameEpoch = String(epoch);
      g.nameGen = sender.generation;
      ctx.events.push({ type: "renamed", groupId: g.id, name: obj.name });
    } else if (obj?.t === "topic" && typeof obj.k === "string" && /^[0-9a-f]{64}$/.test(obj.k)) {
      if (!fromAdmin) return this._count("topic-not-from-admin", ctx);
      const key = unhex(obj.k);
      if (g.role === "admin" || topicOf(key) === g.topic) return;
      if (!newer(epoch, sender.generation, g.topicEpoch, g.topicGen)) return this._count("stale-topic", ctx);
      if (this._topicInUse(d, topicOf(key), g.id)) return this._count("topic-collision", ctx);
      this._switchTopic(ctx, g, key, epoch);
      g.topicGen = sender.generation;
    } else if (obj?.t === "leave") {
      // only a current request from a current leaf; the key is re-checked before anyone is removed
      if (g.role !== "admin" || sender.index === ADMIN_LEAF) return;
      if (late || !stillHere) return this._count("stale-leave", ctx);
      leaving.push({ index: sender.index, key: hex(sender.key) });
    } else this._count("bad-content", ctx);
  }

  // ---------- sealed control messages (v2) on the inbox ----------
  /** m is already authenticated (openControl): it really comes from the holder of m.fromKey. Most kinds are
   * matched by that key alone, against what this device recorded when it asked (a join is keyed by group id +
   * admin key, an invitation stores the invitee's key, a group stores its admin's key, a leaf holds its key), so
   * they need no chain lookup and an outage can't refuse them. Only two need the chain to say whose key it is: a
   * new invitation (kp-request) and a re-add request for a key change. A lookup that fails is never turned into
   * another identity: the message is handed back (RESOLVER_UNAVAILABLE) and tried again; only a new invitation,
   * after lookupTries calls, is kept as unchecked (shown as the address, re-checked when accepted).
   * Returns true when the message had an effect that must enter the seen list. */
  async _control_in(d, ctx, m, h, down) {
    if (NAMELESS_RE.test(m.from) && m.from !== "msg-" + m.fromKey.slice(0, 16)) return this._count("bad-sender", ctx);
    let body;
    try {
      body = JSON.parse(td.decode(m.bytes));
    } catch {
      return this._count("bad-control", ctx);
    }
    const gid = typeof body?.gid === "string" && /^[0-9a-f]{64}$/.test(body.gid) ? body.gid : null;
    if (!gid) return this._count("bad-control", ctx);
    // refusals that need no copy of the state: junk costs no group copy
    const pre = this._precheck(d, m, gid);
    if (pre) return this._count(pre, ctx);
    const who = this._who(m, h, down);
    try {
      // a kp-request never changes a group (only invitations and joins): no group copy for it
      return await this._txn(d, ctx, m.kind === "kp-request" ? null : gid, (s, c) => this._onControl(s, c, m, body, gid, who, h));
    } catch (e) {
      if (e?.code === "RESOLVER_UNAVAILABLE") {
        const k = e.deferredKp;
        const inv = k && Object.hasOwn(d.groups, k.gid) && Object.hasOwn(d.groups[k.gid].invites, k.pid) ? d.groups[k.gid].invites[k.pid] : null;
        if (inv && inv.kp !== k.kp) {
          inv.kp = k.kp; // tick() retries it once the chain is back
          ctx.events.push({ type: "invite-waiting", groupId: k.gid, member: k.pid, reason: "names-unavailable" });
        }
        throw e;
      }
      this.lastLibraryError = String(e?.message ?? "");
      this._count(e instanceof GroupError ? "control-refused" : "library-error", ctx);
      return false;
    }
  }

  /** Read-only refusals, before any copy is made. -> a counter code, or null to go on. */
  _precheck(d, m, gid) {
    const { kind, fromKey } = m;
    const g = Object.hasOwn(d.groups, gid) ? d.groups[gid] : null;
    const adminActive = g?.role === "admin" && g.status === "active";
    switch (kind) {
      case "kp-request":
        return null;
      case "kp":
        return adminActive && Object.values(g.invites).some((x) => x.key === fromKey) ? null : "control-refused";
      case "welcome":
        return Object.hasOwn(d.joins, joinKey(gid, fromKey)) ? null : "control-refused";
      case "resend-request":
        return adminActive && Object.entries(g.members ?? {}).some(([leaf, x]) => x.key === fromKey && Number(leaf) !== ADMIN_LEAF) ? null : "control-refused";
      case "commits":
        return g?.role === "member" && g.status === "active" && g.adminKey === fromKey ? null : "control-refused";
      case "rejoin-request":
        // a current leaf's key (restore), or a sender claiming the name of a current leaf (key change)
        return adminActive && Object.entries(g.members ?? {}).some(([leaf, x]) => Number(leaf) !== ADMIN_LEAF && (x.key === fromKey || x.pid === m.from)) ? null : "control-refused";
      default:
        return "bad-control";
    }
  }

  /** Counts one more failed try for message id h (memory, capped) and returns the count; at lookupTries the
   * message stops being handed back. */
  _tried(h) {
    const n = (this.tries.get(h) ?? 0) + 1;
    this.tries.delete(h);
    if (n < this.timings.lookupTries) {
      this.tries.set(h, n);
      while (this.tries.size > LIMITS.lookupTriesKept) this.tries.delete(this.tries.keys().next().value);
    }
    return n;
  }

  /** Who sent m, looked up only when a handler asks: resolve({ giveUp }) -> { pid, verified, claimed?, unchecked? }.
   * Throws RESOLVER_UNAVAILABLE when the chain can't be read now (and remembers the name as down for this call).
   * giveUp: after lookupTries failed calls, true (new invitations) keeps the sender as an unchecked address;
   * "refuse" (re-add requests, which the requester sends again daily) returns null. Never another identity. */
  _who(m, h, down) {
    let known = null;
    return {
      key: m.fromKey,
      resolve: async ({ giveUp = false } = {}) => {
        if (known) return known;
        if (NAMELESS_RE.test(m.from)) return (known = { pid: "k:" + m.fromKey, verified: true });
        const cacheKey = `${m.from}|${m.fromKey}`;
        if (this.now() - (this.lookups.get(cacheKey) ?? -Infinity) < this.timings.lookupCacheMs) return (known = { pid: m.from, verified: true });
        let verified;
        try {
          if (down.has(m.from)) fail("RESOLVER_UNAVAILABLE");
          verified = eqBytes(await this._chain(m.from), unhex(m.fromKey));
        } catch (e) {
          down.add(m.from);
          if (!giveUp || this._tried(h) < this.timings.lookupTries) throw e;
          // given up: a new invitation is kept as unchecked; anything else is refused (and asked again)
          return (known = giveUp === "refuse" ? null : { pid: "k:" + m.fromKey, verified: false, claimed: m.from, unchecked: true });
        }
        this.tries.delete(h);
        if (verified) this.lookups.set(cacheKey, this.now());
        return (known = verified ? { pid: m.from, verified: true } : { pid: "k:" + m.fromKey, verified: false, claimed: m.from });
      },
    };
  }

  /** Invitation rank: a contact (a name the page says the user talks to) > another name the chain vouches for
   * (names cost a deposit) > an address (free keys) > a sender claiming a name it doesn't hold (or unchecked). */
  _inviteRank(inv) {
    return !inv.verified ? 0 : ADDR_RE.test(inv.from) ? 1 : inv.contact ? 3 : 2;
  }

  /** Handles one authenticated control message inside its own _txn; returns true when it had an effect that
   * must enter the seen list, "unseen" for an effect a replay can't repeat (kept out of the list). */
  async _onControl(d, ctx, m, body, gid, who, h) {
    const fromKey = m.fromKey;
    const g = Object.hasOwn(d.groups, gid) ? d.groups[gid] : null;
    switch (m.kind) {
      case "kp-request": {
        if (typeof body.req !== "string" || body.req.length > 64 || typeof body.name !== "string") return this._count("bad-control", ctx);
        const groupName = body.name.slice(0, LIMITS.groupNameChars);
        // a re-add we asked for (restore, requestReadd): the admin key we recorded is the match, no lookup
        const rj = Object.hasOwn(d.rejoin, gid) ? d.rejoin[gid] : null;
        if (rj && rj.adminKey === fromKey && (g?.status !== "active" || (rj.readd && g.adminKey === fromKey))) {
          delete d.rejoin[gid];
          await this._answerInvite(d, ctx, { gid, groupName, from: rj.admin, fromKey, req: body.req, verified: rj.adminVerified !== false, readd: true });
          return true;
        }
        if (g?.status === "active") return this._count("control-useless", ctx);
        const id = hashHex(te.encode(`${gid}:${fromKey}`)); // one invitation per group and sender key
        if (Object.hasOwn(d.invites, id)) {
          const cur = d.invites[id];
          // same sender, same group: a new request id is news only in a NEWER message from that sender, so a
          // replayed older one can't put back an old id; such updates stay out of the seen list
          if (cur.req === body.req) return this._count("control-useless", ctx);
          if (m.ts <= (cur.sent ?? 0)) return this._count("stale-invite", ctx);
          Object.assign(cur, { groupName, req: body.req, ts: this.now(), sent: m.ts });
          return "unseen";
        }
        const w = await who.resolve({ giveUp: true });
        const inv = { id, gid, groupName, from: w.pid, fromKey, req: body.req, verified: w.verified, ts: this.now(), sent: m.ts };
        if (w.claimed) inv.claimedName = w.claimed;
        if (w.unchecked) inv.unchecked = true;
        if (w.verified && !ADDR_RE.test(w.pid) && this.isContact) {
          try {
            if ((await this.isContact(w.pid)) === true) inv.contact = true;
          } catch {
            /* not a contact */
          }
        }
        const all = Object.values(d.invites);
        if (all.filter((x) => x.fromKey === fromKey).length >= LIMITS.invitesPerSender) return this._count("too-many-invites-from-sender", ctx);
        const rank = this._inviteRank(inv);
        const oldest = (xs) => xs.sort((a, b) => a.ts - b.ts)[0];
        const ofRank = (r) => all.filter((x) => this._inviteRank(x) === r);
        let victim = null;
        if (rank === 1 && ofRank(1).length >= LIMITS.invitesAddress) {
          victim = oldest(all.filter((x) => this._inviteRank(x) <= 1)); // addresses only ever push out addresses or worse
        } else if (all.length >= LIMITS.invites) {
          // a newcomer pushes out the lowest rank below its own (oldest first), else the oldest of its own rank;
          // an unverified newcomer pushes out nothing
          for (let r = 0; r < rank && !victim; r++) victim = oldest(ofRank(r)) ?? null;
          if (!victim && rank >= 1) victim = oldest(ofRank(rank)) ?? null;
          if (!victim) return this._count("too-many-invites", ctx);
        }
        if (victim) {
          delete d.invites[victim.id];
          this._count("invite-evicted", ctx);
        }
        d.invites[id] = inv;
        ctx.events.push({ type: "invite", inviteId: id, groupId: gid, groupName, from: inv.from, claimedName: inv.claimedName, verified: inv.verified, ...(inv.unchecked ? { unchecked: true } : {}) });
        return true;
      }
      case "kp": {
        // the invitation is matched by the key it was sent to and its request id: no lookup of the sender
        const pid = Object.keys(g.invites).find((p) => g.invites[p].key === fromKey && g.invites[p].req === body.req);
        if (!pid) return this._count("control-refused", ctx);
        const msg = mls.decodeMlsMessage(unb64(String(body.kp)), 0)?.[0];
        if (msg?.wireformat !== "mls_key_package") return this._count("bad-control", ctx);
        return this._addFromKp(d, ctx, g, pid, body.kp, h);
      }
      case "welcome": {
        const k = joinKey(gid, fromKey);
        const j = d.joins[k]; // made when this device answered a kp-request from exactly this key
        // never overwrite a record from a Welcome, except a re-add this device asked its own admin for
        const replace = g && j.readd && (g.status !== "active" || g.adminKey === fromKey);
        if (g && !replace) return this._count("welcome-for-existing-group", ctx);
        if (typeof body.topicKey !== "string" || !/^[0-9a-f]{64}$/.test(body.topicKey)) return this._count("bad-control", ctx);
        const topic = topicOf(unhex(body.topicKey));
        if (this._topicInUse(d, topic, gid)) return this._count("topic-collision", ctx);
        const wm = mls.decodeMlsMessage(unb64(String(body.welcome)), 0)?.[0];
        const kpm = mls.decodeMlsMessage(unb64(j.kp), 0)?.[0];
        if (wm?.wireformat !== "mls_welcome" || !kpm) return this._count("bad-control", ctx);
        // copies only: ts-mls keeps the signature key it is given by reference inside the new state
        const priv = { initPrivateKey: unhex(j.init), hpkePrivateKey: unhex(j.hpke), signaturePrivateKey: this.seedCopy() };
        const state = await mls.joinGroup(wm.welcome, kpm.keyPackage, priv, mls.emptyPskIndex, this.impl, undefined, undefined, clientConfig);
        const admin = state.ratchetTree[ADMIN_LEAF * 2];
        if (hex(state.groupContext.groupId) !== gid) {
          wipeState(state, this.seed);
          return this._count("welcome-wrong-group", ctx);
        }
        if (admin?.nodeType !== "leaf" || hex(leafMsgKey(admin.leaf)) !== j.adminKey || (j.adminVerified && leafPid(admin.leaf) !== j.admin)) {
          wipeState(state, this.seed);
          return this._count("welcome-not-from-admin", ctx);
        }
        if (replace && g.status === "active" && state.groupContext.epoch <= BigInt(g.epoch ?? "0")) {
          wipeState(state, this.seed); // a re-add always moves the group forward: an older Welcome is a replay
          return this._count("stale-readd-welcome", ctx);
        }
        for (const [key, other] of Object.entries(d.joins)) if (other.gid === gid) delete d.joins[key];
        if (replace && g.status === "active") this._forget(g, ctx, "replaced");
        const ng = {
          id: gid, name: String(body.name ?? j.name).slice(0, LIMITS.groupNameChars), nameEpoch: String(state.groupContext.epoch), nameGen: -1,
          admin: j.admin, adminKey: j.adminKey, adminVerified: j.adminVerified, role: "member", status: "active",
          topicKey: body.topicKey, topic, topicEpoch: String(state.groupContext.epoch), topicGen: -1, oldTopics: [], mls: "", epoch: "0",
          seen: [], held: [], commitLog: [], invites: {}, members: {}, created: this.now(),
        };
        this._keep(ng, state);
        d.groups[gid] = ng;
        await this._roster(ng, state, ctx);
        ctx.subscribe.push(ng.topic);
        for (let i = ctx.unsubscribe.length - 1; i >= 0; i--) if (ctx.unsubscribe[i] === ng.topic) ctx.unsubscribe.splice(i, 1);
        ctx.events.push({ type: "joined", groupId: gid, name: ng.name, admin: ng.admin, adminVerified: ng.adminVerified, ...(replace ? { readd: true } : {}) });
        return true;
      }
      case "resend-request": {
        const state = this._state(g);
        // the member is the leaf that holds the sealing key (keys are unique in the tree): no lookup
        const member = leaves(state).find((l) => hex(l.key) === fromKey && l.index !== ADMIN_LEAF);
        if (!member) return this._count("control-refused", ctx); // removed members get nothing
        if (typeof body.n !== "string" || !/^[0-9a-f]{16,64}$/.test(body.n)) return this._count("bad-control", ctx);
        let from;
        try {
          from = BigInt(String(body.fromEpoch ?? "0"));
        } catch {
          return this._count("bad-control", ctx);
        }
        // never further back than this device's own join
        const joined = BigInt(g.added?.[fromKey] ?? "0");
        if (from < joined) from = joined;
        // back-off per member, whatever it asks for: the gap doubles (to 1 h) unless the member was quiet for
        // longer than both resendServeQuietMs and twice the gap. Only the continuation of the admin's own capped
        // answer (from >= where that answer stopped, recorded here) is answered at the base gap. And at most
        // resendPerDay answers in any 24 hours.
        g.served ??= {};
        const base = this.timings.resendServeGapMs;
        const sv = g.served[fromKey] ?? { t: 0, gap: base };
        const now = this.now();
        const cont = sv.next != null && from >= BigInt(sv.next);
        if (now - sv.t < (cont ? base : sv.gap)) return this._count("resend-rate-limited", ctx);
        const times = (sv.times ?? []).filter((t) => now - t < 86_400_000);
        if (times.length >= LIMITS.resendPerDay) return this._count("resend-daily-cap", ctx);
        if (this._outboxBytes(d) > LIMITS.outboxBytes) return this._count("resend-outbox-full", ctx);
        const quiet = now - sv.t >= Math.max(this.timings.resendServeQuietMs, 2 * sv.gap);
        const gap = cont ? sv.gap : quiet ? base : Math.min(sv.gap * 2, 3_600_000);
        const all = g.commitLog.filter((c) => BigInt(c.e) >= from);
        const items = all.slice(0, LIMITS.resendCommits);
        const more = all.length > items.length;
        // too old only when the log no longer reaches back to `from` (a capped answer just says more: true)
        const tooOld = from < BigInt(g.epoch) && (!g.commitLog.length || BigInt(g.commitLog[0].e) > from);
        g.served[fromKey] = { t: now, gap, times: [...times, now], next: more ? all[items.length].e : null };
        // chunks that fit a sealed control message; every chunk echoes the request's nonce and says where the
        // admin is and which topic is current, so a member that missed the topic change moves too
        const chunks = [[]];
        let size = 0;
        for (const c of items) {
          if (size + c.b.length > 40_000 && chunks.at(-1).length) {
            chunks.push([]);
            size = 0;
          }
          chunks.at(-1).push(c.b);
          size += c.b.length;
        }
        chunks.forEach((ch, i) =>
          this._control(ctx, fromKey, "commits", { gid, n: body.n, last: i === chunks.length - 1, items: ch, tooOld, more, epoch: g.epoch, topicKey: g.topicKey, topicEpoch: g.topicEpoch }),
        );
        return true;
      }
      case "commits": {
        // matched by the admin's key (_precheck): the commits themselves are the admin's own and are checked by
        // MLS, so applying them is always safe
        const list = (Array.isArray(body.items) ? body.items : []).filter((x) => typeof x === "string").slice(0, LIMITS.resendCommits).map((b) => ({ bytes: unb64(b), old: false }));
        await this._groupBatch(d, ctx, g, list);
        if (g.status !== "active") return true;
        // the topic, newer epoch wins (it is the admin's word, sealed with the admin's key)
        if (typeof body.topicKey === "string" && /^[0-9a-f]{64}$/.test(body.topicKey) && topicOf(unhex(body.topicKey)) !== g.topic) {
          let te2;
          try {
            te2 = BigInt(String(body.topicEpoch));
          } catch {
            te2 = -1n;
          }
          if (te2 > BigInt(g.topicEpoch ?? "0") && !this._topicInUse(d, topicOf(unhex(body.topicKey)), g.id)) {
            this._switchTopic(ctx, g, unhex(body.topicKey), te2);
            g.topicGen = -1;
          }
        }
        // Only an answer to our latest request may say "nothing else exists": then held messages that were
        // received before that request and claim an epoch beyond the admin's are forged, and are dropped. A
        // stale or replayed answer has no outstanding nonce and drops nothing.
        const rq = g.resendReq;
        if (rq && body.n === rq.n) {
          let adminEpoch = null;
          try {
            adminEpoch = BigInt(String(body.epoch));
          } catch {
            adminEpoch = null;
          }
          if (body.tooOld === true && !g.toldNeedsReadd) {
            g.toldNeedsReadd = true;
            ctx.events.push({ type: "needs-readd", groupId: g.id, reason: "the admin no longer has the commits this device missed" });
          }
          if (adminEpoch !== null && body.last === true) {
            const before = g.held.length;
            g.held = g.held.filter((x) => !(x.t <= rq.t && BigInt(x.e) > adminEpoch));
            for (let i = g.held.length; i < before; i++) this._count("forged-future", ctx);
            // the "far ahead" marker goes only if it is older than the request this answers (one set later may
            // be a real later message) and the admin's epoch is reached
            if (g.ahead && g.ahead.t <= rq.t && BigInt(g.epoch) >= adminEpoch) delete g.ahead;
            // still behind the admin (a capped answer, or commits made since): keep asking
            if (BigInt(g.epoch) < adminEpoch && !g.ahead) g.ahead = { t: rq.t };
            if (body.more === true) delete g.resendGap; // the rest comes at the admin's base gap
            delete g.resendReq;
            if (g.behind && !g.held.length && !g.ahead) {
              delete g.behind;
              delete g.behindSince;
              ctx.events.push({ type: "caught-up", groupId: g.id });
            }
          }
        }
        return true;
      }
      case "rejoin-request": {
        const state = this._state(g);
        const ls = leaves(state).filter((l) => l.index !== ADMIN_LEAF);
        // a restore with the same key: the leaf holding the sealing key is the match, no lookup. A key change:
        // the chain must say the sealing key is now that name's key (a failed lookup is retried, never refused).
        let pid;
        let keyChanged;
        const same = ls.find((l) => hex(l.key) === fromKey);
        if (same) {
          if (body.restore !== true) return this._count("control-refused", ctx);
          pid = same.pid;
          keyChanged = false;
        } else {
          const w = await who.resolve({ giveUp: "refuse" });
          if (!w) return this._count("lookup-gave-up", ctx); // the requester asks again tomorrow
          if (!w.verified || !ls.some((l) => l.pid === w.pid)) return this._count("control-refused", ctx); // removed members can't come back this way
          pid = w.pid;
          keyChanged = true;
        }
        const now = this.now();
        const pending = Object.hasOwn(g.invites, pid) ? g.invites[pid] : null;
        if (pending && pending.key === fromKey) {
          // already asked this very key: ask again (the first request may have been lost, or answered by a
          // device that still has the group because someone replayed its old restore request), at most every
          // kpResendGapMs
          if (pending.resent && now - pending.resent < this.timings.kpResendGapMs) return this._count("rejoin-rate-limited", ctx);
          pending.resent = now;
          this._control(ctx, fromKey, "kp-request", { gid, name: g.name, req: pending.req });
          return true;
        }
        g.rejoins ??= {};
        // per name and key (a replayed request for one key doesn't block another), and for key changes also per
        // name (new keys one after another don't buy one re-add each)
        const rk = `${pid}|${fromKey}`;
        const nk = `${pid}|key-change`;
        const gap = keyChanged ? this.timings.rejoinKeyChangeGapMs : this.timings.rejoinRestoreGapMs;
        if (now - (g.rejoins[rk] ?? 0) < gap) return this._count("rejoin-rate-limited", ctx);
        if (keyChanged && now - (g.rejoins[nk] ?? 0) < this.timings.rejoinKeyChangeGapMs) return this._count("rejoin-rate-limited", ctx);
        g.rejoins[rk] = now;
        if (keyChanged) g.rejoins[nk] = now;
        ctx.events.push({ type: "rejoin-request", groupId: gid, member: pid, reason: keyChanged ? "key-changed" : "restored" });
        this._inviteIn(d, ctx, g, pid, unhex(fromKey), true);
        return true;
      }
      default:
        return this._count("bad-control", ctx);
    }
  }

  /** The admin adds the invited device from its key package, all or nothing: the re-add's removal commit, the
   * topic change, the #860 empty commit and the Add are kept and posted only if every one of them worked. The
   * leaf must be the invited name's (or address's) key, now as at invite time. If the chain can't be read now,
   * the key package waits in the invitation (tick() retries it) and invite-waiting is emitted. A key package
   * ts-mls refuses ends the invitation (invite-failed BAD_KEY_PACKAGE); nothing else changes. */
  async _addFromKp(d, ctx, g, pid, kpB64, h = null) {
    const inv = g.invites[pid];
    const kp = mls.decodeMlsMessage(unb64(String(kpB64)), 0)?.[0]?.keyPackage;
    if (!kp) return this._count("bad-control", ctx);
    let keyNow;
    try {
      keyNow = await this._keyOf(pid);
    } catch (e) {
      if (e?.code !== "RESOLVER_UNAVAILABLE") throw e;
      if (h && this._tried(h) < this.timings.lookupTries) {
        // handed back to the caller AND kept in the invitation (by _control_in, outside this message's _txn),
        // so it isn't lost if the caller drops what it was handed back
        e.deferredKp = { gid: g.id, pid, kp: kpB64 };
        throw e;
      }
      if (inv.kp !== kpB64) {
        inv.kp = kpB64;
        ctx.events.push({ type: "invite-waiting", groupId: g.id, member: pid, reason: "names-unavailable" });
      }
      return true;
    }
    if (leafPid(kp.leafNode) !== pid || hex(leafMsgKey(kp.leafNode)) !== inv.key || !eqBytes(keyNow, unhex(inv.key))) {
      delete g.invites[pid];
      ctx.events.push({ type: "invite-failed", groupId: g.id, member: pid, code: "KEY_CHANGED" });
      return true;
    }
    try {
      await this._txn(d, ctx, g.id, async (s, c) => {
        const g2 = s.groups[g.id];
        let state = this._state(g2);
        const old = leaves(state).filter((l) => l.pid === pid && l.index !== ADMIN_LEAF);
        // A re-add removes the old leaf in its own commit first: ts-mls 1.6.4 decides "was I removed?" by
        // whether the device's leaf slot is blank afterwards, so a Remove and an Add that refills the same slot
        // in one commit leave the old device stuck ("No overlap between provided private keys and update path").
        // The removal also moves the group to a new topic, which the Welcome below carries.
        if (old.length) state = await this._removeLeaves(s, c, g2, state, old.map((l) => l.index));
        const r = await this._commit(s, c, g2, state, [{ proposalType: "add", add: { keyPackage: kp } }]);
        state = r.state;
        const welcome = mls.encodeMlsMessage({ version: "mls10", wireformat: "mls_welcome", welcome: r.welcome });
        this._keep(g2, state);
        delete g2.invites[pid];
        g2.added ??= {};
        g2.added[inv.key] = g2.epoch; // resends to this device never go further back than its join
        this._control(c, inv.key, "welcome", { gid: g2.id, name: g2.name, admin: g2.admin, topicKey: g2.topicKey, welcome: b64(welcome) });
        await this._roster(g2, state, c);
      });
    } catch (e) {
      this.lastLibraryError = String(e?.message ?? "");
      this._count("bad-key-package", ctx);
      delete g.invites[pid];
      ctx.events.push({ type: "invite-failed", groupId: g.id, member: pid, code: "BAD_KEY_PACKAGE" });
    }
    return true;
  }

  // ---------- time ----------
  /** tick(): call every few seconds to a minute. Retries posts, asks for missed commits (with back-off), drops
   * old held messages and old topics, and does the admin's daily self-update. */
  async tick() {
    await this._mutate(async (d, ctx) => {
      const now = this.now();
      for (const g of Object.values(d.groups)) {
        if (g.status !== "active") continue;
        const before = g.held.length;
        g.held = g.held.filter((x) => now - x.t <= this.timings.heldTtlMs);
        if (before !== g.held.length) this._count("held-expired", ctx);
        const expired = (g.oldTopics ?? []).filter((o) => o.until <= now).map((o) => o.topic);
        if (expired.length) {
          g.oldTopics = g.oldTopics.filter((o) => o.until > now);
          ctx.unsubscribe.push(...expired.filter((t) => t !== g.topic));
        }
        if (g.role === "member" && (g.held.length || g.ahead)) {
          const oldest = Math.min(...g.held.map((x) => x.t), g.ahead?.t ?? Infinity);
          const gap = g.resendGap ?? this.timings.resendGapMs;
          if (now - oldest > this.timings.resendAfterMs && now - (g.lastResend ?? 0) > gap) {
            g.lastResend = now;
            g.resendGap = Math.min(gap * 2, 3_600_000);
            // the nonce: only the answer to this request may clear held messages received before now
            g.resendReq = { n: hex(rand(16)), t: now };
            this._control(ctx, g.adminKey, "resend-request", { gid: g.id, fromEpoch: g.epoch, n: g.resendReq.n });
            if (!g.behind) {
              g.behind = true;
              g.behindSince = now;
              ctx.events.push({ type: "catching-up", groupId: g.id });
            }
          }
          if (g.behind && now - g.behindSince > this.timings.needsReaddAfterMs && !g.toldNeedsReadd) {
            g.toldNeedsReadd = true;
            ctx.events.push({ type: "needs-readd", groupId: g.id, reason: "missed commits could not be recovered" });
          }
        } else if (g.behind) {
          delete g.behind;
          delete g.behindSince;
        }
        if (g.role === "admin" && now - (g.lastPath ?? 0) > this.timings.adminRefreshMs) {
          // all or nothing: a self-update that fails posts nothing and is tried again later (not every tick)
          try {
            await this._txn(d, ctx, g.id, async (s, c) => {
              const g2 = s.groups[g.id];
              this._keep(g2, (await this._commit(s, c, g2, this._state(g2), [])).state);
            });
          } catch (e) {
            this.lastLibraryError = String(e?.message ?? "");
            this._count("self-update-failed", ctx);
            g.lastPath = now - this.timings.adminRefreshMs + this.timings.selfUpdateRetryMs;
          }
        }
        if (g.role === "admin") {
          for (const [p, inv] of Object.entries(g.invites)) if (now - inv.ts > this.timings.inviteTtlMs) delete g.invites[p];
          // key packages that came while the chain couldn't be read: try again (at most once a minute each)
          for (const [p, inv] of Object.entries(g.invites)) {
            if (!inv.kp || now - (this.kpTried.get(`${g.id}|${p}`) ?? 0) < this.timings.kpRetryMs) continue;
            this.kpTried.set(`${g.id}|${p}`, now);
            try {
              await this._addFromKp(d, ctx, g, p, inv.kp);
            } catch {
              delete inv.kp; // unreadable: the invitee can answer again
              this._count("bad-control", ctx);
            }
          }
          for (const [k, t] of Object.entries(g.rejoins ?? {})) if (now - t > this.timings.rejoinRestoreGapMs) delete g.rejoins[k];
        }
      }
      // accepted invitations whose Welcome never came, and restore requests never answered, stop counting
      for (const [k, j] of Object.entries(d.joins)) if (now - j.ts > this.timings.inviteTtlMs) delete d.joins[k];
      for (const [gid, r] of Object.entries(d.rejoin)) if (now - r.ts > this.timings.inviteTtlMs) delete d.rejoin[gid];
      // a re-add request not answered yet (lost, refused by the admin's rate limit, or the admin's chain lookup
      // failed): asked again once a day until it expires
      for (const [gid, r] of Object.entries(d.rejoin)) {
        if (now - (r.asked ?? r.ts) < this.timings.rejoinAskAgainMs) continue;
        r.asked = now;
        this._control(ctx, r.adminKey, "rejoin-request", { gid, restore: true });
      }
      for (const [id, inv] of Object.entries(d.invites)) if (now - inv.ts > this.timings.inviteTtlMs) delete d.invites[id];
    }).catch(() => {});
  }

  // ---------- backup ----------
  /** exportBackup() -> a plain object with the group list only (no keys, no MLS state, no topics). */
  exportBackup() {
    return this._backupOf(this.data);
  }
  _backupOf(d) {
    return {
      v: 1,
      kind: "names-groups",
      groups: Object.values(d.groups)
        .filter((g) => g.status === "active")
        .map((g) => ({ id: g.id, name: g.name, admin: g.admin, adminKey: g.adminKey, role: g.role, members: [...new Set(Object.values(g.members ?? {}).map((m) => m.pid))] })),
    };
  }
  /** importBackup(backup): on a restored device, asks each group's admin to re-add it. Groups this device was
   * the admin of can't be recovered (no one else can change their members): reported as admin-lost. */
  async importBackup(backup) {
    return this._mutate(async (d, ctx) => {
      for (const b of backup?.groups ?? []) {
        if (typeof b?.id !== "string" || !/^[0-9a-f]{64}$/.test(b.id) || (Object.hasOwn(d.groups, b.id) && d.groups[b.id].status === "active")) continue;
        if (b.role === "admin") {
          ctx.events.push({ type: "admin-lost", groupId: b.id, name: b.name });
          continue;
        }
        let adminKey = null;
        try {
          adminKey = ADDR_RE.test(b.admin) ? unhex(b.admin.slice(2)) : await this._chain(b.admin);
        } catch {
          // the chain can't be read now: the admin key the backup recorded (an outage is not "no address")
          adminKey = typeof b.adminKey === "string" && /^[0-9a-f]{64}$/.test(b.adminKey) ? unhex(b.adminKey) : null;
        }
        if (!adminKey) {
          ctx.events.push({ type: "needs-readd", groupId: b.id, reason: "the admin's messaging address can't be found" });
          continue;
        }
        d.rejoin[b.id] = { admin: b.admin, adminKey: hex(adminKey), adminVerified: true, name: b.name, ts: this.now(), asked: this.now() };
        this._control(ctx, hex(adminKey), "rejoin-request", { gid: b.id, restore: true });
        ctx.events.push({ type: "rejoin-requested", groupId: b.id, name: b.name, admin: b.admin });
      }
    });
  }
}
