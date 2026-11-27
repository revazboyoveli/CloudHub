"""Cryptographic vault using PBKDF2-HMAC-SHA256 key derivation and AES-256-GCM."""
import json
import os
from pathlib import Path
from typing import Any

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

MAGIC_HEADER = b"CHVAULT1"  # Versioned file signature (8 bytes)
SALT_SIZE = 16              # 128-bit random salt
NONCE_SIZE = 12             # 96-bit standard GCM nonce
KDF_ITERATIONS = 600_000    # OWASP recommended PBKDF2-HMAC-SHA256 iterations


def _get_master_secret() -> bytes:
    """Reads the master secret from environment variables (never stored on disk)."""
    secret = os.environ.get("HUB_SECRET_KEY") or os.environ.get("HUB_PASSWORD")
    if not secret:
        raise RuntimeError(
            "Encryption key missing: set HUB_SECRET_KEY (or HUB_PASSWORD) environment variable before starting."
        )
    return secret.encode("utf-8")


def _derive_key(secret: bytes, salt: bytes) -> bytes:
    """Derives a uniform 256-bit (32-byte) AES key from a human secret + random salt."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=KDF_ITERATIONS,
    )
    return kdf.derive(secret)


def encrypt_json(path: Path, payload: dict[str, Any]) -> None:
    """Serializes dict to JSON and writes an authenticated AES-256-GCM binary envelope."""
    secret = _get_master_secret()
    salt = os.urandom(SALT_SIZE)
    nonce = os.urandom(NONCE_SIZE)
    key = _derive_key(secret, salt)

    plaintext = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    # MAGIC_HEADER is passed as Associated Data (AAD): authenticated, not encrypted
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, associated_data=MAGIC_HEADER)

    envelope = MAGIC_HEADER + salt + nonce + ciphertext
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_bytes(envelope)
    os.replace(tmp_path, path)


def decrypt_json(path: Path) -> dict[str, Any]:
    """Reads an encrypted envelope, verifies integrity tag, and returns the original dict."""
    raw = path.read_bytes()
    header_end = len(MAGIC_HEADER)
    salt_end = header_end + SALT_SIZE
    nonce_end = salt_end + NONCE_SIZE

    if len(raw) <= nonce_end or raw[:header_end] != MAGIC_HEADER:
        raise ValueError("Corrupted or unrecognized encrypted vault format")

    salt = raw[header_end:salt_end]
    nonce = raw[salt_end:nonce_end]
    ciphertext = raw[nonce_end:]

    key = _derive_key(_get_master_secret(), salt)
    try:
        plaintext = AESGCM(key).decrypt(nonce, ciphertext, associated_data=MAGIC_HEADER)
    except InvalidTag as exc:
        raise ValueError("Decryption failed: wrong HUB_SECRET_KEY or file was tampered with") from exc

    return json.loads(plaintext.decode("utf-8"))