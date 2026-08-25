"use client";

import { DragEvent, FormEvent, useEffect, useMemo, useState } from "react";

const API = "/api";
type Part = Record<string, string | number | null>;
type Dashboard = { metrics: Record<string, number>; priority_parts: Part[]; recent_import?: { filename: string; created_at: string; data_type?: string } | null; production_orders: ProductionOrder[] };
type ProductionOrder = { id: number; material_number: string; suggested_qty: number; confirmed_qty: number | null; expected_date: string | null; status: string; notes: string | null; updated_at: string; deleted_at?: string | null; deleted_by?: string | null };
type DataKind = "rma" | "inventory" | "master";
type ImportPreview = { filename: string; summary: Record<string, number | string | null>; errors: string[]; warnings: string[]; scope?: string[]; canCommit?: boolean };
type UploadStep = "select" | "checking" | "review" | "committing" | "complete";
type Version = { id: number; version_code: string; label: string; data_type: string; import_mode: string; filename: string; created_at: string; created_by: string; summary: Record<string, number>; warnings: string[]; errors: string[]; scope: string[]; restored_from_id?: number | null; has_original: boolean; has_data_download: boolean };
type Session = { email: string; role: "admin" | "viewer" };

const quantity = (value: unknown) => new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 1 }).format(Number(value || 0));
const dateText = (value?: string | null) => value ? new Date(value).toLocaleDateString("zh-TW") : "—";

export default function Home() {
  const [tab, setTab] = useState<"dashboard" | "parts" | "production" | "import" | "versions">("dashboard");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [parts, setParts] = useState<Part[]>([]);
  const [sites, setSites] = useState<string[]>([]);
  const [orders, setOrders] = useState<ProductionOrder[]>([]);
  const [deletedOrders, setDeletedOrders] = useState<ProductionOrder[]>([]);
  const [search, setSearch] = useState("");
  const [site, setSite] = useState("");
  const [onlyShortage, setOnlyShortage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadStep, setUploadStep] = useState<UploadStep>("select");
  const [uploadError, setUploadError] = useState("");
  const [completedVersionCode, setCompletedVersionCode] = useState("");
  const [dataKind, setDataKind] = useState<DataKind>("rma");
  const [importMode, setImportMode] = useState("full");
  const [operator, setOperator] = useState("本機使用者");
  const [versions, setVersions] = useState<Version[]>([]);
  const [settingsPart, setSettingsPart] = useState<Part | null>(null);

  const [session, setSession] = useState<Session | null>(null);

  const loadSession = async (): Promise<Session> => {
    const res = await fetch(`${API}/session`);
    if (res.status === 401 || res.status === 403) throw new Error("你沒有 CSD 存取權限，請使用已核准的 ChatGPT 帳號登入。");
    if (!res.ok) throw new Error("無法確認登入權限");
    const current = await res.json() as Session;
    setSession(current);
    return current;
  };

  const loadDashboard = async () => {
    const res = await fetch(`${API}/dashboard`);
    if (!res.ok) throw new Error("無法讀取儀表板資料");
    const data = await res.json(); setDashboard(data); setOrders(data.production_orders || []);
  };
  const loadParts = async () => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (site) params.set("site", site);
    if (onlyShortage) params.set("only_shortage", "true");
    const res = await fetch(`${API}/parts?${params}`);
    if (!res.ok) throw new Error("無法讀取料號資料");
    const data = await res.json(); setParts(data.items || []); setSites(data.sites || []);
  };
  const loadOrders = async () => {
    const res = await fetch(`${API}/production-orders`);
    if (!res.ok) throw new Error("無法讀取生產需求");
    setOrders(await res.json());
  };
  const loadDeletedOrders = async () => {
    const res = await fetch(`${API}/production-orders/deleted`);
    if (!res.ok) throw new Error("無法讀取已刪除需求");
    setDeletedOrders(await res.json());
  };
  const loadVersions = async (): Promise<Version[]> => {
    const res = await fetch(`${API}/data/versions`);
    if (!res.ok) throw new Error("無法讀取資料版本");
    const data = await res.json(); const items = data.items || []; setVersions(items); return items;
  };
  const refresh = async () => {
    setLoading(true);
    try {
      const current = await loadSession();
      const requests: Promise<unknown>[] = [loadDashboard(), loadParts(), loadOrders()];
      if (current.role === "admin") requests.push(loadDeletedOrders(), loadVersions());
      await Promise.all(requests);
    }
    catch (error) { setNotice(error instanceof Error ? error.message : "系統連線發生問題"); }
    finally { setLoading(false); }
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => { const handle = setTimeout(loadParts, 220); return () => clearTimeout(handle); }, [search, site, onlyShortage]);

  const topParts = useMemo(() => dashboard?.priority_parts || [], [dashboard]);
  const isAdmin = session?.role === "admin";
  const createProduction = async (part: Part) => {
    const res = await fetch(`${API}/production-orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ material_number: part.material_number, suggested_qty: part.suggested_production, confirmed_qty: part.suggested_production, status: "草稿" }) });
    if (!res.ok) { setNotice("建立待生產需求失敗"); return; }
    setNotice(`已為 ${part.material_number} 建立待生產需求`); await refresh(); setTab("production");
  };
  const updateOrder = async (order: ProductionOrder, status: string, expected_date: string, notes: string) => {
    const res = await fetch(`${API}/production-orders/${order.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, expected_date: expected_date || null, notes }) });
    const data = await res.json();
    if (!res.ok) { setNotice(data.detail || "更新生產需求失敗"); return; }
    setNotice(`已更新 ${order.material_number} 的狀態`); await refresh();
  };
  const deleteOrder = async (order: ProductionOrder) => {
    if (!window.confirm(`確定刪除 ${order.material_number} 的待生產需求？可從「已刪除需求」回復。`)) return;
    const res = await fetch(`${API}/production-orders/${order.id}`, { method: "DELETE" });
    if (!res.ok) { setNotice("刪除待生產需求失敗"); return; }
    setNotice(`已刪除 ${order.material_number} 的待生產需求`); await refresh();
  };
  const restoreDeletedOrder = async (order: ProductionOrder) => {
    const res = await fetch(`${API}/production-orders/${order.id}/restore`, { method: "POST" });
    if (!res.ok) { setNotice("回復待生產需求失敗"); return; }
    setNotice(`已回復 ${order.material_number} 的待生產需求`); await refresh();
  };
  useEffect(() => { setPreview(null); setSelectedFile(null); setUploadError(""); setUploadStep("select"); setCompletedVersionCode(""); setImportMode("full"); }, [dataKind]);
  const changeImportMode = (nextMode: string) => {
    if (nextMode === importMode) return;
    setImportMode(nextMode);
    setPreview(null); setSelectedFile(null); setUploadError(""); setUploadStep("select"); setCompletedVersionCode("");
  };
  const previewFile = async (file: File | null) => {
    if (!file) return;
    setPreview(null); setUploadError(""); setCompletedVersionCode(""); setSelectedFile(file);
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      setUploadStep("select"); setUploadError("請選擇 .xlsx Excel 檔案。"); return;
    }
    const form = new FormData(); form.append("file", file);
    form.append("data_type", dataKind); form.append("mode", importMode);
    setUploadStep("checking");
    try {
      const res = await fetch(`${API}/data/preview`, { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) { setUploadStep("select"); setUploadError(data.detail || "檔案檢查失敗"); return; }
      setPreview({ ...data, warnings: data.warnings || [], errors: data.errors || [] });
      setUploadStep("review");
    } catch {
      setUploadStep("select"); setUploadError("檔案檢查失敗，請稍後再試。");
    }
  };
  const rejectUploadFile = (message: string) => {
    setUploadStep("select"); setUploadError(message);
  };
  const commitImport = async () => {
    if (!selectedFile || !preview || preview.canCommit === false || preview.errors.length > 0) return;
    const form = new FormData(); form.append("file", selectedFile);
    form.append("data_type", dataKind); form.append("mode", importMode); form.append("operator", operator || "本機使用者");
    setUploadError(""); setUploadStep("committing");
    try {
      const res = await fetch(`${API}/data/commit`, { method: "POST", body: form }); const data = await res.json();
      if (!res.ok) { setUploadStep("review"); setUploadError(data.detail || "匯入失敗"); return; }
      setSelectedFile(null); setUploadStep("complete");
      await refresh();
      try {
        const refreshedVersions = await loadVersions();
        const version = refreshedVersions.find((item) => item.id === data.version_id);
        setCompletedVersionCode(version?.version_code || `第 ${data.version_id} 筆資料版本`);
      } catch {
        setCompletedVersionCode(`第 ${data.version_id} 筆資料版本`);
      }
    } catch {
      setUploadStep("review"); setUploadError("匯入失敗，請稍後再試。");
    }
  };
  const restoreVersion = async (version: Version) => {
    if (!window.confirm(`確定回復「${version.label} ${version.version_code}」？待生產需求與人工設定會保留。`)) return;
    const form = new FormData(); form.append("operator", operator || "本機使用者");
    const res = await fetch(`${API}/data/versions/${version.id}/restore`, { method: "POST", body: form }); const data = await res.json();
    if (!res.ok) { setNotice(data.detail || "回復版本失敗"); return; }
    setNotice(data.message || "已回復資料版本"); await refresh();
  };
  const saveSettings = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!settingsPart) return;
    const form = new FormData(event.currentTarget);
    const res = await fetch(`${API}/parts/${encodeURIComponent(String(settingsPart.material_number))}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ target_months: Number(form.get("target_months")), safety_months: Number(form.get("safety_months")), demand_override: form.get("demand_override") ? Number(form.get("demand_override")) : null, safety_override: form.get("safety_override") ? Number(form.get("safety_override")) : null, notes: String(form.get("notes") || "") }) });
    if (!res.ok) { setNotice("料號設定儲存失敗"); return; }
    setSettingsPart(null); setNotice("料號設定已更新"); await refresh();
  };

  return <main>
    <header className="topbar"><div className="brand"><span className="brand-mark">CSD</span><span>備品管理系統<small>Spare parts control · protected access</small></span></div><div className="top-meta">{dashboard?.recent_import ? <>最近匯入：{dashboard.recent_import.filename}<br />{dateText(dashboard.recent_import.created_at)}</> : "尚未匯入資料"}<br />{session && <><small>已登入：{session.email} · {isAdmin ? "管理者" : "檢視者"}</small><br /><a href="/signout-with-chatgpt?return_to=/">登出</a></>}</div></header>
    <div className="app-shell">
      <aside className="sidebar"><div className="nav-label">工作區</div>
        <Nav icon="▦" label="總覽" active={tab === "dashboard"} onClick={() => setTab("dashboard")} />
        <Nav icon="⌁" label="料號規劃" active={tab === "parts"} onClick={() => setTab("parts")} />
        <Nav icon="▣" label="待生產需求" active={tab === "production"} onClick={() => setTab("production")} />
        {isAdmin && <Nav icon="↑" label="資料匯入" active={tab === "import"} onClick={() => setTab("import")} />}
        {isAdmin && <Nav icon="↺" label="資料版本" active={tab === "versions"} onClick={() => setTab("versions")} />}
        <div className="sidebar-foot"><span className="dot" />登入保護 · 系統 v0.2.2<br /><small>{isAdmin ? "管理權限" : "檢視權限"}</small></div>
      </aside>
      <section className="content">
        {notice && <div className="notice"><span>{notice}</span><button onClick={() => setNotice("")}>×</button></div>}
        {loading ? <div className="loading-card">正在讀取 CSD 資料…</div> : <>
          {tab === "dashboard" && <DashboardView dashboard={dashboard} topParts={topParts} canManage={isAdmin} onPlan={createProduction} onParts={() => setTab("parts")} onImport={() => setTab("import")} />}
          {tab === "parts" && <PartsView parts={parts} sites={sites} search={search} site={site} onlyShortage={onlyShortage} canManage={isAdmin} onSearch={setSearch} onSite={setSite} onShortage={setOnlyShortage} onPlan={createProduction} onSettings={setSettingsPart} />}
          {tab === "production" && <ProductionView orders={orders} deletedOrders={deletedOrders} canManage={isAdmin} onSave={updateOrder} onDelete={deleteOrder} onRestore={restoreDeletedOrder} />}
          {isAdmin && tab === "import" && <ImportView dataKind={dataKind} mode={importMode} operator={operator} preview={preview} selectedFile={selectedFile} uploadStep={uploadStep} uploadError={uploadError} completedVersionCode={completedVersionCode} onKind={setDataKind} onMode={changeImportMode} onOperator={setOperator} onFile={previewFile} onReject={rejectUploadFile} onCommit={commitImport} onVersions={() => setTab("versions")} onStartOver={() => { setPreview(null); setUploadError(""); setCompletedVersionCode(""); setUploadStep("select"); }} />}
          {isAdmin && tab === "versions" && <VersionsView versions={versions} operator={operator} onOperator={setOperator} onRestore={restoreVersion} />}
        </>}
      </section>
    </div>
    {isAdmin && settingsPart && <SettingsModal part={settingsPart} onClose={() => setSettingsPart(null)} onSubmit={saveSettings} />}
  </main>;
}

function Nav({ icon, label, active, onClick }: { icon: string; label: string; active: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}><span>{icon}</span>{label}</button>; }
function Metric({ label, value, suffix = "", tone = "" }: { label: string; value: number; suffix?: string; tone?: string }) { return <div className={`metric ${tone}`}><span>{label}</span><strong>{quantity(value)}<em>{suffix}</em></strong></div>; }

function DashboardView({ dashboard, topParts, canManage, onPlan, onParts, onImport }: { dashboard: Dashboard | null; topParts: Part[]; canManage: boolean; onPlan: (p: Part) => void; onParts: () => void; onImport: () => void }) {
  if (!dashboard?.recent_import) return <div className="empty-state"><div className="empty-symbol">↑</div><h1>先匯入目前的備品資料</h1><p>上傳既有 Excel 後，系統會建立料號、RMA、庫存與生產規劃。</p>{canManage ? <button className="primary" onClick={onImport}>前往資料匯入</button> : <p>請聯絡管理者匯入資料。</p>}</div>;
  const m = dashboard.metrics;
  return <><div className="page-title"><div><p className="eyebrow">CSD PLANNING OVERVIEW</p><h1>備品供應總覽</h1><p>依近期 RMA、CSD 庫存與供應狀況，優先處理安全庫存缺口。</p></div><a className="outline" href={`${API}/export/shortages.csv`}>下載缺料清單</a></div>
    <div className="metrics-grid"><Metric label="需處理缺料料號" value={m.shortage_part_count} suffix="項" tone="danger"/><Metric label="CSD 安全庫存缺口" value={m.shortage_qty} suffix="PCS" tone="danger"/><Metric label="在途補給" value={m.in_transit_qty} suffix="PCS"/><Metric label="待投產數量" value={m.pending_production_qty} suffix="PCS"/></div>
    <div className="section-head"><div><h2>優先處理料號</h2><p>依安全庫存缺口與近期需求排序</p></div><button className="text-button" onClick={onParts}>查看全部料號 →</button></div>
    <div className="table-card"><table><thead><tr><th>料號 / 機種</th><th>Site</th><th>近期需求</th><th>CSD 可用</th><th>安全庫存</th><th>缺料量</th><th>建議生產</th>{canManage && <th />}</tr></thead><tbody>{topParts.map(p => <tr key={String(p.material_number)}><td><strong>{p.material_number}</strong><small>{p.model || "未設定機種"}</small></td><td>{p.site}</td><td>{quantity(p.monthly_demand)} / 月</td><td>{quantity(p.available_csd)}</td><td>{quantity(p.safety_stock)}</td><td><b className={Number(p.shortage_qty) > 0 ? "bad" : "good"}>{quantity(p.shortage_qty)}</b></td><td>{quantity(p.suggested_production)}</td>{canManage && <td><button className="row-action" disabled={!Number(p.suggested_production)} onClick={() => onPlan(p)}>建立需求</button></td>}</tr>)}</tbody></table></div>
  </>;
}

function PartsView({ parts, sites, search, site, onlyShortage, canManage, onSearch, onSite, onShortage, onPlan, onSettings }: { parts: Part[]; sites: string[]; search: string; site: string; onlyShortage: boolean; canManage: boolean; onSearch: (x: string) => void; onSite: (x: string) => void; onShortage: (x: boolean) => void; onPlan: (x: Part) => void; onSettings: (x: Part) => void }) {
  return <><div className="page-title"><div><p className="eyebrow">PARTS PLANNING</p><h1>料號與缺料規劃</h1><p>海外庫存僅供參考，不會抵扣 CSD 缺料。</p></div><a className="outline" href={`${API}/export/shortages.csv`}>匯出缺料 CSV</a></div>
    <div className="filters"><input aria-label="搜尋料號" placeholder="搜尋料號、Site 或機種" value={search} onChange={e => onSearch(e.target.value)} /><select aria-label="選擇 Site" value={site} onChange={e => onSite(e.target.value)}><option value="">全部 Site</option>{sites.map(s => <option key={s}>{s}</option>)}</select><label className="check"><input type="checkbox" checked={onlyShortage} onChange={e => onShortage(e.target.checked)} />只看缺料</label><span className="result-count">{parts.length} 個料號</span></div>
    <div className="table-card wide"><table><thead><tr><th>料號 / 機種</th><th>Site</th><th>RMA 1M</th><th>RMA 3M</th><th>RMA 6M</th><th>RMA 12M</th><th>月需求</th><th>CSD</th><th>海外</th><th>在途</th><th>待投產</th><th>安全庫存</th><th>缺料</th><th>建議生產</th>{canManage && <th />}</tr></thead><tbody>{parts.map(p => <tr key={String(p.material_number)}><td><strong>{p.material_number}</strong><small>{p.model || "未設定"}</small></td><td>{p.site}</td><td>{p.rma_1m}</td><td>{p.rma_3m}</td><td>{p.rma_6m}</td><td>{p.rma_12m}</td><td>{quantity(p.monthly_demand)}</td><td>{quantity(p.csd_stock)}</td><td className="muted">{quantity(p.overseas_stock)}</td><td>{quantity(p.in_transit)}</td><td>{quantity(p.pending_production)}</td><td>{quantity(p.safety_stock)}</td><td><b className={Number(p.shortage_qty) > 0 ? "bad" : "good"}>{quantity(p.shortage_qty)}</b></td><td>{quantity(p.suggested_production)}</td>{canManage && <td className="actions"><button className="icon-button" title="設定" onClick={() => onSettings(p)}>⋯</button><button className="row-action" disabled={!Number(p.suggested_production)} onClick={() => onPlan(p)}>建立</button></td>}</tr>)}</tbody></table>{!parts.length && <div className="no-results">沒有符合條件的料號。</div>}</div>
  </>;
}

function ProductionView({ orders, deletedOrders, canManage, onSave, onDelete, onRestore }: { orders: ProductionOrder[]; deletedOrders: ProductionOrder[]; canManage: boolean; onSave: (order: ProductionOrder, status: string, expectedDate: string, notes: string) => void; onDelete: (order: ProductionOrder) => void; onRestore: (order: ProductionOrder) => void }) {
  return <><div className="page-title"><div><p className="eyebrow">PRODUCTION REQUESTS</p><h1>待生產需求</h1><p>{canManage ? "草稿可直接填寫備註；其他狀態必須填寫日期與備註，日期會一併記錄在備註中。" : "檢視目前待生產需求與處理進度。"}</p></div></div><div className="table-card"><table><thead><tr><th>料號</th><th>建議 / 確認量</th><th>狀態與日期</th><th>備註</th>{canManage && <th />}</tr></thead><tbody>{orders.map(order => <ProductionOrderRow key={order.id} order={order} canManage={canManage} onSave={onSave} onDelete={onDelete} />)}</tbody></table>{!orders.length && <div className="no-results">尚未建立待生產需求。</div>}</div>{canManage && <details className="deleted-orders"><summary>已刪除需求（{deletedOrders.length}）</summary>{deletedOrders.length ? <div className="table-card"><table><thead><tr><th>料號</th><th>狀態</th><th>刪除時間</th><th>備註</th><th /></tr></thead><tbody>{deletedOrders.map(order => <tr key={order.id}><td><strong>{order.material_number}</strong></td><td>{order.status}</td><td>{dateText(order.deleted_at)}</td><td>{order.notes || "—"}</td><td><button className="row-action" onClick={() => onRestore(order)}>回復</button></td></tr>)}</tbody></table></div> : <p className="muted">目前沒有已刪除需求。</p>}</details>}</>;
}

function ProductionOrderRow({ order, canManage, onSave, onDelete }: { order: ProductionOrder; canManage: boolean; onSave: (order: ProductionOrder, status: string, expectedDate: string, notes: string) => void; onDelete: (order: ProductionOrder) => void }) {
  const [status, setStatus] = useState(order.status);
  const [expectedDate, setExpectedDate] = useState(order.expected_date || "");
  const [notes, setNotes] = useState(order.notes || "");
  useEffect(() => { setStatus(order.status); setExpectedDate(order.expected_date || ""); setNotes(order.notes || ""); }, [order.status, order.expected_date, order.notes]);
  const needsDate = status !== "草稿";
  if (!canManage) return <tr><td><strong>{order.material_number}</strong><small>更新於 {dateText(order.updated_at)}</small></td><td>{quantity(order.suggested_qty)} / {order.confirmed_qty === null ? "—" : quantity(order.confirmed_qty)} PCS</td><td>{order.status}{order.expected_date && <small>{dateText(order.expected_date)}</small>}</td><td>{order.notes || "—"}</td></tr>;
  return <tr><td><strong>{order.material_number}</strong><small>更新於 {dateText(order.updated_at)}</small></td><td>{quantity(order.suggested_qty)} / {order.confirmed_qty === null ? "—" : quantity(order.confirmed_qty)} PCS</td><td><select value={status} aria-label="更新狀態" onChange={event => setStatus(event.target.value)}>{["草稿", "已提出", "生產中", "已完成", "取消"].map(value => <option key={value}>{value}</option>)}</select>{needsDate && <input className="inline-date" type="date" value={expectedDate} onChange={event => setExpectedDate(event.target.value)} required />}</td><td><textarea className="inline-note" value={notes} placeholder={needsDate ? "必填：此狀態說明" : "草稿備註（可填寫）"} onChange={event => setNotes(event.target.value)} required={needsDate} /></td><td className="actions"><button className="row-action" onClick={() => onSave(order, status, expectedDate, notes)}>儲存</button><button className="danger-button" onClick={() => onDelete(order)}>刪除</button></td></tr>;
}

function ImportView({ dataKind, mode, operator, preview, selectedFile, uploadStep, uploadError, completedVersionCode, onKind, onMode, onOperator, onFile, onReject, onCommit, onVersions, onStartOver }: { dataKind: DataKind; mode: string; operator: string; preview: ImportPreview | null; selectedFile: File | null; uploadStep: UploadStep; uploadError: string; completedVersionCode: string; onKind: (kind: DataKind) => void; onMode: (mode: string) => void; onOperator: (name: string) => void; onFile: (file: File | null) => void; onReject: (message: string) => void; onCommit: () => void; onVersions: () => void; onStartOver: () => void }) {
  const details = dataKind === "rma" ? "必填：RMA日期、料號；可選擇完整覆蓋或增量新增。" : dataKind === "inventory" ? "必填：倉庫、料號、數量；完整快照或指定倉庫更新。" : "必填：料號；可更新 Site、機種、PN Key、在途與待投產。";
  const template = `${API}/data/templates/${dataKind}`;
  const [dragging, setDragging] = useState(false);
  const currentStep = uploadStep === "select" ? 1 : uploadStep === "checking" ? 2 : uploadStep === "review" ? 3 : 4;
  const canCommit = Boolean(preview && preview.canCommit !== false && preview.errors.length === 0);
  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault(); setDragging(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) { onReject("一次只能拖放一個 .xlsx Excel 檔案。"); return; }
    onFile(files[0]);
  };
  return <><div className="page-title"><div><p className="eyebrow">VERSIONED DATA IMPORT</p><h1>資料更新與匯入</h1><p>每次確認匯入都會建立可下載、可回復的版本；資料日期採實際上傳時間。</p></div><a className="outline" href={`${API}/data/export/current.zip`}>下載目前完整資料</a></div>
    <div className="import-layout"><div className="import-card"><ol className="import-steps" aria-label="資料匯入步驟">{["選擇資料類型與方式", "拖放 Excel 檔案", "檢查結果", "確認建立版本"].map((label, index) => <li key={label} className={currentStep > index + 1 ? "done" : currentStep === index + 1 ? "active" : ""}><span>{index + 1}</span>{label}</li>)}</ol>
    <section className="import-stage" aria-label="步驟一：選擇資料類型與方式"><h2>選擇資料類型與方式</h2><div className="data-tabs">
      {([ ["rma", "RMA 更新"], ["inventory", "庫存更新"], ["master", "料號主檔"] ] as [DataKind, string][]).map(([kind, label]) => <button key={kind} type="button" className={dataKind === kind ? "selected" : ""} onClick={() => onKind(kind)}>{label}</button>)}
    </div><div className="import-guidance"><strong>{`${dataKind === "rma" ? "RMA" : dataKind === "inventory" ? "庫存" : "料號主檔"} 更新檔`}</strong><p>{details}</p><a className="text-button" href={template}>下載空白上傳範本 ↓</a></div>
    {dataKind === "rma" && <label className="field-label">匯入方式<select value={mode} disabled={uploadStep === "checking" || uploadStep === "committing"} onChange={event => onMode(event.target.value)}><option value="full">完整覆蓋（此檔為完整 RMA 歷史）</option><option value="incremental">增量新增（只加入尚未存在的資料）</option></select></label>}
    {dataKind === "inventory" && <label className="field-label">匯入方式<select value={mode} disabled={uploadStep === "checking" || uploadStep === "committing"} onChange={event => onMode(event.target.value)}><option value="full">完整快照（取代所有倉庫）</option><option value="partial">指定倉庫更新（其他倉庫維持不變）</option></select></label>}
    <label className="field-label">操作人員<input value={operator} onChange={event => onOperator(event.target.value)} placeholder="本機使用者" /></label></section>
    {uploadStep !== "complete" && <section className="import-stage" aria-label="步驟二：選擇檔案"><h2>拖放或選擇 Excel 檔案</h2><label className={`upload-zone${dragging ? " dragging" : ""}${uploadError ? " invalid" : ""}`} onDragOver={event => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={handleDrop}><input type="file" className="visually-hidden-file-input" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-label="選擇 Excel 檔案" onChange={event => onFile(event.target.files?.[0] || null)} /><span className="upload-icon">↑</span><strong>{selectedFile ? selectedFile.name : "拖放 Excel 檔案，或按此選擇"}</strong><small>只接受一個 .xlsx 檔案，請使用系統下載的範本。</small></label>{uploadError && <p className="upload-error" role="alert">{uploadError}</p>}{uploadStep === "checking" && <p className="upload-busy" role="status">正在檢查檔案…</p>}</section>}
    {(uploadStep === "review" || uploadStep === "committing") && preview && <section className="preview import-stage" aria-label="步驟三：檢查結果"><div><h2>檢查結果</h2><p>{preview.filename}</p></div><div className="preview-grid"><span>可匯入筆數 <b>{quantity(preview.summary.records ?? preview.summary.rma_records ?? 0)}</b></span><span>影響倉庫 <b>{preview.scope?.length ? preview.scope.join("、") : "全部資料"}</b></span><span>阻擋錯誤 <b>{quantity(preview.summary.errors ?? preview.errors.length)}</b></span><span>提醒 <b>{quantity(preview.summary.warnings ?? preview.warnings.length)}</b></span></div>{preview.errors.length > 0 && <details open className="validation-errors"><summary>需修正的問題（{preview.errors.length}）</summary><ul>{preview.errors.map(error => <li key={error}>{error}</li>)}</ul></details>}{preview.warnings.length > 0 && <details><summary>匯入提醒（{preview.warnings.length}）</summary><ul>{preview.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details>}<div className="commit-actions"><div><h2>確認建立版本</h2><p>確認後會保存原始檔並建立可回復版本。</p></div><button className="primary" disabled={!canCommit || uploadStep === "committing"} onClick={onCommit}>{uploadStep === "committing" ? "正在建立版本…" : "確認並建立新版本"}</button></div></section>}
    {uploadStep === "complete" && <section className="import-success" role="status"><h2>已建立資料版本</h2><p>版本代號：<strong>{completedVersionCode}</strong></p><p>目前資料與版本紀錄已重新整理。</p><div className="commit-actions"><button className="outline" type="button" onClick={onStartOver}>匯入其他資料</button><button className="primary" type="button" onClick={onVersions}>前往資料版本</button></div></section>}
    </div><aside className="import-side"><h2>更新原則</h2><p>版本名稱為 V+上傳年月日，例如 V260731。檔案不會被修改，並會保存原始檔、檢查結果、上傳時間與操作人員。</p><p>需要撤回或查詢過去上傳資料時，請到「資料版本」。</p></aside></div></>;
}

function VersionsView({ versions, operator, onOperator, onRestore }: { versions: Version[]; operator: string; onOperator: (name: string) => void; onRestore: (version: Version) => void }) {
  const [search, setSearch] = useState("");
  const [dataType, setDataType] = useState("");
  const keyword = search.trim().toLowerCase();
  const results = versions.filter(version => (!dataType || version.data_type === dataType) && (!keyword || [version.version_code, version.filename, version.created_by, version.label].join(" ").toLowerCase().includes(keyword)));
  const modeLabel = (mode: string) => mode === "full" ? "完整覆蓋" : mode === "incremental" ? "增量新增" : mode === "partial" ? "指定倉庫" : mode === "restore" ? "回復版本" : mode;
  return <><div className="page-title"><div><p className="eyebrow">DATA VERSION HISTORY</p><h1>資料版本紀錄</h1><p>版本以 V+年月日（6 碼）命名；可查詢、下載歷史資料或回復舊版。</p></div><a className="outline" href={`${API}/data/export/current.zip`}>下載目前完整資料</a></div><div className="version-toolbar"><label>搜尋版本、檔名或人員<input value={search} placeholder="例如 V260731" onChange={event => setSearch(event.target.value)} /></label><label>資料類型<select value={dataType} onChange={event => setDataType(event.target.value)}><option value="">全部類型</option><option value="rma">RMA</option><option value="inventory">庫存</option><option value="master">料號主檔</option></select></label><label>回復操作人員<input value={operator} onChange={event => onOperator(event.target.value)} /></label><span>{results.length} / {versions.length} 個版本</span></div><div className="table-card"><table><thead><tr><th>版本 / 類型</th><th>檔案與方式</th><th>上傳時間 / 人員</th><th>資料摘要</th><th>範圍／提醒</th><th /></tr></thead><tbody>{results.map(version => <tr key={version.id}><td><strong>{version.version_code} · {version.label}</strong><small>{version.restored_from_id ? `回復自第 ${version.restored_from_id} 筆紀錄` : "一般匯入"}</small></td><td>{version.filename}<small>{modeLabel(version.import_mode)}</small></td><td>{dateText(version.created_at)}<small>{version.created_by}</small></td><td>{quantity(version.summary.records ?? 0)} 筆<small>{version.errors.length ? `${version.errors.length} 項錯誤` : version.warnings.length ? `${version.warnings.length} 項提醒` : "檢查通過"}</small></td><td>{version.scope?.length ? version.scope.join("、") : "全部資料"}<small>{version.warnings[0] || "—"}</small></td><td className="actions">{version.has_original && <a className="row-action" href={`${API}/data/versions/${version.id}/file`}>原始檔</a>}{version.has_data_download && <a className="row-action" href={`${API}/data/versions/${version.id}/data`}>完整資料</a>}<button className="row-action" onClick={() => onRestore(version)}>回復此版</button></td></tr>)}</tbody></table>{!results.length && <div className="no-results">沒有符合條件的資料版本。</div>}</div></>;
}

function SettingsModal({ part, onClose, onSubmit }: { part: Part; onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) { return <div className="modal-backdrop"><form className="modal" onSubmit={onSubmit}><button type="button" className="close" onClick={onClose}>×</button><p className="eyebrow">PART SETTINGS</p><h2>{part.material_number}</h2><p>{part.site} · {part.model}</p><div className="form-grid"><label>目標覆蓋月數<input name="target_months" type="number" min="0" step="0.5" defaultValue={String(part.target_months ?? 6)} /></label><label>安全庫存月數<input name="safety_months" type="number" min="0" step="0.5" defaultValue={String(part.safety_months ?? 3)} /></label><label>覆寫每月需求<input name="demand_override" type="number" min="0" step="0.1" placeholder={`目前 ${part.monthly_demand}`} /></label><label>覆寫安全庫存<input name="safety_override" type="number" min="0" step="0.1" placeholder={`目前 ${part.safety_stock}`} /></label></div><label>備註<textarea name="notes" defaultValue={String(part.notes || "")} /></label><p className="formula">預設需求 = 1M×40% + 3M月均×30% + 6M月均×20% + 12M月均×10%</p><button className="primary" type="submit">儲存設定</button></form></div>; }
