const puppeteer = require("puppeteer");
const path = require("path");
const http = require("http");

const USER_DATA_DIR = path.join(__dirname, "browser-profile");
const EXTENSION_DIR = process.env.EXTENSION_DIR || path.resolve(__dirname, "..");
const PORT = parseInt(process.env.PORT || "3000", 10);
const CHECK_INTERVAL_MS = 60000;
const WHATNOT_BASE = "https://www.whatnot.com";

let browser = null;
let page = null;
let currentUrl = null;
let isWatching = false;
let lastStatus = "idle";
let startedAt = null;

async function launchBrowser() {
  console.log("[server] launching headless browser...");
  const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  browser = await puppeteer.launch({
    headless: "new",
    executablePath: chromePath,
    userDataDir: USER_DATA_DIR,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu"
    ],
    defaultViewport: { width: 1280, height: 900 }
  });

  browser.on("disconnected", () => {
    console.log("[server] browser disconnected, restarting in 5s...");
    isWatching = false;
    lastStatus = "browser crashed — restarting";
    setTimeout(init, 5000);
  });

  page = await browser.newPage();

  page.on("console", (msg) => {
    const text = msg.text();
    if (text.startsWith("[WN Profit]")) {
      console.log("[extension]", text);
    }
  });

  page.on("pageerror", (err) => {
    console.log("[page error]", err.message);
  });

  console.log("[server] browser launched");
}

async function watchStream(url) {
  if (!browser || !page) {
    console.log("[server] no browser, launching...");
    await launchBrowser();
  }

  console.log("[server] navigating to:", url);
  currentUrl = url;
  isWatching = true;
  startedAt = Date.now();
  lastStatus = "loading stream";

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });
    lastStatus = "watching";
    console.log("[server] stream loaded, extension active");
  } catch (err) {
    lastStatus = "error loading: " + err.message;
    console.log("[server] navigation error:", err.message);
  }
}

async function stopWatching() {
  isWatching = false;
  currentUrl = null;
  startedAt = null;
  lastStatus = "idle";
  if (page) {
    try { await page.goto("about:blank"); } catch {}
  }
  console.log("[server] stopped watching");
}

async function healthCheck() {
  if (!isWatching || !page) return;
  try {
    const url = page.url();
    if (!url.includes("whatnot.com")) {
      console.log("[server] page navigated away, reloading stream...");
      await watchStream(currentUrl);
    }
  } catch {}
}

function getStatus() {
  return {
    status: lastStatus,
    watching: isWatching,
    url: currentUrl,
    uptime: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
    timestamp: new Date().toISOString()
  };
}

function startHttpServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    res.setHeader("Content-Type", "application/json");

    if (url.pathname === "/status") {
      res.end(JSON.stringify(getStatus(), null, 2));
      return;
    }

    if (url.pathname === "/watch" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", async () => {
        try {
          const data = JSON.parse(body);
          if (!data.url || !data.url.includes("whatnot.com")) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Provide a valid Whatnot URL" }));
            return;
          }
          await watchStream(data.url);
          res.end(JSON.stringify(getStatus()));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (url.pathname === "/stop" && req.method === "POST") {
      await stopWatching();
      res.end(JSON.stringify(getStatus()));
      return;
    }

    if (url.pathname === "/screenshot") {
      try {
        if (!page) throw new Error("No active page");
        const buf = await page.screenshot({ encoding: "base64", type: "jpeg", quality: 70 });
        res.setHeader("Content-Type", "image/jpeg");
        res.end(Buffer.from(buf, "base64"));
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    res.end(JSON.stringify({
      endpoints: {
        "GET /status": "Current server status",
        "POST /watch": "Start watching a stream. Body: { \"url\": \"https://www.whatnot.com/live/...\" }",
        "POST /stop": "Stop watching",
        "GET /screenshot": "Screenshot of current page (JPEG)"
      }
    }));
  });

  server.listen(PORT, () => {
    console.log(`[server] HTTP API running on port ${PORT}`);
    console.log(`[server] endpoints:`);
    console.log(`  GET  http://localhost:${PORT}/status`);
    console.log(`  POST http://localhost:${PORT}/watch   { "url": "..." }`);
    console.log(`  POST http://localhost:${PORT}/stop`);
    console.log(`  GET  http://localhost:${PORT}/screenshot`);
  });
}

async function init() {
  try {
    await launchBrowser();
    startHttpServer();
    setInterval(healthCheck, CHECK_INTERVAL_MS);
    console.log("[server] ready. Use the API to start watching a stream.");
  } catch (err) {
    console.error("[server] init failed:", err.message);
    process.exit(1);
  }
}

init();
