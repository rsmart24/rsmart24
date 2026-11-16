
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

function isOutOfStock(product) {
  if (!product || typeof product !== "object") return false;
  const normalize = value => String(value ?? "").trim().toLowerCase().replace(/[\\s-]+/g, "_");
  const status = normalize(product.stockStatus ?? product.stock_status ?? product.availability ?? product.status);
  const stock = product.inStock ?? product.in_stock ?? product.available;
  const stockText = normalize(stock);
  return stock === false || stock === 0 || stock === "0" || stockText === "false" ||
    ["out_of_stock", "sold_out", "outofstock", "unavailable"].includes(status) ||
    ["out_of_stock", "sold_out", "outofstock", "unavailable"].includes(stockText);
}

async function getCatalog(env) {
  const headers = apiHeaders(env);
  const allProducts = [];
  const seen = new Set();
  let deliveryCharges = {};
  let expectedLastPage = 1;
  const maxPages = 100;

  for (let page = 1; page <= maxPages; page++) {
    const url = new URL(`${API_BASE}/products`);
    if (page > 1) url.searchParams.set("page", String(page));
    const response = await fetch(url.toString(), { headers });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error("Business Koro returned an unreadable response."); }
    if (!response.ok) {
      if (page > 1 && allProducts.length) break;
      throw new Error(data?.message || "Could not load products.");
    }

    const pageProducts = Array.isArray(data?.data) ? data.data
      : Array.isArray(data?.products) ? data.products : [];
    if (page === 1) {
      deliveryCharges = data?.deliveryCharges || data?.delivery_charges || {};
      const last = Number(data?.meta?.last_page ?? data?.pagination?.last_page ?? data?.last_page ?? 0);
      if (Number.isInteger(last) && last > 0) expectedLastPage = Math.min(last, maxPages);
    }
    let added = 0;
    for (const product of pageProducts) {
      const key = String(product?.id ?? product?.productId ?? "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      allProducts.push(product);
      added++;
    }
    if (!pageProducts.length || (page > 1 && added === 0)) break;
    const last = Number(data?.meta?.last_page ?? data?.pagination?.last_page ?? data?.last_page ?? 0);
    const hasNext = Boolean(data?.links?.next ?? data?.pagination?.next_page_url ?? data?.next_page_url);
    if (last > 0) expectedLastPage = Math.min(last, maxPages);
    if (page >= expectedLastPage && !hasNext) break;
    if (page === 1 && expectedLastPage === 1 && !hasNext && pageProducts.length < 20) break;
  }
  return { products: allProducts, deliveryCharges };
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

  for (const [name, definition] of [["media_url", "TEXT"], ["media_enabled", "INTEGER NOT NULL DEFAULT 1"]]) {
    if (!productNames.has(name)) {
      try { await env.DB.prepare(`ALTER TABLE product_settings ADD COLUMN ${name} ${definition}`).run(); }
      catch (error) { if (!/duplicate column/i.test(String(error?.message || error))) throw error; }
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
    ["payment_verification_status", "TEXT NOT NULL DEFAULT 'not_required'"],
    ["order_items_json", "TEXT"]
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
    "SELECT product_id, selling_price, original_price, category, is_visible, discount_percent, media_url, media_enabled FROM product_settings"
  ).all();
  return new Map((result.results || []).map(row => [String(row.product_id), row]));
}
function publicProduct(p, setting) {
  return {
    id: p.id,
    name: p.name,
    description: p.description || "",
    images: Array.isArray(p.images) && p.images.length ? p.images : (Array.isArray(p.imageUrls) && p.imageUrls.length ? p.imageUrls : (p.image || p.imageUrl || p.thumbnailUrl ? [p.image || p.imageUrl || p.thumbnailUrl] : [])),
    inStock: isOutOfStock(p) ? false : (p.inStock ?? p.in_stock ?? p.available),
    stockStatus: isOutOfStock(p) ? "out_of_stock" : (p.stockStatus || p.stock_status || "in_stock"),
    variants: Array.isArray(p.variants)
      ? p.variants.map(v => ({
          color: v.color || "",
          size: v.size || "",
          inStock: isOutOfStock(v) ? false : (v.inStock ?? v.in_stock ?? v.available)
        }))
      : [],
    sellingPrice: setting ? Number(setting.selling_price) : null,
    originalPrice: setting?.original_price != null
  ? Number(setting.original_price)
  : null,
    category: setting?.category || "",
    isVisible: setting ? Number(setting.is_visible) === 1 : true,
    discountPercent: Number(setting?.discount_percent || 0),
    mediaUrl: setting?.media_url || "",
    mediaEnabled: setting ? Number(setting.media_enabled) === 1 : true
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

  return json({ data: products, deliveryCharges: catalog.deliveryCharges });
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
  const mediaUrl = String(body.mediaUrl || "").trim().slice(0, 2000);
  if (mediaUrl) {
    try { const parsed = new URL(mediaUrl); if (parsed.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(parsed.hostname)) return json({ error: "Google Drive-এর HTTPS লিংক দিন।" }, 400); }
    catch { return json({ error: "Google Drive-এর সঠিক লিংক দিন।" }, 400); }
  }
  const mediaEnabled = body.mediaEnabled === false ? 0 : 1;
  await env.DB.prepare(`
    INSERT INTO product_settings (product_id, selling_price, original_price, category, is_visible, discount_percent, media_url, media_enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(product_id) DO UPDATE SET
      selling_price = excluded.selling_price, original_price = excluded.original_price,
      category = excluded.category, is_visible = excluded.is_visible,
      discount_percent = excluded.discount_percent, media_url = excluded.media_url,
      media_enabled = excluded.media_enabled, updated_at = CURRENT_TIMESTAMP
  `).bind(String(productId), price, originalPrice, category, isVisible, discountPercent, mediaUrl || null, mediaEnabled).run();

  return json({ success: true, message: "পণ্যের সেটিংস সংরক্ষণ হয়েছে।" });
}

function escapeTelegramHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramOrderAlert(env, order) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_GROUP_ID) return;
  const itemsText = order.items.map((item, index) =>
    `${index + 1}. ${escapeTelegramHtml(item.name)} × ${item.quantity} — ৳${item.subtotal}${item.color ? ` | রং: ${escapeTelegramHtml(item.color)}` : ""}${item.size ? ` | সাইজ: ${escapeTelegramHtml(item.size)}` : ""}`
  ).join("\n");
  const message = [
    "🛍️ <b>RS Mart — নতুন অর্ডার!</b>",
    `অর্ডার ID: <code>${escapeTelegramHtml(order.id)}</code>`,
    "",
    "<b>পণ্য:</b>",
    itemsText,
    "",
    `👤 নাম: ${escapeTelegramHtml(order.name)}`,
    `📞 ফোন: ${escapeTelegramHtml(order.phone)}`,
    `📍 ঠিকানা: ${escapeTelegramHtml([order.area, order.district, order.division, order.address].filter(Boolean).join(", "))}`,
    `💳 পেমেন্ট: ${order.paymentMethod === "advance" ? "অগ্রিম" : "ক্যাশ অন ডেলিভারি"}`,
    `🚚 ডেলিভারি চার্জ: ৳${order.deliveryCharge}`,
    `💰 মোট: ৳${order.totalAmount}`,
    order.note ? `📝 নোট: ${escapeTelegramHtml(order.note)}` : ""
  ].filter(Boolean).join("\n");
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_GROUP_ID,
        text: message.slice(0, 4000),
        parse_mode: "HTML",
        disable_web_page_preview: true
      })
    });
    if (!response.ok) {
      console.error("Telegram order alert failed with HTTP status:", response.status);
    }
  } catch (error) {
    console.error("Telegram order alert request failed:", error?.message || "Unknown error");
  }
}

async function createOrder(request, env) {
  await ensureOrderSchema(env);
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "অর্ডারের তথ্য সঠিকভাবে পাওয়া যায়নি।" }, 400); }
  const required = ["customerName","customerPhone","customerAddress","customerDivision","customerDistrict","customerArea"];
  for (const key of required) {
    if (body[key] === undefined || String(body[key]).trim() === "") return json({ error: "অনুগ্রহ করে " + key + " পূরণ করুন।" }, 400);
  }
  const requestedItems = Array.isArray(body.items) && body.items.length ? body.items : [{ id: body.productId, quantity: body.quantity || 1, color: body.color || "", size: body.size || "" }];
  if (requestedItems.length > 20) return json({error:"এক অর্ডারে সর্বোচ্চ ২০ ধরনের পণ্য যোগ করতে পারবেন।"},400);
  const catalog = await getCatalog(env);
  const orderItems = [];
  let subtotal = 0, totalDiscount = 0, totalQuantity = 0;
  for (const item of requestedItems) {
    const productId = item.id ?? item.productId;
    const quantity = Number(item.quantity || 1);
    if (!productId || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) return json({error:"প্রতিটি পণ্যের পরিমাণ ১ থেকে ২০-এর মধ্যে হতে হবে।"},400);
    const product = catalog.products.find(p => String(p.id) === String(productId));
    if (!product || isOutOfStock(product)) return json({error:"কার্টের একটি পণ্য পাওয়া যাচ্ছে না বা স্টকে নেই।"},409);
    const settings = await env.DB.prepare("SELECT selling_price,is_visible,discount_percent FROM product_settings WHERE product_id = ?").bind(String(product.id)).first();
    if (!settings || Number(settings.is_visible) !== 1) return json({error:"পণ্যটি বর্তমানে অর্ডার করা যাচ্ছে না: " + product.name},400);
    const variants = Array.isArray(product.variants) ? product.variants : [];
    const color = String(item.color || "").trim(), size = String(item.size || "").trim();
    if (variants.length) {
      if (variants.some(v => v.color) && !color) return json({error:product.name + ": রং নির্বাচন করুন।"},400);
      if (variants.some(v => v.size) && !size) return json({error:product.name + ": সাইজ নির্বাচন করুন।"},400);
      const selected = variants.find(v => (!v.color || String(v.color) === color) && (!v.size || String(v.size) === size));
      if (!selected || isOutOfStock(selected)) return json({error:product.name + ": নির্বাচিত ভ্যারিয়েন্ট স্টকে নেই।"},409);
    }
    const unitPrice = Number(settings.selling_price);
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) return json({error:"একটি পণ্যের দাম সঠিক নয়।"},400);
    const lineSubtotal = unitPrice * quantity;
    const discountPercent = body.paymentMethod === "advance" ? Number(settings.discount_percent || 0) : 0;
    const discountAmount = Math.round(lineSubtotal * discountPercent / 100);
    subtotal += lineSubtotal; totalDiscount += discountAmount; totalQuantity += quantity;
    orderItems.push({id:String(product.id),name:String(product.name || ""),quantity,unitPrice,color,size,subtotal:lineSubtotal,discountPercent,discountAmount});
  }
  const division = String(body.customerDivision).trim().toLowerCase();
  const isDhaka = division === "dhaka" || division === "ঢাকা";
  const deliveryCharge = Number(isDhaka ? catalog.deliveryCharges.insideDhaka || 0 : catalog.deliveryCharges.outsideDhaka || 0);
  const paymentMethod = body.paymentMethod === "advance" ? "advance" : "cod";
  const totalAmount = subtotal + deliveryCharge - totalDiscount;
  const advancePaymentAmount = paymentMethod === "advance" ? deliveryCharge : 0;
  const transactionId = String(body.transactionId || "").trim().toUpperCase();
  const transactionIdFormatValid = paymentMethod === "advance" && /^[A-Z0-9]{8,12}$/.test(transactionId);
  if (paymentMethod === "advance" && !transactionIdFormatValid) return json({error:"বিকাশ Transaction ID সঠিক ফরম্যাটে দিন (৮–১২ অক্ষরের আলফানিউমেরিক আইডি)।"},400);
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) return json({error:"অর্ডারের মোট মূল্য সঠিক নয়।"},400);
  const orderId = crypto.randomUUID();
  const first = orderItems[0];
  const productName = orderItems.length === 1 ? first.name : "একাধিক পণ্য (" + orderItems.length + " ধরনের)";
  const effectiveDiscountPercent = subtotal ? Math.round(totalDiscount * 100 / subtotal) : 0;
  await env.DB.prepare(
    "INSERT INTO orders (id,product_id,product_name,customer_name,customer_phone,customer_division,customer_district,customer_area,customer_address,color,size,quantity,unit_price,delivery_charge,total_amount,note,payment_method,discount_percent,discount_amount,advance_payment_amount,transaction_id,transaction_id_format_valid,payment_verification_status,order_items_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(
    orderId,String(first.id),productName,
    String(body.customerName).trim().slice(0,100),String(body.customerPhone).trim().slice(0,20),
    String(body.customerDivision).trim().slice(0,100),String(body.customerDistrict).trim().slice(0,100),
    String(body.customerArea).trim().slice(0,150),String(body.customerAddress).trim().slice(0,500),
    orderItems.length===1?first.color:"",orderItems.length===1?first.size:"",
    totalQuantity,subtotal,deliveryCharge,totalAmount,String(body.customerNote||"").trim().slice(0,500),
    paymentMethod,effectiveDiscountPercent,totalDiscount,advancePaymentAmount,
    paymentMethod==="advance"?transactionId:null,transactionIdFormatValid?1:0,
    paymentMethod==="advance"?"pending_manual":"not_required",JSON.stringify(orderItems)
  ).run();
  await sendTelegramOrderAlert(env, {
    id: orderId,
    items: orderItems,
    name: String(body.customerName).trim().slice(0,100),
    phone: String(body.customerPhone).trim().slice(0,20),
    division: String(body.customerDivision).trim().slice(0,100),
    district: String(body.customerDistrict).trim().slice(0,100),
    area: String(body.customerArea).trim().slice(0,150),
    address: String(body.customerAddress).trim().slice(0,500),
    note: String(body.customerNote || "").trim().slice(0,500),
    paymentMethod,
    deliveryCharge,
    totalAmount
  });
  return json({success:true,orderId,message:"আপনার অর্ডার RS Mart-এ জমা হয়েছে। আমাদের প্রতিনিধি ফোন করে অর্ডার নিশ্চিত করবেন।"},201);
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

        if (path === "/api/admin/telegram-test" && method === "POST") {
          if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_GROUP_ID) {
            return json({ error: "Telegram Bot Token বা Chat ID সেট করা নেই।" }, 503);
          }
          try {
            const telegramResponse = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                chat_id: env.TELEGRAM_GROUP_ID,
                text: "✅ RS Mart Telegram Test\n\nআপনার Telegram Order Alert সংযোগ কাজ করছে। এটি শুধু পরীক্ষামূলক বার্তা—কোনো অর্ডার তৈরি হয়নি।"
              })
            });
            const telegramResult = await telegramResponse.json().catch(() => ({}));
            if (!telegramResponse.ok || !telegramResult.ok) {
              console.error("Telegram test message failed:", telegramResult.description || telegramResponse.status);
              return json({ error: "Telegram বার্তা পাঠানো যায়নি। Cloudflare Logs পরীক্ষা করুন।" }, 502);
            }
            return json({ success: true, message: "Telegram test message sent." });
          } catch (error) {
            console.error("Telegram test request failed:", error?.message || "Unknown error");
            return json({ error: "Telegram সার্ভারে সংযোগ করা যায়নি।" }, 502);
          }
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
