// Anki Quizzer frontend logic
// Pure vanilla JS, no build step.

const $ = (id) => document.getElementById(id);
const screens = {
  setup: $('setup'),
  quiz: $('quiz'),
  results: $('results'),
  history: $('history'),
};

const state = {
  health: null,
  decks: [],
  deck: null,
  count: 10,
  mode: 'recall', // 'recall' | 'mc'
  sessionType: 'daily', // 'daily' | 'cluster'
  cards: [],       // normal quiz: [{id, front, back, options, cluster}...]
  // cluster/session-quiz mode: flattened to [{id, front, back, options, cluster:{title}}...]
  idx: 0,
  revealed: false,
  mcAnswered: false, // MC mode: have we already picked an option for this card?
  mcPicked: null,    // MC mode: which option the user clicked
  results: [],
};

// --- API ---------------------------------------------------------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { error: text }; }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// --- Loading overlay -------------------------------------------------

function showLoading(message, sub) {
  $('loading-message').textContent = message || 'Loading…';
  const subEl = $('loading-sub');
  if (sub) {
    subEl.textContent = sub;
    subEl.classList.remove('hidden');
  } else {
    subEl.classList.add('hidden');
  }
  $('loading-overlay').classList.remove('hidden');
}
function hideLoading() {
  $('loading-overlay').classList.add('hidden');
}

// --- Status / health ---------------------------------------------------

async function refreshHealth() {
  const dot = $('status-dot');
  const text = $('status-text');
  try {
    const h = await api('/api/health/full');
    state.health = h;
    if (h.ok) {
      dot.className = 'dot ok';
      text.textContent = `Anki v${h.ankiVersion}`;
    } else {
      dot.className = 'dot bad';
      text.textContent = 'Anki unreachable';
    }
    $('health-pre').textContent = JSON.stringify(h, null, 2);
    return h.ok;
  } catch (e) {
    dot.className = 'dot bad';
    text.textContent = 'API error';
    $('health-pre').textContent = String(e);
    return false;
  }
}

async function loadDecks() {
  const sel = $('deck-select');
  sel.disabled = true;
  sel.innerHTML = '<option>Loading…</option>';
  try {
    const { decks } = await api('/api/decks');
    state.decks = decks || [];
    sel.innerHTML = '';
    const allOpt = document.createElement('option');
    allOpt.value = 'All';
    allOpt.textContent = `All decks (${state.decks.length})`;
    sel.appendChild(allOpt);
    for (const d of state.decks) {
      const o = document.createElement('option');
      o.value = d; o.textContent = d;
      sel.appendChild(o);
    }
    sel.disabled = false;
    $('start-btn').disabled = !state.decks.length;
  } catch (e) {
    sel.innerHTML = '<option>Failed to load decks</option>';
    $('start-btn').disabled = true;
  }
}

// --- Setup screen ------------------------------------------------------

$('refresh-decks').addEventListener('click', async () => {
  await refreshHealth();
  await loadDecks();
});

$('deck-select').addEventListener('change', (e) => {
  state.deck = e.target.value;
});

const slider = $('count-slider');
const out = $('count-value');
slider.addEventListener('input', () => {
  out.textContent = slider.value;
  state.count = parseInt(slider.value, 10);
});

$('start-btn').addEventListener('click', startQuiz);

for (const r of document.querySelectorAll('input[name="quiz-mode"]')) {
  r.addEventListener('change', (e) => {
    state.mode = e.target.value === 'mc' ? 'mc' : 'recall';
  });
}

// Session type (daily review vs cluster session)
for (const r of document.querySelectorAll('input[name="session-type"]')) {
  r.addEventListener('change', (e) => {
    state.sessionType = e.target.value;
    const isCluster = state.sessionType === 'cluster';
    $('daily-options').classList.toggle('hidden', isCluster);
    $('cluster-options').classList.toggle('hidden', !isCluster);
    // Cluster mode uses MC-style questions and doesn't need Anki decks
    if (isCluster) {
      const mcRadio = document.querySelector('input[name="quiz-mode"][value="mc"]');
      if (mcRadio) mcRadio.checked = true;
      state.mode = 'mc';
      $('start-btn').disabled = false;
    } else {
      // Daily mode: only enable if decks have loaded
      $('start-btn').disabled = !state.decks.length;
    }
  });
}

// --- Quiz flow ---------------------------------------------------------

function showScreen(name) {
  for (const k of Object.keys(screens)) {
    screens[k].classList.toggle('active', k === name);
  }
}

function setModeUI() {
  // Show/hide UI bits based on mode
  const isMC = state.mode === 'mc';
  $('show-answer').classList.toggle('hidden', isMC);
  $('mc-options').classList.toggle('hidden', !isMC);
  $('mc-feedback').classList.add('hidden'); // reset; shown after pick
  $('mc-explanations').classList.add('hidden'); // reset; shown after pick
  $('mc-next-actions').classList.add('hidden'); // reset; shown after MC pick
  // Rating buttons are ONLY for recall mode. MC mode uses correct/incorrect scoring.
  $('rate-actions').classList.toggle('hidden', isMC);
  $('hotkeys-recall').classList.toggle('hidden', isMC);
  $('hotkeys-mc').classList.toggle('hidden', !isMC);
}

async function startQuiz() {
  state.deck = state.sessionType === 'cluster' ? 'Notes' : ($('deck-select').value || 'All');
  state.count = parseInt(slider.value, 10);
  state.cards = [];
  state.idx = 0;
  state.results = [];
  state.revealed = false;
  state.mcAnswered = false;
  state.mcPicked = null;

  $('start-btn').disabled = true;
  if (state.sessionType === 'cluster') {
    showLoading('Generating questions from your notes…', 'Cluster mode calls the LLM — usually 30–60 seconds.');
  } else if (state.mode === 'mc') {
    showLoading('Generating multiple-choice questions…', 'Cold cache may take up to 90 seconds.');
  } else {
    showLoading('Loading cards…');
  }
  try {
    if (state.sessionType === 'cluster') {
      // Cluster session — call /api/session-quiz
      const goal = $('session-goal').value.trim();
      const notes = $('session-notes').value.trim();
      const data = await api('/api/session-quiz', {
        method: 'POST',
        body: JSON.stringify({ goal, notes }),
      });
      // Flatten concepts into a flat cards array for uniform rendering
      const cards = [];
      for (const concept of (data.concepts || [])) {
        for (const q of (concept.quiz || [])) {
          cards.push({
            id: `session-${cards.length}`,
            front: q.question || '(no question)',
            back: (q.options || []).find((o) => o.isCorrect)?.text || '',
            options: (q.options || []).map((o) => ({
              label: o.label,
              text: o.text,
              isCorrect: !!o.isCorrect,
              explanation: o.explanation || null,
            })),
            cluster: { title: concept.title },
          });
        }
      }
      if (!cards.length) {
        alert(data.error || 'No questions generated. Try different notes.');
        hideLoading();
        $('start-btn').disabled = false;
        $('start-btn').textContent = 'Start quiz';
        return;
      }
      state.cards = cards;
      state.mode = 'mc'; // session-quiz is always MC-style
    } else {
      // Daily review — call /api/quiz
      const data = await api('/api/quiz', {
        method: 'POST',
        body: JSON.stringify({ deck: state.deck, count: state.count, mode: state.mode }),
      });
      state.cards = data.cards || [];
      if (!state.cards.length) {
        alert(data.message || 'No cards found in this deck.');
        hideLoading();
        $('start-btn').disabled = false;
        $('start-btn').textContent = 'Start quiz';
        return;
      }
    }
    hideLoading();
    showScreen('quiz');
    renderCard();
  } catch (e) {
    alert(`Failed to load cards: ${e.message}`);
    hideLoading();
    $('start-btn').disabled = false;
    $('start-btn').textContent = 'Start quiz';
  }
}

function renderCard() {
  const c = state.cards[state.idx];
  if (!c) return finishQuiz();

  $('q-index').textContent = state.idx + 1;
  $('q-total').textContent = state.cards.length;
  $('deck-label').textContent = c.deckName || state.deck;

  // Concept label (cluster/session-quiz mode)
  const conceptLabel = $('concept-label');
  if (c.cluster && c.cluster.title) {
    conceptLabel.textContent = c.cluster.title;
    conceptLabel.classList.remove('hidden');
  } else {
    conceptLabel.classList.add('hidden');
  }

  $('card-front').textContent = c.front || '(empty)';
  $('card-back').textContent = c.back || '(empty)';
  $('card-back').classList.add('hidden');

  state.revealed = false;
  state.mcAnswered = false;
  state.mcPicked = null;

  setModeUI();

  if (state.mode === 'mc') {
    renderMCOptions(c);
  }
}

function renderMCOptions(card) {
  const container = $('mc-options');
  container.innerHTML = '';
  if (!Array.isArray(card.options) || card.options.length === 0) {
    container.textContent = '(no options for this card)';
    return;
  }
  for (const opt of card.options) {
    const btn = document.createElement('button');
    btn.className = 'mc-option';
    btn.dataset.label = opt.label;
    btn.dataset.correct = String(!!opt.isCorrect);
    btn.innerHTML = `<span class="mc-letter">${escapeHtml(opt.label)}</span><span class="mc-text">${escapeHtml(opt.text)}</span>`;
    btn.addEventListener('click', () => pickMCOption(btn, opt));
    container.appendChild(btn);
  }
}

function pickMCOption(btn, opt) {
  if (state.mcAnswered) return;
  state.mcAnswered = true;
  state.mcPicked = opt;

  const container = $('mc-options');
  const card = state.cards[state.idx];

  // Mark all options: correct one green, picked-wrong one red, others dim.
  for (const b of container.querySelectorAll('.mc-option')) {
    const isCorrect = b.dataset.correct === 'true';
    b.disabled = true;
    if (isCorrect) b.classList.add('correct');
    else if (b === btn) b.classList.add('incorrect');
    else b.classList.add('dim');
  }

  // Show feedback line.
  const fb = $('mc-feedback');
  if (opt.isCorrect) {
    fb.className = 'mc-feedback ok';
    fb.innerHTML = `✓ Correct!`;
  } else {
    const correctBtn = container.querySelector('.mc-option.correct');
    const correctLabel = correctBtn ? correctBtn.dataset.label : '?';
    const correctText = correctBtn ? correctBtn.querySelector('.mc-text').textContent : '';
    fb.className = 'mc-feedback bad';
    fb.innerHTML = `✗ Incorrect. The answer was <strong>${escapeHtml(correctLabel)}.</strong> ${escapeHtml(correctText)}`;
  }
  fb.classList.remove('hidden');

  // Reveal back side too so user can compare with full back content.
  $('card-back').classList.remove('hidden');

  // Show explanations for all options.
  renderMCExplanations(card.options, opt.label);

  // Record the result immediately (no rating step in MC mode).
  state.results.push({
    id: card.id,
    correct: !!opt.isCorrect,
    front: card.front,
    back: card.back,
    options: card.options,
    pickedLabel: opt.label,
    deck: card.deckName,
    interval: card.interval,
    ease: card.ease,
    mode: 'mc',
    sessionType: state.sessionType,
  });

  // Show the "Next" button — user advances manually instead of timer.
  $('mc-next-actions').classList.remove('hidden');
}

// Advance to the next card (or finish) when the user clicks "Next" or hits Enter/Space.
function mcNext() {
  $('mc-next-actions').classList.add('hidden');
  state.idx++;
  if (state.idx >= state.cards.length) {
    finishQuiz();
  } else {
    renderCard();
  }
}

const mcNextBtn = $('mc-next-btn');
if (mcNextBtn) {
  mcNextBtn.addEventListener('click', mcNext);
}

function renderMCExplanations(options, pickedLabel) {
  const container = $('mc-explanations');
  container.innerHTML = '';
  container.classList.remove('hidden');

  if (!Array.isArray(options)) return;

  for (const opt of options) {
    const item = document.createElement('div');
    const isCorrect = !!opt.isCorrect;
    const isPicked = opt.label === pickedLabel;
    item.className = `mc-explanation-item${isCorrect ? ' is-correct' : isPicked ? ' is-wrong' : ''}`;

    const label = document.createElement('span');
    label.className = 'mc-ex-label';
    label.textContent = opt.label;

    const text = document.createElement('span');
    text.className = 'mc-ex-text';
    if (opt.explanation) {
      text.textContent = opt.explanation;
    } else {
      text.textContent = '(No explanation available)';
      text.style.fontStyle = 'italic';
    }

    item.appendChild(label);
    item.appendChild(text);
    container.appendChild(item);
  }
}

$('show-answer').addEventListener('click', () => {
  $('card-back').classList.remove('hidden');
  $('show-answer').classList.add('hidden');
  $('rate-actions').classList.remove('hidden');
  state.revealed = true;
});

for (const btn of document.querySelectorAll('.rate')) {
  btn.addEventListener('click', () => rate(btn.dataset.rating));
}

function rate(rating) {
  const c = state.cards[state.idx];
  if (!c) return;
  // MC mode auto-advances from pickMCOption; rate() should never be called there.
  if (state.mode === 'mc') return;
  state.results.push({
    id: c.id,
    rating,
    front: c.front,
    back: c.back,
    deck: c.deckName,
    interval: c.interval,
    ease: c.ease,
  });
  state.idx++;
  if (state.idx >= state.cards.length) {
    finishQuiz();
  } else {
    renderCard();
  }
}

async function finishQuiz() {
  showScreen('results');
  renderResults();

  // Send to backend to schedule / persist history.
  try {
    // Capture the questions so the history view can replay the quiz without
    // re-fetching from Anki. Keep the front/back/options/cluster fields.
    const quizPayload = state.cards.map((c) => ({
      id: c.id,
      front: c.front,
      back: c.back,
      deckName: c.deckName || state.deck,
      options: c.options || null,
      cluster: c.cluster || null,
    }));
    const deckLabel = state.sessionType === 'cluster' ? 'Notes' : state.deck;
    const payload = state.mode === 'mc'
      ? {
          deck: deckLabel,
          count: state.cards.length,
          mode: 'mc',
          quiz: quizPayload,
          results: state.results.map(({ id, correct, pickedLabel, sessionType }) => ({ id, correct, pickedLabel, sessionType })),
        }
      : {
          deck: deckLabel,
          count: state.cards.length,
          quiz: quizPayload,
          results: state.results.map(({ id, rating }) => ({ id, rating })),
        };
    const r = await api('/api/finish', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    if (state.sessionType === 'cluster') {
      $('schedule-status').textContent = r.saved
        ? '✓ Saved to history. No Anki rescheduling — cluster sessions use AI-generated questions.'
        : '⚠ Failed to save to history.';
    } else {
      $('schedule-status').textContent =
        r.scheduled > 0
          ? `✓ Rescheduled ${r.scheduled} card(s) in Anki.`
          : '⚠ No cards were rescheduled.';
    }
    if (r.failures && r.failures.length) {
      console.warn('Schedule failures', r.failures);
      $('schedule-status').textContent += ` (${r.failures.length} failures — see console)`;
    }
  } catch (e) {
    $('schedule-status').textContent = `⚠ Schedule error: ${e.message}`;
  }
}

function renderResults() {
  const total = state.results.length;

  // Score: for MC, % answered correctly. For recall, % good/easy.
  let score = 0;
  if (state.mode === 'mc') {
    const correct = state.results.filter((r) => r.correct === true).length;
    score = total ? Math.round((correct / total) * 100) : 0;
  } else {
    const good = state.results.filter((r) => ['good', 'easy'].includes(r.rating)).length;
    score = total ? Math.round((good / total) * 100) : 0;
  }
  $('score-big').textContent = `${score}%`;

  // Breakdown counts
  const counts = { again: 0, hard: 0, good: 0, easy: 0, correct: 0, incorrect: 0 };
  for (const r of state.results) {
    if (state.mode === 'mc') {
      counts[r.correct ? 'correct' : 'incorrect']++;
      counts[r.rating] = (counts[r.rating] || 0) + 1;
    } else {
      counts[r.rating] = (counts[r.rating] || 0) + 1;
    }
  }

  if (state.sessionType === 'cluster') {
    const correct = counts.correct;
    $('score-detail').innerHTML =
      `<strong>${correct}</strong> of <strong>${total}</strong> answered correctly<br>` +
      `<strong>Cluster session</strong>`;
  } else if (state.mode === 'mc') {
    const correct = counts.correct;
    $('score-detail').innerHTML =
      `<strong>${correct}</strong> of <strong>${total}</strong> answered correctly<br>` +
      `Mode: <strong>Multiple choice</strong> · Deck: <strong>${state.deck}</strong>`;
  } else {
    const good = counts.good + counts.easy;
    $('score-detail').innerHTML =
      `<strong>${good}</strong> of <strong>${total}</strong> cards passed<br>` +
      `Mode: <strong>Recall</strong> · Deck: <strong>${state.deck}</strong>`;
  }

  const bd = $('breakdown');
  bd.innerHTML = '';
  if (state.mode === 'mc') {
    // MC mode: just correct/incorrect scoring (no rating breakdown).
    for (const k of ['correct', 'incorrect']) {
      const p = document.createElement('div');
      p.className = `pill ${k}`;
      p.innerHTML = `<div class="n">${counts[k] || 0}</div><div class="l">${k}</div>`;
      bd.appendChild(p);
    }
  } else {
    for (const k of ['again', 'hard', 'good', 'easy']) {
      const p = document.createElement('div');
      p.className = `pill ${k}`;
      p.innerHTML = `<div class="n">${counts[k] || 0}</div><div class="l">${k}</div>`;
      bd.appendChild(p);
    }
  }

  const list = $('card-list');
  list.innerHTML = '';
  for (let i = 0; i < state.results.length; i++) {
    const r = state.results[i];
    const li = document.createElement('li');

    if (state.mode === 'mc') {
      const tagClass = r.correct ? 'good' : 'again';
      const tagLabel = r.correct ? '✓' : '✗';
      const isSession = r.sessionType === 'cluster';
      let metaHtml;
      if (isSession) {
        metaHtml = r.pickedLabel ? `<div class="meta-line">You picked <strong>${escapeHtml(r.pickedLabel)}</strong></div>` : '';
      } else {
        metaHtml = r.pickedLabel
          ? `<div class="meta-line">You picked <strong>${escapeHtml(r.pickedLabel)}</strong> · card #${r.id} · ${escapeHtml(r.deck)} · interval ${r.interval}d · ease ${(r.ease/1000).toFixed(2)}</div>`
          : `<div class="meta-line">card #${r.id} · ${escapeHtml(r.deck)} · interval ${r.interval}d · ease ${(r.ease/1000).toFixed(2)}</div>`;
      }
      li.innerHTML = `
        <div class="rating-tag ${tagClass}">${tagLabel}</div>
        <div>
          <div class="q">${escapeHtml(r.front)}</div>
          <div class="a">${escapeHtml(r.back)}</div>
          ${metaHtml}
        </div>`;
    } else {
      li.innerHTML = `
        <div class="rating-tag ${r.rating}">${r.rating}</div>
        <div>
          <div class="q">${escapeHtml(r.front)}</div>
          <div class="a">${escapeHtml(r.back)}</div>
          <div class="meta-line">card #${r.id} · ${escapeHtml(r.deck)} · interval ${r.interval}d · ease ${(r.ease/1000).toFixed(2)}</div>
        </div>`;
    }
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

$('restart-btn').addEventListener('click', () => {
  hideLoading();
  $('start-btn').disabled = false;
  $('start-btn').textContent = 'Start quiz';
  // Reset session type to daily for next run
  state.sessionType = 'daily';
  const dailyRadio = document.querySelector('input[name="session-type"][value="daily"]');
  if (dailyRadio) dailyRadio.checked = true;
  $('daily-options').classList.remove('hidden');
  $('cluster-options').classList.add('hidden');
  showScreen('setup');
});

// End the current quiz early and bail out to setup without scheduling.
function endQuiz() {
  // Cancel any pending MC auto-advance so the timer can't fire after we've left the screen.
  state.cards = [];
  state.idx = 0;
  state.results = [];
  state.revealed = false;
  state.mcAnswered = false;
  state.mcPicked = null;
  // Hide transient quiz UI.
  $('card-back').classList.add('hidden');
  $('show-answer').classList.remove('hidden');
  $('rate-actions').classList.add('hidden');
  $('mc-feedback').classList.add('hidden');
  $('mc-feedback').textContent = '';
  $('mc-explanations').classList.add('hidden');
  $('mc-explanations').innerHTML = '';
  $('mc-next-actions').classList.add('hidden');
  const mcOpts = $('mc-options');
  mcOpts.innerHTML = '';
  mcOpts.classList.add('hidden');
  // Hide loading overlay too in case it's still up.
  hideLoading();
  // Restore start button so the user can launch a new quiz from setup.
  $('start-btn').disabled = !state.decks.length;
  $('start-btn').textContent = 'Start quiz';
  showScreen('setup');
}
document.addEventListener('DOMContentLoaded', () => {
  const btn = $('end-quiz');
  if (btn) {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      console.log('[anki-quizzer] end-quiz clicked');
      try {
        endQuiz();
      } catch (err) {
        console.error('[anki-quizzer] endQuiz error:', err);
      }
    });
  } else {
    console.warn('[anki-quizzer] end-quiz button not found');
  }
});

// --- Hotkeys -----------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (!screens.quiz.classList.contains('active')) return;

  // MC mode: A/B/C/D pick an option (only before pick)
  if (state.mode === 'mc' && !state.mcAnswered) {
    const k = e.key.toUpperCase();
    if (['A', 'B', 'C', 'D'].includes(k)) {
      const btn = $('mc-options').querySelector(`.mc-option[data-label="${k}"]`);
      if (btn && !btn.disabled) {
        e.preventDefault();
        btn.click();
        return;
      }
    }
  }

  // MC mode: Space/Enter advances after a pick (mirrors the Next button).
  if (state.mode === 'mc' && state.mcAnswered && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    mcNext();
    return;
  }

  // Recall mode: space/enter to reveal
  if (state.mode === 'recall' && !state.revealed && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    $('show-answer').click();
    return;
  }

  // After reveal/pick: 1-4 rate
  if (state.revealed && ['1', '2', '3', '4'].includes(e.key)) {
    e.preventDefault();
    const map = { '1': 'again', '2': 'hard', '3': 'good', '4': 'easy' };
    const btn = document.querySelector(`.rate[data-rating="${map[e.key]}"]`);
    if (btn) btn.click();
  }
});

// --- Boot --------------------------------------------------------------
// --- History ----------------------------------------------------------

// State for the history detail view (separate from the live quiz state).
const historyState = {
  entries: [],   // list-view entries from /api/history
  detail: null,  // full entry from /api/history/:index
  index: null,   // index of the entry being viewed
};

// Header nav buttons: "New quiz" + "History"
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-nav');
    if (target === 'history') openHistoryList();
    else showScreen('setup');
  });
});

// "View history" button on the results screen.
const viewHistoryBtn = $('view-history-btn');
if (viewHistoryBtn) {
  viewHistoryBtn.addEventListener('click', () => openHistoryList());
}

const historyBackBtn = $('history-back-btn');
if (historyBackBtn) {
  historyBackBtn.addEventListener('click', () => openHistoryList());
}

const historyRetakeBtn = $('history-retake-btn');
if (historyRetakeBtn) {
  historyRetakeBtn.addEventListener('click', () => retakeFromHistory());
}

async function openHistoryList() {
  showScreen('history');
  $('history-list-wrap').classList.remove('hidden');
  $('history-detail-wrap').classList.add('hidden');
  $('history-loading').classList.remove('hidden');
  $('history-list').innerHTML = '';
  $('history-empty').classList.add('hidden');

  try {
    const { count, history } = await api('/api/history');
    historyState.entries = history || [];
    $('history-loading').classList.add('hidden');
    if (!historyState.entries.length) {
      $('history-empty').classList.remove('hidden');
      return;
    }
    renderHistoryList();
  } catch (e) {
    $('history-loading').textContent = `⚠ Failed to load history: ${e.message}`;
  }
}

function renderHistoryList() {
  const list = $('history-list');
  list.innerHTML = '';
  // Newest first.
  const entries = historyState.entries.slice().reverse();
  for (const e of entries) {
    const li = document.createElement('li');
    li.className = 'history-row';
    li.tabIndex = 0;
    const date = new Date(e.finishedAt);
    const dateLabel = date.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const counts = e.byRating || {};
    let countsHtml = '';
    if (e.mode === 'mc') {
      countsHtml = `<span class="pill-mini good">✓ ${counts.correct || 0}</span> ` +
                   `<span class="pill-mini again">✗ ${counts.incorrect || 0}</span>`;
    } else {
      const order = ['again', 'hard', 'good', 'easy'];
      countsHtml = order
        .filter((k) => counts[k])
        .map((k) => `<span class="pill-mini ${k}">${counts[k]} ${k}</span>`)
        .join(' ');
    }
    li.innerHTML = `
      <div class="history-row-main">
        <div class="history-row-score">${e.score ?? 0}%</div>
        <div>
          <div class="history-row-title">
            <strong>${escapeHtml(e.deck)}</strong>
            <span class="muted small">${e.mode === 'mc' ? 'Multiple choice' : 'Recall'}</span>
            ${e.hasQuiz ? '' : '<span class="muted small" title="No quiz payload saved for this older entry">(no questions)</span>'}
          </div>
          <div class="history-row-meta muted small">${dateLabel} · ${e.answered}/${e.requested} answered</div>
        </div>
        <div class="history-row-counts">${countsHtml}</div>
      </div>`;
    li.addEventListener('click', () => openHistoryDetail(e.index));
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        openHistoryDetail(e.index);
      }
    });
    list.appendChild(li);
  }
}

async function openHistoryDetail(index) {
  showScreen('history');
  $('history-list-wrap').classList.add('hidden');
  $('history-detail-wrap').classList.remove('hidden');
  $('history-retake-btn').disabled = true;
  $('history-score-big').textContent = '…';
  $('history-score-detail').textContent = 'Loading…';
  $('history-card-list').innerHTML = '';
  $('history-cluster-bg').classList.add('hidden');
  $('history-no-quiz-payload').classList.add('hidden');

  try {
    const entry = await api(`/api/history/${index}`);
    historyState.detail = entry;
    historyState.index = index;
    renderHistoryDetail(entry);
    $('history-retake-btn').disabled = false;
  } catch (e) {
    $('history-score-detail').textContent = `⚠ Failed to load: ${e.message}`;
  }
}

function renderHistoryDetail(entry) {
  $('history-score-big').textContent = `${entry.score ?? 0}%`;
  const when = new Date(entry.finishedAt).toLocaleString();
  $('history-score-detail').innerHTML =
    `<strong>${escapeHtml(entry.deck)}</strong> · ${entry.mode === 'mc' ? 'MC' : 'Recall'} · ${escapeHtml(when)}<br>` +
    `${entry.answered}/${entry.requested} answered`;

  const list = $('history-card-list');
  list.innerHTML = '';
  const quiz = entry.quiz || [];
  const results = entry.results || [];
  const resultById = new Map();
  for (const r of results) resultById.set(String(r.id), r);

  if (!quiz.length) {
    $('history-no-quiz-payload').classList.remove('hidden');
    return;
  }

  // Pick the cluster background from the first quiz entry (cluster is shared).
  const firstCluster = quiz.find((q) => q.cluster && (q.cluster.background || q.cluster.intuition))?.cluster;
  if (firstCluster) {
    $('history-cluster-bg').classList.remove('hidden');
    $('history-cluster-bg-text').textContent = firstCluster.background || '(no background saved)';
    $('history-cluster-intuition-text').textContent = firstCluster.intuition || '(no intuition saved)';
  }

  quiz.forEach((q, i) => {
    const r = resultById.get(String(q.id)) || {};
    const li = document.createElement('li');

    if (entry.mode === 'mc') {
      const tagClass = r.correct ? 'good' : 'again';
      const tagLabel = r.correct ? '✓' : '✗';
      const optionsHtml = (q.options || []).map((o) => {
        const isPick = o.label === r.pickedLabel;
        const isCorrect = o.isCorrect;
        const cls = ['mc-option-static'];
        if (isCorrect) cls.push('correct');
        if (isPick && !isCorrect) cls.push('wrong-pick');
        const mark = isCorrect ? ' ✓' : (isPick ? ' ✗ (your pick)' : '');
        return `<div class="${cls.join(' ')}"><strong>${escapeHtml(o.label)}.</strong> ${escapeHtml(o.text)}${escapeHtml(mark)}</div>`;
      }).join('');
      li.innerHTML = `
        <div class="rating-tag ${tagClass}">${tagLabel}</div>
        <div>
          <div class="q">${i + 1}. ${escapeHtml(q.front)}</div>
          <div class="mc-options-static">${optionsHtml}</div>
          ${r.pickedLabel ? `<div class="meta-line">You picked <strong>${escapeHtml(r.pickedLabel)}</strong></div>` : '<div class="meta-line muted">(no answer recorded)</div>'}
          <div class="meta-line muted small">card #${escapeHtml(String(q.id))} · ${escapeHtml(q.deckName || entry.deck)}</div>
        </div>`;
    } else {
      const rating = r.rating || 'again';
      li.innerHTML = `
        <div class="rating-tag ${rating}">${escapeHtml(rating)}</div>
        <div>
          <div class="q">${i + 1}. ${escapeHtml(q.front)}</div>
          <div class="a">${escapeHtml(q.back)}</div>
          <div class="meta-line muted small">card #${escapeHtml(String(q.id))} · ${escapeHtml(q.deckName || entry.deck)}</div>
        </div>`;
    }
    list.appendChild(li);
  });
}

// Retake: rebuild the same setup (deck, mode, count) and start a fresh quiz.
// New cluster session is generated; questions will differ if the cluster LLM
// changes. For deterministic re-runs we'd need to persist the original
// cardIds; for now this is a "same shape, fresh questions" retake.
async function retakeFromHistory() {
  const entry = historyState.detail;
  if (!entry) return;

  // Make sure decks are loaded so the deck-select dropdown is populated.
  if (!state.decks.length) await loadDecks();

  // Switch to setup screen and pre-fill the form.
  state.sessionType = 'daily';
  const dailyRadio = document.querySelector('input[name="session-type"][value="daily"]');
  if (dailyRadio) dailyRadio.checked = true;
  $('daily-options').classList.remove('hidden');
  $('cluster-options').classList.add('hidden');

  state.mode = entry.mode === 'mc' ? 'mc' : 'recall';
  const modeRadio = document.querySelector(`input[name="quiz-mode"][value="${state.mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  setModeUI();

  // Set deck + count
  if (entry.deck && entry.deck !== 'All') {
    const sel = $('deck-select');
    if (state.decks.includes(entry.deck)) {
      sel.value = entry.deck;
      state.deck = entry.deck;
    }
  }
  const targetCount = entry.requested || entry.answered || 10;
  const slider = $('count-slider');
  slider.value = String(Math.max(1, Math.min(20, targetCount)));
  $('count-value').textContent = slider.value;
  state.count = parseInt(slider.value, 10);

  showScreen('setup');
  // Kick off the quiz automatically.
  await startQuiz();
}

// --- Boot --------------------------------------------------------------

(async function init() {
  const ok = await refreshHealth();
  if (ok) await loadDecks();
  else {
    $('deck-select').innerHTML = '<option>Anki unreachable</option>';
    $('start-btn').disabled = true;
  }
})();
