<div align="center">

# VidGen 🎬

### One-stop AI short-video generator

Give it a **topic** or a **script**, and it writes the narration, matches stock footage,
generates subtitles and background music, and renders a finished vertical video.

**Bun · Hono · Vite · React · MongoDB · FFmpeg**

</div>

---

## What this is

VidGen is a full rewrite of [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo)
on a TypeScript stack. One Bun process serves the JSON API, the generated media and the
React UI, and runs the render worker in the background. MongoDB stores settings, task
state and the stock-search cache.

The original Python implementation (FastAPI + Streamlit) is archived under
[`python-version/`](python-version/README.md) as a working reference. Nothing in the new
stack reads from it.

### The pipeline

```
script → search terms → TTS narration → subtitles → stock materials → clip & concat → mux
```

Every stage is addressable on its own: `--stop-at script` (or `terms`, `audio`,
`subtitle`, `materials`) returns that stage's output without rendering a video.

---

## Requirements

| Requirement | Notes |
|---|---|
| [Bun](https://bun.sh) ≥ 1.2 | Runtime, package manager and test runner |
| [FFmpeg](https://ffmpeg.org) | Every video and audio operation. `ffprobe` too |
| MongoDB ≥ 6 | Settings, tasks and the material cache |
| whisper.cpp *(optional)* | Only for `subtitle_provider = whisper` |

---

## Quick start

### Docker (recommended)

```bash
cp .env.example .env
docker compose up --build
```

Then open <http://127.0.0.1:8080>.

### Local development

```bash
bun install

# MongoDB, if you do not already have one
docker run -d --name vidgen-mongo -p 27017:27017 mongo:7

bun run dev            # API + worker on :7778, Vite UI on :7777
bun run dev:server     # API + worker on :7778
bun run dev:web        # Vite dev server on :7777, proxying to the API
```

Then open <http://127.0.0.1:7777>.

For a single-process production run:

```bash
bun run build          # build the React app into web/dist
bun run start          # serve API + UI from :8080
```

---

## Configuration

There is no config file. Settings live in MongoDB and are edited in the UI under
**Basic Settings**; the same values are available over the API at
`GET`/`POST /api/v1/settings`. API keys are write-only: reads return a `__stored__`
placeholder, and sending that placeholder back leaves the stored key untouched.

Deployment-level values come from the environment — see [`.env.example`](.env.example):

```
MONGODB_URI, MONGODB_DB, LISTEN_HOST, LISTEN_PORT, LOG_LEVEL,
ENDPOINT, CORS_ALLOWED_ORIGINS, FFMPEG_PATH, FFPROBE_PATH, WHISPER_CPP_PATH
```

### Provider keys in `.env`

LLM and stock-video credentials can be set there too, which is usually what you
want for a container or anything scripted — the key survives a wiped Mongo
volume, and it never has to be typed into a browser:

```
GEMINI_API_KEY, OPENAI_API_KEY, GEMMA_API_KEY
PEXELS_API_KEYS, PIXABAY_API_KEYS, COVERR_API_KEYS, TWELVELABS_API_KEYS
GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
```

The material variables take a comma-separated list, and the app rotates through
the keys when one hits its rate limit; the singular spelling (`PEXELS_API_KEY`)
works as well. A value set here wins over one saved through the UI, and the
matching field is shown read-only so the two cannot silently disagree. An empty
or absent variable falls back to the stored value, and nothing from the
environment is ever written into MongoDB.

The file is read from the repository root, so it applies to `bun run dev`,
`bun run start` and `bun run cli` alike. Real environment variables take
precedence over it, which is how `docker compose` passes these through.

### Providers

| Kind | Supported |
|---|---|
| LLM | Google Gemini, OpenAI / ChatGPT, Gemma via Ollama — all through the [Vercel AI SDK](https://sdk.vercel.ai) |
| TTS | Edge TTS (free, default), Kokoro (free, fully local, English), Azure Speech V2, SiliconFlow, Gemini TTS, Xiaomi MiMo, ElevenLabs, Chatterbox, and `no-voice` |
| Stock video | Pexels, Pixabay, Coverr, or your own local files |
| AI music | Sonilo, ElevenLabs Music |
| Subtitles | TTS word boundaries (`edge`), or Whisper transcription |
| Publishing | Native YouTube (multiple channels via Google OAuth), plus TikTok / Instagram / YouTube Shorts via [upload-post.com](https://upload-post.com) |
| Reranking | TwelveLabs Marengo (optional) |

Edge TTS, Kokoro and the bundled music library need no keys at all, so a local
install can produce a video from a script with nothing configured. Kokoro runs the
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) model on your own CPU
(~90 MB download on first use), so narration keeps working entirely offline.

### Background music

**Random** mixes a track from [`resource/songs/`](resource/songs/). That folder
ships [CC0 public-domain](https://creativecommons.org/publicdomain/zero/1.0/)
instrumentals (Loyalty Freak Music and Komiku, via the Internet Archive) — see
[`resource/songs/SOURCES.md`](resource/songs/SOURCES.md). Drop extra files in
the same folder, or upload them in the UI, to grow the library.

Sonilo and ElevenLabs Music generate a new track per video and need API keys.

---

## CLI

```bash
bun run cli --video-subject "How AI is changing everyday life"

bun run cli \
  --video-script "Clean energy is getting cheaper every year." \
  --video-source local --video-materials clip.mp4 \
  --video-aspect 16:9 --voice-name "en-US-AriaNeural-Female"

bun run cli --help
```

---

## API

Base path `/api/v1`. Responses use `{ "status": 200, "data": …, "message": "…" }`.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/videos` | Start a full render |
| `POST` | `/subtitle`, `/audio` | Run the pipeline only to that stage |
| `GET` | `/tasks` | Paginated task list |
| `GET` | `/tasks/:id` | Task status and outputs |
| `GET` | `/tasks/:id/events` | Live progress and logs over SSE |
| `POST` | `/tasks/:id/cancel` | Cancel a running task |
| `DELETE` | `/tasks/:id` | Delete a task and its files |
| `POST` | `/scripts`, `/terms`, `/social-metadata` | LLM helpers |
| `GET`/`POST` | `/settings` | Read and update settings |
| `GET`/`POST`/`DELETE` | `/youtube/channels`, `/youtube/oauth/start`, `/youtube/uploads` | Connect YouTube channels and upload |
| `GET`/`POST` | `/youtube/channels/:id/playlists` | List or create playlists for a connected channel |
| `GET`/`POST` | `/musics`, `/video_materials` | List and upload media |
| `GET` | `/voices?server=…` | Voice catalogue for a TTS engine |
| `GET`/`POST` | `/cache/stats`, `/cache/clear` | Cache management |
| `GET` | `/health` | Database and FFmpeg readiness |

Generated media is served from `/tasks/<task_id>/<file>` with HTTP range support, so
videos can be seeked directly in the browser.

---

## Development

```bash
bun run typecheck      # server + web
bun run test           # server test suite
bun run --cwd web build
```

Layout:

```
server/src/
  config/      settings schema, provider registry, environment probes
  db/          MongoDB client and document types
  routes/v1/   HTTP API
  services/
    llm/       Vercel AI SDK adapters and prompts
    voice/     TTS engines, including the Edge WebSocket protocol
    subtitle/  SRT handling, Whisper, script realignment
    material/  stock search, download, Mongo-backed cache
    music/     Sonilo and ElevenLabs video-to-music
    video/     the FFmpeg engine (probe, clip, transitions, concat, subtitles, mux)
  tasks/       queue, state, pipeline, cross-posting, startup recovery
web/src/       React UI, with the original nine locale files plus Bangla
```

### Notes on the rewrite

- **The video engine is FFmpeg directly.** MoviePy has no JavaScript equivalent, so
  clipping, transitions, concatenation and mixing are built as FFmpeg filter graphs.
- **Subtitles are rasterised with Skia**, not libass. The original layout — a bespoke
  wrap algorithm, a translucent rounded plate, and centring on visible glyph pixels —
  cannot be expressed in ASS, so each cue is drawn to a transparent PNG using the same
  bundled fonts and overlaid on the timeline.
- **Whisper runs through whisper.cpp.** Ollama serves language and vision models only and
  has no speech-to-text endpoint, so it powers the Gemma provider instead. An
  OpenAI-compatible `/v1/audio/transcriptions` adapter is available as an alternative and
  can point at a local server.
- **Scripts keep their paragraph breaks.** The Python version stripped every newline from
  model output, which silently defeated the `paragraph_number` setting.

---

## License

[MIT](LICENSE)

VidGen is a fork of [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) by
Harry, used under the MIT licence. Sponsor and referral links preserved in
[`python-version/`](python-version/) belong to that upstream project, not to VidGen.
