import { useEffect, useState } from "react";
import { Check, Cloud, Copy, ExternalLink, Loader2, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";

type TgChannel = { id: string; title: string; type: string };

export function ConnectTelegramDialog({
  open,
  onOpenChange,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConnected: () => void;
}) {
  const [step, setStep] = useState<"credentials" | "code" | "channel">("credentials");
  const [apiId, setApiId] = useState("");
  const [apiHash, setApiHash] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [need2fa, setNeed2fa] = useState(false);
  const [channels, setChannels] = useState<TgChannel[]>([]);
  const [selectedChannel, setSelectedChannel] = useState("me");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (open) {
      setStep("credentials");
      setCode("");
      setPassword("");
      setNeed2fa(false);
      setChannels([]);
      setSelectedChannel("me");
    }
  }, [open]);

  function proceedToChannels(list?: TgChannel[]) {
    const items = list && list.length ? list : [{ id: "me", title: "Saved Messages", type: "saved" }];
    setChannels(items);
    // Pre-select the first actual channel if available, otherwise Saved Messages
    const firstChannel = items.find((c) => c.type === "channel");
    setSelectedChannel(firstChannel ? firstChannel.id : items[0].id);
    setStep("channel");
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    if (!apiId.trim() || !apiHash.trim() || !phone.trim()) {
      toast.error("Please fill in API ID, API Hash, and phone number");
      return;
    }
    setLoading(true);
    try {
      const res = await api.telegramAuthStart({
        api_id: Number(apiId.trim()),
        api_hash: apiHash.trim(),
        phone: phone.trim(),
      });
      if (res.status === "select_channel") {
        proceedToChannels(res.channels);
      } else {
        toast.success("Verification code sent to your Telegram");
        setStep("code");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send verification code");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    if (!code.trim()) {
      toast.error("Please enter the code sent to Telegram");
      return;
    }
    setLoading(true);
    try {
      const res = await api.telegramAuthVerify({
        code: code.trim(),
        ...(password ? { password } : {}),
      });
      if (res.status === "2fa_required") {
        setNeed2fa(true);
        toast.info("2FA is enabled — please enter your cloud password");
      } else if (res.status === "select_channel") {
        proceedToChannels(res.channels);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Invalid verification code");
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveChannel(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.telegramSelectChannel({ channel_id: selectedChannel });
      toast.success("Telegram connected successfully!");
      onConnected();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to select channel");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="size-5 text-telegram" />
            Connect Telegram
          </DialogTitle>
          <DialogDescription>
            {step === "channel" ? (
              "Choose which Telegram channel or chat to use as your cloud storage."
            ) : (
              <>
                Get your API ID and API Hash from{" "}
                <a
                  href="https://my.telegram.org"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 font-medium text-primary underline"
                >
                  my.telegram.org <ExternalLink className="size-3" />
                </a>
                .
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {step === "credentials" && (
          <form onSubmit={handleSendCode} className="grid gap-3 pt-1">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">API ID</label>
              <Input
                value={apiId}
                onChange={(e) => setApiId(e.target.value)}
                placeholder="e.g. 12345678"
                inputMode="numeric"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">API Hash</label>
              <Input
                value={apiHash}
                onChange={(e) => setApiHash(e.target.value)}
                placeholder="e.g. 0123456789abcdef0123456789abcdef"
              />
            </div>
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Phone number</label>
              <Input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="e.g. +995555123456"
              />
            </div>
            <Button type="submit" disabled={loading} className="mt-2">
              {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
              Send verification code
            </Button>
          </form>
        )}

        {step === "code" && (
          <form onSubmit={handleVerify} className="grid gap-3 pt-1">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Telegram verification code</label>
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. 54321"
                autoFocus
              />
            </div>
            {need2fa && (
              <div className="grid gap-1.5">
                <label className="text-xs font-medium text-muted-foreground">2FA Cloud Password</label>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your 2FA password"
                />
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep("credentials")} disabled={loading}>
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={loading}>
                {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
                Continue
              </Button>
            </div>
          </form>
        )}

        {step === "channel" && (
          <form onSubmit={handleSaveChannel} className="grid gap-3 pt-1">
            <div className="grid gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Select Storage Channel</label>
              <select
                value={selectedChannel}
                onChange={(e) => setSelectedChannel(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} {c.type === "channel" ? "(Channel)" : c.type === "group" ? "(Group)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <Button type="submit" disabled={loading} className="mt-2">
              {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
              Finish & Connect
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export function ConnectDriveDialog({
  open,
  onOpenChange,
  hasSavedConfig,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  hasSavedConfig?: boolean | undefined;
  onConnected: () => void;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const redirectUri =
    typeof window !== "undefined" ? `${window.location.origin}/api/drive/auth/callback` : "http://localhost:3000/api/drive/auth/callback";

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.data === "gdrive-connected") {
        toast.success("Google Drive connected successfully!");
        onConnected();
        onOpenChange(false);
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [onConnected, onOpenChange]);

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!hasSavedConfig && (!clientId.trim() || !clientSecret.trim())) {
      toast.error("Please enter Google Client ID and Client Secret");
      return;
    }
    setLoading(true);
    try {
      const cid = clientId.trim();
      const csec = clientSecret.trim();
      const res = await api.driveAuthStart({
        ...(cid ? { client_id: cid } : {}),
        ...(csec ? { client_secret: csec } : {}),
        redirect_uri: redirectUri,
      });
      window.open(res.auth_url, "gdrive-oauth", "width=520,height=660");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start Google Drive authorization");
    } finally {
      setLoading(false);
    }
  }

  function copyRedirect() {
    navigator.clipboard.writeText(redirectUri);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="size-5 text-drive" />
            Connect Google Drive
          </DialogTitle>
          <DialogDescription>
            Add this URL to{" "}
            <span className="font-medium text-foreground">Authorized redirect URIs</span> when creating your OAuth Client in Google Cloud Console:
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-lg border bg-muted/60 px-3 py-2 font-mono text-xs">
          <span className="min-w-0 flex-1 truncate">{redirectUri}</span>
          <button
            type="button"
            onClick={copyRedirect}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
            title="Copy"
          >
            {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
          </button>
        </div>

        <form onSubmit={handleConnect} className="grid gap-3 pt-1">
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              Google Client ID {hasSavedConfig ? "(Saved — enter again to replace)" : ""}
            </label>
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder="123456789-xxxx.apps.googleusercontent.com"
            />
          </div>
          <div className="grid gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Google Client Secret</label>
            <Input
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="GOCSPX-..."
            />
          </div>
          <Button type="submit" disabled={loading} className="mt-2">
            {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
            Sign in with Google & Connect
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}