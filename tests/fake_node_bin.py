#!/usr/bin/env python3
# A stand-in for logos-blockchain-node in the tests: --check-config and --show-config read the
# keystore.yaml beside the config, the way the real node takes its keys from it.
import os, re, sys

args = list(sys.argv[1:])
if "--deployment" in args:
    i = args.index("--deployment"); del args[i:i + 2]
flag, cfg = args[0], args[1]
try:
    text = open(os.path.join(os.path.dirname(os.path.abspath(cfg)), "keystore.yaml")).read()
    pub = dict(re.findall(r"^  (\w+): ([0-9a-f]{64})$", text.split("secret_keys:")[0], re.M))
    assert pub.get("LeaderFunding") and pub.get("SdpFunding")
except Exception:
    print("bad keystore", file=sys.stderr); sys.exit(1)
if flag == "--check-config":
    print("Configs are valid!"); sys.exit(0)
zk = [v for k, v in pub.items() if k not in ("BlendSigning", "NetworkSwarm")]
print("cryptarchia:\n  leader:\n    wallet:\n      funding_pk: %s\nsdp:\n  wallet:\n    funding_pk: %s\nkms:\n  keystore: keystore.yaml\nwallet:\n  known_keys:"
      % (pub["LeaderFunding"], pub["SdpFunding"]))
for k in zk:
    print("    %s: %s" % (k, k))
