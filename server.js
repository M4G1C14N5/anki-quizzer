// Anki Quizzer — Node.js 22 + Express 4 server.
//
// Proxies AnkiConnect requests from the browser to avoid CORS / API key leakage,
// persists quiz results + last-results.json, and (in v2) drives two LLM-backed
// quiz-generation modes: /api/session-quiz and cluster-aware /api/quiz?mode=mc.
//
// AnkiConnect reachable at: ANKI_URL env (default http://anki-desktop:8765)
//   - Inside Coolify/coolify network: http://anki-desktop:8765 (container hostname)
//   - From the host or outside: http://192.168.192.119:8764 → 8765
//
// Endpoints:
//   GET  /api/health              -> { ok, ankiUrl, ankiReachable, ankiVersion }
//   GET  /api/health/full         -> same, with actual AnkiConnect probe
//   GET  /api/decks               -> { decks: [...] }
//   POST /api/quiz {deck, count, mode}
//        mode: "recall" (default) -> cards: [{id, front, back, tags, interval, ease}]
//        mode: "mc"      -> cards: [{id, ..., options:[{label, text, isCorrect, explanation}]}]
//                           v2: grouped by primary tag, one LLM call per cluster,
//                               rich distractors, content-hash cached. Without
//                               LLM_API_KEY, falls back to distractor-from-backs.
//   POST /api/session-quiz {goal, notes}
//        -> { concepts: [{title, background, intuition, quiz:[...5 MCQs]}] }
//        (legacy fields `summary`/`memory` are accepted as aliases for `goal`/`notes`)
//   POST /api/finish {deck, count, mode, sessionType?, results:[...], quiz?:[...], goal?, notes?}
//        -> schedules via setDueDate + setEaseFactors; returns { saved, scheduled }
//        Cluster sessions (sessionType:'cluster' OR any synthetic IDs in results)
//        skip Anki scheduling entirely; everything is still persisted to history.
//        The full quiz payload (questions, options, cluster bg) is persisted so
//        the history view can replay the quiz without re-fetching from Anki.
//        For cluster sessions `goal`/`notes` are persisted to history.
//   GET  /api/last-results        -> last quiz summary
//   GET  /api/history             -> { count, history: [...] } (list view, no quiz payload)
//   GET  /api/history/:index      -> single history entry with full quiz payload
//   POST /api/llm-cache/clear     -> wipe cluster-cache file (LAN-only auth)
//   GET  /                        -> static public/index.html

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { callLLM } = require('./lib/llm');
const { fillSessionPrompt, fillClusterPrompt } = require('./lib/prompts');
const clusterCache = require('./lib/cluster-cache');

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

// --- HTML stripper -----------------------------------------------------

function stripHtml(s) {
  if (!s) return '';
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
// Again=1min, Hard=6min, Good=+1day, Easy=+4days. AnkiConnect doesn't
// expose timestamp scheduling so sub-day intervals use days=0 (immediately due).

const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };

function scheduleForRating(rating) {
  switch (rating) {
    case 'again': return { days: '0', easeDelta: -50 };
    case 'hard':  return { days: '0', easeDelta: -50 };
    case 'good':  return { days: '1', easeDelta: 0 };
    case 'easy':  return { days: '4', easeDelta: +100 };
    default: return null;
  }
}

// Cluster/session-mode results carry synthetic IDs like "session-0" (set in
// public/app.js startQuiz()). They have no Anki cardId, so skip scheduling
// for them — but they still count toward score / byRating in the history
// entry below. Also catch results tagged `sessionType: "cluster"` defensively,
// in case the front-end ever sets the flag without the `session-` prefix.
function isSyntheticResult(r) {
  if (!r) return false;
  if (r.sessionType === 'cluster') return true;
  return typeof r.id === 'string' && r.id.startsWith('session-');
}

// --- v2 generation-mode helpers ----------------------------------------
// /api/session-quiz: LLM generates 1–3 concepts from goal+notes with 5 MCQs each.
// /api/quiz?mode=mc (v2): group cards by primary tag, one LLM call per cluster,
//   cache per-cluster results by content hash; fall back to distractor-from-backs
//   (no explanations) if LLM_API_KEY is missing or the call fails.

function primaryTag(tags) {
  if (!Array.isArray(tags) || tags.length === 0) return '_untagged';
  return String(tags[0]);
}

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Take a list of options (already has correct:true/false), apply a final
// server-side shuffle, and assign labels A..D.
function labelAndShuffle(options) {
  if (!Array.isArray(options)) return [];
  const cleaned = options.map((o) => ({
    text: String(o && o.text ? o.text : ''),
    isCorrect: !!(o && o.correct === true),
    explanation: (o && typeof o.explanation === 'string') ? o.explanation : undefined,
  }));
  shuffleInPlace(cleaned);
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  return cleaned.slice(0, 4).map((o, i) => ({
    label: labels[i],
    text: o.text,
    isCorrect: o.isCorrect,
    ...(o.explanation ? { explanation: o.explanation } : {}),
  }));
}

// Group cards by primary tag. If most cards have no tags (or there is only
// one tag bucket), treat them as a single cluster to avoid degenerate tiny
// clusters that would each cost an LLM call.
function groupByPrimaryTag(cards) {
  const buckets = new Map();
  for (const c of cards) {
    const t = primaryTag(c.tags);
    if (!buckets.has(t)) buckets.set(t, []);
    buckets.get(t).push(c);
  }
  const total = cards.length;
  const untaggedSize = buckets.get('_untagged')?.length || 0;
  if (buckets.size <= 1) return [cards];
  if (untaggedSize / Math.max(1, total) > 0.6) return [cards];
  return Array.from(buckets.values());
}

// Legacy MC fallback: 3 distractors picked from other cards' backs.
// Returns labelled options [A,B,C,D] without explanations.
function legacyMcDistractors(card, pool) {
  const distractors = [];
  const used = new Set([card.id]);
  const candidates = pool.slice();
  shuffleInPlace(candidates);
  for (const cand of candidates) {
    if (distractors.length >= 3) break;
    if (used.has(cand.id)) continue;
    if (!cand.back || cand.back.trim() === card.back.trim()) continue;
    distractors.push(cand.back);
    used.add(cand.id);
  }
  while (distractors.length < 3) {
    distractors.push(`(no distractor available ${distractors.length + 1})`);
  }
  const opts = [
    { label: 'A', text: card.back, isCorrect: true },
    { label: 'B', text: distractors[0], isCorrect: false },
    { label: 'C', text: distractors[1], isCorrect: false },
    { label: 'D', text: distractors[2], isCorrect: false },
  ];
  shuffleInPlace(opts);
  return opts;
}

// One LLM call for a cluster; caches per sha256(deckName|cardIds|contentHash).
// Returns { entry, fromCache, error }. Caller decides what to do on error.
async function buildClusterMC(cluster, deckName) {
  const contentHash = clusterCache.contentHashForCards(cluster);
  const key = clusterCache.clusterKey(deckName, cluster.map((c) => c.id), contentHash);

  const cached = clusterCache.get(key);
  if (cached) {
    return { entry: cached, fromCache: true, error: null };
  }
  if (!process.env.LLM_API_KEY) {
    return { entry: null, fromCache: false, error: 'LLM_API_KEY not set' };
  }
  try {
    const userPrompt = fillClusterPrompt(cluster.map((c) => ({
      id: String(c.id),
      front: c.front,
      back: c.back,
    })));
    const parsed = await callLLM({ userPrompt, expectJson: true });
    const entry = {
      deckName,
      cardIds: cluster.map((c) => String(c.id)),
      contentHash,
      background: String(parsed?.background || ''),
      intuition: String(parsed?.intuition || ''),
      cards: Array.isArray(parsed?.cards) ? parsed.cards : [],
    };
    clusterCache.set(key, entry);
    return { entry, fromCache: false, error: null };
  } catch (e) {
    return { entry: null, fromCache: false, error: e.message };
  }
}

// --- Routes ------------------------------------------------------------

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    ankiUrl: ANKI_URL,
    port: PORT,
    time: new Date().toISOString(),
  });
});

app.get('/api/health/full', async (_req, res) => {
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
    const mode = (req.body && req.body.mode) === 'mc' ? 'mc' : 'recall';

    let cardIds;
    if (deck === 'All') {
      cardIds = await anki('findCards', { query: '' });
    } else {
      cardIds = await anki('findCards', { query: `deck:"${deck}"` });
    }

    if (!cardIds.length) {
      return res.json({ deck, count, mode, cards: [], message: 'No cards found in this deck.' });
    }

    // Shuffle and slice. In MC mode, pull count*4 so we have a richer pool
    // both for distractors (fallback path) and for cluster grouping.
    const shuffled = cardIds.slice().sort(() => Math.random() - 0.5);
    const poolSize = mode === 'mc' ? Math.min(cardIds.length, count * 4) : count;
    const pool = shuffled.slice(0, poolSize);
    const picked = mode === 'mc' ? pool.slice(0, count) : pool;

    const info = await anki('cardsInfo', { cards: pool });

    const poolById = new Map();
    for (const c of info) {
      if (!c || !c.fields) continue;
      const fieldNames = Object.keys(c.fields || {});
      const frontField = fieldNames[0];
      const backField = fieldNames[1] || fieldNames[0];
      poolById.set(c.cardId, {
        id: c.cardId,
        front: stripHtml(c.fields[frontField]?.value || ''),
        back: stripHtml(c.fields[backField]?.value || ''),
        tags: c.tags || [],
        interval: c.interval || 0,
        ease: c.ease || 0,
        deckName: c.deckName || deck,
        fieldNames,
      });
    }

    let cards = [];

    if (mode === 'mc' && process.env.LLM_API_KEY) {
      // Cluster-aware MC. Group the pool by primary tag, fire one LLM call
      // per cluster in parallel, cache results. If LLM errors on a cluster,
      // fall back to legacy distractor-from-backs for that cluster only.
      const clusterInputs = Array.from(poolById.values()).map((c) => ({
        id: String(c.id),
        front: c.front,
        back: c.back,
        tags: c.tags,
        _pool: c,
      }));
      const clusters = groupByPrimaryTag(clusterInputs);

      let cacheHits = 0;
      let llmCalls = 0;
      let fellBack = 0;
      const clusterEntries = await Promise.all(clusters.map(async (cl) => {
        const { entry, fromCache, error } = await buildClusterMC(
          cl.map((c) => ({ id: c.id, front: c.front, back: c.back })),
          deck,
        );
        if (entry) {
          if (fromCache) cacheHits++; else llmCalls++;
          return { ok: true, entry, cluster: cl };
        }
        if (error) {
          fellBack++;
          console.warn(`[mc] cluster (${cl.length} cards) fell back: ${error}`);
        }
        return { ok: false, cluster: cl };
      }));

      const used = new Set();
      const labelled = [];

      for (const ce of clusterEntries) {
        if (ce.ok) {
          for (const c of ce.entry.cards) {
            const idStr = String(c.id);
            if (used.has(idStr)) continue;
            const poolCard = ce.cluster.find((x) => String(x.id) === idStr);
            if (!poolCard) continue;
            const options = labelAndShuffle(c.options || []);
            if (options.length !== 4 || options.filter((o) => o.isCorrect).length !== 1) continue;
            labelled.push({
              id: poolCard._pool.id,
              front: poolCard._pool.front,
              back: poolCard._pool.back,
              tags: poolCard._pool.tags,
              interval: poolCard._pool.interval,
              ease: poolCard._pool.ease,
              deckName: poolCard._pool.deckName,
              options,
              cluster: {
                background: ce.entry.background,
                intuition: ce.entry.intuition,
              },
            });
            used.add(idStr);
            if (labelled.length >= count) break;
          }
        } else {
          // Hard fallback for this cluster: legacy distractors, no explanations.
          const distractorPool = Array.from(poolById.values()).filter(
            (c) => c.back && c.back.trim(),
          );
          for (const pc of ce.cluster) {
            const idStr = String(pc.id);
            if (used.has(idStr)) continue;
            labelled.push({
              id: pc._pool.id,
              front: pc._pool.front,
              back: pc._pool.back,
              tags: pc._pool.tags,
              interval: pc._pool.interval,
              ease: pc._pool.ease,
              deckName: pc._pool.deckName,
              options: legacyMcDistractors(pc._pool, distractorPool),
            });
            used.add(idStr);
            if (labelled.length >= count) break;
          }
        }
        if (labelled.length >= count) break;
      }

      // Top-up pad if cluster mode couldn't reach `count`.
      if (labelled.length < count) {
        const distractorPool = Array.from(poolById.values()).filter(
          (c) => c.back && c.back.trim(),
        );
        let i = 0;
        while (labelled.length < count && distractorPool.length) {
          const cand = distractorPool[i++ % distractorPool.length];
          const idStr = String(cand.id);
          if (used.has(idStr)) continue;
          labelled.push({
            id: cand.id,
            front: cand.front,
            back: cand.back,
            tags: cand.tags,
            interval: cand.interval,
            ease: cand.ease,
            deckName: cand.deckName,
            options: legacyMcDistractors(cand, distractorPool),
          });
          used.add(idStr);
        }
      }

      cards = labelled.slice(0, count);
      console.log(
        `[mc] deck=${deck} clusters=${clusters.length} cacheHits=${cacheHits}` +
        ` llmCalls=${llmCalls} fellBack=${fellBack} returned=${cards.length}`,
      );
    } else if (mode === 'mc') {
      // No LLM_API_KEY → legacy path; no explanations on options.
      console.warn('[mc] LLM_API_KEY not set — using distractor-from-backs mode (no explanations)');
      const distractorPool = Array.from(poolById.values()).filter(
        (c) => c.back && c.back.trim(),
      );
      cards = picked.map((cardRef) => {
        const cardId = typeof cardRef === 'object' ? cardRef.cardId : cardRef;
        const c = poolById.get(cardId);
        if (!c) return null;
        return { ...c, options: legacyMcDistractors(c, distractorPool) };
      }).filter(Boolean);
    } else {
      cards = picked.map((cardRef) => {
        const cardId = typeof cardRef === 'object' ? cardRef.cardId : cardRef;
        return poolById.get(cardId);
      }).filter(Boolean);
    }

    res.json({ deck, count, mode, cards });
  } catch (e) { next(e); }
});

app.post('/api/session-quiz', async (req, res, next) => {
  try {
    // Field names: goal + notes. Accept the legacy `summary`/`memory`
    // aliases as a fallback so older clients keep working while we migrate.
    const body = req.body || {};
    let goal = (body.goal != null ? String(body.goal) : '');
    let notes = (body.notes != null ? String(body.notes) : '');
    if (!goal && body.summary != null) {
      console.warn('[session-quiz] legacy field "summary" used; pass "goal" instead');
      goal = String(body.summary);
    }
    if (!notes && body.memory != null) {
      console.warn('[session-quiz] legacy field "memory" used; pass "notes" instead');
      notes = String(body.memory);
    }
    if (!goal.trim() && !notes.trim()) {
      return res.status(400).json({ error: 'goal and notes are both empty' });
    }
    if (!process.env.LLM_API_KEY) {
      return res.status(503).json({
        error: 'LLM_API_KEY is not set — /api/session-quiz requires it',
      });
    }

    const userPrompt = fillSessionPrompt(goal, notes);
    const parsed = await callLLM({ userPrompt, expectJson: true });

    const rawConcepts = Array.isArray(parsed?.concepts) ? parsed.concepts : [];
    const concepts = rawConcepts.map((c) => ({
      title: String(c?.title || ''),
      background: String(c?.background || ''),
      intuition: String(c?.intuition || ''),
      quiz: Array.isArray(c?.quiz) ? c.quiz.map((q) => ({
        question: String(q?.question || ''),
        options: labelAndShuffle(q?.options || []),
      })).filter((q) => q.options.length === 4) : [],
    })).filter((c) => c.quiz.length > 0);

    if (!concepts.length) {
      return res.status(502).json({ error: 'LLM returned no usable concepts' });
    }

    res.json({ concepts });
  } catch (e) {
    // Surface auth failures with a clear message (Tom requested 500-with-clear-msg on fake keys).
    if (e && /LLM auth failed/i.test(e.message)) {
      return res.status(500).json({ error: e.message });
    }
    if (e && e.code === 'LLM_NO_KEY') {
      return res.status(503).json({ error: e.message });
    }
    next(e);
  }
});

app.post('/api/llm-cache/clear', async (_req, res) => {
  // AUTH: deliberately not required — this is a LAN-only Coolify deploy.
  // Call this to force regeneration of the cluster cache after content updates.
  try {
    clusterCache.clear();
    res.json({ ok: true, cleared: clusterCache.path() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/finish', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { deck, count, mode, results, quiz, sessionType } = body;
    // Field names: goal + notes. Accept the legacy `summary`/`memory`
    // aliases as a fallback so older clients keep working while we migrate.
    let goal = (body.goal != null ? String(body.goal) : '');
    let notes = (body.notes != null ? String(body.notes) : '');
    if (!goal && body.summary != null) {
      console.warn('[finish] legacy field "summary" used; pass "goal" instead');
      goal = String(body.summary);
    }
    if (!notes && body.memory != null) {
      console.warn('[finish] legacy field "memory" used; pass "notes" instead');
      notes = String(body.memory);
    }
    if (!Array.isArray(results) || !results.length) {
      return res.status(400).json({ error: 'results must be a non-empty array' });
    }

    // Determine session type: explicit flag, OR heuristic from results
    // (any synthetic ID like "session-0" or sessionType:'cluster' on a result).
    const effectiveSessionType = (() => {
      if (sessionType === 'cluster') return 'cluster';
      if (sessionType === 'daily') return 'daily';
      if (results.some((r) => isSyntheticResult(r))) return 'cluster';
      return 'daily';
    })();

    let scheduled = 0;
    let skipped = 0;
    const failures = [];

    function ratingForResult(r) {
      if (mode === 'mc') {
        if (typeof r.correct === 'boolean') return r.correct ? 'good' : 'again';
        return null;
      }
      const rating = String(r.rating || '').toLowerCase();
      return RATINGS[rating] ? rating : null;
    }

    // Cluster/session-mode results (synthetic IDs like "session-0" OR
    // `sessionType: "cluster"`) are persisted to history but never sent to
    // AnkiConnect — they have no real cardId. We filter at push time so
    // the buckets below only contain real Anki IDs; `scheduled` then
    // naturally reflects only real cards. Cluster entries still count
    // toward `score` and `byRating` because those iterate `results`
    // directly (not `byDays`).
    const byDays = new Map();
    const easeDeltas = [];
    for (const r of results) {
      const rating = ratingForResult(r);
      if (!rating) continue;
      if (isSyntheticResult(r)) {
        skipped++;
        continue;
      }
      const sched = scheduleForRating(rating);
      if (!sched) continue;
      if (!byDays.has(sched.days)) byDays.set(sched.days, []);
      byDays.get(sched.days).push(r.id);
      if (sched.easeDelta) easeDeltas.push({ id: r.id, delta: sched.easeDelta });
    }

    for (const [days, ids] of byDays) {
      try {
        await anki('setDueDate', { cards: ids, days });
        scheduled += ids.length;
      } catch (e) {
        for (const id of ids) failures.push({ id, error: `setDueDate: ${e.message}` });
      }
    }

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

    console.log(
      `[finish] deck=${deck || 'All'} mode=${mode === 'mc' ? 'mc' : 'recall'}` +
      ` scheduled=${scheduled} skipped=${skipped} (cluster/synthetic session IDs)`,
    );

    const summary = {
      finishedAt: new Date().toISOString(),
      deck: deck || 'All',
      mode: mode === 'mc' ? 'mc' : 'recall',
      // 'daily' = Anki deck quiz; 'cluster' = LLM-generated session quiz
      // from goal+notes. Cluster sessions never hit AnkiConnect.
      sessionType: effectiveSessionType,
      // For cluster sessions, the original goal/notes are persisted so the
      // history view can show the prompt that generated the quiz.
      goal: effectiveSessionType === 'cluster' ? goal : null,
      notes: effectiveSessionType === 'cluster' ? notes : null,
      requested: count || results.length,
      answered: results.length,
      byRating: results.reduce((acc, r) => {
        const k = mode === 'mc'
          ? (r.correct ? 'correct' : 'incorrect')
          : String(r.rating || 'unknown').toLowerCase();
        acc[k] = (acc[k] || 0) + 1;
        return acc;
      }, {}),
      score: Math.round(
        (results.filter((r) => mode === 'mc'
          ? r.correct === true
          : ['good', 'easy'].includes(String(r.rating).toLowerCase())
        ).length /
          results.length) *
          100,
      ),
      scheduled,
      skipped,
      skippedReason: skipped
        ? 'cluster/synthetic session IDs (no real Anki cardId)'
        : null,
      failures,
      // Persist the full quiz payload (questions, options, cluster background)
      // so the history view can replay the quiz without re-fetching from Anki.
      // For cluster sessions this is the LLM-generated quiz; for daily sessions
      // it's the Anki deck cards as shown.
      quiz: Array.isArray(quiz) ? quiz : null,
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
    const entries = lines.map((l) => JSON.parse(l));
    // List view: drop the heavy `quiz` payload and `results` to keep the
    // response small. Detail view re-fetches by index.
    const summary = entries.map((e, i) => ({
      index: i,
      finishedAt: e.finishedAt,
      deck: e.deck,
      mode: e.mode,
      sessionType: e.sessionType || 'daily',
      hasGoal: typeof e.goal === 'string' && e.goal.length > 0,
      hasNotes: typeof e.notes === 'string' && e.notes.length > 0,
      requested: e.requested,
      answered: e.answered,
      score: e.score,
      byRating: e.byRating,
      hasQuiz: !!e.quiz,
    }));
    res.json({ count: entries.length, history: summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/history/:index — full quiz payload for one past session, including
// the original questions, options, cluster background, and Tom's picks.
app.get('/api/history/:index', async (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    if (!Number.isFinite(idx) || idx < 0) {
      return res.status(400).json({ error: 'index must be a non-negative integer' });
    }
    const buf = await fsp.readFile(HISTORY, 'utf8').catch(() => '');
    const lines = buf.split('\n').filter(Boolean);
    if (idx >= lines.length) {
      return res.status(404).json({ error: `no history entry at index ${idx} (have ${lines.length})` });
    }
    const entry = JSON.parse(lines[idx]);
    res.json({ index: idx, ...entry });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || String(err) });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[anki-quizzer] listening on :${PORT}, ANKI_URL=${ANKI_URL}` +
    (process.env.LLM_API_KEY ? ' LLM=ON' : ' LLM=OFF'));
});
