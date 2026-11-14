
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

async function ensureOrderSchema(env) {
  requireDB(env);
  const productColumns = await env.DB.prepare("PRAGMA table_info(product_settings)").all();
  const productNames = new Set((productColumns.results || []).map(row => row.name));
  if (!productNames.has("discount_percent")) {
    try {
      await env.DB.prepare("ALTER TABLE product_settings ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0").run();
    } catch (error) {
      if (!/duplicate column/i.test(String(error?.message || error))) throw error;
    }
  }

  const orderColumns = await env.DB.prepare("PRAGMA table_info(orders)").all();
  const orderNames = new Set((orderColumns.results || []).map(row => row.name));
  const additions = [
    ["payment_method", "TEXT NOT NULL DEFAULT 'cod'"],
    ["discount_percent", "INTEGER NOT NULL DEFAULT 0"],
    ["discount_amount", "INTEGER NOT NULL DEFAULT 0"],
    ["advance_payment_amount", "INTEGER NOT NULL DEFAULT 0"],
    ["transaction_id", "TEXT"],
    ["transaction_id_format_valid", "INTEGER NOT NULL DEFAULT 0"],
    ["payment_verification_status", "TEXT NOT NULL DEFAULT 'not_required'"]
  ];
  for (const [name, definition] of additions) {
    if (!orderNames.has(name)) {
      try {
        await env.DB.prepare(`ALTER TABLE orders ADD COLUMN ${name} ${definition}`).run();
      } catch (error) {
        if (!/duplicate column/i.test(String(error?.message || error))) throw error;
      }
    }
  }
}

async function getSettings(env) {
  await ensureOrderSchema(env);
  const result = await env.DB.prepare(
    "SELECT product_id, selling_price, original_price, category, is_visible, discount_percent FROM product_settings"
  ).all();
  return new Map((result.results || []).map(row => [String(row.product_id), row]));
}
function publicProduct(p, setting) {
  return {
    id: p.id,
    name: p.name,
    description: p.description || "",
    images: Array.isArray(p.images) ? p.images : (Array.isArray(p.imageUrls) ? p.imageUrls : (p.image || p.imageUrl || p.thumbnailUrl ? [p.image || p.imageUrl || p.thumbnailUrl] : [])),
    inStock: p.inStock,
    variants: Array.isArray(p.variants)
      ? p.variants.map(v => ({
          color: v.color || "",
          size: v.size || "",
          inStock: v.inStock
        }))
      : [],
    sellingPrice: setting ? Number(setting.selling_price) : null,
    originalPrice: setting?.original_price != null
  ? Number(setting.original_price)
  : null,
    category: setting?.category || "",
    isVisible: setting ? Number(setting.is_visible) === 1 : true,
    discountPercent: Number(setting?.discount_percent || 0)
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

  await ensureOrderSchema(env);
  const price = Number(body.sellingPrice);
  if (!Number.isSafeInteger(price) || price < 0) {
    return json({ error: "বিক্রয়মূল্য সঠিকভাবে লিখুন।" }, 400);
  }

  const originalPrice = body.originalPrice == null || body.originalPrice === ""
    ? null
    : Number(body.originalPrice);
  if (originalPrice !== null && (!Number.isSafeInteger(originalPrice) || originalPrice < 0)) {
    return json({ error: "পুরোনো দাম সঠিকভাবে লিখুন।" }, 400);
  }

  const discountPercent = Number(body.discountPercent ?? 0);
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 90) {
    return json({ error: "অগ্রিম পেমেন্ট ছাড় ০ থেকে ৯০ শতাংশের মধ্যে দিন।" }, 400);
  }
  const category = String(body.category || "").trim().slice(0, 100);
  const isVisible = body.isVisible === false ? 0 : 1;

  await env.DB.prepare(`
    INSERT INTO product_settings
      (product_id, selling_price, original_price, category, is_visible, discount_percent, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(product_id) DO UPDATE SET
      selling_price = excluded.selling_price,
      original_price = excluded.original_price,
      category = excluded.category,
      is_visible = excluded.is_visible,
      discount_percent = excluded.discount_percent,
      updated_at = CURRENT_TIMESTAMP
  `).bind(String(productId), price, originalPrice, category, isVisible, discountPercent).run();

  return json({ success: true, message: "পণ্যের সেটিংস সংরক্ষণ হয়েছে।" });
}

async function createOrder(request, env) {
  await ensureOrderSchema(env);
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
    "SELECT selling_price, is_visible, discount_percent FROM product_settings WHERE product_id = ?"
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

  const subtotal = unitPrice * quantity;
  const paymentMethod = body.paymentMethod === "advance" ? "advance" : "cod";
  const discountPercent = paymentMethod === "advance" ? Number(settings.discount_percent || 0) : 0;
  const discountAmount = Math.round(subtotal * discountPercent / 100);
  const totalAmount = subtotal + deliveryCharge - discountAmount;
  const advancePaymentAmount = paymentMethod === "advance" ? deliveryCharge : 0;
  const transactionId = String(body.transactionId || "").trim().toUpperCase();
  const transactionIdFormatValid = paymentMethod === "advance" && /^[A-Z0-9]{10}$/.test(transactionId);
  if (paymentMethod === "advance" && !transactionIdFormatValid) {
    return json({ error: "বিকাশ Transaction ID সঠিক ফরম্যাটে দিন (১০ অক্ষরের আলফানিউমেরিক আইডি)।" }, 400);
  }
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) {
    return json({ error: "অর্ডারের মোট মূল্য সঠিক নয়।" }, 400);
  }

  const orderId = crypto.randomUUID();

  await env.DB.prepare(`
    INSERT INTO orders (
      id, product_id, product_name, customer_name, customer_phone,
      customer_division, customer_district, customer_area, customer_address,
      color, size, quantity, unit_price, delivery_charge, total_amount, note,
      payment_method, discount_percent, discount_amount, advance_payment_amount,
      transaction_id, transaction_id_format_valid, payment_verification_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    String(body.customerNote || "").trim().slice(0, 500),
    paymentMethod,
    discountPercent,
    discountAmount,
    advancePaymentAmount,
    paymentMethod === "advance" ? transactionId : null,
    transactionIdFormatValid ? 1 : 0,
    paymentMethod === "advance" ? "pending_manual" : "not_required"
  ).run();

  return json({
    success: true,
    orderId,
    message: "আপনার অর্ডার RS Mart-এ জমা হয়েছে। আমাদের প্রতিনিধি ফোন করে অর্ডার নিশ্চিত করবেন।"
  }, 201);
}

async function adminOrders(env) {
  await ensureOrderSchema(env);
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
  const paymentAllowed = ["pending_manual", "verified", "rejected"];
  if (body.status !== undefined && !allowed.includes(body.status)) {
    return json({ error: "অর্ডারের অবস্থা সঠিক নয়।" }, 400);
  }
  if (body.paymentVerificationStatus !== undefined && !paymentAllowed.includes(body.paymentVerificationStatus)) {
    return json({ error: "পেমেন্ট যাচাইয়ের অবস্থা সঠিক নয়।" }, 400);
  }
  if (body.status === undefined && body.paymentVerificationStatus === undefined) {
    return json({ error: "কোনো পরিবর্তন পাওয়া যায়নি।" }, 400);
  }

  const result = body.paymentVerificationStatus !== undefined
    ? await env.DB.prepare("UPDATE orders SET payment_verification_status = ? WHERE id = ?")
        .bind(body.paymentVerificationStatus, orderId).run()
    : await env.DB.prepare("UPDATE orders SET status = ? WHERE id = ?")
        .bind(body.status, orderId).run();

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
