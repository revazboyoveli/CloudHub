import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CloudUpload, Folder, Home, Lock, Loader2, X, AlertCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { api, setCredentials, uploadFile, UnauthorizedError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatSize, storageMeta, FileGlyph } from "./utils";

export function NameDialog({ open, onOpenChange, title, description, initial = "", cta, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; initial?: string; cta: string;
  onSubmit: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>
        <form onSubmit={async (e) => { e.preventDefault(); if (!name.trim()) return; setBusy(true); try { await onSubmit(name.trim()); onOpenChange(false); } finally { setBusy(false); } }}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className="h-11" />
          <DialogFooter className="mt-5">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={busy || !name.trim()}>{busy && <Loader2 className="animate-spin" />}{cta}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MoveDialog({ open, onOpenChange, title, excludeId, onSubmit }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; excludeId?: number; onSubmit: (target: number | null) => Promise<void>;
}) {
  const { data = [] } = useQuery({ queryKey: ["folders-all"], queryFn: api.allFolders, enabled: open });
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const opts = [{ id: null as number | null, path: "My Drive (root)" }, ...data.filter((f) => f.id !== excludeId)];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>Choose a destination folder.</DialogDescription></DialogHeader>
        <div className="-mx-2 max-h-72 space-y-0.5 overflow-y-auto px-2">
          {opts.map((o) => (
            <button key={o.id ?? "root"} onClick={() => setSel(o.id)}
              className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors",
                sel === o.id ? "bg-primary/10 text-primary ring-1 ring-primary/30" : "hover:bg-muted")}>
              {o.id == null ? <Home className="size-4 shrink-0" /> : <Folder className="size-4 shrink-0" />}
              <span className="min-w-0 truncate">{o.path}</span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={busy} onClick={async () => { setBusy(true); try { await onSubmit(sel); onOpenChange(false); } finally { setBusy(false); } }}>
            {busy && <Loader2 className="animate-spin" />}Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog({ open, onOpenChange, title, description, cta, onConfirm }: {
  open: boolean; onOpenChange: (o: boolean) => void; title: string; description: string; cta: string; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-2 grid size-11 place-items-center rounded-full bg-destructive/10 text-destructive"><AlertCircle className="size-5" /></div>
          <DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onOpenChange(false); } finally { setBusy(false); } }}>
            {busy && <Loader2 className="animate-spin" />}{cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LoginDialog({ open, onSuccess }: { open: boolean; onSuccess: () => void }) {
  const [u, setU] = useState(""); const [p, setP] = useState("");
  return (
    <Dialog open={open}>
      <DialogContent className="sm:max-w-sm [&>button]:hidden">
        <DialogHeader>
          <div className="mb-2 grid size-11 place-items-center rounded-xl bg-gradient-primary text-primary-foreground shadow-elegant"><Lock className="size-5" /></div>
          <DialogTitle>Sign in to CloudHub</DialogTitle><DialogDescription>Your storage server requires credentials.</DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setCredentials(u, p); onSuccess(); }}>
          <div className="space-y-1.5"><Label htmlFor="u">Username</Label><Input id="u" value={u} onChange={(e) => setU(e.target.value)} autoComplete="username" /></div>
          <div className="space-y-1.5"><Label htmlFor="p">Password</Label><Input id="p" type="password" value={p} onChange={(e) => setP(e.target.value)} autoComplete="current-password" /></div>
          <Button type="submit" className="w-full">Sign in</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface QueueItem { id: string; file: File; progress: number; state: "queued" | "uploading" | "done" | "duplicate" | "error" }

export function UploadDialog({ open, onOpenChange, folderId, folderName, initialFiles, onUploaded, onUnauthorized }: {
  open: boolean; onOpenChange: (o: boolean) => void; folderId: number | null; folderName: string; initialFiles: File[];
  onUploaded: () => void; onUnauthorized: () => void;
}) {
  const { data: storages = [] } = useQuery({ queryKey: ["storages"], queryFn: api.storages });
  const uploadStorages = storages.filter((s) => s.key !== "local");
  const [storage, setStorage] = useState<string>("");
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [drag, setDrag] = useState(false);
  const [running, setRunning] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!storage) {
      const s = uploadStorages.find((x) => x.enabled);
      if (s) setStorage(s.key);
    }
  }, [uploadStorages, storage]);
  useEffect(() => { if (open) { setQueue([]); if (initialFiles.length) add(initialFiles); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  function add(files: FileList | File[]) {
    setQueue((q) => [...q, ...Array.from(files).map((file) => ({ id: `${file.name}-${file.size}-${Math.random()}`, file, progress: 0, state: "queued" as const }))]);
  }
  async function start() {
    setRunning(true);
    for (const item of queue.filter((q) => q.state === "queued")) {
      setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, state: "uploading" } : x)));
      try {
        const r = await uploadFile(item.file, storage, folderId, (pct) => setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, progress: pct } : x))));
        setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, progress: 100, state: r.status === "duplicate" ? "duplicate" : "done" } : x)));
      } catch (e) {
        if (e instanceof UnauthorizedError) { setRunning(false); onUnauthorized(); return; }
        setQueue((q) => q.map((x) => (x.id === item.id ? { ...x, state: "error" } : x)));
      }
    }
    setRunning(false);
    onUploaded();
  }
  const pending = queue.filter((q) => q.state === "queued").length;

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader><DialogTitle>Upload files</DialogTitle><DialogDescription>To <span className="font-medium text-foreground">{folderName}</span></DialogDescription></DialogHeader>

        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">Where to store?</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {uploadStorages.map((s) => {
              const m = storageMeta(s.key);
              return (
                <button key={s.key} disabled={!s.enabled} onClick={() => setStorage(s.key)}
                  className={cn("relative flex items-center gap-2.5 rounded-xl border p-3 text-left text-sm transition-all",
                    !s.enabled && "cursor-not-allowed opacity-50",
                    storage === s.key ? "border-primary bg-primary/5 ring-2 ring-primary/20" : "hover:border-primary/40")}>
                  <span className={cn("size-2.5 shrink-0 rounded-full", m.dot)} />
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{s.label}</span>
                    {!s.enabled && <span className="block text-[11px] text-muted-foreground">Coming soon</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files); }}
          onClick={() => input.current?.click()}
          className={cn("grid cursor-pointer place-items-center rounded-2xl border-2 border-dashed px-6 py-9 text-center transition-colors",
            drag ? "border-primary bg-primary/5" : "border-border hover:border-primary/50 hover:bg-muted/50")}>
          <div className="mb-3 grid size-12 place-items-center rounded-2xl bg-primary/10 text-primary"><CloudUpload className="size-6" /></div>
          <p className="text-sm font-medium">Drop files here or <span className="text-primary">browse</span></p>
          <p className="mt-1 text-xs text-muted-foreground">Videos, photos and documents — any size</p>
          <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files) add(e.target.files); e.target.value = ""; }} />
        </div>

        {queue.length > 0 && (
          <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
            {queue.map((q) => (
              <div key={q.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-xl border bg-card p-2.5">
                <div className="grid size-9 place-items-center rounded-lg bg-muted text-muted-foreground"><FileGlyph mime={q.file.type} className="size-4" /></div>
                <div className="min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium">{q.file.name}</p>
                    <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                      {q.state === "done" ? "Done" : q.state === "duplicate" ? "Duplicate" : q.state === "error" ? "Failed" : q.state === "uploading" ? `${q.progress}%` : formatSize(q.file.size)}
                    </span>
                  </div>
                  <Progress value={q.progress} className="mt-1.5 h-1" />
                </div>
                {q.state === "done" ? <CheckCircle2 className="size-4 text-local" />
                  : q.state === "queued" ? <button onClick={() => setQueue((x) => x.filter((i) => i.id !== q.id))} className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
                  : q.state === "uploading" ? <Loader2 className="size-4 animate-spin text-primary" />
                  : <AlertCircle className={cn("size-4", q.state === "error" ? "text-destructive" : "text-drive")} />}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" disabled={running} onClick={() => onOpenChange(false)}>Close</Button>
          <Button disabled={!pending || running || !storage} onClick={start}>
            {running && <Loader2 className="animate-spin" />}Upload {pending > 0 && `${pending} file${pending > 1 ? "s" : ""}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}