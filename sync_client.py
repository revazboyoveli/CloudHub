#!/usr/bin/env python3
"""სწრაფი სინქრონიზაცია: ტელეფონიდან ან კომპიუტერიდან საქაღალდეს ტვირთავს CloudHub-ზე.

რატომ არის სწრაფი:
  * ფაილს არ ვკითხულობთ და არ ვჰეშავთ: ანაბეჭდი = სახელი|ზომა|თარიღი (მხოლოდ stat).
  * სერვერს ერთი მოთხოვნით ვეკითხებით, რომელი ფაილი აკლია, და მხოლოდ ის გადაგვაქვს.
  * ადგილობრივ ქეშში ვიმახსოვრებთ უკვე ატვირთულს, ამიტომ განმეორებითი გაშვება წამებში სრულდება.
  * რამდენიმე ფაილი ერთდროულად იტვირთება და ფაილი დისკიდან პირდაპირ იგზავნება (მეხსიერებას არ ავსებს).
  * შეწყვეტის შემდეგ ისევ გაუშვი: იქიდან გააგრძელებს, სადაც გაჩერდა.

მაგალითი (Termux-ში, ტელეფონზე):
  termux-setup-storage
  python sync_client.py --server http://100.64.0.5:8080 --path ~/storage/dcim --dest "ტელეფონი"

მხოლოდ სტანდარტული ბიბლიოთეკა, არაფრის დაყენება არ სჭირდება.
"""
import argparse
import base64
import http.client
import json
import os
import sys
import threading
import time
import urllib.parse
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed

MEDIA = {
    ".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v", ".3gp", ".mts",
    ".jpg", ".jpeg", ".png", ".heic", ".heif", ".webp", ".gif", ".dng", ".raw",
}
CACHE_FILE = os.path.expanduser("~/.cloudhub_sync.json")


def scan(root, include_all):
    now = time.time()
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]  # .thumbnails, .trash...
        for fn in filenames:
            if fn.startswith("."):
                continue
            if not include_all and os.path.splitext(fn)[1].lower() not in MEDIA:
                continue
            path = os.path.join(dirpath, fn)
            try:
                st = os.stat(path)
            except OSError:
                continue
            if now - st.st_mtime < 5:  # ფაილი ალბათ ჯერ იწერება
                continue
            rel = os.path.relpath(dirpath, root)
            rel = "" if rel == "." else rel.replace(os.sep, "/")
            yield {"path": path, "name": fn, "rel": rel, "size": st.st_size,
                   "fp": f"{fn}|{st.st_size}|{int(st.st_mtime)}"}


class Server:
    def __init__(self, url, user, password):
        u = urllib.parse.urlparse(url if "//" in url else "http://" + url)
        self.https = u.scheme == "https"
        self.host = u.hostname
        self.port = u.port or (443 if self.https else 80)
        self.auth = ""
        if password:
            self.auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()

    def conn(self):
        cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
        return cls(self.host, self.port, timeout=600)

    def headers(self, extra=None):
        h = dict(extra or {})
        if self.auth:
            h["Authorization"] = self.auth
        return h

    def missing(self, fps):
        out = []
        for i in range(0, len(fps), 1000):
            body = json.dumps({"fingerprints": fps[i:i + 1000]}).encode()
            c = self.conn()
            c.request("POST", "/api/sync/check", body,
                      self.headers({"Content-Type": "application/json"}))
            r = c.getresponse()
            data = r.read()
            c.close()
            if r.status == 401:
                sys.exit("❌ არასწორი მომხმარებელი ან პაროლი.")
            if r.status != 200:
                sys.exit(f"❌ სერვერმა დააბრუნა {r.status}: {data[:200]!r}")
            out += json.loads(data)["missing"]
        return out

    def upload(self, item, dest, storage):
        boundary = uuid.uuid4().hex
        folder_path = "/".join(p for p in (dest, item["rel"]) if p)
        pre = b""
        for k, v in (("storage", storage), ("fingerprint", item["fp"]), ("folder_path", folder_path)):
            pre += (f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n').encode()
        fname = item["name"].replace('"', "%22")
        pre += (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{fname}"\r\n'
                "Content-Type: application/octet-stream\r\n\r\n").encode()
        post = f"\r\n--{boundary}--\r\n".encode()

        c = self.conn()
        try:
            c.putrequest("POST", "/api/upload")
            for k, v in self.headers({
                "Content-Type": f"multipart/form-data; boundary={boundary}",
                "Content-Length": str(len(pre) + item["size"] + len(post)),
            }).items():
                c.putheader(k, v)
            c.endheaders()
            c.send(pre)
            sent = 0
            with open(item["path"], "rb") as f:
                while sent < item["size"]:
                    chunk = f.read(min(1 << 20, item["size"] - sent))
                    if not chunk:
                        raise IOError("ფაილი ატვირთვისას შეიცვალა")
                    c.send(chunk)
                    sent += len(chunk)
            c.send(post)
            r = c.getresponse()
            data = r.read()
            if r.status not in (200, 201):
                raise IOError(f"{r.status}: {data[:200]!r}")
            return json.loads(data).get("status", "ok")
        finally:
            c.close()


def human(n):
    for u in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or u == "TB":
            return f"{n:.1f} {u}" if u != "B" else f"{n} B"
        n /= 1024


def main():
    ap = argparse.ArgumentParser(description="ფოტო/ვიდეოს სინქრონიზაცია CloudHub-ზე")
    ap.add_argument("--server", required=True, help="მაგ. http://192.168.1.10:8080")
    ap.add_argument("--path", required=True, help="საქაღალდე, რომლის ატვირთვაც გინდა")
    ap.add_argument("--dest", default="", help="ფოლდერი საიტზე (შიგნით ქვეფოლდერების სტრუქტურა შენარჩუნდება)")
    ap.add_argument("--storage", default="local", help="local (მერე: drive, telegram)")
    ap.add_argument("--user", default=os.environ.get("HUB_USER", "admin"))
    ap.add_argument("--password", default=os.environ.get("HUB_PASSWORD", ""))
    ap.add_argument("--workers", type=int, default=3, help="ერთდროული ატვირთვები (ნაგულისხმევი 3)")
    ap.add_argument("--all", action="store_true", help="არა მხოლოდ ფოტო/ვიდეო, ყველა ფაილი")
    ap.add_argument("--no-cache", action="store_true", help="ქეშის გარეშე, სერვერს ყველაფერზე ჰკითხოს")
    ap.add_argument("--dry-run", action="store_true", help="მხოლოდ აჩვენოს, რა აიტვირთებოდა")
    a = ap.parse_args()

    root = os.path.abspath(os.path.expanduser(a.path))
    if not os.path.isdir(root):
        sys.exit(f"❌ საქაღალდე ვერ მოიძებნა: {root}")
    srv = Server(a.server, a.user, a.password)

    cache_key = f"{a.server}|{a.dest}|{a.storage}"
    cache = {}
    if not a.no_cache and os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE, encoding="utf-8") as f:
                cache = json.load(f)
        except (OSError, ValueError):
            cache = {}
    done = set(cache.get(cache_key, []))

    t0 = time.time()
    items = list(scan(root, a.all))
    candidates = [i for i in items if i["fp"] not in done]
    print(f"ნაპოვნია {len(items)} ფაილი, ქეშში უკვე არის {len(items) - len(candidates)}.")

    todo = []
    if candidates:
        missing = set(srv.missing([i["fp"] for i in candidates]))
        todo = [i for i in candidates if i["fp"] in missing]
        done.update(i["fp"] for i in candidates if i["fp"] not in missing)  # სერვერზე უკვე იყო
    total = sum(i["size"] for i in todo)
    print(f"ასატვირთია {len(todo)} ფაილი ({human(total)}). შემოწმებას დასჭირდა {time.time() - t0:.1f} წმ.")

    if a.dry_run or not todo:
        for i in todo[:50]:
            print("  •", os.path.join(i["rel"], i["name"]))
        _save(cache, cache_key, done, a.no_cache)
        return

    lock = threading.Lock()
    stats = {"n": 0, "bytes": 0, "fail": 0}
    t1 = time.time()

    def work(item):
        err = None
        for attempt in range(3):
            try:
                srv.upload(item, a.dest, a.storage)
                return item, None
            except Exception as e:  # noqa: BLE001
                err = e
                time.sleep(1 + attempt * 2)
        return item, err

    try:
        with ThreadPoolExecutor(max_workers=max(1, a.workers)) as pool:
            for fut in as_completed([pool.submit(work, i) for i in todo]):
                item, err = fut.result()
                with lock:
                    stats["n"] += 1
                    if err:
                        stats["fail"] += 1
                        print(f"[{stats['n']}/{len(todo)}] ❌ {item['name']}: {err}")
                    else:
                        done.add(item["fp"])
                        stats["bytes"] += item["size"]
                        speed = stats["bytes"] / max(time.time() - t1, 0.001)
                        print(f"[{stats['n']}/{len(todo)}] ✓ {item['name']}  ({human(speed)}/წმ)")
    except KeyboardInterrupt:
        print("\nშეწყდა. ისევ გაუშვი, გააგრძელებს იქიდან, სადაც გაჩერდა.")
    finally:
        _save(cache, cache_key, done, a.no_cache)

    print(f"მზადაა: {stats['n'] - stats['fail']} აიტვირთა, {stats['fail']} შეცდომით, {time.time() - t0:.0f} წმ.")


def _save(cache, key, done, disabled):
    if disabled:
        return
    cache[key] = sorted(done)
    try:
        with open(CACHE_FILE, "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except OSError:
        pass


if __name__ == "__main__":
    main()
