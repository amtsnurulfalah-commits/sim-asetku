import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHmac } from "node:crypto";
import {
  SsoClient,
  SsoError,
  envelope,
  type SsoConfig,
} from "../src/lib/sso/client";
import { loginInput } from "../src/lib/sso/schemas";
const cfg: SsoConfig = {
  baseUrl: "https://sso.test.invalid",
  applicationId: "app_test",
  keyId: "key_test",
  clientSecret: "0123456789abcdef".repeat(4),
};
function okResponse(
  request: RequestInit | undefined,
  overrides: Record<string, unknown> = {},
) {
  const e = JSON.parse(String(request?.body));
  const now = new Date().toISOString();
  return Response.json({
    success: true,
    data: {
      sso_user_id: "test_admin_a",
      username: "test.admin.a",
      full_name: "Admin Uji A",
      account_status: "active",
      identity_version: 1,
      authenticated_at: now,
      request_id: e.request_id,
      ...overrides,
    },
    request_id: e.request_id,
    timestamp: now,
  });
}
const mock = (
  fn: (i: RequestInfo | URL, r?: RequestInit) => Promise<Response>,
) => fn as typeof fetch;
test("HMAC agrees with independent Python Unicode vector and textual hex key", () => {
  const v = JSON.parse(
    fs.readFileSync("tests/fixtures/hmac-python.json", "utf8"),
  );
  const e = envelope(cfg, "authenticate.user", v.payload, {
    requestId: v.request_id,
    timestamp: v.timestamp,
    nonce: v.nonce,
  });
  assert.equal(e.payload, v.payload_encoded);
  assert.equal(e.signature, v.signature);
  assert.notEqual(
    e.signature,
    createHmac("sha256", Buffer.from(cfg.clientSecret, "hex"))
      .update(
        JSON.stringify([
          e.v,
          e.aud,
          e.op,
          e.application_id,
          e.key_id,
          e.request_id,
          e.timestamp,
          e.nonce,
          e.payload,
        ]),
      )
      .digest("hex"),
  );
});
test("Password spaces, Unicode and code-point length are preserved", () => {
  const r = loginInput.parse({ username: " GURU.SATU ", password: "  é 😀  " });
  assert.equal(r.username, "guru.satu");
  assert.equal(r.password, "  é 😀  ");
  assert.ok(
    loginInput.safeParse({ username: "guru.satu", password: "😀".repeat(1024) })
      .success,
  );
  assert.equal(
    loginInput.safeParse({ username: "guru.satu", password: "😀".repeat(1025) })
      .success,
    false,
  );
});
test("Two envelopes have new request IDs and 32-byte nonces", () => {
  const a = envelope(cfg, "user.status", { user_id: "x" }),
    b = envelope(cfg, "user.status", { user_id: "x" });
  assert.notEqual(a.request_id, b.request_id);
  assert.notEqual(a.nonce, b.nonce);
  assert.match(a.nonce, /^[a-f0-9]{64}$/);
});
test("Login uses exact path/op/envelope and no bearer or admin cookie", async () => {
  const client = new SsoClient(
    cfg,
    mock(async (url, init) => {
      assert.equal(url, cfg.baseUrl + "/api/v1/auth/verify");
      const e = JSON.parse(String(init?.body));
      assert.equal(e.op, "authenticate.user");
      assert.equal(Object.keys(e).length, 10);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      assert.deepEqual(
        JSON.parse(Buffer.from(e.payload, "base64url").toString()),
        { username: "guru.satu", password: "  exact  " },
      );
      assert.deepEqual(init?.headers, {
        "Content-Type": "application/json",
        Accept: "application/json",
      });
      return okResponse(init);
    }),
  );
  assert.equal(
    (await client.authenticate("guru.satu", "  exact  ")).sso_user_id,
    "test_admin_a",
  );
});
test("Status uses user_id input and rejects returned ID mismatch", async () => {
  const client = new SsoClient(
    cfg,
    mock(async (url, init) => {
      assert.equal(url, cfg.baseUrl + "/api/v1/users/status");
      const e = JSON.parse(String(init?.body));
      assert.deepEqual(
        JSON.parse(Buffer.from(e.payload, "base64url").toString()),
        { user_id: "test_admin_a" },
      );
      return Response.json({
        success: true,
        request_id: e.request_id,
        timestamp: new Date().toISOString(),
        data: {
          sso_user_id: "wrong_id",
          account_status: "active",
          is_archived: false,
          can_authenticate: true,
          identity_version: 1,
          checked_at: new Date().toISOString(),
          request_id: e.request_id,
        },
      });
    }),
  );
  await assert.rejects(
    () => client.getUserStatus("test_admin_a"),
    (e: unknown) => e instanceof SsoError && e.code === "SSO_ID_MISMATCH",
  );
});
test("Response request correlation and unknown identity fields are rejected", async () => {
  for (const overrides of [
    { request_id: "wrong" },
    { global_role: "super_admin" },
  ]) {
    const c = new SsoClient(
      cfg,
      mock(async (_u, i) => okResponse(i, overrides)),
    );
    await assert.rejects(() => c.authenticate("guru.satu", "secret"), SsoError);
  }
});
test("HTML, redirect, malformed JSON and oversized response fail closed", async () => {
  for (const make of [
    () =>
      new Response("<html>login</html>", {
        headers: { "Content-Type": "text/html" },
      }),
    () =>
      new Response("", {
        status: 302,
        headers: { Location: "https://evil.invalid" },
      }),
    () =>
      new Response("{", { headers: { "Content-Type": "application/json" } }),
    () =>
      new Response("x".repeat(131073), {
        headers: { "Content-Type": "application/json" },
      }),
  ]) {
    const c = new SsoClient(
      cfg,
      mock(async () => make()),
    );
    await assert.rejects(() => c.authenticate("guru.satu", "secret"), SsoError);
  }
});
test("Invalid credentials code is retained; one request and no auto-retry", async () => {
  let n = 0;
  const c = new SsoClient(
    cfg,
    mock(async () => {
      n++;
      return Response.json(
        {
          success: false,
          error: { code: "INVALID_CREDENTIALS", message: "safe" },
          request_id: "gateway-id",
          timestamp: new Date().toISOString(),
        },
        { status: 401 },
      );
    }),
  );
  await assert.rejects(
    () => c.authenticate("guru.satu", "wrong"),
    (e: unknown) =>
      e instanceof SsoError &&
      e.code === "INVALID_CREDENTIALS" &&
      e.responseRequestId === "gateway-id",
  );
  assert.equal(n, 1);
});
test("HTTP/error-code mismatch is rejected as protocol failure", async () => {
  const c = new SsoClient(
    cfg,
    mock(async () =>
      Response.json(
        {
          success: false,
          error: { code: "INVALID_CREDENTIALS", message: "safe" },
          request_id: "gateway-id",
          timestamp: new Date().toISOString(),
        },
        { status: 503 },
      ),
    ),
  );
  await assert.rejects(
    () => c.authenticate("guru.satu", "wrong"),
    (e: unknown) => e instanceof SsoError && e.code === "SSO_TRANSPORT_ERROR",
  );
});
test("Timeout aborts without repeating authentication", async () => {
  let calls = 0;
  const c = new SsoClient(
    { ...cfg, timeoutMs: 5 },
    mock(async (_u, i) => {
      calls++;
      return await new Promise<Response>((_resolve, reject) =>
        i?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    }),
  );
  await assert.rejects(() => c.authenticate("guru.satu", "secret"), SsoError);
  assert.equal(calls, 1);
});
test("Directory search/get use documented operations and do not fabricate membership", async () => {
  const c = new SsoClient(
    cfg,
    mock(async (url, init) => {
      const e = JSON.parse(String(init?.body));
      const now = new Date().toISOString(),
        u = {
          sso_user_id: "test_admin_a",
          username: "test.admin.a",
          full_name: "Uji",
          account_status: "active",
          identity_version: 1,
        };
      const data = String(url).endsWith("/get")
        ? { user: u, request_id: e.request_id, retrieved_at: now }
        : {
            items: [u],
            pagination: {
              page: 1,
              page_size: 25,
              total: 1,
              total_pages: 1,
              has_next: false,
            },
            request_id: e.request_id,
            retrieved_at: now,
          };
      assert.ok(["directory.get", "directory.search"].includes(e.op));
      return Response.json({
        success: true,
        data,
        request_id: e.request_id,
        timestamp: now,
      });
    }),
  );
  assert.equal((await c.searchUsers({ query: "test" })).items.length, 1);
  assert.equal((await c.getUser("test_admin_a")).sso_user_id, "test_admin_a");
});
test("Client refuses non-HTTPS/path base URL or malformed key", () => {
  for (const x of [
    { baseUrl: "http://sso.invalid" },
    { baseUrl: "https://sso.invalid/gas" },
    { clientSecret: "bad" },
  ])
    assert.throws(() => new SsoClient({ ...cfg, ...x }));
});
