/* ═══════════════════════════════════════════════════════════════
   PokéPrice Search — app.js
   Talks to /api/search (Vercel serverless proxy)
   ═══════════════════════════════════════════════════════════════ */
'use strict';

// ── State ──────────────────────────────────────────────────────
let _results      = [];       // current result set
let _language     = 'english';
let _view         = 'grid';   // 'grid' | 'list'
let _modalCard    = null;     // card currently shown in modal
let _modalLang    = 'english';
let _debounce     = null;

// ── DOM refs ───────────────────────────────────────────────────
const $  = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Helpers ────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtPrice(val, currency = 'USD') {
  if (val == null || val === '' || isNaN(Number(val))) return null;
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(Number(val));
}

/** Extract the most relevant market price from a card result object */
function extractPrice(card) {
  // PokémonPriceTracker v2 may return prices in various shapes
  const p = card.marketPrice ?? card.market_price ?? card.tcgPlayerMarketPrice
         ?? card.price       ?? card.Price;
  if (p != null && !isNaN(Number(p))) return Number(p);

  // Try nested structures
  const mkt = card.prices?.normal?.market
           ?? card.prices?.holofoil?.market
           ?? card.prices?.reverseHolofoil?.market
           ?? card.prices?.firstEditionHolofoil?.market
           ?? card.prices?.unlimited?.market;
  if (mkt != null && !isNaN(Number(mkt))) return Number(mkt);

  return null;
}

/** Extract low / mid / high from card */
function extractPriceTiers(card) {
  const tiers = {};
  const variants = [
    'normal', 'holofoil', 'reverseHolofoil',
    'firstEditionHolofoil', 'firstEditionNormal', 'unlimited'
  ];

  if (card.prices) {
    for (const v of variants) {
      if (card.prices[v]) {
        tiers[v] = card.prices[v];
      }
    }
  }

  // Also handle flat fields
  const flat = {};
  if (card.marketPrice     != null) flat.market = Number(card.marketPrice);
  if (card.lowPrice        != null) flat.low    = Number(card.lowPrice);
  if (card.midPrice        != null) flat.mid    = Number(card.midPrice);
  if (card.highPrice       != null) flat.high   = Number(card.highPrice);
  if (card.directLowPrice  != null) flat.directLow = Number(card.directLowPrice);
  if (Object.keys(flat).length) tiers['Market Data'] = flat;

  return tiers;
}

function getThumb(card) {
  return card.imageCdnUrl200 || card.imageCdnUrl400 || card.imageCdnUrl
      || card.image          || card.imageUrl        || card.imageSmall
      || '';
}

function getLargeImg(card) {
  return card.imageCdnUrl400 || card.imageCdnUrl || card.imageLarge
      || card.imageCdnUrl200 || card.image       || '';
}

function getRarity(card) {
  return card.rarity || card.Rarity || '';
}

function getNumber(card) {
  const num   = card.cardNumber   ?? card.number   ?? '';
  const total = card.totalSetNumber ?? card.printedTotal ?? card.setTotal ?? '';
  if (!num) return '';
  return total ? `${num}/${total}` : `${num}`;
}

function getSetName(card) {
  return card.setName || card.set?.name || card.set || '';
}

// ── Search ─────────────────────────────────────────────────────
function getSearchValue() {
  return ($('search-input')?.value ?? '').trim();
}

function getSetValue() {
  return ($('set-input')?.value ?? '').trim();
}

/** Build query params to send to our /api/search proxy */
function buildParams(query, lang, setHint) {
  const p = new URLSearchParams();

  if (query) p.set('search', query);
  p.set('language', lang);
  if (setHint) p.set('set', setHint);

  return p;
}

async function doSearch(query, lang, setHint) {
  if (!query) return;

  showLoading();

  try {
    const params = buildParams(query, lang, setHint);
    const res = await fetch(`/api/search?${params}`);
    const data = await res.json();

    if (!res.ok) {
      showError(data.error || 'Search failed. Check your API key.');
      return;
    }

    _results = data.cards || [];
    renderResults(_results);
  } catch (err) {
    console.error('Search error:', err);
    showError('Network error — could not reach the API.');
  }
}

function handleSearch() {
  const raw     = getSearchValue();
  const setHint = getSetValue();

  if (!raw) {
    showWelcome();
    return;
  }

  doSearch(raw, _language, setHint);
}

// ── Render ─────────────────────────────────────────────────────
function renderResults(cards) {
  hideAll();

  const grid = $('results-grid');
  const bar  = $('status-bar');

  if (!cards.length) {
    showEmpty();
    return;
  }

  bar.classList.remove('hidden');
  $('result-count').innerHTML =
    `Found <strong>${cards.length}</strong> card${cards.length !== 1 ? 's' : ''}`;

  grid.innerHTML = cards.map((card, i) => renderCardEl(card, i)).join('');
  grid.classList.remove('hidden');

  // Attach click handlers
  grid.querySelectorAll('.card').forEach((el, i) => {
    el.addEventListener('click', () => openModal(cards[i]));
  });
}

function renderCardEl(card, i) {
  const thumb    = getThumb(card);
  const name     = esc(card.name || 'Unknown');
  const set      = esc(getSetName(card));
  const num      = esc(getNumber(card));
  const rarity   = esc(getRarity(card));
  const price    = extractPrice(card);
  const priceTxt = price != null ? (fmtPrice(price) ?? '—') : '—';

  const imgEl = thumb
    ? `<img src="${esc(thumb)}" alt="${name}" loading="lazy" />`
    : `<div class="card-img-placeholder">🃏</div>`;

  const rarityBadge = rarity
    ? `<span class="rarity-badge">${rarity}</span>` : '';

  const numberBadge = num
    ? `<span class="number-badge">#${num}</span>` : '';

  // List view has a different inner layout
  const thumbSmall = thumb
    ? `<img src="${esc(thumb)}" alt="${name}" loading="lazy" />`
    : `<span style="font-size:20px;">🃏</span>`;

  return `
  <div class="card" data-index="${i}" tabindex="0" role="button" aria-label="${name}">
    <!-- Grid view image -->
    <div class="card-img-wrap">
      ${imgEl}
      ${rarityBadge}
      ${numberBadge}
    </div>
    <!-- List view inner (hidden in grid, shown in list) -->
    <div class="card-inner" style="display:none;">
      <div class="card-thumb">${thumbSmall}</div>
      <div class="card-body">
        <div class="card-info">
          <div class="card-name">${name}</div>
          <div class="card-meta">${set}${num ? ' · #' + num : ''}${rarity ? ' · ' + rarity : ''}</div>
        </div>
        <div class="card-prices">
          <div class="price-row">
            <span class="price-label">Market</span>
            <span class="price-value ${price == null ? 'na' : ''}">${priceTxt}</span>
          </div>
        </div>
      </div>
    </div>
    <!-- Grid body -->
    <div class="card-body grid-body">
      <div class="card-name">${name}</div>
      <div class="card-meta">${set}${num ? ' · #' + num : ''}</div>
      <div class="card-prices">
        <div class="price-row">
          <span class="price-label">Market</span>
          <span class="price-value ${price == null ? 'na' : ''}">${priceTxt}</span>
        </div>
      </div>
    </div>
  </div>`;
}

function setView(v) {
  _view = v;
  const grid = $('results-grid');

  $$('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === v));

  if (v === 'list') {
    grid.classList.add('list-view');
    // Show list-inner, hide grid-body
    $$('.card-inner').forEach(el => el.style.display = 'grid');
    $$('.card-img-wrap').forEach(el => el.style.display = 'none');
    $$('.grid-body').forEach(el => el.style.display = 'none');
  } else {
    grid.classList.remove('list-view');
    $$('.card-inner').forEach(el => el.style.display = 'none');
    $$('.card-img-wrap').forEach(el => el.style.display = 'flex');
    $$('.grid-body').forEach(el => el.style.display = 'block');
  }
}

// ── Modal ───────────────────────────────────────────────────────
function openModal(card) {
  _modalCard = card;
  _modalLang = _language;
  renderModal(card, _modalLang);
  $('modal-overlay').classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModal() {
  $('modal-overlay').classList.remove('active');
  document.body.style.overflow = '';
  _modalCard = null;
}

function switchModalLang(lang) {
  _modalLang = lang;
  $$('.modal-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
  // Re-render the pricing section only
  renderModalPricing(_modalCard, lang);
}

function renderModal(card, lang) {
  const name   = esc(card.name || 'Unknown');
  const set    = esc(getSetName(card));
  const num    = getNumber(card);
  const rarity = getRarity(card);
  const artist = card.artist || card.Artist || '';
  const hp     = card.hp || card.HP || '';
  const type   = (card.types || card.type || card.pokemonType || []).toString();
  const largeImg = getLargeImg(card);

  const imgEl = largeImg
    ? `<img src="${esc(largeImg)}" alt="${name}" />`
    : `<div class="modal-img-placeholder">🃏</div>`;

  const tags = [
    rarity && `<span class="modal-tag accent">${esc(rarity)}</span>`,
    num    && `<span class="modal-tag">#${esc(num)}</span>`,
    hp     && `<span class="modal-tag">${esc(hp)} HP</span>`,
    type   && `<span class="modal-tag">${esc(type)}</span>`,
  ].filter(Boolean).join('');

  $('modal-content').innerHTML = `
    <div class="modal-close">
      <button class="modal-close-btn" onclick="closeModal()" aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <div class="modal-img-wrap">
        ${imgEl}
        ${artist ? `<div style="font-family:var(--font-mono);font-size:10px;color:var(--text3);text-align:center;">Illus. ${esc(artist)}</div>` : ''}
      </div>
      <div class="modal-info">
        <div class="modal-card-name">${name}</div>
        <div class="modal-card-set">${set}</div>
        <div class="modal-tags">${tags}</div>

        <div class="modal-section-title">Pricing</div>
        <div class="modal-lang-tabs">
          <button class="modal-tab-btn ${lang === 'english'  ? 'active' : ''}" data-lang="english"  onclick="switchModalLang('english')">🇺🇸 English</button>
          <button class="modal-tab-btn ${lang === 'japanese' ? 'active' : ''}" data-lang="japanese" onclick="switchModalLang('japanese')">🇯🇵 Japanese</button>
        </div>
        <div id="modal-pricing-wrap"></div>
      </div>
    </div>`;

  renderModalPricing(card, lang);
}

function renderModalPricing(card, lang) {
  const wrap  = $('modal-pricing-wrap');
  if (!wrap) return;

  // If language differs from what was fetched, we'd ideally refetch.
  // Since the card object already carries both price fields when available,
  // we render from the object and show a note for Japanese.
  const isJP  = lang === 'japanese';
  const tiers = extractPriceTiers(card);
  const keys  = Object.keys(tiers);

  if (!keys.length) {
    const flatPrice = extractPrice(card);
    if (flatPrice == null) {
      wrap.innerHTML = `<p style="font-family:var(--font-mono);font-size:12px;color:var(--text3);padding:12px 0;">No pricing data available.</p>`;
      return;
    }
    wrap.innerHTML = buildSimplePriceTable(flatPrice, isJP);
    return;
  }

  wrap.innerHTML = keys.map(variant => buildVariantTable(variant, tiers[variant], isJP)).join('');
}

function buildSimplePriceTable(price, isJP) {
  return `
  <div class="price-table-wrap" style="margin-bottom:12px;">
    <table class="price-table">
      <thead>
        <tr>
          <th>Variant</th>
          <th>Market Price</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td class="label-cell">Market${isJP ? ' (JP)' : ''}</td>
          <td class="price-cell">${fmtPrice(price) ?? '—'}</td>
        </tr>
      </tbody>
    </table>
  </div>`;
}

function buildVariantTable(variantName, prices, isJP) {
  const label = variantName
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, s => s.toUpperCase())
    .trim();

  const rows = Object.entries(prices)
    .filter(([, v]) => v != null && !isNaN(Number(v)))
    .map(([k, v]) => {
      const kLabel = k.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();
      const formatted = fmtPrice(Number(v));
      return `
        <tr>
          <td class="label-cell">${esc(kLabel)}${isJP ? ' (JP)' : ''}</td>
          <td class="price-cell">${formatted ?? '—'}</td>
        </tr>`;
    });

  if (!rows.length) return '';

  return `
  <div style="margin-bottom:12px;">
    <div style="font-family:var(--font-mono);font-size:10px;color:var(--text3);letter-spacing:.08em;text-transform:uppercase;margin-bottom:6px;">${esc(label)}</div>
    <div class="price-table-wrap">
      <table class="price-table">
        <thead>
          <tr>
            <th>Price Type</th>
            <th>Amount</th>
          </tr>
        </thead>
        <tbody>${rows.join('')}</tbody>
      </table>
    </div>
  </div>`;
}

// ── UI State helpers ────────────────────────────────────────────
function hideAll() {
  $('loading').classList.remove('visible');
  $('empty-state').classList.remove('visible');
  $('error-state').classList.remove('visible');
  $('welcome-state').classList.add('hidden');
  $('results-grid').classList.add('hidden');
  $('status-bar').classList.add('hidden');
}

function showLoading() {
  hideAll();
  $('loading').classList.add('visible');
}

function showEmpty() {
  hideAll();
  $('empty-state').classList.add('visible');
}

function showError(msg) {
  hideAll();
  $('error-msg').textContent = msg;
  $('error-state').classList.add('visible');
}

function showWelcome() {
  hideAll();
  $('welcome-state').classList.remove('hidden');
}

// ── Language toggle ─────────────────────────────────────────────
function setLanguage(lang) {
  _language = lang;
  $$('.lang-btn').forEach(b => b.classList.toggle('active', b.dataset.lang === lang));
  // Re-run search if there are results
  if (_results.length || getSearchValue()) handleSearch();
}

// ── Quick examples ──────────────────────────────────────────────
function useExample(query, lang) {
  $('search-input').value = query;
  if (lang) setLanguage(lang);
  handleSearch();
}

// ── Keyboard & auto-search ──────────────────────────────────────
function onInputKeydown(e) {
  if (e.key === 'Enter') handleSearch();
}

function onInputChange() {
  clearTimeout(_debounce);
  const v = getSearchValue();
  if (!v) { showWelcome(); return; }
  // Auto-search after 600ms idle
  _debounce = setTimeout(handleSearch, 600);
}

// ── Modal keyboard ──────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeModal();
});

$('modal-overlay')?.addEventListener('click', e => {
  if (e.target === $('modal-overlay')) closeModal();
});

// ── Init ────────────────────────────────────────────────────────
(function init() {
  showWelcome();

  // Wire up search input
  $('search-input').addEventListener('keydown', onInputKeydown);
  $('search-input').addEventListener('input', onInputChange);

  // Wire up set input (Enter triggers search)
  $('set-input').addEventListener('keydown', e => { if (e.key === 'Enter') handleSearch(); });

  // Wire lang toggle
  $$('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
  });

  // Wire view toggle
  $$('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // Wire search button
  $('search-btn').addEventListener('click', handleSearch);

  // Hint chips in search panel
  $$('.hint-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $('search-input').value = chip.dataset.query;
      if (chip.dataset.lang) setLanguage(chip.dataset.lang);
      handleSearch();
    });
  });

  // Example chips on welcome
  $$('.example-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      $('search-input').value = chip.dataset.query;
      if (chip.dataset.lang) setLanguage(chip.dataset.lang);
      handleSearch();
    });
  });

  // Focus search on load
  $('search-input').focus();
})();
