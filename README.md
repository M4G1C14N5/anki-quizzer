# 🃏 Anki Quizzer

A self-hosted quiz web app for Anki flashcards. Pick a deck, answer questions in **Recall** or **Multiple Choice** mode, and have results automatically fed back into Anki's spaced-repetition scheduler.

Deploy anywhere with Docker.

> Inspired by Geoffrey Litt — [Understanding is the new bottleneck](https://www.geoffreylitt.com/2026/07/02/understanding-is-the-new-bottleneck).

---

## Features

- **Three quiz modes**
  - **Recall** — see front → reveal back → rate Again / Hard / Good / Easy
  - **Multiple Choice** — LLM-generated distractors with per-option explanations (see [llm-cluster-mc.md](references/llm-cluster-mc.md))
  - **Session** — generate a fresh quiz from pasted summary + memory, no deck required (see [session-mode.md](references/session-mode.md))
- **Automatic Anki scheduling** — quiz results reschedule cards via AnkiConnect (`setDueDate` + ease adjustment)
- **Deck picker** — fetches live deck list from Anki
- **Quiz history** — persisted locally (JSONL); in-app browser coming soon
- **Hotkeys** — Space to reveal, 1–4 to rate
- **Single binary deploy** — one Dockerfile, no build step for the frontend

---

## Quick Start

### Prerequisites

- Anki running with [AnkiConnect](https://ankiweb.net/shared/info/2055492159) add-on installed
- Node.js 18+ (local dev) **or** Docker (production)

### Local Development

```bash
git clone https://github.com/M4G1C14N5/anki-quizzer.git
cd anki-quizzer
cp .env.template .env
# Edit .env — set ANKI_URL (and LLM_* if using session/cluster MC)

npm install
node server.js
# open http://localhost:4318
```

### Docker / Production

```bash
cp .env.template .env
# Edit .env

docker build -t anki-quizzer .
docker run -d -p 4318:4318 \
  --env-file .env \
  --name anki-quizzer \
  anki-quizzer
```

### Coolify (recommended for self-hosted)

1. Point Coolify at `https://github.com/M4G1C14N5/anki-quizzer`
2. Set env vars: `PORT=4318`, `ANKI_URL=http://<anki-host>:8764`, plus `LLM_*` if using LLM modes
3. Deploy — the Dockerfile handles the rest

---

## Environment Variables

See [`references/env-setup.md`](references/env-setup.md) for full setup (network topologies, LLM vars, troubleshooting).

Quick reference:

| Variable   | Required | Description                              |
|------------|----------|------------------------------------------|
| `PORT`     | yes      | HTTP port (default `4318`)               |
| `ANKI_URL` | yes      | AnkiConnect endpoint                     |
| `DATA_DIR`  | no       | History storage (default `./data`)       |
| `LLM_API_KEY` | for session/cluster MC | OpenAI-compatible API key      |
| `LLM_BASE_URL` | optional            | Default `https://api.minimax.io/v1`     |
| `LLM_MODEL` | optional | Default `MiniMax-M3`                     |
| `LLM_CACHE_DIR` | optional          | Cluster cache dir (default `./data/llm-cache`) |
| `LLM_TIMEOUT_MS` | optional         | Default `30000` (use `90000` for reasoning models) |

---

## API Endpoints

| Method | Path                   | Description                                |
|--------|------------------------|--------------------------------------------|
| GET    | `/api/health`          | Fast liveness check                        |
| GET    | `/api/health/full`     | AnkiConnect reachability probe             |
| GET    | `/api/decks`           | List all decks from Anki                   |
| POST   | `/api/quiz`            | Start a quiz → returns N cards             |
| POST   | `/api/finish`          | Submit answers, reschedule in Anki         |
| POST   | `/api/session-quiz`    | Generate MC quiz from session summary + memory — see [session-mode.md](references/session-mode.md) |
| POST   | `/api/llm-cache/clear` | Wipe on-disk cluster cache                 |
| GET    | `/api/last-results`    | Last quiz summary                          |
| GET    | `/api/history`         | Full quiz history (JSONL)                  |

### `POST /api/quiz`

```json
// Request
{ "deck": "Docker", "count": 10, "mode": "recall" }
// mode: "recall" (default) | "mc"
```

See [llm-cluster-mc.md](references/llm-cluster-mc.md) for how `mode: "mc"` works in v2.

### `POST /api/finish`

```json
// Request — recall mode
{ "deck": "Docker", "count": 10, "results": [{ "id": "1494...", "rating": "good" }] }

// Request — multiple choice mode
{ "deck": "Docker", "count": 10, "results": [{ "id": "1494...", "correct": true }] }

// Response
{ "saved": true, "scheduled": 10, "summary": { ... } }
```

---

## AnkiConnect Endpoints Used

| Action            | Purpose                              |
|-------------------|--------------------------------------|
| `version`         | Health probe                         |
| `deckNames`       | Populate deck picker                 |
| `findCards`       | Random card selection by deck query  |
| `cardsInfo`       | Fetch card fields, interval, ease    |
| `setDueDate`      | Reschedule cards by rating           |
| `setEaseFactors`  | Adjust ease (absolute, in 1000ths)   |

### Scheduling Policy

| Rating    | Interval effect           | Ease delta |
|-----------|---------------------------|------------|
| Again     | Due immediately (day 0)   | −50        |
| Hard      | Due immediately (day 0)   | −50        |
| Good      | +1 day                    | 0          |
| Easy      | +4 days                   | +100       |
| MC correct | Same as Good             | 0          |
| MC wrong   | Same as Again            | −50        |

---

## Files

```
anki-quizzer/
├── server.js              # Express API server
├── lib/
│   ├── llm.js             # OpenAI-compatible LLM client (timeout, retry, strip thinking blocks)
│   ├── cluster-cache.js   # On-disk cluster cache (sha256-keyed)
│   └── prompts.js         # SESSION_PROMPT + CLUSTER_PROMPT templates
├── public/
│   ├── index.html         # 3-screen SPA
│   ├── styles.css         # Dark theme
│   └── app.js             # Frontend logic
├── references/
│   ├── env-setup.md       # ANKI_URL topologies + LLM env vars
│   ├── session-mode.md    # POST /api/session-quiz deep dive
│   └── llm-cluster-mc.md  # v2 cluster MC pipeline + cache behavior
├── Dockerfile             # Production container
├── .env.template          # Env var template
└── README.md              # This file
```

---

## Known Issues

1. **Cross-network AnkiConnect** — if Anki and the quizzer are on different Docker networks, use the Anki container's host-published port (e.g. `http://192.168.1.x:8764`) instead of the container hostname. See [env-setup.md](references/env-setup.md).
2. **Sub-minute scheduling** — AnkiConnect only supports day-granularity for `setDueDate`. "Again" and "Hard" use `days: "0"` which marks cards due immediately.
3. **Cloudflare SSL** — if self-hosting behind Cloudflare, set SSL/TLS mode to "Full" or add an origin SSL certificate for the subdomain.
4. **Reasoning-model latency** — cluster MC's first call on a reasoning model (MiniMax-M3) takes ~30–45s. Default `LLM_TIMEOUT_MS=30000` is too tight; bump to `90000`.
5. **Reasoning-model JSON parsing** — reasoning models emit `<think>...</think>` blocks even with `response_format=json_object`. `lib/llm.js` strips them before parsing; if you swap providers and this regresses, check that strip first.
