// Test clients for the group engine: each one is a device with its own fake messaging node (tests/fake_waku.py),
// its own storage (compare-and-swap, like the versioned blob route server.py will have) and its own
// encryption, all sharing one fake chain (name -> msg key). Runs in Node 20 and in a browser page (there the
// nodes are reached through the page's origin, /node/<i>/..., because fake_waku.py sends no CORS headers).
import { createGroupEngine } from "../app/messages/groups.js";
import { openMessage } from "../app/messages/msg-crypto.js";
import { b64, unb64 } from "../app/messages/msg-v2.js";
import { ed25519 } from "../app/noble-curves/ed25519.js";
import { xchacha20poly1305 } from "../app/messages/noble-ciphers/chacha.js";

export class Net {
  constructor({ nodeUrl, ctlUrl, nodes }) {
    Object.assign(this, { nodeUrl, ctlUrl, nodes });
    this.chain = new Map(); // the fake chain: LNS name -> msg key
    this.clock = { offset: 0 };
    this.posted = []; // every payload any client posted: { from, topic, bytes }
    this.next = 0;
  }
  now = () => Date.now() + this.clock.offset;
  async ctl(path, body) {
    const r = await fetch(this.ctlUrl + path, { method: "POST", body: JSON.stringify(body ?? null) });
    if (!r.ok) throw new Error(`control ${path}: ${r.status}`);
  }
  /** A fresh node for a new client (nodes are reused across scenarios: restarted first). */
  async takeNode() {
    if (this.next >= this.nodes) throw new Error("out of fake nodes");
    const i = this.next++;
    await this.ctl(`/restart/${i}`);
    return i;
  }
  resolver() {
    // resolverDown: the chain can't be read (lookups throw), as when the node or the RPC is unreachable
    return {
      msgKey: async (name) => {
        if (this.resolverDown) throw new Error("chain unreachable");
        return this.chain.get(name) ?? null;
      },
    };
  }
}

export function memoryStorage() {
  const s = { version: 0, blob: null, writes: 0, conflicts: 0 };
  s.read = async () => (s.blob ? { version: s.version, blob: s.blob } : null);
  s.write = async (blob, base) => {
    if (base !== s.version) {
      s.conflicts++;
      return { ok: false, version: s.version };
    }
    s.version++;
    s.writes++;
    s.blob = blob;
    return { ok: true, version: s.version };
  };
  return s;
}

export function pageCipher() {
  const key = crypto.getRandomValues(new Uint8Array(32));
  return {
    async encrypt(bytes) {
      const nonce = crypto.getRandomValues(new Uint8Array(24));
      const ct = xchacha20poly1305(key, nonce).encrypt(bytes);
      const out = new Uint8Array(24 + ct.length);
      out.set(nonce);
      out.set(ct, 24);
      return out;
    },
    async decrypt(bytes) {
      return xchacha20poly1305(key, bytes.subarray(0, 24)).decrypt(bytes.subarray(24));
    },
  };
}

export class Client {
  /** Client.make(net, { name, seed, storage, cipher, node, publish }) */
  static async make(net, opts = {}) {
    const c = new Client();
    c.net = net;
    c.name = opts.name ?? "";
    c.seed = opts.seed ?? ed25519.utils.randomSecretKey();
    c.msgKey = ed25519.utils.toMontgomery(ed25519.getPublicKey(c.seed));
    c.msgSecret = ed25519.utils.toMontgomerySecret(c.seed);
    c.keyHex = Array.from(c.msgKey, (x) => x.toString(16).padStart(2, "0")).join("");
    c.node = opts.node ?? (await net.takeNode());
    c.base = net.nodeUrl(c.node);
    c.storage = opts.storage ?? memoryStorage();
    c.cipher = opts.cipher ?? pageCipher();
    c.events = [];
    c.v1 = [];
    c.retry = []; // items the engine couldn't handle yet (state conflict, chain unreachable): fed again next poll
    c.paused = false;
    if (c.name && opts.publish !== false) net.chain.set(c.name, c.msgKey);
    c.transport = {
      post: async (topic, bytes) => {
        const r = await fetch(c.base + "/messaging/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payload: b64(bytes), contentTopic: topic, ephemeral: false }) });
        if (!r.ok) throw new Error(`post ${r.status}`);
        net.posted.push({ from: c, topic, bytes });
      },
      subscribe: async (topics) => {
        const r = await fetch(c.base + "/messaging/v1/subscriptions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(topics) });
        if (!r.ok) throw new Error(`subscribe ${r.status}`);
      },
      unsubscribe: async (topics) => {
        await fetch(c.base + "/messaging/v1/subscriptions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(topics) });
      },
    };
    c.engine = await createGroupEngine({ me: { name: c.name, seed: c.seed }, transport: c.transport, resolver: net.resolver(), storage: c.storage, cipher: c.cipher, now: net.now, ...(opts.engine ?? {}) });
    c.engine.onEvent((e) => c.events.push(e));
    c.inbox = c.engine.inbox;
    await c.transport.subscribe([c.inbox]);
    return c;
  }
  get pid() {
    return this.name || "k:" + this.keyHex;
  }
  /** Reads what the node has (at most 50 kept between reads) and hands it to the engine. -> records read */
  async poll() {
    if (this.paused) return 0;
    let recs;
    try {
      const r = await fetch(this.base + "/messaging/v1/events/received");
      if (!r.ok) return 0;
      recs = await r.json();
    } catch {
      return 0; // node down
    }
    const items = this.retry.splice(0);
    for (const rec of recs) {
      const topic = rec?.message?.contentTopic;
      const bytes = unb64(rec?.message?.payload ?? "");
      if (topic === this.inbox && bytes[0] === 1) {
        const m = openMessage(this.msgSecret, bytes);
        if (m) this.v1.push(m);
      }
      items.push({ topic, bytes, meta: { messageHash: rec.messageHash, source: rec.source } });
    }
    if (items.length) {
      const r = await this.engine.incomingMany(items);
      for (const i of r.failed) this.retry.push(items[i]);
    }
    return recs.length;
  }
  /** Re-subscribes everything (what server.py does when its node comes back: brings what it missed). */
  async resubscribe() {
    await this.transport.subscribe([this.inbox, ...this.engine.topics()]);
  }
  of(type, pred = () => true) {
    return this.events.filter((e) => e.type === type && pred(e));
  }
  messages(gid) {
    return this.of("message", (e) => e.groupId === gid).map((e) => e.text);
  }
  group(gid) {
    return this.engine.listGroups().find((g) => g.id === gid);
  }
}

/** Polls everyone until nothing moves (and every outbox is empty); ticks once things are quiet. */
export async function settle(clients, rounds = 40) {
  for (let r = 0; r < rounds; r++) {
    let got = 0;
    for (const c of clients) got += await c.poll();
    if (got === 0) {
      const net = clients[0]?.net;
      const before = net?.posted.length;
      const pending = clients.some((c) => !c.paused && c.engine.data.outbox.length);
      for (const c of clients) if (!c.paused) await c.engine.tick();
      if (!pending && r > 0 && net?.posted.length === before) return; // quiet, and the ticks sent nothing
    }
  }
}

/** Accepts the newest invitation to `gid` on each client. */
export async function acceptAll(clients, gid) {
  for (const c of clients) {
    const inv = c.engine.listInvites().find((i) => i.groupId === gid);
    if (!inv) throw new Error(`${c.pid} has no invitation to the group`);
    await c.engine.acceptInvite(inv.id);
  }
}
