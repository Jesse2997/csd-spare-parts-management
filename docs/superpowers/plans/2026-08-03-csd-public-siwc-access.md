# CSD Public ChatGPT Sign-in Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish CSD at a public Sites URL while admitting only the owner as administrator and four named colleagues as read-only viewers after ChatGPT sign-in.

**Architecture:** Add a small Worker-side authorization module that reads the Sites-provided authenticated email header and the two runtime policy values. The Worker will redirect anonymous browser requests to the Sites-owned sign-in route, reject unauthorized API calls before CSD handlers run, and pass an authenticated role to a minimal session endpoint used by the React client to hide administrator controls.

**Tech Stack:** TypeScript, Cloudflare Worker runtime, vinext, React 19, Node test runner, OpenAI Sites runtime environment values.

## Global Constraints

- The Sites audience becomes public only after build and access checks pass.
- `CSD_ADMIN_EMAIL` is the sole administrator; `CSD_VIEWER_EMAILS` is a comma-separated viewer allowlist.
- Normalize addresses with trim plus lowercase comparison and fail closed when policy configuration is incomplete.
- Every `/api/` response must be protected at the Worker boundary; client-side hidden controls are never authorization.
- Viewers may read dashboard, parts, active production orders, and the shortage CSV only.
- No new database tables, R2 objects, or application-owned password/OAuth stack are introduced.

---

### Task 1: Define and test the Worker authorization policy

**Files:**
- Create: `worker/csd-auth.ts`
- Create: `tests/csd-auth.test.mjs`

**Interfaces:**
- Produces `type CsdRole = "admin" | "viewer"` and `type CsdAccess = { role: CsdRole; email: string }`.
- Produces `resolveCsdAccess(request: Request, env: CsdAccessEnv): CsdAccess | null`.
- Produces `authorizeCsdRequest(request: Request, env: CsdAccessEnv): Response | CsdAccess | null`, where `null` means an allowlisted static or Sites-owned authentication path may continue without application access.
- Consumes `CSD_ADMIN_EMAIL` and `CSD_VIEWER_EMAILS` from the Worker environment and `oai-authenticated-user-email` from Sites.

- [ ] **Step 1: Write the failing policy tests**

```js
import assert from "node:assert/strict";
import test from "node:test";
import { authorizeCsdRequest, resolveCsdAccess } from "../worker/csd-auth.ts";

const env = {
  CSD_ADMIN_EMAIL: "owner@example.com",
  CSD_VIEWER_EMAILS: "viewer@example.com, Other@Example.com ",
};
const signedIn = (path, email, method = "GET") => new Request(`https://csd.test${path}`, {
  method, headers: { "oai-authenticated-user-email": email },
});

test("normalizes an allowlisted administrator and viewer", () => {
  assert.deepEqual(resolveCsdAccess(signedIn("/", " OWNER@example.com "), env), { role: "admin", email: "owner@example.com" });
  assert.deepEqual(resolveCsdAccess(signedIn("/", "other@example.com"), env), { role: "viewer", email: "other@example.com" });
});

test("redirects anonymous browser navigation but returns 401 for anonymous API requests", async () => {
  const page = authorizeCsdRequest(new Request("https://csd.test/?tab=parts"), env);
  const api = authorizeCsdRequest(new Request("https://csd.test/api/dashboard"), env);
  assert.equal(page instanceof Response, true);
  assert.match(page.headers.get("location") ?? "", /^\/signin-with-chatgpt\?return_to=/);
  assert.equal((api instanceof Response) && api.status, 401);
});

test("denies unknown accounts and viewer mutation routes", async () => {
  const viewerRead = authorizeCsdRequest(signedIn("/api/parts", "viewer@example.com"), env);
  const denied = authorizeCsdRequest(signedIn("/api/dashboard", "outsider@example.com"), env);
  const viewerWrite = authorizeCsdRequest(signedIn("/api/production-orders", "viewer@example.com", "POST"), env);
  const fullExport = authorizeCsdRequest(signedIn("/api/data/export/current.zip", "viewer@example.com"), env);
  assert.deepEqual(viewerRead, { role: "viewer", email: "viewer@example.com" });
  assert.equal((denied instanceof Response) && denied.status, 403);
  assert.equal((viewerWrite instanceof Response) && viewerWrite.status, 403);
  assert.equal((fullExport instanceof Response) && fullExport.status, 403);
});
```

- [ ] **Step 2: Run the policy tests and verify the expected failure**

Run: `node --test tests/csd-auth.test.mjs`

Expected: FAIL because `worker/csd-auth.ts` does not exist.

- [ ] **Step 3: Implement the minimal policy module**

```ts
export type CsdRole = "admin" | "viewer";
export type CsdAccess = { role: CsdRole; email: string };
export type CsdAccessEnv = { CSD_ADMIN_EMAIL?: string; CSD_VIEWER_EMAILS?: string };

export function resolveCsdAccess(request: Request, env: CsdAccessEnv): CsdAccess | null {
  const email = normalizeEmail(request.headers.get("oai-authenticated-user-email"));
  const admin = normalizeEmail(env.CSD_ADMIN_EMAIL);
  const viewers = new Set((env.CSD_VIEWER_EMAILS ?? "").split(",").map(normalizeEmail).filter(Boolean));
  if (!email || !admin || !viewers.size) return null;
  if (email === admin) return { role: "admin", email };
  return viewers.has(email) ? { role: "viewer", email } : null;
}
```

Implement route classification in the same file: all API requests require an access result; viewers may use only `GET /api/session`, `GET /api/dashboard`, `GET /api/parts`, `GET /api/production-orders`, and `GET /api/export/shortages.csv`; all other API paths return JSON `403`. An anonymous non-API navigation redirects to `/signin-with-chatgpt?return_to=<encoded same-origin path and query>`. Allow Sites-owned `/signin-with-chatgpt`, `/signout-with-chatgpt`, and `/callback` routes through unchanged so sign-in cannot loop.

- [ ] **Step 4: Run the policy tests and verify they pass**

Run: `node --test tests/csd-auth.test.mjs`

Expected: PASS; the assertions demonstrate normalization, anonymous handling, deny-by-default behavior, and viewer write denial.

- [ ] **Step 5: Commit the authorization module and tests**

```bash
git add worker/csd-auth.ts tests/csd-auth.test.mjs
git commit -m "feat: add CSD ChatGPT access policy"
```

### Task 2: Enforce the policy in the Worker and expose the safe session record

**Files:**
- Modify: `worker/index.ts:1-47`
- Modify: `worker/csd-api.ts:844-889`
- Modify: `tests/csd-auth.test.mjs`

**Interfaces:**
- Consumes `authorizeCsdRequest(request, env)` from `worker/csd-auth.ts`.
- Extends `handleCsdApi(request, env, access)` with the optional trusted `CsdAccess` supplied only by the Worker.
- Produces `GET /api/session` JSON `{ email: string, role: "admin" | "viewer" }` for authorized users.

- [ ] **Step 1: Add a failing session-endpoint test**

```js
import { handleCsdApi } from "../worker/csd-api.ts";

test("returns only the authenticated viewer session", async () => {
  const response = await handleCsdApi(
    new Request("https://csd.test/api/session"),
    {},
    { role: "viewer", email: "viewer@example.com" },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { role: "viewer", email: "viewer@example.com" });
});
```

- [ ] **Step 2: Run the focused test and verify it fails before the session route exists**

Run: `node --test tests/csd-auth.test.mjs`

Expected: FAIL with a `404` response because `/api/session` is not yet implemented.

- [ ] **Step 3: Integrate the guard and session endpoint**

```ts
// worker/index.ts, before handleCsdApi
const access = authorizeCsdRequest(request, env);
if (access instanceof Response) return access;
if (url.pathname.startsWith("/api/")) {
  if (!access) return new Response("Unauthorized", { status: 401 });
  return handleCsdApi(request, env, access);
}
```

Extend `Env` with optional `CSD_ADMIN_EMAIL` and `CSD_VIEWER_EMAILS`. In `csd-api.ts`, import `CsdAccess`, require it as the third parameter, and add the first API route:

```ts
if (request.method === "GET" && url.pathname === "/api/session") {
  return json({ email: access.email, role: access.role });
}
```

Retain direct unit tests of `handleCsdApi` by allowing its third parameter to be optional only for test-only direct invocation; do not use that optional path from the Worker. Do not add a session route that returns the allowlist or any runtime configuration.

- [ ] **Step 4: Run focused and existing API tests**

Run: `node --test tests/csd-auth.test.mjs tests/csd-planning.test.mjs tests/csd-import.test.mjs`

Expected: PASS; existing import and planning behavior remains unchanged when called by their test helpers.

- [ ] **Step 5: Commit Worker enforcement**

```bash
git add worker/index.ts worker/csd-api.ts tests/csd-auth.test.mjs
git commit -m "feat: protect CSD APIs by role"
```

### Task 3: Adapt the CSD client for administrator and viewer sessions

**Files:**
- Modify: `app/page.tsx:1-230`
- Modify: `tests/rendered-html.test.mjs`

**Interfaces:**
- Consumes `GET /api/session` returning `{ email: string, role: "admin" | "viewer" }`.
- Produces role-specific navigation and controls while leaving the Worker as the authorization authority.

- [ ] **Step 1: Add the failing UI source test**

```js
test("renders role-aware CSD controls instead of exposing administrator navigation to every client", async () => {
  const page = await readFile(new URL("app/page.tsx", projectRoot), "utf8");
  assert.match(page, /\/api\/session/);
  assert.match(page, /role === "admin"/);
  assert.match(page, /已登入/);
});
```

- [ ] **Step 2: Run the rendered HTML test and verify it fails**

Run: `node --test tests/rendered-html.test.mjs`

Expected: FAIL because the client does not yet fetch session identity or branch on `role`.

- [ ] **Step 3: Make the minimal UI change**

Add `type Session = { email: string; role: "admin" | "viewer" }`, a `session` state value, and a `loadSession()` function. Include it in the existing initial `refresh()` `Promise.all` call. Render the signed-in email and role in the header plus a `/signout-with-chatgpt?return_to=/` link. Render the 資料匯入 and 資料版本 navigation buttons, version controls, part settings, production create/save/delete/restore controls, and administrator-only export/download controls only when `session?.role === "admin"`. Keep the dashboard, parts, active production-order display, and shortage CSV link available to viewers. If `/api/session` returns `401` or `403`, replace the generic loading error with a clear Chinese access-denied message; do not show any cached data.

- [ ] **Step 4: Run the UI test and build**

Run: `node --test tests/rendered-html.test.mjs && pnpm build`

Expected: PASS and a successful vinext production build.

- [ ] **Step 5: Commit the role-aware client**

```bash
git add app/page.tsx tests/rendered-html.test.mjs
git commit -m "feat: show CSD controls by viewer role"
```

### Task 4: Configure Sites, verify the complete policy, and publish publicly

**Files:**
- Modify: `README.md`

**Interfaces:**
- Documents the required Sites runtime values without putting their values into a browser bundle or `.openai/hosting.json`.
- Reuses the existing Sites project, D1 binding `DB`, and R2 binding `IMPORTS`.

- [ ] **Step 1: Add a failing documentation/source test**

```js
test("documents the two required Sites access-policy variables", async () => {
  const readme = await readFile(new URL("README.md", projectRoot), "utf8");
  assert.match(readme, /CSD_ADMIN_EMAIL/);
  assert.match(readme, /CSD_VIEWER_EMAILS/);
  assert.match(readme, /公開網址/);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `node --test tests/rendered-html.test.mjs`

Expected: FAIL because the runtime access-policy setup is not documented.

- [ ] **Step 3: Document the operational setup and configure runtime values**

Add a README section stating that Sites runtime settings, not source code, hold the administrator and viewer values; list the two variable names and the role behavior. Configure the existing Site with the approved owner address and four viewer addresses. Keep the audience `custom` during this configuration and initial deployment.

- [ ] **Step 4: Run complete verification before publishing**

Run: `node --test tests/*.test.mjs && python3 -m unittest tests/baseline_migration_sql_test.py && pnpm build`

Expected: all Node and Python tests pass and the production build succeeds. Inspect the deployed private Site as the owner: it must identify the owner as 管理者 and continue to load CSD data. Confirm a synthetic anonymous request redirects to the Sites sign-in path and that a viewer write request receives `403` without invoking D1.

- [ ] **Step 5: Deploy the verified version, switch the Sites audience to public, and verify the public boundary**

Save and deploy the validated version using the existing Sites project. Then change its Sites audience to `public`, as explicitly approved, and verify from an unauthenticated request that the public URL redirects to ChatGPT sign-in instead of returning CSD data. Verify an authorized viewer sees only read-only controls and an administrator retains all controls.

- [ ] **Step 6: Commit documentation**

```bash
git add README.md tests/rendered-html.test.mjs
git commit -m "docs: explain CSD public access policy"
```
