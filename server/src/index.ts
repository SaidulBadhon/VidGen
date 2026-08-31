/**
 * Application entrypoint.
 *
 * One Bun process serves the JSON API, the generated task media, and the built
 * SPA, and runs the generation worker in the background — replacing the
 * separate uvicorn and Streamlit processes of the Python version.
 */

// Must come first: it populates process.env from the root .env, and the
// modules below read it while they are being evaluated.
import "./config/dotenv.ts";

import { Hono } from "hono";
import { cors } from "hono/cors";
import { connect, disconnect } from "./db/client.ts";
import { initSettings } from "./config/settings.ts";
import { handleError } from "./http/errors.ts";
import { serveSpa, serveTaskFile } from "./http/staticFiles.ts";
import { bookRouter } from "./routes/v1/book.ts";
import { footageRouter } from "./routes/v1/footage.ts";
import { llmRouter } from "./routes/v1/llm.ts";
import { mediaRouter } from "./routes/v1/media.ts";
import { pingRouter } from "./routes/v1/ping.ts";
import { settingsRouter } from "./routes/v1/settings.ts";
import { videoRouter } from "./routes/v1/video.ts";
import { youtubeRouter } from "./routes/v1/youtube.ts";
import { startFootageIndexScheduler, stopFootageIndexScheduler } from "./services/footage/scheduler.ts";
import { logger } from "./utils/logger.ts";
import { getResponse } from "./utils/misc.ts";
import { APP_VERSION, PROJECT_NAME } from "./version.ts";

const LISTEN_HOST = process.env.LISTEN_HOST ?? "0.0.0.0";
const LISTEN_PORT = Number(process.env.LISTEN_PORT ?? 8080);

const app = new Hono();

app.onError(handleError);

const corsOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(
  "/api/*",
  cors({
    origin: corsOrigins.length > 0 ? corsOrigins : "*",
    // PATCH is what the book review endpoints use; without it the browser's
    // preflight fails before the request is ever made.
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "x-request-id"],
    credentials: corsOrigins.length > 0,
  }),
);

// Request logging, skipping the poll-heavy progress endpoints.
app.use("/api/*", async (c, next) => {
  const started = performance.now();
  await next();
  if (!c.req.path.endsWith("/events")) {
    logger.debug(`${c.req.method} ${c.req.path} -> ${c.res.status} (${(performance.now() - started).toFixed(0)}ms)`);
  }
});

app.route("/api/v1", pingRouter);
app.route("/api/v1", settingsRouter);
app.route("/api/v1", llmRouter);
app.route("/api/v1", mediaRouter);
app.route("/api/v1", videoRouter);
app.route("/api/v1", bookRouter);
app.route("/api/v1", youtubeRouter);
app.route("/api/v1", footageRouter);

// Generated media: final videos, narration audio, subtitles, script.json.
app.get("/tasks/*", (c) => serveTaskFile(c, c.req.path.replace(/^\/tasks\/?/, "")));

// SPA, with a clear message when the frontend has not been built yet.
app.get("*", (c) => {
  if (c.req.path.startsWith("/api/")) {
    return c.json(getResponse(404, undefined, "not found"), 404);
  }
  const response = serveSpa(c, c.req.path);
  if (response) return response;

  return c.text(
    `${PROJECT_NAME} API is running (v${APP_VERSION}).\n\n` +
      `The web UI has not been built yet. Run:\n  bun run build\n\n` +
      `Or start the Vite dev server on :7777 with:\n  bun run dev:web\n`,
    200,
    { "Content-Type": "text/plain; charset=utf-8" },
  );
});

async function bootstrap(): Promise<void> {
  await connect();
  await initSettings();

  // Deferred so a Mongo outage surfaces as a connection error rather than as a
  // confusing failure inside the task modules.
  const { recoverInterruptedTasks } = await import("./tasks/recovery.ts");
  await recoverInterruptedTasks();

  // The periodic footage index pass. Last, and deliberately not awaited beyond
  // arming its timer: the call only schedules, so nothing here delays
  // `Bun.serve`, and the first pass is a full interval away rather than
  // competing with the recovery sweep above for Mongo.
  //
  // It lives in the server because it cannot live outside it — macOS TCC
  // refuses a cron job and a launchd agent access to `~/Documents`, so both
  // died at exit 126 before ever reaching bun.
  startFootageIndexScheduler();
}

await bootstrap();

const server = Bun.serve({
  hostname: LISTEN_HOST,
  port: LISTEN_PORT,
  // Video renders and provider uploads can hold a request open for a while.
  idleTimeout: 255,
  fetch: app.fetch,
});

logger.success(`${PROJECT_NAME} v${APP_VERSION} listening on http://${LISTEN_HOST}:${server.port}`);

async function shutdown(signal: string): Promise<void> {
  logger.info(`received ${signal}, shutting down`);
  await server.stop(true);
  // Before `disconnect()`, always: a tick that fires after the client closes
  // would try to take a Mongo lock it could then never release.
  stopFootageIndexScheduler();
  await disconnect();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

// Deliberately no default export. Bun auto-serves a default export that looks
// like a server, so exporting `app` here started a second, unconfigured server
// on port 3000 alongside the explicit `Bun.serve` above — silently reachable
// when that port was free, and a hard EADDRINUSE crash at startup when it was
// not. This module is only ever an entrypoint; nothing imports from it.
