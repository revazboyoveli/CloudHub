#!/usr/bin/env python3
"""Telegram-თან დაკავშირება. გაუშვი ერთხელ:  python tg_login.py

რას გკითხავს:
  1. api_id და api_hash (my.telegram.org-იდან)
  2. შენს ტელეფონის ნომერს, Telegram-ში მოსულ კოდს და (თუ გაქვს) ორსაფეხურიან პაროლს
  3. რომელი არხი გამოვიყენოთ ვიდეოებისთვის

შედეგად შეიქმნება ორი ფაილი, tg.session და tg_config.json. ისინი შენი Telegram ექაუნთის გასაღებია:
არავის გაუგზავნო, არსად ატვირთო და zip-ში არ ჩადო.

სერვერი (app.py) გამორთე, სანამ ამას უშვებ.
"""
import json
import os
import sys
from pathlib import Path

try:
    from telethon import utils
    from telethon.sync import TelegramClient
except ImportError:
    sys.exit("Telethon არ არის დაყენებული. გაუშვი:  python -m pip install -r requirements.txt")

BASE = Path(__file__).resolve().parent
TG_DIR = Path(os.environ.get("HUB_TG_DIR", BASE))
CONFIG = TG_DIR / "tg_config.json"
SESSION = TG_DIR / "tg"


def ask_int(prompt, lo=None, hi=None):
    while True:
        try:
            n = int(input(prompt).strip())
        except ValueError:
            print("  ჩაწერე რიცხვი.")
            continue
        if (lo is None or n >= lo) and (hi is None or n <= hi):
            return n
        print(f"  რიცხვი უნდა იყოს {lo}-დან {hi}-მდე.")


def main():
    TG_DIR.mkdir(parents=True, exist_ok=True)
    api_id = ask_int("api_id (რიცხვი): ")
    api_hash = input("api_hash: ").strip()

    client = TelegramClient(str(SESSION), api_id, api_hash)
    client.start()  # ტელეფონს, კოდს და საჭიროების შემთხვევაში 2FA პაროლს იკითხავს
    print("\n✓ Telegram-ში შესული ხარ.\n")

    choices = [("me", "Saved Messages (შენი პირადი ჩატი)")]
    for d in client.iter_dialogs():
        if d.is_channel:
            choices.append((utils.get_peer_id(d.entity), d.title))

    print("რომელ ადგილას გვაქვს (ან გვექნება) ვიდეოები?")
    for i, (_, title) in enumerate(choices, 1):
        print(f"  {i}. {title}")
    n = ask_int("ჩაწერე ნომერი: ", 1, len(choices))
    channel_id, title = choices[n - 1]

    CONFIG.write_text(
        json.dumps(
            {"api_id": api_id, "api_hash": api_hash, "channel_id": channel_id, "channel_title": title},
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    try:
        os.chmod(CONFIG, 0o600)
        os.chmod(str(SESSION) + ".session", 0o600)
    except OSError:
        pass
    client.disconnect()
    print(f"\n✓ მზადაა. გამოვიყენებთ: {title}\nახლა გაუშვი  python app.py  და საიტზე გამოჩნდება Telegram.")


if __name__ == "__main__":
    main()
