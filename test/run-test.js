// End-to-end test with fake Shopify and fake Lulu. Nothing real is contacted.
//   node test/run-test.js
const crypto = require("crypto");
const http = require("http");
Object.assign(process.env, {
  PORT: "3999", PUBLIC_URL: "http://localhost:3999", ADMIN_KEY: "test", DATA_DIR: "/tmp/cms-test-data",
  SHOPIFY_STORE_DOMAIN: "test-store.myshopify.com", SHOPIFY_ACCESS_TOKEN: "shpat_test", SHOPIFY_WEBHOOK_SECRET: "whsec",
  LULU_ENV: "sandbox", LULU_CLIENT_KEY: "k", LULU_CLIENT_SECRET: "luluSecret", LULU_CONTACT_EMAIL: "owner@example.com",
  FALLBACK_PHONE: "9185550100", RENDER_OFFLINE: "yes",
});
require("fs").rmSync("/tmp/cms-test-data", { recursive: true, force: true });
const { PDFDocument } = require("pdf-lib");
const realFetch = global.fetch;
const calls = [];
global.fetch = async (url, opts = {}) => {
  url = String(url);
  if (url.startsWith("http://localhost")) return realFetch(url, opts);
  const body = opts.body ? String(opts.body) : "";
  calls.push({ url, body });
  const json = o => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });
  if (url.includes("openid-connect/token")) return json({ access_token: "tok", expires_in: 3600 });
  if (url.endsWith("/print-jobs/")) return json({ id: 777, status: { name: "CREATED" } });
  if (url.includes("graphql.json")) {
    if (body.includes("fulfillmentOrders")) return json({ data: { order: { fulfillmentOrders: { nodes: [{ id: "gid://shopify/FulfillmentOrder/1", status: "OPEN" }] } } } });
    if (body.includes("fulfillmentCreate")) return json({ data: { fulfillmentCreate: { fulfillment: { id: "f1", status: "SUCCESS" }, userErrors: [] } } });
    if (body.includes("tagsAdd")) return json({ data: { tagsAdd: { userErrors: [] } } });
    if (body.includes("orderUpdate")) return json({ data: { orderUpdate: { userErrors: [] } } });
    if (body.includes("order(id")) return json({ data: { order: { id: "x", name: "#1003", tags: [], note: "" } } });
  }
  return new Response("not mocked", { status: 500 });
};

const { server, processOrder } = require("../server");
const order = (over = {}) => ({
  id: 5550001, admin_graphql_api_id: "gid://shopify/Order/5550001", name: "#1003", test: true, email: "buyer@example.com", tags: "",
  line_items: [{ title: "My Name Is Magic: Personalized All About Me Coloring Book", quantity: 1, properties: [] }],
  note_attributes: [
    { name: "Child's name", value: "Lauren" }, { name: "From", value: "Mimi" }, { name: "Name meaning", value: "from the Laurel plant" },
    { name: "Special words", value: "creative pretty lovely" }, { name: "Cover color", value: "Teal" },
    { name: "Favorites", value: "Unicorns & magic, Puppies, kittens & bunnies, Dinosaurs" },
  ],
  shipping_address: { name: "Lauren G", address1: "8988 S 264th East Ave", city: "Broken Arrow", province_code: "OK", country_code: "US", zip: "74014", phone: null },
  ...over,
});

function post(path, raw, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "localhost", port: 3999, path, method: "POST", headers: { "Content-Type": "application/json", ...headers } }, res => {
      let d = ""; res.on("data", c => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.on("error", reject); req.end(raw);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (ok, msg) => { console.log((ok ? "PASS " : "FAIL ") + msg); if (!ok) process.exitCode = 1; };

(async () => {
  await new Promise(r => server.listen(3999, r));

  // 1. Bad signature is refused
  const raw = JSON.stringify(order());
  const bad = await post("/webhooks/shopify", raw, { "X-Shopify-Hmac-Sha256": "nope" });
  check(bad.status === 401, "unsigned Shopify message is refused");

  // 2. Signed test order goes to the Lulu sandbox
  const sig = crypto.createHmac("sha256", "whsec").update(raw).digest("base64");
  const t0 = Date.now();
  const ok = await post("/webhooks/shopify", raw, { "X-Shopify-Hmac-Sha256": sig });
  check(ok.status === 200, "signed Shopify order accepted right away");
  for (let i = 0; i < 300 && !calls.some(c => c.url.endsWith("/print-jobs/")); i++) await sleep(500);
  const job = calls.find(c => c.url.endsWith("/print-jobs/"));
  check(!!job, `Lulu print job requested (${Math.round((Date.now() - t0) / 1000)}s to build the book)`);
  const pj = JSON.parse(job.body);
  console.log(JSON.stringify({ ...pj, line_items: pj.line_items.map(l => ({ ...l, printable_normalization: "…urls…" })) }, null, 1));
  check(pj.shipping_address.phone_number === "9185550100", "missing customer phone filled with your phone number");
  check(pj.line_items[0].printable_normalization.pod_package_id === "0850X1100BWSTDSS060UW444MXX", "stapled 8.5x11 format");
  check(pj.external_id === "shopify-5550001", "Lulu job is linked to the Shopify order");

  const urls = pj.line_items[0].printable_normalization;
  for (const [k, u] of Object.entries({ interior: urls.interior.source_url, cover: urls.cover.source_url })) {
    const buf = Buffer.from(await (await realFetch(u)).arrayBuffer());
    const doc = await PDFDocument.load(buf);
    const { width, height } = doc.getPage(0).getSize();
    require("fs").writeFileSync(`/tmp/cms-test-data/${k}.pdf`, buf);
    check(true, `${k}: ${doc.getPageCount()} page(s), ${(width / 72).toFixed(3)} x ${(height / 72).toFixed(3)} in, ${(buf.length / 1e6).toFixed(1)} MB`);
  }
  check(calls.some(c => c.body.includes("lulu-sent")), "order tagged lulu-sent");

  // 3. Same order again is ignored
  const before = calls.filter(c => c.url.endsWith("/print-jobs/")).length;
  await post("/webhooks/shopify", raw, { "X-Shopify-Hmac-Sha256": sig }); await sleep(1500);
  check(calls.filter(c => c.url.endsWith("/print-jobs/")).length === before, "duplicate Shopify message does not print twice");

  // 4. A REAL order while still in practice mode is NOT sent anywhere
  const real = order({ id: 5550002, admin_graphql_api_id: "gid://shopify/Order/5550002", name: "#1004", test: false });
  calls.length = 0; await processOrder(real);
  check(!calls.some(c => c.url.endsWith("/print-jobs/")) && calls.some(c => c.body.includes("book-needs-manual-print")), "real order in practice mode is held, not sent");

  // 5. Order with no name stops with a problem tag
  calls.length = 0; await processOrder(order({ id: 5550003, admin_graphql_api_id: "gid://shopify/Order/5550003", note_attributes: [] }));
  check(calls.some(c => c.body.includes("book-problem")) && !calls.some(c => c.url.endsWith("/print-jobs/")), "missing name is flagged, nothing printed");

  // 6. Lulu says SHIPPED -> Shopify order gets tracking
  calls.length = 0;
  const ship = JSON.stringify({ topic: "PRINT_JOB_STATUS_CHANGED", data: { id: 777, external_id: "shopify-5550001", status: { name: "SHIPPED" }, line_items: [{ tracking_id: "9400TEST", tracking_urls: ["https://tools.usps.com/x?n=9400TEST"], carrier_name: "USPS" }] } });
  const lsig = crypto.createHmac("sha256", "luluSecret").update(ship).digest("hex");
  check((await post("/webhooks/lulu", ship, { "Lulu-HMAC-SHA256": "bad" })).status === 401, "unsigned Lulu message is refused");
  await post("/webhooks/lulu", ship, { "Lulu-HMAC-SHA256": lsig }); await sleep(1000);
  const ful = calls.find(c => c.body.includes("fulfillmentCreate"));
  check(!!ful && ful.body.includes("9400TEST") && ful.body.includes('"notifyCustomer":true'), "Shopify order marked shipped with tracking, customer emailed");

  // 7. One order with two different children (and 2 copies of one) -> two books in one Lulu job
  calls.length = 0;
  const li = (name, qty) => ({ title: "My Name Is Magic: Personalized All About Me Coloring Book", quantity: qty,
    properties: [{ name: "Child's name", value: name }, { name: "Favorites", value: "Dinosaurs" }, { name: "Cover color", value: "Blue" }] });
  await processOrder(order({ id: 5550007, admin_graphql_api_id: "gid://shopify/Order/5550007", name: "#1007", line_items: [li("Mia", 1), li("Jack", 2)] }));
  const two = calls.find(c => c.url.endsWith("/print-jobs/"));
  const tj = two && JSON.parse(two.body);
  check(!!tj && tj.line_items.length === 2 && /Mia/.test(tj.line_items[0].title) && /Jack/.test(tj.line_items[1].title) && tj.line_items[1].quantity === 2,
    "two different children in one order get their own books (Jack x2)");

  // 8. A Christmas Edition product builds the holiday book
  const { toBookInput } = require("../lib/map");
  const xo = order({ line_items: [{ title: "My Name Is Magic: Christmas Edition", quantity: 1, properties: [] }] });
  check(toBookInput(xo, xo.line_items[0]).input.edition === "christmas" && toBookInput(order(), order().line_items[0]).input.edition === "regular",
    "Christmas Edition product is detected; the regular book stays regular");
  const xb = await require("../lib/render").renderBook({ ...toBookInput(xo, xo.line_items[0]).input }, { spine: 0 });
  check(xb.pages % 4 === 0 && xb.pages <= 48, `Christmas book built: ${xb.pages} pages`);

  server.close(); await require("../lib/render").shutdown();
})().catch(e => { console.error(e); process.exit(1); });
