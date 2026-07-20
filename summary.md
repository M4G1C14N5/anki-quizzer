# anki-quizzer

Anki flashcard quizzer web app — Tom can pick a deck, get N random cards, self-rate (Again/Hard/Good/Easy), and the app reschedules those cards in Anki via AnkiConnect.

## Stack

- **Backend:** Node.js 22 + Express 4 (single `server.js`)
- **Frontend:** vanilla HTML/CSS/JS in `public/` (no build step)
- **Data:** AnkiConnect (HTTP) for cards, scheduling; local JSONL for history
- **Container:** Dockerfile (`node:20-alpine`), exposed on port 4318

## How to run

### Production (Coolify)

The app is deployed on **claw-server** as a Coolify application:

- **Coolify UUID:** `hise8zugph4v9mltgwrcn1ug`
- **Project:** `private-services` (private)
- **FQDN (configured):** `http://quizzer.camuedlabs.org`
- **Port:** `4318` (internal → Traefik)
- **GitHub:** `M4G1C14N5/anki-quizzer` (public, auto-deploy on push)
- **Image:** built from this repo's `Dockerfile`

Env vars (set in Coolify):
- `ANKI_URL=http://172.18.0.3:8764` — AnkiConnect over the host-published port (the
  Anki container listens on its internal `8765`, but the quizzer is in a separate
  Coolify compose project so container-name DNS doesn't resolve. Using the host
  port `8764` works because it's published onto the coolify network at the Anki
  container's IP `172.18.0.3`).
- `PORT=4318`

Redeploy: `coolify__deploy_by_tag_or_uuid → uuid=hise8zugph4v9mltgwrcn1ug, force=true`
(or push to `main` on GitHub → webhook auto-deploys).

### Local development

```bash
cd anki-quizzer
npm install
ANKI_URL=http://192.168.192.119:8764 PORT=4318 node server.js
# open http://localhost:4318
```

## AnkiConnect endpoints used

| Action       | Why                                              |
|--------------|--------------------------------------------------|
| `version`    | health probe (`/api/health/full`)                |
| `deckNames`  | deck dropdown (`GET /api/decks`)                 |
| `findCards`  | random N cards from a deck (`POST /api/quiz`)    |
| `cardsInfo`  | front/back fields, interval, ease (`/api/quiz`)  |
| `setDueDate` | reschedule per rating (`POST /api/finish`)       |
| `adjustEase` | nudge ease on borderline cards (`/api/finish`)   |

## Scheduling policy

| Rating | Due in     | Ease Δ   |
|--------|-----------|----------|
| Again  | 1 minute  | —        |
| Hard   | 6 minutes | −50      |
| Good   | 1 day     | —        |
| Easy   | 4 days    | +100     |

(`adjustEase` is in 1000ths — so −50 = −0.05 ease, +100 = +0.10 ease.)

## API surface

| Method | Path             | Purpose                                  |
|--------|------------------|------------------------------------------|
| GET    | `/`              | Static SPA (`public/index.html`)         |
| GET    | `/api/health`    | Fast liveness (no Anki probe)            |
| GET    | `/api/health/full` | Slow: actually probes AnkiConnect      |
| GET    | `/api/decks`     | `{decks: [...]}` from AnkiConnect        |
| POST   | `/api/quiz`      | `{deck, count}` → picks N random cards   |
| POST   | `/api/finish`    | `{deck, count, results:[{id,rating}]}`   |
|        |                  | reschedules via setDueDate + adjustEase  |
|        |                  | writes `data/last-results.json`         |
|        |                  | appends to `data/history.jsonl`         |
| GET    | `/api/last-results` | the last quiz summary                  |
| GET    | `/api/history`   | full quiz history                        |

## Files

```
anki-quizzer/
├── server.js          # Express server + AnkiConnect proxy
├── package.json
├── Dockerfile         # node:20-alpine, EXPOSE 4318
├── .dockerignore
├── .gitignore
├── public/
│   ├── index.html     # 3-screen SPA (setup / quiz / results)
│   ├── styles.css     # dark theme
│   └── app.js         # frontend logic, hotkeys
├── data/              # runtime: last-results.json, history.jsonl (gitignored)
├── summary.md         # this file
└── memory.md          # session log of quizzes
```

## Known issues / quirks

1. **Cloudflare origin SSL** — `quizzer.camuedlabs.org` resolves via wildcard DNS,
   but Cloudflare returns 530 ("error code: 1033") because there's no origin SSL
   configuration for this subdomain. **Tom needs to set SSL/TLS encryption mode
   to "Full" or "Flexible" in the Cloudflare dashboard for `quizzer.camuedlabs.org`
   (same fix that worked for `careerops.camuedlabs.org`).** Once done, the FQDN
   works end-to-end. Until then, use the internal URL `https://192.168.192.119:443`
   with `Host: quizzer.camuedlabs.org` header (zero-tier LAN only).

2. **Traefik router-conflict on FQDN change** — when you change the FQDN in
   Coolify and redeploy, Traefik briefly logs "Router defined multiple times with
   different configurations". The conflict resolves after the old container stops.
   If Traefik keeps the conflict (rare), `docker restart coolify-proxy` clears it.

3. **GitHub repo is public** — required because Coolify's GitHub App integration
   wasn't configured for this repo. The app has no secrets; safe to be public.

4. **Anki hostname doesn't resolve** — the quizzer and Anki are in different
   Coolify compose projects, so `anki-desktop` doesn't resolve via Docker DNS.
   Workaround: use the Anki container's IP (`172.18.0.3`) on the host-published
   port `8764`. If the Anki container's IP changes (e.g. recreate), update the
   `ANKI_URL` env var.

## Maintenance

- Push to `main` → Coolify webhook redeploys.
- If the app needs to be rebuilt manually: `coolify__deploy_by_tag_or_uuid force=true`.
- Logs: `docker logs <container>` (find via `docker ps --filter label=coolify.resourceName=anki-quizzer`).