# CSD public URL with ChatGPT sign-in and roles

## Goal

Publish the existing CSD Site at a public URL while keeping CSD data available
only to five approved ChatGPT accounts. The owner remains an administrator;
four colleagues are read-only viewers.

## Access model

The Sites audience becomes public so an external colleague can reach the sign-in
entry point. The Worker is the authorization boundary:

- Anonymous browser requests to CSD pages redirect to Sites-managed
  `/signin-with-chatgpt` with a same-origin return path.
- Anonymous API requests receive `401` JSON and no CSD data.
- Signed-in accounts outside the allowlist receive `403` JSON or an access
  denied page without revealing the allowlist.
- The administrator account has full existing CSD access.
- Viewer accounts may read dashboard, parts, active production orders, and the
  shortage CSV. All imports, version data/original downloads, settings changes,
  production mutations, and restores are denied.

## Configuration

Sites runtime values hold the policy, rather than browser-delivered code:

- `CSD_ADMIN_EMAIL`: `b5qg5srhsz@privaterelay.appleid.com`
- `CSD_VIEWER_EMAILS`: comma-separated viewer addresses:
  `masterofauxo@gmail.com`, `ifongchiu01@gmail.com`,
  `ntbazz@gmail.com`, and `mingweifang@gmail.com`.

Email comparison is trimmed and case-insensitive. Missing or invalid runtime
configuration fails closed: no CSD page or API data is returned.

## UI and routing

The Worker allows only static assets and Sites-owned sign-in/sign-out/callback
paths through before authentication. It protects HTML application routes and
every `/api/` request. The client reads a small authenticated session endpoint
to show the signed-in account and role, and hides administrator-only navigation
and controls from viewers. Hiding UI is supplementary; the Worker remains the
enforcement point.

## Verification

Automated tests cover email normalization, missing authentication, denied
accounts, viewer read access, viewer mutation denial, and administrator access.
The deployment is tested while private first, with the runtime policy set. Only
after those checks pass is the Sites audience changed to public, as explicitly
authorized for this work.
