import assert from "node:assert/strict";
import test from "node:test";

import { authorizeCsdRequest, resolveCsdAccess } from "../worker/csd-auth.ts";
import { handleCsdApi } from "../worker/csd-api.ts";

const env = {
  CSD_ADMIN_EMAIL: "owner@example.com",
  CSD_VIEWER_EMAILS: "viewer@example.com, Other@Example.com ",
};

function signedIn(path, email, method = "GET") {
  return new Request(`https://csd.test${path}`, {
    method,
    headers: { "oai-authenticated-user-email": email },
  });
}

test("normalizes allowlisted administrator and viewer email addresses", () => {
  assert.deepEqual(
    resolveCsdAccess(signedIn("/", " OWNER@example.com "), env),
    { role: "admin", email: "owner@example.com" },
  );
  assert.deepEqual(
    resolveCsdAccess(signedIn("/", "other@example.com"), env),
    { role: "viewer", email: "other@example.com" },
  );
});

test("fails closed when the Sites access policy is incomplete", () => {
  assert.equal(resolveCsdAccess(signedIn("/", "owner@example.com"), {
    CSD_ADMIN_EMAIL: "owner@example.com",
  }), null);
});

test("redirects anonymous browser navigation and preserves its same-origin return path", () => {
  const response = authorizeCsdRequest(new Request("https://csd.test/?tab=parts"), env);

  assert.equal(response instanceof Response, true);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://csd.test/signin-with-chatgpt?return_to=%2F%3Ftab%3Dparts");
});

test("returns no CSD data to anonymous or unknown API callers", async () => {
  const anonymous = authorizeCsdRequest(new Request("https://csd.test/api/dashboard"), env);
  const outsider = authorizeCsdRequest(signedIn("/api/dashboard", "outsider@example.com"), env);

  assert.equal(anonymous instanceof Response, true);
  assert.equal(anonymous.status, 401);
  assert.deepEqual(await anonymous.json(), { detail: "請先登入 ChatGPT" });
  assert.equal(outsider instanceof Response, true);
  assert.equal(outsider.status, 403);
  assert.deepEqual(await outsider.json(), { detail: "你沒有 CSD 存取權限" });
});

test("permits only viewer read routes and leaves Sites sign-in paths available", () => {
  assert.deepEqual(
    authorizeCsdRequest(signedIn("/api/parts", "viewer@example.com"), env),
    { role: "viewer", email: "viewer@example.com" },
  );
  const write = authorizeCsdRequest(signedIn("/api/production-orders", "viewer@example.com", "POST"), env);
  const fullExport = authorizeCsdRequest(signedIn("/api/data/export/current.zip", "viewer@example.com"), env);

  assert.equal(write instanceof Response, true);
  assert.equal(write.status, 403);
  assert.equal(fullExport instanceof Response, true);
  assert.equal(fullExport.status, 403);
  assert.equal(authorizeCsdRequest(new Request("https://csd.test/signin-with-chatgpt"), env), null);
  assert.equal(authorizeCsdRequest(new Request("https://csd.test/callback"), env), null);
});

test("returns only the authenticated viewer session", async () => {
  const response = await handleCsdApi(
    new Request("https://csd.test/api/session"),
    {},
    { role: "viewer", email: "viewer@example.com" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { role: "viewer", email: "viewer@example.com" });
});
