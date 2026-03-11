const DEFAULT_URL = "https://script.google.com/macros/s/AKfycbyvPGGDto5-gVC3pyl2_3DtuD7TwwmOGGhJfDDbxo1hHARwESpFECpy8nR3mrtwmZ9W/exec";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_WEBHOOK_URL") {
    chrome.storage.sync.get("webhookUrl", (data) => {
      sendResponse({ url: data.webhookUrl || DEFAULT_URL });
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
      const url = msg.webhookUrl || data.webhookUrl || DEFAULT_URL;
      if (!url) {
        sendResponse({ ok: false, error: "No webhook URL configured" });
        return;
      }
      const bodyStr = JSON.stringify(msg.payload);
      console.log("[WN Background] sending", msg.type, "to", url.slice(0, 60), "body length:", bodyStr.length);
      console.log("[WN Background] payload:", bodyStr.slice(0, 300));

      try {
        // Google Apps Script executes doPost server-side then returns a 302.
        // With redirect:"follow", the 302 becomes a GET (body lost), so the
        // final response we read is from doGet — not useful for confirming
        // the write.  We use redirect:"manual" instead: the POST still
        // reaches Google, doPost still runs, we just get an opaque-redirect
        // response we can't read.  That's fine — fire-and-forget.
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: bodyStr,
          redirect: "manual"
        });

        console.log("[WN Background] response type:", resp.type, "status:", resp.status);

        if (resp.type === "opaqueredirect" || resp.status === 0 || (resp.status >= 300 && resp.status < 400)) {
          // Redirect means Google received and processed the POST.
          console.log("[WN Background] redirect received — doPost executed on server");
          sendResponse({ ok: true, redirected: true });
          return;
        }

        if (resp.ok) {
          const text = await resp.text().catch(() => "{}");
          console.log("[WN Background] response body:", text.slice(0, 300));
          let json = {};
          try { json = JSON.parse(text); } catch {}
          if (json.status === "error") {
            sendResponse({ ok: false, error: json.message || "Script error" });
          } else {
            sendResponse({ ok: true, data: json });
          }
          return;
        }

        const errText = await resp.text().catch(() => "");
        sendResponse({ ok: false, error: `HTTP ${resp.status}: ${errText.slice(0, 100)}` });
      } catch (e) {
        console.log("[WN Background] fetch error:", e.message);
        sendResponse({ ok: false, error: e.message });
      }
    });
    return true;
  }
});
