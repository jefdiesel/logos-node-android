// ts-mls 1.6.4 (MLS, RFC 9420) with @hpke/core 1.9.0 and @hpke/common 1.10.0, bundled into one ES module.
// NOT SHIPPED (groups Stage 1). Built by tools/mls/build.mjs with esbuild 0.28.2; do not edit by hand.
// Sources, from the npm registry, checked against the sha512 integrity in tools/mls/package-lock.json:
//   ts-mls 1.6.4 (sha512-BFb9qJ3V1+HIuifC+MtnlROEj3oc6NEzA7Ig1/LAmANDRhNay7UCnwkzijzHH9cav5wf1BoJw8KQ2mXiEhPy1Q==)
//   @hpke/core 1.9.0 (sha512-pFxWl1nNJeQCSUFs7+GAblHvXBCjn9EPN65vdKlYQil2aURaRxfGMO6vBKGqm1YHTKwiAxJQNEI70PbSowMP9Q==)
//   @hpke/common 1.10.0 (sha512-uVq9pTNERQ1GcFlHZzQx+a0ZMC81wQzkbNzJPEyR/l3AWM7fASd/qYN2Cnq6uL1NPEfwcD4lgOmfjjZfx2k2XA==)
// Licences: MIT, see LICENSE-ts-mls and LICENSE-hpke beside this file.
// @noble/* imports point at the app's vendored copies (2.4.0); see tools/mls/build.mjs for the mapping.
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod3) => function __require() {
  try {
    return mod3 || (0, cb[__getOwnPropNames(cb)[0]])((mod3 = { exports: {} }).exports, mod3), mod3.exports;
  } catch (e) {
    throw mod3 = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod3, isNodeMode, target) => (target = mod3 != null ? __create(__getProtoOf(mod3)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod3 || !mod3.__esModule ? __defProp(target, "default", { value: mod3, enumerable: true }) : target,
  mod3
));

// not-bundled:crypto
var require_crypto = __commonJS({
  "not-bundled:crypto"() {
    throw new Error("crypto is not in this bundle (MLS cipher suite 1 only)");
  }
});

// not-bundled:@hpke/chacha20poly1305
var require_chacha20poly1305 = __commonJS({
  "not-bundled:@hpke/chacha20poly1305"() {
    throw new Error("@hpke/chacha20poly1305 is not in this bundle (MLS cipher suite 1 only)");
  }
});

// not-bundled:@noble/ciphers/chacha.js
var require_chacha = __commonJS({
  "not-bundled:@noble/ciphers/chacha.js"() {
    throw new Error("@noble/ciphers/chacha.js is not in this bundle (MLS cipher suite 1 only)");
  }
});

// not-bundled:@hpke/dhkem-x448
var require_dhkem_x448 = __commonJS({
  "not-bundled:@hpke/dhkem-x448"() {
    throw new Error("@hpke/dhkem-x448 is not in this bundle (MLS cipher suite 1 only)");
  }
});

// not-bundled:@hpke/ml-kem
var require_ml_kem = __commonJS({
  "not-bundled:@hpke/ml-kem"() {
    throw new Error("@hpke/ml-kem is not in this bundle (MLS cipher suite 1 only)");
  }
});

// not-bundled:@hpke/hybridkem-x-wing
var require_hybridkem_x_wing = __commonJS({
  "not-bundled:@hpke/hybridkem-x-wing"() {
    throw new Error("@hpke/hybridkem-x-wing is not in this bundle (MLS cipher suite 1 only)");
  }
});

// not-bundled:@noble/curves/ed448.js
var require_ed448 = __commonJS({
  "not-bundled:@noble/curves/ed448.js"() {
    throw new Error("@noble/curves/ed448.js is not in this bundle (MLS cipher suite 1 only)");
  }
});

// not-bundled:@noble/curves/nist.js
var require_nist = __commonJS({
  "not-bundled:@noble/curves/nist.js"() {
    throw new Error("@noble/curves/nist.js is not in this bundle (MLS cipher suite 1 only)");
  }
});

// not-bundled:@noble/post-quantum/ml-dsa.js
var require_ml_dsa = __commonJS({
  "not-bundled:@noble/post-quantum/ml-dsa.js"() {
    throw new Error("@noble/post-quantum/ml-dsa.js is not in this bundle (MLS cipher suite 1 only)");
  }
});

// node_modules/ts-mls/dist/src/codec/tlsEncoder.js
var tlsEncoder_exports = {};
__export(tlsEncoder_exports, {
  composeBufferEncoders: () => composeBufferEncoders,
  contramapBufferEncoder: () => contramapBufferEncoder,
  contramapBufferEncoders: () => contramapBufferEncoders,
  encVoid: () => encVoid,
  encode: () => encode
});
function encode(enc) {
  return (t) => {
    const [len, write] = enc(t);
    const buf = new ArrayBuffer(len);
    write(0, buf);
    return new Uint8Array(buf);
  };
}
function contramapBufferEncoder(enc, f) {
  return (u) => enc(f(u));
}
function contramapBufferEncoders(encoders, toTuple) {
  return (value) => {
    const values = toTuple(value);
    let totalLength = 0;
    let writeTotal = (_offset, _buffer) => {
    };
    for (let i = 0; i < encoders.length; i++) {
      const [len, write] = encoders[i](values[i]);
      const oldFunc = writeTotal;
      const currentLen = totalLength;
      writeTotal = (offset, buffer) => {
        oldFunc(offset, buffer);
        write(offset + currentLen, buffer);
      };
      totalLength += len;
    }
    return [totalLength, writeTotal];
  };
}
function composeBufferEncoders(encoders) {
  return (values) => contramapBufferEncoders(encoders, (t) => t)(values);
}
var encVoid = [0, () => {
}];

// node_modules/ts-mls/dist/src/codec/number.js
var uint8Encoder = (n) => [
  1,
  (offset, buffer) => {
    const view = new DataView(buffer);
    view.setUint8(offset, n);
  }
];
var encodeUint8 = encode(uint8Encoder);
var decodeUint8 = (b, offset) => {
  const value = b.at(offset);
  return value !== void 0 ? [value, 1] : void 0;
};
var uint16Encoder = (n) => [
  2,
  (offset, buffer) => {
    const view = new DataView(buffer);
    view.setUint16(offset, n);
  }
];
var encodeUint16 = encode(uint16Encoder);
var decodeUint16 = (b, offset) => {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    return [view.getUint16(offset), 2];
  } catch (e) {
    return void 0;
  }
};
var uint32Encoder = (n) => [
  4,
  (offset, buffer) => {
    const view = new DataView(buffer);
    view.setUint32(offset, n);
  }
];
var encodeUint32 = encode(uint32Encoder);
var decodeUint32 = (b, offset) => {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    return [view.getUint32(offset), 4];
  } catch (e) {
    return void 0;
  }
};
var uint64Encoder = (n) => [
  8,
  (offset, buffer) => {
    const view = new DataView(buffer);
    view.setBigUint64(offset, n);
  }
];
var encodeUint64 = encode(uint64Encoder);
var decodeUint64 = (b, offset) => {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  try {
    return [view.getBigUint64(offset), 8];
  } catch (e) {
    return void 0;
  }
};

// node_modules/ts-mls/dist/src/codec/tlsDecoder.js
var tlsDecoder_exports = {};
__export(tlsDecoder_exports, {
  failDecoder: () => failDecoder,
  flatMapDecoder: () => flatMapDecoder,
  flatMapDecoderAndMap: () => flatMapDecoderAndMap,
  mapDecoder: () => mapDecoder,
  mapDecoderOption: () => mapDecoderOption,
  mapDecoders: () => mapDecoders,
  mapDecodersOption: () => mapDecodersOption,
  orDecoder: () => orDecoder,
  succeedDecoder: () => succeedDecoder
});
function mapDecoder(dec, f) {
  return (b, offset) => {
    const x = dec(b, offset);
    if (x !== void 0) {
      const [t, l] = x;
      return [f(t), l];
    }
  };
}
function mapDecodersOption(decoders, f) {
  return (b, offset) => {
    const initial = mapDecoders(decoders, f)(b, offset);
    if (initial === void 0)
      return void 0;
    else {
      const [r, len] = initial;
      return r !== void 0 ? [r, len] : void 0;
    }
  };
}
function mapDecoders(decoders, f) {
  return (b, offset) => {
    const result = decoders.reduce((acc, decoder) => {
      if (!acc)
        return void 0;
      const decoded = decoder(b, acc.offset);
      if (!decoded)
        return void 0;
      const [value, length] = decoded;
      return {
        values: [...acc.values, value],
        offset: acc.offset + length,
        totalLength: acc.totalLength + length
      };
    }, { values: [], offset, totalLength: 0 });
    if (!result)
      return;
    return [f(...result.values), result.totalLength];
  };
}
function mapDecoderOption(dec, f) {
  return (b, offset) => {
    const x = dec(b, offset);
    if (x !== void 0) {
      const [t, l] = x;
      const u = f(t);
      return u !== void 0 ? [u, l] : void 0;
    }
  };
}
function flatMapDecoder(dec, f) {
  return flatMapDecoderAndMap(dec, f, (_t, u) => u);
}
function orDecoder(decT, decU) {
  return (b, offset) => {
    const t = decT(b, offset);
    return t ? t : decU(b, offset);
  };
}
function flatMapDecoderAndMap(dec, f, g) {
  return (b, offset) => {
    const decodedT = dec(b, offset);
    if (decodedT !== void 0) {
      const [t, len] = decodedT;
      const decoderU = f(t);
      const decodedU = decoderU(b, offset + len);
      if (decodedU !== void 0) {
        const [u, len2] = decodedU;
        return [g(t, u), len + len2];
      }
    }
  };
}
function succeedDecoder(t) {
  return () => [t, 0];
}
function failDecoder() {
  return () => void 0;
}

// node_modules/ts-mls/dist/src/util/enumHelpers.js
function enumNumberToKey(t) {
  return (n) => Object.values(t).includes(n) ? reverseMap(t)[n] : void 0;
}
function reverseMap(obj) {
  return Object.entries(obj).reduce((acc, [key, value]) => ({
    ...acc,
    [value]: key
  }), {});
}
function openEnumNumberToKey(rec) {
  return (n) => {
    const decoded = enumNumberToKey(rec)(n);
    if (decoded === void 0)
      return n.toString();
    else
      return decoded;
  };
}
function openEnumNumberEncoder(rec) {
  return (s) => {
    const x = rec[s];
    if (x === void 0)
      return Number(s);
    else
      return x;
  };
}

// node_modules/ts-mls/dist/src/defaultProposalType.js
var defaultProposalTypes = {
  add: 1,
  update: 2,
  remove: 3,
  psk: 4,
  reinit: 5,
  external_init: 6,
  group_context_extensions: 7
};
var defaultProposalTypeEncoder = contramapBufferEncoder(uint16Encoder, (n) => defaultProposalTypes[n]);
var encodeDefaultProposalType = encode(defaultProposalTypeEncoder);
var decodeDefaultProposalType = mapDecoderOption(decodeUint16, enumNumberToKey(defaultProposalTypes));

// node_modules/ts-mls/dist/src/defaultExtensionType.js
var defaultExtensionTypes = {
  application_id: 1,
  ratchet_tree: 2,
  required_capabilities: 3,
  external_pub: 4,
  external_senders: 5
};
var defaultExtensionTypeEncoder = contramapBufferEncoder(uint16Encoder, (n) => defaultExtensionTypes[n]);
var encodeDefaultExtensionType = encode(defaultExtensionTypeEncoder);
var decodeDefaultExtensionType = mapDecoderOption(decodeUint16, enumNumberToKey(defaultExtensionTypes));

// node_modules/ts-mls/dist/src/incomingMessageAction.js
var acceptAll = () => "accept";

// node_modules/ts-mls/dist/src/codec/variableLength.js
var variableLength_exports = {};
__export(variableLength_exports, {
  base64RecordEncoder: () => base64RecordEncoder,
  bigintMapEncoder: () => bigintMapEncoder,
  decodeBase64Record: () => decodeBase64Record,
  decodeBigintMap: () => decodeBigintMap,
  decodeNumberRecord: () => decodeNumberRecord,
  decodeVarLenData: () => decodeVarLenData,
  decodeVarLenType: () => decodeVarLenType,
  determineLength: () => determineLength,
  lengthEncoder: () => lengthEncoder,
  numberRecordEncoder: () => numberRecordEncoder,
  varLenDataEncoder: () => varLenDataEncoder,
  varLenTypeEncoder: () => varLenTypeEncoder
});

// node_modules/ts-mls/dist/src/mlsError.js
var mlsError_exports = {};
__export(mlsError_exports, {
  CodecError: () => CodecError,
  CryptoError: () => CryptoError,
  CryptoVerificationError: () => CryptoVerificationError,
  DependencyError: () => DependencyError,
  InternalError: () => InternalError,
  MlsError: () => MlsError,
  UsageError: () => UsageError,
  ValidationError: () => ValidationError
});
var MlsError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "MlsError";
  }
};
var ValidationError = class extends MlsError {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
};
var CodecError = class extends MlsError {
  constructor(message) {
    super(message);
    this.name = "CodecError";
  }
};
var UsageError = class extends MlsError {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
};
var DependencyError = class extends MlsError {
  constructor(message) {
    super(message);
    this.name = "DependencyError";
  }
};
var CryptoVerificationError = class extends MlsError {
  constructor(message) {
    super(message);
    this.name = "CryptoVerificationError";
  }
};
var CryptoError = class extends MlsError {
  constructor(message) {
    super(message);
    this.name = "CryptoError";
  }
};
var InternalError = class extends MlsError {
  constructor(message) {
    super(`This error should never occur, if you see this please submit a bug report. Message: ${message}`);
    this.name = "InternalError";
  }
};

// node_modules/ts-mls/dist/src/util/byteArray.js
var byteArray_exports = {};
__export(byteArray_exports, {
  base64ToBytes: () => base64ToBytes,
  bytesToArrayBuffer: () => bytesToArrayBuffer,
  bytesToBase64: () => bytesToBase64,
  concatUint8Arrays: () => concatUint8Arrays,
  toBufferSource: () => toBufferSource,
  zeroOutUint8Array: () => zeroOutUint8Array
});
function bytesToArrayBuffer(b) {
  if (b.buffer instanceof ArrayBuffer) {
    if (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength) {
      return b.buffer;
    }
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  } else {
    const ab = new ArrayBuffer(b.byteLength);
    const arr = new Uint8Array(ab);
    arr.set(b, 0);
    return ab;
  }
}
function toBufferSource(b) {
  if (b.buffer instanceof ArrayBuffer)
    return b;
  const ab = new ArrayBuffer(b.byteLength);
  const arr = new Uint8Array(ab);
  arr.set(b, 0);
  return ab;
}
function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  } else {
    let binary = "";
    bytes.forEach((b) => binary += String.fromCharCode(b));
    return globalThis.btoa(binary);
  }
}
function base64ToBytes(base64) {
  if (typeof Buffer !== "undefined") {
    return Uint8Array.from(Buffer.from(base64, "base64"));
  } else {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }
}
function concatUint8Arrays(a, b) {
  const result = new Uint8Array(a.length + b.length);
  result.set(a, 0);
  result.set(b, a.length);
  return result;
}
function zeroOutUint8Array(buf) {
  crypto.getRandomValues(buf);
  for (let i = 0; i < buf.length; i++) {
    buf[i] ^= buf[i];
  }
}

// node_modules/ts-mls/dist/src/codec/variableLength.js
var varLenDataEncoder = (data) => {
  const [len, write] = lengthEncoder(data.length);
  return [
    len + data.length,
    (offset, buffer) => {
      write(offset, buffer);
      const view = new Uint8Array(buffer);
      view.set(data, offset + len);
    }
  ];
};
function lengthEncoder(len) {
  if (len < 64) {
    return [
      1,
      (offset, buffer) => {
        const view = new DataView(buffer);
        view.setUint8(offset, len & 63);
      }
    ];
  } else if (len < 16384) {
    return [
      2,
      (offset, buffer) => {
        const view = new DataView(buffer);
        view.setUint8(offset, len >> 8 & 63 | 64);
        view.setUint8(offset + 1, len & 255);
      }
    ];
  } else if (len < 1073741824) {
    return [
      4,
      (offset, buffer) => {
        const view = new DataView(buffer);
        view.setUint8(offset, len >> 24 & 63 | 128);
        view.setUint8(offset + 1, len >> 16 & 255);
        view.setUint8(offset + 2, len >> 8 & 255);
        view.setUint8(offset + 3, len & 255);
      }
    ];
  } else {
    throw new CodecError("Length too large to encode (max is 2^30 - 1)");
  }
}
function determineLength(data, offset = 0) {
  if (offset >= data.length) {
    throw new CodecError("Offset beyond buffer");
  }
  const firstByte = data[offset];
  const prefix = firstByte >> 6;
  if (prefix === 0) {
    return { length: firstByte & 63, lengthFieldSize: 1 };
  } else if (prefix === 1) {
    if (offset + 2 > data.length)
      throw new CodecError("Incomplete 2-byte length");
    return { length: (firstByte & 63) << 8 | data[offset + 1], lengthFieldSize: 2 };
  } else if (prefix === 2) {
    if (offset + 4 > data.length)
      throw new CodecError("Incomplete 4-byte length");
    return {
      length: (firstByte & 63) << 24 | data[offset + 1] << 16 | data[offset + 2] << 8 | data[offset + 3],
      lengthFieldSize: 4
    };
  } else {
    throw new CodecError("8-byte length not supported in this implementation");
  }
}
var decodeVarLenData = (buf, offset) => {
  if (offset >= buf.length) {
    throw new CodecError("Offset beyond buffer");
  }
  const { length, lengthFieldSize } = determineLength(buf, offset);
  const totalBytes = lengthFieldSize + length;
  if (offset + totalBytes > buf.length) {
    throw new CodecError("Data length exceeds buffer");
  }
  const data = buf.subarray(offset + lengthFieldSize, offset + totalBytes);
  return [data, totalBytes];
};
function varLenTypeEncoder(enc) {
  return (data) => {
    let totalLength = 0;
    let writeTotal = (_offset, _buffer) => {
    };
    for (let i = 0; i < data.length; i++) {
      const [len, write] = enc(data[i]);
      const oldFunc = writeTotal;
      const currentLen = totalLength;
      writeTotal = (offset, buffer) => {
        oldFunc(offset, buffer);
        write(offset + currentLen, buffer);
      };
      totalLength += len;
    }
    const [headerLength, writeLength] = lengthEncoder(totalLength);
    return [
      headerLength + totalLength,
      (offset, buffer) => {
        writeLength(offset, buffer);
        writeTotal(offset + headerLength, buffer);
      }
    ];
  };
}
function decodeVarLenType(dec) {
  return (b, offset) => {
    const d = decodeVarLenData(b, offset);
    if (d === void 0)
      return;
    const [totalBytes, totalLength] = d;
    let cursor = 0;
    const result = [];
    while (cursor < totalBytes.length) {
      const item = dec(totalBytes, cursor);
      if (item === void 0)
        return void 0;
      const [value, len] = item;
      result.push(value);
      cursor += len;
    }
    return [result, totalLength];
  };
}
function base64RecordEncoder(valueEncoder) {
  const entryEncoder = contramapBufferEncoders([contramapBufferEncoder(varLenDataEncoder, base64ToBytes), valueEncoder], ([key, value]) => [key, value]);
  return contramapBufferEncoders([varLenTypeEncoder(entryEncoder)], (record) => [Object.entries(record)]);
}
function decodeBase64Record(decodeValue) {
  return mapDecoder(decodeVarLenType(mapDecoders([mapDecoder(decodeVarLenData, bytesToBase64), decodeValue], (key, value) => [key, value])), (entries) => {
    const record = {};
    for (const [key, value] of entries) {
      record[key] = value;
    }
    return record;
  });
}
function numberRecordEncoder(numberEncoder, valueEncoder) {
  const entryEncoder = contramapBufferEncoders([numberEncoder, valueEncoder], ([key, value]) => [key, value]);
  return contramapBufferEncoder(varLenTypeEncoder(entryEncoder), (record) => Object.entries(record).map(([key, value]) => [Number(key), value]));
}
function decodeNumberRecord(decodeNumber, decodeValue) {
  return mapDecoder(decodeVarLenType(mapDecoders([decodeNumber, decodeValue], (key, value) => [key, value])), (entries) => {
    const record = {};
    for (const [key, value] of entries) {
      record[key] = value;
    }
    return record;
  });
}
function bigintMapEncoder(valueEncoder) {
  const entryEncoder = contramapBufferEncoders([uint64Encoder, valueEncoder], ([key, value]) => [key, value]);
  return contramapBufferEncoder(varLenTypeEncoder(entryEncoder), (map) => Array.from(map.entries()));
}
function decodeBigintMap(decodeValue) {
  return mapDecoder(decodeVarLenType(mapDecoders([decodeUint64, decodeValue], (key, value) => [key, value])), (entries) => new Map(entries));
}

// node_modules/ts-mls/dist/src/util/constantTimeCompare.js
var constantTimeCompare_exports = {};
__export(constantTimeCompare_exports, {
  constantTimeEqual: () => constantTimeEqual
});
function constantTimeEqual(a, b) {
  if (a.length !== b.length)
    return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

// node_modules/ts-mls/dist/src/extension.js
var extensionTypeEncoder = (t) => typeof t === "number" ? uint16Encoder(t) : defaultExtensionTypeEncoder(t);
var encodeExtensionType = encode(extensionTypeEncoder);
var decodeExtensionType = orDecoder(decodeDefaultExtensionType, decodeUint16);
var extensionEncoder = contramapBufferEncoders([extensionTypeEncoder, varLenDataEncoder], (e) => [e.extensionType, e.extensionData]);
var encodeExtension = encode(extensionEncoder);
var decodeExtension = mapDecoders([decodeExtensionType, decodeVarLenData], (extensionType, extensionData) => ({ extensionType, extensionData }));
function extensionEqual(a, b) {
  return a.extensionType === b.extensionType && constantTimeEqual(a.extensionData, b.extensionData);
}
function extensionsEqual(a, b) {
  if (a.length !== b.length)
    return false;
  return a.every((val, i) => extensionEqual(val, b[i]));
}
function extensionsSupportedByCapabilities(requiredExtensions, capabilities) {
  return requiredExtensions.filter((ex) => !isDefaultExtension(ex.extensionType)).every((ex) => capabilities.extensions.includes(extensionTypeToNumber(ex.extensionType)));
}
function isDefaultExtension(t) {
  return typeof t !== "number";
}
function extensionTypeToNumber(t) {
  return typeof t === "number" ? t : defaultExtensionTypes[t];
}

// node_modules/ts-mls/dist/src/credentialType.js
var credentialTypes = {
  basic: 1,
  x509: 2
};
var credentialTypeEncoder = contramapBufferEncoder(uint16Encoder, openEnumNumberEncoder(credentialTypes));
var encodeCredentialType = encode(credentialTypeEncoder);
var decodeCredentialType = mapDecoderOption(decodeUint16, openEnumNumberToKey(credentialTypes));

// node_modules/ts-mls/dist/src/credential.js
var credentialBasicEncoder = contramapBufferEncoders([credentialTypeEncoder, varLenDataEncoder], (c) => [c.credentialType, c.identity]);
var encodeCredentialBasic = encode(credentialBasicEncoder);
var credentialX509Encoder = contramapBufferEncoders([credentialTypeEncoder, varLenTypeEncoder(varLenDataEncoder)], (c) => [c.credentialType, c.certificates]);
var encodeCredentialX509 = encode(credentialX509Encoder);
var credentialCustomEncoder = contramapBufferEncoders([credentialTypeEncoder, varLenDataEncoder], (c) => [c.credentialType, c.data]);
var encodeCredentialCustom = encode(credentialCustomEncoder);
var credentialEncoder = (c) => {
  switch (c.credentialType) {
    case "basic":
      return credentialBasicEncoder(c);
    case "x509":
      return credentialX509Encoder(c);
    default:
      return credentialCustomEncoder(c);
  }
};
var encodeCredential = encode(credentialEncoder);
var decodeCredentialBasic = mapDecoder(decodeVarLenData, (identity) => ({
  credentialType: "basic",
  identity
}));
var decodeCredentialX509 = mapDecoder(decodeVarLenType(decodeVarLenData), (certificates) => ({ credentialType: "x509", certificates }));
var decodeCredential = flatMapDecoder(decodeCredentialType, (credentialType) => {
  switch (credentialType) {
    case "basic":
      return decodeCredentialBasic;
    case "x509":
      return decodeCredentialX509;
  }
});

// node_modules/ts-mls/dist/src/externalSender.js
var externalSenderEncoder = contramapBufferEncoders([varLenDataEncoder, credentialEncoder], (e) => [e.signaturePublicKey, e.credential]);
var encodeExternalSender = encode(externalSenderEncoder);
var decodeExternalSender = mapDecoders([decodeVarLenData, decodeCredential], (signaturePublicKey, credential) => ({ signaturePublicKey, credential }));

// node_modules/ts-mls/dist/src/messageProtectionPublic.js
var messageProtectionPublic_exports = {};
__export(messageProtectionPublic_exports, {
  protectExternalProposalPublic: () => protectExternalProposalPublic,
  protectProposalPublic: () => protectProposalPublic,
  protectPublicMessage: () => protectPublicMessage,
  unprotectPublicMessage: () => unprotectPublicMessage
});

// node_modules/ts-mls/dist/src/authenticatedContent.js
var authenticatedContent_exports = {};
__export(authenticatedContent_exports, {
  authenticatedContentEncoder: () => authenticatedContentEncoder,
  authenticatedContentTBMEncoder: () => authenticatedContentTBMEncoder,
  createMembershipTag: () => createMembershipTag,
  decodeAuthenticatedContent: () => decodeAuthenticatedContent,
  encodeAuthenticatedContent: () => encodeAuthenticatedContent,
  encodeAuthenticatedContentTBM: () => encodeAuthenticatedContentTBM,
  makeProposalRef: () => makeProposalRef,
  verifyMembershipTag: () => verifyMembershipTag
});

// node_modules/ts-mls/dist/src/crypto/hash.js
var hash_exports = {};
__export(hash_exports, {
  refhash: () => refhash
});
function refhash(label, value, h) {
  return h.digest(encodeRefHash(label, value));
}
function encodeRefHash(label, value) {
  const labelBytes = new TextEncoder().encode(label);
  const enc = composeBufferEncoders([varLenDataEncoder, varLenDataEncoder]);
  return encode(enc)([labelBytes, value]);
}

// node_modules/ts-mls/dist/src/framedContent.js
var framedContent_exports = {};
__export(framedContent_exports, {
  createConfirmationTag: () => createConfirmationTag,
  createContentCommitSignature: () => createContentCommitSignature,
  decodeFramedContent: () => decodeFramedContent,
  decodeFramedContentApplicationData: () => decodeFramedContentApplicationData,
  decodeFramedContentAuthData: () => decodeFramedContentAuthData,
  decodeFramedContentAuthDataCommit: () => decodeFramedContentAuthDataCommit,
  decodeFramedContentCommitData: () => decodeFramedContentCommitData,
  decodeFramedContentInfo: () => decodeFramedContentInfo,
  decodeFramedContentProposalData: () => decodeFramedContentProposalData,
  encodeFramedContent: () => encodeFramedContent,
  encodeFramedContentApplicationData: () => encodeFramedContentApplicationData,
  encodeFramedContentAuthData: () => encodeFramedContentAuthData,
  encodeFramedContentCommitData: () => encodeFramedContentCommitData,
  encodeFramedContentInfo: () => encodeFramedContentInfo,
  encodeFramedContentProposalData: () => encodeFramedContentProposalData,
  encodeFramedContentTBS: () => encodeFramedContentTBS,
  encodeSenderInfo: () => encodeSenderInfo,
  framedContentApplicationDataEncoder: () => framedContentApplicationDataEncoder,
  framedContentAuthDataEncoder: () => framedContentAuthDataEncoder,
  framedContentCommitDataEncoder: () => framedContentCommitDataEncoder,
  framedContentEncoder: () => framedContentEncoder,
  framedContentInfoEncoder: () => framedContentInfoEncoder,
  framedContentProposalDataEncoder: () => framedContentProposalDataEncoder,
  framedContentTBSEncoder: () => framedContentTBSEncoder,
  senderInfoEncoder: () => senderInfoEncoder,
  signFramedContentApplicationOrProposal: () => signFramedContentApplicationOrProposal,
  signFramedContentTBS: () => signFramedContentTBS,
  toTbs: () => toTbs2,
  verifyConfirmationTag: () => verifyConfirmationTag,
  verifyFramedContentSignature: () => verifyFramedContentSignature
});

// node_modules/ts-mls/dist/src/commit.js
var commit_exports = {};
__export(commit_exports, {
  commitEncoder: () => commitEncoder,
  decodeCommit: () => decodeCommit,
  encodeCommit: () => encodeCommit
});

// node_modules/ts-mls/dist/src/codec/optional.js
function optionalEncoder(encodeT) {
  return (t) => {
    if (t) {
      const [len, write] = encodeT(t);
      return [
        len + 1,
        (offset, buffer) => {
          const view = new DataView(buffer);
          view.setUint8(offset, 1);
          write(offset + 1, buffer);
        }
      ];
    } else {
      return [
        1,
        (offset, buffer) => {
          const view = new DataView(buffer);
          view.setUint8(offset, 0);
        }
      ];
    }
  };
}
function decodeOptional(decodeT) {
  return (b, offset) => {
    const presenceOctet = decodeUint8(b, offset)?.[0];
    if (presenceOctet == 1) {
      const result = decodeT(b, offset + 1);
      return result === void 0 ? void 0 : [result[0], result[1] + 1];
    } else {
      return [void 0, 1];
    }
  };
}

// node_modules/ts-mls/dist/src/proposal.js
var proposal_exports = {};
__export(proposal_exports, {
  addEncoder: () => addEncoder,
  decodeAdd: () => decodeAdd,
  decodeExternalInit: () => decodeExternalInit,
  decodeGroupContextExtensions: () => decodeGroupContextExtensions,
  decodePSK: () => decodePSK,
  decodeProposal: () => decodeProposal,
  decodeProposalAdd: () => decodeProposalAdd,
  decodeProposalCustom: () => decodeProposalCustom,
  decodeProposalExternalInit: () => decodeProposalExternalInit,
  decodeProposalGroupContextExtensions: () => decodeProposalGroupContextExtensions,
  decodeProposalPSK: () => decodeProposalPSK,
  decodeProposalReinit: () => decodeProposalReinit,
  decodeProposalRemove: () => decodeProposalRemove,
  decodeProposalUpdate: () => decodeProposalUpdate,
  decodeReinit: () => decodeReinit,
  decodeRemove: () => decodeRemove,
  decodeUpdate: () => decodeUpdate,
  encodeAdd: () => encodeAdd,
  encodeExternalInit: () => encodeExternalInit,
  encodeGroupContextExtensions: () => encodeGroupContextExtensions,
  encodePSK: () => encodePSK,
  encodeProposal: () => encodeProposal,
  encodeProposalAdd: () => encodeProposalAdd,
  encodeProposalCustom: () => encodeProposalCustom,
  encodeProposalExternalInit: () => encodeProposalExternalInit,
  encodeProposalGroupContextExtensions: () => encodeProposalGroupContextExtensions,
  encodeProposalPSK: () => encodeProposalPSK,
  encodeProposalReinit: () => encodeProposalReinit,
  encodeProposalRemove: () => encodeProposalRemove,
  encodeProposalUpdate: () => encodeProposalUpdate,
  encodeReinit: () => encodeReinit,
  encodeRemove: () => encodeRemove,
  encodeUpdate: () => encodeUpdate,
  externalInitEncoder: () => externalInitEncoder,
  groupContextExtensionsEncoder: () => groupContextExtensionsEncoder,
  proposalAddEncoder: () => proposalAddEncoder,
  proposalCustomEncoder: () => proposalCustomEncoder,
  proposalEncoder: () => proposalEncoder,
  proposalExternalInitEncoder: () => proposalExternalInitEncoder,
  proposalGroupContextExtensionsEncoder: () => proposalGroupContextExtensionsEncoder,
  proposalPSKEncoder: () => proposalPSKEncoder,
  proposalReinitEncoder: () => proposalReinitEncoder,
  proposalRemoveEncoder: () => proposalRemoveEncoder,
  proposalUpdateEncoder: () => proposalUpdateEncoder,
  pskEncoder: () => pskEncoder,
  reinitEncoder: () => reinitEncoder,
  removeEncoder: () => removeEncoder,
  updateEncoder: () => updateEncoder
});

// node_modules/ts-mls/dist/src/crypto/ciphersuite.js
var ciphersuite_exports = {};
__export(ciphersuite_exports, {
  ciphersuiteEncoder: () => ciphersuiteEncoder,
  ciphersuites: () => ciphersuites,
  decodeCiphersuite: () => decodeCiphersuite,
  encodeCiphersuite: () => encodeCiphersuite,
  getCiphersuiteFromId: () => getCiphersuiteFromId,
  getCiphersuiteFromName: () => getCiphersuiteFromName,
  getCiphersuiteNameFromId: () => getCiphersuiteNameFromId
});
var ciphersuites = {
  MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519: 1,
  MLS_128_DHKEMP256_AES128GCM_SHA256_P256: 2,
  MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519: 3,
  MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448: 4,
  MLS_256_DHKEMP521_AES256GCM_SHA512_P521: 5,
  MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448: 6,
  MLS_256_DHKEMP384_AES256GCM_SHA384_P384: 7,
  MLS_128_MLKEM512_AES128GCM_SHA256_Ed25519: 77,
  MLS_128_MLKEM512_CHACHA20POLY1305_SHA256_Ed25519: 78,
  MLS_256_MLKEM768_AES256GCM_SHA384_Ed25519: 79,
  MLS_256_MLKEM768_CHACHA20POLY1305_SHA384_Ed25519: 80,
  MLS_256_MLKEM1024_AES256GCM_SHA512_Ed25519: 81,
  MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_Ed25519: 82,
  MLS_256_XWING_AES256GCM_SHA512_Ed25519: 83,
  MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519: 84,
  MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87: 85,
  MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_MLDSA87: 86,
  MLS_256_XWING_AES256GCM_SHA512_MLDSA87: 87,
  MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87: 88
};
var ciphersuiteEncoder = contramapBufferEncoder(uint16Encoder, openEnumNumberEncoder(ciphersuites));
var encodeCiphersuite = encode(ciphersuiteEncoder);
var decodeCiphersuite = mapDecoderOption(decodeUint16, openEnumNumberToKey(ciphersuites));
function getCiphersuiteNameFromId(id) {
  return reverseMap(ciphersuites)[id];
}
function getCiphersuiteFromId(id) {
  return ciphersuiteValues[id];
}
function getCiphersuiteFromName(name) {
  return ciphersuiteValues[ciphersuites[name]];
}
var ciphersuiteValues = {
  1: {
    hash: "SHA-256",
    hpke: {
      kem: "DHKEM-X25519-HKDF-SHA256",
      aead: "AES128GCM",
      kdf: "HKDF-SHA256"
    },
    signature: "Ed25519",
    name: "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519"
  },
  2: {
    hash: "SHA-256",
    hpke: {
      kem: "DHKEM-P256-HKDF-SHA256",
      aead: "AES128GCM",
      kdf: "HKDF-SHA256"
    },
    signature: "P256",
    name: "MLS_128_DHKEMP256_AES128GCM_SHA256_P256"
  },
  3: {
    hash: "SHA-256",
    hpke: {
      kem: "DHKEM-X25519-HKDF-SHA256",
      aead: "CHACHA20POLY1305",
      kdf: "HKDF-SHA256"
    },
    signature: "Ed25519",
    name: "MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519"
  },
  4: {
    hash: "SHA-512",
    hpke: {
      kem: "DHKEM-X448-HKDF-SHA512",
      aead: "AES256GCM",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed448",
    name: "MLS_256_DHKEMX448_AES256GCM_SHA512_Ed448"
  },
  5: {
    hash: "SHA-512",
    hpke: {
      kem: "DHKEM-P521-HKDF-SHA512",
      aead: "AES256GCM",
      kdf: "HKDF-SHA512"
    },
    signature: "P521",
    name: "MLS_256_DHKEMP521_AES256GCM_SHA512_P521"
  },
  6: {
    hash: "SHA-512",
    hpke: {
      kem: "DHKEM-X448-HKDF-SHA512",
      aead: "CHACHA20POLY1305",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed448",
    name: "MLS_256_DHKEMX448_CHACHA20POLY1305_SHA512_Ed448"
  },
  7: {
    hash: "SHA-384",
    hpke: {
      kem: "DHKEM-P384-HKDF-SHA384",
      aead: "AES256GCM",
      kdf: "HKDF-SHA384"
    },
    signature: "P384",
    name: "MLS_256_DHKEMP384_AES256GCM_SHA384_P384"
  },
  77: {
    hash: "SHA-256",
    hpke: {
      kem: "ML-KEM-512",
      aead: "AES256GCM",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed25519",
    name: "MLS_128_MLKEM512_AES128GCM_SHA256_Ed25519"
  },
  78: {
    hash: "SHA-256",
    hpke: {
      kem: "ML-KEM-512",
      aead: "CHACHA20POLY1305",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed25519",
    name: "MLS_128_MLKEM512_CHACHA20POLY1305_SHA256_Ed25519"
  },
  79: {
    hash: "SHA-384",
    hpke: {
      kem: "ML-KEM-768",
      aead: "AES256GCM",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed25519",
    name: "MLS_256_MLKEM768_AES256GCM_SHA384_Ed25519"
  },
  80: {
    hash: "SHA-384",
    hpke: {
      kem: "ML-KEM-768",
      aead: "CHACHA20POLY1305",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed25519",
    name: "MLS_256_MLKEM768_CHACHA20POLY1305_SHA384_Ed25519"
  },
  81: {
    hash: "SHA-512",
    hpke: {
      kem: "ML-KEM-1024",
      aead: "AES256GCM",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed25519",
    name: "MLS_256_MLKEM1024_AES256GCM_SHA512_Ed25519"
  },
  82: {
    hash: "SHA-512",
    hpke: {
      kem: "ML-KEM-1024",
      aead: "CHACHA20POLY1305",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed25519",
    name: "MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_Ed25519"
  },
  83: {
    hash: "SHA-512",
    hpke: {
      kem: "X-Wing",
      aead: "AES256GCM",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed25519",
    name: "MLS_256_XWING_AES256GCM_SHA512_Ed25519"
  },
  84: {
    hash: "SHA-512",
    hpke: {
      kem: "X-Wing",
      aead: "CHACHA20POLY1305",
      kdf: "HKDF-SHA512"
    },
    signature: "Ed25519",
    name: "MLS_256_XWING_CHACHA20POLY1305_SHA512_Ed25519"
  },
  85: {
    hash: "SHA-512",
    hpke: {
      kem: "ML-KEM-1024",
      aead: "AES256GCM",
      kdf: "HKDF-SHA512"
    },
    signature: "ML-DSA-87",
    name: "MLS_256_MLKEM1024_AES256GCM_SHA512_MLDSA87"
  },
  86: {
    hash: "SHA-512",
    hpke: {
      kem: "ML-KEM-1024",
      aead: "CHACHA20POLY1305",
      kdf: "HKDF-SHA512"
    },
    signature: "ML-DSA-87",
    name: "MLS_256_MLKEM1024_CHACHA20POLY1305_SHA512_MLDSA87"
  },
  87: {
    hash: "SHA-512",
    hpke: {
      kem: "X-Wing",
      aead: "AES256GCM",
      kdf: "HKDF-SHA512"
    },
    signature: "ML-DSA-87",
    name: "MLS_256_XWING_AES256GCM_SHA512_MLDSA87"
  },
  88: {
    hash: "SHA-512",
    hpke: {
      kem: "X-Wing",
      aead: "CHACHA20POLY1305",
      kdf: "HKDF-SHA512"
    },
    signature: "ML-DSA-87",
    name: "MLS_256_XWING_CHACHA20POLY1305_SHA512_MLDSA87"
  }
};

// node_modules/ts-mls/dist/src/keyPackage.js
var keyPackage_exports = {};
__export(keyPackage_exports, {
  decodeKeyPackage: () => decodeKeyPackage,
  decodeKeyPackageTBS: () => decodeKeyPackageTBS,
  encodeKeyPackage: () => encodeKeyPackage,
  encodeKeyPackageTBS: () => encodeKeyPackageTBS,
  generateKeyPackage: () => generateKeyPackage,
  generateKeyPackageWithKey: () => generateKeyPackageWithKey,
  keyPackageEncoder: () => keyPackageEncoder,
  keyPackageTBSEncoder: () => keyPackageTBSEncoder,
  makeKeyPackageRef: () => makeKeyPackageRef,
  signKeyPackage: () => signKeyPackage,
  verifyKeyPackage: () => verifyKeyPackage
});

// node_modules/ts-mls/dist/src/crypto/signature.js
var signature_exports = {};
__export(signature_exports, {
  signWithLabel: () => signWithLabel,
  verifyWithLabel: () => verifyWithLabel
});
async function signWithLabel(signKey, label, content, s) {
  return s.sign(signKey, encode(composeBufferEncoders([varLenDataEncoder, varLenDataEncoder]))([
    new TextEncoder().encode(`MLS 1.0 ${label}`),
    content
  ]));
}
async function verifyWithLabel(publicKey, label, content, signature, s) {
  return s.verify(publicKey, encode(composeBufferEncoders([varLenDataEncoder, varLenDataEncoder]))([
    new TextEncoder().encode(`MLS 1.0 ${label}`),
    content
  ]), signature);
}

// node_modules/ts-mls/dist/src/protocolVersion.js
var protocolVersions = {
  mls10: 1
};
var protocolVersionEncoder = contramapBufferEncoder(uint16Encoder, (t) => protocolVersions[t]);
var encodeProtocolVersion = encode(protocolVersionEncoder);
var decodeProtocolVersion = mapDecoderOption(decodeUint16, enumNumberToKey(protocolVersions));

// node_modules/ts-mls/dist/src/leafNode.js
var leafNode_exports = {};
__export(leafNode_exports, {
  decodeLeafNode: () => decodeLeafNode,
  decodeLeafNodeCommit: () => decodeLeafNodeCommit,
  decodeLeafNodeData: () => decodeLeafNodeData,
  decodeLeafNodeInfo: () => decodeLeafNodeInfo,
  decodeLeafNodeInfoCommit: () => decodeLeafNodeInfoCommit,
  decodeLeafNodeInfoCommitOmitted: () => decodeLeafNodeInfoCommitOmitted,
  decodeLeafNodeInfoKeyPackage: () => decodeLeafNodeInfoKeyPackage,
  decodeLeafNodeInfoOmitted: () => decodeLeafNodeInfoOmitted,
  decodeLeafNodeInfoUpdate: () => decodeLeafNodeInfoUpdate,
  decodeLeafNodeInfoUpdateOmitted: () => decodeLeafNodeInfoUpdateOmitted,
  decodeLeafNodeKeyPackage: () => decodeLeafNodeKeyPackage,
  decodeLeafNodeUpdate: () => decodeLeafNodeUpdate,
  encodeLeafNode: () => encodeLeafNode,
  encodeLeafNodeData: () => encodeLeafNodeData,
  encodeLeafNodeInfo: () => encodeLeafNodeInfo,
  encodeLeafNodeInfoCommit: () => encodeLeafNodeInfoCommit,
  encodeLeafNodeInfoCommitOmitted: () => encodeLeafNodeInfoCommitOmitted,
  encodeLeafNodeInfoKeyPackage: () => encodeLeafNodeInfoKeyPackage,
  encodeLeafNodeInfoOmitted: () => encodeLeafNodeInfoOmitted,
  encodeLeafNodeInfoUpdate: () => encodeLeafNodeInfoUpdate,
  encodeLeafNodeInfoUpdateOmitted: () => encodeLeafNodeInfoUpdateOmitted,
  encodeLeafNodeTBS: () => encodeLeafNodeTBS,
  leafNodeDataEncoder: () => leafNodeDataEncoder,
  leafNodeEncoder: () => leafNodeEncoder,
  leafNodeInfoCommitEncoder: () => leafNodeInfoCommitEncoder,
  leafNodeInfoCommitOmittedEncoder: () => leafNodeInfoCommitOmittedEncoder,
  leafNodeInfoEncoder: () => leafNodeInfoEncoder,
  leafNodeInfoKeyPackageEncoder: () => leafNodeInfoKeyPackageEncoder,
  leafNodeInfoOmittedEncoder: () => leafNodeInfoOmittedEncoder,
  leafNodeInfoUpdateEncoder: () => leafNodeInfoUpdateEncoder,
  leafNodeInfoUpdateOmittedEncoder: () => leafNodeInfoUpdateOmittedEncoder,
  leafNodeTBSEncoder: () => leafNodeTBSEncoder,
  signLeafNodeCommit: () => signLeafNodeCommit,
  signLeafNodeKeyPackage: () => signLeafNodeKeyPackage,
  verifyLeafNodeSignature: () => verifyLeafNodeSignature,
  verifyLeafNodeSignatureKeyPackage: () => verifyLeafNodeSignatureKeyPackage
});

// node_modules/ts-mls/dist/src/capabilities.js
var capabilitiesEncoder = contramapBufferEncoders([
  varLenTypeEncoder(protocolVersionEncoder),
  varLenTypeEncoder(ciphersuiteEncoder),
  varLenTypeEncoder(uint16Encoder),
  varLenTypeEncoder(uint16Encoder),
  varLenTypeEncoder(credentialTypeEncoder)
], (cap) => [cap.versions, cap.ciphersuites, cap.extensions, cap.proposals, cap.credentials]);
var encodeCapabilities = encode(capabilitiesEncoder);
var decodeCapabilities = mapDecoders([
  decodeVarLenType(decodeProtocolVersion),
  decodeVarLenType(decodeCiphersuite),
  decodeVarLenType(decodeUint16),
  decodeVarLenType(decodeUint16),
  decodeVarLenType(decodeCredentialType)
], (versions, ciphersuites2, extensions, proposals, credentials) => ({
  versions,
  ciphersuites: ciphersuites2,
  extensions,
  proposals,
  credentials
}));

// node_modules/ts-mls/dist/src/leafNodeSource.js
var leafNodeSources = {
  key_package: 1,
  update: 2,
  commit: 3
};
var leafNodeSourceEncoder = contramapBufferEncoder(uint8Encoder, (t) => leafNodeSources[t]);
var encodeLeafNodeSource = encode(leafNodeSourceEncoder);
var decodeLeafNodeSource = mapDecoderOption(decodeUint8, enumNumberToKey(leafNodeSources));

// node_modules/ts-mls/dist/src/lifetime.js
var lifetimeEncoder = contramapBufferEncoders([uint64Encoder, uint64Encoder], (lt) => [lt.notBefore, lt.notAfter]);
var encodeLifetime = encode(lifetimeEncoder);
var decodeLifetime = mapDecoders([decodeUint64, decodeUint64], (notBefore, notAfter) => ({
  notBefore,
  notAfter
}));
var defaultLifetime = {
  notBefore: 0n,
  notAfter: 9223372036854775807n
};

// node_modules/ts-mls/dist/src/leafNode.js
var leafNodeDataEncoder = contramapBufferEncoders([varLenDataEncoder, varLenDataEncoder, credentialEncoder, capabilitiesEncoder], (data) => [data.hpkePublicKey, data.signaturePublicKey, data.credential, data.capabilities]);
var encodeLeafNodeData = encode(leafNodeDataEncoder);
var decodeLeafNodeData = mapDecoders([decodeVarLenData, decodeVarLenData, decodeCredential, decodeCapabilities], (hpkePublicKey, signaturePublicKey, credential, capabilities) => ({
  hpkePublicKey,
  signaturePublicKey,
  credential,
  capabilities
}));
var leafNodeInfoKeyPackageEncoder = contramapBufferEncoders([leafNodeSourceEncoder, lifetimeEncoder, varLenTypeEncoder(extensionEncoder)], (info) => ["key_package", info.lifetime, info.extensions]);
var encodeLeafNodeInfoKeyPackage = encode(leafNodeInfoKeyPackageEncoder);
var leafNodeInfoUpdateOmittedEncoder = contramapBufferEncoders([leafNodeSourceEncoder, varLenTypeEncoder(extensionEncoder)], (i) => [i.leafNodeSource, i.extensions]);
var encodeLeafNodeInfoUpdateOmitted = encode(leafNodeInfoUpdateOmittedEncoder);
var leafNodeInfoCommitOmittedEncoder = contramapBufferEncoders([leafNodeSourceEncoder, varLenDataEncoder, varLenTypeEncoder(extensionEncoder)], (info) => [info.leafNodeSource, info.parentHash, info.extensions]);
var encodeLeafNodeInfoCommitOmitted = encode(leafNodeInfoCommitOmittedEncoder);
var leafNodeInfoOmittedEncoder = (info) => {
  switch (info.leafNodeSource) {
    case "key_package":
      return leafNodeInfoKeyPackageEncoder(info);
    case "update":
      return leafNodeInfoUpdateOmittedEncoder(info);
    case "commit":
      return leafNodeInfoCommitOmittedEncoder(info);
  }
};
var encodeLeafNodeInfoOmitted = encode(leafNodeInfoOmittedEncoder);
var decodeLeafNodeInfoKeyPackage = mapDecoders([decodeLifetime, decodeVarLenType(decodeExtension)], (lifetime, extensions) => ({
  leafNodeSource: "key_package",
  lifetime,
  extensions
}));
var decodeLeafNodeInfoUpdateOmitted = mapDecoder(decodeVarLenType(decodeExtension), (extensions) => ({
  leafNodeSource: "update",
  extensions
}));
var decodeLeafNodeInfoCommitOmitted = mapDecoders([decodeVarLenData, decodeVarLenType(decodeExtension)], (parentHash, extensions) => ({
  leafNodeSource: "commit",
  parentHash,
  extensions
}));
var decodeLeafNodeInfoOmitted = flatMapDecoder(decodeLeafNodeSource, (leafNodeSource) => {
  switch (leafNodeSource) {
    case "key_package":
      return decodeLeafNodeInfoKeyPackage;
    case "update":
      return decodeLeafNodeInfoUpdateOmitted;
    case "commit":
      return decodeLeafNodeInfoCommitOmitted;
  }
});
var leafNodeInfoUpdateEncoder = contramapBufferEncoders([leafNodeInfoUpdateOmittedEncoder, varLenDataEncoder, uint32Encoder], (i) => [i, i.groupId, i.leafIndex]);
var encodeLeafNodeInfoUpdate = encode(leafNodeInfoUpdateEncoder);
var leafNodeInfoCommitEncoder = contramapBufferEncoders([leafNodeInfoCommitOmittedEncoder, varLenDataEncoder, uint32Encoder], (info) => [info, info.groupId, info.leafIndex]);
var encodeLeafNodeInfoCommit = encode(leafNodeInfoCommitEncoder);
var leafNodeInfoEncoder = (info) => {
  switch (info.leafNodeSource) {
    case "key_package":
      return leafNodeInfoKeyPackageEncoder(info);
    case "update":
      return leafNodeInfoUpdateEncoder(info);
    case "commit":
      return leafNodeInfoCommitEncoder(info);
  }
};
var encodeLeafNodeInfo = encode(leafNodeInfoEncoder);
var decodeLeafNodeInfoUpdate = mapDecoders([decodeLeafNodeInfoUpdateOmitted, decodeVarLenData, decodeUint32], (ln, groupId, leafIndex) => ({
  ...ln,
  groupId,
  leafIndex
}));
var decodeLeafNodeInfoCommit = mapDecoders([decodeLeafNodeInfoCommitOmitted, decodeVarLenData, decodeUint32], (ln, groupId, leafIndex) => ({
  ...ln,
  groupId,
  leafIndex
}));
var decodeLeafNodeInfo = flatMapDecoder(decodeLeafNodeSource, (leafNodeSource) => {
  switch (leafNodeSource) {
    case "key_package":
      return decodeLeafNodeInfoKeyPackage;
    case "update":
      return decodeLeafNodeInfoUpdate;
    case "commit":
      return decodeLeafNodeInfoCommit;
  }
});
var leafNodeTBSEncoder = contramapBufferEncoders([leafNodeDataEncoder, leafNodeInfoEncoder], (tbs) => [tbs, tbs]);
var encodeLeafNodeTBS = encode(leafNodeTBSEncoder);
var leafNodeEncoder = contramapBufferEncoders([leafNodeDataEncoder, leafNodeInfoOmittedEncoder, varLenDataEncoder], (leafNode) => [leafNode, leafNode, leafNode.signature]);
var encodeLeafNode = encode(leafNodeEncoder);
var decodeLeafNode = mapDecoders([decodeLeafNodeData, decodeLeafNodeInfoOmitted, decodeVarLenData], (data, info, signature) => ({
  ...data,
  ...info,
  signature
}));
var decodeLeafNodeKeyPackage = mapDecoderOption(decodeLeafNode, (ln) => ln.leafNodeSource === "key_package" ? ln : void 0);
var decodeLeafNodeCommit = mapDecoderOption(decodeLeafNode, (ln) => ln.leafNodeSource === "commit" ? ln : void 0);
var decodeLeafNodeUpdate = mapDecoderOption(decodeLeafNode, (ln) => ln.leafNodeSource === "update" ? ln : void 0);
function toTbs(leafNode, groupId, leafIndex) {
  switch (leafNode.leafNodeSource) {
    case "key_package":
      return { ...leafNode, leafNodeSource: leafNode.leafNodeSource };
    case "update":
      return { ...leafNode, leafNodeSource: leafNode.leafNodeSource, groupId, leafIndex };
    case "commit":
      return { ...leafNode, leafNodeSource: leafNode.leafNodeSource, groupId, leafIndex };
  }
}
async function signLeafNodeCommit(tbs, signaturePrivateKey, sig) {
  return {
    ...tbs,
    signature: await signWithLabel(signaturePrivateKey, "LeafNodeTBS", encode(leafNodeTBSEncoder)(tbs), sig)
  };
}
async function signLeafNodeKeyPackage(tbs, signaturePrivateKey, sig) {
  return {
    ...tbs,
    signature: await signWithLabel(signaturePrivateKey, "LeafNodeTBS", encode(leafNodeTBSEncoder)(tbs), sig)
  };
}
function verifyLeafNodeSignature(leaf, groupId, leafIndex, sig) {
  return verifyWithLabel(leaf.signaturePublicKey, "LeafNodeTBS", encode(leafNodeTBSEncoder)(toTbs(leaf, groupId, leafIndex)), leaf.signature, sig);
}
function verifyLeafNodeSignatureKeyPackage(leaf, sig) {
  return verifyWithLabel(leaf.signaturePublicKey, "LeafNodeTBS", encode(leafNodeTBSEncoder)(leaf), leaf.signature, sig);
}

// node_modules/ts-mls/dist/src/keyPackage.js
var keyPackageTBSEncoder = contramapBufferEncoders([protocolVersionEncoder, ciphersuiteEncoder, varLenDataEncoder, leafNodeEncoder, varLenTypeEncoder(extensionEncoder)], (keyPackageTBS) => [
  keyPackageTBS.version,
  keyPackageTBS.cipherSuite,
  keyPackageTBS.initKey,
  keyPackageTBS.leafNode,
  keyPackageTBS.extensions
]);
var encodeKeyPackageTBS = encode(keyPackageTBSEncoder);
var decodeKeyPackageTBS = mapDecoders([
  decodeProtocolVersion,
  decodeCiphersuite,
  decodeVarLenData,
  decodeLeafNodeKeyPackage,
  decodeVarLenType(decodeExtension)
], (version, cipherSuite, initKey, leafNode, extensions) => ({
  version,
  cipherSuite,
  initKey,
  leafNode,
  extensions
}));
var keyPackageEncoder = contramapBufferEncoders([keyPackageTBSEncoder, varLenDataEncoder], (keyPackage) => [keyPackage, keyPackage.signature]);
var encodeKeyPackage = encode(keyPackageEncoder);
var decodeKeyPackage = mapDecoders([decodeKeyPackageTBS, decodeVarLenData], (keyPackageTBS, signature) => ({
  ...keyPackageTBS,
  signature
}));
async function signKeyPackage(tbs, signKey, s) {
  return { ...tbs, signature: await signWithLabel(signKey, "KeyPackageTBS", encode(keyPackageTBSEncoder)(tbs), s) };
}
async function verifyKeyPackage(kp, s) {
  return verifyWithLabel(kp.leafNode.signaturePublicKey, "KeyPackageTBS", encode(keyPackageTBSEncoder)(kp), kp.signature, s);
}
function makeKeyPackageRef(value, h) {
  return refhash("MLS 1.0 KeyPackage Reference", encode(keyPackageEncoder)(value), h);
}
async function generateKeyPackageWithKey(credential, capabilities, lifetime, extensions, signatureKeyPair, cs, leafNodeExtensions) {
  const initKeys = await cs.hpke.generateKeyPair();
  const hpkeKeys = await cs.hpke.generateKeyPair();
  const privatePackage = {
    initPrivateKey: await cs.hpke.exportPrivateKey(initKeys.privateKey),
    hpkePrivateKey: await cs.hpke.exportPrivateKey(hpkeKeys.privateKey),
    signaturePrivateKey: signatureKeyPair.signKey
  };
  const leafNodeTbs = {
    leafNodeSource: "key_package",
    hpkePublicKey: await cs.hpke.exportPublicKey(hpkeKeys.publicKey),
    signaturePublicKey: signatureKeyPair.publicKey,
    extensions: leafNodeExtensions ?? [],
    credential,
    capabilities,
    lifetime
  };
  const tbs = {
    version: "mls10",
    cipherSuite: cs.name,
    initKey: await cs.hpke.exportPublicKey(initKeys.publicKey),
    leafNode: await signLeafNodeKeyPackage(leafNodeTbs, signatureKeyPair.signKey, cs.signature),
    extensions
  };
  return { publicPackage: await signKeyPackage(tbs, signatureKeyPair.signKey, cs.signature), privatePackage };
}
async function generateKeyPackage(credential, capabilities, lifetime, extensions, cs, leafNodeExtensions) {
  const sigKeys = await cs.signature.keygen();
  return generateKeyPackageWithKey(credential, capabilities, lifetime, extensions, sigKeys, cs, leafNodeExtensions);
}

// node_modules/ts-mls/dist/src/presharedkey.js
var presharedkey_exports = {};
__export(presharedkey_exports, {
  computePskSecret: () => computePskSecret,
  decodePskId: () => decodePskId,
  decodePskInfo: () => decodePskInfo,
  decodePskLabel: () => decodePskLabel,
  decodePskType: () => decodePskType,
  decodeResumptionPSKUsage: () => decodeResumptionPSKUsage,
  encodePskId: () => encodePskId,
  encodePskInfo: () => encodePskInfo,
  encodePskLabel: () => encodePskLabel,
  encodePskType: () => encodePskType,
  encodeResumptionPSKUsage: () => encodeResumptionPSKUsage,
  pskIdEncoder: () => pskIdEncoder,
  pskInfoEncoder: () => pskInfoEncoder,
  pskLabelEncoder: () => pskLabelEncoder,
  pskTypeEncoder: () => pskTypeEncoder,
  pskTypes: () => pskTypes,
  resumptionPSKUsageEncoder: () => resumptionPSKUsageEncoder,
  resumptionPSKUsages: () => resumptionPSKUsages,
  updatePskSecret: () => updatePskSecret
});

// node_modules/ts-mls/dist/src/crypto/kdf.js
var kdf_exports = {};
__export(kdf_exports, {
  deriveSecret: () => deriveSecret,
  deriveTreeSecret: () => deriveTreeSecret,
  expandWithLabel: () => expandWithLabel
});
function expandWithLabel(secret, label, context, length, kdf) {
  return kdf.expand(secret, encode(composeBufferEncoders([uint16Encoder, varLenDataEncoder, varLenDataEncoder]))([
    length,
    new TextEncoder().encode(`MLS 1.0 ${label}`),
    context
  ]), length);
}
async function deriveSecret(secret, label, kdf) {
  return expandWithLabel(secret, label, new Uint8Array(), kdf.size, kdf);
}
async function deriveTreeSecret(secret, label, generation, length, kdf) {
  return expandWithLabel(secret, label, encode(uint32Encoder)(generation), length, kdf);
}

// node_modules/ts-mls/dist/src/presharedkey.js
var pskTypes = {
  external: 1,
  resumption: 2
};
var pskTypeEncoder = contramapBufferEncoder(uint8Encoder, (t) => pskTypes[t]);
var encodePskType = encode(pskTypeEncoder);
var decodePskType = mapDecoderOption(decodeUint8, enumNumberToKey(pskTypes));
var resumptionPSKUsages = {
  application: 1,
  reinit: 2,
  branch: 3
};
var resumptionPSKUsageEncoder = contramapBufferEncoder(uint8Encoder, (u) => resumptionPSKUsages[u]);
var encodeResumptionPSKUsage = encode(resumptionPSKUsageEncoder);
var decodeResumptionPSKUsage = mapDecoderOption(decodeUint8, enumNumberToKey(resumptionPSKUsages));
var encodePskInfoExternal = contramapBufferEncoders([pskTypeEncoder, varLenDataEncoder], (i) => [i.psktype, i.pskId]);
var encodePskInfoResumption = contramapBufferEncoders([pskTypeEncoder, resumptionPSKUsageEncoder, varLenDataEncoder, uint64Encoder], (info) => [info.psktype, info.usage, info.pskGroupId, info.pskEpoch]);
var decodePskInfoResumption = mapDecoders([decodeResumptionPSKUsage, decodeVarLenData, decodeUint64], (usage, pskGroupId, pskEpoch) => {
  return { usage, pskGroupId, pskEpoch };
});
var pskInfoEncoder = (info) => {
  switch (info.psktype) {
    case "external":
      return encodePskInfoExternal(info);
    case "resumption":
      return encodePskInfoResumption(info);
  }
};
var encodePskInfo = encode(pskInfoEncoder);
var decodePskInfo = flatMapDecoder(decodePskType, (psktype) => {
  switch (psktype) {
    case "external":
      return mapDecoder(decodeVarLenData, (pskId) => ({
        psktype,
        pskId
      }));
    case "resumption":
      return mapDecoder(decodePskInfoResumption, (resumption) => ({
        psktype,
        ...resumption
      }));
  }
});
var pskIdEncoder = contramapBufferEncoders([pskInfoEncoder, varLenDataEncoder], (pskid) => [pskid, pskid.pskNonce]);
var encodePskId = encode(pskIdEncoder);
var decodePskId = mapDecoders([decodePskInfo, decodeVarLenData], (info, pskNonce) => ({ ...info, pskNonce }));
var pskLabelEncoder = contramapBufferEncoders([pskIdEncoder, uint16Encoder, uint16Encoder], (label) => [label.id, label.index, label.count]);
var encodePskLabel = encode(pskLabelEncoder);
var decodePskLabel = mapDecoders([decodePskId, decodeUint16, decodeUint16], (id, index, count) => ({ id, index, count }));
async function computePskSecret(psks, impl) {
  const zeroes = new Uint8Array(impl.kdf.size);
  return psks.reduce(async (acc, [curId, curPsk], index) => updatePskSecret(await acc, curId, curPsk, index, psks.length, impl), Promise.resolve(zeroes));
}
async function updatePskSecret(secret, pskId, psk, index, count, impl) {
  const zeroes = new Uint8Array(impl.kdf.size);
  return impl.kdf.extract(await expandWithLabel(await impl.kdf.extract(zeroes, psk), "derived psk", encode(pskLabelEncoder)({ id: pskId, index, count }), impl.kdf.size, impl.kdf), secret);
}

// node_modules/ts-mls/dist/src/proposal.js
var addEncoder = contramapBufferEncoder(keyPackageEncoder, (a) => a.keyPackage);
var encodeAdd = encode(addEncoder);
var decodeAdd = mapDecoder(decodeKeyPackage, (keyPackage) => ({ keyPackage }));
var updateEncoder = contramapBufferEncoder(leafNodeEncoder, (u) => u.leafNode);
var encodeUpdate = encode(updateEncoder);
var decodeUpdate = mapDecoder(decodeLeafNodeUpdate, (leafNode) => ({ leafNode }));
var removeEncoder = contramapBufferEncoder(uint32Encoder, (r) => r.removed);
var encodeRemove = encode(removeEncoder);
var decodeRemove = mapDecoder(decodeUint32, (removed) => ({ removed }));
var pskEncoder = contramapBufferEncoder(pskIdEncoder, (p) => p.preSharedKeyId);
var encodePSK = encode(pskEncoder);
var decodePSK = mapDecoder(decodePskId, (preSharedKeyId) => ({ preSharedKeyId }));
var reinitEncoder = contramapBufferEncoders([varLenDataEncoder, protocolVersionEncoder, ciphersuiteEncoder, varLenTypeEncoder(extensionEncoder)], (r) => [r.groupId, r.version, r.cipherSuite, r.extensions]);
var encodeReinit = encode(reinitEncoder);
var decodeReinit = mapDecoders([decodeVarLenData, decodeProtocolVersion, decodeCiphersuite, decodeVarLenType(decodeExtension)], (groupId, version, cipherSuite, extensions) => ({ groupId, version, cipherSuite, extensions }));
var externalInitEncoder = contramapBufferEncoder(varLenDataEncoder, (e) => e.kemOutput);
var encodeExternalInit = encode(externalInitEncoder);
var decodeExternalInit = mapDecoder(decodeVarLenData, (kemOutput) => ({ kemOutput }));
var groupContextExtensionsEncoder = contramapBufferEncoder(varLenTypeEncoder(extensionEncoder), (g) => g.extensions);
var encodeGroupContextExtensions = encode(groupContextExtensionsEncoder);
var decodeGroupContextExtensions = mapDecoder(decodeVarLenType(decodeExtension), (extensions) => ({ extensions }));
var proposalAddEncoder = contramapBufferEncoders([defaultProposalTypeEncoder, addEncoder], (p) => [p.proposalType, p.add]);
var encodeProposalAdd = encode(proposalAddEncoder);
var proposalUpdateEncoder = contramapBufferEncoders([defaultProposalTypeEncoder, updateEncoder], (p) => [p.proposalType, p.update]);
var encodeProposalUpdate = encode(proposalUpdateEncoder);
var proposalRemoveEncoder = contramapBufferEncoders([defaultProposalTypeEncoder, removeEncoder], (p) => [p.proposalType, p.remove]);
var encodeProposalRemove = encode(proposalRemoveEncoder);
var proposalPSKEncoder = contramapBufferEncoders([defaultProposalTypeEncoder, pskEncoder], (p) => [p.proposalType, p.psk]);
var encodeProposalPSK = encode(proposalPSKEncoder);
var proposalReinitEncoder = contramapBufferEncoders([defaultProposalTypeEncoder, reinitEncoder], (p) => [p.proposalType, p.reinit]);
var encodeProposalReinit = encode(proposalReinitEncoder);
var proposalExternalInitEncoder = contramapBufferEncoders([defaultProposalTypeEncoder, externalInitEncoder], (p) => [p.proposalType, p.externalInit]);
var encodeProposalExternalInit = encode(proposalExternalInitEncoder);
var proposalGroupContextExtensionsEncoder = contramapBufferEncoders([defaultProposalTypeEncoder, groupContextExtensionsEncoder], (p) => [p.proposalType, p.groupContextExtensions]);
var encodeProposalGroupContextExtensions = encode(proposalGroupContextExtensionsEncoder);
var proposalCustomEncoder = contramapBufferEncoders([uint16Encoder, varLenDataEncoder], (p) => [p.proposalType, p.proposalData]);
var encodeProposalCustom = encode(proposalCustomEncoder);
var proposalEncoder = (p) => {
  switch (p.proposalType) {
    case "add":
      return proposalAddEncoder(p);
    case "update":
      return proposalUpdateEncoder(p);
    case "remove":
      return proposalRemoveEncoder(p);
    case "psk":
      return proposalPSKEncoder(p);
    case "reinit":
      return proposalReinitEncoder(p);
    case "external_init":
      return proposalExternalInitEncoder(p);
    case "group_context_extensions":
      return proposalGroupContextExtensionsEncoder(p);
    default:
      return proposalCustomEncoder(p);
  }
};
var encodeProposal = encode(proposalEncoder);
var decodeProposalAdd = mapDecoder(decodeAdd, (add2) => ({ proposalType: "add", add: add2 }));
var decodeProposalUpdate = mapDecoder(decodeUpdate, (update) => ({
  proposalType: "update",
  update
}));
var decodeProposalRemove = mapDecoder(decodeRemove, (remove) => ({
  proposalType: "remove",
  remove
}));
var decodeProposalPSK = mapDecoder(decodePSK, (psk) => ({ proposalType: "psk", psk }));
var decodeProposalReinit = mapDecoder(decodeReinit, (reinit) => ({
  proposalType: "reinit",
  reinit
}));
var decodeProposalExternalInit = mapDecoder(decodeExternalInit, (externalInit) => ({ proposalType: "external_init", externalInit }));
var decodeProposalGroupContextExtensions = mapDecoder(decodeGroupContextExtensions, (groupContextExtensions) => ({ proposalType: "group_context_extensions", groupContextExtensions }));
function decodeProposalCustom(proposalType) {
  return mapDecoder(decodeVarLenData, (proposalData) => ({ proposalType, proposalData }));
}
var decodeProposal = orDecoder(flatMapDecoder(decodeDefaultProposalType, (proposalType) => {
  switch (proposalType) {
    case "add":
      return decodeProposalAdd;
    case "update":
      return decodeProposalUpdate;
    case "remove":
      return decodeProposalRemove;
    case "psk":
      return decodeProposalPSK;
    case "reinit":
      return decodeProposalReinit;
    case "external_init":
      return decodeProposalExternalInit;
    case "group_context_extensions":
      return decodeProposalGroupContextExtensions;
  }
}), flatMapDecoder(decodeUint16, (n) => decodeProposalCustom(n)));

// node_modules/ts-mls/dist/src/proposalOrRefType.js
var proposalOrRefTypes = {
  proposal: 1,
  reference: 2
};
var proposalOrRefTypeEncoder = contramapBufferEncoder(uint8Encoder, (t) => proposalOrRefTypes[t]);
var encodeProposalOrRefType = encode(proposalOrRefTypeEncoder);
var decodeProposalOrRefType = mapDecoderOption(decodeUint8, enumNumberToKey(proposalOrRefTypes));
var proposalOrRefProposalEncoder = contramapBufferEncoders([proposalOrRefTypeEncoder, proposalEncoder], (p) => [p.proposalOrRefType, p.proposal]);
var encodeProposalOrRefProposal = encode(proposalOrRefProposalEncoder);
var proposalOrRefProposalRefEncoder = contramapBufferEncoders([proposalOrRefTypeEncoder, varLenDataEncoder], (r) => [r.proposalOrRefType, r.reference]);
var encodeProposalOrRefProposalRef = encode(proposalOrRefProposalRefEncoder);
var proposalOrRefEncoder = (input) => {
  switch (input.proposalOrRefType) {
    case "proposal":
      return proposalOrRefProposalEncoder(input);
    case "reference":
      return proposalOrRefProposalRefEncoder(input);
  }
};
var encodeProposalOrRef = encode(proposalOrRefEncoder);
var decodeProposalOrRef = flatMapDecoder(decodeProposalOrRefType, (proposalOrRefType) => {
  switch (proposalOrRefType) {
    case "proposal":
      return mapDecoder(decodeProposal, (proposal) => ({ proposalOrRefType, proposal }));
    case "reference":
      return mapDecoder(decodeVarLenData, (reference) => ({ proposalOrRefType, reference }));
  }
});

// node_modules/ts-mls/dist/src/updatePath.js
var updatePath_exports = {};
__export(updatePath_exports, {
  applyUpdatePath: () => applyUpdatePath,
  createUpdatePath: () => createUpdatePath,
  decodeUpdatePath: () => decodeUpdatePath,
  decodeUpdatePathNode: () => decodeUpdatePathNode,
  encodeUpdatePath: () => encodeUpdatePath,
  encodeUpdatePathNode: () => encodeUpdatePathNode,
  firstCommonAncestor: () => firstCommonAncestor,
  firstMatchAncestor: () => firstMatchAncestor,
  updatePathEncoder: () => updatePathEncoder,
  updatePathNodeEncoder: () => updatePathNodeEncoder
});

// node_modules/ts-mls/dist/src/crypto/hpke.js
var hpke_exports = {};
__export(hpke_exports, {
  decryptWithLabel: () => decryptWithLabel,
  encryptWithLabel: () => encryptWithLabel
});
function encryptWithLabel(publicKey, label, context, plaintext, hpke2) {
  return hpke2.seal(publicKey, plaintext, encode(composeBufferEncoders([varLenDataEncoder, varLenDataEncoder]))([
    new TextEncoder().encode(`MLS 1.0 ${label}`),
    context
  ]), new Uint8Array());
}
function decryptWithLabel(privateKey, label, context, kemOutput, ciphertext, hpke2) {
  return hpke2.open(privateKey, kemOutput, ciphertext, encode(composeBufferEncoders([varLenDataEncoder, varLenDataEncoder]))([
    new TextEncoder().encode(`MLS 1.0 ${label}`),
    context
  ]));
}

// node_modules/ts-mls/dist/src/groupContext.js
var groupContext_exports = {};
__export(groupContext_exports, {
  decodeGroupContext: () => decodeGroupContext,
  encodeGroupContext: () => encodeGroupContext,
  extractEpochSecret: () => extractEpochSecret,
  extractJoinerSecret: () => extractJoinerSecret,
  groupContextEncoder: () => groupContextEncoder
});
var groupContextEncoder = contramapBufferEncoders([
  protocolVersionEncoder,
  ciphersuiteEncoder,
  varLenDataEncoder,
  // groupId
  uint64Encoder,
  // epoch
  varLenDataEncoder,
  // treeHash
  varLenDataEncoder,
  // confirmedTranscriptHash
  varLenTypeEncoder(extensionEncoder)
], (gc) => [gc.version, gc.cipherSuite, gc.groupId, gc.epoch, gc.treeHash, gc.confirmedTranscriptHash, gc.extensions]);
var encodeGroupContext = encode(groupContextEncoder);
var decodeGroupContext = mapDecoders([
  decodeProtocolVersion,
  decodeCiphersuite,
  decodeVarLenData,
  // groupId
  decodeUint64,
  // epoch
  decodeVarLenData,
  // treeHash
  decodeVarLenData,
  // confirmedTranscriptHash
  decodeVarLenType(decodeExtension)
], (version, cipherSuite, groupId, epoch, treeHash2, confirmedTranscriptHash, extensions) => ({
  version,
  cipherSuite,
  groupId,
  epoch,
  treeHash: treeHash2,
  confirmedTranscriptHash,
  extensions
}));
async function extractEpochSecret(context, joinerSecret, kdf, pskSecret) {
  const psk = pskSecret === void 0 ? new Uint8Array(kdf.size) : pskSecret;
  const extracted = await kdf.extract(joinerSecret, psk);
  return expandWithLabel(extracted, "epoch", encode(groupContextEncoder)(context), kdf.size, kdf);
}
async function extractJoinerSecret(context, previousInitSecret, commitSecret, kdf) {
  const extracted = await kdf.extract(previousInitSecret, commitSecret);
  return expandWithLabel(extracted, "joiner", encode(groupContextEncoder)(context), kdf.size, kdf);
}

// node_modules/ts-mls/dist/src/parentHash.js
var parentHash_exports = {};
__export(parentHash_exports, {
  calculateParentHash: () => calculateParentHash,
  decodeParentHashInput: () => decodeParentHashInput,
  encodeParentHashInput: () => encodeParentHashInput,
  parentHashInputEncoder: () => parentHashInputEncoder,
  verifyParentHashes: () => verifyParentHashes
});

// node_modules/ts-mls/dist/src/ratchetTree.js
var ratchetTree_exports = {};
__export(ratchetTree_exports, {
  addLeafNode: () => addLeafNode,
  decodeNode: () => decodeNode,
  decodeRatchetTree: () => decodeRatchetTree,
  encodeNode: () => encodeNode,
  encodeRatchetTree: () => encodeRatchetTree,
  extendRatchetTree: () => extendRatchetTree,
  extendTree: () => extendTree,
  filteredDirectPath: () => filteredDirectPath,
  filteredDirectPathAndCopathResolution: () => filteredDirectPathAndCopathResolution,
  findBlankLeafNodeIndex: () => findBlankLeafNodeIndex,
  findBlankLeafNodeIndexOrExtend: () => findBlankLeafNodeIndexOrExtend,
  findFirstNonBlankAncestor: () => findFirstNonBlankAncestor,
  findLeafIndex: () => findLeafIndex,
  getCredentialFromLeafIndex: () => getCredentialFromLeafIndex,
  getHpkePublicKey: () => getHpkePublicKey,
  getSignaturePublicKeyFromLeafIndex: () => getSignaturePublicKeyFromLeafIndex,
  nodeEncoder: () => nodeEncoder,
  ratchetTreeEncoder: () => ratchetTreeEncoder,
  removeLeafNode: () => removeLeafNode,
  removeLeaves: () => removeLeaves,
  resolution: () => resolution,
  stripBlankNodes: () => stripBlankNodes,
  traverseToRoot: () => traverseToRoot,
  updateLeafNode: () => updateLeafNode
});

// node_modules/ts-mls/dist/src/nodeType.js
var nodeTypes = {
  leaf: 1,
  parent: 2
};
var nodeTypeEncoder = contramapBufferEncoder(uint8Encoder, (t) => nodeTypes[t]);
var encodeNodeType = encode(nodeTypeEncoder);
var decodeNodeType = mapDecoderOption(decodeUint8, enumNumberToKey(nodeTypes));

// node_modules/ts-mls/dist/src/parentNode.js
var parentNodeEncoder = contramapBufferEncoders([varLenDataEncoder, varLenDataEncoder, varLenTypeEncoder(uint32Encoder)], (node) => [node.hpkePublicKey, node.parentHash, node.unmergedLeaves]);
var encodeParentNode = encode(parentNodeEncoder);
var decodeParentNode = mapDecoders([decodeVarLenData, decodeVarLenData, decodeVarLenType(decodeUint32)], (hpkePublicKey, parentHash, unmergedLeaves) => ({
  hpkePublicKey,
  parentHash,
  unmergedLeaves
}));

// node_modules/ts-mls/dist/src/treemath.js
var treemath_exports = {};
__export(treemath_exports, {
  copath: () => copath,
  directPath: () => directPath,
  isAncestor: () => isAncestor,
  isLeaf: () => isLeaf,
  leafToNodeIndex: () => leafToNodeIndex,
  leafWidth: () => leafWidth,
  left: () => left,
  nodeToLeafIndex: () => nodeToLeafIndex,
  nodeWidth: () => nodeWidth,
  parent: () => parent,
  right: () => right,
  root: () => root,
  rootFromNodeWidth: () => rootFromNodeWidth,
  sibling: () => sibling,
  toLeafIndex: () => toLeafIndex,
  toNodeIndex: () => toNodeIndex
});
function toNodeIndex(n) {
  return n;
}
function toLeafIndex(n) {
  return n;
}
function log2(x) {
  if (x === 0)
    return 0;
  let k = 0;
  while (x >> k > 0) {
    k++;
  }
  return k - 1;
}
function level(nodeIndex) {
  if ((nodeIndex & 1) === 0)
    return 0;
  let k = 0;
  while ((nodeIndex >> k & 1) === 1) {
    k++;
  }
  return k;
}
function isLeaf(nodeIndex) {
  return nodeIndex % 2 == 0;
}
function leafToNodeIndex(leafIndex) {
  return toNodeIndex(leafIndex * 2);
}
function nodeToLeafIndex(nodeIndex) {
  return toLeafIndex(nodeIndex / 2);
}
function leafWidth(nodeWidth2) {
  return nodeWidth2 == 0 ? 0 : (nodeWidth2 - 1) / 2 + 1;
}
function nodeWidth(leafWidth2) {
  return leafWidth2 === 0 ? 0 : 2 * (leafWidth2 - 1) + 1;
}
function rootFromNodeWidth(nodeWidth2) {
  return toNodeIndex((1 << log2(nodeWidth2)) - 1);
}
function root(leafWidth2) {
  const w = nodeWidth(leafWidth2);
  return rootFromNodeWidth(w);
}
function left(nodeIndex) {
  const k = level(nodeIndex);
  if (k === 0)
    throw new InternalError("leaf node has no children");
  return toNodeIndex(nodeIndex ^ 1 << k - 1);
}
function right(nodeIndex) {
  const k = level(nodeIndex);
  if (k === 0)
    throw new InternalError("leaf node has no children");
  return toNodeIndex(nodeIndex ^ 3 << k - 1);
}
function parent(nodeIndex, leafWidth2) {
  if (nodeIndex === root(leafWidth2))
    throw new InternalError("root node has no parent");
  const k = level(nodeIndex);
  const b = nodeIndex >> k + 1 & 1;
  return toNodeIndex((nodeIndex | 1 << k) ^ b << k + 1);
}
function sibling(x, leafWidth2) {
  const p = parent(x, leafWidth2);
  return x < p ? right(p) : left(p);
}
function directPath(nodeIndex, leafWidth2) {
  const r = root(leafWidth2);
  if (nodeIndex === r)
    return [];
  const d = [];
  while (nodeIndex !== r) {
    nodeIndex = parent(nodeIndex, leafWidth2);
    d.push(nodeIndex);
  }
  return d;
}
function copath(nodeIndex, leafWidth2) {
  if (nodeIndex === root(leafWidth2))
    return [];
  const d = directPath(nodeIndex, leafWidth2);
  d.unshift(nodeIndex);
  d.pop();
  return d.map((y) => sibling(y, leafWidth2));
}
function isAncestor(childNodeIndex, ancestor, nodeWidth2) {
  return directPath(childNodeIndex, leafWidth(nodeWidth2)).includes(ancestor);
}

// node_modules/ts-mls/dist/src/ratchetTree.js
var nodeEncoder = (node) => {
  switch (node.nodeType) {
    case "parent":
      return contramapBufferEncoders([nodeTypeEncoder, parentNodeEncoder], (n) => [n.nodeType, n.parent])(node);
    case "leaf":
      return contramapBufferEncoders([nodeTypeEncoder, leafNodeEncoder], (n) => [n.nodeType, n.leaf])(node);
  }
};
var encodeNode = encode(nodeEncoder);
var decodeNode = flatMapDecoder(decodeNodeType, (nodeType) => {
  switch (nodeType) {
    case "parent":
      return mapDecoder(decodeParentNode, (parent2) => ({
        nodeType,
        parent: parent2
      }));
    case "leaf":
      return mapDecoder(decodeLeafNode, (leaf) => ({
        nodeType,
        leaf
      }));
  }
});
function getHpkePublicKey(n) {
  switch (n.nodeType) {
    case "parent":
      return n.parent.hpkePublicKey;
    case "leaf":
      return n.leaf.hpkePublicKey;
  }
}
function extendRatchetTree(tree) {
  const lastIndex = tree.length - 1;
  if (tree[lastIndex] === void 0) {
    throw new InternalError("The last node in the ratchet tree must be non-blank.");
  }
  const neededSize = nextFullBinaryTreeSize(tree.length);
  const copy = tree.slice();
  while (copy.length < neededSize) {
    copy.push(void 0);
  }
  return copy;
}
function nextFullBinaryTreeSize(n) {
  let d = 0;
  while ((1 << d + 1) - 1 < n) {
    d++;
  }
  return (1 << d + 1) - 1;
}
function stripBlankNodes(tree) {
  let lastNonBlank = tree.length - 1;
  while (lastNonBlank >= 0 && tree[lastNonBlank] === void 0) {
    lastNonBlank--;
  }
  return tree.slice(0, lastNonBlank + 1);
}
var ratchetTreeEncoder = contramapBufferEncoder(varLenTypeEncoder(optionalEncoder(nodeEncoder)), stripBlankNodes);
var encodeRatchetTree = encode(ratchetTreeEncoder);
var decodeRatchetTree = mapDecoder(decodeVarLenType(decodeOptional(decodeNode)), extendRatchetTree);
function findBlankLeafNodeIndex(tree) {
  const nodeIndex = tree.findIndex((node, nodeIndex2) => node === void 0 && isLeaf(toNodeIndex(nodeIndex2)));
  if (nodeIndex < 0)
    return void 0;
  else
    return toNodeIndex(nodeIndex);
}
function findBlankLeafNodeIndexOrExtend(tree) {
  const blankLeaf = findBlankLeafNodeIndex(tree);
  return blankLeaf === void 0 ? toNodeIndex(tree.length + 1) : blankLeaf;
}
function extendTree(tree, leafNode) {
  const newRoot = void 0;
  const insertedNodeIndex = toNodeIndex(tree.length + 1);
  const newTree = [
    ...tree,
    newRoot,
    { nodeType: "leaf", leaf: leafNode },
    ...new Array(tree.length - 1)
  ];
  return [newTree, insertedNodeIndex];
}
function addLeafNode(tree, leafNode) {
  const blankLeaf = findBlankLeafNodeIndex(tree);
  if (blankLeaf === void 0) {
    return extendTree(tree, leafNode);
  }
  const insertedLeafIndex = nodeToLeafIndex(blankLeaf);
  const dp = directPath(blankLeaf, leafWidth(tree.length));
  const copy = tree.slice();
  for (const nodeIndex of dp) {
    const node = tree[nodeIndex];
    if (node !== void 0) {
      const parentNode = node;
      const updated = {
        nodeType: "parent",
        parent: { ...parentNode.parent, unmergedLeaves: [...parentNode.parent.unmergedLeaves, insertedLeafIndex] }
      };
      copy[nodeIndex] = updated;
    }
  }
  copy[blankLeaf] = { nodeType: "leaf", leaf: leafNode };
  return [copy, blankLeaf];
}
function updateLeafNode(tree, leafNode, leafIndex) {
  const leafNodeIndex = leafToNodeIndex(leafIndex);
  const pathToBlank = directPath(leafNodeIndex, leafWidth(tree.length));
  const copy = tree.slice();
  for (const nodeIndex of pathToBlank) {
    const node = tree[nodeIndex];
    if (node !== void 0) {
      copy[nodeIndex] = void 0;
    }
  }
  copy[leafNodeIndex] = { nodeType: "leaf", leaf: leafNode };
  return copy;
}
function removeLeafNode(tree, removedLeafIndex) {
  const leafNodeIndex = leafToNodeIndex(removedLeafIndex);
  const pathToBlank = directPath(leafNodeIndex, leafWidth(tree.length));
  const copy = tree.slice();
  for (const nodeIndex of pathToBlank) {
    const node = tree[nodeIndex];
    if (node !== void 0) {
      copy[nodeIndex] = void 0;
    }
  }
  copy[leafNodeIndex] = void 0;
  return condenseRatchetTreeAfterRemove(copy);
}
function condenseRatchetTreeAfterRemove(tree) {
  return extendRatchetTree(stripBlankNodes(tree));
}
function resolution(tree, nodeIndex) {
  const node = tree[nodeIndex];
  if (node === void 0) {
    if (isLeaf(nodeIndex)) {
      return [];
    }
    const l = left(nodeIndex);
    const r = right(nodeIndex);
    const leftRes = resolution(tree, l);
    const rightRes = resolution(tree, r);
    return [...leftRes, ...rightRes];
  }
  if (isLeaf(nodeIndex)) {
    return [nodeIndex];
  }
  const unmerged = node.nodeType === "parent" ? node.parent.unmergedLeaves : [];
  return [nodeIndex, ...unmerged.map((u) => leafToNodeIndex(toLeafIndex(u)))];
}
function filteredDirectPath(leafIndex, tree) {
  const leafNodeIndex = leafToNodeIndex(leafIndex);
  const leafWidth2 = nodeToLeafIndex(toNodeIndex(tree.length));
  const cp = copath(leafNodeIndex, leafWidth2);
  return directPath(leafNodeIndex, leafWidth2).filter((_nodeIndex, n) => resolution(tree, cp[n]).length !== 0);
}
function filteredDirectPathAndCopathResolution(leafIndex, tree) {
  const leafNodeIndex = leafToNodeIndex(leafIndex);
  const lWidth = leafWidth(tree.length);
  const cp = copath(leafNodeIndex, lWidth);
  return directPath(leafNodeIndex, lWidth).reduce((acc, cur, n) => {
    const r = resolution(tree, cp[n]);
    if (r.length === 0)
      return acc;
    else
      return [...acc, { nodeIndex: cur, resolution: r }];
  }, []);
}
function removeLeaves(tree, leafIndices) {
  const copy = tree.slice();
  function shouldBeRemoved(leafIndex) {
    return leafIndices.find((x) => leafIndex === x) !== void 0;
  }
  for (const [i, n] of tree.entries()) {
    if (n !== void 0) {
      const nodeIndex = toNodeIndex(i);
      if (isLeaf(nodeIndex) && shouldBeRemoved(nodeToLeafIndex(nodeIndex))) {
        copy[i] = void 0;
      } else if (n.nodeType === "parent") {
        copy[i] = {
          ...n,
          parent: { ...n.parent, unmergedLeaves: n.parent.unmergedLeaves.filter((l) => !shouldBeRemoved(l)) }
        };
      }
    }
  }
  return condenseRatchetTreeAfterRemove(copy);
}
function traverseToRoot(tree, leafIndex, f) {
  const rootIndex = root(leafWidth(tree.length));
  let currentIndex = leafToNodeIndex(leafIndex);
  while (currentIndex != rootIndex) {
    currentIndex = parent(currentIndex, leafWidth(tree.length));
    const currentNode = tree[currentIndex];
    if (currentNode !== void 0) {
      if (currentNode.nodeType === "leaf") {
        throw new InternalError("Expected parent node");
      }
      const result = f(currentIndex, currentNode.parent);
      if (result !== void 0) {
        return [result, currentIndex];
      }
    }
  }
}
function findFirstNonBlankAncestor(tree, nodeIndex) {
  return traverseToRoot(tree, nodeToLeafIndex(nodeIndex), (nodeIndex2, _node) => nodeIndex2)?.[0] ?? root(leafWidth(tree.length));
}
function findLeafIndex(tree, leaf) {
  const foundIndex = tree.findIndex((node, nodeIndex) => {
    if (isLeaf(toNodeIndex(nodeIndex)) && node !== void 0) {
      if (node.nodeType === "parent")
        throw new InternalError("Found parent node in leaf node position");
      return constantTimeEqual(encode(leafNodeEncoder)(node.leaf), encode(leafNodeEncoder)(leaf));
    }
    return false;
  });
  return foundIndex === -1 ? void 0 : nodeToLeafIndex(toNodeIndex(foundIndex));
}
function getCredentialFromLeafIndex(ratchetTree, leafIndex) {
  const senderLeafNode = ratchetTree[leafToNodeIndex(leafIndex)];
  if (senderLeafNode === void 0 || senderLeafNode.nodeType === "parent")
    throw new ValidationError("Unable to find leafnode for leafIndex");
  return senderLeafNode.leaf.credential;
}
function getSignaturePublicKeyFromLeafIndex(ratchetTree, leafIndex) {
  const leafNode = ratchetTree[leafToNodeIndex(leafIndex)];
  if (leafNode === void 0 || leafNode.nodeType === "parent")
    throw new ValidationError("Unable to find leafnode for leafIndex");
  return leafNode.leaf.signaturePublicKey;
}

// node_modules/ts-mls/dist/src/treeHash.js
var treeHash_exports = {};
__export(treeHash_exports, {
  decodeLeafNodeHashInput: () => decodeLeafNodeHashInput,
  decodeParentNodeHashInput: () => decodeParentNodeHashInput,
  decodeTreeHashInput: () => decodeTreeHashInput,
  encodeLeafNodeHashInput: () => encodeLeafNodeHashInput,
  encodeParentNodeHashInput: () => encodeParentNodeHashInput,
  encodeTreeHashInput: () => encodeTreeHashInput,
  leafNodeHashInputEncoder: () => leafNodeHashInputEncoder,
  parentNodeHashInputEncoder: () => parentNodeHashInputEncoder,
  treeHash: () => treeHash,
  treeHashInputEncoder: () => treeHashInputEncoder,
  treeHashRoot: () => treeHashRoot
});
var leafNodeHashInputEncoder = contramapBufferEncoders([nodeTypeEncoder, uint32Encoder, optionalEncoder(leafNodeEncoder)], (input) => [input.nodeType, input.leafIndex, input.leafNode]);
var encodeLeafNodeHashInput = encode(leafNodeHashInputEncoder);
var decodeLeafNodeHashInput = mapDecoders([decodeUint32, decodeOptional(decodeLeafNode)], (leafIndex, leafNode) => ({
  nodeType: "leaf",
  leafIndex,
  leafNode
}));
var parentNodeHashInputEncoder = contramapBufferEncoders([nodeTypeEncoder, optionalEncoder(parentNodeEncoder), varLenDataEncoder, varLenDataEncoder], (input) => [input.nodeType, input.parentNode, input.leftHash, input.rightHash]);
var encodeParentNodeHashInput = encode(parentNodeHashInputEncoder);
var decodeParentNodeHashInput = mapDecoders([decodeOptional(decodeParentNode), decodeVarLenData, decodeVarLenData], (parentNode, leftHash, rightHash) => ({
  nodeType: "parent",
  parentNode,
  leftHash,
  rightHash
}));
var treeHashInputEncoder = (input) => {
  switch (input.nodeType) {
    case "leaf":
      return leafNodeHashInputEncoder(input);
    case "parent":
      return parentNodeHashInputEncoder(input);
  }
};
var encodeTreeHashInput = encode(treeHashInputEncoder);
var decodeTreeHashInput = flatMapDecoder(decodeNodeType, (nodeType) => {
  switch (nodeType) {
    case "leaf":
      return decodeLeafNodeHashInput;
    case "parent":
      return decodeParentNodeHashInput;
  }
});
async function treeHashRoot(tree, h) {
  return treeHash(tree, rootFromNodeWidth(tree.length), h);
}
async function treeHash(tree, subtreeIndex, h) {
  if (isLeaf(subtreeIndex)) {
    const leafNode = tree[subtreeIndex];
    if (leafNode?.nodeType === "parent")
      throw new InternalError("Somehow found parent node in leaf position");
    const input = encode(leafNodeHashInputEncoder)({
      nodeType: "leaf",
      leafIndex: nodeToLeafIndex(subtreeIndex),
      leafNode: leafNode?.leaf
    });
    return await h.digest(input);
  } else {
    const parentNode = tree[subtreeIndex];
    if (parentNode?.nodeType === "leaf")
      throw new InternalError("Somehow found leaf node in parent position");
    const leftHash = await treeHash(tree, left(subtreeIndex), h);
    const rightHash = await treeHash(tree, right(subtreeIndex), h);
    const input = {
      nodeType: "parent",
      parentNode: parentNode?.parent,
      leftHash,
      rightHash
    };
    return await h.digest(encode(parentNodeHashInputEncoder)(input));
  }
}

// node_modules/ts-mls/dist/src/parentHash.js
var parentHashInputEncoder = contramapBufferEncoders([varLenDataEncoder, varLenDataEncoder, varLenDataEncoder], (i) => [i.encryptionKey, i.parentHash, i.originalSiblingTreeHash]);
var encodeParentHashInput = encode(parentHashInputEncoder);
var decodeParentHashInput = mapDecoders([decodeVarLenData, decodeVarLenData, decodeVarLenData], (encryptionKey, parentHash, originalSiblingTreeHash) => ({
  encryptionKey,
  parentHash,
  originalSiblingTreeHash
}));
function validateParentHashCoverage(parentIndices, coverage) {
  for (const index of parentIndices) {
    if ((coverage[index] ?? 0) !== 1) {
      return false;
    }
  }
  return true;
}
async function verifyParentHashes(tree, h) {
  const parentNodes = tree.reduce((acc, cur, index) => {
    if (cur !== void 0 && cur.nodeType === "parent") {
      return [...acc, index];
    } else
      return acc;
  }, []);
  if (parentNodes.length === 0)
    return true;
  const coverage = await parentHashCoverage(tree, h);
  return validateParentHashCoverage(parentNodes, coverage);
}
function parentHashCoverage(tree, h) {
  return tree.reduce(async (acc, node, nodeIndex) => {
    let currentIndex = toNodeIndex(nodeIndex);
    if (!isLeaf(currentIndex) || node === void 0)
      return acc;
    let updated = { ...await acc };
    const rootIndex = root(leafWidth(tree.length));
    while (currentIndex !== rootIndex) {
      const currentNode = tree[currentIndex];
      if (currentNode === void 0) {
        continue;
      }
      const [parentHash, parentHashNodeIndex] = await calculateParentHash(tree, currentIndex, h);
      if (parentHashNodeIndex === void 0) {
        throw new InternalError("Reached root before completing parent hash coeverage");
      }
      const expectedParentHash = getParentHash(currentNode);
      if (expectedParentHash !== void 0 && constantTimeEqual(parentHash, expectedParentHash)) {
        const newCount = (updated[parentHashNodeIndex] ?? 0) + 1;
        updated = { ...updated, [parentHashNodeIndex]: newCount };
      } else {
        break;
      }
      currentIndex = parentHashNodeIndex;
    }
    return updated;
  }, Promise.resolve({}));
}
function getParentHash(node) {
  if (node.nodeType === "parent")
    return node.parent.parentHash;
  else if (node.leaf.leafNodeSource === "commit")
    return node.leaf.parentHash;
}
async function calculateParentHash(tree, nodeIndex, h) {
  const rootIndex = root(leafWidth(tree.length));
  if (nodeIndex === rootIndex) {
    return [new Uint8Array(), void 0];
  }
  const parentNodeIndex = findFirstNonBlankAncestor(tree, nodeIndex);
  const parentNode = tree[parentNodeIndex];
  if (parentNodeIndex === rootIndex && parentNode === void 0) {
    return [new Uint8Array(), parentNodeIndex];
  }
  const siblingIndex = nodeIndex < parentNodeIndex ? right(parentNodeIndex) : left(parentNodeIndex);
  if (parentNode === void 0 || parentNode.nodeType === "leaf")
    throw new InternalError("Expected non-blank parent Node");
  const removedUnmerged = removeLeaves(tree, parentNode.parent.unmergedLeaves);
  const originalSiblingTreeHash = await treeHash(removedUnmerged, siblingIndex, h);
  const input = {
    encryptionKey: parentNode.parent.hpkePublicKey,
    parentHash: parentNode.parent.parentHash,
    originalSiblingTreeHash
  };
  return [await h.digest(encode(parentHashInputEncoder)(input)), parentNodeIndex];
}

// node_modules/ts-mls/dist/src/hpkeCiphertext.js
var hpkeCiphertextEncoder = contramapBufferEncoders([varLenDataEncoder, varLenDataEncoder], (egs) => [egs.kemOutput, egs.ciphertext]);
var encodeHpkeCiphertext = encode(hpkeCiphertextEncoder);
var decodeHpkeCiphertext = mapDecoders([decodeVarLenData, decodeVarLenData], (kemOutput, ciphertext) => ({ kemOutput, ciphertext }));

// node_modules/ts-mls/dist/src/updatePath.js
var updatePathNodeEncoder = contramapBufferEncoders([varLenDataEncoder, varLenTypeEncoder(hpkeCiphertextEncoder)], (node) => [node.hpkePublicKey, node.encryptedPathSecret]);
var encodeUpdatePathNode = encode(updatePathNodeEncoder);
var decodeUpdatePathNode = mapDecoders([decodeVarLenData, decodeVarLenType(decodeHpkeCiphertext)], (hpkePublicKey, encryptedPathSecret) => ({ hpkePublicKey, encryptedPathSecret }));
var updatePathEncoder = contramapBufferEncoders([leafNodeEncoder, varLenTypeEncoder(updatePathNodeEncoder)], (path) => [path.leafNode, path.nodes]);
var encodeUpdatePath = encode(updatePathEncoder);
var decodeUpdatePath = mapDecoders([decodeLeafNodeCommit, decodeVarLenType(decodeUpdatePathNode)], (leafNode, nodes) => ({ leafNode, nodes }));
async function createUpdatePath(originalTree, senderLeafIndex, groupContext, signaturePrivateKey, cs, excludeNodes = []) {
  const originalLeafNode = originalTree[leafToNodeIndex(senderLeafIndex)];
  if (originalLeafNode === void 0 || originalLeafNode.nodeType === "parent")
    throw new InternalError("Expected non-blank leaf node");
  const pathSecret = cs.rng.randomBytes(cs.kdf.size);
  const leafNodeSecret = await deriveSecret(pathSecret, "node", cs.kdf);
  const leafKeypair = await cs.hpke.deriveKeyPair(leafNodeSecret);
  const fdp = filteredDirectPathAndCopathResolution(senderLeafIndex, originalTree);
  const copy = originalTree.slice();
  blankStructuralDirectPath(copy, senderLeafIndex);
  const [ps, updatedTree] = await applyInitialTreeUpdate(fdp, pathSecret, senderLeafIndex, copy, cs, new Set(excludeNodes));
  const treeWithHashes = await insertParentHashes(fdp, updatedTree, cs);
  const leafParentHash = await calculateParentHash(treeWithHashes, leafToNodeIndex(senderLeafIndex), cs.hash);
  const updatedLeafNodeTbs = {
    leafNodeSource: "commit",
    hpkePublicKey: await cs.hpke.exportPublicKey(leafKeypair.publicKey),
    extensions: originalLeafNode.leaf.extensions,
    capabilities: originalLeafNode.leaf.capabilities,
    credential: originalLeafNode.leaf.credential,
    signaturePublicKey: originalLeafNode.leaf.signaturePublicKey,
    parentHash: leafParentHash[0],
    groupId: groupContext.groupId,
    leafIndex: senderLeafIndex
  };
  const updatedLeafNode = await signLeafNodeCommit(updatedLeafNodeTbs, signaturePrivateKey, cs.signature);
  treeWithHashes[leafToNodeIndex(senderLeafIndex)] = {
    nodeType: "leaf",
    leaf: updatedLeafNode
  };
  const updatedTreeHash = await treeHashRoot(treeWithHashes, cs.hash);
  const updatedGroupContext = {
    ...groupContext,
    treeHash: updatedTreeHash,
    epoch: groupContext.epoch + 1n
  };
  const pathSecrets = ps.slice(0, ps.length - 1).reverse();
  const updatePathNodes = await Promise.all(pathSecrets.map(encryptSecretsForPath(originalTree, treeWithHashes, updatedGroupContext, cs)));
  const updatePath = { leafNode: updatedLeafNode, nodes: updatePathNodes };
  return [treeWithHashes, updatePath, pathSecrets, leafKeypair.privateKey];
}
function encryptSecretsForPath(originalTree, updatedTree, updatedGroupContext, cs) {
  return async (pathSecret) => {
    const key = getHpkePublicKey(updatedTree[pathSecret.nodeIndex]);
    const res = {
      hpkePublicKey: key,
      encryptedPathSecret: await Promise.all(pathSecret.sendTo.map(async (nodeIndex) => {
        const { ct, enc } = await encryptWithLabel(await cs.hpke.importPublicKey(getHpkePublicKey(originalTree[nodeIndex])), "UpdatePathNode", encode(groupContextEncoder)(updatedGroupContext), pathSecret.secret, cs.hpke);
        return { ciphertext: ct, kemOutput: enc };
      }))
    };
    return res;
  };
}
async function insertParentHashes(fdp, tree, cs) {
  for (let x = fdp.length - 1; x >= 0; x--) {
    const { nodeIndex } = fdp[x];
    const parentHash = await calculateParentHash(tree, nodeIndex, cs.hash);
    const currentNode = tree[nodeIndex];
    if (currentNode === void 0 || currentNode.nodeType === "leaf")
      throw new InternalError("Expected non-blank parent node");
    const updatedNode = { nodeType: "parent", parent: { ...currentNode.parent, parentHash: parentHash[0] } };
    tree[nodeIndex] = updatedNode;
  }
  return tree;
}
async function applyInitialTreeUpdate(fdp, pathSecret, senderLeafIndex, tree, cs, excludeNodes = /* @__PURE__ */ new Set()) {
  return await fdp.reduce(async (acc, { nodeIndex, resolution: resolution2 }) => {
    const [pathSecrets, tree2] = await acc;
    const lastPathSecret = pathSecrets[0];
    const nextPathSecret = await deriveSecret(lastPathSecret.secret, "path", cs.kdf);
    const nextNodeSecret = await deriveSecret(nextPathSecret, "node", cs.kdf);
    const { publicKey } = await cs.hpke.deriveKeyPair(nextNodeSecret);
    tree2[nodeIndex] = {
      nodeType: "parent",
      parent: {
        hpkePublicKey: await cs.hpke.exportPublicKey(publicKey),
        parentHash: new Uint8Array(),
        unmergedLeaves: []
      }
    };
    const sendTo = excludeNodes.size === 0 ? resolution2 : resolution2.filter((nodeIndex2) => !excludeNodes.has(nodeIndex2));
    return [[{ nodeIndex, secret: nextPathSecret, sendTo }, ...pathSecrets], tree2];
  }, Promise.resolve([[{ secret: pathSecret, nodeIndex: leafToNodeIndex(senderLeafIndex), sendTo: [] }], tree]));
}
function blankStructuralDirectPath(tree, senderLeafIndex) {
  for (const nodeIndex of directPath(leafToNodeIndex(senderLeafIndex), leafWidth(tree.length))) {
    tree[nodeIndex] = void 0;
  }
}
async function applyUpdatePath(tree, senderLeafIndex, path, h, isExternal = false) {
  if (!isExternal) {
    const leafToUpdate = tree[leafToNodeIndex(senderLeafIndex)];
    if (leafToUpdate === void 0 || leafToUpdate.nodeType === "parent")
      throw new InternalError("Leaf node not defined or is parent");
    const leafNodePublicKeyNotNew = constantTimeEqual(leafToUpdate.leaf.hpkePublicKey, path.leafNode.hpkePublicKey);
    if (leafNodePublicKeyNotNew)
      throw new ValidationError("Public key in the LeafNode is the same as the committer's current leaf node");
  }
  const pathNodePublicKeysExistInTree = path.nodes.some((node) => tree.some((treeNode) => {
    return treeNode?.nodeType === "parent" ? constantTimeEqual(treeNode.parent.hpkePublicKey, node.hpkePublicKey) : false;
  }));
  if (pathNodePublicKeysExistInTree)
    throw new ValidationError("Public keys in the UpdatePath may not appear in a node of the new ratchet tree");
  const copy = tree.slice();
  copy[leafToNodeIndex(senderLeafIndex)] = { nodeType: "leaf", leaf: path.leafNode };
  const reverseFilteredDirectPath = filteredDirectPath(senderLeafIndex, tree).reverse();
  blankStructuralDirectPath(copy, senderLeafIndex);
  const reverseUpdatePath = path.nodes.slice().reverse();
  if (reverseUpdatePath.length !== reverseFilteredDirectPath.length) {
    throw new ValidationError("Invalid length of UpdatePath");
  }
  for (const [level2, nodeIndex] of reverseFilteredDirectPath.entries()) {
    const parentHash = await calculateParentHash(copy, nodeIndex, h);
    copy[nodeIndex] = {
      nodeType: "parent",
      parent: { hpkePublicKey: reverseUpdatePath[level2].hpkePublicKey, unmergedLeaves: [], parentHash: parentHash[0] }
    };
  }
  const leafParentHash = await calculateParentHash(copy, leafToNodeIndex(senderLeafIndex), h);
  if (!constantTimeEqual(leafParentHash[0], path.leafNode.parentHash))
    throw new ValidationError("Parent hash did not match the UpdatePath");
  return copy;
}
function firstCommonAncestor(tree, leafIndex, senderLeafIndex) {
  const fdp = filteredDirectPathAndCopathResolution(senderLeafIndex, tree);
  for (const { nodeIndex } of fdp) {
    if (isAncestor(leafToNodeIndex(leafIndex), nodeIndex, tree.length)) {
      return nodeIndex;
    }
  }
  throw new ValidationError("Could not find common ancestor");
}
function firstMatchAncestor(tree, leafIndex, senderLeafIndex, path) {
  const fdp = filteredDirectPathAndCopathResolution(senderLeafIndex, tree);
  for (const [n, { nodeIndex, resolution: resolution2 }] of fdp.entries()) {
    if (isAncestor(leafToNodeIndex(leafIndex), nodeIndex, tree.length)) {
      return { nodeIndex, resolution: resolution2, updateNode: path.nodes[n] };
    }
  }
  throw new ValidationError("Could not find common ancestor");
}

// node_modules/ts-mls/dist/src/commit.js
var commitEncoder = contramapBufferEncoders([varLenTypeEncoder(proposalOrRefEncoder), optionalEncoder(updatePathEncoder)], (commit) => [commit.proposals, commit.path]);
var encodeCommit = encode(commitEncoder);
var decodeCommit = mapDecoders([decodeVarLenType(decodeProposalOrRef), decodeOptional(decodeUpdatePath)], (proposals, path) => ({ proposals, path }));

// node_modules/ts-mls/dist/src/contentType.js
var contentTypes = {
  application: 1,
  proposal: 2,
  commit: 3
};
var contentTypeEncoder = contramapBufferEncoder(uint8Encoder, (t) => contentTypes[t]);
var encodeContentType = encode(contentTypeEncoder);
var decodeContentType = mapDecoderOption(decodeUint8, enumNumberToKey(contentTypes));

// node_modules/ts-mls/dist/src/wireformat.js
var wireformats = {
  mls_public_message: 1,
  mls_private_message: 2,
  mls_welcome: 3,
  mls_group_info: 4,
  mls_key_package: 5
};
var wireformatEncoder = (s) => contramapBufferEncoder(uint16Encoder, (t) => wireformats[t])(s);
var encodeWireformat = encode(wireformatEncoder);
var decodeWireformat = mapDecoderOption(decodeUint16, enumNumberToKey(wireformats));

// node_modules/ts-mls/dist/src/sender.js
var sender_exports = {};
__export(sender_exports, {
  decodeReuseGuard: () => decodeReuseGuard,
  decodeSender: () => decodeSender,
  decodeSenderData: () => decodeSenderData,
  decodeSenderDataAAD: () => decodeSenderDataAAD,
  decodeSenderType: () => decodeSenderType,
  encodeReuseGuard: () => encodeReuseGuard,
  encodeSender: () => encodeSender,
  encodeSenderData: () => encodeSenderData,
  encodeSenderDataAAD: () => encodeSenderDataAAD,
  encodeSenderType: () => encodeSenderType,
  expandSenderDataKey: () => expandSenderDataKey,
  expandSenderDataNonce: () => expandSenderDataNonce,
  getSenderLeafNodeIndex: () => getSenderLeafNodeIndex,
  reuseGuardEncoder: () => reuseGuardEncoder,
  sampleCiphertext: () => sampleCiphertext,
  senderDataAADEncoder: () => senderDataAADEncoder,
  senderDataEncoder: () => senderDataEncoder,
  senderEncoder: () => senderEncoder,
  senderTypeEncoder: () => senderTypeEncoder,
  senderTypes: () => senderTypes
});
var senderTypes = {
  member: 1,
  external: 2,
  new_member_proposal: 3,
  new_member_commit: 4
};
var senderTypeEncoder = contramapBufferEncoder(uint8Encoder, (t) => senderTypes[t]);
var encodeSenderType = encode(senderTypeEncoder);
var decodeSenderType = mapDecoderOption(decodeUint8, enumNumberToKey(senderTypes));
var senderEncoder = (s) => {
  switch (s.senderType) {
    case "member":
      return contramapBufferEncoders([senderTypeEncoder, uint32Encoder], (s2) => [s2.senderType, s2.leafIndex])(s);
    case "external":
      return contramapBufferEncoders([senderTypeEncoder, uint32Encoder], (s2) => [s2.senderType, s2.senderIndex])(s);
    case "new_member_proposal":
    case "new_member_commit":
      return senderTypeEncoder(s.senderType);
  }
};
var encodeSender = encode(senderEncoder);
var decodeSender = flatMapDecoder(decodeSenderType, (senderType) => {
  switch (senderType) {
    case "member":
      return mapDecoder(decodeUint32, (leafIndex) => ({
        senderType,
        leafIndex
      }));
    case "external":
      return mapDecoder(decodeUint32, (senderIndex) => ({
        senderType,
        senderIndex
      }));
    case "new_member_proposal":
      return mapDecoder(() => [void 0, 0], () => ({
        senderType
      }));
    case "new_member_commit":
      return mapDecoder(() => [void 0, 0], () => ({
        senderType
      }));
  }
});
function getSenderLeafNodeIndex(sender) {
  return sender.senderType === "member" ? sender.leafIndex : void 0;
}
var reuseGuardEncoder = (g) => [
  4,
  (offset, buffer) => {
    const view = new Uint8Array(buffer, offset, 4);
    view.set(g, 0);
  }
];
var encodeReuseGuard = encode(reuseGuardEncoder);
var decodeReuseGuard = (b, offset) => {
  return [b.subarray(offset, offset + 4), 4];
};
var senderDataEncoder = contramapBufferEncoders([uint32Encoder, uint32Encoder, reuseGuardEncoder], (s) => [s.leafIndex, s.generation, s.reuseGuard]);
var encodeSenderData = encode(senderDataEncoder);
var decodeSenderData = mapDecoders([decodeUint32, decodeUint32, decodeReuseGuard], (leafIndex, generation, reuseGuard) => ({
  leafIndex,
  generation,
  reuseGuard
}));
var senderDataAADEncoder = contramapBufferEncoders([varLenDataEncoder, uint64Encoder, contentTypeEncoder], (aad) => [aad.groupId, aad.epoch, aad.contentType]);
var encodeSenderDataAAD = encode(senderDataAADEncoder);
var decodeSenderDataAAD = mapDecoders([decodeVarLenData, decodeUint64, decodeContentType], (groupId, epoch, contentType) => ({
  groupId,
  epoch,
  contentType
}));
function sampleCiphertext(cs, ciphertext) {
  return ciphertext.length < cs.kdf.size ? ciphertext : ciphertext.subarray(0, cs.kdf.size);
}
async function expandSenderDataKey(cs, senderDataSecret, ciphertext) {
  const ciphertextSample = sampleCiphertext(cs, ciphertext);
  const keyLength = cs.hpke.keyLength;
  return await expandWithLabel(senderDataSecret, "key", ciphertextSample, keyLength, cs.kdf);
}
async function expandSenderDataNonce(cs, senderDataSecret, ciphertext) {
  const ciphertextSample = sampleCiphertext(cs, ciphertext);
  const keyLength = cs.hpke.nonceLength;
  return await expandWithLabel(senderDataSecret, "nonce", ciphertextSample, keyLength, cs.kdf);
}

// node_modules/ts-mls/dist/src/framedContent.js
var framedContentApplicationDataEncoder = contramapBufferEncoders([contentTypeEncoder, varLenDataEncoder], (f) => [f.contentType, f.applicationData]);
var encodeFramedContentApplicationData = encode(framedContentApplicationDataEncoder);
var framedContentProposalDataEncoder = contramapBufferEncoders([contentTypeEncoder, proposalEncoder], (f) => [f.contentType, f.proposal]);
var encodeFramedContentProposalData = encode(framedContentProposalDataEncoder);
var framedContentCommitDataEncoder = contramapBufferEncoders([contentTypeEncoder, commitEncoder], (f) => [f.contentType, f.commit]);
var encodeFramedContentCommitData = encode(framedContentCommitDataEncoder);
var framedContentInfoEncoder = (fc) => {
  switch (fc.contentType) {
    case "application":
      return framedContentApplicationDataEncoder(fc);
    case "proposal":
      return framedContentProposalDataEncoder(fc);
    case "commit":
      return framedContentCommitDataEncoder(fc);
  }
};
var encodeFramedContentInfo = encode(framedContentInfoEncoder);
var decodeFramedContentApplicationData = mapDecoder(decodeVarLenData, (applicationData) => ({ contentType: "application", applicationData }));
var decodeFramedContentProposalData = mapDecoder(decodeProposal, (proposal) => ({ contentType: "proposal", proposal }));
var decodeFramedContentCommitData = mapDecoder(decodeCommit, (commit) => ({
  contentType: "commit",
  commit
}));
var decodeFramedContentInfo = flatMapDecoder(decodeContentType, (contentType) => {
  switch (contentType) {
    case "application":
      return decodeFramedContentApplicationData;
    case "proposal":
      return decodeFramedContentProposalData;
    case "commit":
      return decodeFramedContentCommitData;
  }
});
function toTbs2(content, wireformat, context) {
  return { protocolVersion: context.version, wireformat, content, senderType: content.sender.senderType, context };
}
var framedContentEncoder = contramapBufferEncoders([varLenDataEncoder, uint64Encoder, senderEncoder, varLenDataEncoder, framedContentInfoEncoder], (fc) => [fc.groupId, fc.epoch, fc.sender, fc.authenticatedData, fc]);
var encodeFramedContent = encode(framedContentEncoder);
var decodeFramedContent = mapDecoders([decodeVarLenData, decodeUint64, decodeSender, decodeVarLenData, decodeFramedContentInfo], (groupId, epoch, sender, authenticatedData, info) => ({
  groupId,
  epoch,
  sender,
  authenticatedData,
  ...info
}));
var senderInfoEncoder = (info) => {
  switch (info.senderType) {
    case "member":
    case "new_member_commit":
      return groupContextEncoder(info.context);
    case "external":
    case "new_member_proposal":
      return encVoid;
  }
};
var encodeSenderInfo = encode(senderInfoEncoder);
var framedContentTBSEncoder = contramapBufferEncoders([protocolVersionEncoder, wireformatEncoder, framedContentEncoder, senderInfoEncoder], (f) => [f.protocolVersion, f.wireformat, f.content, f]);
var encodeFramedContentTBS = encode(framedContentTBSEncoder);
var encodeFramedContentAuthDataContent = (authData) => {
  switch (authData.contentType) {
    case "commit":
      return encodeFramedContentAuthDataCommit(authData);
    case "application":
    case "proposal":
      return encVoid;
  }
};
var encodeFramedContentAuthDataCommit = contramapBufferEncoder(varLenDataEncoder, (data) => data.confirmationTag);
var framedContentAuthDataEncoder = contramapBufferEncoders([varLenDataEncoder, encodeFramedContentAuthDataContent], (d) => [d.signature, d]);
var encodeFramedContentAuthData = encode(framedContentAuthDataEncoder);
var decodeFramedContentAuthDataCommit = mapDecoder(decodeVarLenData, (confirmationTag) => ({
  contentType: "commit",
  confirmationTag
}));
function decodeFramedContentAuthData(contentType) {
  switch (contentType) {
    case "commit":
      return mapDecoders([decodeVarLenData, decodeFramedContentAuthDataCommit], (signature, commitData) => ({
        signature,
        ...commitData
      }));
    case "application":
    case "proposal":
      return mapDecoder(decodeVarLenData, (signature) => ({
        signature,
        contentType
      }));
  }
}
async function verifyFramedContentSignature(signKey, wireformat, content, auth, context, s) {
  return verifyWithLabel(signKey, "FramedContentTBS", encode(framedContentTBSEncoder)(toTbs2(content, wireformat, context)), auth.signature, s);
}
function signFramedContentTBS(signKey, tbs, s) {
  return signWithLabel(signKey, "FramedContentTBS", encode(framedContentTBSEncoder)(tbs), s);
}
async function signFramedContentApplicationOrProposal(signKey, tbs, cs) {
  const signature = await signFramedContentTBS(signKey, tbs, cs.signature);
  return {
    contentType: tbs.content.contentType,
    signature
  };
}
function createConfirmationTag(confirmationKey, confirmedTranscriptHash, h) {
  return h.mac(confirmationKey, confirmedTranscriptHash);
}
function verifyConfirmationTag(confirmationKey, tag, confirmedTranscriptHash, h) {
  return h.verifyMac(confirmationKey, tag, confirmedTranscriptHash);
}
async function createContentCommitSignature(groupContext, wireformat, c, sender, authenticatedData, signKey, s) {
  const tbs = {
    protocolVersion: groupContext.version,
    wireformat,
    content: {
      contentType: "commit",
      commit: c,
      groupId: groupContext.groupId,
      epoch: groupContext.epoch,
      sender,
      authenticatedData
    },
    senderType: "member",
    context: groupContext
  };
  const signature = await signFramedContentTBS(signKey, tbs, s);
  return { framedContent: tbs.content, signature };
}

// node_modules/ts-mls/dist/src/authenticatedContent.js
var authenticatedContentEncoder = contramapBufferEncoders([wireformatEncoder, framedContentEncoder, framedContentAuthDataEncoder], (a) => [a.wireformat, a.content, a.auth]);
var encodeAuthenticatedContent = encode(authenticatedContentEncoder);
var decodeAuthenticatedContent = mapDecoders([
  decodeWireformat,
  flatMapDecoder(decodeFramedContent, (content) => {
    return mapDecoder(decodeFramedContentAuthData(content.contentType), (auth) => ({ content, auth }));
  })
], (wireformat, contentAuth) => ({
  wireformat,
  ...contentAuth
}));
var authenticatedContentTBMEncoder = contramapBufferEncoders([framedContentTBSEncoder, framedContentAuthDataEncoder], (t) => [t.contentTbs, t.auth]);
var encodeAuthenticatedContentTBM = encode(authenticatedContentTBMEncoder);
function createMembershipTag(membershipKey, tbm, h) {
  return h.mac(membershipKey, encode(authenticatedContentTBMEncoder)(tbm));
}
function verifyMembershipTag(membershipKey, tbm, tag, h) {
  return h.verifyMac(membershipKey, tag, encode(authenticatedContentTBMEncoder)(tbm));
}
function makeProposalRef(proposal, h) {
  return refhash("MLS 1.0 Proposal Reference", encode(authenticatedContentEncoder)(proposal), h);
}

// node_modules/ts-mls/dist/src/publicMessage.js
var publicMessageInfoEncoder = (info) => {
  switch (info.senderType) {
    case "member":
      return varLenDataEncoder(info.membershipTag);
    case "external":
    case "new_member_proposal":
    case "new_member_commit":
      return encVoid;
  }
};
var encodePublicMessageInfo = encode(publicMessageInfoEncoder);
function decodePublicMessageInfo(senderType) {
  switch (senderType) {
    case "member":
      return mapDecoder(decodeVarLenData, (membershipTag) => ({
        senderType,
        membershipTag
      }));
    case "external":
    case "new_member_proposal":
    case "new_member_commit":
      return succeedDecoder({ senderType });
  }
}
var publicMessageEncoder = contramapBufferEncoders([framedContentEncoder, framedContentAuthDataEncoder, publicMessageInfoEncoder], (msg) => [msg.content, msg.auth, msg]);
var encodePublicMessage = encode(publicMessageEncoder);
var decodePublicMessage = flatMapDecoder(decodeFramedContent, (content) => mapDecoders([decodeFramedContentAuthData(content.contentType), decodePublicMessageInfo(content.sender.senderType)], (auth, info) => ({
  ...info,
  content,
  auth
})));
function findSignaturePublicKey(ratchetTree, groupContext, framedContent) {
  switch (framedContent.sender.senderType) {
    case "member":
      return getSignaturePublicKeyFromLeafIndex(ratchetTree, toLeafIndex(framedContent.sender.leafIndex));
    case "external": {
      const sender = senderFromExtension(groupContext.extensions, framedContent.sender.senderIndex);
      if (sender === void 0)
        throw new ValidationError("Received external but no external_sender extension");
      return sender.signaturePublicKey;
    }
    case "new_member_proposal":
      if (framedContent.contentType !== "proposal")
        throw new ValidationError("Received new_member_proposal but contentType is not proposal");
      if (framedContent.proposal.proposalType !== "add")
        throw new ValidationError("Received new_member_proposal but proposalType was not add");
      return framedContent.proposal.add.keyPackage.leafNode.signaturePublicKey;
    case "new_member_commit": {
      if (framedContent.contentType !== "commit")
        throw new ValidationError("Received new_member_commit but contentType is not commit");
      if (framedContent.commit.path === void 0)
        throw new ValidationError("Commit contains no update path");
      return framedContent.commit.path.leafNode.signaturePublicKey;
    }
  }
}
function senderFromExtension(extensions, senderIndex) {
  const externalSenderExtensions = extensions.filter((ex) => ex.extensionType === "external_senders");
  const externalSenderExtension = externalSenderExtensions[senderIndex];
  if (externalSenderExtension !== void 0) {
    const externalSender = decodeExternalSender(externalSenderExtension.extensionData, 0);
    if (externalSender === void 0)
      throw new CodecError("Could not decode ExternalSender");
    return externalSender[0];
  }
}

// node_modules/ts-mls/dist/src/messageProtectionPublic.js
async function protectProposalPublic(signKey, membershipKey, groupContext, authenticatedData, proposal, leafIndex, cs) {
  const framedContent = {
    groupId: groupContext.groupId,
    epoch: groupContext.epoch,
    sender: { senderType: "member", leafIndex },
    contentType: "proposal",
    authenticatedData,
    proposal
  };
  const tbs = {
    protocolVersion: groupContext.version,
    wireformat: "mls_public_message",
    content: framedContent,
    senderType: "member",
    context: groupContext
  };
  const auth = await signFramedContentApplicationOrProposal(signKey, tbs, cs);
  const authenticatedContent = {
    wireformat: "mls_public_message",
    content: framedContent,
    auth
  };
  const msg = await protectPublicMessage(membershipKey, groupContext, authenticatedContent, cs);
  return { publicMessage: msg };
}
async function protectExternalProposalPublic(signKey, groupContext, authenticatedData, proposal, sender, cs) {
  const framedContent = {
    groupId: groupContext.groupId,
    epoch: groupContext.epoch,
    sender,
    contentType: "proposal",
    authenticatedData,
    proposal
  };
  const tbs = {
    protocolVersion: groupContext.version,
    wireformat: "mls_public_message",
    content: framedContent,
    senderType: sender.senderType,
    context: groupContext
  };
  const auth = await signFramedContentApplicationOrProposal(signKey, tbs, cs);
  const msg = {
    content: framedContent,
    auth,
    senderType: sender.senderType
  };
  return { publicMessage: msg };
}
async function protectPublicMessage(membershipKey, groupContext, content, cs) {
  if (content.content.contentType === "application")
    throw new UsageError("Can't make an application message public");
  if (content.content.sender.senderType == "member") {
    const authenticatedContent = {
      contentTbs: toTbs2(content.content, "mls_public_message", groupContext),
      auth: content.auth
    };
    const tag = await createMembershipTag(membershipKey, authenticatedContent, cs.hash);
    return {
      content: content.content,
      auth: content.auth,
      senderType: "member",
      membershipTag: tag
    };
  }
  return {
    content: content.content,
    auth: content.auth,
    senderType: content.content.sender.senderType
  };
}
async function unprotectPublicMessage(membershipKey, groupContext, ratchetTree, msg, cs, overrideSignatureKey) {
  if (msg.content.contentType === "application")
    throw new UsageError("Can't make an application message public");
  if (msg.senderType === "member") {
    const authenticatedContent = {
      contentTbs: toTbs2(msg.content, "mls_public_message", groupContext),
      auth: msg.auth
    };
    if (!await verifyMembershipTag(membershipKey, authenticatedContent, msg.membershipTag, cs.hash))
      throw new CryptoVerificationError("Could not verify membership");
  }
  const signaturePublicKey = overrideSignatureKey !== void 0 ? overrideSignatureKey : findSignaturePublicKey(ratchetTree, groupContext, msg.content);
  const signatureValid = await verifyFramedContentSignature(signaturePublicKey, "mls_public_message", msg.content, msg.auth, groupContext, cs.signature);
  if (!signatureValid)
    throw new CryptoVerificationError("Signature invalid");
  return {
    wireformat: "mls_public_message",
    content: msg.content,
    auth: msg.auth
  };
}

// node_modules/ts-mls/dist/src/externalProposal.js
async function proposeAddExternal(groupInfo, keyPackage, privateKeyPackage, cs, authenticatedData = new Uint8Array()) {
  const allExtensionsSupported = extensionsSupportedByCapabilities(groupInfo.groupContext.extensions, keyPackage.leafNode.capabilities);
  if (!allExtensionsSupported)
    throw new UsageError("client does not support every extension in the GroupContext");
  const proposal = {
    proposalType: "add",
    add: {
      keyPackage
    }
  };
  const result = await protectExternalProposalPublic(privateKeyPackage.signaturePrivateKey, groupInfo.groupContext, authenticatedData, proposal, { senderType: "new_member_proposal" }, cs);
  return {
    wireformat: "mls_public_message",
    version: groupInfo.groupContext.version,
    publicMessage: result.publicMessage
  };
}
async function proposeExternal(groupInfo, proposal, signaturePublicKey, signaturePrivateKey, cs, authenticatedData = new Uint8Array()) {
  const externalSenderExtensionIndex = groupInfo.groupContext.extensions.findIndex((ex) => {
    if (ex.extensionType !== "external_senders")
      return false;
    const decoded = decodeExternalSender(ex.extensionData, 0);
    if (decoded === void 0)
      throw new ValidationError("Could not decode external_sender extension");
    return constantTimeEqual(decoded[0].signaturePublicKey, signaturePublicKey);
  });
  if (externalSenderExtensionIndex === -1)
    throw new ValidationError("Could not find external_sender extension in groupContext.extensions");
  const result = await protectExternalProposalPublic(signaturePrivateKey, groupInfo.groupContext, authenticatedData, proposal, { senderType: "external", senderIndex: externalSenderExtensionIndex }, cs);
  return {
    wireformat: "mls_public_message",
    version: groupInfo.groupContext.version,
    publicMessage: result.publicMessage
  };
}

// node_modules/ts-mls/dist/src/requiredCapabilities.js
var requiredCapabilitiesEncoder = contramapBufferEncoders([varLenTypeEncoder(uint16Encoder), varLenTypeEncoder(uint16Encoder), varLenTypeEncoder(credentialTypeEncoder)], (rc) => [rc.extensionTypes, rc.proposalTypes, rc.credentialTypes]);
var encodeRequiredCapabilities = encode(requiredCapabilitiesEncoder);
var decodeRequiredCapabilities = mapDecoders([decodeVarLenType(decodeUint16), decodeVarLenType(decodeUint16), decodeVarLenType(decodeCredentialType)], (extensionTypes, proposalTypes, credentialTypes2) => ({ extensionTypes, proposalTypes, credentialTypes: credentialTypes2 }));

// node_modules/ts-mls/dist/src/authenticationService.js
var defaultAuthenticationService = {
  async validateCredential(_credential, _signaturePublicKey) {
    return true;
  }
};

// node_modules/ts-mls/dist/src/paddingConfig.js
var paddingConfig_exports = {};
__export(paddingConfig_exports, {
  byteLengthToPad: () => byteLengthToPad,
  defaultPaddingConfig: () => defaultPaddingConfig
});
var defaultPaddingConfig = { kind: "padUntilLength", padUntilLength: 256 };
function byteLengthToPad(encodedLength, config) {
  if (config.kind === "alwaysPad")
    return config.paddingLength;
  else
    return encodedLength >= config.padUntilLength ? 0 : config.padUntilLength - encodedLength;
}

// node_modules/ts-mls/dist/src/keyPackageEqualityConfig.js
var defaultKeyPackageEqualityConfig = {
  compareKeyPackages(a, b) {
    return constantTimeEqual(a.leafNode.signaturePublicKey, b.leafNode.signaturePublicKey);
  },
  compareKeyPackageToLeafNode(a, b) {
    return constantTimeEqual(a.leafNode.signaturePublicKey, b.signaturePublicKey);
  }
};

// node_modules/ts-mls/dist/src/lifetimeConfig.js
var defaultLifetimeConfig = {
  maximumTotalLifetime: 2628000n,
  // 1 month
  validateLifetimeOnReceive: false
};

// node_modules/ts-mls/dist/src/keyRetentionConfig.js
var keyRetentionConfig_exports = {};
__export(keyRetentionConfig_exports, {
  defaultKeyRetentionConfig: () => defaultKeyRetentionConfig
});
var defaultKeyRetentionConfig = {
  retainKeysForGenerations: 10,
  retainKeysForEpochs: 4,
  maximumForwardRatchetSteps: 200
};

// node_modules/ts-mls/dist/src/clientState.js
var clientState_exports = {};
__export(clientState_exports, {
  addHistoricalReceiverData: () => addHistoricalReceiverData,
  applyProposals: () => applyProposals,
  checkCanSendApplicationMessages: () => checkCanSendApplicationMessages,
  checkCanSendHandshakeMessages: () => checkCanSendHandshakeMessages,
  createGroup: () => createGroup,
  decodeGroupState: () => decodeGroupState,
  decodeGroupStateWithoutTree: () => decodeGroupStateWithoutTree,
  encodeGroupState: () => encodeGroupState,
  encodeGroupStateWithoutTree: () => encodeGroupStateWithoutTree,
  exportSecret: () => exportSecret,
  extractFromGroupMembers: () => extractFromGroupMembers,
  getGroupMembers: () => getGroupMembers,
  getOwnLeafNode: () => getOwnLeafNode,
  groupStateEncoder: () => groupStateEncoder,
  groupStateEncoderWithoutTree: () => groupStateEncoderWithoutTree,
  joinGroup: () => joinGroup,
  joinGroupWithExtensions: () => joinGroupWithExtensions,
  makePskIndex: () => makePskIndex,
  nextEpochContext: () => nextEpochContext,
  processProposal: () => processProposal,
  throwIfDefined: () => throwIfDefined,
  validateLeafNodeCredentialAndKeyUniqueness: () => validateLeafNodeCredentialAndKeyUniqueness,
  validateLeafNodeUpdateOrCommit: () => validateLeafNodeUpdateOrCommit,
  validateRatchetTree: () => validateRatchetTree
});

// node_modules/ts-mls/dist/src/groupInfo.js
var groupInfo_exports = {};
__export(groupInfo_exports, {
  decodeGroupInfo: () => decodeGroupInfo,
  decodeGroupInfoTBS: () => decodeGroupInfoTBS,
  encodeGroupInfo: () => encodeGroupInfo,
  encodeGroupInfoTBS: () => encodeGroupInfoTBS,
  extractWelcomeSecret: () => extractWelcomeSecret,
  groupInfoEncoder: () => groupInfoEncoder,
  groupInfoTBSEncoder: () => groupInfoTBSEncoder,
  ratchetTreeFromExtension: () => ratchetTreeFromExtension,
  signGroupInfo: () => signGroupInfo,
  verifyGroupInfoConfirmationTag: () => verifyGroupInfoConfirmationTag,
  verifyGroupInfoSignature: () => verifyGroupInfoSignature
});
var groupInfoTBSEncoder = contramapBufferEncoders([groupContextEncoder, varLenTypeEncoder(extensionEncoder), varLenDataEncoder, uint32Encoder], (g) => [g.groupContext, g.extensions, g.confirmationTag, g.signer]);
var encodeGroupInfoTBS = encode(groupInfoTBSEncoder);
var decodeGroupInfoTBS = mapDecoders([decodeGroupContext, decodeVarLenType(decodeExtension), decodeVarLenData, decodeUint32], (groupContext, extensions, confirmationTag, signer) => ({
  groupContext,
  extensions,
  confirmationTag,
  signer
}));
var groupInfoEncoder = contramapBufferEncoders([groupInfoTBSEncoder, varLenDataEncoder], (g) => [g, g.signature]);
var encodeGroupInfo = encode(groupInfoEncoder);
var decodeGroupInfo = mapDecoders([decodeGroupInfoTBS, decodeVarLenData], (tbs, signature) => ({
  ...tbs,
  signature
}));
function ratchetTreeFromExtension(info) {
  const treeExtension = info.extensions.find((ex) => ex.extensionType === "ratchet_tree");
  if (treeExtension !== void 0) {
    const tree = decodeRatchetTree(treeExtension.extensionData, 0);
    if (tree === void 0)
      throw new CodecError("Could not decode RatchetTree");
    return tree[0];
  }
}
async function signGroupInfo(tbs, privateKey, s) {
  const signature = await signWithLabel(privateKey, "GroupInfoTBS", encode(groupInfoTBSEncoder)(tbs), s);
  return { ...tbs, signature };
}
function verifyGroupInfoSignature(gi, publicKey, s) {
  return verifyWithLabel(publicKey, "GroupInfoTBS", encode(groupInfoTBSEncoder)(gi), gi.signature, s);
}
async function verifyGroupInfoConfirmationTag(gi, joinerSecret, pskSecret, cs) {
  const epochSecret = await extractEpochSecret(gi.groupContext, joinerSecret, cs.kdf, pskSecret);
  const key = await deriveSecret(epochSecret, "confirm", cs.kdf);
  return cs.hash.verifyMac(key, gi.confirmationTag, gi.groupContext.confirmedTranscriptHash);
}
async function extractWelcomeSecret(joinerSecret, pskSecret, kdf) {
  return deriveSecret(await kdf.extract(joinerSecret, pskSecret), "welcome", kdf);
}

// node_modules/ts-mls/dist/src/keySchedule.js
var keySchedule_exports = {};
__export(keySchedule_exports, {
  decodeKeySchedule: () => decodeKeySchedule,
  deriveKeySchedule: () => deriveKeySchedule,
  encodeKeySchedule: () => encodeKeySchedule,
  initializeEpoch: () => initializeEpoch,
  initializeKeySchedule: () => initializeKeySchedule,
  keyScheduleEncoder: () => keyScheduleEncoder,
  mlsExporter: () => mlsExporter
});
var keyScheduleEncoder = contramapBufferEncoders([
  varLenDataEncoder,
  varLenDataEncoder,
  varLenDataEncoder,
  varLenDataEncoder,
  varLenDataEncoder,
  varLenDataEncoder,
  varLenDataEncoder,
  varLenDataEncoder,
  varLenDataEncoder,
  varLenDataEncoder
], (ks) => [
  new Uint8Array(),
  ks.senderDataSecret,
  new Uint8Array(),
  ks.exporterSecret,
  ks.externalSecret,
  ks.confirmationKey,
  ks.membershipKey,
  ks.resumptionPsk,
  ks.epochAuthenticator,
  ks.initSecret
]);
var encodeKeySchedule = encode(keyScheduleEncoder);
var decodeKeySchedule = mapDecoders([
  decodeVarLenData,
  decodeVarLenData,
  decodeVarLenData,
  decodeVarLenData,
  decodeVarLenData,
  decodeVarLenData,
  decodeVarLenData,
  decodeVarLenData,
  decodeVarLenData,
  decodeVarLenData
], (_epochSecret, senderDataSecret, _encryptionSecret, exporterSecret, externalSecret, confirmationKey, membershipKey, resumptionPsk, epochAuthenticator, initSecret) => ({
  senderDataSecret,
  exporterSecret,
  externalSecret,
  confirmationKey,
  membershipKey,
  resumptionPsk,
  epochAuthenticator,
  initSecret
}));
async function mlsExporter(exporterSecret, label, context, length, cs) {
  const secret = await deriveSecret(exporterSecret, label, cs.kdf);
  const hash = await cs.hash.digest(context);
  return expandWithLabel(secret, "exported", hash, length, cs.kdf);
}
async function deriveKeySchedule(joinerSecret, pskSecret, groupContext, kdf) {
  const epochSecret = await extractEpochSecret(groupContext, joinerSecret, kdf, pskSecret);
  const encryptionSecret = await deriveSecret(epochSecret, "encryption", kdf);
  const keySchedule = await initializeKeySchedule(epochSecret, kdf);
  return [keySchedule, encryptionSecret];
}
async function initializeKeySchedule(epochSecret, kdf) {
  const newInitSecret = await deriveSecret(epochSecret, "init", kdf);
  const senderDataSecret = await deriveSecret(epochSecret, "sender data", kdf);
  const exporterSecret = await deriveSecret(epochSecret, "exporter", kdf);
  const externalSecret = await deriveSecret(epochSecret, "external", kdf);
  const confirmationKey = await deriveSecret(epochSecret, "confirm", kdf);
  const membershipKey = await deriveSecret(epochSecret, "membership", kdf);
  const resumptionPsk = await deriveSecret(epochSecret, "resumption", kdf);
  const epochAuthenticator = await deriveSecret(epochSecret, "authentication", kdf);
  const newKeySchedule = {
    initSecret: newInitSecret,
    senderDataSecret,
    exporterSecret,
    externalSecret,
    confirmationKey,
    membershipKey,
    resumptionPsk,
    epochAuthenticator
  };
  return newKeySchedule;
}
async function initializeEpoch(initSecret, commitSecret, groupContext, pskSecret, kdf) {
  const joinerSecret = await extractJoinerSecret(groupContext, initSecret, commitSecret, kdf);
  const welcomeSecret = await extractWelcomeSecret(joinerSecret, pskSecret, kdf);
  const [newKeySchedule, encryptionSecret] = await deriveKeySchedule(joinerSecret, pskSecret, groupContext, kdf);
  return { welcomeSecret, joinerSecret, encryptionSecret, keySchedule: newKeySchedule };
}

// node_modules/ts-mls/dist/src/secretTree.js
var secretTree_exports = {};
__export(secretTree_exports, {
  allSecretTreeValues: () => allSecretTreeValues,
  consumeRatchet: () => consumeRatchet,
  createSecretTree: () => createSecretTree,
  decodeGenerationSecret: () => decodeGenerationSecret,
  decodeSecretTree: () => decodeSecretTree,
  decodeSecretTreeNode: () => decodeSecretTreeNode,
  deriveKey: () => deriveKey,
  deriveNonce: () => deriveNonce,
  derivePrivateMessageNonce: () => derivePrivateMessageNonce,
  generationSecretEncoder: () => generationSecretEncoder,
  ratchetToGeneration: () => ratchetToGeneration,
  ratchetUntil: () => ratchetUntil,
  secretTreeEncoder: () => secretTreeEncoder,
  secretTreeNodeEncoder: () => secretTreeNodeEncoder
});
var generationSecretEncoder = contramapBufferEncoders([varLenDataEncoder, uint32Encoder, numberRecordEncoder(uint32Encoder, varLenDataEncoder)], (gs) => [gs.secret, gs.generation, gs.unusedGenerations]);
var decodeGenerationSecret = mapDecoders([decodeVarLenData, decodeUint32, decodeNumberRecord(decodeUint32, decodeVarLenData)], (secret, generation, unusedGenerations) => ({
  secret,
  generation,
  unusedGenerations
}));
var secretTreeNodeEncoder = contramapBufferEncoders([generationSecretEncoder, generationSecretEncoder], (node) => [node.handshake, node.application]);
var decodeSecretTreeNode = mapDecoders([decodeGenerationSecret, decodeGenerationSecret], (handshake, application) => ({
  handshake,
  application
}));
var secretTreeEncoder = varLenTypeEncoder(secretTreeNodeEncoder);
var decodeSecretTree = decodeVarLenType(decodeSecretTreeNode);
function allSecretTreeValues(tree) {
  const arr = new Array(tree.length * 2);
  for (const node of tree) {
    arr.push(node.application.secret);
    arr.push(node.handshake.secret);
    for (const gen of Object.values(node.application.unusedGenerations)) {
      arr.push(gen);
    }
    for (const gen of Object.values(node.handshake.unusedGenerations)) {
      arr.push(gen);
    }
  }
  return arr;
}
function scaffoldSecretTree(leafWidth2, encryptionSecret, kdf) {
  const tree = new Array(nodeWidth(leafWidth2));
  const rootIndex = root(leafWidth2);
  tree[rootIndex] = encryptionSecret;
  return deriveChildren(tree, rootIndex, kdf);
}
async function createSecretTree(leafWidth2, encryptionSecret, kdf) {
  const tree = await scaffoldSecretTree(leafWidth2, encryptionSecret, kdf);
  return await Promise.all(tree.map(async (secret) => {
    const application = await createRatchetRoot(secret, "application", kdf);
    const handshake = await createRatchetRoot(secret, "handshake", kdf);
    return { handshake, application };
  }));
}
async function deriveChildren(tree, nodeIndex, kdf) {
  if (isLeaf(nodeIndex))
    return tree;
  const l = left(nodeIndex);
  const r = right(nodeIndex);
  const parentSecret = tree[nodeIndex];
  if (parentSecret === void 0)
    throw new InternalError("Bad node index for secret tree");
  const leftSecret = await expandWithLabel(parentSecret, "tree", new TextEncoder().encode("left"), kdf.size, kdf);
  const rightSecret = await expandWithLabel(parentSecret, "tree", new TextEncoder().encode("right"), kdf.size, kdf);
  tree[l] = leftSecret;
  tree[r] = rightSecret;
  return deriveChildren(await deriveChildren(tree, l, kdf), r, kdf);
}
async function deriveNonce(secret, generation, cs) {
  return await deriveTreeSecret(secret, "nonce", generation, cs.hpke.nonceLength, cs.kdf);
}
async function deriveKey(secret, generation, cs) {
  return await deriveTreeSecret(secret, "key", generation, cs.hpke.keyLength, cs.kdf);
}
async function ratchetUntil(current, desiredGen, config, kdf) {
  const generationDifference = desiredGen - current.generation;
  if (generationDifference > config.maximumForwardRatchetSteps)
    throw new ValidationError("Desired generation too far in the future");
  const consumed = [];
  let result = { ...current };
  for (let i = 0; i < generationDifference; i++) {
    const nextSecret = await deriveTreeSecret(result.secret, "secret", result.generation, kdf.size, kdf);
    const [updated, old] = updateUnusedGenerations(result, config.retainKeysForGenerations);
    consumed.push(...old);
    result = {
      secret: nextSecret,
      generation: result.generation + 1,
      unusedGenerations: updated
    };
  }
  return [result, consumed];
}
function updateUnusedGenerations(s, retainGenerationsMax) {
  const withNew = { ...s.unusedGenerations, [s.generation]: s.secret };
  const generations = Object.keys(withNew);
  const result = generations.length >= retainGenerationsMax ? removeOldGenerations(withNew, retainGenerationsMax) : [withNew, []];
  return result;
}
function removeOldGenerations(unusedGenerations, max) {
  const generations = Object.keys(unusedGenerations).map(Number).sort((a, b) => a - b);
  const cutoff = generations.length - max;
  const consumed = new Array();
  const record = {};
  for (const [n, gen] of generations.entries()) {
    const value = unusedGenerations[gen];
    if (n < cutoff) {
      consumed.push(value);
    } else {
      record[gen] = value;
    }
  }
  return [record, consumed];
}
async function derivePrivateMessageNonce(secret, generation, reuseGuard, cs) {
  const nonce = await deriveNonce(secret, generation, cs);
  if (nonce.length >= 4 && reuseGuard.length >= 4) {
    for (let i = 0; i < 4; i++) {
      nonce[i] ^= reuseGuard[i];
    }
  } else
    throw new ValidationError("Reuse guard or nonce incorrect length");
  return nonce;
}
async function ratchetToGeneration(tree, senderData, contentType, config, cs) {
  const index = leafToNodeIndex(toLeafIndex(senderData.leafIndex));
  const node = tree[index];
  if (node === void 0)
    throw new InternalError("Bad node index for secret tree");
  const ratchet = ratchetForContentType(node, contentType);
  if (ratchet.generation > senderData.generation) {
    const desired = ratchet.unusedGenerations[senderData.generation];
    if (desired !== void 0) {
      const { [senderData.generation]: _, ...removedDesiredGen } = ratchet.unusedGenerations;
      const ratchetState = { ...ratchet, unusedGenerations: removedDesiredGen };
      return await createRatchetResultWithSecret(node, index, desired, senderData.generation, senderData.reuseGuard, tree, contentType, [], cs, ratchetState);
    }
    throw new ValidationError("Desired gen in the past");
  }
  const [currentSecret, consumed] = await ratchetUntil(ratchetForContentType(node, contentType), senderData.generation, config, cs.kdf);
  return createRatchetResult(node, index, currentSecret, senderData.reuseGuard, tree, contentType, consumed, cs);
}
async function consumeRatchet(tree, index, contentType, cs) {
  const node = tree[index];
  if (node === void 0)
    throw new InternalError("Bad node index for secret tree");
  const currentSecret = ratchetForContentType(node, contentType);
  const reuseGuard = cs.rng.randomBytes(4);
  return createRatchetResult(node, index, currentSecret, reuseGuard, tree, contentType, [], cs);
}
async function createRatchetResult(node, index, currentSecret, reuseGuard, tree, contentType, consumed, cs) {
  const nextSecret = await deriveTreeSecret(currentSecret.secret, "secret", currentSecret.generation, cs.kdf.size, cs.kdf);
  const ratchetState = { ...currentSecret, secret: nextSecret, generation: currentSecret.generation + 1 };
  return await createRatchetResultWithSecret(node, index, currentSecret.secret, currentSecret.generation, reuseGuard, tree, contentType, consumed, cs, ratchetState);
}
async function createRatchetResultWithSecret(node, index, secret, generation, reuseGuard, tree, contentType, consumed, cs, ratchetState) {
  const { nonce, key } = await createKeyAndNonce(secret, generation, reuseGuard, cs);
  const newNode = contentType === "application" ? { ...node, application: ratchetState } : { ...node, handshake: ratchetState };
  const newTree = tree.slice();
  newTree[index] = newNode;
  return {
    generation,
    reuseGuard,
    nonce,
    key,
    newTree,
    consumed: [...consumed, secret, key]
  };
}
async function createKeyAndNonce(secret, generation, reuseGuard, cs) {
  const key = await deriveKey(secret, generation, cs);
  const nonce = await derivePrivateMessageNonce(secret, generation, reuseGuard, cs);
  return { nonce, key };
}
function ratchetForContentType(node, contentType) {
  switch (contentType) {
    case "application":
      return node.application;
    case "proposal":
      return node.handshake;
    case "commit":
      return node.handshake;
  }
}
async function createRatchetRoot(node, label, kdf) {
  const secret = await expandWithLabel(node, label, new Uint8Array(), kdf.size, kdf);
  return { secret, generation: 0, unusedGenerations: {} };
}

// node_modules/ts-mls/dist/src/transcriptHash.js
var transcriptHash_exports = {};
__export(transcriptHash_exports, {
  confirmedTranscriptHashInputEncoder: () => confirmedTranscriptHashInputEncoder,
  createConfirmedHash: () => createConfirmedHash,
  createInterimHash: () => createInterimHash,
  decodeConfirmedTranscriptHashInput: () => decodeConfirmedTranscriptHashInput,
  encodeConfirmedTranscriptHashInput: () => encodeConfirmedTranscriptHashInput
});
var confirmedTranscriptHashInputEncoder = contramapBufferEncoders([wireformatEncoder, framedContentEncoder, varLenDataEncoder], (input) => [input.wireformat, input.content, input.signature]);
var encodeConfirmedTranscriptHashInput = encode(confirmedTranscriptHashInputEncoder);
var decodeConfirmedTranscriptHashInput = mapDecodersOption([decodeWireformat, decodeFramedContent, decodeVarLenData], (wireformat, content, signature) => {
  if (content.contentType === "commit")
    return {
      wireformat,
      content,
      signature
    };
  else
    return void 0;
});
function createConfirmedHash(interimTranscriptHash, input, hash) {
  const [len, write] = confirmedTranscriptHashInputEncoder(input);
  const buf = new ArrayBuffer(interimTranscriptHash.byteLength + len);
  const arr = new Uint8Array(buf);
  arr.set(interimTranscriptHash, 0);
  write(interimTranscriptHash.byteLength, buf);
  return hash.digest(arr);
}
function createInterimHash(confirmedHash, confirmationTag, hash) {
  const [len, write] = varLenDataEncoder(confirmationTag);
  const buf = new ArrayBuffer(confirmedHash.byteLength + len);
  const arr = new Uint8Array(buf);
  arr.set(confirmedHash, 0);
  write(confirmedHash.byteLength, buf);
  return hash.digest(arr);
}

// node_modules/ts-mls/dist/src/welcome.js
var welcome_exports = {};
__export(welcome_exports, {
  decodeEncryptedGroupSecrets: () => decodeEncryptedGroupSecrets,
  decodeWelcome: () => decodeWelcome,
  decryptGroupInfo: () => decryptGroupInfo,
  decryptGroupSecrets: () => decryptGroupSecrets,
  encodeEncryptedGroupSecrets: () => encodeEncryptedGroupSecrets,
  encodeWelcome: () => encodeWelcome,
  encryptGroupInfo: () => encryptGroupInfo,
  encryptGroupSecrets: () => encryptGroupSecrets,
  encryptedGroupSecretsEncoder: () => encryptedGroupSecretsEncoder,
  welcomeEncoder: () => welcomeEncoder,
  welcomeKey: () => welcomeKey,
  welcomeNonce: () => welcomeNonce
});

// node_modules/ts-mls/dist/src/groupSecrets.js
var groupSecrets_exports = {};
__export(groupSecrets_exports, {
  decodeGroupSecrets: () => decodeGroupSecrets,
  encodeGroupSecrets: () => encodeGroupSecrets,
  groupSecretsEncoder: () => groupSecretsEncoder
});
var groupSecretsEncoder = contramapBufferEncoders([varLenDataEncoder, optionalEncoder(varLenDataEncoder), varLenTypeEncoder(pskIdEncoder)], (gs) => [gs.joinerSecret, gs.pathSecret, gs.psks]);
var encodeGroupSecrets = encode(groupSecretsEncoder);
var decodeGroupSecrets = mapDecoders([decodeVarLenData, decodeOptional(decodeVarLenData), decodeVarLenType(decodePskId)], (joinerSecret, pathSecret, psks) => ({ joinerSecret, pathSecret, psks }));

// node_modules/ts-mls/dist/src/welcome.js
var encryptedGroupSecretsEncoder = contramapBufferEncoders([varLenDataEncoder, hpkeCiphertextEncoder], (egs) => [egs.newMember, egs.encryptedGroupSecrets]);
var encodeEncryptedGroupSecrets = encode(encryptedGroupSecretsEncoder);
var decodeEncryptedGroupSecrets = mapDecoders([decodeVarLenData, decodeHpkeCiphertext], (newMember, encryptedGroupSecrets) => ({ newMember, encryptedGroupSecrets }));
var welcomeEncoder = contramapBufferEncoders([ciphersuiteEncoder, varLenTypeEncoder(encryptedGroupSecretsEncoder), varLenDataEncoder], (welcome) => [welcome.cipherSuite, welcome.secrets, welcome.encryptedGroupInfo]);
var encodeWelcome = encode(welcomeEncoder);
var decodeWelcome = mapDecoders([decodeCiphersuite, decodeVarLenType(decodeEncryptedGroupSecrets), decodeVarLenData], (cipherSuite, secrets, encryptedGroupInfo) => ({ cipherSuite, secrets, encryptedGroupInfo }));
function welcomeNonce(welcomeSecret, cs) {
  return expandWithLabel(welcomeSecret, "nonce", new Uint8Array(), cs.hpke.nonceLength, cs.kdf);
}
function welcomeKey(welcomeSecret, cs) {
  return expandWithLabel(welcomeSecret, "key", new Uint8Array(), cs.hpke.keyLength, cs.kdf);
}
async function encryptGroupInfo(groupInfo, welcomeSecret, cs) {
  const key = await welcomeKey(welcomeSecret, cs);
  const nonce = await welcomeNonce(welcomeSecret, cs);
  const encrypted = await cs.hpke.encryptAead(key, nonce, void 0, encode(groupInfoEncoder)(groupInfo));
  return encrypted;
}
async function decryptGroupInfo(w, joinerSecret, pskSecret, cs) {
  const welcomeSecret = await extractWelcomeSecret(joinerSecret, pskSecret, cs.kdf);
  const key = await welcomeKey(welcomeSecret, cs);
  const nonce = await welcomeNonce(welcomeSecret, cs);
  const decrypted = await cs.hpke.decryptAead(key, nonce, void 0, w.encryptedGroupInfo);
  const decoded = decodeGroupInfo(decrypted, 0);
  return decoded?.[0];
}
function encryptGroupSecrets(initKey, encryptedGroupInfo, groupSecrets, hpke2) {
  return encryptWithLabel(initKey, "Welcome", encryptedGroupInfo, encode(groupSecretsEncoder)(groupSecrets), hpke2);
}
async function decryptGroupSecrets(initPrivateKey, keyPackageRef, welcome, hpke2) {
  const secret = welcome.secrets.find((s) => constantTimeEqual(s.newMember, keyPackageRef));
  if (secret === void 0)
    throw new ValidationError("No matching secret found");
  const decrypted = await decryptWithLabel(initPrivateKey, "Welcome", welcome.encryptedGroupInfo, secret.encryptedGroupSecrets.kemOutput, secret.encryptedGroupSecrets.ciphertext, hpke2);
  return decodeGroupSecrets(decrypted, 0)?.[0];
}

// node_modules/ts-mls/dist/src/pathSecrets.js
var pathSecrets_exports = {};
__export(pathSecrets_exports, {
  getCommitSecret: () => getCommitSecret,
  pathToPathSecrets: () => pathToPathSecrets,
  pathToRoot: () => pathToRoot
});
function pathToPathSecrets(pathSecrets) {
  return pathSecrets.reduce((acc, cur) => ({
    ...acc,
    [cur.nodeIndex]: cur.secret
  }), {});
}
async function getCommitSecret(tree, nodeIndex, pathSecret, kdf) {
  const rootIndex = root(leafWidth(tree.length));
  const path = await pathToRoot(tree, nodeIndex, pathSecret, kdf);
  const rootSecret = path[rootIndex];
  if (rootSecret === void 0)
    throw new InternalError("Could not find secret for root");
  return deriveSecret(rootSecret, "path", kdf);
}
async function pathToRoot(tree, nodeIndex, pathSecret, kdf) {
  const rootIndex = root(leafWidth(tree.length));
  let currentIndex = nodeIndex;
  const pathSecrets = { [nodeIndex]: pathSecret };
  while (currentIndex != rootIndex) {
    const nextIndex = findFirstNonBlankAncestor(tree, currentIndex);
    const nextSecret = await deriveSecret(pathSecrets[currentIndex], "path", kdf);
    pathSecrets[nextIndex] = nextSecret;
    currentIndex = nextIndex;
  }
  return pathSecrets;
}

// node_modules/ts-mls/dist/src/privateKeyPath.js
var privateKeyPath_exports = {};
__export(privateKeyPath_exports, {
  decodePrivateKeyPath: () => decodePrivateKeyPath,
  mergePrivateKeyPaths: () => mergePrivateKeyPaths,
  privateKeyPathEncoder: () => privateKeyPathEncoder,
  toPrivateKeyPath: () => toPrivateKeyPath,
  updateLeafKey: () => updateLeafKey
});
var privateKeyPathEncoder = contramapBufferEncoders([uint32Encoder, numberRecordEncoder(uint32Encoder, varLenDataEncoder)], (pkp) => [pkp.leafIndex, pkp.privateKeys]);
var decodePrivateKeyPath = mapDecoders([decodeUint32, decodeNumberRecord(decodeUint32, decodeVarLenData)], (leafIndex, privateKeys) => ({
  leafIndex,
  privateKeys
}));
function mergePrivateKeyPaths(a, b) {
  return { ...a, privateKeys: { ...a.privateKeys, ...b.privateKeys } };
}
function updateLeafKey(path, newKey) {
  return { ...path, privateKeys: { ...path.privateKeys, [leafToNodeIndex(toLeafIndex(path.leafIndex))]: newKey } };
}
async function toPrivateKeyPath(pathSecrets, leafIndex, cs) {
  const asArray = await Promise.all(Object.entries(pathSecrets).map(async ([nodeIndex, pathSecret]) => {
    const nodeSecret = await deriveSecret(pathSecret, "node", cs.kdf);
    const { privateKey } = await cs.hpke.deriveKeyPair(nodeSecret);
    return [Number(nodeIndex), await cs.hpke.exportPrivateKey(privateKey)];
  }));
  const privateKeys = Object.fromEntries(asArray);
  return { leafIndex, privateKeys };
}

// node_modules/ts-mls/dist/src/unappliedProposals.js
var proposalWithSenderEncoder = contramapBufferEncoders([proposalEncoder, optionalEncoder(uint32Encoder)], (pws) => [pws.proposal, pws.senderLeafIndex]);
var decodeProposalWithSender = mapDecoders([decodeProposal, decodeOptional(decodeUint32)], (proposal, senderLeafIndex) => ({
  proposal,
  senderLeafIndex
}));
var unappliedProposalsEncoder = base64RecordEncoder(proposalWithSenderEncoder);
var decodeUnappliedProposals = decodeBase64Record(decodeProposalWithSender);
function addUnappliedProposal(ref, proposals, proposal, senderLeafIndex) {
  const r = bytesToBase64(ref);
  return {
    ...proposals,
    [r]: { proposal, senderLeafIndex }
  };
}

// node_modules/ts-mls/dist/src/pskIndex.js
var emptyPskIndex = {
  findPsk(_preSharedKeyId) {
    return void 0;
  }
};
async function accumulatePskSecret(groupedPsk, pskSearch, cs, zeroes) {
  return groupedPsk.reduce(async (acc, cur, index) => {
    const [previousSecret, ids] = await acc;
    const psk = pskSearch.findPsk(cur);
    if (psk === void 0)
      throw new ValidationError("Could not find pskId referenced in proposal");
    const pskSecret = await updatePskSecret(previousSecret, cur, psk, index, groupedPsk.length, cs);
    return [pskSecret, [...ids, cur]];
  }, Promise.resolve([zeroes, []]));
}

// node_modules/ts-mls/dist/src/util/addToMap.js
function addToMap(map, k, v) {
  const copy = new Map(map);
  copy.set(k, v);
  return copy;
}

// node_modules/ts-mls/dist/src/clientConfig.js
var defaultClientConfig = {
  keyRetentionConfig: defaultKeyRetentionConfig,
  lifetimeConfig: defaultLifetimeConfig,
  keyPackageEqualityConfig: defaultKeyPackageEqualityConfig,
  paddingConfig: defaultPaddingConfig,
  authService: defaultAuthenticationService
};

// node_modules/ts-mls/dist/src/util/array.js
function arraysEqual(a, b) {
  if (a.length !== b.length)
    return false;
  return a.every((val, index) => val === b[index]);
}

// node_modules/ts-mls/dist/src/codec/string.js
var stringEncoder = contramapBufferEncoder(varLenDataEncoder, (s) => new TextEncoder().encode(s));
var encodeString = encode(stringEncoder);
var decodeString = mapDecoder(decodeVarLenData, (u) => new TextDecoder().decode(u));

// node_modules/ts-mls/dist/src/groupActiveState.js
var activeEncoder = contramapBufferEncoder(stringEncoder, () => "active");
var suspendedPendingReinitEncoder = contramapBufferEncoders([stringEncoder, reinitEncoder], (s) => ["suspendedPendingReinit", s.reinit]);
var removedFromGroupEncoder = contramapBufferEncoder(stringEncoder, () => "removedFromGroup");
var groupActiveStateEncoder = (state) => {
  switch (state.kind) {
    case "active":
      return activeEncoder(state);
    case "suspendedPendingReinit":
      return suspendedPendingReinitEncoder(state);
    case "removedFromGroup":
      return removedFromGroupEncoder(state);
  }
};
var decodeGroupActiveState = flatMapDecoder(decodeString, (kind) => {
  switch (kind) {
    case "active":
      return succeedDecoder({ kind: "active" });
    case "suspendedPendingReinit":
      return mapDecoder(decodeReinit, (reinit) => ({ kind: "suspendedPendingReinit", reinit }));
    case "removedFromGroup":
      return succeedDecoder({ kind: "removedFromGroup" });
    default:
      return failDecoder();
  }
});

// node_modules/ts-mls/dist/src/epochReceiverData.js
var epochReceiverDataEncoder = contramapBufferEncoders([varLenDataEncoder, secretTreeEncoder, ratchetTreeEncoder, varLenDataEncoder, groupContextEncoder], (erd) => [erd.resumptionPsk, erd.secretTree, erd.ratchetTree, erd.senderDataSecret, erd.groupContext]);
var decodeEpochReceiverData = mapDecoders([decodeVarLenData, decodeSecretTree, decodeRatchetTree, decodeVarLenData, decodeGroupContext], (resumptionPsk, secretTree, ratchetTree, senderDataSecret, groupContext) => ({
  resumptionPsk,
  secretTree,
  ratchetTree,
  senderDataSecret,
  groupContext
}));

// node_modules/ts-mls/dist/src/clientState.js
var groupStateEncoder = contramapBufferEncoders([
  groupContextEncoder,
  keyScheduleEncoder,
  secretTreeEncoder,
  ratchetTreeEncoder,
  privateKeyPathEncoder,
  varLenDataEncoder,
  unappliedProposalsEncoder,
  varLenDataEncoder,
  bigintMapEncoder(epochReceiverDataEncoder),
  groupActiveStateEncoder
], (state) => [
  state.groupContext,
  state.keySchedule,
  state.secretTree,
  state.ratchetTree,
  state.privatePath,
  state.signaturePrivateKey,
  state.unappliedProposals,
  state.confirmationTag,
  state.historicalReceiverData,
  state.groupActiveState
]);
var encodeGroupState = encode(groupStateEncoder);
var decodeGroupState = mapDecoders([
  decodeGroupContext,
  decodeKeySchedule,
  decodeSecretTree,
  decodeRatchetTree,
  decodePrivateKeyPath,
  decodeVarLenData,
  decodeUnappliedProposals,
  decodeVarLenData,
  decodeBigintMap(decodeEpochReceiverData),
  decodeGroupActiveState
], (groupContext, keySchedule, secretTree, ratchetTree, privatePath, signaturePrivateKey, unappliedProposals, confirmationTag, historicalReceiverData, groupActiveState) => ({
  groupContext,
  keySchedule,
  secretTree,
  ratchetTree,
  privatePath,
  signaturePrivateKey,
  unappliedProposals,
  confirmationTag,
  historicalReceiverData,
  groupActiveState
}));
var groupStateEncoderWithoutTree = contramapBufferEncoders([
  groupContextEncoder,
  keyScheduleEncoder,
  secretTreeEncoder,
  privateKeyPathEncoder,
  varLenDataEncoder,
  unappliedProposalsEncoder,
  varLenDataEncoder,
  bigintMapEncoder(epochReceiverDataEncoder),
  groupActiveStateEncoder
], (state) => [
  state.groupContext,
  state.keySchedule,
  state.secretTree,
  state.privatePath,
  state.signaturePrivateKey,
  state.unappliedProposals,
  state.confirmationTag,
  state.historicalReceiverData,
  state.groupActiveState
]);
var encodeGroupStateWithoutTree = encode(groupStateEncoderWithoutTree);
function decodeGroupStateWithoutTree(ratchetTree) {
  return mapDecoders([
    decodeGroupContext,
    decodeKeySchedule,
    decodeSecretTree,
    decodePrivateKeyPath,
    decodeVarLenData,
    decodeUnappliedProposals,
    decodeVarLenData,
    decodeBigintMap(decodeEpochReceiverData),
    decodeGroupActiveState
  ], (groupContext, keySchedule, secretTree, privatePath, signaturePrivateKey, unappliedProposals, confirmationTag, historicalReceiverData, groupActiveState) => ({
    groupContext,
    keySchedule,
    secretTree,
    ratchetTree,
    privatePath,
    signaturePrivateKey,
    unappliedProposals,
    confirmationTag,
    historicalReceiverData,
    groupActiveState
  }));
}
function getOwnLeafNode(state) {
  const idx = leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex));
  const leaf = state.ratchetTree[idx];
  if (leaf?.nodeType !== "leaf")
    throw new InternalError("Expected leaf node");
  return leaf.leaf;
}
function getGroupMembers(state) {
  return extractFromGroupMembers(state, () => false, (l) => l);
}
function extractFromGroupMembers(state, exclude, map) {
  const recipients = [];
  for (const node of state.ratchetTree) {
    if (node?.nodeType === "leaf" && !exclude(node.leaf)) {
      recipients.push(map(node.leaf));
    }
  }
  return recipients;
}
function checkCanSendApplicationMessages(state) {
  if (Object.keys(state.unappliedProposals).length !== 0)
    throw new UsageError("Cannot send application message with unapplied proposals");
  checkCanSendHandshakeMessages(state);
}
function checkCanSendHandshakeMessages(state) {
  if (state.groupActiveState.kind === "suspendedPendingReinit")
    throw new UsageError("Cannot send messages while Group is suspended pending reinit");
  else if (state.groupActiveState.kind === "removedFromGroup")
    throw new UsageError("Cannot send messages after being removed from group");
}
var emptyProposals = {
  add: [],
  update: [],
  remove: [],
  psk: [],
  reinit: [],
  external_init: [],
  group_context_extensions: []
};
function flattenExtensions(groupContextExtensions) {
  return groupContextExtensions.reduce((acc, { proposal }) => {
    return [...acc, ...proposal.groupContextExtensions.extensions];
  }, []);
}
async function validateProposals(p, committerLeafIndex, groupContext, config, authService, tree) {
  const containsUpdateByCommitter = p.update.some((o) => o.senderLeafIndex !== void 0 && o.senderLeafIndex === committerLeafIndex);
  if (containsUpdateByCommitter)
    return new ValidationError("Commit cannot contain an update proposal sent by committer");
  const containsRemoveOfCommitter = p.remove.some((o) => o.proposal.remove.removed === committerLeafIndex);
  if (containsRemoveOfCommitter)
    return new ValidationError("Commit cannot contain a remove proposal removing committer");
  const multipleUpdateRemoveForSameLeaf = p.update.some(({ senderLeafIndex: a }, indexA) => p.update.some(({ senderLeafIndex: b }, indexB) => a === b && indexA !== indexB) || p.remove.some((r) => r.proposal.remove.removed === a)) || p.remove.some((a, indexA) => p.remove.some((b, indexB) => b.proposal.remove.removed === a.proposal.remove.removed && indexA !== indexB) || p.update.some(({ senderLeafIndex }) => a.proposal.remove.removed === senderLeafIndex));
  if (multipleUpdateRemoveForSameLeaf)
    return new ValidationError("Commit cannot contain multiple update and/or remove proposals that apply to the same leaf");
  const multipleAddsContainSameKeypackage = p.add.some(({ proposal: a }, indexA) => p.add.some(({ proposal: b }, indexB) => config.compareKeyPackages(a.add.keyPackage, b.add.keyPackage) && indexA !== indexB));
  if (multipleAddsContainSameKeypackage)
    return new ValidationError("Commit cannot contain multiple Add proposals that contain KeyPackages that represent the same client");
  const addsContainExistingKeypackage = p.add.some(({ proposal }) => tree.some((node, nodeIndex) => node !== void 0 && node.nodeType === "leaf" && config.compareKeyPackageToLeafNode(proposal.add.keyPackage, node.leaf) && p.remove.every((r) => r.proposal.remove.removed !== nodeToLeafIndex(toNodeIndex(nodeIndex)))));
  if (addsContainExistingKeypackage)
    return new ValidationError("Commit cannot contain an Add proposal for someone already in the group");
  const everyLeafSupportsGroupExtensions = p.add.every(({ proposal }) => extensionsSupportedByCapabilities(groupContext.extensions, proposal.add.keyPackage.leafNode.capabilities));
  if (!everyLeafSupportsGroupExtensions)
    return new ValidationError("Added leaf node that doesn't support extension in GroupContext");
  const multiplePskWithSamePskId = p.psk.some((a, indexA) => p.psk.some((b, indexB) => constantTimeEqual(encode(pskIdEncoder)(a.proposal.psk.preSharedKeyId), encode(pskIdEncoder)(b.proposal.psk.preSharedKeyId)) && indexA !== indexB));
  if (multiplePskWithSamePskId)
    return new ValidationError("Commit cannot contain PreSharedKey proposals that reference the same PreSharedKeyID");
  const multipleGroupContextExtensions = p.group_context_extensions.length > 1;
  if (multipleGroupContextExtensions)
    return new ValidationError("Commit cannot contain multiple GroupContextExtensions proposals");
  const allExtensions = flattenExtensions(p.group_context_extensions);
  const requiredCapabilities = allExtensions.find((e) => e.extensionType === "required_capabilities");
  if (requiredCapabilities !== void 0) {
    const caps = decodeRequiredCapabilities(requiredCapabilities.extensionData, 0);
    if (caps === void 0)
      return new CodecError("Could not decode required_capabilities");
    const everyLeafSupportsCapabilities = tree.filter((n) => n !== void 0 && n.nodeType === "leaf").every((l) => capabiltiesAreSupported(caps[0], l.leaf.capabilities));
    if (!everyLeafSupportsCapabilities)
      return new ValidationError("Not all members support required capabilities");
    const allAdditionsSupportCapabilities = p.add.every((a) => capabiltiesAreSupported(caps[0], a.proposal.add.keyPackage.leafNode.capabilities));
    if (!allAdditionsSupportCapabilities)
      return new ValidationError("Commit contains add proposals of member without required capabilities");
  }
  return await validateExternalSenders(allExtensions, authService);
}
async function validateExternalSenders(extensions, authService) {
  const externalSenders = extensions.filter((e) => e.extensionType === "external_senders");
  for (const externalSender of externalSenders) {
    const decoded = decodeExternalSender(externalSender.extensionData, 0);
    if (decoded === void 0)
      return new CodecError("Could not decode external_senders");
    const validCredential = await authService.validateCredential(decoded[0].credential, decoded[0].signaturePublicKey);
    if (!validCredential)
      return new ValidationError("Could not validate external credential");
  }
}
function capabiltiesAreSupported(caps, cs) {
  return caps.credentialTypes.every((c) => cs.credentials.includes(c)) && caps.extensionTypes.every((e) => cs.extensions.includes(e)) && caps.proposalTypes.every((p) => cs.proposals.includes(p));
}
async function validateRatchetTree(tree, groupContext, config, authService, treeHash2, cs) {
  const hpkeKeys = /* @__PURE__ */ new Set();
  const signatureKeys = /* @__PURE__ */ new Set();
  const credentialTypes2 = /* @__PURE__ */ new Set();
  for (const [i, n] of tree.entries()) {
    const nodeIndex = toNodeIndex(i);
    if (n?.nodeType === "leaf") {
      if (!isLeaf(nodeIndex))
        return new ValidationError("Received Ratchet Tree is not structurally sound");
      const hpkeKey = bytesToBase64(n.leaf.hpkePublicKey);
      if (hpkeKeys.has(hpkeKey))
        return new ValidationError("hpke keys not unique");
      else
        hpkeKeys.add(hpkeKey);
      const signatureKey = bytesToBase64(n.leaf.signaturePublicKey);
      if (signatureKeys.has(signatureKey))
        return new ValidationError("signature keys not unique");
      else
        signatureKeys.add(signatureKey);
      credentialTypes2.add(n.leaf.credential.credentialType);
      const err = n.leaf.leafNodeSource === "key_package" ? await validateLeafNodeKeyPackage(n.leaf, groupContext, false, config, authService, cs.signature) : await validateLeafNodeUpdateOrCommit(n.leaf, nodeToLeafIndex(nodeIndex), groupContext, authService, cs.signature);
      if (err !== void 0)
        return err;
    } else if (n?.nodeType === "parent") {
      if (isLeaf(nodeIndex))
        return new ValidationError("Received Ratchet Tree is not structurally sound");
      const hpkeKey = bytesToBase64(n.parent.hpkePublicKey);
      if (hpkeKeys.has(hpkeKey))
        return new ValidationError("hpke keys not unique");
      else
        hpkeKeys.add(hpkeKey);
      for (const unmergedLeaf of n.parent.unmergedLeaves) {
        const leafIndex = toLeafIndex(unmergedLeaf);
        const dp = directPath(leafToNodeIndex(leafIndex), leafWidth(tree.length));
        const nodeIndex2 = leafToNodeIndex(leafIndex);
        if (tree[nodeIndex2]?.nodeType !== "leaf" && !dp.includes(toNodeIndex(i)))
          return new ValidationError("Unmerged leaf did not represent a non-blank descendant leaf node");
        for (const parentIdx of dp) {
          const dpNode = tree[parentIdx];
          if (dpNode !== void 0) {
            if (dpNode.nodeType !== "parent")
              return new InternalError("Expected parent node");
            if (!arraysEqual(dpNode.parent.unmergedLeaves, n.parent.unmergedLeaves))
              return new ValidationError("non-blank intermediate node must list leaf node in its unmerged_leaves");
          }
        }
      }
    }
  }
  for (const n of tree) {
    if (n?.nodeType === "leaf") {
      for (const credentialType of credentialTypes2) {
        if (!n.leaf.capabilities.credentials.includes(credentialType))
          return new ValidationError("LeafNode has credential that is not supported by member of the group");
      }
    }
  }
  const parentHashesVerified = await verifyParentHashes(tree, cs.hash);
  if (!parentHashesVerified)
    return new CryptoVerificationError("Unable to verify parent hash");
  if (!constantTimeEqual(treeHash2, await treeHashRoot(tree, cs.hash)))
    return new ValidationError("Unable to verify tree hash");
}
async function validateLeafNodeUpdateOrCommit(leafNode, leafIndex, groupContext, authService, s) {
  const signatureValid = await verifyLeafNodeSignature(leafNode, groupContext.groupId, leafIndex, s);
  if (!signatureValid)
    return new CryptoVerificationError("Could not verify leaf node signature");
  const commonError = await validateLeafNodeCommon(leafNode, groupContext, authService);
  if (commonError !== void 0)
    return commonError;
}
function throwIfDefined(err) {
  if (err !== void 0)
    throw err;
}
async function validateLeafNodeCommon(leafNode, groupContext, authService) {
  const credentialValid = await authService.validateCredential(leafNode.credential, leafNode.signaturePublicKey);
  if (!credentialValid)
    return new ValidationError("Could not validate credential");
  const requiredCapabilities = groupContext.extensions.find((e) => e.extensionType === "required_capabilities");
  if (requiredCapabilities !== void 0) {
    const caps = decodeRequiredCapabilities(requiredCapabilities.extensionData, 0);
    if (caps === void 0)
      return new CodecError("Could not decode required_capabilities");
    const leafSupportsCapabilities = capabiltiesAreSupported(caps[0], leafNode.capabilities);
    if (!leafSupportsCapabilities)
      return new ValidationError("LeafNode does not support required capabilities");
  }
  const extensionsSupported = extensionsSupportedByCapabilities(leafNode.extensions, leafNode.capabilities);
  if (!extensionsSupported)
    return new ValidationError("LeafNode contains extension not listed in capabilities");
}
async function validateLeafNodeKeyPackage(leafNode, groupContext, sentByClient, config, authService, s) {
  const signatureValid = await verifyLeafNodeSignatureKeyPackage(leafNode, s);
  if (!signatureValid)
    return new CryptoVerificationError("Could not verify leaf node signature");
  if (sentByClient || config.validateLifetimeOnReceive) {
    if (leafNode.leafNodeSource === "key_package") {
      const currentTime = BigInt(Math.floor(Date.now() / 1e3));
      if (leafNode.lifetime.notBefore > currentTime || leafNode.lifetime.notAfter < currentTime)
        return new ValidationError("Current time not within Lifetime");
    }
  }
  const commonError = await validateLeafNodeCommon(leafNode, groupContext, authService);
  if (commonError !== void 0)
    return commonError;
}
async function validateLeafNodeCredentialAndKeyUniqueness(tree, leafNode, existingLeafIndex) {
  const hpkeKeys = /* @__PURE__ */ new Set();
  const signatureKeys = /* @__PURE__ */ new Set();
  for (const [nodeIndex, node] of tree.entries()) {
    if (node?.nodeType === "leaf") {
      if (!node.leaf.capabilities.credentials.includes(leafNode.credential.credentialType)) {
        return new ValidationError("LeafNode has credential that is not supported by member of the group");
      }
      const hpkeKey = bytesToBase64(node.leaf.hpkePublicKey);
      if (hpkeKeys.has(hpkeKey))
        return new ValidationError("hpke keys not unique");
      else
        hpkeKeys.add(hpkeKey);
      const signatureKey = bytesToBase64(node.leaf.signaturePublicKey);
      if (signatureKeys.has(signatureKey) && existingLeafIndex !== nodeToLeafIndex(toNodeIndex(nodeIndex)))
        return new ValidationError("signature keys not unique");
      else
        signatureKeys.add(signatureKey);
    } else if (node?.nodeType === "parent") {
      const hpkeKey = bytesToBase64(node.parent.hpkePublicKey);
      if (hpkeKeys.has(hpkeKey))
        return new ValidationError("hpke keys not unique");
      else
        hpkeKeys.add(hpkeKey);
    }
  }
}
async function validateKeyPackage(kp, groupContext, tree, sentByClient, config, authService, s) {
  if (kp.cipherSuite !== groupContext.cipherSuite)
    return new ValidationError("Invalid CipherSuite");
  if (kp.version !== groupContext.version)
    return new ValidationError("Invalid mls version");
  const leafNodeConsistentWithTree = await validateLeafNodeCredentialAndKeyUniqueness(tree, kp.leafNode);
  if (leafNodeConsistentWithTree !== void 0)
    return leafNodeConsistentWithTree;
  const leafNodeError = await validateLeafNodeKeyPackage(kp.leafNode, groupContext, sentByClient, config, authService, s);
  if (leafNodeError !== void 0)
    return leafNodeError;
  const signatureValid = await verifyKeyPackage(kp, s);
  if (!signatureValid)
    return new CryptoVerificationError("Invalid keypackage signature");
  if (constantTimeEqual(kp.initKey, kp.leafNode.hpkePublicKey))
    return new ValidationError("Cannot have identicial init and encryption keys");
}
function validateReinit(allProposals, reinit, gc) {
  if (allProposals.length !== 1)
    return new ValidationError("Reinit proposal needs to be commited by itself");
  if (protocolVersions[reinit.version] < protocolVersions[gc.version])
    return new ValidationError("A ReInit proposal cannot use a version less than the version for the current group");
}
function validateExternalInit(grouped) {
  if (grouped.external_init.length > 1)
    return new ValidationError("Cannot contain more than one external_init proposal");
  if (grouped.remove.length > 1)
    return new ValidationError("Cannot contain more than one remove proposal");
  if (grouped.add.length > 0 || grouped.group_context_extensions.length > 0 || grouped.reinit.length > 0 || grouped.update.length > 0)
    return new ValidationError("Invalid proposals");
}
function validateRemove(remove, tree) {
  if (tree[leafToNodeIndex(toLeafIndex(remove.removed))] === void 0)
    return new ValidationError("Tried to remove empty leaf node");
}
async function applyProposals(state, proposals, committerLeafIndex, pskSearch, sentByClient, cs) {
  const allProposals = proposals.reduce((acc, cur) => {
    if (cur.proposalOrRefType === "proposal")
      return [...acc, { proposal: cur.proposal, senderLeafIndex: committerLeafIndex }];
    const p = state.unappliedProposals[bytesToBase64(cur.reference)];
    if (p === void 0)
      throw new ValidationError("Could not find proposal with supplied reference");
    return [...acc, p];
  }, []);
  const grouped = allProposals.reduce((acc, cur) => {
    if (typeof cur.proposal.proposalType === "number")
      return acc;
    const proposal = acc[cur.proposal.proposalType] ?? [];
    return { ...acc, [cur.proposal.proposalType]: [...proposal, cur] };
  }, emptyProposals);
  const zeroes = new Uint8Array(cs.kdf.size);
  const isExternalInit = grouped.external_init.length > 0;
  if (!isExternalInit) {
    if (grouped.reinit.length > 0) {
      const reinit = grouped.reinit.at(0).proposal.reinit;
      throwIfDefined(validateReinit(allProposals, reinit, state.groupContext));
      return {
        tree: state.ratchetTree,
        pskSecret: zeroes,
        pskIds: [],
        needsUpdatePath: false,
        additionalResult: {
          kind: "reinit",
          reinit
        },
        selfRemoved: false,
        allProposals
      };
    }
    throwIfDefined(await validateProposals(grouped, committerLeafIndex, state.groupContext, state.clientConfig.keyPackageEqualityConfig, state.clientConfig.authService, state.ratchetTree));
    const newExtensions = flattenExtensions(grouped.group_context_extensions);
    const [mutatedTree, addedLeafNodes] = await applyTreeMutations(state.ratchetTree, grouped, state.groupContext, sentByClient, state.clientConfig.authService, state.clientConfig.lifetimeConfig, cs.signature);
    const [updatedPskSecret, pskIds] = await accumulatePskSecret(grouped.psk.map((p) => p.proposal.psk.preSharedKeyId), pskSearch, cs, zeroes);
    const selfRemoved = mutatedTree[leafToNodeIndex(toLeafIndex(state.privatePath.leafIndex))] === void 0;
    const needsUpdatePath = allProposals.length === 0 || Object.values(grouped.update).length > 0 || Object.values(grouped.remove).length > 0;
    return {
      tree: mutatedTree,
      pskSecret: updatedPskSecret,
      additionalResult: {
        kind: "memberCommit",
        addedLeafNodes,
        extensions: newExtensions
      },
      pskIds,
      needsUpdatePath,
      selfRemoved,
      allProposals
    };
  } else {
    throwIfDefined(validateExternalInit(grouped));
    const treeAfterRemove = grouped.remove.reduce((acc, { proposal }) => {
      return removeLeafNode(acc, toLeafIndex(proposal.remove.removed));
    }, state.ratchetTree);
    const zeroes2 = new Uint8Array(cs.kdf.size);
    const [updatedPskSecret, pskIds] = await accumulatePskSecret(grouped.psk.map((p) => p.proposal.psk.preSharedKeyId), pskSearch, cs, zeroes2);
    const initProposal = grouped.external_init.at(0);
    const externalKeyPair = await cs.hpke.deriveKeyPair(state.keySchedule.externalSecret);
    const externalInitSecret = await importSecret(await cs.hpke.exportPrivateKey(externalKeyPair.privateKey), initProposal.proposal.externalInit.kemOutput, cs);
    return {
      needsUpdatePath: true,
      tree: treeAfterRemove,
      pskSecret: updatedPskSecret,
      pskIds,
      additionalResult: {
        kind: "externalCommit",
        externalInitSecret,
        newMemberLeafIndex: nodeToLeafIndex(findBlankLeafNodeIndexOrExtend(treeAfterRemove))
      },
      selfRemoved: false,
      allProposals
    };
  }
}
function makePskIndex(state, externalPsks) {
  return {
    findPsk(preSharedKeyId) {
      if (preSharedKeyId.psktype === "external") {
        return externalPsks[bytesToBase64(preSharedKeyId.pskId)];
      }
      if (state !== void 0 && constantTimeEqual(preSharedKeyId.pskGroupId, state.groupContext.groupId)) {
        if (preSharedKeyId.pskEpoch === state.groupContext.epoch)
          return state.keySchedule.resumptionPsk;
        else
          return state.historicalReceiverData.get(preSharedKeyId.pskEpoch)?.resumptionPsk;
      }
    }
  };
}
async function nextEpochContext(groupContext, wireformat, content, signature, updatedTreeHash, confirmationTag, h) {
  const interimTranscriptHash = await createInterimHash(groupContext.confirmedTranscriptHash, confirmationTag, h);
  const newConfirmedHash = await createConfirmedHash(interimTranscriptHash, { wireformat, content, signature }, h);
  return {
    ...groupContext,
    epoch: groupContext.epoch + 1n,
    treeHash: updatedTreeHash,
    confirmedTranscriptHash: newConfirmedHash
  };
}
async function joinGroup(welcome, keyPackage, privateKeys, pskSearch, cs, ratchetTree, resumingFromState, clientConfig = defaultClientConfig) {
  const res = await joinGroupWithExtensions(welcome, keyPackage, privateKeys, pskSearch, cs, ratchetTree, resumingFromState, clientConfig);
  return res[0];
}
async function joinGroupWithExtensions(welcome, keyPackage, privateKeys, pskSearch, cs, ratchetTree, resumingFromState, clientConfig = defaultClientConfig) {
  const keyPackageRef = await makeKeyPackageRef(keyPackage, cs.hash);
  const privKey = await cs.hpke.importPrivateKey(privateKeys.initPrivateKey);
  const groupSecrets = await decryptGroupSecrets(privKey, keyPackageRef, welcome, cs.hpke);
  if (groupSecrets === void 0)
    throw new CodecError("Could not decode group secrets");
  const zeroes = new Uint8Array(cs.kdf.size);
  const [pskSecret, pskIds] = await accumulatePskSecret(groupSecrets.psks, pskSearch, cs, zeroes);
  const gi = await decryptGroupInfo(welcome, groupSecrets.joinerSecret, pskSecret, cs);
  if (gi === void 0)
    throw new CodecError("Could not decode group info");
  const resumptionPsk = pskIds.find((id) => id.psktype === "resumption");
  if (resumptionPsk !== void 0) {
    if (resumingFromState === void 0)
      throw new ValidationError("No prior state passed for resumption");
    if (resumptionPsk.pskEpoch !== resumingFromState.groupContext.epoch)
      throw new ValidationError("Epoch mismatch");
    if (!constantTimeEqual(resumptionPsk.pskGroupId, resumingFromState.groupContext.groupId))
      throw new ValidationError("old groupId mismatch");
    if (gi.groupContext.epoch !== 1n)
      throw new ValidationError("Resumption must be started at epoch 1");
    if (resumptionPsk.usage === "reinit") {
      if (resumingFromState.groupActiveState.kind !== "suspendedPendingReinit")
        throw new ValidationError("Found reinit psk but no old suspended clientState");
      if (!constantTimeEqual(resumingFromState.groupActiveState.reinit.groupId, gi.groupContext.groupId))
        throw new ValidationError("new groupId mismatch");
      if (resumingFromState.groupActiveState.reinit.version !== gi.groupContext.version)
        throw new ValidationError("Version mismatch");
      if (resumingFromState.groupActiveState.reinit.cipherSuite !== gi.groupContext.cipherSuite)
        throw new ValidationError("Ciphersuite mismatch");
      if (!extensionsEqual(resumingFromState.groupActiveState.reinit.extensions, gi.groupContext.extensions))
        throw new ValidationError("Extensions mismatch");
    }
  }
  const allExtensionsSupported = extensionsSupportedByCapabilities(gi.groupContext.extensions, keyPackage.leafNode.capabilities);
  if (!allExtensionsSupported)
    throw new UsageError("client does not support every extension in the GroupContext");
  const tree = ratchetTreeFromExtension(gi) ?? ratchetTree;
  if (tree === void 0)
    throw new UsageError("No RatchetTree passed and no ratchet_tree extension");
  const signerNode = tree[leafToNodeIndex(toLeafIndex(gi.signer))];
  if (signerNode === void 0) {
    throw new ValidationError("Could not find signer leafNode");
  }
  if (signerNode.nodeType === "parent")
    throw new ValidationError("Expected non blank leaf node");
  const credentialVerified = await clientConfig.authService.validateCredential(signerNode.leaf.credential, signerNode.leaf.signaturePublicKey);
  if (!credentialVerified)
    throw new ValidationError("Could not validate credential");
  const groupInfoSignatureVerified = await verifyGroupInfoSignature(gi, signerNode.leaf.signaturePublicKey, cs.signature);
  if (!groupInfoSignatureVerified)
    throw new CryptoVerificationError("Could not verify groupInfo signature");
  if (gi.groupContext.cipherSuite !== keyPackage.cipherSuite)
    throw new ValidationError("cipher suite in the GroupInfo does not match the cipher_suite in the KeyPackage");
  throwIfDefined(await validateRatchetTree(tree, gi.groupContext, clientConfig.lifetimeConfig, clientConfig.authService, gi.groupContext.treeHash, cs));
  const newLeaf = findLeafIndex(tree, keyPackage.leafNode);
  if (newLeaf === void 0)
    throw new ValidationError("Could not find own leaf when processing welcome");
  const privateKeyPath = {
    leafIndex: newLeaf,
    privateKeys: { [leafToNodeIndex(newLeaf)]: privateKeys.hpkePrivateKey }
  };
  const ancestorNodeIndex = firstCommonAncestor(tree, newLeaf, toLeafIndex(gi.signer));
  const updatedPkp = groupSecrets.pathSecret === void 0 ? privateKeyPath : mergePrivateKeyPaths(await toPrivateKeyPath(await pathToRoot(tree, ancestorNodeIndex, groupSecrets.pathSecret, cs.kdf), newLeaf, cs), privateKeyPath);
  const [keySchedule, encryptionSecret] = await deriveKeySchedule(groupSecrets.joinerSecret, pskSecret, gi.groupContext, cs.kdf);
  const confirmationTagVerified = await verifyGroupInfoConfirmationTag(gi, groupSecrets.joinerSecret, pskSecret, cs);
  if (!confirmationTagVerified)
    throw new CryptoVerificationError("Could not verify confirmation tag");
  const secretTree = await createSecretTree(leafWidth(tree.length), encryptionSecret, cs.kdf);
  zeroOutUint8Array(encryptionSecret);
  zeroOutUint8Array(groupSecrets.joinerSecret);
  return [
    {
      groupContext: gi.groupContext,
      ratchetTree: tree,
      privatePath: updatedPkp,
      signaturePrivateKey: privateKeys.signaturePrivateKey,
      confirmationTag: gi.confirmationTag,
      unappliedProposals: {},
      keySchedule,
      secretTree,
      historicalReceiverData: /* @__PURE__ */ new Map(),
      groupActiveState: { kind: "active" },
      clientConfig
    },
    gi.extensions
  ];
}
async function createGroup(groupId, keyPackage, privateKeyPackage, extensions, cs, clientConfig = defaultClientConfig) {
  const ratchetTree = [{ nodeType: "leaf", leaf: keyPackage.leafNode }];
  const privatePath = {
    leafIndex: 0,
    privateKeys: { [0]: privateKeyPackage.hpkePrivateKey }
  };
  const confirmedTranscriptHash = new Uint8Array();
  const groupContext = {
    version: "mls10",
    cipherSuite: cs.name,
    epoch: 0n,
    treeHash: await treeHashRoot(ratchetTree, cs.hash),
    groupId,
    extensions,
    confirmedTranscriptHash
  };
  throwIfDefined(await validateExternalSenders(extensions, clientConfig.authService));
  const epochSecret = cs.rng.randomBytes(cs.kdf.size);
  const keySchedule = await initializeKeySchedule(epochSecret, cs.kdf);
  const confirmationTag = await createConfirmationTag(keySchedule.confirmationKey, confirmedTranscriptHash, cs.hash);
  const encryptionSecret = await deriveSecret(epochSecret, "encryption", cs.kdf);
  const secretTree = await createSecretTree(1, encryptionSecret, cs.kdf);
  zeroOutUint8Array(epochSecret);
  return {
    ratchetTree,
    keySchedule,
    secretTree,
    privatePath,
    signaturePrivateKey: privateKeyPackage.signaturePrivateKey,
    unappliedProposals: {},
    historicalReceiverData: /* @__PURE__ */ new Map(),
    groupContext,
    confirmationTag,
    groupActiveState: { kind: "active" },
    clientConfig
  };
}
async function exportSecret(publicKey, cs) {
  return cs.hpke.exportSecret(await cs.hpke.importPublicKey(publicKey), new TextEncoder().encode("MLS 1.0 external init secret"), cs.kdf.size, new Uint8Array());
}
async function importSecret(privateKey, kemOutput, cs) {
  return cs.hpke.importSecret(await cs.hpke.importPrivateKey(privateKey), new TextEncoder().encode("MLS 1.0 external init secret"), kemOutput, cs.kdf.size, new Uint8Array());
}
async function applyTreeMutations(ratchetTree, grouped, gc, sentByClient, authService, lifetimeConfig, s) {
  const treeAfterUpdate = await grouped.update.reduce(async (acc, { senderLeafIndex, proposal }) => {
    if (senderLeafIndex === void 0)
      throw new InternalError("No sender index found for update proposal");
    throwIfDefined(await validateLeafNodeUpdateOrCommit(proposal.update.leafNode, senderLeafIndex, gc, authService, s));
    throwIfDefined(await validateLeafNodeCredentialAndKeyUniqueness(ratchetTree, proposal.update.leafNode, senderLeafIndex));
    return updateLeafNode(await acc, proposal.update.leafNode, toLeafIndex(senderLeafIndex));
  }, Promise.resolve(ratchetTree));
  const treeAfterRemove = grouped.remove.reduce((acc, { proposal }) => {
    throwIfDefined(validateRemove(proposal.remove, ratchetTree));
    return removeLeafNode(acc, toLeafIndex(proposal.remove.removed));
  }, treeAfterUpdate);
  const [treeAfterAdd, addedLeafNodes] = await grouped.add.reduce(async (acc, { proposal }) => {
    throwIfDefined(await validateKeyPackage(proposal.add.keyPackage, gc, ratchetTree, sentByClient, lifetimeConfig, authService, s));
    const [tree, ws] = await acc;
    const [updatedTree, leafNodeIndex] = addLeafNode(tree, proposal.add.keyPackage.leafNode);
    return [
      updatedTree,
      [...ws, [nodeToLeafIndex(leafNodeIndex), proposal.add.keyPackage]]
    ];
  }, Promise.resolve([treeAfterRemove, []]));
  return [treeAfterAdd, addedLeafNodes];
}
async function processProposal(state, content, proposal, h) {
  const ref = await makeProposalRef(content, h);
  return {
    ...state,
    unappliedProposals: addUnappliedProposal(ref, state.unappliedProposals, proposal, getSenderLeafNodeIndex(content.content.sender))
  };
}
function addHistoricalReceiverData(state) {
  const withNew = addToMap(state.historicalReceiverData, state.groupContext.epoch, {
    secretTree: state.secretTree,
    ratchetTree: state.ratchetTree,
    senderDataSecret: state.keySchedule.senderDataSecret,
    groupContext: state.groupContext,
    resumptionPsk: state.keySchedule.resumptionPsk
  });
  const epochs = [...withNew.keys()];
  const result = epochs.length >= state.clientConfig.keyRetentionConfig.retainKeysForEpochs ? removeOldHistoricalReceiverData(withNew, state.clientConfig.keyRetentionConfig.retainKeysForEpochs) : [withNew, []];
  return result;
}
function removeOldHistoricalReceiverData(historicalReceiverData, max) {
  const sortedEpochs = [...historicalReceiverData.keys()].sort((a, b) => a < b ? -1 : 1);
  const cutoff = sortedEpochs.length - max;
  const toBeDeleted = new Array();
  const map = /* @__PURE__ */ new Map();
  for (const [n, epoch] of sortedEpochs.entries()) {
    const data = historicalReceiverData.get(epoch);
    if (n < cutoff) {
      toBeDeleted.push(...allSecretTreeValues(data.secretTree));
    } else {
      map.set(epoch, data);
    }
  }
  return [new Map(sortedEpochs.slice(-max).map((epoch) => [epoch, historicalReceiverData.get(epoch)])), []];
}

// node_modules/ts-mls/dist/src/messageProtection.js
var messageProtection_exports = {};
__export(messageProtection_exports, {
  protect: () => protect,
  protectApplicationData: () => protectApplicationData,
  protectProposal: () => protectProposal,
  unprotectPrivateMessage: () => unprotectPrivateMessage,
  validateSenderData: () => validateSenderData
});

// node_modules/ts-mls/dist/src/privateMessage.js
var privateMessageEncoder = contramapBufferEncoders([varLenDataEncoder, uint64Encoder, contentTypeEncoder, varLenDataEncoder, varLenDataEncoder, varLenDataEncoder], (msg) => [msg.groupId, msg.epoch, msg.contentType, msg.authenticatedData, msg.encryptedSenderData, msg.ciphertext]);
var encodePrivateMessage = encode(privateMessageEncoder);
var decodePrivateMessage = mapDecoders([decodeVarLenData, decodeUint64, decodeContentType, decodeVarLenData, decodeVarLenData, decodeVarLenData], (groupId, epoch, contentType, authenticatedData, encryptedSenderData, ciphertext) => ({
  groupId,
  epoch,
  contentType,
  authenticatedData,
  encryptedSenderData,
  ciphertext
}));
var privateContentAADEncoder = contramapBufferEncoders([varLenDataEncoder, uint64Encoder, contentTypeEncoder, varLenDataEncoder], (aad) => [aad.groupId, aad.epoch, aad.contentType, aad.authenticatedData]);
var encodePrivateContentAAD = encode(privateContentAADEncoder);
var decodePrivateContentAAD = mapDecoders([decodeVarLenData, decodeUint64, decodeContentType, decodeVarLenData], (groupId, epoch, contentType, authenticatedData) => ({
  groupId,
  epoch,
  contentType,
  authenticatedData
}));
function decodePrivateMessageContent(contentType) {
  switch (contentType) {
    case "application":
      return decoderWithPadding(mapDecoders([decodeVarLenData, decodeVarLenData], (applicationData, signature) => ({
        contentType,
        applicationData,
        auth: { contentType, signature }
      })));
    case "proposal":
      return decoderWithPadding(mapDecoders([decodeProposal, decodeVarLenData], (proposal, signature) => ({
        contentType,
        proposal,
        auth: { contentType, signature }
      })));
    case "commit":
      return decoderWithPadding(mapDecoders([decodeCommit, decodeVarLenData, decodeFramedContentAuthDataCommit], (commit, signature, auth) => ({
        contentType,
        commit,
        auth: { ...auth, signature, contentType }
      })));
  }
}
function privateMessageContentEncoder(config) {
  return (msg) => {
    switch (msg.contentType) {
      case "application":
        return encoderWithPadding(contramapBufferEncoders([varLenDataEncoder, framedContentAuthDataEncoder], (m) => [m.applicationData, m.auth]), config)(msg);
      case "proposal":
        return encoderWithPadding(contramapBufferEncoders([proposalEncoder, framedContentAuthDataEncoder], (m) => [m.proposal, m.auth]), config)(msg);
      case "commit":
        return encoderWithPadding(contramapBufferEncoders([commitEncoder, framedContentAuthDataEncoder], (m) => [m.commit, m.auth]), config)(msg);
    }
  };
}
function encodePrivateMessageContent(config) {
  return encode(privateMessageContentEncoder(config));
}
async function decryptSenderData(msg, senderDataSecret, cs) {
  const key = await expandSenderDataKey(cs, senderDataSecret, msg.ciphertext);
  const nonce = await expandSenderDataNonce(cs, senderDataSecret, msg.ciphertext);
  const aad = {
    groupId: msg.groupId,
    epoch: msg.epoch,
    contentType: msg.contentType
  };
  const decrypted = await cs.hpke.decryptAead(key, nonce, encode(senderDataAADEncoder)(aad), msg.encryptedSenderData);
  return decodeSenderData(decrypted, 0)?.[0];
}
async function encryptSenderData(senderDataSecret, senderData, aad, ciphertext, cs) {
  const key = await expandSenderDataKey(cs, senderDataSecret, ciphertext);
  const nonce = await expandSenderDataNonce(cs, senderDataSecret, ciphertext);
  return await cs.hpke.encryptAead(key, nonce, encode(senderDataAADEncoder)(aad), encode(senderDataEncoder)(senderData));
}
function toAuthenticatedContent(content, msg, senderLeafIndex) {
  return {
    wireformat: "mls_private_message",
    content: {
      groupId: msg.groupId,
      epoch: msg.epoch,
      sender: {
        senderType: "member",
        leafIndex: senderLeafIndex
      },
      authenticatedData: msg.authenticatedData,
      ...content
    },
    auth: content.auth
  };
}
function encoderWithPadding(encoder, config) {
  return (t) => {
    const [len, write] = encoder(t);
    const totalLength = len + byteLengthToPad(len, config);
    return [
      totalLength,
      (offset, buffer) => {
        write(offset, buffer);
      }
    ];
  };
}
function decoderWithPadding(decoder) {
  return (bytes, offset) => {
    const result = decoder(bytes, offset);
    if (result === void 0)
      return void 0;
    const [decoded, innerOffset] = result;
    const paddingBytes = bytes.subarray(offset + innerOffset, bytes.length);
    const allZeroes = paddingBytes.every((byte) => byte === 0);
    if (!allZeroes)
      return void 0;
    return [decoded, bytes.length];
  };
}

// node_modules/ts-mls/dist/src/messageProtection.js
async function protectApplicationData(signKey, senderDataSecret, applicationData, authenticatedData, groupContext, secretTree, leafIndex, paddingConfig, cs) {
  const tbs = {
    protocolVersion: groupContext.version,
    wireformat: "mls_private_message",
    content: {
      contentType: "application",
      applicationData,
      groupId: groupContext.groupId,
      epoch: groupContext.epoch,
      sender: {
        senderType: "member",
        leafIndex
      },
      authenticatedData
    },
    senderType: "member",
    context: groupContext
  };
  const auth = await signFramedContentApplicationOrProposal(signKey, tbs, cs);
  const content = {
    ...tbs.content,
    auth
  };
  const result = await protect(senderDataSecret, authenticatedData, groupContext, secretTree, content, leafIndex, paddingConfig, cs);
  return { newSecretTree: result.tree, privateMessage: result.privateMessage, consumed: result.consumed };
}
async function protectProposal(signKey, senderDataSecret, p, authenticatedData, groupContext, secretTree, leafIndex, paddingConfig, cs) {
  const tbs = {
    protocolVersion: groupContext.version,
    wireformat: "mls_private_message",
    content: {
      contentType: "proposal",
      proposal: p,
      groupId: groupContext.groupId,
      epoch: groupContext.epoch,
      sender: {
        senderType: "member",
        leafIndex
      },
      authenticatedData
    },
    senderType: "member",
    context: groupContext
  };
  const auth = await signFramedContentApplicationOrProposal(signKey, tbs, cs);
  const content = { ...tbs.content, auth };
  const protectResult = await protect(senderDataSecret, authenticatedData, groupContext, secretTree, content, leafIndex, paddingConfig, cs);
  const newSecretTree = protectResult.tree;
  const authenticatedContent = {
    wireformat: "mls_private_message",
    content,
    auth
  };
  const proposalRef = await makeProposalRef(authenticatedContent, cs.hash);
  return { privateMessage: protectResult.privateMessage, newSecretTree, proposalRef, consumed: protectResult.consumed };
}
async function protect(senderDataSecret, authenticatedData, groupContext, secretTree, content, leafIndex, config, cs) {
  const node = secretTree[leafToNodeIndex(toLeafIndex(leafIndex))];
  if (node === void 0)
    throw new InternalError("Bad node index for secret tree");
  const { newTree, generation, reuseGuard, nonce, key, consumed } = await consumeRatchet(secretTree, leafToNodeIndex(toLeafIndex(leafIndex)), content.contentType, cs);
  const aad = {
    groupId: groupContext.groupId,
    epoch: groupContext.epoch,
    contentType: content.contentType,
    authenticatedData
  };
  const ciphertext = await cs.hpke.encryptAead(key, nonce, encode(privateContentAADEncoder)(aad), encodePrivateMessageContent(config)(content));
  const senderData = {
    leafIndex,
    generation,
    reuseGuard
  };
  const senderAad = {
    groupId: groupContext.groupId,
    epoch: groupContext.epoch,
    contentType: content.contentType
  };
  const encryptedSenderData = await encryptSenderData(senderDataSecret, senderData, senderAad, ciphertext, cs);
  return {
    privateMessage: {
      groupId: groupContext.groupId,
      epoch: groupContext.epoch,
      encryptedSenderData,
      contentType: content.contentType,
      authenticatedData,
      ciphertext
    },
    tree: newTree,
    consumed
  };
}
async function unprotectPrivateMessage(senderDataSecret, msg, secretTree, ratchetTree, groupContext, config, cs, overrideSignatureKey) {
  const senderData = await decryptSenderData(msg, senderDataSecret, cs);
  if (senderData === void 0)
    throw new CodecError("Could not decode senderdata");
  validateSenderData(senderData, ratchetTree);
  const { key, nonce, newTree, consumed } = await ratchetToGeneration(secretTree, senderData, msg.contentType, config, cs);
  const aad = {
    groupId: msg.groupId,
    epoch: msg.epoch,
    contentType: msg.contentType,
    authenticatedData: msg.authenticatedData
  };
  const decrypted = await cs.hpke.decryptAead(key, nonce, encode(privateContentAADEncoder)(aad), msg.ciphertext);
  const pmc = decodePrivateMessageContent(msg.contentType)(decrypted, 0)?.[0];
  if (pmc === void 0)
    throw new CodecError("Could not decode PrivateMessageContent");
  const content = toAuthenticatedContent(pmc, msg, senderData.leafIndex);
  const signaturePublicKey = overrideSignatureKey !== void 0 ? overrideSignatureKey : getSignaturePublicKeyFromLeafIndex(ratchetTree, toLeafIndex(senderData.leafIndex));
  const signatureValid = await verifyFramedContentSignature(signaturePublicKey, "mls_private_message", content.content, content.auth, groupContext, cs.signature);
  if (!signatureValid)
    throw new CryptoVerificationError("Signature invalid");
  return { tree: newTree, content, consumed };
}
function validateSenderData(senderData, tree) {
  if (tree[leafToNodeIndex(toLeafIndex(senderData.leafIndex))]?.nodeType !== "leaf")
    return new ValidationError("SenderData did not point to a non-blank leaf node");
}

// node_modules/ts-mls/dist/src/createMessage.js
async function createProposal(state, publicMessage, proposal, cs, authenticatedData = new Uint8Array()) {
  if (publicMessage) {
    const result = await protectProposalPublic(state.signaturePrivateKey, state.keySchedule.membershipKey, state.groupContext, authenticatedData, proposal, state.privatePath.leafIndex, cs);
    const newState = await processProposal(state, { content: result.publicMessage.content, auth: result.publicMessage.auth, wireformat: "mls_public_message" }, proposal, cs.hash);
    return {
      newState,
      message: { wireformat: "mls_public_message", version: "mls10", publicMessage: result.publicMessage },
      consumed: []
    };
  } else {
    const result = await protectProposal(state.signaturePrivateKey, state.keySchedule.senderDataSecret, proposal, authenticatedData, state.groupContext, state.secretTree, state.privatePath.leafIndex, state.clientConfig.paddingConfig, cs);
    const newState = {
      ...state,
      secretTree: result.newSecretTree,
      unappliedProposals: addUnappliedProposal(result.proposalRef, state.unappliedProposals, proposal, state.privatePath.leafIndex)
    };
    return {
      newState,
      message: { wireformat: "mls_private_message", version: "mls10", privateMessage: result.privateMessage },
      consumed: result.consumed
    };
  }
}
async function createApplicationMessage(state, message, cs, authenticatedData = new Uint8Array()) {
  checkCanSendApplicationMessages(state);
  const result = await protectApplicationData(state.signaturePrivateKey, state.keySchedule.senderDataSecret, message, authenticatedData, state.groupContext, state.secretTree, state.privatePath.leafIndex, state.clientConfig.paddingConfig, cs);
  return {
    newState: { ...state, secretTree: result.newSecretTree },
    privateMessage: result.privateMessage,
    consumed: result.consumed
  };
}

// node_modules/ts-mls/dist/src/createCommit.js
var createCommit_exports = {};
__export(createCommit_exports, {
  applyUpdatePathSecret: () => applyUpdatePathSecret,
  createCommit: () => createCommit,
  createGroupInfo: () => createGroupInfo,
  createGroupInfoWithExternalPub: () => createGroupInfoWithExternalPub,
  createGroupInfoWithExternalPubAndRatchetTree: () => createGroupInfoWithExternalPubAndRatchetTree,
  createGroupInfoWithRatchetTree: () => createGroupInfoWithRatchetTree,
  filterNewLeaves: () => filterNewLeaves,
  joinGroupExternal: () => joinGroupExternal
});
async function createCommit(context, options) {
  const { state, pskIndex = makePskIndex(state, {}), cipherSuite } = context;
  const { wireAsPublicMessage = false, extraProposals = [], ratchetTreeExtension = false, authenticatedData = new Uint8Array(), groupInfoExtensions = [] } = options ?? {};
  checkCanSendHandshakeMessages(state);
  const wireformat = wireAsPublicMessage ? "mls_public_message" : "mls_private_message";
  const allProposals = bundleAllProposals(state, extraProposals);
  const res = await applyProposals(state, allProposals, toLeafIndex(state.privatePath.leafIndex), pskIndex, true, cipherSuite);
  if (res.additionalResult.kind === "externalCommit")
    throw new UsageError("Cannot create externalCommit as a member");
  const suspendedPendingReinit = res.additionalResult.kind === "reinit" ? res.additionalResult.reinit : void 0;
  const excludeNodes = res.additionalResult.kind === "memberCommit" ? res.additionalResult.addedLeafNodes.map(([leafIndex]) => leafToNodeIndex(leafIndex)) : [];
  const [tree, updatePath, pathSecrets, newPrivateKey] = res.needsUpdatePath ? await createUpdatePath(res.tree, toLeafIndex(state.privatePath.leafIndex), state.groupContext, state.signaturePrivateKey, cipherSuite, excludeNodes) : [res.tree, void 0, [], void 0];
  const updatedExtensions = res.additionalResult.kind === "memberCommit" && res.additionalResult.extensions.length > 0 ? res.additionalResult.extensions : state.groupContext.extensions;
  const groupContextWithExtensions = { ...state.groupContext, extensions: updatedExtensions };
  const privateKeys = mergePrivateKeyPaths(newPrivateKey !== void 0 ? updateLeafKey(state.privatePath, await cipherSuite.hpke.exportPrivateKey(newPrivateKey)) : state.privatePath, await toPrivateKeyPath(pathToPathSecrets(pathSecrets), state.privatePath.leafIndex, cipherSuite));
  const lastPathSecret = pathSecrets.at(-1);
  const commitSecret = lastPathSecret === void 0 ? new Uint8Array(cipherSuite.kdf.size) : await getCommitSecret(tree, toNodeIndex(lastPathSecret.nodeIndex), lastPathSecret.secret, cipherSuite.kdf);
  const { signature, framedContent } = await createContentCommitSignature(state.groupContext, wireformat, { proposals: allProposals, path: updatePath }, { senderType: "member", leafIndex: state.privatePath.leafIndex }, authenticatedData, state.signaturePrivateKey, cipherSuite.signature);
  const treeHash2 = await treeHashRoot(tree, cipherSuite.hash);
  const updatedGroupContext = await nextEpochContext(groupContextWithExtensions, wireformat, framedContent, signature, treeHash2, state.confirmationTag, cipherSuite.hash);
  const epochSecrets = await initializeEpoch(state.keySchedule.initSecret, commitSecret, updatedGroupContext, res.pskSecret, cipherSuite.kdf);
  const confirmationTag = await createConfirmationTag(epochSecrets.keySchedule.confirmationKey, updatedGroupContext.confirmedTranscriptHash, cipherSuite.hash);
  const authData = {
    contentType: framedContent.contentType,
    signature,
    confirmationTag
  };
  const [commit, _newTree, consumedSecrets] = await protectCommit(wireAsPublicMessage, state, authenticatedData, framedContent, authData, cipherSuite);
  const welcome = await createWelcome(ratchetTreeExtension, updatedGroupContext, confirmationTag, state, tree, cipherSuite, epochSecrets, res, pathSecrets, groupInfoExtensions);
  const groupActiveState = res.selfRemoved ? { kind: "removedFromGroup" } : suspendedPendingReinit !== void 0 ? { kind: "suspendedPendingReinit", reinit: suspendedPendingReinit } : { kind: "active" };
  const [historicalReceiverData, consumedEpochData] = addHistoricalReceiverData(state);
  const newState = {
    groupContext: updatedGroupContext,
    ratchetTree: tree,
    secretTree: await createSecretTree(leafWidth(tree.length), epochSecrets.encryptionSecret, cipherSuite.kdf),
    keySchedule: epochSecrets.keySchedule,
    privatePath: privateKeys,
    unappliedProposals: {},
    historicalReceiverData,
    confirmationTag,
    signaturePrivateKey: state.signaturePrivateKey,
    groupActiveState,
    clientConfig: state.clientConfig
  };
  zeroOutUint8Array(commitSecret);
  zeroOutUint8Array(epochSecrets.encryptionSecret);
  zeroOutUint8Array(epochSecrets.joinerSecret);
  const consumed = [...consumedSecrets, ...consumedEpochData, state.keySchedule.initSecret];
  return { newState, welcome, commit, consumed };
}
function bundleAllProposals(state, extraProposals) {
  const refs = Object.keys(state.unappliedProposals).map((p) => ({
    proposalOrRefType: "reference",
    reference: base64ToBytes(p)
  }));
  const proposals = extraProposals.map((p) => ({ proposalOrRefType: "proposal", proposal: p }));
  return [...refs, ...proposals];
}
async function createWelcome(ratchetTreeExtension, groupContext, confirmationTag, state, tree, cs, epochSecrets, res, pathSecrets, extensions) {
  const groupInfo = ratchetTreeExtension ? await createGroupInfoWithRatchetTree(groupContext, confirmationTag, state, tree, extensions, cs) : await createGroupInfo(groupContext, confirmationTag, state, extensions, cs);
  const encryptedGroupInfo = await encryptGroupInfo(groupInfo, epochSecrets.welcomeSecret, cs);
  const encryptedGroupSecrets = res.additionalResult.kind === "memberCommit" ? await Promise.all(res.additionalResult.addedLeafNodes.map(([leafNodeIndex, keyPackage]) => {
    return createEncryptedGroupSecrets(tree, leafNodeIndex, state, pathSecrets, cs, keyPackage, encryptedGroupInfo, epochSecrets, res);
  })) : [];
  return encryptedGroupSecrets.length > 0 ? {
    cipherSuite: groupContext.cipherSuite,
    secrets: encryptedGroupSecrets,
    encryptedGroupInfo
  } : void 0;
}
async function createEncryptedGroupSecrets(tree, leafNodeIndex, state, pathSecrets, cs, keyPackage, encryptedGroupInfo, epochSecrets, res) {
  const nodeIndex = firstCommonAncestor(tree, leafNodeIndex, toLeafIndex(state.privatePath.leafIndex));
  const pathSecret = pathSecrets.find((ps) => ps.nodeIndex === nodeIndex);
  const pk = await cs.hpke.importPublicKey(keyPackage.initKey);
  const egs = await encryptGroupSecrets(pk, encryptedGroupInfo, { joinerSecret: epochSecrets.joinerSecret, pathSecret: pathSecret?.secret, psks: res.pskIds }, cs.hpke);
  const ref = await makeKeyPackageRef(keyPackage, cs.hash);
  return { newMember: ref, encryptedGroupSecrets: { kemOutput: egs.enc, ciphertext: egs.ct } };
}
async function createGroupInfo(groupContext, confirmationTag, state, extensions, cs) {
  const groupInfoTbs = {
    groupContext,
    extensions,
    confirmationTag,
    signer: state.privatePath.leafIndex
  };
  return signGroupInfo(groupInfoTbs, state.signaturePrivateKey, cs.signature);
}
async function createGroupInfoWithRatchetTree(groupContext, confirmationTag, state, tree, extensions, cs) {
  const encodedTree = encode(ratchetTreeEncoder)(tree);
  const gi = await createGroupInfo(groupContext, confirmationTag, state, [...extensions, { extensionType: "ratchet_tree", extensionData: encodedTree }], cs);
  return gi;
}
async function createGroupInfoWithExternalPub(state, extensions, cs) {
  const externalKeyPair = await cs.hpke.deriveKeyPair(state.keySchedule.externalSecret);
  const externalPub = await cs.hpke.exportPublicKey(externalKeyPair.publicKey);
  const gi = await createGroupInfo(state.groupContext, state.confirmationTag, state, [...extensions, { extensionType: "external_pub", extensionData: externalPub }], cs);
  return gi;
}
async function createGroupInfoWithExternalPubAndRatchetTree(state, extensions, cs) {
  const encodedTree = encode(ratchetTreeEncoder)(state.ratchetTree);
  const externalKeyPair = await cs.hpke.deriveKeyPair(state.keySchedule.externalSecret);
  const externalPub = await cs.hpke.exportPublicKey(externalKeyPair.publicKey);
  const gi = await createGroupInfo(state.groupContext, state.confirmationTag, state, [
    ...extensions,
    { extensionType: "external_pub", extensionData: externalPub },
    { extensionType: "ratchet_tree", extensionData: encodedTree }
  ], cs);
  return gi;
}
async function protectCommit(publicMessage, state, authenticatedData, content, authData, cs) {
  const wireformat = publicMessage ? "mls_public_message" : "mls_private_message";
  const authenticatedContent = {
    wireformat,
    content,
    auth: authData
  };
  if (publicMessage) {
    const msg = await protectPublicMessage(state.keySchedule.membershipKey, state.groupContext, authenticatedContent, cs);
    return [{ version: "mls10", wireformat: "mls_public_message", publicMessage: msg }, state.secretTree, []];
  } else {
    const res = await protect(state.keySchedule.senderDataSecret, authenticatedData, state.groupContext, state.secretTree, { ...content, auth: authData }, state.privatePath.leafIndex, state.clientConfig.paddingConfig, cs);
    return [
      { version: "mls10", wireformat: "mls_private_message", privateMessage: res.privateMessage },
      res.tree,
      res.consumed
    ];
  }
}
async function applyUpdatePathSecret(tree, privatePath, senderLeafIndex, gc, path, excludeNodes, cs) {
  const { nodeIndex: ancestorNodeIndex, resolution: resolution2, updateNode } = firstMatchAncestor(tree, toLeafIndex(privatePath.leafIndex), senderLeafIndex, path);
  for (const [i, nodeIndex] of filterNewLeaves(resolution2, excludeNodes).entries()) {
    if (privatePath.privateKeys[nodeIndex] !== void 0) {
      const key = await cs.hpke.importPrivateKey(privatePath.privateKeys[nodeIndex]);
      const ct = updateNode.encryptedPathSecret[i];
      const pathSecret = await decryptWithLabel(key, "UpdatePathNode", encode(groupContextEncoder)(gc), ct.kemOutput, ct.ciphertext, cs.hpke);
      return { nodeIndex: ancestorNodeIndex, pathSecret };
    }
  }
  throw new InternalError("No overlap between provided private keys and update path");
}
async function joinGroupExternal(groupInfo, keyPackage, privateKeys, resync, cs, tree, clientConfig = defaultClientConfig, authenticatedData = new Uint8Array()) {
  const externalPub = groupInfo.extensions.find((ex) => ex.extensionType === "external_pub");
  if (externalPub === void 0)
    throw new UsageError("Could not find external_pub extension");
  const allExtensionsSupported = extensionsSupportedByCapabilities(groupInfo.groupContext.extensions, keyPackage.leafNode.capabilities);
  if (!allExtensionsSupported)
    throw new UsageError("client does not support every extension in the GroupContext");
  const { enc, secret: initSecret } = await exportSecret(externalPub.extensionData, cs);
  const ratchetTree = ratchetTreeFromExtension(groupInfo) ?? tree;
  if (ratchetTree === void 0)
    throw new UsageError("No RatchetTree passed and no ratchet_tree extension");
  throwIfDefined(await validateRatchetTree(ratchetTree, groupInfo.groupContext, clientConfig.lifetimeConfig, clientConfig.authService, groupInfo.groupContext.treeHash, cs));
  const signaturePublicKey = getSignaturePublicKeyFromLeafIndex(ratchetTree, toLeafIndex(groupInfo.signer));
  const signerCredential = getCredentialFromLeafIndex(ratchetTree, toLeafIndex(groupInfo.signer));
  const credentialVerified = await clientConfig.authService.validateCredential(signerCredential, signaturePublicKey);
  if (!credentialVerified)
    throw new ValidationError("Could not validate credential");
  const groupInfoSignatureVerified = await verifyGroupInfoSignature(groupInfo, signaturePublicKey, cs.signature);
  if (!groupInfoSignatureVerified)
    throw new CryptoVerificationError("Could not verify groupInfo Signature");
  const formerLeafIndex = resync ? nodeToLeafIndex(toNodeIndex(ratchetTree.findIndex((n) => {
    if (n !== void 0 && n.nodeType === "leaf") {
      return clientConfig.keyPackageEqualityConfig.compareKeyPackageToLeafNode(keyPackage, n.leaf);
    }
    return false;
  }))) : void 0;
  const updatedTree = formerLeafIndex !== void 0 ? removeLeafNode(ratchetTree, formerLeafIndex) : ratchetTree;
  const [treeWithNewLeafNode, newLeafNodeIndex] = addLeafNode(updatedTree, keyPackage.leafNode);
  const [newTree, updatePath, pathSecrets, newPrivateKey] = await createUpdatePath(treeWithNewLeafNode, nodeToLeafIndex(newLeafNodeIndex), groupInfo.groupContext, privateKeys.signaturePrivateKey, cs);
  const privateKeyPath = updateLeafKey(await toPrivateKeyPath(pathToPathSecrets(pathSecrets), nodeToLeafIndex(newLeafNodeIndex), cs), await cs.hpke.exportPrivateKey(newPrivateKey));
  const lastPathSecret = pathSecrets.at(-1);
  const commitSecret = lastPathSecret === void 0 ? new Uint8Array(cs.kdf.size) : await getCommitSecret(newTree, toNodeIndex(lastPathSecret.nodeIndex), lastPathSecret.secret, cs.kdf);
  const externalInitProposal = {
    proposalType: "external_init",
    externalInit: { kemOutput: enc }
  };
  const proposals = formerLeafIndex !== void 0 ? [{ proposalType: "remove", remove: { removed: formerLeafIndex } }, externalInitProposal] : [externalInitProposal];
  const pskSecret = new Uint8Array(cs.kdf.size);
  const { signature, framedContent } = await createContentCommitSignature(groupInfo.groupContext, "mls_public_message", { proposals: proposals.map((p) => ({ proposalOrRefType: "proposal", proposal: p })), path: updatePath }, {
    senderType: "new_member_commit"
  }, authenticatedData, privateKeys.signaturePrivateKey, cs.signature);
  const treeHash2 = await treeHashRoot(newTree, cs.hash);
  const groupContext = await nextEpochContext(groupInfo.groupContext, "mls_public_message", framedContent, signature, treeHash2, groupInfo.confirmationTag, cs.hash);
  const epochSecrets = await initializeEpoch(initSecret, commitSecret, groupContext, pskSecret, cs.kdf);
  const confirmationTag = await createConfirmationTag(epochSecrets.keySchedule.confirmationKey, groupContext.confirmedTranscriptHash, cs.hash);
  const state = {
    ratchetTree: newTree,
    groupContext,
    secretTree: await createSecretTree(leafWidth(newTree.length), epochSecrets.encryptionSecret, cs.kdf),
    privatePath: privateKeyPath,
    confirmationTag,
    historicalReceiverData: /* @__PURE__ */ new Map(),
    signaturePrivateKey: privateKeys.signaturePrivateKey,
    keySchedule: epochSecrets.keySchedule,
    unappliedProposals: {},
    groupActiveState: { kind: "active" },
    clientConfig
  };
  const authenticatedContent = {
    content: framedContent,
    auth: { signature, confirmationTag, contentType: "commit" },
    wireformat: "mls_public_message"
  };
  const msg = await protectPublicMessage(epochSecrets.keySchedule.membershipKey, groupContext, authenticatedContent, cs);
  zeroOutUint8Array(commitSecret);
  zeroOutUint8Array(initSecret);
  zeroOutUint8Array(epochSecrets.encryptionSecret);
  zeroOutUint8Array(epochSecrets.joinerSecret);
  return { publicMessage: msg, newState: state };
}
function filterNewLeaves(resolution2, excludeNodes) {
  const set = new Set(excludeNodes);
  return resolution2.filter((i) => !set.has(i));
}

// node_modules/ts-mls/dist/src/processMessages.js
var processMessages_exports = {};
__export(processMessages_exports, {
  processMessage: () => processMessage,
  processPrivateMessage: () => processPrivateMessage,
  processPublicMessage: () => processPublicMessage
});
async function processPrivateMessage(state, pm, pskSearch, cs, callback = acceptAll) {
  if (pm.epoch < state.groupContext.epoch) {
    const receiverData = state.historicalReceiverData.get(pm.epoch);
    if (receiverData !== void 0) {
      const result2 = await unprotectPrivateMessage(receiverData.senderDataSecret, pm, receiverData.secretTree, receiverData.ratchetTree, receiverData.groupContext, state.clientConfig.keyRetentionConfig, cs);
      const newHistoricalReceiverData = addToMap(state.historicalReceiverData, pm.epoch, {
        ...receiverData,
        secretTree: result2.tree
      });
      const newState = { ...state, historicalReceiverData: newHistoricalReceiverData };
      if (result2.content.content.contentType === "application") {
        return {
          kind: "applicationMessage",
          message: result2.content.content.applicationData,
          newState,
          consumed: result2.consumed
        };
      } else {
        throw new ValidationError("Cannot process commit or proposal from former epoch");
      }
    } else {
      throw new ValidationError("Cannot process message, epoch too old");
    }
  }
  const result = await unprotectPrivateMessage(state.keySchedule.senderDataSecret, pm, state.secretTree, state.ratchetTree, state.groupContext, state.clientConfig.keyRetentionConfig, cs);
  const updatedState = { ...state, secretTree: result.tree };
  if (result.content.content.contentType === "application") {
    return {
      kind: "applicationMessage",
      message: result.content.content.applicationData,
      newState: updatedState,
      consumed: result.consumed
    };
  } else if (result.content.content.contentType === "commit") {
    const { newState, actionTaken, consumed } = await processCommit(updatedState, result.content, "mls_private_message", pskSearch, callback, cs);
    return {
      kind: "newState",
      newState,
      actionTaken,
      consumed: [...result.consumed, ...consumed]
    };
  } else {
    const action = callback({
      kind: "proposal",
      proposal: {
        proposal: result.content.content.proposal,
        senderLeafIndex: getSenderLeafNodeIndex(result.content.content.sender)
      }
    });
    if (action === "reject")
      return {
        kind: "newState",
        newState: updatedState,
        actionTaken: action,
        consumed: result.consumed
      };
    else
      return {
        kind: "newState",
        newState: await processProposal(updatedState, result.content, result.content.content.proposal, cs.hash),
        actionTaken: action,
        consumed: result.consumed
      };
  }
}
async function processPublicMessage(state, pm, pskSearch, cs, callback = acceptAll) {
  if (pm.content.epoch < state.groupContext.epoch)
    throw new ValidationError("Cannot process message, epoch too old");
  const content = await unprotectPublicMessage(state.keySchedule.membershipKey, state.groupContext, state.ratchetTree, pm, cs);
  if (content.content.contentType === "proposal") {
    const action = callback({
      kind: "proposal",
      proposal: { proposal: content.content.proposal, senderLeafIndex: getSenderLeafNodeIndex(content.content.sender) }
    });
    if (action === "reject")
      return {
        newState: state,
        actionTaken: action,
        consumed: []
      };
    else
      return {
        newState: await processProposal(state, content, content.content.proposal, cs.hash),
        actionTaken: action,
        consumed: []
      };
  } else {
    return processCommit(state, content, "mls_public_message", pskSearch, callback, cs);
  }
}
async function processCommit(state, content, wireformat, pskSearch, callback, cs) {
  if (content.content.epoch !== state.groupContext.epoch)
    throw new ValidationError("Could not validate epoch");
  const senderLeafIndex = content.content.sender.senderType === "member" ? toLeafIndex(content.content.sender.leafIndex) : void 0;
  const result = await applyProposals(state, content.content.commit.proposals, senderLeafIndex, pskSearch, false, cs);
  const action = callback({ kind: "commit", senderLeafIndex, proposals: result.allProposals });
  if (action === "reject") {
    return { newState: state, actionTaken: action, consumed: [] };
  }
  if (content.content.commit.path !== void 0) {
    const committerLeafIndex = senderLeafIndex ?? (result.additionalResult.kind === "externalCommit" ? result.additionalResult.newMemberLeafIndex : void 0);
    if (committerLeafIndex === void 0)
      throw new ValidationError("Cannot verify commit leaf node because no commiter leaf index found");
    throwIfDefined(await validateLeafNodeUpdateOrCommit(content.content.commit.path.leafNode, committerLeafIndex, state.groupContext, state.clientConfig.authService, cs.signature));
    throwIfDefined(await validateLeafNodeCredentialAndKeyUniqueness(result.tree, content.content.commit.path.leafNode, committerLeafIndex));
  }
  if (result.needsUpdatePath && content.content.commit.path === void 0)
    throw new ValidationError("Update path is required");
  if (result.selfRemoved) {
    return {
      newState: {
        ...state,
        ratchetTree: result.tree,
        unappliedProposals: {},
        groupActiveState: { kind: "removedFromGroup" }
      },
      actionTaken: action,
      consumed: []
    };
  }
  const groupContextWithExtensions = result.additionalResult.kind === "memberCommit" && result.additionalResult.extensions.length > 0 ? { ...state.groupContext, extensions: result.additionalResult.extensions } : state.groupContext;
  const [pkp, commitSecret, tree] = await applyTreeUpdate(content.content.commit.path, content.content.sender, result.tree, cs, state, groupContextWithExtensions, result.additionalResult.kind === "memberCommit" ? result.additionalResult.addedLeafNodes.map((l) => leafToNodeIndex(toLeafIndex(l[0]))) : [findBlankLeafNodeIndex(result.tree) ?? toNodeIndex(result.tree.length + 1)], cs.kdf);
  const newTreeHash = await treeHashRoot(tree, cs.hash);
  if (content.auth.contentType !== "commit")
    throw new ValidationError("Received content as commit, but not auth");
  const updatedGroupContext = await nextEpochContext(groupContextWithExtensions, wireformat, content.content, content.auth.signature, newTreeHash, state.confirmationTag, cs.hash);
  const initSecret = result.additionalResult.kind === "externalCommit" ? result.additionalResult.externalInitSecret : state.keySchedule.initSecret;
  const epochSecrets = await initializeEpoch(initSecret, commitSecret, updatedGroupContext, result.pskSecret, cs.kdf);
  const confirmationTagValid = await verifyConfirmationTag(epochSecrets.keySchedule.confirmationKey, content.auth.confirmationTag, updatedGroupContext.confirmedTranscriptHash, cs.hash);
  if (!confirmationTagValid)
    throw new CryptoVerificationError("Could not verify confirmation tag");
  const secretTree = await createSecretTree(leafWidth(tree.length), epochSecrets.encryptionSecret, cs.kdf);
  const suspendedPendingReinit = result.additionalResult.kind === "reinit" ? result.additionalResult.reinit : void 0;
  const groupActiveState = result.selfRemoved ? { kind: "removedFromGroup" } : suspendedPendingReinit !== void 0 ? { kind: "suspendedPendingReinit", reinit: suspendedPendingReinit } : { kind: "active" };
  const [historicalReceiverData, consumedEpochData] = addHistoricalReceiverData(state);
  zeroOutUint8Array(commitSecret);
  zeroOutUint8Array(epochSecrets.joinerSecret);
  zeroOutUint8Array(epochSecrets.encryptionSecret);
  const consumed = [...consumedEpochData, initSecret];
  return {
    newState: {
      ...state,
      secretTree,
      ratchetTree: tree,
      privatePath: pkp,
      groupContext: updatedGroupContext,
      keySchedule: epochSecrets.keySchedule,
      confirmationTag: content.auth.confirmationTag,
      historicalReceiverData,
      unappliedProposals: {},
      groupActiveState
    },
    actionTaken: action,
    consumed
  };
}
async function applyTreeUpdate(path, sender, tree, cs, state, groupContext, excludeNodes, kdf) {
  if (path === void 0)
    return [state.privatePath, new Uint8Array(kdf.size), tree];
  if (sender.senderType === "member") {
    const updatedTree = await applyUpdatePath(tree, toLeafIndex(sender.leafIndex), path, cs.hash);
    const [pkp, commitSecret] = await updatePrivateKeyPath(updatedTree, state, toLeafIndex(sender.leafIndex), { ...groupContext, treeHash: await treeHashRoot(updatedTree, cs.hash), epoch: groupContext.epoch + 1n }, path, excludeNodes, cs);
    return [pkp, commitSecret, updatedTree];
  } else {
    const [treeWithLeafNode, leafNodeIndex] = addLeafNode(tree, path.leafNode);
    const senderLeafIndex = nodeToLeafIndex(leafNodeIndex);
    const updatedTree = await applyUpdatePath(treeWithLeafNode, senderLeafIndex, path, cs.hash, true);
    const [pkp, commitSecret] = await updatePrivateKeyPath(updatedTree, state, senderLeafIndex, { ...groupContext, treeHash: await treeHashRoot(updatedTree, cs.hash), epoch: groupContext.epoch + 1n }, path, excludeNodes, cs);
    return [pkp, commitSecret, updatedTree];
  }
}
async function updatePrivateKeyPath(tree, state, leafNodeIndex, groupContext, path, excludeNodes, cs) {
  const secret = await applyUpdatePathSecret(tree, state.privatePath, leafNodeIndex, groupContext, path, excludeNodes, cs);
  const pathSecrets = await pathToRoot(tree, toNodeIndex(secret.nodeIndex), secret.pathSecret, cs.kdf);
  const newPkp = mergePrivateKeyPaths(state.privatePath, await toPrivateKeyPath(pathSecrets, state.privatePath.leafIndex, cs));
  const rootIndex = root(leafWidth(tree.length));
  const rootSecret = pathSecrets[rootIndex];
  if (rootSecret === void 0)
    throw new InternalError("Could not find secret for root");
  const commitSecret = await deriveSecret(rootSecret, "path", cs.kdf);
  return [newPkp, commitSecret];
}
async function processMessage(message, state, pskIndex, action, cs) {
  if (message.wireformat === "mls_public_message") {
    const result = await processPublicMessage(state, message.publicMessage, pskIndex, cs, action);
    return { ...result, kind: "newState" };
  } else
    return processPrivateMessage(state, message.privateMessage, emptyPskIndex, cs, action);
}

// node_modules/ts-mls/dist/src/crypto/getCiphersuiteImpl.js
var getCiphersuiteImpl_exports = {};
__export(getCiphersuiteImpl_exports, {
  getCiphersuiteImpl: () => getCiphersuiteImpl
});

// node_modules/ts-mls/dist/src/crypto/implementation/default/makeHashImpl.js
function makeHashImpl(sc, h) {
  return {
    async digest(data) {
      const result = await sc.digest(h, toBufferSource(data));
      return new Uint8Array(result);
    },
    async mac(key, data) {
      const result = await sc.sign("HMAC", await importMacKey(key, h), toBufferSource(data));
      return new Uint8Array(result);
    },
    async verifyMac(key, mac, data) {
      return sc.verify("HMAC", await importMacKey(key, h), toBufferSource(mac), toBufferSource(data));
    }
  };
}
function importMacKey(rawKey, h) {
  return crypto.subtle.importKey("raw", toBufferSource(rawKey), {
    name: "HMAC",
    hash: { name: h }
  }, false, ["sign", "verify"]);
}

// node_modules/ts-mls/dist/src/crypto/implementation/default/makeHpke.js
var makeHpke_exports = {};
__export(makeHpke_exports, {
  makeHpke: () => makeHpke
});

// node_modules/@hpke/common/esm/src/errors.js
var HpkeError = class extends Error {
  constructor(e) {
    let message;
    if (e instanceof Error) {
      message = e.message;
    } else if (typeof e === "string") {
      message = e;
    } else {
      message = "";
    }
    super(message);
    this.name = this.constructor.name;
  }
};
var InvalidParamError = class extends HpkeError {
};
var SerializeError = class extends HpkeError {
};
var DeserializeError = class extends HpkeError {
};
var EncapError = class extends HpkeError {
};
var DecapError = class extends HpkeError {
};
var ExportError = class extends HpkeError {
};
var SealError = class extends HpkeError {
};
var OpenError = class extends HpkeError {
};
var MessageLimitReachedError = class extends HpkeError {
};
var DeriveKeyPairError = class extends HpkeError {
};
var NotSupportedError = class extends HpkeError {
};

// node_modules/@hpke/common/esm/_dnt.shims.js
var dntGlobals = {};
var dntGlobalThis = createMergeProxy(globalThis, dntGlobals);
function createMergeProxy(baseObj, extObj) {
  return new Proxy(baseObj, {
    get(_target, prop, _receiver) {
      if (prop in extObj) {
        return extObj[prop];
      } else {
        return baseObj[prop];
      }
    },
    set(_target, prop, value) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      baseObj[prop] = value;
      return true;
    },
    deleteProperty(_target, prop) {
      let success = false;
      if (prop in extObj) {
        delete extObj[prop];
        success = true;
      }
      if (prop in baseObj) {
        delete baseObj[prop];
        success = true;
      }
      return success;
    },
    ownKeys(_target) {
      const baseKeys = Reflect.ownKeys(baseObj);
      const extKeys = Reflect.ownKeys(extObj);
      const extKeysSet = new Set(extKeys);
      return [...baseKeys.filter((k) => !extKeysSet.has(k)), ...extKeys];
    },
    defineProperty(_target, prop, desc) {
      if (prop in extObj) {
        delete extObj[prop];
      }
      Reflect.defineProperty(baseObj, prop, desc);
      return true;
    },
    getOwnPropertyDescriptor(_target, prop) {
      if (prop in extObj) {
        return Reflect.getOwnPropertyDescriptor(extObj, prop);
      } else {
        return Reflect.getOwnPropertyDescriptor(baseObj, prop);
      }
    },
    has(_target, prop) {
      return prop in extObj || prop in baseObj;
    }
  });
}

// node_modules/@hpke/common/esm/src/algorithm.js
async function loadSubtleCrypto() {
  if (dntGlobalThis !== void 0 && globalThis.crypto !== void 0) {
    return globalThis.crypto.subtle;
  }
  try {
    const { webcrypto } = await Promise.resolve().then(() => __toESM(require_crypto(), 1));
    return webcrypto.subtle;
  } catch (e) {
    throw new NotSupportedError(e);
  }
}
var NativeAlgorithm = class {
  constructor() {
    Object.defineProperty(this, "_api", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
  }
  async _setup() {
    if (this._api !== void 0) {
      return;
    }
    this._api = await loadSubtleCrypto();
  }
};

// node_modules/@hpke/common/esm/src/identifiers.js
var Mode = {
  Base: 0,
  Psk: 1,
  Auth: 2,
  AuthPsk: 3
};
var KemId = {
  NotAssigned: 0,
  DhkemP256HkdfSha256: 16,
  DhkemP384HkdfSha384: 17,
  DhkemP521HkdfSha512: 18,
  DhkemSecp256k1HkdfSha256: 19,
  DhkemX25519HkdfSha256: 32,
  DhkemX448HkdfSha512: 33,
  HybridkemX25519Kyber768: 48,
  MlKem512: 64,
  MlKem768: 65,
  MlKem1024: 66,
  XWing: 25722
};
var KdfId = {
  HkdfSha256: 1,
  HkdfSha384: 2,
  HkdfSha512: 3,
  Sha3256: 4,
  Sha3384: 5,
  Sha3512: 6,
  Shake128: 16,
  Shake256: 17,
  TurboShake128: 18,
  TurboShake256: 19
};
var AeadId = {
  Aes128Gcm: 1,
  Aes256Gcm: 2,
  Chacha20Poly1305: 3,
  ExportOnly: 65535
};

// node_modules/@hpke/common/esm/src/consts.js
var INPUT_LENGTH_LIMIT = 8192;
var INFO_LENGTH_LIMIT = 65536;
var MINIMUM_PSK_LENGTH = 32;
var EMPTY = /* @__PURE__ */ new Uint8Array(0);
var BYTE_TO_BIGINT_256 = /* @__PURE__ */ (() => {
  const out = new Array(256);
  let i = 0;
  let value = 0n;
  while (i < 256) {
    out[i] = value;
    i++;
    value += 1n;
  }
  return out;
})();

// node_modules/@hpke/common/esm/src/interfaces/kemInterface.js
var SUITE_ID_HEADER_KEM = /* @__PURE__ */ new Uint8Array([
  75,
  69,
  77,
  0,
  0
]);

// node_modules/@hpke/common/esm/src/kdfs/hkdf.js
var HPKE_VERSION = /* @__PURE__ */ new Uint8Array([
  72,
  80,
  75,
  69,
  45,
  118,
  49
]);
function toUint8Array(input) {
  return new Uint8Array(toArrayBuffer(input));
}
function toArrayBuffer(input) {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice().buffer;
  }
  return new Uint8Array(input).slice().buffer;
}
var HkdfNative = class extends NativeAlgorithm {
  constructor() {
    super();
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha256
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "_suiteId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: EMPTY
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-256",
        length: 256
      }
    });
  }
  init(suiteId) {
    this._suiteId = suiteId;
  }
  buildLabeledIkm(label, ikm) {
    this._checkInit();
    const ret = new Uint8Array(7 + this._suiteId.byteLength + label.byteLength + ikm.byteLength);
    ret.set(HPKE_VERSION, 0);
    ret.set(this._suiteId, 7);
    ret.set(label, 7 + this._suiteId.byteLength);
    ret.set(ikm, 7 + this._suiteId.byteLength + label.byteLength);
    return ret;
  }
  buildLabeledInfo(label, info, len) {
    this._checkInit();
    const ret = new Uint8Array(9 + this._suiteId.byteLength + label.byteLength + info.byteLength);
    ret.set(new Uint8Array([0, len]), 0);
    ret.set(HPKE_VERSION, 2);
    ret.set(this._suiteId, 9);
    ret.set(label, 9 + this._suiteId.byteLength);
    ret.set(info, 9 + this._suiteId.byteLength + label.byteLength);
    return ret;
  }
  async extract(salt, ikm) {
    await this._setup();
    const saltBuf = salt.byteLength === 0 ? new ArrayBuffer(this.hashSize) : toArrayBuffer(salt);
    if (saltBuf.byteLength !== this.hashSize) {
      throw new InvalidParamError("The salt length must be the same as the hashSize");
    }
    const ikmBuf = toArrayBuffer(ikm);
    const key = await this._api.importKey("raw", saltBuf, this.algHash, false, [
      "sign"
    ]);
    return await this._api.sign("HMAC", key, ikmBuf);
  }
  async expand(prk, info, len) {
    await this._setup();
    const prkBuf = toArrayBuffer(prk);
    const key = await this._api.importKey("raw", prkBuf, this.algHash, false, [
      "sign"
    ]);
    const okm = new ArrayBuffer(len);
    const okmBytes = new Uint8Array(okm);
    let prev = EMPTY;
    const mid = toUint8Array(info);
    const tail = new Uint8Array(1);
    if (len > 255 * this.hashSize) {
      throw new Error("Entropy limit reached");
    }
    const tmp = new Uint8Array(this.hashSize + mid.length + 1);
    for (let i = 1, cur = 0; cur < okmBytes.length; i++) {
      tail[0] = i;
      tmp.set(prev, 0);
      tmp.set(mid, prev.length);
      tmp.set(tail, prev.length + mid.length);
      prev = new Uint8Array(await this._api.sign("HMAC", key, tmp.slice(0, prev.length + mid.length + 1)));
      if (okmBytes.length - cur >= prev.length) {
        okmBytes.set(prev, cur);
        cur += prev.length;
      } else {
        okmBytes.set(prev.slice(0, okmBytes.length - cur), cur);
        cur += okmBytes.length - cur;
      }
    }
    return okm;
  }
  async extractAndExpand(salt, ikm, info, len) {
    await this._setup();
    const ikmBuf = toArrayBuffer(ikm);
    const baseKey = await this._api.importKey("raw", ikmBuf, "HKDF", false, ["deriveBits"]);
    return await this._api.deriveBits({
      name: "HKDF",
      hash: this.algHash.hash,
      salt: toArrayBuffer(salt),
      info: toArrayBuffer(info)
    }, baseKey, len * 8);
  }
  async labeledExtract(salt, label, ikm) {
    return await this.extract(salt, this.buildLabeledIkm(label, ikm));
  }
  async labeledExpand(prk, label, info, len) {
    return await this.expand(prk, this.buildLabeledInfo(label, info, len), len);
  }
  _checkInit() {
    if (this._suiteId === EMPTY) {
      throw new Error("Not initialized. Call init()");
    }
  }
};
var HkdfSha256Native = class extends HkdfNative {
  constructor() {
    super(...arguments);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha256
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-256",
        length: 256
      }
    });
  }
};
var HkdfSha384Native = class extends HkdfNative {
  constructor() {
    super(...arguments);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha384
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 48
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-384",
        length: 384
      }
    });
  }
};
var HkdfSha512Native = class extends HkdfNative {
  constructor() {
    super(...arguments);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KdfId.HkdfSha512
    });
    Object.defineProperty(this, "hashSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 64
    });
    Object.defineProperty(this, "algHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: {
        name: "HMAC",
        hash: "SHA-512",
        length: 512
      }
    });
  }
};

// node_modules/@hpke/common/esm/src/utils/misc.js
var isCryptoKeyPair = (x) => typeof x === "object" && x !== null && typeof x.privateKey === "object" && typeof x.publicKey === "object";
function i2Osp(n, w) {
  if (w <= 0) {
    throw new Error("i2Osp: too small size");
  }
  if (n >= 256 ** w) {
    throw new Error("i2Osp: too large integer");
  }
  const ret = new Uint8Array(w);
  for (let i = 0; i < w && n; i++) {
    ret[w - (i + 1)] = n % 256;
    n = Math.floor(n / 256);
  }
  return ret;
}
function concat(a, b) {
  const ret = new Uint8Array(a.length + b.length);
  ret.set(a, 0);
  ret.set(b, a.length);
  return ret;
}
function base64UrlToBytes(v) {
  const base64 = v.replace(/-/g, "+").replace(/_/g, "/");
  const byteString = atob(base64);
  const ret = new Uint8Array(byteString.length);
  for (let i = 0; i < byteString.length; i++) {
    ret[i] = byteString.charCodeAt(i);
  }
  return ret;
}
function xor(a, b) {
  if (a.byteLength !== b.byteLength) {
    throw new Error("xor: different length inputs");
  }
  const buf = new Uint8Array(a.byteLength);
  for (let i = 0; i < a.byteLength; i++) {
    buf[i] = a[i] ^ b[i];
  }
  return buf;
}

// node_modules/@hpke/common/esm/src/kems/dhkem.js
var LABEL_EAE_PRK = /* @__PURE__ */ new Uint8Array([
  101,
  97,
  101,
  95,
  112,
  114,
  107
]);
var LABEL_SHARED_SECRET = /* @__PURE__ */ new Uint8Array([
  115,
  104,
  97,
  114,
  101,
  100,
  95,
  115,
  101,
  99,
  114,
  101,
  116
]);
function concat3(a, b, c) {
  const ret = new Uint8Array(a.length + b.length + c.length);
  ret.set(a, 0);
  ret.set(b, a.length);
  ret.set(c, a.length + b.length);
  return ret;
}
var Dhkem = class {
  constructor(id, prim, kdf) {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 0
    });
    Object.defineProperty(this, "_prim", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.id = id;
    this._prim = prim;
    this._kdf = kdf;
    const suiteId = new Uint8Array(SUITE_ID_HEADER_KEM);
    suiteId.set(i2Osp(this.id, 2), 3);
    this._kdf.init(suiteId);
  }
  async serializePublicKey(key) {
    return await this._prim.serializePublicKey(key);
  }
  async deserializePublicKey(key) {
    return await this._prim.deserializePublicKey(toArrayBuffer(key));
  }
  async serializePrivateKey(key) {
    return await this._prim.serializePrivateKey(key);
  }
  async deserializePrivateKey(key) {
    return await this._prim.deserializePrivateKey(toArrayBuffer(key));
  }
  async importKey(format, key, isPublic = true) {
    return await this._prim.importKey(format, key, isPublic);
  }
  async generateKeyPair() {
    return await this._prim.generateKeyPair();
  }
  async deriveKeyPair(ikm) {
    const rawIkm = toArrayBuffer(ikm);
    if (rawIkm.byteLength > INPUT_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long ikm");
    }
    return await this._prim.deriveKeyPair(rawIkm);
  }
  async encap(params) {
    let ke;
    if (params.ekm === void 0) {
      ke = await this.generateKeyPair();
    } else if (isCryptoKeyPair(params.ekm)) {
      ke = params.ekm;
    } else {
      ke = await this.deriveKeyPair(params.ekm);
    }
    const enc = await this._prim.serializePublicKey(ke.publicKey);
    const pkrm = await this._prim.serializePublicKey(params.recipientPublicKey);
    try {
      let dh;
      if (params.senderKey === void 0) {
        dh = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
      } else {
        const sks = isCryptoKeyPair(params.senderKey) ? params.senderKey.privateKey : params.senderKey;
        const dh1 = new Uint8Array(await this._prim.dh(ke.privateKey, params.recipientPublicKey));
        const dh2 = new Uint8Array(await this._prim.dh(sks, params.recipientPublicKey));
        dh = concat(dh1, dh2);
      }
      let kemContext;
      if (params.senderKey === void 0) {
        kemContext = concat(new Uint8Array(enc), new Uint8Array(pkrm));
      } else {
        const pks = isCryptoKeyPair(params.senderKey) ? params.senderKey.publicKey : await this._prim.derivePublicKey(params.senderKey);
        const pksm = await this._prim.serializePublicKey(pks);
        kemContext = concat3(new Uint8Array(enc), new Uint8Array(pkrm), new Uint8Array(pksm));
      }
      const sharedSecret = await this._generateSharedSecret(dh, kemContext);
      return {
        enc,
        sharedSecret
      };
    } catch (e) {
      throw new EncapError(e);
    }
  }
  async decap(params) {
    const enc = toArrayBuffer(params.enc);
    const pke = await this._prim.deserializePublicKey(enc);
    const skr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.privateKey : params.recipientKey;
    const pkr = isCryptoKeyPair(params.recipientKey) ? params.recipientKey.publicKey : await this._prim.derivePublicKey(params.recipientKey);
    const pkrm = await this._prim.serializePublicKey(pkr);
    try {
      let dh;
      if (params.senderPublicKey === void 0) {
        dh = new Uint8Array(await this._prim.dh(skr, pke));
      } else {
        const dh1 = new Uint8Array(await this._prim.dh(skr, pke));
        const dh2 = new Uint8Array(await this._prim.dh(skr, params.senderPublicKey));
        dh = concat(dh1, dh2);
      }
      let kemContext;
      if (params.senderPublicKey === void 0) {
        kemContext = concat(new Uint8Array(enc), new Uint8Array(pkrm));
      } else {
        const pksm = await this._prim.serializePublicKey(params.senderPublicKey);
        kemContext = new Uint8Array(enc.byteLength + pkrm.byteLength + pksm.byteLength);
        kemContext.set(new Uint8Array(enc), 0);
        kemContext.set(new Uint8Array(pkrm), enc.byteLength);
        kemContext.set(new Uint8Array(pksm), enc.byteLength + pkrm.byteLength);
      }
      return await this._generateSharedSecret(dh, kemContext);
    } catch (e) {
      throw new DecapError(e);
    }
  }
  async _generateSharedSecret(dh, kemContext) {
    const labeledIkm = this._kdf.buildLabeledIkm(LABEL_EAE_PRK, dh);
    const labeledInfo = this._kdf.buildLabeledInfo(LABEL_SHARED_SECRET, kemContext, this.secretSize);
    return await this._kdf.extractAndExpand(EMPTY, labeledIkm, labeledInfo, this.secretSize);
  }
};

// node_modules/@hpke/common/esm/src/interfaces/dhkemPrimitives.js
var KEM_USAGES = ["deriveBits"];
var LABEL_DKP_PRK = /* @__PURE__ */ new Uint8Array([
  100,
  107,
  112,
  95,
  112,
  114,
  107
]);
var LABEL_SK = /* @__PURE__ */ new Uint8Array([115, 107]);

// node_modules/@hpke/common/esm/src/utils/bignum.js
var Bignum = class {
  constructor(size) {
    Object.defineProperty(this, "_num", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this._num = new Uint8Array(size);
  }
  val() {
    return this._num;
  }
  reset() {
    this._num.fill(0);
  }
  set(src) {
    if (src.length !== this._num.length) {
      throw new Error("Bignum.set: invalid argument");
    }
    this._num.set(src);
  }
  isZero() {
    for (let i = 0; i < this._num.length; i++) {
      if (this._num[i] !== 0) {
        return false;
      }
    }
    return true;
  }
  lessThan(v) {
    if (v.length !== this._num.length) {
      throw new Error("Bignum.lessThan: invalid argument");
    }
    for (let i = 0; i < this._num.length; i++) {
      if (this._num[i] < v[i]) {
        return true;
      }
      if (this._num[i] > v[i]) {
        return false;
      }
    }
    return false;
  }
};

// node_modules/@hpke/common/esm/src/kems/dhkemPrimitives/ec.js
var LABEL_CANDIDATE = /* @__PURE__ */ new Uint8Array([
  99,
  97,
  110,
  100,
  105,
  100,
  97,
  116,
  101
]);
var ORDER_P_256 = /* @__PURE__ */ new Uint8Array([
  255,
  255,
  255,
  255,
  0,
  0,
  0,
  0,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  188,
  230,
  250,
  173,
  167,
  23,
  158,
  132,
  243,
  185,
  202,
  194,
  252,
  99,
  37,
  81
]);
var ORDER_P_384 = /* @__PURE__ */ new Uint8Array([
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  199,
  99,
  77,
  129,
  244,
  55,
  45,
  223,
  88,
  26,
  13,
  178,
  72,
  176,
  167,
  122,
  236,
  236,
  25,
  106,
  204,
  197,
  41,
  115
]);
var ORDER_P_521 = /* @__PURE__ */ new Uint8Array([
  1,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  255,
  250,
  81,
  134,
  135,
  131,
  191,
  47,
  150,
  107,
  127,
  204,
  1,
  72,
  247,
  9,
  165,
  208,
  59,
  181,
  201,
  184,
  137,
  156,
  71,
  174,
  187,
  111,
  183,
  30,
  145,
  56,
  100,
  9
]);
var PKCS8_ALG_ID_P_256 = /* @__PURE__ */ new Uint8Array([
  48,
  65,
  2,
  1,
  0,
  48,
  19,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  8,
  42,
  134,
  72,
  206,
  61,
  3,
  1,
  7,
  4,
  39,
  48,
  37,
  2,
  1,
  1,
  4,
  32
]);
var PKCS8_ALG_ID_P_384 = /* @__PURE__ */ new Uint8Array([
  48,
  78,
  2,
  1,
  0,
  48,
  16,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  5,
  43,
  129,
  4,
  0,
  34,
  4,
  55,
  48,
  53,
  2,
  1,
  1,
  4,
  48
]);
var PKCS8_ALG_ID_P_521 = /* @__PURE__ */ new Uint8Array([
  48,
  96,
  2,
  1,
  0,
  48,
  16,
  6,
  7,
  42,
  134,
  72,
  206,
  61,
  2,
  1,
  6,
  5,
  43,
  129,
  4,
  0,
  35,
  4,
  73,
  48,
  71,
  2,
  1,
  1,
  4,
  66
]);
var EC_P_256_PARAMS = {
  p: 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn,
  b: 0x5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604bn,
  gx: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  gy: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  coordinateSize: 32
};
var EC_P_384_PARAMS = {
  p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffeffffffff0000000000000000ffffffffn,
  b: 0xb3312fa7e23ee7e4988e056be3f82d19181d9c6efe8141120314088f5013875ac656398d8a2ed19d2a85c8edd3ec2aefn,
  gx: 0xaa87ca22be8b05378eb1c71ef320ad746e1d3b628ba79b9859f741e082542a385502f25dbf55296c3a545e3872760ab7n,
  gy: 0x3617de4a96262c6f5d9e98bf9292dc29f8f41dbd289a147ce9da3113b5f0b8c00a60b1ce1d7e819d7a431d7c90ea0e5fn,
  coordinateSize: 48
};
var EC_P_521_PARAMS = {
  p: (1n << 521n) - 1n,
  b: 0x0051953eb9618e1c9a1f929a21a0b68540eea2da725b99b315f3b8b489918ef109e156193951ec7e937b1652c0bd3bb1bf073573df883d2c34f1ef451fd46b503f00n,
  gx: 0x00c6858e06b70404e9cd9e3ecb662395b4429c648139053fb521f828af606b4d3dbaa14b5e77efe75928fe1dc127a2ffa8de3348b3c1856a429bf97e7e31c2e5bd66n,
  gy: 0x011839296a789a3bc0045c8a5fb42c7d1bd998f54449579b446817afbd17273e662c97ee72995ef42640c550b9013fad0761353c7086a272c24088be94769fd16650n,
  coordinateSize: 66
};
function mod(a, p) {
  const r = a % p;
  return r >= 0n ? r : r + p;
}
function modPow(base, exponent, p) {
  let result = 1n;
  let b = mod(base, p);
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = mod(result * b, p);
    }
    b = mod(b * b, p);
    e >>= 1n;
  }
  return result;
}
function modSqrt(rhs, p) {
  const y = modPow(rhs, p + 1n >> 2n, p);
  if (mod(y * y, p) !== mod(rhs, p)) {
    throw new Error("Invalid ECDH point");
  }
  return y;
}
function bytesToBigInt(bytes) {
  let v = 0n;
  for (const b of bytes) {
    v = v << 8n | BYTE_TO_BIGINT_256[b];
  }
  return v;
}
function bigIntToBytes(v, len) {
  const out = new Uint8Array(len);
  let n = v;
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) {
    throw new Error("Invalid coordinate length");
  }
  return out;
}
function buildRawUncompressedPublicKey(x, y, coordinateSize) {
  const out = new Uint8Array(1 + coordinateSize * 2);
  out[0] = 4;
  out.set(bigIntToBytes(x, coordinateSize), 1);
  out.set(bigIntToBytes(y, coordinateSize), 1 + coordinateSize);
  return out;
}
var Ec = class extends NativeAlgorithm {
  constructor(kem, hkdf) {
    super();
    Object.defineProperty(this, "_hkdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_alg", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nPk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nSk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nDh", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_order", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_bitmask", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_pkcs8AlgId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_curveParams", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this._hkdf = hkdf;
    switch (kem) {
      case KemId.DhkemP256HkdfSha256:
        this._alg = { name: "ECDH", namedCurve: "P-256" };
        this._nPk = 65;
        this._nSk = 32;
        this._nDh = 32;
        this._order = ORDER_P_256;
        this._bitmask = 255;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_256;
        this._curveParams = EC_P_256_PARAMS;
        break;
      case KemId.DhkemP384HkdfSha384:
        this._alg = { name: "ECDH", namedCurve: "P-384" };
        this._nPk = 97;
        this._nSk = 48;
        this._nDh = 48;
        this._order = ORDER_P_384;
        this._bitmask = 255;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_384;
        this._curveParams = EC_P_384_PARAMS;
        break;
      default:
        this._alg = { name: "ECDH", namedCurve: "P-521" };
        this._nPk = 133;
        this._nSk = 66;
        this._nDh = 66;
        this._order = ORDER_P_521;
        this._bitmask = 1;
        this._pkcs8AlgId = PKCS8_ALG_ID_P_521;
        this._curveParams = EC_P_521_PARAMS;
        break;
    }
  }
  async serializePublicKey(key) {
    await this._setup();
    try {
      return await this._api.exportKey("raw", key);
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePublicKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(toArrayBuffer(key), true);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async serializePrivateKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      if (!("d" in jwk)) {
        throw new Error("Not private key");
      }
      return base64UrlToBytes(jwk["d"]).buffer;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePrivateKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(toArrayBuffer(key), false);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async importKey(format, key, isPublic) {
    await this._setup();
    try {
      if (format === "raw") {
        return await this._importRawKey(key, isPublic);
      }
      if (key instanceof ArrayBuffer) {
        throw new Error("Invalid jwk key format");
      }
      return await this._importJWK(key, isPublic);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async generateKeyPair() {
    await this._setup();
    try {
      return await this._api.generateKey(this._alg, true, KEM_USAGES);
    } catch (e) {
      throw new NotSupportedError(e);
    }
  }
  async deriveKeyPair(ikm) {
    await this._setup();
    try {
      const rawIkm = toArrayBuffer(ikm);
      const dkpPrk = await this._hkdf.labeledExtract(EMPTY, LABEL_DKP_PRK, new Uint8Array(rawIkm));
      const bn = new Bignum(this._nSk);
      for (let counter = 0; bn.isZero() || !bn.lessThan(this._order); counter++) {
        if (counter > 255) {
          throw new Error("Faild to derive a key pair");
        }
        const bytes = new Uint8Array(await this._hkdf.labeledExpand(dkpPrk, LABEL_CANDIDATE, i2Osp(counter, 1), this._nSk));
        bytes[0] = bytes[0] & this._bitmask;
        bn.set(bytes);
      }
      const sk = await this._deserializePkcs8Key(bn.val());
      bn.reset();
      return {
        privateKey: sk,
        publicKey: await this.derivePublicKey(sk)
      };
    } catch (e) {
      throw new DeriveKeyPairError(e);
    }
  }
  async derivePublicKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      delete jwk["d"];
      delete jwk["key_ops"];
      return await this._api.importKey("jwk", jwk, this._alg, true, []);
    } catch {
      try {
        return await this._derivePublicKeyWithoutJwkExport(key);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
  }
  async dh(sk, pk) {
    try {
      await this._setup();
      const bits = await this._api.deriveBits({
        name: "ECDH",
        public: pk
      }, sk, this._nDh * 8);
      return bits;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async _importRawKey(key, isPublic) {
    if (isPublic && key.byteLength !== this._nPk) {
      throw new Error("Invalid public key for the ciphersuite");
    }
    if (!isPublic && key.byteLength !== this._nSk) {
      throw new Error("Invalid private key for the ciphersuite");
    }
    if (isPublic) {
      return await this._api.importKey("raw", key, this._alg, true, []);
    }
    return await this._deserializePkcs8Key(new Uint8Array(key));
  }
  async _importJWK(key, isPublic) {
    if (typeof key.crv === "undefined" || key.crv !== this._alg.namedCurve) {
      throw new Error(`Invalid crv: ${key.crv}`);
    }
    if (isPublic) {
      if (typeof key.d !== "undefined") {
        throw new Error("Invalid key: `d` should not be set");
      }
      return await this._api.importKey("jwk", key, this._alg, true, []);
    }
    if (typeof key.d === "undefined") {
      throw new Error("Invalid key: `d` not found");
    }
    return await this._api.importKey("jwk", key, this._alg, true, KEM_USAGES);
  }
  async _deserializePkcs8Key(k) {
    const pkcs8Key = new Uint8Array(this._pkcs8AlgId.length + k.length);
    pkcs8Key.set(this._pkcs8AlgId, 0);
    pkcs8Key.set(k, this._pkcs8AlgId.length);
    return await this._api.importKey("pkcs8", pkcs8Key, this._alg, true, KEM_USAGES);
  }
  async _derivePublicKeyWithoutJwkExport(key) {
    const basePointRaw = buildRawUncompressedPublicKey(this._curveParams.gx, this._curveParams.gy, this._curveParams.coordinateSize);
    const basePoint = await this._api.importKey("raw", basePointRaw.buffer, this._alg, true, []);
    const xBytes = new Uint8Array(await this._api.deriveBits({
      name: "ECDH",
      public: basePoint
    }, key, this._nDh * 8));
    const p = this._curveParams.p;
    const x = bytesToBigInt(xBytes);
    const rhs = mod(modPow(x, 3n, p) - 3n * x + this._curveParams.b, p);
    let y = modSqrt(rhs, p);
    if ((y & 1n) === 1n) {
      y = p - y;
    }
    const pubRaw = buildRawUncompressedPublicKey(x, y, this._curveParams.coordinateSize);
    return await this._api.importKey("raw", pubRaw.buffer, this._alg, true, []);
  }
};

// node_modules/@hpke/common/esm/src/interfaces/aeadEncryptionContext.js
var AEAD_USAGES = ["encrypt", "decrypt"];

// node_modules/@hpke/common/esm/src/utils/noble.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n, title = "") {
  if (!Number.isSafeInteger(n) || n < 0) {
    const prefix = title && `"${title}" `;
    throw new Error(`${prefix}expected integer >0, got ${n}`);
  }
}
function abytes(value, length, title = "") {
  const bytes = isBytes(value);
  const len = value?.length;
  const needsLen = length !== void 0;
  if (!bytes || needsLen && len !== length) {
    const prefix = title && `"${title}" `;
    const ofLen = needsLen ? ` of length ${length}` : "";
    const got = bytes ? `length=${len}` : `type=${typeof value}`;
    throw new Error(prefix + "expected Uint8Array" + ofLen + ", got " + got);
  }
  return value;
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished) {
    throw new Error("Hash#digest() has already been called");
  }
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
var _endianTestBuffer = /* @__PURE__ */ new Uint32Array([287454020]);
var _endianTestBytes = /* @__PURE__ */ new Uint8Array(_endianTestBuffer.buffer);
var isLE = _endianTestBytes[0] === 68;

// node_modules/@hpke/common/esm/src/hash/hash.js
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function") {
    throw new Error("Hash must wrapped by utils.createHasher");
  }
  anumber(h.outputLen);
  anumber(h.blockLen);
}

// node_modules/@hpke/common/esm/src/hash/hmac.js
var _HMAC = class {
  constructor(hash, key) {
    Object.defineProperty(this, "oHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "iHash", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "blockLen", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "outputLen", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "finished", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false
    });
    Object.defineProperty(this, "destroyed", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: false
    });
    ahash(hash);
    abytes(key, void 0, "key");
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function") {
      throw new Error("Expected instance of class which extends utils.Hash");
    }
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key.length > blockLen ? hash.create().update(key).digest() : key);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    clean(pad);
  }
  update(buf) {
    aexists(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists(this);
    abytes(out, this.outputLen, "output");
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to ||= Object.create(Object.getPrototypeOf(this), {});
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  clone() {
    return this._cloneInto();
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = (hash, key, message) => new _HMAC(hash, key).update(message).digest();
hmac.create = (hash, key) => new _HMAC(hash, key);

// node_modules/@hpke/common/esm/src/hash/u64.js
var U32_MASK64 = 0xffffffffn;
var _32n = 32n;
function fromBig(n, le = false) {
  if (le) {
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  }
  return {
    h: Number(n >> _32n & U32_MASK64) | 0,
    l: Number(n & U32_MASK64) | 0
  };
}
function split(lst, le = false) {
  const len = lst.length;
  const Ah = new Uint32Array(len);
  const Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}

// node_modules/@hpke/common/esm/src/hash/sha3.js
var _0n = 0n;
var _1n = 1n;
var _2n = 2n;
var _7n = 7n;
var _256n = 256n;
var _0x71n = 0x71n;
var SHA3_PI = [];
var SHA3_ROTL = [];
var _SHA3_IOTA = [];
for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
  [x, y] = [y, (2 * x + 3 * y) % 5];
  SHA3_PI.push(2 * (5 * y + x));
  SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
  let t = _0n;
  for (let j = 0; j < 7; j++) {
    R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
    if (R & _2n)
      t ^= _1n << (_1n << BigInt(j)) - _1n;
  }
  _SHA3_IOTA.push(t);
}
var IOTAS = split(_SHA3_IOTA, true);
var SHA3_IOTA_H = IOTAS[0];
var SHA3_IOTA_L = IOTAS[1];

// node_modules/@hpke/common/esm/src/curve/modular.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */

// node_modules/@hpke/common/esm/src/curve/montgomery.js
/*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) */

// node_modules/@hpke/core/esm/src/aeads/aesGcm.js
var AesGcmContext = class extends NativeAlgorithm {
  constructor(key) {
    super();
    Object.defineProperty(this, "_rawKey", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_key", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this._rawKey = toArrayBuffer(key);
  }
  async seal(iv, data, aad) {
    await this._setupKey();
    const alg = {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad)
    };
    const ct = await this._api.encrypt(alg, this._key, toArrayBuffer(data));
    return ct;
  }
  async open(iv, data, aad) {
    await this._setupKey();
    const alg = {
      name: "AES-GCM",
      iv: toArrayBuffer(iv),
      additionalData: toArrayBuffer(aad)
    };
    const pt = await this._api.decrypt(alg, this._key, toArrayBuffer(data));
    return pt;
  }
  async _setupKey() {
    if (this._key !== void 0) {
      return;
    }
    await this._setup();
    const key = await this._importKey(this._rawKey);
    new Uint8Array(this._rawKey).fill(0);
    this._key = key;
    return;
  }
  async _importKey(key) {
    return await this._api.importKey("raw", key, { name: "AES-GCM" }, true, AEAD_USAGES);
  }
};
var Aes128Gcm = class {
  constructor() {
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: AeadId.Aes128Gcm
    });
    Object.defineProperty(this, "keySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
    Object.defineProperty(this, "nonceSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 12
    });
    Object.defineProperty(this, "tagSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
  }
  createEncryptionContext(key) {
    return new AesGcmContext(key);
  }
};
var Aes256Gcm = class extends Aes128Gcm {
  constructor() {
    super(...arguments);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: AeadId.Aes256Gcm
    });
    Object.defineProperty(this, "keySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "nonceSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 12
    });
    Object.defineProperty(this, "tagSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 16
    });
  }
};

// node_modules/@hpke/core/esm/src/utils/emitNotSupported.js
function emitNotSupported() {
  return new Promise((_resolve, reject) => {
    reject(new NotSupportedError("Not supported"));
  });
}

// node_modules/@hpke/core/esm/src/exporterContext.js
var LABEL_SEC = new Uint8Array([115, 101, 99]);
var ExporterContextImpl = class {
  constructor(api, kdf, exporterSecret) {
    Object.defineProperty(this, "_api", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "exporterSecret", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this._api = api;
    this._kdf = kdf;
    this.exporterSecret = exporterSecret;
  }
  async seal(_data, _aad) {
    return await emitNotSupported();
  }
  async open(_data, _aad) {
    return await emitNotSupported();
  }
  async export(exporterContext, len) {
    const rawExporterContext = toArrayBuffer(exporterContext);
    if (rawExporterContext.byteLength > INPUT_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long exporter context");
    }
    try {
      return await this._kdf.labeledExpand(this.exporterSecret, LABEL_SEC, new Uint8Array(rawExporterContext), len);
    } catch (e) {
      throw new ExportError(e);
    }
  }
};
var RecipientExporterContextImpl = class extends ExporterContextImpl {
};
var SenderExporterContextImpl = class extends ExporterContextImpl {
  constructor(api, kdf, exporterSecret, enc) {
    super(api, kdf, exporterSecret);
    Object.defineProperty(this, "enc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this.enc = enc;
    return;
  }
};

// node_modules/@hpke/core/esm/src/encryptionContext.js
var EncryptionContextImpl = class extends ExporterContextImpl {
  constructor(api, kdf, params) {
    super(api, kdf, params.exporterSecret);
    Object.defineProperty(this, "_aead", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nK", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nN", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nT", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_ctx", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    if (params.key === void 0 || params.baseNonce === void 0 || params.seq === void 0) {
      throw new Error("Required parameters are missing");
    }
    this._aead = params.aead;
    this._nK = this._aead.keySize;
    this._nN = this._aead.nonceSize;
    this._nT = this._aead.tagSize;
    const key = this._aead.createEncryptionContext(params.key);
    this._ctx = {
      key,
      baseNonce: params.baseNonce,
      seq: params.seq
    };
  }
  computeNonce(k) {
    const seqBytes = i2Osp(k.seq, k.baseNonce.byteLength);
    return xor(k.baseNonce, seqBytes).buffer;
  }
  incrementSeq(k) {
    if (k.seq > Number.MAX_SAFE_INTEGER) {
      throw new MessageLimitReachedError("Message limit reached");
    }
    k.seq += 1;
    return;
  }
};

// node_modules/@hpke/core/esm/src/mutex.js
var __classPrivateFieldGet = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _Mutex_locked;
var Mutex = class {
  constructor() {
    _Mutex_locked.set(this, Promise.resolve());
  }
  async lock() {
    let releaseLock;
    const nextLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    const previousLock = __classPrivateFieldGet(this, _Mutex_locked, "f");
    __classPrivateFieldSet(this, _Mutex_locked, nextLock, "f");
    await previousLock;
    return releaseLock;
  }
};
_Mutex_locked = /* @__PURE__ */ new WeakMap();

// node_modules/@hpke/core/esm/src/recipientContext.js
var __classPrivateFieldGet2 = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet2 = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _RecipientContextImpl_mutex;
var RecipientContextImpl = class extends EncryptionContextImpl {
  constructor() {
    super(...arguments);
    _RecipientContextImpl_mutex.set(this, void 0);
  }
  async open(data, aad = EMPTY.buffer) {
    __classPrivateFieldSet2(this, _RecipientContextImpl_mutex, __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f") ?? new Mutex(), "f");
    const release = await __classPrivateFieldGet2(this, _RecipientContextImpl_mutex, "f").lock();
    let pt;
    try {
      pt = await this._ctx.key.open(this.computeNonce(this._ctx), toArrayBuffer(data), toArrayBuffer(aad));
    } catch (e) {
      throw new OpenError(e);
    } finally {
      release();
    }
    this.incrementSeq(this._ctx);
    return pt;
  }
};
_RecipientContextImpl_mutex = /* @__PURE__ */ new WeakMap();

// node_modules/@hpke/core/esm/src/senderContext.js
var __classPrivateFieldGet3 = function(receiver, state, kind, f) {
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
  return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
};
var __classPrivateFieldSet3 = function(receiver, state, value, kind, f) {
  if (kind === "m") throw new TypeError("Private method is not writable");
  if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
  if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
  return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
};
var _SenderContextImpl_mutex;
var SenderContextImpl = class extends EncryptionContextImpl {
  constructor(api, kdf, params, enc) {
    super(api, kdf, params);
    Object.defineProperty(this, "enc", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    _SenderContextImpl_mutex.set(this, void 0);
    this.enc = enc;
  }
  async seal(data, aad = EMPTY.buffer) {
    __classPrivateFieldSet3(this, _SenderContextImpl_mutex, __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f") ?? new Mutex(), "f");
    const release = await __classPrivateFieldGet3(this, _SenderContextImpl_mutex, "f").lock();
    let ct;
    try {
      ct = await this._ctx.key.seal(this.computeNonce(this._ctx), toArrayBuffer(data), toArrayBuffer(aad));
    } catch (e) {
      throw new SealError(e);
    } finally {
      release();
    }
    this.incrementSeq(this._ctx);
    return ct;
  }
};
_SenderContextImpl_mutex = /* @__PURE__ */ new WeakMap();

// node_modules/@hpke/core/esm/src/cipherSuiteNative.js
var LABEL_BASE_NONCE = new Uint8Array([
  98,
  97,
  115,
  101,
  95,
  110,
  111,
  110,
  99,
  101
]);
var LABEL_EXP = new Uint8Array([101, 120, 112]);
var LABEL_INFO_HASH = new Uint8Array([
  105,
  110,
  102,
  111,
  95,
  104,
  97,
  115,
  104
]);
var LABEL_KEY = new Uint8Array([107, 101, 121]);
var LABEL_PSK_ID_HASH = new Uint8Array([
  112,
  115,
  107,
  95,
  105,
  100,
  95,
  104,
  97,
  115,
  104
]);
var LABEL_SECRET = new Uint8Array([115, 101, 99, 114, 101, 116]);
var SUITE_ID_HEADER_HPKE = new Uint8Array([
  72,
  80,
  75,
  69,
  0,
  0,
  0,
  0,
  0,
  0
]);
var CipherSuiteNative = class extends NativeAlgorithm {
  /**
   * @param params A set of parameters for building a cipher suite.
   *
   * If the error occurred, throws {@link InvalidParamError}.
   *
   * @throws {@link InvalidParamError}
   */
  constructor(params) {
    super();
    Object.defineProperty(this, "_kem", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_kdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_aead", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_suiteId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    if (typeof params.kem === "number") {
      throw new InvalidParamError("KemId cannot be used");
    }
    this._kem = params.kem;
    if (typeof params.kdf === "number") {
      throw new InvalidParamError("KdfId cannot be used");
    }
    this._kdf = params.kdf;
    if (typeof params.aead === "number") {
      throw new InvalidParamError("AeadId cannot be used");
    }
    this._aead = params.aead;
    this._suiteId = new Uint8Array(SUITE_ID_HEADER_HPKE);
    this._suiteId.set(i2Osp(this._kem.id, 2), 4);
    this._suiteId.set(i2Osp(this._kdf.id, 2), 6);
    this._suiteId.set(i2Osp(this._aead.id, 2), 8);
    this._kdf.init(this._suiteId);
  }
  /**
   * Gets the KEM context of the ciphersuite.
   */
  get kem() {
    return this._kem;
  }
  /**
   * Gets the KDF context of the ciphersuite.
   */
  get kdf() {
    return this._kdf;
  }
  /**
   * Gets the AEAD context of the ciphersuite.
   */
  get aead() {
    return this._aead;
  }
  /**
   * Creates an encryption context for a sender.
   *
   * If the error occurred, throws {@link DecapError} | {@link ValidationError}.
   *
   * @param params A set of parameters for the sender encryption context.
   * @returns A sender encryption context.
   * @throws {@link EncapError}, {@link ValidationError}
   */
  async createSenderContext(params) {
    this._validateInputLength(params);
    await this._setup();
    const dh = await this._kem.encap(params);
    let mode;
    if (params.psk !== void 0) {
      mode = params.senderKey !== void 0 ? Mode.AuthPsk : Mode.Psk;
    } else {
      mode = params.senderKey !== void 0 ? Mode.Auth : Mode.Base;
    }
    return await this._keyScheduleS(mode, dh.sharedSecret, dh.enc, params);
  }
  /**
   * Creates an encryption context for a recipient.
   *
   * If the error occurred, throws {@link DecapError}
   * | {@link DeserializeError} | {@link ValidationError}.
   *
   * @param params A set of parameters for the recipient encryption context.
   * @returns A recipient encryption context.
   * @throws {@link DecapError}, {@link DeserializeError}, {@link ValidationError}
   */
  async createRecipientContext(params) {
    this._validateInputLength(params);
    await this._setup();
    const sharedSecret = await this._kem.decap(params);
    let mode;
    if (params.psk !== void 0) {
      mode = params.senderPublicKey !== void 0 ? Mode.AuthPsk : Mode.Psk;
    } else {
      mode = params.senderPublicKey !== void 0 ? Mode.Auth : Mode.Base;
    }
    return await this._keyScheduleR(mode, sharedSecret, params);
  }
  /**
   * Encrypts a message to a recipient.
   *
   * If the error occurred, throws `EncapError` | `MessageLimitReachedError` | `SealError` | `ValidationError`.
   *
   * @param params A set of parameters for building a sender encryption context.
   * @param pt A plain text as bytes to be encrypted.
   * @param aad Additional authenticated data as bytes fed by an application.
   * @returns A cipher text and an encapsulated key as bytes.
   * @throws {@link EncapError}, {@link MessageLimitReachedError}, {@link SealError}, {@link ValidationError}
   */
  async seal(params, pt, aad = EMPTY.buffer) {
    const ctx = await this.createSenderContext(params);
    return {
      ct: await ctx.seal(pt, aad),
      enc: ctx.enc
    };
  }
  /**
   * Decrypts a message from a sender.
   *
   * If the error occurred, throws `DecapError` | `DeserializeError` | `OpenError` | `ValidationError`.
   *
   * @param params A set of parameters for building a recipient encryption context.
   * @param ct An encrypted text as bytes to be decrypted.
   * @param aad Additional authenticated data as bytes fed by an application.
   * @returns A decrypted plain text as bytes.
   * @throws {@link DecapError}, {@link DeserializeError}, {@link OpenError}, {@link ValidationError}
   */
  async open(params, ct, aad = EMPTY.buffer) {
    const ctx = await this.createRecipientContext(params);
    return await ctx.open(ct, aad);
  }
  // private verifyPskInputs(mode: Mode, params: KeyScheduleParams) {
  //   const gotPsk = (params.psk !== undefined);
  //   const gotPskId = (params.psk !== undefined && params.psk.id.byteLength > 0);
  //   if (gotPsk !== gotPskId) {
  //     throw new Error('Inconsistent PSK inputs');
  //   }
  //   if (gotPsk && (mode === Mode.Base || mode === Mode.Auth)) {
  //     throw new Error('PSK input provided when not needed');
  //   }
  //   if (!gotPsk && (mode === Mode.Psk || mode === Mode.AuthPsk)) {
  //     throw new Error('Missing required PSK input');
  //   }
  //   return;
  // }
  async _keySchedule(mode, sharedSecret, params) {
    const pskId = params.psk === void 0 ? EMPTY : toUint8Array(params.psk.id);
    const pskIdHash = await this._kdf.labeledExtract(EMPTY, LABEL_PSK_ID_HASH, pskId);
    const info = params.info === void 0 ? EMPTY : toUint8Array(params.info);
    const infoHash = await this._kdf.labeledExtract(EMPTY, LABEL_INFO_HASH, info);
    const keyScheduleContext = new Uint8Array(1 + pskIdHash.byteLength + infoHash.byteLength);
    keyScheduleContext.set(new Uint8Array([mode]), 0);
    keyScheduleContext.set(new Uint8Array(pskIdHash), 1);
    keyScheduleContext.set(new Uint8Array(infoHash), 1 + pskIdHash.byteLength);
    const psk = params.psk === void 0 ? EMPTY : toUint8Array(params.psk.key);
    const ikm = this._kdf.buildLabeledIkm(LABEL_SECRET, psk);
    const exporterSecretInfo = this._kdf.buildLabeledInfo(LABEL_EXP, keyScheduleContext, this._kdf.hashSize);
    const exporterSecret = await this._kdf.extractAndExpand(sharedSecret, ikm, exporterSecretInfo, this._kdf.hashSize);
    if (this._aead.id === AeadId.ExportOnly) {
      return { aead: this._aead, exporterSecret };
    }
    const keyInfo = this._kdf.buildLabeledInfo(LABEL_KEY, keyScheduleContext, this._aead.keySize);
    const key = await this._kdf.extractAndExpand(sharedSecret, ikm, keyInfo, this._aead.keySize);
    const baseNonceInfo = this._kdf.buildLabeledInfo(LABEL_BASE_NONCE, keyScheduleContext, this._aead.nonceSize);
    const baseNonce = await this._kdf.extractAndExpand(sharedSecret, ikm, baseNonceInfo, this._aead.nonceSize);
    return {
      aead: this._aead,
      exporterSecret,
      key,
      baseNonce: new Uint8Array(baseNonce),
      seq: 0
    };
  }
  async _keyScheduleS(mode, sharedSecret, enc, params) {
    const res = await this._keySchedule(mode, sharedSecret, params);
    if (res.key === void 0) {
      return new SenderExporterContextImpl(this._api, this._kdf, res.exporterSecret, enc);
    }
    return new SenderContextImpl(this._api, this._kdf, res, enc);
  }
  async _keyScheduleR(mode, sharedSecret, params) {
    const res = await this._keySchedule(mode, sharedSecret, params);
    if (res.key === void 0) {
      return new RecipientExporterContextImpl(this._api, this._kdf, res.exporterSecret);
    }
    return new RecipientContextImpl(this._api, this._kdf, res);
  }
  _validateInputLength(params) {
    if (params.info !== void 0 && params.info.byteLength > INFO_LENGTH_LIMIT) {
      throw new InvalidParamError("Too long info");
    }
    if (params.psk !== void 0) {
      if (params.psk.key.byteLength < MINIMUM_PSK_LENGTH) {
        throw new InvalidParamError(`PSK must have at least ${MINIMUM_PSK_LENGTH} bytes`);
      }
      if (params.psk.key.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long psk.key");
      }
      if (params.psk.id.byteLength > INPUT_LENGTH_LIMIT) {
        throw new InvalidParamError("Too long psk.id");
      }
    }
    return;
  }
};

// node_modules/@hpke/core/esm/src/kems/dhkemNative.js
var DhkemP256HkdfSha256Native = class extends Dhkem {
  constructor() {
    const kdf = new HkdfSha256Native();
    const prim = new Ec(KemId.DhkemP256HkdfSha256, kdf);
    super(KemId.DhkemP256HkdfSha256, prim, kdf);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KemId.DhkemP256HkdfSha256
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 65
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 65
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
  }
};
var DhkemP384HkdfSha384Native = class extends Dhkem {
  constructor() {
    const kdf = new HkdfSha384Native();
    const prim = new Ec(KemId.DhkemP384HkdfSha384, kdf);
    super(KemId.DhkemP384HkdfSha384, prim, kdf);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KemId.DhkemP384HkdfSha384
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 48
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 97
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 97
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 48
    });
  }
};
var DhkemP521HkdfSha512Native = class extends Dhkem {
  constructor() {
    const kdf = new HkdfSha512Native();
    const prim = new Ec(KemId.DhkemP521HkdfSha512, kdf);
    super(KemId.DhkemP521HkdfSha512, prim, kdf);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KemId.DhkemP521HkdfSha512
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 64
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 133
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 133
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 64
    });
  }
};

// node_modules/@hpke/core/esm/src/native.js
var CipherSuite = class extends CipherSuiteNative {
};
var DhkemP256HkdfSha256 = class extends DhkemP256HkdfSha256Native {
};
var DhkemP384HkdfSha384 = class extends DhkemP384HkdfSha384Native {
};
var DhkemP521HkdfSha512 = class extends DhkemP521HkdfSha512Native {
};
var HkdfSha256 = class extends HkdfSha256Native {
};
var HkdfSha384 = class extends HkdfSha384Native {
};
var HkdfSha512 = class extends HkdfSha512Native {
};

// node_modules/@hpke/core/esm/src/kems/dhkemPrimitives/x25519.js
var ALG_NAME = "X25519";
var PKCS8_ALG_ID_X25519 = new Uint8Array([
  48,
  46,
  2,
  1,
  0,
  48,
  5,
  6,
  3,
  43,
  101,
  110,
  4,
  34,
  4,
  32
]);
var BASE_POINT_X25519 = /* @__PURE__ */ (() => {
  const p = new Uint8Array(32);
  p[0] = 9;
  return p;
})();
var X25519 = class extends NativeAlgorithm {
  constructor(hkdf) {
    super();
    Object.defineProperty(this, "_hkdf", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_alg", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nPk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nSk", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_nDh", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    Object.defineProperty(this, "_pkcs8AlgId", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: void 0
    });
    this._alg = { name: ALG_NAME };
    this._hkdf = hkdf;
    this._nPk = 32;
    this._nSk = 32;
    this._nDh = 32;
    this._pkcs8AlgId = PKCS8_ALG_ID_X25519;
  }
  async serializePublicKey(key) {
    await this._setup();
    try {
      return await this._api.exportKey("raw", key);
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePublicKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(toArrayBuffer(key), true);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async serializePrivateKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      if (!("d" in jwk)) {
        throw new Error("Not private key");
      }
      return base64UrlToBytes(jwk["d"]).buffer;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async deserializePrivateKey(key) {
    await this._setup();
    try {
      return await this._importRawKey(toArrayBuffer(key), false);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async importKey(format, key, isPublic) {
    await this._setup();
    try {
      if (format === "raw") {
        return await this._importRawKey(key, isPublic);
      }
      if (key instanceof ArrayBuffer) {
        throw new Error("Invalid jwk key format");
      }
      return await this._importJWK(key, isPublic);
    } catch (e) {
      throw new DeserializeError(e);
    }
  }
  async generateKeyPair() {
    await this._setup();
    try {
      return await this._api.generateKey(ALG_NAME, true, KEM_USAGES);
    } catch (e) {
      throw new NotSupportedError(e);
    }
  }
  async deriveKeyPair(ikm) {
    await this._setup();
    try {
      const rawIkm = toArrayBuffer(ikm);
      const dkpPrk = await this._hkdf.labeledExtract(EMPTY, LABEL_DKP_PRK, new Uint8Array(rawIkm));
      const rawSk = await this._hkdf.labeledExpand(dkpPrk, LABEL_SK, EMPTY, this._nSk);
      const rawSkBytes = new Uint8Array(rawSk);
      const sk = await this._deserializePkcs8Key(rawSkBytes);
      rawSkBytes.fill(0);
      return {
        privateKey: sk,
        publicKey: await this.derivePublicKey(sk)
      };
    } catch (e) {
      throw new DeriveKeyPairError(e);
    }
  }
  async derivePublicKey(key) {
    await this._setup();
    try {
      const jwk = await this._api.exportKey("jwk", key);
      delete jwk["d"];
      delete jwk["key_ops"];
      return await this._api.importKey("jwk", jwk, this._alg, true, []);
    } catch {
      try {
        const bp = await this._api.importKey("raw", BASE_POINT_X25519.buffer, this._alg, true, []);
        const bits = await this._api.deriveBits({
          name: ALG_NAME,
          public: bp
        }, key, this._nPk * 8);
        return await this._api.importKey("raw", bits, this._alg, true, []);
      } catch (e) {
        throw new DeserializeError(e);
      }
    }
  }
  async dh(sk, pk) {
    await this._setup();
    try {
      const bits = await this._api.deriveBits({
        name: ALG_NAME,
        public: pk
      }, sk, this._nDh * 8);
      return bits;
    } catch (e) {
      throw new SerializeError(e);
    }
  }
  async _importRawKey(key, isPublic) {
    if (isPublic && key.byteLength !== this._nPk) {
      throw new Error("Invalid public key for the ciphersuite");
    }
    if (!isPublic && key.byteLength !== this._nSk) {
      throw new Error("Invalid private key for the ciphersuite");
    }
    if (isPublic) {
      return await this._api.importKey("raw", key, this._alg, true, []);
    }
    return await this._deserializePkcs8Key(new Uint8Array(key));
  }
  async _importJWK(key, isPublic) {
    if (typeof key.kty === "undefined" || key.kty !== "OKP") {
      throw new Error(`Invalid kty: ${key.crv}`);
    }
    if (typeof key.crv === "undefined" || key.crv !== ALG_NAME) {
      throw new Error(`Invalid crv: ${key.crv}`);
    }
    if (isPublic) {
      if (typeof key.d !== "undefined") {
        throw new Error("Invalid key: `d` should not be set");
      }
      return await this._api.importKey("jwk", key, this._alg, true, []);
    }
    if (typeof key.d === "undefined") {
      throw new Error("Invalid key: `d` not found");
    }
    return await this._api.importKey("jwk", key, this._alg, true, KEM_USAGES);
  }
  async _deserializePkcs8Key(k) {
    const pkcs8Key = new Uint8Array(this._pkcs8AlgId.length + k.length);
    pkcs8Key.set(this._pkcs8AlgId, 0);
    pkcs8Key.set(k, this._pkcs8AlgId.length);
    return await this._api.importKey("pkcs8", pkcs8Key, this._alg, true, KEM_USAGES);
  }
};

// node_modules/@hpke/core/esm/src/kems/dhkemX25519.js
var DhkemX25519HkdfSha256 = class extends Dhkem {
  constructor() {
    const kdf = new HkdfSha256Native();
    super(KemId.DhkemX25519HkdfSha256, new X25519(kdf), kdf);
    Object.defineProperty(this, "id", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: KemId.DhkemX25519HkdfSha256
    });
    Object.defineProperty(this, "secretSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "encSize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "publicKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
    Object.defineProperty(this, "privateKeySize", {
      enumerable: true,
      configurable: true,
      writable: true,
      value: 32
    });
  }
};

// node_modules/@hpke/core/esm/src/kems/dhkemPrimitives/x448.js
var PKCS8_ALG_ID_X448 = new Uint8Array([
  48,
  70,
  2,
  1,
  0,
  48,
  5,
  6,
  3,
  43,
  101,
  111,
  4,
  58,
  4,
  56
]);

// node_modules/ts-mls/dist/src/crypto/implementation/hpke.js
var hpke_exports2 = {};
__export(hpke_exports2, {
  makeGenericHpke: () => makeGenericHpke
});
async function makeGenericHpke(hpkealg, aead, cs) {
  return {
    async open(privateKey, kemOutput, ciphertext, info, aad) {
      try {
        const result = await cs.open({ recipientKey: privateKey, enc: bytesToArrayBuffer(kemOutput), info: bytesToArrayBuffer(info) }, bytesToArrayBuffer(ciphertext), aad ? bytesToArrayBuffer(aad) : new ArrayBuffer());
        return new Uint8Array(result);
      } catch (e) {
        throw new CryptoError(`${e}`);
      }
    },
    async seal(publicKey, plaintext, info, aad) {
      const result = await cs.seal({ recipientPublicKey: publicKey, info: bytesToArrayBuffer(info) }, bytesToArrayBuffer(plaintext), aad ? bytesToArrayBuffer(aad) : new ArrayBuffer());
      return {
        ct: new Uint8Array(result.ct),
        enc: new Uint8Array(result.enc)
      };
    },
    async exportSecret(publicKey, exporterContext, length, info) {
      const context = await cs.createSenderContext({ recipientPublicKey: publicKey, info: bytesToArrayBuffer(info) });
      return {
        enc: new Uint8Array(context.enc),
        secret: new Uint8Array(await context.export(bytesToArrayBuffer(exporterContext), length))
      };
    },
    async importSecret(privateKey, exporterContext, kemOutput, length, info) {
      try {
        const context = await cs.createRecipientContext({
          recipientKey: privateKey,
          info: bytesToArrayBuffer(info),
          enc: bytesToArrayBuffer(kemOutput)
        });
        return new Uint8Array(await context.export(bytesToArrayBuffer(exporterContext), length));
      } catch (e) {
        throw new CryptoError(`${e}`);
      }
    },
    async importPrivateKey(k) {
      try {
        const key = hpkealg.kem === "DHKEM-P521-HKDF-SHA512" ? prepadPrivateKeyP521(k) : k;
        return await cs.kem.deserializePrivateKey(bytesToArrayBuffer(key));
      } catch (e) {
        throw new CryptoError(`${e}`);
      }
    },
    async importPublicKey(k) {
      try {
        return await cs.kem.deserializePublicKey(bytesToArrayBuffer(k));
      } catch (e) {
        throw new CryptoError(`${e}`);
      }
    },
    async exportPublicKey(k) {
      return new Uint8Array(await cs.kem.serializePublicKey(k));
    },
    async exportPrivateKey(k) {
      return new Uint8Array(await cs.kem.serializePrivateKey(k));
    },
    async encryptAead(key, nonce, aad, plaintext) {
      return aead.encrypt(key, nonce, aad ? aad : new Uint8Array(), plaintext);
    },
    async decryptAead(key, nonce, aad, ciphertext) {
      try {
        return await aead.decrypt(key, nonce, aad ? aad : new Uint8Array(), ciphertext);
      } catch (e) {
        throw new CryptoError(`${e}`);
      }
    },
    async deriveKeyPair(ikm) {
      const kp = await cs.kem.deriveKeyPair(bytesToArrayBuffer(ikm));
      return { privateKey: kp.privateKey, publicKey: kp.publicKey };
    },
    async generateKeyPair() {
      const kp = await cs.kem.generateKeyPair();
      return { privateKey: kp.privateKey, publicKey: kp.publicKey };
    },
    keyLength: cs.aead.keySize,
    nonceLength: cs.aead.nonceSize
  };
}
function prepadPrivateKeyP521(k) {
  const lengthDifference = 66 - k.byteLength;
  return concatUint8Arrays(new Uint8Array(lengthDifference), k);
}

// node_modules/ts-mls/dist/src/crypto/implementation/default/makeAead.js
var makeAead_exports = {};
__export(makeAead_exports, {
  makeAead: () => makeAead
});
async function makeAead(aeadAlg) {
  switch (aeadAlg) {
    case "AES128GCM":
      return [
        {
          encrypt(key, nonce, aad, plaintext) {
            return encryptAesGcm(key, nonce, aad, plaintext);
          },
          decrypt(key, nonce, aad, ciphertext) {
            return decryptAesGcm(key, nonce, aad, ciphertext);
          }
        },
        new Aes128Gcm()
      ];
    case "AES256GCM":
      return [
        {
          encrypt(key, nonce, aad, plaintext) {
            return encryptAesGcm(key, nonce, aad, plaintext);
          },
          decrypt(key, nonce, aad, ciphertext) {
            return decryptAesGcm(key, nonce, aad, ciphertext);
          }
        },
        new Aes256Gcm()
      ];
    case "CHACHA20POLY1305":
      try {
        const { Chacha20Poly1305 } = await Promise.resolve().then(() => __toESM(require_chacha20poly1305(), 1));
        const { chacha20poly1305 } = await Promise.resolve().then(() => __toESM(require_chacha(), 1));
        return [
          {
            async encrypt(key, nonce, aad, plaintext) {
              return chacha20poly1305(key, nonce, aad).encrypt(plaintext);
            },
            async decrypt(key, nonce, aad, ciphertext) {
              return chacha20poly1305(key, nonce, aad).decrypt(ciphertext);
            }
          },
          new Chacha20Poly1305()
        ];
      } catch (err) {
        throw new DependencyError("Optional dependency '@hpke/chacha20poly1305' is not installed. Please install it to use this feature.");
      }
  }
}
async function encryptAesGcm(key, nonce, aad, plaintext) {
  const cryptoKey = await crypto.subtle.importKey("raw", toBufferSource(key), { name: "AES-GCM" }, false, ["encrypt"]);
  const params = {
    name: "AES-GCM",
    iv: toBufferSource(nonce)
  };
  if (aad.length > 0) {
    params.additionalData = toBufferSource(aad);
  }
  const result = await crypto.subtle.encrypt(params, cryptoKey, toBufferSource(plaintext));
  return new Uint8Array(result);
}
async function decryptAesGcm(key, nonce, aad, ciphertext) {
  const cryptoKey = await crypto.subtle.importKey("raw", toBufferSource(key), { name: "AES-GCM" }, false, ["decrypt"]);
  const params = {
    name: "AES-GCM",
    iv: toBufferSource(nonce)
  };
  if (aad.length > 0) {
    params.additionalData = toBufferSource(aad);
  }
  const result = await crypto.subtle.decrypt(params, cryptoKey, toBufferSource(ciphertext));
  return new Uint8Array(result);
}

// node_modules/ts-mls/dist/src/crypto/implementation/default/makeKdfImpl.js
function makeKdfImpl(k) {
  return {
    async extract(salt, ikm) {
      const result = await k.extract(bytesToArrayBuffer(salt), bytesToArrayBuffer(ikm));
      return new Uint8Array(result);
    },
    async expand(prk, info, len) {
      const result = await k.expand(bytesToArrayBuffer(prk), bytesToArrayBuffer(info), len);
      return new Uint8Array(result);
    },
    size: k.hashSize
  };
}
function makeKdf(kdfAlg) {
  switch (kdfAlg) {
    case "HKDF-SHA256":
      return new HkdfSha256();
    case "HKDF-SHA384":
      return new HkdfSha384();
    case "HKDF-SHA512":
      return new HkdfSha512();
  }
}

// node_modules/ts-mls/dist/src/crypto/implementation/default/makeDhKem.js
async function makeDhKem(kemAlg) {
  switch (kemAlg) {
    case "DHKEM-P256-HKDF-SHA256":
      return new DhkemP256HkdfSha256();
    case "DHKEM-X25519-HKDF-SHA256":
      return new DhkemX25519HkdfSha256();
    case "DHKEM-X448-HKDF-SHA512": {
      try {
        const { DhkemX448HkdfSha512: DhkemX448HkdfSha5122 } = await Promise.resolve().then(() => __toESM(require_dhkem_x448(), 1));
        return new DhkemX448HkdfSha5122();
      } catch (err) {
        throw new DependencyError("Optional dependency '@hpke/dhkem-x448' is not installed. Please install it to use this feature.");
      }
    }
    case "DHKEM-P521-HKDF-SHA512":
      return new DhkemP521HkdfSha512();
    case "DHKEM-P384-HKDF-SHA384":
      return new DhkemP384HkdfSha384();
    case "ML-KEM-512":
      try {
        const { MlKem512 } = await Promise.resolve().then(() => __toESM(require_ml_kem(), 1));
        return new MlKem512();
      } catch (err) {
        throw new DependencyError("Optional dependency '@hpke/ml-kem' is not installed. Please install it to use this feature.");
      }
    case "ML-KEM-768":
      try {
        const { MlKem768 } = await Promise.resolve().then(() => __toESM(require_ml_kem(), 1));
        return new MlKem768();
      } catch (err) {
        throw new DependencyError("Optional dependency '@hpke/ml-kem' is not installed. Please install it to use this feature.");
      }
    case "ML-KEM-1024":
      try {
        const { MlKem1024 } = await Promise.resolve().then(() => __toESM(require_ml_kem(), 1));
        return new MlKem1024();
      } catch (err) {
        throw new DependencyError("Optional dependency '@hpke/ml-kem' is not installed. Please install it to use this feature.");
      }
    case "X-Wing":
      try {
        const { XWing } = await Promise.resolve().then(() => __toESM(require_hybridkem_x_wing(), 1));
        return new XWing();
      } catch (err) {
        throw new DependencyError("Optional dependency '@hpke/hybridkem-x-wing' is not installed. Please install it to use this feature.");
      }
  }
}

// node_modules/ts-mls/dist/src/crypto/implementation/default/makeHpke.js
async function makeHpke(hpkealg) {
  const [aead, aeadInterface] = await makeAead(hpkealg.aead);
  const cs = new CipherSuite({
    kem: await makeDhKem(hpkealg.kem),
    kdf: makeKdf(hpkealg.kdf),
    aead: aeadInterface
  });
  return makeGenericHpke(hpkealg, aead, cs);
}

// node_modules/ts-mls/dist/src/crypto/implementation/default/rng.js
var defaultRng = {
  randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }
};

// node_modules/ts-mls/dist/src/crypto/implementation/default/makeNobleSignatureImpl.js
function rawEd25519ToPKCS8(rawKey) {
  const oid = new Uint8Array([6, 3, 43, 101, 112]);
  const innerOctetString = new Uint8Array([4, 32, ...rawKey]);
  const privateKeyField = new Uint8Array([4, 34, ...innerOctetString]);
  const algorithmSeq = new Uint8Array([48, 5, ...oid]);
  const version = new Uint8Array([2, 1, 0]);
  const content = new Uint8Array([...version, ...algorithmSeq, ...privateKeyField]);
  return new Uint8Array([48, content.length, ...content]);
}
async function makeNobleSignatureImpl(alg) {
  switch (alg) {
    case "Ed25519": {
      const subtle = globalThis.crypto?.subtle;
      if (subtle !== void 0) {
        return {
          async sign(signKey, message) {
            const keyData = signKey.length === 32 ? rawEd25519ToPKCS8(signKey) : signKey;
            const key = await subtle.importKey("pkcs8", toBufferSource(keyData), "Ed25519", false, ["sign"]);
            const sig = await subtle.sign("Ed25519", key, toBufferSource(message));
            return new Uint8Array(sig);
          },
          async verify(publicKey, message, signature) {
            const key = await subtle.importKey("raw", toBufferSource(publicKey), "Ed25519", false, ["verify"]);
            return subtle.verify("Ed25519", key, toBufferSource(signature), toBufferSource(message));
          },
          async keygen() {
            const keyPair = await subtle.generateKey("Ed25519", true, ["sign", "verify"]);
            const publicKeyBuffer = await subtle.exportKey("raw", keyPair.publicKey);
            const privateKeyBuffer = await subtle.exportKey("pkcs8", keyPair.privateKey);
            const publicKey = new Uint8Array(publicKeyBuffer);
            const signKey = new Uint8Array(privateKeyBuffer);
            return { signKey, publicKey };
          }
        };
      }
      try {
        const { ed25519 } = await import("../noble-curves/ed25519.js");
        return {
          async sign(signKey, message) {
            return ed25519.sign(message, signKey);
          },
          async verify(publicKey, message, signature) {
            return ed25519.verify(signature, message, publicKey);
          },
          async keygen() {
            const signKey = ed25519.utils.randomSecretKey();
            return { signKey, publicKey: ed25519.getPublicKey(signKey) };
          }
        };
      } catch (err) {
        throw new DependencyError("Optional dependency '@noble/curves' is not installed. Please install it to use this feature.");
      }
    }
    case "Ed448":
      try {
        const { ed448 } = await Promise.resolve().then(() => __toESM(require_ed448(), 1));
        return {
          async sign(signKey, message) {
            return ed448.sign(message, signKey);
          },
          async verify(publicKey, message, signature) {
            return ed448.verify(signature, message, publicKey);
          },
          async keygen() {
            const signKey = ed448.utils.randomSecretKey();
            return { signKey, publicKey: ed448.getPublicKey(signKey) };
          }
        };
      } catch (err) {
        throw new DependencyError("Optional dependency '@noble/curves' is not installed. Please install it to use this feature.");
      }
    case "P256":
      try {
        const { p256 } = await Promise.resolve().then(() => __toESM(require_nist(), 1));
        return {
          async sign(signKey, message) {
            return p256.sign(message, signKey, { prehash: true, format: "der", lowS: false });
          },
          async verify(publicKey, message, signature) {
            return p256.verify(signature, message, publicKey, { prehash: true, format: "der", lowS: false });
          },
          async keygen() {
            const signKey = p256.utils.randomSecretKey();
            return { signKey, publicKey: p256.getPublicKey(signKey) };
          }
        };
      } catch (err) {
        throw new DependencyError("Optional dependency '@noble/curves' is not installed. Please install it to use this feature.");
      }
    case "P384":
      try {
        const { p384 } = await Promise.resolve().then(() => __toESM(require_nist(), 1));
        return {
          async sign(signKey, message) {
            return p384.sign(message, signKey, { prehash: true, format: "der", lowS: false });
          },
          async verify(publicKey, message, signature) {
            return p384.verify(signature, message, publicKey, { prehash: true, format: "der", lowS: false });
          },
          async keygen() {
            const signKey = p384.utils.randomSecretKey();
            return { signKey, publicKey: p384.getPublicKey(signKey) };
          }
        };
      } catch (err) {
        throw new DependencyError("Optional dependency '@noble/curves' is not installed. Please install it to use this feature.");
      }
    case "P521":
      try {
        const { p521 } = await Promise.resolve().then(() => __toESM(require_nist(), 1));
        return {
          async sign(signKey, message) {
            return p521.sign(message, signKey, { prehash: true, format: "der", lowS: false });
          },
          async verify(publicKey, message, signature) {
            return p521.verify(signature, message, publicKey, { prehash: true, format: "der", lowS: false });
          },
          async keygen() {
            const signKey = p521.utils.randomSecretKey();
            return { signKey, publicKey: p521.getPublicKey(signKey) };
          }
        };
      } catch (err) {
        throw new DependencyError("Optional dependency '@noble/curves' is not installed. Please install it to use this feature.");
      }
    case "ML-DSA-87":
      try {
        const { ml_dsa87 } = await Promise.resolve().then(() => __toESM(require_ml_dsa(), 1));
        return {
          async sign(signKey, message) {
            return ml_dsa87.sign(message, signKey);
          },
          async verify(publicKey, message, signature) {
            return ml_dsa87.verify(signature, message, publicKey);
          },
          async keygen() {
            const keys = ml_dsa87.keygen(crypto.getRandomValues(new Uint8Array(32)));
            return { signKey: keys.secretKey, publicKey: keys.publicKey };
          }
        };
      } catch (err) {
        throw new DependencyError("Optional dependency '@noble/post-quantum' is not installed. Please install it to use this feature.");
      }
  }
}

// node_modules/ts-mls/dist/src/crypto/implementation/default/provider.js
var defaultCryptoProvider = {
  async getCiphersuiteImpl(cs) {
    const sc = crypto.subtle;
    return {
      kdf: makeKdfImpl(makeKdf(cs.hpke.kdf)),
      hash: makeHashImpl(sc, cs.hash),
      signature: await makeNobleSignatureImpl(cs.signature),
      hpke: await makeHpke(cs.hpke),
      rng: defaultRng,
      name: cs.name
    };
  }
};

// node_modules/ts-mls/dist/src/crypto/getCiphersuiteImpl.js
async function getCiphersuiteImpl(cs, provider = defaultCryptoProvider) {
  return provider.getCiphersuiteImpl(cs);
}

// node_modules/ts-mls/dist/src/resumption.js
async function reinitGroup(state, groupId, version, cipherSuite, extensions, cs) {
  const reinitProposal = {
    proposalType: "reinit",
    reinit: {
      groupId,
      version,
      cipherSuite,
      extensions
    }
  };
  return createCommit({
    state,
    pskIndex: makePskIndex(state, {}),
    cipherSuite: cs
  }, {
    extraProposals: [reinitProposal]
  });
}
async function reinitCreateNewGroup(state, keyPackage, privateKeyPackage, memberKeyPackages, groupId, cipherSuite, extensions, provider = defaultCryptoProvider) {
  const cs = await getCiphersuiteImpl(getCiphersuiteFromName(cipherSuite), provider);
  const newGroup = await createGroup(groupId, keyPackage, privateKeyPackage, extensions, cs);
  const addProposals = memberKeyPackages.map((kp) => ({
    proposalType: "add",
    add: { keyPackage: kp }
  }));
  const psk = makeResumptionPsk(state, "reinit", cs);
  const resumptionPsk = {
    proposalType: "psk",
    psk: {
      preSharedKeyId: psk.id
    }
  };
  return createCommit({
    state: newGroup,
    pskIndex: makePskIndex(state, {}),
    cipherSuite: cs
  }, {
    extraProposals: [...addProposals, resumptionPsk]
  });
}
function makeResumptionPsk(state, usage, cs) {
  const secret = state.keySchedule.resumptionPsk;
  const pskNonce = cs.rng.randomBytes(cs.kdf.size);
  const psk = {
    pskEpoch: state.groupContext.epoch,
    pskGroupId: state.groupContext.groupId,
    psktype: "resumption",
    pskNonce,
    usage
  };
  return { id: psk, secret };
}
async function branchGroup(state, keyPackage, privateKeyPackage, memberKeyPackages, newGroupId, cs) {
  const resumptionPsk = makeResumptionPsk(state, "branch", cs);
  const pskSearch = makePskIndex(state, {});
  const newGroup = await createGroup(newGroupId, keyPackage, privateKeyPackage, state.groupContext.extensions, cs);
  const addMemberProposals = memberKeyPackages.map((kp) => ({
    proposalType: "add",
    add: {
      keyPackage: kp
    }
  }));
  const branchPskProposal = {
    proposalType: "psk",
    psk: {
      preSharedKeyId: resumptionPsk.id
    }
  };
  return createCommit({
    state: newGroup,
    pskIndex: pskSearch,
    cipherSuite: cs
  }, {
    extraProposals: [...addMemberProposals, branchPskProposal]
  });
}
async function joinGroupFromBranch(oldState, welcome, keyPackage, privateKeyPackage, ratchetTree, cs) {
  const pskSearch = makePskIndex(oldState, {});
  return await joinGroup(welcome, keyPackage, privateKeyPackage, pskSearch, cs, ratchetTree, oldState);
}
async function joinGroupFromReinit(suspendedState, welcome, keyPackage, privateKeyPackage, ratchetTree, provider = defaultCryptoProvider) {
  const pskSearch = makePskIndex(suspendedState, {});
  if (suspendedState.groupActiveState.kind !== "suspendedPendingReinit")
    throw new UsageError("Cannot reinit because no init proposal found in last commit");
  const cs = await getCiphersuiteImpl(getCiphersuiteFromName(suspendedState.groupActiveState.reinit.cipherSuite), provider);
  return await joinGroup(welcome, keyPackage, privateKeyPackage, pskSearch, cs, ratchetTree, suspendedState);
}

// node_modules/ts-mls/dist/src/message.js
var message_exports = {};
__export(message_exports, {
  decodeMlsMessage: () => decodeMlsMessage,
  decodeMlsMessageContent: () => decodeMlsMessageContent,
  encodeMlsGroupInfo: () => encodeMlsGroupInfo,
  encodeMlsKeyPackage: () => encodeMlsKeyPackage,
  encodeMlsMessage: () => encodeMlsMessage,
  encodeMlsMessageContent: () => encodeMlsMessageContent,
  encodeMlsPrivateMessage: () => encodeMlsPrivateMessage,
  encodeMlsPublicMessage: () => encodeMlsPublicMessage,
  encodeMlsWelcome: () => encodeMlsWelcome,
  mlsGroupInfoEncoder: () => mlsGroupInfoEncoder,
  mlsKeyPackageEncoder: () => mlsKeyPackageEncoder,
  mlsMessageContentEncoder: () => mlsMessageContentEncoder,
  mlsMessageEncoder: () => mlsMessageEncoder,
  mlsPrivateMessageEncoder: () => mlsPrivateMessageEncoder,
  mlsPublicMessageEncoder: () => mlsPublicMessageEncoder,
  mlsWelcomeEncoder: () => mlsWelcomeEncoder
});
var mlsPublicMessageEncoder = contramapBufferEncoders([wireformatEncoder, publicMessageEncoder], (msg) => [msg.wireformat, msg.publicMessage]);
var encodeMlsPublicMessage = encode(mlsPublicMessageEncoder);
var mlsWelcomeEncoder = contramapBufferEncoders([wireformatEncoder, welcomeEncoder], (wm) => [wm.wireformat, wm.welcome]);
var encodeMlsWelcome = encode(mlsWelcomeEncoder);
var mlsPrivateMessageEncoder = contramapBufferEncoders([wireformatEncoder, privateMessageEncoder], (pm) => [pm.wireformat, pm.privateMessage]);
var encodeMlsPrivateMessage = encode(mlsPrivateMessageEncoder);
var mlsGroupInfoEncoder = contramapBufferEncoders([wireformatEncoder, groupInfoEncoder], (gi) => [gi.wireformat, gi.groupInfo]);
var encodeMlsGroupInfo = encode(mlsGroupInfoEncoder);
var mlsKeyPackageEncoder = contramapBufferEncoders([wireformatEncoder, keyPackageEncoder], (kp) => [kp.wireformat, kp.keyPackage]);
var encodeMlsKeyPackage = encode(mlsKeyPackageEncoder);
var mlsMessageContentEncoder = (mc) => {
  switch (mc.wireformat) {
    case "mls_public_message":
      return mlsPublicMessageEncoder(mc);
    case "mls_welcome":
      return mlsWelcomeEncoder(mc);
    case "mls_private_message":
      return mlsPrivateMessageEncoder(mc);
    case "mls_group_info":
      return mlsGroupInfoEncoder(mc);
    case "mls_key_package":
      return mlsKeyPackageEncoder(mc);
  }
};
var encodeMlsMessageContent = encode(mlsMessageContentEncoder);
var decodeMlsMessageContent = flatMapDecoder(decodeWireformat, (wireformat) => {
  switch (wireformat) {
    case "mls_public_message":
      return mapDecoder(decodePublicMessage, (publicMessage) => ({ wireformat, publicMessage }));
    case "mls_welcome":
      return mapDecoder(decodeWelcome, (welcome) => ({ wireformat, welcome }));
    case "mls_private_message":
      return mapDecoder(decodePrivateMessage, (privateMessage) => ({ wireformat, privateMessage }));
    case "mls_group_info":
      return mapDecoder(decodeGroupInfo, (groupInfo) => ({ wireformat, groupInfo }));
    case "mls_key_package":
      return mapDecoder(decodeKeyPackage, (keyPackage) => ({ wireformat, keyPackage }));
  }
});
var mlsMessageEncoder = contramapBufferEncoders([protocolVersionEncoder, mlsMessageContentEncoder], (w) => [w.version, w]);
var encodeMlsMessage = encode(mlsMessageEncoder);
var decodeMlsMessage = mapDecoders([decodeProtocolVersion, decodeMlsMessageContent], (version, mc) => ({ ...mc, version }));

// node_modules/ts-mls/dist/src/defaultCapabilities.js
var defaultCapabilities_exports = {};
__export(defaultCapabilities_exports, {
  defaultCapabilities: () => defaultCapabilities
});

// node_modules/ts-mls/dist/src/grease.js
var greaseValues = [
  2570,
  6682,
  10794,
  14906,
  19018,
  23130,
  27242,
  31354,
  35466,
  39578,
  43690,
  47802,
  51914,
  56026,
  60138
];
var defaultGreaseConfig = {
  probabilityPerGreaseValue: 0.1
};
function grease(greaseConfig) {
  return greaseValues.filter(() => greaseConfig.probabilityPerGreaseValue > Math.random());
}
function greaseCiphersuites(greaseConfig) {
  return grease(greaseConfig).map((n) => n.toString());
}
function greaseCredentials(greaseConfig) {
  return grease(greaseConfig).map((n) => n.toString());
}
function greaseCapabilities(config, capabilities) {
  return {
    ciphersuites: [...capabilities.ciphersuites, ...greaseCiphersuites(config)],
    credentials: [...capabilities.credentials, ...greaseCredentials(config)],
    extensions: [...capabilities.extensions, ...grease(config)],
    proposals: [...capabilities.proposals, ...grease(config)],
    versions: capabilities.versions
  };
}

// node_modules/ts-mls/dist/src/defaultCapabilities.js
function defaultCapabilities() {
  return greaseCapabilities(defaultGreaseConfig, {
    versions: ["mls10"],
    ciphersuites: Object.keys(ciphersuites),
    extensions: [],
    proposals: [],
    credentials: ["basic", "x509"]
  });
}

// entry.js
var hpke = Object.freeze({ CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes128Gcm });
var internals = Object.freeze({
  "authenticatedContent.js": authenticatedContent_exports,
  "clientState.js": clientState_exports,
  "codec/tlsDecoder.js": tlsDecoder_exports,
  "codec/tlsEncoder.js": tlsEncoder_exports,
  "codec/variableLength.js": variableLength_exports,
  "commit.js": commit_exports,
  "createCommit.js": createCommit_exports,
  "crypto/ciphersuite.js": ciphersuite_exports,
  "crypto/getCiphersuiteImpl.js": getCiphersuiteImpl_exports,
  "crypto/hash.js": hash_exports,
  "crypto/hpke.js": hpke_exports,
  "crypto/kdf.js": kdf_exports,
  "crypto/signature.js": signature_exports,
  "crypto/implementation/hpke.js": hpke_exports2,
  "crypto/implementation/default/makeAead.js": makeAead_exports,
  "crypto/implementation/default/makeHpke.js": makeHpke_exports,
  "defaultCapabilities.js": defaultCapabilities_exports,
  "framedContent.js": framedContent_exports,
  "groupContext.js": groupContext_exports,
  "groupInfo.js": groupInfo_exports,
  "groupSecrets.js": groupSecrets_exports,
  "keyPackage.js": keyPackage_exports,
  "keyRetentionConfig.js": keyRetentionConfig_exports,
  "keySchedule.js": keySchedule_exports,
  "leafNode.js": leafNode_exports,
  "message.js": message_exports,
  "messageProtection.js": messageProtection_exports,
  "messageProtectionPublic.js": messageProtectionPublic_exports,
  "mlsError.js": mlsError_exports,
  "paddingConfig.js": paddingConfig_exports,
  "parentHash.js": parentHash_exports,
  "pathSecrets.js": pathSecrets_exports,
  "presharedkey.js": presharedkey_exports,
  "privateKeyPath.js": privateKeyPath_exports,
  "processMessages.js": processMessages_exports,
  "proposal.js": proposal_exports,
  "ratchetTree.js": ratchetTree_exports,
  "secretTree.js": secretTree_exports,
  "sender.js": sender_exports,
  "transcriptHash.js": transcriptHash_exports,
  "treeHash.js": treeHash_exports,
  "treemath.js": treemath_exports,
  "updatePath.js": updatePath_exports,
  "util/byteArray.js": byteArray_exports,
  "util/constantTimeCompare.js": constantTimeCompare_exports,
  "welcome.js": welcome_exports
});
export {
  CodecError,
  CryptoError,
  CryptoVerificationError,
  DependencyError,
  InternalError,
  MlsError,
  UsageError,
  ValidationError,
  acceptAll,
  branchGroup,
  bytesToBase64,
  ciphersuites,
  contentTypes,
  createApplicationMessage,
  createCommit,
  createGroup,
  createGroupInfoWithExternalPub,
  createGroupInfoWithExternalPubAndRatchetTree,
  createProposal,
  credentialTypes,
  decodeExternalSender,
  decodeGroupState,
  decodeMlsMessage,
  decodeRequiredCapabilities,
  defaultAuthenticationService,
  defaultCapabilities,
  defaultCryptoProvider,
  defaultExtensionTypes,
  defaultKeyPackageEqualityConfig,
  defaultKeyRetentionConfig,
  defaultLifetime,
  defaultLifetimeConfig,
  defaultPaddingConfig,
  defaultProposalTypes,
  emptyPskIndex,
  encodeExternalSender,
  encodeGroupState,
  encodeMlsMessage,
  encodeRequiredCapabilities,
  generateKeyPackage,
  generateKeyPackageWithKey,
  getCiphersuiteFromName,
  getCiphersuiteImpl,
  hpke,
  internals,
  joinGroup,
  joinGroupExternal,
  joinGroupFromBranch,
  joinGroupFromReinit,
  joinGroupWithExtensions,
  makePskIndex,
  mlsExporter,
  processMessage,
  processPrivateMessage,
  processPublicMessage,
  proposeAddExternal,
  proposeExternal,
  protocolVersions,
  reinitCreateNewGroup,
  reinitGroup,
  resumptionPSKUsages,
  senderTypes,
  zeroOutUint8Array
};
