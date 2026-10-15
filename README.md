# Color Me Spellbound — order connector

What it does, automatically:

1. A customer pays for **My Name Is Magic** on colormespellbound.com.
2. Shopify tells the connector. The connector builds that child's book (interior PDF + cover PDF) with the same book maker used to design it.
3. It sends both files and the shipping address to **Lulu**, which prints and ships the book. Lulu charges the card saved in the Lulu account.
4. The Shopify order gets the tag `lulu-sent` and a note with the Lulu print job number.
5. When Lulu ships, the connector marks the Shopify order shipped with the tracking number, and Shopify emails the customer.

## Safety rules built in

- **Shopify test orders never print for real.** In practice mode they go to the Lulu sandbox; in live mode they only build files.
- **Real orders are never sent to the sandbox.** If the connector is still in practice mode, a real order is tagged `book-needs-manual-print` with links to its files.
- **Nothing prints twice** if Shopify repeats a message.
- **Problems are flagged on the order** with the tag `book-problem` and a note saying what went wrong (missing name, bad address, Lulu error, unpaid Lulu job).

## Settings (set these on the host, never in the code)

| Setting | What to put |
|---|---|
| `PUBLIC_URL` | This connector's web address, e.g. `https://cms-connector.up.railway.app` |
| `ADMIN_KEY` | A password you make up, for the status page |
| `LULU_ENV` | `sandbox` while practicing, `production` when live |
| `LULU_CLIENT_KEY`, `LULU_CLIENT_SECRET` | From the Lulu developer site (sandbox and production have different keys) |
| `LULU_CONTACT_EMAIL` | Your email, for Lulu's messages |
| `FALLBACK_PHONE` | Your phone, used when a customer leaves phone blank (Lulu requires one) |
| `LULU_POD_PACKAGE_ID` | Book format. Default `0850X1100BWSTDSS060UW444MXX` = 8.5×11, black & white, stapled (saddle stitch) |
| `LULU_SHIPPING_LEVEL` | `MAIL` (cheapest, default), `GROUND`, `EXPEDITED`… |
| `SHOPIFY_STORE_DOMAIN` | e.g. `color-me-spellbound.myshopify.com` |
| `SHOPIFY_WEBHOOK_SECRET` | The signing key shown under Settings → Notifications → Webhooks |
| `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET` | From the Shopify app (for tags, notes and tracking) — or `SHOPIFY_ACCESS_TOKEN` |

## Pages

- `/admin?key=ADMIN_KEY` — status and recent activity
- `/admin/check?key=…` — checks the Lulu and Shopify connections
- `/admin/test-book?key=…&name=Avery&color=pink&favorites=unicorns,ballet,pets` — builds a sample book
- `/admin/setup-lulu-webhook?key=…` — turns on Lulu shipping updates (do once)
- `/admin/retry?key=…&order=ORDER_ID` — tries an order again (`&force=yes` to resend)

## Updating the book design

Replace `book/book-maker.html` with the newest book maker file and redeploy.

## Test

`npm test` runs a full fake order (no real Shopify or Lulu) and checks every step.
