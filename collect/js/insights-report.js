// Self-contained HTML copy of the Insights dashboard, for emailing or archiving.
//
// Built from the dashboard already rendered in the page, so the file always matches what's
// on screen. That DOM is created with textContent only, and serializing it escapes text and
// attributes, so vCenter names can't inject markup. Styles are inlined; no scripts are needed.

const InsightsReport = (() => {
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const STYLE = `
:root{--app-bg:#1b2a32;--surface:#22343c;--surface-alt:#1e2f37;--border:#314351;--border-strong:#495a63;
--text:#eaedf0;--text-dim:#adbbc4;--text-faint:#798d99;--accent:#49afd9;--success:#60b515;--warning:#f5c348;--danger:#f54f47}
*{box-sizing:border-box}
body{margin:0;background:var(--app-bg);color:var(--text);
font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
header{padding:22px 28px;border-bottom:1px solid var(--border);background:var(--surface-alt)}
h1{margin:0;font-size:19px;font-weight:600}
header .meta{margin:4px 0 0;color:var(--text-dim);font-size:12px}
main{padding:20px 28px 40px;max-width:1400px}
footer{padding:16px 28px;border-top:1px solid var(--border);color:var(--text-faint);font-size:11.5px}
.warnings{margin:0 0 16px;padding:10px 14px;border-left:3px solid var(--warning);background:rgba(245,195,72,.1);border-radius:3px}
.warnings ul{margin:6px 0 0;padding-left:18px;color:var(--text-dim)}
.dashboard{display:flex;flex-direction:column;gap:14px}
.kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:4px;padding:14px 16px}
.card-title{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--text-faint);margin:0 0 10px}
.kpi{position:relative;padding-left:18px}
.kpi::before{content:"";position:absolute;left:0;top:14px;bottom:14px;width:3px;border-radius:2px;background:var(--accent)}
.kpi.muted::before{background:var(--border-strong)}
.kpi-value{font-size:30px;font-weight:300;line-height:1.05;font-variant-numeric:tabular-nums}
.kpi-label{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:var(--text-faint);margin:0 0 8px}
.kpi-sub{font-size:11.5px;color:var(--text-dim);margin-top:6px}
.panel-row{display:grid;grid-template-columns:minmax(260px,340px) 1fr;gap:14px;align-items:start}
@media (max-width:1000px){.panel-row{grid-template-columns:1fr}}
.gauge-wrap{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.gauge{flex:none}
.gauge-track{fill:none;stroke:var(--app-bg);stroke-width:13}
.gauge-fill{fill:none;stroke:var(--accent);stroke-width:13;stroke-linecap:round}
.gauge-pct{fill:var(--text);font-size:21px;font-weight:300;text-anchor:middle}
.gauge-cap{fill:var(--text-faint);font-size:8.5px;text-anchor:middle;letter-spacing:.08em}
.stat-list{display:flex;flex-direction:column;gap:9px;flex:1;min-width:140px}
.stat{display:flex;justify-content:space-between;gap:12px;font-size:12.5px}
.stat .k{color:var(--text-dim)}
.stat .v{font-variant-numeric:tabular-nums}
.bars{display:flex;flex-direction:column;gap:11px}
.bar-row{display:grid;grid-template-columns:1fr auto;gap:4px 12px;font-size:12.5px}
.bar-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-val{color:var(--text-dim);font-variant-numeric:tabular-nums}
.bar-track{grid-column:1/-1;height:6px;background:var(--app-bg);border-radius:3px;overflow:hidden}
.bar-fill{height:100%;border-radius:3px;background:var(--accent)}
.bar-fill.warn{background:var(--warning)}.bar-fill.crit{background:var(--danger)}
.bar-fill.nfs{background:var(--success)}.bar-fill.vmfs{background:var(--accent)}
.mini-wrap{overflow-x:auto}
.mini-table{width:100%;border-collapse:collapse;font-size:12.5px}
.mini-table th{text-align:left;font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--text-faint);font-weight:600;padding:0 10px 7px 0;border-bottom:1px solid var(--border)}
.mini-table td{padding:7px 10px 7px 0;border-bottom:1px solid var(--border)}
.mini-table .num{text-align:right;font-variant-numeric:tabular-nums}
.mini-table tr:last-child td{border-bottom:0}
.empty-note{color:var(--text-faint);margin:0}
@media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;

  /** The dashboard as a standalone HTML document. `dashboardNode` is the rendered #dashboard. */
  function render(insights, dashboardNode, version) {
    const board = dashboardNode.cloneNode(true);
    board.removeAttribute("id");
    board.removeAttribute("hidden");
    board.className = "dashboard";

    const generated = new Date().toLocaleString();
    const servers = insights.servers.map(esc).join(", ") || "No vCenter";
    const warnings = insights.warnings.length
      ? `<div class="warnings"><strong>${insights.warnings.length} vCenter${insights.warnings.length === 1 ? "" : "s"} could not be queried — these numbers are incomplete:</strong><ul>${insights.warnings
          .map((w) => `<li>${esc(w)}</li>`)
          .join("")}</ul></div>`
      : "";

    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>DBH Insights Report</title>
<style>${STYLE}</style></head>
<body>
<header>
  <h1>Insights</h1>
  <p class="meta">${servers} · generated ${esc(generated)} by DBH Insights ${esc(version)}</p>
</header>
<main>${warnings}${board.outerHTML}</main>
<footer>Storage figures are summed across all datastores. Physical memory counts DRAM only; hosts with memory tiering also report the tier separately.</footer>
</body></html>`;
  }

  return { render };
})();
