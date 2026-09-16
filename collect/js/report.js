// Self-contained HTML topology report: hosts grouped by cluster on the left, datastores
// on the right, lines for each mount. Everything is inlined so the file can be emailed or
// archived. The SVG layout is computed here, so it's complete even with scripting off.
// vCenter names are free text and are HTML-escaped everywhere they appear.

const TopologyReport = (() => {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const gib = (v) => (v === null || v === undefined ? "—" : v >= 1024 ? `${(v / 1024).toFixed(2)} TiB` : `${v.toFixed(1)} GiB`);

  const f1 = (n) => n.toFixed(1);

  function kindClass(kind) {
    const k = String(kind ?? "").toUpperCase();
    if (k.startsWith("VMFS")) return "vmfs";
    if (k.startsWith("NFS")) return "nfs";
    if (k.startsWith("VSAN")) return "vsan";
    if (k.startsWith("VVOL")) return "vvol";
    return "other";
  }

  const HOST_H = 52;
  const HOST_GAP = 12;
  const DS_H = 62;
  const DS_GAP = 12;
  const CLUSTER_PAD = 30;
  const CLUSTER_GAP = 22;
  const NODE_W = 250;
  const COL_GAP = 210;
  const MARGIN = 24;

  function diagram(t) {
    const hostX = MARGIN;
    const dsX = MARGIN + NODE_W + COL_GAP;
    const width = dsX + NODE_W + MARGIN;

    const hostY = new Map();
    let left = "";
    let y = MARGIN + 26;

    const groups = t.clusters.map((c) => [c.name, c.hosts]);
    if (t.standaloneHosts.length) groups.push(["Standalone hosts", t.standaloneHosts]);

    for (const [cluster, hosts] of groups) {
      const inner = hosts.length ? hosts.length * HOST_H + (hosts.length - 1) * HOST_GAP : HOST_H;
      const boxH = inner + CLUSTER_PAD + 14;
      left += `<g class="cluster"><rect x="${f1(hostX - 14)}" y="${f1(y - 24)}" width="${f1(NODE_W + 28)}" height="${f1(boxH)}" rx="8"/>
<text class="cluster-label" x="${f1(hostX - 2)}" y="${f1(y - 7)}">${esc(cluster)}</text></g>`;

      let hy = y + 8;
      for (const host of hosts) {
        const state = host.inMaintenance ? "maint" : host.connectionState === "connected" ? "ok" : "bad";
        const cores = host.cpuCores ?? "—";
        // With memory tiering on, memorySize counts the NVMe tier; the node shows DRAM.
        const detail = host.dramGiB !== null ? `${cores} cores · ${gib(host.dramGiB)} DRAM` : `${cores} cores · ${gib(host.memoryGiB)}`;
        left += `<g class="node host ${state}" data-host="${esc(host.moref)}"><rect x="${f1(hostX)}" y="${f1(hy)}" width="${f1(NODE_W)}" height="${f1(HOST_H)}" rx="6"/>
<circle class="dot" cx="${f1(hostX + 16)}" cy="${f1(hy + HOST_H / 2)}" r="4"/>
<text class="node-title" x="${f1(hostX + 30)}" y="${f1(hy + 21)}">${esc(host.name)}</text>
<text class="node-sub" x="${f1(hostX + 30)}" y="${f1(hy + 38)}">${esc(detail)}</text></g>`;
        hostY.set(host.moref, hy + HOST_H / 2);
        hy += HOST_H + HOST_GAP;
      }
      y += boxH + CLUSTER_GAP;
    }
    const leftHeight = y;

    const dsY = new Map();
    let right = "";
    let dy = MARGIN + 26;
    for (const ds of t.datastores) {
      const cls = kindClass(ds.kind);
      const usedPct = dsUsedPercent(ds) ?? 0;
      const barW = (NODE_W - 32) * Math.min(1, Math.max(0, usedPct / 100));
      const sub = `${ds.kind ?? "—"} · ${gib(ds.freeGiB)} free of ${gib(ds.capacityGiB)}`;
      right += `<g class="node ds ${cls}" data-ds="${esc(ds.moref)}"><rect x="${f1(dsX)}" y="${f1(dy)}" width="${f1(NODE_W)}" height="${f1(DS_H)}" rx="6"/>
<rect class="kind-bar" x="${f1(dsX)}" y="${f1(dy)}" width="5" height="${f1(DS_H)}"/>
<text class="node-title" x="${f1(dsX + 16)}" y="${f1(dy + 20)}">${esc(ds.name)}</text>
<text class="node-sub" x="${f1(dsX + 16)}" y="${f1(dy + 36)}">${esc(sub)}</text>
<rect class="cap-track" x="${f1(dsX + 16)}" y="${f1(dy + 46)}" width="${f1(NODE_W - 32)}" height="5" rx="2.5"/>
<rect class="cap-fill" x="${f1(dsX + 16)}" y="${f1(dy + 46)}" width="${f1(barW)}" height="5" rx="2.5"/></g>`;
      dsY.set(ds.moref, dy + DS_H / 2);
      dy += DS_H + DS_GAP;
    }
    const rightHeight = dy;

    // Links first so nodes paint over them.
    let links = "";
    for (const ds of t.datastores) {
      const y2 = dsY.get(ds.moref);
      const cls = kindClass(ds.kind);
      for (const hostMoref of ds.mountedBy) {
        const y1 = hostY.get(hostMoref);
        // A datastore can be mounted by a host outside this inventory view; skip it.
        if (y1 === undefined) continue;
        const x1 = hostX + NODE_W;
        const x2 = dsX;
        const mid = (x1 + x2) / 2;
        links += `<path class="link ${cls}" data-host="${esc(hostMoref)}" data-ds="${esc(ds.moref)}" d="M${f1(x1)},${f1(y1)} C${f1(mid)},${f1(y1)} ${f1(mid)},${f1(y2)} ${f1(x2)},${f1(y2)}"/>`;
      }
    }

    const height = Math.max(leftHeight, rightHeight) + MARGIN;
    // Explicit width/height: drawn at natural size and only scaled down, never up.
    return `<svg class="topology" width="${width.toFixed(0)}" height="${height.toFixed(0)}" viewBox="0 0 ${width.toFixed(0)} ${height.toFixed(0)}" role="img" aria-label="Host and storage topology">
<text class="col-head" x="${f1(hostX)}" y="18">HOSTS</text>
<text class="col-head" x="${f1(dsX)}" y="18">DATASTORES</text>
<g class="links">${links}</g>${left}${right}</svg>`;
  }

  function datastoreRows(t) {
    const hostName = new Map(allHosts(t).map((h) => [h.moref, h.name]));
    return t.datastores
      .map((ds) => {
        const mounts = ds.mountedBy.map((m) => hostName.get(m) ?? m).sort();
        const pct = dsUsedPercent(ds);
        return `<tr><td>${esc(ds.name)}</td><td><span class="tag ${kindClass(ds.kind)}">${esc(ds.kind ?? "—")}</span></td>
<td class="num">${gib(ds.capacityGiB)}</td><td class="num">${gib(dsUsedGiB(ds))}</td><td class="num">${gib(ds.freeGiB)}</td>
<td class="num">${pct === null ? "—" : `${pct.toFixed(1)}%`}</td><td class="num">${ds.vmCount}</td><td class="num">${ds.mountedBy.length}</td><td class="hosts">${esc(mounts.join(", "))}</td></tr>`;
      })
      .join("");
  }

  function hostRows(t) {
    return allHosts(t)
      .map((h) => {
        const mounted = t.datastores.filter((d) => d.mountedBy.includes(h.moref));
        return `<tr><td>${esc(h.name)}</td><td>${esc(h.cluster ?? "—")}</td><td>${esc(h.inMaintenance ? "maintenance" : h.connectionState ?? "—")}</td><td class="num">${h.cpuCores ?? "—"}</td>
<td class="num">${gib(h.dramGiB)}</td><td class="num">${gib(h.memoryGiB)}</td><td class="num">${mounted.length}</td><td class="hosts">${esc(mounted.map((d) => d.name).join(", "))}</td></tr>`;
      })
      .join("");
  }

  function serverSection(t) {
    const capacity = t.datastores.reduce((n, d) => n + (d.capacityGiB ?? 0), 0);
    const free = t.datastores.reduce((n, d) => n + (d.freeGiB ?? 0), 0);
    return `<section class="server">
<h2>${esc(t.server)}</h2>
<p class="meta">${t.datacenters.length ? esc(t.datacenters.join(", ")) : "no datacenter"} · ${t.clusters.length} clusters · ${allHosts(t).length} hosts · ${t.datastores.length} datastores · ${gib(capacity)} capacity, ${gib(free)} free</p>
<div class="legend">
  <span><i class="swatch vmfs"></i>VMFS</span><span><i class="swatch nfs"></i>NFS</span>
  <span><i class="swatch vsan"></i>vSAN</span><span><i class="swatch vvol"></i>vVol</span>
  <span><i class="swatch other"></i>Other</span>
</div>
<div class="diagram">${diagram(t)}</div>
<h3>Datastores</h3>
<div class="table-wrap"><table>
<thead><tr><th>Datastore</th><th>Type</th><th>Capacity</th><th>Used</th><th>Free</th><th>Used %</th><th>VMs</th><th>Mounts</th><th>Mounted by</th></tr></thead>
<tbody>${datastoreRows(t)}</tbody></table></div>
<h3>Hosts</h3>
<div class="table-wrap"><table>
<thead><tr><th>Host</th><th>Cluster</th><th>State</th><th>Cores</th><th>DRAM</th><th>Memory (incl. tiers)</th><th>Datastores</th><th>Mounted datastores</th></tr></thead>
<tbody>${hostRows(t)}</tbody></table></div>
</section>`;
  }

  const STYLE = `
:root{--bg:#1b2a32;--panel:#22343c;--panel-alt:#1e2f37;--line:#314351;--line-2:#495a63;
--text:#eaedf0;--dim:#adbbc4;--faint:#798d99;--accent:#49afd9;--warn:#f5c348;
--vmfs:#49afd9;--nfs:#60b515;--vsan:#c47bd6;--vvol:#f5c348;--other:#798d99;}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header{padding:22px 28px;border-bottom:1px solid var(--line);background:var(--panel-alt)}
h1{margin:0;font-size:19px;font-weight:600}
header .meta{margin:4px 0 0;color:var(--dim);font-size:12px}
main{padding:24px 28px 48px;max-width:1400px}
section.server{margin-bottom:44px}
h2{font-size:16px;margin:0 0 4px;color:var(--accent)}
h3{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:var(--faint);margin:26px 0 8px}
p.meta{margin:0 0 14px;color:var(--dim);font-size:12px}
.warnings{margin:0 0 20px;padding:10px 14px;border-left:3px solid var(--warn);background:rgba(245,195,72,.1);border-radius:3px}
.warnings ul{margin:6px 0 0;padding-left:18px;color:var(--dim)}
.legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;color:var(--dim);font-size:12px}
.legend span{display:flex;align-items:center;gap:6px}
.swatch{width:10px;height:10px;border-radius:2px;display:inline-block}
.swatch.vmfs{background:var(--vmfs)}.swatch.nfs{background:var(--nfs)}
.swatch.vsan{background:var(--vsan)}.swatch.vvol{background:var(--vvol)}.swatch.other{background:var(--other)}
.diagram{background:var(--panel);border:1px solid var(--line);border-radius:4px;padding:8px;overflow-x:auto;width:fit-content;max-width:100%}
svg.topology{display:block;max-width:100%;height:auto;min-width:640px}
.col-head{fill:var(--faint);font-size:10px;letter-spacing:.09em;font-weight:600}
.cluster rect{fill:rgba(73,175,217,.04);stroke:var(--line-2);stroke-dasharray:3 3}
.cluster-label{fill:var(--dim);font-size:11px;font-weight:600}
.node rect{fill:var(--panel-alt);stroke:var(--line-2)}
.node-title{fill:var(--text);font-size:12.5px;font-weight:600}
.node-sub{fill:var(--faint);font-size:11px}
.host .dot{fill:var(--nfs)}.host.maint .dot{fill:var(--vvol)}.host.bad .dot{fill:#f54f47}
.kind-bar{stroke:none}
.ds.vmfs .kind-bar{fill:var(--vmfs)}.ds.nfs .kind-bar{fill:var(--nfs)}
.ds.vsan .kind-bar{fill:var(--vsan)}.ds.vvol .kind-bar{fill:var(--vvol)}.ds.other .kind-bar{fill:var(--other)}
.cap-track{fill:#16242b}.cap-fill{fill:var(--accent)}
.link{fill:none;stroke-width:1.4;opacity:.42}
.link.vmfs{stroke:var(--vmfs)}.link.nfs{stroke:var(--nfs)}
.link.vsan{stroke:var(--vsan)}.link.vvol{stroke:var(--vvol)}.link.other{stroke:var(--other)}
svg.topology.focus .link{opacity:.08}
svg.topology.focus .link.on{opacity:1;stroke-width:2.4}
svg.topology.focus .node{opacity:.35}
svg.topology.focus .node.on{opacity:1}
.node{cursor:pointer}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:4px;background:var(--panel)}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th,td{padding:7px 12px;text-align:left;border-bottom:1px solid var(--line);white-space:nowrap}
th{background:#17262e;color:var(--dim);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
tbody tr:nth-child(even){background:#1f313a}
td.num{text-align:right;font-variant-numeric:tabular-nums}
td.hosts{white-space:normal;color:var(--dim);min-width:220px}
.tag{padding:1px 7px;border-radius:9px;font-size:11px;font-weight:600;color:#0b1a21}
.tag.vmfs{background:var(--vmfs)}.tag.nfs{background:var(--nfs)}
.tag.vsan{background:var(--vsan)}.tag.vvol{background:var(--vvol)}.tag.other{background:var(--other)}
footer{padding:18px 28px;border-top:1px solid var(--line);color:var(--faint);font-size:11.5px}
main.embedded{padding:16px 20px 32px;max-width:none}
main.embedded .help{margin:0 0 18px;color:var(--faint);font-size:12px}
@media (max-width:760px){main.embedded{padding:12px 16px 24px}}
@media print{body{background:#fff;color:#000}.diagram,.table-wrap{background:#fff}}
`;

  /**
   * Hover highlighting only; the report is complete without it. The downloaded file runs
   * this as an inline script. In the app the report sits in a frame with scripts disabled,
   * and the app calls this on the frame's document instead.
   */
  function attachHover(doc) {
    doc.querySelectorAll("svg.topology").forEach(function (svg) {
      function clear() {
        svg.classList.remove("focus");
        svg.querySelectorAll(".on").forEach(function (el) { el.classList.remove("on"); });
      }
      svg.querySelectorAll(".node").forEach(function (node) {
        node.addEventListener("mouseenter", function () {
          clear();
          var host = node.getAttribute("data-host");
          var ds = node.getAttribute("data-ds");
          var sel = host ? '[data-host="' + host + '"]' : '[data-ds="' + ds + '"]';
          svg.classList.add("focus");
          node.classList.add("on");
          svg.querySelectorAll(".link" + sel).forEach(function (link) {
            link.classList.add("on");
            var other = host ? link.getAttribute("data-ds") : link.getAttribute("data-host");
            var attr = host ? "data-ds" : "data-host";
            var peer = svg.querySelector(".node[" + attr + '="' + other + '"]');
            if (peer) peer.classList.add("on");
          });
        });
        node.addEventListener("mouseleave", clear);
      });
    });
  }

  const SCRIPT = `(${attachHover.toString()})(document);`;

  /**
   * The whole report as an HTML document. `embedded` drops the page header and footer
   * for showing inside the app, where the app's own title bar says what this is.
   */
  function render(topology, version, { embedded = false } = {}) {
    const generated = new Date().toLocaleString();
    const warnings = topology.warnings.length
      ? `<div class="warnings"><strong>${topology.warnings.length} vCenter${topology.warnings.length === 1 ? "" : "s"} could not be queried — this report is incomplete:</strong><ul>${topology.warnings
          .map((w) => `<li>${esc(w)}</li>`)
          .join("")}</ul></div>`
      : "";
    const body = topology.servers.length
      ? topology.servers.map(serverSection).join("")
      : '<p class="meta">No vCenter returned any topology data.</p>';
    const servers = topology.servers.map((s) => esc(s.server)).join(", ") || "No vCenter";
    const help = "Lines connect each host to the datastores it has mounted. Hover a host or datastore to isolate its connections.";

    const page = embedded
      ? `<main class="embedded"><p class="help">${help}</p>${body}</main>`
      : `<header>
  <h1>Host &amp; Storage Topology</h1>
  <p class="meta">${servers} · generated ${esc(generated)} by DBH Insights ${esc(version)}</p>
</header>
<main>${warnings}${body}</main>
<footer>${help}</footer>`;

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DBH Insights Topology Report</title>
<style>${STYLE}</style></head>
<body>
${page}
${embedded ? "" : `<script>${SCRIPT}<\/script>`}
</body></html>`;
  }

  return { render, attachHover };
})();
