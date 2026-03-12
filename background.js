const WEBHOOK_URL = "https://script.google.com/macros/s/AKfycbzSOPc9lvs9fU6S5quI0lj8RBQ_O_RbI34RNfCHzUy9eqVanHhKXltUe9D1vrXcOZ9zqw/exec";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "GET_WEBHOOK_URL") {
    sendResponse({ url: WEBHOOK_URL });
    return true;
  }

  if (msg.type === "SET_WEBHOOK_URL") {
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "SYNC_SALE" || msg.type === "SYNC_SESSION_SUMMARY" || msg.type === "SYNC_CHAT") {
    const bodyStr = JSON.stringify(msg.payload);
    console.log("[WN Background] sending", msg.type, "to", WEBHOOK_URL.slice(0, 60), "body:", bodyStr.slice(0, 200));

    fetch(WEBHOOK_URL, {
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
