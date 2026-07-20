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
  cards: [],
  idx: 0,
  revealed: false,
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
    const h = await api('/api/health');
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

// --- Quiz flow ---------------------------------------------------------

function showScreen(name) {
  for (const k of Object.keys(screens)) {
    screens[k].classList.toggle('active', k === name);
  }
}

async function startQuiz() {
  state.deck = $('deck-select').value || 'All';
  state.count = parseInt(slider.value, 10);
  state.cards = [];
  state.idx = 0;
  state.results = [];
  state.revealed = false;

  $('start-btn').disabled = true;
  $('start-btn').textContent = 'Loading cards…';
  try {
    const data = await api('/api/quiz', {
      method: 'POST',
      body: JSON.stringify({ deck: state.deck, count: state.count }),
    });
    state.cards = data.cards || [];
    if (!state.cards.length) {
      alert(data.message || 'No cards found in this deck.');
      $('start-btn').disabled = false;
      $('start-btn').textContent = 'Start quiz';
      return;
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

  $('card-front').textContent = c.front || '(empty)';
  $('card-back').textContent = c.back || '(empty)';
  $('card-back').classList.add('hidden');

  $('show-answer').classList.remove('hidden');
  $('rate-actions').classList.add('hidden');
  state.revealed = false;
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
  // Send to backend to schedule.
  try {
    const r = await api('/api/finish', {
      method: 'POST',
      body: JSON.stringify({
        deck: state.deck,
        count: state.cards.length,
        results: state.results.map(({ id, rating }) => ({ id, rating })),
      }),
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
  const good = state.results.filter((r) => ['good', 'easy'].includes(r.rating)).length;
  const score = total ? Math.round((good / total) * 100) : 0;
  $('score-big').textContent = `${score}%`;

  const counts = { again: 0, hard: 0, good: 0, easy: 0 };
  for (const r of state.results) counts[r.rating] = (counts[r.rating] || 0) + 1;

  $('score-detail').innerHTML =
    `<strong>${good}</strong> of <strong>${total}</strong> cards passed<br>` +
    `Deck: <strong>${state.deck}</strong>`;

  const bd = $('breakdown');
  bd.innerHTML = '';
  for (const k of ['again', 'hard', 'good', 'easy']) {
    const p = document.createElement('div');
    p.className = `pill ${k}`;
    p.innerHTML = `<div class="n">${counts[k] || 0}</div><div class="l">${k}</div>`;
    bd.appendChild(p);
  }

  const list = $('card-list');
  list.innerHTML = '';
  for (let i = 0; i < state.results.length; i++) {
    const r = state.results[i];
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="rating-tag ${r.rating}">${r.rating}</div>
      <div>
        <div class="q">${escapeHtml(r.front)}</div>
        <div class="a">${escapeHtml(r.back)}</div>
        <div class="meta-line">card #${r.id} · ${r.deck} · interval ${r.interval}d · ease ${(r.ease/1000).toFixed(2)}</div>
      </div>`;
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
  showScreen('setup');
});

// --- Hotkeys -----------------------------------------------------------

document.addEventListener('keydown', (e) => {
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (!screens.quiz.classList.contains('active')) return;
  if (!state.revealed && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    $('show-answer').click();
    return;
  }
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