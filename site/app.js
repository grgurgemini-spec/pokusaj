/* Precon Price Tracker — vanilla JS single-page app.
   Reads static JSON produced by fetch_prices.py / scrape_cardmarket.py. */

"use strict";

const state = {
  cards: null,      // data/cards.json
  history: null,    // data/history.json
  listings: null,   // data/listings.json (optional)
  catalog: null,    // catalog.json - all known precons grouped by set
  index: null,      // data/cardindex.json — per-name polja, lijeno (samo #/cards, #/stats)
  sort: {},         // per-deck sort state: {key, dir}
  filter: {},       // per-deck text filter
  cardsUI: null,    // {q, key, dir, limit} za #/cards
  statsUI: null,    // {pick, assign} za #/stats
  priceMode: localStorage.getItem("priceMode") === "eur_low" ? "eur_low" : "eur",
};

/* ---------------- From / Average price toggle ---------------- */

function priceKey() { return state.priceMode; }
function priceLabel() { return state.priceMode === "eur_low" ? "From" : "Average"; }
function setPriceMode(mode) {
  state.priceMode = mode;
  localStorage.setItem("priceMode", mode);
  document.querySelectorAll("#price-toggle button").forEach(b =>
    b.classList.toggle("on", b.dataset.mode === mode));
  render();
}
function wirePriceToggle() {
  // Dva proizvođača pune `data/`: lokalni export.py (ima eur_low) i GitHub workflow
  // fetch_prices.py (nema ga). Bez ove provjere "From" na deployanoj stranici isprazni
  // SVAKU cijenu i svaki zbroj padne na 0 € — kontrola koja tiho laže.
  const hasLow = state.cards.decks.some(d =>
    d.cards.some(c => c.prices.cardmarket.eur_low != null));
  const box = document.getElementById("price-toggle");
  if (!hasLow) {
    if (box) box.hidden = true;
    state.priceMode = "eur";
    return;
  }
  if (box) box.hidden = false;
  document.querySelectorAll("#price-toggle button").forEach(b => {
    b.classList.toggle("on", b.dataset.mode === state.priceMode);
    b.addEventListener("click", () => setPriceMode(b.dataset.mode));
  });
}

const $app = document.getElementById("app");
const $nav = document.getElementById("nav");
const $updated = document.getElementById("updated");

/* ---------------- data loading ---------------- */

async function loadJSON(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

async function boot() {
  try {
    state.cards = await loadJSON("../data/cards.json");
  } catch (e) {
    renderSetup(e);
    return;
  }
  try { state.history = await loadJSON("../data/history.json"); } catch { state.history = {}; }
  try { state.listings = await loadJSON("../data/listings.json"); } catch { state.listings = null; }
  try { state.catalog = await loadJSON("catalog.json"); } catch { state.catalog = null; }
  if (!state.catalog) {
    // No catalog file: fall back to one pseudo-set holding whatever has data.
    state.catalog = { sets: [{ code: "", icon: null, name: "Praćeni deckovi", decks: state.cards.decks }] };
  }

  const when = state.cards.generated_at ? new Date(state.cards.generated_at) : null;
  // Terminal čita vrijeme, ne rečenicu: lokalni ISO-ish stamp bez sekundi.
  // Starost snimka je dio podatka, ne fusnota: preko 2 dana se stamp oboji i sam kaže koliko je star.
  if (when) {
    const days = Math.floor((Date.now() - when) / 864e5);
    const stamp = when.toLocaleString("hr-HR",
      { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).replace(",", " ·");
    $updated.textContent = days > 2 ? `${stamp} · ${days}d star` : stamp;
    $updated.classList.toggle("stale-stamp", days > 2);
    $updated.title = `Zadnji snimak cijena: ${when.toLocaleString("hr-HR")}`;
  }
  $nav.innerHTML = `<a href="#/" data-home="1">Katalog</a>`
    + `<a href="#/cards" data-route="cards">Sve karte</a>`
    + `<a href="#/stats" data-route="stats">Statistika</a>`
    + state.catalog.sets
    .map(s => `<a href="#/set/${s.code}" data-set="${s.code}"
      class="${setTracked(s) ? "" : "dim"}">${esc(shortSetName(s))}</a>`)
    .join("");

  wireUpdateButton();
  wirePriceToggle();
  measureTopbar();                       // tek kad je traka puna — prazna je 11px niža
  addEventListener("resize", measureTopbar);
  window.addEventListener("hashchange", render);
  render();
}

/* ---------------- helpers ---------------- */

/** Sticky thead se lijepi ispod sticky trake, ne ispod ruba prozora — a traka mijenja
    visinu s brojem redaka. Mjeri se umjesto da se pogađa konstantom. */
function measureTopbar() {
  const bar = document.querySelector(".topbar");
  if (bar) document.documentElement.style.setProperty("--topbar-h", bar.offsetHeight + "px");
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
/* Web-export (`export.py --web`) izostavlja `image` i `cardmarket_url` jer su izvedivi
   iz `id`-a — u fajlu su bili 3,6 MB čistog ponavljanja. Lokalni puni export ih i dalje
   ima, pa oba oblika moraju raditi. Ključno: `undefined` (ključa nema → izvedi) NIJE isto
   što i `null` (izvoz kaže: ova karta nema sliku → ne izmišljaj URL koji vodi na 404). */
const cardImage = c => c.image !== undefined ? c.image
  : (c.id && c.id.length > 1
      ? `https://cards.scryfall.io/normal/front/${c.id[0]}/${c.id[1]}/${c.id}.jpg` : null);
const cardmarketUrl = c => c.cardmarket_url !== undefined ? c.cardmarket_url
  : (c.cardmarket_id
      ? `https://www.cardmarket.com/en/Magic/Products?idProduct=${c.cardmarket_id}` +
        `&referrer=scryfall&utm_campaign=card_prices&utm_medium=text&utm_source=scryfall` : null);

/** JEDINA definicija „cijena ove karte" na frontendu → {v, foil}.

    🍌 138 karata iz naših deckova izlazi SAMO u foilu (C17/C16 legende, 40k, Doctor Who):
    Scryfall im nema `eur`, ima `eur_foil`. Dok se to nije uzimalo u obzir, prikazivale su
    se kao „—" iako cijena postoji, a `deckTotal` ih je tiho preskakao — Edgar Markov
    (28,71 €) nije ulazio u vrijednost vlastitog decka.

    Foil cijena se NE pretvara u `eur` (foil i nonfoil su različiti proizvodi); vraća se uz
    zastavicu `foil: true` da je prikaz može označiti. */
function cardPrice(c) {
  const cm = (c.prices && c.prices.cardmarket) || {};
  const v = cm[priceKey()];
  if (v != null) return { v, foil: false };
  return cm.eur_foil != null ? { v: cm.eur_foil, foil: true } : { v: null, foil: false };
}

const fmtEur = v => v == null ? `<span class="price-na">—</span>` : `€${v.toFixed(2)}`;
/** Cijena + oznaka kad dolazi iz foila — bez oznake bi tvrdila da je nefoil trend. */
const fmtPrice = p => p.v == null ? `<span class="price-na">—</span>`
  : `€${p.v.toFixed(2)}${p.foil ? `<span class="foil-tag" title="Ovo izdanje postoji samo u foilu — prikazana je foil cijena">F</span>` : ""}`;
const fmtUsd = v => v == null ? `<span class="price-na">—</span>` : `$${v.toFixed(2)}`;

function deltaHtml(pct, { arrow = true } = {}) {
  if (pct == null) return `<span class="delta flat">—</span>`;
  const cls = pct > 0.001 ? "up" : pct < -0.001 ? "down" : "flat";
  const sym = !arrow ? "" : pct > 0.001 ? "▲ " : pct < -0.001 ? "▼ " : "";
  return `<span class="delta ${cls}">${sym}${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
}

/** % promjena između zadnje točke i najbliže točke starije od `days` dana.
    Vraća null kad te točke NEMA — bez podmetanja kraćeg perioda.

    🍌 Prije je ovdje bio fallback na najstariju dostupnu točku. Kako povijest za
    većinu karata seže samo nekoliko dana, stupac označen „7d" prikazivao je
    šestodnevnu (ili kraću) promjenu, i to različit period od retka do retka pod
    istom oznakom. Radije prazno nego brojka koja ne znači ono što piše. */
function pctChange(points, key, days) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  if (last[key] == null) return null;
  const target = new Date(last.d);
  target.setDate(target.getDate() - days);
  let base = null;
  for (const p of points) {
    if (p[key] == null) continue;
    if (new Date(p.d) <= target) base = p;
  }
  if (!base || base[key] === 0 || base === last) return null;
  return ((last[key] - base[key]) / base[key]) * 100;
}

function cardHistory(id) {
  return state.history?.cards?.[id]?.points || [];
}

/* --- povijest: puni izvoz vs. split web izvoz ---------------------------------
   Lokalni `export.py` nosi cijelu povijest u history.json. Web izvoz
   (`export.py --web`) drzi tamo samo zadnje dvije tocke — dovoljno za dnevni
   pregled — a punih 180 dana seli u `data/history/<xx>.json`, koji se dohvaca tek
   kad se otvori kartica karte. Oba oblika moraju raditi, pa se sve razlike drze
   ovdje: `state.history.split` kaze koji je oblik. */

/** 7d promjena za tablicu decka. U split izvozu je predracunata (dvije tocke je ne
    mogu dati); u punom se racuna iz serije. Vrijednosti su iste — export koristi
    doslovno isti algoritam, pa cijepanje ne mijenja nijednu prikazanu brojku. */
function card7d(id, key) {
  const h = state.history?.cards?.[id];
  if (!h) return null;
  const pre = key === "eur_low" ? h.d7_low : h.d7;
  return pre !== undefined ? pre : pctChange(h.points || [], key, 7);
}

const shardCache = new Map();

/** Puna serija za graf. U punom izvozu je vec u memoriji; u split izvozu dohvaca
    shard (~25 kB) i pamti ga, pa je druga kartica iz istog sharda besplatna. */
async function cardPoints(id) {
  if (!state.history?.split) return cardHistory(id);
  const key = id.slice(0, 2);
  if (!shardCache.has(key)) {
    shardCache.set(key, loadJSON(`../data/history/${key}.json`).catch(() => ({})));
  }
  return (await shardCache.get(key))[id] || cardHistory(id);
}
function deckHistory(id) {
  return state.history?.decks?.[id] || [];
}
function findCard(id) {
  for (const deck of state.cards.decks) {
    const c = deck.cards.find(c => c.id === id);
    if (c) return { card: c, deck };
  }
  return null;
}
function findDeck(id) {
  return state.cards.decks.find(d => d.id === id) || null;
}
function shortSetName(set) {
  return set.abbr || set.name;
}
const SET_ICON = code =>
  code ? `https://svgs.scryfall.io/sets/${code}.svg` : null;
function deckTotal(deck) {
  let t = 0, priced = 0, foilOnly = 0;
  for (const c of deck.cards) {
    const p = cardPrice(c);
    if (p.v != null) { t += p.v * c.qty; priced++; if (p.foil) foilOnly++; }
  }
  return { total: t, priced, foilOnly };
}

/* ---------------- router ---------------- */

let navToken = 0;

function render() {
  navToken++;                 // ponisti render kartice koji jos ceka svoj shard
  // Query se odreze PRIJE splita: bez toga `#/cards?q=sol` daje route "cards?q=sol"
  // i ruta tiho ne postoji.
  const hash = (location.hash || "#/").split("?")[0];
  const [, route, arg] = hash.split("/");
  const deckSet = route === "deck" && arg
    ? state.catalog.sets.find(s => s.decks.some(d => d.id === decodeURIComponent(arg)))
    : null;
  // 🍌 Boolean(...) je nužan: classList.toggle(cls, undefined) NE gasi klasu nego je
  // preokrene. `a.dataset.home` je undefined za set-linkove, pa su se pri svakom
  // renderu svi linkovi naizmjenično palili — nevidljivo dok .active nije bio glasan.
  $nav.querySelectorAll("a").forEach(a => a.classList.toggle("active", Boolean(
    (route === "set" && a.dataset.set === arg) ||
    (deckSet && a.dataset.set === deckSet.code) ||
    (!["set", "deck", "card", "cards", "stats"].includes(route) && a.dataset.home))));
  $nav.querySelectorAll("a[data-route]").forEach(a =>
    a.classList.toggle("active", a.dataset.route === route));
  window.scrollTo(0, 0);
  if (route === "deck" && arg) return renderDeck(decodeURIComponent(arg));
  if (route === "card" && arg) return renderCard(decodeURIComponent(arg));
  if (route === "set" && arg) return renderSet(arg);
  if (route === "cards") return renderCards();
  if (route === "stats") return renderStats();
  renderCatalog();
}

/* ---------------- views ---------------- */

function renderSetup(err) {
  $app.innerHTML = `
    <div class="setup">
      <h1>Nema podataka o cijenama</h1>
      <p class="sub">(${esc(err.message)})</p>
      <p>Stranica čita statične JSON snimke. Napravi ih ovako:</p>
      <ol>
        <li>Povuci svježe cijene i izračunaj vrijednosti deckova:
          <pre>python scripts/mtg/update.py daily</pre></li>
        <li>Izvezi ih u oblik koji ova stranica čita:
          <pre>python scripts/mtg/export.py</pre></li>
        <li>Pokreni lokalni dashboard i otvori ga:
          <pre>python scripts/mtg/dashboard.py
# pa otvori http://localhost:8770/site/</pre></li>
      </ol>
      <p>Korak 1 se pokreće jednom dnevno — grafovi povijesti rastu iz tih snimaka.</p>
    </div>`;
}

function deckTile(deck) {
  const { total, priced } = deckTotal(deck);
  const hist = deckHistory(deck.id);
  const d1 = pctChange(hist, priceKey(), 1);
  const d7 = pctChange(hist, priceKey(), 7);
  return `
    <a class="deck-tile" href="#/deck/${deck.id}">
      <span class="tile-name">${esc(deck.name)}</span>
      <div class="cmd">${esc(deck.commander || "")} · ${deck.cards.length} karata (${priced} s cijenom)</div>
      <div class="deck-meta">
        <span class="value">€${total.toFixed(2)} <small>Cardmarket ${priceLabel()}</small></span>
      </div>
      <div class="deck-meta">
        <span>1d ${deltaHtml(d1)}</span>
        <span>7d ${deltaHtml(d7)}</span>
      </div>
      <div class="spark">${sparkline(hist, priceKey(), 300, 46)}</div>
    </a>`;
}

function deckTileOff(entry) {
  return `
    <div class="deck-tile off">
      <span class="tile-name">${esc(entry.name)}</span>
      <div class="cmd">${esc(entry.commander || "")}</div>
      <div class="soon">Ne prati se</div>
    </div>`;
}

function setTracked(set) {
  return set.decks.filter(e => e.id && findDeck(e.id)).length;
}

/* ---------------- dnevni pregled (globalno, svi preconi) ---------------- */

/** Zadnje dvije stvarne tocke serije → apsolutna € promjena + postotak. */
function lastDelta(points, key = "eur") {
  const pts = (points || []).filter(p => p[key] != null);
  if (pts.length < 2) return null;
  const a = pts[pts.length - 1], b = pts[pts.length - 2];
  const abs = a[key] - b[key];
  if (!abs) return null;
  return { now: a[key], abs, pct: b[key] ? (abs / b[key]) * 100 : null, from: b.d, to: a.d };
}

/** Rangiranje ide po APSOLUTNOJ € promjeni — postotak je sekundaran.
    Time common od 0,02 € (+150 %) nikad ne otme naslovnicu, pa nema umjetnog praga. */
function moversGlobal(limit = 5) {
  const seen = new Map();
  for (const deck of state.cards.decks)
    for (const c of deck.cards) if (!seen.has(c.id)) seen.set(c.id, c);
  const rows = [];
  for (const [id, c] of seen) {
    const d = lastDelta(cardHistory(id));
    if (d) rows.push({ c, ...d });
  }
  rows.sort((x, y) => Math.abs(y.abs) - Math.abs(x.abs));
  // Ista karta u vise izdanja inace pojede vise mjesta u top 5 (npr. dva printa
  // Heroic Interventiona). Izdanja JESU zasebne stavke za trgovanje, ali na listi
  // od pet mjesta je informativnije vidjeti pet razlicitih karata — pa drzimo
  // najveci pomak po imenu. Detalj po izdanju i dalje zivi na kartici decka.
  const topBy = (pred) => {
    const out = [], seenName = new Set();
    for (const r of rows) {
      if (!pred(r) || seenName.has(r.c.name)) continue;
      seenName.add(r.c.name); out.push(r);
      if (out.length === limit) break;
    }
    return out;
  };
  return {
    up: topBy(r => r.abs > 0),
    down: topBy(r => r.abs < 0),
    pool: rows.length, total: seen.size,
  };
}

function deckMovers(limit = 3) {
  const rows = [];
  for (const deck of state.cards.decks) {
    const d = lastDelta(deckHistory(deck.id));
    if (d) rows.push({ deck, ...d });
  }
  rows.sort((x, y) => Math.abs(y.abs) - Math.abs(x.abs));
  return { up: rows.filter(r => r.abs > 0).slice(0, limit),
           down: rows.filter(r => r.abs < 0).slice(0, limit) };
}

const eurDelta = (abs, pct) => {
  const cls = abs > 0 ? "up" : abs < 0 ? "down" : "flat";
  const sign = abs > 0 ? "+" : abs < 0 ? "−" : "";
  const p = pct == null ? "" :
    ` <span class="mv-pct">(${sign}${Math.abs(pct).toFixed(1)}%)</span>`;
  return `<span class="delta ${cls}">${sign}€${Math.abs(abs).toFixed(2)}</span>${p}`;
};

// Terminal ticker: jedan redak po karti (minijatura · ime · cijena · delta).
// Zamijenilo mrežu velikih kartica — pet kartica je trošilo cijeli ekran za pet brojki.
function moverTile(r) {
  return `
    <a class="mv-row" href="#/card/${esc(r.c.id)}" title="${esc(r.c.name)}">
      <span class="mv-art">${cardImage(r.c)
        ? `<img src="${esc(cardImage(r.c))}" alt="" loading="lazy">`
        : `<span class="mv-noart" aria-hidden="true">${esc((r.c.name || "?")[0])}</span>`}</span>
      <span class="mv-name">${esc(r.c.name)}</span>
      <span class="mv-price">€${(r.now ?? 0).toFixed(2)}</span>
      <span class="mv-delta">${eurDelta(r.abs, r.pct)}</span>
    </a>`;
}

function deckMoverRow(r) {
  return `
    <a class="dm-row" href="#/deck/${esc(r.deck.id)}">
      <span class="dm-name">${esc(r.deck.name)}</span>
      <span class="dm-val">€${r.now.toFixed(2)}</span>
      <span class="dm-delta">${eurDelta(r.abs, r.pct)}</span>
    </a>`;
}

function renderOverview() {
  const m = moversGlobal(5), dm = deckMovers(3);
  if (!m.up.length && !m.down.length && !dm.up.length && !dm.down.length) {
    return `<div class="ov-empty">Dnevni pregled se pojavi kad povijest ima barem dvije točke
      za neku kartu — pokreni <code>python scripts/mtg/update.py daily</code> još jednom sutra.</div>`;
  }
  const block = (title, rows) => `
    <div class="mv-block">
      <h2 class="mv-h">${title}</h2>
      <div class="mv-list">${rows.length ? rows.map(moverTile).join("")
        : `<div class="ov-empty">nema podataka</div>`}</div>
    </div>`;
  const deckBlock = (title, rows) => `
    <div class="dm-block">
      <h2 class="mv-h">${title}</h2>
      <div class="mv-list">${rows.length ? rows.map(deckMoverRow).join("")
        : `<div class="ov-empty">nema podataka</div>`}</div>
    </div>`;
  return `
    <section class="overview">
      <div class="ov-head">
        <h1>Dnevni pregled</h1>
        <span class="sub">rangirano po apsolutnoj promjeni u eurima (postotak je sekundaran) ·
          ${m.pool} od ${m.total} karata ima dovoljno povijesti</span>
      </div>
      ${block("Najviše poskupjele", m.up)}
      ${block("Najviše pojeftinile", m.down)}
      <div class="dm-wrap">
        ${deckBlock("Deckovi — rast", dm.up)}
        ${deckBlock("Deckovi — pad", dm.down)}
      </div>
    </section>`;
}

function renderCatalog() {
  const ui = state.catalogUI ||= { q: "", dir: 1, trackedOnly: false };
  const q = ui.q.trim().toLowerCase();

  let sets = state.catalog.sets.slice();          // chronological in the file
  if (ui.dir === -1) sets.reverse();
  if (ui.trackedOnly) sets = sets.filter(s => setTracked(s) > 0);
  if (q) {
    sets = sets.filter(s =>
      s.name.toLowerCase().includes(q) ||
      (s.abbr || "").toLowerCase().includes(q) ||
      s.decks.some(d => d.name.toLowerCase().includes(q) ||
                        (d.commander || "").toLowerCase().includes(q)));
  }

  const tiles = sets.map(set => {
    const tracked = setTracked(set);
    const icon = SET_ICON(set.icon);
    const year = (set.date || "").slice(0, 4);
    // When searching, show which decks inside the set matched.
    const hits = q ? set.decks.filter(d =>
      d.name.toLowerCase().includes(q) ||
      (d.commander || "").toLowerCase().includes(q)).slice(0, 3) : [];
    return `
      <a class="set-tile ${tracked ? "" : "off"}" href="#/set/${esc(set.code)}">
        ${icon ? `<img class="set-logo" src="${icon}" alt="" loading="lazy"
           onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'set-logo-fallback',textContent:'${esc(set.abbr || set.code.toUpperCase())}'}))">` : ""}
        <span class="tile-name">${esc(set.name)}</span>
        <div class="set-sub">${esc(set.released || year)} ·
          ${tracked ? `${tracked}/${set.decks.length} deckova praćeno` : "ne prati se"}</div>
        ${hits.length ? `<div class="hit-list">${hits.map(h => esc(h.name)).join(" · ")}</div>` : ""}
      </a>`;
  }).join("");

  const totalDecks = state.catalog.sets.reduce((n, s) => n + s.decks.length, 0);
  const snapshots = Object.values(state.history?.decks || {})[0]?.length || 0;
  // Pregled nosi h1; kad ga pretraga sakrije, Katalog preuzima h1 (bez preskoka razine).
  const withOverview = !(ui.q || ui.trackedOnly);
  const catH = withOverview ? "h2" : "h1";
  $app.innerHTML = `
    ${withOverview ? renderOverview() : ""}
    <${catH}>Katalog</${catH}>
    <p class="sub">${state.catalog.sets.length} setova ·
      ${totalDecks} deckova (2011 → danas). Zasivljeni setovi još se ne prate.
      ${snapshots >= 2 ? `${snapshots} dnevnih snimaka cijena.` : ""}</p>
    <div class="toolbar">
      <input id="cat-q" type="search" placeholder="Traži set, deck ili commandera…"
        value="${esc(ui.q)}">
      <select id="cat-sort">
        <option value="1" ${ui.dir === 1 ? "selected" : ""}>Najstariji prvo</option>
        <option value="-1" ${ui.dir === -1 ? "selected" : ""}>Najnoviji prvo</option>
      </select>
      <label class="check"><input id="cat-tracked" type="checkbox"
        ${ui.trackedOnly ? "checked" : ""}> samo praćeni</label>
      <span class="count">${sets.length} / ${state.catalog.sets.length} setova</span>
    </div>
    <div class="set-grid">${tiles.length ? tiles : ""}</div>
    ${tiles.length ? "" : `<p class="sub">Nema rezultata za "${esc(ui.q)}".</p>`}`;

  const qEl = document.getElementById("cat-q");
  qEl.addEventListener("input", e => {
    ui.q = e.target.value;
    renderCatalog();
    const el = document.getElementById("cat-q");
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  });
  document.getElementById("cat-sort").addEventListener("change", e => {
    ui.dir = Number(e.target.value);
    renderCatalog();
  });
  document.getElementById("cat-tracked").addEventListener("change", e => {
    ui.trackedOnly = e.target.checked;
    renderCatalog();
  });
}

function renderSet(code) {
  const set = state.catalog.sets.find(s => s.code === code);
  if (!set) { $app.innerHTML = `<p>Nepoznat set.</p>`; return; }
  const tiles = set.decks.map(entry => {
    const deck = entry.id ? findDeck(entry.id) : null;
    return deck ? deckTile(deck) : deckTileOff(entry);
  }).join("");
  const tracked = setTracked(set);
  const icon = SET_ICON(set.icon);
  $app.innerHTML = `
    <a class="backlink" href="#/">← Katalog</a>
    <div class="set-head">
      ${icon ? `<img class="set-icon" src="${icon}" alt="" onerror="this.remove()">` : ""}
      <div>
        <h1>${esc(set.name)}</h1>
        <div class="set-sub">${esc(set.released || "")}${set.released ? " · " : ""}${tracked}/${set.decks.length} deckova praćeno</div>
      </div>
    </div>
    <div class="deck-grid">${tiles}</div>`;
}

/* ---------------- manual price update (GitHub workflow dispatch) ---------- */

function toast(msg, ms = 6000) {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.innerHTML = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), ms);
}

/** Lokalni update: dashboard.py nudi POST /api/job. Na GitHub Pagesu tog endpointa
    nema, pa se gumb tamo uopce ne prikazuje (vidi wireUpdateButton). */
async function localUpdate(btn) {
  btn.disabled = true;
  btn.textContent = "⏳ Osvježavam…";
  try {
    const r = await fetch("/api/job", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cmd: "update" }),
    }).then(r => r.json());
    if (r.error) { toast("❌ " + esc(r.error)); btn.disabled = false; btn.textContent = "⟳ Update"; return; }
    toast("⏳ Update pokrenut lokalno — povlačim svježe Cardmarket cijene…", 8000);
    const poll = setInterval(async () => {
      const j = await fetch("/api/job").then(r => r.json()).catch(() => null);
      if (!j || j.running) return;
      clearInterval(poll);
      btn.disabled = false; btn.textContent = "⟳ Update";
      toast("✅ Gotovo — učitavam svježe podatke…", 4000);
      setTimeout(() => location.reload(), 1200);
    }, 2500);
  } catch {
    btn.disabled = false; btn.textContent = "⟳ Update";
    toast("❌ Lokalni server ne odgovara.");
  }
}

/** Postoji li lokalni backend? Odlucuje hoce li gumb raditi lokalno ili preko GitHuba. */
async function hasLocalBackend() {
  try {
    const r = await fetch("/api/job", { method: "GET" });
    return r.ok;
  } catch { return false; }
}

async function wireUpdateButton() {
  const btn = document.getElementById("update-btn");
  if (!btn) return;
  // Od 2026-07-29 deployani `data/` puni lokalni pipeline, a GitHub workflow samo
  // objavljuje. Na javnoj stranici gumb dakle NE moze povuci svjeze cijene — a gumb
  // koji obeca osvjezavanje pa ga ne isporuci je kontrola koja laze. Zato postoji
  // samo tamo gdje doista radi: uz lokalni dashboard.
  let local = await hasLocalBackend();
  btn.hidden = !local;
  if (!local) return;
  btn.addEventListener("click", () => localUpdate(btn));
}

function renderDeck(deckId) {
  const deck = state.cards.decks.find(d => d.id === deckId);
  if (!deck) { $app.innerHTML = `<p>Nepoznat deck.</p>`; return; }

  const sort = state.sort[deckId] || { key: "price", dir: -1 };
  const filter = (state.filter[deckId] || "").toLowerCase();

  const rows = deck.cards
    .map(c => ({
      c,
      price: cardPrice(c).v,
      priceFoil: cardPrice(c).foil,
      foil: c.prices.cardmarket.eur_foil,
      usd: c.prices.tcgplayer.usd,
      d7: card7d(c.id, priceKey()),
    }))
    .filter(r => !filter
      || r.c.name.toLowerCase().includes(filter)
      || (r.c.type_line || "").toLowerCase().includes(filter)
      || (r.c.rarity || "").includes(filter));

  const val = (r) => sort.key === "name" ? r.c.name.toLowerCase()
    : sort.key === "rarity" ? rarityRank(r.c.rarity)
    : r[sort.key];
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;            // nulls always last
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
  });

  const { total } = deckTotal(deck);
  // Prazan 7d stupac bez objasnjenja izgleda kao kvar. Pokrivenost se priznaje
  // (DESIGN.md, nacelo 5) — i nota nestane sama kad povijest naraste za svaku kartu.
  // Fraza „X od Y karata ima" je ista kao u dnevnom pregledu i izbjegava hrvatsku
  // slozenu mnozinu (1 karta / 2 karte / 5 karata) — „od" uvijek trazi genitiv.
  const d7n = rows.filter(r => r.d7 != null).length;
  const th = (key, label, num, cls = "") => {
    const arrow = sort.key === key ? `<span class="arrow">${sort.dir > 0 ? "▲" : "▼"}</span>` : "";
    return `<th class="${num ? "num" : ""} ${cls}" data-sort="${key}">${label} ${arrow}</th>`;
  };

  const parentSet = state.catalog.sets.find(s => s.decks.some(d => d.id === deckId));
  const nameLink = deck.cardmarket_url
    ? `<a href="${esc(deck.cardmarket_url)}" target="_blank" rel="noopener" title="Otvori na Cardmarketu">${esc(deck.name)} ↗</a>`
    : esc(deck.name);
  const sealed = deck.sealed && deck.sealed[priceKey()] != null
    ? ` · zapakiran deck <strong>€${deck.sealed[priceKey()].toFixed(2)}</strong>`
    : "";
  $app.innerHTML = `
    <a class="backlink" href="${parentSet ? `#/set/${parentSet.code}` : "#/"}">← ${esc(parentSet ? parentSet.name : "Katalog")}</a>
    <h1>${nameLink}</h1>
    <p class="sub">${esc(deck.commander || "")} · set ${esc((deck.set || deck.cards[0]?.set || "?").toUpperCase())}
       · zbroj karata <strong>€${total.toFixed(2)}</strong> (Cardmarket ${priceLabel()})${sealed}</p>
    <div class="toolbar">
      <input id="filter" type="search" placeholder="Filtriraj karte…" value="${esc(state.filter[deckId] || "")}">
      <span class="count">${rows.length} / ${deck.cards.length} karata</span>
      ${d7n < rows.length ? `<span class="count">7d: ${d7n} od ${rows.length} karata ima
        7 dana povijesti</span>` : ""}
      ${deckTotal(deck).foilOnly ? `<span class="count">${deckTotal(deck).foilOnly}
        ${deckTotal(deck).foilOnly === 1 ? "karta izlazi" : "karata izlazi"} samo u foilu
        (<span class="foil-tag">F</span>) — u zbroju je foil cijena</span>` : ""}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          ${th("name", "Karta")}${th("rarity", "Rijetkost", false, "col-rarity")}
          ${th("price", `EUR ${priceLabel()}`, true, "col-price")}${th("foil", "Foil EUR", true, "col-foil")}
          ${th("usd", "USD", true, "col-usd")}${th("d7", "7d", true, "col-d7")}
          <th class="col-cm"></th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr data-card="${r.c.id}">
              <td class="cardcell">
                ${cardImage(r.c) ? `<img loading="lazy" src="${esc(cardImage(r.c))}" alt="">` : ""}
                <span><span class="cn">${esc(r.c.name)}</span>${r.c.qty > 1 ? ` ×${r.c.qty}` : ""}<br>
                <span class="ct">${esc(r.c.type_line || "")}</span></span>
              </td>
              <td class="col-rarity"><span class="rarity ${esc(r.c.rarity)}">${esc(r.c.rarity || "")}</span></td>
              <td class="num col-price">${fmtPrice({ v: r.price, foil: r.priceFoil })}</td>
              <td class="num col-foil">${fmtEur(r.foil)}</td>
              <td class="num col-usd">${fmtUsd(r.usd)}</td>
              <td class="num col-d7">${deltaHtml(r.d7, { arrow: false })}</td>
              <td class="col-cm">${cardmarketUrl(r.c)
                ? `<a class="ext" href="${esc(cardmarketUrl(r.c))}" target="_blank" rel="noopener"
                     title="Otvori na Cardmarketu">CM ↗</a>` : ""}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;

  document.getElementById("filter").addEventListener("input", e => {
    state.filter[deckId] = e.target.value;
    renderDeck(deckId);
    const inp = document.getElementById("filter");
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
  });
  $app.querySelectorAll("th[data-sort]").forEach(el =>
    el.addEventListener("click", () => {
      const key = el.dataset.sort;
      const cur = state.sort[deckId] || { key: "price", dir: -1 };
      state.sort[deckId] = { key, dir: cur.key === key ? -cur.dir : (key === "name" ? 1 : -1) };
      renderDeck(deckId);
    }));
  $app.querySelectorAll("tbody tr").forEach(el =>
    el.addEventListener("click", e => {
      if (e.target.closest("a")) return;   // let the Cardmarket link work
      location.hash = `#/card/${el.dataset.card}`;
    }));
}

function rarityRank(r) {
  return { mythic: 4, rare: 3, uncommon: 2, common: 1 }[r] || 0;
}

/* ================= pregled cijelog skupa + statistika ================= */

/** cardindex.json = per-name polja (cmc, mana_cost, n_prints, edhrec_rank).
    Odvojen fajl jer naslovnica i deck-stranica ta polja ne trebaju — izmjereno
    106 kB gzip koje ne plati nitko tko ne otvori ova dva pogleda. */
async function ensureIndex() {
  if (!state.index) {
    try { state.index = await loadJSON("../data/cardindex.json"); }
    catch { state.index = {}; }
  }
  return state.index;
}

/** Jedan redak po PRINTANJU (to je ono sto ima cijenu), + u koliko se PRECONA pojavljuje.
    `n_decks` se broji po imenu i po decku jednom — deck koji ima dva izdanja iste karte
    ne smije se brojati dvaput. */
function allPrintings() {
  if (state._flat) return state._flat;
  const byId = new Map(), decksByName = new Map();
  for (const d of state.cards.decks) {
    const names = new Set();
    for (const c of d.cards) {
      if (!byId.has(c.id)) byId.set(c.id, c);
      names.add(c.name);
    }
    for (const n of names) decksByName.set(n, (decksByName.get(n) || 0) + 1);
  }
  state._flat = [...byId.values()].map(c => ({ c, n_decks: decksByName.get(c.name) || 0 }));
  return state._flat;
}

/** Karta koja izlazi u vise izdanja ima vise cijena. Koja je "cijena karte" je
    UREDNICKA odluka, ne cinjenica — zato prekidac, a ne tiho uzeta prva. */
function pricesByName(mode) {
  const per = new Map();
  for (const { c } of allPrintings()) {
    const p = cardPrice(c).v;
    if (p == null) continue;
    const cur = per.get(c.name);
    if (!cur) per.set(c.name, { p, c });
    else if (mode === "max" ? p > cur.p : p < cur.p) per.set(c.name, { p, c });
  }
  return per;
}

// Redoslijed JE pravilo prednosti primarnog tipa. Mijenjanje redoslijeda mijenja
// rezultat — zato je ispisano na stranici, a ne skriveno u kodu.
const TYPES = ["Creature", "Planeswalker", "Land", "Instant", "Sorcery",
               "Artifact", "Enchantment", "Battle"];
const typesOf = tl => TYPES.filter(t => String(tl || "").split("//")[0].split("—")[0].includes(t));
const primaryType = tl => typesOf(tl)[0] || "—";
const isSplit = c => String(c.mana_cost || "").includes("//") ||
                     String(c.type_line || "").includes("//");

function quant(sorted, q) {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}
const median = a => quant(a, 0.5);

/* ---------------- #/cards ---------------- */

const CARDS_PAGE = 200;

async function renderCards() {
  await ensureIndex();
  const ui = state.cardsUI || (state.cardsUI = { q: "", key: "price", dir: -1, limit: CARDS_PAGE });
  const ix = state.index;
  const q = ui.q.toLowerCase();

  const all = allPrintings().map(({ c, n_decks }) => {
    const m = ix[c.name] || {};
    const pr = cardPrice(c);
    return { c, n_decks, m, price: pr.v, priceFoil: pr.foil,
             cmc: m.cmc, prints: m.n_prints, edhrec: m.edhrec_rank };
  });
  const rows = all.filter(r => !q
    || r.c.name.toLowerCase().includes(q)
    || (r.c.type_line || "").toLowerCase().includes(q)
    || (r.m.mana_cost || "").toLowerCase().includes(q)
    || (r.c.set || "").toLowerCase().includes(q)
    || (r.c.variant || "").includes(q));

  const val = r => ({ name: r.c.name.toLowerCase(), set: r.c.set || "",
                      type: r.c.type_line || "", rarity: rarityRank(r.c.rarity),
                      variant: r.c.variant || "" }[ui.key]) ?? r[ui.key];
  rows.sort((a, b) => {
    const va = val(a), vb = val(b);
    if (va == null && vb == null) return 0;
    if (va == null) return 1;                        // null uvijek zadnji
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * ui.dir;
  });

  const shown = rows.slice(0, ui.limit);
  const priced = all.filter(r => r.price != null).length;
  const th = (key, label, num, cls = "") =>
    `<th class="${num ? "num" : ""} ${cls}" data-sort="${key}">${label} ${
      ui.key === key ? `<span class="arrow">${ui.dir > 0 ? "▲" : "▼"}</span>` : ""}</th>`;

  $app.innerHTML = `
    <h1>Sve karte</h1>
    <p class="sub">Skup = <strong>158 Commander precona</strong>, ne cijeli Magic.
      ${all.length} printanja · ${priced} s cijenom (${(100 * priced / all.length).toFixed(1)} %)
      · cijena je Cardmarket ${priceLabel()}.</p>
    <div class="toolbar">
      <input id="cards-q" type="search" placeholder="Ime, tip, mana cost, set…" value="${esc(ui.q)}">
      <span class="count">${rows.length} / ${all.length} printanja</span>
      ${rows.length > shown.length
        ? `<span class="count">prikazano ${shown.length}</span>` : ""}
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          ${th("name", "Karta")}${th("set", "Set")}
          ${th("cmc", "Mana", true)}${th("rarity", "Rijetkost", false, "col-rarity")}
          ${th("variant", "Obrada")}${th("price", `EUR ${priceLabel()}`, true, "col-price")}
          ${th("prints", "Izdanja", true)}${th("decks", "Deckova", true)}
          ${th("edhrec", "EDHREC", true, "col-usd")}
        </tr></thead>
        <tbody id="cards-body">${cardsRows(shown)}</tbody>
      </table>
    </div>
    ${rows.length > shown.length ? `<div class="more-wrap">
      <button id="cards-more" class="more-btn">Prikaži još ${
        Math.min(CARDS_PAGE, rows.length - shown.length)} (ostalo ${rows.length - shown.length})</button>
    </div>` : ""}
    <p class="sub foot-note">„Mana" je Scryfallov <em>cmc</em>. Za split i dvolične karte to je
      <strong>zbroj obiju polovica</strong> (<code>Dusk // Dawn</code> = 9 uz
      <code>{2}{W}{W} // {3}{W}{W}</code>) — takvi su redci označeni sa <span class="sigma">Σ</span>,
      jer sortiranje po toj brojci njih stavlja uz karte za devet many.</p>`;

  const inp = document.getElementById("cards-q");
  inp.addEventListener("input", e => {
    ui.q = e.target.value; ui.limit = CARDS_PAGE;
    // samo tbody + brojaci -> input node ostaje ziv, pa nema hacka s kursorom
    renderCards();
  });
  document.getElementById("cards-more")?.addEventListener("click", () => {
    ui.limit += CARDS_PAGE; renderCards();
  });
  $app.querySelectorAll("th[data-sort]").forEach(el =>
    el.addEventListener("click", () => {
      const key = el.dataset.sort;
      ui.dir = ui.key === key ? -ui.dir : (["name", "set", "type", "variant"].includes(key) ? 1 : -1);
      ui.key = key; ui.limit = CARDS_PAGE;
      renderCards();
    }));
  $app.querySelectorAll("tbody tr").forEach(el =>
    el.addEventListener("click", e => {
      if (e.target.closest("a")) return;
      location.hash = `#/card/${el.dataset.card}`;
    }));
  if (document.activeElement !== inp && ui.q) {
    inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
  }
}

function cardsRows(rows) {
  return rows.map(r => `
    <tr data-card="${r.c.id}">
      <td class="cardcell">
        ${cardImage(r.c) ? `<img loading="lazy" src="${esc(cardImage(r.c))}" alt="">` : ""}
        <span><span class="cn">${esc(r.c.name)}</span><br>
        <span class="ct">${esc(r.c.type_line || "")}</span></span>
      </td>
      <td>${esc((r.c.set || "").toUpperCase())}</td>
      <td class="num">${r.cmc == null ? `<span class="price-na">—</span>`
        : `${r.cmc}${isSplit({ ...r.c, ...r.m }) ? `<span class="sigma" title="cmc je zbroj obiju polovica">Σ</span>` : ""}`}
        ${r.m.mana_cost ? `<small class="mc">${esc(r.m.mana_cost)}</small>` : ""}</td>
      <td class="col-rarity"><span class="rarity ${esc(r.c.rarity)}">${esc(r.c.rarity || "")}</span></td>
      <td>${r.c.variant ? `<span class="vtag">${esc(r.c.variant)}</span>` : ""}</td>
      <td class="num col-price">${fmtPrice({ v: r.price, foil: r.priceFoil })}</td>
      <td class="num">${r.prints ?? `<span class="price-na">—</span>`}</td>
      <td class="num">${r.n_decks}</td>
      <td class="num col-usd">${r.edhrec ?? `<span class="price-na">—</span>`}</td>
    </tr>`).join("");
}

/* ---------------- #/stats ---------------- */

async function renderStats() {
  await ensureIndex();
  const ui = state.statsUI || (state.statsUI = { pick: "min", assign: "primary" });
  const per = pricesByName(ui.pick);

  // svi nazivi u skupu (i oni bez cijene) — da se pokrivenost moze priznati
  const names = new Map();
  for (const { c } of allPrintings()) if (!names.has(c.name)) names.set(c.name, c);

  const buckets = new Map();
  for (const [name, c] of names) {
    const types = ui.assign === "primary" ? [primaryType(c.type_line)] : typesOf(c.type_line);
    for (const t of (types.length ? types : ["—"])) {
      const b = buckets.get(t) || { n: 0, vals: [], top: null };
      b.n++;
      const hit = per.get(name);
      if (hit) {
        b.vals.push(hit.p);
        if (!b.top || hit.p > b.top.p) b.top = { p: hit.p, name, id: hit.c.id };
      }
      buckets.set(t, b);
    }
  }

  const rows = [...buckets.entries()]
    .filter(([, b]) => b.vals.length)          // prazan bucket se NE renderira
    .map(([t, b]) => {
      const s = [...b.vals].sort((x, y) => x - y);
      return { t, n: b.n, priced: s.length, mean: s.reduce((a, x) => a + x, 0) / s.length,
               med: median(s), p90: quant(s, 0.9), max: s[s.length - 1], top: b.top };
    })
    .sort((a, b) => b.med - a.med);

  const sumN = rows.reduce((a, r) => a + r.n, 0);
  const totalPriced = per.size;
  const label = ui.pick === "min" ? "najjeftinije izdanje" : "najskuplje izdanje";

  $app.innerHTML = `
    <h1>Statistika po tipu karte</h1>
    <p class="sub">Skup = <strong>158 Commander precona</strong>, ne cijeli Magic —
      najskuplja karta u skupu je oko 56 €, pa ovo nije presjek Magica.
      ${names.size} različitih karata, ${totalPriced} s cijenom
      (${(100 * totalPriced / names.size).toFixed(1)} %). Cijena po karti =
      <strong>${label}</strong>, Cardmarket ${priceLabel()}.</p>

    <div class="toolbar">
      <span class="seg" id="seg-pick">
        <button data-v="min" class="${ui.pick === "min" ? "on" : ""}">Najjeftinije izdanje</button
        ><button data-v="max" class="${ui.pick === "max" ? "on" : ""}">Najskuplje</button>
      </span>
      <span class="seg" id="seg-assign">
        <button data-v="primary" class="${ui.assign === "primary" ? "on" : ""}">Primarni tip</button
        ><button data-v="all" class="${ui.assign === "all" ? "on" : ""}">Svaki tip koji nosi</button>
      </span>
    </div>

    <div class="callout">
      <strong>Nema jednog „najskupljeg tipa".</strong> Odgovor se mijenja s odabranom
      statistikom i s pravilom razvrstavanja: po <em>prosjeku</em> vodi Artifact, po
      <em>medijanu</em> Planeswalker, a Artifact i Enchantment dijeli oko 0,02 € na uzorku
      od ~500 karata — to je unutar šuma. Zato je tablica sortirana po medijanu i prikazuje
      i prosjek i medijan i p90, bez proglašavanja pobjednika.
    </div>

    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Tip</th><th class="num">Karata</th><th class="num">S cijenom</th>
          <th class="num">Prosjek</th><th class="num">Medijan</th><th class="num">p90</th>
          <th class="num">Max</th><th>Najskuplja</th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td><strong>${esc(r.t)}</strong></td>
              <td class="num">${r.n}</td>
              <td class="num ${r.priced / r.n < 0.95 ? "warn" : ""}">${r.priced}
                <small>(${(100 * r.priced / r.n).toFixed(0)} %)</small></td>
              <td class="num">${fmtEur(r.mean)}</td>
              <td class="num"><strong>${fmtEur(r.med)}</strong></td>
              <td class="num">${fmtEur(r.p90)}</td>
              <td class="num">${fmtEur(r.max)}</td>
              <td>${r.top ? `<a href="#/card/${r.top.id}">${esc(r.top.name)}</a>` : "—"}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>

    <h2 class="sec-h">Kako je tip određen</h2>
    <p class="sub">Pravilo prednosti: ${TYPES.join(" → ")}. Uzima se lice prije
      <code>//</code> i prije <code>—</code>.
      ${ui.assign === "primary"
        ? `U ovom načinu karta ulazi u <strong>točno jedan</strong> tip, pa npr. svi
           <em>Artifact Creature</em> idu u Creature i bucket Artifact ih ne sadrži —
           a Artifact je upravo tip koji po prosjeku ispada najskuplji. Prebaci na
           „svaki tip koji nosi" da vidiš koliko to mijenja.`
        : `U ovom načinu karta ulazi u <strong>svaki</strong> tip koji nosi, pa je zbroj
           stupca „Karata" ${sumN} — više od ${names.size} različitih karata. Zbroj
           namjerno premašuje 100 %.`}</p>
    <p class="sub foot-note">Rangiranje je po medijanu jer je prosjek 3–5× veći od medijana
      u svakom tipu — raspodjela ima dugi rep i prosjek sam zavarava. Postotak pokrivenosti
      ispod 95 % je označen: bucket s 92 % i bucket sa 100 % nisu usporedivi.</p>`;

  document.getElementById("seg-pick").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    ui.pick = b.dataset.v; renderStats();
  });
  document.getElementById("seg-assign").addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    ui.assign = b.dataset.v; renderStats();
  });
}

async function renderCard(cardId) {
  const hit = findCard(cardId);
  if (!hit) { $app.innerHTML = `<p>Nepoznata karta.</p>`; return; }
  const { card, deck } = hit;
  const cm = card.prices.cardmarket, tp = card.prices.tcgplayer;
  // ponytail: prethodni prikaz ostaje dok shard stigne (~25 kB s istog origina).
  // Ako ikad postane primjetno, ovdje ide skeleton umjesto cekanja.
  const my = navToken;
  const points = await cardPoints(card.id);
  const vers = await cardVersions(card);
  const syn = await cardSynergy(card.name);
  if (my !== navToken) return;                 // korisnik je u međuvremenu otišao dalje
  const d1 = pctChange(points, priceKey(), 1);
  const d7 = pctChange(points, priceKey(), 7);
  const d30 = pctChange(points, priceKey(), 30);

  const listing = state.listings?.cards?.[card.id];

  $app.innerHTML = `
    <a class="backlink" href="#/deck/${deck.id}">← ${esc(deck.name)}</a>
    <div class="card-page">
      <div class="art">
        ${cardImage(card) ? `<img src="${esc(cardImage(card))}" alt="${esc(card.name)}">` : ""}
        ${cardmarketUrl(card)
          ? `<a class="buy-btn" href="${esc(cardmarketUrl(card))}" target="_blank" rel="noopener">
               Otvori na Cardmarketu ↗</a>` : ""}
        <a class="buy-btn alt" href="https://scryfall.com/card/${esc((card.set || "").toLowerCase())
          }/${esc(card.collector_number || "")}" target="_blank" rel="noopener">Scryfall ↗</a>
        ${msLink(card, vers)}
      </div>
      <div>
        <h1>${esc(card.name)}</h1>
        <p class="sub">${esc(card.type_line || "")} ·
          <span class="rarity ${esc(card.rarity)}">${esc(card.rarity || "")}</span> ·
          ${esc((card.set || "").toUpperCase())} #${esc(card.collector_number || "?")}</p>

        <div class="stat-row">
          <div class="stat"><div class="lbl">Cardmarket ${priceLabel()}</div>
            <div class="val">${fmtPrice(cardPrice(card))}</div></div>
          <div class="stat"><div class="lbl">Foil trend</div>
            <div class="val">${fmtEur(cm.eur_foil)}</div></div>
          <div class="stat"><div class="lbl">TCGplayer USD</div>
            <div class="val">${fmtUsd(tp.usd)}</div></div>
          <div class="stat"><div class="lbl">1d / 7d / 30d</div>
            <div class="val val-sm">
              ${deltaHtml(d1, { arrow: false })} / ${deltaHtml(d7, { arrow: false })} / ${deltaHtml(d30, { arrow: false })}
            </div></div>
        </div>

        <h2 class="sec-h">Povijest cijene · EUR, Cardmarket ${priceLabel()}</h2>
        ${priceChart(points)}

        ${synergySection(syn)}
        ${versionsSection(vers)}
        ${state.listings ? listingsSection(card, listing) : ""}
      </div>
    </div>`;

  attachChartHover();
  wireVersions(vers);
}

/* ---------------- sinergija (EDHREC) ---------------- */

/** MORA biti identično `synergy.shard_key()` u Pythonu — inače shard ne postoji i
    sekcija tiho nestane. */
const synShard = name => {
  const c = (name || "").trim()[0]?.toLowerCase() || "";
  return (c >= "a" && c <= "z") || (c >= "0" && c <= "9") ? c : "_";
};

async function cardSynergy(name) {
  const k = synShard(name);
  state._syn = state._syn || {};
  if (!(k in state._syn)) {
    try { state._syn[k] = await loadJSON(`../data/synergy/${k}.json`); }
    catch { state._syn[k] = {}; }
  }
  return state._syn[k][name] || null;
}

/** Formulacija je namjerna: „odgovaraju istim commanderima", NE „igraju se zajedno".
    EDHREC daje uključenost po commanderu, a ne parove karata iz istih deckova — pa je
    druga tvrdnja jača od podataka. */
function synergySection(list) {
  if (!list || !list.length) return "";
  return `
    <h2 class="sec-h">Odgovaraju istim commanderima · ${list.length}</h2>
    <p class="sub">Karte koje se pojavljuju uz <strong>iste commandere</strong> kao ova.
      Nije isto što i „igraju se zajedno u istom decku" — EDHREC daje udio po commanderu,
      ne parove karata iz istih lista. Sličnost je skupljena prema broju zajedničkih
      commandera, pa par s puno dokaza pobjeđuje par s malo.</p>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Karta</th><th class="num">Sličnost</th><th class="num">Zajedničkih</th>
          <th>Isti keywordi</th><th class="num">EUR</th>
        </tr></thead>
        <tbody>
          ${list.map(s => `
            <tr>
              <td><span class="cn">${esc(s.name)}</span></td>
              <td class="num">${s.sim.toFixed(3)}</td>
              <td class="num">${s.shared}</td>
              <td>${(s.kw || []).map(k => `<span class="vtag">${esc(k)}</span>`).join(" ")}</td>
              <td class="num">${s.eur == null ? `<span class="price-na">—</span>`
                : `€${s.eur.toFixed(2)}`}</td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>
    <p class="sub foot-note">„Isti keywordi" dolazi iz Scryfall podataka i <strong>nezavisan</strong>
      je od EDHREC-a. Izmjereno: parovi koji dijele keyword imaju prosječnu sličnost
      <strong>0,279</strong> naspram <strong>0,109</strong> za one koji ne dijele — dvije
      nepovezane metode pokazuju isto, pa mjera hvata mehaničku srodnost, a ne samo popularnost.</p>`;
}

/* ---------------- sva izdanja karte (MTGStocks) ---------------- */

/** versions/<ms_card_id>.json — jedan fajl PO KARTI, jer je popis izdanja zajednički
    svim njenim printanjima. Ključ `ms_card` postoji samo ako su podaci dohvaćeni. */
async function cardVersions(card) {
  if (!card.ms_card) return null;
  state._vers = state._vers || {};
  if (!(card.ms_card in state._vers)) {
    try { state._vers[card.ms_card] = await loadJSON(`../data/versions/${card.ms_card}.json`); }
    catch { state._vers[card.ms_card] = null; }
  }
  return state._vers[card.ms_card];
}

/** Gumb na MTGStocks. `prints/<ms_id>` preusmjeri na slug, pa je dovoljan broj.
    Bez podataka NE glumi izravan link — vodi na pretragu i to i piše, jer bi isti
    izgled na dva različita ponašanja bio laž. */
function msLink(card, vers) {
  const mine = vers?.versions?.find(v => v.id === card.id);
  if (mine) return `<a class="buy-btn alt" href="https://www.mtgstocks.com/prints/${mine.ms_id}"
      target="_blank" rel="noopener">MTGStocks ↗</a>`;
  return `<a class="buy-btn alt dim-btn"
    href="https://www.mtgstocks.com/search?q=${encodeURIComponent(card.name)}"
    target="_blank" rel="noopener" title="Ovo izdanje još nije povezano — otvara pretragu">
    MTGStocks (pretraga) ↗</a>`;
}

/** Legenda je TABLICA, ne 153 boje. Redak od 40 px je klik-cilj; polilinija od 2 px
    nije, a na dodiru je nepogodiva. Tablica je ujedno i odgovor na „usporedi sve verzije". */
function versionsSection(vers) {
  if (!vers) {
    return `<h2 class="sec-h">Sva izdanja</h2>
      <p class="sub">Izdanja ove karte još nisu dohvaćena. Lokalno:
        <code>python scripts/mtg/mtgstocks.py versions &lt;id&gt; --history 10</code>
        (popis izdanja je jedan zahtjev, povijest ide 1 izdanje/s).</p>`;
  }
  const vs = vers.versions;
  const withHist = vs.filter(v => v.points.length >= 2);
  const prices = vs.map(v => v.eur).filter(v => v != null);
  const spread = prices.length > 1
    ? `raspon <strong>€${Math.min(...prices).toFixed(2)}–€${Math.max(...prices).toFixed(2)}</strong>
       (${(Math.max(...prices) / Math.max(Math.min(...prices), 0.01)).toFixed(1)}×)` : "";
  return `
    <h2 class="sec-h">Sva izdanja · ${vs.length}</h2>
    <p class="sub">${spread}${spread ? " · " : ""}povijest ima
      <strong>${withHist.length} od ${vs.length}</strong> izdanja — ostala su poznata, ali im
      serija još nije povučena (nije isto što i „nema podataka").
      Cijena je MTGStocksov zadnji Cardmarket podatak i <em>nije</em> ista veličina kao
      cijena gore (drugi izvor, drugi trenutak).</p>
    ${withHist.length >= 1 ? `
      <div class="toolbar">
        <span class="seg" id="seg-scale">
          <button data-v="log" class="on">Log os</button><button data-v="lin">Linearna</button
          ><button data-v="idx">Indeks =100</button>
        </span>
      </div>
      <div id="multi-chart">${multiChart(withHist, "log")}</div>` : ""}
    <div class="table-wrap">
      <table class="ver-table">
        <thead><tr>
          <th>Izdanje</th><th>Foil</th><th class="num">EUR</th>
          <th class="num">Točaka</th><th class="num">Od</th><th></th>
        </tr></thead>
        <tbody>
          ${vs.map((v, i) => `
            <tr data-ms="${v.ms_id}">
              <td class="cardcell">
                ${v.image ? `<img loading="lazy" class="ver-img" src="${esc(v.image)}"
                     alt="" data-full="${esc(v.image)}">` : ""}
                <span><span class="cn">${esc(v.set || "—")} #${esc(v.cn || "?")}</span><br>
                <span class="ct">${esc(v.set_name || "")}</span></span>
              </td>
              <td>${v.foil ? `<span class="vtag">foil</span>` : ""}</td>
              <td class="num">${fmtEur(v.eur)}</td>
              <td class="num">${v.points.length || `<span class="price-na">—</span>`}</td>
              <td class="num"><small>${v.points.length ? esc(v.points[0].d) : ""}</small></td>
              <td class="num">
                ${v.mkm_url ? `<a class="ext" href="${esc(v.mkm_url)}" target="_blank"
                   rel="noopener" title="Cardmarket za OVU verziju">CM ↗</a>` : ""}
                ${v.slug ? `<a class="ext" href="https://www.mtgstocks.com/prints/${v.ms_id}"
                   target="_blank" rel="noopener" title="MTGStocks">MS ↗</a>` : ""}
              </td>
            </tr>`).join("")}
        </tbody>
      </table>
    </div>`;
}

function wireVersions(vers) {
  if (!vers) return;
  const withHist = vers.versions.filter(v => v.points.length >= 2);
  document.getElementById("seg-scale")?.addEventListener("click", e => {
    const b = e.target.closest("button"); if (!b) return;
    e.currentTarget.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
    document.getElementById("multi-chart").innerHTML = multiChart(withHist, b.dataset.v);
  });
  // klik na sliku izdanja → povećana slika s MTGStocksa
  $app.querySelectorAll(".ver-img").forEach(img =>
    img.addEventListener("click", ev => {
      ev.stopPropagation();
      showLightbox(img.dataset.full);
    }));
}

function showLightbox(src) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${esc(src)}" alt="">`;
  box.addEventListener("click", () => box.remove());
  document.addEventListener("keydown", function esc2(e) {
    if (e.key === "Escape") { box.remove(); document.removeEventListener("keydown", esc2); }
  });
  document.body.appendChild(box);
}

/* ---------------- listings ---------------- */

// Poziva se samo kad listings.json postoji — inače sekcija ne postoji uopće.
// Prazno stanje koje upućuje na skriptu koje u pipelineu nema je gora usluga od tišine.
function listingsSection(card, listing) {
  if (!listing) {
    return `
      <h2 class="sec-h">Najjeftinije ponude</h2>
      <div class="listing-note">Za ovu kartu nema snimljenih ponuda — snimka ponuda pokriva
        samo dio karata.</div>`;
  }
  const table = (rows) => rows.length ? `
    <div class="table-wrap">
      <table class="listings-table">
        <thead><tr><th>#</th><th class="num">Cijena</th><th>Jezik</th><th>Država prodavača</th>
          <th class="col-cond">Stanje</th><th class="col-qty num">Kom.</th><th>Prodavač</th></tr></thead>
        <tbody>${rows.map((l, i) => `
          <tr>
            <td>${i + 1}</td>
            <td class="num"><strong>${fmtEur(l.price)}</strong></td>
            <td>${esc(l.language || "?")}</td>
            <td>${esc(l.country || "?")}</td>
            <td class="col-cond">${l.condition ? `<span class="cond">${esc(l.condition)}</span>` : "?"}</td>
            <td class="num col-qty">${l.qty ?? "?"}</td>
            <td>${esc(l.seller || "?")}</td>
          </tr>`).join("")}
        </tbody>
      </table>
    </div>` : `<div class="listing-note">Nema pronađenih ponuda.</div>`;

  return `
    <h2 class="sec-h">10 najjeftinijih ponuda</h2>
    ${table(listing.cheapest || [])}
    <h2 class="sec-h">Najbolji prodavači u Hrvatskoj <span class="hr-badge">HR</span></h2>
    ${table(listing.croatia || [])}
    <div class="stale">Snimka ponuda od ${esc(listing.scraped_at || "?")} — ponude se
      snimaju odvojeno od dnevnih cijena i mogu biti starije od grafa.</div>`;
}

/* ---------------- charts (inline SVG) ---------------- */

function seriesDefs() {
  return [
    { key: priceKey(), label: priceKey() === "eur_low" ? "Nonfoil (from)" : "Nonfoil", color: "var(--series-eur)" },
    { key: "eur_foil", label: "Foil", color: "var(--series-foil)" },
  ];
}

/** Prima točke (ne samo vrijednosti) da bi i ovdje os bila vremenska, ne po indeksu —
    inače bi rupa u snimcima izgledala kao ravnomjeran dio serije. */
function sparkline(points, key, w, h) {
  const pts0 = (points || []).filter(p => p[key] != null);
  const vals = pts0.map(p => p[key]);
  if (vals.length < 2) {
    return `<svg width="${w}" height="${h}"><line x1="0" y1="${h - 6}" x2="${w}" y2="${h - 6}"
      stroke="var(--baseline)" stroke-dasharray="3 4"/><text x="0" y="${h - 12}"
      fill="var(--muted)" font-size="11">povijest raste sa svakim dnevnim snimkom</text></svg>`;
  }
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const t0 = Date.parse(pts0[0].d);
  const tSpan = (Date.parse(pts0[pts0.length - 1].d) - t0) || 1;
  const pts = pts0.map((p, i) => [
    ((Date.parse(p.d) - t0) / tSpan) * (w - 4) + 2,
    h - 4 - ((vals[i] - min) / span) * (h - 10),
  ]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return `<svg width="${w}" height="${h}" role="img"
      aria-label="Kretanje vrijednosti decka, ${vals.length} snimaka, €${vals[0].toFixed(2)} → €${vals[vals.length - 1].toFixed(2)}">
    <path d="${d}" fill="none" stroke="var(--series-eur)" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" fill="var(--series-eur)"/></svg>`;
}

/* ---------------- graf sa svim izdanjima ---------------- */

/* Boje su LITERALI, nikad `var(--series-${i})`: check_design.py traži var() reference
   regexom nad tekstom app.js, pa mu je sastavljeno ime nevidljivo — a nedefiniran var()
   u `stroke` tiho postane `stroke:none` (jednom je već sakrio cijeli grid).
   Više od tri istaknute serije se ne boja: 11 (ili 153) nijansi nije legenda. Ostale idu
   prigušeno, a identifikacija se radi u tablici ispod, gdje je redak klik-cilj. */
const RAMP = ["var(--series-eur)", "var(--series-foil)", "var(--series-usd)"];

/** N serija s RAZLIČITIM datumskim mrežama. priceChart to ne može: ondje je x funkcija
    INDEKSA jedne zajedničke liste. Zato zasebna funkcija — priceChart se ne dira. */
function multiChart(series, scale = "log") {
  const pts = s => s.points.filter(p => p.avg != null);
  const live = series.filter(s => pts(s).length >= 2);
  if (!live.length) return `<div class="chart-box"><div class="chart-empty">
    Nijedno izdanje nema barem dvije točke povijesti.</div></div>`;

  const narrow = innerWidth < 640;
  const W = narrow ? 360 : 720, H = narrow ? 240 : 300;
  const padL = narrow ? 42 : 52, padR = narrow ? 8 : 14, padT = 10, padB = narrow ? 22 : 26;
  const fs = narrow ? 13 : 11;

  // indeks: svaka serija kreće od 100 → usporediva je oblikom, ne razinom
  const val = (s, p) => scale === "idx" ? (p.avg / pts(s)[0].avg) * 100 : p.avg;
  const tAll = live.flatMap(s => pts(s).map(p => Date.parse(p.d)));
  const t0 = Math.min(...tAll), tSpan = (Math.max(...tAll) - t0) || 1;
  const vAll = live.flatMap(s => pts(s).map(p => val(s, p))).filter(v => v > 0);
  let lo = Math.min(...vAll), hi = Math.max(...vAll);
  if (lo === hi) { lo *= 0.9; hi *= 1.1; }

  // Log os jer raspon unutar iste karte zna biti 10× i više (Sol Ring 0,40–129,95 €):
  // na linearnoj bi gotovo sve serije bile ravna crta na dnu — točno, a bez informacije.
  const useLog = scale === "log" && lo > 0;
  const f = v => useLog ? Math.log10(v) : v;
  const fLo = f(lo) - (f(hi) - f(lo)) * 0.06, fHi = f(hi) + (f(hi) - f(lo)) * 0.06;
  const x = ms => padL + ((ms - t0) / tSpan) * (W - padL - padR);
  const y = v => padT + (1 - (f(v) - fLo) / ((fHi - fLo) || 1)) * (H - padT - padB);

  let grid = "", labels = "";
  const ticks = narrow ? 3 : 4;
  for (let i = 0; i <= ticks; i++) {
    const fv = fLo + ((fHi - fLo) * i) / ticks;
    const v = useLog ? Math.pow(10, fv) : fv;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid)"/>`;
    labels += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end" fill="var(--muted)"
      font-size="${fs}" style="font-variant-numeric:tabular-nums">${
        scale === "idx" ? v.toFixed(0) : "€" + (v >= 10 ? v.toFixed(0) : v.toFixed(2))}</text>`;
  }
  const yr = ms => new Date(ms).getFullYear();
  for (let i = 0; i <= (narrow ? 2 : 5); i++) {
    const ms = t0 + (tSpan * i) / (narrow ? 2 : 5);
    labels += `<text x="${x(ms)}" y="${H - 6}" text-anchor="${
      i === 0 ? "start" : i === (narrow ? 2 : 5) ? "end" : "middle"}"
      fill="var(--muted)" font-size="${fs}">${yr(ms)}</text>`;
  }

  // Rupa u seriji NE smije se premostiti ravnom crtom — to je isti izmišljeni nagib
  // zbog kojeg je x-os prebačena s indeksa na datum. Serija koja počinje 2024. mora
  // POČETI 2024., a ne biti povučena unatrag do ruba grafa.
  const GAP_MS = 45 * 864e5;
  const paths = live.map((s, i) => {
    const P = pts(s);
    let d = "", prev = null;
    for (const p of P) {
      const ms = Date.parse(p.d);
      d += (prev == null || ms - prev > GAP_MS ? "M" : "L") + x(ms).toFixed(1) + " "
         + y(val(s, p)).toFixed(1) + " ";
      prev = ms;
    }
    const hot = i < RAMP.length;
    return `<path d="${d}" fill="none" stroke="${hot ? RAMP[i] : "var(--line-2)"}"
      stroke-width="${hot ? 1.8 : 1}" opacity="${hot ? 1 : 0.45}"
      stroke-linejoin="round" stroke-linecap="round"/>`;
  }).join("");

  const legend = live.slice(0, RAMP.length).map((s, i) =>
    `<span class="lg"><i style="background:${RAMP[i]}"></i>${esc(s.set || "?")} #${esc(s.cn || "")}${
      s.foil ? " foil" : ""}</span>`).join("");

  return `<div class="chart-box">
    <div class="chart-legend">${legend}${live.length > RAMP.length
      ? `<span class="lg"><i class="faint"></i>+${live.length - RAMP.length} ostalih izdanja</span>`
      : ""}</div>
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto" role="img"
      aria-label="Povijest cijena svih izdanja">
      ${grid}<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="var(--baseline)"/>
      ${paths}${labels}
    </svg>
    <p class="sub chart-note">${
      scale === "idx" ? "Svako izdanje kreće od 100 — uspoređuje se oblik, ne razina."
      : useLog ? "Logaritamska os: jednak razmak = jednak POSTOTNI pomak. Raspon među izdanjima je prevelik za linearnu."
      : "Linearna os — izdanja jeftinija od najskupljeg izgledaju spljošteno uz dno."}
      Prekid linije znači da izdanje tada nije imalo kotaciju; serija počinje kad je izdanje izašlo.</p>
  </div>`;
}

let chartState = null; // {points, series, geom} for the hover layer

function priceChart(points) {
  const series = seriesDefs()
    .map(s => ({ ...s, on: points.some(p => p[s.key] != null) }))
    .filter(s => s.on);
  if (points.length < 2 || !series.length) {
    return `<div class="chart-box"><div class="chart-empty">
      Premalo povijesti — graf se pojavi kad <code>update.py daily</code> odradi
      barem dva različita dana.</div></div>`;
  }

  // SVG se skalira na širinu spremnika, pa se s njim skalira i font osi: na 720px širokom
  // viewBoxu 11px oznaka na telefonu padne na ~5px. Uži viewBox = oznake ostaju čitljive.
  // ponytail: mjeri se pri renderu, ne prati rotaciju — okretanje telefona traži re-ulaz u karticu.
  const narrow = innerWidth < 640;
  const W = narrow ? 360 : 720, H = narrow ? 210 : 260;
  const padL = narrow ? 38 : 46, padR = narrow ? 8 : 14, padT = 10, padB = narrow ? 22 : 26;
  // Oznake osi su u koordinatama viewBoxa: 11 na uzem viewBoxu izlazi manje nego na sirem.
  // Ova vrijednost drzi obje varijante na ~12px stvarnih, koliko DESIGN.md trazi kao pod.
  const fs = narrow ? 13 : 11;
  const all = [];
  for (const s of series) for (const p of points) if (p[s.key] != null) all.push(p[s.key]);
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 0.5; max += 0.5; }
  const pad = (max - min) * 0.08;
  min = Math.max(0, min - pad); max += pad;

  // 🍌 Bilo je `i / (points.length - 1)` — razmak po INDEKSU točke, ne po datumu.
  // Snimci imaju rupe (07-21, 07-22, 07-24…), a crtali su se jednako razmaknuto:
  // rijetke i guste dionice izgledaju isto → nagib koji podaci ne podupiru.
  // To je grijeh #4 iz [[Pet grijeha nepoštene statistike]]. Os je sad vremenska.
  const t = i => Date.parse(points[i].d);
  const t0 = t(0), tSpan = (t(points.length - 1) - t0) || 1;
  const x = i => padL + ((t(i) - t0) / tSpan) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);

  const yTicks = narrow ? 3 : 4;
  let grid = "", labels = "";
  for (let t = 0; t <= yTicks; t++) {
    const v = min + ((max - min) * t) / yTicks;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid)"/>`;
    labels += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end"
      fill="var(--muted)" font-size="${fs}" style="font-variant-numeric:tabular-nums">€${v.toFixed(2)}</text>`;
  }
  const xtickEvery = Math.max(1, Math.ceil(points.length / (narrow ? 3 : 6)));
  points.forEach((p, i) => {
    if (i % xtickEvery === 0 || i === points.length - 1) {
      // Rubne oznake se sidre uz rub, ne centriraju: centrirana zadnja visi pola izvan
      // viewBoxa i SVG je odreze (na telefonu je od "07-27" ostajalo "07-2").
      const anchor = i === points.length - 1 ? "end" : i === 0 ? "start" : "middle";
      labels += `<text x="${x(i)}" y="${H - 8}" text-anchor="${anchor}"
        fill="var(--muted)" font-size="${fs}">${p.d.slice(5)}</text>`;
    }
  });

  const paths = series.map(s => {
    let d = "", started = false;
    points.forEach((p, i) => {
      if (p[s.key] == null) return;
      d += `${started ? "L" : "M"}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`;
      started = true;
    });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("");

  chartState = { points, series, W, H, padL, padR, x, y };

  const legend = series.length > 1 ? `<div class="legend">${series.map(s =>
    `<span class="key"><span class="swatch" style="background:${s.color}"></span>${s.label}</span>`
  ).join("")}</div>` : "";

  return `
    <div class="chart-box" id="chart">
      ${legend}
      <svg id="chart-svg" viewBox="0 0 ${W} ${H}" role="img"
        aria-label="Povijest cijene, ${points.length} snimaka od ${esc(points[0].d)} do ${esc(points[points.length - 1].d)}, raspon €${min.toFixed(2)}–€${max.toFixed(2)}"
        style="width:100%;height:auto;display:block">
        ${grid}
        <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--baseline)"/>
        ${labels}
        ${paths}
        <line id="crosshair" y1="${padT}" y2="${H - padB}" stroke="var(--baseline)"
          stroke-dasharray="3 3" visibility="hidden"/>
        <g id="dots"></g>
        <rect id="hover-zone" x="${padL}" y="${padT}" width="${W - padL - padR}"
          height="${H - padT - padB}" fill="transparent"/>
      </svg>
      <div class="chart-tip" id="chart-tip"></div>
    </div>`;
}

function attachChartHover() {
  const svg = document.getElementById("chart-svg");
  if (!svg || !chartState) return;
  const { points, series, W, padL, padR, x, y } = chartState;
  const zone = document.getElementById("hover-zone");
  const cross = document.getElementById("crosshair");
  const dots = document.getElementById("dots");
  const tip = document.getElementById("chart-tip");
  const box = document.getElementById("chart");

  function onMove(evt) {
    const rect = svg.getBoundingClientRect();
    const sx = ((evt.clientX - rect.left) / rect.width) * W;
    // Os je vremenska, pa indeks nije linearan u x — traži se najbliža točka po x.
    let i = 0;
    for (let k = 1, best = Math.abs(x(0) - sx); k < points.length; k++) {
      const d = Math.abs(x(k) - sx);
      if (d < best) { best = d; i = k; }
    }
    const p = points[i];
    const cx = x(i);
    cross.setAttribute("x1", cx);
    cross.setAttribute("x2", cx);
    cross.setAttribute("visibility", "visible");
    dots.innerHTML = series.map(s => p[s.key] == null ? "" :
      `<circle cx="${cx}" cy="${y(p[s.key])}" r="4" fill="${s.color}"
        stroke="var(--surface)" stroke-width="2"/>`).join("");
    tip.style.display = "block";
    tip.innerHTML = `<div class="d">${p.d}</div>` + series.map(s =>
      `<div class="v"><span class="swatch" style="background:${s.color};display:inline-block;width:10px;height:3px;border-radius:2px;margin-right:5px;vertical-align:3px"></span>${s.label}: ${p[s.key] == null ? "—" : "€" + p[s.key].toFixed(2)}</div>`).join("");
    const boxRect = box.getBoundingClientRect();
    let left = evt.clientX - boxRect.left + 14;
    if (left + tip.offsetWidth > boxRect.width - 8) left = left - tip.offsetWidth - 28;
    tip.style.left = left + "px";
    tip.style.top = (evt.clientY - boxRect.top - 10) + "px";
  }
  function onLeave() {
    cross.setAttribute("visibility", "hidden");
    dots.innerHTML = "";
    tip.style.display = "none";
  }
  zone.addEventListener("mousemove", onMove);
  zone.addEventListener("mouseleave", onLeave);
  // Touch: finger drag moves the crosshair, lifting keeps the last tooltip.
  const onTouch = (evt) => {
    if (evt.touches.length) {
      evt.preventDefault();
      onMove(evt.touches[0]);
    }
  };
  zone.addEventListener("touchstart", onTouch, { passive: false });
  zone.addEventListener("touchmove", onTouch, { passive: false });
}

boot();
