#!/usr/bin/env python3
"""Best-effort Cardmarket listings scraper (optional).

For every card in data/cards.json this visits its Cardmarket product page and
records:
  * the 10 cheapest listings  - price, card language, seller country,
    condition, seller name, quantity
  * the 3 cheapest listings from sellers located in Croatia

Results are merged into data/listings.json, which the site displays on each
card's detail page.

IMPORTANT
  Cardmarket has no public API and its terms of service do not allow
  automated scraping. This script exists for personal, low-volume use on
  your own machine, at your own risk. It is deliberately slow (random
  multi-second delays), it stops on repeated failures, and everything else
  in this project keeps working when it fails - Cloudflare or a page
  redesign can break it at any time.

Setup (once):
  pip install playwright
  playwright install chromium

Usage:
  python scrape_cardmarket.py                 # scrape all cards (slow!)
  python scrape_cardmarket.py --deck the-hosts-of-mordor
  python scrape_cardmarket.py --card "Sauron, Lord of the Rings"
  python scrape_cardmarket.py --limit 5       # first 5 cards only
  python scrape_cardmarket.py --headed        # show the browser window
                                              # (helps against bot checks)
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


def polite_sleep():
    time.sleep(random.uniform(3.0, 7.0))


def txt(el) -> str:
    try:
        return re.sub(r"\s+", " ", el.inner_text()).strip()
    except Exception:
        return ""


def tooltip(el) -> str:
    """Cardmarket encodes language/country in icon tooltips."""
    for attr in ("data-original-title", "title", "aria-label", "data-bs-original-title"):
        v = el.get_attribute(attr)
        if v:
            return re.sub(r"<[^>]+>", " ", v).strip()
    return ""


def parse_price(text: str) -> float | None:
    # "1.234,56 €" -> 1234.56
    m = re.search(r"(\d{1,3}(?:\.\d{3})*|\d+),(\d{2})", text)
    if not m:
        return None
    return float(m.group(1).replace(".", "") + "." + m.group(2))


def parse_row(row) -> dict | None:
    listing: dict = {"seller": None, "country": None, "language": None,
                     "condition": None, "price": None, "qty": None}

    seller_el = row.query_selector(".seller-name a, .seller-info a")
    if seller_el:
        listing["seller"] = txt(seller_el)

    # Seller country: an icon in the seller column whose tooltip reads
    # "Item location: <Country>" (wording has changed before, so keep it loose).
    for icon in row.query_selector_all(".seller-info .icon, .seller-name .icon"):
        tip = tooltip(icon)
        m = re.search(r"(?:location|ships? from|versandort)\s*:?\s*(.+)", tip, re.I)
        if m:
            listing["country"] = m.group(1).strip()
            break

    cond_el = row.query_selector(".article-condition .badge, a.article-condition")
    if cond_el:
        listing["condition"] = txt(cond_el)

    # Card language: icon tooltip in the product attributes column.
    known_langs = ("English", "German", "French", "Italian", "Spanish",
                   "Portuguese", "Japanese", "Korean", "Russian",
                   "Simplified Chinese", "Traditional Chinese")
    for icon in row.query_selector_all(".product-attributes .icon"):
        tip = tooltip(icon)
        if tip in known_langs:
            listing["language"] = tip
            break
        for lang in known_langs:
            if lang.lower() in tip.lower():
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
    rows = page.query_selector_all(ROW_SELECTOR)
    out = []
    for row in rows:
        listing = parse_row(row)
        if listing:
            out.append(listing)
        if len(out) >= limit:
            break
    return out


def resolve_croatia_id(page) -> str | None:
    """Read Cardmarket's numeric id for Croatia from the seller-country filter."""
    for opt in page.query_selector_all("select[name='sellerCountry'] option"):
        label = txt(opt)
        if label.lower() in ("croatia", "hrvatska", "kroatien"):
            return opt.get_attribute("value")
    return None


def looks_blocked(page) -> bool:
    title = (page.title() or "").lower()
    return any(s in title for s in ("just a moment", "attention required", "access denied"))


def scrape_card(page, card, croatia_id_cache: dict) -> dict | None:
    url = card.get("cardmarket_url")
    if not url:
        print("    no Cardmarket URL, skipping")
        return None

    page.goto(url, wait_until="domcontentloaded", timeout=60_000)
    page.wait_for_timeout(2500)
    if looks_blocked(page):
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

    result = {
        "name": card["name"],
        "url": page.url.split("?")[0],
        "scraped_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "cheapest": extract_listings(page, LISTINGS_PER_CARD),
        "croatia": [],
    }

    if "croatia" not in croatia_id_cache:
        croatia_id_cache["croatia"] = resolve_croatia_id(page)
    croatia_id = croatia_id_cache["croatia"]

    if croatia_id:
        polite_sleep()
        sep = "&" if "?" in result["url"] else "?"
        page.goto(f"{result['url']}{sep}sellerCountry={croatia_id}",
                  wait_until="domcontentloaded", timeout=60_000)
        page.wait_for_timeout(2500)
        if not looks_blocked(page):
            try:
                page.wait_for_selector(ROW_SELECTOR, timeout=10_000)
                result["croatia"] = extract_listings(page, CROATIA_LISTINGS)
            except Exception:
                pass  # simply no Croatian sellers for this card
    else:
        # Fallback: filter the unfiltered listings we already have.
        result["croatia"] = [l for l in result["cheapest"]
                             if (l.get("country") or "").lower() == "croatia"
                             ][:CROATIA_LISTINGS]
    return result


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--deck", help="only scrape cards of this deck id")
    ap.add_argument("--card", help="only scrape the card with this exact name")
    ap.add_argument("--limit", type=int, help="stop after N cards")
    ap.add_argument("--headed", action="store_true", help="show the browser window")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("Playwright is not installed. Run:\n"
              "  pip install playwright\n  playwright install chromium")
        return 1

    cards_path = DATA_DIR / "cards.json"
    if not cards_path.exists():
        print("data/cards.json not found - run `python fetch_prices.py` first.")
        return 1
    cards_data = json.loads(cards_path.read_text(encoding="utf-8"))

    todo = []
    for deck in cards_data["decks"]:
        if args.deck and deck["id"] != args.deck:
            continue
        for card in deck["cards"]:
            if args.card and card["name"].lower() != args.card.lower():
                continue
            todo.append(card)
    # A precon has many duplicate basics; scrape each distinct card once.
    seen, unique = set(), []
    for c in todo:
        if c["id"] not in seen:
            seen.add(c["id"])
            unique.append(c)
    todo = unique[: args.limit] if args.limit else unique
    if not todo:
        print("No matching cards.")
        return 1

    listings_path = DATA_DIR / "listings.json"
    listings = (json.loads(listings_path.read_text(encoding="utf-8"))
                if listings_path.exists() else {"cards": {}})
    listings.setdefault("cards", {})

    print(f"Scraping {len(todo)} card pages from Cardmarket "
          f"(slow on purpose - a few seconds per page)...")
    failures = 0
    croatia_id_cache: dict = {}

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=not args.headed)
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
                result = scrape_card(page, card, croatia_id_cache)
                if result:
                    listings["cards"][card["id"]] = result
                    listings["scraped_at"] = result["scraped_at"]
                    listings_path.write_text(
                        json.dumps(listings, ensure_ascii=False, indent=1),
                        encoding="utf-8")
                    print(f"    ok: {len(result['cheapest'])} listings, "
                          f"{len(result['croatia'])} from Croatia")
                failures = 0
            except Exception as e:  # noqa: BLE001 - keep going, log everything
                failures += 1
                print(f"    failed: {e}")
                if failures >= MAX_CONSECUTIVE_FAILURES:
                    print(f"\n{failures} failures in a row - stopping so we don't "
                          "hammer a site that is refusing us. Partial results "
                          "were saved; try again later or with --headed.")
                    break
            if i < len(todo):
                polite_sleep()

        browser.close()

    done = len(listings["cards"])
    print(f"\ndata/listings.json now has listings for {done} cards.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
