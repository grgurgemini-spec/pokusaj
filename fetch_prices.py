#!/usr/bin/env python3
"""Fetch Cardmarket/TCGplayer aggregate prices for the tracked precons.

Reads decklists from decks/*.txt, resolves every card through the Scryfall API
(which republishes Cardmarket EUR trend prices and TCGplayer USD prices daily),
and writes:

  data/cards.json    latest snapshot of every card with prices and metadata
  data/history.json  one price point per card per day, appended on each run

Deck files that contain no card lines yet are synced automatically from the
deck sources declared in their header (`# source: archidekt:<id>` /
`# source: mtggoldfish:<id>` / `# source: moxfield:<public-id>`).

Usage:
  python fetch_prices.py               # sync missing decklists, fetch prices
  python fetch_prices.py --sync-decks  # force re-download of all decklists
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DECKS_DIR = ROOT / "decks"
DATA_DIR = ROOT / "data"

SCRYFALL_COLLECTION = "https://api.scryfall.com/cards/collection"
USER_AGENT = "PreconPriceTracker/1.0 (local hobby project)"
SCRYFALL_DELAY = 0.11  # Scryfall asks for 50-100ms between requests

BASIC_LANDS = {"plains", "island", "swamp", "mountain", "forest", "wastes",
               "snow-covered plains", "snow-covered island", "snow-covered swamp",
               "snow-covered mountain", "snow-covered forest"}


def http_json(url: str, payload: dict | None = None, timeout: int = 30):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, headers={
        "User-Agent": USER_AGENT,
        "Accept": "application/json;q=0.9,*/*;q=0.8",
        **({"Content-Type": "application/json"} if data else {}),
    })
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def http_text(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode()


# ---------------------------------------------------------------------------
# Deck files
# ---------------------------------------------------------------------------

CARD_LINE = re.compile(r"^(\d+)[xX]?\s+(.+?)(?:\s+\[(\w+)\])?\s*$")


class Deck:
    def __init__(self, path: Path):
        self.path = path
        self.id = path.stem
        self.headers: dict[str, list[str]] = {}
        self.cards: list[dict] = []  # {qty, name, set}
        self._parse()

    def _parse(self):
        for raw in self.path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line:
                continue
            if line.startswith("#"):
                m = re.match(r"#\s*([\w-]+)\s*:\s*(.+)$", line)
                if m:
                    self.headers.setdefault(m.group(1).lower(), []).append(m.group(2).strip())
                continue
            m = CARD_LINE.match(line)
            if m:
                self.cards.append({
                    "qty": int(m.group(1)),
                    "name": m.group(2).strip(),
                    "set": (m.group(3) or self.header("set") or "").lower() or None,
                })

    def header(self, key: str) -> str | None:
        vals = self.headers.get(key)
        return vals[0] if vals else None

    @property
    def name(self) -> str:
        return self.header("name") or self.id.replace("-", " ").title()

    @property
    def sources(self) -> list[tuple[str, str]]:
        out = []
        for v in self.headers.get("source", []):
            kind, _, ident = v.partition(":")
            if kind and ident:
                out.append((kind.strip().lower(), ident.strip()))
        return out

    def write_cards(self, cards: list[dict]):
        """Rewrite the deck file, keeping the header comments, replacing cards."""
        lines = []
        for raw in self.path.read_text(encoding="utf-8").splitlines():
            if raw.strip().startswith("#") or not raw.strip():
                lines.append(raw)
            else:
                break  # card section starts; drop the rest
        lines.append("")
        for c in cards:
            suffix = f" [{c['set']}]" if c.get("set") else ""
            lines.append(f"{c['qty']} {c['name']}{suffix}")
        self.path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
        self.cards = cards


# ---------------------------------------------------------------------------
# Decklist sync (Archidekt / MTGGoldfish / Moxfield)
# ---------------------------------------------------------------------------

def sync_from_archidekt(deck_id: str) -> list[dict]:
    data = http_json(f"https://archidekt.com/api/decks/{deck_id}/")
    excluded_cats = {c["name"] for c in data.get("categories", [])
                     if not c.get("includedInDeck", True)}
    cards = []
    for entry in data["cards"]:
        cats = set(entry.get("categories") or [])
        if cats & excluded_cats:
            continue
        card = entry["card"]
        cards.append({
            "qty": entry.get("quantity", 1),
            "name": card["oracleCard"]["name"],
            "set": (card.get("edition") or {}).get("editioncode"),
        })
    return cards


def sync_from_mtggoldfish(deck_id: str) -> list[dict]:
    text = http_text(f"https://www.mtggoldfish.com/deck/download/{deck_id}")
    cards = []
    for line in text.splitlines():
        m = CARD_LINE.match(line.strip())
        if m:
            cards.append({"qty": int(m.group(1)), "name": m.group(2).strip(), "set": None})
    return cards


def sync_from_moxfield(public_id: str) -> list[dict]:
    data = http_json(f"https://api2.moxfield.com/v3/decks/all/{public_id}")
    cards = []
    boards = data.get("boards", {})
    for board_name in ("commanders", "mainboard"):
        board = boards.get(board_name, {})
        for entry in (board.get("cards") or {}).values():
            card = entry.get("card") or {}
            cards.append({
                "qty": entry.get("quantity", 1),
                "name": card.get("name"),
                "set": card.get("set"),
            })
    return [c for c in cards if c["name"]]


SYNCERS = {
    "archidekt": sync_from_archidekt,
    "mtggoldfish": sync_from_mtggoldfish,
    "moxfield": sync_from_moxfield,
}


def sync_deck(deck: Deck, force: bool) -> bool:
    if deck.cards and not force:
        return True
    if not deck.sources:
        print(f"  !! {deck.id}: no cards and no '# source:' headers to sync from")
        return bool(deck.cards)
    for kind, ident in deck.sources:
        fn = SYNCERS.get(kind)
        if not fn:
            print(f"  !! {deck.id}: unknown source type '{kind}'")
            continue
        try:
            print(f"  syncing decklist from {kind}:{ident} ...")
            cards = fn(ident)
        except Exception as e:  # noqa: BLE001 - any network/parse failure -> next source
            print(f"     failed ({e}); trying next source")
            continue
        total = sum(c["qty"] for c in cards)
        if total < 90:  # a commander precon has 100 cards; guard against partial data
            print(f"     got only {total} cards, looks incomplete; trying next source")
            continue
        deck.write_cards(cards)
        print(f"     ok: {total} cards written to {deck.path.name}")
        return True
    print(f"  !! {deck.id}: could not sync decklist from any source")
    return bool(deck.cards)


# ---------------------------------------------------------------------------
# Scryfall price fetch
# ---------------------------------------------------------------------------

def chunks(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i:i + n]


def fetch_deck_cards(deck: Deck) -> list[dict]:
    """Resolve all cards of a deck via Scryfall's batch collection endpoint."""
    identifiers = []
    for c in deck.cards:
        ident = {"name": c["name"]}
        # Pin to the precon's set so we price the precon printing, but never pin
        # basic lands (the deck-level set may not have that exact land number).
        if c["set"] and c["name"].lower() not in BASIC_LANDS:
            ident["set"] = c["set"]
        identifiers.append(ident)

    resolved: dict[str, dict] = {}
    for batch in chunks(identifiers, 75):
        result = http_json(SCRYFALL_COLLECTION, {"identifiers": batch})
        for nf in result.get("not_found", []):
            # Retry once without the set pin (wrong/renamed set code, promo, etc.)
            if "set" in nf:
                time.sleep(SCRYFALL_DELAY)
                retry = http_json(SCRYFALL_COLLECTION,
                                  {"identifiers": [{"name": nf["name"]}]})
                for card in retry.get("data", []):
                    resolved[norm_name(card["name"])] = card
                if retry.get("not_found"):
                    print(f"  !! not found on Scryfall: {nf['name']}")
            else:
                print(f"  !! not found on Scryfall: {nf.get('name', nf)}")
        for card in result.get("data", []):
            resolved[norm_name(card["name"])] = card
        time.sleep(SCRYFALL_DELAY)

    out = []
    for c in deck.cards:
        card = resolved.get(norm_name(c["name"]))
        if not card:
            continue
        out.append(shape_card(card, c["qty"]))
    return out


def norm_name(name: str) -> str:
    return name.split("//")[0].strip().lower()


def shape_card(card: dict, qty: int) -> dict:
    image = (card.get("image_uris") or {}).get("normal")
    if not image and card.get("card_faces"):
        image = (card["card_faces"][0].get("image_uris") or {}).get("normal")
    prices = card.get("prices") or {}

    def num(key):
        v = prices.get(key)
        return float(v) if v not in (None, "") else None

    return {
        "id": card["id"],
        "name": card["name"],
        "qty": qty,
        "set": card.get("set"),
        "set_name": card.get("set_name"),
        "collector_number": card.get("collector_number"),
        "rarity": card.get("rarity"),
        "type_line": card.get("type_line"),
        "image": image,
        "cardmarket_id": card.get("cardmarket_id"),
        "cardmarket_url": (card.get("purchase_uris") or {}).get("cardmarket"),
        "scryfall_url": card.get("scryfall_uri"),
        "prices": {
            "cardmarket": {"eur": num("eur"), "eur_foil": num("eur_foil")},
            "tcgplayer": {"usd": num("usd"), "usd_foil": num("usd_foil")},
        },
    }


# ---------------------------------------------------------------------------
# Output files
# ---------------------------------------------------------------------------

def load_json(path: Path, default):
    if path.exists():
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    return default


def update_history(history: dict, decks_out: list[dict], today: str):
    hcards = history.setdefault("cards", {})
    hdecks = history.setdefault("decks", {})
    for deck in decks_out:
        deck_total = 0.0
        for card in deck["cards"]:
            cm = card["prices"]["cardmarket"]
            tp = card["prices"]["tcgplayer"]
            if cm["eur"] is not None:
                deck_total += cm["eur"] * card["qty"]
            entry = hcards.setdefault(card["id"], {"name": card["name"], "points": []})
            entry["name"] = card["name"]
            point = {"d": today, "eur": cm["eur"], "eur_foil": cm["eur_foil"],
                     "usd": tp["usd"]}
            entry["points"] = [p for p in entry["points"] if p["d"] != today] + [point]
            entry["points"].sort(key=lambda p: p["d"])
        dpoints = hdecks.setdefault(deck["id"], [])
        dpoint = {"d": today, "eur": round(deck_total, 2)}
        dpoints[:] = sorted([p for p in dpoints if p["d"] != today] + [dpoint],
                            key=lambda p: p["d"])


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--sync-decks", action="store_true",
                    help="re-download all decklists from their sources")
    args = ap.parse_args()

    deck_files = sorted(DECKS_DIR.glob("*.txt"))
    if not deck_files:
        print(f"No deck files found in {DECKS_DIR}")
        return 1

    DATA_DIR.mkdir(exist_ok=True)
    today = dt.date.today().isoformat()
    decks_out = []

    for path in deck_files:
        deck = Deck(path)
        print(f"Deck: {deck.name}")
        if not sync_deck(deck, force=args.sync_decks):
            print(f"  skipping {deck.id} (no cards)")
            continue
        print(f"  fetching prices for {sum(c['qty'] for c in deck.cards)} cards "
              f"from Scryfall ...")
        try:
            cards = fetch_deck_cards(deck)
        except urllib.error.URLError as e:
            print(f"  !! network error talking to Scryfall: {e}")
            print("     (check your internet connection and try again)")
            return 1
        priced = sum(1 for c in cards if c["prices"]["cardmarket"]["eur"] is not None)
        print(f"  resolved {len(cards)} cards ({priced} with a Cardmarket price)")
        decks_out.append({
            "id": deck.id,
            "name": deck.name,
            "set": deck.header("set"),
            "commander": deck.header("commander"),
            "cards": cards,
        })

    if not decks_out:
        print("Nothing fetched; data files left untouched.")
        return 1

    cards_json = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "sources": {
            "cardmarket": "EUR trend prices via Scryfall (updated daily by Scryfall)",
            "tcgplayer": "USD prices via Scryfall",
        },
        "decks": decks_out,
    }
    (DATA_DIR / "cards.json").write_text(
        json.dumps(cards_json, indent=1, ensure_ascii=False), encoding="utf-8")

    history = load_json(DATA_DIR / "history.json", {})
    update_history(history, decks_out, today)
    (DATA_DIR / "history.json").write_text(
        json.dumps(history, ensure_ascii=False), encoding="utf-8")

    print(f"\nWrote data/cards.json and data/history.json (snapshot for {today}).")
    print("Serve the site with:  python -m http.server 8000")
    print("then open:            http://localhost:8000/site/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
