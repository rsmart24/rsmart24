# RS Mart — Cloudflare Worker storefront

Starter storefront for the `rsmart24` GitHub repository.

## What is included
- Responsive Bangla-friendly storefront
- Product list loaded through a server-side Worker proxy
- Order form that submits to Business Koro
- API key kept in a Cloudflare Worker secret (never in browser code)

## Before deploying
1. In Cloudflare Worker settings, add secret `BUSINESS_KORO_API_KEY`.
2. If Business Koro has a configured domain for this store, add variable `BUSINESS_KORO_DOMAIN` (otherwise leave unset).
3. Confirm the API key and storefront access with Business Koro.
4. Deploy using `npx wrangler deploy`.

## Local development
```bash
npm install
npm run dev
```

## Important
This is a starter integration. Test product loading and submit a test order before sharing the website publicly. Product selling prices are initially taken from Business Koro's `suggestedPrice`. Delivery fee is shown using the API's `deliveryCharges` values. The order request marks delivery as paid by the customer. Adjust the delivery/payment policy before launch if your business rules differ.
