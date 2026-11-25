# CloudHub: My Cloud

A single web app where all your videos are gathered and organized into folders.
Files are stored in different storages (Now on hard disk and Telegram, later on Google Drive).
Every record is saved in a tiny file: hub.db. No paid database is needed.

<img width="1919" height="992" alt="image" src="https://github.com/user-attachments/assets/62e90401-89d6-469a-861d-9e485183d99b" />
<img width="1919" height="992" alt="image" src="https://github.com/user-attachments/assets/ad4358ac-2af3-4e9b-a2f2-4df35e6c5158" />

## 1. Launch (EST 5 minutes)

1. Download **Python 3.9+** (python.org). In the Windows installer, check the "Add Python to PATH" box.
2. Open a terminal in this folder and run:
   pip install -r requirements.txt
3. Start the server.

   **Windows (PowerShell):**
   ```
   $env:HUB_PASSWORD="your-password"; $env:HUB_STORAGE="D:\Videos"; python app.py
   ```
   **Mac / Linux:**
   ```
   HUB_PASSWORD="your-password" HUB_STORAGE=/path/to/disk python app.py
   ```
4. Open `http://localhost:8080`. Username: `admin`, password: whatever you set.

Variable | What it does
`HUB_STORAGE` | Where videos are stored (point this to an external or large drive)
`HUB_PASSWORD` | Password (required if you access it from your phone outside your home)
`HUB_DB` | Where `hub.db` is saved (default: this folder)
`HUB_PORT` | Port (default: 8080)

## 2. Access Outside Your Home (Free & Secure): Tailscale

**Do not open ports on your router.** Instead:
1. Install **Tailscale** on both your computer and phone, and log in with the same account.
2. On your phone, open the site using your computer's Tailscale IP: `http://100.x.y.z:8080`.

Traffic is encrypted and nobody else can see your site.

## 3. Syncing from Your Phone

`sync_client.py` uploads only **new** photos and videos. It doesn't hash files, so repeat runs finish in seconds, and if interrupted, it picks up right where it left off. Your subfolder structure is preserved on the site as well.

**On Android (Termux, from F-Droid):**
```
pkg install python
termux-setup-storage
python sync_client.py --server [http://100.](http://100.)x.y.z:8080 --password your-password --path ~/storage/dcim --dest "Phone"
```
**From a computer:**
```
python sync_client.py --server http://localhost:8080 --password your-password --path "D:\Videos" --dest "Old Videos"
```
Useful flags: `--dry-run` (only shows what will be uploaded), `--workers 5` (faster uploads), `--all` (all file types).

## 4. Connecting Telegram

Videos stay in Telegram—nothing is saved on your computer. The site only remembers where each file lives and streams it from Telegram when you watch it.

1. **You need `api_id` and `api_hash`**: go to my.telegram.org → API development tools → Create application.
2. Update packages (Telethon was added):
   ```
   .\.venv\Scripts\python.exe -m pip install -r requirements.txt
   ```
3. **Stop the server** (`Ctrl+C`) and run once:
   ```
   .\.venv\Scripts\python.exe tg_login.py
   ```
   Enter your `api_id`, `api_hash`, then your phone number (+995...), the login code sent to Telegram, and your 2FA password if you have one.
   Finally, select your private channel from the list.
4. Start `app.py` as usual. You will see an **"Import from Telegram"** button on the site: videos from your channel will appear in whichever folder you're currently in, and you can sort them into folders afterward.
5. When uploading, choose "Telegram" as the storage: the video will be uploaded straight to your channel.

**Good to know:**
- `tg.session` and `tg_config.json` are the keys to your Telegram account. Never send them to anyone or upload them anywhere.
- **Deleting from the site does not delete anything from Telegram.** It only removes the entry on the site; the file stays in your channel. Clicking "Import" again will bring it back.
- During upload, the file is temporarily written to your computer and automatically deleted once uploaded. Single files can be up to 2 GB (more with Telegram Premium).
- Only videos/images sent **as files** are imported. Regular compressed Telegram photos are not imported yet.
- Telegram videos only play on the site while the server is running.

## 5. Backup

Your folder structure is stored in `hub.db`. Back it up elsewhere periodically (e.g., to Google Drive).
Local files live in the `HUB_STORAGE` folder. Keep important videos in two places.

## 6. What's Next

- [x] **Telegram** storage
- [ ] **Google Drive** storage (placeholder `PlannedBackend("drive")` is already set up in `app.py`)
- [ ] Mobile app (with automatic background sync)
- [x] Video thumbnails
