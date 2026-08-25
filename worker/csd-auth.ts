export type CsdRole = "admin" | "viewer";

export type CsdAccess = {
  email: string;
  role: CsdRole;
};

export type CsdAccessEnv = {
  CSD_ADMIN_EMAIL?: string;
  CSD_VIEWER_EMAILS?: string;
};

const AUTH_PATHS = new Set(["/signin-with-chatgpt", "/signout-with-chatgpt", "/callback"]);
const STATIC_PATH_PREFIXES = ["/_next/", "/_vinext/", "/assets/"];
const VIEWER_API_PATHS = new Set([
  "/api/session",
  "/api/dashboard",
  "/api/parts",
  "/api/production-orders",
  "/api/export/shortages.csv",
]);

function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function json(detail: string, status: number): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function isStaticPath(pathname: string): boolean {
  return pathname === "/favicon.svg" || STATIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function isViewerApiRequest(request: Request, pathname: string): boolean {
  return request.method === "GET" && VIEWER_API_PATHS.has(pathname);
}

export function resolveCsdAccess(request: Request, env: CsdAccessEnv): CsdAccess | null {
  const email = normalizeEmail(request.headers.get("oai-authenticated-user-email"));
  const admin = normalizeEmail(env.CSD_ADMIN_EMAIL);
  const viewers = new Set(
    (env.CSD_VIEWER_EMAILS ?? "")
      .split(",")
      .map(normalizeEmail)
      .filter((candidate): candidate is string => Boolean(candidate)),
  );

  if (!email || !admin || viewers.size === 0) return null;
  if (email === admin) return { email, role: "admin" };
  return viewers.has(email) ? { email, role: "viewer" } : null;
}

export function authorizeCsdRequest(request: Request, env: CsdAccessEnv): CsdAccess | Response | null {
  const url = new URL(request.url);
  if (AUTH_PATHS.has(url.pathname) || isStaticPath(url.pathname)) return null;

  const access = resolveCsdAccess(request, env);
  if (url.pathname.startsWith("/api/")) {
    if (!access) {
      return request.headers.has("oai-authenticated-user-email")
        ? json("你沒有 CSD 存取權限", 403)
        : json("請先登入 ChatGPT", 401);
    }
    if (access.role === "viewer" && !isViewerApiRequest(request, url.pathname)) {
      return json("此帳號僅有檢視權限", 403);
    }
    return access;
  }

  if (access) return access;
  if (request.headers.has("oai-authenticated-user-email")) {
    return new Response("你沒有 CSD 存取權限", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  const returnTo = `${url.pathname}${url.search}`;
  return Response.redirect(new URL(`/signin-with-chatgpt?return_to=${encodeURIComponent(returnTo)}`, url), 302);
}
