# AirRTC - P2P Secure File Transfer (AirDrop Clone)

An elegant, high-performance, and secure AirDrop clone MVP designed to transfer files directly between devices (e.g., a desktop computer and a mobile phone) using **WebRTC (peer-to-peer)** with **Node.js & Socket.io** serving as the 4-digit/QR-based signaling layer.

Because transfers run directly peer-to-peer, files never touch a cloud server. Transfer speeds are limited only by your local Wi-Fi router, and there are **no file size limits**.

---

## 🚀 Key Features

- **Direct P2P Transfer:** Ultra-fast, zero-cloud file transfers using WebRTC `RTCDataChannel` in binary bytes mode.
- **Backpressure & Chunking:** Optimally slices files into 16KB chunks and monitors `bufferedAmount` to prevent memory bottlenecks or channel disconnects, enabling high-speed transfers of very large files (even gigabytes) reliably.
- **Dual Pairing Mechanism:** Connect instantly using a unique **4-digit numerical room code** or by scanning a **QR Code**.
- **Auto-Join URL:** The QR Code encodes the direct URL (`http://<IP>:3000/?code=XXXX`). Scanning it automatically opens the web app and pairs the mobile device to the host instantly.
- **Premium Glassmorphic UI:** A beautiful dark-theme interface with floating color decorations, smooth CSS animations, live transfer speeds, drag-and-drop support, and file download indicators.

---

## 🛠️ Architecture & Modularity

The codebase is engineered to be exceptionally clean, modular, and separated by concerns:

1. **`server.js` (Signaling Server):**
   - Node.js + Express + Socket.io server.
   - Manages code generation (1000–9999), rooms (maximum 2 peers), and routes RTC signal packets (offers, answers, ICE candidates) between the peers.
2. **`public/index.html` & `style.css` (User Interface):**
   - Implements responsive screen transitions and glassmorphic card styles.
3. **`public/js/socket-manager.js` (Signaling Client):**
   - Standardizes the signaling connection, handling room creation, code validation, and SDP/ICE routing.
4. **`public/js/webrtc-manager.js` (WebRTC Controller):**
   - Manages the RTCPeerConnection life cycle, ICE collection, and the binary data channel.
   - Implements chunked binary stream reading via `FileReader`, backpressure congestion handling via the `'bufferedamountlow'` event, and binary byte array reconstruction on receipt.
5. **`public/js/app.js` (App Controller):**
   - Binds UI controls, triggers drag-and-drop operations, measures real-time speed in MB/s, and initiates QR generation and URL query parameter parsing.

---

## 🏁 How to Run

1. Make sure you have [Node.js](https://nodejs.org/) installed.
2. Navigate to the project directory:
   ```bash
   cd C:\Users\samue\Projects\airdrop-mvp
   ```
3. Start the signaling server:
   ```bash
   npm start
   ```
4. The server will output:
   ```text
   Signaling server running on http://localhost:3000
   Local network access via http://<YOUR_LOCAL_IP>:3000
   ```

---

## 📱 How to Use (Local Network Transfer)

For transferring files between a **desktop** and a **mobile phone**:

1. **Start as Receiver:**
   - On your desktop browser, navigate to `http://localhost:3000`.
   - Under **Set up as Receiver**, click **Generate Pairing Code**.
   - A unique 4-digit code (e.g., `4839`) and a QR code will fade in.

2. **Connect from Sender (Mobile):**
   - Ensure your phone is connected to the **same Wi-Fi network** as your desktop.
   - **Method A (Easiest):** Scan the QR code displayed on the desktop using your mobile camera. It will open the URL with the auto-pairing parameter (e.g. `http://192.168.1.50:3000/?code=4839`) and connect automatically!
   - **Method B:** Open your mobile browser, navigate to your desktop's local IP address (e.g., `http://192.168.1.50:3000`), enter the 4-digit code shown on the desktop, and click **Connect Device**.

3. **Transfer Files:**
   - Once connected, both screens will change to the **Active Connection** screen showing `Secured P2P Connection Active`.
   - On the sender device, drag-and-drop any file into the designated transfer area, or click the zone to choose a file from your device files / photo library.
   - The file will be streamed directly from peer to peer. You'll see real-time progress, percentage, and instantaneous transfer speeds (e.g., `12.5 MB/s`).
   - On the receiving device, once the transfer hits 100%, the browser will instantly prompt to save or automatically download the reconstructed file in bytes.
   - Click **Transfer Another File** to send more, or **Disconnect** to close the session.
