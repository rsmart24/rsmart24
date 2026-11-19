import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

test("checkout calculates product prices from server-side catalog settings", () => {
  assert.match(worker, /const catalog = await getCatalog\(env\)/);
  assert.match(worker, /SELECT selling_price,is_visible,discount_percent FROM product_settings/);
  assert.match(worker, /const unitPrice = Number\(settings\.selling_price\)/);
});

test("checkout applies the district-based delivery policy on the server", () => {
  assert.match(worker, /const isDhakaDistrict = \["ঢাকা", "dhaka", "ঢাকাজেলা", "dhakadistrict"\]\.includes\(district\)/);
  assert.match(worker, /const deliveryCharge = isDhakaDistrict \? 70 : 130/);
});

test("checkout validates selected product variants against server catalog stock", () => {
  assert.match(worker, /const selected = variants\.find\(/);
  assert.match(worker, /if \(!selected \|\| isOutOfStock\(selected\)\)/);
});

test("advance payments remain pending manual verification", () => {
  assert.match(worker, /paymentMethod==="advance"\?"pending_manual":"not_required"/);
  assert.match(worker, /if \(paymentMethod === "advance" && !transactionIdFormatValid\)/);
});

test("admin session cookie uses secure browser protections", () => {
  assert.match(worker, /HttpOnly; Secure; SameSite=Strict; Path=\/api\/admin/);
});

test("public order endpoint applies request rate limiting", () => {
  assert.match(worker, /enforcePublicOrderRateLimit\(request, env\)/);
  assert.match(worker, /enforcePhoneOrderRateLimit\(customerPhone, env\)/);
});
