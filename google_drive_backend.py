"""Google Drive backend — OAuth, import, upload, and streaming."""
import json
import os
import time
from pathlib import Path
from urllib.parse import urlencode

import requests

BASE = Path(__file__).resolve().parent
GDRIVE_DIR = Path(os.environ.get("HUB_GDRIVE_DIR", BASE))
CONFIG_PATH = GDRIVE_DIR / "gdrive_config.json"
TOKEN_PATH = GDRIVE_DIR / "gdrive_token.json"

SCOPES = "https://www.googleapis.com/auth/drive"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files"
DRIVE_UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files"


class GoogleDriveBackend:
    key = "drive"
    label = "Google Drive"
    streams = True

    @property
    def enabled(self) -> bool:
        if not CONFIG_PATH.exists() or not TOKEN_PATH.exists():
            return False
        try:
            tok = json.loads(TOKEN_PATH.read_text(encoding="utf-8"))
            return bool(tok.get("refresh_token") or tok.get("access_token"))
        except Exception:
            return False

    def get_config(self) -> dict:
        if not CONFIG_PATH.exists():
            return {}
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))

    def save_config(self, client_id: str, client_secret: str):
        CONFIG_PATH.write_text(
            json.dumps({"client_id": client_id.strip(), "client_secret": client_secret.strip()}, indent=2),
            encoding="utf-8",
        )

    def build_auth_url(self, redirect_uri: str) -> str:
        cfg = self.get_config()
        if not cfg.get("client_id") or not cfg.get("client_secret"):
            raise ValueError("Enter Google Client ID and Client Secret first")
        params = {
            "client_id": cfg["client_id"],
            "redirect_uri": redirect_uri,
            "response_type": "code",
            "scope": SCOPES,
            "access_type": "offline",
            "prompt": "consent",
        }
        return f"{AUTH_URL}?{urlencode(params)}"

    def exchange_code(self, code: str, redirect_uri: str):
        cfg = self.get_config()
        res = requests.post(
            TOKEN_URL,
            data={
                "code": code,
                "client_id": cfg["client_id"],
                "client_secret": cfg["client_secret"],
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
            timeout=20,
        )
        data = res.json()
        if not res.ok or "access_token" not in data:
            raise RuntimeError(data.get("error_description") or data.get("error") or "Google authorization failed")
        data["expires_at"] = time.time() + int(data.get("expires_in", 3600)) - 60
        TOKEN_PATH.write_text(json.dumps(data, indent=2), encoding="utf-8")

    def _access_token(self) -> str:
        if not TOKEN_PATH.exists():
            raise RuntimeError("Google Drive is not connected")
        tok = json.loads(TOKEN_PATH.read_text(encoding="utf-8"))
        if tok.get("access_token") and time.time() < tok.get("expires_at", 0):
            return tok["access_token"]

        refresh = tok.get("refresh_token")
        if not refresh:
            raise RuntimeError("Google Drive session expired, please reconnect")

        cfg = self.get_config()
        res = requests.post(
            TOKEN_URL,
            data={
                "client_id": cfg["client_id"],
                "client_secret": cfg["client_secret"],
                "refresh_token": refresh,
                "grant_type": "refresh_token",
            },
            timeout=20,
        )
        new_data = res.json()
        if not res.ok or "access_token" not in new_data:
            raise RuntimeError("Failed to refresh Google token")
        tok["access_token"] = new_data["access_token"]
        tok["expires_at"] = time.time() + int(new_data.get("expires_in", 3600)) - 60
        TOKEN_PATH.write_text(json.dumps(tok, indent=2), encoding="utf-8")
        return tok["access_token"]

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._access_token()}"}

    def list_files(self, limit: int = 200) -> list[dict]:
        params = {
            "pageSize": limit,
            "q": "trashed = false and mimeType != 'application/vnd.google-apps.folder'",
            "fields": "files(id, name, size, mimeType, createdTime)",
            "orderBy": "createdTime desc",
        }
        res = requests.get(DRIVE_FILES_URL, headers=self._headers(), params=params, timeout=25)
        if not res.ok:
            raise RuntimeError(f"Google Drive API: {res.text[:200]}")
        out = []
        for f in res.json().get("files", []):
            mime = f.get("mimeType") or "application/octet-stream"
            if mime.startswith("application/vnd.google-apps."):
                continue
            created = (f.get("createdTime") or "")[:19].replace("T", " ") or "2026-01-01 00:00:00"
            out.append({
                "id": f["id"],
                "name": f["name"],
                "size": int(f.get("size") or 0),
                "mime": mime,
                "date": created,
            })
        return out

    def save(self, file_storage, filename: str):
        meta = json.dumps({"name": filename})
        file_bytes = file_storage.read()
        files = {
            "metadata": ("metadata", meta, "application/json; charset=UTF-8"),
            "file": (filename, file_bytes, file_storage.mimetype or "application/octet-stream"),
        }
        res = requests.post(
            f"{DRIVE_UPLOAD_URL}?uploadType=multipart",
            headers=self._headers(),
            files=files,
            timeout=120,
        )
        if not res.ok:
            raise RuntimeError(f"Google Drive upload: {res.text[:200]}")
        fid = res.json()["id"]
        return fid, len(file_bytes)

    def iter_bytes(self, ref: str, start: int, length: int):
        if length <= 0:
            return
        headers = self._headers()
        headers["Range"] = f"bytes={start}-{start + length - 1}"
        with requests.get(
            f"{DRIVE_FILES_URL}/{ref}",
            headers=headers,
            params={"alt": "media"},
            stream=True,
            timeout=30,
        ) as res:
            if res.status_code not in (200, 206):
                raise RuntimeError(f"Google Drive stream: {res.status_code}")
            for chunk in res.iter_content(chunk_size=1024 * 512):
                if chunk:
                    yield chunk

    def delete(self, ref: str):
        try:
            requests.delete(f"{DRIVE_FILES_URL}/{ref}", headers=self._headers(), timeout=15)
        except Exception:
            pass