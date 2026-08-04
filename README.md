# AirDows

**AirDows** is a browser-based file transfer application for Android, iPhone, Windows, and macOS. Transfer files directly between your devices by scanning a QR code or entering a 4-digit pairing code—no account required.

**Main site:** https://airdows.com

---

## 📋 What is AirDows?

AirDows enables you to send files from your browser to any nearby device. Pairing is instant via QR code or 4-digit code. Files are transferred at original quality without compression and are never permanently stored.

When network conditions allow, AirDows attempts to establish a direct peer-to-peer (P2P) connection using WebRTC. If direct connection is not possible, encrypted traffic may pass temporarily through a TURN relay server as a fallback.

The effective file size depends on your browser, device, available storage, network stability, and the connection path between devices.

---

## ✨ Key Features

- **Instant pairing:** 4-digit code or QR code
- **Multiple files:** Send as many files as you want
- **Queue and cancel:** Manage transfers in real-time
- **No compression:** Files transfer at original quality
- **No permanent storage:** Files are deleted immediately after transfer
- **Clipboard support:** Share clipboard content directly
- **PWA:** Install as an app on your device
- **Direct save:** Save files directly to disk when your browser allows
- **WebRTC encryption:** Transport layer encryption + AES-GCM when available

---

## 🔐 How AirDows Transfers Your Files

AirDows attempts to route your files directly between devices using WebRTC. When that's not possible due to network restrictions (corporate firewalls, carrier-grade NAT, etc.), encrypted traffic may temporarily route through a TURN relay server.

**Important:** Transfers are encrypted in transit. Files are not permanently stored on any server and are deleted immediately after successful transfer.

For detailed security information, visit: https://airdows.com/seguridad

---

## 🏁 How to Run Locally

1. Ensure [Node.js](https://nodejs.org/) is installed.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   npm start
   ```
4. The server will output:
   ```text
   Signaling server running on http://localhost:3000
   ```

---

## 🔧 Environment Variables

Key variables for deployment:

```bash
TURN_URLS=<comma-separated-turn-servers>
TURN_USERNAME=<turn-username>
TURN_CREDENTIAL=<turn-credential>
ADMIN_DASHBOARD_TOKEN=<admin-auth-token>
METRICS_DATABASE_URL=postgresql://user:password@host:5432/dbname
METRICS_DATABASE_SSL=true
TELEGRAM_BOT_TOKEN=<telegram-bot-token>
TELEGRAM_CHAT_ID=<chat-id>
```

---

## 📝 License

See LICENSE file in this repository.

---

**Questions or feedback?** Visit https://airdows.com
