#!/usr/bin/env python3
"""The web app's own ChaCha20-Poly1305 (used for wallet backups) against the RFC 8439 test vectors.
Runs anywhere with plain Python: python3 tests/crypto_test.py
"""
import os, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "app"))
import server  # noqa: E402


def h(s):
    return bytes.fromhex("".join(s.split()).replace(":", ""))


def check(name, cond):
    print(("ok   " if cond else "FAIL ") + name)
    if not cond:
        sys.exit(1)


# RFC 8439 2.3.2: the ChaCha20 block function
key = bytes(range(32))
block = server.chacha20_block(key, 1, h("00:00:00:09:00:00:00:4a:00:00:00:00"))
check("ChaCha20 block function (RFC 8439 2.3.2)", block == h("""
    10 f1 e7 e4 d1 3b 59 15 50 0f dd 1f a3 20 71 c4 c7 d1 f4 c7 33 c0 68 03 04 22 aa 9a c3 d4 6c 4e
    d2 82 64 46 07 9f aa 09 14 c2 d7 05 d9 8b 02 a2 b5 12 9c d1 de 16 4e b9 cb d0 83 e8 a2 50 3c 4e"""))

# RFC 8439 2.4.2: the ChaCha20 cipher ("Ladies and Gentlemen..." under the same key, counter 1)
sunscreen = (b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, "
             b"sunscreen would be it.")
ct = server.chacha20_xor(key, 1, h("00:00:00:00:00:00:00:4a:00:00:00:00"), sunscreen)
check("ChaCha20 encryption (RFC 8439 2.4.2)", ct == h("""
    6e 2e 35 9a 25 68 f9 80 41 ba 07 28 dd 0d 69 81 e9 7e 7a ec 1d 43 60 c2 0a 27 af cc fd 9f ae 0b
    f9 1b 65 c5 52 47 33 ab 8f 59 3d ab cd 62 b3 57 16 39 d6 24 e6 51 52 ab 8f 53 0c 35 9f 08 61 d8
    07 ca 0d bf 50 0d 6a 61 56 a3 8e 08 8a 22 b6 5e 52 bc 51 4d 16 cc f8 06 81 8c e9 1a b7 79 37 36
    5a f9 0b bf 74 a3 5b e6 b4 0b 8e ed f2 78 5e 42 87 4d"""))

# RFC 8439 2.5.2: Poly1305
tag = server.poly1305(h("85:d6:be:78:57:55:6d:33:7f:44:52:fe:42:d5:06:a8:01:03:80:8a:fb:0d:b2:fd:4a:bf:f6:af:41:49:f5:1b"),
                      b"Cryptographic Forum Research Group")
check("Poly1305 (RFC 8439 2.5.2)", tag == h("a8:06:1d:c1:30:51:36:c6:c2:2b:8b:af:0c:01:27:a9"))

# RFC 8439 2.8.2: AEAD_CHACHA20_POLY1305
akey = bytes(range(0x80, 0xa0))
nonce = h("07 00 00 00 40 41 42 43 44 45 46 47")
aad = h("50 51 52 53 c0 c1 c2 c3 c4 c5 c6 c7")
want = h("""
    d3 1a 8d 34 64 8e 60 db 7b 86 af bc 53 ef 7e c2 a4 ad ed 51 29 6e 08 fe a9 e2 b5 a7 36 ee 62 d6
    3d be a4 5e 8c a9 67 12 82 fa fb 69 da 92 72 8b 1a 71 de 0a 9e 06 0b 29 05 d6 a5 b6 7e cd 3b 36
    92 dd bd 7f 2d 77 8b 8c 98 03 ae e3 28 09 1b 58 fa b3 24 e4 fa d6 75 94 55 85 80 8b 48 31 d7 bc
    3f f4 de f0 8e 4b 7a 9d e5 76 d2 65 86 ce c6 4b 61 16""") + h("1a:e1:0b:59:4f:09:e2:6a:7e:90:2e:cb:d0:60:06:91")
sealed = server.aead_encrypt(akey, nonce, sunscreen, aad)
check("AEAD encryption, ciphertext and tag (RFC 8439 2.8.2)", sealed == want)
check("AEAD decryption gives the plaintext back", server.aead_decrypt(akey, nonce, sealed, aad) == sunscreen)
check("AEAD decryption refuses a changed ciphertext", server.aead_decrypt(akey, nonce, bytes([sealed[0] ^ 1]) + sealed[1:], aad) is None)
check("AEAD decryption refuses a changed tag", server.aead_decrypt(akey, nonce, sealed[:-1] + bytes([sealed[-1] ^ 1]), aad) is None)
check("AEAD decryption refuses other associated data", server.aead_decrypt(akey, nonce, sealed, aad + b"x") is None)
check("AEAD handles an empty message", server.aead_decrypt(akey, nonce, server.aead_encrypt(akey, nonce, b"", b""), b"") == b"")
print("all checks passed")
