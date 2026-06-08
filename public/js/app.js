/* ═══════════════════════════════════════════════════════════════════
   POKEVAULT v4 — app.js  (Vercel + Supabase edition)
   New in v4:
     • profiles table — is_premium flag, account-age history window
     • price_history_cache — Supabase-first price history, saves API credits
     • portfolio_items table — separate investment tracking (cards + sealed)
     • Sealed products tab — search & add via /api/pokeprice?action=sealed
     • "Upgrade to Pro" modal — premium upsell scaffold
     • Rolling history rule: allowed_days = account_age_days + 5
     • Premium override: always fetch 180 days when is_premium === true
   ═══════════════════════════════════════════════════════════════════ */
'use strict';

const SUPABASE_URL      = 'https://jqzwvcjkekvdyimhryha.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Impxend2Y2prZWt2ZHlpbWhyeWhhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA1NzU5OTYsImV4cCI6MjA5NjE1MTk5Nn0.waU_KSWUuB0W_0Zu7tizbraAxmSpXyEVnKWCQnruXjs';
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── DB row → client object (existing cards table) ─────────────────
function dbToClient(row) {
  return {
    id:            row.id,
    name:          row.name,
    set:           row.set_name,
    type:          row.type,
    grade:         row.grade         ?? 'raw',
    quantity:      row.quantity      ?? 1,
    purchasePrice: row.purchase_price,
    purchaseDate:  row.purchase_date,
    targetPrice:   row.target_price,
    notes:         row.notes,
    currentValue:  row.current_value,
    lastUpdated:   row.last_updated,
    url:           row.url,
    priceHistory:  row.price_history ?? [],
    sold:          row.sold          ?? false,
    soldPrice:     row.sold_price,
    soldDate:      row.sold_date,
    soldTo:        row.sold_to,
  };
}

// DB row → client object (portfolio_items table)
function dbToPortfolioItem(row) {
  return {
    id:                 row.id,
    itemId:             row.item_id,
    type:               row.type,        // 'card' | 'sealed'
    name:               row.name,
    set:                row.set_name,
    imageUrl:           row.image_url,
    purchasePrice:      row.purchase_price,
    quantity:           row.quantity     ?? 1,
    conditionOrGrade:   row.condition_or_grade ?? 'Near Mint',
    language:           row.language     ?? 'english',
    notes:              row.notes,
    currentValue:       row.current_value,
    lastValueUpdated:   row.last_value_updated,
    sold:               row.sold         ?? false,
    soldPrice:          row.sold_price,
    soldDate:           row.sold_date,
    createdAt:          row.created_at,
  };
}

// ── Global state ──────────────────────────────────────────────────
let USD_TO_SGD          = 1.35;
let cards               = [];
let portfolioItems      = [];     // NEW: portfolio_items rows
let priceChart          = null;
let colorEnabled        = true;
let activeTypeFilter    = '';
let activeSetFilter     = '';
let activeMoversFilter  = '';
let searchQuery         = '';
let editingCardId       = null;
let activeCollectionTab = 'active';
let sortCol             = null;
let sortDir             = 1;
let _currentUserId      = null;
let _userProfile        = null;   // NEW: profiles row { is_premium, created_at }
let _allowedHistoryDays = 5;      // NEW: computed on init from account age

const _alertedTargets    = new Set();
let _cardImageUrl        = null;
let _cardImageLoaded     = false;
let _pickerResults       = [];
let _pickerCallback      = null;
let _pendingImageResults = [];
let _pendingImageCard    = null;

// Quick-search / add-card state
let _qsDebounceTimer  = null;
let _qsLastResults    = [];
let _qsLastLang       = 'english';
let _qsSelectedResult = null;

// Portfolio add modal state
let _portfolioAddResult = null;   // API result chosen for portfolio add

const TYPE_COLORS = {
  Fire:      { bg: 'rgba(255,100,50,0.12)',  border: '#ff6432', chart: '#ff6432' },
  Water:     { bg: 'rgba(74,144,217,0.12)',  border: '#4a90d9', chart: '#4a90d9' },
  Grass:     { bg: 'rgba(76,175,80,0.12)',   border: '#4caf50', chart: '#4caf50' },
  Electric:  { bg: 'rgba(255,200,0,0.12)',   border: '#ffc800', chart: '#ffc800' },
  Psychic:   { bg: 'rgba(220,80,160,0.12)',  border: '#dc50a0', chart: '#dc50a0' },
  Fighting:  { bg: 'rgba(192,80,40,0.12)',   border: '#c05028', chart: '#c05028' },
  Dark:      { bg: 'rgba(80,60,120,0.12)',   border: '#503c78', chart: '#8060c0' },
  Steel:     { bg: 'rgba(120,140,160,0.12)', border: '#788ca0', chart: '#788ca0' },
  Dragon:    { bg: 'rgba(40,100,220,0.12)',  border: '#2864dc', chart: '#2864dc' },
  Fairy:     { bg: 'rgba(240,100,180,0.12)', border: '#f064b4', chart: '#f064b4' },
  Normal:    { bg: 'rgba(160,160,120,0.12)', border: '#a0a078', chart: '#a0a078' },
  Colorless: { bg: 'rgba(180,180,180,0.08)', border: '#b4b4b4', chart: '#b4b4b4' },
};

const QS_TYPE_MAP = {
  fire:'Fire', water:'Water', grass:'Grass', lightning:'Electric', electric:'Electric',
  psychic:'Psychic', fighting:'Fighting', darkness:'Dark', dark:'Dark',
  metal:'Steel', steel:'Steel', dragon:'Dragon', fairy:'Fairy',
  normal:'Normal', colorless:'Colorless',
};

function getTypeColor(type) {
  if (!colorEnabled) return { bg: 'transparent', border: 'var(--border)', chart: 'var(--accent)' };
  return TYPE_COLORS[type] || { bg: 'transparent', border: 'var(--border)', chart: 'var(--accent)' };
}

function toggleColors() {
  colorEnabled = document.getElementById('color-toggle').checked;
  render();
}

const THEMES = ['dark', 'light', 'lucario'];
function setTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('pv-theme', theme);
  document.querySelectorAll('.theme-option').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-theme') === theme);
  });
}
(function initTheme() {
  let saved = localStorage.getItem('pv-theme') || 'dark';
  if (saved === 'dark2') saved = 'dark';
  setTheme(THEMES.includes(saved) ? saved : 'dark');
})();

window.addEventListener('scroll', () => {
  document.getElementById('site-header')?.classList.toggle('scrolled', window.scrollY > 20);
});

async function fetchExchangeRate() {
  try {
    const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
    if (!res.ok) return;
    const data = await res.json();
    if (data.rates?.SGD) {
      USD_TO_SGD = data.rates.SGD;
      const el = document.getElementById('fx-rate');
      if (el) el.textContent = 'USD/SGD: ' + USD_TO_SGD.toFixed(4);
    }
  } catch { console.warn('Exchange rate fetch failed — using fallback 1.35'); }
}

// ══════════════════════════════════════════════════════════════════
//  PROFILE & HISTORY WINDOW
// ══════════════════════════════════════════════════════════════════

// Compute how many days of history this user is allowed to fetch.
// Free:    account_age_days + 5  (minimum 5 on day 0)
// Premium: always 180
function computeAllowedHistoryDays(profile) {
  if (!profile) return 5;
  if (profile.is_premium) return 180;
  const created  = new Date(profile.created_at);
  const today    = new Date();
  const ageDays  = Math.floor((today - created) / (1000 * 60 * 60 * 24));
  return ageDays + 5;
}

async function loadProfile() {
  const { data, error } = await _sb
    .from('profiles')
    .select('id, created_at, is_premium')
    .eq('id', _currentUserId)
    .single();

  if (error && error.code === 'PGRST116') {
    // Row not found — create it (handles users created before the trigger existed)
    const { data: inserted } = await _sb
      .from('profiles')
      .insert([{ id: _currentUserId }])
      .select()
      .single();
    _userProfile = inserted;
  } else if (!error) {
    _userProfile = data;
  }

  _allowedHistoryDays = computeAllowedHistoryDays(_userProfile);

  // Update premium badge visibility
  const premBadge = document.getElementById('premium-badge');
  const upgradeBtn = document.getElementById('upgrade-btn');
  if (_userProfile?.is_premium) {
    if (premBadge) premBadge.style.display = 'inline-flex';
    if (upgradeBtn) upgradeBtn.style.display = 'none';
  } else {
    if (premBadge) premBadge.style.display = 'none';
    if (upgradeBtn) upgradeBtn.style.display = 'inline-flex';
  }

  // Update history window display
  const histEl = document.getElementById('history-days-display');
  if (histEl) {
    histEl.textContent = _userProfile?.is_premium
      ? '180-day history (Pro)'
      : `${_allowedHistoryDays}-day history`;
  }
}

// ══════════════════════════════════════════════════════════════════
//  PRICE HISTORY CACHE (Supabase-first)
// ══════════════════════════════════════════════════════════════════

// Read cached price history for an item from Supabase.
// Returns array of { recorded_date, price } sorted oldest-first,
// limited to the user's allowed window.
async function readCachedHistory(itemId, type, lang) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - _allowedHistoryDays);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  const { data, error } = await _sb
    .from('price_history_cache')
    .select('recorded_date, price')
    .eq('item_id', String(itemId))
    .eq('type', type)
    .eq('language', lang)
    .gte('recorded_date', cutoffStr)
    .order('recorded_date', { ascending: true });

  if (error) { console.warn('Cache read error:', error.message); return []; }
  return data || [];
}

// Check whether we have *enough* cached rows that we can skip the API call.
// "Enough" = we have today's price AND at least 2 data points total.
function cacheIsFresh(rows) {
  if (!rows || rows.length < 2) return false;
  const today = new Date().toISOString().split('T')[0];
  return rows.some(r => r.recorded_date === today);
}

// ══════════════════════════════════════════════════════════════════
//  INIT
// ══════════════════════════════════════════════════════════════════

async function init() {
  if (!document.getElementById('card-table')) return;
  const { data: { session } } = await _sb.auth.getSession();
  if (!session) { window.location.href = '/login'; return; }
  _currentUserId = session.user.id;
  const usernameEl = document.getElementById('username-display');
  if (usernameEl) usernameEl.textContent = session.user.email.split('@')[0];
  await Promise.all([fetchExchangeRate(), loadProfile()]);
  await Promise.all([loadCards(), loadPortfolioItems()]);
  checkAutoRefresh();
}

async function logout() {
  await _sb.auth.signOut();
  window.location.href = '/login';
}

async function loadCards() {
  const { data, error } = await _sb.from('cards').select('*')
    .eq('user_id', _currentUserId).order('created_at', { ascending: true });
  if (error) { console.error('loadCards error:', error); toast('Failed to load cards.', 'error'); return; }
  cards = data.map(dbToClient);
  render();
}

async function loadPortfolioItems() {
  const { data, error } = await _sb.from('portfolio_items').select('*')
    .eq('user_id', _currentUserId).order('created_at', { ascending: true });
  if (error) { console.error('loadPortfolioItems error:', error); return; }
  portfolioItems = data.map(dbToPortfolioItem);
  renderPortfolio();
}

async function checkAutoRefresh() {
  if (!cards.filter(c => !c.sold).length) return;
  const last = localStorage.getItem('lastRefresh');
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  if (!last || parseInt(last, 10) < oneDayAgo) {
    toast('Auto-refreshing prices…', 'info');
    await refreshPrices(true);
  }
}

// ══════════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════════

function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmt(val) { return val != null ? 'SGD $' + Number(val).toFixed(2) : '—'; }
function isSameDay(ts1, ts2) {
  const a = new Date(ts1), b = new Date(ts2);
  return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
}

function animateValue(el, target, prefix) {
  if (!el) return;
  const start = parseFloat(el.getAttribute('data-val') || '0');
  const duration = 600; const t0 = performance.now();
  const step = now => {
    const p = Math.min((now - t0) / duration, 1);
    const ease = 1 - Math.pow(1 - p, 3);
    el.textContent = prefix + '$' + (start + (target - start) * ease).toFixed(2);
    if (p < 1) requestAnimationFrame(step);
    else { el.textContent = prefix + '$' + target.toFixed(2); el.setAttribute('data-val', target); }
  };
  requestAnimationFrame(step);
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.classList.add('toast-show'), 10);
  setTimeout(() => { el.classList.remove('toast-show'); setTimeout(() => el.remove(), 300); }, 3500);
}

function confirmDialog(message) {
  return new Promise(resolve => {
    document.getElementById('confirm-message').textContent = message;
    const overlay = document.getElementById('confirm-overlay');
    overlay.classList.add('active');
    const ok = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    function cleanup(result) {
      overlay.classList.remove('active');
      ok.removeEventListener('click', onOk);
      cancel.removeEventListener('click', onCancel);
      resolve(result);
    }
    const onOk = () => cleanup(true);
    const onCancel = () => cleanup(false);
    ok.addEventListener('click', onOk);
    cancel.addEventListener('click', onCancel);
  });
}

// ══════════════════════════════════════════════════════════════════
//  UPGRADE MODAL (Premium upsell scaffold)
// ══════════════════════════════════════════════════════════════════

function openUpgradeModal() {
  document.getElementById('upgrade-overlay').classList.add('active');
}

function closeUpgradeModal() {
  document.getElementById('upgrade-overlay').classList.remove('active');
}

// ══════════════════════════════════════════════════════════════════
//  ADD CARD MODAL
// ══════════════════════════════════════════════════════════════════

function openAddModal() {
  _qsSelectedResult = null;
  _qsLastLang = 'english';
  ['f-name','f-set','f-variant','f-notes','f-quicksearch'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('f-price').value         = '';
  document.getElementById('f-target').value        = '';
  document.getElementById('f-quantity').value      = '1';
  document.getElementById('f-purchase-date').value = '';
  document.getElementById('f-type').value          = '';
  document.getElementById('f-grade').value         = 'raw';
  document.getElementById('qs-selected-preview').style.display = 'none';
  qsHide();
  document.getElementById('add-overlay').classList.add('active');
  setTimeout(() => document.getElementById('f-quicksearch')?.focus(), 100);
}

function closeAddModal() {
  document.getElementById('add-overlay').classList.remove('active');
  qsHide();
  _qsSelectedResult = null;
}

// ══════════════════════════════════════════════════════════════════
//  QUICK SEARCH (search bar inside the Add Card modal)
// ══════════════════════════════════════════════════════════════════

function _isCardNumber(q) {
  return /^\d+\/\d+$/.test(q.trim()) || /^\d{3}$/.test(q.trim());
}

function _parseQsInput(raw) {
  const jpFlag = /\s+JP\.?$/i;
  const isJP = jpFlag.test(raw);
  const cleaned = raw.replace(jpFlag, '').trim();
  const numSetMatch = cleaned.match(/^(\d+\/\d+)\s+(.+)$/);
  if (numSetMatch) {
    return { query: numSetMatch[1], setHint: numSetMatch[2].trim(), lang: isJP ? 'japanese' : 'english' };
  }
  return { query: cleaned, setHint: '', lang: isJP ? 'japanese' : 'english' };
}

function qsDebounce() {
  clearTimeout(_qsDebounceTimer);
  _qsDebounceTimer = setTimeout(qsSearch, 480);
}

function qsSetLoading(text) {
  const box = document.getElementById('qs-results');
  if (!box) return;
  box.style.display = 'block';
  box.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text3);font-size:13px;font-family:var(--font-mono);">${text}</div>`;
}

function qsHide() {
  const box = document.getElementById('qs-results');
  if (!box) return;
  box.style.display = 'none';
  box.innerHTML = '';
  _qsLastResults = [];
}

async function qsSearch() {
  clearTimeout(_qsDebounceTimer);
  const raw = (document.getElementById('f-quicksearch')?.value || '').trim();
  if (!raw) { qsHide(); return; }
  const { query, setHint, lang } = _parseQsInput(raw);
  if (!query) { qsHide(); return; }
  _qsLastLang = lang;
  qsSetLoading('Searching…');
  try {
    let results;
    if (_isCardNumber(query)) {
      const p = new URLSearchParams({ action: 'bynumber', name: query, language: lang });
      if (setHint) p.set('set', setHint);
      const r = await fetch('/api/pokeprice?' + p);
      const d = await r.json();
      results = d.results || [];
    } else {
      const p = new URLSearchParams({ action: 'search', name: query, language: lang });
      const r = await fetch('/api/pokeprice?' + p);
      const d = await r.json();
      results = d.results || [];
    }
    _qsLastResults = results;
    _qsRenderResults(results, lang, false);
  } catch (e) {
    console.error('qsSearch error:', e);
    qsSetLoading('Search failed — check connection');
  }
}

async function qsSealedSearch() {
  const raw = (document.getElementById('f-quicksearch')?.value || '').trim();
  const { query, lang } = _parseQsInput(raw);
  _qsLastLang = lang;
  qsSetLoading('Searching sealed products…');
  try {
    const p = new URLSearchParams({ action: 'sealed', language: lang });
    if (query) p.set('name', query);
    const r = await fetch('/api/pokeprice?' + p);
    const d = await r.json();
    _qsLastResults = d.results || [];
    _qsRenderResults(_qsLastResults, lang, true);
  } catch (e) {
    console.error('qsSealedSearch error:', e);
    qsSetLoading('Search failed — check connection');
  }
}

function _extractResultPrice(r, isSealed) {
  if (isSealed) return r.unopenedPrice ?? null;
  if (r.prices?.market    != null) return r.prices.market;
  if (r.prices?.lowPrice  != null) return r.prices.lowPrice;
  if (r.prices?.midPrice  != null) return r.prices.midPrice;
  if (r.japanesePrice     != null) return r.japanesePrice;
  if (r.averagePrice      != null) return r.averagePrice;
  if (r.marketPrice       != null) return r.marketPrice;
  if (r.price             != null) return r.price;
  return null;
}

function _qsRenderResults(results, lang, isSealed) {
  const box = document.getElementById('qs-results');
  if (!box) return;
  if (!results.length) {
    box.style.display = 'block';
    box.innerHTML = `<div style="padding:18px;text-align:center;color:var(--text3);font-size:13px;font-family:var(--font-mono);">No results found</div>`;
    return;
  }
  const raw = (document.getElementById('f-quicksearch')?.value || '').trim();
  const { query } = _parseQsInput(raw);
  if (_isCardNumber(query) && results.length > 1) {
    box.style.display = 'none';
    _qsOpenPicker(results, isSealed);
    return;
  }
  box.style.display = 'block';
  box.innerHTML = results.map((r, i) => {
    const thumb    = r.imageCdnUrl200 || r.imageCdnUrl400 || r.imageCdnUrl || '';
    const priceUSD = _extractResultPrice(r, isSealed);
    const priceTxt = priceUSD != null ? `SGD $${(priceUSD * USD_TO_SGD).toFixed(2)}` : '';
    const sub      = isSealed
      ? esc(r.setName || '—')
      : `${esc(r.setName||'—')}${r.cardNumber?' · #'+esc(r.cardNumber):''}${r.rarity?' · '+esc(r.rarity):''}${lang==='japanese'?' · 🇯🇵':''}`;
    const imgEl = thumb
      ? `<img src="${esc(thumb)}" style="width:34px;height:48px;object-fit:contain;border-radius:3px;flex-shrink:0;" />`
      : `<span style="width:34px;height:48px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">${isSealed?'📦':'🃏'}</span>`;
    return `<div onclick="_qsSelect(${i},${isSealed})"
      style="display:flex;align-items:center;gap:12px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .12s;"
      onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background=''">
      ${imgEl}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.name)}</div>
        <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono);margin-top:2px;">${sub}</div>
      </div>
      <div style="font-family:var(--font-mono);font-size:12px;color:var(--accent);white-space:nowrap;">${esc(priceTxt)}</div>
    </div>`;
  }).join('');
}

function _qsOpenPicker(results, isSealed) {
  const grid = document.getElementById('picker-grid');
  document.getElementById('picker-title').textContent = 'Multiple cards found — pick the right one';
  document.getElementById('picker-overlay').classList.add('active');
  grid.innerHTML = results.map((r, i) => {
    const thumb    = r.imageCdnUrl200 || r.imageCdnUrl400 || r.imageCdnUrl || '';
    const priceUSD = _extractResultPrice(r, isSealed);
    const priceTxt = priceUSD != null ? `SGD $${(priceUSD * USD_TO_SGD).toFixed(2)}` : '—';
    const imgEl = thumb
      ? `<img src="${esc(thumb)}" alt="${esc(r.name)}" loading="lazy" style="width:100%;border-radius:6px;" />`
      : `<div style="width:100%;aspect-ratio:2/3;background:var(--bg2);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:32px;">${isSealed?'📦':'🃏'}</div>`;
    return `<div class="picker-item" onclick="_qsPickerSelect(${i},${isSealed})">
      <div class="picker-img-wrap">${imgEl}</div>
      <div class="picker-info">
        <div class="picker-name">${esc(r.name)}</div>
        <div class="picker-set">${esc(r.setName||'—')}</div>
        <div class="picker-num">#${esc(r.cardNumber||r.tcgPlayerId||'?')} · ${esc(priceTxt)}</div>
      </div>
    </div>`;
  }).join('');
  grid._qsResults  = results;
  grid._qsIsSealed = isSealed;
}

function _qsPickerSelect(index, isSealed) {
  document.getElementById('picker-overlay').classList.remove('active');
  const grid = document.getElementById('picker-grid');
  _qsApply((grid._qsResults || [])[index], isSealed);
}

function _qsSelect(index, isSealed) {
  qsHide();
  _qsApply(_qsLastResults[index], isSealed);
}

function _qsApply(r, isSealed) {
  if (!r) return;
  _qsSelectedResult = r;
  const isJP = _qsLastLang === 'japanese';

  if (isSealed) {
    document.getElementById('f-name').value  = r.name    || '';
    document.getElementById('f-set').value   = r.setName || '';
    document.getElementById('f-type').value  = '';
    document.getElementById('f-grade').value = 'raw';
    const priceUSD = _extractResultPrice(r, true);
    const pi = document.getElementById('f-price');
    if (!pi.value && priceUSD != null) pi.value = (priceUSD * USD_TO_SGD).toFixed(2);
  } else {
    const displayName = isJP ? (r.name || '') + ' 🇯🇵' : (r.name || '');
    document.getElementById('f-name').value = displayName;
    document.getElementById('f-set').value  = r.setName || '';
    const rawType   = (r.pokemonType || '').toLowerCase();
    const firstType = Array.isArray(r.energyType) ? (r.energyType[0] || '').toLowerCase() : rawType;
    const mapped    = QS_TYPE_MAP[rawType] || QS_TYPE_MAP[firstType] || '';
    if (mapped) document.getElementById('f-type').value = mapped;
    const priceUSD = _extractResultPrice(r, false);
    const pi = document.getElementById('f-price');
    if (!pi.value && priceUSD != null) pi.value = (priceUSD * USD_TO_SGD).toFixed(2);
  }

  const thumb = r.imageCdnUrl200 || r.imageCdnUrl400 || r.imageCdnUrl || '';
  const preview = document.getElementById('qs-selected-preview');
  const previewImg = document.getElementById('qs-preview-img');
  const previewName = document.getElementById('qs-preview-name');
  const previewSub  = document.getElementById('qs-preview-sub');
  if (preview) {
    preview.style.display = 'flex';
    if (previewImg) { previewImg.src = thumb; previewImg.style.display = thumb ? 'block' : 'none'; }
    if (previewName) previewName.textContent = r.name || '';
    if (previewSub) previewSub.textContent = [r.setName, r.cardNumber ? '#'+r.cardNumber : '', isJP ? '🇯🇵 Japanese' : ''].filter(Boolean).join(' · ');
  }

  if (document.getElementById('f-quicksearch')) document.getElementById('f-quicksearch').value = '';
  qsHide();
  document.getElementById('f-price').focus();
}

function clearQsSelection() {
  _qsSelectedResult = null;
  document.getElementById('qs-selected-preview').style.display = 'none';
  ['f-name','f-set','f-type','f-price'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  document.getElementById('f-grade').value = 'raw';
  document.getElementById('f-quicksearch')?.focus();
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO ADD MODAL
// ══════════════════════════════════════════════════════════════════

// Open the portfolio add modal pre-filled with a search result.
// Called from search results in the Portfolio tab (via _qsSelect path)
// and from the card/sealed detail view "Add to Portfolio" button.
function openPortfolioAddModal(apiResult, isSealed) {
  if (!apiResult) return;
  _portfolioAddResult = { result: apiResult, isSealed };

  const isJP      = _qsLastLang === 'japanese';
  const priceUSD  = _extractResultPrice(apiResult, isSealed);
  const priceSGD  = priceUSD != null ? (priceUSD * USD_TO_SGD).toFixed(2) : '';

  document.getElementById('pf-item-name').textContent  = apiResult.name || '—';
  document.getElementById('pf-item-set').textContent   = apiResult.setName || '—';
  document.getElementById('pf-item-type').textContent  = isSealed ? '📦 Sealed' : '🃏 Card';

  const imgEl = document.getElementById('pf-item-img');
  const thumb = apiResult.imageCdnUrl200 || apiResult.imageCdnUrl400 || apiResult.imageCdnUrl || '';
  if (imgEl) { imgEl.src = thumb; imgEl.style.display = thumb ? 'block' : 'none'; }

  document.getElementById('pf-purchase-price').value  = priceSGD;
  document.getElementById('pf-quantity').value        = '1';
  document.getElementById('pf-notes').value           = '';

  // Populate condition/grade dropdown
  const gradeEl = document.getElementById('pf-condition');
  if (gradeEl) {
    gradeEl.innerHTML = isSealed
      ? `<option value="Sealed">Sealed / Unopened</option>
         <option value="Opened">Opened</option>`
      : `<option value="Near Mint">Near Mint</option>
         <option value="Lightly Played">Lightly Played</option>
         <option value="Moderately Played">Moderately Played</option>
         <option value="Heavily Played">Heavily Played</option>
         <option value="Damaged">Damaged</option>
         <option value="PSA 10">PSA 10</option>
         <option value="PSA 9">PSA 9</option>
         <option value="PSA 8">PSA 8</option>
         <option value="PSA 7">PSA 7</option>
         <option value="BGS 10">BGS 10</option>
         <option value="BGS 9.5">BGS 9.5</option>
         <option value="BGS 9">BGS 9</option>`;
  }

  document.getElementById('portfolio-add-overlay').classList.add('active');
  setTimeout(() => document.getElementById('pf-purchase-price')?.focus(), 100);
}

function closePortfolioAddModal() {
  document.getElementById('portfolio-add-overlay').classList.remove('active');
  _portfolioAddResult = null;
}

async function savePortfolioItem() {
  const { result: r, isSealed } = _portfolioAddResult || {};
  if (!r) return;

  const purchasePrice    = parseFloat(document.getElementById('pf-purchase-price').value);
  const quantity         = parseInt(document.getElementById('pf-quantity').value, 10) || 1;
  const conditionOrGrade = document.getElementById('pf-condition').value;
  const notes            = document.getElementById('pf-notes').value.trim();

  if (!purchasePrice || purchasePrice <= 0) { toast('Please enter a valid purchase price.', 'error'); return; }

  const isJP    = _qsLastLang === 'japanese';
  const imgUrl  = r.imageCdnUrl || r.imageCdnUrl400 || r.imageCdnUrl200 || null;
  const itemId  = String(r.tcgPlayerId || r.id || r.productId || crypto.randomUUID());
  const priceUSD = _extractResultPrice(r, isSealed);
  const currentValueSGD = priceUSD != null ? Math.round(priceUSD * USD_TO_SGD * 100) / 100 : null;

  const row = {
    user_id:            _currentUserId,
    item_id:            itemId,
    type:               isSealed ? 'sealed' : 'card',
    name:               r.name || '—',
    set_name:           r.setName || null,
    image_url:          imgUrl,
    purchase_price:     purchasePrice,
    quantity,
    condition_or_grade: conditionOrGrade,
    language:           isJP ? 'japanese' : 'english',
    notes:              notes || null,
    current_value:      currentValueSGD,
    last_value_updated: currentValueSGD ? new Date().toISOString() : null,
  };

  const { data, error } = await _sb.from('portfolio_items').insert([row]).select().single();
  if (error) { toast('Failed to save: ' + error.message, 'error'); return; }

  portfolioItems.push(dbToPortfolioItem(data));
  closePortfolioAddModal();
  renderPortfolio();
  toast(`${r.name} added to portfolio.`, 'success');
}

async function deletePortfolioItem(id) {
  const item = portfolioItems.find(i => i.id === id);
  if (!await confirmDialog('Remove "' + (item?.name ?? 'this item') + '" from your portfolio?')) return;
  const { error } = await _sb.from('portfolio_items').delete().eq('id', id).eq('user_id', _currentUserId);
  if (error) { toast('Failed to delete.', 'error'); return; }
  portfolioItems = portfolioItems.filter(i => i.id !== id);
  renderPortfolio();
  toast('Item removed from portfolio.', 'info');
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO RENDER
// ══════════════════════════════════════════════════════════════════

function renderPortfolio() {
  const tbody = document.getElementById('portfolio-table');
  if (!tbody) return;

  const active = portfolioItems.filter(i => !i.sold);
  const sold   = portfolioItems.filter(i =>  i.sold);

  // Metrics
  const totalCost  = active.reduce((s,i) => s + Number(i.purchasePrice) * (i.quantity||1), 0);
  const totalValue = active.reduce((s,i) => {
    const val = i.currentValue != null ? Number(i.currentValue) : Number(i.purchasePrice);
    return s + val * (i.quantity||1);
  }, 0);
  const totalPL  = totalValue - totalCost;
  const roi      = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;

  const metricCost  = document.getElementById('pf-metric-cost');
  const metricValue = document.getElementById('pf-metric-value');
  const metricPL    = document.getElementById('pf-metric-pl');
  const metricROI   = document.getElementById('pf-metric-roi');
  if (metricCost)  metricCost.textContent  = 'SGD $' + totalCost.toFixed(2);
  if (metricValue) animateValue(metricValue, totalValue, 'SGD ');
  if (metricPL) {
    metricPL.textContent = (totalPL >= 0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(totalPL).toFixed(2);
    metricPL.className = 'pf-metric-val ' + (totalPL >= 0 ? 'profit-pos' : 'profit-neg');
  }
  if (metricROI) {
    metricROI.textContent = (roi >= 0 ? '+' : '') + roi.toFixed(1) + '%';
    metricROI.className = 'pf-metric-val ' + (roi >= 0 ? 'profit-pos' : 'profit-neg');
  }

  if (!active.length) {
    tbody.innerHTML = '<tr><td colspan="8"><div class="empty-state">No items in portfolio — search for a card or sealed product and click "Add to Portfolio"</div></td></tr>';
    return;
  }

  tbody.innerHTML = active.map(item => {
    const cost        = Number(item.purchasePrice) * (item.quantity||1);
    const val         = item.currentValue != null ? Number(item.currentValue) * (item.quantity||1) : null;
    const profit      = val != null ? val - cost : null;
    const profitStr   = profit != null ? (profit>=0?'↑ +':'↓ ')+'SGD $'+Math.abs(profit).toFixed(2) : '—';
    const profitClass = profit == null ? '' : (profit >= 0 ? 'profit-pos' : 'profit-neg');
    const typeIcon    = item.type === 'sealed' ? '📦' : '🃏';
    const thumb       = item.imageUrl;
    const imgEl       = thumb
      ? `<img src="${esc(thumb)}" style="width:28px;height:40px;object-fit:contain;border-radius:3px;vertical-align:middle;margin-right:8px;" />`
      : `<span style="margin-right:8px;">${typeIcon}</span>`;
    const langFlag    = item.language === 'japanese' ? ' 🇯🇵' : '';
    return `<tr>
      <td style="font-weight:600;">${imgEl}${esc(item.name)}${langFlag}</td>
      <td style="color:var(--text2);">${esc(item.set||'—')}</td>
      <td><span class="badge badge-raw">${esc(item.conditionOrGrade)}</span></td>
      <td style="font-family:var(--font-mono);">×${item.quantity||1}</td>
      <td style="font-family:var(--font-mono);">SGD $${cost.toFixed(2)}</td>
      <td style="font-family:var(--font-mono);">${val!=null?'SGD $'+val.toFixed(2):'<span style="color:var(--text3);">—</span>'}</td>
      <td class="${profitClass}" style="font-family:var(--font-mono);font-weight:600;">${profitStr}</td>
      <td><button class="del-btn" onclick="deletePortfolioItem('${item.id}')" title="Remove">✕</button></td>
    </tr>`;
  }).join('');
}

// ══════════════════════════════════════════════════════════════════
//  PORTFOLIO SEARCH (standalone search for the Portfolio tab)
// ══════════════════════════════════════════════════════════════════

let _pfSearchResults  = [];
let _pfSearchLang     = 'english';
let _pfSearchDebounce = null;

function pfSearchDebounce() {
  clearTimeout(_pfSearchDebounce);
  _pfSearchDebounce = setTimeout(pfSearch, 480);
}

function pfSetSearchLang(lang) {
  _pfSearchLang = lang;
  document.querySelectorAll('.pf-lang-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.lang === lang));
}

async function pfSearch() {
  clearTimeout(_pfSearchDebounce);
  const raw     = (document.getElementById('pf-search-input')?.value || '').trim();
  const isSealed = document.getElementById('pf-search-sealed')?.checked;
  if (!raw) {
    const resultsEl = document.getElementById('pf-search-results');
    if (resultsEl) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; }
    return;
  }

  const resultsEl = document.getElementById('pf-search-results');
  if (resultsEl) {
    resultsEl.style.display = 'block';
    resultsEl.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text3);font-size:13px;font-family:var(--font-mono);">Searching…</div>`;
  }

  try {
    let endpoint, params;
    if (isSealed) {
      params = new URLSearchParams({ action: 'sealed', language: _pfSearchLang });
      if (raw) params.set('name', raw);
    } else {
      const { query, setHint } = _parseQsInput(raw);
      if (_isCardNumber(query)) {
        params = new URLSearchParams({ action: 'bynumber', name: query, language: _pfSearchLang });
        if (setHint) params.set('set', setHint);
      } else {
        params = new URLSearchParams({ action: 'search', name: query, language: _pfSearchLang });
      }
    }
    const r = await fetch('/api/pokeprice?' + params);
    const d = await r.json();
    _pfSearchResults = d.results || [];
    pfRenderSearchResults(_pfSearchResults, isSealed);
  } catch (e) {
    if (resultsEl) resultsEl.innerHTML = `<div style="padding:14px;color:var(--text3);font-size:13px;font-family:var(--font-mono);">Search failed</div>`;
  }
}

function pfRenderSearchResults(results, isSealed) {
  const box = document.getElementById('pf-search-results');
  if (!box) return;
  if (!results.length) {
    box.style.display = 'block';
    box.innerHTML = `<div style="padding:14px;text-align:center;color:var(--text3);font-size:13px;font-family:var(--font-mono);">No results found</div>`;
    return;
  }
  box.style.display = 'block';
  box.innerHTML = results.map((r, i) => {
    const thumb    = r.imageCdnUrl200 || r.imageCdnUrl400 || r.imageCdnUrl || '';
    const priceUSD = _extractResultPrice(r, isSealed);
    const priceTxt = priceUSD != null ? `SGD $${(priceUSD * USD_TO_SGD).toFixed(2)}` : '';
    const imgEl = thumb
      ? `<img src="${esc(thumb)}" style="width:34px;height:48px;object-fit:contain;border-radius:3px;flex-shrink:0;" />`
      : `<span style="width:34px;height:48px;display:flex;align-items:center;justify-content:center;font-size:20px;flex-shrink:0;">${isSealed?'📦':'🃏'}</span>`;
    const sub = isSealed
      ? esc(r.setName||'—')
      : `${esc(r.setName||'—')}${r.cardNumber?' · #'+esc(r.cardNumber):''}${r.rarity?' · '+esc(r.rarity):''}`;
    return `<div onclick="pfPickResult(${i},${isSealed})"
      style="display:flex;align-items:center;gap:12px;padding:9px 14px;cursor:pointer;border-bottom:1px solid var(--border);transition:background .12s;"
      onmouseover="this.style.background='var(--bg2)'" onmouseout="this.style.background=''">
      ${imgEl}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:600;font-size:13px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(r.name)}</div>
        <div style="font-size:11px;color:var(--text3);font-family:var(--font-mono);margin-top:2px;">${sub}</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-family:var(--font-mono);font-size:12px;color:var(--accent);">${esc(priceTxt)}</span>
        <button class="btn-add-portfolio" onclick="event.stopPropagation();pfPickResult(${i},${isSealed})" style="white-space:nowrap;">+ Portfolio</button>
      </div>
    </div>`;
  }).join('');
}

function pfPickResult(index, isSealed) {
  const r = _pfSearchResults[index];
  if (!r) return;
  // Hide results
  const box = document.getElementById('pf-search-results');
  if (box) { box.style.display = 'none'; box.innerHTML = ''; }
  openPortfolioAddModal(r, isSealed);
}

// ══════════════════════════════════════════════════════════════════
//  COLLECTION TAB NAVIGATION
// ══════════════════════════════════════════════════════════════════

function switchTab(tab) {
  activeCollectionTab = tab;
  const tabs   = ['active', 'sold', 'portfolio'];
  const panels = ['panel-active', 'panel-sold', 'panel-portfolio'];
  tabs.forEach((t, i) => {
    document.getElementById('tab-' + t)?.classList.toggle('active', t === tab);
    const panel = document.getElementById(panels[i]);
    if (panel) panel.style.display = t === tab ? 'block' : 'none';
  });
}

function populateSetFilter() {
  const sets    = [...new Set(cards.filter(c => !c.sold && c.set).map(c => c.set))].sort();
  const sel     = document.getElementById('filter-set');
  const current = sel.value;
  sel.innerHTML = '<option value="">All sets</option>' +
    sets.map(s => `<option value="${esc(s)}"${s===current?' selected':''}>${esc(s)}</option>`).join('');
}

// ══════════════════════════════════════════════════════════════════
//  ADD CARD (vault cards table)
// ══════════════════════════════════════════════════════════════════

async function addCard() {
  const name         = document.getElementById('f-name').value.trim();
  const set          = document.getElementById('f-set').value.trim();
  const variant      = document.getElementById('f-variant').value.trim();
  const type         = document.getElementById('f-type').value;
  const grade        = document.getElementById('f-grade').value;
  const quantity     = parseInt(document.getElementById('f-quantity').value, 10) || 1;
  const price        = parseFloat(document.getElementById('f-price').value);
  const purchaseDate = document.getElementById('f-purchase-date').value;
  const targetPrice  = parseFloat(document.getElementById('f-target').value) || null;
  const notes        = document.getElementById('f-notes').value.trim();

  if (!name)                { toast('Please enter a card name.', 'error'); return; }
  if (!price || price <= 0) { toast('Please enter a valid purchase price.', 'error'); return; }

  const displayName = variant ? `${name} (${variant})` : name;
  const id          = crypto.randomUUID();
  const r           = _qsSelectedResult;
  const imgUrl      = r ? (r.imageCdnUrl || r.imageCdnUrl400 || r.imageCdnUrl200 || null) : null;

  const { data, error } = await _sb.from('cards').insert([{
    id, user_id: _currentUserId, name: displayName, set_name: set||null,
    type: type||null, grade, quantity, purchase_price: price,
    purchase_date: purchaseDate||null, target_price: targetPrice,
    notes: notes||null, current_value: null, last_updated: null,
    url: imgUrl, price_history: [], sold: false,
  }]).select().single();

  if (error) { toast('Failed to save card: ' + error.message, 'error'); return; }
  cards.push(dbToClient(data));
  render();
  closeAddModal();
  toast(displayName + ' added to your vault.', 'success');
}

async function deleteCard(id) {
  const card = cards.find(c => c.id === id);
  if (!await confirmDialog('Remove "' + (card?.name ?? 'this card') + '" from your vault?')) return;
  const { error } = await _sb.from('cards').delete().eq('id', id).eq('user_id', _currentUserId);
  if (error) { toast('Failed to delete card.', 'error'); return; }
  cards = cards.filter(c => c.id !== id);
  _alertedTargets.delete(id);
  render();
  toast('Card removed.', 'info');
}

async function resetVault() {
  if (!await confirmDialog('Delete ALL cards from your vault? This cannot be undone.')) return;
  const { error } = await _sb.from('cards').delete().eq('user_id', _currentUserId);
  if (error) { toast('Failed to reset vault.', 'error'); return; }
  cards = []; _alertedTargets.clear(); render();
  toast('Vault reset. All cards removed.', 'info');
}

// ── Edit modal ─────────────────────────────────────────────────────
function openEditForm(idOverride) {
  const targetId = idOverride || editingCardId;
  if (!targetId) return;
  editingCardId = targetId;
  const card = cards.find(c => c.id === targetId);
  if (!card) return;
  document.getElementById('edit-id').value            = card.id;
  document.getElementById('edit-name').value          = card.name          || '';
  document.getElementById('edit-set').value           = card.set           || '';
  document.getElementById('edit-type').value          = card.type          || '';
  document.getElementById('edit-grade').value         = card.grade         || 'raw';
  document.getElementById('edit-quantity').value      = card.quantity      || 1;
  document.getElementById('edit-price').value         = card.purchasePrice || '';
  document.getElementById('edit-purchase-date').value = card.purchaseDate  || '';
  document.getElementById('edit-target').value        = card.targetPrice   || '';
  document.getElementById('edit-notes').value         = card.notes         || '';
  document.getElementById('edit-url').value           = card.url           || '';
  document.getElementById('modal-overlay').classList.remove('active');
  document.getElementById('edit-overlay').classList.add('active');
}

function closeEditModal() { document.getElementById('edit-overlay').classList.remove('active'); }

async function saveEdit() {
  const id           = document.getElementById('edit-id').value;
  const name         = document.getElementById('edit-name').value.trim();
  const set          = document.getElementById('edit-set').value.trim();
  const type         = document.getElementById('edit-type').value;
  const grade        = document.getElementById('edit-grade').value;
  const quantity     = parseInt(document.getElementById('edit-quantity').value, 10) || 1;
  const price        = parseFloat(document.getElementById('edit-price').value);
  const purchaseDate = document.getElementById('edit-purchase-date').value;
  const targetPrice  = parseFloat(document.getElementById('edit-target').value) || null;
  const notes        = document.getElementById('edit-notes').value.trim();
  const url          = document.getElementById('edit-url').value.trim();

  if (!name)                { toast('Card name is required.', 'error'); return; }
  if (!price || price <= 0) { toast('Please enter a valid price.', 'error'); return; }

  const { error } = await _sb.from('cards')
    .update({ name, set_name: set||null, type: type||null, grade, quantity,
              purchase_price: price, purchase_date: purchaseDate||null,
              target_price: targetPrice, notes: notes||null, url: url||null })
    .eq('id', id).eq('user_id', _currentUserId);

  if (error) { toast('Failed to save changes.', 'error'); return; }
  const idx = cards.findIndex(c => c.id === id);
  if (idx > -1) {
    cards[idx] = { ...cards[idx], name, set, type, grade, quantity, purchasePrice: price, purchaseDate, targetPrice, notes, url };
    _alertedTargets.delete(id);
  }
  closeEditModal(); render(); toast('Card updated.', 'success');
}

// ── Sell modal ─────────────────────────────────────────────────────
function openSellForm() {
  const card = cards.find(c => c.id === editingCardId);
  if (!card) return;
  document.getElementById('sell-id').value    = card.id;
  document.getElementById('sell-price').value = card.currentValue || '';
  document.getElementById('sell-date').value  = new Date().toISOString().split('T')[0];
  document.getElementById('sell-to').value    = '';
  document.getElementById('modal-overlay').classList.remove('active');
  document.getElementById('sell-overlay').classList.add('active');
}

function closeSellModal() { document.getElementById('sell-overlay').classList.remove('active'); }

async function confirmSell() {
  const id        = document.getElementById('sell-id').value;
  const soldPrice = parseFloat(document.getElementById('sell-price').value);
  const soldDate  = document.getElementById('sell-date').value;
  const soldTo    = document.getElementById('sell-to').value.trim();
  if (!soldPrice || soldPrice <= 0) { toast('Please enter a valid sale price.', 'error'); return; }
  const { error } = await _sb.from('cards')
    .update({ sold: true, sold_price: soldPrice, sold_date: soldDate||null, sold_to: soldTo||null })
    .eq('id', id).eq('user_id', _currentUserId);
  if (error) { toast('Failed to mark as sold.', 'error'); return; }
  const idx = cards.findIndex(c => c.id === id);
  if (idx > -1) cards[idx] = { ...cards[idx], sold: true, soldPrice, soldDate, soldTo };
  closeSellModal(); render(); toast('Card marked as sold.', 'success');
}

// ── Manual price modal ─────────────────────────────────────────────
function openManualPrice() {
  const card = cards.find(c => c.id === editingCardId);
  if (!card) return;
  document.getElementById('manual-price-id').value  = card.id;
  document.getElementById('manual-price-val').value = card.currentValue || '';
  document.getElementById('modal-overlay').classList.remove('active');
  document.getElementById('manual-price-overlay').classList.add('active');
  setTimeout(() => document.getElementById('manual-price-val').focus(), 100);
}

function closeManualPriceModal() { document.getElementById('manual-price-overlay').classList.remove('active'); }

async function saveManualPrice() {
  const id  = document.getElementById('manual-price-id').value;
  const val = parseFloat(document.getElementById('manual-price-val').value);
  if (!val || val <= 0) { toast('Please enter a valid price.', 'error'); return; }
  const idx = cards.findIndex(c => c.id === id);
  if (idx < 0) return;
  const now     = Date.now();
  const history = [...(cards[idx].priceHistory || [])];
  const last    = history[history.length - 1];
  if (!last || !isSameDay(last.date, now)) history.push({ date: now, value: val });
  else history[history.length - 1] = { date: now, value: val };
  const { error } = await _sb.from('cards')
    .update({ current_value: val, last_updated: now, price_history: history })
    .eq('id', id).eq('user_id', _currentUserId);
  if (error) { toast('Failed to save price.', 'error'); return; }
  cards[idx] = { ...cards[idx], currentValue: val, lastUpdated: now, priceHistory: history };
  closeManualPriceModal(); render(); toast('Price updated manually.', 'success');
}

// ── Filters & search ───────────────────────────────────────────────
function applyFilter() {
  activeTypeFilter   = document.getElementById('filter-type').value;
  activeSetFilter    = document.getElementById('filter-set').value;
  activeMoversFilter = document.getElementById('filter-movers').value;
  render();
}

function applySearch() {
  searchQuery = document.getElementById('search-input').value.trim().toLowerCase();
  render();
}

function getFilteredCards() {
  let filtered = cards.filter(c => !c.sold);
  if (searchQuery) filtered = filtered.filter(c =>
    c.name.toLowerCase().includes(searchQuery) || (c.set||'').toLowerCase().includes(searchQuery));
  if (activeTypeFilter) filtered = filtered.filter(c => c.type === activeTypeFilter);
  if (activeSetFilter)  filtered = filtered.filter(c => c.set  === activeSetFilter);
  if (activeMoversFilter) {
    const priced = filtered.filter(c => c.currentValue != null);
    const sorted = [...priced].sort((a, b) => {
      const ap = (Number(a.currentValue) - Number(a.purchasePrice)) / Number(a.purchasePrice);
      const bp = (Number(b.currentValue) - Number(b.purchasePrice)) / Number(b.purchasePrice);
      return bp - ap;
    });
    if (activeMoversFilter === 'gainers')     filtered = sorted.slice(0, 5);
    else if (activeMoversFilter === 'losers') filtered = sorted.slice(-5).reverse();
  }
  return filtered;
}

function sortBy(col) { sortDir = sortCol === col ? -sortDir : 1; sortCol = col; render(); }

function getSortedCards(list) {
  if (!sortCol) return list;
  return [...list].sort((a, b) => {
    let av, bv;
    switch (sortCol) {
      case 'name':          av = a.name.toLowerCase();          bv = b.name.toLowerCase();          break;
      case 'set':           av = (a.set||'').toLowerCase();     bv = (b.set||'').toLowerCase();     break;
      case 'purchasePrice': av = Number(a.purchasePrice);       bv = Number(b.purchasePrice);       break;
      case 'currentValue':  av = Number(a.currentValue||0);     bv = Number(b.currentValue||0);     break;
      case 'profit':
        av = a.currentValue != null ? Number(a.currentValue)-Number(a.purchasePrice) : -Infinity;
        bv = b.currentValue != null ? Number(b.currentValue)-Number(b.purchasePrice) : -Infinity;
        break;
      case 'lastUpdated':   av = a.lastUpdated||0;              bv = b.lastUpdated||0;              break;
      default: return 0;
    }
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });
}

function exportCSV() {
  const all = [...cards.filter(c => !c.sold), ...cards.filter(c => c.sold)];
  if (!all.length) { toast('No cards to export.', 'info'); return; }
  const headers = ['Name','Set','Type','Grade','Quantity','Purchase Price (SGD)','Current Value (SGD)',
    'P/L (SGD)','Purchase Date','Target Price','Notes','Status','Sold Price','Sold Date','Sold To'];
  const rows = all.map(c => {
    const cost = Number(c.purchasePrice) * (c.quantity||1);
    const val  = c.sold ? Number(c.soldPrice||0)*(c.quantity||1) : c.currentValue!=null ? Number(c.currentValue)*(c.quantity||1) : '';
    const pl   = c.sold ? ((Number(c.soldPrice||0)-Number(c.purchasePrice))*(c.quantity||1)).toFixed(2)
               : c.currentValue!=null ? ((Number(c.currentValue)-Number(c.purchasePrice))*(c.quantity||1)).toFixed(2) : '';
    return [c.name,c.set||'',c.type||'',c.grade||'',c.quantity||1,cost.toFixed(2),
      val!==''?Number(val).toFixed(2):'',pl,c.purchaseDate||'',c.targetPrice||'',c.notes||'',
      c.sold?'Sold':'Active',c.sold?(c.soldPrice||''):'',c.sold?(c.soldDate||''):'',c.sold?(c.soldTo||''):'',
    ].map(v => '"' + String(v).replace(/"/g,'""') + '"');
  });
  const csv  = [headers.map(h=>'"'+h+'"').join(','), ...rows.map(r=>r.join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url  = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), {
    href: url, download: 'pokevault-' + new Date().toISOString().split('T')[0] + '.csv',
  }).click();
  URL.revokeObjectURL(url);
  toast('Collection exported.', 'success');
}

// ══════════════════════════════════════════════════════════════════
//  PRICE API  (Supabase-first caching + rolling history window)
// ══════════════════════════════════════════════════════════════════

function sanitiseName(name) { return name.replace(/\s*\(.*$/, '').trim().replace(/['\"🇯🇵]/g,'').trim(); }
function sanitiseSet(set)   { return (set||'').replace(/['\"]|/g,'').trim(); }
function extractVariant(name) { const m = name.match(/\(([^)]+)\)/); return m ? m[1].trim() : null; }
function isJapaneseCard(card) { return card.name.includes('🇯🇵'); }

function scorePokePriceResult(result, card) {
  const cardName = sanitiseName(card.name).toLowerCase();
  const cardSet  = sanitiseSet(card.set).toLowerCase();
  const variant  = extractVariant(card.name);
  const rName    = (result.name       || '').toLowerCase();
  const rSet     = (result.setName    || '').toLowerCase();
  const rNumber  = (result.cardNumber || '').toLowerCase();
  let score = 0;
  if (rName === cardName)            score += 10;
  else if (rName.includes(cardName)) score +=  5;
  if (cardSet) {
    if (rSet === cardSet)                                       score += 6;
    else if (rSet.includes(cardSet)||cardSet.includes(rSet))   score += 3;
    const fw = cardSet.split(' ')[0];
    if (fw.length > 2 && rSet.includes(fw))                   score += 1;
  }
  if (variant) {
    const v = variant.toLowerCase();
    if (rNumber && rNumber === v)            score += 8;
    else if (rNumber && rNumber.includes(v)) score += 4;
    if (rSet.includes(v))                    score += 5;
  }
  return score;
}

function extractPokePrice(result) {
  if (result.prices?.market    != null) return result.prices.market;
  if (result.prices?.lowPrice  != null) return result.prices.lowPrice;
  if (result.prices?.midPrice  != null) return result.prices.midPrice;
  if (result.japanesePrice     != null) return result.japanesePrice;
  if (result.averagePrice      != null) return result.averagePrice;
  if (result.marketPrice       != null) return result.marketPrice;
  if (result.price             != null) return result.price;
  return null;
}

function applyGradeMultiplier(baseUSD, grade) {
  const g = (grade||'raw').toLowerCase();
  if (g==='psa 10'||g==='bgs 10')  return baseUSD * 3.5;
  if (g==='psa 9' ||g==='bgs 9.5') return baseUSD * 1.5;
  if (g==='psa 8' ||g==='bgs 9')   return baseUSD * 1.2;
  if (g==='psa 7')                  return baseUSD * 1.05;
  return baseUSD;
}

async function fetchPrice(card) {
  try {
    const isJP   = isJapaneseCard(card);
    const name   = sanitiseName(card.name);
    const set    = sanitiseSet(card.set);
    const lang   = isJP ? 'japanese' : 'english';

    // Pass the user's allowed history window to the API proxy
    const params = new URLSearchParams({
      action:         'search',
      name,
      language:       lang,
      includeHistory: 'true',
      days:           String(_allowedHistoryDays),
      includeEbay:    'true',
    });
    if (set) params.set('set', set);

    const res = await fetch('/api/pokeprice?' + params.toString());
    if (!res.ok) { console.warn('Price proxy returned', res.status, 'for', card.name); return null; }
    const data    = await res.json();
    const results = data.results || [];
    if (!results.length) return null;
    const scored = results.map(r => ({ ...r, _score: scorePokePriceResult(r, card) })).sort((a,b)=>b._score-a._score);
    for (const match of scored) {
      const baseUSD = extractPokePrice(match);
      if (baseUSD==null||baseUSD<=0) continue;
      return Math.round(applyGradeMultiplier(baseUSD, card.grade) * USD_TO_SGD * 100) / 100;
    }
    return null;
  } catch (e) { console.error('fetchPrice error for '+card.name, e); return null; }
}

async function refreshPrices(silent = false) {
  const active = cards.filter(c => !c.sold);
  if (!active.length) { if (!silent) toast('No cards to refresh.', 'info'); return; }
  const btn = document.querySelector('.btn-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Fetching…'; }
  let updated = 0;
  for (let i = 0; i < active.length; i++) {
    try {
      const price = await fetchPrice(active[i]);
      if (price != null) {
        const now     = Date.now();
        const idx     = cards.findIndex(c => c.id === active[i].id);
        if (idx < 0) continue;
        const history = [...(cards[idx].priceHistory||[])];
        const last    = history[history.length-1];
        if (!last||!isSameDay(last.date,now)) history.push({date:now,value:price});
        else history[history.length-1] = {date:now,value:price};
        cards[idx] = { ...cards[idx], currentValue: price, lastUpdated: now, priceHistory: history };
        await _sb.from('cards')
          .update({ current_value: price, last_updated: now, price_history: history })
          .eq('id', cards[idx].id).eq('user_id', _currentUserId);
        updated++;
      }
    } catch (e) { console.error('Refresh failed for '+active[i].name, e); }
    await new Promise(r => setTimeout(r, 400));
  }

  // Also refresh portfolio item values
  await refreshPortfolioValues(silent);

  localStorage.setItem('lastRefresh', Date.now().toString());
  render();
  renderPortfolio();
  const el = document.getElementById('last-updated');
  if (el) el.textContent = 'Last refreshed: ' + new Date().toLocaleString('en-SG') + ' · USD/SGD: ' + USD_TO_SGD.toFixed(4);
  if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh prices'; }
  if (!silent) {
    if (updated) toast('Updated '+updated+' card'+(updated!==1?'s':'')+'.', 'success');
    else toast('No prices found. Try setting values manually.', 'error');
  }
}

// Refresh current_value on portfolio items using Supabase cache first, then API
async function refreshPortfolioValues(silent = false) {
  const active = portfolioItems.filter(i => !i.sold);
  if (!active.length) return;

  for (const item of active) {
    try {
      const lang = item.language || 'english';

      // 1. Try Supabase cache first
      const cached = await readCachedHistory(item.itemId, item.type, lang);
      let priceSGD = null;

      if (cacheIsFresh(cached)) {
        // Use the most recent cached price
        const latest = cached[cached.length - 1];
        priceSGD = Math.round(Number(latest.price) * USD_TO_SGD * 100) / 100;
      } else {
        // 2. Fallback: hit the API
        const action = item.type === 'sealed' ? 'sealed' : 'card';
        const params = new URLSearchParams({
          action,
          id:             item.itemId,
          language:       lang,
          includeHistory: 'true',
          days:           String(_allowedHistoryDays),
        });
        if (item.type === 'sealed') {
          params.delete('id');
          params.set('name', item.name);
        }
        const res = await fetch('/api/pokeprice?' + params);
        if (res.ok) {
          const d       = await res.json();
          const results = d.results || [];
          if (results.length) {
            const priceUSD = _extractResultPrice(results[0], item.type === 'sealed');
            if (priceUSD != null) priceSGD = Math.round(priceUSD * USD_TO_SGD * 100) / 100;
          }
        }
      }

      if (priceSGD != null) {
        await _sb.from('portfolio_items')
          .update({ current_value: priceSGD, last_value_updated: new Date().toISOString() })
          .eq('id', item.id).eq('user_id', _currentUserId);
        const idx = portfolioItems.findIndex(i => i.id === item.id);
        if (idx > -1) portfolioItems[idx] = { ...portfolioItems[idx], currentValue: priceSGD };
      }
    } catch (e) { console.warn('Portfolio value refresh failed for', item.name, e); }
    await new Promise(r => setTimeout(r, 300));
  }
}

// ══════════════════════════════════════════════════════════════════
//  CARD IMAGES
// ══════════════════════════════════════════════════════════════════

function scoreImageResult(result, card) {
  const cardName = sanitiseName(card.name).toLowerCase();
  const cardSet  = sanitiseSet(card.set).toLowerCase();
  const variant  = extractVariant(card.name);
  const rName    = (result.name       || '').toLowerCase();
  const rSet     = (result.setName    || '').toLowerCase();
  const rNum     = (result.cardNumber || '').toLowerCase();
  let score = 0;
  if (rName === cardName)            score += 10;
  else if (rName.includes(cardName)) score +=  4;
  if (cardSet) {
    if (rSet === cardSet)                                       score += 6;
    else if (rSet.includes(cardSet)||cardSet.includes(rSet))   score += 3;
    const fw = cardSet.split(' ')[0];
    if (fw.length > 2 && rSet.includes(fw))                   score += 1;
  }
  if (variant) {
    const v = variant.toLowerCase();
    if (rNum && rNum === v)            score += 8;
    else if (rNum && rNum.includes(v)) score += 4;
    if (rSet.includes(v))              score += 5;
  }
  return score;
}

async function fetchCardImageResults(card) {
  try {
    const isJP   = isJapaneseCard(card);
    const name   = sanitiseName(card.name);
    const set    = sanitiseSet(card.set);
    const params = new URLSearchParams({ action: 'search', name, language: isJP ? 'japanese' : 'english' });
    if (set) params.set('set', set);
    const res  = await fetch('/api/pokeprice?' + params.toString());
    if (!res.ok) return [];
    const data = await res.json();
    return (data.results||[]).filter(r => r.imageCdnUrl400||r.imageCdnUrl||r.imageCdnUrl200);
  } catch (e) { console.warn('fetchCardImageResults error:', e); return []; }
}

function switchModalTab(tab) {
  document.getElementById('modal-panel-info').style.display  = tab==='info'  ? 'block' : 'none';
  document.getElementById('modal-panel-image').style.display = tab==='image' ? 'block' : 'none';
  document.getElementById('modal-tab-info').classList.toggle('active',  tab==='info');
  document.getElementById('modal-tab-image').classList.toggle('active', tab==='image');
  if (tab === 'image') _renderImageTab();
}

function _renderImageTab() {
  const loadingEl  = document.getElementById('modal-image-loading');
  const foundEl    = document.getElementById('modal-image-found');
  const notFoundEl = document.getElementById('modal-image-notfound');
  const largeImg   = document.getElementById('modal-card-image-large');
  if (_cardImageLoaded && _cardImageUrl) {
    loadingEl.style.display='none'; foundEl.style.display='block'; notFoundEl.style.display='none';
    if (largeImg.src !== _cardImageUrl) largeImg.src = _cardImageUrl;
  } else if (_cardImageLoaded && !_cardImageUrl) {
    loadingEl.style.display='none'; foundEl.style.display='none'; notFoundEl.style.display='flex';
  } else {
    loadingEl.style.display='flex'; foundEl.style.display='none'; notFoundEl.style.display='none';
  }
}

async function openCard(id) {
  const card = cards.find(c => c.id === id);
  if (!card) return;
  editingCardId = id; _cardImageUrl = null; _cardImageLoaded = false;

  // Augment price history with Supabase cache data for chart
  // Only do this if the card has a known tcgPlayerId-style itemId stored
  let enrichedHistory = [...(card.priceHistory || [])];
  // (Price history for vault cards is stored directly in the cards row;
  // the Supabase cache is used for portfolio items. Vault cards already
  // accumulate their own history via refreshPrices.)

  const cost   = Number(card.purchasePrice);
  const val    = card.currentValue != null ? Number(card.currentValue) : null;
  const profit = val != null ? (val - cost) * (card.quantity||1) : null;
  const colors = getTypeColor(card.type);

  const typeBar = document.getElementById('modal-type-bar');
  if (typeBar) typeBar.style.background = colors.border;

  document.getElementById('modal-name').textContent = card.name + (card.quantity > 1 ? ' ×'+card.quantity : '');
  document.getElementById('modal-meta').textContent = (card.set||'Unknown set') + (card.type ? ' · '+card.type : '');

  const gradeEl = document.getElementById('modal-grade');
  gradeEl.textContent = card.grade;
  gradeEl.className   = 'badge ' + (card.grade==='raw' ? 'badge-raw' : 'badge-psa');

  document.getElementById('modal-cost').textContent  = 'SGD $' + (cost*(card.quantity||1)).toFixed(2);
  document.getElementById('modal-value').textContent = val!=null ? 'SGD $'+(val*(card.quantity||1)).toFixed(2) : '—';

  const profitEl = document.getElementById('modal-profit');
  if (profit != null) {
    profitEl.textContent = (profit>=0 ? '↑ +' : '↓ ') + 'SGD $' + Math.abs(profit).toFixed(2);
    profitEl.className   = 'modal-stat-value ' + (profit>=0 ? 'profit-pos' : 'profit-neg');
  } else { profitEl.textContent='—'; profitEl.className='modal-stat-value'; }

  document.getElementById('modal-updated').textContent       = card.lastUpdated ? new Date(card.lastUpdated).toLocaleDateString('en-SG') : '—';
  document.getElementById('modal-purchase-date').textContent = card.purchaseDate || '—';

  const targetEl = document.getElementById('modal-target');
  if (card.targetPrice) {
    const hit = val!=null && val>=card.targetPrice;
    targetEl.textContent = 'SGD $'+Number(card.targetPrice).toFixed(2)+(hit?' ✓ Target reached!':'');
    targetEl.style.color = hit ? 'var(--green)' : '';
  } else { targetEl.textContent='—'; targetEl.style.color=''; }

  const notesWrap = document.getElementById('modal-notes-wrap');
  if (card.notes) { notesWrap.style.display='block'; document.getElementById('modal-notes').textContent=card.notes; }
  else notesWrap.style.display = 'none';

  document.getElementById('modal-image-caption').textContent = card.name + (card.set?' — '+card.set:'');

  if (card.url) {
    _cardImageUrl    = card.url;
    _cardImageLoaded = true;
  }

  switchModalTab('info');
  document.getElementById('modal-overlay').classList.add('active');

  if (!card.url) {
    fetchCardImageResults(card).then(async results => {
      if (!results.length) { _cardImageUrl=null; _cardImageLoaded=true; }
      else {
        const scored      = results.map(r=>({...r,_score:scoreImageResult(r,card)})).sort((a,b)=>b._score-a._score);
        const topScore    = scored[0]._score;
        const runnerScore = scored[1]?._score ?? 0;
        const autoSelect  = topScore>0 && (topScore-runnerScore)>=5;
        let chosen = autoSelect ? scored[0] : (scored.length===1 ? scored[0] : null);
        if (!chosen) {
          _pendingImageResults=scored; _pendingImageCard=card;
          const imagePanel = document.getElementById('modal-panel-image');
          if (imagePanel?.style.display!=='none') _showImagePicker(scored, card);
          return;
        }
        _cardImageUrl    = chosen.imageCdnUrl||chosen.imageCdnUrl400||chosen.imageCdnUrl200||null;
        _cardImageLoaded = true;
        if (_cardImageUrl) {
          const idx = cards.findIndex(c => c.id === id);
          if (idx > -1) {
            cards[idx] = { ...cards[idx], url: _cardImageUrl };
            await _sb.from('cards').update({ url: _cardImageUrl }).eq('id', id).eq('user_id', _currentUserId);
          }
        }
      }
      const imagePanel = document.getElementById('modal-panel-image');
      if (imagePanel?.style.display!=='none') _renderImageTab();
    });
  }

  _renderPriceChart(card, colors);
}

async function _showImagePicker(results, card) {
  const withImages = results.filter(r => r.imageCdnUrl400||r.imageCdnUrl||r.imageCdnUrl200);
  if (!withImages.length) { _cardImageUrl=null; _cardImageLoaded=true; _renderImageTab(); return; }
  const chosen     = await openCardPicker(withImages, card);
  _cardImageUrl    = chosen ? (chosen.imageCdnUrl||chosen.imageCdnUrl400||chosen.imageCdnUrl200||null) : null;
  _cardImageLoaded = true;
  if (_cardImageUrl && card.id) {
    const idx = cards.findIndex(c => c.id === card.id);
    if (idx > -1) {
      cards[idx] = { ...cards[idx], url: _cardImageUrl };
      await _sb.from('cards').update({ url: _cardImageUrl }).eq('id', card.id).eq('user_id', _currentUserId);
    }
  }
  _renderImageTab();
}

function switchModalTabWithPicker(tab) {
  switchModalTab(tab);
  if (tab==='image' && !_cardImageLoaded && _pendingImageResults.length)
    _showImagePicker(_pendingImageResults, _pendingImageCard);
}

function openCardPicker(results, card) {
  return new Promise(resolve => {
    _pickerResults=results; _pickerCallback=resolve;
    document.getElementById('picker-title').textContent = 'Select the correct "'+sanitiseName(card.name)+'" card';
    const grid = document.getElementById('picker-grid');
    grid.innerHTML = '';
    results.forEach((r, i) => {
      const thumb = r.imageCdnUrl200||r.imageCdnUrl400||r.imageCdnUrl||'';
      const item  = document.createElement('div');
      item.className = 'picker-item';
      item.innerHTML =
        '<div class="picker-img-wrap">' +
          (thumb?`<img src="${esc(thumb)}" alt="${esc(r.name)}" loading="lazy" />`:'<div class="picker-no-img">No image</div>') +
        '</div>' +
        `<div class="picker-info">` +
          `<div class="picker-name">${esc(r.name)}</div>` +
          `<div class="picker-set">${esc(r.setName||'—')}</div>` +
          `<div class="picker-num">#${esc(r.cardNumber||'?')}</div>` +
        `</div>`;
      item.addEventListener('click', () => pickCard(i));
      grid.appendChild(item);
    });
    document.getElementById('picker-overlay').classList.add('active');
  });
}

function pickCard(index) {
  document.getElementById('picker-overlay').classList.remove('active');
  if (_pickerCallback) { _pickerCallback(_pickerResults[index]||null); _pickerCallback=null; }
}

function closePickerModal() {
  document.getElementById('picker-overlay').classList.remove('active');
  if (_pickerCallback) { _pickerCallback(null); _pickerCallback=null; }
}

function _renderPriceChart(card, colors) {
  const history        = card.priceHistory || [];
  const emptyEl        = document.getElementById('modal-chart-empty');
  const chartContainer = document.querySelector('.modal-chart-container');
  if (history.length < 2) {
    emptyEl.style.display='block'; chartContainer.style.display='none'; return;
  }
  emptyEl.style.display='none'; chartContainer.style.display='block';
  const labels = history.map(p => new Date(p.date).toLocaleDateString('en-SG'));
  const values = history.map(p => p.value);
  if (priceChart) { priceChart.destroy(); priceChart=null; }
  const ctx = document.getElementById('price-chart').getContext('2d');
  priceChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{
      label: 'Value (SGD)', data: values, borderColor: colors.chart,
      backgroundColor: colors.bg, borderWidth: 2, pointRadius: 4,
      pointBackgroundColor: colors.chart, pointBorderColor: 'var(--bg2)',
      pointBorderWidth: 2, tension: 0.4, fill: true,
    }]},
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor:'var(--bg3)', borderColor:'var(--border2)', borderWidth:1,
          titleColor:'var(--text2)', bodyColor:'var(--text)',
          callbacks: { label: ctx => 'SGD $'+Number(ctx.raw).toFixed(2) },
        },
      },
      scales: {
        y: { ticks:{callback:v=>'$'+v,font:{size:11,family:'DM Mono'},color:'var(--text3)'}, grid:{color:'var(--border)'}, border:{display:false} },
        x: { ticks:{font:{size:11,family:'DM Mono'},color:'var(--text3)'}, grid:{display:false}, border:{display:false} },
      },
    },
  });
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  _destroyModal();
}

function _destroyModal() {
  document.getElementById('modal-overlay').classList.remove('active');
  if (priceChart) { priceChart.destroy(); priceChart=null; }
  _cardImageUrl=null; _cardImageLoaded=false;
  _pendingImageResults=[]; _pendingImageCard=null;
}

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  ['modal-overlay','confirm-overlay','edit-overlay','sell-overlay','manual-price-overlay',
   'picker-overlay','add-overlay','upgrade-overlay','portfolio-add-overlay']
    .forEach(id => document.getElementById(id)?.classList.remove('active'));
  if (priceChart) { priceChart.destroy(); priceChart=null; }
});

// ══════════════════════════════════════════════════════════════════
//  SUMMARY & RENDER
// ══════════════════════════════════════════════════════════════════

function renderMovers() {
  const priced  = cards.filter(c => !c.sold && c.currentValue!=null);
  const section = document.getElementById('movers-section');
  if (!section) return;
  if (priced.length < 2) { section.style.display='none'; return; }
  section.style.display = 'block';
  const sorted = [...priced].sort((a,b) => {
    const ap = (Number(a.currentValue)-Number(a.purchasePrice))/Number(a.purchasePrice);
    const bp = (Number(b.currentValue)-Number(b.purchasePrice))/Number(b.purchasePrice);
    return bp - ap;
  });
  const moverCard = c => {
    const profit = Number(c.currentValue)-Number(c.purchasePrice);
    const pct    = (profit/Number(c.purchasePrice))*100;
    const pos    = profit >= 0;
    const colors = getTypeColor(c.type);
    return `<div class="mover-card" style="border-left:3px solid ${colors.border};" onclick="openCard('${c.id}')">` +
      `<div style="overflow:hidden;"><div class="mover-name">${esc(c.name)}</div><div class="mover-set">${esc(c.set||'—')}</div></div>` +
      `<div class="mover-value ${pos?'profit-pos':'profit-neg'}">${pos?'↑':'↓'} ${Math.abs(pct).toFixed(1)}%` +
        `<span class="mover-sgd">${pos?'+':'-'}SGD $${Math.abs(profit).toFixed(2)}</span></div></div>`;
  };
  document.getElementById('movers-gainers').innerHTML = sorted.slice(0,3).map(moverCard).join('');
  document.getElementById('movers-losers').innerHTML  = sorted.slice(-3).reverse().map(moverCard).join('');
}

function checkTargetAlerts() {
  cards.filter(c => !c.sold && c.targetPrice && c.currentValue!=null &&
    Number(c.currentValue)>=Number(c.targetPrice) && !_alertedTargets.has(c.id))
  .forEach(c => {
    _alertedTargets.add(c.id);
    toast('🎯 '+c.name+' hit your target of SGD $'+Number(c.targetPrice).toFixed(2)+'!', 'success');
  });
}

function updateSummary() {
  const active   = cards.filter(c => !c.sold);
  const sold     = cards.filter(c =>  c.sold);
  const count    = active.reduce((s,c) => s+(c.quantity||1), 0);
  const cost     = active.reduce((s,c) => s+Number(c.purchasePrice)*(c.quantity||1), 0);
  const value    = active.reduce((s,c) => s+(c.currentValue!=null?Number(c.currentValue):Number(c.purchasePrice))*(c.quantity||1), 0);
  const profit   = value - cost;
  const realised = sold.reduce((s,c) => s+(c.soldPrice?(Number(c.soldPrice)-Number(c.purchasePrice))*(c.quantity||1):0), 0);

  document.getElementById('s-count').textContent = count;
  animateValue(document.getElementById('s-cost'),  cost,  'SGD ');
  animateValue(document.getElementById('s-value'), value, 'SGD ');
  animateValue(document.getElementById('header-value'), value, 'SGD ');

  const pel = document.getElementById('s-profit');
  pel.textContent = (profit>=0?'↑ +SGD $':'↓ -SGD $') + Math.abs(profit).toFixed(2);
  pel.className   = 'metric-value ' + (profit>=0?'pos':'neg');

  const rel = document.getElementById('s-realised');
  rel.textContent = (realised>=0?'+SGD $':'-SGD $') + Math.abs(realised).toFixed(2);
  rel.className   = 'metric-value ' + (realised>=0?'pos':'neg');

  const profitCard = document.querySelector('.profit-card');
  const profitIcon = document.getElementById('profit-icon');
  profitCard?.classList.toggle('pos', profit>=0);
  profitCard?.classList.toggle('neg', profit<0);
  if (profitIcon) profitIcon.textContent = profit>=0 ? '💰' : '📉';
}

function render() {
  populateSetFilter();
  const tbody     = document.getElementById('card-table');
  const cardList  = document.getElementById('card-list');
  const filtered  = getFilteredCards();
  const sorted    = getSortedCards(filtered);
  const soldCards = cards.filter(c => c.sold);

  if (!cards.filter(c => !c.sold).length) {
    tbody.innerHTML    = '<tr><td colspan="11"><div class="empty-state">Your vault is empty — add your first card to get started</div></td></tr>';
    cardList.innerHTML = '<div class="empty-state">Your vault is empty — add your first card to get started</div>';
  } else if (!sorted.length) {
    tbody.innerHTML    = '<tr><td colspan="11"><div class="empty-state">No cards match your filters</div></td></tr>';
    cardList.innerHTML = '<div class="empty-state">No cards match your filters</div>';
  } else {
    tbody.innerHTML = sorted.map(c => {
      const cost        = Number(c.purchasePrice)*(c.quantity||1);
      const val         = c.currentValue!=null ? Number(c.currentValue)*(c.quantity||1) : null;
      const profit      = val!=null ? val-cost : null;
      const profitStr   = profit!=null ? (profit>=0?'↑ +':'↓ ')+'SGD $'+Math.abs(profit).toFixed(2) : '—';
      const profitClass = profit==null?'':(profit>=0?'profit-pos':'profit-neg');
      const gradeClass  = c.grade==='raw'?'badge-raw':'badge-psa';
      const updated     = c.lastUpdated ? new Date(c.lastUpdated).toLocaleDateString('en-SG') : '—';
      const colors      = getTypeColor(c.type);
      const typeBadge   = c.type
        ? `<span class="type-badge" style="background:${colors.bg};color:${colors.border};border:1px solid ${colors.border};">${esc(c.type)}</span>`
        : '<span class="type-badge type-unknown">—</span>';
      const targetHit = c.targetPrice && c.currentValue!=null && Number(c.currentValue)>=Number(c.targetPrice);
      const rowStyle  = `border-left:3px solid ${colors.border}${targetHit?';box-shadow:inset 0 0 0 1px rgba(76,175,125,0.2);':''}`;
      return `<tr class="card-row${targetHit?' target-hit':''}" onclick="openCard('${c.id}')" style="${rowStyle}">` +
        `<td title="${esc(c.name)}" style="font-weight:600;">${esc(c.name)}${targetHit?' <span style="color:var(--green);font-size:11px;">🎯</span>':''}</td>` +
        `<td title="${esc(c.set||'—')}" style="color:var(--text2);">${esc(c.set||'—')}</td>` +
        `<td>${typeBadge}</td>` +
        `<td><span class="badge ${gradeClass}">${esc(c.grade)}</span></td>` +
        `<td style="font-family:var(--font-mono);color:var(--text2);">×${c.quantity||1}</td>` +
        `<td style="font-family:var(--font-mono);">$${cost.toFixed(2)}</td>` +
        `<td style="font-family:var(--font-mono);">${val!=null?'$'+val.toFixed(2):'<span style="color:var(--text3);">—</span>'}</td>` +
        `<td class="${profitClass}" style="font-family:var(--font-mono);font-weight:600;">${profitStr}</td>` +
        `<td style="color:var(--text3);font-family:var(--font-mono);font-size:12px;">${updated}</td>` +
        `<td><button class="btn-row-edit" onclick="event.stopPropagation();openEditForm('${c.id}')" title="Edit">✎</button></td>` +
        `<td><button class="del-btn" onclick="event.stopPropagation();deleteCard('${c.id}')" title="Delete">✕</button></td>` +
        '</tr>';
    }).join('');

    cardList.innerHTML = sorted.map(c => {
      const cost        = Number(c.purchasePrice)*(c.quantity||1);
      const val         = c.currentValue!=null ? Number(c.currentValue)*(c.quantity||1) : null;
      const profit      = val!=null ? val-cost : null;
      const profitStr   = profit!=null ? (profit>=0?'↑ +':'↓ -')+'SGD $'+Math.abs(profit).toFixed(2) : '—';
      const profitClass = profit==null?'':(profit>=0?'profit-pos':'profit-neg');
      const gradeClass  = c.grade==='raw'?'badge-raw':'badge-psa';
      const colors      = getTypeColor(c.type);
      const targetHit   = c.targetPrice && c.currentValue!=null && Number(c.currentValue)>=Number(c.targetPrice);
      return `<div class="mobile-card${targetHit?' target-hit':''}" style="border-left:3px solid ${colors.border};" onclick="openCard('${c.id}')">` +
        '<div class="mobile-card-top">' +
          `<div><div class="mobile-card-name">${esc(c.name)}${targetHit?' 🎯':''}</div>` +
          `<div class="mobile-card-set">${esc(c.set||'—')} · <span class="badge ${gradeClass}">${esc(c.grade)}</span>${c.quantity>1?' ×'+c.quantity:''}</div></div>` +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            `<button class="mobile-card-delete" onclick="event.stopPropagation();openEditForm('${c.id}')" title="Edit" style="font-size:14px;">✎</button>` +
            `<button class="mobile-card-delete" onclick="event.stopPropagation();deleteCard('${c.id}')" title="Delete">✕</button>` +
          '</div>' +
        '</div>' +
        '<div class="mobile-card-bottom">' +
          `<div class="mobile-card-price">Paid: SGD $${cost.toFixed(2)}<br>Value: ${fmt(val)}</div>` +
          `<div class="mobile-card-profit ${profitClass}">${profitStr}</div>` +
        '</div></div>';
    }).join('');
  }

  const soldTbody = document.getElementById('sold-table');
  const soldList  = document.getElementById('sold-list');
  if (!soldCards.length) {
    soldTbody.innerHTML = '<tr><td colspan="9"><div class="empty-state">No sold cards yet</div></td></tr>';
    soldList.innerHTML  = '<div class="empty-state">No sold cards yet</div>';
  } else {
    soldTbody.innerHTML = soldCards.map(c => {
      const profit      = c.soldPrice ? (Number(c.soldPrice)-Number(c.purchasePrice))*(c.quantity||1) : null;
      const profitStr   = profit!=null ? (profit>=0?'↑ +':'↓ ')+'SGD $'+Math.abs(profit).toFixed(2) : '—';
      const profitClass = profit==null?'':(profit>=0?'profit-pos':'profit-neg');
      return '<tr>' +
        `<td style="font-weight:600;">${esc(c.name)}</td>` +
        `<td style="color:var(--text2);">${esc(c.set||'—')}</td>` +
        `<td><span class="badge ${c.grade==='raw'?'badge-raw':'badge-psa'}">${esc(c.grade)}</span></td>` +
        `<td style="font-family:var(--font-mono);">$${(Number(c.purchasePrice)*(c.quantity||1)).toFixed(2)}</td>` +
        `<td style="font-family:var(--font-mono);">${c.soldPrice?'$'+Number(c.soldPrice).toFixed(2):'—'}</td>` +
        `<td class="${profitClass}" style="font-family:var(--font-mono);font-weight:600;">${profitStr}</td>` +
        `<td style="color:var(--text3);font-family:var(--font-mono);font-size:12px;">${c.soldDate||'—'}</td>` +
        `<td style="color:var(--text2);font-size:12px;">${esc(c.soldTo||'—')}</td>` +
        `<td><button class="del-btn" onclick="deleteCard('${c.id}')" title="Delete">✕</button></td>` +
        '</tr>';
    }).join('');
    soldList.innerHTML = soldCards.map(c => {
      const profit      = c.soldPrice ? (Number(c.soldPrice)-Number(c.purchasePrice))*(c.quantity||1) : null;
      const profitStr   = profit!=null ? (profit>=0?'+':'')+'SGD $'+(profit||0).toFixed(2) : '—';
      const profitClass = profit==null?'':(profit>=0?'profit-pos':'profit-neg');
      return '<div class="mobile-card">' +
        '<div class="mobile-card-top">' +
          `<div><div class="mobile-card-name">${esc(c.name)}</div>` +
          `<div class="mobile-card-set">${esc(c.set||'—')} · sold ${c.soldDate||'—'}</div></div>` +
        '</div>' +
        '<div class="mobile-card-bottom">' +
          `<div class="mobile-card-price">Paid: SGD $${Number(c.purchasePrice).toFixed(2)}<br>Sold: ${c.soldPrice?'SGD $'+Number(c.soldPrice).toFixed(2):'—'}</div>` +
          `<div class="mobile-card-profit ${profitClass}">${profitStr}</div>` +
        '</div></div>';
    }).join('');
  }

  updateSummary();
  renderMovers();
  checkTargetAlerts();
}

// ── Bootstrap ──────────────────────────────────────────────────────
init();
