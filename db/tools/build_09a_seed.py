#!/usr/bin/env python3
"""
PortfolioAI — Migration 09a security-master seed generator.

Reads authoritative exchange source files (downloaded separately, never
committed), applies deterministic normalization/deduplication, and emits:

  db/migrations/0009a_security_master_seed.sql   (proposal — not applied here)
  db/seeds/0009a/manifest.json                   (source provenance)
  db/seeds/0009a/stats.json                      (counts)
  db/seeds/0009a/exclusions.csv                  (rows deliberately not seeded)
  db/seeds/0009a/conflicts.csv                   (source conflicts for review)

The generator NEVER invents a security. Every emitted row traces to a source
record. Conflicts are reported, never silently resolved. ON CONFLICT DO NOTHING
appears in the SQL only as an idempotency safety net, after conflict detection.

Usage:  python3 db/tools/build_09a_seed.py --input <dir-with-source-files>
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import re
import unicodedata
import uuid
from collections import Counter, defaultdict
from datetime import datetime, timezone

NS = uuid.UUID("6f0a1f2c-8b1e-5c3a-9d4e-0a1b2c3d4e5f")

SYMBOL_RE = re.compile(r"^[A-Z0-9][A-Z0-9&._\-]{0,31}$")
ISIN_RE = re.compile(r"^[A-Z]{2}[A-Z0-9]{9}[0-9]$")

SOURCES = {
    "nse_equity": {
        "file": "EQUITY_L.csv",
        "publisher": "National Stock Exchange of India (NSE)",
        "url": "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv",
        "description": "NSE list of securities available for equity trading",
    },
    "nse_sme": {
        "file": "SME_EQUITY_L.csv",
        "publisher": "National Stock Exchange of India (NSE) — Emerge (SME) platform",
        "url": "https://nsearchives.nseindia.com/emerge/corporates/content/SME_EQUITY_L.csv",
        "description": "NSE Emerge SME list of securities",
    },
    "nse_etf": {
        "file": "eq_etfseclist.csv",
        "publisher": "National Stock Exchange of India (NSE)",
        "url": "https://nsearchives.nseindia.com/content/equities/eq_etfseclist.csv",
        "description": "NSE list of listed exchange traded funds",
    },
    "bse_all": {
        "file": "bse_all.json",
        "publisher": "BSE Ltd",
        "url": (
            "https://api.bseindia.com/BseIndiaAPI/api/ListofScripData/w"
            "?Group=&Scripcode=&industry=&segment=All&status=Active"
        ),
        "description": "BSE list of active scrips (all segments)",
    },
}

# ISIN issue-type digits (positions 8-9 of an Indian ISIN) used as depository-level
# instrument evidence. Documented NSDL/CDSL numbering convention.
ISIN_TYPE_EQUITY = {"01", "02"}
ISIN_TYPE_RIGHTS = {"20"}
ISIN_TYPE_INVIT = {"23"}
ISIN_TYPE_REIT = {"25"}


def normalize_alias(value: str) -> str:
    """Mirror of public.normalize_alias(text) deployed in Migration 04."""
    s = unicodedata.normalize("NFKC", value)
    s = re.sub(r"[\u200B-\u200D\uFEFF]", "", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().upper()


def sec_uuid(key: str) -> str:
    return str(uuid.uuid5(NS, "portfolioai:security:" + key))


def alias_uuid(sec_id: str, atype: str, source: str | None, exch: str | None, norm: str) -> str:
    return str(uuid.uuid5(NS, f"portfolioai:alias:{atype}|{source or ''}|{exch or ''}|{norm}"))


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def isin_type(isin: str | None) -> str | None:
    if not isin or len(isin) != 12:
        return None
    return isin[7:9]


def isin_asset_class(isin: str | None) -> str | None:
    """Depository-level instrument evidence, or None when not decisive."""
    if not isin:
        return None
    if isin.startswith("INF"):
        return "ETF"          # mutual-fund/ETF ISIN space; exchange-listed here
    t = isin_type(isin)
    if t in ISIN_TYPE_INVIT:
        return "INVIT"
    if t in ISIN_TYPE_REIT:
        return "REIT"
    if t in ISIN_TYPE_EQUITY:
        return "EQUITY"
    return None


class Report:
    def __init__(self) -> None:
        self.exclusions: list[dict] = []
        self.conflicts: list[dict] = []

    def exclude(self, source: str, ident: str, reason: str, detail: str = "") -> None:
        self.exclusions.append(
            {"source": source, "identifier": ident, "reason": reason, "detail": detail}
        )

    def conflict(self, kind: str, ident: str, detail: str) -> None:
        self.conflicts.append({"kind": kind, "identifier": ident, "detail": detail})


def load_nse_equity(path: str, rep: Report) -> list[dict]:
    out = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
            sym, isin, name = r["SYMBOL"], r["ISIN NUMBER"], r["NAME OF COMPANY"]
            out.append(
                {
                    "src": "nse_equity", "exchange": "NSE", "symbol": sym, "isin": isin,
                    "name": name, "class_hint": "EQUITY", "series": r["SERIES"], "code": None,
                }
            )
    return out


def load_nse_sme(path: str, rep: Report) -> list[dict]:
    out = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
            sym, isin, name = r["SYMBOL"], r["ISIN_NUMBER"], r["NAME_OF_COMPANY"]
            out.append(
                {
                    "src": "nse_sme", "exchange": "NSE", "symbol": sym, "isin": isin,
                    "name": name, "class_hint": "EQUITY", "series": r["SERIES"],
                    "code": None, "sme": True,
                }
            )
    return out


def load_nse_etf(path: str, rep: Report) -> list[dict]:
    out = []
    with open(path, newline="", encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            r = {k.strip(): (v or "").strip() for k, v in r.items() if k}
            out.append(
                {
                    "src": "nse_etf", "exchange": "NSE", "symbol": r["Symbol"],
                    "isin": r["ISINNumber"], "name": r["SecurityName"],
                    "class_hint": "ETF", "series": "ETF", "code": None,
                }
            )
    return out


def load_bse(path: str, rep: Report) -> list[dict]:
    out = []
    with open(path, encoding="utf-8") as fh:
        rows = json.load(fh)
    for r in rows:
        seg = (r.get("Segment") or "").strip()
        group = (r.get("GROUP") or "").strip()
        code = (r.get("SCRIP_CD") or "").strip()
        name = (r.get("Scrip_Name") or "").strip()
        isin = (r.get("ISIN_NUMBER") or "").strip()
        scrip_id = (r.get("scrip_id") or "").strip()
        if seg not in ("Equity", "MF"):
            rep.exclude("bse_all", code, "out_of_scope_segment", seg or "(blank)")
            continue
        hint = "ETF" if seg == "MF" else ("UNKNOWN" if group == "IF" else "EQUITY")
        out.append(
            {
                "src": "bse_all", "exchange": "BSE", "symbol": scrip_id, "isin": isin,
                "name": name, "class_hint": hint, "series": group, "code": code,
            }
        )
    return out


def build(input_dir: str, out_root: str) -> dict:
    rep = Report()
    manifest = []
    records: list[dict] = []

    loaders = {
        "nse_equity": load_nse_equity,
        "nse_sme": load_nse_sme,
        "nse_etf": load_nse_etf,
        "bse_all": load_bse,
    }
    for key, meta in SOURCES.items():
        path = os.path.join(input_dir, meta["file"])
        rows = loaders[key](path, rep)
        st = os.stat(path)
        manifest.append(
            {
                "id": key,
                "publisher": meta["publisher"],
                "file": meta["file"],
                "url": meta["url"],
                "description": meta["description"],
                "retrieved_utc": datetime.fromtimestamp(st.st_mtime, timezone.utc)
                .strftime("%Y-%m-%dT%H:%M:%SZ"),
                "sha256": sha256(path),
                "bytes": st.st_size,
                "rows_read": len(rows),
            }
        )
        records.extend(rows)

    # ---- per-record validation ------------------------------------------------
    valid: list[dict] = []
    for r in records:
        ident = f"{r['exchange']}:{r['symbol'] or r['code']}"
        if not r["name"]:
            rep.exclude(r["src"], ident, "missing_name", "")
            continue
        if len(r["name"]) > 200:
            rep.exclude(r["src"], ident, "name_exceeds_200_chars", r["name"][:60] + "...")
            continue
        if r["isin"] and not ISIN_RE.match(r["isin"]):
            rep.exclude(r["src"], ident, "malformed_isin", r["isin"])
            r = {**r, "isin": ""}
        t = isin_type(r["isin"]) if r["isin"] else None
        if t in ISIN_TYPE_RIGHTS:
            rep.exclude(r["src"], ident, "rights_entitlement_temporary_instrument", r["isin"])
            continue
        valid.append(r)

    # ---- deterministic classification ----------------------------------------
    for r in valid:
        depository = isin_asset_class(r["isin"])
        hint = r["class_hint"]
        if depository is None:
            r["asset_class"] = hint if hint != "UNKNOWN" else "UNKNOWN"
            if hint == "UNKNOWN":
                rep.conflict(
                    "unclassifiable_instrument",
                    f"{r['exchange']}:{r['symbol'] or r['code']}",
                    f"isin={r['isin'] or '(none)'} group={r['series']} -> UNKNOWN",
                )
            continue
        r["asset_class"] = depository
        if hint not in ("UNKNOWN", depository):
            rep.conflict(
                "classification_disagreement",
                f"{r['exchange']}:{r['symbol'] or r['code']}",
                f"source_list={hint} depository_isin={depository} isin={r['isin']} "
                f"-> depository evidence used",
            )

    # ---- canonical grouping ---------------------------------------------------
    by_isin: dict[str, list[dict]] = defaultdict(list)
    no_isin: list[dict] = []
    for r in valid:
        (by_isin[r["isin"]] if r["isin"] else no_isin).append(r)

    securities: dict[str, dict] = {}

    def pick_symbol(rows: list[dict], exch: str) -> str | None:
        syms = {r["symbol"] for r in rows if r["exchange"] == exch and r["symbol"]}
        syms = {s for s in syms if SYMBOL_RE.match(s)}
        if len(syms) == 1:
            return next(iter(syms))
        return None

    for isin, rows in by_isin.items():
        classes = {r["asset_class"] for r in rows}
        if len(classes) > 1:
            rep.conflict(
                "conflicting_class_same_isin", isin,
                "|".join(sorted(f"{r['src']}={r['asset_class']}" for r in rows)),
            )
        # depository evidence already applied per row; take the decisive one
        dep = isin_asset_class(isin)
        asset_class = dep or (next(iter(classes)) if len(classes) == 1 else "UNKNOWN")

        names = {r["name"] for r in rows}
        nse_names = [r["name"] for r in rows if r["exchange"] == "NSE"]
        name = sorted(nse_names)[0] if nse_names else sorted(names)[0]
        if len({normalize_alias(n) for n in names}) > 1:
            rep.conflict(
                "differing_names_same_isin", isin,
                " | ".join(sorted(names))[:300],
            )

        nse_sym = pick_symbol(rows, "NSE")
        bse_sym = pick_symbol(rows, "BSE")
        if nse_sym:
            exch, sym = "NSE", nse_sym
        elif bse_sym:
            exch, sym = "BSE", bse_sym
        else:
            exch, sym = None, None
        if any(r["exchange"] == "NSE" for r in rows) and not nse_sym:
            rep.conflict("ambiguous_or_invalid_nse_symbol", isin,
                         "|".join(sorted({r["symbol"] for r in rows if r["exchange"] == "NSE"})))
        if any(r["exchange"] == "BSE" for r in rows) and not bse_sym:
            rep.conflict("ambiguous_or_invalid_bse_symbol", isin,
                         "|".join(sorted({r["symbol"] for r in rows if r["exchange"] == "BSE"})))

        securities[isin] = {
            "id": sec_uuid("ISIN:" + isin), "isin": isin, "name": name,
            "asset_class": asset_class, "exchange": exch, "primary_symbol": sym,
            "rows": rows,
            "exchanges": sorted({r["exchange"] for r in rows}),
            "sme": any(r.get("sme") for r in rows),
        }

    # securities without an ISIN: keep only when (exchange, symbol) is unambiguous
    key_counts = Counter(
        (r["exchange"], r["symbol"]) for r in no_isin if r["symbol"]
    )
    seen_no_isin: set[tuple[str, str]] = set()
    for r in no_isin:
        ident = f"{r['exchange']}:{r['symbol'] or r['code']}"
        if not r["symbol"] or not SYMBOL_RE.match(r["symbol"]):
            rep.exclude(r["src"], ident, "no_isin_and_no_usable_symbol", r["symbol"])
            continue
        k = (r["exchange"], r["symbol"])
        if key_counts[k] > 1:
            rep.exclude(r["src"], ident, "no_isin_and_duplicate_exchange_symbol", "")
            continue
        # must not collide with an ISIN-bearing security's (exchange, symbol)
        if any(s["exchange"] == k[0] and s["primary_symbol"] == k[1] for s in securities.values()):
            rep.conflict("no_isin_symbol_collides_with_isin_security", ident, "")
            continue
        if k in seen_no_isin:
            continue
        seen_no_isin.add(k)
        sid = sec_uuid(f"{r['exchange']}:{r['symbol']}")
        securities[f"NOISIN:{r['exchange']}:{r['symbol']}"] = {
            "id": sid, "isin": None, "name": r["name"], "asset_class": r["asset_class"],
            "exchange": r["exchange"], "primary_symbol": r["symbol"], "rows": [r],
            "exchanges": [r["exchange"]], "sme": bool(r.get("sme")),
        }

    # global (exchange, primary_symbol) uniqueness — must hold before SQL is emitted
    sym_owner: dict[tuple[str, str], str] = {}
    for k, s in list(securities.items()):
        if not s["primary_symbol"]:
            continue
        key = (s["exchange"], s["primary_symbol"])
        if key in sym_owner:
            rep.conflict(
                "duplicate_exchange_symbol_between_securities",
                f"{key[0]}:{key[1]}",
                f"{sym_owner[key]} vs {s['isin'] or k} -> symbol dropped from the later row",
            )
            s["exchange"], s["primary_symbol"] = None, None
        else:
            sym_owner[key] = s["isin"] or k

    # ---- aliases --------------------------------------------------------------
    alias_owner: dict[tuple[str, str, str, str], str] = {}
    aliases: list[dict] = []

    def add_alias(sec, atype, value, exch=None, source=None):
        value = (value or "").strip()
        if not value or len(value) > 200:
            return
        norm = normalize_alias(value)
        if atype == "ISIN" and not ISIN_RE.match(norm):
            return
        key = (atype, source or "", exch or "", norm)
        if key in alias_owner:
            if alias_owner[key] != sec["id"]:
                rep.conflict(
                    "conflicting_alias_same_context",
                    f"{atype}/{exch or '-'}/{norm}",
                    f"claimed by {alias_owner[key]} and {sec['id']} -> alias not seeded",
                )
                # remove the previously emitted one as well: context is ambiguous
                for i, a in enumerate(aliases):
                    if (a["alias_type"], a["source"] or "", a["exchange"] or "", a["norm"]) == key:
                        aliases.pop(i)
                        break
                alias_owner[key] = "__AMBIGUOUS__"
            return
        alias_owner[key] = sec["id"]
        aliases.append(
            {
                "id": alias_uuid(sec["id"], atype, source, exch, norm),
                "security_id": sec["id"], "alias_type": atype, "alias_value": value,
                "exchange": exch, "source": source, "norm": norm,
            }
        )

    for s in securities.values():
        if s["isin"]:
            add_alias(s, "ISIN", s["isin"])
        for r in s["rows"]:
            if r["symbol"]:
                add_alias(s, "EXCHANGE_SYMBOL", r["symbol"], exch=r["exchange"])
            if r["code"]:
                add_alias(s, "EXCHANGE_SYMBOL", r["code"], exch=r["exchange"])
            add_alias(s, "COMPANY_NAME", r["name"])

    # ---- statistics -----------------------------------------------------------
    cls = Counter(s["asset_class"] for s in securities.values())
    stats = {
        "generated_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_securities": len(securities),
        "by_asset_class": dict(sorted(cls.items())),
        "sme_equities": sum(1 for s in securities.values() if s["sme"]),
        "nse_only": sum(1 for s in securities.values() if s["exchanges"] == ["NSE"]),
        "bse_only": sum(1 for s in securities.values() if s["exchanges"] == ["BSE"]),
        "nse_and_bse_shared_isin": sum(
            1 for s in securities.values() if s["exchanges"] == ["BSE", "NSE"]
        ),
        "missing_isin_securities": sum(1 for s in securities.values() if not s["isin"]),
        "securities_without_symbol": sum(
            1 for s in securities.values() if not s["primary_symbol"]
        ),
        "total_aliases": len(aliases),
        "aliases_by_type": dict(sorted(Counter(a["alias_type"] for a in aliases).items())),
        "excluded_records": len(rep.exclusions),
        "exclusions_by_reason": dict(sorted(Counter(e["reason"] for e in rep.exclusions).items())),
        "conflicts": len(rep.conflicts),
        "conflicts_by_kind": dict(sorted(Counter(c["kind"] for c in rep.conflicts).items())),
    }

    # ---- output ---------------------------------------------------------------
    seeds = os.path.join(out_root, "db", "seeds", "0009a")
    os.makedirs(seeds, exist_ok=True)
    with open(os.path.join(seeds, "manifest.json"), "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    with open(os.path.join(seeds, "stats.json"), "w") as fh:
        json.dump(stats, fh, indent=2)
        fh.write("\n")
    with open(os.path.join(seeds, "exclusions.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["source", "identifier", "reason", "detail"])
        w.writeheader()
        w.writerows(rep.exclusions)
    with open(os.path.join(seeds, "conflicts.csv"), "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=["kind", "identifier", "detail"])
        w.writeheader()
        w.writerows(rep.conflicts)

    write_sql(os.path.join(out_root, "db", "migrations", "0009a_security_master_seed.sql"),
              securities, aliases, manifest, stats)
    return stats


def q(v) -> str:
    if v is None:
        return "null"
    return "'" + str(v).replace("'", "''") + "'"


def write_sql(path, securities, aliases, manifest, stats) -> None:
    secs = sorted(securities.values(), key=lambda s: (s["isin"] or "zzz", s["id"]))
    als = sorted(aliases, key=lambda a: (a["alias_type"], a["exchange"] or "", a["norm"]))
    with open(path, "w") as fh:
        w = fh.write
        w("-- 0009a_security_master_seed.sql\n")
        w("-- PortfolioAI Migration 09a — canonical security master seed (reference data).\n")
        w("--\n-- Generated by db/tools/build_09a_seed.py. Do not hand-edit.\n")
        w(f"-- Generated (UTC): {stats['generated_utc']}\n--\n-- Sources:\n")
        for m in manifest:
            w(f"--   * {m['publisher']} — {m['description']}\n")
            w(f"--     {m['url']}\n")
            w(f"--     retrieved {m['retrieved_utc']}  sha256 {m['sha256']}  rows {m['rows_read']}\n")
        w("--\n-- Contents: no schema change. INSERT-only into public.securities and\n")
        w("-- public.security_aliases. ON CONFLICT DO NOTHING is an idempotency safety\n")
        w("-- net only; source conflicts were detected by the generator and routed to\n")
        w("-- db/seeds/0009a/conflicts.csv instead of being resolved silently.\n")
        w(f"--   securities: {stats['total_securities']}   aliases: {stats['total_aliases']}\n")
        w("--\n-- Rollback (safe only while nothing references these rows):\n")
        w("-- begin;\n")
        w("--   delete from public.security_aliases a\n")
        w("--    where not exists (select 1 from public.transactions t where t.security_id = a.security_id);\n")
        w("--   delete from public.securities s\n")
        w("--    where not exists (select 1 from public.transactions t where t.security_id = s.id);\n")
        w("-- commit;\n\n")
        w("begin;\n\n")

        w("insert into public.securities\n")
        w("  (id, asset_class, name, isin, exchange, primary_symbol, currency, is_active)\n")
        w("values\n")
        for i, s in enumerate(secs):
            w("  (%s, %s, %s, %s, %s, %s, 'INR', true)%s\n" % (
                q(s["id"]), q(s["asset_class"]) + "::public.asset_class", q(s["name"]),
                q(s["isin"]), q(s["exchange"]), q(s["primary_symbol"]),
                "," if i < len(secs) - 1 else ""))
        w("on conflict do nothing;\n\n")

        w("insert into public.security_aliases\n")
        w("  (id, security_id, alias_type, alias_value, source, exchange)\n")
        w("values\n")
        for i, a in enumerate(als):
            w("  (%s, %s, %s, %s, %s, %s)%s\n" % (
                q(a["id"]), q(a["security_id"]),
                q(a["alias_type"]) + "::public.security_alias_type",
                q(a["alias_value"]), q(a["source"]), q(a["exchange"]),
                "," if i < len(als) - 1 else ""))
        w("on conflict do nothing;\n\n")
        w("commit;\n")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--out", default=os.getcwd())
    a = ap.parse_args()
    print(json.dumps(build(a.input, a.out), indent=2))
