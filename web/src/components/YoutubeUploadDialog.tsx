/**
 * Pick channels and listing copy, then send a rendered video to YouTube.
 */

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus, RefreshCw, Sparkles } from "lucide-react";
import { api, type YoutubeChannel, type YoutubePlaylist } from "@/api/client.ts";
import { useI18n } from "@/i18n/index.tsx";
import { Alert, Button, Dialog, Field, Select, TextArea, TextInput } from "@/components/ui.tsx";
import { Checkbox } from "@/components/ui/checkbox";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const CREATE_PLAYLIST_VALUE = "__create__";
const PLAYLIST_TITLE_MAX = 150;
const YOUTUBE_DESCRIPTION_MAX = 5000;
/** Fallback listings are a title, a credit line, and hashtags. */
export const STUB_DESCRIPTION_MAX = 160;
const SCHEDULE_LEAD_MS = 60_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function toDatetimeLocalValue(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function defaultScheduleAt(): string {
  const date = new Date(Date.now() + 60 * 60 * 1000);
  date.setSeconds(0, 0);
  return toDatetimeLocalValue(date);
}

function datetimeLocalToIso(value: string): string | undefined {
  if (!value.trim()) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function scheduleIsReady(value: string): boolean {
  const iso = datetimeLocalToIso(value);
  return Boolean(iso && new Date(iso).getTime() >= Date.now() + SCHEDULE_LEAD_MS);
}

function resolvedPrivacy(privacy: string): "public" | "unlisted" | "private" {
  return privacy === "scheduled" ? "private" : (privacy as "public" | "unlisted" | "private");
}

export function youtubeListingIsStub(description: string | undefined | null): boolean {
  return (description ?? "").trim().length <= STUB_DESCRIPTION_MAX;
}

export interface YoutubeUploadDraft {
  source: "task" | "book_short" | "book_segment";
  taskId?: string;
  bookId?: string;
  shortIndex?: number;
  segmentIndex?: number;
  title: string;
  description: string;
  tags: string[];
}

export function YoutubeUploadDialog({
  open,
  onOpenChange,
  draft,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: YoutubeUploadDraft | null;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState("");
  const [privacy, setPrivacy] = useState("unlisted");
  const [scheduleAt, setScheduleAt] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [playlistIds, setPlaylistIds] = useState<Record<string, string>>({});
  const [newPlaylistTitles, setNewPlaylistTitles] = useState<Record<string, string>>({});

  const channelsQuery = useQuery({
    queryKey: ["youtube-channels"],
    queryFn: api.listYoutubeChannels,
    enabled: open,
  });
  const statusQuery = useQuery({
    queryKey: ["youtube-status"],
    queryFn: () => api.youtubeStatus(),
    enabled: open,
  });

  const channels = channelsQuery.data?.channels ?? [];
  const playlistQueries = useQueries({
    queries: channels.map((channel) => ({
      queryKey: ["youtube-playlists", channel.id],
      queryFn: () => api.listYoutubePlaylists(channel.id),
      enabled: open,
    })),
  });
  const playlistsByChannel = useMemo(() => {
    const map: Record<string, { playlists: YoutubePlaylist[]; isLoading: boolean; isError: boolean }> = {};
    channels.forEach((channel, index) => {
      const query = playlistQueries[index];
      map[channel.id] = {
        playlists: query?.data?.playlists ?? [],
        isLoading: Boolean(query?.isLoading || query?.isFetching) && !query?.data,
        isError: Boolean(query?.isError),
      };
    });
    return map;
  }, [channels, playlistQueries]);

  const draftKey = draft
    ? `${draft.source}:${draft.taskId ?? ""}:${draft.bookId ?? ""}:${draft.shortIndex ?? ""}:${draft.segmentIndex ?? ""}`
    : null;

  // Seed once per video. Channel/status fetches must not reset listing copy —
  // that was wiping a saved description and looking like a regenerate.
  useEffect(() => {
    if (!open || !draft) return;
    setTitle(draft.title);
    setDescription(draft.description);
    setTags(draft.tags.join(", "));
    setPrivacy(statusQuery.data?.privacy_status ?? "unlisted");
    setScheduleAt("");
    setSelected(channels.map((channel) => channel.id));
    setPlaylistIds({});
    setNewPlaylistTitles({});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- seed from the draft identity only
  }, [open, draftKey]);

  useEffect(() => {
    if (!open || channels.length === 0) return;
    setSelected((current) => (current.length > 0 ? current : channels.map((channel) => channel.id)));
  }, [open, draftKey, channels]);

  useEffect(() => {
    if (!open) return;
    const privacy = statusQuery.data?.privacy_status;
    if (privacy) setPrivacy(privacy);
  }, [open, draftKey, statusQuery.data?.privacy_status]);

  const rewrite = useMutation({
    mutationFn: (options?: { descriptionOnly?: boolean }) => {
      if (!draft) throw new Error("missing upload draft");
      return api.generateYoutubeListing({
        source: draft.source,
        task_id: draft.taskId,
        book_id: draft.bookId,
        short_index: draft.shortIndex,
        segment_index: draft.segmentIndex,
      }).then((listing) => ({ listing, descriptionOnly: options?.descriptionOnly ?? false }));
    },
    onSuccess: ({ listing, descriptionOnly }) => {
      if (!descriptionOnly) setTitle(listing.title);
      setDescription(listing.description);
      setTags(listing.tags.join(", "));
      if (draft?.bookId) {
        void queryClient.invalidateQueries({ queryKey: ["book-shorts", draft.bookId] });
        void queryClient.invalidateQueries({ queryKey: ["book", draft.bookId] });
      }
    },
  });

  const toggle = (id: string, checked: boolean) => {
    setSelected((current) => (checked ? [...current, id] : current.filter((entry) => entry !== id)));
  };

  const reconnect = useMutation({
    mutationFn: () => api.startYoutubeOAuth(),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });

  const createPlaylist = useMutation({
    mutationFn: async ({ channelId, title }: { channelId: string; title: string }) => {
      const result = await api.createYoutubePlaylist(channelId, {
        title,
        privacy_status: resolvedPrivacy(privacy),
      });
      return { channelId, playlist: result.playlist };
    },
    onSuccess: ({ channelId, playlist }) => {
      queryClient.setQueryData<{ playlists: YoutubePlaylist[] }>(["youtube-playlists", channelId], (old) => ({
        playlists: [playlist, ...(old?.playlists ?? []).filter((entry) => entry.id !== playlist.id)],
      }));
      setPlaylistIds((current) => ({ ...current, [channelId]: playlist.id }));
      setNewPlaylistTitles((current) => ({ ...current, [channelId]: "" }));
    },
  });

  const upload = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("missing upload draft");
      const resolved: Record<string, string> = {};
      for (const id of selected) {
        const current = playlistIds[id]?.trim() ?? "";
        if (current === CREATE_PLAYLIST_VALUE) {
          const name = newPlaylistTitles[id]?.trim() ?? "";
          if (!name) continue;
          const created = await api.createYoutubePlaylist(id, {
            title: name,
            privacy_status: resolvedPrivacy(privacy),
          });
          resolved[id] = created.playlist.id;
          void queryClient.invalidateQueries({ queryKey: ["youtube-playlists", id] });
        } else if (current) {
          resolved[id] = current;
        }
      }
      return api.uploadToYoutube({
        source: draft.source,
        task_id: draft.taskId,
        book_id: draft.bookId,
        short_index: draft.shortIndex,
        segment_index: draft.segmentIndex,
        channel_ids: selected,
        title,
        description,
        tags: tags
          .split(",")
          .map((tag) => tag.trim())
          .filter(Boolean),
        privacy_status: resolvedPrivacy(privacy),
        playlist_ids: resolved,
        ...(privacy === "scheduled" ? { publish_at: datetimeLocalToIso(scheduleAt) } : {}),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (draft?.bookId) {
        void queryClient.invalidateQueries({ queryKey: ["book-shorts", draft.bookId] });
        void queryClient.invalidateQueries({ queryKey: ["book", draft.bookId] });
      }
      onOpenChange(false);
    },
  });

  const scheduled = privacy === "scheduled";
  const canSubmit =
    Boolean(draft) &&
    selected.length > 0 &&
    title.trim().length > 0 &&
    !upload.isPending &&
    !createPlaylist.isPending &&
    (!scheduled || scheduleIsReady(scheduleAt));
  const needsPlaylistReconnect = selected.some((id) => {
    const channel = channels.find((entry) => entry.id === id);
    return channel != null && channel.playlist_access === false;
  });
  const playlistReconnectError =
    (createPlaylist.isError && /reconnect this channel/i.test((createPlaylist.error as Error).message)) ||
    (upload.isError && /reconnect this channel/i.test((upload.error as Error).message));

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t("YouTube Upload Title")}>
      <div className="space-y-4">
        {channelsQuery.isError && <Alert tone="danger">{(channelsQuery.error as Error).message}</Alert>}
        {channels.length === 0 && !channelsQuery.isLoading ? (
          <Alert tone="warning">{t("YouTube Upload No Channels")}</Alert>
        ) : (
          <Field label={t("YouTube Upload Channels")}>
            <div className="space-y-2 rounded-md border p-2">
              {channels.map((channel) => (
                <ChannelRow
                  key={channel.id}
                  channel={channel}
                  checked={selected.includes(channel.id)}
                  onCheckedChange={(checked) => toggle(channel.id, checked)}
                />
              ))}
            </div>
          </Field>
        )}

        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{t("YouTube Listing Section")}</p>
          <Button
            size="sm"
            variant="default"
            disabled={!draft || rewrite.isPending || upload.isPending}
            onClick={() => rewrite.mutate({ descriptionOnly: draft?.source === "book_segment" })}
          >
            {rewrite.isPending ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
            {t("YouTube Rewrite Listing")}
          </Button>
        </div>
        {rewrite.isError && <Alert tone="danger">{(rewrite.error as Error).message}</Alert>}

        <Field label={t("YouTube Video Title")}>
          <TextInput
            value={title}
            maxLength={100}
            disabled={rewrite.isPending}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field
          label={
            <div className="flex items-center justify-between gap-2">
              <span>{t("YouTube Video Description")}</span>
              <Button
                size="sm"
                variant="default"
                disabled={!draft || rewrite.isPending || upload.isPending}
                onClick={() => rewrite.mutate({ descriptionOnly: true })}
              >
                {rewrite.isPending ? <Loader2 className="animate-spin" size={14} /> : <Sparkles size={14} />}
                {t("YouTube Generate Description")}
              </Button>
            </div>
          }
          hint={t("YouTube Video Description Hint", {
            count: description.length,
            max: YOUTUBE_DESCRIPTION_MAX,
          })}
        >
          <TextArea
            rows={12}
            value={description}
            maxLength={YOUTUBE_DESCRIPTION_MAX}
            disabled={rewrite.isPending}
            onChange={(event) => setDescription(event.target.value)}
          />
        </Field>
        <Field label={t("YouTube Video Tags")} hint={t("YouTube Video Tags Hint")}>
          <TextInput
            value={tags}
            disabled={rewrite.isPending}
            onChange={(event) => setTags(event.target.value)}
          />
        </Field>
        <div className={scheduled ? "grid gap-4 sm:grid-cols-2" : undefined}>
          <Field label={t("YouTube Upload Privacy")}>
            <Select
              value={privacy}
              onValueChange={(value) => {
                setPrivacy(value);
                if (value === "scheduled" && !scheduleAt) setScheduleAt(defaultScheduleAt());
              }}
              options={[
                { value: "public", label: t("YouTube Privacy Public") },
                { value: "unlisted", label: t("YouTube Privacy Unlisted") },
                { value: "private", label: t("YouTube Privacy Private") },
                { value: "scheduled", label: t("YouTube Privacy Scheduled") },
              ]}
            />
          </Field>
          {scheduled && (
            <Field
              label={t("YouTube Schedule Publish")}
              hint={
                scheduleAt && !scheduleIsReady(scheduleAt)
                  ? t("YouTube Schedule Publish Required")
                  : t("YouTube Schedule Publish Hint")
              }
            >
              <TextInput
                type="datetime-local"
                value={scheduleAt}
                min={toDatetimeLocalValue(new Date(Date.now() + SCHEDULE_LEAD_MS))}
                step={60}
                disabled={rewrite.isPending || upload.isPending}
                className="dark:[color-scheme:dark]"
                onChange={(event) => setScheduleAt(event.target.value)}
              />
            </Field>
          )}
        </div>
        {selected.length > 0 && (
          <Field label={t("YouTube Playlist")} hint={t("YouTube Playlist Hint")}>
            {(needsPlaylistReconnect || playlistReconnectError) && (
              <Alert tone="warning">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <p>{t("YouTube Playlist Access Needed")}</p>
                  <Button
                    size="sm"
                    variant="default"
                    disabled={reconnect.isPending}
                    onClick={() => reconnect.mutate()}
                  >
                    {reconnect.isPending ? <Loader2 className="animate-spin" size={14} /> : <RefreshCw size={14} />}
                    {t("YouTube Reconnect Channel")}
                  </Button>
                </div>
              </Alert>
            )}
            {reconnect.isError && <Alert tone="danger">{(reconnect.error as Error).message}</Alert>}
            <div className="space-y-2">
              {selected.map((id) => {
                const channel = channels.find((entry) => entry.id === id);
                if (!channel) return null;
                const info = playlistsByChannel[id];
                const creating = (playlistIds[id] ?? "") === CREATE_PLAYLIST_VALUE;
                const newTitle = newPlaylistTitles[id] ?? "";
                const creatingThis = createPlaylist.isPending && createPlaylist.variables?.channelId === id;
                return (
                  <div key={id} className="space-y-1.5">
                    {selected.length > 1 && (
                      <p className="truncate text-xs text-muted-foreground">{channel.title}</p>
                    )}
                    <Select
                      value={playlistIds[id] ?? ""}
                      onValueChange={(value) =>
                        setPlaylistIds((current) => ({ ...current, [id]: value }))
                      }
                      disabled={info?.isLoading || rewrite.isPending || upload.isPending || createPlaylist.isPending}
                      placeholder={
                        info?.isLoading
                          ? t("YouTube Playlist Loading")
                          : info?.isError
                            ? t("YouTube Playlist Error")
                            : t("YouTube Playlist None")
                      }
                      options={[
                        { value: "", label: t("YouTube Playlist None") },
                        { value: CREATE_PLAYLIST_VALUE, label: t("YouTube Playlist Create") },
                        ...(info?.playlists ?? []).map((playlist) => ({
                          value: playlist.id,
                          label: playlist.title,
                        })),
                      ]}
                    />
                    {creating && (
                      <div className="flex gap-2">
                        <TextInput
                          className="min-w-0 flex-1"
                          value={newTitle}
                          maxLength={PLAYLIST_TITLE_MAX}
                          placeholder={t("YouTube Playlist Create Title")}
                          disabled={rewrite.isPending || upload.isPending || creatingThis}
                          onChange={(event) =>
                            setNewPlaylistTitles((current) => ({ ...current, [id]: event.target.value }))
                          }
                          onKeyDown={(event) => {
                            if (event.key !== "Enter") return;
                            event.preventDefault();
                            if (!newTitle.trim() || creatingThis) return;
                            createPlaylist.mutate({ channelId: id, title: newTitle.trim() });
                          }}
                        />
                        <Button
                          type="button"
                          variant="default"
                          className="shrink-0"
                          disabled={!newTitle.trim() || rewrite.isPending || upload.isPending || creatingThis}
                          onClick={() => createPlaylist.mutate({ channelId: id, title: newTitle.trim() })}
                        >
                          {creatingThis ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />}
                          {t("YouTube Playlist Create Submit")}
                        </Button>
                      </div>
                    )}
                    {info?.isError && (
                      <p className="text-xs text-destructive">{t("YouTube Playlist Error")}</p>
                    )}
                    {creating && createPlaylist.isError && createPlaylist.variables?.channelId === id && (
                      <p className="text-xs text-destructive">{(createPlaylist.error as Error).message}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </Field>
        )}

        {upload.isError && <Alert tone="danger">{(upload.error as Error).message}</Alert>}

        <div className="flex justify-end gap-2">
          <Button variant="default" onClick={() => onOpenChange(false)}>
            {t("Cancel")}
          </Button>
          <Button variant="primary" disabled={!canSubmit || rewrite.isPending} onClick={() => upload.mutate()}>
            {upload.isPending && <Loader2 className="animate-spin" size={14} />}
            {t(scheduled ? "YouTube Upload Schedule Submit" : "YouTube Upload Submit")}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ChannelRow({
  channel,
  checked,
  onCheckedChange,
}: {
  channel: YoutubeChannel;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const initial = channel.title.trim().slice(0, 1).toUpperCase() || "Y";
  return (
    <label className="flex cursor-pointer items-center gap-3 rounded-md px-1 py-1.5 hover:bg-muted/60">
      <Checkbox checked={checked} onCheckedChange={(value) => onCheckedChange(Boolean(value))} />
      <Avatar size="sm">
        {channel.thumbnail_url && <AvatarImage src={channel.thumbnail_url} alt="" />}
        <AvatarFallback>{initial}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{channel.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {channel.custom_url || channel.google_account_email || channel.channel_id}
        </span>
      </span>
    </label>
  );
}

export function youtubeUploadBusy(state?: string | null): boolean {
  return state === "pending" || state === "processing";
}

export function youtubeAlreadyUploaded(
  results?: { success: boolean; video_id?: string; video_url?: string }[] | null,
): boolean {
  return Boolean(results?.some((result) => result.success && Boolean(result.video_id || result.video_url)));
}

export function YoutubeUploadStatus({
  state,
  error,
  results,
}: {
  state?: string | null;
  error?: string | null;
  results?: {
    success: boolean;
    channel_title: string;
    video_url?: string;
    error?: string;
    playlist_error?: string;
  }[] | null;
}) {
  const { t } = useI18n();
  const summary = useMemo(() => {
    if (state === "processing" || state === "pending") return t("YouTube Upload In Progress");
    if (!results || results.length === 0) {
      if (state === "failed") return error || t("YouTube Upload Failed");
      return null;
    }
    const ok = results.filter((result) => result.success);
    const failed = results.filter((result) => !result.success);
    if (failed.length === 0) return t("YouTube Upload Complete", { count: ok.length });
    if (ok.length === 0) return error || t("YouTube Upload Failed");
    return t("YouTube Upload Partial", { ok: ok.length, failed: failed.length });
  }, [error, results, state, t]);

  if (!summary) return null;

  return (
    <div className="space-y-1 text-xs">
      <p className={state === "failed" ? "text-destructive" : "text-muted-foreground"}>{summary}</p>
      {results?.map((result) =>
        result.success && result.video_url ? (
          <div key={result.channel_title + (result.video_url ?? "")} className="space-y-0.5">
            <a
              href={result.video_url}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-primary hover:underline"
            >
              {result.channel_title}
            </a>
            {result.playlist_error ? (
              <p className="truncate text-destructive">
                {t("YouTube Playlist Add Failed", { error: result.playlist_error })}
              </p>
            ) : null}
          </div>
        ) : result.error ? (
          <p key={result.channel_title} className="truncate text-destructive">
            {result.channel_title}: {result.error}
          </p>
        ) : null,
      )}
    </div>
  );
}
