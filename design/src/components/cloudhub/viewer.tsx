import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Sparkles, X, Zap } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { contentUrl, type FileItem } from "@/lib/api";
import { formatDate, formatSize, StorageBadge } from "./utils";

type QualityMode = "auto" | "fast" | "original";

export function MediaViewer({
  items,
  index,
  onIndex,
  onClose,
}: {
  items: FileItem[];
  index: number | null;
  onIndex: (i: number) => void;
  onClose: () => void;
}) {
  const file = index == null ? undefined : items[index];
  const isVideo = Boolean(file?.mime.startsWith("video/"));

  const [mode, setMode] = useState<QualityMode>("auto");
  const [activeQuality, setActiveQuality] = useState<"fast" | "original" | null>(null);
  const [fastReady, setFastReady] = useState(false);
  const [ffmpegAvailable, setFfmpegAvailable] = useState(true);
  const [hdBuffering, setHdBuffering] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const resumeRef = useRef<{ time: number; playing: boolean }>({ time: 0, playing: true });
  const openedAtRef = useRef<number>(0);

  const go = (d: number) => {
    if (index == null || !items.length) return;
    onIndex((index + d + items.length) % items.length);
  };

  useEffect(() => {
    if (index == null) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // Check if 480p version is ready
  useEffect(() => {
    if (!file || !isVideo) {
      setActiveQuality(null);
      setFastReady(false);
      setHdBuffering(false);
      return;
    }

    let cancelled = false;
    setMode("auto");
    setActiveQuality(null);
    setFastReady(false);
    setHdBuffering(false);
    resumeRef.current = { time: 0, playing: true };
    openedAtRef.current = Date.now();

    const checkStatus = async () => {
      try {
        const res = await fetch(`/api/files/${file.id}/stream-status`);
        if (!res.ok || cancelled) return;
        const data: { fast_ready: boolean; ffmpeg_available: boolean } = await res.json();
        if (cancelled) return;
        setFastReady(data.fast_ready);
        setFfmpegAvailable(data.ffmpeg_available);
        setActiveQuality((prev) => prev ?? (data.fast_ready ? "fast" : "original"));
      } catch {
        if (!cancelled) setActiveQuality((prev) => prev ?? "original");
      }
    };

    checkStatus();
    const timer = window.setInterval(() => {
      setFastReady((ready) => {
        if (!ready && !cancelled) checkStatus();
        return ready;
      });
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [file?.id, isVideo]);

  const switchQuality = (next: "fast" | "original", nextMode?: QualityMode) => {
    const el = videoRef.current;
    if (el) {
      resumeRef.current = { time: el.currentTime || 0, playing: !el.paused };
    }
    if (nextMode) setMode(nextMode);
    setActiveQuality(next);
  };

  const toggleQualityButton = () => {
    if (!fastReady) return;
    if (activeQuality === "fast") {
      switchQuality("original", "original");
    } else {
      switchQuality("fast", "fast");
    }
  };

  // Switch to HD once buffered
  const handleHdReady = (bgVideo: HTMLVideoElement) => {
    if (mode !== "auto" || activeQuality !== "fast") return;
    const elapsed = Date.now() - openedAtRef.current;
    const bufferedAhead =
      bgVideo.buffered.length > 0 ? bgVideo.buffered.end(bgVideo.buffered.length - 1) : 0;
    const curTime = videoRef.current?.currentTime ?? 0;

    if (elapsed >= 2500 && bufferedAhead >= Math.min(bgVideo.duration || 6, curTime + 5)) {
      setHdBuffering(false);
      switchQuality("original");
    }
  };

  const baseUrl = file ? contentUrl(file) : "";
  const videoSrc =
    activeQuality === "fast" ? `${baseUrl}?quality=fast` : activeQuality === "original" ? baseUrl : undefined;

  return (
    <Dialog open={!!file} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[94vh] max-w-[min(1200px,96vw)] flex-col gap-0 overflow-hidden border-0 bg-foreground p-0 text-background sm:rounded-2xl [&>button]:hidden">
        {file && (
          <>
            <div className="grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-background/10 px-4 py-3">
              <div className="min-w-0">
                <DialogTitle className="truncate text-sm font-medium text-background">{file.name}</DialogTitle>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-background/60">
                  <StorageBadge storage={file.storage} />
                  <span>{formatSize(file.size)}</span>
                  <span>·</span>
                  <span>{formatDate(file.created_at)}</span>
                  <span className="font-mono">
                    · {(index ?? 0) + 1}/{items.length}
                  </span>

                  {isVideo && activeQuality && (
                    <button
                      type="button"
                      onClick={toggleQualityButton}
                      disabled={!fastReady}
                      title={fastReady ? "Switch quality (Fast / Original)" : "Preparing Fast 480p version"}
                      className="ml-1 inline-flex items-center gap-1 rounded-full bg-background/15 px-2.5 py-0.5 text-[11px] font-medium text-background transition hover:bg-background/25 disabled:cursor-default disabled:opacity-80"
                    >
                      {activeQuality === "fast" ? (
                        <>
                          <Zap className="size-3 text-amber-400" />
                          <span>Fast 480p{hdBuffering ? " · Loading HD..." : ""}</span>
                        </>
                      ) : (
                        <>
                          <Sparkles className="size-3 text-emerald-400" />
                          <span>
                            Original HD
                            {!fastReady && ffmpegAvailable ? " (Preparing Fast...)" : ""}
                          </span>
                        </>
                      )}
                    </button>
                  )}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <a
                  href={contentUrl(file, true)}
                  download={file.name}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3 text-sm font-medium text-accent-foreground transition-transform hover:scale-[1.02]"
                >
                  <Download className="size-4" />
                  <span className="hidden sm:inline">Download</span>
                </a>
                <button
                  onClick={onClose}
                  className="grid size-9 place-items-center rounded-lg text-background/70 hover:bg-background/10 hover:text-background"
                >
                  <X className="size-5" />
                </button>
              </div>
            </div>

            <div className="relative flex h-[78vh] min-h-0 w-full items-center justify-center bg-foreground p-3">
              {isVideo ? (
                <>
                  {videoSrc && (
                    <video
                      ref={videoRef}
                      key={`${file.id}-${activeQuality}`}
                      src={videoSrc}
                      controls
                      autoPlay
                      playsInline
                      preload="auto"
                      onLoadedMetadata={(e) => {
                        const v = e.currentTarget;
                        if (resumeRef.current.time > 0.2 && Number.isFinite(v.duration)) {
                          v.currentTime = Math.min(resumeRef.current.time, Math.max(0, v.duration - 0.2));
                        }
                        if (resumeRef.current.playing) {
                          v.play().catch(() => {});
                        }
                      }}
                      className="h-auto max-h-full w-auto max-w-full rounded-lg object-contain"
                    />
                  )}

                  {/* Background HD preloader */}
                  {activeQuality === "fast" && mode === "auto" && (
                    <video
                      key={`preload-${file.id}`}
                      src={baseUrl}
                      muted
                      playsInline
                      preload="auto"
                      onLoadStart={() => setHdBuffering(true)}
                      onProgress={(e) => handleHdReady(e.currentTarget)}
                      onCanPlayThrough={(e) => handleHdReady(e.currentTarget)}
                      className="hidden"
                    />
                  )}
                </>
              ) : (
                <img
                  key={file.id}
                  src={baseUrl}
                  alt={file.name}
                  className="max-h-full max-w-full object-contain"
                />
              )}

              {items.length > 1 && (
                <>
                  <button
                    onClick={() => go(-1)}
                    aria-label="Previous"
                    className="absolute left-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-background/10 text-background backdrop-blur-md hover:bg-background/20"
                  >
                    <ChevronLeft />
                  </button>
                  <button
                    onClick={() => go(1)}
                    aria-label="Next"
                    className="absolute right-3 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-background/10 text-background backdrop-blur-md hover:bg-background/20"
                  >
                    <ChevronRight />
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}