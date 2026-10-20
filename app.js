'use strict';

// Data sources (both CORS-enabled, no backend needed)
const ALGOLIA = 'https://hn.algolia.com/api/v1';
const FIREBASE = 'https://hacker-news.firebaseio.com/v0';
const DEFAULTS = { topN: 30, commentsN: 20, daysBack: 2 };
const LIST_TTL_MS = 20 * 60 * 1000;
const READ_KEEP_MS = 14 * 24 * 3600 * 1000;

const $ = (sel) => document.querySelector(sel);
const els = {
  back: $('#back'), heading: $('#heading'), refresh: $('#refresh'), toggleRead: $('#toggleRead'),
  listView: $('#listView'), list: $('#list'), subtitle: $('#subtitle'), listStatus: $('#listStatus'),
  readView: $('#readView'), story: $('#story'), comments: $('#comments'), commentStatus: $('#commentStatus'),
  commentsHeading: $('#commentsHeading'), ptr: $('#ptr'),
  toast: $('#toast'), toastMsg: $('#toastMsg'), toastAction: $('#toastAction'),
  settingsBtn: $('#settingsBtn'), settings: $('#settings'),
  setTopN: $('#setTopN'), setComments: $('#setComments'), setDaysBack: $('#setDaysBack'),
};

// ---------- storage ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* quota or private mode */ }
  },
};

let readMap = store.get('yday.read', {});
let hideRead = store.get('yday.hideRead', false);
let settings = { ...DEFAULTS, ...store.get('yday.settings', {}) };
let stories = [];
let listScrollY = 0;
let readerId = null; // story currently open in the reader

function pruneRead() {
  const cutoff = Date.now() - READ_KEEP_MS;
  for (const id in readMap) if (readMap[id] < cutoff) delete readMap[id];
  store.set('yday.read', readMap);
}
const isRead = (id) => Boolean(readMap[id]);
function setRead(id, value) {
  if (value) readMap[id] = Date.now(); else delete readMap[id];
  store.set('yday.read', readMap);
}

// ---------- time ----------
// A calendar day in the device's timezone, settings.daysBack days ago. The default
// of 2 (the day before yesterday) gives every story at least 24h of voting, so
// evening posts aren't disfavored.
function storyWindow(now = Date.now()) {
  const d = new Date(now);
  const back = settings.daysBack;
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back + 1);
  const key = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  return { start: Math.floor(start / 1000), end: Math.floor(end / 1000), key, startDate: start };
}

function ago(ts) {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

const weekday = (date) => date.toLocaleDateString(undefined, { weekday: 'long' });
const postedAt = (ts) => new Date(ts * 1000).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- fetching ----------
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchWindowStories(range, topN) {
  // search_by_date returns newest first and caps at 1000 hits, so filter by a
  // points floor that keeps the candidate set small, then rank client-side.
  for (const floor of [20, 5, 0]) {
    const filters = `created_at_i>=${range.start},created_at_i<${range.end},points>=${floor}`;
    const url = `${ALGOLIA}/search_by_date?tags=story&hitsPerPage=1000&numericFilters=${encodeURIComponent(filters)}`;
    const data = await getJSON(url);
    if (data.hits.length >= topN || floor === 0) {
      return data.hits
        .map((h) => ({
          id: Number(h.objectID), title: h.title, url: h.url || '', points: h.points || 0,
          comments: h.num_comments || 0, author: h.author, time: h.created_at_i,
        }))
        .sort((a, b) => b.points - a.points)
        .slice(0, topN);
    }
  }
  return [];
}

async function loadList(force = false) {
  const range = storyWindow();
  const cached = store.get('yday.list', null);
  const same = cached && cached.day === range.key && cached.topN === settings.topN;
  const fresh = same && Date.now() - cached.fetchedAt < LIST_TTL_MS;
  if (same) { stories = cached.stories; renderList(cached); }
  if (fresh && !force) return;

  els.listStatus.textContent = stories.length ? '' : 'Loading…';
  els.refresh.disabled = true;
  try {
    const fetched = await fetchWindowStories(range, settings.topN);
    const entry = { day: range.key, topN: settings.topN, fetchedAt: Date.now(), stories: fetched };
    store.set('yday.list', entry);
    stories = fetched;
    renderList(entry);
    if (force) toast('Updated');
  } catch (err) {
    if (!stories.length) els.listStatus.textContent = `Could not load stories (${err.message}). Tap ↻ to retry.`;
    else toast('Offline: showing cached list');
  } finally {
    els.refresh.disabled = false;
  }
}

// ---------- list view ----------
function renderList(entry) {
  const range = storyWindow();
  const day = range.startDate.toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
  els.subtitle.textContent = `${day} · updated ${ago(entry.fetchedAt / 1000)}`;
  els.list.replaceChildren(...stories.map((s, i) => storyRow(s, i + 1)));
  els.listStatus.textContent = stories.length ? '' : 'No stories found for that day.';
  applyReadFilter();
}

function storyRow(s, rank) {
  const li = document.createElement('li');
  li.dataset.id = s.id;
  if (isRead(s.id)) li.classList.add('read');
  li.innerHTML = `
    <div class="swipe-bg"><span class="open">Read &rarr;</span><span class="read">&larr; Mark read</span></div>
    <div class="row"><span class="rank">${rank}</span><span class="title"></span></div>`;
  li.querySelector('.title').textContent = s.title;
  attachSwipe(li);
  return li;
}

function applyReadFilter() {
  els.toggleRead.setAttribute('aria-pressed', String(hideRead));
  els.toggleRead.textContent = hideRead ? 'Show read' : 'Hide read';
  for (const li of els.list.children) {
    li.classList.toggle('hidden', hideRead && isRead(Number(li.dataset.id)));
  }
}

function toggleReadItem(li) {
  const id = Number(li.dataset.id);
  const now = !isRead(id);
  setRead(id, now);
  li.classList.toggle('read', now);
  applyReadFilter();
  toast(now ? 'Marked read' : 'Marked unread', 'Undo', () => {
    setRead(id, !now);
    li.classList.toggle('read', !now);
    applyReadFilter();
  });
}

// Reflect a read-state change made outside the list (e.g. from the reader).
function syncRow(id) {
  const li = els.list.querySelector(`li[data-id="${id}"]`);
  if (li) li.classList.toggle('read', isRead(id));
  applyReadFilter();
}

// Leaving the reader marks that story read, with an Undo in the toast.
function markLeftStoryRead(id) {
  if (isRead(id)) return;
  setRead(id, true);
  syncRow(id);
  toast('Marked read', 'Undo', () => { setRead(id, false); syncRow(id); });
}

function attachSwipe(li) {
  const row = li.querySelector('.row');
  let startX = 0, startY = 0, dx = 0, tracking = false, horizontal = null;

  const reset = () => {
    row.classList.add('animate');
    row.style.transform = '';
    li.classList.remove('dir-left', 'dir-right');
    setTimeout(() => row.classList.remove('animate'), 200);
  };

  row.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    tracking = true; horizontal = null; dx = 0;
    startX = e.clientX; startY = e.clientY;
    row.classList.remove('animate');
  });

  row.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const mx = e.clientX - startX, my = e.clientY - startY;
    if (horizontal === null && (Math.abs(mx) > 8 || Math.abs(my) > 8)) {
      horizontal = Math.abs(mx) > Math.abs(my);
      if (horizontal) row.setPointerCapture(e.pointerId);
      else { tracking = false; return; }
    }
    if (!horizontal) return;
    dx = mx;
    row.style.transform = `translateX(${dx}px)`;
    li.classList.toggle('dir-right', dx > 0);
    li.classList.toggle('dir-left', dx < 0);
  });

  const end = () => {
    if (!tracking) return;
    tracking = false;
    const threshold = Math.min(110, row.offsetWidth * 0.28);
    if (horizontal && dx > threshold) { reset(); openStory(Number(li.dataset.id)); }
    else if (horizontal && dx < -threshold) { reset(); toggleReadItem(li); }
    else if (horizontal) reset();
  };
  row.addEventListener('pointerup', end);
  row.addEventListener('pointercancel', () => { tracking = false; reset(); });

  // A plain tap also opens the story (handy on desktop).
  row.addEventListener('click', () => { if (!horizontal) openStory(Number(li.dataset.id)); });
}

// ---------- routing ----------
function openStory(id) {
  listScrollY = window.scrollY;
  location.hash = `#/item/${id}`;
}

function route() {
  const m = location.hash.match(/^#\/item\/(\d+)/);
  const id = m ? Number(m[1]) : null;
  if (readerId && readerId !== id) markLeftStoryRead(readerId);
  readerId = id;
  if (id) showReader(id);
  else showList();
}

function listHeading() {
  return weekday(storyWindow().startDate);
}

function showList() {
  els.readView.hidden = true;
  els.listView.hidden = false;
  els.back.hidden = true;
  els.toggleRead.hidden = false;
  els.heading.textContent = listHeading();
  document.title = `${listHeading()} on HN`;
  requestAnimationFrame(() => window.scrollTo(0, listScrollY));
}

function goToList() {
  if (history.length > 1 && location.hash) history.back();
  else location.hash = '';
}

// The next unread story after `id` in list order, wrapping around.
function nextUnread(id) {
  const i = stories.findIndex((s) => s.id === id);
  for (let k = 1; k < stories.length; k++) {
    const s = stories[(i + k) % stories.length];
    if (s.id !== id && !isRead(s.id)) return s;
  }
  return null;
}

function openNextUnread() {
  const next = nextUnread(readerId);
  if (!next) { goToList(); return; }
  // Replace, so Back still returns to the list rather than the previous story.
  location.replace(`#/item/${next.id}`);
}

// ---------- reader ----------
let readerToken = 0;

async function showReader(id) {
  const token = ++readerToken;
  els.listView.hidden = true;
  els.readView.hidden = false;
  els.back.hidden = false;
  els.toggleRead.hidden = true;
  els.heading.textContent = 'Story';
  window.scrollTo(0, 0);

  els.commentsHeading.textContent = `${settings.commentsN} most insightful comments`;
  const known = stories.find((s) => s.id === id);
  renderStoryHeader(known || { id, title: 'Loading…' });
  els.comments.replaceChildren();
  els.commentStatus.textContent = 'Loading comments…';

  try {
    const [item, order] = await Promise.all([
      getJSON(`${ALGOLIA}/items/${id}`),
      getJSON(`${FIREBASE}/item/${id}.json`).then((d) => (d && d.kids) || []).catch(() => []),
    ]);
    if (token !== readerToken) return;
    renderStoryHeader({
      id, title: item.title, url: item.url || '', points: item.points, author: item.author,
      time: item.created_at_i, comments: known ? known.comments : undefined, text: item.text,
    });
    const picked = pickInsightful(item, order, settings.commentsN);
    els.comments.replaceChildren(...picked.map(commentEl));
    collapseLong();
    els.commentStatus.textContent = picked.length ? '' : 'No comments yet.';
  } catch (err) {
    if (token !== readerToken) return;
    els.commentStatus.textContent = `Could not load comments (${err.message}).`;
  }
}

function renderStoryHeader(s) {
  document.title = s.title || 'Story';
  const hnUrl = `https://news.ycombinator.com/item?id=${s.id}`;
  let host = '';
  try { host = s.url ? new URL(s.url).hostname.replace(/^www\./, '') : ''; } catch { /* bad url */ }
  const meta = [
    s.points != null ? `${s.points} points` : '',
    s.author ? `by ${s.author}` : '',
    s.time ? postedAt(s.time) : '',
    host,
  ].filter(Boolean).join(' · ');
  els.story.innerHTML = `<h2><a></a></h2><div class="meta"></div><div class="text"></div>
    <a class="open-link" target="_blank" rel="noopener noreferrer"></a><a class="open-link" target="_blank" rel="noopener noreferrer">On HN</a>`;
  const [titleLink, openLink, hnLink] = els.story.querySelectorAll('a');
  titleLink.textContent = s.title;
  titleLink.href = s.url || hnUrl;
  titleLink.target = '_blank'; titleLink.rel = 'noopener noreferrer';
  els.story.querySelector('.meta').textContent = meta;
  openLink.textContent = s.url ? 'Open source article' : 'Open discussion';
  openLink.href = s.url || hnUrl;
  hnLink.href = hnUrl;
  if (!s.url) hnLink.remove();
  const text = els.story.querySelector('.text');
  if (s.text) text.append(sanitize(s.text)); else text.remove();
}

/*
 * "Most insightful" heuristic. HN has no public comment score, so we combine:
 *  - HN's own ranking of top-level comments (order of `kids` from the official API,
 *    which reflects votes and moderation),
 *  - how much discussion a comment sparked (number of descendant replies),
 *  - substance (text length, capped so walls of text don't win by default),
 *  - a small penalty for depth so the list is mostly self-contained top-level takes.
 */
function pickInsightful(root, order, n) {
  const rankOf = new Map(order.map((id, i) => [id, i]));
  const all = [];

  const walk = (node, depth, parent) => {
    let descendants = 0;
    for (const child of node.children || []) descendants += 1 + walk(child, depth + 1, node);
    if (depth > 0 && node.text && node.author) {
      all.push({ node, depth, parent, descendants });
    }
    return descendants;
  };
  walk(root, 0, null);

  for (const c of all) {
    const len = plainLength(c.node.text);
    let score = 2 * Math.log1p(c.descendants) + 1.5 * Math.min(len, 1200) / 1200 - 0.6 * (c.depth - 1);
    if (c.depth === 1 && rankOf.size) {
      const r = rankOf.has(c.node.id) ? rankOf.get(c.node.id) : rankOf.size;
      score += 3 * (1 - r / rankOf.size);
    }
    if (len < 80) score -= 2;
    c.score = score;
  }
  return all.sort((a, b) => b.score - a.score).slice(0, n);
}

function plainLength(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').length;
}

function commentEl(c) {
  const li = document.createElement('li');
  li.className = 'comment';
  const body = document.createElement('div');
  body.className = 'body';
  body.append(sanitize(c.node.text));
  li.append(body);
  return li;
}

// Clamp comments taller than ~10 lines, with a "More" button to expand.
function collapseLong() {
  for (const li of els.comments.children) {
    const body = li.querySelector('.body');
    const max = 10 * parseFloat(getComputedStyle(body).lineHeight);
    if (body.scrollHeight <= max * 1.3) continue; // not worth hiding a couple of lines
    li.classList.add('clamped');
    body.style.maxHeight = `${max}px`;
    const more = document.createElement('button');
    more.className = 'more';
    more.textContent = 'More';
    li.append(more);
  }
}

// Keep only the small set of tags HN emits; links open in a new tab.
const ALLOWED = new Set(['P', 'A', 'I', 'EM', 'B', 'STRONG', 'PRE', 'CODE', 'BR']);
function sanitize(html) {
  // HN starts with a bare text run and only opens <p> for later paragraphs, so
  // give the first paragraph its own <p> to get the same spacing as the rest.
  if (!/^\s*<(p|pre)\b/i.test(html)) html = `<p>${html}`;
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const frag = document.createDocumentFragment();
  const clean = (src, dest) => {
    for (const node of src.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) { dest.append(node.textContent); continue; }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (!ALLOWED.has(node.tagName)) { clean(node, dest); continue; }
      const el = document.createElement(node.tagName);
      if (node.tagName === 'A') {
        const href = node.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href)) {
          el.href = href; el.target = '_blank'; el.rel = 'noopener noreferrer nofollow';
        }
      }
      clean(node, el);
      dest.append(el);
    }
  };
  clean(doc.body.firstChild, frag);
  return frag;
}

// ---------- clipboard ----------
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', '');
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.append(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    return ok;
  }
}

els.comments.addEventListener('click', async (e) => {
  if (e.target.closest('a')) return; // links behave normally
  const li = e.target.closest('.comment');
  if (!li) return;
  if (e.target.closest('.more')) {
    li.classList.remove('clamped');
    li.querySelector('.body').style.maxHeight = '';
    e.target.remove();
    return;
  }
  if (String(window.getSelection())) return; // user is selecting text
  const text = li.querySelector('.body').innerText.trim();
  const ok = await copyText(text);
  toast(ok ? 'Comment copied' : 'Copy failed');
  if (ok) { li.classList.add('copied'); setTimeout(() => li.classList.remove('copied'), 600); }
});

// ---------- misc ----------
let toastTimer;
let toastUndo = null;
function toast(msg, actionLabel, action) {
  els.toastMsg.textContent = msg;
  toastUndo = action || null;
  els.toastAction.hidden = !action;
  els.toastAction.textContent = actionLabel || '';
  els.toast.classList.toggle('actionable', Boolean(action));
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show', 'actionable');
    toastUndo = null;
  }, action ? 4000 : 1400);
}
els.toastAction.addEventListener('click', () => {
  const fn = toastUndo;
  toastUndo = null;
  clearTimeout(toastTimer);
  els.toast.classList.remove('show', 'actionable');
  if (fn) fn();
});

els.back.addEventListener('click', goToList);

// ---------- reader swipes ----------
// Swipe left: back to the list. Swipe right: next unread story. Both mark the current story read.
(() => {
  let x0 = 0, y0 = 0, t0 = 0, active = false;
  els.readView.addEventListener('touchstart', (e) => {
    active = e.touches.length === 1 && !e.target.closest('pre');
    if (!active) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  els.readView.addEventListener('touchend', (e) => {
    if (!active) return;
    active = false;
    if (String(window.getSelection())) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - x0, dy = t.clientY - y0;
    const min = Math.min(100, window.innerWidth * 0.25);
    if (Math.abs(dx) < min || Math.abs(dx) < 2 * Math.abs(dy) || Date.now() - t0 > 800) return;
    if (dx < 0) goToList(); else openNextUnread();
  }, { passive: true });
})();

// ---------- pull to refresh (list view) ----------
(() => {
  const TRIGGER = 70;
  let y0 = null, x0 = 0, pull = 0;
  const show = (px) => {
    els.ptr.style.height = `${px}px`;
    els.ptr.classList.toggle('armed', px >= TRIGGER);
  };
  document.addEventListener('touchstart', (e) => {
    y0 = null;
    if (els.listView.hidden || window.scrollY > 0 || e.touches.length !== 1 || els.refresh.disabled) return;
    y0 = e.touches[0].clientY; x0 = e.touches[0].clientX; pull = 0;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (y0 == null) return;
    const dy = e.touches[0].clientY - y0, dx = e.touches[0].clientX - x0;
    if (pull === 0 && Math.abs(dx) > Math.abs(dy)) { y0 = null; return; } // a row swipe, not a pull
    pull = Math.max(0, Math.min(110, dy * 0.5));
    show(pull);
  }, { passive: true });
  document.addEventListener('touchend', () => {
    if (y0 == null) return;
    y0 = null;
    els.ptr.classList.add('settle');
    show(0);
    setTimeout(() => els.ptr.classList.remove('settle'), 200);
    if (pull >= TRIGGER) loadList(true);
    pull = 0;
  }, { passive: true });
})();

// ---------- settings ----------
const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && v !== '' ? Math.min(hi, Math.max(lo, n)) : dflt;
};
$('#helpLink').addEventListener('click', (e) => {
  e.preventDefault();
  $('#help').showModal();
});
els.settingsBtn.addEventListener('click', () => {
  els.setTopN.value = settings.topN;
  els.setComments.value = settings.commentsN;
  els.setDaysBack.value = settings.daysBack;
  els.settings.showModal();
});
els.settings.addEventListener('close', () => {
  if (els.settings.returnValue !== 'save') return;
  const next = {
    topN: clampInt(els.setTopN.value, 5, 100, DEFAULTS.topN),
    commentsN: clampInt(els.setComments.value, 5, 50, DEFAULTS.commentsN),
    daysBack: clampInt(els.setDaysBack.value, 1, 7, DEFAULTS.daysBack),
  };
  const changed = JSON.stringify(next) !== JSON.stringify(settings);
  settings = next;
  store.set('yday.settings', settings);
  if (!changed) return;
  toast('Settings saved');
  if (readerId) showReader(readerId);
  else { listScrollY = 0; showList(); loadList(); }
});
els.refresh.addEventListener('click', () => {
  if (readerId) showReader(readerId); else loadList(true);
});
// Bypass the 10 min GitHub Pages cache: refetch assets, then load index.html under a fresh ?v=<ms> URL;
// index.html passes the same v on to style.css and app.js.
// localStorage is keyed by origin, not URL, so read marks and settings survive.
$('#reload').addEventListener('click', async (e) => {
  e.preventDefault();
  const assets = ['index.html', 'app.js', 'style.css', 'manifest.webmanifest', 'icon.svg'];
  await Promise.all(assets.map((f) => fetch(f, { cache: 'reload' }).catch(() => {})));
  location.replace(`${location.pathname}?v=${Date.now()}${location.hash}`);
});
els.toggleRead.addEventListener('click', () => {
  hideRead = !hideRead;
  store.set('yday.hideRead', hideRead);
  applyReadFilter();
});
window.addEventListener('hashchange', route);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !location.hash) loadList();
});

pruneRead();
loadList();
route();
