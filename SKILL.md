---
name: anki-quizzer
description: "Quiz yourself on Anki decks in recall or multiple-choice mode; results auto-reschedule cards via AnkiConnect."
---

# Anki Quizzer

Self-hosted flashcard quiz app with two modes: **recall** (standard flashcard) and **multiple choice** (question + 4 options). Answers feed back into Anki's spaced-repetition scheduler automatically.

## When to use

- A human wants to quiz themselves on an Anki deck and have results propagate back to Anki
- A study session needs a web UI instead of Anki's built-in review
- Multiple choice is desired for faster, more gamified knowledge checks

## How it works

1. Serve the app (Docker or Node.js)
2. Open the web UI → pick a deck → pick question count → choose Recall or MC mode
3. Answer cards in the browser
4. On quiz completion, the app calls AnkiConnect to reschedule each card based on performance

## Deployment

### Docker (any host)

```bash
git clone https://github.com/M4G1C14N5/anki-quizzer.git
cd anki-quizzer
cp .env.template .env
# Edit .env: set ANKI_URL to your Anki + AnkiConnect endpoint

docker build -t anki-quizzer .
docker run -d -p 4318:4318 --env-file .env --name anki-quizzer anki-quizzer
```

### Coolify (recommended for self-hosted AI rigs)

```bash
# Add to Coolify as a new application
# Git repo: https://github.com/M4G1C14N5/anki-quizzer
# Branch: main
# Build pack: Dockerfile
# Port: 4318
# Env vars:
#   ANKI_URL=http://<anki-host>:8764
#   PORT=4318
```

### Local development

```bash
npm install
cp .env.template .env
node server.js
# → http://localhost:4318
```

## AnkiConnect requirement

Anki must be running with the [AnkiConnect add-on](https://ankiweb.net/shared/info/2055492159) (addon ID `2055492159`).

- Anki machine: the host running Anki
- ANKI_URL format:
  - Same Docker network: `http://anki-desktop:8765`
  - Cross-network: `http://<anki-host-ip>:8764` (8764 is the host-published port)
  - Local dev: `http://localhost:8764`

## API

All endpoints are on the quizzer server (default `localhost:4318`).

| Method | Path                  | Purpose                          |
|--------|-----------------------|----------------------------------|
| GET    | `/api/health`         | Liveness                         |
| GET    | `/api/health/full`    | AnkiConnect reachability         |
| GET    | `/api/decks`          | `{decks: ["Deck1", "Deck2"]}`   |
| POST   | `/api/quiz`           | Start quiz → returns cards       |
| POST   | `/api/finish`         | Submit answers, reschedule cards |
| GET    | `/api/history`         | Full quiz history (JSONL)        |
| POST   | `/api/session-quiz`    | Generate MC quiz from session goal + notes |
| POST   | `/api/llm-cache/clear` | Wipe on-disk cluster cache       |

## Generation modes

v2 adds two LLM-backed quiz generation paths. Both use an OpenAI-compatible
chat-completions endpoint (defaults to MiniMax). The app must **not 500 when
`LLM_API_KEY` is missing** — missing-key behaviour is documented below.

### Session mode — `POST /api/session-quiz`

Body:

```json
{ "goal": "<markdown>", "notes": "<markdown>" }
```

Response:

```json
{
  "concepts": [
    {
      "title": "...",
      "background": "...",
      "intuition": "...",
      "quiz": [
        { "question": "...",
          "options": [
            { "label": "A", "text": "...", "isCorrect": false, "explanation": "..." },
            { "label": "B", "text": "...", "isCorrect": true,  "explanation": "..." },
            { "label": "C", "text": "...", "isCorrect": false, "explanation": "..." },
            { "label": "D", "text": "...", "isCorrect": false, "explanation": "..." }
          ]
        }
      ]
    }
  ]
}
```

- 1–3 concepts, each with exactly 5 MC questions (server drops/filters malformed entries).
- 4 labelled options per question, exactly one correct.
- `explanation` is required on every option (right and wrong).
- The server applies a final shuffle on options so the correct answer doesn't
  sit in the same slot every time.
- Not cached — fresh per request.

### Cluster mode — `POST /api/quiz {deck, count, mode:"mc"}` (v2)

In v2, MC mode no longer uses arbitrary cards' backs as distractors. Instead:

1. The server pulls `count * 4` cards from the deck (rich pool).
2. Cards are grouped by their **primary tag** (first tag of each card).
   Cards without tags go to a `"_untagged"` bucket. If most cards are
   untagged (or only one tag bucket exists), all cards stay in one cluster.
3. For **each cluster**, the server fires one LLM call with a
   `CLUSTER_PROMPT` (in `lib/prompts.js`) containing the cluster's cards.
   The LLM returns rich, concept-derived distractors + per-option
   explanations — not random backs.
4. The result is **cached** to disk at `${LLM_CACHE_DIR || './data/llm-cache'}/clusters.json`
   keyed by `sha256(deckName + "|" + cardIds.sort().join(",") + "|" + contentHash)`
   where `contentHash = sha256(concat of "id::front||back" per card)`. Subsequent
   calls with unchanged content skip the LLM.
5. Clusters are merged back into a single `cards` array of length `count`.
   If a cluster fails (LLM error) or the merge can't reach `count` (tiny
   decks with one cluster), the server pads with the legacy
   distractor-from-backs logic — no explanations on padded cards.

### Cache management — `POST /api/llm-cache/clear`

Wipes `clusters.json` (and any future cache files). **No auth** — the deploy
is LAN-only via Coolify. Documented inline; revisit before any public exposure.

### Environment variables

| Var               | Required for      | Default                       |
|-------------------|-------------------|-------------------------------|
| `LLM_API_KEY`     | session + cluster | **required** for both modes   |
| `LLM_BASE_URL`    | both modes        | `https://api.minimax.io/v1` |
| `LLM_MODEL`       | both modes        | `MiniMax-M3`                 |
| `LLM_CACHE_DIR`   | cluster mode      | `./data/llm-cache`           |
| `LLM_TIMEOUT_MS`  | both modes        | `30000`                       |

### Missing `LLM_API_KEY` behaviour

| Endpoint                          | Behaviour when key is missing                  |
|-----------------------------------|------------------------------------------------|
| `POST /api/session-quiz`          | Returns `503 {error:"LLM_API_KEY is not set..."}` |
| `POST /api/quiz?mode=mc`          | Falls back to distractor-from-backs; options **have no `explanation` field**; logs `[mc] LLM_API_KEY not set — using distractor-from-backs mode (no explanations)` to console. No `5xx`. |
| `POST /api/quiz?mode=recall`      | Unaffected.                                    |

### Quiz request

```json
POST /api/quiz
{ "deck": "Docker", "count": 10, "mode": "recall" }
```

`mode` is `"recall"` (default) or `"mc"` (multiple choice).

### Finish request

```json
POST /api/finish
{ "deck": "Docker", "count": 10, "results": [{ "id": "1494...", "rating": "good" }] }
```

For MC mode, replace `rating` with `"correct": true|false`. The server maps correct→good, incorrect→again for scheduling.

## Scheduling (AnkiConnect)

| Rating    | Effect                          |
|-----------|---------------------------------|
| Again     | Due immediately, ease −50       |
| Hard      | Due immediately, ease −50       |
| Good      | +1 day, no ease change          |
| Easy      | +4 days, ease +100              |
| MC correct | Same as Good                   |
| MC wrong  | Same as Again                   |

Uses `setDueDate` + `setEaseFactors` (absolute, in 1000ths).

## Customization

- **Hotkeys**: Space = reveal, 1/2/3/4 = rate (recall mode)
- **Question count**: 1–50 per quiz
- **Deck**: any deck in Anki, or "All decks"
- **Port**: change `PORT` env var
- **History path**: `DATA_DIR` env var (default `./data` in container)

## Troubleshooting

- **Anki unreachable**: verify ANKI_URL is correct and AnkiConnect add-on is enabled in Anki's add-ons menu
- **No cards found**: check the deck name matches exactly (case-sensitive)
- **Scheduling has no effect**: Anki must be open during quiz finish for AnkiConnect to write to the database
