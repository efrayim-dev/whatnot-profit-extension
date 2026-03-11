chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_WEBHOOK_URL") {
    chrome.storage.sync.get("webhookUrl", (data) => {
      sendResponse({ url: data.webhookUrl || "" });
    });
    return true;
  }

  if (msg.type === "SET_WEBHOOK_URL") {
    chrome.storage.sync.set({ webhookUrl: msg.url }, () => {
      console.log("[WN Background] webhook URL saved:", msg.url?.slice(0, 60));
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "SYNC_SALE" || msg.type === "SYNC_SESSION_SUMMARY" || msg.type === "SYNC_CHAT") {
    chrome.storage.sync.get("webhookUrl", async (data) => {
      const url = data.webhookUrl;
      if (!url) {
        console.log("[WN Background] no webhook URL configured");
        sendResponse({ ok: false, error: "No webhook URL configured" });
        return;
      }
      const bodyStr = JSON.stringify(msg.payload);
      console.log("[WN Background] sending", msg.type, "to", url.slice(0, 60), "body length:", bodyStr.length);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: bodyStr,
          redirect: "follow"
        });
        console.log("[WN Background] response status:", resp.status, "url:", resp.url?.slice(0, 80));
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          console.log("[WN Background] error body:", text.slice(0, 200));
          sendResponse({ ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 100)}` });
          return;
        }
        const text = await resp.text().catch(() => "{}");
        console.log("[WN Background] success:", text.slice(0, 200));
        let json = {};
        try { json = JSON.parse(text); } catch {}
        sendResponse({ ok: true, data: json });
      } catch (e) {
        console.log("[WN Background] fetch error:", e.message);
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }
});
