"""`skill/scripts/parts.py`: the szlcsc.com parts search ported from Wiren Board's wb-component-search skill.

Pinned here:

  * the anti-bot cookies: RC4 against a public test vector and the source's own known answer, the cookie a challenge
    page asks for, and a GET that answers the challenge and then reads the page; Aliyun WAF's acw_sc__v2 for a
    recorded WAF page against what the page's own script set, the WAF answered on a GET and on a POST, and the WAF
    page coming back after its cookie ending the run instead of printing nothing; a captcha page ending a GET and a
    POST at their first request;
  * tree parses the recorded catalog page; search reads the recorded search page's __NEXT_DATA__: highlight tags
    stripped, the 1000-pc step of the ladder in USD;
  * harvest: --max-usd-1k becomes a server cap of 2.2 x the rate on the 1-pc price and is stored with the rate; a
    query at the 1500-row cut is sliced by brand; a killed run resumes from .state.json and the .jsonl without pulling
    a finished slice again or writing a row twice, and a line the kill tore is ended before rows are appended;
  * detail of a recorded LCSC answer, datasheet keeping only a body that starts with %PDF-, report --csv columns, rate.

No network: `parts.fetch`, the one call that touches it, is replaced by a fake that answers by URL. The WAF and captcha
pages, the catalog and search pages (gzipped), the LCSC detail and the rate bodies under tests/fixtures/parts/ are
recorded; the list.szlcsc.com bodies are built here in the shape of the source's API map. The script is stdlib-only and
is loaded from `skill/scripts/` by path.
"""

import base64
import gzip
import importlib.util
import json
import re
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures" / "parts"
_SPEC = importlib.util.spec_from_file_location("skill_parts", ROOT / "skill" / "scripts" / "parts.py")
parts = importlib.util.module_from_spec(_SPEC)
# no skill/scripts/__pycache__: the hub packs and digests every file under skill/
_bytecode, sys.dont_write_bytecode = sys.dont_write_bytecode, True
_SPEC.loader.exec_module(parts)
sys.dont_write_bytecode = _bytecode

KNOWN_HEX = "dcceb009155297a853b72d15eaa0e09c4ca8133c"  # RC4("tg09It3*9h", "1721739000123:987654"), the source's tests
CHALLENGE = '<html><script>var _xvasu = 987654; var _xvpts = 1721739000123.0; var _xvpfs = "tws2_";</script></html>'
WAF = (FIX / "waf.html").read_text(encoding="utf-8")
# (arg1, the acw_sc__v2 the page's own script set for it in node): how they were taken is in the file
WAF_VECTORS = json.loads((FIX / "waf_vectors.json").read_text(encoding="utf-8"))["vectors"]


def recorded(name):
    return gzip.decompress((FIX / name).read_bytes())


def waf_until_solved(content):
    """A route answering the recorded WAF page until a request carries the cookie its script computes."""
    expected = WAF_VECTORS[0]["acw_sc__v2"][:-10]  # the last five bytes are random

    def route(s, req):
        s.jar.add_cookie_header(req)
        sent = re.search(r"acw_sc__v2=([\w-]+)", req.get_header("Cookie") or "")
        return content if sent and sent.group(1)[:-10] == expected else WAF
    return route


@pytest.fixture
def net(monkeypatch):
    """parts.fetch replaced: `routes` maps a URL substring to a body (str, bytes, dict) or an exception to raise, or
    to a function of (session, request) returning one; `log` keeps every request."""
    n = types.SimpleNamespace(routes={}, log=[])

    def fake(session, req):
        n.log.append(req)
        for key, body in n.routes.items():
            if key in req.full_url:
                body = body(session, req) if callable(body) else body
                if isinstance(body, BaseException):
                    raise body
                body = json.dumps(body) if isinstance(body, (dict, list)) else body
                return 200, "application/json", body if isinstance(body, bytes) else body.encode()
        raise AssertionError("unexpected request " + req.full_url)

    monkeypatch.setattr(parts, "fetch", fake)
    monkeypatch.setattr(parts.time, "sleep", lambda s: None)
    return n


@pytest.fixture
def run(monkeypatch, capsys):
    """One parts.py run; returns its captured (out, err)."""
    def go(*argv):
        monkeypatch.setattr(sys, "argv", ["parts.py", *map(str, argv)])
        parts.main()
        return capsys.readouterr()
    return go


def rec(code, price=2.0):
    """A listing record as /category/product carries it."""
    return {"lightProductCode": code, "lightProductModel": "M-" + code, "lightBrandName": "BrandCo",
            "lightStandard": "LQFP-32", "lightProductName": "desc", "paramLinkedMap": {"CPU": "M0"},
            "productVO": {"productId": None, "productTypeCode": "11329", "productType": "MCU", "stockNumber": 5,
                          "minBuyNumber": 1, "productPriceList": [
                              {"spNumber": q, "productPrice": round(price * k, 4)} for q, k in ((1, 1), (10, .9), (1000, .7), (5000, .6))]}}


def listing(records, page, total=None):
    return {"code": 200, "result": {"searchResult": {"productRecordList": records[(page - 1) * 30:page * 30],
                                                     "totalCount": len(records) if total is None else total,
                                                     "countPage": max(1, -(-len(records) // 30))}}}


def test_rc4_and_the_challenge_cookie(net):
    assert parts.rc4(b"Key", b"Plaintext").hex() == "bbf316e8d940af0ad3"  # the public RC4 test vector
    assert parts.rc4(b"tg09It3*9h", b"1721739000123:987654").hex() == KNOWN_HEX
    # _xvpts loses its ".0" as the page's JS prints the number
    assert parts.challenge_cookie(CHALLENGE) == ("tws2_987654", base64.b64encode(bytes.fromhex(KNOWN_HEX)).decode())
    with pytest.raises(RuntimeError):
        parts.challenge_cookie("<html>_xvasu _xvpfs</html>")

    def page(s, req):
        s.jar.add_cookie_header(req)
        return "<html>content</html>" if "tws2_987654=" in (req.get_header("Cookie") or "") else CHALLENGE
    net.routes["list.szlcsc.com"] = page
    assert parts.get_html(parts.make_client(), "https://list.szlcsc.com/catalog/1.html") == "<html>content</html>"
    assert len(net.log) == 2


def test_waf_cookie_is_what_the_page_script_sets():
    assert parts.is_waf(WAF) and not parts.is_waf(CHALLENGE)
    first = re.search(r"arg1='(\w+)'", WAF).group(1)
    assert WAF_VECTORS[0]["arg1"] == first

    def checks(cookie):  # the parity of each of the last five bytes answers one of the page's bot checks
        return [int(cookie[i:i + 2], 16) % 2 for i in range(len(cookie) - 10, len(cookie), 2)]
    for v in WAF_VECTORS:
        got = parts.waf_cookie(WAF.replace(first, v["arg1"]))
        assert got[:-10] == v["acw_sc__v2"][:-10] and checks(got) == checks(v["acw_sc__v2"]) == [0, 0, 1, 1, 0]
    with pytest.raises(RuntimeError):
        parts.waf_cookie('<meta name="aliyun_waf_aa">arg1=')


def test_tree_and_params_through_the_waf(net, run):
    net.routes["www.szlcsc.com/catalog.html"] = waf_until_solved(recorded("catalog.html.gz"))
    leaves = json.loads(run("tree", "--json").out)["data"]
    assert len(net.log) == 2  # the WAF page, then the catalog
    assert len(leaves) == 2863 and leaves[0] == {"id": "313", "name": "贴片电容(MLCC)", "group": "电容", "count": 547333}
    assert run("tree", "--grep", "11329").out.splitlines() == [
        " 11329  单片机/微控制器 > 单片机(MCU/MPU/SOC)  (64179)", "-- 1 categories"]
    net.routes["list.szlcsc.com/catalog/"] = "<html>ok</html>"
    net.routes["/parameter"] = waf_until_solved(json.dumps({"code": 200, "result": {"paramGroupMap": {
        "queryProductGradePlateId": {"paramName": "品牌", "paramDetailList": [{"name": "GigaDevice", "code": "b1"}]},
        "total": 3}}}))
    assert json.loads(run("params", "11329", "--json").out)["data"] == {
        "queryProductGradePlateId": {"label": "品牌", "values": [{"name": "GigaDevice", "code": "b1"}]}}


def test_the_waf_page_again_after_its_cookie_ends_the_run(net, run, capsys):
    net.routes["www.szlcsc.com/catalog.html"] = WAF  # the cookie is not taken
    with pytest.raises(SystemExit, match="parts: szlcsc anti-bot not passed"):
        run("tree")
    assert len(net.log) == 2 and "categories" not in capsys.readouterr().out


def test_a_captcha_ends_the_run_at_the_first_request(net):
    net.routes["list.szlcsc.com"] = (FIX / "captcha.html").read_text(encoding="utf-8")
    with pytest.raises(SystemExit, match="captcha"):
        parts.get_html(parts.make_client(), "https://list.szlcsc.com/catalog/11329.html")
    assert len(net.log) == 1
    with pytest.raises(SystemExit, match="captcha"):
        parts.api_post(parts.make_client(), "/category/product", parts.base_query(11329))
    assert len(net.log) == 2


def test_search_reads_the_next_data_of_the_search_page(net, run):
    net.routes["so.szlcsc.com"] = recorded("search_GD32E230K8T6.html.gz")
    out = json.loads(run("search", "GD32E230K8T6", "--rate", "7", "--json").out)["data"]
    assert net.log[0].full_url == "https://so.szlcsc.com/global.html?k=GD32E230K8T6"
    assert (out["totalCount"], out["shown"], out["rate_cny_per_usd"]) == (1, 1, 7.0)
    row = out["rows"][0]  # its model comes as <SPAN CLASS='LUCENE_HIGHLIGHT_CLASS'>GD32E230K8T6</SPAN>
    assert (row["model"], row["price_cny_1pc"], row["price_cny_1k"], row["price_1k_basis_qty"], row["price_usd_1k"]) == (
        "GD32E230K8T6", 4.99, 2.77, 1000, 0.3957)
    assert (row["url"], row["spec:CPU内核"], row["catalog_id"]) == (
        "https://item.szlcsc.com/752130.html", "ARM Cortex-M23", "11329")


def harvest_routes(net, brands, unfiltered_total=None, kill=None):
    """The two list.szlcsc.com endpoints of one category with rows per brand code; returns the logged payloads."""
    payloads = []

    def product(s, req):
        p = json.loads(req.data)
        payloads.append(p)
        if p["brandIdFilter"] and p["brandIdFilter"] == kill:
            return RuntimeError("killed")
        rows = brands[p["brandIdFilter"]] if p["brandIdFilter"] else [r for b in brands.values() for r in b]
        return listing(rows, p["currentPage"], None if p["brandIdFilter"] else unfiltered_total)
    net.routes["list.szlcsc.com/catalog/"] = "<html>ok</html>"
    net.routes["/category/product"] = product
    net.routes["/parameter"] = {"code": 200, "result": {"paramGroupMap": {"queryProductGradePlateId": {"paramDetailList": [
        {"name": "Brand " + b, "code": b} for b in brands] + [{"name": "no code", "code": None}]}}}}
    return payloads


def test_harvest_caps_the_1pc_price_and_keeps_the_stored_rate_and_cap(net, run, tmp_path):
    payloads = harvest_routes(net, {"b1": [rec("C%d" % i) for i in range(45)]})
    out = tmp_path / "dump"
    res = run("harvest", "100", "--out", out, "--max-usd-1k", "1", "--rate", "7", "--delay", "0")
    assert [(p["currentPage"], p["endPrice"], p["spotFilter"], p["catalogIdFilter"]) for p in payloads] == [
        (1, "15.4", 1, "100"), (1, "15.4", 1, "100"), (2, "15.4", 1, "100")]  # the probe, then both pages
    assert "45 unique parts" in res.out
    state = json.loads((tmp_path / "dump.state.json").read_text())
    assert (state["fx_rate"], state["max_cny"], state["done"]) == (7.0, 15.4, ['100|{"endPrice": "15.4"}'])
    assert len((tmp_path / "dump.jsonl").read_text().splitlines()) == 45
    csv_text = (tmp_path / "dump.csv").read_text(encoding="utf-8")
    assert csv_text.startswith("﻿code,model,brand,package,catalog_id") and len(csv_text.splitlines()) == 46

    res = run("harvest", "100", "--out", out, "--max-cny", "99", "--rate", "6.5", "--delay", "0")
    assert "ignoring --rate 6.5, keeping stored 7.0" in res.err and "ignoring --max-cny 99.0, keeping stored 15.4" in res.err
    assert len(payloads) == 3 and "45 unique parts" in res.out  # the slice is done: no page asked again


def test_harvest_slices_at_the_1500_cut_and_resumes_a_killed_run(net, run, tmp_path):
    brands = {"b1": [rec("C1%02d" % i) for i in range(20)], "b2": [rec("C2%02d" % i) for i in range(25)]}
    payloads = harvest_routes(net, brands, unfiltered_total=1500, kill="b2")
    out = tmp_path / "dump"
    with pytest.raises(RuntimeError, match="killed"):
        run("harvest", "100", "--out", out, "--rate", "7", "--delay", "0")
    state = json.loads((tmp_path / "dump.state.json").read_text())
    assert state["done"] == ['100|{"brandIdFilter": "b1"}'] and len(state["seen"]) == 20
    with open(tmp_path / "dump.jsonl", "a") as f:  # a row written after the last state save
        f.write(json.dumps(parts.flatten(brands["b2"][0])) + "\n")

    payloads = harvest_routes(net, brands, unfiltered_total=1500)
    res = run("harvest", "100", "--out", out, "--delay", "0")
    assert [p["brandIdFilter"] for p in payloads] == ["", "b2", "b2"]  # b1 is done: only the parent probe and b2
    codes = [json.loads(l)["code"] for l in (tmp_path / "dump.jsonl").read_text().splitlines()]
    assert len(codes) == len(set(codes)) == 45
    assert "resuming: 21 rows, 1 slices done" in res.err and "45 unique parts" in res.out
    assert json.loads((tmp_path / "dump.state.json").read_text())["fx_rate"] == 7.0


def test_harvest_ends_a_line_torn_by_a_kill_before_appending(net, run, tmp_path):
    harvest_routes(net, {"b1": [rec("C1"), rec("C2")]})
    (tmp_path / "dump.jsonl").write_text(json.dumps(parts.flatten(rec("C1"))) + '\n{"code": "C2", "mo')
    res = run("harvest", "100", "--out", tmp_path / "dump", "--rate", "7", "--delay", "0")
    lines = (tmp_path / "dump.jsonl").read_text().splitlines()
    assert lines[1] == '{"code": "C2", "mo' and json.loads(lines[2])["code"] == "C2"
    assert "2 unique parts" in res.out


def test_detail_of_a_recorded_answer(net, run):
    net.routes["productCode=C712540"] = (FIX / "detail_C712540.json").read_bytes()
    net.routes["productCode=C9"] = OSError("connection reset")
    good, bad = json.loads(run("detail", "C712540", "C9", "--json").out)["data"]
    assert (good["model"], good["brand_en"], good["package"], good["stock_intl"]) == (
        "GD32E230K8T6", "GigaDevice Semicon Beijing", "LQFP-32(7x7)", 866)
    assert good["catalog_en"] == "Embedded Processors & Controllers / Microcontrollers"
    assert good["pdf_url"].startswith("https://datasheet.lcsc.com/datasheet/pdf/")
    assert good["usd_ladder"][-1] == {"qty": 1000, "usd": 0.4545}
    assert {"name": "CPU Core", "value": "ARM Cortex-M23"} in good["params_en"]
    assert bad == {"code": "C9", "error": "connection reset"}


def test_datasheet_keeps_only_a_pdf(net, run, tmp_path):
    net.routes.update({
        "productCode=C1": {"result": {"title": "T1", "pdfUrl": "https://datasheet.lcsc.com/a.pdf", "productId": 1}},
        "productCode=C2": {"result": {"title": "T2", "pdfUrl": "https://datasheet.lcsc.com/b.pdf", "productId": 2}},
        "/a.pdf": b"%PDF-1.7 fake", "/b.pdf": b"<html>WAF</html>",
        "item.szlcsc.com/2.html": '<a href="https://atta.szlcsc.com/upload/c.pdf">', "atta.szlcsc.com": b"<html>no</html>"})
    pdfs = tmp_path / "pdfs"
    res = run("datasheet", "C1", "C2", "../evil", "-d", pdfs)
    assert (pdfs / "C1.pdf").read_bytes() == b"%PDF-1.7 fake" and not (pdfs / "C2.pdf").exists()
    ds = json.loads((pdfs / "ds_map.json").read_text())
    assert (ds["C1"]["ok"], ds["C1"]["bytes"], ds["C2"]["ok"], ds["C2"]["pdf_url"]) == (
        True, 13, False, "https://datasheet.lcsc.com/b.pdf")
    assert "skipping 1 non-C-code value(s): ['../evil']" in res.err
    assert "datasheets: 1 ok, 1 missing" in res.out and "['C2']" in res.out
    asked = len(net.log)
    run("datasheet", "C1", "-d", pdfs)
    assert len(net.log) == asked  # C1 is on disk and in the map
    with pytest.raises(SystemExit, match="parts: no codes given"):
        run("datasheet", "../evil", "-d", pdfs)


def test_report_csv(run, tmp_path):
    out = tmp_path / "short.csv"
    assert run("report", FIX / "report.json", "--csv", out).out == "wrote %s (2 rows)\n" % out
    raw = out.read_bytes().decode("utf-8")
    assert raw.startswith("﻿")
    assert raw[1:].splitlines() == [
        "MPN,Brand,USD@1k,Pinout,Pinout — note,url",
        "GD32E230K8T6,GigaDevice,0.31,,,https://item.szlcsc.com/752130.html",
        "APM32E030K8T6,Geehy,0.27,A,\"pin 1 is VDD, not BOOT0\",https://item.szlcsc.com/1.html",
        "CKS32F030K6T6,CKS,0.22,NONE,,"]
    bad = tmp_path / "bad.json"
    bad.write_text(json.dumps({"columns": [{"key": "mpn"}], "rows": {}}))
    with pytest.raises(SystemExit, match='columns\\[0\\]: every column needs "key" and "label"'):
        run("report", bad, "--csv", out)


def test_rate(net, run):
    net.routes["open.er-api.com"] = (FIX / "rate.json").read_bytes()
    assert json.loads(run("rate", "--json").out) == {"ok": True, "data": {"cny_per_usd": 6.685797}}
    net.routes["open.er-api.com"] = OSError("offline")
    with pytest.raises(SystemExit) as e:
        run("rate")
    assert e.value.code == 1


def test_overseas_prices_what_the_lot_can_supply(net, run, tmp_path):
    offer = {"provider": "future", "productCodeManufacturer": "MT41K", "stockNumber": 500, "minBuyNumber": 2,
             "tieredPrices": [{"countStart": 1, "price": 100.0}, {"countStart": 418, "price": 80.0},
                              {"countStart": 836, "price": 70.0}], "productDiscount": 0.5}

    def search(s, req):
        page = int(dict(x.split("=") for x in req.full_url.split("?")[1].split("&"))["pageNumber"])
        return {"code": 200, "result": [{"total": 3, "pageTotal": 2, "products": [offer] * page}]}
    net.routes["/overseas/search/future"] = search
    out = tmp_path / "offers.jsonl"
    rows = json.loads(run("overseas", "MT41K", "--provider", "future", "--out", out, "--rate", "8", "--json").out)["data"]["rows"]
    assert len(rows) == 3 and len(out.read_text().splitlines()) == 3  # page 1 and page 2
    assert (rows[0]["keyword"], rows[0]["price_cny_1k"], rows[0]["price_1k_basis_qty"], rows[0]["price_usd_1k"]) == (
        "MT41K", 40.0, 418, 5.0)  # the 836+ step needs more than the 500 in stock
    net.routes["/overseas/search/future"] = {"code": 200, "result": [{"total": 0}]}
    with pytest.raises(SystemExit) as e:
        run("overseas", "MT41K", "--provider", "future", "--control", "MT41K2", "--rate", "8")
    assert e.value.code == 2
