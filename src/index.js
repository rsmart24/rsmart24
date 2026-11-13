
const API_BASE = "https://api.businesskoro.com/api/v1/storefront";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders
    }
  });
}

function apiHeaders(env) {
  if (!env.BUSINESS_KORO_API_KEY) {
    throw new Error("Business Koro API key is not configured.");
  }
  const headers = {
    "x-api-key": env.BUSINESS_KORO_API_KEY,
    "content-type": "application/json"
  };
  if (env.BUSINESS_KORO_DOMAIN) {
    headers["x-domain"] = env.BUSINESS_KORO_DOMAIN;
  }
  return headers;
}

async function getCatalog(env) {
  const response = await fetch(`${API_BASE}/products`, {
    headers: apiHeaders(env)
  });
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("Business Koro returned an unreadable response.");
  }
  if (!response.ok) {
    throw new Error(data?.message || "Could not load products.");
  }
  return {
    products: Array.isArray(data?.data) ? data.data : [],
    deliveryCharges: data?.deliveryCharges || {}
  };
}

function requireDB(env) {
  if (!env.DB) throw new Error("D1 database binding DB is missing.");
}

async function getSettings(env) {
  requireDB(env);
  const result = await env.DB.prepare(
    "SELECT product_id, selling_price, original_price, category, is_visible FROM product_settings"
  ).all();
  return new Map((result.results || []).map(row => [String(row.product_id), row]));
}
function publicProduct(p, setting) {
  return {
    id: p.id,
    name: p.name,
    description: p.description || "",
    images: Array.isArray(p.images) ? p.images : [],
    inStock: p.inStock,
    variants: Array.isArray(p.variants)
      ? p.variants.map(v => ({
          color: v.color || "",
          size: v.size || "",
          inStock: v.inStock
        }))
      : [],
    sellingPrice: setting ? Number(setting.selling_price) : null,
    category: setting?.category || "",
    isVisible: setting ? Number(setting.is_visible) === 1 : true
  };
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signSession(expiry, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(String(expiry))
  );
  return `${expiry}.${base64url(new Uint8Array(signature))}`;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/(?:^|;\s*)rs_admin=([^;]+)/);
  if (!match) return false;

  const parts = match[1].split(".");
  if (parts.length !== 2) return false;

  const expiry = Number(parts[0]);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;

  const expected = await signSession(expiry, env.ADMIN_PASSWORD);
  return expected === match[1];
}

async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) {
    return json({ error: "Admin password is not configured." }, 500);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "সঠিক পাসওয়ার্ড দিন।" }, 400);
  }

  if (body.password !== env.ADMIN_PASSWORD) {
    return json({ error: "পাসওয়ার্ড সঠিক নয়।" }, 401);
  }

  const expiry = Date.now() + 8 * 60 * 60 * 1000;
  const token = await signSession(expiry, env.ADMIN_PASSWORD);

  return json(
    { success: true, message: "Login successful." },
    200,
    {
      "Set-Cookie": `rs_admin=${token}; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=28800`
    }
  );
}

async function adminLogout() {
  return json(
    { success: true },
    200,
    {
      "Set-Cookie": "rs_admin=; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=0"
    }
  );
}

async function publicProducts(env) {
  const catalog = await getCatalog(env);
  const settings = await getSettings(env);

  const products = catalog.products
    .map(p => publicProduct(p, settings.get(String(p.id))))
    .filter(p => p.isVisible);

  return json({
    data: products,
    deliveryCharges: catalog.deliveryCharges
  });
}

async function adminProducts(env) {
  const catalog = await getCatalog(env);
  const settings = await getSettings(env);

  const products = catalog.products.map(p => ({
    ...publicProduct(p, settings.get(String(p.id))),
    suggestedPrice: p.suggestedPrice
  }));

  return json({ data: products });
}

async function saveProductSettings(request, env, productId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "সঠিক তথ্য পাঠান।" }, 400);
  }

  const price = Number(body.sellingPrice);
  if (!Number.isSafeInteger(price) || price < 0) {
    return json({ error: "বিক্রয়মূল্য সঠিকভাবে লিখুন।" }, 400);
  }

  const category = String(body.category || "").trim().slice(0, 100);
  const isVisible = body.isVisible === false ? 0 : 1;

  await env.DB.prepare(`
    INSERT INTO product_settings
      (product_id, selling_price, category, is_visible, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(product_id) DO UPDATE SET
      selling_price = excluded.selling_price,
      category = excluded.category,
      is_visible = excluded.is_visible,
      updated_at = CURRENT_TIMESTAMP
  `).bind(String(productId), price, category, isVisible).run();

  return json({ success: true, message: "পণ্যের সেটিংস সংরক্ষণ হয়েছে।" });
}

async function createOrder(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "অর্ডারের তথ্য সঠিকভাবে পাওয়া যায়নি।" }, 400);
  }

  const required = [
    "productId", "customerName", "customerPhone", "customerAddress",
    "customerDivision", "customerDistrict", "customerArea"
  ];

  for (const key of required) {
    if (body[key] === undefined || String(body[key]).trim() === "") {
      return json({ error: `অনুগ্রহ করে ${key} পূরণ করুন।` }, 400);
    }
  }

  const quantity = Number(body.quantity || 1);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
    return json({ error: "পরিমাণ ১ থেকে ২০-এর মধ্যে হতে হবে।" }, 400);
  }

  const catalog = await getCatalog(env);
  const product = catalog.products.find(
    p => String(p.id) === String(body.productId)
  );

  if (!product) return json({ error: "পণ্যটি পাওয়া যায়নি।" }, 404);
  if (product.inStock === false) {
    return json({ error: "দুঃখিত, পণ্যটি স্টকে নেই।" }, 409);
  }

  const settings = await env.DB.prepare(
    "SELECT selling_price, is_visible FROM product_settings WHERE product_id = ?"
  ).bind(String(product.id)).first();

  if (!settings || Number(settings.is_visible) !== 1) {
    return json({ error: "এই পণ্যটি বর্তমানে অর্ডার করা যাচ্ছে না।" }, 400);
  }

  const variants = Array.isArray(product.variants) ? product.variants : [];
  let selectedVariant = null;

  if (variants.length) {
    const colorRequired = variants.some(v => v.color);
    const sizeRequired = variants.some(v => v.size);

    if (colorRequired && !body.color) {
      return json({ error: "পণ্যের রং নির্বাচন করুন।" }, 400);
    }
    if (sizeRequired && !body.size) {
      return json({ error: "পণ্যের সাইজ নির্বাচন করুন।" }, 400);
    }

    selectedVariant = variants.find(v =>
      (!v.color || String(v.color) === String(body.color || "")) &&
      (!v.size || String(v.size) === String(body.size || ""))
    );

    if (!selectedVariant || selectedVariant.inStock === false) {
      return json({ error: "নির্বাচিত রং বা সাইজ স্টকে নেই।" }, 409);
    }
  }

  const unitPrice = Number(settings.selling_price);
  const division = String(body.customerDivision).trim().toLowerCase();
  const isDhaka = division === "dhaka" || division === "ঢাকা";
  const deliveryCharge = Number(
    isDhaka
      ? catalog.deliveryCharges.insideDhaka || 0
      : catalog.deliveryCharges.outsideDhaka || 0
  );

  const totalAmount = unitPrice * quantity + deliveryCharge;
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) {
    return json({ error: "অর্ডারের মোট মূল্য সঠিক নয়।" }, 400);
  }

  const orderId = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO orders (
      id, product_id, product_name, customer_name, customer_phone,
      customer_division, customer_district, customer_area, customer_address,
      color, size, quantity, unit_price, delivery_charge, total_amount, note
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    orderId,
    String(product.id),
    String(product.name || ""),
    String(body.customerName).trim().slice(0, 100),
    String(body.customerPhone).trim().slice(0, 20),
    String(body.customerDivision).trim().slice(0, 100),
    String(body.customerDistrict).trim().slice(0, 100),
    String(body.customerArea).trim().slice(0, 150),
    String(body.customerAddress).trim().slice(0, 500),
    String(body.color || "").trim().slice(0, 60),
    String(body.size || "").trim().slice(0, 60),
    quantity,
    unitPrice,
    deliveryCharge,
    totalAmount,
    String(body.customerNote || "").trim().slice(0, 500)
  ).run();

  return json({
    success: true,
    orderId,
    message: "আপনার অর্ডার RS Mart-এ জমা হয়েছে।"
  }, 201);
}

async function adminOrders(env) {
  const result = await env.DB.prepare(
    "SELECT * FROM orders ORDER BY created_at DESC LIMIT 200"
  ).all();
  return json({ data: result.results || [] });
}

async function updateOrderStatus(request, env, orderId) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "সঠিক তথ্য পাঠান।" }, 400);
  }

  const allowed = ["new", "confirmed", "shipped", "delivered", "cancelled"];
  if (!allowed.includes(body.status)) {
    return json({ error: "অর্ডারের অবস্থা সঠিক নয়।" }, 400);
  }

  const result = await env.DB.prepare(
    "UPDATE orders SET status = ? WHERE id = ?"
  ).bind(body.status, orderId).run();

  if (!result.meta?.changes) {
    return json({ error: "অর্ডার পাওয়া যায়নি।" }, 404);
  }

  return json({ success: true });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/api/admin/login" && method === "POST") {
        return await adminLogin(request, env);
      }

      if (path === "/api/admin/logout" && method === "POST") {
        if (!(await isAdmin(request, env))) {
          return json({ error: "অনুমতি নেই।" }, 401);
        }
        return await adminLogout();
      }

      if (path.startsWith("/api/admin/")) {
        if (!(await isAdmin(request, env))) {
          return json({ error: "Admin login প্রয়োজন।" }, 401);
        }

        requireDB(env);

        if (path === "/api/admin/products" && method === "GET") {
          return await adminProducts(env);
        }

        if (path === "/api/admin/orders" && method === "GET") {
          return await adminOrders(env);
        }

        const productMatch = path.match(/^\/api\/admin\/products\/([^/]+)$/);
        if (productMatch && method === "PUT") {
          return await saveProductSettings(
            request, env, decodeURIComponent(productMatch[1])
          );
        }

        const orderMatch = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
        if (orderMatch && method === "PATCH") {
          return await updateOrderStatus(
            request, env, decodeURIComponent(orderMatch[1])
          );
        }

        return json({ error: "Admin API route not found." }, 404);
      }

      if (path === "/api/products" && method === "GET") {
        return await publicProducts(env);
      }

      if (path === "/api/orders" && method === "POST") {
        requireDB(env);
        return await createOrder(request, env);
      }

      if (path.startsWith("/api/")) {
        return json({ error: "API route not found." }, 404);
      }

      return env.ASSETS.fetch(request);
    } catch (error) {
      return json({ error: error?.message || "Server error." }, 500);
    }
  }
};
