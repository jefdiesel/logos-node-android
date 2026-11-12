#!/usr/bin/env python3
"""Opens a Logos node wallet backup (logos-node-wallet-backup-YYYYMMDD.json) and writes the node's key file.

  python3 decrypt-backup.py logos-node-wallet-backup-20261111.json            -> ./keystore.yaml
  python3 decrypt-backup.py backup.json -o /path/to/keystore.yaml
  echo "the password" | python3 decrypt-backup.py backup.json --password-stdin

A version 2 backup also holds this device's messaging key (when messages were on); it is written to
messaging-key.json beside the key file (or --messaging-out).

It does not use the web app's code: the key comes from Python's hashlib.scrypt and the decryption from
the `cryptography` package (pip install cryptography), so a backup can be opened on any computer.
The format is described in docs/backup.md.
"""
import argparse, base64, getpass, hashlib, json, os, sys

FORMAT = "logos-node-wallet-backup"
# version 1: the node's key file; version 2: also this device's messaging key (when it had one)
AADS = {1: b"logos-node-wallet-backup v1", 2: b"logos-node-wallet-backup v2"}


def fail(msg):
    print("error: " + msg, file=sys.stderr)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="Decrypt a Logos node wallet backup into keystore.yaml.")
    ap.add_argument("backup", help="the backup file (.json)")
    ap.add_argument("-o", "--output", default="keystore.yaml", help="where to write the key file (default: ./keystore.yaml)")
    ap.add_argument("--force", action="store_true", help="overwrite the output file if it exists")
    ap.add_argument("--password-stdin", action="store_true", help="read the backup password from the first line of stdin")
    ap.add_argument("--messaging-out", default=None,
                    help="where to write the messaging key, if the backup has one (default: messaging-key.json beside the key file)")
    a = ap.parse_args()
    try:
        from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
        from cryptography.exceptions import InvalidTag
    except ImportError:
        fail("this needs the 'cryptography' package: pip install cryptography")
    try:
        with open(a.backup) as f:
            doc = json.load(f)
        if doc.get("format") != FORMAT or doc.get("version") not in AADS or isinstance(doc.get("version"), bool):
            fail("this is not a %s file of a version this tool knows (%s)" % (FORMAT, ", ".join(map(str, AADS))))
        kdf, cipher = doc["kdf"], doc["cipher"]
        if kdf.get("name") != "scrypt" or cipher.get("name") != "chacha20-poly1305":
            fail("unknown key derivation or cipher in this file")
        salt, nonce, sealed = (base64.b64decode(v) for v in (kdf["salt"], cipher["nonce"], doc["ciphertext"]))
    except (OSError, ValueError, KeyError, TypeError) as e:
        fail("can't read the backup file: %s" % e)
    msg_out = a.messaging_out or os.path.join(os.path.dirname(os.path.abspath(a.output)), "messaging-key.json")
    for path in (a.output, msg_out) if doc["version"] >= 2 else (a.output,):
        if os.path.exists(path) and not a.force:
            fail("%s already exists; move it away or use --force" % path)
    password = sys.stdin.readline().rstrip("\r\n") if a.password_stdin else getpass.getpass("Backup password: ")
    key = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=int(kdf["n"]), r=int(kdf["r"]), p=int(kdf["p"]),
                         dklen=int(kdf["dklen"]), maxmem=2 ** 27)
    try:
        plain = ChaCha20Poly1305(key).decrypt(nonce, sealed, AADS[doc["version"]])
    except InvalidTag:
        fail("wrong password, or the file has been changed or damaged")
    content = json.loads(plain)
    text = content["keystore.yaml"]
    fd = os.open(a.output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(text.encode("utf-8"))
    print("wrote %s (%d bytes). Addresses in this backup:" % (a.output, len(text.encode("utf-8"))))
    msg = content.get("messaging_key") if doc["version"] >= 2 else None
    if msg:
        fd = os.open(msg_out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as f:
            json.dump(msg, f)
        print("wrote %s: this device's messaging key (public %s%s)" % (msg_out, msg.get("public", ""),
                                                                     ", name " + msg["name"] if msg.get("name") else ""))
    for k in doc.get("addresses", []):
        print("  %-8s %s" % (k.get("label", ""), k.get("key", "")))


if __name__ == "__main__":
    main()
