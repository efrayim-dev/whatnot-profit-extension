# Whatnot Profit & Cost Alerts

Chrome/Opera extension that:

- Shows a popup when a new sale is detected on a Whatnot livestream.
- Calculates:
  - sale price
  - item cost
  - net after 15% fee
  - difference (`net - cost`)
- Shows a popup when a listing/auction item loads, with current item cost.

## Install locally

1. Open `chrome://extensions` (or `opera://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder.

## Notes

- The extension reads Whatnot GraphQL traffic and polls sold items while you are on a live stream URL.
- Item costs are fetched from the Whatnot inventory page for each listing ID.
- If a cost is not set for an item, the popup will say `Not set`.
