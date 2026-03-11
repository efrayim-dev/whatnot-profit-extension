if (!window.__wnProfitBridgeInstalled) {
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
}
