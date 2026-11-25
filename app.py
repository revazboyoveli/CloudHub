"""CloudHub: One workspace, multiple storages.

Files are stored in backends (Home Drive, Google Drive, Telegram),
while the folder structure is kept in a single SQLite database (hub.db).
"""
from collections import deque
import hmac
import mimetypes
import os
import random
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import uuid
from pathlib import Path
from urllib.parse import quote

from flask import Flask, Response, abort, g, jsonify, request, send_file, send_from_directory
from werkzeug.exceptions import HTTPException

from telegram_backend import TelegramBackend
from google_drive_backend import GoogleDriveBackend

BASE = Path(__file__).resolve().parent
STORAGE_DIR = Path(os.environ.get("HUB_STORAGE", BASE / "storage")).resolve()
CACHE_DIR = STORAGE_DIR / ".cache"
ORIG_CACHE = CACHE_DIR / "orig"
FAST_CACHE = CACHE_DIR / "fast"
THUMB_CACHE = CACHE_DIR / "thumbs"
DB_PATH = Path(os.environ.get("HUB_DB", BASE / "hub.db")).resolve()
PASSWORD = os.environ.get("HUB_PASSWORD", "")
USER = os.environ.get("HUB_USER", "admin")

app = Flask(__name__, static_folder=None)


def _find_ffmpeg():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg  # type: ignore
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG_BIN = _find_ffmpeg()


# ------------------------------------------------------------------------ Auth
@app.before_request
def require_auth():
    if not PASSWORD:
        return None
    a = request.authorization
    if (
        a
        and hmac.compare_digest((a.username or "").encode(), USER.encode())
        and hmac.compare_digest((a.password or "").encode(), PASSWORD.encode())
    ):
        return None
    return Response("Login required", 401, {"WWW-Authenticate": 'Basic realm="CloudHub"'})


@app.errorhandler(HTTPException)
def http_error(e):
    return jsonify(error=e.description or e.name), e.code


# -------------------------------------------------------------------- Database
SCHEMA = """
CREATE TABLE IF NOT EXISTS folders(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS folders_unique ON folders(COALESCE(parent_id, 0), name);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  folder_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  storage TEXT NOT NULL,        -- local / drive / telegram
  storage_ref TEXT NOT NULL,    -- file reference in that storage
  fingerprint TEXT,             -- name|size|mtime for duplicate detection
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS files_folder ON files(folder_id);
CREATE UNIQUE INDEX IF NOT EXISTS files_fp ON files(fingerprint) WHERE fingerprint IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS files_ref ON files(storage, storage_ref);
"""


def init():
    STORAGE_DIR.mkdir(parents=True, exist_ok=True)
    ORIG_CACHE.mkdir(parents=True, exist_ok=True)
    FAST_CACHE.mkdir(parents=True, exist_ok=True)
    THUMB_CACHE.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(DB_PATH)
    c.execute("PRAGMA journal_mode=WAL")
    c.executescript(SCHEMA)
    c.commit()
    c.close()


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, timeout=30)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys=ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


# -------------------------------------------------------------------- Backends
class Backend:
    key = ""
    label = ""
    enabled = False
    streams = False

    def save(self, file_storage, filename):
        raise NotImplementedError

    def path(self, ref):
        raise NotImplementedError

    def delete(self, ref):
        pass


class LocalBackend(Backend):
    key = "local"
    label = "Home Drive"
    enabled = True

    def save(self, file_storage, filename):
        ext = re.sub(r"[^A-Za-z0-9.]", "", Path(filename).suffix)[:10].lower()
        uid = uuid.uuid4().hex
        ref = f"{uid[:2]}/{uid}{ext}"
        dest = STORAGE_DIR / ref
        dest.parent.mkdir(parents=True, exist_ok=True)
        file_storage.save(dest)
        return ref, dest.stat().st_size

    def path(self, ref):
        p = (STORAGE_DIR / ref).resolve()
        if STORAGE_DIR not in p.parents:
            raise ValueError("Invalid storage reference")
        return p

    def delete(self, ref):
        try:
            self.path(ref).unlink()
        except (FileNotFoundError, ValueError):
            pass


class PlannedBackend(Backend):
    def __init__(self, key, label):
        self.key, self.label = key, label


BACKENDS = {
    "local": LocalBackend(),
    "drive": GoogleDriveBackend(),
    "telegram": TelegramBackend(),
}


# --------------------------------------------- Background Video Cache & 480p
_QUEUE_LOCK = threading.Lock()
_VIDEO_QUEUE = deque()
_QUEUED_IDS = set()
_WORKER_STARTED = False


def _fast_path(fid: int) -> Path:
    return FAST_CACHE / f"{fid}.mp4"


def _orig_cache_path(fid: int) -> Path:
    return ORIG_CACHE / f"{fid}.bin"


def _thumb_path(fid: int) -> Path:
    return THUMB_CACHE / f"{fid}.jpg"


def _cleanup_video_cache(fid: int):
    for p in (_fast_path(fid), _orig_cache_path(fid), _thumb_path(fid)):
        try:
            p.unlink()
        except FileNotFoundError:
            pass


def queue_video_prep(fid: int, priority: bool = False):
    """Caches video on local SSD in the background and prepares a lightweight 480p fast stream."""
    global _WORKER_STARTED
    if _fast_path(fid).exists():
        return
    with _QUEUE_LOCK:
        if fid in _QUEUED_IDS:
            if priority and fid in _VIDEO_QUEUE:
                _VIDEO_QUEUE.remove(fid)
                _VIDEO_QUEUE.appendleft(fid)
            return
        _QUEUED_IDS.add(fid)
        if priority:
            _VIDEO_QUEUE.appendleft(fid)
        else:
            _VIDEO_QUEUE.append(fid)
        if not _WORKER_STARTED:
            _WORKER_STARTED = True
            threading.Thread(target=_video_prep_worker, daemon=True, name="video-prep").start()


def _video_prep_worker():
    while True:
        with _QUEUE_LOCK:
            if not _VIDEO_QUEUE:
                fid = None
            else:
                fid = _VIDEO_QUEUE.popleft()
        if fid is None:
            threading.Event().wait(0.5)
            continue
        try:
            _process_single_video(fid)
        except Exception as exc:  # noqa: BLE001
            print(f"[video-prep] #{fid} error: {exc}")
        finally:
            with _QUEUE_LOCK:
                _QUEUED_IDS.discard(fid)


def _process_single_video(fid: int):
    if _fast_path(fid).exists():
        return
    c = sqlite3.connect(DB_PATH, timeout=30)
    c.row_factory = sqlite3.Row
    row = c.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
    c.close()
    if not row or not (row["mime"] or "").startswith("video/"):
        return

    b = BACKENDS.get(row["storage"])
    if not b or not b.enabled:
        return

    if b.streams:
        orig_file = _orig_cache_path(fid)
        if not orig_file.exists():
            part_orig = ORIG_CACHE / f"{fid}.{uuid.uuid4().hex[:6]}.part"
            try:
                with open(part_orig, "wb") as out:
                    for chunk in b.iter_bytes(row["storage_ref"], 0, row["size"] or 0):
                        out.write(chunk)
                os.replace(part_orig, orig_file)
            finally:
                if part_orig.exists():
                    part_orig.unlink(missing_ok=True)
    else:
        orig_file = b.path(row["storage_ref"])

    if not FFMPEG_BIN or not orig_file.exists():
        return

    part_fast = FAST_CACHE / f"{fid}.{uuid.uuid4().hex[:6]}.mp4"
    try:
        cmd = [
            FFMPEG_BIN,
            "-y",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            str(orig_file),
            "-vf",
            "scale='min(854,iw)':-2",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-crf",
            "28",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            str(part_fast),
        ]
        subprocess.run(cmd, check=True, timeout=600)
        os.replace(part_fast, _fast_path(fid))
    finally:
        if part_fast.exists():
            part_fast.unlink(missing_ok=True)


# --------------------------------------------------------------------- Helpers
def clean_name(name):
    name = (name or "").replace("\\", "/").split("/")[-1].strip()
    return name or "file"


def folder_exists(db, fid):
    return fid is None or db.execute("SELECT 1 FROM folders WHERE id=?", (fid,)).fetchone() is not None


def ensure_path(db, path):
    parent = None
    for part in [p.strip() for p in path.split("/") if p.strip()]:
        row = db.execute("SELECT id FROM folders WHERE parent_id IS ? AND name=?", (parent, part)).fetchone()
        if row:
            parent = row["id"]
        else:
            parent = db.execute("INSERT INTO folders(parent_id, name) VALUES(?, ?)", (parent, part)).lastrowid
    db.commit()
    return parent


def descendant_ids(db, fid):
    rows = db.execute(
        "WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT f.id FROM folders f JOIN t ON f.parent_id=t.id) "
        "SELECT id FROM t",
        (fid,),
    )
    return [r["id"] for r in rows]


# ----------------------------------------------------------------------- Pages
@app.get("/")
def index():
    return send_from_directory(BASE / "static", "index.html")


@app.get("/api/storages")
def api_storages():
    return jsonify([{"key": b.key, "label": b.label, "enabled": b.enabled} for b in BACKENDS.values()])


# --------------------------------------------------------------------- Folders
@app.get("/api/list")
def api_list():
    db = get_db()
    fid = request.args.get("folder", type=int)
    if not folder_exists(db, fid):
        abort(404, "Folder not found")
    folders = [
        dict(r)
        for r in db.execute(
            "SELECT f.id, f.name,"
            " (SELECT COUNT(*) FROM files x WHERE x.folder_id=f.id) AS files,"
            " (SELECT COUNT(*) FROM folders y WHERE y.parent_id=f.id) AS folders"
            " FROM folders f WHERE f.parent_id IS ? ORDER BY f.name COLLATE NOCASE",
            (fid,),
        )
    ]
    files = [
        dict(r)
        for r in db.execute(
            "SELECT id, folder_id, name, size, mime, storage, created_at FROM files"
            " WHERE folder_id IS ? ORDER BY name COLLATE NOCASE",
            (fid,),
        )
    ]

    crumbs, cur = [], fid
    while cur:
        r = db.execute("SELECT id, parent_id, name FROM folders WHERE id=?", (cur,)).fetchone()
        if not r:
            break
        crumbs.append({"id": r["id"], "name": r["name"]})
        cur = r["parent_id"]
    crumbs.reverse()
    return jsonify(folder=fid, breadcrumb=crumbs, folders=folders, files=files)


@app.get("/api/folders/all")
def api_folders_all():
    rows = {r["id"]: dict(r) for r in get_db().execute("SELECT id, parent_id, name FROM folders")}

    def path(r):
        parts = []
        while r:
            parts.append(r["name"])
            r = rows.get(r["parent_id"])
        return " / ".join(reversed(parts))

    out = [{"id": r["id"], "path": path(r)} for r in rows.values()]
    out.sort(key=lambda x: x["path"].lower())
    return jsonify(out)


@app.post("/api/folders")
def api_folder_create():
    db = get_db()
    data = request.get_json(silent=True) or {}
    name = clean_name(data.get("name"))
    parent = data.get("parent_id")
    if not folder_exists(db, parent):
        abort(404, "Parent folder not found")
    try:
        fid = db.execute("INSERT INTO folders(parent_id, name) VALUES(?, ?)", (parent, name)).lastrowid
    except sqlite3.IntegrityError:
        abort(409, "A folder with this name already exists")
    db.commit()
    return jsonify(id=fid), 201


@app.patch("/api/folders/<int:fid>")
def api_folder_update(fid):
    db = get_db()
    data = request.get_json(silent=True) or {}
    row = db.execute("SELECT * FROM folders WHERE id=?", (fid,)).fetchone()
    if not row:
        abort(404)
    name = clean_name(data["name"]) if "name" in data else row["name"]
    parent = data["parent_id"] if "parent_id" in data else row["parent_id"]
    if not folder_exists(db, parent):
        abort(404, "Parent folder not found")
    if parent is not None and parent in descendant_ids(db, fid):
        abort(400, "Cannot move a folder inside itself")
    try:
        db.execute("UPDATE folders SET name=?, parent_id=? WHERE id=?", (name, parent, fid))
    except sqlite3.IntegrityError:
        abort(409, "A folder with this name already exists")
    db.commit()
    return jsonify(ok=True)


@app.delete("/api/folders/<int:fid>")
def api_folder_delete(fid):
    db = get_db()
    if not folder_exists(db, fid):
        abort(404)
    ids = descendant_ids(db, fid)
    q = ",".join("?" * len(ids))
    for r in db.execute(f"SELECT id, storage, storage_ref FROM files WHERE folder_id IN ({q})", ids).fetchall():
        _cleanup_video_cache(r["id"])
        b = BACKENDS.get(r["storage"])
        if b and b.enabled:
            b.delete(r["storage_ref"])
    db.execute("DELETE FROM folders WHERE id=?", (fid,))
    db.commit()
    return jsonify(ok=True)


# ----------------------------------------------------------------------- Files
@app.post("/api/upload")
def api_upload():
    db = get_db()
    backend = BACKENDS.get(request.form.get("storage", "local"))
    if not backend or not backend.enabled:
        abort(400, "This storage backend is not enabled")
    f = request.files.get("file")
    if not f:
        abort(400, "No file uploaded")

    fp = request.form.get("fingerprint") or None
    if fp and db.execute("SELECT 1 FROM files WHERE fingerprint=?", (fp,)).fetchone():
        return jsonify(status="duplicate")

    folder_id = request.form.get("folder_id", type=int)
    folder_path = request.form.get("folder_path", "").strip()
    if folder_path:
        folder_id = ensure_path(db, folder_path)
    elif not folder_exists(db, folder_id):
        abort(404, "Folder not found")

    name = clean_name(f.filename)
    try:
        ref, size = backend.save(f, name)
    except ValueError as e:
        abort(400, str(e))
    except Exception as e:  # noqa: BLE001
        abort(502, f"{backend.label}: {e}")
    mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
    try:
        cur = db.execute(
            "INSERT INTO files(folder_id, name, size, mime, storage, storage_ref, fingerprint)"
            " VALUES(?, ?, ?, ?, ?, ?, ?)",
            (folder_id, name, size, mime, backend.key, ref, fp),
        )
    except sqlite3.IntegrityError:
        backend.delete(ref)
        return jsonify(status="duplicate")
    db.commit()
    if mime.startswith("video/"):
        queue_video_prep(cur.lastrowid, priority=False)
    return jsonify(status="ok", id=cur.lastrowid), 201


@app.get("/api/files/<int:fid>/stream-status")
def api_file_stream_status(fid):
    r = get_db().execute("SELECT id, mime FROM files WHERE id=?", (fid,)).fetchone()
    if not r:
        abort(404)
    is_video = (r["mime"] or "").startswith("video/")
    fast_ready = _fast_path(fid).exists()
    orig_cached = _orig_cache_path(fid).exists()
    if is_video and not fast_ready:
        queue_video_prep(fid, priority=True)
    return jsonify(
        fast_ready=fast_ready,
        orig_cached=orig_cached,
        ffmpeg_available=bool(FFMPEG_BIN),
    )


def stream_response(row, backend):
    """Streams non-local files with HTTP Range support."""
    size = row["size"] or 0
    start, end, status = 0, size - 1, 200
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", request.headers.get("Range", "").strip())
    if m and (m.group(1) or m.group(2)) and size:
        s, e = m.groups()
        if s == "":
            start = max(0, size - int(e))
        else:
            start = int(s)
            if e != "":
                end = min(end, int(e))
        if start > end or start >= size:
            return Response(status=416, headers={"Content-Range": f"bytes */{size}"})
        status = 206
    length = max(0, end - start + 1)
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(length)}
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    if request.args.get("download"):
        headers["Content-Disposition"] = "attachment; filename*=UTF-8''" + quote(row["name"])
    body = backend.iter_bytes(row["storage_ref"], start, length) if length else iter(())
    return Response(body, status=status, headers=headers, mimetype=row["mime"] or "application/octet-stream")


@app.get("/api/files/<int:fid>/content")
def api_file_content(fid):
    r = get_db().execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
    if not r:
        abort(404)
    b = BACKENDS.get(r["storage"])
    if not b or not b.enabled:
        abort(501, "This storage backend is not enabled")

    as_download = bool(request.args.get("download"))
    quality = request.args.get("quality", "original")

    if quality == "fast" and not as_download and _fast_path(fid).exists():
        return send_file(_fast_path(fid), mimetype="video/mp4", conditional=True)

    if b.streams and _orig_cache_path(fid).exists():
        return send_file(
            _orig_cache_path(fid),
            mimetype=r["mime"],
            conditional=True,
            download_name=r["name"],
            as_attachment=as_download,
        )

    if (r["mime"] or "").startswith("video/") and not as_download:
        queue_video_prep(fid, priority=True)

    if b.streams:
        return stream_response(r, b)
    return send_file(
        b.path(r["storage_ref"]),
        mimetype=r["mime"],
        conditional=True,
        download_name=r["name"],
        as_attachment=as_download,
    )


def _extract_random_frame(video_path: Path, out_jpg: Path) -> bool:
    if not FFMPEG_BIN:
        return False
    seek_sec = round(random.uniform(0.3, 2.5), 2)
    cmd = [
        FFMPEG_BIN,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        str(seek_sec),
        "-i",
        str(video_path),
        "-vframes",
        "1",
        "-vf",
        "scale=480:-1",
        "-q:v",
        "4",
        str(out_jpg),
    ]
    res = subprocess.run(cmd)
    if res.returncode == 0 and out_jpg.exists() and out_jpg.stat().st_size > 0:
        return True

    cmd[6] = "0"
    res = subprocess.run(cmd)
    return res.returncode == 0 and out_jpg.exists() and out_jpg.stat().st_size > 0


@app.get("/api/files/<int:fid>/thumbnail")
def api_file_thumbnail(fid: int):
    thumb_path = _thumb_path(fid)
    if thumb_path.exists() and thumb_path.stat().st_size > 0:
        return send_file(thumb_path, mimetype="image/jpeg")

    r = get_db().execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
    if not r or not (r["mime"] or "").startswith("video/"):
        abort(404)

    b = BACKENDS.get(r["storage"])
    if not b or not b.enabled:
        abort(404)

    # 1. Check if video is already cached locally on SSD
    for cached in (_fast_path(fid), _orig_cache_path(fid)):
        if cached.exists() and _extract_random_frame(cached, thumb_path):
            return send_file(thumb_path, mimetype="image/jpeg")

    # 2. Local storage video
    if not b.streams:
        orig = b.path(r["storage_ref"])
        if orig.exists() and _extract_random_frame(orig, thumb_path):
            return send_file(thumb_path, mimetype="image/jpeg")
        abort(404)

    # 3. Remote streaming video (Telegram / Google Drive)
    size = r["size"] or 0
    if size <= 0:
        abort(404)

    sample_len = min(size, 6_000_000)
    suffix = Path(r["name"]).suffix or ".mp4"
    fd, tmp_name = tempfile.mkstemp(suffix=suffix, dir=THUMB_CACHE)
    os.close(fd)
    tmp_path = Path(tmp_name)
    try:
        with open(tmp_path, "wb") as out:
            for chunk in b.iter_bytes(r["storage_ref"], 0, sample_len):
                out.write(chunk)
        if _extract_random_frame(tmp_path, thumb_path):
            return send_file(thumb_path, mimetype="image/jpeg")

        # Fallback for .MOV files whose metadata (moov atom) is at the end of the file
        orig_file = _orig_cache_path(fid)
        if not orig_file.exists():
            part_orig = ORIG_CACHE / f"{fid}.{uuid.uuid4().hex[:6]}.part"
            try:
                with open(part_orig, "wb") as out:
                    for chunk in b.iter_bytes(r["storage_ref"], 0, size):
                        out.write(chunk)
                os.replace(part_orig, orig_file)
            finally:
                part_orig.unlink(missing_ok=True)
        if orig_file.exists() and _extract_random_frame(orig_file, thumb_path):
            return send_file(thumb_path, mimetype="image/jpeg")
    except Exception as exc:  # noqa: BLE001
        print(f"[thumb] #{fid} error: {exc}")
    finally:
        tmp_path.unlink(missing_ok=True)

    abort(404)


@app.patch("/api/files/<int:fid>")
def api_file_update(fid):
    db = get_db()
    data = request.get_json(silent=True) or {}
    row = db.execute("SELECT * FROM files WHERE id=?", (fid,)).fetchone()
    if not row:
        abort(404)
    name = clean_name(data["name"]) if "name" in data else row["name"]
    folder = data["folder_id"] if "folder_id" in data else row["folder_id"]
    if not folder_exists(db, folder):
        abort(404, "Folder not found")
    db.execute("UPDATE files SET name=?, folder_id=? WHERE id=?", (name, folder, fid))
    db.commit()
    return jsonify(ok=True)


@app.delete("/api/files/<int:fid>")
def api_file_delete(fid):
    db = get_db()
    r = db.execute("SELECT storage, storage_ref FROM files WHERE id=?", (fid,)).fetchone()
    if not r:
        abort(404)
    _cleanup_video_cache(fid)
    b = BACKENDS.get(r["storage"])
    if b and b.enabled:
        b.delete(r["storage_ref"])
    db.execute("DELETE FROM files WHERE id=?", (fid,))
    db.commit()
    return jsonify(ok=True)


# -------------------------------------------------------------------- Telegram
@app.post("/api/telegram/import")
def api_telegram_import():
    b = BACKENDS["telegram"]
    if not b.enabled:
        abort(400, "Telegram is not connected yet")
    db = get_db()
    folder_id = (request.get_json(silent=True) or {}).get("folder_id")
    if not folder_exists(db, folder_id):
        abort(404, "Folder not found")
    try:
        items = b.list_media()
    except Exception as e:  # noqa: BLE001
        abort(502, f"Telegram: {e}")
    added = 0
    for it in items:
        cur = db.execute(
            "INSERT OR IGNORE INTO files(folder_id, name, size, mime, storage, storage_ref, created_at)"
            " VALUES(?, ?, ?, ?, 'telegram', ?, ?)",
            (folder_id, it["name"], it["size"], it["mime"], str(it["id"]), it["date"]),
        )
        added += cur.rowcount
    db.commit()
    return jsonify(added=added, total=len(items))


# ------------------------------------------------------------------------ Sync
@app.post("/api/sync/check")
def api_sync_check():
    fps = (request.get_json(silent=True) or {}).get("fingerprints", [])
    db = get_db()
    have = set()
    for i in range(0, len(fps), 500):
        chunk = fps[i : i + 500]
        q = ",".join("?" * len(chunk))
        have.update(r[0] for r in db.execute(f"SELECT fingerprint FROM files WHERE fingerprint IN ({q})", chunk))
    return jsonify(missing=[f for f in fps if f not in have])


init()


# ------------------------------------------------------ Web Integrations & Auth
@app.get("/api/integrations/status")
def api_integrations_status():
    tg = BACKENDS["telegram"]
    gd = BACKENDS["drive"]
    return jsonify(
        local={"enabled": True},
        telegram={"enabled": tg.enabled},
        drive={"enabled": gd.enabled, "has_config": bool(gd.get_config().get("client_id"))},
    )


@app.post("/api/telegram/auth/start")
def api_telegram_auth_start():
    data = request.get_json(silent=True) or {}
    try:
        res = BACKENDS["telegram"].start_web_login(
            api_id=int(data["api_id"]),
            api_hash=data["api_hash"],
            phone=data["phone"],
            channel_id=data.get("channel_id") or "me",
        )
        return jsonify(res)
    except Exception as e:  # noqa: BLE001
        abort(400, f"Telegram: {e}")


@app.post("/api/telegram/auth/verify")
def api_telegram_auth_verify():
    data = request.get_json(silent=True) or {}
    try:
        res = BACKENDS["telegram"].finish_web_login(
            code=data.get("code", ""),
            password=data.get("password", ""),
        )
        return jsonify(res)
    except Exception as e:  # noqa: BLE001
        abort(400, f"Telegram: {e}")


@app.post("/api/drive/auth/start")
def api_drive_auth_start():
    data = request.get_json(silent=True) or {}
    gd = BACKENDS["drive"]
    try:
        if data.get("client_id") and data.get("client_secret"):
            gd.save_config(data["client_id"], data["client_secret"])
        redirect_uri = f"{request.scheme}://{request.host}/api/drive/auth/callback"
        return jsonify(auth_url=gd.build_auth_url(redirect_uri))
    except Exception as e:  # noqa: BLE001
        abort(400, f"Google Drive: {e}")


@app.get("/api/drive/auth/callback")
def api_drive_auth_callback():
    code = request.args.get("code")
    if not code:
        abort(400, "Google authorization code not found")
    gd = BACKENDS["drive"]
    redirect_uri = f"{request.scheme}://{request.host}/api/drive/auth/callback"
    try:
        gd.exchange_code(code, redirect_uri)
    except Exception as e:  # noqa: BLE001
        abort(400, f"Google Drive: {e}")
    return Response(
        "<script>if(window.opener){window.opener.postMessage('gdrive-connected','*');window.close();}else{location.href='/';}</script>",
        mimetype="text/html",
    )


@app.post("/api/drive/import")
def api_drive_import():
    gd = BACKENDS["drive"]
    if not gd.enabled:
        abort(400, "Google Drive is not connected yet")
    db = get_db()
    folder_id = (request.get_json(silent=True) or {}).get("folder_id")
    if not folder_exists(db, folder_id):
        abort(404, "Folder not found")
    try:
        items = gd.list_files()
    except Exception as e:  # noqa: BLE001
        abort(502, f"Google Drive: {e}")
    added = 0
    for it in items:
        cur = db.execute(
            "INSERT OR IGNORE INTO files(folder_id, name, size, mime, storage, storage_ref, created_at)"
            " VALUES(?, ?, ?, ?, 'drive', ?, ?)",
            (folder_id, it["name"], it["size"], it["mime"], str(it["id"]), it["date"]),
        )
        added += cur.rowcount
    db.commit()
    return jsonify(added=added, total=len(items))


if __name__ == "__main__":
    host = os.environ.get("HUB_HOST", "0.0.0.0")
    port = int(os.environ.get("HUB_PORT", "8080"))
    if not PASSWORD:
        print("WARNING: HUB_PASSWORD is not set; running without authentication.")
    if not FFMPEG_BIN:
        print("INFO: Install imageio-ffmpeg for video thumbnails and fast 480p streaming.")
    print(f"Storage: {STORAGE_DIR}\nDB:      {DB_PATH}\nOpen:    http://localhost:{port}")
    app.run(host=host, port=port, threaded=True)