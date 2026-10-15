// Talks to Shopify: checks webhook signatures, tags orders, adds notes, marks orders shipped.
const crypto = require("crypto");
const cfg = require("./config").shopify;

let token = cfg.accessToken || null, tokenExp = cfg.accessToken ? Infinity : 0;

const canUseApi = () => !!(cfg.store && (cfg.accessToken || (cfg.clientId && cfg.clientSecret)));

async function getToken() {
  if (token && Date.now() < tokenExp) return token;
  if (!cfg.store || !cfg.clientId || !cfg.clientSecret) throw new Error("Shopify app details are not set.");
  const res = await fetch(`https://${cfg.store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: cfg.clientId, client_secret: cfg.clientSecret }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new Error(`Shopify sign-in failed (${res.status}): ${JSON.stringify(j).slice(0, 300)}`);
  token = j.access_token;
  tokenExp = j.expires_in ? Date.now() + (j.expires_in - 300) * 1000 : Infinity;
  return token;
}

async function gql(query, variables) {
  const res = await fetch(`https://${cfg.store}/admin/api/${cfg.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.errors) throw new Error(`Shopify API error (${res.status}): ${JSON.stringify(j.errors || j).slice(0, 500)}`);
  return j.data;
}

function userErrors(obj) {
  const errs = obj && obj.userErrors;
  if (errs && errs.length) throw new Error("Shopify: " + errs.map(e => e.message).join("; "));
  return obj;
}

// Webhooks from Settings > Notifications use the key shown there; app webhooks use the app's client secret.
function verifyWebhook(raw, hmacHeader) {
  if (!hmacHeader) return false;
  for (const secret of [cfg.webhookSecret, cfg.clientSecret].filter(Boolean)) {
    const digest = crypto.createHmac("sha256", secret).update(raw).digest("base64");
    const a = Buffer.from(digest), b = Buffer.from(String(hmacHeader));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

async function getOrderMeta(gid) {
  const d = await gql(`query($id: ID!){ order(id:$id){ id name tags note } }`, { id: gid });
  return d.order;
}

async function addTags(gid, tags) {
  const d = await gql(`mutation($id: ID!, $tags: [String!]!){ tagsAdd(id:$id, tags:$tags){ userErrors{ message } } }`, { id: gid, tags });
  userErrors(d.tagsAdd);
}

async function removeTags(gid, tags) {
  const d = await gql(`mutation($id: ID!, $tags: [String!]!){ tagsRemove(id:$id, tags:$tags){ userErrors{ message } } }`, { id: gid, tags });
  userErrors(d.tagsRemove);
}

// Adds a line to the order's notes (keeps anything already there).
async function appendNote(gid, line) {
  const o = await getOrderMeta(gid);
  const note = [o && o.note, line].filter(Boolean).join("\n");
  const d = await gql(`mutation($input: OrderInput!){ orderUpdate(input:$input){ userErrors{ message } } }`, { input: { id: gid, note: note.slice(-4900) } });
  userErrors(d.orderUpdate);
}

// Marks the order shipped with tracking. Shopify emails the customer the tracking link.
async function fulfillWithTracking(gid, { company, number, url }) {
  const d = await gql(`query($id: ID!){ order(id:$id){ fulfillmentOrders(first: 10){ nodes{ id status } } } }`, { id: gid });
  const open = ((d.order && d.order.fulfillmentOrders.nodes) || []).filter(f => ["OPEN", "IN_PROGRESS", "SCHEDULED"].includes(f.status));
  if (!open.length) return { skipped: "Order is already fulfilled." };
  const m = await gql(`mutation($f: FulfillmentInput!){ fulfillmentCreate(fulfillment:$f){ fulfillment{ id status } userErrors{ message } } }`, {
    f: {
      lineItemsByFulfillmentOrder: open.map(f => ({ fulfillmentOrderId: f.id })),
      trackingInfo: { company: company || undefined, number: number || undefined, url: url || undefined },
      notifyCustomer: true,
    },
  });
  return userErrors(m.fulfillmentCreate);
}

module.exports = { canUseApi, verifyWebhook, getOrderMeta, addTags, removeTags, appendNote, fulfillWithTracking, gql };
