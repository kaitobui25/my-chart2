"""Official JPX issue classifications, independent of market-price requests."""
from __future__ import annotations

import io
import json
import re
import threading
import time
import zipfile
from datetime import datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

SOURCE_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/01.html"
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
FIELDS = ("コード", "銘柄名", "33業種コード", "33業種区分", "17業種コード", "17業種区分", "日付")


def parse_jpx_workbook(content: bytes) -> dict:
    with zipfile.ZipFile(io.BytesIO(content)) as book:
        strings = []
        if "xl/sharedStrings.xml" in book.namelist():
            root = ET.fromstring(book.read("xl/sharedStrings.xml"))
            strings = ["".join(node.itertext()) for node in root.findall("s:si", NS)]
        sheet = ET.fromstring(book.read("xl/worksheets/sheet1.xml"))
        rows = []
        for row in sheet.findall(".//s:sheetData/s:row", NS):
            values = {}
            for cell in row.findall("s:c", NS):
                column = re.sub(r"\d", "", cell.attrib["r"])
                value = cell.findtext("s:v", "", NS)
                if cell.attrib.get("t") == "s":
                    value = strings[int(value)]
                elif cell.attrib.get("t") == "inlineStr":
                    value = "".join(cell.find("s:is", NS).itertext())
                values[column] = value.strip()
            rows.append(values)
    if not rows:
        raise ValueError("JPX workbook is empty")
    columns = {value: column for column, value in rows[0].items()}
    if not all(field in columns for field in FIELDS):
        raise ValueError("JPX workbook classification columns changed")
    records = {}
    dates = set()
    for row in rows[1:]:
        values = {field: row.get(columns[field], "") for field in FIELDS}
        code = values["コード"].removesuffix(".0").upper()
        if not re.fullmatch(r"[0-9A-Z]{4}", code):
            continue
        date = values["日付"].removesuffix(".0")
        if re.fullmatch(r"\d{8}", date):
            dates.add(date)
        code33, code17 = values["33業種コード"], values["17業種コード"]
        if not code33.isdigit() or not code17.isdigit():
            continue  # ETFs and other issues may have no industry classification.
        records[f"{code}.T"] = {
            "name": values["銘柄名"], "sector33Code": code33.zfill(4),
            "sector33Name": values["33業種区分"], "sector17Code": code17.zfill(2),
            "sector17Name": values["17業種区分"],
        }
    if not records or len(dates) != 1:
        raise ValueError("JPX workbook has no valid dated classifications")
    date = dates.pop()
    return {"asOf": f"{date[:4]}-{date[4:6]}-{date[6:]}", "sourceUrl": SOURCE_URL, "records": records}


class WorkbookLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.urls = []

    def handle_starttag(self, tag, attrs):
        href = dict(attrs).get("href", "")
        if tag == "a" and re.search(r"/data_j\.xlsx(?:\?.*)?$", href):
            self.urls.append(urljoin(SOURCE_URL, href))


def download_catalog() -> dict:
    def read(url):
        with urlopen(Request(url, headers={"User-Agent": "L2Chart JPX classifications"}), timeout=20) as response:
            if urlparse(response.url).hostname != "www.jpx.co.jp":
                raise ValueError("Unexpected JPX redirect")
            content = response.read(8 * 1024 * 1024 + 1)
            if len(content) > 8 * 1024 * 1024:
                raise ValueError("JPX response is too large")
            return content
    links = WorkbookLinks()
    links.feed(read(SOURCE_URL).decode("utf-8"))
    url = next((url for url in links.urls if urlparse(url).hostname == "www.jpx.co.jp"), None)
    if not url:
        raise ValueError("JPX classification workbook link was not found")
    result = parse_jpx_workbook(read(url))
    result["workbookUrl"] = url
    return result


class JpxSectorRepository:
    def __init__(self, path=None, download=download_catalog):
        self.path = path or Path.home() / ".cache" / "l2chart" / "jpx-sectors.json"
        self.download = download
        self.lock = threading.Lock()
        self.snapshot = None
        self.retry_after = 0

    def get(self):
        with self.lock:
            if self.snapshot is None:
                try:
                    saved = json.loads(self.path.read_text(encoding="utf-8"))
                    if isinstance(saved.get("records"), dict) and saved.get("asOf") and saved["records"]:
                        self.snapshot = saved
                except (OSError, ValueError):
                    pass
            expected = (datetime.now(ZoneInfo("Asia/Tokyo")).replace(day=1) - timedelta(days=1)).strftime("%Y-%m")
            if self.snapshot and self.snapshot["asOf"][:7] >= expected:
                return self.snapshot
            if time.time() >= self.retry_after:
                self.retry_after = time.time() + 86400
                try:
                    updated = self.download()
                    self.path.parent.mkdir(parents=True, exist_ok=True)
                    temporary = self.path.with_suffix(".tmp")
                    temporary.write_text(json.dumps(updated, ensure_ascii=False), encoding="utf-8")
                    temporary.replace(self.path)
                    self.snapshot = updated
                except Exception:
                    self.retry_after = time.time() + 60
                    if self.snapshot is None:
                        raise
            if self.snapshot is None:
                raise RuntimeError("JPX classifications are temporarily unavailable")
            return self.snapshot
