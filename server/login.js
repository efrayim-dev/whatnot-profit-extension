const puppeteer = require("puppeteer");
const path = require("path");

const USER_DATA_DIR = path.join(__dirname, "browser-profile");
const EXTENSION_DIR = path.resolve(__dirname, "..");

async function login() {
  console.log("Launching browser for login (non-headless)...");
  console.log("Extension dir:", EXTENSION_DIR);
  console.log("Profile dir:", USER_DATA_DIR);

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: USER_DATA_DIR,
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized"
    ],
    defaultViewport: null
  });

  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();
  await page.goto("https://www.whatnot.com/login", { waitUntil: "networkidle2" });

  console.log("\n=== Log in to Whatnot in the browser window ===");
  console.log("Once logged in, navigate around to confirm the session works.");
  console.log("Then close the browser window — your session will be saved.\n");

  await new Promise((resolve) => {
    browser.on("disconnected", resolve);
  });

  console.log("Browser closed. Session saved to:", USER_DATA_DIR);
  console.log("You can now run: npm start");
}

login().catch((err) => {
  console.error("Login failed:", err.message);
  process.exit(1);
});
