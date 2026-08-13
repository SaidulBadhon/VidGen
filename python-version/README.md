# VidGen — Python version (archived)

This is the original Python implementation (v1.3.4): FastAPI API + Streamlit WebUI + CLI.
It has been superseded by the Bun/Hono/React/MongoDB rewrite at the repository root.

It is kept here as a working reference and behavioural baseline while the rewrite reaches
parity. Nothing in the new stack imports from this directory.

## Layout note

`resource/` (fonts and built-in background music, ~197 MB) lives at the repository root and is
shared with the new stack. This directory contains a relative symlink so the Python app's
`utils.root_dir()` resolution keeps working:

```
python-version/resource -> ../resource
```

If you check the repo out on a system that does not materialise git symlinks (some Windows
setups), recreate it or copy `../resource` here before running.

## Running it

```bash
cd python-version
uv sync
uv run python main.py                      # API on :8080
uv run streamlit run ./webui/Main.py       # WebUI on :8501
```

Or with Docker:

```bash
cd python-version
docker compose up
```

Configuration still lives in `python-version/config.toml`, copied from `config.example.toml`
on first run. The new stack stores settings in MongoDB instead and does not read this file.
