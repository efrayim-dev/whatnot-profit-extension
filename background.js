chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_WEBHOOK_URL") {
    chrome.storage.sync.get("webhookUrl", (data) => {
      sendResponse({ url: data.webhookUrl || "" });
    });
    return true;
  }

  if (msg.type === "SET_WEBHOOK_URL") {
    chrome.storage.sync.set({ webhookUrl: msg.url }, () => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === "SYNC_SALE" || msg.type === "SYNC_SESSION_SUMMARY" || msg.type === "SYNC_CHAT") {
    chrome.storage.sync.get("webhookUrl", async (data) => {
      const url = data.webhookUrl;
      if (!url) {
        sendResponse({ ok: false, error: "No webhook URL configured" });
        return;
      }
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload)
        });
        if (!resp.ok) {
          sendResponse({ ok: false, error: `HTTP ${resp.status}` });
          return;
        }
        const json = await resp.json().catch(() => ({}));
        sendResponse({ ok: true, data: json });
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }
});
