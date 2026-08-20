import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { ExternalLink, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/api/client.ts";
import { Alert, Button, Card, Field, NumberInput, Select, Switch, TextInput } from "@/components/ui.tsx";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useI18n } from "@/i18n/index.tsx";
import { useSettingsDraft } from "./context.tsx";

export function YoutubeSettingsPage() {
  const { t } = useI18n();
  const { draft, fromEnv, setApp } = useSettingsDraft();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();

  const statusQuery = useQuery({
    queryKey: ["youtube-status"],
    queryFn: () => api.youtubeStatus(),
  });
  const channelsQuery = useQuery({
    queryKey: ["youtube-channels"],
    queryFn: api.listYoutubeChannels,
  });

  useEffect(() => {
    if (params.get("connected")) {
      toast.success(t("YouTube Channel Connected"));
      void queryClient.invalidateQueries({ queryKey: ["youtube-channels"] });
      if (params.get("playlist") === "0") {
        toast.warning(t("YouTube OAuth No Playlist Scope"));
      }
      setParams({}, { replace: true });
    }
    const error = params.get("error");
    const description = params.get("error_description");
    if (error) {
      toast.error(oauthErrorMessage(error, t, description));
      setParams({}, { replace: true });
    }
  }, [params, queryClient, setParams, t]);

  const connect = useMutation({
    mutationFn: () => api.startYoutubeOAuth(),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) => toast.error(readableError(error)),
  });

  const disconnect = useMutation({
    mutationFn: (id: string) => api.disconnectYoutubeChannel(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["youtube-channels"] });
      toast.success(t("YouTube Channel Disconnected"));
    },
    onError: (error) => toast.error(readableError(error)),
  });

  const autoUpload = useMutation({
    mutationFn: ({ id, value }: { id: string; value: boolean }) => api.setYoutubeChannelAutoUpload(id, value),
    onSuccess: (data) => {
      queryClient.setQueryData(["youtube-channels"], data);
    },
    onError: (error) => toast.error(readableError(error)),
  });

  if (!draft) return null;

  const channels = channelsQuery.data?.channels ?? [];
  const redirectUri = statusQuery.data?.redirect_uri ?? "";

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title={t("YouTube Google App")}>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{t("YouTube Google App Help")}</p>
          <a
            href="https://console.cloud.google.com/apis/library/youtube.googleapis.com"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            {t("YouTube Enable Api")}
            <ExternalLink size={12} />
          </a>
          <Field
            label={
              <span className="inline-flex items-center gap-2">
                {t("YouTube Client Id")}
                <a
                  href="https://console.cloud.google.com/apis/credentials"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary hover:underline"
                >
                  <ExternalLink size={11} />
                </a>
              </span>
            }
            hint={fromEnv("google_client_id") ? t("Set in .env") : undefined}
          >
            <TextInput
              disabled={fromEnv("google_client_id")}
              value={String(draft.app.google_client_id ?? "")}
              onChange={(event) => setApp("google_client_id", event.target.value)}
            />
          </Field>
          <Field
            label={t("YouTube Client Secret")}
            hint={fromEnv("google_client_secret") ? t("Set in .env") : undefined}
          >
            <TextInput
              type="password"
              disabled={fromEnv("google_client_secret")}
              value={String(draft.app.google_client_secret ?? "")}
              onChange={(event) => setApp("google_client_secret", event.target.value)}
            />
          </Field>
          <Field label={t("YouTube Redirect Uri")} hint={t("YouTube Redirect Uri Help")}>
            <TextInput readOnly value={redirectUri} />
          </Field>
          <Field label={t("YouTube Privacy")} hint={t("YouTube Privacy Help")}>
            <Select
              value={String(draft.app.youtube_privacy_status ?? "unlisted")}
              onValueChange={(value) => setApp("youtube_privacy_status", value)}
              options={[
                { value: "public", label: t("YouTube Privacy Public") },
                { value: "unlisted", label: t("YouTube Privacy Unlisted") },
                { value: "private", label: t("YouTube Privacy Private") },
              ]}
            />
          </Field>
          <Field label={t("YouTube Auto Schedule Hours")} hint={t("YouTube Auto Schedule Hours Help")}>
            <NumberInput
              min={0}
              max={168}
              step={1}
              value={Number(draft.app.youtube_auto_schedule_hours ?? 6)}
              onChange={(event) => {
                const hours = Number(event.target.value);
                setApp(
                  "youtube_auto_schedule_hours",
                  Number.isFinite(hours) ? Math.max(0, Math.min(168, Math.round(hours))) : 0,
                );
              }}
            />
          </Field>
        </div>
      </Card>

      <Card
        title={t("YouTube Channels")}
        action={
          <Button size="sm" variant="primary" disabled={connect.isPending} onClick={() => connect.mutate()}>
            {connect.isPending ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
            {t("YouTube Connect Channel")}
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{t("YouTube Channels Help")}</p>
          {connect.isError && <Alert tone="danger">{readableError(connect.error)}</Alert>}
          {channelsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading")}</p>
          ) : channels.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("YouTube No Channels")}</p>
          ) : (
            <ul className="space-y-3">
              {channels.map((channel) => {
                const initial = channel.title.trim().slice(0, 1).toUpperCase() || "Y";
                return (
                  <li key={channel.id} className="rounded-lg border p-3">
                    <div className="flex items-start gap-3">
                      <Avatar>
                        {channel.thumbnail_url && <AvatarImage src={channel.thumbnail_url} alt="" />}
                        <AvatarFallback>{initial}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-medium">{channel.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {channel.custom_url || channel.channel_id}
                          {channel.google_account_email ? ` · ${channel.google_account_email}` : ""}
                        </p>
                        {channel.error && <p className="mt-1 text-xs text-destructive">{channel.error}</p>}
                        {!channel.playlist_access && (
                          <p className="mt-1 text-xs text-warning">{t("YouTube Playlist Access Needed")}</p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <Switch
                            checked={channel.auto_upload}
                            onCheckedChange={(value) => autoUpload.mutate({ id: channel.id, value })}
                            label={t("YouTube Auto Upload")}
                          />
                          {!channel.playlist_access && (
                            <Button
                              size="sm"
                              variant="default"
                              disabled={connect.isPending}
                              onClick={() => connect.mutate()}
                            >
                              {connect.isPending ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                              {t("YouTube Reconnect Channel")}
                            </Button>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={disconnect.isPending}
                        title={t("YouTube Disconnect")}
                        onClick={() => disconnect.mutate(channel.id)}
                      >
                        {disconnect.isPending && disconnect.variables === channel.id ? (
                          <Loader2 className="animate-spin" size={14} />
                        ) : (
                          <Trash2 size={14} className="text-destructive" />
                        )}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message && error.message !== "[object Object]") return error.message;
  if (typeof error === "string" && error && error !== "[object Object]") return error;
  return "YouTube request failed";
}

function oauthErrorMessage(error: string, t: (key: string) => string, description?: string | null): string {
  if (error === "access_denied") return t("YouTube OAuth Denied");
  if (error === "expired_state") return t("YouTube OAuth Expired");
  if (error === "no_refresh_token") return t("YouTube OAuth No Refresh");
  if (error === "not_configured") return t("YouTube OAuth Not Configured");
  if (error === "missing_code") return t("YouTube OAuth Missing Code");
  if (error === "redirect_uri_mismatch") return t("YouTube OAuth Redirect Mismatch");
  if (error === "invalid_client") return t("YouTube OAuth Invalid Client");
  if (/youtube data api/i.test(error) || error.includes("youtube.googleapis.com")) {
    return t("YouTube OAuth Api Disabled");
  }
  if (error === "[object Object]" || !error.trim()) {
    return description?.trim() || t("YouTube OAuth Failed");
  }
  if (description?.trim()) return `${error}: ${description.trim()}`;
  return error;
}
