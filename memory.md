# anki-quizzer memory

Session log + per-quiz tracking. **Append** to the bottom — never rewrite history.

## Format

Each quiz entry:
```
### YYYY-MM-DD HH:MM
- Deck: <deck>
- Cards: <N>
- Score: <P>%
- Breakdown: again/hard/good/easy = a/h/g/e
- Cards scheduled: <N>  (failures: <N>)
- Weak topics: <list of fronts where rating was again/hard>
```

## Build session: 2026-07-20 01:08–01:33 EDT

**What got built:**
- Node.js + Express server (`server.js`) + vanilla HTML/CSS/JS frontend
- Deployed on Coolify app `hise8zugph4v9mltgwrcn1ug` (private-services project, claw-server)
- FQDN configured: `quizzer.camuedlabs.org`
- GitHub: `M4G1C14N5/anki-quizzer` (public, auto-deploy on push)
- Container: `node:20-alpine`, port 4318

**Endpoints working:**
- `/api/health` (liveness) ✅
- `/api/health/full` (Anki probe) ✅ — `ankiVersion: 6` from `172.18.0.3:8764`
- `/api/decks` ✅
- `/api/quiz` ✅
- `/api/finish` (reschedules via setDueDate + adjustEase) ✅

**Quirk: ANKI_URL must use the IP, not `anki-desktop`.**
Cross-project DNS doesn't resolve. `http://172.18.0.3:8764` works.

**Open issue: external HTTPS via Cloudflare returns 530 (origin SSL not configured).**
Internal routing works fine (`Host: quizzer.camuedlabs.org` to localhost:80 → 200).
Tom needs to set Cloudflare SSL/TLS mode for this subdomain.

**Bugs hit during build:**
- First deploy: GitHub repo was private + no GitHub App integration → "could not read Username". Fixed by `gh repo edit --visibility public`.
- Custom healthcheck with `wget http://localhost:4318/api/health` failed because healthcheck calls AnkiConnect and times out → split into `/api/health` (fast liveness) and `/api/health/full` (slow probe).
- Traefik router conflict after FQDN change. Auto-resolved once old container stopped. Persistent state would need `docker restart coolify-proxy`.
- Coolify API gotcha: `PATCH /applications/{uuid}` accepts many fields but **rejects `fqdn`** (validation error). Workaround: use field name **`domains`** (not `fqdn`) with a full URL like `http://quizzer.camuedlabs.org`. See Coolify GitHub issue #9502.
- AnkiConnect gotchas: (a) `setDueDate` takes `{cards: [...], days: "1"}` — `days` is a STRING and `card` (singular) doesn't work; (b) `adjustEase` doesn't exist; the equivalent is `setEaseFactors({cards, easeFactors})` which expects absolute factors (1000ths, 1300–5000). Code reads current factors first via `cardsInfo` then applies the delta.

**Final state (2026-07-20 01:37 EDT):**
- All 6 API endpoints working
- End-to-end quiz verified via internal Traefik routing: 3-card Docker quiz → schedule 3 cards → no failures
- Public URL via Cloudflare (`https://quizzer.camuedlabs.org`) still 530s — Cloudflare origin SSL not configured. Tom needs to add this subdomain to Cloudflare with SSL/TLS = Full or Flexible.
- Until then, use: `http://192.168.192.119/` with `Host: quizzer.camuedlabs.org` header (LAN only), or the SSLip URL `https://hise8zugph4v9mltgwrcn1ug.192.168.192.119.sslip.io` (probably also 530 via Cloudflare proxy).

---

## Quiz history

### 2026-07-20 01:34 EDT (build verification)
- Deck: Docker
- Cards: 0 (no live quiz run yet — AnkiConnect reachable, app verified)
- Score: n/a
- Weak topics: (none yet)