#!/usr/bin/env python3
"""Best-effort Cardmarket listings scraper (optional, runs on YOUR machine).

For cards in data/cards.json this visits their Cardmarket product pages and
records:
  * the 10 cheapest listings  - price, card language, seller country,
    condition, seller name, quantity
  * the 3 cheapest listings from sellers located in Croatia

Results are merged into data/listings.json, which the site displays on each
card's detail page. Commit & push data/listings.json and the live site picks
it up on the next deploy.

IMPORTANT
  Cardmarket has no public API and its terms of service do not allow
  automated scraping. This script exists for personal, low-volume use on
  your own machine, at your own risk. It is deliberately slow (random
  multi-second delays), it stops on repeated failures, and everything else
  in this project keeps working when it fails - Cloudflare or a page
  redesign can break it at any time. It will NOT work from cloud servers
  (GitHub Actions etc.) - run it at home, ideally with --headed.

Setup (once):
  pip install playwright
  playwright install chromium

Typical use (Croatian sellers for all cards worth at least 1 EUR):
  python scrape_cardmarket.py --croatia-only --min-eur 1 --headed

Other examples:
  python scrape_cardmarket.py --limit 5 --headed     # try a few cards first
  python scrape_cardmarket.py --deck doom-prevails
  python scrape_cardmarket.py --card "Sauron, Lord of the Rings"
  python scrape_cardmarket.py --force                # re-scrape fresh data

Interrupted? Just run it again - cards scraped in the last 20 hours are
skipped automatically (override with --force).
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import random
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_DIR = ROOT / "data"
DEBUG_DIR = DATA_DIR / "scrape_debug"

MAX_CONSECUTIVE_FAILURES = 3
LISTINGS_PER_CARD = 10
CROATIA_LISTINGS = 3

ROW_SELECTOR = ".article-table .article-row, div[id^='articleRow']"

CROATIA_NAMES = {"croatia", "hrvatska", "kroatien", "croatie", "croazia"}

KNOWN_LANGS = ("English", "German", "French", "Italian", "Spanish",
               "Portuguese", "Japanese", "Korean", "Russian",
               "Simplified Chinese", "Traditional Chinese")


def polite_sleep():
    time.sleep(random.uniform(3.0, 7.0))


def txt(el) -> str:
    try:
        return re.sub(r"\s+", " ", el.inner_text()).strip()
    except Exception:
        return ""


def tooltip(el) -> str:
    """Cardmarket encodes language/country in icon tooltips."""
    for attr in ("data-original-title", "data-bs-original-title", "title",
                 "aria-label", "data-tooltip"):
        try:
            v = el.get_attribute(attr)
        except Exception:
            v = None
        if v:
            return re.sub(r"<[^>]+>", " ", v).strip()
    return ""


def parse_price(text: str) -> float | None:
    # "1.234,56 €" -> 1234.56   (also tolerates "1,234.56" just in case)
    m = re.search(r"(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})(?!\d)", text)
    if m:
        return float(m.group(1).replace(".", "") + "." + m.group(2))
    m = re.search(r"(\d+)\.(\d{2})(?!\d)", text)
    if m:
        return float(m.group(0))
    return None


def is_croatia(country: str | None) -> bool:
    return bool(country) and country.strip().lower() in CROATIA_NAMES


def parse_row(row) -> dict | None:
    listing: dict = {"seller": None, "country": None, "language": None,
                     "condition": None, "price": None, "qty": None}

    seller_el = row.query_selector(".seller-name a, .seller-info a")
    if seller_el:
        listing["seller"] = txt(seller_el)

    # Seller country: an icon in the seller column whose tooltip reads
    # "Item location: <Country>" (wording differs by UI language, keep loose).
    for icon in row.query_selector_all(
            ".seller-info .icon, .seller-name .icon, .seller-info span[class*='flag']"):
        tip = tooltip(icon)
        if not tip:
            continue
        m = re.search(r"(?:location|ships? from|versandort|artikelstandort)"
                      r"\s*:?\s*(.+)", tip, re.I)
        if m:
            listing["country"] = m.group(1).strip()
            break
        # Some layouts put just the country name in the tooltip.
        if tip.lower() in CROATIA_NAMES or (len(tip.split()) <= 3
                                            and tip[:1].isupper()
                                            and tip not in KNOWN_LANGS):
            listing["country"] = tip
            break

    cond_el = row.query_selector(".article-condition .badge, a.article-condition")
    if cond_el:
        listing["condition"] = txt(cond_el)

    # Card language: icon tooltip in the product attributes column.
    for icon in row.query_selector_all(".product-attributes .icon"):
        tip = tooltip(icon)
        for lang in KNOWN_LANGS:
            if tip == lang or lang.lower() in tip.lower():
                listing["language"] = lang
                break
        if listing["language"]:
            break

    price_el = row.query_selector(".price-container")
    if price_el:
        listing["price"] = parse_price(txt(price_el))

    qty_el = row.query_selector(".amount-container .item-count, .amount-container")
    if qty_el:
        m = re.search(r"\d+", txt(qty_el))
        listing["qty"] = int(m.group()) if m else None

    if listing["price"] is None:
        return None
    return listing


def extract_listings(page, limit: int) -> list[dict]:
    out = []
    for row in page.query_selector_all(ROW_SELECTOR):
        listing = parse_row(row)
        if listing:
            out.append(listing)
        if len(out) >= limit:
            break
    return out


def resolve_croatia_id(page) -> str | None:
    """Read Cardmarket's numeric id for Croatia from the seller-country filter."""
    for opt in page.query_selector_all("select[name='sellerCountry'] option"):
        if txt(opt).lower() in CROATIA_NAMES:
            return opt.get_attribute("value")
    return None


def looks_blocked(page) -> bool:
    try:
        title = (page.title() or "").lower()
    except Exception:
        return True
    return any(s in title for s in ("just a moment", "attention required",
                                    "access denied", "cloudflare"))


def wait_out_challenge(page, seconds: int = 30) -> bool:
    """Give a Cloudflare interstitial time to clear (works best with --headed).
    Returns True if the page is usable afterwards."""
    waited = 0
    while looks_blocked(page) and waited < seconds:
        page.wait_for_timeout(2000)
        waited += 2
    return not looks_blocked(page)


def base_url(card) -> str | None:
    url = card.get("cardmarket_url")
    return url.split("?")[0] if url else None


def scrape_card(page, card, croatia_id_cache: dict, croatia_only: bool,
                previous: dict | None) -> dict | None:
    url = base_url(card)
    if not url:
        print("    no Cardmarket URL, skipping")
        return None

    result = {
        "name": card["name"],
        "url": url,
        "scraped_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "cheapest": (previous or {}).get("cheapest", []),
        "croatia": [],
    }

    croatia_id = croatia_id_cache.get("croatia")
    need_unfiltered = (not croatia_only) or croatia_id is None

    if need_unfiltered:
        page.goto(url, wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(2500)
        if not wait_out_challenge(page):
            raise RuntimeError("blocked by Cloudflare / bot protection "
                               "(try --headed, or try again later)")
        try:
            page.wait_for_selector(ROW_SELECTOR, timeout=15_000)
        except Exception:
            DEBUG_DIR.mkdir(parents=True, exist_ok=True)
            dump = DEBUG_DIR / (re.sub(r"\W+", "_", card["name"])[:60] + ".html")
            dump.write_text(page.content(), encoding="utf-8")
            raise RuntimeError(f"no listing rows found (page layout changed? "
                               f"HTML saved to {dump})")
        if not croatia_only:
            result["cheapest"] = extract_listings(page, LISTINGS_PER_CARD)
        if croatia_id is None:
            croatia_id = resolve_croatia_id(page)
            if croatia_id:
                croatia_id_cache["croatia"] = croatia_id
                print(f"    (Cardmarket country id for Croatia: {croatia_id})")

    if croatia_id:
        if need_unfiltered:
            polite_sleep()
        page.goto(f"{url}?sellerCountry={croatia_id}",
                  wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(2500)
        if wait_out_challenge(page):
            try:
                page.wait_for_selector(ROW_SELECTOR, timeout=10_000)
                result["croatia"] = extract_listings(page, CROATIA_LISTINGS)
            except Exception:
                pass  # simply no Croatian sellers for this card
    else:
        # Couldn't find the country filter: fall back to filtering whatever
        # the unfiltered page showed.
        result["croatia"] = [l for l in result["cheapest"]
                             if is_croatia(l.get("country"))][:CROATIA_LISTINGS]
    return result


def is_fresh(entry: dict | None, hours: float) -> bool:
    if not entry or not entry.get("scraped_at"):
        return False
    try:
        ts = dt.datetime.fromisoformat(entry["scraped_at"])
    except ValueError:
        return False
    age = dt.datetime.now(dt.timezone.utc) - ts
    return age.total_seconds() < hours * 3600


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--deck", help="only scrape cards of this deck id")
    ap.add_argument("--card", help="only scrape the card with this exact name")
    ap.add_argument("--limit", type=int, help="stop after N cards")
    ap.add_argument("--min-eur", type=float, default=0.0,
                    help="skip cards whose Cardmarket trend is below this "
                         "(e.g. --min-eur 1 skips bulk, saves a LOT of time)")
    ap.add_argument("--croatia-only", action="store_true",
                    help="only fetch the Croatian-sellers view (1 page per "
                         "card instead of 2); keeps any previously scraped "
                         "cheapest-listings data")
    ap.add_argument("--refresh-hours", type=float, default=20,
                    help="skip cards scraped within the last N hours "
                         "(default 20; use --force to ignore)")
    ap.add_argument("--force", action="store_true",
                    help="re-scrape even recently scraped cards")
    ap.add_argument("--headed", action="store_true",
                    help="show the browser window (helps pass bot checks)")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright is not installed. Run:\n"
              "  pip install playwright\n  playwright install chromium")
        return 1

    cards_path = DATA_DIR / "cards.json"
    if not cards_path.exists():
        print("data/cards.json not found - run `python fetch_prices.py` first "
              "(or git pull, the daily workflow commits it).")
        return 1
    cards_data = json.loads(cards_path.read_text(encoding="utf-8"))

    listings_path = DATA_DIR / "listings.json"
    listings = (json.loads(listings_path.read_text(encoding="utf-8"))
                if listings_path.exists() else {"cards": {}})
    listings.setdefault("cards", {})

    todo, seen = [], set()
    skipped_fresh = skipped_cheap = 0
    for deck in cards_data["decks"]:
        if args.deck and deck["id"] != args.deck:
            continue
        for card in deck["cards"]:
            if args.card and card["name"].lower() != args.card.lower():
                continue
            if card["id"] in seen:
                continue
            seen.add(card["id"])
            if not args.card:
                # Basics are never worth listing-level tracking.
                if "Basic Land" in (card.get("type_line") or ""):
                    continue
                eur = card["prices"]["cardmarket"]["eur"]
                if args.min_eur and (eur is None or eur < args.min_eur):
                    skipped_cheap += 1
                    continue
                if not args.force and is_fresh(listings["cards"].get(card["id"]),
                                               args.refresh_hours):
                    skipped_fresh += 1
                    continue
            todo.append(card)
    todo = todo[: args.limit] if args.limit else todo

    if skipped_cheap:
        print(f"Skipping {skipped_cheap} cards under €{args.min_eur:.2f} (--min-eur).")
    if skipped_fresh:
        print(f"Skipping {skipped_fresh} cards scraped in the last "
              f"{args.refresh_hours:g}h (use --force to redo).")
    if not todo:
        print("Nothing to scrape.")
        return 0

    pages_per_card = 1 if args.croatia_only else 2
    est_min = len(todo) * pages_per_card * 7 / 60
    print(f"Scraping {len(todo)} cards from Cardmarket "
          f"({'Croatia view only' if args.croatia_only else 'full + Croatia view'}, "
          f"rough estimate ~{est_min:.0f} min - slow on purpose)...")

    failures = 0
    ok_count = 0
    croatia_id_cache: dict = {}
    if listings.get("croatia_country_id"):
        croatia_id_cache["croatia"] = listings["croatia_country_id"]

    with sync_playwright() as pw:
        try:
            browser = pw.chromium.launch(headless=not args.headed)
        except Exception as e:  # noqa: BLE001
            print(f"Could not start the browser: {e}\n"
                  "If Chromium is missing, install it with:\n"
                  "  playwright install chromium")
            return 1
        context = browser.new_context(
            locale="en-US",
            viewport={"width": 1366, "height": 900},
            user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                        "AppleWebKit/537.36 (KHTML, like Gecko) "
                        "Chrome/126.0.0.0 Safari/537.36"),
        )
        page = context.new_page()

        for i, card in enumerate(todo, 1):
            print(f"  [{i}/{len(todo)}] {card['name']}")
            try:
                result = scrape_card(page, card, croatia_id_cache,
                                     args.croatia_only,
                                     listings["cards"].get(card["id"]))
                if result:
                    listings["cards"][card["id"]] = result
                    listings["scraped_at"] = result["scraped_at"]
                    if croatia_id_cache.get("croatia"):
                        listings["croatia_country_id"] = croatia_id_cache["croatia"]
                    listings_path.write_text(
                        json.dumps(listings, ensure_ascii=False, indent=1),
                        encoding="utf-8")
                    hr = result["croatia"]
                    hr_info = (f"{len(hr)} from Croatia (from €{hr[0]['price']:.2f})"
                               if hr else "none from Croatia")
                    print(f"    ok: {len(result['cheapest'])} listings, {hr_info}")
                    ok_count += 1
                failures = 0
            except Exception as e:  # noqa: BLE001 - keep going, log everything
                failures += 1
                print(f"    failed: {e}")
                if failures >= MAX_CONSECUTIVE_FAILURES:
                    print(f"\n{failures} failures in a row - stopping so we don't "
                          "hammer a site that is refusing us. Progress was "
                          "saved; run the same command again later (already "
                          "scraped cards are skipped automatically).")
                    break
            if i < len(todo):
                polite_sleep()

        browser.close()

    print(f"\nDone: {ok_count} cards updated this run; data/listings.json now "
          f"covers {len(listings['cards'])} cards.")
    print("Publish to the live site with:\n"
          "  git add data/listings.json && git commit -m \"Update listings\" "
          "&& git push")
    return 0


if __name__ == "__main__":
    sys.exit(main())
