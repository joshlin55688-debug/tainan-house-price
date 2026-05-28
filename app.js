// 台南房屋成交價查詢 - 前端邏輯
"use strict";

const PAGE_SIZE = 50;
const DATA_URL = "data/transactions.json";
const DISTRICT_URL = "data/districts.json";

const state = {
  all: [],
  filtered: [],
  districts: [],
  categories: ["新屋", "中古屋", "預售屋"],
  categoryCounts: {},
  selectedCats: new Set(["新屋", "中古屋", "預售屋"]),
  centroids: {},                // 區 → [lat, lng]
  streetCoords: {},             // "區|路段" → [lat, lng]
  page: 1,
  sortKey: "date",
  sortDir: "desc",
  chart: null,
  trendChart: null,
  map: null,
  mapDistLayer: null,           // 區層 (低 zoom 顯示)
  mapStreetLayer: null,         // 路段層 (高 zoom 顯示)
  cmpResults: [],
};

const STREET_ZOOM_THRESHOLD = 12;   // zoom >= 此值切換到路段層

// ---------- 工具函式 ----------
const $ = (id) => document.getElementById(id);

function fmtMoney(yuan) {
  if (yuan == null) return "—";
  return (yuan / 10000).toLocaleString("zh-TW", { maximumFractionDigits: 0 });
}
function fmtMoneyPerPing(yuanPerPing) {
  if (yuanPerPing == null) return "—";
  return (yuanPerPing / 10000).toLocaleString("zh-TW", { maximumFractionDigits: 1 });
}
function fmtNumber(n, digits = 1) {
  if (n == null) return "—";
  return n.toLocaleString("zh-TW", { maximumFractionDigits: digits });
}
function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function ymKey(dateStr) { return dateStr.slice(0, 7); }   // YYYY-MM

// ---------- 載入資料 ----------
async function loadData() {
  const loadingText = $("loading-text");
  try {
    loadingText.textContent = "載入資料中⋯";
    const [resp, centResp, streetResp] = await Promise.all([
      fetch(DATA_URL),
      fetch(DISTRICT_URL),
      fetch("data/street_coords.json").catch(() => null),
    ]);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const payload = await resp.json();
    state.all = payload.rows;
    state.districts = payload.districts;
    if (payload.categories && payload.categories.length) {
      // 排序：新屋 → 中古屋 → 預售屋
      const order = { 新屋: 1, 中古屋: 2, 預售屋: 3 };
      state.categories = [...payload.categories].sort(
        (a, b) => (order[a] || 99) - (order[b] || 99)
      );
    }
    state.categoryCounts = payload.category_counts || {};
    state.selectedCats = new Set(state.categories);
    state.centroids = centResp.ok ? await centResp.json() : {};
    state.streetCoords =
      streetResp && streetResp.ok ? await streetResp.json() : {};
    const latest = payload.latest_date || "—";
    $("header-sub").innerHTML =
      `資料來源：內政部實價登錄 · 季別 ${payload.seasons.join("、")} ＋ 最新旬報 · ` +
      `共 ${payload.count.toLocaleString()} 筆 · 最新成交日 <strong>${latest}</strong> · 產生於 ${payload.generated_at}`;
    initFilters(payload);
    initTabs();
    initCompareTab();
    initTrendTab();
    initExportButton();
    applyFilters();
    $("loading").style.display = "none";
  } catch (err) {
    loadingText.innerHTML =
      `<div style="color:#dc2626;">載入失敗：${err.message}</div>` +
      `<div style="margin-top:8px;font-size:12px;">請確認 <code>data/transactions.json</code> 是否存在。<br>` +
      `若是本地檔案需用 <code>python -m http.server</code> 等本地伺服器啟動。</div>`;
  }
}

// ---------- 初始化篩選器 ----------
function initFilters(payload) {
  // 物件類型 pills
  const catBox = $("cat-pills");
  catBox.innerHTML = state.categories
    .map(
      (c) =>
        `<span class="cat-pill active" data-cat="${c}">${c}` +
        `<span class="cnt">(${(state.categoryCounts[c] || 0).toLocaleString()})</span></span>`
    )
    .join("");
  catBox.querySelectorAll(".cat-pill").forEach((el) => {
    el.addEventListener("click", () => {
      const c = el.dataset.cat;
      if (state.selectedCats.has(c)) {
        // 至少保留一個
        if (state.selectedCats.size > 1) {
          state.selectedCats.delete(c);
          el.classList.remove("active");
        }
      } else {
        state.selectedCats.add(c);
        el.classList.add("active");
      }
      applyFilters();
    });
  });

  // 行政區
  const grid = $("district-grid");
  grid.innerHTML = state.districts
    .map(
      (d) =>
        `<label><input type="checkbox" value="${d}" checked />${d}` +
        `<span style="color:#9ca3af;font-size:10px;">(${payload.district_counts[d]})</span></label>`
    )
    .join("");

  // 日期預設：最新日期往回推 1 年
  const dates = state.all.map((r) => r.date);
  const minDate = dates.reduce((a, b) => (a < b ? a : b));
  const maxDate = dates.reduce((a, b) => (a > b ? a : b));
  const defaultFrom = oneYearBack(maxDate);
  $("date-from").value = defaultFrom > minDate ? defaultFrom : minDate;
  $("date-to").value = maxDate;
  $("date-from").min = minDate;
  $("date-from").max = maxDate;
  $("date-to").min = minDate;
  $("date-to").max = maxDate;

  // 建物型態
  const types = new Set();
  state.all.forEach((r) => r.type && types.add(r.type));
  [...types].sort().forEach((t) => {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    $("building-type").appendChild(opt);
    // 同時加到比價的 type 下拉
    const opt2 = opt.cloneNode(true);
    $("cmp-type").appendChild(opt2);
  });

  // 比價的行政區下拉
  const cmpDist = $("cmp-district");
  cmpDist.innerHTML = state.districts
    .map((d) => `<option value="${d}">${d}</option>`)
    .join("");

  // 事件
  $("btn-search").addEventListener("click", applyFilters);
  $("btn-reset").addEventListener("click", resetFilters);
  $("dist-all").addEventListener("click", () => toggleDistricts(true));
  $("dist-none").addEventListener("click", () => toggleDistricts(false));
  $("addr-kw").addEventListener("keydown", (e) => {
    if (e.key === "Enter") applyFilters();
  });
  $("prev-page").addEventListener("click", () => {
    if (state.page > 1) {
      state.page--;
      renderTable();
    }
  });
  $("next-page").addEventListener("click", () => {
    const maxPage = Math.max(1, Math.ceil(state.filtered.length / PAGE_SIZE));
    if (state.page < maxPage) {
      state.page++;
      renderTable();
    }
  });
  document.querySelectorAll("thead th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (state.sortKey === key) {
        state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
      } else {
        state.sortKey = key;
        state.sortDir = key === "date" ? "desc" : "asc";
      }
      sortFiltered();
      renderTable();
      updateSortIndicator();
    });
  });
}

function oneYearBack(dateStr) {
  const d = new Date(dateStr);
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function toggleDistricts(checked) {
  document
    .querySelectorAll("#district-grid input[type=checkbox]")
    .forEach((cb) => (cb.checked = checked));
}
function getSelectedDistricts() {
  return [
    ...document.querySelectorAll("#district-grid input[type=checkbox]:checked"),
  ].map((cb) => cb.value);
}

function resetFilters() {
  // 類型全選
  state.selectedCats = new Set(state.categories);
  document.querySelectorAll("#cat-pills .cat-pill").forEach((el) => {
    el.classList.add("active");
  });
  toggleDistricts(true);
  $("addr-kw").value = "";
  $("price-min").value = "";
  $("price-max").value = "";
  $("ping-min").value = "";
  $("ping-max").value = "";
  $("age-min").value = "";
  $("age-max").value = "";
  $("building-type").value = "";
  const maxDate = $("date-to").max;
  const minDate = $("date-from").min;
  const defaultFrom = oneYearBack(maxDate);
  $("date-from").value = defaultFrom > minDate ? defaultFrom : minDate;
  $("date-to").value = maxDate;
  applyFilters();
}

// ---------- 篩選 ----------
function applyFilters() {
  const districts = new Set(getSelectedDistricts());
  const dateFrom = $("date-from").value;
  const dateTo = $("date-to").value;
  const kw = $("addr-kw").value.trim();
  const priceMin = parseFloat($("price-min").value);
  const priceMax = parseFloat($("price-max").value);
  const pingMin = parseFloat($("ping-min").value);
  const pingMax = parseFloat($("ping-max").value);
  const ageMin = parseFloat($("age-min").value);
  const ageMax = parseFloat($("age-max").value);
  const btype = $("building-type").value;

  state.filtered = state.all.filter((r) => {
    if (!state.selectedCats.has(r.cat)) return false;
    if (!districts.has(r.d)) return false;
    if (dateFrom && r.date < dateFrom) return false;
    if (dateTo && r.date > dateTo) return false;
    if (kw && !(r.addr && r.addr.includes(kw))) return false;
    if (btype && r.type !== btype) return false;
    if (!isNaN(priceMin) && (r.total == null || r.total / 10000 < priceMin)) return false;
    if (!isNaN(priceMax) && (r.total == null || r.total / 10000 > priceMax)) return false;
    if (!isNaN(pingMin) && (r.ping == null || r.ping < pingMin)) return false;
    if (!isNaN(pingMax) && (r.ping == null || r.ping > pingMax)) return false;
    if (!isNaN(ageMin) && (r.age == null || r.age < ageMin)) return false;
    if (!isNaN(ageMax) && (r.age == null || r.age > ageMax)) return false;
    return true;
  });

  state.page = 1;
  sortFiltered();
  updateStats();
  updateDistChart();
  renderTable();
  updateSortIndicator();
  // 連動其他 tab（若已渲染過）
  if ($("tab-map").classList.contains("active")) renderMap();
  if ($("tab-trend").classList.contains("active")) renderTrend();
}

function sortFiltered() {
  const k = state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  state.filtered.sort((a, b) => {
    const av = a[k], bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av < bv) return -1 * dir;
    if (av > bv) return 1 * dir;
    return 0;
  });
}

function updateSortIndicator() {
  document.querySelectorAll("thead th.sortable").forEach((th) => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.key === state.sortKey) {
      th.classList.add(state.sortDir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });
}

// ---------- 統計卡 ----------
function updateStats() {
  const rows = state.filtered;
  $("stat-count").textContent = rows.length.toLocaleString();
  $("stat-count-sub").textContent =
    rows.length ? `佔總資料 ${((rows.length / state.all.length) * 100).toFixed(1)}%` : "";
  $("result-badge").textContent = rows.length.toLocaleString();

  const totals = rows.map((r) => r.total).filter((v) => v != null);
  const upps = rows.map((r) => r.upp).filter((v) => v != null);
  const pings = rows.map((r) => r.ping).filter((v) => v != null);

  $("stat-median-price").textContent = totals.length ? fmtMoney(median(totals)) : "—";
  $("stat-avg-upp").textContent = upps.length ? fmtMoneyPerPing(mean(upps)) : "—";
  $("stat-median-ping").textContent = pings.length ? fmtNumber(median(pings), 1) : "—";
}

// ---------- 區成交量長條圖（總覽 tab） ----------
function updateDistChart() {
  const counts = {};
  state.filtered.forEach((r) => {
    counts[r.d] = (counts[r.d] || 0) + 1;
  });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const labels = sorted.map((x) => x[0]);
  const data = sorted.map((x) => x[1]);

  const upMap = {};
  state.districts.forEach((d) => {
    const upps = state.filtered
      .filter((r) => r.d === d && r.upp != null)
      .map((r) => r.upp);
    upMap[d] = upps.length ? median(upps) : null;
  });

  const ctx = $("dist-chart");
  if (state.chart) state.chart.destroy();
  state.chart = new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "成交筆數",
        data,
        backgroundColor: "#2563eb",
        borderRadius: 3,
      }],
    },
    options: {
      indexAxis: "y",
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            afterLabel: (ctx) => {
              const m = upMap[ctx.label];
              return m ? `中位單價：${fmtMoneyPerPing(m)} 萬/坪` : "";
            },
          },
        },
      },
      scales: {
        x: { ticks: { precision: 0 }, grid: { color: "#f3f4f6" } },
        y: { ticks: { font: { size: 11 } }, grid: { display: false } },
      },
    },
  });

  const wrap = $("chart-wrap");
  wrap.style.height = Math.max(220, labels.length * 22 + 40) + "px";
}

// ---------- 結果表格 ----------
function renderTable() {
  const tbody = $("result-body");
  const total = state.filtered.length;
  const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (state.page > maxPage) state.page = maxPage;
  const start = (state.page - 1) * PAGE_SIZE;
  const slice = state.filtered.slice(start, start + PAGE_SIZE);

  if (!slice.length) {
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center;padding:30px;color:#9ca3af;">無符合條件的資料</td></tr>`;
  } else {
    tbody.innerHTML = slice.map(rowToHtml).join("");
  }

  $("page-info").textContent = total
    ? `第 ${start + 1}-${Math.min(start + PAGE_SIZE, total)} 筆 / 共 ${total.toLocaleString()} 筆（第 ${state.page}/${maxPage} 頁）`
    : "—";
  $("prev-page").disabled = state.page <= 1;
  $("next-page").disabled = state.page >= maxPage;
}

function rowToHtml(r) {
  const pattern =
    r.rooms || r.halls || r.baths
      ? `${r.rooms || 0}房${r.halls || 0}廳${r.baths || 0}衛`
      : "—";
  const elev = r.elev === "有" ? " 🛗" : "";
  const cat = r.cat || "";
  const catCell = cat ? `<span class="cat-badge ${cat}">${cat}</span>` : "—";
  // 預售屋顯示建案名稱在地址下方
  let addrCell = escapeHtml(r.addr);
  if (r.cat === "預售屋" && r.build_name) {
    addrCell += `<div style="font-size:11px;color:#5b21b6;">🏗 ${escapeHtml(r.build_name)}</div>`;
  }
  return `<tr>
    <td>${r.date}</td>
    <td>${catCell}</td>
    <td><span class="badge">${r.d}</span></td>
    <td class="addr">${addrCell}</td>
    <td>${escapeHtml(r.type || "—")}${elev}</td>
    <td class="num">${fmtMoney(r.total)}</td>
    <td class="num">${fmtNumber(r.ping, 1)}</td>
    <td class="num">${fmtMoneyPerPing(r.upp)}</td>
    <td>${pattern}</td>
    <td class="num">${r.age != null ? r.age.toFixed(1) : "—"}</td>
    <td>${escapeHtml(r.floor_total || "—")}</td>
  </tr>`;
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

// ===================================================================
// Tab 切換
// ===================================================================
function initTabs() {
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-panel").forEach((p) => {
        p.classList.toggle("active", p.id === `tab-${target}`);
      });
      // 延遲渲染地圖/趨勢，第一次切到才畫
      if (target === "map") renderMap();
      if (target === "trend") renderTrend();
    });
  });
}

// ===================================================================
// 地圖模組（Leaflet）
// ===================================================================
// 從地址抽出路段名稱：去掉「臺南市XX區」前綴，取（半形/全形）數字、巷弄號之樓前的部分
function extractStreet(addr) {
  if (!addr) return "";
  // 半形與全形數字都當作切點
  const stripped = addr.replace(/^臺?南?市?[^0-9０-９]{0,4}區/, "");
  const m = stripped.match(/^[^0-9０-９巷弄號之樓]+/);
  return m ? m[0].trim() : stripped.slice(0, 6);
}

function renderMap() {
  if (!state.map) {
    state.map = L.map("map").setView([23.05, 120.25], 10);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "© OpenStreetMap",
    }).addTo(state.map);

    // 圖例
    const legend = L.control({ position: "bottomright" });
    legend.onAdd = function () {
      const div = L.DomUtil.create("div", "map-legend");
      div.innerHTML = `
        <strong>單價（萬/坪）</strong><br>
        <span class="swatch" style="background:#fef3c7;"></span> &lt; 10<br>
        <span class="swatch" style="background:#fbbf24;"></span> 10–20<br>
        <span class="swatch" style="background:#f97316;"></span> 20–35<br>
        <span class="swatch" style="background:#dc2626;"></span> &gt; 35<br>
        <strong style="margin-top:6px;display:block;">操作</strong>
        放大可看路段圓圈<br>
        點擊看詳細統計
      `;
      return div;
    };
    legend.addTo(state.map);

    // 依 zoom level 切換層級
    state.map.on("zoomend", switchMapLayer);
  }

  // 清除舊 layer
  if (state.mapDistLayer) state.map.removeLayer(state.mapDistLayer);
  if (state.mapStreetLayer) state.map.removeLayer(state.mapStreetLayer);

  // 聚合：依區、依路段
  const byDist = {};
  const byStreet = {};
  state.filtered.forEach((r) => {
    if (!byDist[r.d]) byDist[r.d] = { count: 0, upps: [], totals: [], streetMap: {} };
    const b = byDist[r.d];
    b.count++;
    if (r.upp != null) b.upps.push(r.upp);
    if (r.total != null) b.totals.push(r.total);
    const street = extractStreet(r.addr);
    if (street) {
      if (!b.streetMap[street]) b.streetMap[street] = { count: 0, upps: [], totals: [] };
      b.streetMap[street].count++;
      if (r.upp != null) b.streetMap[street].upps.push(r.upp);
      if (r.total != null) b.streetMap[street].totals.push(r.total);
      const key = `${r.d}|${street}`;
      if (!byStreet[key]) byStreet[key] = { d: r.d, street, count: 0, upps: [], totals: [] };
      byStreet[key].count++;
      if (r.upp != null) byStreet[key].upps.push(r.upp);
      if (r.total != null) byStreet[key].totals.push(r.total);
    }
  });

  // ===== 區層 (低 zoom) =====
  const maxDistCount = Math.max(1, ...Object.values(byDist).map((x) => x.count));
  const distLayers = [];
  Object.entries(byDist).forEach(([d, stats]) => {
    const c = state.centroids[d];
    if (!c) return;
    const medUpp = stats.upps.length ? median(stats.upps) : null;
    const medTotal = stats.totals.length ? median(stats.totals) : null;
    const medUppWan = medUpp ? medUpp / 10000 : null;
    const radius = 8 + Math.sqrt(stats.count / maxDistCount) * 32;
    const color = uppColor(medUppWan);

    const marker = L.circleMarker(c, {
      radius, color, fillColor: color, fillOpacity: 0.55, weight: 2,
    });

    const topStreets = Object.entries(stats.streetMap)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10);
    const streetRows = topStreets
      .map(([s, info], i) => {
        const medU = info.upps.length ? median(info.upps) : null;
        return `<tr>
          <td style="color:#6b7280;">${i + 1}</td>
          <td>${escapeHtml(s)}</td>
          <td style="text-align:right;">${info.count}</td>
          <td style="text-align:right;color:#6b7280;">${medU != null ? fmtMoneyPerPing(medU) : "—"}</td>
        </tr>`;
      })
      .join("");

    marker.bindPopup(`
      <div class="map-popup-title">${d}</div>
      <div class="map-popup-row"><span class="lbl">成交量</span>${stats.count.toLocaleString()} 筆</div>
      <div class="map-popup-row"><span class="lbl">中位總價</span>${medTotal != null ? fmtMoney(medTotal) + " 萬" : "—"}</div>
      <div class="map-popup-row"><span class="lbl">中位單價</span>${medUppWan != null ? medUppWan.toFixed(1) + " 萬/坪" : "—"}</div>
      ${
        topStreets.length
          ? `<div style="margin-top:8px;border-top:1px solid #e5e7eb;padding-top:6px;">
              <div style="font-size:11px;color:#6b7280;margin-bottom:4px;">熱門路段 Top ${topStreets.length}</div>
              <table style="font-size:11px;width:100%;border-collapse:collapse;">
                <thead><tr style="color:#9ca3af;">
                  <th style="text-align:left;font-weight:500;width:18px;">#</th>
                  <th style="text-align:left;font-weight:500;">路段</th>
                  <th style="text-align:right;font-weight:500;">筆數</th>
                  <th style="text-align:right;font-weight:500;">萬/坪</th>
                </tr></thead>
                <tbody>${streetRows}</tbody>
              </table>
            </div>`
          : ""
      }
    `, { maxWidth: 320 });

    marker.on("click", () => {
      state.map.setView(c, Math.max(state.map.getZoom(), STREET_ZOOM_THRESHOLD));
    });

    distLayers.push(marker);
  });
  state.mapDistLayer = L.layerGroup(distLayers);

  // ===== 路段層 (高 zoom) =====
  const streetCoords = state.streetCoords || {};
  const streetEntries = Object.values(byStreet).filter((s) => {
    const key = `${s.d}|${s.street}`;
    return streetCoords[key]; // 有 geocoded 才顯示
  });
  const maxStreetCount = Math.max(1, ...streetEntries.map((s) => s.count));
  const streetLayers = [];
  streetEntries.forEach((s) => {
    const key = `${s.d}|${s.street}`;
    const c = streetCoords[key];
    if (!c) return;
    const medUpp = s.upps.length ? median(s.upps) : null;
    const medTotal = s.totals.length ? median(s.totals) : null;
    const medUppWan = medUpp ? medUpp / 10000 : null;
    // 路段圓圈 size: 5 + sqrt(count/max)*25 = max ~30px
    const radius = 5 + Math.sqrt(s.count / maxStreetCount) * 25;
    const color = uppColor(medUppWan);
    const marker = L.circleMarker(c, {
      radius, color, fillColor: color, fillOpacity: 0.6, weight: 1.5,
    });
    marker.bindPopup(`
      <div class="map-popup-title">${escapeHtml(s.street)}</div>
      <div class="map-popup-row"><span class="lbl">區</span>${s.d}</div>
      <div class="map-popup-row"><span class="lbl">成交量</span>${s.count} 筆</div>
      <div class="map-popup-row"><span class="lbl">中位總價</span>${medTotal != null ? fmtMoney(medTotal) + " 萬" : "—"}</div>
      <div class="map-popup-row"><span class="lbl">中位單價</span>${medUppWan != null ? medUppWan.toFixed(1) + " 萬/坪" : "—"}</div>
    `, { maxWidth: 240 });
    streetLayers.push(marker);
  });
  state.mapStreetLayer = L.layerGroup(streetLayers);

  // 依目前 zoom 決定要顯示哪一層
  switchMapLayer();

  setTimeout(() => state.map.invalidateSize(), 100);
}

function switchMapLayer() {
  if (!state.map) return;
  const zoom = state.map.getZoom();
  const useStreet = zoom >= STREET_ZOOM_THRESHOLD && state.mapStreetLayer
    && state.mapStreetLayer.getLayers().length > 0;
  if (useStreet) {
    if (state.mapDistLayer && state.map.hasLayer(state.mapDistLayer)) {
      state.map.removeLayer(state.mapDistLayer);
    }
    if (state.mapStreetLayer && !state.map.hasLayer(state.mapStreetLayer)) {
      state.mapStreetLayer.addTo(state.map);
    }
  } else {
    if (state.mapStreetLayer && state.map.hasLayer(state.mapStreetLayer)) {
      state.map.removeLayer(state.mapStreetLayer);
    }
    if (state.mapDistLayer && !state.map.hasLayer(state.mapDistLayer)) {
      state.mapDistLayer.addTo(state.map);
    }
  }
}

function uppColor(uppWan) {
  if (uppWan == null) return "#9ca3af";
  if (uppWan < 10) return "#fef3c7";
  if (uppWan < 20) return "#fbbf24";
  if (uppWan < 35) return "#f97316";
  return "#dc2626";
}

// ===================================================================
// 趨勢模組
// ===================================================================
function initTrendTab() {
  $("trend-district").addEventListener("change", renderTrend);
  $("trend-metric").addEventListener("change", renderTrend);
  $("trend-split-cat").addEventListener("change", renderTrend);
}

const CAT_COLORS = {
  "新屋":   { line: "#10b981", bar: "rgba(16, 185, 129, 0.35)" },
  "中古屋": { line: "#f59e0b", bar: "rgba(245, 158, 11, 0.35)" },
  "預售屋": { line: "#8b5cf6", bar: "rgba(139, 92, 246, 0.35)" },
};

function renderTrend() {
  const distFilter = $("trend-district").value;
  const metric = $("trend-metric").value; // 'upp' | 'total' | 'ping'
  const splitCat = $("trend-split-cat").checked;

  // 趨勢圖：依篩選後資料 + 可選額外的區
  let rows = state.filtered;
  if (distFilter) rows = rows.filter((r) => r.d === distFilter);

  // 把區下拉填入 (只填一次, 用篩選後資料的區)
  const sel = $("trend-district");
  if (sel.options.length <= 1 || sel.dataset.districts !== state.districts.join(",")) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">全部 (篩選後)</option>` +
      state.districts.map((d) => `<option value="${d}">${d}</option>`).join("");
    sel.dataset.districts = state.districts.join(",");
    sel.value = cur;
  }

  const metricArrKey = { upp: "upps", total: "totals", ping: "pings" }[metric];
  const metricLabel = {
    upp: "中位單價 (萬/坪)",
    total: "中位總價 (萬)",
    ping: "中位坪數",
  }[metric];
  const metricScale = { upp: 10000, total: 10000, ping: 1 }[metric];

  // 依 splitCat 模式建立月度聚合
  // 不拆線: monthMap[ym] = { count, upps, totals, pings }
  // 拆線:   monthMap[ym][cat] = { count, upps, totals, pings }
  const allMonths = new Set();
  const monthMap = {};
  rows.forEach((r) => {
    const k = ymKey(r.date);
    allMonths.add(k);
    if (splitCat) {
      if (!monthMap[k]) monthMap[k] = {};
      if (!monthMap[k][r.cat]) monthMap[k][r.cat] = { count: 0, upps: [], totals: [], pings: [] };
      const bucket = monthMap[k][r.cat];
      bucket.count++;
      if (r.upp != null) bucket.upps.push(r.upp);
      if (r.total != null) bucket.totals.push(r.total);
      if (r.ping != null) bucket.pings.push(r.ping);
    } else {
      if (!monthMap[k]) monthMap[k] = { count: 0, upps: [], totals: [], pings: [] };
      monthMap[k].count++;
      if (r.upp != null) monthMap[k].upps.push(r.upp);
      if (r.total != null) monthMap[k].totals.push(r.total);
      if (r.ping != null) monthMap[k].pings.push(r.ping);
    }
  });
  const months = [...allMonths].sort();

  const datasets = [];
  if (splitCat) {
    // 每個類型一條折線（指標）+ 一條堆疊長條（成交量）
    state.categories.forEach((cat) => {
      const c = CAT_COLORS[cat] || { line: "#6b7280", bar: "rgba(107,114,128,0.35)" };
      datasets.push({
        type: "bar",
        label: `${cat} 成交量`,
        data: months.map((m) => monthMap[m]?.[cat]?.count || 0),
        backgroundColor: c.bar,
        borderColor: c.line,
        borderWidth: 1,
        borderRadius: 2,
        yAxisID: "y2",
        stack: "vol",
        order: 3,
      });
      datasets.push({
        type: "line",
        label: `${cat} ${metricLabel}`,
        data: months.map((m) => {
          const arr = monthMap[m]?.[cat]?.[metricArrKey];
          if (!arr || !arr.length) return null;
          return median(arr) / metricScale;
        }),
        borderColor: c.line,
        backgroundColor: c.line,
        tension: 0.25,
        pointRadius: 3,
        pointHoverRadius: 5,
        yAxisID: "y1",
        spanGaps: true,
        order: 1,
      });
    });
  } else {
    datasets.push({
      type: "bar",
      label: "成交量",
      data: months.map((m) => monthMap[m]?.count || 0),
      backgroundColor: "rgba(37, 99, 235, 0.35)",
      borderColor: "#2563eb",
      borderWidth: 1,
      borderRadius: 3,
      yAxisID: "y2",
      order: 2,
    });
    datasets.push({
      type: "line",
      label: metricLabel,
      data: months.map((m) => {
        const arr = monthMap[m]?.[metricArrKey];
        if (!arr || !arr.length) return null;
        return median(arr) / metricScale;
      }),
      borderColor: "#dc2626",
      backgroundColor: "#dc2626",
      tension: 0.25,
      pointRadius: 3,
      pointHoverRadius: 5,
      yAxisID: "y1",
      order: 1,
    });
  }

  const ctx = $("trend-chart");
  if (state.trendChart) state.trendChart.destroy();
  state.trendChart = new Chart(ctx, {
    data: { labels: months, datasets },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { font: { size: 11 }, boxWidth: 14 } },
      },
      scales: {
        x: { ticks: { font: { size: 10 } }, grid: { display: false } },
        y1: {
          type: "linear",
          position: "left",
          title: { display: true, text: metricLabel, font: { size: 11 } },
          ticks: { precision: 1 },
          grid: { color: "#f3f4f6" },
        },
        y2: {
          type: "linear",
          position: "right",
          title: { display: true, text: "成交量", font: { size: 11 } },
          ticks: { precision: 0 },
          grid: { display: false },
          stacked: splitCat,
        },
      },
    },
  });

  renderRankings();
}

function renderRankings() {
  const byDist = {};
  state.filtered.forEach((r) => {
    if (!byDist[r.d]) byDist[r.d] = { count: 0, upps: [] };
    byDist[r.d].count++;
    if (r.upp != null) byDist[r.d].upps.push(r.upp);
  });
  const arr = Object.entries(byDist).map(([d, s]) => ({
    d,
    count: s.count,
    medUpp: s.upps.length ? median(s.upps) : null,
  }));

  // 成交量排行
  const byVolume = [...arr].sort((a, b) => b.count - a.count).slice(0, 10);
  $("rank-volume").innerHTML = byVolume
    .map(
      (x, i) => `
      <div class="rank-row">
        <span class="rank-num ${i < 3 ? "top" : ""}">${i + 1}</span>
        <span><span class="badge">${x.d}</span></span>
        <span class="num">${x.count.toLocaleString()} 筆</span>
        <span class="sub">${x.medUpp != null ? fmtMoneyPerPing(x.medUpp) + " 萬/坪" : "—"}</span>
      </div>`
    )
    .join("");

  // 中位單價排行（至少 10 筆才列入，避免極端值）
  const byPrice = arr
    .filter((x) => x.medUpp != null && x.count >= 10)
    .sort((a, b) => b.medUpp - a.medUpp)
    .slice(0, 10);
  $("rank-price").innerHTML = byPrice
    .map(
      (x, i) => `
      <div class="rank-row">
        <span class="rank-num ${i < 3 ? "top" : ""}">${i + 1}</span>
        <span><span class="badge">${x.d}</span></span>
        <span class="num">${fmtMoneyPerPing(x.medUpp)} 萬/坪</span>
        <span class="sub">${x.count} 筆</span>
      </div>`
    )
    .join("");
}

// ===================================================================
// 比價模組
// ===================================================================
function initCompareTab() {
  $("cmp-search").addEventListener("click", runCompare);
}

function runCompare() {
  const d = $("cmp-district").value;
  const cat = $("cmp-cat").value;
  const type = $("cmp-type").value;
  const targetPing = parseFloat($("cmp-ping").value);
  const targetAge = parseFloat($("cmp-age").value);
  const targetRooms = parseInt($("cmp-rooms").value, 10);

  // 先過濾候選：同區 (+ 類型 + 型態, 如有指定)
  let cand = state.all.filter((r) => r.d === d);
  if (cat) cand = cand.filter((r) => r.cat === cat);
  if (type) cand = cand.filter((r) => r.type === type);

  // 為每筆算相似度 (0=完全相同, 越高越不像)
  const scored = cand
    .map((r) => {
      let dist = 0;
      let valid = 0;
      if (!isNaN(targetPing) && r.ping != null) {
        dist += Math.pow((r.ping - targetPing) / Math.max(targetPing, 1), 2) * 100;
        valid++;
      }
      if (!isNaN(targetAge) && r.age != null) {
        dist += Math.pow((r.age - targetAge) / Math.max(targetAge + 1, 5), 2) * 100;
        valid++;
      }
      if (!isNaN(targetRooms) && r.rooms != null) {
        dist += Math.pow(r.rooms - targetRooms, 2) * 30;
        valid++;
      }
      // 加入時間衰減（越新分數越好）
      const ageDays = (new Date() - new Date(r.date)) / (1000 * 60 * 60 * 24);
      dist += Math.max(0, ageDays - 30) * 0.05;
      return { r, dist, valid };
    })
    .filter((x) => x.valid > 0 || (isNaN(targetPing) && isNaN(targetAge) && isNaN(targetRooms)))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 30);

  state.cmpResults = scored;

  if (!scored.length) {
    $("cmp-summary").textContent = "沒有符合條件的可比物件";
    $("cmp-badge").textContent = "0";
    $("cmp-body").innerHTML = `<tr><td colspan="9" style="text-align:center;padding:30px;color:#9ca3af;">無資料</td></tr>`;
    return;
  }

  // 統計可比物件的價格分布
  const upps = scored.map((x) => x.r.upp).filter((v) => v != null);
  const medUpp = upps.length ? median(upps) : null;
  const totals = scored.map((x) => x.r.total).filter((v) => v != null);
  const medTotal = totals.length ? median(totals) : null;

  let summaryParts = [`找到 ${scored.length} 筆相似物件`];
  if (medTotal != null) summaryParts.push(`中位總價 <strong>${fmtMoney(medTotal)}</strong> 萬`);
  if (medUpp != null) summaryParts.push(`中位單價 <strong>${fmtMoneyPerPing(medUpp)}</strong> 萬/坪`);
  if (!isNaN(targetPing) && medUpp != null) {
    const est = (medUpp * targetPing) / 10000;
    summaryParts.push(`👉 預估價（中位單價 × ${targetPing} 坪）約 <strong>${fmtNumber(est, 0)}</strong> 萬`);
  }
  $("cmp-summary").innerHTML = summaryParts.join(" · ");
  $("cmp-badge").textContent = scored.length;

  const maxDist = scored[scored.length - 1].dist || 1;
  $("cmp-body").innerHTML = scored.map(({ r, dist }) => {
    const sim = Math.max(0, 1 - dist / (maxDist * 1.1));   // 0..1
    const pct = Math.round(sim * 100);
    const pattern =
      r.rooms || r.halls || r.baths
        ? `${r.rooms || 0}房${r.halls || 0}廳${r.baths || 0}衛`
        : "—";
    const catB = r.cat ? `<span class="cat-badge ${r.cat}" style="margin-right:4px;">${r.cat}</span>` : "";
    let addrCell = escapeHtml(r.addr);
    if (r.cat === "預售屋" && r.build_name) {
      addrCell += `<div style="font-size:11px;color:#5b21b6;">🏗 ${escapeHtml(r.build_name)}</div>`;
    }
    return `<tr>
      <td>
        <span class="sim-bar" style="width:${Math.max(20, pct)}px;"></span>
        <span style="font-size:11px;color:var(--muted);margin-left:4px;">${pct}%</span>
      </td>
      <td>${r.date}</td>
      <td class="addr">${catB}${addrCell}</td>
      <td>${escapeHtml(r.type || "—")}</td>
      <td class="num">${fmtMoney(r.total)}</td>
      <td class="num">${fmtNumber(r.ping, 1)}</td>
      <td class="num">${fmtMoneyPerPing(r.upp)}</td>
      <td>${pattern}</td>
      <td class="num">${r.age != null ? r.age.toFixed(1) : "—"}</td>
    </tr>`;
  }).join("");
}

// ===================================================================
// CSV 匯出
// ===================================================================
function initExportButton() {
  $("btn-export").addEventListener("click", exportCsv);
}

function exportCsv() {
  const rows = state.filtered;
  if (!rows.length) {
    alert("沒有資料可匯出");
    return;
  }
  const headers = [
    "成交日期", "類型", "行政區", "地址", "建案名稱", "建物型態", "主要用途",
    "總價(元)", "建物坪數", "單價(元/坪)",
    "房", "廳", "衛", "總樓層數",
    "建築完成", "屋齡(年)", "電梯", "季別",
  ];
  const lines = [headers.join(",")];
  rows.forEach((r) => {
    const cells = [
      r.date,
      r.cat || "",
      r.d,
      r.addr,
      r.build_name || "",
      r.type || "",
      r.use || "",
      r.total ?? "",
      r.ping ?? "",
      r.upp ?? "",
      r.rooms ?? "",
      r.halls ?? "",
      r.baths ?? "",
      r.floor_total || "",
      r.build_date || "",
      r.age ?? "",
      r.elev || "",
      r.season || "",
    ];
    lines.push(cells.map(csvEscape).join(","));
  });

  // 加入 UTF-8 BOM 讓 Excel 識別為 UTF-8
  const bom = "﻿";
  const blob = new Blob([bom + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const ts = new Date().toISOString().slice(0, 16).replace(/[T:]/g, "-");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tainan_house_${ts}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

function csvEscape(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// 暴露 state 供瀏覽器 console 除錯使用（如 __app.filtered, __app.map）
window.__app = state;

// ---------- 啟動 ----------
loadData();
