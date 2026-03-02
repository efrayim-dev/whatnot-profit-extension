(function () {
  const GRAPHQL_URL = "https://www.whatnot.com/services/graphql/?operationName=SoldAuditRecentSales&ssr=0";
  const LIVE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const FEE_MULTIPLIER = 0.88;
  const POLL_MS = 2000;
  const RECENT_COOLDOWN_MS = 60_000;

  const seenSaleIds = new Set();
  const listingCostCache = new Map();
  const listingCostInFlight = new Map();
  const listingToastAt = new Map();
  const listingToastInFlight = new Set();

  let currentLiveId = null;
  let pollTimer = null;
  let fetchHookInstalled = false;

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
      .wn-profit-toast + .wn-profit-toast {
        margin-top: 8px;
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
      .wn-profit-toast .ok {
        color: #86efac;
      }
      .wn-profit-toast .bad {
        color: #fda4af;
      }
      .wn-profit-toast .hint {
        margin-top: 6px;
        opacity: 0.7;
        font-size: 11px;
        font-weight: 500;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function showToast(html, timeoutMs = 7000) {
    ensureToastStyles();
    const wrapId = "wn-profit-toast-wrap";
    let wrap = document.getElementById(wrapId);
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = wrapId;
      wrap.style.position = "fixed";
      wrap.style.left = "0";
      wrap.style.top = "0";
      wrap.style.zIndex = "2147483647";
      wrap.style.pointerEvents = "none";
      document.documentElement.appendChild(wrap);
    }
    const el = document.createElement("div");
    el.className = "wn-profit-toast";
    el.innerHTML = html;
    wrap.appendChild(el);
    window.setTimeout(() => {
      el.style.transition = "opacity 0.25s ease";
      el.style.opacity = "0";
      window.setTimeout(() => el.remove(), 260);
    }, timeoutMs);
  }

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

  function extractListingIds(payload) {
    if (!payload || typeof payload !== "object") return [];
    const ids = new Set();
    const stack = [payload];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      if (Array.isArray(node)) {
        for (const child of node) if (child && typeof child === "object") stack.push(child);
        continue;
      }
      if (typeof node.id === "string" && LIVE_ID_RE.test(node.id)) {
        const looksLikeListing =
          "title" in node ||
          "subtitle" in node ||
          "price" in node ||
          "startingBid" in node ||
          "buyNowPrice" in node ||
          "buyNowPriceAmount" in node;
        if (looksLikeListing) ids.add(node.id);
      }
      for (const v of Object.values(node)) if (v && typeof v === "object") stack.push(v);
    }
    return Array.from(ids);
  }

  async function maybeShowCurrentItemCost(listingId) {
    if (!currentLiveId || !listingId || listingToastInFlight.has(listingId)) return;
    const now = Date.now();
    const last = listingToastAt.get(listingId) || 0;
    if (now - last < RECENT_COOLDOWN_MS) return;
    listingToastAt.set(listingId, now);
    listingToastInFlight.add(listingId);
    try {
      const cost = await fetchListingCost(listingId);
      if (!currentLiveId) return;
      if (!cost) {
        showToast(
          `<div class="title">Current Item</div><div class="row"><span class="label">Cost</span><span>Not set</span></div><div class="hint">Loaded item / auction start</div>`,
          5000
        );
        return;
      }
      showToast(
        `<div class="title">Current Item</div><div class="row"><span class="label">Cost</span><span>${formatMoney(
          cost.amountCents / 100,
          cost.currency
        )}</span></div><div class="hint">Loaded item / auction start</div>`,
        5000
      );
    } finally {
      listingToastInFlight.delete(listingId);
    }
  }

  function installFetchHook() {
    if (fetchHookInstalled || typeof window.fetch !== "function") return;
    fetchHookInstalled = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const resp = await originalFetch(...args);
      try {
        if (!currentLiveId) return resp;
        const input = args[0];
        const url = typeof input === "string" ? input : input?.url;
        if (!url || !url.includes("/services/graphql")) return resp;
        const body = args[1]?.body;
        if (typeof body === "string" && body && !/(live|auction|listing|product|shop)/i.test(body)) return resp;
        const json = await resp.clone().json().catch(() => null);
        if (!json) return resp;
        const listingIds = extractListingIds(json);
        for (const id of listingIds) {
          if (!LIVE_ID_RE.test(id) || id.toLowerCase() === currentLiveId) continue;
          void maybeShowCurrentItemCost(id);
        }
      } catch {
      }
      return resp;
    };
  }

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

    const cost = await fetchListingCost(sale.listingId);
    const net = typeof sale.saleAmount === "number" ? sale.saleAmount * FEE_MULTIPLIER : null;
    const costAmount = cost ? cost.amountCents / 100 : null;
    const diff = typeof net === "number" && typeof costAmount === "number" ? net - costAmount : null;
    const currency = cost?.currency || sale.currency || "USD";

    showToast(
      `<div class="title">Sold: ${sale.title}</div>
       <div class="row"><span class="label">Sale</span><span>${formatMoney(sale.saleAmount, sale.currency)}</span></div>
       <div class="row"><span class="label">Cost</span><span>${cost ? formatMoney(costAmount, currency) : "Not set"}</span></div>
       <div class="row"><span class="label">Net (after 12%)</span><span>${formatMoney(net, currency)}</span></div>
       <div class="row"><span class="label">Difference</span><span class="${typeof diff === "number" && diff >= 0 ? "ok" : "bad"}">${
         typeof diff === "number" ? formatMoney(diff, currency) : "N/A"
       }</span></div>
       <div class="hint">${sale.buyer ? `Buyer: @${sale.buyer}` : "New sale captured"}</div>`,
      9000
    );
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
      // Ignore transient API errors and continue polling.
    }
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
    listingToastAt.clear();
    currentLiveId = liveId;
    if (!currentLiveId) return;
    void pollSales(true);
    pollTimer = window.setInterval(() => void pollSales(false), POLL_MS);
  }

  function updateLiveFromLocation() {
    const liveId = getLiveIdFromLocation();
    if (liveId === currentLiveId) return;
    startPollingForLive(liveId);
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

  installFetchHook();
  installNavigationHooks();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", updateLiveFromLocation, { once: true });
  } else {
    updateLiveFromLocation();
  }
})();
