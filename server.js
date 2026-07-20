// Anki Quizzer — single-file Node.js server
// Proxies AnkiConnect requests from the browser to avoid CORS / API key leakage,
// and persists quiz results + last-results.json.
//
// AnkiConnect reachable at: ANKI_URL env (default http://anki-desktop:8765)
//   - Inside Coolify/coolify network: http://anki-desktop:8765 (container hostname)
//   - From the host or outside: http://192.168.192.119:8764 → 8765
//
// Endpoints:
//   GET  /api/health              -> { ok, ankiUrl, ankiReachable, ankiVersion }
//   GET  /api/decks               -> [ "Default", "Docker", ... ]
//   POST /api/quiz {deck, count}  -> { deck, count, cards:[{id, front, back, tags, interval, ease}] }
//   POST /api/finish {deck, results:[{id, rating}]}
//        -> schedules via setDueDate / adjustEase, returns { saved:true, scheduled:n }
//   GET  /api/last-results        -> last-results.json contents
//   GET  /                        -> static public/index.html

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const PORT = parseInt(process.env.PORT || '4318', 10);
const ANKI_URL = process.env.ANKI_URL || 'http://anki-desktop:8765';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const LAST_RESULTS = path.join(DATA_DIR, 'last-results.json');
const HISTORY = path.join(DATA_DIR, 'history.jsonl');

fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- AnkiConnect helpers -----------------------------------------------

async function anki(action, params = {}, { useHebSchedule = false } = {}) {
  const body = {
    action,
    version: 6,
    params,
    ...(useHebSchedule ? { useHebSchedule: true } : {}),
  };
  const res = await fetch(ANKI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`AnkiConnect HTTP ${res.status} for action=${action}`);
  }
  const data = await res.json();
  if (data.error) {
    throw new Error(`AnkiConnect error [${action}]: ${data.error}`);
  }
  return data.result;
}

async function ankiOk() {
  try {
    const v = await anki('version');
    return { ok: true, version: v };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// --- HTML stripper (Anki fields include HTML markup) -------------------

function stripHtml(s) {
  if (!s) return '';
  // Preserve line breaks, drop everything else.
  return String(s)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// --- Scheduling policy -------------------------------------------------
// Again=1min, Hard=6min, Good=+1day (keeps surface area), Easy=+4days.
// AnkiConnect API:
//   setDueDate({ cards: [...], days: "1" })   // days is a STRING (range string)
//   setEaseFactors({ cards: [...], easeFactors: [2500] })  // 1000ths — 2500 = 2.5x
// 'ease' here is the DELTA applied to the card's current factor. We need
// the current factor first, then set the new value via setEaseFactors.

const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };

// Days (as strings, since AnkiConnect wants a string range like "1" or "1-3").
// Minutes/seconds are not supported directly, so for sub-day intervals we
// approximate by setting due-date via direct SQL on the cards table is NOT
// possible here. AnkiConnect doesn't expose timestamp-based scheduling.
// Workaround: set due-date in days. For 'Again' (1 min) we use 0 (immediately
// due, will re-show in the next session). For 'Hard' (6 min) we use 0 too
// — Anki will resurface it shortly because the interval is 0.
function scheduleForRating(rating) {
  switch (rating) {
    case 'again': {
      return { days: '0', easeDelta: -50 }; // immediately due, ease down 0.05
    }
    case 'hard': {
      return { days: '0', easeDelta: -50 }; // borderline: ease down
    }
    case 'good': {
      return { days: '1', easeDelta: 0 }; // 1 day
    }
    case 'easy': {
      return { days: '4', easeDelta: +100 }; // 4 days, ease up 0.10
    }
    default:
      return null;
  }
}

// --- Routes ------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  // Liveness only — must return fast for Docker HEALTHCHECK.
  // Anki status is a separate probe so a slow/unreachable Anki doesn't fail health.
  res.json({
    ok: true,
    ankiUrl: ANKI_URL,
    port: PORT,
    time: new Date().toISOString(),
  });
});

app.get('/api/health/full', async (_req, res) => {
  // Slow probe: actually reach AnkiConnect.
  const ok = await ankiOk();
  res.json({
    ok: ok.ok,
    ankiUrl: ANKI_URL,
    ankiVersion: ok.version || null,
    error: ok.error || null,
    port: PORT,
    time: new Date().toISOString(),
  });
});

app.get('/api/decks', async (_req, res, next) => {
  try {
    const decks = await anki('deckNames');
    res.json({ decks });
  } catch (e) { next(e); }
});

app.post('/api/quiz', async (req, res, next) => {
  try {
    const deck = (req.body && req.body.deck) || 'All';
    const count = Math.max(1, Math.min(50, parseInt(req.body && req.body.count, 10) || 10));

    let cardIds;
    if (deck === 'All') {
      cardIds = await anki('findCards', { query: '' });
    } else {
      cardIds = await anki('findCards', { query: `deck:"${deck}"` });
    }

    if (!cardIds.length) {
      return res.json({ deck, count, cards: [], message: 'No cards found in this deck.' });
    }

    // Shuffle and slice
    const shuffled = cardIds.slice().sort(() => Math.random() - 0.5);
    const picked = shuffled.slice(0, count);

    // getCards → ['1494727644693', ...]
    // cardsInfo → [{ cardId, fields, interval, ease, ... }]
    const info = await anki('cardsInfo', { cards: picked });

    const cards = info
      .filter((c) => c && c.fields)
      .map((c) => {
        // Pull the first non-empty field as "front", second as "back" if present.
        const fieldNames = Object.keys(c.fields || {});
        const frontField = fieldNames[0];
        const backField = fieldNames[1] || fieldNames[0];
        return {
          id: c.cardId,
          front: stripHtml(c.fields[frontField]?.value || ''),
          back: stripHtml(c.fields[backField]?.value || ''),
          tags: c.tags || [],
          interval: c.interval || 0,
          ease: c.ease || 0,
          deckName: c.deckName || deck,
          fieldNames,
        };
      });

    res.json({ deck, count, cards });
  } catch (e) { next(e); }
});

app.post('/api/finish', async (req, res, next) => {
  try {
    const { deck, count, results } = req.body || {};
    if (!Array.isArray(results) || !results.length) {
      return res.status(400).json({ error: 'results must be a non-empty array' });
    }

    let scheduled = 0;
    const failures = [];

    // Group by (days) bucket so we can batch setDueDate calls per unique value.
    const byDays = new Map(); // days-string -> [cardId]
    const easeDeltas = []; // {id, delta} for cards that need ease adjustment
    for (const r of results) {
      const rating = String(r.rating || '').toLowerCase();
      if (!RATINGS[rating]) continue;
      const sched = scheduleForRating(rating);
      if (!sched) continue;
      if (!byDays.has(sched.days)) byDays.set(sched.days, []);
      byDays.get(sched.days).push(r.id);
      if (sched.easeDelta) easeDeltas.push({ id: r.id, delta: sched.easeDelta });
    }

    // Batch setDueDate by days bucket.
    for (const [days, ids] of byDays) {
      try {
        await anki('setDueDate', { cards: ids, days });
        scheduled += ids.length;
      } catch (e) {
        for (const id of ids) failures.push({ id, error: `setDueDate: ${e.message}` });
      }
    }

    // For ease adjustments, we need current factors first.
    if (easeDeltas.length) {
      try {
        const infos = await anki('cardsInfo', { cards: easeDeltas.map((e) => e.id) });
        const factorById = new Map();
        for (const c of infos) factorById.set(c.cardId, c.factor || 2500);
        const newFactors = easeDeltas.map((e) => {
          const cur = factorById.get(e.id) || 2500;
          return Math.max(1300, Math.min(5000, cur + e.delta));
        });
        await anki('setEaseFactors', {
          cards: easeDeltas.map((e) => e.id),
          easeFactors: newFactors,
        });
      } catch (e) {
        for (const ed of easeDeltas) {
          failures.push({ id: ed.id, error: `setEaseFactors: ${e.message}` });
        }
      }
    }

    const summary = {
      finishedAt: new Date().toISOString(),
      deck: deck || 'All',
      requested: count || results.length,
      answered: results.length,
      byRating: results.reduce((acc, r) => {
        const k = String(r.rating || 'unknown').toLowerCase();
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      score: Math.round(
        (results.filter((r) => ['good', 'easy'].includes(String(r.rating).toLowerCase())).length /
          results.length) *
          100,
      ),
      scheduled,
      failures,
      results,
    };

    await fsp.writeFile(LAST_RESULTS, JSON.stringify(summary, null, 2));
    await fsp.appendFile(HISTORY, JSON.stringify(summary) + '\n');

    res.json({ saved: true, scheduled, summary });
  } catch (e) { next(e); }
});

app.get('/api/last-results', async (_req, res) => {
  try {
    const buf = await fsp.readFile(LAST_RESULTS, 'utf8').catch(() => null);
    if (!buf) return res.json({ exists: false });
    res.type('application/json').send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (_req, res) => {
  try {
    const buf = await fsp.readFile(HISTORY, 'utf8').catch(() => '');
    const lines = buf.split('\n').filter(Boolean);
    res.json({ count: lines.length, history: lines.map((l) => JSON.parse(l)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || String(err) });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[anki-quizzer] listening on :${PORT}, ANKI_URL=${ANKI_URL}`);
});