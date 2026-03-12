/**
 * Google Apps Script — Whatnot Sales Webhook
 *
 * Setup:
 * 1. Go to https://script.google.com
 * 2. Click "New project"
 * 3. Delete the default code and paste this entire file
 * 4. Click "Deploy" > "New deployment"
 * 5. Choose type: "Web app"
 * 6. Set "Execute as": "Me"
 * 7. Set "Who has access": "Anyone"
 * 8. Click "Deploy" and authorize when prompted
 * 9. Copy the Web App URL and paste it into the extension settings
 *
 * If updating: Deploy > Manage deployments > Edit > New version > Deploy
 */

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const ss = getOrCreateSpreadsheet();

    if (data.type === "session_summary") {
      writeSummary(ss, data);
    } else if (data.messages && Array.isArray(data.messages)) {
      writeChat(ss, data);
    } else {
      writeSale(ss, data);
    }

    return ContentService
      .createTextOutput(JSON.stringify({ status: "ok" }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: "error", message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function getOrCreateSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (ss) return ss;

  var props = PropertiesService.getScriptProperties();
  var ssId = props.getProperty("SPREADSHEET_ID");
  if (ssId) {
    try { return SpreadsheetApp.openById(ssId); } catch (_) {}
  }

  ss = SpreadsheetApp.create("Whatnot Sales Tracker");
  props.setProperty("SPREADSHEET_ID", ss.getId());
  return ss;
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(headers);
    sheet.getRange("1:1").setFontWeight("bold");
    sheet.setFrozenRows(1);
  } else {
    var currentCols = sheet.getLastColumn();
    if (currentCols < headers.length) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange("1:1").setFontWeight("bold");
    }
  }
  return sheet;
}

var SALE_HEADERS = [
  "Timestamp", "Session ID", "Item", "Sale Price", "Cost",
  "Net (after 15%)", "Profit", "Bids", "Auction Duration (s)", "Gap From Last (s)",
  "Description", "Source", "Sale ID"
];
var SALE_ID_COL = 12; // 0-indexed column index of "Sale ID" in SALE_HEADERS

function buildSaleRow(data, source) {
  return [
    data.timestamp ? new Date(data.timestamp).toLocaleString() : new Date().toLocaleString(),
    data.sessionId || "",
    data.title || "",
    data.saleAmount != null ? data.saleAmount : "",
    data.costAmount != null ? data.costAmount : "",
    data.netAmount != null ? data.netAmount : "",
    data.profit != null ? data.profit : "",
    data.bidCount != null ? data.bidCount : "",
    data.auctionDuration != null ? Math.round(data.auctionDuration / 1000) : "",
    data.gapFromLast != null ? Math.round(data.gapFromLast / 1000) : "",
    data.description || "",
    source,
    data.saleId || ""
  ];
}

function findRowBySaleId(sheet, saleId) {
  if (!saleId) return -1;
  var values = sheet.getDataRange().getValues();
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][SALE_ID_COL]) === String(saleId)) return i + 1; // 1-indexed row
  }
  return -1;
}

function writeSale(ss, data) {
  // Use a script-level lock so that two devices firing simultaneously
  // cannot both pass the duplicate check before either one sets the cache key.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (e) {
    console.log("Could not acquire lock: " + e.message);
    return;
  }
  try {
    var sheet = ensureSheet(ss, "Sales", SALE_HEADERS);
    var saleId = data.saleId || null;
    var isPrimary = data.priority === "primary";
    var cache = CacheService.getScriptCache();
    var primaryKey = saleId ? "primary_" + saleId : null;
    var secondaryKey = saleId ? "secondary_" + saleId : null;

    if (isPrimary) {
      // Primary: skip only if we already wrote as primary
      if (primaryKey && cache.get(primaryKey)) {
        console.log("Primary duplicate skipped: " + saleId);
        return;
      }
      var row = buildSaleRow(data, "Primary");
      // If a secondary row was already written, replace it in-place
      var existingRow = saleId ? findRowBySaleId(sheet, saleId) : -1;
      if (existingRow > 0) {
        sheet.getRange(existingRow, 1, 1, row.length).setValues([row]);
        console.log("Primary overwrote secondary row for: " + saleId);
      } else {
        sheet.appendRow(row);
      }
      if (primaryKey) cache.put(primaryKey, "1", 300);
    } else {
      // Secondary: skip if primary already wrote, or if secondary already wrote
      if (primaryKey && cache.get(primaryKey)) {
        console.log("Secondary skipped (primary already wrote): " + saleId);
        return;
      }
      if (secondaryKey && cache.get(secondaryKey)) {
        console.log("Secondary duplicate skipped: " + saleId);
        return;
      }
      sheet.appendRow(buildSaleRow(data, "Secondary"));
      if (secondaryKey) cache.put(secondaryKey, "1", 300);
    }
  } finally {
    lock.releaseLock();
  }
}

function writeSummary(ss, data) {
  const sheet = ensureSheet(ss, "Sessions", [
    "Session Start", "Session ID", "Total Sales", "Total Revenue",
    "Total Cost", "Total Net", "Total Profit", "Avg Auction (s)", "Avg Gap (s)"
  ]);
  sheet.appendRow([
    data.startedAt ? new Date(data.startedAt).toLocaleString() : new Date().toLocaleString(),
    data.sessionId || "",
    data.totalSales != null ? data.totalSales : "",
    data.totalRevenue != null ? data.totalRevenue : "",
    data.totalCost != null ? data.totalCost : "",
    data.totalNet != null ? data.totalNet : "",
    data.totalProfit != null ? data.totalProfit : "",
    data.avgAuction != null ? Math.round(data.avgAuction / 1000) : "",
    data.avgGap != null ? Math.round(data.avgGap / 1000) : ""
  ]);
}

function writeChat(ss, data) {
  const sheet = ensureSheet(ss, "Chat", ["Timestamp", "Session ID", "Username", "Message"]);
  const sessionId = data.sessionId || "";
  const messages = data.messages || [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    sheet.appendRow([
      msg.timestamp ? new Date(msg.timestamp).toLocaleString() : new Date().toLocaleString(),
      sessionId,
      msg.username || "",
      msg.text || ""
    ]);
  }
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({
      status: "ok",
      version: 2,
      message: "Whatnot Sales Webhook is running. Use POST to send data."
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
