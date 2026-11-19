import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/index.js";

test("admin order API rejects unauthenticated requests", async () => {
  const response = await app.fetch(
    new Request("https://rsmart.test/api/admin/orders"),
    {}
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Admin login প্রয়োজন।" });
});

test("unknown API endpoints return a JSON 404", async () => {
  const response = await app.fetch(
    new Request("https://rsmart.test/api/does-not-exist"),
    {}
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "API route not found." });
});
