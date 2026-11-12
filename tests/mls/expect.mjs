// The small part of vitest's `expect` that ts-mls's test-vector tests use (toBe, toStrictEqual, toBeNull,
// toThrow, rejects.toThrow), with vitest's strict rules: same types, typed arrays byte for byte, keys whose
// value is undefined count. Runs in Node and in the browser. selfTest() checks that it does fail when it should.
export class AssertionError extends Error {}

const show = (v) => {
  if (v instanceof Uint8Array) return `${v.constructor.name}(${v.length})[${Array.from(v.slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("")}${v.length > 16 ? "…" : ""}]`;
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "string") return JSON.stringify(v.length > 80 ? v.slice(0, 80) + "…" : v);
  if (typeof v === "function") return `[function ${v.name}]`;
  if (v && typeof v === "object") return `[${v.constructor?.name ?? "object"}]`;
  return String(v);
};

// Returns undefined when equal, otherwise a description of the first difference.
export function strictDiff(a, b, path = "$", seen = new Map()) {
  if (Object.is(a, b)) return undefined;
  if (typeof a !== typeof b) return `${path}: ${show(a)} vs ${show(b)} (type)`;
  if (a === null || b === null || typeof a !== "object") return `${path}: ${show(a)} vs ${show(b)}`;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return `${path}: ${show(a)} vs ${show(b)} (prototype)`;
  if (seen.get(a) === b) return undefined;
  seen.set(a, b);
  if (ArrayBuffer.isView(a)) {
    if (a.byteLength !== b.byteLength) return `${path}: length ${a.byteLength} vs ${b.byteLength}`;
    const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return `${path}[${i}]: ${x[i]} vs ${y[i]} in ${show(a)} vs ${show(b)}`;
    return undefined;
  }
  if (a instanceof ArrayBuffer) return strictDiff(new Uint8Array(a), new Uint8Array(b), path, seen);
  if (a instanceof Map) {
    if (a.size !== b.size) return `${path}: Map size ${a.size} vs ${b.size}`;
    for (const [k, v] of a) {
      if (!b.has(k)) return `${path}: Map key ${show(k)} missing`;
      const d = strictDiff(v, b.get(k), `${path}.get(${show(k)})`, seen);
      if (d) return d;
    }
    return undefined;
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return `${path}: Set size ${a.size} vs ${b.size}`;
    for (const k of a) if (!b.has(k)) return `${path}: Set member ${show(k)} missing`;
    return undefined;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return `${path}: length ${a.length} vs ${b.length}`;
    for (let i = 0; i < a.length; i++) {
      if ((i in a) !== (i in b)) return `${path}[${i}]: sparse vs present`;
      const d = strictDiff(a[i], b[i], `${path}[${i}]`, seen);
      if (d) return d;
    }
    return undefined;
  }
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join("\0") !== kb.join("\0")) return `${path}: keys [${ka}] vs [${kb}]`;
  for (const k of ka) {
    const d = strictDiff(a[k], b[k], `${path}.${k}`, seen);
    if (d) return d;
  }
  return undefined;
}

function checkThrown(err, expected) {
  if (expected === undefined) return;
  if (typeof expected === "function") {
    if (!(err instanceof expected)) throw new AssertionError(`expected a ${expected.name}, got ${err?.constructor?.name}: ${err?.message}`);
  } else if (typeof expected === "string") {
    if (!String(err?.message).includes(expected)) throw new AssertionError(`expected an error with "${expected}", got: ${err?.message}`);
  } else if (expected instanceof RegExp) {
    if (!expected.test(String(err?.message))) throw new AssertionError(`expected an error matching ${expected}, got: ${err?.message}`);
  }
}

export function expect(actual) {
  return {
    toBe(expected) {
      if (!Object.is(actual, expected)) throw new AssertionError(`expected ${show(actual)} to be ${show(expected)}`);
    },
    toStrictEqual(expected) {
      const d = strictDiff(actual, expected);
      if (d) throw new AssertionError(`not strictly equal: ${d}`);
    },
    toBeNull() {
      if (actual !== null) throw new AssertionError(`expected null, got ${show(actual)}`);
    },
    toThrow(expected) {
      let threw = false;
      let err;
      try {
        actual();
      } catch (e) {
        threw = true;
        err = e;
      }
      if (!threw) throw new AssertionError("expected the function to throw");
      checkThrown(err, expected);
    },
    rejects: {
      async toThrow(expected) {
        try {
          await actual;
        } catch (e) {
          checkThrown(e, expected);
          return;
        }
        throw new AssertionError("expected the promise to reject");
      },
    },
  };
}

// The shim must fail on differences, or a lenient compare could pass broken vectors.
export function selfTest() {
  const mustFail = [
    () => expect(new Uint8Array([1, 2])).toStrictEqual(new Uint8Array([1, 3])),
    () => expect(new Uint8Array([1, 2])).toStrictEqual(new Uint8Array([1, 2, 0])),
    () => expect(new Uint8Array([1])).toStrictEqual([1]),
    () => expect({ a: 1, b: undefined }).toStrictEqual({ a: 1 }),
    () => expect({ a: { b: [1, 2] } }).toStrictEqual({ a: { b: [1, 3] } }),
    () => expect(new Map([[1, new Uint8Array([1])]])).toStrictEqual(new Map([[1, new Uint8Array([2])]])),
    () => expect(1n).toStrictEqual(2n),
    () => expect("a").toBe("b"),
    () => expect(0).toBeNull(),
    () => expect(() => {}).toThrow(),
    () => expect(() => { throw new TypeError("x"); }).toThrow(RangeError),
  ];
  mustFail.forEach((f, i) => {
    let failed = false;
    try {
      f();
    } catch (e) {
      failed = e instanceof AssertionError;
    }
    if (!failed) throw new Error(`expect shim self-test ${i} did not fail`);
  });
  expect({ a: [new Uint8Array([1, 2])], b: 3n, c: undefined }).toStrictEqual({ c: undefined, b: 3n, a: [new Uint8Array([1, 2])] });
  expect(() => { throw new RangeError("y"); }).toThrow(RangeError);
  return mustFail.length + 2;
}
