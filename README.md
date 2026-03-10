# Whatnot Profit & Cost Alerts (Analytics)

Full-featured Chrome/Opera extension for Whatnot livestream sellers.

## Features

- **Sale alerts** — green popup + pulse for profit, red for loss (after 15% fee)
- **Item cost on load** — shows cost when a new item is pinned/started
- **Auction duration tracking** — records how long each auction took from start to sale
- **Gap tracking** — time between each sale and the next auction start
- **Session analytics panel** — click the chart icon to open:
  - Total sales, revenue, cost, net, profit
  - Average auction duration and gap
  - Session elapsed time
  - Full sale-by-sale history with timestamps and timing
- **Google Sheets sync** — every sale automatically saved to a Google Sheet
- **Past sessions** — view previous session summaries (stored in localStorage)
- **CSV export** — download any session's data as a spreadsheet

## Branches

- `master` — simple version (cost + sale alerts only)
- `analytics` — this branch (full session tracking + Google Sheets)

## Install extension

1. Open `chrome://extensions` (or `opera://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Set up Google Sheets sync

1. Go to [script.google.com](https://script.google.com)
2. Click **New project**
3. Delete the default code
4. Open `google-apps-script.js` from this folder and copy all the code
5. Paste it into the Apps Script editor
6. Click **Deploy** > **New deployment**
7. Set type to **Web app**
8. Set "Execute as" to **Me**
9. Set "Who has access" to **Anyone**
10. Click **Deploy** and authorize when prompted
11. Copy the **Web App URL**
12. In the extension, click the chart icon to open the analytics panel
13. Click the gear icon, paste the URL, and click **Test**
14. You should see "Connected! Test row added to your sheet."

The extension will now auto-sync every sale to your Google Sheet. A "Sessions" tab tracks session summaries, and the "Sales" tab logs every individual sale.

## Notes

- Session data is also stored locally in `localStorage` (up to 50 sessions).
- If a cost is not set for an item, the popup will say `Not set`.
- The Google Sheet is auto-created on first sync with "Sales" and "Sessions" tabs.
