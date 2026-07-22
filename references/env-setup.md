# ANKI_URL Reference

How to set `ANKI_URL` depends on where Anki is running relative to the quizzer.

## Anki on the same Docker host (same Compose/Coolify network)

```
ANKI_URL=http://anki-desktop:8765
```

The hostname `anki-desktop` is the container name of the Anki Desktop container. AnkiConnect listens on port 8765 inside the container.

Verify with:
```bash
docker ps --format '{{.Names}}' | grep anki
```

## Anki on the host machine, quizzer in Docker

```
ANKI_URL=http://host.docker.internal:8764
```

`host.docker.internal` resolves to the Docker host's IP. Port 8764 must be published on the Anki container.

If `host.docker.internal` doesn't resolve:
```
ANKI_URL=http://192.168.192.119:8764
```
(Replace with your actual host IP.)

## Anki on a different machine on the LAN

```
ANKI_URL=http://192.168.1.100:8764
```

Both machines must be on the same network. Anki must have its AnkiConnect port (8764) exposed to the LAN.

## Anki on a remote / cloud machine

Not recommended — AnkiConnect has no authentication and should not be exposed publicly.

If needed, use a VPN (WireGuard, ZeroTier) to reach the Anki machine:
```
ANKI_URL=http://10.0.0.50:8764
```
(ZeroTier LAN IP of the Anki machine.)

## Verifying connectivity

From the quizzer container/shell:
```bash
curl -X POST http://<ANKI_URL> \
  -H "Content-Type: application/json" \
  -d '{"action":"version","version":6}'
```

Should return `{"result": 6, ...}`.

## Multiple Choice Distractors

When in MC mode, the quizzer generates wrong answers by pulling from the **backs** of other cards in the same deck. This means:

- Decks with fewer than 4 cards can't do MC mode (need 1 correct + 3 distractors)
- Decks with fewer than 4 * N cards may have duplicate distractors
- The more cards in the deck, the better the MC experience

For best MC results, decks should have at least 20+ cards.

---

## LLM Environment Variables (v2)

Required for **session mode** and **LLM cluster MC** generation. Uses an OpenAI-compatible chat-completions endpoint.

| Var               | Required for        | Default                       |
|-------------------|---------------------|-------------------------------|
| `LLM_API_KEY`     | session + cluster   | **required** for both modes   |
| `LLM_BASE_URL`    | both modes          | `https://api.minimax.io/v1` |
| `LLM_MODEL`       | both modes          | `MiniMax-M3`                 |
| `LLM_CACHE_DIR`   | cluster mode        | `./data/llm-cache`           |
| `LLM_TIMEOUT_MS`  | both modes          | `30000`                       |

**Reasoning-model note:** if `LLM_MODEL` is a reasoning model (e.g. MiniMax-M3), bump `LLM_TIMEOUT_MS` to `90000`. Cluster generation for a 12-card cluster takes ~29s — at the 30s default it times out sporadically.

**Cache:** cluster MC writes per-cluster results to `${LLM_CACHE_DIR}/clusters.json` (keyed by content hash). Bump-and-prune via `POST /api/llm-cache/clear`.

See `references/llm-cluster-mc.md` for cluster cache details and `references/session-mode.md` for session-mode behavior.
