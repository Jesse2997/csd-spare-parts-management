import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("ships the CSD management workspace instead of the starter preview", async () => {
  const [page, layout, css] = await Promise.all([
    readFile(new URL("app/page.tsx", projectRoot), "utf8"),
    readFile(new URL("app/layout.tsx", projectRoot), "utf8"),
    readFile(new URL("app/globals.css", projectRoot), "utf8"),
  ]);
  assert.match(page, /備品管理系統/);
  assert.match(page, /data\/preview/);
  assert.match(page, /production-orders/);
  assert.match(page, /選擇資料類型/);
  assert.match(page, /檢查結果/);
  assert.match(page, /確認建立版本/);
  assert.match(page, /拖放 Excel 檔案/);
  assert.match(page, /const changeImportMode = \(nextMode: string\) => \{[\s\S]*setImportMode\(nextMode\);[\s\S]*setPreview\(null\);[\s\S]*setSelectedFile\(null\);[\s\S]*setUploadStep\("select"\);/);
  assert.match(page, /onChange=\{event => onMode\(event\.target\.value\)\}/);
  assert.match(page, /type="file"[^>]*className="visually-hidden-file-input"[^>]*aria-label="選擇 Excel 檔案"/);
  assert.match(layout, /title: "CSD 備品管理系統"/);
  assert.doesNotMatch(page, /SkeletonPreview|codex-preview/);
  assert.match(css, /\.metrics-grid/);
  assert.match(css, /\.table-card/);
  assert.match(css, /\.visually-hidden-file-input\s*\{[\s\S]*position:absolute/);
  assert.doesNotMatch(css, /\.upload-zone input\s*\{\s*display:none/);
  assert.match(css, /\.upload-zone:focus-within/);
});

test("renders role-aware CSD controls instead of exposing administrator navigation to every client", async () => {
  const page = await readFile(new URL("app/page.tsx", projectRoot), "utf8");

  assert.match(page, /\$\{API\}\/session/);
  assert.match(page, /session\?\.role === "admin"/);
  assert.match(page, /已登入/);
  assert.match(page, /signout-with-chatgpt/);
});

test("documents the two required Sites access-policy variables", async () => {
  const readme = await readFile(new URL("README.md", projectRoot), "utf8");

  assert.match(readme, /CSD_ADMIN_EMAIL/);
  assert.match(readme, /CSD_VIEWER_EMAILS/);
  assert.match(readme, /公開網址/);
});
