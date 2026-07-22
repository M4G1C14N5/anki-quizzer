# LLM Cluster Multiple Choice

v2 of MC mode. Instead of pulling random card backs as distractors, the server asks an LLM to generate concept-aware wrong answers with explanations.

**Endpoint:** `POST /api/quiz` with `mode: "mc"`

## How it differs from legacy MC

| Aspect              | Legacy (v1)                    | Cluster MC (v2)                                  |
|---------------------|--------------------------------|--------------------------------------------------|
| Distractors         | Random backs from other cards  | LLM-generated, concept-aware                     |
| Per-option explanation | None                        | Required on every option                         |
| Cluster grouping    | None                           | Cards grouped by primary tag                     |
| LLM calls           | None                           | One per cluster (cached)                         |
| Cluster size        | n/a                            | ~12 cards / cluster typically                    |

## Pipeline

1. Server pulls `count * 4` cards from the deck (rich pool).
2. Cards are grouped by **primary tag** (first tag of each card).
   - Cards without tags → `_untagged` bucket.
   - If most cards are untagged (or only one tag bucket exists), all cards stay in one cluster.
3. For **each cluster**, the server fires one LLM call with `CLUSTER_PROMPT` (`lib/prompts.js`) containing the cluster's cards.
4. The LLM returns rich, concept-derived distractors + per-option explanations.
5. Result is **cached** to disk at `${LLM_CACHE_DIR || './data/llm-cache'}/clusters.json`.
6. Clusters are merged back into a single `cards` array of length `count`.
7. If a cluster fails (LLM error) or merge can't reach `count` (tiny decks), the server pads with the legacy distractor-from-backs logic. Padded cards have **no `explanation` field**.

## Cache

**Key:** `sha256(deckName + "|" + cardIds.sort().join(",") + "|" + contentHash)`

Where `contentHash = sha256(concat of "id::front||back" per card)`.

Editing any card's content invalidates that cluster's cache automatically.

**Location:** `./data/llm-cache/clusters.json` inside the container (override with `LLM_CACHE_DIR`).

**Clear:** `POST /api/llm-cache/clear` — wipes the cache file. No auth (LAN-only deploy).

## Missing-key behavior

If `LLM_API_KEY` is not set, MC mode silently falls back to legacy distractor-from-backs:

- Options have **no `explanation` field**
- Logs `[mc] LLM_API_KEY not set — using distractor-from-backs mode (no explanations)`
- No 5xx — the quiz still works, just dumber

## Latency

| Call       | Typical (MiniMax-M3 reasoning) |
|------------|---------------------------------|
| First cluster (cold) | 30–45s               |
| Same cluster (warm)  | <100ms (cache hit)   |

`LLM_TIMEOUT_MS` defaults to 30000; bump to 90000 for clusters with 12+ cards.
