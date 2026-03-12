# Whatnot Profit & Cost Alerts (Analytics)

Full-featured Chrome/Opera extension for Whatnot livestream sellers, with optional cloud server for 24/7 tracking.

## Features

- **Sale alerts** — green popup + pulse for profit, red for loss (after 15% fee)
- **Item cost on load** — shows cost when a new item is pinned/started
- **Bid count tracking** — captures bids per auction
- **Auction duration tracking** — records how long each auction took
- **Gap tracking** — time between each sale and the next auction start
- **Chat message log** — every chat message saved to Google Sheets
- **Session analytics panel** — full stats, sale history, past sessions
- **Google Sheets sync** — all data auto-saved to a spreadsheet
- **CSV export** — download any session as a spreadsheet
- **Cloud server** — runs headless on a VPS so you don't need a tab open

## Branches

- `master` — simple version (cost + sale alerts only)
- `analytics` — this branch (full tracking + Sheets + server)

## Install extension locally

1. Open `chrome://extensions` (or `opera://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Set up Google Sheets sync

1. Go to [script.google.com](https://script.google.com)
2. Click **New project**
3. Paste the code from `google-apps-script.js`
4. Deploy as **Web app** (Execute as: Me, Access: Anyone)
5. Copy the URL, paste in extension settings (gear icon in analytics panel)

## Cloud server setup (optional — for 24/7 tracking)

This runs a headless browser on a VPS so sales are tracked even when your computer is off.

### Option A: Docker (recommended)

1. Get a VPS ($5/month — DigitalOcean, Hetzner, Vultr, etc.)
2. SSH into the server and install Docker
3. Clone the repo:
   ```
   git clone https://github.com/efrayim-dev/whatnot-profit-extension.git
   cd whatnot-profit-extension
   git checkout analytics
   ```
4. Build and run:
   ```
   cd server
   docker compose up -d
   ```
5. The API runs on port 3000.

### Option B: Direct Node.js

1. Install Node.js 20+ and Chromium on the server
2. Clone the repo and checkout `analytics`
3. Install dependencies:
   ```
   cd server
   npm install
   ```
4. First time — log in to Whatnot (requires a display, or use VNC):
   ```
   npm run login
   ```
   This opens a real browser. Log in, then close it. Session is saved.
5. Start the server:
   ```
   npm start
   ```

### Server API

Once running, control it via HTTP:

| Endpoint | Method | Description |
|---|---|---|
| `/status` | GET | Current status (watching, idle, uptime) |
| `/watch` | POST | Start watching a stream. Body: `{ "url": "https://www.whatnot.com/live/..." }` |
| `/stop` | POST | Stop watching |
| `/screenshot` | GET | JPEG screenshot of current page |

**Example — start watching a show:**
```
curl -X POST http://your-server:3000/watch \
  -H "Content-Type: application/json" \
  -d '{"url": "https://www.whatnot.com/live/your-show-id"}'
```

**Check status:**
```
curl http://your-server:3000/status
```

### How it works

- The server runs Chrome headless with the extension loaded
- It navigates to your Whatnot live stream page
- The extension does everything it normally does: tracks sales, bids, chat, timing
- Data flows to Google Sheets via the webhook (same setup as the browser extension)
- If the page crashes or navigates away, it auto-recovers
- Your browser session is saved, so you stay logged in

### First-time login

The server needs your Whatnot session. Two options:

1. **On a machine with a screen**: Run `npm run login`, log in normally, close the browser
2. **On a headless VPS**: Use VNC or X11 forwarding to get a display, then run `npm run login`

The session persists in `server/browser-profile/`. It should stay valid for weeks/months as long as the server is running (Whatnot refreshes the session automatically).

## Notes

- Session data is stored locally in `localStorage` (up to 50 sessions) and synced to Google Sheets
- If a cost is not set for an item, the popup will say `Not set`
- The Google Sheet is auto-created with Sales, Sessions, and Chat tabs
- Duplicate chat messages (same username + same text) are intentionally deduplicated to reduce spam. If full chat accuracy is needed in the future, add a timestamp bucket to the hash key in `extractChatMessage` / `recentChatHashes`

## Future ideas

### Auction submission from the extension
Rather than setting auction parameters (duration, starting bid, buy now price) through Whatnot's UI each time, the extension could submit auctions directly.

Two approaches:
1. **DOM automation** — the extension auto-fills and clicks through Whatnot's existing auction setup form
2. **GraphQL mutation** — capture the `StartAuction` (or equivalent) mutation from DevTools Network tab when starting a live auction, then replay it directly from the extension using the existing session cookie (`credentials: "include"`)

Option 2 is cleaner. To implement, capture a HAR file or Network tab screenshot of the exact request Whatnot sends when you start an auction. The extension already has `bridge.js` hooking `fetch`/`XHR`, so the mutation name and variables can be logged from there.

Once the mutation is known, build a small form in the live view popup (duration, starting bid, buy now) with a "Start" button that fires it for the currently pinned item. Last-used values would be saved to `localStorage`.

### Show duration tracking
Whatnot displays a HH:MM:SS counter for how long the show has been live. Capture this with a DOM selector (need to get the JS path from the live page) and log it per-sale alongside viewer count. Could also be used to compute more accurate per-hour rates.
