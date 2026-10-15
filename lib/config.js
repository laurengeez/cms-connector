// All settings come from environment variables (set them on Render, never in the code).
const env = (k, d) => (process.env[k] == null || process.env[k] === "" ? d : process.env[k]);

module.exports = {
  port: Number(env("PORT", 3000)),
  // The public web address of this connector, e.g. https://cms-connector.onrender.com (no trailing slash)
  publicUrl: env("PUBLIC_URL", "http://localhost:3000").replace(/\/+$/, ""),
  // A password you make up. Needed for the admin test pages.
  adminKey: env("ADMIN_KEY", ""),
  dataDir: env("DATA_DIR", "/tmp/cms-data"),

  shopify: {
    store: env("SHOPIFY_STORE_DOMAIN", ""), // e.g. color-me-spellbound.myshopify.com
    apiVersion: env("SHOPIFY_API_VERSION", "2026-01"),
    accessToken: env("SHOPIFY_ACCESS_TOKEN", ""), // shpat_... (optional if client id/secret given)
    clientId: env("SHOPIFY_CLIENT_ID", ""),
    clientSecret: env("SHOPIFY_CLIENT_SECRET", ""),
    // Signing key for the "Order payment" webhook (shown in Settings > Notifications > Webhooks).
    webhookSecret: env("SHOPIFY_WEBHOOK_SECRET", ""),
    // Only line items whose product title contains this text are treated as books.
    bookTitleMatch: env("BOOK_TITLE_MATCH", "My Name Is Magic"),
  },

  lulu: {
    // "sandbox" (practice, nothing prints) or "production" (real printing, real charges)
    env: env("LULU_ENV", "sandbox"),
    key: env("LULU_CLIENT_KEY", ""),
    secret: env("LULU_CLIENT_SECRET", ""),
    // 8.5x11, black & white, standard, SADDLE STITCH (stapled), 60# white paper, matte cover
    podPackageId: env("LULU_POD_PACKAGE_ID", "0850X1100BWSTDSS060UW444MXX"),
    shippingLevel: env("LULU_SHIPPING_LEVEL", "MAIL"),
    contactEmail: env("LULU_CONTACT_EMAIL", ""),
    fallbackPhone: env("FALLBACK_PHONE", ""),
    spine: Number(env("COVER_SPINE_INCHES", "0")),
  },

  // Shopify test orders never print. Set to "yes" only to send test orders to the Lulu SANDBOX.
  sendTestOrdersToSandbox: env("SEND_TEST_ORDERS_TO_SANDBOX", "yes") === "yes",
  // "yes" = build the files and attach links to the order, but do not send anything to Lulu.
  filesOnly: env("FILES_ONLY", "no") === "yes",
};
