// cluster-cache.js — on-disk cache for LLM-generated cluster quiz data.
//
// File: ${LLM_CACHE_DIR || './data/llm-cache'}/clusters.json
// Shape: { "<key>": { savedAt, deckName, cardIds, contentHash, background, intuition, cards } }
//
// Cache key: sha256(deckName + "|" + cardIds.sort().join(",") + "|" + contentHash)
// contentHash = sha256(concat of card.front + "||" + card.back for each card in the cluster)
//
// Lazy-creates the directory on first write. Reads return null on missing file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = process.env.LLM_CACHE_DIR || path.join(__dirname, '..', 'data', 'llm-cache');
const CACHE_FILE = path.join(CACHE_DIR, 'clusters.json');

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function clusterKey(deckName, cardIds, contentHash) {
  const sortedIds = cardIds.slice().map(String).sort();
  const raw = `${deckName}|${sortedIds.join(',')}|${contentHash}`;
  return sha256(raw);
}

function contentHashForCards(cards) {
  const parts = cards.map((c) => `${String(c.id)}::${c.front || ''}||${c.back || ''}`);
  return sha256(parts.join('\n'));
}

function readCache() {
  try {
    const buf = fs.readFileSync(CACHE_FILE, 'utf8');
    const obj = JSON.parse(buf);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (e) {
    if (e.code === 'ENOENT') return {};
    // Corrupt file — log and start fresh.
    console.warn(`[cluster-cache] failed to read cache (${e.code || e.message}), starting empty`);
    return {};
  }
}

function writeCache(obj) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2));
}

function get(key) {
  const cache = readCache();
  return cache[key] || null;
}

function set(key, entry) {
  const cache = readCache();
  cache[key] = { ...entry, savedAt: new Date().toISOString() };
  writeCache(cache);
}

function clear() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  writeCache({});
}

function path_() {
  return CACHE_FILE;
}

module.exports = {
  clusterKey,
  contentHashForCards,
  get,
  set,
  clear,
  path: path_,
};
