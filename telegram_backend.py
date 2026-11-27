"""Telegram storage backend (high-speed video streaming: 1MB chunks + 192MB RAM cache + 6x parallel prefetch)."""
import asyncio
from collections import OrderedDict
import json
import mimetypes
import os
import re
import tempfile
import threading
from importlib.util import find_spec
from pathlib import Path

from crypto_vault import decrypt_json, encrypt_json

BASE = Path(__file__).resolve().parent
TG_DIR = Path(os.environ.get("HUB_TG_DIR", BASE))
CONFIG = TG_DIR / "tg_config.enc"
SESSION = TG_DIR / "tg"

CHUNK = 1024 * 1024         # 1 MB — Telegram MTProto max block size
PREFETCH = 8                # 8 MB prefetch before playback
MAX_CACHE_CHUNKS = 192      # 192 MB RAM cache
MAX_CONCURRENT_DL = 6       # Max 6 parallel download workers
MAX_UPLOAD = 2 * 1024**3
_BAD_CHARS = re.compile(r'[\\/:*?"<>|]')


class TelegramBackend:
    key = "telegram"
    label = "Telegram"
    streams = True

    def __init__(self):
        self._lock = threading.Lock()
        self._loop = None
        self._client = None
        self._entity = None
        self._sem = None
        self._media_cache = {}
        self._size_cache = {}
        self._chunk_cache = OrderedDict()
        self._inflight = {}
        self._pending_client = None
        self._pending_phone = ""
        self._pending_hash = ""
        self._pending_api_id = 0
        self._pending_api_hash = ""

    @property
    def enabled(self):
        if self._client is not None and self._entity is not None:
            return True
        return (
            CONFIG.exists()
            and Path(str(SESSION) + ".session").exists()
            and find_spec("telethon") is not None
        )

    def _cfg(self):
        return decrypt_json(CONFIG)

    def _run(self, coro):
        return asyncio.run_coroutine_threadsafe(coro, self._loop).result()

    def _ensure(self):
        if self._client is not None and self._entity is not None:
            return
        with self._lock:
            if self._client is not None and self._entity is not None:
                return
            loop = asyncio.new_event_loop()
            threading.Thread(target=loop.run_forever, daemon=True, name="telegram-loop").start()
            self._loop = loop
            try:
                self._run(self._connect())
            except Exception:
                loop.call_soon_threadsafe(loop.stop)
                self._loop = None
                raise

    async def _connect(self):
        from telethon import TelegramClient

        cfg = self._cfg()
        client = TelegramClient(str(SESSION), int(cfg["api_id"]), cfg["api_hash"])
        await client.connect()
        if not await client.is_user_authorized():
            await client.disconnect()
            raise RuntimeError("Not signed in to Telegram. Connect via the web UI or run: python tg_login.py")
        self._entity = await self._resolve(client, cfg.get("channel_id", "me"))
        self._sem = asyncio.Semaphore(MAX_CONCURRENT_DL)
        self._client = client

    @staticmethod
    async def _resolve(client, cid):
        if str(cid) == "me":
            return await client.get_entity("me")
        try:
            return await client.get_entity(int(cid))
        except ValueError:
            async for _ in client.iter_dialogs():
                pass
            return await client.get_entity(int(cid))

    @staticmethod
    def _name(msg, doc, mime):
        for a in doc.attributes:
            n = getattr(a, "file_name", None)
            if n:
                return n
        caption = (msg.message or "").strip()
        base = _BAD_CHARS.sub("_", caption.splitlines()[0][:80]) if caption else ""
        base = base or f"{msg.date:%Y-%m-%d_%H-%M}_{msg.id}"
        ext = mimetypes.guess_extension(mime) or ""
        return base if (not ext or base.lower().endswith(ext)) else base + ext

    def list_media(self):
        self._ensure()
        return self._run(self._list())

    async def _list(self):
        out = []
        async for m in self._client.iter_messages(self._entity):
            doc = m.document
            if not doc:
                continue
            mime = doc.mime_type or ""
            name = self._name(m, doc, mime)
            if not (mime.startswith(("video/", "image/"))):
                guessed = mimetypes.guess_type(name)[0] or ""
                if not guessed.startswith(("video/", "image/")):
                    continue
                mime = guessed
            size = doc.size or 0
            self._media_cache[m.id] = m.media
            self._size_cache[m.id] = size
            out.append({
                "id": m.id,
                "name": name,
                "size": size,
                "mime": mime,
                "date": m.date.strftime("%Y-%m-%d %H:%M:%S"),
            })
        return out

    def save(self, file_storage, filename):
        self._ensure()
        with tempfile.TemporaryDirectory(prefix="cloudhub_") as td:
            path = os.path.join(td, _BAD_CHARS.sub("_", filename) or "file")
            file_storage.save(path)
            size = os.path.getsize(path)
            if size > MAX_UPLOAD:
                raise ValueError("File exceeds Telegram's 2 GB upload limit")
            msg_id = self._run(self._send(path, filename, size))
        return str(msg_id), size

    async def _send(self, path, name, size):
        msg = await self._client.send_file(
            self._entity,
            path,
            force_document=True,
            file_name=name,
            part_size_kb=512,
        )
        self._media_cache[msg.id] = msg.media
        self._size_cache[msg.id] = size
        return msg.id

    async def _get_media(self, msg_id: int):
        media = self._media_cache.get(msg_id)
        if media is None:
            msg = await self._client.get_messages(self._entity, ids=msg_id)
            if msg is None or not getattr(msg, "media", None):
                raise FileNotFoundError("Message not found in Telegram")
            media = msg.media
            self._media_cache[msg_id] = media
            doc = getattr(media, "document", None)
            if doc and getattr(doc, "size", 0):
                self._size_cache[msg_id] = doc.size
        return media

    def _put_cache(self, key, data: bytes):
        self._chunk_cache[key] = data
        self._chunk_cache.move_to_end(key)
        while len(self._chunk_cache) > MAX_CACHE_CHUNKS:
            self._chunk_cache.popitem(last=False)

    async def _download_worker(self, media, key, offset: int, fut: asyncio.Future):
        try:
            async with self._sem:
                if key in self._chunk_cache:
                    data = self._chunk_cache[key]
                else:
                    buf = bytearray()
                    async for chunk in self._client.iter_download(
                        media, offset=offset, limit=CHUNK, request_size=CHUNK
                    ):
                        buf.extend(chunk)
                        if len(buf) >= CHUNK:
                            break
                    data = bytes(buf)
                    self._put_cache(key, data)
            if not fut.done():
                fut.set_result(data)
        except Exception as exc:  # noqa: BLE001
            if not fut.done():
                fut.set_exception(exc)
        finally:
            self._inflight.pop(key, None)

    def _schedule_chunk(self, media, msg_id: int, offset: int) -> asyncio.Future:
        key = (msg_id, offset)
        if key in self._chunk_cache:
            self._chunk_cache.move_to_end(key)
            fut = self._loop.create_future()
            fut.set_result(self._chunk_cache[key])
            return fut

        fut = self._inflight.get(key)
        if fut is None:
            fut = self._loop.create_future()
            fut.add_done_callback(lambda f: f.exception() if not f.cancelled() else None)
            self._inflight[key] = fut
            self._loop.create_task(self._download_worker(media, key, offset, fut))
        return fut

    async def _get_chunk_with_prefetch(self, msg_id: int, offset: int, end_limit: int, warm_tail: bool) -> bytes:
        media = await self._get_media(msg_id)
        doc_size = self._size_cache.get(msg_id, 0)

        target_fut = self._schedule_chunk(media, msg_id, offset)
        for i in range(1, PREFETCH):
            next_off = offset + i * CHUNK
            if next_off < end_limit and (not doc_size or next_off < doc_size):
                self._schedule_chunk(media, msg_id, next_off)

        # Preload last 2 MB of .MOV / .MP4 files (for moov atom index)
        if warm_tail and doc_size > CHUNK * 2:
            last_aligned = ((doc_size - 1) // CHUNK) * CHUNK
            self._schedule_chunk(media, msg_id, last_aligned)
            if last_aligned - CHUNK > 0:
                self._schedule_chunk(media, msg_id, last_aligned - CHUNK)

        return await asyncio.shield(target_fut)

    def iter_bytes(self, ref, start, length):
        self._ensure()
        msg_id = int(ref)
        aligned = (start // CHUNK) * CHUNK
        skip = start - aligned
        end_limit = start + length
        sent = 0
        cur = aligned
        first_step = True

        while sent < length:
            warm_tail = first_step and (aligned == 0)
            first_step = False
            chunk = self._run(self._get_chunk_with_prefetch(msg_id, cur, end_limit, warm_tail))
            cur += CHUNK

            if not chunk:
                break
            if skip:
                chunk, skip = chunk[skip:], 0
            if len(chunk) > length - sent:
                chunk = chunk[: length - sent]
            if chunk:
                sent += len(chunk)
                yield chunk
            if len(chunk) < CHUNK and sent < length:
                break

    def delete(self, ref):
        return None

    def _ensure_loop(self):
        if self._loop is None:
            loop = asyncio.new_event_loop()
            threading.Thread(target=loop.run_forever, daemon=True, name="telegram-loop").start()
            self._loop = loop

    @staticmethod
    async def _fetch_channels(client) -> list[dict]:
        channels = [{"id": "me", "title": "Saved Messages (Personal Cloud)", "type": "saved"}]
        async for d in client.iter_dialogs():
            if d.is_channel or d.is_group:
                channels.append({
                    "id": str(d.id),
                    "title": d.name or f"Channel {d.id}",
                    "type": "channel" if d.is_channel else "group",
                })
        return channels

    def start_web_login(self, api_id: int, api_hash: str, phone: str) -> dict:
        self._ensure_loop()
        return self._run(self._web_send_code(int(api_id), api_hash.strip(), phone.strip()))

    async def _web_send_code(self, api_id: int, api_hash: str, phone: str) -> dict:
        from telethon import TelegramClient

        if self._client is not None:
            try:
                await self._client.disconnect()
            except Exception:
                pass
            self._client = None
            self._entity = None

        if self._pending_client is not None:
            try:
                await self._pending_client.disconnect()
            except Exception:
                pass
            self._pending_client = None

        client = TelegramClient(str(SESSION), api_id, api_hash)
        await client.connect()
        self._pending_client = client
        self._pending_api_id = api_id
        self._pending_api_hash = api_hash

        if await client.is_user_authorized():
            channels = await self._fetch_channels(client)
            return {"status": "select_channel", "channels": channels}

        sent = await client.send_code_request(phone)
        self._pending_phone = phone
        self._pending_hash = sent.phone_code_hash
        return {"status": "code_sent"}

    def finish_web_login(self, code: str, password: str = "") -> dict:
        self._ensure_loop()
        return self._run(self._web_sign_in(code.strip(), password))

    async def _web_sign_in(self, code: str, password: str) -> dict:
        from telethon.errors import SessionPasswordNeededError

        client = self._pending_client
        if client is None:
            raise RuntimeError("Please request a verification code first")
        try:
            await client.sign_in(
                phone=self._pending_phone,
                code=code,
                phone_code_hash=self._pending_hash,
            )
        except SessionPasswordNeededError:
            if not password:
                return {"status": "2fa_required"}
            await client.sign_in(password=password)

        channels = await self._fetch_channels(client)
        return {"status": "select_channel", "channels": channels}

    def select_web_channel(self, channel_id: str) -> dict:
        self._ensure_loop()
        return self._run(self._web_finalize_channel((channel_id or "me").strip()))

    async def _web_finalize_channel(self, channel_id: str) -> dict:
        client = self._pending_client or self._client
        if client is None or not await client.is_user_authorized():
            raise RuntimeError("Telegram session is not authorized")

        self._entity = await self._resolve(client, channel_id)
        self._sem = asyncio.Semaphore(MAX_CONCURRENT_DL)
        self._client = client
        self._pending_client = None

        api_id = self._pending_api_id or (self._cfg().get("api_id") if CONFIG.exists() else 0)
        api_hash = self._pending_api_hash or (self._cfg().get("api_hash") if CONFIG.exists() else "")
        encrypt_json(
            CONFIG,
            {
                "api_id": int(api_id),
                "api_hash": api_hash,
                "channel_id": channel_id,
            },
        )
        return {"status": "authorized"}