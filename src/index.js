
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
  const normalize = value => String(value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const status = normalize(product.stockStatus ?? product.stock_status ?? product.availability ?? product.status);
  const stock = product.inStock ?? product.in_stock ?? product.available;
  const stockText = normalize(stock);
  const unavailableStates = ["out_of_stock", "sold_out", "soldout", "outofstock", "unavailable", "not_available", "not_in_stock", "no_stock", "false", "0"];
  return stock === false || stock === 0 || stock === "0" || stockText === "false" ||
    unavailableStates.includes(status) || unavailableStates.includes(stockText);
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
  // Storefront delivery policy: Dhaka District ৳70; every other district ৳130.
  // Do not use Business Koro's division-level charges for customer checkout.
  return { products: allProducts, deliveryCharges: { insideDhaka: 70, outsideDhaka: 130 } };
}


function normalizeReviewPhone(value) {
  let phone = String(value || "")
    .replace(/[০-৯]/g, digit => "০১২৩৪৫৬৭৮৯".indexOf(digit))
    .replace(/[\s-]/g, "");
  if (phone.startsWith("+88")) phone = phone.slice(3);
  else if (phone.startsWith("88") && phone.length === 13) phone = phone.slice(2);
  return /^01[3-9]\d{8}$/.test(phone) ? phone : "";
}
async function reviewPhoneHash(phone) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("rs-mart-review:" + phone));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2,"0")).join("");
}
async function publicProductReviews(env, productId) {
  await ensureOrderSchema(env);
  const result = await env.DB.prepare("SELECT id, customer_name, rating, comment, created_at FROM product_reviews WHERE product_id = ? AND status = 'approved' ORDER BY created_at DESC, id DESC LIMIT 100").bind(productId).all();
  return json({ data: result.results || [] });
}
async function submitProductReview(request, env) {
  await ensureOrderSchema(env);
  let body;
  try { body = await request.json(); } catch { return json({error:"রিভিউয়ের তথ্য সঠিক নয়।"},400); }
  const productId = String(body?.productId || "").trim().slice(0,100);
  const name = String(body?.name || "").trim().replace(/\s+/g," ").slice(0,80);
  const phone = normalizeReviewPhone(body?.phone);
  const rating = Number(body?.rating);
  const comment = String(body?.comment || "").trim().slice(0,500);
  if (!productId || !name || !phone || !Number.isInteger(rating) || rating < 1 || rating > 5 || comment.length < 3) {
    return json({error:"নাম, সঠিক মোবাইল নম্বর, রেটিং ও কমপক্ষে ৩ অক্ষরের মন্তব্য দিন।"},400);
  }
  const hash = await reviewPhoneHash(phone);
  // Keep the existing UNIQUE(product_id, phone_hash) constraint and use two
  // deterministic slots per phone/product. This safely upgrades the limit
  // without rebuilding or deleting any existing review rows.
  for (let attempt = 0; attempt < 2; attempt++) {
    const existing = await env.DB.prepare(
      "SELECT COUNT(*) AS total FROM product_reviews WHERE product_id = ? AND phone_hash IN (?, ?)"
    ).bind(productId, hash, hash + ":2").first();
    const count = Number(existing?.total || 0);
    if (count >= 2) {
      return json({error:"এই নম্বর দিয়ে এই পণ্যে সর্বোচ্চ ২টি রিভিউ দেওয়া যাবে।"},409);
    }
    const storedHash = count === 0 ? hash : hash + ":2";
    try {
      await env.DB.prepare("INSERT INTO product_reviews (product_id, customer_name, customer_phone, phone_hash, rating, comment, status) VALUES (?,?,?,?,?,?,'pending')").bind(productId,name,phone,storedHash,rating,comment).run();
      return json({success:true,message:"আপনার রিভিউ জমা হয়েছে। অনুমোদনের পর প্রকাশ করা হবে।"},201);
    } catch (error) {
      if (/unique/i.test(String(error?.message || error))) {
        // A simultaneous submission may have taken this slot; recount once.
        if (attempt === 0) continue;
        const latest = await env.DB.prepare(
          "SELECT COUNT(*) AS total FROM product_reviews WHERE product_id = ? AND phone_hash IN (?, ?)"
        ).bind(productId, hash, hash + ":2").first();
        if (Number(latest?.total || 0) >= 2) {
          return json({error:"এই নম্বর দিয়ে এই পণ্যে সর্বোচ্চ ২টি রিভিউ দেওয়া যাবে।"},409);
        }
      }
      throw error;
    }
  }
  return json({error:"রিভিউ জমা দেওয়া যায়নি। আবার চেষ্টা করুন।"},409);
}
async function adminProductReviews(env, url) {
  await ensureOrderSchema(env);
  const status = ["pending","approved","rejected","all"].includes(url.searchParams.get("status")) ? url.searchParams.get("status") : "pending";
  const result = await env.DB.prepare("SELECT id, product_id, customer_name, customer_phone, rating, comment, status, created_at FROM product_reviews " + (status === "all" ? "" : "WHERE status = ? ") + "ORDER BY created_at DESC, id DESC LIMIT 300").bind(...(status === "all" ? [] : [status])).all();
  return json({data:result.results || []});
}
async function updateProductReview(request, env, reviewId) {
  let body; try { body = await request.json(); } catch { return json({error:"সঠিক তথ্য দিন।"},400); }
  const status = String(body?.status || "");
  if (!["approved","rejected","pending"].includes(status)) return json({error:"রিভিউয়ের অবস্থা সঠিক নয়।"},400);
  const result = await env.DB.prepare("UPDATE product_reviews SET status = ? WHERE id = ?").bind(status,reviewId).run();
  return result.meta?.changes ? json({success:true}) : json({error:"রিভিউ পাওয়া যায়নি।"},404);
}
async function deleteProductReview(env, reviewId) {
  const result = await env.DB.prepare("DELETE FROM product_reviews WHERE id = ?").bind(reviewId).run();
  return result.meta?.changes ? json({success:true}) : json({error:"রিভিউ পাওয়া যায়নি।"},404);
}

function requireDB(env) {
  if (!env.DB) throw new Error("D1 database binding DB is missing.");
}

async function enforcePublicOrderRateLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("rs-mart-public-order:" + ip));
  const ipHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const state = await env.DB.prepare(`
    INSERT INTO public_order_rate_limits (ip_hash, request_count, window_started_at, blocked_until)
    VALUES (?, 1, ?, 0)
    ON CONFLICT(ip_hash) DO UPDATE SET
      request_count = CASE
        WHEN public_order_rate_limits.blocked_until > excluded.window_started_at THEN public_order_rate_limits.request_count
        WHEN excluded.window_started_at - public_order_rate_limits.window_started_at >= 600000 THEN 1
        ELSE public_order_rate_limits.request_count + 1
      END,
      window_started_at = CASE
        WHEN public_order_rate_limits.blocked_until > excluded.window_started_at THEN public_order_rate_limits.window_started_at
        WHEN excluded.window_started_at - public_order_rate_limits.window_started_at >= 600000 THEN excluded.window_started_at
        ELSE public_order_rate_limits.window_started_at
      END
    RETURNING request_count, blocked_until
  `).bind(ipHash, now).first();
  const blockedUntil = Number(state?.blocked_until || 0);
  if (blockedUntil > now) {
    const retrySeconds = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
    return json({ error: "অল্প সময়ে অনেকগুলো অর্ডার পাঠানো হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।" }, 429, { "Retry-After": String(retrySeconds) });
  }
  if (Number(state?.request_count || 0) >= 41) {
    const retrySeconds = 5 * 60;
    await env.DB.prepare("UPDATE public_order_rate_limits SET blocked_until = ? WHERE ip_hash = ?").bind(now + retrySeconds * 1000, ipHash).run();
    return json({ error: "একই নেটওয়ার্ক থেকে অনেকগুলো অর্ডার পাঠানো হয়েছে। ৫ মিনিট পর আবার চেষ্টা করুন।" }, 429, { "Retry-After": String(retrySeconds) });
  }
  return null;
}

async function enforcePhoneOrderRateLimit(phone, env) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("rs-mart-order-phone:" + phone));
  const phoneHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  await env.DB.prepare("DELETE FROM public_order_phone_limits WHERE window_started_at < ? AND blocked_until < ?").bind(now - 86400000, now).run();
  const state = await env.DB.prepare(`
    INSERT INTO public_order_phone_limits (phone_hash, request_count, window_started_at, blocked_until) VALUES (?, 1, ?, 0)
    ON CONFLICT(phone_hash) DO UPDATE SET
      request_count = CASE WHEN public_order_phone_limits.blocked_until > excluded.window_started_at THEN public_order_phone_limits.request_count WHEN excluded.window_started_at - public_order_phone_limits.window_started_at >= 600000 THEN 1 ELSE public_order_phone_limits.request_count + 1 END,
      window_started_at = CASE WHEN public_order_phone_limits.blocked_until > excluded.window_started_at THEN public_order_phone_limits.window_started_at WHEN excluded.window_started_at - public_order_phone_limits.window_started_at >= 600000 THEN excluded.window_started_at ELSE public_order_phone_limits.window_started_at END
    RETURNING request_count, blocked_until
  `).bind(phoneHash, now).first();
  const blockedUntil = Number(state?.blocked_until || 0);
  if (blockedUntil > now) return json({ error: "এই মোবাইল নম্বর থেকে অল্প সময়ে অনেকগুলো অর্ডার এসেছে। কিছুক্ষণ পর আবার চেষ্টা করুন।" }, 429, { "Retry-After": String(Math.ceil((blockedUntil-now)/1000)) });
  if (Number(state?.request_count || 0) >= 5) {
    await env.DB.prepare("UPDATE public_order_phone_limits SET blocked_until = ? WHERE phone_hash = ?").bind(now + 900000, phoneHash).run();
    return json({ error: "এই নম্বর দিয়ে ১০ মিনিটে সর্বোচ্চ ৪টি অর্ডার করা যাবে। ১৫ মিনিট পর আবার চেষ্টা করুন।" }, 429, { "Retry-After": "900" });
  }
  return null;
}

async function ensureOrderSchema(env) {
  requireDB(env);
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS admin_login_attempts (ip_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, window_started_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS public_order_rate_limits (ip_hash TEXT PRIMARY KEY, request_count INTEGER NOT NULL DEFAULT 0, window_started_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0)").run();
  const productColumns = await env.DB.prepare("PRAGMA table_info(product_settings)").all();
  const productNames = new Set((productColumns.results || []).map(row => row.name));
  if (!productNames.has("discount_percent")) {
    try {
      await env.DB.prepare("ALTER TABLE product_settings ADD COLUMN discount_percent INTEGER NOT NULL DEFAULT 0").run();
    } catch (error) {
      if (!/duplicate column/i.test(String(error?.message || error))) throw error;
    }
  }

  for (const [name, definition] of [["media_url", "TEXT"], ["media_enabled", "INTEGER NOT NULL DEFAULT 1"], ["is_trending", "INTEGER NOT NULL DEFAULT 0"]]) {
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
    ["order_items_json", "TEXT"],
    ["business_koro_status", "TEXT NOT NULL DEFAULT 'not_sent'"],
    ["business_koro_order_id", "TEXT"],
    ["business_koro_response", "TEXT"],
    ["business_koro_sent_at", "TEXT"],
    ["business_koro_live_status", "TEXT"],
    ["business_koro_status_checked_at", "TEXT"],
    ["submission_key", "TEXT"],
    ["archived_at", "TEXT"]
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
  await env.DB.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_submission_key ON orders(submission_key)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS public_order_phone_limits (phone_hash TEXT PRIMARY KEY, request_count INTEGER NOT NULL DEFAULT 0, window_started_at INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS dhamaaka_offer_settings (id INTEGER PRIMARY KEY CHECK (id = 1), product_id TEXT, discount_percent INTEGER NOT NULL DEFAULT 30, enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT CURRENT_TIMESTAMP)").run();
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS product_reviews (id INTEGER PRIMARY KEY AUTOINCREMENT, product_id TEXT NOT NULL, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, phone_hash TEXT NOT NULL, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), comment TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(product_id, phone_hash))").run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_product_reviews_public ON product_reviews(product_id, status, created_at DESC)").run();
}

async function getSettings(env) {
  await ensureOrderSchema(env);
  const result = await env.DB.prepare(
    "SELECT product_id, selling_price, original_price, category, is_visible, discount_percent, media_url, media_enabled, is_trending FROM product_settings"
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
    mediaEnabled: setting ? Number(setting.media_enabled) === 1 : true,
    isTrending: Number(setting?.is_trending || 0) === 1
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
  if (!env.ADMIN_PASSWORD) return json({ error: "Admin password is not configured." }, 500);
  await ensureOrderSchema(env);
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(env.ADMIN_PASSWORD + ":" + ip));
  const ipHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  const now = Date.now();
  const attempt = await env.DB.prepare("SELECT attempts, window_started_at, blocked_until FROM admin_login_attempts WHERE ip_hash = ?").bind(ipHash).first();
  if (Number(attempt?.blocked_until || 0) > now) {
    const retrySeconds = Math.max(1, Math.ceil((Number(attempt.blocked_until) - now) / 1000));
    return json({ error: "অনেকবার ভুল পাসওয়ার্ড দেওয়া হয়েছে। কিছুক্ষণ পর আবার চেষ্টা করুন।" }, 429, { "Retry-After": String(retrySeconds) });
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: "সঠিক পাসওয়ার্ড দিন।" }, 400); }
  if (body.password !== env.ADMIN_PASSWORD) {
    const sameWindow = attempt && now - Number(attempt.window_started_at || 0) < 15 * 60 * 1000;
    const attempts = sameWindow ? Number(attempt.attempts || 0) + 1 : 1;
    const windowStartedAt = sameWindow ? Number(attempt.window_started_at) : now;
    const blockedUntil = attempts >= 5 ? now + 15 * 60 * 1000 : 0;
    await env.DB.prepare("INSERT INTO admin_login_attempts (ip_hash, attempts, window_started_at, blocked_until) VALUES (?, ?, ?, ?) ON CONFLICT(ip_hash) DO UPDATE SET attempts=excluded.attempts, window_started_at=excluded.window_started_at, blocked_until=excluded.blocked_until").bind(ipHash, attempts, windowStartedAt, blockedUntil).run();
    if (blockedUntil) return json({ error: "৫ বার ভুল পাসওয়ার্ড দেওয়া হয়েছে। ১৫ মিনিট পর আবার চেষ্টা করুন।" }, 429, { "Retry-After": "900" });
    return json({ error: "পাসওয়ার্ড সঠিক নয়।" }, 401);
  }
  await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip_hash = ?").bind(ipHash).run();
  const expiry = Date.now() + 8 * 60 * 60 * 1000;
  const token = await signSession(expiry, env.ADMIN_PASSWORD);
  return json({ success: true, message: "Login successful." }, 200, {
    "Set-Cookie": "rs_admin=" + token + "; HttpOnly; Secure; SameSite=Strict; Path=/api/admin; Max-Age=28800"
  });
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

function seoEscapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function seoAbsoluteImage(value, origin) {
  try {
    const url = new URL(String(value || ""), origin);
    return ["https:", "http:"].includes(url.protocol) ? url.href : "";
  } catch { return ""; }
}

function renderSeoProductPage(product, origin, relatedProducts = []) {
  const id = String(product.id);
  const name = String(product.name || "পণ্য").trim();
  const title = name + " | RS Mart বাংলাদেশ";
  const sourceDescription = String(product.description || "").replace(/\s+/g, " ").trim();
  const fallbackDescription = name + " পণ্যের দাম, ছবি ও বিস্তারিত দেখুন। RS Mart থেকে অনলাইনে অর্ডার করুন।";
  const description = (sourceDescription || fallbackDescription).slice(0, 160);
  const canonical = origin + "/product/" + encodeURIComponent(id);
  const image = seoAbsoluteImage(product.images?.[0], origin);
  const price = Number(product.sellingPrice || 0);
  const inStock = !isOutOfStock(product);
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name,
    description,
    sku: id,
    url: canonical,
    mainEntityOfPage: canonical,
    image: image ? [image] : undefined,
    brand: { "@type": "Brand", name: "RS Mart" },
    offers: {
      "@type": "Offer",
      url: canonical,
      priceCurrency: "BDT",
      price,
      availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition"
    }
  };
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "হোম", item: origin + "/" },
      { "@type": "ListItem", position: 2, name, item: canonical }
    ]
  };
  const safeJson = value => JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
  const imageMarkup = image
    ? '<img class="product-image" src="' + seoEscapeHtml(image) + '" alt="' + seoEscapeHtml(name + " - RS Mart পণ্যের ছবি") + '" loading="eager" decoding="async">'
    : '<div class="product-image image-placeholder">ছবি পাওয়া যায়নি</div>';
  const oldPrice = Number(product.originalPrice || 0) > price
    ? '<del>' + Number(product.originalPrice).toLocaleString("en-BD") + ' টাকা</del>'
    : "";
  const variants = Array.isArray(product.variants) ? product.variants : [];
  const colors = [...new Set(variants.map(v => v.color).filter(Boolean))];
  const sizes = [...new Set(variants.map(v => v.size).filter(Boolean))];
  const variantText = [colors.length ? "রং: " + colors.join(", ") : "", sizes.length ? "সাইজ: " + sizes.join(", ") : ""].filter(Boolean).join(" | ");
  const orderUrl = "/#product-" + encodeURIComponent(id);
  const stockText = inStock ? "স্টকে আছে" : "স্টক শেষ";
  const relatedMarkup = relatedProducts.length ? `
<section class="related" aria-labelledby="related-title">
<h2 id="related-title">সম্পর্কিত আরও পণ্য</h2>
<div class="related-grid">${relatedProducts.map(item => {
  const relatedName = String(item.name || "পণ্য");
  const relatedImage = seoAbsoluteImage(item.images?.[0], origin);
  const relatedPrice = Number(item.sellingPrice || 0);
  return '<a class="related-card" href="/product/' + encodeURIComponent(String(item.id)) + '">' +
    (relatedImage ? '<img src="' + seoEscapeHtml(relatedImage) + '" alt="' + seoEscapeHtml(relatedName + " - RS Mart পণ্যের ছবি") + '" loading="lazy" decoding="async">' : '') +
    '<strong>' + seoEscapeHtml(relatedName) + '</strong><span>' + relatedPrice.toLocaleString("en-BD") + ' টাকা</span></a>';
}).join("")}</div></section>` : "";
  return `<!doctype html>
<html lang="bn">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="index,follow">
  <!-- Google tag (gtag.js) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-GVZY93Q6E3"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-GVZY93Q6E3');
  </script>
  <!-- End Google tag -->
<title>${seoEscapeHtml(title)}</title>
<meta name="description" content="${seoEscapeHtml(description)}">
<link rel="canonical" href="${seoEscapeHtml(canonical)}">
<meta property="og:type" content="product">
<meta property="og:site_name" content="RS Mart">
<meta property="og:title" content="${seoEscapeHtml(title)}">
<meta property="og:description" content="${seoEscapeHtml(description)}">
<meta property="og:url" content="${seoEscapeHtml(canonical)}">
${image ? '<meta property="og:image" content="' + seoEscapeHtml(image) + '">' : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${seoEscapeHtml(title)}">
<meta name="twitter:description" content="${seoEscapeHtml(description)}">
${image ? '<meta name="twitter:image" content="' + seoEscapeHtml(image) + '">' : ""}
<script type="application/ld+json">${safeJson(jsonLd)}</script>
<script type="application/ld+json">${safeJson(breadcrumbJsonLd)}</script>
<style>
*{box-sizing:border-box}body{margin:0;background:#f7f7f8;color:#202124;font-family:Arial,"Noto Sans Bengali",sans-serif;line-height:1.65}.wrap{max-width:980px;margin:0 auto;padding:22px}.top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:12px}.brand{font-weight:800;font-size:24px;color:#c90018;text-decoration:none}.back{color:#444;text-decoration:none}.breadcrumb{font-size:13px;margin:0 0 18px;color:#666}.breadcrumb a{color:#444}.card{background:#fff;border-radius:16px;padding:22px;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:28px;box-shadow:0 4px 20px #0000000a}.product-image{width:100%;height:auto;max-height:480px;object-fit:contain;border-radius:12px;background:#fafafa}.image-placeholder{min-height:240px;display:grid;place-items:center}.info h1{font-size:28px;line-height:1.35;margin:0 0 14px}.price{font-size:26px;font-weight:800;color:#c90018}.price del{display:block;color:#777;font-size:16px;font-weight:400}.stock{font-weight:700;color:${inStock ? "#16803c" : "#b42318"}}.description{white-space:pre-line;margin:18px 0}.order{display:inline-block;background:#c90018;color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-weight:700;margin-top:14px}.note{font-size:13px;color:#666;margin-top:16px}.related{margin-top:26px}.related h2{font-size:20px}.related-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.related-card{display:grid;gap:6px;padding:10px;background:#fff;border:1px solid #e5e7eb;border-radius:12px;color:#202124;text-decoration:none}.related-card img{width:100%;aspect-ratio:1/1;object-fit:contain;background:#fafafa;border-radius:8px}.related-card strong{font-size:14px}.related-card span{font-weight:700;color:#c90018}@media(max-width:680px){.wrap{padding:14px}.card{grid-template-columns:1fr;padding:16px;gap:16px}.info h1{font-size:23px}.product-image{max-height:360px}}
</style>
</head>
<body><main class="wrap">
<header class="top"><a class="brand" href="/">RS Mart</a><a class="back" href="/">← সব পণ্য দেখুন</a></header>
<nav class="breadcrumb" aria-label="Breadcrumb"><a href="/">হোম</a> / <span>${seoEscapeHtml(name)}</span></nav>
<article class="card">
<div>${imageMarkup}</div>
<div class="info">
<p class="stock">${stockText}</p>
<h1>${seoEscapeHtml(name)}</h1>
<div class="price">${price.toLocaleString("en-BD")} টাকা ${oldPrice}</div>
<p class="description">${seoEscapeHtml(description)}</p>
${variantText ? '<p>' + seoEscapeHtml(variantText) + '</p>' : ""}
<a class="order" href="${seoEscapeHtml(orderUrl)}">${inStock ? "অর্ডার করুন" : "পণ্যটি দেখুন"}</a>
<p class="note">RS Mart থেকে সহজ অনলাইন অর্ডার। সারা বাংলাদেশে ডেলিভারি।</p>
</div></article>
${relatedMarkup}
</main></body></html>`;
}
async function seoProductPage(request, env, productId) {
  const catalog = await getCatalog(env);
  const settings = await getSettings(env);
  const products = catalog.products
    .map(item => publicProduct(item, settings.get(String(item.id))))
    .filter(item => item.isVisible && item.sellingPrice !== null && item.sellingPrice !== undefined);
  const product = products.find(item => String(item.id) === String(productId));
  if (!product) return new Response("পণ্য পাওয়া যায়নি।", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
  const sameCategory = products.filter(item => String(item.id) !== String(productId) && product.category && item.category === product.category);
  const otherProducts = products.filter(item => String(item.id) !== String(productId) && !sameCategory.some(related => String(related.id) === String(item.id)));
  const relatedProducts = [...sameCategory, ...otherProducts].slice(0, 4);
  return new Response(renderSeoProductPage(product, new URL(request.url).origin, relatedProducts), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300, s-maxage=900" }
  });
}
async function seoSitemap(request, env) {
  let catalog;
  let settings;
  try {
    catalog = await getCatalog(env);
    settings = await getSettings(env);
  } catch (error) {
    console.error("Dynamic sitemap generation failed:", error?.message || "Unknown error");
    return env.ASSETS.fetch(request);
  }
  const origin = new URL(request.url).origin;
  const products = catalog.products
    .map(item => publicProduct(item, settings.get(String(item.id))))
    .filter(product => product.isVisible && product.sellingPrice !== null && product.sellingPrice !== undefined);
  const urls = [
    origin + "/",
    origin + "/dhamaaka-offer.html",
    origin + "/contact.html",
    origin + "/delivery-policy.html",
    origin + "/return-refund.html",
    origin + "/privacy-policy.html",
    ...products.map(product => origin + "/product/" + encodeURIComponent(product.id))
  ];
  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    urls.map(url => '<url><loc>' + seoEscapeHtml(url) + '</loc></url>').join("") +
    '</urlset>';
  return new Response(xml, {
    headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300, s-maxage=900" }
  });
}
async function adminProducts(env) {
  const catalog = await getCatalog(env);
  const settings = await getSettings(env);

  const products = catalog.products.map(p => ({
    ...publicProduct(p, settings.get(String(p.id))),
    suggestedPrice: p.suggestedPrice,
    costPrice: p.costPrice ?? p.cost_price ?? null,
    minimumSellingPrice: p.minimumSellingPrice ?? p.minimum_selling_price ?? null
  }));

  return json({ data: products });
}

async function saveProductSettings(request, env, productId) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "সঠিক তথ্য পাঠান।" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "সঠিক তথ্য পাঠান।" }, 400);

  await ensureOrderSchema(env);
  // Merge updates with the stored row so omitted fields can never be erased.
  const existing = await env.DB.prepare("SELECT * FROM product_settings WHERE product_id = ?").bind(String(productId)).first();
  const has = key => Object.prototype.hasOwnProperty.call(body, key);

  const price = has("sellingPrice") ? Number(body.sellingPrice) : Number(existing?.selling_price);
  if (!Number.isSafeInteger(price) || price < 0) return json({ error: "বিক্রয়মূল্য সঠিকভাবে লিখুন।" }, 400);

  const originalPrice = has("originalPrice")
    ? (body.originalPrice == null || body.originalPrice === "" ? null : Number(body.originalPrice))
    : (existing?.original_price == null ? null : Number(existing.original_price));
  if (originalPrice !== null && (!Number.isSafeInteger(originalPrice) || originalPrice < 0)) return json({ error: "পুরোনো দাম সঠিকভাবে লিখুন।" }, 400);

  const discountPercent = has("discountPercent") ? Number(body.discountPercent) : Number(existing?.discount_percent || 0);
  if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 90) return json({ error: "অগ্রিম পেমেন্ট ছাড় ০ থেকে ৯০ শতাংশের মধ্যে দিন।" }, 400);

  const category = has("category") ? String(body.category ?? "").trim().slice(0, 100) : String(existing?.category || "");
  const isVisible = has("isVisible") ? (body.isVisible === false ? 0 : 1) : Number(existing?.is_visible ?? 1);
  const mediaUrl = has("mediaUrl") ? String(body.mediaUrl ?? "").trim().slice(0, 2000) : String(existing?.media_url || "");
  if (mediaUrl) {
    try {
      const parsed = new URL(mediaUrl);
      if (parsed.protocol !== "https:" || !["drive.google.com", "docs.google.com"].includes(parsed.hostname)) return json({ error: "Google Drive-এর HTTPS লিংক দিন।" }, 400);
    } catch { return json({ error: "Google Drive-এর সঠিক লিংক দিন।" }, 400); }
  }
  const mediaEnabled = has("mediaEnabled") ? (body.mediaEnabled === false ? 0 : 1) : Number(existing?.media_enabled ?? 1);
  const isTrending = has("isTrending") ? (body.isTrending === true ? 1 : 0) : Number(existing?.is_trending || 0);

  await env.DB.prepare(`
    INSERT INTO product_settings (product_id, selling_price, original_price, category, is_visible, discount_percent, media_url, media_enabled, is_trending, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(product_id) DO UPDATE SET
      selling_price = excluded.selling_price, original_price = excluded.original_price,
      category = excluded.category, is_visible = excluded.is_visible,
      discount_percent = excluded.discount_percent, media_url = excluded.media_url,
      media_enabled = excluded.media_enabled, is_trending = excluded.is_trending,
      updated_at = CURRENT_TIMESTAMP
  `).bind(String(productId), price, originalPrice, category, isVisible, discountPercent, mediaUrl || null, mediaEnabled, isTrending).run();

  return json({ success: true, message: "পণ্যের সেটিংস সংরক্ষণ হয়েছে।" });
}

function escapeTelegramHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramOrderAlert(env, order) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_GROUP_ID) return;
  const code = value => `<code>${escapeTelegramHtml(value)}</code>`;
  const itemsText = order.items.map((item, i) => {
    const variants = [
      item.color ? "রং: " + escapeTelegramHtml(item.color) : "",
      item.size ? "সাইজ: " + escapeTelegramHtml(item.size) : ""
    ].filter(Boolean).join(" · ");
    return `<b>${i + 1}. ${escapeTelegramHtml(item.name)}</b>\n${item.quantity} টি × ${code("৳" + item.unitPrice)} = <b>${code("৳" + item.subtotal)}</b>${variants ? "\n" + variants : ""}`;
  }).join("\n\n");
  const address = [order.area, order.district, order.division, order.address].filter(Boolean).join(", ");
  const message = [
    "🛍️ <b>RS MART | নতুন অর্ডার</b>",
    "━━━━━━━━━━━━━━━━━━",
    "<b>📦 অর্ডারের তথ্য</b>",
    "অর্ডার ID: " + code(order.id),
    "",
    "<b>🛒 পণ্যের তালিকা</b>",
    itemsText,
    "",
    "━━━━━━━━━━━━━━━━━━",
    "<b>👤 ক্রেতার তথ্য</b>",
    "নাম: <b>" + escapeTelegramHtml(order.name) + "</b>",
    "মোবাইল: " + code(order.phone),
    "ঠিকানা: " + escapeTelegramHtml(address),
    "",
    "━━━━━━━━━━━━━━━━━━",
    "<b>💳 পেমেন্ট ও হিসাব</b>",
    "পেমেন্ট পদ্ধতি: " + (order.paymentMethod === "advance" ? "অগ্রিম পেমেন্ট" : "ক্যাশ অন ডেলিভারি"),
    "ডেলিভারি চার্জ: " + code("৳" + order.deliveryCharge),
    "<b>সর্বমোট: " + code("৳" + order.totalAmount) + "</b>",
    order.note ? "<b>📝 ক্রেতার নোট</b>\n" + escapeTelegramHtml(order.note) : null,
    "",
    "⚡ অর্ডারটি Admin Panel থেকে নিশ্চিত করুন."
  ].filter(x => x !== null).join("\n");
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
    if (!response.ok) console.error("Telegram order alert failed with HTTP status:", response.status);
  } catch (error) {
    console.error("Telegram order alert request failed:", error?.message || "Unknown error");
  }
}

async function createOrder(request, env) {
  await ensureOrderSchema(env);
  const rateLimitResponse = await enforcePublicOrderRateLimit(request, env);
  if (rateLimitResponse) return rateLimitResponse;
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "অর্ডারের তথ্য সঠিকভাবে পাওয়া যায়নি।" }, 400); }
  const submissionKey = String(body.submissionKey || "").trim();
  if (submissionKey && !/^[0-9a-f-]{36}$/i.test(submissionKey)) return json({ error: "অর্ডার জমার অনুরোধটি সঠিক নয়। পেজ রিফ্রেশ করে আবার চেষ্টা করুন।" }, 400);
  if (submissionKey) {
    const previous = await env.DB.prepare("SELECT id, total_amount FROM orders WHERE submission_key = ?").bind(submissionKey).first();
    if (previous) return json({ success: true, orderId: previous.id, value: Number(previous.total_amount || 0), currency: "BDT", duplicate: true, message: "এই অর্ডারটি আগেই জমা হয়েছে।" }, 200);
  }
  const required = ["customerName","customerPhone","customerAddress","customerDivision","customerDistrict","customerArea"];
  for (const key of required) {
    if (body[key] === undefined || String(body[key]).trim() === "") return json({ error: "অনুগ্রহ করে " + key + " পূরণ করুন।" }, 400);
  }
  const customerPhone = String(body.customerPhone).trim()
    .replace(/[০-৯]/g, digit => "০১২৩৪৫৬৭৮৯".indexOf(digit))
    .replace(/[\s-]/g, "");
  if (!/^(?:01[3-9][0-9]{8}|\+8801[3-9][0-9]{8}|8801[3-9][0-9]{8})$/.test(customerPhone)) {
    return json({ error: "সঠিক বাংলাদেশি মোবাইল নম্বর দিন (যেমন 017XXXXXXXX)।" }, 400);
  }
  const phoneLimitResponse = await enforcePhoneOrderRateLimit(customerPhone, env);
  if (phoneLimitResponse) return phoneLimitResponse;
  const requestedItems = Array.isArray(body.items) && body.items.length ? body.items : [{ id: body.productId, quantity: body.quantity || 1, color: body.color || "", size: body.size || "" }];
  let dhamaakaOffer = null;
  if (body.dhamaakaOffer === true) {
    dhamaakaOffer = await env.DB.prepare("SELECT product_id, discount_percent, enabled FROM dhamaaka_offer_settings WHERE id = 1").first();
    if (!dhamaakaOffer || Number(dhamaakaOffer.enabled) !== 1 || !dhamaakaOffer.product_id) return json({error:"ধামাকা অফারটি বর্তমানে চালু নেই।"},409);
    if (requestedItems.length !== 2 || requestedItems.some(item => String(item.id ?? item.productId) !== String(dhamaakaOffer.product_id) || Number(item.quantity || 1) !== 1)) {
      return json({error:"ধামাকা অফারে একই পণ্যের ঠিক ২টি পিস নির্বাচন করতে হবে।"},400);
    }
    const offerPercent = Number(dhamaakaOffer.discount_percent);
    if (!Number.isInteger(offerPercent) || offerPercent < 1 || offerPercent > 90) return json({error:"ধামাকা অফারের ছাড়ের সেটিং সঠিক নয়।"},409);
  }
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
    if (!Number.isSafeInteger(unitPrice) || unitPrice < 1) return json({error:"একটি পণ্যের দাম সঠিক নয়।"},400);
    const lineSubtotal = unitPrice * quantity;
    const baseAdvancePercent = body.paymentMethod === "advance" ? Number(settings.discount_percent || 0) : 0;
    // Apply the product's existing advance discount first; Dhamaaka's extra discount is calculated on that already-discounted price.
    const baseDiscountedUnitPrice = baseAdvancePercent > 0
      ? Math.max(0, Math.round(unitPrice * (100 - baseAdvancePercent) / 100))
      : unitPrice;
    const discountedUnitPrice = dhamaakaOffer && body.paymentMethod === "advance"
      ? Math.max(0, Math.round(baseDiscountedUnitPrice * (100 - Number(dhamaakaOffer.discount_percent)) / 100))
      : baseDiscountedUnitPrice;
    const discountPercent = unitPrice > 0 ? Math.round((unitPrice - discountedUnitPrice) * 100 / unitPrice) : 0;
    const discountAmount = (unitPrice - discountedUnitPrice) * quantity;
    subtotal += lineSubtotal; totalDiscount += discountAmount; totalQuantity += quantity;
    orderItems.push({id:String(product.id),name:String(product.name || ""),quantity,unitPrice,color,size,subtotal:lineSubtotal,discountPercent,discountAmount,discountedUnitPrice});
  }
  const district = String(body.customerDistrict || "").trim().toLowerCase().replace(/[\s-]+/g, "");
  const isDhakaDistrict = ["ঢাকা", "dhaka", "ঢাকাজেলা", "dhakadistrict"].includes(district);
  const deliveryCharge = isDhakaDistrict ? 70 : 130;
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
  try {
    await env.DB.prepare(
      "INSERT INTO orders (id,product_id,product_name,customer_name,customer_phone,customer_division,customer_district,customer_area,customer_address,color,size,quantity,unit_price,delivery_charge,total_amount,note,payment_method,discount_percent,discount_amount,advance_payment_amount,transaction_id,transaction_id_format_valid,payment_verification_status,order_items_json,submission_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)"
    ).bind(orderId,String(first.id),productName,String(body.customerName).trim().slice(0,100),customerPhone.slice(0,20),String(body.customerDivision).trim().slice(0,100),String(body.customerDistrict).trim().slice(0,100),String(body.customerArea).trim().slice(0,150),String(body.customerAddress).trim().slice(0,500),orderItems.length===1?first.color:"",orderItems.length===1?first.size:"",totalQuantity,subtotal,deliveryCharge,totalAmount,String(body.customerNote||"").trim().slice(0,500),paymentMethod,effectiveDiscountPercent,totalDiscount,advancePaymentAmount,paymentMethod==="advance"?transactionId:null,transactionIdFormatValid?1:0,paymentMethod==="advance"?"pending_manual":"not_required",JSON.stringify(orderItems),submissionKey || null).run();
  } catch (error) {
    if (submissionKey && /unique|constraint/i.test(String(error?.message || error))) {
      const previous = await env.DB.prepare("SELECT id FROM orders WHERE submission_key = ?").bind(submissionKey).first();
      if (previous) return json({ success: true, orderId: previous.id, duplicate: true, message: "এই অর্ডারটি আগেই জমা হয়েছে।" }, 200);
    }
    throw error;
  }
  await sendTelegramOrderAlert(env, {
    id: orderId,
    items: orderItems,
    name: String(body.customerName).trim().slice(0,100),
    phone: customerPhone.slice(0,20),
    division: String(body.customerDivision).trim().slice(0,100),
    district: String(body.customerDistrict).trim().slice(0,100),
    area: String(body.customerArea).trim().slice(0,150),
    address: String(body.customerAddress).trim().slice(0,500),
    note: String(body.customerNote || "").trim().slice(0,500),
    paymentMethod,
    deliveryCharge,
    totalAmount
  });
  return json({success:true,orderId,value:totalAmount,currency:"BDT",message:"আপনার অর্ডার RS Mart-এ জমা হয়েছে। আমাদের প্রতিনিধি ফোন করে অর্ডার নিশ্চিত করবেন।"},201);
}

async function sendOrderToBusinessKoro(request, env, orderId) {
  await ensureOrderSchema(env);
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ?").bind(orderId).first();
  if (!order) return json({error:"অর্ডার পাওয়া যায়নি।"},404);
  if (order.business_koro_status === "sent") {
    return json({error:"এই অর্ডারটি আগেই Business Koro-তে পাঠানো হয়েছে।", businessKoroOrderId:order.business_koro_order_id},409);
  }
  if (order.business_koro_status === "sending") {
    return json({error:"অর্ডারটি পাঠানোর প্রক্রিয়ায় আছে। কিছুক্ষণ পর অবস্থা দেখুন।"},409);
  }
  let items=[];
  try { items=JSON.parse(order.order_items_json || "[]"); } catch { /* Use the legacy single-product order fields below. */ }
  if (!items.length && order.product_id) items=[{id:order.product_id,name:order.product_name,quantity:Number(order.quantity||1),unitPrice:Number(order.unit_price||0),color:order.color||"",size:order.size||""}];
  if (items.length !== 1) return json({error:"এই অর্ডারে একাধিক পণ্য আছে। Business Koro-র দেওয়া API একবারে একটি পণ্য নেয়। তাই ভুল ডেলিভারি/চার্জ এড়াতে এটি পাঠানো হয়নি।"},400);
  const item=items[0];
  if (Number(item.quantity||1) !== 1) return json({error:"এই API-তে quantity গ্রহণ করা হয় না। একাধিক পিসের অর্ডার আপাতত পাঠানো যাচ্ছে না।"},400);
  let requestBody={};
  try { requestBody=await request.json(); } catch { /* No optional delivery mode was supplied. */ }
  const deliveryChargeMode=String(requestBody.deliveryChargeMode || "customer_delivery");
  const allowedDeliveryModes=["customer_delivery","customer_upfront","reseller_bears"];
  if (!allowedDeliveryModes.includes(deliveryChargeMode)) return json({error:"ডেলিভারি চার্জের অপশন সঠিক নয়।"},400);
  // Send the actual per-unit price after every order discount has been applied.
  // Order items store discountAmount as a line total, so divide by quantity.
  const baseUnitPrice=Number(item.unitPrice ?? order.unit_price);
  const itemQuantity=Math.max(1,Number(item.quantity||1));
  const sellingPrice=Number(item.discountedUnitPrice ?? (
    Number(item.discountPercent||0) > 0
      ? Math.max(0, Math.round(baseUnitPrice * (100 - Number(item.discountPercent||0)) / 100))
      : baseUnitPrice
  ));
  if (!Number.isSafeInteger(sellingPrice) || sellingPrice <= 0) return json({error:"ছাড় বাদ দেওয়ার পর বিক্রয়মূল্য সঠিক নয়।"},400);
  const address=[order.customer_address,order.customer_area,order.customer_district,order.customer_division].filter(Boolean).join(", ");
  const payload={
    productId:String(item.id || order.product_id),
    customerName:String(order.customer_name||"").trim(),
    customerPhone:String(order.customer_phone||"").trim(),
    customerAddress:address,
    customerDivision:String(order.customer_division||"").trim(),
    customerDistrict:String(order.customer_district||"").trim(),
    customerArea:String(order.customer_area||"").trim(),
    sellingPrice,
    deliveryChargePaidByCustomer:deliveryChargeMode === "customer_delivery",
    customerNote:String(order.note||"").trim()
  };
  if (item.color) payload.color=String(item.color);
  if (item.size) payload.size=String(item.size);
  if (deliveryChargeMode === "customer_upfront") {
    payload.deliveryChargeCollectionMode="CUSTOMER_PAID_RESELLER_UPFRONT";
  }
  const claim=await env.DB.prepare("UPDATE orders SET business_koro_status='sending', business_koro_response=NULL WHERE id=? AND business_koro_status IN ('not_sent','failed')").bind(orderId).run();
  if (!claim.meta?.changes) return json({error:"অর্ডারটি ইতিমধ্যে পাঠানো হচ্ছে বা পাঠানো হয়েছে।"},409);
  try {
    const response=await fetch(`${API_BASE}/orders`,{method:"POST",headers:apiHeaders(env),body:JSON.stringify(payload)});
    const raw=await response.text();
    let data; try { data=JSON.parse(raw); } catch { data={message:raw.slice(0,1000)}; }
    if (!response.ok) {
      const message=String(data?.message || data?.error || "Business Koro অর্ডার গ্রহণ করেনি।").slice(0,1500);
      const outcome = response.status >= 500 ? "unknown" : "failed";
      await env.DB.prepare("UPDATE orders SET business_koro_status=?, business_koro_response=? WHERE id=?").bind(outcome,JSON.stringify(data).slice(0,5000),orderId).run();
      return json({error: outcome === "unknown" ? "Business Koro-র উত্তর নিশ্চিত নয়। ডুপ্লিকেট এড়াতে আবার পাঠানো বন্ধ রাখা হয়েছে। Business Koro-তে অর্ডারটি আগে যাচাই করুন।" : message,details:data},response.status>=400&&response.status<500?400:502);
    }
    const externalId=data?.data?.id ?? data?.order?.id ?? data?.orderId ?? data?.id ?? null;
    await env.DB.prepare("UPDATE orders SET business_koro_status='sent', business_koro_order_id=?, business_koro_response=?, business_koro_sent_at=CURRENT_TIMESTAMP WHERE id=?").bind(externalId==null?null:String(externalId),JSON.stringify(data).slice(0,5000),orderId).run();
    return json({success:true,businessKoroOrderId:externalId,message:"Business Koro-তে অর্ডার পাঠানো হয়েছে।",response:data});
  } catch(error) {
    await env.DB.prepare("UPDATE orders SET business_koro_status='unknown', business_koro_response=? WHERE id=?").bind(JSON.stringify({message:String(error?.message||error),outcome:"unknown"}).slice(0,5000),orderId).run();
    return json({error:"Business Koro-র কাছে অর্ডার পৌঁছেছে কি না নিশ্চিত হওয়া যায়নি। ডুপ্লিকেট এড়াতে পুনরায় পাঠানো বন্ধ রাখা হয়েছে। Business Koro-তে আগে যাচাই করুন।"},502);
  }
}

function findExternalStatus(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 5) return "";
  for (const key of ["status", "order_status", "delivery_status", "current_status", "state"]) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  for (const key of ["data", "order", "result", "consignment", "courier"]) {
    const found = findExternalStatus(value[key], depth + 1);
    if (found) return found;
  }
  return "";
}

async function refreshExternalOrderStatuses(env, orders) {
  const now = Date.now();
  await Promise.all((orders || []).map(async order => {
    const businessChecked = Date.parse(order.business_koro_status_checked_at || "");
    if (order.business_koro_order_id && env.BUSINESS_KORO_API_KEY && (!Number.isFinite(businessChecked) || now - businessChecked > 120000)) {
      try {
        const response = await fetch(API_BASE + "/orders/" + encodeURIComponent(order.business_koro_order_id), { headers: apiHeaders(env) });
        let data = {};
        try { data = await response.json(); } catch { /* Ignore an unreadable optional status payload. */ }
        if (response.ok) {
          const status = findExternalStatus(data);
          await env.DB.prepare("UPDATE orders SET business_koro_live_status=?, business_koro_status_checked_at=CURRENT_TIMESTAMP WHERE id=?").bind(status ? status.slice(0, 100) : null, order.id).run();
        }
      } catch (error) { console.error("Business Koro status refresh failed:", error?.message || "Unknown error"); }
    }

  }));
}

async function adminOrders(env, url) {
  await ensureOrderSchema(env);
  const requestedPage = Math.max(1, Math.min(100000, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1));
  const limit = Math.max(10, Math.min(100, Number.parseInt(url.searchParams.get("limit") || "50", 10) || 50));
  const query = String(url.searchParams.get("q") || "").trim().slice(0, 100);
  const requestedStatus = String(url.searchParams.get("status") || "all");
  const allowedStatuses = ["new", "confirmed", "shipped", "delivered", "cancelled"];
  const status = allowedStatuses.includes(requestedStatus) ? requestedStatus : "all";
  const archivedOnly = url.searchParams.get("archived") === "1";
  const conditions = [archivedOnly ? "archived_at IS NOT NULL" : "archived_at IS NULL"];
  const filterValues = [];
  if (query) {
    conditions.push("(CAST(id AS TEXT) LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR product_name LIKE ?)");
    const pattern = "%" + query + "%";
    filterValues.push(pattern, pattern, pattern, pattern);
  }
  if (status !== "all") {
    conditions.push("status = ?");
    filterValues.push(status);
  }
  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";
  const summary = await env.DB.prepare(`
    SELECT COUNT(*) AS total_orders,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) AS new_orders,
      SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered_orders,
      SUM(CASE WHEN status = 'delivered' AND (payment_method = 'cod' OR payment_verification_status = 'verified') THEN total_amount ELSE 0 END) AS total_sales
    FROM orders WHERE archived_at IS NULL
  `).first();
  const countResult = await env.DB.prepare("SELECT COUNT(*) AS total FROM orders" + where).bind(...filterValues).first();
  const total = Number(countResult?.total || 0);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * limit;
  const selectPage = async () => env.DB.prepare("SELECT * FROM orders" + where + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?").bind(...filterValues, limit, offset).all();
  const result = await selectPage();
  await refreshExternalOrderStatuses(env, (result.results || []).slice(0, 10));
  const refreshed = await selectPage();
  return json({
    data: refreshed.results || [],
    page, limit, total, totalPages,
    summary: {
      total_orders: Number(summary?.total_orders || 0),
      new_orders: Number(summary?.new_orders || 0),
      delivered_orders: Number(summary?.delivered_orders || 0),
      total_sales: Number(summary?.total_sales || 0)
    }
  });
}

async function archiveOrder(env, orderId, restore = false) {
  await ensureOrderSchema(env);
  const result = restore ? await env.DB.prepare("UPDATE orders SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL").bind(orderId).run() : await env.DB.prepare("UPDATE orders SET archived_at = CURRENT_TIMESTAMP WHERE id = ? AND archived_at IS NULL").bind(orderId).run();
  if (!result.meta?.changes) return json({ error: "অর্ডার পাওয়া যায়নি বা অবস্থা ইতিমধ্যে পরিবর্তিত হয়েছে।" }, 404);
  return json({ success: true, archived: !restore, restored: restore });
}
async function exportOrdersCSV(env, url) {
  await ensureOrderSchema(env);
  const archivedOnly = url.searchParams.get("archived") === "1", conditions = [archivedOnly ? "archived_at IS NOT NULL" : "archived_at IS NULL"], values = [];
  const q = String(url.searchParams.get("q") || "").trim().slice(0,100), status = String(url.searchParams.get("status") || "all");
  if(q){conditions.push("(CAST(id AS TEXT) LIKE ? OR customer_name LIKE ? OR customer_phone LIKE ? OR product_name LIKE ?)");const p="%"+q+"%";values.push(p,p,p,p);}
  if(["new","confirmed","shipped","delivered","cancelled"].includes(status)){conditions.push("status = ?");values.push(status);}
  const result=await env.DB.prepare("SELECT * FROM orders WHERE "+conditions.join(" AND ")+" ORDER BY created_at DESC,id DESC").bind(...values).all();
  const headers=["Order ID","Date","Customer","Phone","Product","Quantity","Product price","Delivery","Total","Payment","Transaction ID","Payment verification","Order status","Address","Business Koro status","Archived at"];
  const rows=(result.results||[]).map(o=>[o.id,o.created_at,o.customer_name,o.customer_phone,o.product_name,o.quantity,o.unit_price,o.delivery_charge,o.total_amount,o.payment_method,o.transaction_id,o.payment_verification_status,o.status,[o.customer_division,o.customer_district,o.customer_area,o.customer_address].filter(Boolean).join(", "),o.business_koro_status,o.archived_at]);
  const csvCell = value => {
    let text = String(value ?? "");
    // Prefix text cells that could be interpreted as spreadsheet formulas.
    if (typeof value === "string" && /^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  };
  const csv="\uFEFF"+[headers,...rows].map(row=>row.map(csvCell).join(",")).join("\r\n");
  return new Response(csv,{headers:{"content-type":"text/csv; charset=utf-8","content-disposition":'attachment; filename="rs-mart-orders.csv"',"cache-control":"no-store"}});
}
async function updateOrderStatus(request,env,orderId){await ensureOrderSchema(env);let b;try{b=await request.json()}catch{return json({error:"সঠিক তথ্য পাঠান।"},400)}const allowed=["new","confirmed","shipped","delivered","cancelled"],pay=["pending_manual","verified","rejected"],sets=[],vals=[];if(b.status!==undefined){if(!allowed.includes(b.status))return json({error:"অর্ডারের অবস্থা সঠিক নয়।"},400);sets.push("status=?");vals.push(b.status)}if(b.paymentVerificationStatus!==undefined){if(!pay.includes(b.paymentVerificationStatus))return json({error:"পেমেন্ট যাচাইয়ের অবস্থা সঠিক নয়।"},400);sets.push("payment_verification_status=?");vals.push(b.paymentVerificationStatus)}if(!sets.length)return json({error:"কোনো পরিবর্তন পাওয়া যায়নি।"},400);vals.push(orderId);const r=await env.DB.prepare("UPDATE orders SET "+sets.join(", ")+" WHERE id=?").bind(...vals).run();if(!r.meta?.changes)return json({error:"অর্ডার পাওয়া যায়নি।"},404);return json({success:true})}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/sitemap.xml" && method === "GET") {
        return await seoSitemap(request, env);
      }

      const seoProductMatch = path.match(/^\/product\/([^/]+)\/?$/);
      if (seoProductMatch && method === "GET") {
        return await seoProductPage(request, env, decodeURIComponent(seoProductMatch[1]));
      }

      if (path === "/api/admin/login" && method === "POST") {
        return await adminLogin(request, env);
      }

      if (path === "/api/admin/logout" && method === "POST") {
        if (!(await isAdmin(request, env))) {          return json({ error: "অনুমতি নেই।" }, 401);
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

        if (path === "/api/admin/dhamaaka-offer" && method === "GET") {
          await ensureOrderSchema(env);
          const offer = await env.DB.prepare("SELECT product_id, discount_percent, enabled FROM dhamaaka_offer_settings WHERE id = 1").first();
          const catalog = await getCatalog(env);
          const settings = await getSettings(env);
          return json({offer:offer || {product_id:null,discount_percent:30,enabled:0}, products:catalog.products.map(p=>publicProduct(p,settings.get(String(p.id))))});
        }
        if (path === "/api/admin/dhamaaka-offer" && method === "PUT") {
          let body; try { body = await request.json(); } catch { return json({error:"সঠিক তথ্য পাঠান।"},400); }
          const productId = String(body.productId || "").trim();
          const discountPercent = Number(body.discountPercent);
          const enabled = body.enabled === true;
          if (!productId || !Number.isInteger(discountPercent) || discountPercent < 1 || discountPercent > 90) return json({error:"একটি পণ্য নির্বাচন করুন এবং ১–৯০ শতাংশ ছাড় দিন।"},400);
          const catalog = await getCatalog(env);
          const product = catalog.products.find(p=>String(p.id)===productId);
          const settings = await env.DB.prepare("SELECT is_visible FROM product_settings WHERE product_id=?").bind(productId).first();
          if (!product || isOutOfStock(product) || !settings || Number(settings.is_visible)!==1) return json({error:"নির্বাচিত পণ্যটি দৃশ্যমান ও স্টকে থাকা প্রয়োজন।"},400);
          await env.DB.prepare("INSERT INTO dhamaaka_offer_settings (id,product_id,discount_percent,enabled,updated_at) VALUES (1,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET product_id=excluded.product_id,discount_percent=excluded.discount_percent,enabled=excluded.enabled,updated_at=CURRENT_TIMESTAMP").bind(productId,discountPercent,enabled?1:0).run();
          return json({success:true,message:"ধামাকা অফারের সেটিংস সংরক্ষণ হয়েছে।"});
        }
        if (path === "/api/admin/reviews" && method === "GET") return await adminProductReviews(env, url);
        const reviewAdminMatch = path.match(/^\/api\/admin\/reviews\/(\d+)$/);
        if (reviewAdminMatch && method === "PATCH") return await updateProductReview(request, env, Number(reviewAdminMatch[1]));
        if (reviewAdminMatch && method === "DELETE") return await deleteProductReview(env, Number(reviewAdminMatch[1]));

        if (path === "/api/admin/products" && method === "GET") {
          return await adminProducts(env);
        }

        if (path === "/api/admin/orders/export" && method === "GET") return await exportOrdersCSV(env, url);
        if (path === "/api/admin/orders" && method === "GET") {
          return await adminOrders(env, url);
        }

        const productMatch = path.match(/^\/api\/admin\/products\/([^/]+)$/);
        if (productMatch && method === "PUT") {
          return await saveProductSettings(
            request, env, decodeURIComponent(productMatch[1])
          );
        }

        const businessKoroMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/business-koro$/);
        if (businessKoroMatch && method === "POST") {
          return await sendOrderToBusinessKoro(request, env, decodeURIComponent(businessKoroMatch[1]));
        }

        const archiveMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/(archive|restore)$/);
        if (archiveMatch && method === "POST") return await archiveOrder(env, decodeURIComponent(archiveMatch[1]), archiveMatch[2] === "restore");

        const orderMatch = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
        if (orderMatch && method === "PATCH") {
          return await updateOrderStatus(
            request, env, decodeURIComponent(orderMatch[1])
          );
        }
        if (orderMatch && method === "DELETE") {
          return await archiveOrder(env, decodeURIComponent(orderMatch[1]), false);
        }

        return json({ error: "Admin API route not found." }, 404);
      }

      if (path === "/api/dhamaaka-offer" && method === "GET") {
        await ensureOrderSchema(env);
        const offer = await env.DB.prepare("SELECT product_id, discount_percent, enabled FROM dhamaaka_offer_settings WHERE id = 1").first();
        if (!offer || Number(offer.enabled) !== 1 || !offer.product_id) return json({active:false});
        const catalog = await getCatalog(env);
        const settings = await getSettings(env);
        const product = catalog.products.find(p => String(p.id) === String(offer.product_id));
        const productSettings = settings.get(String(offer.product_id));
        if (!product || !productSettings || Number(productSettings.is_visible) !== 1 || isOutOfStock(product)) return json({active:false});
        return json({active:true, discountPercent:Number(offer.discount_percent), product:publicProduct(product, productSettings), deliveryCharges:catalog.deliveryCharges});
      }
      if (path === "/api/reviews" && method === "GET") {
        const productId = String(url.searchParams.get("productId") || "").trim().slice(0,100);
        if (!productId) return json({error:"পণ্য নির্বাচন করুন।"},400);
        return await publicProductReviews(env, productId);
      }
      if (path === "/api/reviews" && method === "POST") return await submitProductReview(request, env);

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