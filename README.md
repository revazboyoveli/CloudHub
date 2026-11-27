# CloudHub: My Cloud

A single web app where all your videos are gathered and organized into folders.
Files are stored in different storages (Hard disk, Telegram, and Google Drive).
Every record is saved in a tiny file: `hub.db`. No paid database is needed.

<p align="center">
    <img src="https://github.com/user-attachments/assets/a64857ea-709e-4f17-bf78-1a79b72bc326" alt="CloudHub Demo" width="850" />
</p>
<img width="1919" height="992" alt="image" src="https://github.com/user-attachments/assets/62e90401-89d6-469a-861d-9e485183d99b" />
<img width="1919" height="992" alt="image" src="https://github.com/user-attachments/assets/ad4358ac-2af3-4e9b-a2f2-4df35e6c5158" />

## 1. Launch (EST 5 minutes)

1. Download **Python 3.9+** (python.org). In the Windows installer, check the "Add Python to PATH" box.
2. Open a terminal in this folder and run:
   ```bash
   pip install -r requirements.txt
   ```
3. Start the server.

   **Windows (PowerShell):**
   ```powershell
   $env:HUB_SECRET_KEY="your-strong-master-passphrase"; $env:HUB_PASSWORD="your-password"; $env:HUB_STORAGE="D:\Videos"; python app.py
   ```
   **Mac / Linux:**
   ```bash
   HUB_SECRET_KEY="your-strong-master-passphrase" HUB_PASSWORD="your-password" HUB_STORAGE=/path/to/disk python app.py
   ```
4. Open `http://localhost:8080`. Username: `admin`, password: whatever you set.

Variable | What it does
--- | ---
`HUB_SECRET_KEY` | Master passphrase (min. 12 chars) used to encrypt/decrypt stored API credentials
`HUB_STORAGE` | Where videos are stored (point this to an external or large drive)
`HUB_PASSWORD` | Password for web login (also used as fallback encryption key if `HUB_SECRET_KEY` is unset)
`HUB_DB` | Where `hub.db` is saved (default: this folder)
`HUB_PORT` | Port (default: 8080)

## 2. Connecting Telegram

Videos stay in Telegram—nothing is saved on your computer. The site only remembers where each file lives and streams it from Telegram when you watch it.

1. **Get your `api_id` and `api_hash`**: go to [my.telegram.org](https://my.telegram.org) → API development tools → Create application.
2. Start `app.py` and click **Connect Telegram** directly in the web sidebar.
3. Enter your `api_id`, `api_hash`, and phone number (`+995...`), then enter the login code sent to Telegram (and your 2FA password if enabled).
4. Select your private channel or **Saved Messages** from the dropdown list. Your credentials are encrypted and saved to `tg_config.enc`.
5. Click **"Import from Telegram"** on the site: videos from your channel will appear in whichever folder you're currently in, and you can sort them into folders afterward.
6. When uploading, choose "Telegram" as the storage: the video will be uploaded straight to your channel.

**Good to know:**
- `tg.session` and `tg_config.enc` are the keys to your Telegram account. Never send them to anyone or upload them anywhere.
- **Deleting from the site does not delete anything from Telegram.** It only removes the entry on the site; the file stays in your channel. Clicking "Import" again will bring it back.
- During upload, the file is temporarily written to your computer and automatically deleted once uploaded. Single files can be up to 2 GB (more with Telegram Premium).
- Only videos/images sent **as files** are imported. Regular compressed Telegram photos are not imported yet.
- Telegram videos only play on the site while the server is running.

## 3. Security & Credential Encryption

Sensitive API credentials (`api_id`, `api_hash`, `channel_id`) are never stored in plaintext on disk. CloudHub uses a dedicated cryptographic vault (`crypto_vault.py`) built on industry-standard primitives:

- **Key Derivation (`PBKDF2-HMAC-SHA256`):** Derives a 256-bit cryptographic key from your runtime `HUB_SECRET_KEY` and a fresh 128-bit random salt across **600,000 iterations** (OWASP standard).
- **Authenticated Encryption (`AES-256-GCM`):** Encrypts configuration payloads inside a versioned binary envelope (`CHVAULT1`) using a unique 96-bit nonce per write and an authentication tag that detects any file tampering or wrong key immediately.
- **Zero Secrets in Repository:** `HUB_SECRET_KEY` lives only in environment variables at runtime, while `*.enc` and `*.session` files are excluded via `.gitignore`.

## 4. Backup

Your folder structure is stored in `hub.db`. Back it up elsewhere periodically (e.g., to Google Drive).
Local files live in the `HUB_STORAGE` folder. Keep important videos in two places.

## 5. What's Next

- [x] **Telegram** storage (with in-browser login & channel selector)
- [x] **Google Drive** storage (OAuth 2.0 integration)
- [x] **AES-256-GCM** encrypted credential vault
- [ ] Mobile app (with automatic background sync)
- [x] Video thumbnails
