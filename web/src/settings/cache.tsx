import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client.ts";
import { Alert, Button, Card } from "@/components/ui.tsx";
import { useI18n } from "@/i18n/index.tsx";

export function CacheSettingsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const stats = useQuery({ queryKey: ["cache-stats"], queryFn: api.cacheStats });

  const clear = useMutation({
    mutationFn: (scope: "all" | "videos" | "search") => api.clearCache(scope),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["cache-stats"] }),
  });

  const megabytes = ((stats.data?.videos.bytes ?? 0) / 1024 / 1024).toFixed(1);

  return (
    <Card>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-xs text-muted-foreground">{t("Cached Videos")}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {stats.data?.videos.files ?? 0}{" "}
              <span className="text-sm font-normal text-muted-foreground">({megabytes} MB)</span>
            </div>
          </div>
          <div className="rounded-lg border bg-muted/40 p-3">
            <div className="text-xs text-muted-foreground">{t("Cached Searches")}</div>
            <div className="mt-1 text-lg font-semibold tabular-nums">
              {stats.data?.search.entries ?? 0}{" "}
              <span className="text-sm font-normal text-muted-foreground">
                ({stats.data?.search.assets ?? 0} assets)
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={clear.isPending} onClick={() => clear.mutate("videos")}>
            {t("Clear Video Cache")}
          </Button>
          <Button size="sm" disabled={clear.isPending} onClick={() => clear.mutate("search")}>
            {t("Clear Search Cache")}
          </Button>
          <Button size="sm" variant="danger" disabled={clear.isPending} onClick={() => clear.mutate("all")}>
            {t("Clear All")}
          </Button>
        </div>

        {clear.isSuccess && (
          <Alert tone="success">
            {t("Removed")}: {clear.data.removed_files} files, {clear.data.removed_searches} searches
          </Alert>
        )}
      </div>
    </Card>
  );
}
