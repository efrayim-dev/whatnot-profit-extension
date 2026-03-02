(function () {
  const GRAPHQL_URL = "https://www.whatnot.com/services/graphql/?operationName=SoldAuditRecentSales&ssr=0";
  const EXT_VERSION =
    typeof chrome !== "undefined" && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : "dev";
  const LIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const FEE_MULTIPLIER = 0.88;
  const POLL_MS = 1000;

  const seenSaleIds = new Set();
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
  let lastDomTitle = null;

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

  /* ── UI ─────────────────────────────────────────────── */

  function ensureToastStyles() {
    if (document.getElementById("wn-profit-toast-style")) return;
    const style = document.createElement("style");
    style.id = "wn-profit-toast-style";
    style.textContent = `
      .wn-profit-toast {
        position: fixed;
        left: 16px;
        top: 16px;
        z-index: 2147483647;
        width: min(360px, calc(100vw - 32px));
        border-radius: 12px;
        background: rgba(15, 23, 42, 0.96);
        border: 1px solid rgba(148, 163, 184, 0.35);
        box-shadow: 0 14px 34px rgba(0, 0, 0, 0.45);
        color: #e2e8f0;
        padding: 10px 12px;
        font: 600 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        backdrop-filter: blur(6px);
      }
      .wn-profit-toast .row {
        display: flex;
        justify-content: space-between;
        gap: 8px;
      }
      .wn-profit-toast .label {
        opacity: 0.78;
        font-weight: 500;
      }
      .wn-profit-toast .title {
        margin-bottom: 6px;
        font-weight: 700;
      }
      .wn-profit-toast .ok { color: #86efac; }
      .wn-profit-toast .bad { color: #fda4af; }
      .wn-profit-toast .hint {
        margin-top: 6px;
        opacity: 0.7;
        font-size: 11px;
        font-weight: 500;
      }
      .wn-profit-toast.sale-profit {
        background: rgba(22, 101, 52, 0.94);
        border-color: rgba(74, 222, 128, 0.5);
        box-shadow: 0 14px 34px rgba(22, 101, 52, 0.45);
      }
      .wn-profit-toast.sale-loss {
        background: rgba(127, 29, 29, 0.94);
        border-color: rgba(252, 165, 165, 0.5);
        box-shadow: 0 14px 34px rgba(127, 29, 29, 0.45);
      }
      @keyframes wn-pulse {
        0%   { transform: scale(1);    opacity: 1; }
        15%  { transform: scale(1.04); opacity: 0.9; }
        30%  { transform: scale(1);    opacity: 1; }
        45%  { transform: scale(1.03); opacity: 0.92; }
        60%  { transform: scale(1);    opacity: 1; }
        100% { transform: scale(1);    opacity: 1; }
      }
      .wn-profit-toast.pulse {
        animation: wn-pulse 0.8s ease-in-out;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function getPopupElement() {
    ensureToastStyles();
    const id = "wn-profit-toast";
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.className = "wn-profit-toast";
      document.documentElement.appendChild(el);
    }
    return el;
  }

  function setPopup(html) {
    const el = getPopupElement();
    el.classList.remove("sale-profit", "sale-loss", "pulse");
    el.style.opacity = "1";
    el.style.transition = "";
    el.innerHTML = html;
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

  function setSalePopup(saleTitle, saleAmount, costAmount, netAmount, diffAmount, currency, buyer) {
    const el = getPopupElement();
    el.classList.remove("sale-profit", "sale-loss", "pulse");
    el.style.opacity = "1";
    el.style.transition = "";
    el.innerHTML =
      `<div class="title">Sale Completed: ${saleTitle}</div>
       <div class="row"><span class="label">Sale</span><span>${formatMoney(saleAmount, currency)}</span></div>
       <div class="row"><span class="label">Cost</span><span>${typeof costAmount === "number" ? formatMoney(costAmount, currency) : "Not set"}</span></div>
       <div class="row"><span class="label">Net (after 12%)</span><span>${formatMoney(netAmount, currency)}</span></div>
       <div class="row"><span class="label">Profit</span><span class="${typeof diffAmount === "number" && diffAmount >= 0 ? "ok" : "bad"}">${
         typeof diffAmount === "number" ? formatMoney(diffAmount, currency) : "N/A"
       }</span></div>
       <div class="hint">${buyer ? `Buyer: @${buyer}` : "Sale captured"}</div>`;
    const isProfit = typeof diffAmount === "number" && diffAmount >= 0;
    el.classList.add(isProfit ? "sale-profit" : "sale-loss");
    void el.offsetWidth;
    el.classList.add("pulse");
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
      } catch {
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

  /* ── DOM-based current item detection ──────────────── */

  const DOM_TITLE_SELECTOR = "#bottom-section-stream-container > div > div > div:nth-child(1) > div:nth-child(2) > div:nth-child(2) > div > div > div:nth-child(1)";

  function getDomCurrentItemTitle() {
    const el = document.querySelector(DOM_TITLE_SELECTOR);
    if (!el) return null;
    const text = (el.textContent || "").trim();
    return text || null;
  }

  let inventoryLoaded = false;
  let inventoryLoading = false;

  async function fetchListingPage(liveId, after) {
    const variables = {
      livestreamId: liveId,
      tab: "ACTIVE",
      transactionTypes: ["AUCTION"],
      first: 100
    };
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
              edges {
                node { id title subtitle price { amount currency } }
              }
            }
          }
        }
      `
    });
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
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
          if (numMatch) {
            titleToListingCache.set(numMatch[1], node);
            total++;
          }
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


  /* ── Sale processing ───────────────────────────────── */

  function saleFromNode(node) {
    const listing = node?.listing || {};
    const saleAmountCents =
      typeof node?.price?.amount === "number"
        ? node.price.amount
        : typeof listing?.price?.amount === "number"
        ? listing.price.amount
        : null;
    const currency = node?.price?.currency || listing?.price?.currency || "USD";
    const saleAmount = typeof saleAmountCents === "number" ? saleAmountCents / 100 : null;
    return {
      saleId: node?.id || null,
      listingId: listing?.id || null,
      title: listing?.title || listing?.subtitle || "Sale recorded",
      buyer: node?.buyer?.username || null,
      saleAmount,
      currency
    };
  }

  async function processNewSale(node) {
    const sale = saleFromNode(node);
    if (!sale.saleId || seenSaleIds.has(sale.saleId)) return;
    seenSaleIds.add(sale.saleId);

    const saleListingId = decodeRelayListingId(sale.listingId) || sale.listingId;
    const cost = await fetchListingCost(saleListingId);
    const net = typeof sale.saleAmount === "number" ? sale.saleAmount * FEE_MULTIPLIER : null;
    const costAmount = cost ? cost.amountCents / 100 : null;

    const effectiveCostAmount =
      saleListingId && saleListingId === currentListingId && currentListingCost
        ? currentListingCost.amountCents / 100
        : costAmount;
    const effectiveCurrency =
      saleListingId && saleListingId === currentListingId && currentListingCurrency
        ? currentListingCurrency
        : cost?.currency || sale.currency || "USD";
    const effectiveDiff =
      typeof net === "number" && typeof effectiveCostAmount === "number" ? net - effectiveCostAmount : null;

    console.log("[WN Profit] sale detected", {
      title: sale.title?.slice(0, 60),
      saleAmount: sale.saleAmount,
      costCents: effectiveCostAmount != null ? effectiveCostAmount * 100 : null,
      profit: effectiveDiff
    });

    setSalePopup(sale.title, sale.saleAmount, effectiveCostAmount, net, effectiveDiff, effectiveCurrency, sale.buyer);
  }

  /* ── Polling ───────────────────────────────────────── */

  async function fetchRecentSoldItems(liveId) {
    const body = JSON.stringify({
      operationName: "SoldAuditRecentSales",
      variables: { liveId, first: 12 },
      query: `
        query SoldAuditRecentSales($liveId: ID!, $first: Int) {
          liveShop(liveId: $liveId) {
            soldItems(first: $first) {
              edges {
                node {
                  id
                  buyer { username }
                  price { amount currency }
                  listing { id title subtitle price { amount currency } }
                }
              }
            }
          }
        }
      `
    });
    const res = await fetch(GRAPHQL_URL, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body
    });
    if (!res.ok) return [];
    const json = await res.json().catch(() => null);
    return json?.data?.liveShop?.soldItems?.edges || [];
  }

  async function pollSales(initial = false) {
    if (!currentLiveId) return;
    try {
      const edges = await fetchRecentSoldItems(currentLiveId);
      if (initial) {
        for (const edge of edges) {
          const saleId = edge?.node?.id;
          if (saleId) seenSaleIds.add(saleId);
        }
        return;
      }
      for (let i = edges.length - 1; i >= 0; i -= 1) {
        const node = edges[i]?.node;
        if (node) void processNewSale(node);
      }
    } catch {
    }
  }

  async function pollCurrentItem() {
    if (!currentLiveId) return;
    try {
      const domTitle = getDomCurrentItemTitle();
      if (!domTitle || domTitle === lastDomTitle) return;
      lastDomTitle = domTitle;

      const numMatch = /^(\d+):/.exec(domTitle);
      if (!numMatch) return;
      const itemNum = numMatch[1];

      if (!titleToListingCache.has(itemNum)) {
        console.log("[WN Profit] item not in inventory cache", { itemNum, cacheSize: titleToListingCache.size });
        return;
      }

      const cached = titleToListingCache.get(itemNum);
      const listingId = decodeRelayListingId(cached.id);
      if (!listingId) return;

      const cost = await fetchListingCost(listingId);
      currentListingId = listingId;
      currentListingCost = cost;
      currentListingCurrency = cost?.currency || "USD";
      setCurrentItemPopup(domTitle, cost);
      console.log("[WN Profit] item changed", {
        domText: domTitle.slice(0, 80),
        cachedTitle: cached.title?.slice(0, 80),
        itemNum,
        listingId,
        cost: cost?.amountCents ?? null
      });
    } catch {
    }
  }

  async function pollTick(initial = false) {
    if (initial) {
      await pollSales(true);
      await pollCurrentItem();
      return;
    }
    await Promise.all([pollSales(false), pollCurrentItem()]);
  }

  function clearPolling() {
    if (pollTimer !== null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPollingForLive(liveId) {
    clearPolling();
    seenSaleIds.clear();
    listingCostCache.clear();
    titleToListingCache.clear();
    inventoryLoaded = false;
    inventoryLoading = false;
    lastDomTitle = null;
    currentLiveId = liveId;
    if (!currentLiveId) {
      setStatusPopup("Waiting for live stream", "Open a Whatnot live stream page to start tracking.");
      return;
    }
    setStatusPopup("Live detected", `Livestream: ${currentLiveId.slice(0, 8)}... — loading inventory`);
    void buildInventoryCache(currentLiveId).then(() => {
      setStatusPopup("Live detected", `Livestream: ${currentLiveId.slice(0, 8)}... — ${titleToListingCache.size} items loaded`);
    });
    void pollTick(true);
    pollTimer = window.setInterval(() => void pollTick(false), POLL_MS);
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
      } catch {
      }
    });

    const script = document.createElement("script");
    script.textContent = `
      (() => {
        if (window.__wnProfitBridgeInstalled) return;
        window.__wnProfitBridgeInstalled = true;

        function parseBody(body) {
          if (!body || typeof body !== "string") return {};
          try {
            const obj = JSON.parse(body);
            return { liveId: obj?.variables?.liveId || obj?.variables?.livestreamId || obj?.variables?.id || undefined };
          } catch { return {}; }
        }

        function emit(data) {
          window.postMessage({ source: "WN_PROFIT_BRIDGE", ...data }, "*");
        }

        const originalFetch = window.fetch?.bind(window);
        if (typeof originalFetch === "function") {
          window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            try {
              const input = args[0];
              const url = typeof input === "string" ? input : input?.url;
              if (url && url.includes("/services/graphql")) {
                const parsed = parseBody(args[1]?.body);
                if (parsed.liveId) emit({ liveId: parsed.liveId });
              }
            } catch {}
            return response;
          };
        }

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__wnProfitUrl = typeof url === "string" ? url : String(url || "");
          return origOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(body) {
          try {
            if (this.__wnProfitUrl && this.__wnProfitUrl.includes("/services/graphql")) {
              const parsed = parseBody(body);
              if (parsed.liveId) emit({ liveId: parsed.liveId });
            }
          } catch {}
          return origSend.call(this, body);
        };
      })();
    `;
    (document.documentElement || document.head).appendChild(script);
    script.remove();
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
          ? `Livestream: ${liveId.slice(0, 8)}... — watching for sales`
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
  console.log("[WN Profit] content script loaded", location.href);
  setStatusPopup("Loaded", `Extension v${EXT_VERSION} injected`);
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateLiveFromLocation, { once: true });
  } else {
    updateLiveFromLocation();
  }
})();
