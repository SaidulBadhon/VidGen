/**
 * One clip in the gallery grid.
 *
 * The tile is a poster frame with the clip's `summary` as its caption —
 * there is no separate title in the index, the summary *is* the title.
 *
 * Thumbnails are `loading="lazy"` because the grid is a window onto 1,512
 * clips: paging keeps the DOM small, and lazy loading keeps a tall page from
 * firing a request per tile before the user has scrolled to it.
 */

import { useState } from "react";
import { Film, ImageOff } from "lucide-react";
import { api, type FootageItem } from "@/api/client.ts";
import { useI18n } from "@/i18n/index.tsx";
import { formatDuration } from "./format.ts";
import { isAspect } from "./query.ts";

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-md bg-black/65 px-1.5 py-0.5 text-[11px] font-medium text-white tabular-nums backdrop-blur-sm">
      {children}
    </span>
  );
}

export function FootageCard({ item, onSelect }: { item: FootageItem; onSelect: (item: FootageItem) => void }) {
  const { t } = useI18n();
  const [thumbFailed, setThumbFailed] = useState(false);

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      className="group flex h-full w-full flex-col overflow-hidden rounded-xl border bg-card text-left shadow-sm outline-none transition hover:border-primary/60 hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <div className="relative aspect-video w-full shrink-0 overflow-hidden bg-muted">
        {thumbFailed ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <ImageOff size={20} />
            <span className="text-[11px]">{t("Gallery Thumb Unavailable")}</span>
          </div>
        ) : (
          <img
            src={api.footageThumbUrl(item.local_file)}
            alt={item.summary || item.local_file}
            loading="lazy"
            decoding="async"
            onError={() => setThumbFailed(true)}
            className="h-full w-full object-cover transition duration-200 group-hover:scale-[1.03]"
          />
        )}

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center gap-1 p-1.5">
          <Chip>{formatDuration(item.duration)}</Chip>
          {item.aspect && <Chip>{isAspect(item.aspect) ? t(`Gallery Aspect ${item.aspect}`) : item.aspect}</Chip>}
          {typeof item.score === "number" && (
            <span className="ml-auto rounded-md bg-primary px-1.5 py-0.5 text-[11px] font-medium text-primary-foreground tabular-nums">
              {item.score.toFixed(2)}
            </span>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1 p-2.5">
        <p className="line-clamp-2 text-xs font-medium leading-snug">
          {item.summary || item.local_file}
        </p>
        <p className="mt-auto flex items-center gap-1 truncate text-[11px] text-muted-foreground">
          <Film size={11} className="shrink-0" />
          <span className="truncate">
            {item.provider || t("Gallery Provider Unknown")}
            {item.setting ? ` · ${item.setting}` : ""}
          </span>
        </p>
      </div>
    </button>
  );
}
