(function () {
  const GRAPHQL_URL = "https://www.whatnot.com/services/graphql/";
  const EXT_VERSION =
    typeof chrome !== "undefined" && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : "dev";
  const LIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const FEE_MULTIPLIER = 0.85;
  const POLL_MS = 500;
  const STORAGE_KEY = "wn_profit_sessions";
  const TOAST_POS_KEY = "wn_profit_toast_pos";
  const FOCUS_SEARCH_KEY = "wn_profit_focus_search";
  const FOCUS_SEARCH_ON_START_KEY = "wn_profit_focus_search_on_start";
  const DEVICE_PRIORITY_KEY = "wn_profit_device_priority";
  const VIEW_START_KEY = "wn_profit_view_start";
  const CHAT_SYNC_INTERVAL_MS = 30000;
  const SESSION_SYNC_INTERVAL_MS = 180000; // 3 minutes

  const listingCostCache = new Map();
  const listingCostInFlight = new Map();
  const titleToListingCache = new Map();

  let currentLiveId = null;
  let pollTimer = null;
  let bridgeInstalled = false;
  let startupToastShown = false;
  let currentListingId = null;
  let currentListingCost = null;
  let currentListingCurrency = "USD";
  let currentListingDescription = null;
  let lastDomTitle = null;
  let lastTimerText = null;
  let saleAlreadyFired = false;

  /* ── Analytics state ─────────────────────────────────── */

  let session = null;
  let auctionStartTime = null;
  let lastSaleTime = null;
  let viewStartTime = 0;
  let panelVisible = false;
  let settingsVisible = false;
  const DEFAULT_WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbzSOPc9lvs9fU6S5quI0lj8RBQ_O_RbI34RNfCHzUy9eqVanHhKXltUe9D1vrXcOZ9zqw/exec";
  let webhookUrl = DEFAULT_WEBHOOK_URL;
  let sheetsConnected = true;

  let sessionSyncTimer = null;

  /* ── Chat state ──────────────────────────────────────── */

  let chatObserver = null;
  let chatBuffer = [];
  let chatSyncTimer = null;
  let lastSeenChatCount = 0;
  const recentChatHashes = new Set();

  /* ── Sheets sync ─────────────────────────────────────── */

  function loadWebhookUrl() {
    if (DEFAULT_WEBHOOK_URL) {
      webhookUrl = DEFAULT_WEBHOOK_URL;
      sheetsConnected = true;
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: "SET_WEBHOOK_URL", url: DEFAULT_WEBHOOK_URL });
      }
      console.log("[WN Profit] using hardcoded webhook URL:", DEFAULT_WEBHOOK_URL.slice(0, 50) + "...");
    }
  }

  function saveWebhookUrl(url) {
    webhookUrl = url;
    sheetsConnected = !!url;
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "SET_WEBHOOK_URL", url });
    }
  }

  const syncRetryQueue = [];
  const MAX_RETRIES = 3;
  const RETRY_INTERVAL_MS = 15000;

  function sendToBackground(type, payload, cb) {
    if (!webhookUrl || typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type, payload, webhookUrl }, cb || (() => {}));
  }

  function sendWithRetry(type, payload, cb) {
    sendToBackground(type, payload, (resp) => {
      if (resp?.ok) {
        if (cb) cb(resp);
      } else {
        console.log("[WN Profit] sync failed, queuing retry:", type);
        syncRetryQueue.push({ type, payload, retries: 0 });
        if (cb) cb(resp);
      }
    });
  }

  function processSyncRetries() {
    if (!syncRetryQueue.length) return;
    const item = syncRetryQueue[0];
    sendToBackground(item.type, item.payload, (resp) => {
      if (resp?.ok) {
        syncRetryQueue.shift();
        console.log("[WN Profit] retry succeeded:", item.type, "remaining:", syncRetryQueue.length);
      } else {
        item.retries++;
        if (item.retries >= MAX_RETRIES) {
          console.log("[WN Profit] retry exhausted after", MAX_RETRIES, "attempts, dropping:", item.type);
          syncRetryQueue.shift();
        }
      }
    });
  }

  setInterval(processSyncRetries, RETRY_INTERVAL_MS);

  function makeSaleId(timestamp) {
    const lid = currentLiveId || "unknown";
    return `${lid}|${Math.round((timestamp || Date.now()) / 5000)}`;
  }

  function getDevicePriority() {
    try { return localStorage.getItem(DEVICE_PRIORITY_KEY) === "1" ? "primary" : "secondary"; } catch { return "secondary"; }
  }

  function syncNoSaleToSheets(entry) {
    const sessionId = session ? `${session.liveId}-${session.startedAt}` : "";
    sendWithRetry("SYNC_SALE", {
      timestamp: entry.timestamp,
      sessionId,
      saleId: makeSaleId(entry.timestamp),
      priority: getDevicePriority(),
      title: entry.title || "No sale",
      saleAmount: null,
      costAmount: null,
      netAmount: null,
      profit: null,
      bidCount: null,
      viewers: entry.viewers,
      showDuration: entry.showDuration,
      auctionDuration: entry.auctionDuration,
      gapFromLast: entry.gapFromLast
    }, (resp) => {
      if (resp?.ok) console.log("[WN Profit] no-sale row synced to Sheets");
      else console.log("[WN Profit] no-sale sync failed:", resp?.error);
    });
  }

  function syncSaleToSheets(entry) {
    console.log("[WN Profit] attempting sale sync, webhookUrl:", webhookUrl ? "set" : "NOT SET");
    const sessionId = session ? `${session.liveId}-${session.startedAt}` : "";
    sendWithRetry("SYNC_SALE", {
      ...entry,
      sessionId,
      saleId: makeSaleId(entry.timestamp),
      priority: getDevicePriority()
    }, (resp) => {
      if (chrome.runtime.lastError) {
        console.log("[WN Profit] runtime error:", chrome.runtime.lastError.message);
        return;
      }
      if (resp?.ok) console.log("[WN Profit] sale synced to Sheets");
      else console.log("[WN Profit] Sheets sync failed:", resp?.error);
    });
  }

  function syncSessionSummary() {
    if (!session) return;
    const t = computeTotals(session);
    const elapsed = viewStartTime ? Date.now() - viewStartTime : 0;
    const hrs = elapsed / 3600000;
    sendWithRetry("SYNC_SESSION_SUMMARY", {
      type: "session_summary",
      sessionId: `${session.liveId}-${session.startedAt}`,
      startedAt: session.startedAt,
      totalSales: session.sales.length,
      totalRevenue: t.revenue,
      totalCost: t.cost,
      totalNet: t.net,
      totalProfit: t.profit,
      avgSale: t.avgSale,
      highestSale: t.highest,
      lowestSale: t.lowest,
      highestViewers: session.highestViewers || 0,
      showDuration: getDomShowDuration(),
      profitPerHour: hrs > 0 ? Math.round((t.profit / hrs) * 100) / 100 : null,
      revenuePerHour: hrs > 0 ? Math.round((t.revenue / hrs) * 100) / 100 : null,
      avgAuction: avg(session.auctionDurations),
      avgGap: avg(session.gapDurations)
    }, (resp) => {
      if (resp?.ok) console.log("[WN Profit] session summary synced to Sheets");
      else console.log("[WN Profit] session summary sync failed:", resp?.error);
    });
  }

  function startSessionSync() {
    if (sessionSyncTimer) clearInterval(sessionSyncTimer);
    sessionSyncTimer = setInterval(() => {
      syncSessionSummary();
      saveSession();
    }, SESSION_SYNC_INTERVAL_MS);
  }

  function stopSessionSync() {
    if (sessionSyncTimer) { clearInterval(sessionSyncTimer); sessionSyncTimer = null; }
  }

  function syncChatBatch() {
    if (!chatBuffer.length) return;
    const batch = chatBuffer.splice(0);
    sendWithRetry("SYNC_CHAT", {
      sessionId: session ? `${session.liveId}-${session.startedAt}` : "",
      messages: batch
    }, (resp) => {
      if (resp?.ok) console.log("[WN Profit] chat batch synced:", batch.length, "messages");
      else console.log("[WN Profit] chat sync failed:", resp?.error);
    });
  }

  /* ── Session management ──────────────────────────────── */

  function newSession(liveId) {
    return {
      liveId,
      startedAt: Date.now(),
      sales: [],
      totalRevenue: 0,
      totalCost: 0,
      totalProfit: 0,
      totalNet: 0,
      totalBids: 0,
      highestViewers: 0,
      auctionDurations: [],
      gapDurations: []
    };
  }

  let pastSessionsCache = null;

  function saveSession() {
    if (!session) return;
    pastSessionsCache = null;
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      const idx = stored.findIndex(s => s.liveId === session.liveId);
      if (session.sales.length === 0) {
        if (idx >= 0) stored.splice(idx, 1);
      } else if (idx >= 0) {
        stored[idx] = session;
      } else {
        stored.push(session);
      }
      if (stored.length > 50) stored.splice(0, stored.length - 50);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {}
  }

  function loadPastSessions() {
    if (pastSessionsCache) return pastSessionsCache;
    try {
      const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      const merged = new Map();
      for (const s of raw) {
        const key = s.liveId;
        if (!key) continue;
        if (!merged.has(key)) { merged.set(key, s); continue; }
        const existing = merged.get(key);
        existing.startedAt = Math.min(existing.startedAt, s.startedAt);
        existing.sales = (existing.sales || []).concat(s.sales || []);
        existing.totalRevenue = (existing.totalRevenue || 0) + (s.totalRevenue || 0);
        existing.totalCost = (existing.totalCost || 0) + (s.totalCost || 0);
        existing.totalNet = (existing.totalNet || 0) + (s.totalNet || 0);
        existing.totalProfit = (existing.totalProfit || 0) + (s.totalProfit || 0);
        existing.totalBids = (existing.totalBids || 0) + (s.totalBids || 0);
        existing.auctionDurations = (existing.auctionDurations || []).concat(s.auctionDurations || []);
        existing.gapDurations = (existing.gapDurations || []).concat(s.gapDurations || []);
      }
      const result = Array.from(merged.values()).filter(s => s.sales && s.sales.length > 0);
      if (result.length !== raw.length) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(result));
      }
      pastSessionsCache = result;
      return result;
    } catch { return []; }
  }

  function recordSale(entry) {
    if (!session) return;
    session.sales.push(entry);
    if (typeof entry.saleAmount === "number") session.totalRevenue += entry.saleAmount;
    if (typeof entry.costAmount === "number") session.totalCost += entry.costAmount;
    if (typeof entry.netAmount === "number") session.totalNet += entry.netAmount;
    if (typeof entry.profit === "number") session.totalProfit += entry.profit;
    if (typeof entry.bidCount === "number") session.totalBids += entry.bidCount;
    if (typeof entry.viewers === "number" && entry.viewers > (session.highestViewers || 0)) {
      session.highestViewers = entry.viewers;
    }
    if (typeof entry.auctionDuration === "number") session.auctionDurations.push(entry.auctionDuration);
    if (typeof entry.gapFromLast === "number") session.gapDurations.push(entry.gapFromLast);
    saveSession();
    syncSaleToSheets(entry);
  }

  function formatDuration(ms) {
    if (typeof ms !== "number" || ms < 0) return "\u2014";
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function avg(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  // Recompute totals from the raw sales array so Revenue/Cost/Profit
  // are always internally consistent, regardless of how they were accumulated.
  function computeTotals(s) {
    let revenue = 0, cost = 0, bids = 0;
    let highest = -Infinity, lowest = Infinity, salesWithAmount = 0;
    for (const sale of (s.sales || [])) {
      if (typeof sale.saleAmount === "number") {
        revenue += sale.saleAmount;
        salesWithAmount++;
        if (sale.saleAmount > highest) highest = sale.saleAmount;
        if (sale.saleAmount < lowest) lowest = sale.saleAmount;
      }
      if (typeof sale.costAmount === "number") cost += sale.costAmount;
      if (typeof sale.bidCount === "number") bids += sale.bidCount;
    }
    const net = revenue * FEE_MULTIPLIER;
    const profit = net - cost;
    const avgSale = salesWithAmount > 0 ? revenue / salesWithAmount : 0;
    return {
      revenue, cost, net, profit, bids, avgSale,
      highest: highest === -Infinity ? 0 : highest,
      lowest: lowest === Infinity ? 0 : lowest,
      salesWithAmount
    };
  }

  /* ── Helpers ─────────────────────────────────────────── */

  function normalizeListingId(value) {
    if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
    if (typeof value !== "string") return null;
    const out = value.trim();
    return out.length ? out : null;
  }

  function decodeRelayListingId(value) {
    const raw = normalizeListingId(value);
    if (!raw) return null;
    if (/^\d+$/.test(raw)) return raw;
    try {
      const decoded = atob(raw);
      const m = /^ListingNode:(\d+)$/.exec(decoded);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function getLiveIdFromLocation() {
    const parts = location.pathname.split("/").filter(Boolean);
    for (let i = 0; i < parts.length; i += 1) {
      if (parts[i] === "live" && LIVE_ID_RE.test(parts[i + 1] || "")) {
        return parts[i + 1].toLowerCase();
      }
    }
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (LIVE_ID_RE.test(parts[i])) return parts[i].toLowerCase();
    }
    const qp = new URLSearchParams(location.search).get("liveId");
    return qp && LIVE_ID_RE.test(qp) ? qp.toLowerCase() : null;
  }

  function formatMoney(amount, currency) {
    if (typeof amount !== "number" || Number.isNaN(amount)) return "";
    const code = (currency || "USD").toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(amount);
    } catch {
      return `${amount.toFixed(2)} ${code}`;
    }
  }

  function parseDomPrice(text) {
    if (!text) return null;
    const cleaned = text.replace(/[^0-9.]/g, "");
    const num = parseFloat(cleaned);
    return Number.isFinite(num) ? num : null;
  }

  function escHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* ── UI ─────────────────────────────────────────────── */

  // CSS is now loaded from styles.css via manifest.json

  function getPopupElement() {
    const id = "wn-profit-toast";
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.className = "wn-profit-toast";
      document.documentElement.appendChild(el);
    }
    if (!el.querySelector(".wn-toast-drag")) {
      const body = document.createElement("div");
      body.className = "wn-toast-body";
      while (el.firstChild) body.appendChild(el.firstChild);
      el.innerHTML = "";
      const dragHandle = document.createElement("div");
      dragHandle.className = "wn-toast-drag";
      dragHandle.innerHTML = `
        <span class="wn-drag-handle-text">Move</span>
        <div class="wn-focus-toggles">
          <label class="wn-focus-search-toggle">
            <input type="checkbox" id="wn-focus-search-cb" />
            <span>On auction end</span>
          </label>
          <label class="wn-focus-search-toggle">
            <input type="checkbox" id="wn-focus-search-start-cb" />
            <span>On start</span>
          </label>
        </div>`;
      try {
        dragHandle.querySelector("#wn-focus-search-cb").checked = localStorage.getItem(FOCUS_SEARCH_KEY) === "1";
        dragHandle.querySelector("#wn-focus-search-start-cb").checked = localStorage.getItem(FOCUS_SEARCH_ON_START_KEY) === "1";
      } catch {}
      dragHandle.querySelector("#wn-focus-search-cb").addEventListener("change", (e) => {
        try { localStorage.setItem(FOCUS_SEARCH_KEY, e.target.checked ? "1" : "0"); } catch {}
      });
      dragHandle.querySelector("#wn-focus-search-start-cb").addEventListener("change", (e) => {
        try { localStorage.setItem(FOCUS_SEARCH_ON_START_KEY, e.target.checked ? "1" : "0"); } catch {}
      });
      el.appendChild(dragHandle);
      el.appendChild(body);
    }
    if (!el.dataset.dragInit) {
      el.dataset.dragInit = "1";
      try {
        const pos = JSON.parse(localStorage.getItem(TOAST_POS_KEY) || "{}");
        if (typeof pos.left === "number" && typeof pos.top === "number") {
          el.style.left = pos.left + "px";
          el.style.top = pos.top + "px";
        }
      } catch {}
      const handle = el.querySelector(".wn-toast-drag");
      handle.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (e.target.closest(".wn-focus-toggles")) return;
        e.preventDefault();
        const startX = e.clientX - el.getBoundingClientRect().left;
        const startY = e.clientY - el.getBoundingClientRect().top;
        const onMove = (ev) => {
          let left = ev.clientX - startX;
          let top = ev.clientY - startY;
          left = Math.max(0, Math.min(left, window.innerWidth - el.offsetWidth));
          top = Math.max(0, Math.min(top, window.innerHeight - 40));
          el.style.left = left + "px";
          el.style.top = top + "px";
        };
        const onUp = () => {
          document.removeEventListener("mousemove", onMove);
          document.removeEventListener("mouseup", onUp);
          try {
            const rect = el.getBoundingClientRect();
            localStorage.setItem(TOAST_POS_KEY, JSON.stringify({ left: rect.left, top: rect.top }));
          } catch {}
        };
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
      });
    }
    return el;
  }

  function getToastBody() {
    const el = getPopupElement();
    return el.querySelector(".wn-toast-body") || el;
  }

  function setPopup(html) {
    const el = getPopupElement();
    const body = getToastBody();
    el.classList.remove("sale-profit", "sale-loss", "pulse");
    el.style.opacity = "1";
    el.style.transition = "";
    body.innerHTML = html;
  }

  function setStatusPopup(status, hint) {
    setPopup(
      `<div class="title">Whatnot Profit Extension (v${EXT_VERSION})</div>
       <div class="row"><span class="label">Status</span><span>${status}</span></div>
       <div class="hint">${hint}</div>`
    );
  }

  function setCurrentItemPopup(title, cost) {
    const currency = cost?.currency || "USD";
    setPopup(
      `<div class="title">Current Item</div>
       <div class="row"><span class="label">Item</span><span>${title}</span></div>
       <div class="row"><span class="label">Cost</span><span>${cost ? formatMoney(cost.amountCents / 100, currency) : "Not set"}</span></div>`
    );
  }

  function setSalePopup(saleTitle, saleAmount, costAmount, netAmount, diffAmount, currency, bidCount) {
    const el = getPopupElement();
    const body = getToastBody();
    el.classList.remove("sale-profit", "sale-loss", "pulse");
    el.style.opacity = "1";
    el.style.transition = "";
    body.innerHTML =
      `<div class="title">Sale Completed: ${escHtml(saleTitle)}</div>
       <div class="row"><span class="label">Sale</span><span>${formatMoney(saleAmount, currency)}</span></div>
       <div class="row"><span class="label">Cost</span><span>${typeof costAmount === "number" ? formatMoney(costAmount, currency) : "Not set"}</span></div>
       <div class="row"><span class="label">Net (after 15%)</span><span>${formatMoney(netAmount, currency)}</span></div>
       <div class="row"><span class="label">Profit</span><span class="${typeof diffAmount === "number" && diffAmount >= 0 ? "ok" : "bad"}">${
         typeof diffAmount === "number" ? formatMoney(diffAmount, currency) : "N/A"
       }</span></div>`;
    const isProfit = typeof diffAmount === "number" && diffAmount >= 0;
    el.classList.add(isProfit ? "sale-profit" : "sale-loss");
    void el.offsetWidth;
    el.classList.add("pulse");
  }

  /* ── Analytics panel UI ──────────────────────────────── */

  function getToggleButton() {
    let btn = document.getElementById("wn-analytics-toggle");
    if (!btn) {
      btn = document.createElement("div");
      btn.id = "wn-analytics-toggle";
      btn.className = "wn-analytics-toggle";
      btn.textContent = "\u{1F4CA}";
      btn.title = "Toggle analytics panel";
      btn.addEventListener("click", togglePanel);
      document.documentElement.appendChild(btn);
    }
    return btn;
  }

  function getAnalyticsPanel() {
    let panel = document.getElementById("wn-analytics-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.id = "wn-analytics-panel";
      panel.className = "wn-analytics-panel";
      document.documentElement.appendChild(panel);
    }
    return panel;
  }

  function togglePanel() {
    panelVisible = !panelVisible;
    const panel = getAnalyticsPanel();
    panel.classList.toggle("open", panelVisible);
    if (panelVisible) renderPanel();
  }

  function renderPanel(viewSession) {
    const panel = getAnalyticsPanel();
    const s = viewSession || session;
    if (!s) {
      panel.innerHTML = `
        <div class="panel-header"><span>Session Analytics</span></div>
        <div class="empty-state">No active session. Start a live stream to begin tracking.</div>`;
      renderPastSessions(panel);
      return;
    }

    let elapsed;
    if (s === session) {
      elapsed = viewStartTime ? Date.now() - viewStartTime : Date.now() - s.startedAt;
    } else if (s.sales && s.sales.length >= 2) {
      const ts = s.sales.map(e => e.timestamp);
      elapsed = Math.max(...ts) - Math.min(...ts);
    } else {
      elapsed = s.sales && s.sales.length === 1 ? 0 : (Date.now() - s.startedAt);
    }
    const saleCount = s.sales.length;
    const avgDuration = avg(s.auctionDurations);
    const avgGap = avg(s.gapDurations);
    const totals = computeTotals(s);
    const { revenue: dispRevenue, cost: dispCost, net: dispNet, profit: dispProfit, bids: dispBids, avgSale, highest, lowest } = totals;
    const profitClass = dispProfit >= 0 ? "ok" : "bad";
    const isViewing = viewSession && viewSession !== session;

    let html = `
      <div class="panel-header">
        <span>${isViewing ? "Past Session" : "Session Analytics"}</span>
        <div>
          ${isViewing ? `<button data-action="back">Back</button>` : ""}
          <button data-action="export">Export CSV</button>
          ${!isViewing ? `<button data-action="settings" title="Google Sheets settings">\u2699</button>` : ""}
        </div>
      </div>
      <div class="sheets-bar">
        <div class="sync-status">
          <span class="dot ${sheetsConnected ? "on" : "off"}"></span>
          <span>Google Sheets: ${sheetsConnected ? "Connected" : "Not connected"}</span>
        </div>
      </div>
      <div class="stats-grid">
        <div class="stat-box">
          <div class="stat-label">Sales</div>
          <div class="stat-value">${saleCount}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Total Profit</div>
          <div class="stat-value ${profitClass}">${formatMoney(dispProfit, "USD")}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Revenue</div>
          <div class="stat-value">${formatMoney(dispRevenue, "USD")}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Net (after 15%)</div>
          <div class="stat-value">${formatMoney(dispNet, "USD")}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Total Cost</div>
          <div class="stat-value">${formatMoney(dispCost, "USD")}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Profit / Hour</div>
          <div class="stat-value ${profitClass}">${elapsed > 0 ? formatMoney(dispProfit / (elapsed / 3600000), "USD") : "\u2014"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Revenue / Hour</div>
          <div class="stat-value">${elapsed > 0 ? formatMoney(dispRevenue / (elapsed / 3600000), "USD") : "\u2014"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Avg Sale</div>
          <div class="stat-value">${avgSale > 0 ? formatMoney(avgSale, "USD") : "\u2014"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Highest Sale</div>
          <div class="stat-value">${highest > 0 ? formatMoney(highest, "USD") : "\u2014"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Lowest Sale</div>
          <div class="stat-value">${lowest > 0 ? formatMoney(lowest, "USD") : "\u2014"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Total Bids</div>
          <div class="stat-value">${dispBids}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Avg Auction</div>
          <div class="stat-value">${formatDuration(avgDuration)}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Peak Viewers</div>
          <div class="stat-value">${s.highestViewers || "\u2014"}</div>
        </div>
        <div class="stat-box">
          <div class="stat-label">Avg Gap</div>
          <div class="stat-value">${formatDuration(avgGap)}</div>
        </div>
      </div>
      <div class="sale-list">
        <div class="sale-list-title">Sale History (${saleCount})</div>`;

    if (!saleCount) {
      html += `<div class="empty-state">No sales yet this session.</div>`;
    } else {
      for (let i = s.sales.length - 1; i >= 0; i--) {
        const e = s.sales[i];
        const pClass = typeof e.profit === "number" && e.profit >= 0 ? "profit" : "loss";
        const time = new Date(e.timestamp).toLocaleTimeString();
        html += `
          <div class="sale-entry ${pClass}">
            <div class="sale-name">#${i + 1} \u2014 ${escHtml(e.title || "Sale")}</div>
            <div class="sale-row"><span>Sale</span><span>${formatMoney(e.saleAmount, e.currency)}</span></div>
            <div class="sale-row"><span>Cost</span><span>${typeof e.costAmount === "number" ? formatMoney(e.costAmount, e.currency) : "Not set"}</span></div>
            <div class="sale-row"><span>Net</span><span>${formatMoney(e.netAmount, e.currency)}</span></div>
            <div class="sale-row"><span>Profit</span><span class="${pClass === "profit" ? "ok" : "bad"}">${typeof e.profit === "number" ? formatMoney(e.profit, e.currency) : "N/A"}</span></div>
            <div class="sale-meta">${time} \u00B7 Bids: ${e.bidCount ?? "\u2014"} \u00B7 Auction: ${formatDuration(e.auctionDuration)} \u00B7 Gap: ${formatDuration(e.gapFromLast)}</div>
          </div>`;
      }
    }
    html += `</div>`;
    panel.innerHTML = html;

    const backBtn = panel.querySelector('[data-action="back"]');
    if (backBtn) backBtn.addEventListener("click", () => renderPanel());
    const exportBtn = panel.querySelector('[data-action="export"]');
    if (exportBtn) exportBtn.addEventListener("click", () => exportCsv(s));
    const settingsBtn = panel.querySelector('[data-action="settings"]');
    if (settingsBtn) settingsBtn.addEventListener("click", () => {
      settingsVisible = !settingsVisible;
      renderSettingsSection(panel);
    });

    if (settingsVisible && !isViewing) renderSettingsSection(panel);
    if (!isViewing) {
      renderPastSessions(panel);
      renderPrimaryDeviceSection(panel);
    }
  }

  function renderPrimaryDeviceSection(panel) {
    const isPrimary = (() => { try { return localStorage.getItem(DEVICE_PRIORITY_KEY) === "1"; } catch { return false; } })();
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "margin-top:12px;padding:8px 10px;border-top:1px solid rgba(255,255,255,0.08);";

    if (isPrimary) {
      wrapper.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;font-size:11px;">
          <span style="color:#86efac;">\u2713 Primary device active</span>
          <button data-action="revoke-primary" style="font-size:10px;padding:2px 6px;background:#374151;color:#e2e8f0;border:1px solid #4b5563;border-radius:4px;cursor:pointer;">Revoke</button>
        </div>`;
      panel.appendChild(wrapper);
      wrapper.querySelector('[data-action="revoke-primary"]').addEventListener("click", () => {
        try { localStorage.setItem(DEVICE_PRIORITY_KEY, "0"); } catch {}
        renderPanel();
      });
    } else {
      wrapper.innerHTML = `
        <div style="font-size:11px;color:#94a3b8;margin-bottom:4px;">Enable primary device</div>
        <div style="display:flex;gap:4px;align-items:center;">
          <input type="password" id="wn-primary-key" placeholder="Enter key" style="flex:1;padding:3px 6px;font-size:11px;background:#1e293b;color:#e2e8f0;border:1px solid #334155;border-radius:4px;" />
          <button data-action="unlock-primary" style="font-size:10px;padding:3px 8px;background:#374151;color:#e2e8f0;border:1px solid #4b5563;border-radius:4px;cursor:pointer;">Unlock</button>
        </div>
        <div class="primary-msg" style="font-size:10px;margin-top:4px;"></div>`;
      panel.appendChild(wrapper);
      wrapper.querySelector('[data-action="unlock-primary"]').addEventListener("click", () => {
        const input = wrapper.querySelector("#wn-primary-key");
        const msg = wrapper.querySelector(".primary-msg");
        if (input.value === "efrayimwhatnot") {
          try { localStorage.setItem(DEVICE_PRIORITY_KEY, "1"); } catch {}
          renderPanel();
        } else {
          msg.textContent = "Incorrect key.";
          msg.style.color = "#fda4af";
        }
      });
    }
  }

  function renderPastSessions(panel) {
    const past = loadPastSessions().filter(
      s => !(session && s.liveId === session.liveId)
    );
    if (!past.length) return;

    let html = `<div class="past-sessions"><div class="sale-list-title">Past Sessions</div>`;
    for (let i = past.length - 1; i >= 0; i--) {
      const s = past[i];
      const d = new Date(s.startedAt).toLocaleString();
      const { revenue: pRev, profit: pProfit } = computeTotals(s);
      const profitClass = pProfit >= 0 ? "ok" : "bad";
      html += `
        <div class="past-session-entry" data-idx="${i}">
          <div class="ps-date">${d}</div>
          <div class="ps-stats">${s.sales.length} sales \u00B7 Profit: <span class="${profitClass}">${formatMoney(pProfit, "USD")}</span> \u00B7 Revenue: ${formatMoney(pRev, "USD")}</div>
        </div>`;
    }
    html += `</div>`;
    panel.insertAdjacentHTML("beforeend", html);

    panel.querySelectorAll(".past-session-entry").forEach(el => {
      el.addEventListener("click", () => {
        const idx = parseInt(el.dataset.idx, 10);
        renderPanel(past[idx]);
      });
    });
  }

  function renderSettingsSection(panel) {
    let section = panel.querySelector(".settings-section");
    if (!settingsVisible) { if (section) section.remove(); return; }
    if (section) return;
    const sheetsBar = panel.querySelector(".sheets-bar");
    if (!sheetsBar) return;

    section = document.createElement("div");
    section.className = "settings-section";
    section.innerHTML = `
      <label>Google Sheets Webhook URL</label>
      <input type="text" placeholder="https://script.google.com/macros/s/.../exec" value="${escHtml(webhookUrl)}" />
      <div class="settings-actions">
        <button class="save-btn">Save</button>
        <button class="test-btn">Test</button>
        ${webhookUrl ? `<button class="sync-btn">Sync Session</button>` : ""}
      </div>
      <div class="hint">
        To set up: go to script.google.com, create a new project, paste the code from
        google-apps-script.js, deploy as Web App, and paste the URL above.
      </div>
      <div class="settings-msg" style="margin-top:6px;font-size:11px;"></div>
    `;
    sheetsBar.insertAdjacentElement("afterend", section);

    const input = section.querySelector("input");
    const msgEl = section.querySelector(".settings-msg");

    section.querySelector(".save-btn").addEventListener("click", () => {
      saveWebhookUrl(input.value.trim());
      msgEl.textContent = "Saved!";
      msgEl.style.color = "#86efac";
    });

    section.querySelector(".test-btn").addEventListener("click", () => {
      const url = input.value.trim() || DEFAULT_WEBHOOK_URL;
      if (!url) { msgEl.textContent = "Enter a URL first"; msgEl.style.color = "#fda4af"; return; }
      saveWebhookUrl(url);
      msgEl.textContent = "Testing...";
      msgEl.style.color = "#e2e8f0";
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
          type: "SYNC_SALE",
          webhookUrl: url,
          payload: { timestamp: Date.now(), title: "Test Sale", saleAmount: 10, costAmount: 5, netAmount: 8.5, profit: 3.5, currency: "USD", bidCount: 3, auctionDuration: 15000, gapFromLast: 5000, sessionId: "test" }
        }, (resp) => {
          if (chrome.runtime.lastError) {
            msgEl.textContent = "Error: " + chrome.runtime.lastError.message;
            msgEl.style.color = "#fda4af";
            return;
          }
          if (resp?.ok) {
            msgEl.textContent = resp.redirected
              ? "Sent! Check Google Drive for \"Whatnot Sales Tracker\" spreadsheet."
              : "Connected! Test row added to your sheet.";
            msgEl.style.color = "#86efac";
          } else {
            msgEl.textContent = "Failed: " + (resp?.error || "unknown error");
            msgEl.style.color = "#fda4af";
          }
        });
      }
    });

    const syncBtn = section.querySelector(".sync-btn");
    if (syncBtn) {
      syncBtn.addEventListener("click", () => {
        if (!webhookUrl) {
          msgEl.textContent = "No webhook URL set";
          msgEl.style.color = "#fda4af";
          return;
        }
        syncSessionSummary();
        msgEl.textContent = "Syncing...";
        msgEl.style.color = "#e2e8f0";
      });
    }

  }

  function exportCsv(s) {
    if (!s || !s.sales.length) return;
    const headers = ["Timestamp", "Session ID", "Item", "Sale Price", "Cost", "Net (after 15%)", "Profit", "Bids", "Auction Duration (s)", "Gap From Last (s)", "Description", "Viewers", "Show Duration"];
    const rows = [headers];
    const sessionId = s.liveId ? `${s.liveId}-${s.startedAt}` : "";
    const round2 = (n) => (typeof n === "number" && !isNaN(n) ? Math.round(n * 100) / 100 : "");
    const esc = (v) => (v == null || v === "" ? "" : `"${String(v).replace(/"/g, '""')}"`);
    s.sales.forEach((e) => {
      rows.push([
        esc(e.timestamp ? new Date(e.timestamp).toLocaleString() : ""),
        esc(sessionId),
        esc(e.title || ""),
        typeof e.saleAmount === "number" ? round2(e.saleAmount) : "",
        typeof e.costAmount === "number" ? round2(e.costAmount) : "",
        typeof e.netAmount === "number" ? round2(e.netAmount) : "",
        typeof e.profit === "number" ? round2(e.profit) : "",
        typeof e.bidCount === "number" ? e.bidCount : "",
        typeof e.auctionDuration === "number" ? Math.round(e.auctionDuration / 1000) : "",
        typeof e.gapFromLast === "number" ? Math.round(e.gapFromLast / 1000) : "",
        esc(e.description || ""),
        typeof e.viewers === "number" ? e.viewers : "",
        esc(e.showDuration || "")
      ]);
    });
    const csvTotals = computeTotals(s);
    rows.push([]);
    rows.push(["Summary"]);
    rows.push(["Total Sales", s.sales.length]);
    rows.push(["Total Revenue", round2(csvTotals.revenue)]);
    rows.push(["Net (after 15%)", round2(csvTotals.net)]);
    rows.push(["Total Cost", round2(csvTotals.cost)]);
    rows.push(["Total Profit", round2(csvTotals.profit)]);
    rows.push(["Avg Sale Price", round2(csvTotals.avgSale)]);
    rows.push(["Highest Sale", round2(csvTotals.highest)]);
    rows.push(["Lowest Sale", round2(csvTotals.lowest)]);
    rows.push(["Total Bids", csvTotals.bids]);
    rows.push(["Avg Auction", typeof avg(s.auctionDurations) === "number" ? Math.round(avg(s.auctionDurations) / 1000) + "s" : ""]);
    rows.push(["Avg Gap", typeof avg(s.gapDurations) === "number" ? Math.round(avg(s.gapDurations) / 1000) + "s" : ""]);

    const csv = rows.map(r => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `whatnot-session-${new Date(s.startedAt).toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /* ── Cost fetching ─────────────────────────────────── */

  async function fetchListingCost(listingId) {
    if (!listingId) return null;
    const key = listingId.trim();
    if (!key) return null;
    if (listingCostCache.has(key)) return listingCostCache.get(key);
    if (listingCostInFlight.has(key)) return listingCostInFlight.get(key);

    const promise = (async () => {
      const url = new URL(`/dashboard/inventory/${encodeURIComponent(key)}`, location.origin).toString();
      const ctrl = new AbortController();
      const timer = window.setTimeout(() => ctrl.abort(), 4500);
      try {
        const resp = await fetch(url, {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
          signal: ctrl.signal
        });
        if (!resp.ok) return null;
        const html = await resp.text();
        const patterns = [
          /"costPerItem"\s*:\s*\{[^{}]*"amount"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"currency"\s*:\s*"([A-Za-z]{3})"/i,
          /\\"costPerItem\\"\s*:\s*\{[^{}]*\\"amount\\"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*\\"currency\\"\s*:\s*\\"([A-Za-z]{3})\\"/i
        ];
        for (const re of patterns) {
          const m = re.exec(html);
          if (!m) continue;
          const amountCents = Math.round(Number(m[1]));
          const currency = (m[2] || "USD").toUpperCase();
          if (Number.isFinite(amountCents)) return { amountCents, currency };
        }
        return null;
      } catch (e) {
        console.log("[WN Profit] fetchListingCost error for", key, ":", e?.message);
        return null;
      } finally {
        window.clearTimeout(timer);
        listingCostInFlight.delete(key);
      }
    })();

    listingCostInFlight.set(key, promise);
    const result = await promise;
    listingCostCache.set(key, result);
    return result;
  }

  /* ── DOM selectors ─────────────────────────────────── */

  const DOM_TITLE_SELECTOR = "#bottom-section-stream-container > div > div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > div > div > div:nth-child(1)";
  const DOM_BID_COUNT_SELECTOR = "#bottom-section-stream-container > div > div:nth-child(1) > div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > div > div > div:nth-child(1) > div > p";
  const DOM_PRICE_SELECTOR = "#bottom-section-stream-container > div > div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > div:nth-child(1) > div:nth-child(2)";
  const DOM_DESCRIPTION_SELECTOR = "#bottom-section-stream-container > div > div > div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > div > div > div:nth-child(2) > div:nth-child(4)";
  const DOM_VIEWER_COUNT_SELECTOR = "#app > div > div:nth-child(3) > div > div > div > div:nth-child(4) > div > div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > div:nth-child(2) > div > div:nth-child(1) > div > div:nth-child(4)";
  const DOM_SHOW_DURATION_SELECTOR = "#app > div > div:nth-child(3) > div > div > div > div:nth-child(4) > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(1) > div:nth-child(3) > div:nth-child(1) > div:nth-child(3)";
  const TIMER_PATTERN = /^\d{1,2}:\d{2}$/;
  const TIMER_CONTAINER = "#bottom-section-stream-container";
  let cachedTimerEl = null;

  let cachedSearchBar = null;
  function findSearchBar() {
    if (cachedSearchBar && cachedSearchBar.isConnected) return cachedSearchBar;
    cachedSearchBar = null;
    const suffix = "div > div > div > div:nth-child(4) > div > div:nth-child(1) > div:nth-child(1) > input";
    for (let n = 1; n <= 6; n++) {
      const el = document.querySelector(`#app > div > div:nth-child(${n}) > ${suffix}`);
      if (el) { cachedSearchBar = el; return el; }
    }
    return null;
  }

  let cachedChatContainer = null;
  function findChatContainer() {
    if (cachedChatContainer && cachedChatContainer.isConnected && cachedChatContainer.children.length > 0) {
      return cachedChatContainer;
    }
    cachedChatContainer = null;
    const suffix = "div > div > div > div:nth-child(4) > div > div:nth-child(1) > div:nth-child(3) > div:nth-child(5) > div:nth-child(3)";
    for (let n = 1; n <= 6; n++) {
      const el = document.querySelector(`#app > div > div:nth-child(${n}) > ${suffix}`);
      if (el && el.children.length >= 3) {
        cachedChatContainer = el;
        console.log("[WN Profit] chat container found at nth-child(" + n + "), children:", el.children.length);
        return el;
      }
    }
    return null;
  }

  function getDomCurrentItemTitle() {
    const el = document.querySelector(DOM_TITLE_SELECTOR);
    if (!el) return null;
    let text = "";
    for (const child of el.childNodes) {
      if (child.nodeType === 3) text += child.textContent;
    }
    text = text.trim();
    return text || null;
  }

  function getDomBidCount() {
    const el = document.querySelector(DOM_BID_COUNT_SELECTOR);
    if (!el) return null;
    const text = (el.textContent || "").trim();
    const m = /(\d+)/.exec(text);
    return m ? parseInt(m[1], 10) : null;
  }

  function getDomPrice() {
    const el = document.querySelector(DOM_PRICE_SELECTOR);
    if (!el) return null;
    return (el.textContent || "").trim() || null;
  }

  function getDomDescription() {
    const el = document.querySelector(DOM_DESCRIPTION_SELECTOR);
    return el ? (el.textContent || "").trim() || null : null;
  }

  function getDomViewerCount() {
    const el = document.querySelector(DOM_VIEWER_COUNT_SELECTOR);
    if (!el) return null;
    const text = (el.textContent || "").trim().replace(/[,\s]/g, "");
    const n = parseInt(text, 10);
    return Number.isFinite(n) ? n : null;
  }

  function getDomShowDuration() {
    const el = document.querySelector(DOM_SHOW_DURATION_SELECTOR);
    return el ? (el.textContent || "").trim() || null : null;
  }

  function getDomTimer() {
    if (cachedTimerEl && cachedTimerEl.isConnected) {
      const text = (cachedTimerEl.textContent || "").trim();
      if (TIMER_PATTERN.test(text)) return text;
      cachedTimerEl = null;
    }
    const container = document.querySelector(TIMER_CONTAINER);
    if (!container) return null;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.children.length > 0) continue;
      const text = (node.textContent || "").trim();
      if (TIMER_PATTERN.test(text)) {
        cachedTimerEl = node;
        return text;
      }
    }
    return null;
  }

  /* ── Chat observer ─────────────────────────────────── */

  function extractChatMessage(node) {
    if (!node || node.nodeType !== 1) return null;
    const fullText = (node.textContent || "").trim();
    if (!fullText) return null;

    let username = "";

    const imgs = node.querySelectorAll("img[alt*='profile image']");
    for (const img of imgs) {
      const alt = img.getAttribute("alt") || "";
      const name = alt.replace(/\s*profile image\s*$/i, "").trim();
      if (name && name.length >= 2) { username = name; break; }
    }

    const avatarContainer = node.querySelector("img[alt*='profile image'], img[alt*='profile']");
    const avatarParent = avatarContainer ? avatarContainer.closest("div") : null;

    const skipEls = new Set();
    if (avatarParent) {
      avatarParent.querySelectorAll("*").forEach(el => skipEls.add(el));
      skipEls.add(avatarParent);
    }

    const badges = /^(Mod|VIP|Host|Creator)$/i;
    const leafTexts = [];
    const allEls = node.querySelectorAll("*");
    for (const el of allEls) {
      if (el.children.length > 0) continue;
      if (skipEls.has(el)) continue;
      if (el.tagName === "IMG") continue;
      const t = (el.textContent || "").trim();
      if (!t) continue;
      if (badges.test(t)) continue;
      leafTexts.push(t);
    }

    if (!username && leafTexts.length >= 2) {
      const first = leafTexts[0];
      if (first.length >= 3 && first.length < 25 && /^[@\w._-]+$/.test(first)) {
        username = first;
        leafTexts.shift();
      }
    }

    const message = leafTexts.join(" ").trim() || fullText;
    return { timestamp: Date.now(), username, text: message };
  }

  function installChatObserver() {
    if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }

    const tryAttach = () => {
      const container = findChatContainer();
      if (!container) return false;

      lastSeenChatCount = container.children.length;

      chatObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;
            const msg = extractChatMessage(node);
            if (!msg) continue;
            const hash = `${msg.username}|${msg.text}`;
            if (recentChatHashes.has(hash)) continue;
            recentChatHashes.add(hash);
            if (recentChatHashes.size > 200) {
              const first = recentChatHashes.values().next().value;
              recentChatHashes.delete(first);
            }
            chatBuffer.push(msg);
          }
        }
      });

      chatObserver.observe(container, { childList: true, subtree: false });
      console.log("[WN Profit] chat observer attached, existing messages:", lastSeenChatCount);
      return true;
    };

    if (!tryAttach()) {
      let attempts = 0;
      const retryTimer = setInterval(() => {
        attempts++;
        if (tryAttach() || attempts > 30) {
          clearInterval(retryTimer);
          if (attempts > 30) console.log("[WN Profit] chat container not found after 30 attempts");
        }
      }, 2000);
    }
  }

  function startChatSync() {
    if (chatSyncTimer) clearInterval(chatSyncTimer);
    chatSyncTimer = setInterval(syncChatBatch, CHAT_SYNC_INTERVAL_MS);
  }

  function stopChatSync() {
    if (chatObserver) { chatObserver.disconnect(); chatObserver = null; }
    if (chatSyncTimer) { clearInterval(chatSyncTimer); chatSyncTimer = null; }
    syncChatBatch();
  }

  /* ── Inventory cache ───────────────────────────────── */

  let inventoryLoaded = false;
  let inventoryLoading = false;

  async function fetchListingPage(liveId, after) {
    const variables = { livestreamId: liveId, tab: "ACTIVE", first: 100 };
    if (after) variables.after = after;
    const body = JSON.stringify({
      operationName: "LivestreamShop",
      variables,
      query: `
        query LivestreamShop($livestreamId: ID!, $tab: ShopTab, $transactionTypes: [ListingTransactionType], $first: Int, $after: String) {
          liveStream(id: $livestreamId) {
            id
            shop(tab: $tab, transactionTypes: $transactionTypes, first: $first, after: $after) {
              pageInfo { hasNextPage endCursor }
              edges { node { id title subtitle price { amount currency } } }
            }
          }
        }
      `
    });
    const res = await fetch(GRAPHQL_URL, {
      method: "POST", credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body
    });
    if (!res.ok) return { edges: [], hasNext: false, cursor: null };
    const json = await res.json().catch(() => null);
    const shop = json?.data?.liveStream?.shop;
    return {
      edges: shop?.edges || [],
      hasNext: !!shop?.pageInfo?.hasNextPage,
      cursor: shop?.pageInfo?.endCursor || null
    };
  }

  async function buildInventoryCache(liveId) {
    if (inventoryLoading || inventoryLoaded) return;
    inventoryLoading = true;
    let cursor = null;
    let total = 0;
    try {
      while (true) {
        const page = await fetchListingPage(liveId, cursor);
        for (const edge of page.edges) {
          const node = edge?.node;
          if (!node?.title) continue;
          const numMatch = /^(\d+):/.exec(node.title);
          if (numMatch) titleToListingCache.set(numMatch[1], node);
          titleToListingCache.set(node.title, node);
          total++;
        }
        if (!page.hasNext || !page.cursor) break;
        cursor = page.cursor;
      }
      inventoryLoaded = true;
      console.log("[WN Profit] inventory cache built:", total, "items");
    } catch (e) {
      console.log("[WN Profit] inventory cache error:", e?.message);
    } finally {
      inventoryLoading = false;
    }
  }

  /* ── Polling ───────────────────────────────────────── */

  function pollSale() {
    const timerText = getDomTimer();
    const isZero = timerText === "00:00" || timerText === "0:00";
    const wasRunning = lastTimerText && lastTimerText !== "00:00" && lastTimerText !== "0:00";
    const timerDisappeared = !timerText && wasRunning;

    if ((isZero && wasRunning && !saleAlreadyFired) || (timerDisappeared && !saleAlreadyFired && auctionStartTime)) {
      saleAlreadyFired = true;
      const now = Date.now();
      const priceText = getDomPrice();
      const saleAmount = parseDomPrice(priceText);
      const bidCount = getDomBidCount();
      const title = lastDomTitle || "Sale";
      const costAmount = currentListingCost ? currentListingCost.amountCents / 100 : null;
      const currency = currentListingCurrency || "USD";
      const net = typeof saleAmount === "number" ? saleAmount * FEE_MULTIPLIER : null;
      const diff = typeof net === "number" && typeof costAmount === "number" ? net - costAmount : null;

      const auctionDuration = auctionStartTime ? now - auctionStartTime : null;
      const gapFromLast = lastSaleTime ? (auctionStartTime || now) - lastSaleTime : null;
      lastSaleTime = now;
      auctionStartTime = null;

      const noBids = (bidCount ?? 0) === 0;
      const viewers = getDomViewerCount();
      if (session && typeof viewers === "number" && viewers > (session.highestViewers || 0)) {
        session.highestViewers = viewers;
      }

      const showDuration = getDomShowDuration();

      if (noBids) {
        console.log("[WN Profit] auction ended with no bids", { title: title?.slice(0, 60), auctionDuration, gapFromLast, viewers });
        syncNoSaleToSheets({
          timestamp: now, title, auctionDuration, gapFromLast, viewers, showDuration
        });
      } else {
        console.log("[WN Profit] sale detected (timer hit 00:00)", {
          title: title?.slice(0, 60), priceText, saleAmount, bidCount,
          cost: costAmount, net, profit: diff, auctionDuration, gapFromLast, viewers
        });
        recordSale({
          timestamp: now, title, description: currentListingDescription,
          saleAmount, costAmount, netAmount: net, profit: diff,
          currency, bidCount, auctionDuration, gapFromLast, viewers, showDuration
        });
        setSalePopup(title, saleAmount, costAmount, net, diff, currency, bidCount);
        if (panelVisible) renderPanel();
      }

      try {
        if (localStorage.getItem(FOCUS_SEARCH_KEY) === "1") {
          setTimeout(() => {
            const searchBar = findSearchBar();
            if (searchBar) searchBar.focus();
          }, 150);
        }
      } catch {}
    }

    if (!isZero && timerText && !auctionStartTime) {
      auctionStartTime = Date.now();
      try {
        if (localStorage.getItem(FOCUS_SEARCH_ON_START_KEY) === "1") {
          const searchBar = findSearchBar();
          if (searchBar) searchBar.focus();
        }
      } catch {}
    }

    // saleAlreadyFired is reset only when lastDomTitle changes (in pollCurrentItem),
    // not on timer state, to prevent duplicate triggers from UI flicker.

    lastTimerText = timerText;
  }

  async function pollCurrentItem() {
    if (!currentLiveId) return;
    try {
      const domTitle = getDomCurrentItemTitle();
      if (!domTitle || domTitle === lastDomTitle) return;
      lastDomTitle = domTitle;
      saleAlreadyFired = false;

      const numMatch = /^(\d+):/.exec(domTitle);
      const itemNum = numMatch ? numMatch[1] : null;

      const cached = (itemNum && titleToListingCache.get(itemNum)) || titleToListingCache.get(domTitle);
      if (!cached) {
        console.log("[WN Profit] item not in inventory cache", { domTitle: domTitle.slice(0, 60), itemNum, cacheSize: titleToListingCache.size });
        currentListingId = null;
        currentListingCost = null;
        currentListingDescription = null;
        setCurrentItemPopup(domTitle, null);
        return;
      }
      const listingId = decodeRelayListingId(cached.id);
      if (!listingId) return;

      const cost = await fetchListingCost(listingId);
      currentListingId = listingId;
      currentListingCost = cost;
      currentListingCurrency = cost?.currency || "USD";
      currentListingDescription = getDomDescription();
      setCurrentItemPopup(domTitle, cost);
      console.log("[WN Profit] item changed", {
        domText: domTitle.slice(0, 80), itemNum, listingId, cost: cost?.amountCents ?? null
      });
    } catch (e) {
      console.log("[WN Profit] pollCurrentItem error:", e?.message);
    }
  }

  function pollTick() {
    pollSale();
    void pollCurrentItem();
  }

  function clearPolling() {
    if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  function startPollingForLive(liveId) {
    clearPolling();
    stopChatSync();
    stopSessionSync();
    listingCostCache.clear();
    titleToListingCache.clear();
    inventoryLoaded = false;
    inventoryLoading = false;
    lastDomTitle = null;
    lastTimerText = null;
    saleAlreadyFired = false;
    auctionStartTime = null;
    lastSaleTime = null;
    currentListingDescription = null;
    chatBuffer = [];
    currentLiveId = liveId;

    if (!currentLiveId) {
      if (session && session.sales.length > 0) syncSessionSummary();
      stopSessionSync();
      session = null;
      setStatusPopup("Waiting for live stream", "Open a Whatnot live stream page to start tracking.");
      return;
    }

    try {
      const stored = JSON.parse(localStorage.getItem(VIEW_START_KEY) || "{}");
      viewStartTime = (stored.liveId === currentLiveId && stored.ts) ? stored.ts : Date.now();
      localStorage.setItem(VIEW_START_KEY, JSON.stringify({ liveId: currentLiveId, ts: viewStartTime }));
    } catch { viewStartTime = Date.now(); }
    const existing = loadPastSessions().find(s => s.liveId === currentLiveId);
    if (existing) {
      session = existing;
      console.log("[WN Profit] resuming existing session for", currentLiveId.slice(0, 8), "with", existing.sales.length, "prior sales");
    } else {
      session = newSession(currentLiveId);
    }
    saveSession();

    setStatusPopup("Live detected", `Livestream: ${currentLiveId.slice(0, 8)}... \u2014 loading inventory`);
    void buildInventoryCache(currentLiveId).then(() => {
      setStatusPopup("Live detected", `Livestream: ${currentLiveId.slice(0, 8)}... \u2014 ${titleToListingCache.size} items loaded`);
    });
    pollTimer = window.setInterval(pollTick, POLL_MS);
    installChatObserver();
    startChatSync();
    startSessionSync();
  }

  /* ── Page bridge (live ID detection from network) ──── */

  function installPageGraphqlBridge() {
    if (bridgeInstalled) return;
    bridgeInstalled = true;

    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || msg.source !== "WN_PROFIT_BRIDGE") return;
      try {
        const liveId = msg.liveId;
        if (!currentLiveId && typeof liveId === "string" && LIVE_ID_RE.test(liveId)) {
          startPollingForLive(liveId.toLowerCase());
        }
      } catch {}
    });

    console.log("[WN Profit] bridge listener installed (bridge.js runs in MAIN world via manifest)");
  }

  /* ── Navigation ────────────────────────────────────── */

  function updateLiveFromLocation() {
    const liveId = getLiveIdFromLocation();
    if (liveId === currentLiveId && startupToastShown) return;
    startPollingForLive(liveId);
    if (!startupToastShown) {
      startupToastShown = true;
      setStatusPopup(
        liveId ? "Live detected" : "Waiting for live stream",
        liveId
          ? `Livestream: ${liveId.slice(0, 8)}... \u2014 watching for sales`
          : "Open a Whatnot live stream page to start tracking."
      );
    }
  }

  function installNavigationHooks() {
    const eventName = "wn-profit-location-change";
    const fire = () => window.dispatchEvent(new Event(eventName));
    const wrapHistory = (method) => {
      const original = history[method];
      history[method] = function (...args) {
        const out = original.apply(this, args);
        fire();
        return out;
      };
    };
    wrapHistory("pushState");
    wrapHistory("replaceState");
    window.addEventListener("popstate", fire);
    window.addEventListener("hashchange", fire);
    window.addEventListener(eventName, updateLiveFromLocation);
  }

  /* ── Init ──────────────────────────────────────────── */

  installPageGraphqlBridge();
  installNavigationHooks();
  getToggleButton();
  loadWebhookUrl();
  console.log("[WN Profit] content script loaded (analytics branch)", location.href);
  setStatusPopup("Loaded", `Extension v${EXT_VERSION} (analytics) injected`);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateLiveFromLocation, { once: true });
  } else {
    updateLiveFromLocation();
  }
})();
