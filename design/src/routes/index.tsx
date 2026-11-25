import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ChevronDown, ChevronRight, CloudUpload, Download, Folder, FolderPlus, FolderInput, Grid2x2, HardDrive, Home, Layers, List,
  Loader2, Menu, MoreHorizontal, Pencil, Play, RefreshCw, Search, Send, Settings2, Sparkles, Trash2, Cloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api, contentUrl, isDemoMode, UnauthorizedError, type FileItem, type FolderItem } from "@/lib/api";
import { cn } from "@/lib/utils";
import { FileGlyph, formatDate, formatSize, isMedia, Logo, StorageBadge, storageMeta } from "@/components/cloudhub/utils";
import { ConfirmDialog, LoginDialog, MoveDialog, NameDialog, UploadDialog } from "@/components/cloudhub/dialogs";
import { ConnectDriveDialog, ConnectTelegramDialog } from "@/components/cloudhub/connect-dialogs";
import { MediaViewer } from "@/components/cloudhub/viewer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "CloudHub — Your files, every cloud, one place" },
      { name: "description", content: "Browse, stream and organise files across Telegram, Google Drive and your home drive in one workspace." },
      { property: "og:title", content: "CloudHub — Your files, every cloud, one place" },
      { property: "og:description", content: "Browse, stream and organise files across Telegram, Google Drive and your home drive." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CloudHub,
});

type Filter = "all" | "telegram" | "local" | "drive";
type Target = { kind: "file"; item: FileItem } | { kind: "folder"; item: FolderItem };

function CloudHub() {
  const qc = useQueryClient();
  const [folderId, setFolderId] = useState<number | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [mobileNav, setMobileNav] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [dropped, setDropped] = useState<File[]>([]);
  const [pageDrag, setPageDrag] = useState(false);
  const [newFolder, setNewFolder] = useState(false);
  const [renaming, setRenaming] = useState<Target | null>(null);
  const [moving, setMoving] = useState<Target | null>(null);
  const [deleting, setDeleting] = useState<Target | null>(null);
  const [viewer, setViewer] = useState<number | null>(null);
  const [importing, setImporting] = useState<"telegram" | "drive" | null>(null);
  const [connectTgOpen, setConnectTgOpen] = useState(false);
  const [connectDriveOpen, setConnectDriveOpen] = useState(false);

  const guard = async <T,>(fn: () => Promise<T>) => {
    try { return await fn(); } catch (e) {
      if (e instanceof UnauthorizedError) setNeedLogin(true); else toast.error(e instanceof Error ? e.message : "Something went wrong");
      throw e;
    }
  };

  const list = useQuery({ queryKey: ["list", folderId], queryFn: () => guard(() => api.list(folderId)), retry: false });
  const tree = useQuery({ queryKey: ["folders-all"], queryFn: () => guard(() => api.allFolders()), retry: false });
  const integrations = useQuery({ queryKey: ["integrations"], queryFn: () => guard(() => api.integrationsStatus()), retry: false });
  const refresh = () => qc.invalidateQueries();

  const tgConnected = integrations.data?.telegram.enabled ?? false;
  const driveConnected = integrations.data?.drive.enabled ?? false;

  const q = search.trim().toLowerCase();
  const folders = (list.data?.folders ?? []).filter((f) => !q || f.name.toLowerCase().includes(q));
  const files = (list.data?.files ?? []).filter((f) => (filter === "all" || f.storage === filter) && (!q || f.name.toLowerCase().includes(q)));
  const media = useMemo(() => files.filter((f) => isMedia(f.mime)), [files]);
  const crumbs = list.data?.breadcrumb ?? [];
  const currentName = crumbs.at(-1)?.name ?? "My Drive";
  const totalSize = files.reduce((s, f) => s + f.size, 0);

  const open = (f: FileItem) => {
    if (isMedia(f.mime)) setViewer(media.findIndex((m) => m.id === f.id));
    else window.open(contentUrl(f, true), "_blank");
  };
  const go = (id: number | null) => { setFolderId(id); setSearch(""); setMobileNav(false); };

  async function runTelegramImport() {
    if (!tgConnected) {
      setConnectTgOpen(true);
      return;
    }
    setImporting("telegram");
    try {
      const r = await guard(() => api.telegramImport(folderId));
      toast.success(`Telegram: Added ${r.added} new file${r.added === 1 ? "" : "s"}`, {
        description: `${r.total} files in the channel`,
      });
      refresh();
    } catch { /* handled */ } finally { setImporting(null); }
  }

  async function runDriveImport() {
    if (!driveConnected) {
      setConnectDriveOpen(true);
      return;
    }
    setImporting("drive");
    try {
      const r = await guard(() => api.driveImport(folderId));
      toast.success(`Google Drive: Added ${r.added} new file${r.added === 1 ? "" : "s"}`, {
        description: `${r.total} files in Drive`,
      });
      refresh();
    } catch { /* handled */ } finally { setImporting(null); }
  }

  const sidebar = (
    <div className="flex h-full flex-col gap-6 p-5">
      <Logo />
      <div className="grid gap-2">
        <Button size="lg" className="h-11 justify-start gap-2.5 bg-gradient-primary shadow-elegant transition-transform hover:scale-[1.01]" onClick={() => { setDropped([]); setUploadOpen(true); }}>
          <CloudUpload className="size-4" />Upload
        </Button>
        <Button size="lg" variant="outline" className="h-11 justify-start gap-2.5 bg-card" onClick={() => setNewFolder(true)}>
          <FolderPlus className="size-4" />New folder
        </Button>
      </div>

      <nav className="grid gap-0.5">
        <p className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Sources</p>
        {([
          ["all", "All files", Layers], ["telegram", "Telegram", Send], ["local", "Home drive", HardDrive], ["drive", "Google Drive", Cloud],
        ] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => { setFilter(k); setMobileNav(false); }}
            className={cn("group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
              filter === k ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground")}>
            <Icon className={cn("size-4", filter === k && "text-primary")} />{label}
            {k !== "all" && <span className={cn("ml-auto size-1.5 rounded-full", storageMeta(k).dot)} />}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="mb-1.5 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Folders</p>
        <button onClick={() => go(null)} className={cn("flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm", folderId == null ? "text-primary" : "text-muted-foreground hover:text-foreground")}>
          <Home className="size-3.5" />My Drive
        </button>
        {(tree.data ?? []).map((f) => {
          const depth = f.path.split(" / ").length;
          return (
            <button key={f.id} onClick={() => go(f.id)} style={{ paddingLeft: `${0.75 + depth * 0.85}rem` }}
              className={cn("flex w-full items-center gap-2.5 rounded-lg py-1.5 pr-3 text-sm", folderId === f.id ? "bg-primary/8 font-medium text-primary" : "text-muted-foreground hover:text-foreground")}>
              <Folder className="size-3.5 shrink-0" /><span className="truncate">{f.path.split(" / ").at(-1)}</span>
            </button>
          );
        })}
      </div>

      <div className="relative overflow-hidden rounded-2xl border bg-card p-4 shadow-soft">
        <div className="absolute -right-6 -top-6 size-20 rounded-full bg-accent/60 blur-2xl" />
        <div className="relative flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4 text-primary" />Unified storage</div>
        <p className="relative mt-1 text-xs text-muted-foreground">
          {1 + (tgConnected ? 1 : 0) + (driveConnected ? 1 : 0)} sources connected · unlimited via Telegram
        </p>
        <div className="relative mt-3 flex h-1.5 overflow-hidden rounded-full bg-muted">
          <span className="w-[46%] bg-telegram" /><span className="w-[22%] bg-local" /><span className="w-[12%] bg-drive" />
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background bg-sky-mesh"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setPageDrag(true); } }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setPageDrag(false); }}
      onDrop={(e) => { e.preventDefault(); setPageDrag(false); if (e.dataTransfer.files.length) { setDropped(Array.from(e.dataTransfer.files)); setUploadOpen(true); } }}>
      <aside className="sticky top-0 hidden h-screen w-72 shrink-0 border-r bg-sidebar/80 backdrop-blur-xl lg:block">{sidebar}</aside>
      <Sheet open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-72 bg-sidebar p-0"><SheetTitle className="sr-only">Navigation</SheetTitle>{sidebar}</SheetContent>
      </Sheet>

      <main className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 border-b bg-background/75 backdrop-blur-xl">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-8">
            <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setMobileNav(true)}><Menu /></Button>
            <div className="relative max-w-xl flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search files and folders…" className="h-10 rounded-xl border-transparent bg-muted/70 pl-10 shadow-none focus-visible:bg-card" />
              <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded border bg-card px-1.5 font-mono text-[10px] text-muted-foreground sm:block">/</kbd>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {isDemoMode() && <span className="hidden rounded-full bg-accent px-2.5 py-1 text-[11px] font-semibold text-accent-foreground md:inline">Demo data</span>}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="h-10 gap-2 rounded-xl bg-card" disabled={importing !== null}>
                    {importing ? <Loader2 className="size-4 animate-spin text-primary" /> : <Download className="size-4 text-primary" />}
                    <span className="hidden sm:inline">{importing ? "Importing…" : "Import & Connect"}</span>
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuItem onSelect={() => { setDropped([]); setUploadOpen(true); }} className="gap-2.5 py-2">
                    <HardDrive className="size-4 text-local" />
                    <div className="flex flex-col">
                      <span className="font-medium">Home Drive</span>
                      <span className="text-xs text-muted-foreground">Select files from your computer</span>
                    </div>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem onSelect={runTelegramImport} className="gap-2.5 py-2">
                    <Send className="size-4 text-telegram" />
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {tgConnected ? "Import from Telegram" : "Connect Telegram"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {tgConnected ? "" : "Connect your Telegram account"}
                      </span>
                    </div>
                  </DropdownMenuItem>
                  {tgConnected && (
                    <DropdownMenuItem onSelect={() => setConnectTgOpen(true)} className="gap-2 pl-8 text-xs text-muted-foreground">
                      <Settings2 className="size-3.5" />
                      Telegram Settings / Change
                    </DropdownMenuItem>
                  )}

                  <DropdownMenuSeparator />

                  <DropdownMenuItem onSelect={runDriveImport} className="gap-2.5 py-2">
                    <Cloud className="size-4 text-drive" />
                    <div className="flex flex-col">
                      <span className="font-medium">
                        {driveConnected ? "Import from Google Drive" : "Connect Google Drive"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {driveConnected ? "" : ""}
                      </span>
                    </div>
                  </DropdownMenuItem>
                  {driveConnected && (
                    <DropdownMenuItem onSelect={() => setConnectDriveOpen(true)} className="gap-2 pl-8 text-xs text-muted-foreground">
                      <Settings2 className="size-3.5" />
                      Google Drive Settings / Change
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        <div className="px-4 pb-16 pt-7 sm:px-8">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-4">
            <div className="min-w-0">
              <nav className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
                <button onClick={() => go(null)} className="rounded px-1 hover:text-foreground">My Drive</button>
                {crumbs.map((c) => (
                  <span key={c.id} className="flex items-center gap-1"><ChevronRight className="size-3.5" />
                    <button onClick={() => go(c.id)} className="rounded px-1 hover:text-foreground">{c.name}</button></span>
                ))}
              </nav>
              <h1 className="mt-1.5 truncate text-3xl font-semibold tracking-tight sm:text-4xl">{currentName}</h1>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {folders.length} folder{folders.length === 1 ? "" : "s"} · {files.length} file{files.length === 1 ? "" : "s"} · {formatSize(totalSize)}
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-xl border bg-card p-1 shadow-soft">
              <button onClick={() => refresh()} className="grid size-8 place-items-center rounded-lg text-muted-foreground hover:text-foreground" aria-label="Refresh"><RefreshCw className={cn("size-4", list.isFetching && "animate-spin")} /></button>
              <span className="mx-0.5 h-5 w-px bg-border" />
              {(["grid", "list"] as const).map((v) => (
                <button key={v} onClick={() => setView(v)} aria-label={`${v} view`}
                  className={cn("grid size-8 place-items-center rounded-lg transition-colors", view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                  {v === "grid" ? <Grid2x2 className="size-4" /> : <List className="size-4" />}
                </button>
              ))}
            </div>
          </div>

          {list.isLoading ? (
            <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="aspect-[4/3] rounded-2xl" />)}</div>
          ) : (
            <>
              {folders.length > 0 && (
                <section className="mt-8">
                  <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Folders</h2>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                    {folders.map((f) => (
                      <div key={f.id} onDoubleClick={() => go(f.id)} onClick={() => go(f.id)}
                        className="group grid cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border bg-card p-3.5 shadow-soft transition-all hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-elegant">
                        <div className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary transition-colors group-hover:bg-gradient-primary group-hover:text-primary-foreground"><Folder className="size-5" /></div>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{f.name}</p>
                          <p className="text-xs text-muted-foreground">{f.files} files · {f.folders} folders</p>
                        </div>
                        <ItemMenu onRename={() => setRenaming({ kind: "folder", item: f })} onMove={() => setMoving({ kind: "folder", item: f })} onDelete={() => setDeleting({ kind: "folder", item: f })} />
                      </div>
                    ))}
                  </div>
                </section>
              )}

              <section className="mt-9">
                <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">Files</h2>
                {files.length === 0 ? (
                  <div className="grid place-items-center rounded-3xl border border-dashed bg-card/60 px-6 py-16 text-center">
                    <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-primary/10 text-primary"><CloudUpload className="size-7" /></div>
                    <p className="font-medium">{q ? "No matches found" : "Nothing here yet"}</p>
                    <p className="mt-1 max-w-sm text-sm text-muted-foreground">{q ? "Try a different search or source filter." : "Drag files anywhere on this page, or import from Telegram, Google Drive or Home Drive."}</p>
                    {!q && <Button className="mt-5" onClick={() => { setDropped([]); setUploadOpen(true); }}>Upload files</Button>}
                  </div>
                ) : view === "grid" ? (
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
                    {files.map((f) => (
                      <div key={f.id} className="group overflow-hidden rounded-2xl border bg-card shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-elegant">
                      <button onClick={() => open(f)} aria-label={`Open ${f.name}`} className="relative block aspect-[4/3] w-full overflow-hidden bg-muted">
                        {f.mime.startsWith("image/") && contentUrl(f) ? (
                          <img src={contentUrl(f)} alt={f.name} loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-105" />
                        ) : f.mime.startsWith("video/") ? (
                          <>
                            <div className="grid size-full place-items-center bg-linear-to-br from-secondary to-muted">
                              <FileGlyph mime={f.mime} className="size-10 text-primary/60" />
                            </div>
                            <img
                              src={`/api/files/${f.id}/thumbnail`}
                              alt={f.name}
                              loading="lazy"
                              onError={(e) => { e.currentTarget.style.display = "none"; }}
                              className="absolute inset-0 size-full object-cover transition-transform duration-500 group-hover:scale-105"
                            />
                          </>
                        ) : (
                          <div className="grid size-full place-items-center bg-linear-to-br from-secondary to-muted">
                            <FileGlyph mime={f.mime} className="size-10 text-primary/60" />
                          </div>
                        )}
                        {f.mime.startsWith("video/") && (
                            <span className="absolute inset-0 grid place-items-center">
                              <span className="grid size-12 place-items-center rounded-full bg-background/85 text-primary shadow-lg backdrop-blur transition-transform group-hover:scale-110"><Play className="ml-0.5 size-5 fill-current" /></span>
                            </span>
                          )}
                          <StorageBadge storage={f.storage} className="absolute left-2.5 top-2.5 bg-card/90 backdrop-blur" />
                        </button>
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 p-3">
                          <div className="min-w-0 cursor-pointer" onClick={() => open(f)}>
                            <p className="truncate text-sm font-medium">{f.name}</p>
                            <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{formatSize(f.size)} · {formatDate(f.created_at)}</p>
                          </div>
                          <ItemMenu file={f} onRename={() => setRenaming({ kind: "file", item: f })} onMove={() => setMoving({ kind: "file", item: f })} onDelete={() => setDeleting({ kind: "file", item: f })} />
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-2xl border bg-card shadow-soft">
                    <div className="hidden grid-cols-[minmax(0,1fr)_140px_100px_120px_40px] gap-4 border-b bg-muted/40 px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground md:grid">
                      <span>Name</span><span>Source</span><span>Size</span><span>Added</span><span />
                    </div>
                    {files.map((f) => (
                      <div key={f.id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b px-4 py-2.5 last:border-0 hover:bg-muted/40 md:grid-cols-[minmax(0,1fr)_140px_100px_120px_40px]">
                        <button onClick={() => open(f)} className="flex min-w-0 items-center gap-3 text-left">
                          <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-lg bg-muted text-primary">
                            {f.mime.startsWith("image/") && contentUrl(f) ? <img src={contentUrl(f)} alt="" className="size-full object-cover" /> : <FileGlyph mime={f.mime} className="size-4" />}
                          </span>
                          <span className="truncate text-sm font-medium">{f.name}</span>
                        </button>
                        <span className="hidden md:block"><StorageBadge storage={f.storage} /></span>
                        <span className="hidden font-mono text-xs text-muted-foreground md:block">{formatSize(f.size)}</span>
                        <span className="hidden text-xs text-muted-foreground md:block">{formatDate(f.created_at)}</span>
                        <ItemMenu file={f} onRename={() => setRenaming({ kind: "file", item: f })} onMove={() => setMoving({ kind: "file", item: f })} onDelete={() => setDeleting({ kind: "file", item: f })} />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      </main>

      {pageDrag && (
        <div className="pointer-events-none fixed inset-3 z-50 grid place-items-center rounded-3xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm">
          <div className="rounded-2xl bg-card px-6 py-4 text-center shadow-elegant"><CloudUpload className="mx-auto mb-2 size-7 text-primary" /><p className="font-medium">Drop to upload to {currentName}</p></div>
        </div>
      )}

      <UploadDialog open={uploadOpen} onOpenChange={setUploadOpen} folderId={folderId} folderName={currentName} initialFiles={dropped}
        onUploaded={() => { refresh(); toast.success("Upload complete"); }} onUnauthorized={() => setNeedLogin(true)} />
      <NameDialog open={newFolder} onOpenChange={setNewFolder} title="New folder" description={`Inside ${currentName}`} cta="Create"
        onSubmit={async (name) => { await guard(() => api.createFolder(name, folderId)); toast.success(`Folder “${name}” created`); refresh(); }} />
      <NameDialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)} title="Rename" initial={renaming?.item.name ?? ""} cta="Save"
        onSubmit={async (name) => {
          if (!renaming) return;
          await guard(() => renaming.kind === "file" ? api.updateFile(renaming.item.id, { name }) : api.updateFolder(renaming.item.id, { name }));
          toast.success("Renamed"); refresh();
        }} />
      <MoveDialog open={!!moving} onOpenChange={(o) => !o && setMoving(null)} title={`Move “${moving?.item.name ?? ""}”`}
        {...(moving?.kind === "folder" ? { excludeId: moving.item.id } : {})}
        onSubmit={async (target) => {
          if (!moving) return;
          await guard(() => moving.kind === "file" ? api.updateFile(moving.item.id, { folder_id: target }) : api.updateFolder(moving.item.id, { parent_id: target }));
          toast.success("Moved"); refresh();
        }} />
      <ConfirmDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)} cta="Delete"
        title={`Delete “${deleting?.item.name ?? ""}”?`}
        description={deleting?.kind === "folder" ? "This folder and everything inside it will be removed from CloudHub." : "The file is removed from CloudHub only — the original in your source storage stays untouched."}
        onConfirm={async () => {
          if (!deleting) return;
          await guard(() => deleting.kind === "file" ? api.deleteFile(deleting.item.id) : api.deleteFolder(deleting.item.id));
          toast.success("Deleted"); refresh();
        }} />
      <ConnectTelegramDialog
        open={connectTgOpen}
        onOpenChange={setConnectTgOpen}
        onConnected={() => refresh()}
      />
      <ConnectDriveDialog
        open={connectDriveOpen}
        onOpenChange={setConnectDriveOpen}
        hasSavedConfig={Boolean(integrations.data?.drive.has_config)}
        onConnected={() => refresh()}
      />
      <MediaViewer items={media} index={viewer} onIndex={setViewer} onClose={() => setViewer(null)} />
      <LoginDialog open={needLogin} onSuccess={() => { setNeedLogin(false); refresh(); }} />
    </div>
  );
}

function ItemMenu({ file, onRename, onMove, onDelete }: { file?: FileItem; onRename: () => void; onMove: () => void; onDelete: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
        <button className="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground opacity-70 transition hover:bg-muted hover:text-foreground group-hover:opacity-100" aria-label="Actions">
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem onSelect={onRename}><Pencil />Rename</DropdownMenuItem>
        <DropdownMenuItem onSelect={onMove}><FolderInput />Move to…</DropdownMenuItem>
        {file && <DropdownMenuItem asChild><a href={contentUrl(file, true)} download={file.name}><Download />Download</a></DropdownMenuItem>}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onDelete} className="text-destructive focus:text-destructive"><Trash2 />Delete</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}