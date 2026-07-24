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
};

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
    state.catalog = { sets: [{ code: "", icon: null, name: "Tracked decks", decks: state.cards.decks }] };
  }

  const when = state.cards.generated_at ? new Date(state.cards.generated_at) : null;
  if (when) $updated.textContent = "prices from " + when.toLocaleString();
  $nav.innerHTML = `<a href="#/" data-home="1">📚 Katalog</a>` + state.catalog.sets
    .map(s => `<a href="#/set/${s.code}" data-set="${s.code}"
      class="${setTracked(s) ? "" : "dim"}">${esc(shortSetName(s))}</a>`)
    .join("");

  wireUpdateButton();
  window.addEventListener("hashchange", render);
  render();
}

/* ---------------- helpers ---------------- */

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g,
    c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
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
    const p = c.prices.cardmarket.eur;
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
  $nav.querySelectorAll("a").forEach(a => a.classList.toggle("active",
    (route === "set" && a.dataset.set === arg) ||
    (deckSet && a.dataset.set === deckSet.code) ||
    (!["set", "deck", "card"].includes(route) && a.dataset.home)));
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
      <h1>Almost there — no price data yet</h1>
      <p class="sub">(${esc(err.message)})</p>
      <p>This site reads local JSON snapshots. Generate them once:</p>
      <ol>
        <li>Run the price fetcher — plain Python 3, nothing to install
            (it downloads the decklists automatically on the first run):
          <pre>python fetch_prices.py</pre></li>
        <li>Serve the project root and open the site:
          <pre>python -m http.server 8000
# then visit http://localhost:8000/site/</pre></li>
        <li>Optional — seller listings &amp; Croatian sellers (see README caveats):
          <pre>pip install playwright &amp;&amp; playwright install chromium
python scrape_cardmarket.py --limit 10</pre></li>
      </ol>
      <p>Run <code>python fetch_prices.py</code> daily (or via a scheduler) to
         build up the price-history charts.</p>
    </div>`;
}

function deckTile(deck) {
  const { total, priced } = deckTotal(deck);
  const hist = deckHistory(deck.id);
  const d1 = pctChange(hist, "eur", 1);
  const d7 = pctChange(hist, "eur", 7);
  return `
    <a class="deck-tile" href="#/deck/${deck.id}">
      <h3>${esc(deck.name)}</h3>
      <div class="cmd">${esc(deck.commander || "")} · ${deck.cards.length} cards (${priced} priced)</div>
      <div class="deck-meta">
        <span class="value">€${total.toFixed(2)} <small>Cardmarket trend</small></span>
      </div>
      <div class="deck-meta">
        <span>1d ${deltaHtml(d1)}</span>
        <span>7d ${deltaHtml(d7)}</span>
      </div>
      <div class="spark">${sparkline(hist.map(p => p.eur), 300, 46)}</div>
    </a>`;
}

function deckTileOff(entry) {
  return `
    <div class="deck-tile off">
      <h3>${esc(entry.name)}</h3>
      <div class="cmd">${esc(entry.commander || "")}</div>
      <div class="soon">Not tracked yet</div>
    </div>`;
}

function setTracked(set) {
  return set.decks.filter(e => e.id && findDeck(e.id)).length;
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
        <h3>${esc(set.name)}</h3>
        <div class="set-sub">${esc(set.released || year)} ·
          ${tracked ? `${tracked}/${set.decks.length} decks tracked` : "not tracked yet"}</div>
        ${hits.length ? `<div class="hit-list">${hits.map(h => esc(h.name)).join(" · ")}</div>` : ""}
      </a>`;
  }).join("");

  const totalDecks = state.catalog.sets.reduce((n, s) => n + s.decks.length, 0);
  const snapshots = Object.values(state.history?.decks || {})[0]?.length || 0;
  $app.innerHTML = `
    <h1>Katalog</h1>
    <p class="sub">${state.catalog.sets.length} Commander precon sets ·
      ${totalDecks} decks (2011 → today). Pick a set to see its decks and
      Cardmarket prices; greyed sets aren't tracked yet.
      ${snapshots >= 2 ? `${snapshots} daily price snapshots collected.` : ""}</p>
    <div class="toolbar">
      <input id="cat-q" type="search" placeholder="Traži set, deck ili commandera…"
        value="${esc(ui.q)}">
      <select id="cat-sort">
        <option value="1" ${ui.dir === 1 ? "selected" : ""}>Najstariji prvo</option>
        <option value="-1" ${ui.dir === -1 ? "selected" : ""}>Najnoviji prvo</option>
      </select>
      <label class="check"><input id="cat-tracked" type="checkbox"
        ${ui.trackedOnly ? "checked" : ""}> samo praćeni</label>
      <span class="count">${sets.length} / ${state.catalog.sets.length} sets</span>
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
  if (!set) { $app.innerHTML = `<p>Unknown set.</p>`; return; }
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
        <h1 style="font-size:22px;margin:0">${esc(set.name)}</h1>
        <div class="set-sub">${esc(set.released || "")}${set.released ? " · " : ""}${tracked}/${set.decks.length} decks tracked</div>
      </div>
    </div>
    <div class="deck-grid" style="margin-top:16px">${tiles}</div>`;
}

/* ---------------- manual price update (GitHub workflow dispatch) ---------- */

const GH_REPO = "grgurgemini-spec/pokusaj";
const GH_WORKFLOW = "update-and-deploy.yml";

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

async function dispatchUpdate(btn) {
  const token = localStorage.getItem("gh_token");
  if (!token) return showTokenPanel();
  btn.disabled = true;
  btn.textContent = "⏳ Pokrećem…";
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GH_REPO}/actions/workflows/${GH_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ref: "main" }),
      });
    if (res.status === 204) {
      toast("✅ Update pokrenut! Svježe Cardmarket cijene bit će live za ~2–3 min " +
            "(i spremljene u povijest/statistiku). Onda osvježi stranicu.", 10000);
    } else if (res.status === 401 || res.status === 403) {
      localStorage.removeItem("gh_token");
      toast("❌ Token ne vrijedi ili nema ovlasti (Actions: write). Unesi novi.");
      showTokenPanel();
    } else {
      toast(`❌ GitHub je vratio HTTP ${res.status}.`);
    }
  } catch (e) {
    toast("❌ Ne mogu do GitHuba: " + esc(e.message));
  }
  btn.disabled = false;
  btn.textContent = "⟳ Update";
}

function showTokenPanel() {
  document.getElementById("update-panel").hidden = false;
}

function wireUpdateButton() {
  const btn = document.getElementById("update-btn");
  const panel = document.getElementById("update-panel");
  if (!btn) return;
  btn.addEventListener("click", () => {
    if (!localStorage.getItem("gh_token")) {
      panel.hidden = !panel.hidden;
    } else {
      dispatchUpdate(btn);
    }
  });
  document.getElementById("token-save").addEventListener("click", () => {
    const v = document.getElementById("token-input").value.trim();
    if (!v) return;
    localStorage.setItem("gh_token", v);
    document.getElementById("token-input").value = "";
    panel.hidden = true;
    dispatchUpdate(btn);
  });
}

function renderDeck(deckId) {
  const deck = state.cards.decks.find(d => d.id === deckId);
  if (!deck) { $app.innerHTML = `<p>Unknown deck.</p>`; return; }

  const sort = state.sort[deckId] || { key: "eur", dir: -1 };
  const filter = (state.filter[deckId] || "").toLowerCase();

  const rows = deck.cards
    .map(c => ({
      c,
      eur: c.prices.cardmarket.eur,
      foil: c.prices.cardmarket.eur_foil,
      usd: c.prices.tcgplayer.usd,
      d7: pctChange(cardHistory(c.id), "eur", 7),
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
  $app.innerHTML = `
    <a class="backlink" href="${parentSet ? `#/set/${parentSet.code}` : "#/"}">← ${esc(parentSet ? parentSet.name : "Katalog")}</a>
    <h1>${esc(deck.name)}</h1>
    <p class="sub">${esc(deck.commander || "")} · set ${esc((deck.set || deck.cards[0]?.set || "?").toUpperCase())}
       · deck value <strong>€${total.toFixed(2)}</strong> (Cardmarket trend)</p>
    <div class="toolbar">
      <input id="filter" type="search" placeholder="Filter cards…" value="${esc(state.filter[deckId] || "")}">
      <span class="count">${rows.length} / ${deck.cards.length} cards</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          ${th("name", "Card")}${th("rarity", "Rarity", false, "col-rarity")}
          ${th("eur", "EUR trend", true)}${th("foil", "Foil EUR", true, "col-foil")}
          ${th("usd", "USD", true, "col-usd")}${th("d7", "7d", true)}
          <th class="col-cm"></th>
        </tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr data-card="${r.c.id}">
              <td class="cardcell">
                ${r.c.image ? `<img loading="lazy" src="${esc(r.c.image)}" alt="">` : ""}
                <span><span class="cn">${esc(r.c.name)}</span>${r.c.qty > 1 ? ` ×${r.c.qty}` : ""}<br>
                <span class="ct">${esc(r.c.type_line || "")}</span></span>
              </td>
              <td class="col-rarity"><span class="rarity ${esc(r.c.rarity)}">${esc(r.c.rarity || "")}</span></td>
              <td class="num">${fmtEur(r.eur)}</td>
              <td class="num col-foil">${fmtEur(r.foil)}</td>
              <td class="num col-usd">${fmtUsd(r.usd)}</td>
              <td class="num">${deltaHtml(r.d7, { arrow: false })}</td>
              <td class="col-cm">${r.c.cardmarket_url
                ? `<a class="ext" href="${esc(r.c.cardmarket_url)}" target="_blank" rel="noopener"
                     title="Open on Cardmarket">CM ↗</a>` : ""}</td>
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
      const cur = state.sort[deckId] || { key: "eur", dir: -1 };
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
  if (!hit) { $app.innerHTML = `<p>Unknown card.</p>`; return; }
  const { card, deck } = hit;
  const cm = card.prices.cardmarket, tp = card.prices.tcgplayer;
  const points = cardHistory(card.id);
  const d1 = pctChange(points, "eur", 1);
  const d7 = pctChange(points, "eur", 7);
  const d30 = pctChange(points, "eur", 30);

  const listing = state.listings?.cards?.[card.id];

  $app.innerHTML = `
    <a class="backlink" href="#/deck/${deck.id}">← ${esc(deck.name)}</a>
    <div class="card-page">
      <div class="art">
        ${card.image ? `<img src="${esc(card.image)}" alt="${esc(card.name)}">` : ""}
        ${card.cardmarket_url
          ? `<a class="buy-btn" href="${esc(card.cardmarket_url)}" target="_blank" rel="noopener">
               View on Cardmarket ↗</a>` : ""}
      </div>
      <div>
        <h1>${esc(card.name)}</h1>
        <p class="sub">${esc(card.type_line || "")} ·
          <span class="rarity ${esc(card.rarity)}">${esc(card.rarity || "")}</span> ·
          ${esc((card.set || "").toUpperCase())} #${esc(card.collector_number || "?")}</p>

        <div class="stat-row">
          <div class="stat"><div class="lbl">Cardmarket trend</div>
            <div class="val">${fmtEur(cm.eur)}</div></div>
          <div class="stat"><div class="lbl">Foil trend</div>
            <div class="val">${fmtEur(cm.eur_foil)}</div></div>
          <div class="stat"><div class="lbl">TCGplayer</div>
            <div class="val">${fmtUsd(tp.usd)}</div></div>
          <div class="stat"><div class="lbl">1d / 7d / 30d</div>
            <div class="val" style="font-size:15px">
              ${deltaHtml(d1, { arrow: false })} / ${deltaHtml(d7, { arrow: false })} / ${deltaHtml(d30, { arrow: false })}
            </div></div>
        </div>

        <h2>Price history <small style="color:var(--muted);font-weight:400">(EUR, Cardmarket trend)</small></h2>
        ${priceChart(points)}

        ${listingsSection(card, listing)}
      </div>
    </div>`;

  attachChartHover();
}

/* ---------------- listings ---------------- */

function listingsSection(card, listing) {
  if (!listing) {
    return `
      <h2>Cheapest listings</h2>
      <div class="listing-note">
        No scraped listings for this card yet. Listing details (10 cheapest offers
        with card language and seller country, plus the top Croatian sellers) come
        from the optional scraper:
        <code>python scrape_cardmarket.py --card "${esc(card.name)}"</code> —
        see the README for the caveats before using it.
      </div>`;
  }
  const table = (rows) => rows.length ? `
    <div class="table-wrap">
      <table class="listings-table">
        <thead><tr><th>#</th><th>Price</th><th>Language</th><th>Seller country</th>
          <th class="col-cond">Cond.</th><th class="col-qty">Qty</th><th>Seller</th></tr></thead>
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
    </div>` : `<div class="listing-note">No offers found.</div>`;

  return `
    <h2>10 cheapest listings</h2>
    ${table(listing.cheapest || [])}
    <h2>Top sellers in Croatia <span class="hr-badge">HR</span></h2>
    ${table(listing.croatia || [])}
    <div class="stale">Listings snapshot from ${esc(listing.scraped_at || "?")}
      — refresh with <code>python scrape_cardmarket.py --card "${esc(card.name)}"</code></div>`;
}

/* ---------------- charts (inline SVG) ---------------- */

const SERIES_DEFS = [
  { key: "eur", label: "Nonfoil", color: "var(--series-eur)" },
  { key: "eur_foil", label: "Foil", color: "var(--series-foil)" },
];

function sparkline(values, w, h) {
  const vals = values.filter(v => v != null);
  if (vals.length < 2) {
    return `<svg width="${w}" height="${h}"><line x1="0" y1="${h - 6}" x2="${w}" y2="${h - 6}"
      stroke="var(--baseline)" stroke-dasharray="3 4"/><text x="0" y="${h - 12}"
      fill="var(--muted)" font-size="11">history builds up with daily runs</text></svg>`;
  }
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = (max - min) || 1;
  const pts = vals.map((v, i) => [
    (i / (vals.length - 1)) * (w - 4) + 2,
    h - 4 - ((v - min) / span) * (h - 10),
  ]);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  return `<svg width="${w}" height="${h}" role="img" aria-label="deck value trend">
    <path d="${d}" fill="none" stroke="var(--series-eur)" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

let chartState = null; // {points, series, geom} for the hover layer

function priceChart(points) {
  const series = SERIES_DEFS
    .map(s => ({ ...s, on: points.some(p => p[s.key] != null) }))
    .filter(s => s.on);
  if (points.length < 2 || !series.length) {
    return `<div class="chart-box"><div class="chart-empty">
      Not enough history yet — the chart appears once <code>fetch_prices.py</code>
      has run on at least two different days.</div></div>`;
  }

  const W = 720, H = 260, padL = 46, padR = 14, padT = 10, padB = 26;
  const all = [];
  for (const s of series) for (const p of points) if (p[s.key] != null) all.push(p[s.key]);
  let min = Math.min(...all), max = Math.max(...all);
  if (min === max) { min -= 0.5; max += 0.5; }
  const pad = (max - min) * 0.08;
  min = Math.max(0, min - pad); max += pad;

  const x = i => padL + (i / (points.length - 1)) * (W - padL - padR);
  const y = v => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);

  const yTicks = 4;
  let grid = "", labels = "";
  for (let t = 0; t <= yTicks; t++) {
    const v = min + ((max - min) * t) / yTicks;
    const yy = y(v);
    grid += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="var(--grid)"/>`;
    labels += `<text x="${padL - 8}" y="${yy + 4}" text-anchor="end"
      fill="var(--muted)" font-size="11" style="font-variant-numeric:tabular-nums">€${v.toFixed(2)}</text>`;
  }
  const xtickEvery = Math.max(1, Math.ceil(points.length / 6));
  points.forEach((p, i) => {
    if (i % xtickEvery === 0 || i === points.length - 1) {
      labels += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle"
        fill="var(--muted)" font-size="11">${p.d.slice(5)}</text>`;
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
      <svg id="chart-svg" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">
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
