const API_BASE = "https://api.businesskoro.com/api/v1/storefront";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function apiHeaders(env) {
  if (!env.BUSINESS_KORO_API_KEY) throw new Error("Business Koro API key is not configured in Cloudflare.");
  const headers = {
    "x-api-key": env.BUSINESS_KORO_API_KEY,
    "content-type": "application/json"
  };
  if (env.BUSINESS_KORO_DOMAIN) headers["x-domain"] = env.BUSINESS_KORO_DOMAIN;
  return headers;
}

async function proxyProducts(env) {
  const response = await fetch(`${API_BASE}/products`, { headers: apiHeaders(env) });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { return json({ error: "Business Koro returned an unreadable response." }, 502); }
  if (!response.ok) return json({ error: data?.message || "Could not load products.", details: data }, response.status);
  // Never send internal cost/profit fields to the public browser.
  const products = (data?.data || []).map(p => ({
    id: p.id,
    name: p.name,
    description: p.description || "",
    images: Array.isArray(p.images) ? p.images : [],
    suggestedPrice: p.suggestedPrice,
    inStock: p.inStock,
    variants: Array.isArray(p.variants) ? p.variants : []
  }));
  return json({ data: products, deliveryCharges: data?.deliveryCharges || {} });
}

async function createOrder(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "অর্ডারের তথ্য সঠিকভাবে পাওয়া যায়নি।" }, 400); }

  const required = ["productId", "customerName", "customerPhone", "customerAddress",
    "customerDivision", "customerDistrict", "customerArea", "sellingPrice"];
  for (const key of required) {
    if (body[key] === undefined || body[key] === null || String(body[key]).trim() === "") {
      return json({ error: `অনুগ্রহ করে ${key} পূরণ করুন।` }, 400);
    }
  }
  const payload = {
    productId: body.productId,
    customerName: String(body.customerName).trim(),
    customerPhone: String(body.customerPhone).trim(),
    customerAddress: String(body.customerAddress).trim(),
    customerDivision: String(body.customerDivision).trim(),
    customerDistrict: String(body.customerDistrict).trim(),
    customerArea: String(body.customerArea).trim(),
    sellingPrice: Number(body.sellingPrice),
    deliveryChargePaidByCustomer: true
  };
  if (body.customerNote) payload.customerNote = String(body.customerNote).trim().slice(0, 500);

  const response = await fetch(`${API_BASE}/orders`, {
    method: "POST",
    headers: apiHeaders(env),
    body: JSON.stringify(payload)
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { return json({ error: "Business Koro থেকে সঠিক উত্তর পাওয়া যায়নি।" }, 502); }
  return json(data, response.status);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/products" && request.method === "GET") return await proxyProducts(env);
      if (url.pathname === "/api/orders" && request.method === "POST") return await createOrder(request, env);
      if (url.pathname.startsWith("/api/")) return json({ error: "API route not found." }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error?.message || "Server error." }, 500);
    }
  }
};
