# CSD 備品管理系統

這是一套備品規劃工具，集中管理料號、RMA 趨勢、CSD／海外庫存、在途量、待投產與缺料建議。正式資料保存在 Sites 的 D1 與 R2；本機 FastAPI／SQLite 啟動方式僅保留作為歷史開發參考。

## 系統版本控管

- 程式功能版本目前為 **v0.2.2**；變更內容記錄於 `CHANGELOG.md`。
- RMA、庫存與料號資料版本請在系統內的「資料版本」查看或還原；不會與程式版本混在一起。
- 可用 `./scripts/system-version.sh status` 檢查程式是否有變更、`history` 查看歷史、`snapshot "變更說明"` 建立版本。上傳資料、資料庫、原始 Excel 與密碼檔均不會納入系統版本庫。

## 啟動方式

首次使用時，建立 Python 環境並安裝套件：

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
npm install
```

接著在兩個終端機分別啟動後端與畫面：

```bash
.venv/bin/python backend/main.py
```

```bash
npm run dev
```

開啟畫面後，到「資料匯入」先下載對應的 `.xlsx` 範本，再分別更新 RMA、庫存或料號主檔。

## 規劃邏輯

- 每月需求 = `1M RMA × 40% + 3M 月均 × 30% + 6M 月均 × 20% + 12M 月均 × 10%`
- 目標庫存 = 每月需求 × 6 個月；安全庫存 = 每月需求 × 3 個月。
- CSD 可用量 = CSD 庫存 + 在途量 + 已提出／生產中的待投產量。
- 海外／客戶倉庫庫存只顯示，不會抵扣 CSD 缺料。
- 料號可覆寫每月需求、安全庫存或覆蓋月數。

## 資料與匯入

- 不提供「初始完整檔」上傳項目；請使用系統範本分別上傳 RMA、庫存或料號主檔。RMA 可選完整覆蓋或增量新增；庫存可選完整快照或指定倉庫更新。
- 匯入前會檢查必填欄、重複欄名、日期、數量與未知料號。阻擋錯誤不可匯入，提醒項目會在確認前列出。
- 每個成功版本以 `VYYMMDD`（例如 `V260731`）命名，保存原始 Excel、上傳時間、操作人員、資料摘要與提醒。可在「資料版本」搜尋版本、下載原始檔或該版的標準資料檔、回復任一版本；回復不影響待生產需求與人工設定。
- 待生產需求採可回復刪除；草稿可自由填寫備註，其他狀態必須填入日期和備註，系統會將日期記錄在備註前方。
- 可從「資料匯入」下載目前有效資料包與空白範本；可從總覽或料號規劃下載目前缺料清單 CSV。
- 匯入上限為 `.xlsx` 2 MiB、10,000 筆非空資料列，以及 2 MiB 的啟用版本 JSON snapshot。這是以目前 5,996 筆、約 264 KB 的 RMA 基準檔設計；超出時會在解析或啟用前拒絕，不支援任意大的檔案。
- 啟用的刪除、寫入與版本更新會維持在一個 D1 `batch()`，避免拆批而破壞資料啟用原子性。R2 與 D1 沒有跨服務交易：一般 R2 寫入或 D1 啟用失敗會補償刪除原始物件及 pending 版本；若補償刪除本身失敗，版本會標為隱藏的 `failed` 並保存物件鍵供管理員清理。若這個最後的 D1 failed-status 寫入也失敗，pending 列仍不會出現在成功版本查詢中，但可能需要從 R2 `originals/<versionId>/` 人工追查及清理物件。

## Sites 部署與存取

- CSD 使用公開網址，讓受邀同事可到達 ChatGPT 登入入口；未登入、未列入白名單或未通過角色檢查者不會取得 CSD 資料。
- Sites 的執行環境必須設定 `CSD_ADMIN_EMAIL`（唯一管理者）與 `CSD_VIEWER_EMAILS`（以逗號分隔的檢視者 Email）。兩者缺漏時系統會拒絕所有 CSD 資料請求。
- 管理者可使用完整功能；檢視者只能讀取總覽、料號、待生產需求與缺料 CSV，不能匯入、修改、刪除、回復或下載完整資料版本。
- 要增減檢視者時，請更新 Sites 的 `CSD_VIEWER_EMAILS` 執行環境值，並重新部署已核准版本；不可把白名單寫入前端程式碼或 `.openai/hosting.json`。
- D1 是正式營運資料的權威儲存，包括料號、庫存、RMA、出貨、待生產需求與資料版本中繼資料。
- R2 保存每次成功匯入的原始 Excel 與可下載資料檔，供版本追溯與回復使用。
- 現有 FastAPI／SQLite 本機啟動方式僅保留至遷移資料核對通過為止，之後不再作為正式資料來源。

### 首版資料遷移 dry-run

在私人 Sites 部署完成前，只執行本機 dry-run：

```bash
node work/migrate-csd-v022-to-sites.mjs --dry-run
node --test tests/migration-parity.test.mjs
```

工具只讀取 `/Users/jesse/Desktop/CSD管理系統/CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx`，並將核對報告寫入 `/Users/jesse/Desktop/CSD管理系統/work/migration-reports/v022-dry-run.json`。報告中的 `target` 是尚未部署前的預估筆數，不代表 D1/R2 已寫入或已完成線上核對。

首版整合遷移只在已更新到本版本、仍是 owner-only 的 Sites 發布上可用。Worker 的私有端點是 `POST /api/admin/migrations/v0.2.2`；它只接受原始 XLSX bytes（不能是一般匯入 multipart），並同時要求 `x-csd-migration-contract: csd-baseline-v022-1`、固定檔名、Office XLSX MIME type 和固定 SHA-256。檔案上限是 512 KiB；它會重新解析四張既有工作表，要求 `120 / 124 / 5,996 / 98` 筆。任何檔名、內容類型、雜湊、大小或筆數不符都會在 D1/R2 寫入前拒絕。

由於這是同一份 Excel 同時提供料號、庫存、RMA 與出貨，Worker 不會分成四次公開匯入。它先在 R2 暫存原始檔與 pending version，再用一個 D1 `batch()` 同時建立單次遷移鎖、批次記錄、四個資料集合和 active version；lock 的 D1 trigger 是 batch 的第一個寫入，會在任何 delete 前 atomically 拒絕已有營運資料的目標。若 D1 回應不明確，Worker 會先核對版本與遷移鎖的實際狀態；只有確認仍為 pending 且未啟用時才補償移除暫存物件，無法確認時會保留原檔與版本供檢查。`baseline_migrations` 的主鍵會拒絕第二次套用。原始檔會保留在 R2；首版整合版本只提供原始檔與核對結果，不可錯當成單一類型版本回復。

在部署已套用至 `drizzle/0003_stock_identity.sql` 後，建立一份**未提交**的 private deployment contract；它不含任何憑證。0003 會標準化既有庫存的廠別／儲位鍵值，並安全加總可能折疊為同一鍵值的舊列：

```json
{
  "version": "csd-owner-only-v1",
  "endpoint": "https://owner-only-sites-origin.example",
  "privateAccess": { "provider": "cloudflare-access", "ownerOnly": true },
  "unauthenticatedHealthCheck": { "path": "/api/health", "deniedStatuses": [401, 403] },
  "migrationApi": { "contractPath": "/api/admin/migrations/v0.2.2/contract" }
}
```

僅在 owner-only Sites URL 已發布且確認 Access 沒有任何群組或其他使用者後，才從本機執行。先在 Codex 中以 `generate_siwc_bypass_token` 取得該 private Sites origin 的 bypass token；只取得不帶 `Bearer ` 前綴的 token 值，且不要把它儲存到任何檔案。接著**單獨執行**下列 `read`；出現提示後再輸入該 token。`-s` 使輸入不回顯，值不會成為命令列或 shell history 的一部分：

```zsh
read -r -s 'CSD_OWNER_MIGRATION_AUTHORIZATION?Owner-only Sites bypass token（不回顯）：'
```

接著執行下列區塊。授權值只會在子 shell 的環境中提供給遷移工具；區塊結束後再從目前 shell 移除。不要把值寫入 private deployment contract、暫存檔、原始碼或任何命令列參數：

```zsh
printf '\n'
(
  export CSD_OWNER_MIGRATION_AUTHORIZATION
  node work/migrate-csd-v022-to-sites.mjs --apply \
    --endpoint https://owner-only-sites-origin.example \
    --private-deployment-contract /absolute/path/private-deployment.json
)
unset CSD_OWNER_MIGRATION_AUTHORIZATION
```

`--apply` 會從 `CSD_OWNER_MIGRATION_AUTHORIZATION` 環境變數讀取 bypass token，不接受把憑證放進 CLI 參數；它會為每個已驗證的私有 API 請求建立 `OAI-Sites-Authorization: Bearer <token>`。它先以未驗證 `GET /api/health` 確認 Access 確實拒絕，再以 owner-only Sites bypass 取得已部署 Worker 的 contract；只有它完全符合固定 v0.2.2 契約時，工具才會讀取**唯一**的 `/Users/jesse/Desktop/CSD管理系統/CSD_spare_parts_control_2026-07-31_v0.2.2.xlsx`、驗證雜湊與筆數、POST 原始 bytes，最後抓取 `/reconciliation`。若 POST 已成功但回應遺失，同一來源與遷移的重試會在 `409` 後以完整 reconciliation 收斂；來源、遷移身分、版本代碼、筆數或固定 dashboard 基準任一不符都不會寫入套用報告。核對成功後才寫入 `work/migration-reports/v022-applied.json`。工具拒絕 localhost、IP、非 HTTPS、帶路徑 URL、`trycloudflare.com` tunnel、公開或 contract 不符的來源；不可改用既有公開 tunnel。

## 開發驗證

```bash
npm run build
```
