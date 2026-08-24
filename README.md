<p align="center">
  <img src="src/assets/knt-logo-horizontal.svg" alt="KNT Manager" width="340"/>
</p>

<p align="center">
  <b>Run multiple Roblox accounts side by side — one clean dashboard.</b><br/>
  <sub>A modern, feature-rich fork of MultiRoblox built with Tauri 2.</sub>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-2.0-6366f1?style=flat-square" alt="Version 2.0"/>
  <img src="https://img.shields.io/badge/platform-Windows-2dd4bf?style=flat-square" alt="Windows"/>
  <img src="https://img.shields.io/badge/license-MIT-4ade80?style=flat-square" alt="MIT License"/>
  <img src="https://img.shields.io/badge/stack-Tauri%202%20%E2%80%A2%20Rust%20%E2%80%A2%20Vanilla%20JS-f97316?style=flat-square" alt="Stack"/>
</p>

---

## ✨ Features

- 🖥️ **Multi-instance** — launch as many Roblox clients as you want, simultaneously
- 👤 **Account manager** — add, edit, organize and favorite accounts with inline renaming
- 🗂️ **Groups & categories** — launch whole teams of accounts into the same game with one click
- 🔒 **Local encryption** — accounts are stored encrypted (AES-256-GCM via scrypt, or Windows DPAPI), protected by your own key
- 🟡 **Home (tray) detection** — knows when an account lives in the Roblox system tray and tracks it
- ⚡ **Process control** — reliable Sync, Kill All, per-account kill, RAM trim and FPS control
- 📊 **Live dashboard** — real-time stats, running instances and recent activity
- 🎨 **Theme engine** — 12 built-in themes with unique background textures (grain, stars, rays, hexagons…), custom themes, and full accent/border customization
- 🔁 **Auto AFK** — keeps instances alive against the idle kick
- 🧪 **Alt generator** — BloxGen / Altgen API integration plus a free manual generator with real-time Roblox username validation
- 📈 **Tracking** — monitor your accounts and games
- 📦 **Manual backups** — password-protected, restorable on any PC
- 🌐 **i18n** — Portuguese (BR) and English

## 🖼️ Screenshots

*Coming soon.*

## 📥 Installation

1. Grab the latest **`MultiRoblox.exe`** from the [Releases](../../releases) page
2. Run it — no installer needed, portable
3. Windows 10/11 with **WebView2** runtime (usually preinstalled)

> The app stores its data under `%APPDATA%\multiroblox`. Your accounts never leave your device.

## 🛠️ Building from source

Requirements: [Rust](https://rustup.rs) (stable), [Node.js](https://nodejs.org), and a C# compiler (`csc`, ships with Windows/.NET SDK) for the native helper.

```bat
build.bat
```

That produces `dist\MultiRoblox.exe`. The frontend lives in `src/` and is embedded at compile time — rebuild after any UI change.

## 📁 Project structure

```
├─ src/              # Frontend (vanilla JS, HTML, CSS, i18n)
├─ src-tauri/        # Rust backend (process control, encryption, backups)
│  └─ src/
│     ├─ native.rs   # Roblox process management (sync, kill, watch)
│     ├─ encryption.rs # AES-256-GCM / DPAPI storage
│     ├─ backup.rs   # Password-protected backups
│     └─ ...
├─ web/              # Browser demo (mirrors the UI)
├─ site/             # Landing page
└─ build.bat         # One-command build
```

## 🤝 Credits

**KNT Manager** is a fork of the original [MultiRoblox](https://github.com/PookiePepelsss/MultiRoblox-RAM) project, rebuilt and extended by:

| | |
|---|---|
| **pookiepepelss** | Lead Developer |
| **xern** | Co-Developer |

## ⚠️ Disclaimer

This tool automates Roblox clients. Automated multi-account usage may violate Roblox's Terms of Service — **use at your own risk**. This project is not affiliated with or endorsed by Roblox Corporation. All trademarks belong to their respective owners.

## 📄 License

[MIT](LICENSE)
