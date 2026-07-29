/* Precon Price Tracker — vanilla JS single-page app.
   Reads static JSON produced by fetch_prices.py / scrape_cardmarket.py. */

"use strict";

const state = {
  cards: null,      // data/cards.json
  history: null,    // data/history.json
  listings: null,   // data/listings.json (optional)
  catalog: null,    // catalog.json - all known precons grouped by set
  sort: {},         // per-deck sort state: {key, dir}
  filter: {},       // per-deck text filter
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
  $nav.innerHTML = `<a href="#/" data-home="1">Katalog</a>` + state.catalog.sets
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

const fmtEur = v => v == null ? `<span class="price-na">—</span>` : `€${v.toFixed(2)}`;
const fmtUsd = v => v == null ? `<span class="price-na">—</span>` : `$${v.toFixed(2)}`;

function deltaHtml(pct, { arrow = true } = {}) {
  if (pct == null) return `<span class="delta flat">—</span>`;
  const cls = pct > 0.001 ? "up" : pct < -0.001 ? "down" : "flat";
  const sym = !arrow ? "" : pct > 0.001 ? "▲ " : pct < -0.001 ? "▼ " : "";
  return `<span class="delta ${cls}">${sym}${pct > 0 ? "+" : ""}${pct.toFixed(1)}%</span>`;
}

/** % change between the last point and the closest point >= `days` back. */
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
  if (!base) base = points.find(p => p[key] != null && p !== last) || null;
  if (!base || base[key] === 0 || base === last) return null;
  return ((last[key] - base[key]) / base[key]) * 100;
}

function cardHistory(id) {
  return state.history?.cards?.[id]?.points || [];
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
  let t = 0, priced = 0;
  for (const c of deck.cards) {
    const p = c.prices.cardmarket[priceKey()];
    if (p != null) { t += p * c.qty; priced++; }
  }
  return { total: t, priced };
}

/* ---------------- router ---------------- */

function render() {
  const hash = location.hash || "#/";
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
    (!["set", "deck", "card"].includes(route) && a.dataset.home))));
  window.scrollTo(0, 0);
  if (route === "deck" && arg) return renderDeck(decodeURIComponent(arg));
  if (route === "card" && arg) return renderCard(decodeURIComponent(arg));
  if (route === "set" && arg) return renderSet(arg);
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
      <div class="spark">${sparkline(hist.map(p => p[priceKey()]), 300, 46)}</div>
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
      price: c.prices.cardmarket[priceKey()],
      foil: c.prices.cardmarket.eur_foil,
      usd: c.prices.tcgplayer.usd,
      d7: pctChange(cardHistory(c.id), priceKey(), 7),
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
              <td class="num col-price">${fmtEur(r.price)}</td>
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

function renderCard(cardId) {
  const hit = findCard(cardId);
  if (!hit) { $app.innerHTML = `<p>Nepoznata karta.</p>`; return; }
  const { card, deck } = hit;
  const cm = card.prices.cardmarket, tp = card.prices.tcgplayer;
  const points = cardHistory(card.id);
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
      </div>
      <div>
        <h1>${esc(card.name)}</h1>
        <p class="sub">${esc(card.type_line || "")} ·
          <span class="rarity ${esc(card.rarity)}">${esc(card.rarity || "")}</span> ·
          ${esc((card.set || "").toUpperCase())} #${esc(card.collector_number || "?")}</p>

        <div class="stat-row">
          <div class="stat"><div class="lbl">Cardmarket ${priceLabel()}</div>
            <div class="val">${fmtEur(cm[priceKey()])}</div></div>
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

        ${state.listings ? listingsSection(card, listing) : ""}
      </div>
    </div>`;

  attachChartHover();
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

function sparkline(values, w, h) {
  const vals = values.filter(v => v != null);
  if (vals.length < 2) {
    return `<svg width="${w}" height="${h}"><line x1="0" y1="${h - 6}" x2="${w}" y2="${h - 6}"
      stroke="var(--baseline)" stroke-dasharray="3 4"/><text x="0" y="${h - 12}"
      fill="var(--muted)" font-size="11">povijest raste sa svakim dnevnim snimkom</text></svg>`;
  }
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const pts = vals.map((v, i) => [
    (i / (vals.length - 1)) * (w - 4) + 2,
    h - 4 - ((v - min) / span) * (h - 10),
  ]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const last = pts[pts.length - 1];
  return `<svg width="${w}" height="${h}" role="img"
      aria-label="Kretanje vrijednosti decka, ${vals.length} snimaka, €${vals[0].toFixed(2)} → €${vals[vals.length - 1].toFixed(2)}">
    <path d="${d}" fill="none" stroke="var(--series-eur)" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="2.5" fill="var(--series-eur)"/></svg>`;
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

  const x = i => padL + (i / (points.length - 1)) * (W - padL - padR);
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
    const frac = (sx - padL) / (W - padL - padR);
    const i = Math.max(0, Math.min(points.length - 1, Math.round(frac * (points.length - 1))));
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
