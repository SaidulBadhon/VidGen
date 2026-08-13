import { Hono } from "hono";
import { ping as pingDatabase } from "../../db/client.ts";
import { getFfmpegBinary } from "../../utils/paths.ts";
import { getResponse } from "../../utils/misc.ts";
import { APP_VERSION } from "../../version.ts";

export const pingRouter = new Hono();

pingRouter.get("/ping", (c) => c.json(getResponse(200, "pong")));

/** Reports whether the dependencies a generation needs are actually reachable. */
pingRouter.get("/health", async (c) => {
  const [databaseOk, ffmpegOk] = await Promise.all([pingDatabase(), checkFfmpeg()]);
  const healthy = databaseOk && ffmpegOk;

  return c.json(
    getResponse(healthy ? 200 : 503, {
      version: APP_VERSION,
      database: databaseOk ? "ok" : "unavailable",
      ffmpeg: ffmpegOk ? "ok" : "unavailable",
    }),
    healthy ? 200 : 503,
  );
});

async function checkFfmpeg(): Promise<boolean> {
  try {
    const proc = Bun.spawn([getFfmpegBinary(), "-version"], { stdout: "ignore", stderr: "ignore" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
