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
- **Past sessions** — view previous session summaries (stored in localStorage)
- **CSV export** — download any session's data as a spreadsheet

## Branches

- `master` — simple version (cost + sale alerts only)
- `analytics` — this branch (full session tracking)

## Install locally

1. Open `chrome://extensions` (or `opera://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Notes

- The extension reads Whatnot GraphQL traffic and DOM elements while you are on a live stream URL.
- Item costs are fetched from the Whatnot inventory page for each listing ID.
- Session data is stored in `localStorage` (persists across page refreshes, up to 50 sessions).
- If a cost is not set for an item, the popup will say `Not set`.
