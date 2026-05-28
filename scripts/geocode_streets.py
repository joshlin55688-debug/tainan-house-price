"""
將台南各區的熱門路段批次 geocode 成經緯度，輸出到 data/street_coords.json。

使用 OpenStreetMap Nominatim 免費 API，遵守其使用條款：
- 限速 1 req/sec（本腳本用 1.1 秒安全邊際）
- 必須設定 User-Agent
- 避免短時間大量請求

使用方式：
    python scripts/geocode_streets.py                # 預設 >=10 筆
    python scripts/geocode_streets.py --min-count 5  # >=5 筆
    python scripts/geocode_streets.py --max 200      # 只跑前 200 條
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

# Windows cp950 console 無法輸出某些罕用字（私有區字元等），全部用 replace 避免崩潰
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def safe_print(*args):
    try:
        safe_print(*args, flush=True)
    except Exception:
        msg = " ".join(str(a) for a in args)
        sys.stdout.buffer.write(msg.encode("utf-8", errors="replace") + b"\n")
        sys.stdout.flush()

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
INPUT_FILE = DATA_DIR / "transactions.json"
OUTPUT_FILE = DATA_DIR / "street_coords.json"

NOMINATIM_URL = "https://nominatim.openstreetmap.org/search"
USER_AGENT = "tainan-house-price/1.0 (https://github.com/; educational)"
SLEEP_SEC = 1.1


def extract_street(addr: str) -> str:
    """同 app.js 的 extractStreet：去掉 區 前綴，取數字/巷弄號之樓 前的部分。"""
    if not addr:
        return ""
    stripped = re.sub(r"^臺?南?市?[^0-9０-９]{0,4}區", "", addr)
    m = re.match(r"^[^0-9０-９巷弄號之樓]+", stripped)
    return m.group(0).strip() if m else ""


def query_nominatim(q: str) -> tuple[float, float] | None:
    url = NOMINATIM_URL + "?" + urllib.parse.urlencode({
        "q": q,
        "format": "json",
        "limit": 1,
        "countrycodes": "tw",
    })
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            arr = json.loads(resp.read())
        if arr:
            return (float(arr[0]["lat"]), float(arr[0]["lon"]))
    except Exception as e:
        safe_print(f"    [錯誤] {e}", file=sys.stderr)
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--min-count", type=int, default=10,
                    help="只 geocode 成交筆數 >= 此值的路段（預設 10）")
    ap.add_argument("--max", type=int, default=None, help="最多處理筆數")
    args = ap.parse_args()

    if not INPUT_FILE.exists():
        safe_print(f"找不到 {INPUT_FILE}，請先跑 fetch_data.py", file=sys.stderr)
        return 1

    with open(INPUT_FILE, encoding="utf-8") as f:
        data = json.load(f)

    # 統計每個 (district, street) 組合
    counts: Counter[tuple[str, str]] = Counter()
    for r in data["rows"]:
        s = extract_street(r["addr"])
        if s:
            counts[(r["d"], s)] += 1

    targets = [
        (d, s, c) for (d, s), c in counts.items() if c >= args.min_count
    ]
    targets.sort(key=lambda x: -x[2])
    if args.max:
        targets = targets[: args.max]

    safe_print(f"總路段 {len(counts)} 條；篩選 >={args.min_count} 筆共 {len(targets)} 條")
    safe_print(f"預估耗時 {len(targets) * SLEEP_SEC / 60:.1f} 分鐘")

    # 載入既有快取
    cache: dict[str, list[float] | None] = {}
    if OUTPUT_FILE.exists():
        with open(OUTPUT_FILE, encoding="utf-8") as f:
            cache = json.load(f)
        safe_print(f"快取已有 {len(cache)} 條 entries")

    hit = miss = skip = 0
    for i, (d, s, c) in enumerate(targets, 1):
        key = f"{d}|{s}"
        if key in cache:
            skip += 1
            continue

        # 嘗試多種查詢字串
        queries = [
            f"{s}, 臺南市{d}, 台灣",
            f"{s}, 臺南市{d}",
            f"{s} {d} 臺南市",
        ]
        coord = None
        for q in queries:
            coord = query_nominatim(q)
            time.sleep(SLEEP_SEC)
            if coord:
                # 檢查座標是否在台南合理範圍 (大致 22.8-23.4, 119.9-120.7)
                if 22.8 <= coord[0] <= 23.5 and 119.9 <= coord[1] <= 120.7:
                    break
                else:
                    coord = None  # 範圍外的視為無效

        cache[key] = coord
        if coord:
            hit += 1
            safe_print(f"  [{i}/{len(targets)}] {d} {s} ({c}筆) → ({coord[0]:.4f}, {coord[1]:.4f})")
        else:
            miss += 1
            safe_print(f"  [{i}/{len(targets)}] {d} {s} ({c}筆) → not found")

        # 每 20 條存檔一次（避免中斷遺失進度）
        if i % 20 == 0:
            with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
                json.dump(cache, f, ensure_ascii=False)

    # 最終存檔
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f, ensure_ascii=False)
    safe_print(f"\n[完成] 新 geocode {hit} 條，失敗 {miss} 條，已快取 {skip} 條。")
    safe_print(f"  輸出：{OUTPUT_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
