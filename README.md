# Precon Price Tracker

A local, MTGStocks-style website that tracks **Cardmarket prices for every card
in selected preconstructed Commander decks** — starting with:

| Deck | Commander | Set |
|---|---|---|
| The Hosts of Mordor | Sauron, Lord of the Rings | Tales of Middle-earth Commander (LTC) |
| Doom Prevails | Doctor Doom, King of Latveria | Marvel Super Heroes Commander |

Everything runs on your machine: Python scripts write JSON snapshots into
`data/`, and a static HTML/JS site in `site/` displays them — deck value
overview, sortable price tables, per-card price-history charts, and (optional)
scraped Cardmarket listings with card language, seller country, and the top
sellers in Croatia.

## Live site

**https://grgurgemini-spec.github.io/pokusaj/** — hosted on GitHub Pages and
mobile-friendly (on a phone you can "Add to Home Screen" to install it like an
app).

A GitHub Action (`.github/workflows/update-and-deploy.yml`) runs
`fetch_prices.py` **every day**, commits the new price snapshot to `main`, and
redeploys the site — the price-history charts grow automatically. To refresh
right now: GitHub → *Actions* → *Update prices & deploy site* → *Run workflow*.
If you run the listings scraper locally, commit and push `data/listings.json`
and the next deploy will show the listings online too.

You can still run everything fully locally instead:

## Quick start (local)

Python 3.9+ is all you need for the core workflow (no packages required).

```bash
# 1. Fetch prices (first run also downloads the decklists automatically)
python fetch_prices.py

# 2. Serve the project root and open the site
python -m http.server 8000
# → http://localhost:8000/site/
```

Run `python fetch_prices.py` once a day to build up the price-history charts —
each run appends one dated price point per card. Automate it if you like:

* **Linux/macOS (cron):** `0 9 * * * cd /path/to/pokusaj && python fetch_prices.py`
* **Windows:** Task Scheduler → run `python fetch_prices.py` daily in the repo folder.

## Where the prices come from

* **Cardmarket EUR trend + foil trend** and **TCGplayer USD** come from the
  free [Scryfall API](https://scryfall.com/docs/api), which republishes them
  daily. This is 100% reliable and fair-use.
* Cardmarket has **no public API**, so per-listing details (the 10 cheapest
  offers, card language, seller country, Croatian sellers) can only be read
  from Cardmarket's own web pages — see the scraper below.

## Decklists

Deck files live in `decks/*.txt` — one card per line (`1 Sauron, Lord of the
Rings [ltc]`), with metadata in `#` header comments. Files that contain only
headers are **synced automatically** on the first `fetch_prices.py` run from
the deck sources declared in their `# source:` headers (Archidekt →
MTGGoldfish → Moxfield, first one that works).

* Refresh a decklist: `python fetch_prices.py --sync-decks`
* Track another deck: drop a new `.txt` into `decks/` — either paste the card
  list yourself or just add `# source: archidekt:<deck-id>` (or
  `mtggoldfish:<id>` / `moxfield:<public-id>`) and let the sync fill it in.

## Optional: Cardmarket listings scraper

`scrape_cardmarket.py` visits each card's Cardmarket page with a real browser
(Playwright) and saves the 10 cheapest listings (price, language, seller
country, condition, quantity, seller name) plus the 3 cheapest offers from
sellers in Croatia into `data/listings.json`. The card pages on the site pick
this up automatically.

> **⚠️ Read this first:** Cardmarket's terms of service do not allow automated
> scraping, and the site is protected by Cloudflare. This script is for
> **personal, low-volume use at your own risk** — it is deliberately slow
> (several seconds per card, ~200 cards ≈ 20+ minutes), stops after repeated
> failures, and may break whenever Cardmarket changes its pages. The rest of
> the tracker works fine without it.

### Croatian sellers - quick start 🇭🇷

On **your own computer** (it will not work from cloud servers):

```bash
git clone https://github.com/grgurgemini-spec/pokusaj && cd pokusaj
pip install playwright && playwright install chromium

# Croatian listings for every card worth at least 1 EUR (~1 page/card):
python scrape_cardmarket.py --croatia-only --min-eur 1 --headed
```

On Windows you can simply double-click **`scrape_croatia.bat`** - it installs
what's needed and runs the command above.

When it finishes (or whenever you stop it - progress is saved after every
card, and re-running skips anything scraped in the last 20 h), publish the
results to the live site:

```bash
git add data/listings.json
git commit -m "Update listings"
git push
```

The push triggers the deploy workflow and each card's page on the site shows
its listings and the "Top sellers in Croatia" panel.

### More scraper options

```bash
python scrape_cardmarket.py --limit 10          # try a few cards first
python scrape_cardmarket.py --deck doom-prevails
python scrape_cardmarket.py --card "Sauron, Lord of the Rings"
python scrape_cardmarket.py                     # full mode: 10 cheapest
                                                # listings + Croatia per card
python scrape_cardmarket.py --force             # ignore the 20h freshness skip
```

`--headed` (visible browser window) noticeably helps against Cloudflare's bot
checks. Basic lands are always skipped. If the script can't find listing rows,
it saves the page HTML into `data/scrape_debug/` so the selectors can be
fixed.

## Project layout

```
decks/        decklists (auto-synced on first run)
data/         generated JSON: cards.json, history.json, listings.json
site/         the website (vanilla HTML/JS/CSS, no build step, no CDN)
fetch_prices.py       daily price fetcher (Scryfall, stdlib only)
scrape_cardmarket.py  optional listings scraper (Playwright)
```

## Extending to other marketplaces

Prices are namespaced by source (`prices.cardmarket.*`, `prices.tcgplayer.*`)
in `data/cards.json`, so adding another site later (e.g. Cardkingdom, or a
different scraper) means writing one more fetcher that fills in
`prices.<newsource>` — the data model already supports it.
