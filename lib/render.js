// Builds the interior and cover PDFs by running the book maker in a hidden browser.
// The browser draws each page at 300 dpi; the PDF is assembled here, one page at a time.
const path = require("path");
const { chromium } = require("playwright");
const { PDFDocument } = require("pdf-lib");

const BOOK_PAGE = "file://" + path.join(__dirname, "..", "book", "book-maker.html");

let browser = null;
let queue = Promise.resolve();
let idleTimer = null, busyCount = 0;
// Close the hidden browser after 2 quiet minutes so the server uses little memory between orders.
function scheduleIdleClose() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (!busyCount && browser) { const b = browser; browser = null; b.close().catch(() => {}); } }, 120000);
  if (idleTimer.unref) idleTimer.unref();
}

async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  browser = await chromium.launch({ args: ["--disable-dev-shm-usage", "--disable-gpu", "--disable-extensions", "--js-flags=--max-old-space-size=256"] });
  return browser;
}

// One book at a time keeps memory low on a small server.
function renderBook(input, opts) {
  busyCount++;
  const job = queue.then(() => doRender(input, opts || {})).finally(() => { busyCount--; scheduleIdleClose(); });
  queue = job.catch(() => {});
  return job;
}

async function doRender(input, opts) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport: { width: 1200, height: 900 } });
  await ctx.addInitScript(() => { window.__LAZY_ART = true; });
  const page = await ctx.newPage();
  try {
    // The page's own download button library isn't needed here.
    await page.route(/cdnjs\.cloudflare\.com\//, r => r.fulfill({ status: 200, contentType: "application/javascript", body: "window.jspdf={};" }));
    if (opts.offline || process.env.RENDER_OFFLINE === "yes") await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await page.goto(BOOK_PAGE, { waitUntil: "load", timeout: 120000 });
    await page.waitForFunction(() => typeof window.__prepPrint === "function", null, { timeout: 120000 });
    const info = await page.evaluate(([i, o]) => window.__prepPrint(i, o), [input, { spine: opts.spine }]);

    const interior = await PDFDocument.create();
    interior.setTitle(`${info.name} - All About Me`);
    const [iw, ih] = info.interiorIn.map(n => n * 72);
    for (let i = 0; i < info.pages; i++) {
      const jpg = await interior.embedJpg(Buffer.from(await page.evaluate(n => window.__printPage(n), i), "base64"));
      interior.addPage([iw, ih]).drawImage(jpg, { x: 0, y: 0, width: iw, height: ih });
    }

    const cover = await PDFDocument.create();
    cover.setTitle(`${info.name} - Cover`);
    const [cw, ch] = info.coverIn.map(n => n * 72);
    const cjpg = await cover.embedJpg(Buffer.from(await page.evaluate(() => window.__printCover()), "base64"));
    cover.addPage([cw, ch]).drawImage(cjpg, { x: 0, y: 0, width: cw, height: ch });

    return {
      pages: info.pages,
      name: info.name,
      coverInches: info.coverIn,
      interior: Buffer.from(await interior.save()),
      cover: Buffer.from(await cover.save()),
    };
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function shutdown() { if (browser) await browser.close().catch(() => {}); }

module.exports = { renderBook, shutdown };
