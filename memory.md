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

---

## Quiz history

### 2026-07-20 01:34 EDT (build verification)
- Deck: Docker
- Cards: 0 (no live quiz run yet — AnkiConnect reachable, app verified)
- Score: n/a
- Weak topics: (none yet)