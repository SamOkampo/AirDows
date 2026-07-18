# AirDows Native Android

This folder documents the Android shell generated with Capacitor. The web interface remains in `public`, while Android supplies a stable native container and runtime configuration.

## Build configuration

The native app needs the public HTTPS address of the signaling server at build time. In PowerShell:

```powershell
$env:AIRDOWS_SIGNALING_URL = 'https://your-airdows-domain.example'
npm run native:sync
npm run native:open
```

Open Android Studio, select a physical Android device, then run the app. Do not use `http://` in production: WebRTC, secure storage, and modern browser APIs require HTTPS.

## Background transfer roadmap

The Android shell starts a foreground service with a persistent transfer notification while AirDows is sending or receiving. This keeps the app process substantially more resilient, but it is not a claim that a WebView can keep WebRTC alive indefinitely while Android is locked. The production background engine must move transfer ownership into native Android code:

1. Android foreground service owns the active transfer and persistent notification.
2. Native WebRTC data channel writes directly to a file stream.
3. The web UI receives progress through a Capacitor plugin.
4. The server signaling protocol remains compatible with the current Socket.IO messages.

iOS requires a separate native implementation and cannot promise unrestricted background WebRTC operation.
