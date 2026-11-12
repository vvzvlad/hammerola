"""Parts search on szlcsc.com (LCSC's domestic shop): the category tree, keyword search, foreign distributors' offers resold by szlcsc, a category's brands, packages and spec values, whole categories harvested to JSONL and CSV under a price cap (resumable), LCSC's English detail per part, datasheet PDFs, the CNY-per-USD rate, and a shortlist JSON written out as CSV; the site's anti-bot cookies (its RC4 one and Aliyun WAF's acw_sc__v2) are solved on the way.
usage: python3 parts.py tree [--grep S] [--json] | search KEYWORD [--rate R] [--json] | overseas KW... [--provider P]... [--out F.jsonl] [--rate R] [--control KW]... [--json] | params ID [--json] | harvest ID... [--out PREFIX] [--max-cny X] [--max-usd-1k X] [--rate R] [--brand CODE] [--include-oos] [--delay 0.35] | detail CODE... [--json] | datasheet [CODE...] [--codes-file F] [-d DIR] [--map-file F] | rate [--json] | report SPEC.json --csv OUT.csv   (price of a part: the CNY ladder step that covers 1000 pcs, in USD at the live rate unless --rate; search shows at most 30 hits; harvest appends to PREFIX.jsonl and writes PREFIX.csv and PREFIX.state.json, PREFIX szlcsc_harvest in the current directory by default, slices a query over the server's 1500 rows by brand, package, then 1-pc price, --max-usd-1k caps the 1-pc price at 2.2 x that x rate, and the same command run again resumes; datasheet saves DIR/<CODE>.pdf, DIR the current directory by default, only for a body that starts with %PDF-, and records progress in DIR/ds_map.json; report SPEC: {"reference": row or null, "columns": [{"key", "label"}...], "rows": [...]}, the reference first, a "<key>_note" in any row adds a "<label> — note" column after that column, "url" last)
needs: python3 (stdlib only)"""
# Ported from Wiren Board's wb-component-search skill (scripts/szlcsc.py and scripts/report.py):
#
# MIT License
#
# Copyright (c) 2026 Wiren Board
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.
import sys, os, re, csv, json, time, base64, random, argparse
import http.client, http.cookiejar, urllib.error, urllib.parse, urllib.request
from pathlib import Path

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0"
RC4_KEY = b"tg09It3*9h"
# Aliyun WAF's acw_sc__v2 as the challenge page's own script computes it: the first 40 characters of the page's arg1
# shuffled by a PRNG with a constant seed, then read off by columns whose count the PRNG, reseeded from a constant,
# picks — together a fixed position table; a constant before them, and after them one random byte per bot check, odd for "yes", answered as a
# browser does (no navigator, navigator.webdriver, globalThis is window, then two constants)
WAF_PREFIX = "1234cf0d46"
WAF_ORDER = (7, 34, 35, 21, 0, 16, 4, 26, 11, 30, 15, 3, 32, 38, 31, 39, 5, 10, 14, 13,
             2, 12, 8, 17, 18, 22, 9, 23, 33, 24, 36, 25, 20, 6, 28, 27, 1, 37, 19, 29)
WAF_CHECKS = (0, 0, 1, 1, 0)
LIST = "https://list.szlcsc.com"
DETAIL_URL = "https://wmsc.lcsc.com/ftps/wm/product/detail?productCode={}"
OVERSEAS = "https://overseas.szlcsc.com"  # the search page's per-distributor tabs: foreign stock resold by szlcsc
FX_URL = "https://open.er-api.com/v6/latest/USD"
SLICE_CAP = 1500  # the server serves at most 50 pages x 30 rows per query
TAG_RE = re.compile(r"<[^>]+>")
BROWSER = {"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8", "Referer": LIST + "/", "Origin": LIST}
NET_ERRORS = (OSError, http.client.HTTPException)  # urllib's URLError and socket timeouts are OSError
URL_SAFE = ":/?#[]@!$&'()*+,;=%~"  # left as they are when a URL is percent-encoded


# ---------------------------------------------------------------- HTTP layer
def fetch(session, req):
    """The one call that touches the network: (status, content type, body) of one request. Redirects are followed and
    cookies kept in the session's jar; an HTTP error status is returned, not raised, as httpx in the source does."""
    try:
        with session.opener.open(req, timeout=session.timeout) as r:
            return r.status, r.headers.get("Content-Type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type", ""), e.read()


class Session:
    """Headers, timeout and cookie jar shared by the requests of one run, as the source's httpx client."""

    def __init__(self, headers=None, timeout=30):
        self.headers, self.timeout = dict({"Accept": "*/*"}, **(headers or {})), timeout
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))

    def get(self, url, query=None, headers=None):
        if query:
            url += "?" + urllib.parse.urlencode(query)
        # httpx percent-encodes a URL with spaces or non-ASCII characters (a datasheet link); urllib refuses one
        url = urllib.parse.quote(url, safe=URL_SAFE)
        return fetch(self, urllib.request.Request(url, headers=dict(self.headers, **(headers or {}))))

    def post_json(self, url, payload):
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
        return fetch(self, urllib.request.Request(url, data=body, method="POST",
                                                  headers=dict(self.headers, **{"Content-Type": "application/json"})))

    def set_cookie(self, name, value, host):
        self.jar.set_cookie(http.cookiejar.Cookie(
            version=0, name=name, value=value, port=None, port_specified=False, domain=host, domain_specified=True,
            domain_initial_dot=host.startswith("."), path="/", path_specified=True, secure=False, expires=None,
            discard=True, comment=None, comment_url=None, rest={"HttpOnly": None}))


def make_client():
    return Session(BROWSER, 30)


def text(body):
    return body.decode("utf-8", "replace")


def rc4(key, data):
    """Plain RC4, used by the site's anti-bot cookie challenge."""
    box, j = list(range(256)), 0
    for i in range(256):
        j = (j + box[i] + key[i % len(key)]) % 256
        box[i], box[j] = box[j], box[i]
    out, i, j = bytearray(), 0, 0
    for byte in data:
        i = (i + 1) % 256
        j = (j + box[i]) % 256
        box[i], box[j] = box[j], box[i]
        out.append(byte ^ box[(box[i] + box[j]) % 256])
    return bytes(out)


def is_captcha(page):
    """True when the body is the WAF's captcha page (Tencent's TCaptcha posting to /WafCaptcha) instead of the content."""
    head = page[:2000]
    return "TencentCaptcha" in head or "WafCaptcha" in head


def is_challenge(page):
    """True when the body is the JS anti-bot challenge instead of the content."""
    head = page[:2000]
    return "_xvasu" in head and "_xvpfs" in head


def challenge_cookie(page):
    """(name, value) of the tws2_* cookie a challenge page expects: base64(RC4(key, "<pts>:<asu>")), name <pfs><asu>."""
    asu = re.search(r"_xvasu\s*=\s*(\d+)", page)
    pts = re.search(r"_xvpts\s*=\s*([\d.]+)", page)
    pfs = re.search(r'_xvpfs\s*=\s*"([^"]+)"', page)
    if not (asu and pts and pfs):
        raise RuntimeError("unrecognized anti-bot challenge format — the site changed")
    asu, pts, pfs = asu.group(1), pts.group(1), pfs.group(1)
    if pts.endswith(".0"):  # the page's JS prints the number without it
        pts = pts[:-2]
    return pfs + asu, base64.b64encode(rc4(RC4_KEY, ("%s:%s" % (pts, asu)).encode())).decode()


def solve_challenge(page, s, host):
    s.set_cookie(*challenge_cookie(page), host)


def is_waf(page):
    """True when the body is Aliyun WAF's acw_sc__v2 challenge page instead of the content (it answers HTTP 200)."""
    head = page[:2000]
    return "aliyun_waf_aa" in head and "arg1=" in head


def waf_cookie(page):
    """The acw_sc__v2 value the WAF page's script sets for its arg1."""
    m = re.search(r"arg1='([0-9a-fA-F]{40,})'", page)
    if not m:
        raise RuntimeError("unrecognized Aliyun WAF page — the site changed")
    return "%s-%s%s" % (WAF_PREFIX, "".join(m.group(1)[i] for i in WAF_ORDER).lower(),
                        "".join("%02x" % (random.randrange(64) * 2 + yes) for yes in WAF_CHECKS))


def solve_waf(page, s, url, again):
    """Answers a WAF page with its cookie; the WAF page again right after that is the end of the run."""
    if again:
        raise SystemExit("parts: szlcsc anti-bot not passed: the Aliyun WAF page came back after its acw_sc__v2 "
                         "cookie was set (%s)" % url)
    s.set_cookie("acw_sc__v2", waf_cookie(page), urllib.parse.urlsplit(url).hostname or "")


def get_html(s, url, retries=4):
    """GET that solves both anti-bot challenges on the way and retries transient network errors."""
    host, last, waf = urllib.parse.urlsplit(url).hostname or "", None, False
    for attempt in range(retries):
        try:
            status, _, body = s.get(url)
        except NET_ERRORS as e:  # a transient hiccup on a big page
            last = e
            time.sleep(1.0 + attempt)
            continue
        page = text(body)
        if is_captcha(page):  # a wall not to be got around: no retry
            raise SystemExit("parts: szlcsc answered a captcha (%s): stop and tell the owner" % url)
        if is_challenge(page):
            solve_challenge(page, s, host)
            continue
        if is_waf(page):
            solve_waf(page, s, url, waf)
            waf = True
            continue
        if status >= 400:
            raise RuntimeError("GET %s: HTTP %d" % (url, status))
        return page
    raise RuntimeError("GET %s failed after %d attempts (last: %s)" % (url, retries, last or "still challenged"))


def api_post(s, path, payload, retries=4):
    """POST to a list.szlcsc.com JSON endpoint, solving the challenge again whenever it comes back."""
    last, waf = None, False
    for attempt in range(retries):
        try:
            status, _, body = s.post_json(LIST + path, payload)
            page = text(body)
            if is_captcha(page):  # a wall not to be got around: no retry
                raise SystemExit("parts: szlcsc answered a captcha (%s): stop and tell the owner" % (LIST + path))
            if is_challenge(page):
                solve_challenge(page, s, "list.szlcsc.com")
                continue
            if is_waf(page):
                solve_waf(page, s, LIST + path, waf)
                waf = True
                continue
            if status < 400:
                return json.loads(page)
            last = "HTTP %d" % status
        except NET_ERRORS + (ValueError,) as e:  # a network or gateway hiccup, a body that is not JSON
            last = e
        time.sleep(1.0 + attempt)
    raise RuntimeError("API POST %s failed: %s" % (path, last))


# ---------------------------------------------------------------- data layer
def base_query(catalog_id, page=1):
    """The /category/product payload; spotFilter 1 favours parts in stock, but rows with stock 0 still come through."""
    return {"currentPage": page, "pageSize": 30, "catalogIdFilter": str(catalog_id), "brandIdFilter": "",
            "standardFilter": "", "brandPlaceFilter": "", "brandOriginFilter": "", "labelFilter": "", "arrangeFilter": "",
            "smtLabelFilter": "", "spotFilter": 1, "discountFilter": 1, "startPrice": "", "endPrice": "", "sortNumber": 0,
            "queryParameterValue": "", "lastParamName": "", "keyword": "", "secondKeyword": "", "hasDataFile": False,
            "demandNumber": "", "satisfyStockType": "", "queryProductTypeCode": ""}


def strip_tags(value):
    """Removes the search highlighter's <SPAN> markup from a string."""
    return TAG_RE.sub("", value) if isinstance(value, str) else value


def price_at_1000(ladder):
    """(price, from-qty) for buying 1000 pcs: the ladder step that covers 1000, or the smallest step above it."""
    if not ladder:
        return None, None
    eligible = [(q, p) for q, p in ladder if q <= 1000]
    qty, price = max(eligible) if eligible else min(ladder)
    return price, qty


def usd(cny, rate):
    return round(cny / rate, 4) if (cny is not None and rate) else None


def flatten(rec, rate=None):
    """One listing or search record as a flat row: prices parsed, tags stripped, the catalog's specs as spec:<name>."""
    pvo = rec.get("productVO") or {}
    ladder = []
    for step in pvo.get("productPriceList") or []:
        try:
            ladder.append((int(step["spNumber"]), float(step["productPrice"])))
        except (KeyError, TypeError, ValueError):
            continue
    ladder.sort()
    cny_1k, basis = price_at_1000(ladder)
    row = {"code": strip_tags(rec.get("lightProductCode")), "model": strip_tags(rec.get("lightProductModel")),
           "brand": strip_tags(rec.get("lightBrandName")), "package": strip_tags(rec.get("lightStandard")),
           "catalog_id": pvo.get("productTypeCode"), "catalog_name": strip_tags(pvo.get("productType")),
           "stock": pvo.get("stockNumber"), "min_qty": pvo.get("minBuyNumber"),
           "price_cny_1pc": ladder[0][1] if ladder else None, "price_cny_1k": cny_1k, "price_1k_basis_qty": basis,
           "price_usd_1k": usd(cny_1k, rate), "price_cny_ladder": "; ".join("%d+:%s" % (q, p) for q, p in ladder),
           "url": "https://item.szlcsc.com/%s.html" % pvo["productId"] if pvo.get("productId") else None,
           "description": strip_tags(rec.get("lightProductName") or rec.get("lightProductIntro"))}
    for key, val in (rec.get("paramLinkedMap") or {}).items():
        row["spec:" + key] = val
    return row


def get_page(s, catalog_id, page, filters):
    """One /category/product page: its searchResult."""
    data = api_post(s, "/category/product", dict(base_query(catalog_id, page), **filters))
    if data.get("code") != 200:
        raise RuntimeError("api code %s: %s" % (data.get("code"), data.get("msg")))
    return (data.get("result") or {}).get("searchResult") or {}


def get_param_groups(s, catalog_id, filters):
    """Filter metadata of a query (/parameter): brands and packages with their codes, spec values."""
    data = api_post(s, "/parameter", dict(base_query(catalog_id), **filters))
    if data.get("code") != 200:
        raise RuntimeError("/parameter api code %s: %s" % (data.get("code"), data.get("msg")))
    return (data.get("result") or {}).get("paramGroupMap") or {}


def flatten_overseas(rec, rate=None):
    """One foreign distributor's offer as a flat row (CNY with VAT, the discount applied)."""
    discount = rec.get("productDiscount") or 1
    ladder = []
    for step in rec.get("tieredPrices") or []:
        try:
            ladder.append((int(step["countStart"]), round(float(step["price"]) * discount, 4)))
        except (KeyError, TypeError, ValueError):
            continue
    ladder.sort()
    # a distributor's lot is finite: price the quantity that can really be bought, 1000 pcs or the whole stock
    stock = rec.get("stockNumber") or 0
    reachable = [(q, p) for q, p in ladder if q <= max(min(1000, stock), rec.get("minBuyNumber") or 1)] if stock else ladder
    cny_1k, basis = price_at_1000(reachable or ladder[:1])
    return {"provider": rec.get("provider"), "model": strip_tags(rec.get("productCodeManufacturer")),
            "brand": strip_tags(rec.get("productGradePlateName")), "stock": rec.get("stockNumber"),
            "min_qty": rec.get("minBuyNumber"), "multiple": rec.get("incrementalQuantity"),
            "lead_time": rec.get("deliveryTimeWayDays"), "price_cny_1k": cny_1k, "price_1k_basis_qty": basis,
            "price_usd_1k": usd(cny_1k, rate), "price_cny_ladder": "; ".join("%d+:%s" % (q, p) for q, p in ladder),
            "region": rec.get("productRegion"), "packaging": rec.get("packaging"), "date_code": rec.get("batchNumber"),
            "code": rec.get("productCode"), "description": strip_tags(rec.get("productDesc"))}


def overseas_get(s, path, query=None):
    """GET an overseas.szlcsc.com JSON endpoint; returns its `result`."""
    status, ctype, body = s.get(OVERSEAS + path, query)
    if status != 200 or "json" not in ctype:
        raise RuntimeError("overseas %s: HTTP %d, not JSON (site check?)" % (path, status))
    data = json.loads(text(body))
    if data.get("code") != 200:
        raise RuntimeError("overseas %s: code %s %s" % (path, data.get("code"), data.get("msg")))
    return data.get("result") or []


def overseas_query(keyword, provider, page):
    return {"keyword": keyword, "providers": provider, "pageNumber": page, "noShowSelf": "false", "from": keyword}


def provider_names(s, providers):
    return providers or [p["provider"] for p in overseas_get(s, "/overseas/search/providers")]


def overseas_offers(s, keyword, providers=None, rate=None, delay=0.4, max_pages=40):
    """Every foreign offer whose MPN starts with `keyword`: one request per provider and page."""
    rows = []
    for name in provider_names(s, providers):
        page, pages = 1, 1
        while page <= min(pages, max_pages):
            for block in overseas_get(s, "/overseas/search/" + name, overseas_query(keyword, name, page)):
                pages = max(pages, block.get("pageTotal") or 1)
                rows += [flatten_overseas(rec, rate) for rec in block.get("products") or []]
            page += 1
            time.sleep(delay)
    return rows


def overseas_alive(s, controls, providers=None):
    """True if a control keyword (one known to have offers) still returns offers: catches an export that answers
    with empty, well-formed JSON. Page 1 only, one request per provider."""
    names = provider_names(s, providers)
    for keyword in controls:
        for name in names:
            if any(b.get("total") for b in overseas_get(s, "/overseas/search/" + name, overseas_query(keyword, name, 1))):
                return True
    return False


def fetch_rate(fallback=None):
    """The live CNY-per-USD rate; `fallback` when the request fails."""
    try:
        rate = json.loads(text(Session(timeout=10).get(FX_URL)[2])).get("rates", {}).get("CNY")
        return float(rate) if rate else fallback
    except NET_ERRORS + (ValueError,):
        return fallback


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def emit(data):
    """The --json envelope: {"ok": true, "data": ...}."""
    print(json.dumps({"ok": True, "data": data}, ensure_ascii=False, indent=1))


def emit_error(code, message, as_json):
    """A named error: the envelope with --json, a line on stderr otherwise."""
    if as_json:
        print(json.dumps({"ok": False, "error": {"code": code, "message": message}}, ensure_ascii=False))
    else:
        log("error [%s]: %s" % (code, message))


def dash(v):
    return "—" if v is None else v


# ---------------------------------------------------------------- commands
LEAF_RE = re.compile(r'href="https://list\.szlcsc\.com/catalog/(\d+)\.html"[^>]*>([^<]+)<span[^>]*>（(?:<!-- -->)?([\d,]+)')


def cmd_tree(a):
    """The whole catalog tree (group > leaf, id, product count) from www.szlcsc.com."""
    page = get_html(make_client(), "https://www.szlcsc.com/catalog.html")
    groups = [(m.start(), m.group(1)) for m in re.finditer(r"<h2>([^<]+)<span", page)]
    leaves = []
    for m in LEAF_RE.finditer(page):
        group = ""
        for pos, name in groups:
            if pos >= m.start():
                break
            group = name
        leaves.append({"id": m.group(1), "name": m.group(2).strip(), "group": group,
                       "count": int(m.group(3).replace(",", ""))})
    if a.grep:
        needle = a.grep.lower()
        leaves = [l for l in leaves if needle in l["name"].lower() or needle in l["group"].lower() or needle == l["id"]]
    if a.json:
        return emit(leaves)
    for l in leaves:
        print("%6s  %s > %s  (%d)" % (l["id"], l["group"], l["name"], l["count"]))
    print("-- %d categories" % len(leaves))


def cmd_search(a):
    """Keyword search on so.szlcsc.com: a reference part's code, category id and price in one request."""
    fx_rate = a.rate or fetch_rate()
    page = get_html(make_client(), "https://so.szlcsc.com/global.html?k=" + urllib.parse.quote(a.keyword))
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', page, re.S)
    if not m:
        emit_error("SearchFormatError", "no __NEXT_DATA__ on the search page — site changed?", a.json)
        sys.exit(2)
    try:
        result = json.loads(m.group(1))["props"]["pageProps"]["soData"]["searchResult"]
    except (ValueError, KeyError, TypeError) as e:
        emit_error("SearchFormatError", "unexpected search payload shape (%s) — site changed?" % e, a.json)
        sys.exit(2)
    rows = [flatten(rec, fx_rate) for rec in result.get("productRecordList") or []]
    total = result.get("totalCount")
    if a.json:
        return emit({"totalCount": total, "shown": len(rows), "rate_cny_per_usd": fx_rate, "rows": rows})
    for r in rows:
        print("%10s  %s  [%s]  %s  cat=%s(%s)  stock=%s  1k=%sCNY/%sUSD  %s" % (
            r["code"], r["model"], r["brand"], r["package"], r["catalog_id"], r["catalog_name"], r["stock"],
            dash(r["price_cny_1k"]), dash(r["price_usd_1k"]), r["url"]))
    print("-- shown %d of %s (narrow the keyword if truncated)" % (len(rows), total))


def cmd_overseas(a):
    """Foreign distributors' offers resold by szlcsc: `search` and `harvest` see szlcsc's own stock only, and a part
    with stock 0 there may still be orderable here."""
    fx_rate = a.rate or fetch_rate()
    s, providers, rows = make_client(), a.provider or None, []
    try:
        for i, keyword in enumerate(a.keywords):
            if a.control and i % 50 == 0 and not overseas_alive(s, a.control, providers):
                raise RuntimeError("control keywords %s returned no offers before %r — export broken" % (a.control, keyword))
            rows += [dict({"keyword": keyword}, **r) for r in overseas_offers(s, keyword, providers, fx_rate)]
        if a.control and not overseas_alive(s, a.control, providers):
            raise RuntimeError("control keywords %s returned no offers at the end — results are incomplete" % a.control)
    except NET_ERRORS + (RuntimeError, ValueError) as e:
        emit_error("OverseasError", str(e), a.json)
        sys.exit(2)
    if a.out:
        with open(a.out, "a", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    if a.json:
        return emit({"shown": len(rows), "rate_cny_per_usd": fx_rate, "rows": rows})
    for r in rows:
        print("%16s  %s  [%s]  stock=%s  moq=%s  1k=%sCNY/%sUSD (from %s)  %s" % (
            r["provider"], r["model"], r["brand"], r["stock"], r["min_qty"], dash(r["price_cny_1k"]),
            dash(r["price_usd_1k"]), r["price_1k_basis_qty"], r["lead_time"]))
    print("-- %d overseas offers" % len(rows))


def cmd_params(a):
    """A category's brands (with the codes harvest slices by), packages and spec values."""
    s = make_client()
    get_html(s, "%s/catalog/%s.html" % (LIST, a.catalog_id))
    out = {}
    for key, val in get_param_groups(s, a.catalog_id, {}).items():
        if isinstance(val, dict):
            out[key] = {"label": val.get("paramName"),
                        "values": [{"name": d.get("name"), "code": d.get("code")} for d in val.get("paramDetailList") or []]}
    if a.json:
        return emit(out)
    for key, val in out.items():
        names = ", ".join("%s[%s]" % (v["name"], v["code"]) if v["code"] else str(v["name"]) for v in val["values"][:12])
        more = "" if len(val["values"]) <= 12 else " … +%d" % (len(val["values"]) - 12)
        print("%s (%s): %s%s" % (key, val["label"], names, more))


def pull_slice(s, catalog_id, label, seen, fp, rate, delay, filters):
    """Every page of one filtered query; appends the rows not seen yet. Returns (new rows, the server's total)."""
    page, added, total = 1, 0, 0
    while True:
        result = get_page(s, catalog_id, page, filters)
        total = result.get("totalCount") or 0
        records = result.get("productRecordList") or []
        if not records:
            break
        for rec in records:
            row = flatten(rec, rate)
            if row["code"] and row["code"] not in seen:
                seen.add(row["code"])
                row["harvest_catalog_id"] = catalog_id
                fp.write(json.dumps(row, ensure_ascii=False) + "\n")
                added += 1
        fp.flush()
        pages = result.get("countPage") or 0
        log("  [%s] page %d/%d total=%d new=%d" % (label, page, pages, total, added))
        if page >= pages:
            break
        page += 1
        time.sleep(delay)
    return added, total


def cmd_harvest(a):
    """Whole category listings to JSONL and CSV, sliced by brand, package and price to get past the 1500-row cap."""
    out_path, state_path = Path(a.out + ".jsonl"), Path(a.out + ".state.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    state = {"done": [], "seen": [], "fx_rate": None, "max_cny": None}
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))
    # a price band's slice id carries CNY bounds derived from the rate: a resumed run keeps the stored rate and cap,
    # or none of the stored bands matches and the coverage drifts
    if state.get("fx_rate"):
        fx_rate = state["fx_rate"]
        if a.rate and abs(a.rate - fx_rate) > 1e-9:
            log("resume: ignoring --rate %s, keeping stored %s" % (a.rate, fx_rate))
    else:
        fx_rate = a.rate or fetch_rate(6.9)
    log("rate: %s CNY/USD" % fx_rate)
    max_cny = a.max_cny
    if state.get("max_cny"):
        if max_cny and abs(max_cny - state["max_cny"]) > 1e-9:
            log("resume: ignoring --max-cny %s, keeping stored %s" % (max_cny, state["max_cny"]))
        max_cny = state["max_cny"]
    elif a.max_usd_1k and not max_cny:
        max_cny = round(a.max_usd_1k * fx_rate * 2.2, 2)
        log("server 1-pc price cap: %s CNY (2.2x margin over %s USD@1k)" % (max_cny, a.max_usd_1k))

    done, seen = set(state["done"]), set(state["seen"])
    # the .jsonl is the record of what was written: a run killed mid-slice leaves rows on disk that the state's `seen`
    # lacks, and without them the same command run again would append duplicates
    torn_tail = False
    if out_path.exists():
        written = out_path.read_text(encoding="utf-8")
        torn_tail = bool(written) and not written.endswith("\n")
        for line in written.splitlines():
            try:
                seen.add(json.loads(line)["code"])
            except (ValueError, KeyError, TypeError):
                continue  # a line torn by the kill: its row is pulled again
    if seen:
        log("resuming: %d rows, %d slices done" % (len(seen), len(done)))

    s = make_client()
    get_html(s, "%s/catalog/%s.html" % (LIST, a.catalog_ids[0]))
    base = {}
    if max_cny:
        base["endPrice"] = str(max_cny)
    if a.brand:
        base["brandIdFilter"] = a.brand
    if a.include_oos:
        base["spotFilter"] = ""

    def save_state():
        tmp = state_path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps({"done": sorted(done), "seen": sorted(seen), "fx_rate": fx_rate, "max_cny": max_cny}),
                       encoding="utf-8")
        os.replace(tmp, state_path)

    with out_path.open("a", encoding="utf-8") as fp:
        if torn_tail:  # end the line the kill tore, or the first row appended is glued onto it and lost
            fp.write("\n")

        def pull(cat, label, filters):
            pull_slice(s, cat, label, seen, fp, fx_rate, a.delay, filters)

        def run_slice(cat, label, extra):
            # keyed by the whole filter set: the base filters (--brand, --include-oos, the cap) change the request,
            # so a run with other flags must not skip the slice as done
            merged = dict(base, **extra)
            slice_id = "%s|%s" % (cat, json.dumps(merged, sort_keys=True))
            if slice_id in done:
                return
            if (get_page(s, cat, 1, merged).get("totalCount") or 0) < SLICE_CAP:
                pull(cat, label, merged)
            elif not merged.get("brandIdFilter"):  # over the cap: brands, then packages, then price bisection
                refine(cat, label, extra, merged, "queryProductGradePlateId", "brandIdFilter", "brands")
            elif not merged.get("standardFilter"):
                refine(cat, label, extra, merged, "queryProductStandard", "standardFilter", "packages")
            else:
                bisect(cat, label, extra)
            done.add(slice_id)
            save_state()

        def refine(cat, label, extra, merged, group, key, what):
            values = (get_param_groups(s, cat, merged).get(group) or {}).get("paramDetailList") or []
            values = [v for v in values if v.get("code")]
            if not values:  # an empty or uncoded list (a flaky /parameter, packages of some categories): never drop the slice
                return bisect(cat, label, extra)
            log("  [%s] capped -> slicing %d %s" % (label, len(values), what))
            for v in values:
                run_slice(cat, "%s/%s" % (label, v["name"]), dict(extra, **{key: v["code"]}))

        def bisect(cat, label, extra):
            merged = dict(base, **extra)
            low = float(merged.get("startPrice") or 0)
            high = float(merged.get("endPrice") or 100000)  # uncapped: no real 1-pc price is above it
            mid = round((low + high) / 2, 2)
            if high - low < 0.02:
                log("  [%s] price band exhausted, accepting first %d" % (label, SLICE_CAP))
                return pull(cat, label, merged)
            log("  [%s] capped -> price bisect %s..%s..%s" % (label, low, mid, high))
            run_slice(cat, "%s/<=%s" % (label, mid), dict(extra, startPrice=str(low), endPrice=str(mid)))
            run_slice(cat, "%s/>%s" % (label, mid), dict(extra, startPrice=str(mid), endPrice=str(high)))

        for cat_id in a.catalog_ids:
            run_slice(cat_id, cat_id, {})

    rows, torn, codes = [], 0, set()
    for line in out_path.read_text(encoding="utf-8").splitlines():
        if not line:
            continue
        try:
            row = json.loads(line)
        except ValueError:
            torn += 1
            continue
        if row.get("code") not in codes:
            codes.add(row.get("code"))
            rows.append(row)
    if torn:
        log("warning: skipped %d torn .jsonl line(s) from an interrupted run" % torn)
    fields = list(dict.fromkeys(k for row in rows for k in row))
    with open(a.out + ".csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(rows)
    print("harvest done: %d unique parts -> %s.jsonl / %s.csv" % (len(rows), a.out, a.out))


def cmd_detail(a):
    """Per part from LCSC's international API: English names and specs, the datasheet's pdfUrl, the USD ladder."""
    s, out = Session({"User-Agent": UA, "Accept": "application/json"}, 30), []
    for code in a.codes:
        try:
            data = json.loads(text(s.get(DETAIL_URL.format(code))[2]))
        except NET_ERRORS + (ValueError,) as e:
            out.append({"code": code, "error": str(e)})
            continue
        res = data.get("result") or {}
        out.append({"code": code, "model": res.get("productModel"), "brand_en": res.get("brandNameEn"),
                    "catalog_en": "%s / %s" % (res.get("parentCatalogName"), res.get("catalogName")),
                    "package": res.get("encapStandard"), "intro_en": res.get("productIntroEn"),
                    "pdf_url": res.get("pdfUrl") or res.get("pdfLinkUrl"), "stock_intl": res.get("stockNumber"),
                    "usd_ladder": [{"qty": p.get("ladder"), "usd": p.get("usdPrice")} for p in res.get("productPriceList") or []],
                    "params_en": [{"name": p.get("paramNameEn"), "value": p.get("paramValueEn")}
                                  for p in res.get("paramVOList") or []]})
        time.sleep(0.3)
    if a.json:
        return emit(out)
    for item in out:
        print(json.dumps(item, ensure_ascii=False, indent=1))


def atta_urls(page):
    """atta.szlcsc.com attachment links on a domestic item page (JSON-escaped ones too), PDFs first."""
    urls = []
    for u in re.findall(r"https://atta\.szlcsc\.com/[^\"'\\\s<>]+", page.replace("\\u002F", "/").replace("\\/", "/")):
        u = u.replace("&amp;", "&")
        if u not in urls:
            urls.append(u)
    return [u for u in urls if ".pdf" in u.lower()] + [u for u in urls if ".pdf" not in u.lower()]


def download_pdf(s, url, target, retries=3):
    """Saves the body of `url` to `target` if it is a PDF; returns its size, 0 when it is not one or the GET fails."""
    for attempt in range(retries):
        try:
            blob = s.get(url)[2]
        except NET_ERRORS:
            time.sleep(1.0 + attempt)
            continue
        if blob[:5] != b"%PDF-":  # a WAF or HTML error page would otherwise be saved as the datasheet
            return 0
        target.write_bytes(blob)
        return len(blob)
    return 0


def cmd_datasheet(a):
    """Datasheet PDFs by product code: the international API's pdfUrl, then the attachment links on the domestic item
    page (challenge solved); the rest needs a manual search."""
    todo = list(a.codes)
    if a.codes_file:
        body = Path(a.codes_file).read_text(encoding="utf-8")
        if a.codes_file.endswith(".jsonl"):
            todo += [json.loads(line)["code"] for line in body.splitlines() if line.strip()]
        else:
            todo += [c["code"] if isinstance(c, dict) else c for c in json.loads(body)]
    bad = [c for c in todo if not re.fullmatch(r"C\d+", str(c))]
    if bad:  # a code becomes a file name: a hostile catalog row must not pick the path
        log("skipping %d non-C-code value(s): %s" % (len(bad), bad[:5]))
        todo = [c for c in todo if c not in bad]
    if not todo:
        raise SystemExit("parts: no codes given")
    dest = Path(a.dest)
    dest.mkdir(parents=True, exist_ok=True)
    map_path = Path(a.map_file) if a.map_file else dest / "ds_map.json"
    ds_map = json.loads(map_path.read_text(encoding="utf-8")) if map_path.exists() else {}
    s, browser = Session({"User-Agent": UA}, 60), make_client()
    for idx, code in enumerate(todo):
        target = dest / (code + ".pdf")
        if ds_map.get(code, {}).get("ok") and target.exists():
            continue
        rec, product_id = {"ok": False, "pdf_url": None, "file": None, "bytes": 0, "title": None}, None
        try:
            res = json.loads(text(s.get(DETAIL_URL.format(code), headers={"Accept": "application/json"})[2])).get("result") or {}
            rec.update(title=res.get("title"), pdf_url=res.get("pdfUrl") or res.get("pdfLinkUrl"))
            product_id = res.get("productId")
        except NET_ERRORS + (ValueError,):
            pass
        if rec["pdf_url"]:
            n = download_pdf(s, rec["pdf_url"], target)
            if n:
                rec.update(ok=True, file=str(target), bytes=n)
        if not rec["ok"] and product_id:
            try:
                for url in atta_urls(get_html(browser, "https://item.szlcsc.com/%s.html" % product_id))[:4]:
                    n = download_pdf(s, url, target)
                    if n:
                        rec.update(ok=True, pdf_url=url, file=str(target), bytes=n)
                        break
            except NET_ERRORS + (RuntimeError,):
                pass
        ds_map[code] = rec
        map_path.write_text(json.dumps(ds_map, ensure_ascii=False, indent=1), encoding="utf-8")
        if not rec["ok"] or (idx + 1) % 10 == 0:
            log("[%d/%d] %s ok=%s %s" % (idx + 1, len(todo), code, rec["ok"], rec["title"] or ""))
        time.sleep(0.4)
    ok = sum(1 for rec in ds_map.values() if rec.get("ok"))
    failed = [code for code in todo if not ds_map.get(code, {}).get("ok")]
    print("datasheets: %d ok, %d missing -> rescue these manually (web search / vendor site): %s" % (ok, len(failed), failed[:20]))


def cmd_rate(a):
    """The live CNY-per-USD rate (open.er-api.com)."""
    value = fetch_rate()
    if value is None:
        emit_error("FxError", "rate fetch failed — pass --rate explicitly to other commands", a.json)
        sys.exit(1)
    if a.json:
        return emit({"cny_per_usd": value})
    print("%s CNY per USD" % value)


def cmd_report(a):
    """A shortlist JSON written out as CSV: the reference row first, a note column after every column that has notes,
    url last."""
    spec = json.loads(Path(a.spec).read_text(encoding="utf-8"))
    problems, cols = [], spec.get("columns")
    if not isinstance(cols, list) or not cols:
        problems.append('"columns" must be a non-empty list')
        cols = []
    for i, col in enumerate(cols):
        if not isinstance(col, dict) or not col.get("key") or not col.get("label"):
            problems.append('columns[%d]: every column needs "key" and "label"' % i)
    if not isinstance(spec.get("rows"), list):
        problems.append('"rows" must be a list')
    if problems:
        raise SystemExit("parts: report spec invalid:\n  - " + "\n  - ".join(problems))
    rows = ([spec["reference"]] if spec.get("reference") else []) + spec["rows"]
    fields, labels = [], []
    for col in cols:
        fields.append(col["key"])
        labels.append(col["label"])
        note = col["key"] + "_note"
        if any(r.get(note) for r in rows):  # a hover note is data too: it gets its own column
            fields.append(note)
            labels.append(col["label"] + " — note")
    if "url" not in fields:
        fields.append("url")
        labels.append("url")
    with open(a.csv, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(labels)
        for r in rows:
            w.writerow([r.get(k, "") for k in fields])
    print("wrote %s (%d rows)" % (a.csv, len(spec["rows"])))


def parser():
    p = argparse.ArgumentParser(prog="parts.py")
    sp = p.add_subparsers(dest="cmd", required=True)
    s = sp.add_parser("tree"); s.add_argument("--grep")
    s = sp.add_parser("search"); s.add_argument("keyword"); s.add_argument("--rate", type=float)
    s = sp.add_parser("overseas"); s.add_argument("keywords", nargs="+")
    s.add_argument("--provider", action="append", default=[]); s.add_argument("--out"); s.add_argument("--rate", type=float)
    s.add_argument("--control", action="append", default=[])
    s = sp.add_parser("params"); s.add_argument("catalog_id")
    s = sp.add_parser("harvest"); s.add_argument("catalog_ids", nargs="+"); s.add_argument("--out", default="szlcsc_harvest")
    s.add_argument("--max-cny", type=float); s.add_argument("--max-usd-1k", type=float); s.add_argument("--rate", type=float)
    s.add_argument("--brand", default=""); s.add_argument("--include-oos", action="store_true")
    s.add_argument("--delay", type=float, default=0.35)
    s = sp.add_parser("detail"); s.add_argument("codes", nargs="+")
    s = sp.add_parser("datasheet"); s.add_argument("codes", nargs="*"); s.add_argument("--codes-file")
    s.add_argument("-d", "--dest", default="."); s.add_argument("--map-file")
    sp.add_parser("rate")
    s = sp.add_parser("report"); s.add_argument("spec"); s.add_argument("--csv", required=True)
    for name in ("tree", "search", "overseas", "params", "detail", "rate"):
        sp.choices[name].add_argument("--json", action="store_true")
    return p


CMDS = dict(tree=cmd_tree, search=cmd_search, overseas=cmd_overseas, params=cmd_params, harvest=cmd_harvest,
            detail=cmd_detail, datasheet=cmd_datasheet, rate=cmd_rate, report=cmd_report)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    a = parser().parse_args()
    CMDS[a.cmd](a)


if __name__ == "__main__":
    main()
