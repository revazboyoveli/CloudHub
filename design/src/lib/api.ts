// API client for the CloudHub storage backend.
// Falls back to an in-memory demo store when no backend answers, so the UI stays usable in preview.

export type StorageKey = "local" | "drive" | "telegram" | (string & {});
export interface Storage { key: StorageKey; label: string; enabled: boolean }
export interface FolderItem { id: number; name: string; files: number; folders: number }
export interface FileItem {
  id: number; folder_id: number | null; name: string; size: number; mime: string;
  storage: StorageKey; created_at: string; preview?: string;
}
export interface ListResponse {
  folder: number | null;
  breadcrumb: { id: number; name: string }[];
  folders: FolderItem[];
  files: FileItem[];
}
export interface FolderPath { id: number; path: string }
export interface IntegrationsStatus {
  local: { enabled: boolean };
  telegram: { enabled: boolean };
  drive: { enabled: boolean; has_config?: boolean };
}

export const API_BASE: string = (import.meta.env["VITE_API_BASE_URL"] as string | undefined) ?? "";
const AUTH_KEY = "cloudhub_auth";

export class UnauthorizedError extends Error { constructor() { super("unauthorized"); } }

let demoMode = false;
export const isDemoMode = () => demoMode;

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const t = sessionStorage.getItem(AUTH_KEY);
  return t ? { Authorization: `Basic ${t}` } : {};
}
export function setCredentials(user: string, pass: string) {
  sessionStorage.setItem(AUTH_KEY, btoa(`${user}:${pass}`));
}
export function authQuery(): string {
  if (typeof window === "undefined") return "";
  const t = sessionStorage.getItem(AUTH_KEY);
  return t ? `auth=${encodeURIComponent(t)}` : "";
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (demoMode) return demo<T>(path, init);
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        ...(init.body && typeof init.body === "string" ? { "Content-Type": "application/json" } : {}),
        ...authHeader(),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    demoMode = true;
    return demo<T>(path, init);
  }
  if (res.status === 401) throw new UnauthorizedError();
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("application/json")) {
    if (!API_BASE) { demoMode = true; return demo<T>(path, init); }
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return {} as T;
  }
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data;
}

export const api = {
  storages: () => request<Storage[]>("/api/storages"),
  integrationsStatus: () => request<IntegrationsStatus>("/api/integrations/status"),
  list: (folder: number | null) => request<ListResponse>(folder == null ? "/api/list" : `/api/list?folder=${folder}`),
  allFolders: () => request<FolderPath[]>("/api/folders/all"),
  createFolder: (name: string, parent_id: number | null) =>
    request<{ id: number }>("/api/folders", { method: "POST", body: JSON.stringify({ name, parent_id }) }),
  updateFolder: (id: number, body: { name?: string; parent_id?: number | null }) =>
    request<{ ok: true }>(`/api/folders/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteFolder: (id: number) => request<{ ok: true }>(`/api/folders/${id}`, { method: "DELETE" }),
  updateFile: (id: number, body: { name?: string; folder_id?: number | null }) =>
    request<{ ok: true }>(`/api/files/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteFile: (id: number) => request<{ ok: true }>(`/api/files/${id}`, { method: "DELETE" }),

  // Telegram auth & import
  telegramAuthStart: (body: { api_id: number; api_hash: string; phone: string }) =>
    request<{
      status: "code_sent" | "select_channel";
      channels?: { id: string; title: string; type: string }[];
    }>("/api/telegram/auth/start", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  telegramAuthVerify: (body: { code: string; password?: string }) =>
    request<{
      status: "2fa_required" | "select_channel";
      channels?: { id: string; title: string; type: string }[];
    }>("/api/telegram/auth/verify", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  telegramSelectChannel: (body: { channel_id: string }) =>
    request<{ status: "authorized" }>("/api/telegram/auth/channel", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  telegramImport: (folder_id: number | null) =>
    request<{ added: number; total: number }>("/api/telegram/import", {
      method: "POST",
      body: JSON.stringify({ folder_id }),
    }),

  // Google Drive auth & import
  driveAuthStart: (body: { client_id?: string; client_secret?: string; redirect_uri: string }) =>
    request<{ auth_url: string }>("/api/drive/auth/start", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  driveImport: (folder_id: number | null) =>
    request<{ added: number; total: number }>("/api/drive/import", {
      method: "POST",
      body: JSON.stringify({ folder_id }),
    }),
};

export function contentUrl(f: FileItem, download = false) {
  if (demoMode) return f.preview ?? "";
  return `${API_BASE}/api/files/${f.id}/content${download ? "?download=1" : ""}`;
}

export function uploadFile(
  file: File, storage: string, folderId: number | null, onProgress: (pct: number) => void,
): Promise<{ status: string; id?: number }> {
  if (demoMode) {
    return new Promise((resolve) => {
      let p = 0;
      const t = setInterval(() => {
        p = Math.min(100, p + 8 + Math.random() * 18);
        onProgress(Math.round(p));
        if (p >= 100) {
          clearInterval(t);
          const id = nextId++;
          db.files.push({ id, folder_id: folderId, name: file.name, size: file.size, mime: file.type || "application/octet-stream", storage, created_at: now(), preview: URL.createObjectURL(file) });
          resolve({ status: "ok", id });
        }
      }, 120);
    });
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/upload`);
    const h = authHeader();
    if (h["Authorization"]) xhr.setRequestHeader("Authorization", h["Authorization"]);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      if (xhr.status === 401) return reject(new UnauthorizedError());
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); } catch { resolve({ status: "ok" }); }
      } else reject(new Error(`Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error"));
    const fd = new FormData();
    fd.append("file", file);
    fd.append("storage", storage);
    if (folderId != null) fd.append("folder_id", String(folderId));
    xhr.send(fd);
  });
}

// Demo store
function now() { return new Date().toISOString().slice(0, 19).replace("T", " "); }
interface DemoFolder { id: number; name: string; parent_id: number | null }
let nextId = 100;
const img = (seed: string) => `https://picsum.photos/seed/${seed}/1200/800`;
const db: { folders: DemoFolder[]; files: FileItem[] } = {
  folders: [
    { id: 1, name: "Travel", parent_id: null },
    { id: 2, name: "Batumi", parent_id: 1 },
    { id: 3, name: "Tbilisi", parent_id: 1 },
    { id: 4, name: "Work", parent_id: null },
    { id: 5, name: "Design assets", parent_id: 4 },
    { id: 6, name: "Family", parent_id: null },
  ],
  files: [
    { id: 10, folder_id: null, name: "Sunset_over_sea.jpg", size: 4_812_330, mime: "image/jpeg", storage: "drive", created_at: "2026-11-18 19:02:11", preview: img("sea") },
    { id: 11, folder_id: null, name: "Mountain_drive.mp4", size: 182_402_144, mime: "video/mp4", storage: "telegram", created_at: "2026-11-19 10:14:50", preview: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
    { id: 12, folder_id: null, name: "Q4_report.pdf", size: 1_204_992, mime: "application/pdf", storage: "local", created_at: "2026-11-17 08:41:00" },
    { id: 13, folder_id: null, name: "Old_town.jpg", size: 6_102_400, mime: "image/jpeg", storage: "local", created_at: "2026-11-20 12:20:33", preview: img("town") },
    { id: 14, folder_id: null, name: "Forest_trail.jpg", size: 3_402_120, mime: "image/jpeg", storage: "telegram", created_at: "2026-11-15 16:05:12", preview: img("forest") },
    { id: 15, folder_id: null, name: "Interview_raw.mov", size: 1_402_000_000, mime: "video/quicktime", storage: "drive", created_at: "2026-11-12 09:00:00", preview: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
    { id: 16, folder_id: 1, name: "Boarding_pass.png", size: 402_120, mime: "image/png", storage: "local", created_at: "2026-11-10 07:30:00", preview: img("plane") },
    { id: 17, folder_id: 2, name: "Boulevard.jpg", size: 5_002_120, mime: "image/jpeg", storage: "telegram", created_at: "2026-11-11 18:35:54", preview: img("boulevard") },
    { id: 18, folder_id: 2, name: "Beach_timelapse.mp4", size: 45_219_840, mime: "video/mp4", storage: "telegram", created_at: "2026-11-11 19:12:01", preview: "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" },
    { id: 19, folder_id: 5, name: "Brand_guidelines.pdf", size: 12_402_120, mime: "application/pdf", storage: "drive", created_at: "2026-11-09 11:11:11" },
    { id: 20, folder_id: 6, name: "Birthday.jpg", size: 3_902_120, mime: "image/jpeg", storage: "local", created_at: "2026-11-08 20:20:20", preview: img("party") },
  ],
};

function pathOf(id: number): string {
  const parts: string[] = [];
  let cur = db.folders.find((f) => f.id === id);
  while (cur) { parts.unshift(cur.name); const p = cur.parent_id; cur = p == null ? undefined : db.folders.find((f) => f.id === p); }
  return parts.join(" / ");
}
function removeFolder(id: number) {
  db.folders.filter((f) => f.parent_id === id).forEach((f) => removeFolder(f.id));
  db.folders = db.folders.filter((f) => f.id !== id);
  db.files = db.files.filter((f) => f.folder_id !== id);
}

async function demo<T>(path: string, init: RequestInit): Promise<T> {
  await new Promise((r) => setTimeout(r, 120));
  const method = init.method ?? "GET";
  const body = init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  const url = new URL(path, "http://x");
  const p = url.pathname;
  const out = (v: unknown) => structuredClone(v) as T;
  if (p === "/api/storages") return out([
    { key: "telegram", label: "Telegram", enabled: true },
    { key: "local", label: "Home drive", enabled: true },
    { key: "drive", label: "Google Drive", enabled: false },
  ]);
  if (p === "/api/integrations/status") return out({
    local: { enabled: true },
    telegram: { enabled: true },
    drive: { enabled: false, has_config: false },
  });
  if (p === "/api/list") {
    const fq = url.searchParams.get("folder");
    const folder = fq ? Number(fq) : null;
    const breadcrumb: { id: number; name: string }[] = [];
    let cur = folder == null ? undefined : db.folders.find((f) => f.id === folder);
    while (cur) { breadcrumb.unshift({ id: cur.id, name: cur.name }); const pid = cur.parent_id; cur = pid == null ? undefined : db.folders.find((f) => f.id === pid); }
    return out({
      folder, breadcrumb,
      folders: db.folders.filter((f) => f.parent_id === folder).map((f) => ({
        id: f.id, name: f.name,
        files: db.files.filter((x) => x.folder_id === f.id).length,
        folders: db.folders.filter((x) => x.parent_id === f.id).length,
      })),
      files: db.files.filter((f) => f.folder_id === folder),
    });
  }
  if (p === "/api/folders/all") return out(db.folders.map((f) => ({ id: f.id, path: pathOf(f.id) })).sort((a, b) => a.path.localeCompare(b.path)));
  if (p === "/api/folders" && method === "POST") {
    const id = nextId++;
    db.folders.push({ id, name: String(body["name"]), parent_id: (body["parent_id"] as number | null) ?? null });
    return out({ id });
  }
  const fm = p.match(/^\/api\/folders\/(\d+)$/);
  if (fm) {
    const id = Number(fm[1]);
    if (method === "DELETE") removeFolder(id);
    else { const f = db.folders.find((x) => x.id === id); if (f) { if ("name" in body) f.name = String(body["name"]); if ("parent_id" in body) f.parent_id = body["parent_id"] as number | null; } }
    return out({ ok: true });
  }
  const fi = p.match(/^\/api\/files\/(\d+)$/);
  if (fi) {
    const id = Number(fi[1]);
    if (method === "DELETE") db.files = db.files.filter((f) => f.id !== id);
    else { const f = db.files.find((x) => x.id === id); if (f) { if ("name" in body) f.name = String(body["name"]); if ("folder_id" in body) f.folder_id = body["folder_id"] as number | null; } }
    return out({ ok: true });
  }
  if (p === "/api/telegram/import" || p === "/api/drive/import") {
    await new Promise((r) => setTimeout(r, 800));
    const fid = (body["folder_id"] as number | null) ?? null;
    const storage = p.includes("drive") ? "drive" : "telegram";
    const id = nextId++;
    db.files.push({ id, folder_id: fid, name: `${storage}_media_${id}.jpg`, size: 2_400_000, mime: "image/jpeg", storage, created_at: now(), preview: img(`${storage}${id}`) });
    return out({ added: 1, total: db.files.filter((f) => f.storage === storage).length });
  }
  throw new Error("Not found");
}