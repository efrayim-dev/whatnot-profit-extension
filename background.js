chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_WEBHOOK_URL") {
    sendResponse({ url: msg.webhookUrl || "" });
    return true;
  }

  if (msg.type === "SET_WEBHOOK_URL") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_BLURBS") {
    const url = msg.webhookUrl;
    if (!url) { sendResponse({ ok: false, error: "no webhook URL" }); return true; }
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ type: "get_blurbs", secret: msg.secret }),
      redirect: "follow"
    }).then(resp => resp.json())
      .then(json => sendResponse(json))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === "SYNC_SALE" || msg.type === "SYNC_SESSION_SUMMARY" || msg.type === "SYNC_CHAT") {
    const url = msg.webhookUrl;
    if (!url) {
      console.log("[WN Background]", msg.type, "skipped — no webhook URL in message");
      sendResponse({ ok: false, error: "no webhook URL" });
      return true;
    }

    const bodyStr = JSON.stringify(msg.payload);
    console.log("[WN Background] sending", msg.type, "to", url.slice(0, 60), "body:", bodyStr.slice(0, 200));

    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: bodyStr,
      redirect: "manual"
    }).then(resp => {
      console.log("[WN Background] response type:", resp.type, "status:", resp.status);
      sendResponse({ ok: true, redirected: resp.type === "opaqueredirect" });
    }).catch(e => {
      console.log("[WN Background] fetch error:", e.message);
      sendResponse({ ok: false, error: e.message });
    });

    return true;
  }
});
