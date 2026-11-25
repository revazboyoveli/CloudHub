import { FileText, Film, Image as ImageIcon, FileArchive, Music, File as FileIcon } from "lucide-react";
import type { StorageKey } from "@/lib/api";
import { cn } from "@/lib/utils";

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024; let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}
export function formatDate(s: string) {
  const d = new Date(s.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export const isMedia = (mime: string) => mime.startsWith("video/") || mime.startsWith("image/");

export function FileGlyph({ mime, className }: { mime: string; className?: string }) {
  const Icon = mime.startsWith("video/") ? Film : mime.startsWith("image/") ? ImageIcon : mime.startsWith("audio/") ? Music
    : mime.includes("pdf") || mime.startsWith("text/") ? FileText : mime.includes("zip") ? FileArchive : FileIcon;
  return <Icon className={className} />;
}

const STORAGE: Record<string, { label: string; cls: string; dot: string }> = {
  telegram: { label: "Telegram", cls: "bg-telegram/10 text-telegram ring-telegram/20", dot: "bg-telegram" },
  local: { label: "Home drive", cls: "bg-local/10 text-local ring-local/20", dot: "bg-local" },
  drive: { label: "Google Drive", cls: "bg-drive/10 text-drive ring-drive/25", dot: "bg-drive" },
};
export const storageMeta = (k: StorageKey) => STORAGE[k] ?? { label: k, cls: "bg-muted text-muted-foreground ring-border", dot: "bg-muted-foreground" };

export function StorageBadge({ storage, className }: { storage: StorageKey; className?: string }) {
  const m = storageMeta(storage);
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", m.cls, className)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} />{m.label}
    </span>
  );
}

export function Logo() {
  return (
    <div className="flex items-center gap-2.5">
      <svg viewBox="0 0 64 64" className="size-8 shrink-0 drop-shadow-sm" aria-hidden>
        <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--primary)" /><stop offset="1" stopColor="var(--primary-glow)" /></linearGradient></defs>
        <rect width="64" height="64" rx="16" fill="url(#lg)" />
        <path d="M20 40a8 8 0 0 1 1.6-15.8A11 11 0 0 1 43 26a7 7 0 0 1 1 14Z" fill="var(--background)" />
        <circle cx="44" cy="22" r="5" fill="var(--accent)" />
      </svg>
      <span className="text-[17px] font-semibold tracking-tight">Cloud<span className="text-primary">Hub</span></span>
    </div>
  );
}
