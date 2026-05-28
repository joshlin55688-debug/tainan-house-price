"""
下載內政部實價登錄開放資料，過濾台南市買賣案件，輸出精簡 JSON 供前端使用。

使用方式：
    python scripts/fetch_data.py
    python scripts/fetch_data.py --seasons 115S1 114S4 114S3 114S2

最終輸出： data/transactions.json
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import sys
import urllib.request
import zipfile
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"

DOWNLOAD_URL = (
    "https://plvr.land.moi.gov.tw/DownloadSeason"
    "?season={season}&type=zip&fileName=lvr_landcsv.zip"
)
CURRENT_URL = (
    "https://plvr.land.moi.gov.tw/Download?type=zip&fileName=lvr_landcsv.zip"
)
TAINAN_CSV = "d_lvr_land_a.csv"       # 買賣（新屋＋中古屋）
TAINAN_CSV_PRESALE = "d_lvr_land_b.csv"  # 預售屋

# 新屋判定門檻：屋齡 < 此值 (年) 視為新屋，>= 視為中古屋 (含無屋齡資料的舊建物)
NEW_HOUSE_AGE_THRESHOLD = 5.0

SQM_TO_PING = 0.3025


def default_seasons() -> list[str]:
    """回傳目前可下載的最近 4 個季別（民國年）。"""
    today = date.today()
    roc_year = today.year - 1911
    quarter = (today.month - 1) // 3 + 1
    seasons: list[str] = []
    y, q = roc_year, quarter
    for _ in range(4):
        q -= 1
        if q == 0:
            q = 4
            y -= 1
        seasons.append(f"{y}S{q}")
    return seasons


def download_season(season: str) -> Path:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    target = RAW_DIR / f"{season}.zip"
    if target.exists() and target.stat().st_size > 1024 * 1024:
        print(f"  [快取] {season} 已存在，略過下載")
        return target
    url = DOWNLOAD_URL.format(season=season)
    print(f"  [下載] {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(target, "wb") as f:
        f.write(resp.read())
    return target


def download_current() -> Path:
    """下載「本期」旬報 ZIP（每次抓最新一旬，含 4–5 月補登資料）。"""
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    target = RAW_DIR / "CURRENT.zip"
    print(f"  [下載] {CURRENT_URL}")
    req = urllib.request.Request(CURRENT_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=120) as resp, open(target, "wb") as f:
        f.write(resp.read())
    return target


def read_current_build_time(zip_path: Path) -> str:
    """讀 build_time.xml 取本期說明文字（含日期範圍）"""
    try:
        with zipfile.ZipFile(zip_path) as zf:
            xml = zf.read("build_time.xml").decode("utf-8", errors="ignore")
        import re
        m = re.search(r"<lvr_time>(.+?)</lvr_time>", xml, re.S)
        return m.group(1).strip() if m else ""
    except Exception:
        return ""


def roc_to_iso(roc_date: str) -> str | None:
    """民國日期 YYYMMDD → 西元 YYYY-MM-DD"""
    s = roc_date.strip()
    if not s or not s.isdigit() or len(s) < 6:
        return None
    year = int(s[:-4]) + 1911
    month = int(s[-4:-2])
    day = int(s[-2:])
    try:
        return f"{year:04d}-{month:02d}-{day:02d}"
    except Exception:
        return None


def roc_yyymm_to_iso(roc_ym: str) -> str | None:
    """民國年月 YYYMM → 西元 YYYY-MM-01（建築完成年月用）"""
    s = roc_ym.strip()
    if not s or not s.isdigit() or len(s) < 5:
        return None
    year = int(s[:-4]) + 1911
    month = int(s[-4:-2]) or 1
    try:
        return f"{year:04d}-{month:02d}-01"
    except Exception:
        return None


def to_float(s: str) -> float | None:
    s = (s or "").strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def to_int(s: str) -> int | None:
    f = to_float(s)
    return int(f) if f is not None else None


def calc_age(tx_iso: str | None, build_iso: str | None) -> float | None:
    if not tx_iso or not build_iso:
        return None
    try:
        a = date.fromisoformat(tx_iso)
        b = date.fromisoformat(build_iso)
        return round((a - b).days / 365.25, 1)
    except Exception:
        return None


def classify(age: float | None, is_presale: bool) -> str:
    """類型分類：預售屋 / 新屋 (屋齡 < 5) / 中古屋 (含無屋齡資料的舊建物)"""
    if is_presale:
        return "預售屋"
    if age is not None and age < NEW_HOUSE_AGE_THRESHOLD:
        return "新屋"
    return "中古屋"


def parse_csv(zip_path: Path, season: str, *, presale: bool = False) -> list[dict]:
    """解析買賣 (a) 或預售屋 (b) CSV。"""
    out: list[dict] = []
    inner_name = TAINAN_CSV_PRESALE if presale else TAINAN_CSV
    with zipfile.ZipFile(zip_path) as zf:
        try:
            data = zf.read(inner_name)
        except KeyError:
            print(f"  [警告] {season} 找不到 {inner_name}")
            return out
    text = data.decode("utf-8-sig", errors="ignore")
    reader = csv.DictReader(io.StringIO(text))
    # 第二列是英文欄名，跳過
    rows = list(reader)
    if rows and rows[0].get("鄉鎮市區", "").startswith("The"):
        rows = rows[1:]
    for r in rows:
        district = (r.get("鄉鎮市區") or "").strip()
        addr = (r.get("土地位置建物門牌") or "").strip()
        if not district or not addr:
            continue
        tx_iso = roc_to_iso(r.get("交易年月日") or "")
        if not tx_iso:
            continue
        if tx_iso < "2011-01-01":
            continue
        total_price = to_int(r.get("總價元") or "")
        build_sqm = to_float(r.get("建物移轉總面積平方公尺") or "")
        unit_price_per_sqm = to_float(r.get("單價元平方公尺") or "")
        build_iso = roc_yyymm_to_iso(r.get("建築完成年月") or "")
        ping = round(build_sqm * SQM_TO_PING, 2) if build_sqm else None
        unit_price_per_ping = (
            round(unit_price_per_sqm / SQM_TO_PING) if unit_price_per_sqm else None
        )
        age = calc_age(tx_iso, build_iso)
        rec = {
            "d": district,
            "addr": addr,
            "date": tx_iso,
            "cat": classify(age, presale),                       # 新增：類型
            "type": (r.get("建物型態") or "").strip(),
            "use": (r.get("主要用途") or "").strip(),
            "total": total_price,
            "ping": ping,
            "upp": unit_price_per_ping,
            "rooms": to_int(r.get("建物現況格局-房") or ""),
            "halls": to_int(r.get("建物現況格局-廳") or ""),
            "baths": to_int(r.get("建物現況格局-衛") or ""),
            "floor_total": (r.get("總樓層數") or "").strip(),
            "build_date": build_iso,
            "age": age,
            "elev": (r.get("電梯") or "").strip(),
            "season": season,
        }
        if presale:
            # 預售屋特有欄位
            rec["build_name"] = (r.get("建案名稱") or "").strip()
            rec["unit_code"] = (r.get("棟及號") or "").strip()
            rec["terminated"] = (r.get("解約情形") or "").strip()
        out.append(rec)
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", nargs="*", help="指定季別，例如 115S1 114S4")
    args = ap.parse_args()
    seasons = args.seasons or default_seasons()
    print(f"處理季別：{seasons}")

    all_rows: list[dict] = []
    for s in seasons:
        print(f"\n== {s} ==")
        try:
            zip_path = download_season(s)
        except Exception as e:
            print(f"  [錯誤] 下載 {s} 失敗：{e}")
            continue
        rows_a = parse_csv(zip_path, s)
        rows_b = parse_csv(zip_path, s, presale=True)
        print(f"  [解析] 買賣 {len(rows_a)} 筆 + 預售屋 {len(rows_b)} 筆")
        all_rows.extend(rows_a)
        all_rows.extend(rows_b)

    # 「本期」旬報 — 補上 4–5 月新登錄案件
    current_note = ""
    print(f"\n== 本期旬報 ==")
    try:
        cur_zip = download_current()
        current_note = read_current_build_time(cur_zip)
        if current_note:
            print(f"  [說明] {current_note}")
        cur_a = parse_csv(cur_zip, "CURR")
        cur_b = parse_csv(cur_zip, "CURR", presale=True)
        print(f"  [解析] 買賣 {len(cur_a)} 筆 + 預售屋 {len(cur_b)} 筆")
        all_rows.extend(cur_a)
        all_rows.extend(cur_b)
    except Exception as e:
        print(f"  [錯誤] 下載本期失敗：{e}")

    # 去重：複合鍵 (cat + date + addr + total + ping) — 預售/買賣 同址也可能並存
    before = len(all_rows)
    seen: dict[tuple, dict] = {}
    for r in all_rows:
        key = (r["cat"], r["date"], r["addr"], r.get("total"), r.get("ping"))
        # 偏好「季別」(非 CURR) 的版本，因季別資料較完整
        existing = seen.get(key)
        if existing is None or (existing["season"] == "CURR" and r["season"] != "CURR"):
            seen[key] = r
    all_rows = list(seen.values())
    print(f"\n[去重] {before} → {len(all_rows)} 筆 (移除 {before - len(all_rows)} 筆重複)")

    # 依日期排序（最新在前）
    all_rows.sort(key=lambda r: r["date"], reverse=True)

    # 統計
    by_district: dict[str, int] = {}
    by_cat: dict[str, int] = {}
    for r in all_rows:
        by_district[r["d"]] = by_district.get(r["d"], 0) + 1
        by_cat[r["cat"]] = by_cat.get(r["cat"], 0) + 1

    out_path = DATA_DIR / "transactions.json"
    latest_date = max((r["date"] for r in all_rows), default="")
    payload = {
        "generated_at": date.today().isoformat(),
        "seasons": seasons,
        "current_note": current_note,
        "latest_date": latest_date,
        "count": len(all_rows),
        "districts": sorted(by_district.keys()),
        "district_counts": by_district,
        "categories": sorted(by_cat.keys()),
        "category_counts": by_cat,
        "rows": all_rows,
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    size_mb = out_path.stat().st_size / 1024 / 1024
    print(
        f"\n[完成] {out_path}  共 {len(all_rows)} 筆 / "
        f"{len(by_district)} 區 / 檔案大小 {size_mb:.2f} MB"
    )
    print("各區成交量（前 10）：")
    top = sorted(by_district.items(), key=lambda x: -x[1])[:10]
    for d, c in top:
        print(f"  {d:>6}  {c:>5}")
    print("各類型成交量：")
    for cat, n in sorted(by_cat.items(), key=lambda x: -x[1]):
        print(f"  {cat:>6}  {n:>5}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
