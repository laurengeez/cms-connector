// Talks to the Lulu Print API.
const crypto = require("crypto");
const cfg = require("./config").lulu;

const base = () => (cfg.env === "production" ? "https://api.lulu.com" : "https://api.sandbox.lulu.com");
let token = null, tokenExp = 0;

async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  if (!cfg.key || !cfg.secret) throw new Error("Lulu keys are not set (LULU_CLIENT_KEY / LULU_CLIENT_SECRET).");
  const res = await fetch(`${base()}/auth/realms/glasstree/protocol/openid-connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: "Basic " + Buffer.from(`${cfg.key}:${cfg.secret}`).toString("base64"),
    },
    body: "grant_type=client_credentials",
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Lulu sign-in failed (${res.status}): ${JSON.stringify(j).slice(0, 300)}`);
  token = j.access_token;
  tokenExp = Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000;
  return token;
}

async function api(method, p, body) {
  const res = await fetch(base() + p, {
    method,
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + (await getToken()) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let j; try { j = JSON.parse(text); } catch (e) { j = { raw: text }; }
  if (!res.ok) throw new Error(`Lulu ${method} ${p} failed (${res.status}): ${text.slice(0, 600)}`);
  return j;
}

// books: [{ title, quantity, interiorUrl, coverUrl }] — one entry per different child's book.
function createPrintJob({ externalId, books, address, shippingLevel, podPackageId }) {
  const pod = podPackageId || cfg.podPackageId;
  return api("POST", "/print-jobs/", {
    external_id: externalId,
    contact_email: cfg.contactEmail || address.email,
    shipping_level: shippingLevel || cfg.shippingLevel,
    shipping_address: address,
    line_items: books.map((b, i) => ({
      external_id: books.length > 1 ? `${externalId}-${i + 1}` : externalId,
      title: b.title,
      quantity: b.quantity || 1,
      pod_package_id: pod,
      printable_normalization: {
        cover: { source_url: b.coverUrl },
        interior: { source_url: b.interiorUrl },
        pod_package_id: pod,
      },
    })),
  });
}

const getPrintJob = id => api("GET", `/print-jobs/${id}/`);

function costEstimate({ pageCount, address }) {
  return api("POST", "/print-job-cost-calculations/", {
    line_items: [{ pod_package_id: cfg.podPackageId, page_count: pageCount, quantity: 1 }],
    shipping_address: address,
    shipping_option: cfg.shippingLevel,
  });
}

// Ask Lulu to tell us when a print job changes (for tracking numbers).
async function subscribeWebhook(url) {
  const existing = await api("GET", "/webhooks/").catch(() => null);
  const list = existing && (existing.results || existing);
  if (Array.isArray(list) && list.some(w => w.url === url)) return { already: true };
  return api("POST", "/webhooks/", { topics: ["PRINT_JOB_STATUS_CHANGED"], url });
}

function verifyWebhook(raw, header) {
  if (!header || !cfg.secret) return false;
  const mac = crypto.createHmac("sha256", cfg.secret).update(raw);
  const hex = mac.digest("hex");
  const b64 = Buffer.from(hex, "hex").toString("base64");
  const h = String(header).trim();
  return safeEq(h.toLowerCase(), hex) || safeEq(h, b64);
}

function safeEq(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

module.exports = { createPrintJob, getPrintJob, costEstimate, subscribeWebhook, verifyWebhook, base };
