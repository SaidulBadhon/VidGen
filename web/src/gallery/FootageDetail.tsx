/**
 * Everything the index knows about one clip, plus the clip itself.
 *
 * The player points at `/footage/clip/:localFile`, which honours Range
 * requests, so the browser streams and seeks instead of pulling a 20 MB file
 * before the first frame. `preload="metadata"` keeps opening the panel cheap:
 * the poster is the already-cached thumbnail.
 *
 * Nothing here is editable — the library is written by the indexing CLI, and
 * this is a reader.
 */

import { ExternalLink } from "lucide-react";
import { api, type FootageItem } from "@/api/client.ts";
import { Badge, Dialog } from "@/components/ui.tsx";
import { useI18n } from "@/i18n/index.tsx";
import { formatBytes, formatDimensions, formatDuration, formatScore, formatTimestamp } from "./format.ts";
import { isAspect } from "./query.ts";

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 truncate text-sm">{children}</dd>
    </div>
  );
}

/**
 * A labelled row of badges, or nothing at all.
 *
 * Renders null on an empty list rather than an empty heading: a clip with no
 * quality flags should show no "Quality flags" section, not a blank one.
 */
function ChipList({
  label,
  values,
  tone = "muted",
}: {
  label: string;
  values: string[] | undefined;
  tone?: "muted" | "warning" | "accent";
}) {
  const items = (values ?? []).filter((value) => String(value).trim());
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {items.map((value) => (
          <Badge key={value} tone={tone}>
            {value}
          </Badge>
        ))}
      </div>
    </div>
  );
}

function ExternalRow({ label, href, text }: { label: string; href: string; text: string }) {
  return (
    <MetaRow label={label}>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 text-primary hover:underline"
      >
        <span className="truncate">{text}</span>
        <ExternalLink size={11} className="shrink-0" />
      </a>
    </MetaRow>
  );
}

export function FootageDetail({ item, onClose }: { item: FootageItem; onClose: () => void }) {
  const { t } = useI18n();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()} title={item.summary || item.local_file}>
      <div className="space-y-5">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          key={item.local_file}
          src={api.footageClipUrl(item.local_file)}
          poster={api.footageThumbUrl(item.local_file)}
          controls
          preload="metadata"
          className="max-h-[52vh] w-full rounded-lg bg-black"
        />

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <MetaRow label={t("Gallery Duration")}>
            <span className="tabular-nums">{formatDuration(item.duration)}</span>
          </MetaRow>
          <MetaRow label={t("Gallery Dimensions")}>
            <span className="tabular-nums">{formatDimensions(item.width, item.height)}</span>
          </MetaRow>
          <MetaRow label={t("Gallery Aspect")}>
            {item.aspect ? (isAspect(item.aspect) ? t(`Gallery Aspect ${item.aspect}`) : item.aspect) : "—"}
          </MetaRow>
          <MetaRow label={t("Gallery Size")}>
            <span className="tabular-nums">{formatBytes(item.bytes)}</span>
          </MetaRow>
          <MetaRow label={t("Gallery Provider")}>
            {item.provider || t("Gallery Provider Unknown")}
          </MetaRow>
          <MetaRow label={t("Gallery Setting")}>{item.setting || "—"}</MetaRow>
          <MetaRow label={t("Gallery Time Of Day")}>{item.time_of_day || "—"}</MetaRow>
          <MetaRow label={t("Gallery Camera Motion")}>{item.camera_motion || "—"}</MetaRow>
          <MetaRow label={t("Gallery Has People")}>
            {item.has_people ? t("Gallery Yes") : t("Gallery No")}
          </MetaRow>
          <MetaRow label={t("Gallery Has On Screen Text")}>
            {item.has_on_screen_text ? t("Gallery Yes") : t("Gallery No")}
          </MetaRow>
          <MetaRow label={t("Gallery Indexed At")}>{formatTimestamp(item.indexed_at)}</MetaRow>
          {typeof item.score === "number" && (
            <MetaRow label={t("Gallery Score")}>
              <span className="tabular-nums">{formatScore(item.score)}</span>
            </MetaRow>
          )}
          {item.creator?.profile_page ? (
            <ExternalRow
              label={t("Gallery Creator")}
              href={item.creator.profile_page}
              text={item.creator.name || item.creator.profile_page}
            />
          ) : item.creator?.name ? (
            <MetaRow label={t("Gallery Creator")}>{item.creator.name}</MetaRow>
          ) : null}
          {item.source_page && (
            <ExternalRow label={t("Gallery Source Page")} href={item.source_page} text={item.source_page} />
          )}
          {item.asset_id && <MetaRow label={t("Gallery Asset Id")}>{item.asset_id}</MetaRow>}
          <MetaRow label={t("Gallery Local File")}>
            <span className="font-mono text-xs">{item.local_file}</span>
          </MetaRow>
        </dl>

        {item.detailed_description && (
          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              {t("Gallery Detailed Description")}
            </p>
            <p className="text-sm leading-relaxed">{item.detailed_description}</p>
          </div>
        )}

        {(item.use_cases ?? []).length > 0 && (
          <div>
            <p className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">
              {t("Gallery Use Cases")}
            </p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {item.use_cases.map((useCase) => (
                <li key={useCase}>{useCase}</li>
              ))}
            </ul>
          </div>
        )}

        <ChipList label={t("Gallery Mood")} values={item.mood} />
        <ChipList label={t("Gallery Tags")} values={item.tags} />
        <ChipList label={t("Gallery Search Terms")} values={item.search_terms} />
        <ChipList label={t("Gallery Quality Flags")} values={item.quality_flags} tone="warning" />
      </div>
    </Dialog>
  );
}
