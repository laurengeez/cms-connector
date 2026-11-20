// Color Me Spellbound order connector
//   Shopify "order paid"  ->  build the book files  ->  send to Lulu to print & ship
//   Lulu "shipped"         ->  mark the Shopify order shipped with tracking
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cfg = require("./lib/config");
const shopify = require("./lib/shopify");
const lulu = require("./lib/lulu");
const { renderBook } = require("./lib/render");
const { bookLineItems, toBookInput, luluAddress, INTERESTS } = require("./lib/map");

const DIRS = { files: path.join(cfg.dataDir, "files"), orders: path.join(cfg.dataDir, "orders"), sent: path.join(cfg.dataDir, "sent") };
const ensureDirs = () => Object.values(DIRS).forEach(d => fs.mkdirSync(d, { recursive: true }));
ensureDirs();

/* ---------- small helpers ---------- */
const logLines = [];
function log(msg) {
  const line = `${new Date().toISOString()}  ${msg}`;
  console.log(line);
  logLines.push(line); if (logLines.length > 200) logLines.shift();
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const gidOf = id => `gid://shopify/Order/${id}`;
const keyOk = url => cfg.adminKey && url.searchParams.get("key") === cfg.adminKey;

function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}

function saveFile(buf, label) {
  const token = crypto.randomBytes(18).toString("hex");
  const name = `${token}-${label}.pdf`;
  ensureDirs();
  fs.writeFileSync(path.join(DIRS.files, name), buf);
  return `${cfg.publicUrl}/files/${name}`;
}

// Remove files older than 30 days.
function cleanup() {
  const cutoff = Date.now() - 30 * 24 * 3600 * 1000;
  for (const d of [DIRS.files, DIRS.orders]) for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (e) {}
  }
}
setInterval(cleanup, 12 * 3600 * 1000).unref();

// Safe wrappers: Shopify notes/tags are nice-to-have and must never stop a book from printing.
async function tag(gid, tags) { if (shopify.canUseApi()) try { await shopify.addTags(gid, tags); } catch (e) { log(`Could not tag order: ${e.message}`); } }
async function note(gid, line) { if (shopify.canUseApi()) try { await shopify.appendNote(gid, line); } catch (e) { log(`Could not add note: ${e.message}`); } }

/* ---------- the main job: one paid order ---------- */
const inFlight = new Set();

async function processOrder(order, { force = false } = {}) {
  const id = String(order.id), gid = order.admin_graphql_api_id || gidOf(id), label = order.name || `#${id}`;
  const sentMarker = path.join(DIRS.sent, id);
  if (inFlight.has(id)) return log(`${label}: already being worked on, skipped duplicate.`);
  if (!force && fs.existsSync(sentMarker)) return log(`${label}: already sent before, skipped duplicate.`);
  if (!force && String(order.tags || "").split(",").map(t => t.trim()).includes("lulu-sent")) return log(`${label}: already tagged lulu-sent, skipped.`);

  const items = bookLineItems(order, cfg.shopify.bookTitleMatch);
  if (!items.length) return log(`${label}: no book in this order, nothing to do.`);
  inFlight.add(id);

  try {
    // Each book line item can be a different child (its own answers), so build each one.
    const built = [];
    const problems = [];
    for (const li of items) {
      const r = toBookInput(order, li);
      if (r.fatal) {
        await tag(gid, ["book-problem"]);
        await note(gid, `BOOK NOT SENT: ${r.problems.join(" ")} Please check the order answers.`);
        return log(`${label}: STOPPED. ${r.problems.join(" ")}`);
      }
      problems.push(...r.problems);
      built.push({ input: r.input, quantity: li.quantity || 1 });
    }

    const { addr, missing } = luluAddress(order, cfg.lulu.fallbackPhone);

    // Decide whether this order may go to Lulu, and where.
    let mode = "send";
    if (cfg.filesOnly) mode = "files";
    if (order.test && (cfg.lulu.env === "production" || !cfg.sendTestOrdersToSandbox)) mode = "files";
    if (!order.test && cfg.lulu.env !== "production") mode = "practice-real";

    const books = [];
    for (const b of built) {
      const input = b.input;
      log(`${label}: building book for ${input.name} (${input.cover}, ${input.selected.join(", ")})${b.quantity > 1 ? ` x${b.quantity}` : ""}...`);
      const t0 = Date.now();
      const book = await renderBook(input, { spine: cfg.lulu.spine });
      const interiorUrl = saveFile(book.interior, "interior");
      const coverUrl = saveFile(book.cover, "cover");
      log(`${label}: book ready, ${book.pages} pages, ${Math.round((Date.now() - t0) / 1000)}s.`);
      books.push({ name: book.name, pages: book.pages, quantity: b.quantity, interiorUrl, coverUrl,
        title: `${book.name}'s All About Me Book (${label})` });
    }
    const links = books.map(b => `${b.name}${b.quantity > 1 ? ` (x${b.quantity})` : ""} — ${b.pages} pages\nInterior: ${b.interiorUrl}\nCover: ${b.coverUrl}`).join("\n");
    const warn = problems.length ? `\nNote: ${[...new Set(problems)].join(" ")}` : "";

    if (mode !== "send") {
      const why = mode === "files"
        ? (order.test ? "This was a TEST order, so it was not sent to Lulu." : "Files-only mode is on, so it was not sent to Lulu.")
        : "The connector is still in PRACTICE (sandbox) mode, so this REAL order was NOT sent to Lulu. Print it by hand or switch to production and retry.";
      await tag(gid, [mode === "files" ? "book-files-ready" : "book-needs-manual-print"]);
      await note(gid, `Book files: ${why}\n${links}${warn}`);
      return log(`${label}: files only. ${why}`);
    }

    if (missing.length) {
      await tag(gid, ["book-problem"]);
      await note(gid, `BOOK NOT SENT: shipping address is missing ${missing.join(", ")}.\n${links}`);
      return log(`${label}: STOPPED, address missing ${missing.join(", ")}.`);
    }

    const job = await lulu.createPrintJob({ externalId: `shopify-${id}`, books, address: addr });
    ensureDirs(); fs.writeFileSync(sentMarker, String(job.id || ""));
    await tag(gid, ["lulu-sent"]);
    await note(gid, `Sent to Lulu (${cfg.lulu.env}) — print job ${job.id}.\n${links}${warn}`);
    log(`${label}: SENT to Lulu ${cfg.lulu.env}, print job ${job.id}.`);
  } catch (e) {
    log(`${label}: ERROR ${e.message}`);
    await tag(gid, ["book-problem"]);
    await note(gid, `BOOK NOT SENT because of an error: ${e.message.slice(0, 400)}`);
  } finally {
    inFlight.delete(id);
  }
}

/* ---------- Lulu status updates ---------- */
async function handleLulu(payload) {
  const job = payload && payload.data;
  if (!job) return;
  const status = (job.status && (job.status.name || job.status)) || "";
  const m = /^shopify-(\d+)$/.exec(job.external_id || "");
  log(`Lulu job ${job.id}: ${status}`);
  if (!m) return;
  const gid = gidOf(m[1]);
  if (status === "SHIPPED") {
    const li = (job.line_items || []).find(l => l.tracking_id || (l.tracking_urls || []).length) || {};
    const tracking = { company: li.carrier_name, number: li.tracking_id, url: (li.tracking_urls || [])[0] };
    if (shopify.canUseApi()) {
      try { const r = await shopify.fulfillWithTracking(gid, tracking); log(`Order ${m[1]}: marked shipped ${r && r.skipped ? "(" + r.skipped + ")" : ""}`); }
      catch (e) { log(`Order ${m[1]}: could not mark shipped: ${e.message}`); await note(gid, `Lulu shipped it (tracking ${tracking.number || "n/a"}) but marking it shipped failed: ${e.message}`); }
    }
  } else if (["REJECTED", "CANCELED", "ERROR"].includes(status)) {
    const msg = JSON.stringify(job.status && job.status.messages || "").slice(0, 400);
    await tag(gid, ["book-problem"]);
    await note(gid, `Lulu says the print job ${job.id} is ${status}. ${msg}`);
  } else if (status === "UNPAID") {
    await tag(gid, ["book-problem"]);
    await note(gid, `Lulu print job ${job.id} is UNPAID — check the payment card in your Lulu account.`);
  } else if (status === "IN_PRODUCTION") {
    await tag(gid, ["printing"]);
  }
}

/* ---------- admin pages (need ?key=ADMIN_KEY) ---------- */
function statusPage() {
  const rows = [
    ["Lulu mode", cfg.lulu.env === "production" ? "LIVE — real printing" : "Practice (sandbox) — nothing prints"],
    ["Lulu keys", cfg.lulu.key && cfg.lulu.secret ? "set" : "MISSING"],
    ["Book format", cfg.lulu.podPackageId],
    ["Shipping level", cfg.lulu.shippingLevel],
    ["Shopify store", cfg.shopify.store || "MISSING"],
    ["Shopify webhook key", cfg.shopify.webhookSecret || cfg.shopify.clientSecret ? "set" : "MISSING"],
    ["Shopify app (tags, notes, tracking)", shopify.canUseApi() ? "set" : "not set"],
    ["Files-only mode", cfg.filesOnly ? "ON" : "off"],
    ["This connector's address", cfg.publicUrl],
  ];
  const k = encodeURIComponent(cfg.adminKey);
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connector status</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:860px;margin:24px auto;padding:0 16px;color:#222}td{padding:4px 12px 4px 0;vertical-align:top}pre{background:#f4f4f6;padding:12px;border-radius:8px;white-space:pre-wrap;font-size:13px}a{color:#6b3fa0}</style>
<h1>Color Me Spellbound connector</h1><table>${rows.map(([a, b]) => `<tr><td><b>${esc(a)}</b></td><td>${esc(b)}</td></tr>`).join("")}</table>
<p><a href="/admin/check?key=${k}">Check connections</a> · <a href="/admin/test-book?key=${k}&name=Avery&color=pink&favorites=unicorns,ballet,pets">Build a sample book</a> · <a href="/admin/test-book?key=${k}&name=Avery&color=red&favorites=unicorns,flowers,pets&edition=christmas">Build a Christmas sample</a> · <a href="/admin/setup-lulu-webhook?key=${k}">Turn on Lulu tracking updates</a></p>
<h2>Recent activity</h2><pre>${esc(logLines.slice(-60).reverse().join("\n") || "Nothing yet.")}</pre>`;
}

async function admin(url, res) {
  if (!keyOk(url)) return send(res, 403, "Add ?key=YOUR_ADMIN_KEY to the address.");
  const p = url.pathname;
  if (p === "/admin") return send(res, 200, statusPage(), "text/html; charset=utf-8");
  if (p === "/admin/check") {
    const out = [];
    try { await require("./lib/lulu").costEstimate({ pageCount: 32, address: { street1: "1 Main St", city: "Tulsa", state_code: "OK", country_code: "US", postcode: "74103", phone_number: "9185550100" } }).then(c => out.push(`Lulu: connected (${cfg.lulu.env}). A 32-page book shipped ${cfg.lulu.shippingLevel} to Tulsa costs about $${c.total_cost_incl_tax || c.total_cost_excl_tax || "?"}.`)); }
    catch (e) { out.push("Lulu: NOT connected — " + e.message); }
    if (shopify.canUseApi()) { try { await shopify.gql("{ shop { name } }").then(d => out.push(`Shopify: connected to ${d.shop.name}.`)); } catch (e) { out.push("Shopify: NOT connected — " + e.message); } }
    else out.push("Shopify app: not set up (orders still print; tags, notes and tracking need it).");
    return send(res, 200, out.join("\n\n"));
  }
  if (p === "/admin/test-book") {
    const fav = (url.searchParams.get("favorites") || "unicorns,flowers,pets").split(",").filter(f => INTERESTS.some(([id]) => id === f)).slice(0, 3);
    const input = { name: url.searchParams.get("name") || "Avery", cover: url.searchParams.get("color") || "purple", from: url.searchParams.get("from") || "Mimi", meaning: url.searchParams.get("meaning") || "", words: url.searchParams.get("words") || "", selected: fav.length ? fav : ["unicorns"], edition: url.searchParams.get("edition") === "christmas" ? "christmas" : "regular" };
    const t0 = Date.now();
    const b = await renderBook(input, { spine: cfg.lulu.spine });
    const i = saveFile(b.interior, "sample-interior"), c = saveFile(b.cover, "sample-cover");
    log(`Sample book for ${input.name}: ${b.pages} pages in ${Math.round((Date.now() - t0) / 1000)}s`);
    return send(res, 200, `<!doctype html><meta charset="utf-8"><p>Sample book for <b>${esc(b.name)}</b>: ${b.pages} pages, cover ${b.coverInches.map(n => n.toFixed(3)).join(" × ")} in.</p><p><a href="${i}">Open interior PDF</a><br><a href="${c}">Open cover PDF</a></p>`, "text/html; charset=utf-8");
  }
  if (p === "/admin/lulu-job") {
    const id = (url.searchParams.get("id") || "").replace(/\D/g, "");
    if (!id) return send(res, 400, "Add &id=PRINT_JOB_NUMBER to the address.");
    const L = require("./lib/lulu");
    const out = [];
    try {
      const job = await L.getPrintJob(id);
      out.push(`Print job ${id}: status ${job.status && job.status.name}${job.status && job.status.messages ? " " + JSON.stringify(job.status.messages) : ""}`);
      for (const li of job.line_items || []) {
        out.push(`Book: ${li.title} | format ${li.pod_package_id || (li.printable_normalization || {}).pod_package_id} | pages ${li.page_count} | qty ${li.quantity} | status ${li.status && li.status.name} ${li.status && li.status.messages ? JSON.stringify(li.status.messages) : ""}`);
      }
      const c = job.costs || {};
      out.push("Lulu's charges:\n" + JSON.stringify(c, null, 2));
      const pages = (job.line_items || [])[0] && job.line_items[0].page_count;
      if (pages) {
        const est = await L.costEstimate({ pageCount: pages, address: { ...job.shipping_address, email: undefined } }).catch(e => ({ error: e.message }));
        out.push(`Price check for ${pages} pages to the same address:\n` + JSON.stringify(est, null, 2));
      }
    } catch (e) { out.push("Could not read the job: " + e.message); }
    return send(res, 200, out.join("\n\n"));
  }
  if (p === "/admin/setup-lulu-webhook") {
    const r = await lulu.subscribeWebhook(`${cfg.publicUrl}/webhooks/lulu`);
    return send(res, 200, r && r.already ? "Lulu tracking updates were already on." : "Lulu tracking updates are now on.");
  }
  if (p === "/admin/retry") {
    const f = path.join(DIRS.orders, `${(url.searchParams.get("order") || "").replace(/\D/g, "")}.json`);
    if (!fs.existsSync(f)) return send(res, 404, "No saved order with that number. Use the long order id from the order's web address.");
    processOrder(JSON.parse(fs.readFileSync(f, "utf8")), { force: url.searchParams.get("force") === "yes" });
    return send(res, 200, "Retrying. Check the status page in a minute.");
  }
  return send(res, 404, "Not found");
}

/* ---------- web server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) return send(res, 200, "Color Me Spellbound connector is running.");

    if (req.method === "GET" && url.pathname.startsWith("/files/")) {
      const name = path.basename(url.pathname);
      const f = path.join(DIRS.files, name);
      if (!/^[a-f0-9]{36}-[a-z-]+\.pdf$/.test(name) || !fs.existsSync(f)) return send(res, 404, "Not found");
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Length": fs.statSync(f).size });
      return fs.createReadStream(f).pipe(res);
    }

    if (req.method === "POST" && url.pathname === "/webhooks/shopify") {
      const raw = await readBody(req);
      if (!shopify.verifyWebhook(raw, req.headers["x-shopify-hmac-sha256"])) { log("Rejected a Shopify message with a bad signature."); return send(res, 401, "bad signature"); }
      send(res, 200, "ok"); // answer right away; Shopify waits only a few seconds
      const order = JSON.parse(raw.toString("utf8"));
      if (order && order.id) {
        ensureDirs();
        fs.writeFileSync(path.join(DIRS.orders, `${order.id}.json`), raw);
        processOrder(order);
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/webhooks/lulu") {
      const raw = await readBody(req);
      if (!lulu.verifyWebhook(raw, req.headers["lulu-hmac-sha256"])) { log("Rejected a Lulu message with a bad signature."); return send(res, 401, "bad signature"); }
      send(res, 200, "ok");
      handleLulu(JSON.parse(raw.toString("utf8"))).catch(e => log(`Lulu update error: ${e.message}`));
      return;
    }

    if (url.pathname.startsWith("/admin")) return await admin(url, res);
    send(res, 404, "Not found");
  } catch (e) {
    log(`Server error on ${url.pathname}: ${e.message}`);
    if (!res.headersSent) send(res, 500, "Something went wrong: " + e.message);
  }
});

if (require.main === module) {
  server.listen(cfg.port, () => log(`Connector running on port ${cfg.port}. Lulu mode: ${cfg.lulu.env}.`));
}
module.exports = { server, processOrder, handleLulu };
