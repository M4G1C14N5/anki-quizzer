// Anki Quizzer frontend logic
// Pure vanilla JS, no build step.

const $ = (id) => document.getElementById(id);
const screens = {
  setup: $('setup'),
  quiz: $('quiz'),
  results: $('results'),
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
  // Rating buttons are ONLY for recall mode. MC mode uses correct/incorrect scoring.
  $('rate-actions').classList.toggle('hidden', isMC);
  $('hotkeys-recall').classList.toggle('hidden', isMC);
  $('hotkeys-mc').classList.toggle('hidden', !isMC);
}

async function startQuiz() {
  state.deck = $('deck-select').value || 'All';
  state.count = parseInt(slider.value, 10);
  state.cards = [];
  state.idx = 0;
  state.results = [];
  state.revealed = false;
  state.mcAnswered = false;
  state.mcPicked = null;

  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Loading cards…';
  try {
    if (state.sessionType === 'cluster') {
      // Cluster session — call /api/session-quiz
      const summary = $('session-summary').value.trim();
      const memory = $('session-memory').value.trim();
      const data = await api('/api/session-quiz', {
        method: 'POST',
        body: JSON.stringify({ summary, memory }),
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
        alert(data.error || 'No questions generated. Try different summary text.');
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
        $('start-btn').disabled = false;
        $('start-btn').textContent = 'Start quiz';
        return;
      }
    }
    showScreen('quiz');
    renderCard();
  } catch (e) {
    alert(`Failed to load cards: ${e.message}`);
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

  // Auto-advance after 2s (slightly longer to let user read explanations).
  setTimeout(() => {
    state.idx++;
    if (state.idx >= state.cards.length) {
      finishQuiz();
    } else {
      renderCard();
    }
  }, 2000);
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

  // Session-quiz mode has no Anki cards to schedule — skip /api/finish.
  if (state.sessionType === 'cluster') {
    $('schedule-status').textContent = 'ℹ Cluster sessions generate AI questions — no Anki scheduling needed.';
    return;
  }

  // Send to backend to schedule.
  try {
    const payload = state.mode === 'mc'
      ? {
          deck: state.deck,
          count: state.cards.length,
          mode: 'mc',
          results: state.results.map(({ id, correct }) => ({ id, correct })),
        }
      : {
          deck: state.deck,
          count: state.cards.length,
          results: state.results.map(({ id, rating }) => ({ id, rating })),
        };
    const r = await api('/api/finish', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    $('schedule-status').textContent =
      r.scheduled > 0
        ? `✓ Rescheduled ${r.scheduled} card(s) in Anki.`
        : '⚠ No cards were rescheduled.';
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

(async function init() {
  const ok = await refreshHealth();
  if (ok) await loadDecks();
  else {
    $('deck-select').innerHTML = '<option>Anki unreachable</option>';
    $('start-btn').disabled = true;
  }
})();