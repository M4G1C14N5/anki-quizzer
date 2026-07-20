# 🃏 Anki Quizzer

A self-hosted quiz web app for Anki flashcards. Pick a deck, answer questions in **Recall** or **Multiple Choice** mode, and have results automatically fed back into Anki's spaced-repetition scheduler.

Built for Tom's weekly knowledge-gauge workflow. Deploy it anywhere with Docker.

---

## Features

- **Two quiz modes**
  - **Recall** — classic flashcard: see front → reveal back → rate Again / Hard / Good / Easy
  - **Multiple Choice** — see question + 4 shuffled options, instant correct/wrong feedback
- **Automatic Anki scheduling** — quiz results reschedule cards via AnkiConnect (setDueDate + ease adjustment)
- **Deck picker** — fetches live deck list from Anki
- **Quiz history** — persisted locally (JSONL), browsable via the app
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
# Edit .env — set ANKI_URL to your Anki instance

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
2. Set env vars: `PORT=4318`, `ANKI_URL=http://<anki-host>:8764`
3. Deploy — the Dockerfile handles the rest

---

## Environment Variables

| Variable   | Default               | Description                              |
|------------|-----------------------|------------------------------------------|
| `PORT`     | `4318`                | HTTP port the server listens on          |
| `ANKI_URL` | `http://anki-desktop:8765` | AnkiConnect HTTP endpoint            |
| `DATA_DIR`  | `./data` (container) | Where quiz history files are stored    |

---

## API Endpoints

| Method | Path                   | Description                                |
|--------|------------------------|--------------------------------------------|
| GET    | `/api/health`          | Fast liveness check                        |
| GET    | `/api/health/full`     | AnkiConnect reachability probe             |
| GET    | `/api/decks`           | List all decks from Anki                   |
| POST   | `/api/quiz`            | Start a quiz → returns N cards             |
| POST   | `/api/finish`          | Submit answers, reschedule in Anki         |
| GET    | `/api/last-results`    | Last quiz summary                          |
| GET    | `/api/history`         | Full quiz history (JSONL)                  |

### `POST /api/quiz`

```json
// Request
{ "deck": "Docker", "count": 10, "mode": "recall" }
// mode: "recall" (default) | "mc"

// Response
{
  "deck": "Docker",
  "count": 10,
  "cards": [
    {
      "id": "1494727644693",
      "front": "What flag does `docker run` use to expose a port?",
      "back": "-p or --publish",
      "tags": ["docker", "networking"],
      "interval": 4,
      "ease": 2500,
      "options": [...]  // only in "mc" mode
    }
  ]
}
```

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

| Action          | Purpose                              |
|-----------------|--------------------------------------|
| `version`       | Health probe                         |
| `deckNames`     | Populate deck picker                 |
| `findCards`      | Random card selection by deck query  |
| `cardsInfo`      | Fetch card fields, interval, ease    |
| `setDueDate`    | Reschedule cards by rating           |
| `setEaseFactors` | Adjust ease (delta applied to current) |

### Scheduling Policy

| Rating | Interval effect            | Ease delta |
|--------|---------------------------|------------|
| Again  | Due immediately (day 0)    | −50        |
| Hard   | Due immediately (day 0)    | −50        |
| Good   | +1 day                     | 0          |
| Easy   | +4 days                    | +100       |

---

## Files

```
anki-quizzer/
├── server.js          # Express API server
├── public/
│   ├── index.html     # 3-screen SPA
│   ├── styles.css     # Dark theme
│   └── app.js         # Frontend logic
├── Dockerfile         # Production container
├── .env.template      # Env var template
├── README.md          # This file
├── summary.md         # Project notes (gitignored)
└── memory.md          # Session log (gitignored)
```

---

## Known Issues

1. **Cross-network AnkiConnect** — if Anki and the quizzer are on different Docker networks, use the Anki container's host-published port (e.g. `http://192.168.1.x:8764`) instead of the container hostname.
2. **Sub-minute scheduling** — AnkiConnect only supports day-granularity for `setDueDate`. "Again" and "Hard" use `days: "0"` which marks cards due immediately.
3. **Cloudflare SSL** — if self-hosting behind Cloudflare, set SSL/TLS mode to "Full" or add an origin SSL certificate for the subdomain.
