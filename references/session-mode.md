# Session Mode

Generates a multiple-choice quiz from a free-form session goal and optional notes context — no Anki deck required.

**Endpoint:** `POST /api/session-quiz`

## When to use

- End-of-session consolidation when the Anki deck doesn't yet have cards on what was covered
- Quick knowledge check from pasted notes / lecture transcript / reading summary
- Surface weak spots in fresh material by extracting concepts you might miss

## Request

```json
{
  "goal": "Free-form markdown — what was studied/covered",
  "notes": "Optional markdown — context from prior sessions"
}
```

| Field    | Required | Description                                          |
|----------|----------|------------------------------------------------------|
| `goal`   | yes      | The material to quiz on. Markdown accepted.          |
| `notes`  | no       | Cross-session context (e.g. "struggles with X").     |

## Response

```json
{
  "concepts": [
    {
      "title": "Concept name",
      "background": "Why this matters / where it fits",
      "intuition": "The mental model or shortcut",
      "quiz": [
        {
          "question": "...",
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

- **1–3 concepts** per request (server truncates if LLM returns more)
- **5 questions** per concept (server drops malformed entries)
- **4 options** per question, exactly one correct
- Every option includes an `explanation` (right and wrong)
- The server applies a final shuffle on options so the correct answer doesn't sit in the same slot every time
- **Not cached** — fresh per request

## How it works

1. Server builds a prompt from the goal + notes (template in `lib/prompts.js` → `SESSION_PROMPT`).
2. Sends to the configured LLM via OpenAI-compatible chat completions.
3. Strips `<think>...</think>` blocks (reasoning models emit them even with `response_format=json_object`).
4. Parses + validates JSON shape, drops malformed entries, returns the rest.

## Missing-key behavior

If `LLM_API_KEY` is not set, the endpoint returns:

```json
{ "error": "LLM_API_KEY is not set..." }
```

with HTTP `503`. Session mode has no fallback — it's purely LLM-driven.

## Latency

Reasoning models (e.g. MiniMax-M3) take ~30–45s for a typical goal. `LLM_TIMEOUT_MS` defaults to 30000; bump to 90000 if you see timeouts.
