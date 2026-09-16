// DBH Insights: page logic.
//
// Every value rendered here comes from vCenter and is free text (VM names, annotations).
// Nothing is written with innerHTML: nodes are built with createElement and textContent.

const $ = (id) => document.getElementById(id);

const APP_VERSION = "0.3.0";
const INSIGHTS = "Insights";
const TOPOLOGY = "Topology";
const IMPACT = "Impact";
const EXPLORER = "API Explorer";
const ALL = "all";
const PAGE_SIZES = [5, 10, 25, 50, 100, 250, 500, 0]; // 0 = all rows
const DEFAULT_PAGE_SIZE = 25;
const SHEET_BY_NAME = new Map(SHEETS.map((s) => [s.name, s]));
const GROUP_ORDER = [
  "Overview",
  "Inventory",
  "Virtual machines",
  "Host network & storage",
  "Distributed switch",
  "Performance",
  "Health",
  "System",
  "Tools",
];

function readPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch { /* storage unavailable */ }
}

const state = {
  view: readPref("view", INSIGHTS),
  vcenters: [], // [{ id, name, host, username }] from the helper
  selected: readPref("vcenter", ALL),
  ready: false,
  data: new Map(), // vCenter id → VcenterData, reused until Refresh
  table: null,
  sort: { index: null, ascending: true },
  page: 1,
  pageSize: Number(readPref("pageSize", String(DEFAULT_PAGE_SIZE))),
  rowCounts: new Map(),
  loadToken: 0,
  loadedAt: null,
  busy: 0,
  insights: null, // the dashboard currently shown, for Download HTML
  fabric: null, // hosts, datastores and VMs joined up, for Impact
  impactTarget: readPref("impactTarget", ""),
};
if (![INSIGHTS, TOPOLOGY, IMPACT, EXPLORER].includes(state.view) && !SHEET_BY_NAME.has(state.view)) state.view = INSIGHTS;
if (!PAGE_SIZES.includes(state.pageSize)) state.pageSize = DEFAULT_PAGE_SIZE;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// ---------- status, notices, warnings ----------

function setStatus(text) {
  $("status").textContent = text;
}

function loadedAtText() {
  return state.loadedAt ? ` · data from ${state.loadedAt.toLocaleTimeString()}` : "";
}

function setConnection(text, tone, title = "") {
  const node = $("connection");
  node.textContent = text;
  node.className = `conn ${tone}`;
  node.title = title;
}

/** Guidance about the helper itself. Parts are strings or nodes. */
function showNotice(title, ...parts) {
  const box = $("notice");
  box.replaceChildren();
  box.hidden = !title;
  if (!title) return;
  box.append(make("strong", "", title));
  if (parts.length) {
    const p = make("p");
    p.append(...parts);
    box.append(p);
  }
}

function renderWarnings(warnings) {
  const box = $("warnings");
  box.replaceChildren();
  box.hidden = !warnings?.length;
  if (!warnings?.length) return;
  box.append(
    make(
      "strong",
      "",
      warnings.length === 1
        ? "1 vCenter could not be queried — results below are incomplete:"
        : `${warnings.length} vCenter queries failed — results below are incomplete:`,
    ),
  );
  const list = make("ul");
  for (const w of warnings) list.append(make("li", "", w));
  box.append(list);
}

function busyStart() {
  state.busy += 1;
  updateBusy();
}

function busyEnd() {
  state.busy = Math.max(0, state.busy - 1);
  updateBusy();
}

function updateBusy() {
  const busy = state.busy > 0;
  for (const id of ["refresh", "export", "downloadHtml"]) $(id).disabled = busy;
}

// ---------- helper and vCenters ----------

function dataFor(vc) {
  const key = `${vc.host}|${vc.username}`;
  let data = state.data.get(vc.id);
  if (!data || data.key !== key) {
    data = new VcenterData(vc);
    data.key = key;
    state.data.set(vc.id, data);
  }
  data.vc = vc; // picks up a renamed display name
  return data;
}

function selectedData() {
  const vcs = state.selected === ALL ? state.vcenters : state.vcenters.filter((vc) => vc.id === state.selected);
  return vcs.map(dataFor);
}

function fillSelect(select, options, preferred) {
  select.replaceChildren(...options.map(([value, label]) => new Option(label, value)));
  select.value = options.some(([value]) => value === preferred) ? preferred : (options[0]?.[0] ?? "");
}

function renderVcenterPickers() {
  const options = state.vcenters.map((vc) => [vc.id, vc.name]);
  const multiple = options.length > 1;

  fillSelect($("vcenterSelect"), [[ALL, `All vCenters (${options.length})`], ...options], state.selected);
  state.selected = $("vcenterSelect").value;
  $("vcenterSelect").hidden = !multiple;

  const explorerPreferred = $("explorerVcenter").value || (state.selected !== ALL ? state.selected : "");
  fillSelect($("explorerVcenter"), options, explorerPreferred);
  $("explorerVcenter").hidden = !multiple;
}

async function checkHelper() {
  let status;
  try {
    status = await HelperClient.status();
  } catch (err) {
    state.ready = false;
    setConnection("Helper not running", "bad", err.message);
    showNotice(
      "Can't find the DBH Insights Helper.",
      "Start the helper app on this computer. If your browser asks to allow access to your local network, choose Allow.",
    );
    return false;
  }

  if (!status.originAllowed) {
    state.ready = false;
    setConnection("Website not allowed", "bad");
    if (location.protocol === "file:") {
      showNotice(
        "The helper doesn't allow pages opened from a local file.",
        "Open the helper, turn on “Allow the website when opened from a local file”, and click Save settings. Or serve this folder with a local web server and open it from http://localhost:5500 instead.",
      );
      return false;
    }
    showNotice(
      "The helper is running but doesn't trust this website yet.",
      "Open the helper, add ",
      make("code", "", location.origin),
      " to “Websites allowed to use this helper”, and click Save settings.",
    );
    return false;
  }

  if (!status.capabilities?.includes("soap")) {
    state.ready = false;
    setConnection("Helper update needed", "bad", `Helper ${status.version}`);
    showNotice(
      "This page needs a newer DBH Insights Helper.",
      `The running helper (${status.version}) can't make SOAP queries. Install DBH Insights Helper 0.3.0 or later.`,
    );
    return false;
  }

  state.vcenters = status.vcenters ?? [];
  renderVcenterPickers();

  if (!state.vcenters.length) {
    state.ready = false;
    setConnection("Helper needs a vCenter", "warn");
    showNotice("The helper has no vCenters set up.", "Open the helper app and click “Add vCenter”.");
    return false;
  }

  state.ready = true;
  const title = `Helper ${status.version}`;
  if (state.vcenters.length === 1) {
    const [vc] = state.vcenters;
    setConnection(`${vc.username} @ ${vc.host}`, "ok", title);
  } else {
    setConnection(`Helper ready · ${state.vcenters.length} vCenters`, "ok", title);
  }
  showNotice("");
  return true;
}

// ---------- navigation ----------

function renderNav() {
  const nav = $("nav");
  nav.replaceChildren();

  const groups = new Map([
    ["Overview", [INSIGHTS, TOPOLOGY, IMPACT]],
    ["Tools", [EXPLORER]],
  ]);
  for (const sheet of SHEETS) {
    if (!groups.has(sheet.group)) groups.set(sheet.group, []);
    groups.get(sheet.group).push(sheet.name);
  }
  // Known groups first, in order; anything new appears after them rather than vanishing.
  const headings = [
    ...GROUP_ORDER.filter((g) => groups.has(g)),
    ...[...groups.keys()].filter((g) => !GROUP_ORDER.includes(g)),
  ];

  for (const heading of headings) {
    const views = groups.get(heading);
    nav.append(make("p", "nav-heading", heading));
    for (const view of views) {
      const item = make("button", `nav-item${view === state.view ? " active" : ""}`);
      item.type = "button";
      if (view === state.view) item.setAttribute("aria-current", "page");
      item.append(make("span", "", view));
      // Counts appear once a sheet has been fetched; an unvisited sheet shows nothing rather than zero.
      if (state.rowCounts.has(view)) item.append(make("span", "count", state.rowCounts.get(view).toLocaleString()));
      item.addEventListener("click", () => selectView(view));
      nav.append(item);
    }
  }
}

function selectView(view) {
  if (view === state.view) return;
  state.view = view;
  writePref("view", view);
  $("filter").value = "";
  renderNav();
  load();
}

/** Show exactly one of the dashboard, the topology, a table, or the explorer. */
function setView(view) {
  const isSheet = SHEET_BY_NAME.has(view);
  $("dashboard").hidden = view !== INSIGHTS;
  $("topologyView").hidden = view !== TOPOLOGY;
  $("impactView").hidden = view !== IMPACT;
  $("tableView").hidden = !isSheet;
  $("explorerView").hidden = view !== EXPLORER;
  $("filter").hidden = !isSheet;
  // Insights and Topology can each be saved as a standalone HTML file.
  $("downloadHtml").hidden = view !== INSIGHTS && view !== TOPOLOGY;
  $("refresh").hidden = view === EXPLORER;
}

// ---------- table with paging ----------

function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return String(value);
}

function filteredRows() {
  const needle = $("filter").value.trim().toLowerCase();
  if (!needle) return state.table.rows;
  return state.table.rows.filter((row) => row.some((v) => cellText(v).toLowerCase().includes(needle)));
}

function sortedRows(rows) {
  const { index, ascending } = state.sort;
  if (index === null) return rows;
  const numeric = state.table.columns[index].kind === "number";
  const dir = ascending ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[index];
    const y = b[index];
    // Blanks sort last in both directions: "not reported" isn't a small value.
    const xEmpty = x === null || x === undefined || x === "";
    const yEmpty = y === null || y === undefined || y === "";
    if (xEmpty || yEmpty) return xEmpty && yEmpty ? 0 : xEmpty ? 1 : -1;
    if (numeric) return (x - y) * dir;
    return cellText(x).localeCompare(cellText(y), undefined, { numeric: true }) * dir;
  });
}

function renderHead() {
  const row = $("headRow");
  row.replaceChildren();
  if (!state.table) return;
  state.table.columns.forEach((column, i) => {
    const th = make("th", column.kind === "number" ? "num" : "", column.label);
    th.title = column.label;
    th.setAttribute("aria-sort", state.sort.index === i ? (state.sort.ascending ? "ascending" : "descending") : "none");
    if (state.sort.index === i) {
      th.classList.add("sorted");
      th.append(make("span", "arrow", state.sort.ascending ? "▲" : "▼"));
    }
    th.addEventListener("click", () => {
      state.sort = { index: i, ascending: state.sort.index === i ? !state.sort.ascending : true };
      state.page = 1;
      renderHead();
      renderBody();
    });
    row.append(th);
  });
}

function renderBody() {
  const body = $("body");
  body.replaceChildren();
  const table = state.table;
  if (!table) {
    $("tableEmpty").hidden = true;
    renderPager(0, 0, 0, 1);
    return;
  }

  const rows = sortedRows(filteredRows());
  const size = state.pageSize || Math.max(rows.length, 1);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  state.page = Math.min(Math.max(1, state.page), pages);
  const start = (state.page - 1) * size;
  const pageRows = rows.slice(start, start + size);

  const frag = document.createDocumentFragment();
  for (const row of pageRows) {
    const tr = make("tr");
    row.forEach((value, i) => {
      const text = cellText(value);
      const td = make("td", "", text);
      td.title = text;
      if (table.columns[i].kind === "number") td.classList.add("num");
      if (typeof value === "boolean") td.classList.add(value ? "bool-true" : "bool-false");
      if (text === "") td.classList.add("empty");
      tr.append(td);
    });
    frag.append(tr);
  }
  body.append(frag);

  $("tableEmpty").hidden = rows.length > 0;
  $("tableEmpty").textContent = table.rows.length ? "No rows match the filter." : "No rows returned.";
  renderPager(rows.length, start, pageRows.length, pages);

  const total = table.rows.length;
  const count = rows.length === total ? `${total.toLocaleString()} rows` : `${rows.length.toLocaleString()} of ${total.toLocaleString()} rows`;
  setStatus(`${count}${loadedAtText()}`);
}

function renderPager(count, start, shown, pages) {
  $("pageRange").textContent = count ? `${(start + 1).toLocaleString()}–${(start + shown).toLocaleString()} of ${count.toLocaleString()}` : "0 rows";
  $("pageInfo").textContent = `Page ${state.page.toLocaleString()} of ${pages.toLocaleString()}`;
  $("pageFirst").disabled = $("pagePrev").disabled = state.page <= 1;
  $("pageNext").disabled = $("pageLast").disabled = state.page >= pages;
}

function goToPage(page) {
  state.page = page;
  renderBody();
  document.querySelector(".table-wrap").scrollTop = 0;
}

// ---------- Insights dashboard ----------

function num(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function size(gib) {
  if (gib === null || gib === undefined) return "—";
  return gib >= 1024 ? `${num(gib / 1024, 2)} TiB` : `${num(gib, 1)} GiB`;
}

function kpi(label, value, sub, tone = "hero") {
  const card = make("div", `card kpi ${tone}`);
  card.append(make("p", "kpi-label", label), make("div", "kpi-value", value));
  if (sub) card.append(make("div", "kpi-sub", sub));
  return card;
}

function gauge(percentUsed) {
  const svgNS = "http://www.w3.org/2000/svg";
  const box = 132;
  const r = 52;
  const circumference = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(100, percentUsed));
  const el = (name, attrs) => {
    const node = document.createElementNS(svgNS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const svg = el("svg", { class: "gauge", width: box, height: box, viewBox: `0 0 ${box} ${box}`, role: "img", "aria-label": `${num(percentUsed, 1)}% of storage used` });
  svg.append(el("circle", { class: "gauge-track", cx: box / 2, cy: box / 2, r }));
  const fill = el("circle", {
    class: "gauge-fill",
    cx: box / 2,
    cy: box / 2,
    r,
    "stroke-dasharray": `${(clamped / 100) * circumference} ${circumference}`,
    transform: `rotate(-90 ${box / 2} ${box / 2})`,
  });
  if (clamped >= 90) fill.style.stroke = "var(--danger)";
  else if (clamped >= 75) fill.style.stroke = "var(--warning)";
  // A zero-length arc with round caps would still draw a dot.
  if (clamped > 0) svg.append(fill);
  const pct = el("text", { class: "gauge-pct", x: box / 2, y: box / 2 + 4 });
  pct.textContent = `${num(percentUsed, 1)}%`;
  const cap = el("text", { class: "gauge-cap", x: box / 2, y: box / 2 + 20 });
  cap.textContent = "USED";
  svg.append(pct, cap);
  return svg;
}

function statLine(key, value) {
  const row = make("div", "stat");
  row.append(make("span", "k", key), make("span", "v", value));
  return row;
}

function barRow(name, valueText, percentWidth, toneClass) {
  const row = make("div", "bar-row");
  row.append(make("span", "bar-name", name), make("span", "bar-val", valueText));
  const track = make("div", "bar-track");
  const fill = make("div", `bar-fill ${toneClass || ""}`);
  fill.style.width = `${Math.max(0, Math.min(100, percentWidth))}%`;
  track.append(fill);
  row.append(track);
  return row;
}

function kindClass(kind) {
  const k = String(kind || "").toUpperCase();
  if (k.startsWith("NFS")) return "nfs";
  if (k.startsWith("VMFS")) return "vmfs";
  return "other";
}

function renderDashboard(i) {
  const board = $("dashboard");
  board.replaceChildren();

  const kpis = make("div", "kpi-row");
  kpis.append(
    kpi(
      "Total Hosts",
      num(i.hosts),
      i.hostsInMaintenance || i.hostsDisconnected
        ? `${i.hostsInMaintenance} in maintenance · ${i.hostsDisconnected} disconnected`
        : `${i.clusters} clusters · all connected`,
    ),
    kpi("Total Cores", num(i.cores), `${num(i.vcpus)} vCPUs assigned`),
    kpi("Total Storage", size(i.storageCapacityGiB), `${size(i.storageFreeGiB)} free across ${i.datastores} datastores`),
    kpi("Virtual Machines", num(i.vmsTotal), `${num(i.vmsPoweredOn)} powered on`, "muted"),
    kpi("Physical Memory", size(i.dramGiB), i.memoryTotalGiB > i.dramGiB ? `${size(i.memoryTotalGiB)} incl. memory tiers` : null, "muted"),
    kpi("vCPU : Core", i.vcpuCoreRatio ? `${num(i.vcpuCoreRatio, 2)}:1` : "—", `${size(i.vramGiB)} vRAM assigned`, "muted"),
  );
  board.append(kpis);

  const row = make("div", "panel-row");
  const gaugeCard = make("div", "card");
  gaugeCard.append(make("p", "card-title", "Storage utilisation"));
  const wrap = make("div", "gauge-wrap");
  const stats = make("div", "stat-list");
  stats.append(
    statLine("Capacity", size(i.storageCapacityGiB)),
    statLine("Used", size(i.storageUsedGiB)),
    statLine("Free", size(i.storageFreeGiB)),
    statLine("Datastores", num(i.datastores)),
  );
  wrap.append(gauge(i.storageUsedPercent), stats);
  gaugeCard.append(wrap);

  const typeCard = make("div", "card");
  typeCard.append(make("p", "card-title", "Capacity by datastore type"));
  const typeBars = make("div", "bars");
  const maxCapacity = Math.max(1, ...i.storageByType.map((t) => t.capacityGiB));
  for (const t of i.storageByType) {
    typeBars.append(
      barRow(
        `${t.kind} · ${t.datastores} datastore${t.datastores === 1 ? "" : "s"}`,
        `${size(t.usedGiB)} of ${size(t.capacityGiB)}`,
        (t.capacityGiB / maxCapacity) * 100,
        kindClass(t.kind),
      ),
    );
  }
  if (!i.storageByType.length) typeBars.append(make("p", "empty-note", "No datastores reported."));
  typeCard.append(typeBars);
  row.append(gaugeCard, typeCard);
  board.append(row);

  const row2 = make("div", "panel-row");
  const fullCard = make("div", "card");
  fullCard.append(make("p", "card-title", "Fullest datastores"));
  const fullBars = make("div", "bars");
  const multipleServers = i.servers.length > 1;
  for (const d of i.topDatastores) {
    const tone = d.usedPercent >= 90 ? "crit" : d.usedPercent >= 75 ? "warn" : "";
    fullBars.append(barRow(multipleServers ? `${d.name} · ${d.server}` : d.name, `${num(d.usedPercent, 1)}% · ${size(d.capacityGiB)}`, d.usedPercent, tone));
  }
  if (!i.topDatastores.length) fullBars.append(make("p", "empty-note", "No datastores reported."));
  fullCard.append(fullBars);

  const clusterCard = make("div", "card");
  clusterCard.append(make("p", "card-title", "Clusters"));
  if (i.clusterSummaries.length) {
    const tableWrap = make("div", "mini-wrap");
    const table = make("table", "mini-table");
    const head = make("tr");
    const headings = [["Cluster", ""], ...(multipleServers ? [["vCenter", ""]] : []), ["Hosts", "num"], ["Cores", "num"], ["DRAM", "num"]];
    for (const [label, cls] of headings) head.append(make("th", cls, label));
    const thead = make("thead");
    thead.append(head);
    const tbody = make("tbody");
    for (const c of i.clusterSummaries) {
      const tr = make("tr");
      tr.append(make("td", "", c.name));
      if (multipleServers) tr.append(make("td", "", c.server));
      tr.append(make("td", "num", num(c.hosts)), make("td", "num", num(c.cores)), make("td", "num", size(c.dramGiB)));
      tbody.append(tr);
    }
    table.append(thead, tbody);
    tableWrap.append(table);
    clusterCard.append(tableWrap);
  } else {
    clusterCard.append(make("p", "empty-note", "No clusters reported."));
  }
  row2.append(fullCard, clusterCard);
  board.append(row2);
}

// ---------- Impact ----------

// The picker is a searchable combobox, not a <select>: a large estate has hundreds of
// hosts and datastores, and a native list can only be typed at one letter at a time.
const COMBO_SHOWN = 200; // rows rendered at once; the rest need a narrower search

const combo = { options: [], matches: [], active: -1, open: false, query: "" };

function fillImpactTargets() {
  const many = state.fabric.servers.length > 1;
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  combo.options = [];
  state.fabric.servers.forEach((server, index) => {
    for (const host of server.hosts) {
      combo.options.push({
        value: `${index}:host:${host.moref}`,
        label: host.name,
        group: many ? `Hosts · ${server.server}` : "Hosts",
        detail: `${host.cluster ?? "Standalone"} · ${plural(host.vms.length, "VM")}`,
      });
    }
    for (const ds of server.datastores) {
      combo.options.push({
        value: `${index}:datastore:${ds.moref}`,
        label: ds.name,
        group: many ? `Datastores · ${server.server}` : "Datastores",
        detail: `${ds.kind ?? "Datastore"} · ${plural(ds.vms.length, "VM")} · ${plural(ds.hosts.length, "host")}`,
      });
    }
  });

  const chosen = combo.options.find((o) => o.value === state.impactTarget) ?? combo.options[0] ?? null;
  state.impactTarget = chosen?.value ?? "";
  $("impactSearch").value = chosen?.label ?? "";
  $("impactSearch").disabled = combo.options.length === 0;
  closeCombo(false);
}

/** Every term has to appear somewhere in the row, so "cl-02 vmfs" narrows twice. */
function comboMatches(query) {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return combo.options;
  return combo.options.filter((o) => {
    const hay = `${o.label} ${o.group} ${o.detail}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}

/** Opening from the field shows everything with the current choice highlighted; typing jumps to the first match. */
function openCombo(keepSelected) {
  combo.matches = comboMatches(combo.query);
  combo.open = true;
  combo.active = keepSelected ? combo.matches.findIndex((o) => o.value === state.impactTarget) : 0;
  if (combo.active < 0 && combo.matches.length) combo.active = 0;
  renderCombo();
}

function closeCombo(restore = true) {
  combo.open = false;
  combo.active = -1;
  renderCombo();
  if (restore) {
    const current = combo.options.find((o) => o.value === state.impactTarget);
    $("impactSearch").value = current?.label ?? "";
  }
}

function moveCombo(delta) {
  const count = Math.min(combo.matches.length, COMBO_SHOWN);
  if (!count) return;
  combo.active = (combo.active + delta + count) % count;
  renderCombo();
}

/** Takes the option itself, never a row index: the list can re-filter between render and click. */
function chooseCombo(option) {
  if (!option) return;
  state.impactTarget = option.value;
  writePref("impactTarget", option.value);
  $("impactSearch").value = option.label;
  closeCombo(false);
  renderImpactSelection();
}

function renderCombo() {
  const input = $("impactSearch");
  const list = $("impactList");
  list.replaceChildren();
  list.hidden = !combo.open;
  input.setAttribute("aria-expanded", String(combo.open));
  input.removeAttribute("aria-activedescendant");
  if (!combo.open) return;

  if (!combo.matches.length) {
    list.append(make("li", "combo-empty", "Nothing matches that."));
    return;
  }

  let group = null;
  combo.matches.slice(0, COMBO_SHOWN).forEach((option, i) => {
    if (option.group !== group) {
      group = option.group;
      list.append(make("li", "combo-group", group));
    }
    const li = make("li", `combo-option${i === combo.active ? " active" : ""}`);
    li.id = `impactOption${i}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(option.value === state.impactTarget));
    li.append(make("span", "combo-label", option.label), make("span", "combo-detail", option.detail));
    // Clicking must not blur the field first, or the list would close before the click lands.
    li.addEventListener("mousedown", (event) => event.preventDefault());
    li.addEventListener("click", () => chooseCombo(option));
    list.append(li);
  });
  if (combo.matches.length > COMBO_SHOWN) {
    list.append(make("li", "combo-empty", `${combo.matches.length - COMBO_SHOWN} more — keep typing to narrow the list.`));
  }

  const active = combo.active >= 0 ? $(`impactOption${combo.active}`) : null;
  if (active) {
    input.setAttribute("aria-activedescendant", active.id);
    active.scrollIntoView({ block: "nearest" });
  }
}

/** A cell is plain text, or { num } to right-align it. */
function miniTable(columns, rows) {
  const table = make("table", "mini-table");
  const head = make("tr");
  for (const label of columns) head.append(make("th", "", label));
  const thead = make("thead");
  thead.append(head);
  const tbody = make("tbody");
  for (const row of rows) {
    const tr = make("tr");
    row.forEach((cell, i) => {
      const numeric = cell && typeof cell === "object";
      const td = make("td", numeric ? "num" : "", numeric ? cell.num : cell);
      if (i === 0) td.title = String(cell);
      tr.append(td);
    });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  const wrap = make("div", "mini-wrap impact-scroll");
  wrap.append(table);
  return wrap;
}

function renderImpact(box, r) {
  const head = make("div", "impact-head");
  head.append(make("h2", "", r.title));
  head.append(make("p", "impact-sub", state.fabric.servers.length > 1 ? `${r.subtitle} · ${r.server}` : r.subtitle));
  box.append(head);

  const verdict = make("div", `verdict ${r.severity}`);
  verdict.append(make("strong", "", r.headline), make("p", "", r.detail));
  box.append(verdict);

  const kpis = make("div", "kpi-row");
  for (const [label, value, sub] of r.kpis) kpis.append(kpi(label, value, sub, r.severity === "crit" ? "hero" : "muted"));
  box.append(kpis);

  const row = make("div", "panel-row");
  const facts = make("div", "card");
  facts.append(make("p", "card-title", r.kind === "host" ? "Host and cluster" : "Datastore"));
  const stats = make("div", "stat-list");
  for (const [k, v] of r.facts) stats.append(statLine(k, v));
  facts.append(stats);

  const main = make("div", "card");
  main.append(make("p", "card-title", r.table.title));
  main.append(r.table.rows.length ? miniTable(r.table.columns, r.table.rows) : make("p", "empty-note", r.table.empty));
  row.append(facts, main);
  box.append(row);

  for (const list of r.lists) {
    const card = make("div", "card");
    card.append(make("p", "card-title", list.title));
    if (list.note) card.append(make("p", "impact-note", list.note));
    card.append(miniTable(list.columns, list.rows));
    box.append(card);
  }
}

function renderImpactSelection() {
  const box = $("impactResult");
  box.replaceChildren();
  const [index, kind, ...rest] = state.impactTarget.split(":");
  const moref = rest.join(":");
  const server = state.fabric?.servers[Number(index)];
  const item = server && (kind === "host" ? server.hosts : server.datastores).find((x) => x.moref === moref);
  if (!item) {
    box.append(make("p", "empty-note", "Pick a host or datastore to see what depends on it."));
    setStatus(loadedAtText().replace(/^ · /, ""));
    return;
  }

  const result = kind === "host" ? hostImpact(server, item) : datastoreImpact(server, item);
  renderImpact(box, result);
  setStatus(`${result.title} · ${result.status}${loadedAtText()}`);
}

// ---------- loading ----------

async function load() {
  const token = ++state.loadToken;
  const view = state.view;
  $("title").textContent = view;
  setView(view);
  renderWarnings([]);

  if (view === EXPLORER) {
    setStatus("REST and SOAP requests through the helper");
    await checkHelper();
    return;
  }

  if (view === INSIGHTS) {
    state.insights = null;
    $("dashboard").replaceChildren();
  } else if (view === TOPOLOGY) {
    $("topologyFrame").srcdoc = "";
  } else if (view === IMPACT) {
    $("impactResult").replaceChildren();
  } else {
    state.table = null;
    renderHead();
    renderBody();
  }

  if (!(await checkHelper())) {
    if (token === state.loadToken) setStatus("");
    return;
  }
  if (token !== state.loadToken) return;

  const data = selectedData();
  setStatus(
    view === INSIGHTS
      ? "Building insights…"
      : view === TOPOLOGY
        ? "Mapping hosts and datastores…"
        : view === IMPACT
          ? "Working out what depends on what…"
          : `Querying vCenter for ${view}…`,
  );
  busyStart();
  try {
    if (view === INSIGHTS) {
      const insights = await buildInsights(data);
      if (token !== state.loadToken) return;
      state.loadedAt ??= new Date();
      state.insights = insights;
      renderWarnings(insights.warnings);
      renderDashboard(insights);
      const servers = insights.servers.length;
      setStatus(
        `${num(insights.hosts)} hosts · ${num(insights.cores)} cores · ${size(insights.storageCapacityGiB)} across ${servers} vCenter${servers === 1 ? "" : "s"}${loadedAtText()}`,
      );
    } else if (view === TOPOLOGY) {
      const topology = await buildTopology(data);
      if (token !== state.loadToken) return;
      state.loadedAt ??= new Date();
      renderWarnings(topology.warnings);
      const frame = $("topologyFrame");
      frame.addEventListener("load", () => frame.contentDocument && TopologyReport.attachHover(frame.contentDocument), { once: true });
      frame.srcdoc = TopologyReport.render(topology, APP_VERSION, { embedded: true });
      setStatus(`${topologySummary(topology)}${loadedAtText()}`);
    } else if (view === IMPACT) {
      const fabric = await buildFabric(data);
      if (token !== state.loadToken) return;
      state.loadedAt ??= new Date();
      state.fabric = fabric;
      renderWarnings(fabric.warnings);
      fillImpactTargets();
      renderImpactSelection();
    } else {
      const table = await buildTable(SHEET_BY_NAME.get(view), data);
      if (token !== state.loadToken) return;
      state.loadedAt ??= new Date();
      state.table = table;
      state.sort = { index: null, ascending: true };
      state.page = 1;
      state.rowCounts.set(view, table.rows.length);
      renderNav();
      renderWarnings(table.warnings);
      renderHead();
      renderBody();
    }
  } catch (err) {
    if (token === state.loadToken) setStatus(err.message);
  } finally {
    busyEnd();
  }
}

function refresh() {
  state.data = new Map();
  state.fabric = null;
  state.rowCounts.clear();
  state.loadedAt = null;
  renderNav();
  load();
}

// ---------- export and report ----------

function timestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
}

function downloadBlob(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

async function exportXlsx() {
  if (!(await checkHelper())) return;
  const data = selectedData();
  busyStart();
  setStatus("Collecting every sheet for export…");
  try {
    const tables = await Promise.all(SHEETS.map((sheet) => buildTable(sheet, data)));
    for (const t of tables) state.rowCounts.set(t.name, t.rows.length);
    renderNav();

    const filename = `DBH_Insights_export_all_${timestamp()}.xlsx`;
    downloadBlob(Xlsx.workbook(tables), filename);

    // A workbook missing a vCenter's rows has to say so, not just report a row count.
    renderWarnings([...new Set(tables.flatMap((t) => t.warnings))]);
    const rows = tables.reduce((n, t) => n + t.rows.length, 0);
    setStatus(`Exported ${tables.length} sheets, ${rows.toLocaleString()} rows → ${filename}`);
  } catch (err) {
    setStatus(`Export failed: ${err.message}`);
  } finally {
    busyEnd();
  }
}

function topologySummary(topology) {
  const hosts = topology.servers.reduce((n, s) => n + allHosts(s).length, 0);
  const datastores = topology.servers.reduce((n, s) => n + s.datastores.length, 0);
  const servers = topology.servers.length;
  return `${hosts} host${hosts === 1 ? "" : "s"} · ${datastores} datastore${datastores === 1 ? "" : "s"} across ${servers} vCenter${servers === 1 ? "" : "s"}`;
}

/** The Insights dashboard as a standalone HTML file, matching what's on screen. */
function downloadInsights() {
  if (!state.insights) {
    setStatus("Insights are still loading. Try again when the dashboard appears.");
    return;
  }
  const filename = `DBH_Insights_Dashboard_${timestamp()}.html`;
  const html = InsightsReport.render(state.insights, $("dashboard"), APP_VERSION);
  downloadBlob(new Blob([html], { type: "text/html" }), filename);
  const servers = state.insights.servers.length;
  setStatus(`Insights for ${servers} vCenter${servers === 1 ? "" : "s"} → ${filename}`);
}

/** The topology as a standalone HTML file, for emailing or archiving. Uses the cached queries. */
async function downloadTopology() {
  if (!(await checkHelper())) return;
  const data = selectedData();
  busyStart();
  setStatus("Building the topology report…");
  try {
    const topology = await buildTopology(data);
    const filename = `DBH_Insights_Topology_${timestamp()}.html`;
    downloadBlob(new Blob([TopologyReport.render(topology, APP_VERSION)], { type: "text/html" }), filename);
    renderWarnings(topology.warnings);
    setStatus(`${topologySummary(topology)} → ${filename}`);
  } catch (err) {
    setStatus(`Report failed: ${err.message}`);
  } finally {
    busyEnd();
  }
}

// ---------- API explorer ----------

const SOAP_SAMPLE = `<vim25:RetrieveServiceContent>
  <vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this>
</vim25:RetrieveServiceContent>`;

function updateExplorerMode() {
  const soap = $("explorerMode").value === "SOAP";
  $("explorerPath").hidden = soap;
  // Only SOAP takes a body; REST requests are GETs.
  $("explorerBody").hidden = !soap;
  if (soap && !$("explorerBody").value.trim()) $("explorerBody").value = SOAP_SAMPLE;
  $("explorerBody").placeholder = "One vim25 operation element";
  $("explorerHint").textContent = soap
    ? "Read-only operations only: RetrieveServiceContent, RetrievePropertiesEx, ContinueRetrievePropertiesEx, CancelRetrievePropertiesEx, CreateContainerView, DestroyView. The helper adds the envelope and session."
    : "Any vCenter REST path under /api/ or /rest/. The helper only reads from vCenter, so requests are sent as GET.";
}

/** Indent serialized XML one element per line, for reading. */
function prettyXml(xml) {
  let depth = 0;
  return xml
    .replace(/>\s*</g, ">\n<")
    .split("\n")
    .map((line) => {
      if (line.startsWith("</")) depth = Math.max(0, depth - 1);
      const out = "  ".repeat(depth) + line;
      const opens = /^<[^!?/][^>]*[^/]>$/.test(line) || /^<[^!?/>]>$/.test(line);
      if (opens && !/<\/[^>]+>$/.test(line)) depth += 1;
      return out;
    })
    .join("\n");
}

async function sendExplorer() {
  const output = $("explorerOutput");
  const mode = $("explorerMode").value;
  const vcenter = $("explorerVcenter").value || null;
  const bodyText = $("explorerBody").value.trim();
  output.textContent = "…";
  try {
    if (mode === "SOAP") {
      const doc = await HelperClient.soap(vcenter, bodyText);
      output.textContent = prettyXml(new XMLSerializer().serializeToString(doc));
      return;
    }
    const data = await HelperClient.call("GET", $("explorerPath").value.trim(), null, vcenter);
    output.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  } catch (err) {
    const extra = err instanceof VcenterError && err.data ? `\n\n${JSON.stringify(err.data, null, 2)}` : "";
    output.textContent = `${err.message}${extra}`;
  }
}

// ---------- wiring ----------

$("refresh").addEventListener("click", refresh);
$("export").addEventListener("click", exportXlsx);
$("downloadHtml").addEventListener("click", () => (state.view === TOPOLOGY ? downloadTopology() : downloadInsights()));

$("filter").addEventListener("input", () => {
  state.page = 1;
  renderBody();
});

$("pageSize").value = String(state.pageSize);
$("pageSize").addEventListener("change", () => {
  state.pageSize = Number($("pageSize").value);
  writePref("pageSize", state.pageSize);
  state.page = 1;
  renderBody();
});
$("pageFirst").addEventListener("click", () => goToPage(1));
$("pagePrev").addEventListener("click", () => goToPage(state.page - 1));
$("pageNext").addEventListener("click", () => goToPage(state.page + 1));
$("pageLast").addEventListener("click", () => goToPage(Number.MAX_SAFE_INTEGER));

$("vcenterSelect").addEventListener("change", () => {
  state.selected = $("vcenterSelect").value;
  writePref("vcenter", state.selected);
  state.rowCounts.clear();
  renderNav();
  load();
});

const impactSearch = $("impactSearch");
impactSearch.addEventListener("focus", () => {
  combo.query = "";
  openCombo(true);
  impactSearch.select();
});
impactSearch.addEventListener("click", () => {
  if (combo.open) return;
  // Clicking a field that already holds the current choice starts a new search,
  // so the whole label is selected: typing replaces it instead of appending to it.
  combo.query = "";
  openCombo(true);
  impactSearch.select();
});
impactSearch.addEventListener("input", () => {
  combo.query = impactSearch.value;
  openCombo(false);
});
impactSearch.addEventListener("blur", () => closeCombo(true));
impactSearch.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (!combo.open) {
      combo.query = "";
      openCombo(true);
    } else {
      moveCombo(event.key === "ArrowDown" ? 1 : -1);
    }
  } else if (event.key === "Enter") {
    if (combo.open && combo.active >= 0) {
      event.preventDefault();
      chooseCombo(combo.matches[combo.active]);
    }
  } else if (event.key === "Escape") {
    if (combo.open) {
      event.stopPropagation();
      closeCombo(true);
    }
  } else if (event.key === "Tab") {
    closeCombo(true);
  }
});

$("explorerMode").addEventListener("change", updateExplorerMode);
$("explorerSend").addEventListener("click", sendExplorer);

$("helperSettings").addEventListener("click", () => {
  $("helperUrl").value = HelperClient.url;
  $("helperDialog").showModal();
});
$("helperDialog").addEventListener("close", () => {
  if ($("helperDialog").returnValue !== "save") return;
  HelperClient.url = $("helperUrl").value.trim() || DEFAULT_HELPER_URL;
  refresh();
});

// While the helper isn't ready, keep checking so the page lights up as soon as it is.
setInterval(async () => {
  if (!state.ready && state.busy === 0 && (await checkHelper()) && state.view !== EXPLORER) load();
}, 5000);

updateExplorerMode();
renderNav();
load();
