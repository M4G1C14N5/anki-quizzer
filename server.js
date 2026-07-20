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
// Again=1min, Hard=6min, Good=no change (push +1d if very overdue),
// Easy=4days. Borderline Hard → adjustEase down.

const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };

function scheduleForRating(rating) {
  const now = new Date();
  switch (rating) {
    case 'again': {
      const t = new Date(now.getTime() + 60 * 1000);
      return { kind: 'due', date: t, ease: null };
    }
    case 'hard': {
      const t = new Date(now.getTime() + 6 * 60 * 1000);
      // Borderline: nudge ease down a little.
      return { kind: 'due', date: t, ease: -50 }; // -5 percentage points
    }
    case 'good': {
      // Leave scheduling to Anki — just bump due date by +1 day to keep surface area.
      const t = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      return { kind: 'due', date: t, ease: null };
    }
    case 'easy': {
      const t = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
      return { kind: 'due', date: t, ease: +100 }; // +10pp ease
    }
    default:
      return null;
  }
}

// --- Routes ------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
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

    // Group by card for setDueDate batch (Anki supports array of cards + single date)
    // but we have per-card dates — loop.
    for (const r of results) {
      const rating = String(r.rating || '').toLowerCase();
      if (!RATINGS[rating]) continue;
      const sched = scheduleForRating(rating);
      if (!sched) continue;
      try {
        await anki('setDueDate', { card: r.id, date: sched.date.toISOString() });
        scheduled++;
      } catch (e) {
        failures.push({ id: r.id, error: e.message });
      }
      if (sched.ease !== null) {
        try {
          await anki('adjustEase', { cards: [r.id], ease: sched.ease });
        } catch (e) {
          // Non-fatal — log and continue.
          failures.push({ id: r.id, error: `adjustEase: ${e.message}` });
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