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

function writeSale(ss, data) {
  const sheet = ensureSheet(ss, "Sales", [
    "Timestamp", "Session ID", "Item", "Sale Price", "Cost",
    "Net (after 15%)", "Profit", "Bids", "Auction Duration (s)", "Gap From Last (s)"
  ]);
  sheet.appendRow([
    data.timestamp ? new Date(data.timestamp).toLocaleString() : new Date().toLocaleString(),
    data.sessionId || "",
    data.title || "",
    data.saleAmount != null ? data.saleAmount : "",
    data.costAmount != null ? data.costAmount : "",
    data.netAmount != null ? data.netAmount : "",
    data.profit != null ? data.profit : "",
    data.bidCount != null ? data.bidCount : "",
    data.auctionDuration != null ? Math.round(data.auctionDuration / 1000) : "",
    data.gapFromLast != null ? Math.round(data.gapFromLast / 1000) : ""
  ]);
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
