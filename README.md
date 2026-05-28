# 台南房屋成交價查詢

純前端的台南市不動產成交價查詢工具，資料來自[內政部不動產交易實價查詢服務](https://plvr.land.moi.gov.tw/)的開放資料。可直接部署到 GitHub Pages，無需後端。

## 功能

**核心查詢**
- 多條件篩選：成交日期、行政區（37 個）多選、地址/路段關鍵字、總價/坪數/屋齡範圍、建物型態
- 即時統計卡：符合筆數、中位總價、平均單價、中位坪數
- 明細表格：排序、分頁

**📍 地圖視覺化（雙層）**
- Leaflet + OpenStreetMap
- **低 zoom**：37 個區圓圈，大小 = 成交量，顏色 = 平均單價
- **高 zoom (≥ 12)**：自動切換到「路段層」顯示數百個小圓，每個是一條路（如「永華路二段」），件數越多圓越大
- 點擊任一圓圈看詳細統計
- 區層 popup 還會列出該區 Top 10 熱門路段

**📈 趨勢分析**
- 月度雙軸圖：成交量長條 + 中位單價/總價/坪數折線
- 區排行榜：成交量 Top 10、中位單價 Top 10（至少 10 筆才入榜）
- 可單獨檢視某一行政區的趨勢

**🔍 比價引擎**
- 輸入區/型態/坪數/屋齡/房數
- 用加權歐氏距離找相似度最高的 30 筆可比成交
- 自動計算預估價（中位單價 × 目標坪數）

**⬇ 匯出**
- 一鍵匯出篩選後資料為 CSV（含 UTF-8 BOM，Excel 直接開）

**📱 手機 RWD**：小螢幕篩選面板自動堆疊

## 線上 Demo

部署到 GitHub Pages 後即可使用：`https://<你的帳號>.github.io/tainan-house-price/`

## 快速使用

### 直接執行（本機）

```bash
git clone <this-repo>
cd tainan-house-price
python -m http.server 8000
# 開啟 http://localhost:8000
```

### 更新資料

每 10 天 (每月 1、11、21 日) 內政部會發布新資料。執行：

```bash
python scripts/fetch_data.py
```

### 補 geocode 新路段（選用）

如果想讓地圖路段層顯示更多路段（預設 ≥10 筆才 geocode）：

```bash
# 預設：geocode >=10 筆的路段（約 600 條，~12 分鐘）
python scripts/geocode_streets.py

# 涵蓋更多：>=5 筆（約 1300 條，~25 分鐘）
python scripts/geocode_streets.py --min-count 5
```

結果存到 `data/street_coords.json`。已 geocode 的會跳過，不會重複跑。
資料源是 OpenStreetMap Nominatim（免費，限速 1 req/sec）。

這會：
1. 下載最近 4 季的全國實價登錄 ZIP（已有快取會跳過）
2. 抽取台南市買賣案件 (`d_lvr_land_a.csv`)
3. 民國日期 → 西元、平方公尺 → 坪、計算屋齡
4. 過濾異常日期 (民國 100 / 西元 2011 年以前)
5. 輸出 `data/transactions.json`（前端載入）

要指定特定季別：

```bash
python scripts/fetch_data.py --seasons 115S1 114S4 114S3 114S2
```

## 部署到 GitHub Pages

1. 在 GitHub 建立 repo（例如 `tainan-house-price`），把整個資料夾推上去：
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/<你的帳號>/tainan-house-price.git
   git push -u origin main
   ```

2. 進入 repo 的 **Settings → Pages**：
   - Source 選 `Deploy from a branch`
   - Branch 選 `main` / `/ (root)`
   - 按 Save

3. 等 1–2 分鐘，網址會出現在頂部：
   `https://<你的帳號>.github.io/tainan-house-price/`

> ⚠️ `data/transactions.json` 約 7.8 MB，第一次載入需要幾秒（GitHub Pages 會自動 gzip 為 ~1.5 MB）。如果想更快可在發佈前用 `gzip -9 data/transactions.json` 預壓縮並修改 `app.js` 改 fetch 路徑。

## 自動更新（選用）

加入 GitHub Actions 排程，每月自動抓資料並 commit：

`.github/workflows/update-data.yml`
```yaml
name: Update LVR data
on:
  schedule:
    - cron: "0 18 1,11,21 * *"   # 每月 1、11、21 日 02:00 (UTC+8) 跑
  workflow_dispatch:

permissions:
  contents: write

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.x" }
      - run: rm -rf data/raw && python scripts/fetch_data.py
      - run: |
          git config user.name "github-actions"
          git config user.email "actions@github.com"
          git add data/transactions.json
          git diff --cached --quiet || git commit -m "chore: refresh LVR data $(date -Iseconds)"
          git push
```

## 檔案結構

```
tainan-house-price/
├── index.html              # 頁面結構＋樣式（Tabs：總覽/地圖/趨勢/比價）
├── app.js                  # 全部前端邏輯（篩選/圖表/地圖/比價/匯出）
├── data/
│   ├── transactions.json   # 前端載入的精簡資料（自動產生）
│   ├── districts.json      # 37 區質心經緯度（給地圖用）
│   └── raw/                # 下載快取（.gitignore 可忽略）
├── scripts/
│   └── fetch_data.py       # 下載＋轉換腳本
└── README.md
```

## 系統架構（核心模組）

```
┌─ Module 1：資料管線 ─────────────────────┐
│  fetch_data.py → transactions.json       │  ← 月跑一次
└──────────────────┬───────────────────────┘
                   │
┌──────────────────▼───────────────────────┐
│  Module 2：查詢引擎                       │  ← 純前端 client-side
│  條件 → 過濾 → 排序 → 分頁                │
└──────────────────┬───────────────────────┘
                   │
   ┌───────────────┼───────────────┬───────────────┐
   ▼               ▼               ▼               ▼
┌───────┐  ┌───────────┐  ┌──────────┐  ┌──────────┐
│ 統計  │  │ 地圖視覺  │  │ 趨勢分析 │  │ 比價引擎 │
│ 卡/表 │  │  Leaflet  │  │ Chart.js │  │ 相似度   │
└───────┘  └───────────┘  └──────────┘  └──────────┘
                                              │
                                              ▼
                                        ┌──────────┐
                                        │ CSV 匯出 │
                                        └──────────┘
```

## 資料欄位說明

`transactions.json` 中每筆紀錄：

| 欄位 | 說明 |
|------|------|
| `d` | 行政區 |
| `addr` | 土地位置建物門牌 |
| `date` | 交易日期 (YYYY-MM-DD) |
| `type` | 建物型態 |
| `use` | 主要用途 |
| `total` | 總價（元） |
| `ping` | 建物坪數 |
| `upp` | 單價（元/坪） |
| `rooms` / `halls` / `baths` | 房 / 廳 / 衛 |
| `floor_total` | 總樓層數（中文） |
| `build_date` | 建築完成日期 |
| `age` | 屋齡（年，1 位小數） |
| `elev` | 電梯（有/無） |
| `season` | 來源季別代號，如 `115S1` |

## 注意

- 實價登錄資料採「申報主義」，**有 30 天申報期且部分為估算門牌段**，請以正式登記為準。
- 統計值僅供參考，**並非法律或財務建議**。
- 本工具為個人/教育用途，使用前請遵守內政部[資料開放條款](https://data.gov.tw/license)。
