// Entry point for vendor-staging/mls/mls.js, built by tools/mls/build.mjs. Not shipped yet (groups, Stage 1).
//
// 1. The public API of ts-mls 1.6.4 (its dist/src/index.js), minus `nobleCryptoProvider`: that provider imports
//    @noble/ciphers/aes.js, which the app does not vendor. `defaultCryptoProvider` stays.
// 2. The ts-mls error classes, and the @hpke/core classes a custom CryptoProvider needs (as `hpke`).
// 3. `internals`: the ts-mls modules that its RFC 9420 test-vector tests import (test/test-vectors/*.ts and
//    test/crypto/keyMatch.ts at v1.6.4), plus the default provider's building blocks. These are in the bundle
//    anyway; exporting them lets tests/mls/ run the upstream vectors against these exact bytes. App code
//    should not rely on them.
// The same names as ts-mls's index.js, each from its own module, so index.js (and with it the noble provider) is
// never part of the build.
export { defaultProposalTypes } from "ts-mls/defaultProposalType.js";
export { defaultExtensionTypes } from "ts-mls/defaultExtensionType.js";
export { acceptAll } from "ts-mls/incomingMessageAction.js";
export { proposeAddExternal, proposeExternal } from "ts-mls/externalProposal.js";
export { decodeExternalSender, encodeExternalSender } from "ts-mls/externalSender.js";
export { decodeRequiredCapabilities, encodeRequiredCapabilities, } from "ts-mls/requiredCapabilities.js";
export { defaultAuthenticationService } from "ts-mls/authenticationService.js";
export { defaultPaddingConfig } from "ts-mls/paddingConfig.js";
export { defaultKeyPackageEqualityConfig } from "ts-mls/keyPackageEqualityConfig.js";
export { defaultLifetimeConfig } from "ts-mls/lifetimeConfig.js";
export { generateKeyPackage, generateKeyPackageWithKey } from "ts-mls/keyPackage.js";
export { defaultKeyRetentionConfig } from "ts-mls/keyRetentionConfig.js";
export { createGroup, makePskIndex, joinGroup, joinGroupWithExtensions, decodeGroupState, encodeGroupState, } from "ts-mls/clientState.js";
export { createApplicationMessage, createProposal } from "ts-mls/createMessage.js";
export { zeroOutUint8Array } from "ts-mls/util/byteArray.js";
export { joinGroupExternal, createCommit, createGroupInfoWithExternalPub, createGroupInfoWithExternalPubAndRatchetTree, } from "ts-mls/createCommit.js";
export { processPrivateMessage, processMessage, processPublicMessage, } from "ts-mls/processMessages.js";
export { emptyPskIndex } from "ts-mls/pskIndex.js";
export { joinGroupFromReinit, reinitCreateNewGroup, reinitGroup, joinGroupFromBranch, branchGroup, } from "ts-mls/resumption.js";
export { mlsExporter } from "ts-mls/keySchedule.js";
export { ciphersuites, getCiphersuiteFromName, } from "ts-mls/crypto/ciphersuite.js";
export { getCiphersuiteImpl } from "ts-mls/crypto/getCiphersuiteImpl.js";
export { defaultCryptoProvider } from "ts-mls/crypto/implementation/default/provider.js";
export { bytesToBase64 } from "ts-mls/util/byteArray.js";
export { decodeMlsMessage, encodeMlsMessage, } from "ts-mls/message.js";
export { defaultLifetime } from "ts-mls/lifetime.js";
export { defaultCapabilities } from "ts-mls/defaultCapabilities.js";
export { contentTypes } from "ts-mls/contentType.js";
export { credentialTypes } from "ts-mls/credentialType.js";
export { protocolVersions } from "ts-mls/protocolVersion.js";
export { senderTypes, } from "ts-mls/sender.js";
export { resumptionPSKUsages } from "ts-mls/presharedkey.js";

export {
  MlsError,
  ValidationError,
  CodecError,
  UsageError,
  DependencyError,
  CryptoVerificationError,
  CryptoError,
  InternalError,
} from "ts-mls/mlsError.js";

import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes128Gcm } from "@hpke/core";
export const hpke = Object.freeze({ CipherSuite, DhkemX25519HkdfSha256, HkdfSha256, Aes128Gcm });

import * as authenticatedContent from "ts-mls/authenticatedContent.js";
import * as clientState from "ts-mls/clientState.js";
import * as tlsDecoder from "ts-mls/codec/tlsDecoder.js";
import * as tlsEncoder from "ts-mls/codec/tlsEncoder.js";
import * as variableLength from "ts-mls/codec/variableLength.js";
import * as commit from "ts-mls/commit.js";
import * as createCommit from "ts-mls/createCommit.js";
import * as ciphersuite from "ts-mls/crypto/ciphersuite.js";
import * as getCiphersuiteImpl from "ts-mls/crypto/getCiphersuiteImpl.js";
import * as hash from "ts-mls/crypto/hash.js";
import * as hpkeMod from "ts-mls/crypto/hpke.js";
import * as kdf from "ts-mls/crypto/kdf.js";
import * as signature from "ts-mls/crypto/signature.js";
import * as genericHpke from "ts-mls/crypto/implementation/hpke.js";
import * as defaultMakeAead from "ts-mls/crypto/implementation/default/makeAead.js";
import * as defaultMakeHpke from "ts-mls/crypto/implementation/default/makeHpke.js";
import * as defaultCapabilities from "ts-mls/defaultCapabilities.js";
import * as framedContent from "ts-mls/framedContent.js";
import * as groupContext from "ts-mls/groupContext.js";
import * as groupInfo from "ts-mls/groupInfo.js";
import * as groupSecrets from "ts-mls/groupSecrets.js";
import * as keyPackage from "ts-mls/keyPackage.js";
import * as keyRetentionConfig from "ts-mls/keyRetentionConfig.js";
import * as keySchedule from "ts-mls/keySchedule.js";
import * as leafNode from "ts-mls/leafNode.js";
import * as message from "ts-mls/message.js";
import * as messageProtection from "ts-mls/messageProtection.js";
import * as messageProtectionPublic from "ts-mls/messageProtectionPublic.js";
import * as mlsError from "ts-mls/mlsError.js";
import * as paddingConfig from "ts-mls/paddingConfig.js";
import * as parentHash from "ts-mls/parentHash.js";
import * as pathSecrets from "ts-mls/pathSecrets.js";
import * as presharedkey from "ts-mls/presharedkey.js";
import * as privateMessage from "ts-mls/privateMessage.js";
import * as privateKeyPath from "ts-mls/privateKeyPath.js";
import * as processMessages from "ts-mls/processMessages.js";
import * as proposal from "ts-mls/proposal.js";
import * as ratchetTree from "ts-mls/ratchetTree.js";
import * as secretTree from "ts-mls/secretTree.js";
import * as sender from "ts-mls/sender.js";
import * as transcriptHash from "ts-mls/transcriptHash.js";
import * as treeHash from "ts-mls/treeHash.js";
import * as treemath from "ts-mls/treemath.js";
import * as updatePath from "ts-mls/updatePath.js";
import * as byteArray from "ts-mls/util/byteArray.js";
import * as constantTimeCompare from "ts-mls/util/constantTimeCompare.js";
import * as welcome from "ts-mls/welcome.js";

export const internals = Object.freeze({
  "authenticatedContent.js": authenticatedContent,
  "clientState.js": clientState,
  "codec/tlsDecoder.js": tlsDecoder,
  "codec/tlsEncoder.js": tlsEncoder,
  "codec/variableLength.js": variableLength,
  "commit.js": commit,
  "createCommit.js": createCommit,
  "crypto/ciphersuite.js": ciphersuite,
  "crypto/getCiphersuiteImpl.js": getCiphersuiteImpl,
  "crypto/hash.js": hash,
  "crypto/hpke.js": hpkeMod,
  "crypto/kdf.js": kdf,
  "crypto/signature.js": signature,
  "crypto/implementation/hpke.js": genericHpke,
  "crypto/implementation/default/makeAead.js": defaultMakeAead,
  "crypto/implementation/default/makeHpke.js": defaultMakeHpke,
  "defaultCapabilities.js": defaultCapabilities,
  "framedContent.js": framedContent,
  "groupContext.js": groupContext,
  "groupInfo.js": groupInfo,
  "groupSecrets.js": groupSecrets,
  "keyPackage.js": keyPackage,
  "keyRetentionConfig.js": keyRetentionConfig,
  "keySchedule.js": keySchedule,
  "leafNode.js": leafNode,
  "message.js": message,
  "messageProtection.js": messageProtection,
  "messageProtectionPublic.js": messageProtectionPublic,
  "mlsError.js": mlsError,
  "paddingConfig.js": paddingConfig,
  "parentHash.js": parentHash,
  "pathSecrets.js": pathSecrets,
  "presharedkey.js": presharedkey,
  "privateMessage.js": privateMessage, // decryptSenderData: who sent an application message (groups.js)
  "privateKeyPath.js": privateKeyPath,
  "processMessages.js": processMessages,
  "proposal.js": proposal,
  "ratchetTree.js": ratchetTree,
  "secretTree.js": secretTree,
  "sender.js": sender,
  "transcriptHash.js": transcriptHash,
  "treeHash.js": treeHash,
  "treemath.js": treemath,
  "updatePath.js": updatePath,
  "util/byteArray.js": byteArray,
  "util/constantTimeCompare.js": constantTimeCompare,
  "welcome.js": welcome,
});
