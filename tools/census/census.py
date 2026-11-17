#!/usr/bin/env python3
"""Gemini production prediction-market census (read-only, public API, stdlib only).
Usage: python3 -I census.py fetch   # download pages into census_data/
       python3 -I census.py explore # strike-type inspection
       python3 -I census.py report  # full analysis (prints summary)
"""
import json, os, sys, time, urllib.request, statistics, collections, re

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "census_data")
URL = "https://api.gemini.com/v1/prediction-markets/events?status=active&limit=100&offset=%d"
UA = "Mozilla/5.0 (compatible; market-census/1.0)"
MAX_EVENTS = 2000

def fetch():
    os.makedirs(DATA, exist_ok=True)
    off = 0
    while off < MAX_EVENTS:
        req = urllib.request.Request(URL % off, headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
        path = os.path.join(DATA, "page_%04d.json" % off)
        with open(path, "wb") as f:
            f.write(raw)
        d = json.loads(raw)
        n = len(d["data"])
        print("offset", off, "events", n, "bytes", len(raw), "pagination", d.get("pagination"))
        if n < 100:
            break
        off += 100
        time.sleep(0.5)

def load_top():
    top = []
    for fn in sorted(os.listdir(DATA)):
        if fn.startswith("page_") and fn.endswith(".json"):
            top += json.load(open(os.path.join(DATA, fn)))["data"]
    return top[:MAX_EVENTS]

def flatten(top):
    """Return list of events (parent + nested child events), each tagged with parent ticker."""
    out = []
    for e in top:
        e["_parent"] = None
        out.append(e)
        for c in e.get("events") or []:
            c["_parent"] = e["ticker"]
            for k in ("category", "subcategory"):
                c.setdefault(k, e.get(k))
            out.append(c)
    return out

def P(x):
    try:
        if x is None or x == "": return None
        v = float(x)
        return v if 0 <= v <= 1 else None
    except Exception:
        return None

def cinfo(c):
    p = c.get("prices") or {}
    return P(p.get("bestBid")), P(p.get("bestAsk"))

def isopen(c):
    return c.get("marketState") == "open"

def mid(c):
    b, a = cinfo(c)
    return (b + a) / 2 if b is not None and a is not None else None

def cat(e):
    return e.get("category") or "?"

def sub(e):
    s = e.get("subcategory")
    if isinstance(s, dict):
        return "/".join(s.get("path") or [s.get("name", "?")])
    return str(s)

def q(xs, p):
    xs = sorted(xs)
    if not xs: return None
    k = (len(xs) - 1) * p
    f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)

def stats(xs):
    if not xs: return "n=0"
    return "n=%d p25=%.3f med=%.3f p75=%.3f" % (len(xs), q(xs, .25), q(xs, .5), q(xs, .75))

def strike_type(c):
    s = c.get("strike")
    return s.get("type") if isinstance(s, dict) else None

def table(rows, header):
    print("| " + " | ".join(header) + " |")
    print("|" + "---|" * len(header))
    for r in rows:
        print("| " + " | ".join(str(x) for x in r) + " |")
    print()

def explore():
    ev = flatten(load_top())
    st = collections.defaultdict(list)
    for e in ev:
        for c in e["contracts"]:
            st[strike_type(c)].append((e, c))
    for k, v in st.items():
        print("STRIKE", k, len(v))
        seen = set()
        for e, c in v:
            key = (cat(e), e["ticker"].split("-")[-1] if cat(e) == "Sports" else "")
            if key in seen: continue
            seen.add(key)
            print("   ", key, "|", e["title"], "|", c["label"], "|", c.get("strike"), "|", cinfo(c))
            if len(seen) > 8: break

def report():
    top = load_top()
    ev = flatten(top)
    print("top-level events:", len(top), " child events nested:", len(ev) - len(top), " total flattened events:", len(ev))
    print("total contracts:", sum(len(e["contracts"]) for e in ev))
    print("event statuses:", collections.Counter(e.get("status") for e in ev))
    print("contract marketStates:", collections.Counter(c.get("marketState") for e in ev for c in e["contracts"]))
    # --- Inventory
    print("\n## Inventory by category")
    bc = collections.defaultdict(lambda: [0, 0, 0, 0.0, 0.0])
    for e in ev:
        r = bc[cat(e)]; r[0] += 1; r[1] += len(e["contracts"]); r[2] += sum(isopen(c) for c in e["contracts"])
        r[3] += float(e.get("volume") or 0); r[4] += float(e.get("volume24h") or 0)
    table([(k, v[0], v[1], v[2], "%.0f" % v[3], "%.0f" % v[4]) for k, v in sorted(bc.items(), key=lambda x: -x[1][0])],
          ["category", "events", "contracts", "open contracts", "volume", "volume24h"])
    print("## Inventory by category/subcategory (events)")
    bs = collections.Counter((cat(e), sub(e)) for e in ev)
    table([(a, b, n) for (a, b), n in sorted(bs.items())], ["category", "subcategory", "events"])
    print("## By event type")
    table(sorted(collections.Counter((cat(e), e.get("type")) for e in ev).items()), ["(category,type)", "events"])
    print("## Distinct strike.type")
    st = collections.defaultdict(list)
    for e in ev:
        for c in e["contracts"]:
            st[strike_type(c)].append((e, c))
    rows = []
    for k, v in sorted(st.items(), key=lambda x: -len(x[1])):
        ex = v[0]
        samples = []
        seen = set()
        for e, c in v:
            if cat(e) in seen: continue
            seen.add(cat(e)); samples.append("%s: '%s' (%s)" % (cat(e), c["label"], (c.get("strike") or {}).get("value")))
            if len(samples) >= 3: break
        rows.append((k, len(v), "; ".join(samples)))
    table(rows, ["strike.type", "contracts", "sample labels"])

    # --- Linked structure classification
    NUMRE = re.compile(r"\d[\d,]*\.?\d*")
    EASY_LOW = {"above", "over", "spread"}      # lower strike = easier (superset)
    EASY_HIGH = {"below", "under_or_equal"}     # higher strike = easier
    def sv(c):
        try: return float(c["strike"]["value"])
        except Exception: return None
    def groups(e, types):
        g = collections.defaultdict(list)
        for c in e["contracts"]:
            t = strike_type(c)
            if t in types and sv(c) is not None:
                g[(t, NUMRE.sub("#", c["label"]))].append(c)
        return {k: v for k, v in g.items() if len({sv(c) for c in v}) >= 2}
    LADDER = EASY_LOW | EASY_HIGH
    A_strict = [e for e in ev if len([c for c in e["contracts"] if strike_type(c) == "above"]) >= 2]
    print("## Structure A (strict): events with >=2 contracts of strike.type 'above', per category")
    table(sorted(collections.Counter(cat(e) for e in A_strict).items()), ["category", "events"])
    G = {e["ticker"]: groups(e, LADDER) for e in ev}
    A_ext = [e for e in ev if G[e["ticker"]]]
    print("## Structure A (extended): events with a nested ladder group (same strike.type and same label-with-number-removed, >=2 distinct strikes)")
    table(sorted(collections.Counter((cat(e), t) for e in A_ext for (t, _) in G[e["ticker"]]).items()), ["(category, strike.type) group count", "groups"])
    print("events with an extended ladder, per category:")
    table(sorted(collections.Counter(cat(e) for e in A_ext).items()), ["category", "events"])
    pairs = []   # (e, easy, hard, K, Kmid, type)
    npairs_open = collections.Counter()
    for e in A_ext:
        for (t, key), cs in G[e["ticker"]].items():
            cs = [c for c in cs if isopen(c)]
            cs.sort(key=sv, reverse=(t in EASY_HIGH))   # easy first
            for i, a in enumerate(cs):
                for b in cs[i + 1:]:
                    if sv(a) == sv(b): continue
                    npairs_open[(cat(e), t)] += 1
                    ba, _ = cinfo(a); _, ab = cinfo(b)
                    if ba is None or ab is None or ba <= 0 or not ab < ba: continue
                    ma, mb = mid(a), mid(b)
                    Km = mb / ma if ma and mb is not None else None
                    pairs.append((e, a, b, ab / ba, Km, t))
    rows = []
    keys = sorted(set(npairs_open) | {(cat(x[0]), x[5]) for x in pairs})
    for k in keys:
        L = [x for x in pairs if (cat(x[0]), x[5]) == k]
        d = [x[3] - x[4] for x in L if x[4] is not None]
        rows.append((k[0], k[1], npairs_open[k], len(L), stats(d),
                     "%.0f%%" % (100 * sum(x > .05 for x in d) / len(d)) if d else "-",
                     "%.0f%%" % (100 * sum(x > .10 for x in d) / len(d)) if d else "-"))
    print("### Open ordered pairs (A easier, B harder, both open) and executable pairs with K - K_mid")
    table(rows, ["category", "strike.type", "open ordered pairs", "executable (bestAsk(B)<bestBid(A))", "K-K_mid", ">0.05", ">0.10"])
    for label, sel in (("STRICT 'above' only", lambda x: x[5] == "above"), ("ALL ladder types", lambda x: True)):
        L = [x for x in pairs if sel(x)]
        d = [x[3] - x[4] for x in L if x[4] is not None]
        print("%s: executable pairs %d in %d events; K-K_mid %s; share>0.05 %.0f%%; share>0.10 %.0f%%" % (
            label, len(L), len({x[0]["ticker"] for x in L}), stats(d),
            100 * sum(x > .05 for x in d) / max(1, len(d)), 100 * sum(x > .10 for x in d) / max(1, len(d))))
    print("Executable pairs by (category, sports ticker suffix):")
    fam = collections.Counter((cat(x[0]), x[0]["ticker"].rsplit("-", 1)[-1] if cat(x[0]) == "Sports" else "") for x in pairs)
    table(sorted(fam.items()), ["(category, suffix)", "pairs"])
    allp = pairs
    print("Executable-pair events per category:")
    table(sorted(collections.Counter(cat(e) for e in {x[0]["ticker"]: x[0] for x in pairs}.values()).items()), ["category", "events with >=1 executable pair"])
    nd = [x for x in pairs if cinfo(x[1])[0] >= 0.10 and cinfo(x[2])[1] >= 0.05 and x[3] <= 0.90]
    print("Non-degenerate executable pairs (bestBid(A)>=0.10, bestAsk(B)>=0.05, K<=0.90):", len(nd), "in", len({x[0]["ticker"] for x in nd}), "events;",
          dict(collections.Counter(cat(x[0]) for x in nd)))
    # cross-event: moneyline contract (event ...-M) vs spread contract (event ...-S) of the same game and team
    byg = collections.defaultdict(dict)
    for e in ev:
        if cat(e) != "Sports" or "-" not in e["ticker"]: continue
        game, suf = e["ticker"].rsplit("-", 1)
        byg[game][suf] = e
    n_games = len(byg)
    both = [g for g, d in byg.items() if "M" in d and "S" in d]
    print("\nCross-event nesting: games (ticker minus last suffix) =", n_games, "; with both -M and -S events =", len(both),
          "; with -S but no -M =", sum(1 for g, d in byg.items() if "S" in d and "M" not in d))
    xp = []
    for g in both:
        M, S_ = byg[g]["M"], byg[g]["S"]
        for mc in M["contracts"]:
            if not isopen(mc) or mc["label"].lower().startswith("tie") or strike_type(mc) is not None: continue
            for sc in S_["contracts"]:
                if strike_type(sc) != "spread" or not isopen(sc): continue
                if not sc["label"].startswith(mc["label"] + " "): continue
                ba, _ = cinfo(mc); _, ab = cinfo(sc)
                if ba is None or ab is None or ba <= 0 or not ab < ba: continue
                ma, mb = mid(mc), mid(sc)
                xp.append((M, S_, mc, sc, ab / ba, (mb / ma) if ma and mb is not None else None))
    d = [x[4] - x[5] for x in xp if x[5] is not None]
    print("Executable moneyline(A)->spread(B) cross-event pairs:", len(xp), "in", len({x[0]["ticker"] for x in xp}), "games; K-K_mid", stats(d),
          "share>0.05 %.0f%%" % (100 * sum(x > .05 for x in d) / max(1, len(d))), "share>0.10 %.0f%%" % (100 * sum(x > .10 for x in d) / max(1, len(d))))
    for M, S_, mc, sc, K, Km in sorted(xp, key=lambda x: x[4] - (x[5] if x[5] is not None else 9))[:3]:
        print("  XEVENT EXAMPLE:", M["ticker"], "| moneyline '%s' %s -> spread '%s' %s | K=%.3f K_mid=%s" % (mc["label"], cinfo(mc), sc["label"], cinfo(sc), K, Km and round(Km, 3)))

    # --- Structure B
    print("## Structure B: multi-contract events with NO nested ladder group (partition/outcome lists), exclusivity by price sums")
    B = [e for e in ev if len(e["contracts"]) >= 2 and not G[e["ticker"]]]
    cls = {}
    for e in B:
        oc = [c for c in e["contracts"] if isopen(c)]
        n = len(oc)
        mids = [mid(c) for c in oc]
        asks = [cinfo(c)[1] for c in oc]
        complete = n >= 2 and all(m is not None for m in mids)
        s_m = sum(mids) if complete else None
        s_a = sum(asks) if n >= 2 and all(a is not None for a in asks) else None
        part = sum(m for m in mids if m is not None)
        # bounds when some contracts lack a bid (mid in [ask/2, ask]); contracts with no quote at all make it unbounded
        noquote = [c for c in oc if cinfo(c) == (None, None)]
        askonly = [cinfo(c)[1] for c in oc if cinfo(c)[0] is None and cinfo(c)[1] is not None]
        lo = part + sum(a / 2 for a in askonly)
        hi = part + sum(askonly)
        if complete and 0.9 <= s_m <= 1.15: k = "likely exclusive"
        elif n >= 2 and not noquote and lo >= 0.85 and hi <= 1.25: k = "likely exclusive"
        elif lo > 1.3: k = "not exclusive"
        else: k = "unclear"
        cls[e["ticker"]] = (k, s_m, s_a, part, n, len(e["contracts"]))
    bycat = collections.defaultdict(collections.Counter)
    sums = collections.defaultdict(list)
    for e in B:
        k, sm, sa, part, n, tot = cls[e["ticker"]]
        bycat[cat(e)][k] += 1
        if sm is not None: sums[(cat(e), k)].append(sm)
    table([(c, sum(v.values()), v["likely exclusive"], v["not exclusive"], v["unclear"]) for c, v in sorted(bycat.items())],
          ["category", "events", "likely exclusive", "not exclusive", "unclear"])
    print("Sum-of-mid distribution (events where every open contract has bid and ask) per (category, class):")
    table([(c, k, stats(v)) for (c, k), v in sorted(sums.items())], ["category", "class", "sum of mids"])
    print("Strike types in B events:", dict(collections.Counter(str(strike_type(c)) for e in B for c in e["contracts"])))
    print("Event type in B events:", dict(collections.Counter((cat(e), e.get("type")) for e in B)))
    for k in ("likely exclusive", "not exclusive", "unclear"):
        print("Examples", k)
        seen = collections.Counter(); n = 0
        for e in B:
            if cls[e["ticker"]][0] != k or seen[cat(e)] >= 1: continue
            seen[cat(e)] += 1; n += 1
            _, sm, sa, part, nn, tot = cls[e["ticker"]]
            print("  -", e["ticker"], "|", e["title"], "|", cat(e), "| contracts=%d open=%d" % (tot, nn),
                  "| sum_mid=%s sum_ask=%s partial_mid_sum=%.2f" % (sm and round(sm, 3), sa and round(sa, 3), part), "|", [c["label"] for c in e["contracts"][:4]])
            if n >= 5: break

    # --- Structure C sports
    print("\n## Structure C: sports")
    S = [e for e in ev if cat(e) == "Sports"]
    print("sports events:", len(S), "top-level:", sum(e["_parent"] is None for e in S), "children:", sum(e["_parent"] is not None for e in S))
    suf = collections.Counter(e["ticker"].rsplit("-", 1)[-1] for e in S)
    print("ticker suffix counts:", suf)
    table(sorted(collections.Counter((e["ticker"].rsplit("-", 1)[-1], e.get("type"), tuple(sorted({str(strike_type(c)) for c in e["contracts"]}))) for e in S).items()),
          ["(suffix, type, strike types)", "events"])
    gm = collections.defaultdict(set)
    for e in S:
        gm[e["_parent"] or e["ticker"]].add(e["ticker"].rsplit("-", 1)[-1])
    print("games by set of market-suffixes in one parent:", collections.Counter(tuple(sorted(v)) for v in gm.values()))
    shown = collections.Counter()
    for e in S:
        s_ = e["ticker"].rsplit("-", 1)[-1]
        if s_ in ("S", "T") and shown[s_] < 3:
            shown[s_] += 1
            print("EXAMPLE", s_, e["ticker"], "|", e["title"], "| parent:", e["_parent"])
            for c in e["contracts"][:4]:
                print("     ", c["label"], c.get("strike"), cinfo(c), c.get("marketState"))

    # --- Liquidity
    print("\n## Liquidity per category (open contracts)")
    rows = []
    for k in sorted({cat(e) for e in ev}):
        oc = [c for e in ev if cat(e) == k for c in e["contracts"] if isopen(c)]
        both = [c for c in oc if None not in cinfo(c)]
        sp = [cinfo(c)[1] - cinfo(c)[0] for c in both]
        bids = [cinfo(c)[0] for c in both]; asks = [cinfo(c)[1] for c in both]
        rows.append((k, len(oc), "%.0f%%" % (100 * len(both) / max(1, len(oc))),
                     "%.3f" % statistics.median(sp) if sp else "-",
                     "%.2f/%.2f" % (statistics.median(bids), statistics.median(asks)) if both else "-"))
    table(rows, ["category", "open contracts", "share w/ bid&ask", "median spread", "median bid/ask"])

    # --- Single-contract events
    print("## Single-contract-only events by category")
    table(sorted(collections.Counter(cat(e) for e in ev if len(e["contracts"]) == 1).items()), ["category", "events"])
    print("events with 0 contracts:", sum(len(e["contracts"]) == 0 for e in ev))

    # --- Top examples
    print("\n## Best concrete examples (nested ladders, executable, tight, K-Kmid small, one per category, then fill)")
    cand = []
    for x in allp:
        e, a, b, K, Km, _t = x
        if Km is None: continue
        ba, aa = cinfo(a); bb, ab = cinfo(b)
        if ba < 0.25 or ab < 0.05 or K > 0.90 or K < 0.10 or (aa - ba) > 0.04 or (ab - bb) > 0.04: continue
        cand.append((max(0, K - Km) + (aa - ba) + (ab - bb), x))
    cand.sort(key=lambda t: t[0])
    chosen = []; usedfam = set()
    for _, x in cand:
        e = x[0]
        fam_ = (cat(e), e["ticker"].rsplit("-", 1)[-1] if cat(e) == "Sports" else e["ticker"][:3])
        if fam_ in usedfam: continue
        usedfam.add(fam_); chosen.append(x)
        if len(chosen) >= 14: break
    for e, a, b, K, Km, _t in chosen:
        print("- [%s] %s | Given '%s' (bid/ask %s), will '%s' (bid/ask %s)? costs %.0f cents per $1 (fair K_mid %.0f cents) | %s" % (
            cat(e), e["title"], a["label"], cinfo(a), b["label"], cinfo(b), K * 100, Km * 100, e["ticker"]))

if __name__ == "__main__":
    commands = {"fetch": fetch, "explore": explore, "report": report}
    if len(sys.argv) < 2 or sys.argv[1] not in commands:
        print(__doc__.strip())
        sys.exit(1)
    commands[sys.argv[1]]()
