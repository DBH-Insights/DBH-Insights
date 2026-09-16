# DBH Insights

A vCenter inventory website that anyone can open, backed by a small helper app each user runs on their own machine.

```
 Browser (your hosted website)          User's machine                  Local network
 ┌──────────────────────────┐   fetch   ┌─────────────────────┐  HTTPS  ┌──────────┐
 │ collect/ UI, sheets, all │ ────────▶ │ helper/  Tauri+Rust │ ──────▶ │ vCenter  │
 │ REST + SOAP query logic  │ ◀──────── │ 127.0.0.1:8765      │ ◀────── │ REST+SOAP│
 │ (updates instantly)      │           │ creds in OS keychain│         │ (self-   │
 └──────────────────────────┘           └─────────────────────┘         │  signed) │
                                                                        └──────────┘
```

- **`collect/`**: the website — a folder in this repository, not a part of any URL. Its *contents* are what you publish; the live site serves them at its root. Plain HTML/JS, no build step. Every vCenter query is defined here, so new sheets, columns, and layouts ship by redeploying the site.
- **`helper/`**: the desktop helper. It has a settings window where you add, edit, test, and delete any number of vCenters, lives in the system tray, and exposes a pass-through on `127.0.0.1` for vCenter's REST API and read-only SOAP (vim25) queries. It accepts vCenter's self-signed certificate and holds the vCenter sessions. Credentials never reach the website's server.

## Screenshots

**Insights** — the headline numbers for every selected vCenter: hosts, cores, storage, VMs, memory and the vCPU-to-core ratio, with storage utilisation, capacity by datastore type, the fullest datastores and a cluster table.

![The Insights dashboard, showing KPI cards, a storage gauge, capacity bars and a cluster table](Screen-Shots/Insights.png)

**Topology** — every host and the datastores it mounts, grouped by cluster, with a line per mount and tables of datastores and hosts underneath.

![The Topology tab: hosts on the left, datastores on the right, curved lines for each mount](Screen-Shots/Topology.png)

**Impact** — what depends on one host or datastore. Here `esx9-01.vcrocs.local` carries 16 VMs, HA is off on its cluster, and one datastore is mounted by that host alone.

![The Impact tab assessing a host failure: a red verdict, four KPI cards, the VMs on the host, and the datastore only it can reach](Screen-Shots/Impact.png)

**Sheets** — sortable, filterable and paged. `vInfo` is one row per VM across both vCenters.

![The vInfo sheet, 31 rows across two vCenters, with paging at the bottom](Screen-Shots/vInfo.png)

`vHost` is one row per ESXi host, including CPU model, cores, threads and memory tiering.

![The vHost sheet, four hosts with hardware and usage columns](Screen-Shots/vHost.png)

**The helper** — where vCenters are added, tested and removed, and where the allowed websites and local port are set. Passwords go to the OS keychain, never to the website.

![The DBH Insights Helper window: two vCenters with Test, Edit and Delete buttons, the allowed-websites list, the local-file switch and the port](Screen-Shots/Insight-Helper.png)

## What the website does

- **Insights dashboard:** hosts, cores, storage, VMs, physical memory, the vCPU-to-core ratio, storage utilisation, capacity by datastore type, fullest datastores, and clusters. **Download HTML** saves the dashboard as a self-contained file.
- **Sheets:** 27 of them, grouped in the sidebar the way the vSphere inventory is:

  | Group | Sheet | Rows | Source |
  |---|---|---|---|
  | Inventory | vHost | one per ESXi host | SOAP |
  | Inventory | vCluster | one per cluster | SOAP, plus REST for HA and DRS |
  | Inventory | vRP | one per resource pool | SOAP |
  | Inventory | vDatastore | one per datastore | SOAP |
  | Virtual machines | vInfo | one per VM | SOAP |
  | Virtual machines | vCPU | CPU sizing, shares and usage per VM | SOAP |
  | Virtual machines | vMemory | memory sizing, shares and usage per VM | SOAP |
  | Virtual machines | vDisk | one per virtual disk | SOAP |
  | Virtual machines | vPartition | one per guest filesystem (needs VMware Tools) | SOAP |
  | Virtual machines | vNetwork | one per virtual NIC | SOAP, plus REST for network names |
  | Virtual machines | vSnapshot | one per snapshot | SOAP |
  | Virtual machines | vCD | one per CD/DVD drive | SOAP |
  | Virtual machines | vUSB | USB controllers and devices | SOAP |
  | Virtual machines | vTools | VMware Tools status per VM | SOAP |
  | Host network & storage | vHBA | one per host bus adapter | SOAP |
  | Host network & storage | vNIC | one per physical host NIC | SOAP |
  | Host network & storage | vSwitch | standard switches | SOAP |
  | Host network & storage | vPort | standard switch port groups | SOAP |
  | Host network & storage | vSC_VMK | VMkernel ports | SOAP |
  | Distributed switch | dvSwitch | distributed switches | SOAP |
  | Distributed switch | dvPort | distributed port groups | SOAP |
  | Performance | vHost Performance | newest CPU, memory, network and disk sample per host | SOAP (QueryPerf) |
  | Performance | vInfo Performance | newest sample per powered-on VM | SOAP (QueryPerf) |
  | Health | vHealth | one per finding: NTP, NTPD, folder name, connected CD-ROM, active snapshot | SOAP |
  | System | vSource | vCenter version details | SOAP |
  | System | vLicense | licences and their usage | SOAP |
  | System | vMetaData | what collected the data, when, and from where | SOAP |

  Sheets have sorting, filtering, and **paging** with a choice of 5, 10, 25 (the default), 50, 100, 250, 500 or all rows per page.
- **Multiple vCenters:** choose "All vCenters" or one. Every sheet gets a `VI SDK Server` column, and a vCenter that fails shows a warning while the others still load.
- **Export XLSX:** every sheet in one workbook (Verdana 9pt, black header row, frozen first row and column, AutoFilter, real dates), in the inventory tool's sheet order. Built in the browser.
- **Topology tab:** hosts grouped by cluster, datastores, and a line for each host-to-datastore mount (hover to isolate one), plus datastore and host tables. It renders in the page in a sandboxed frame. **Download HTML** saves the same report as a self-contained file for emailing or archiving.
- **Impact tab:** search for one host or datastore and see what depends on it: the VMs registered on it or stored on it, whether vSphere HA could restart them, whether the remaining hosts in the cluster have the memory to take them, and any datastore only that one host mounts. The picker filters as you type — on name, cluster or datastore type — so an estate with hundreds of hosts stays usable, and the whole tab answers from data already loaded, with no extra vCenter queries.
- **API Explorer:** send a REST GET or a read-only SOAP operation through the helper, to see a response before building a sheet on it.

The sidebar runs **Overview** (Insights, Topology, Impact), then the sheet groups in the order above, then **Tools** (API Explorer). Sheets show their row count next to the name once they've been opened.

Queries are cached per vCenter, so switching sheets doesn't query vCenter again. **Refresh** fetches fresh data.

## Run the helper (development)

Prerequisites: Rust (stable) and Node 18+. On Linux, also install the [Tauri system packages](https://v2.tauri.app/start/prerequisites/#linux) plus `libayatana-appindicator3-dev` for the tray icon.

```bash
cd helper
npm install
npm run dev
```

The first time it runs with no settings, the window opens. Click **Add vCenter**, enter the details, and click **Save & test**; the test checks both the REST and SOAP logins. Repeat for each vCenter; every entry has **Test**, **Edit**, and **Delete** buttons. Closing the window leaves the helper running in the tray. Use the tray menu to reopen settings or quit. Quitting logs out of every vCenter session.

General settings hold the websites allowed to use the helper, the local-file switch, and the port. Saving a new port moves the listener straight away — the new port is opened before the old one is dropped, so a port already in use leaves the helper where it was.

Where things are stored:

| What | Where |
|---|---|
| Settings (vCenters, allowed websites, port) | `config.json` in the OS app-config dir (e.g. `~/Library/Application Support/dev.dbhinsights.helper/` on macOS) |
| Password | OS keychain: macOS Keychain, Windows Credential Manager, Linux Secret Service. Service `dbh-insights-helper`, one account per vCenter login (`user@host`) |

## Run the website (development)

```bash
python3 -m http.server 5500 --bind 127.0.0.1
```

Run that from the project root, then open http://localhost:5500/collect/ — the `/collect/` there is just the local folder you're serving from, and the published site has no such path. The helper allows `https://dbh-insights.github.io`, `http://localhost:5500` and `http://127.0.0.1:5500` by default. The website needs helper 0.3.0 or later (for SOAP and performance counters) and says so if an older helper is running.

## Build installers

```bash
cd helper
npm run build
```

Output goes to `helper/src-tauri/target/release/bundle/`: `.dmg`/`.app` on macOS, `.msi`/`.exe` on Windows, `.deb`/`.rpm`/`.AppImage` on Linux. Tauri can't cross-compile installers, so build on each OS, or use a GitHub Actions matrix with [`tauri-apps/tauri-action`](https://github.com/tauri-apps/tauri-action). Unsigned builds will trigger Gatekeeper/SmartScreen warnings; sign them before handing them out widely.

### Build the Windows app

[`helper/BUILD-WINDOWS.md`](helper/BUILD-WINDOWS.md) walks a fresh Windows Server from nothing to `dbh-insights-helper.exe` and a setup installer, with every step as a PowerShell block to paste. In short, once the C++ build tools, Rust, Node.js and Git are installed:

```powershell
cd helper
npm ci
npm run build -- --bundles nsis
```

### Build the Mac app

```bash
cd helper
npm run build:mac
```

Use `build:mac` rather than `build`. It puts the build output in `~/Library/Caches/dbh-insights-helper-build` instead of the project folder. If the project lives in an iCloud-synced folder (like `~/Documents` with Desktop & Documents sync on), iCloud adds a Finder attribute to the app after it's signed, which breaks the signature and makes other Macs report the app as damaged.

The app and disk image end up in `~/Library/Caches/dbh-insights-helper-build/release/bundle/` (`macos/` and `dmg/`). Builds are Apple Silicon only unless you add `-- --target universal-apple-darwin`.

## Installing the helper on another Mac

Mac builds are ad-hoc signed (`bundle.macOS.signingIdentity` is `"-"` in `tauri.conf.json`), not signed with an Apple Developer ID. Copy **DBH Insights Helper.app** into **Applications**, then open it. The first time, macOS may block it:

- **"Apple could not verify… is free of malware"** or **"can't be verified"**: click **Done**, open **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
- **"DBH Insights Helper is damaged and can't be opened. You should move it to the Trash"**: the app isn't actually damaged; macOS quarantined it when it was downloaded or copied. Don't move it to the Trash. Instead, run this once in Terminal, then open the app again:

  ```bash
  xattr -dr com.apple.quarantine "/Applications/DBH Insights Helper.app"
  ```

  This removes only the quarantine flag macOS added to the copied app.

For a public release, sign with a Developer ID and notarize (set `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` before `npm run build:mac`) so the app opens with no warning at all.

The app icon (white DBH with Insights underneath, on orange) is drawn in `helper/icon-source.svg`. Every letter is an outline, not text, so it renders the same without the font installed. To change it, edit the SVG, then regenerate the PNG and every icon size:

```bash
cd helper
rsvg-convert -w 1024 -h 1024 icon-source.svg -o icon-source.png
npm run icons
```

`npm run icons` also creates Android and iOS icons under `src-tauri/icons/`; they aren't used, so you can delete those folders.

## Deploy the website

Copy the **contents** of `collect/` — `index.html` plus the `css/` and `js/` folders, not `collect/` itself — to wherever you serve from. `collect/` is this repository's source folder; it never has to appear in a URL. The published site lives in the `dbh-insights.github.io` repository, whose root is the web root, so it serves the files at `https://dbh-insights.github.io/` with no `/collect/` in the address, and that origin is allowed by the helper out of the box.

The files are static and reference each other with relative links, so they work equally well one level down — `https://example.com/insights/`, say — as long as you link to the URL with its trailing slash; most servers redirect `/insights` to `/insights/` automatically. Any static host works: GitHub Pages, Netlify, S3, IIS, nginx. If you publish to an origin of your own, each user adds it (for example `https://insights.example.com`, with no trailing path) under **Websites allowed to use this helper**. Until they do, the site shows exactly what to add.

## Website code

```
collect/
├── index.html      the page (stays at the top: it's what the site's URL loads)
├── css/            styles
└── js/             scripts, loaded in order by index.html
```

Links between them are relative (`js/app.js`, not `/js/app.js`), so the folder works at a site's root or one level down. The scripts share functions as globals, so their order in `index.html` matters: `app.js` loads last.

| File | Purpose |
|---|---|
| `index.html` | Page markup: sidebar, toolbar, and one section per kind of view |
| `css/styles.css` | Dark theme, tables, dashboard cards, topology frame, impact picker |
| `js/helper-client.js` | Calls the helper: `status()`, `call()` for REST, `soap()` for SOAP, `forVcenter(id)` to bind both to one vCenter |
| `js/vim.js` | vim25 querying: `retrieve()` over a ContainerView (following continuation tokens), `retrieveObject()` for a known managed object, `serviceContent()`, `perfCounterIds()` and `queryPerf()` |
| `js/sheets.js` | `VcenterData` (cached per-vCenter queries) and the `SHEETS` definitions |
| `js/insights.js` | Topology (hosts, clusters, datastore mounts) and the dashboard rollup |
| `js/impact.js` | Impact: the fabric of hosts, datastores and VMs, and the host/datastore failure answers built from it |
| `js/xlsx.js` | Dependency-free .xlsx writer |
| `js/report.js` | Topology report HTML |
| `js/insights-report.js` | Insights dashboard as a standalone HTML file |
| `js/app.js` | UI: navigation, tables and paging, dashboard, impact picker and panels, export, explorer |

## Adding a sheet

Add an entry to `SHEETS` in `collect/js/sheets.js`:

```js
{
  name: "vRP",
  group: "Inventory",
  columns: [col.text("Resource Pool name"), col.number("CPU limit"), col.text("Status")],
  async rows(d) {
    const pools = await retrieve(d.api, "ResourcePool", ["name", "config.cpuAllocation.limit", "overallStatus"]);
    return pools.map((p) => [p.str("name"), p.num("config.cpuAllocation.limit"), p.str("overallStatus")]);
  },
}
```

`group` decides which sidebar heading the sheet appears under; the order of the headings is `GROUP_ORDER` in `collect/js/app.js`, and a group that isn't listed there appears after the known ones rather than vanishing.

`rows(d)` runs once per selected vCenter. `d.api` is bound to that vCenter (`get`, `call`, `soap`), and `d` also offers shared cached queries — `vmInventory()`, `vmDevices()`, `hosts()`, `clusters()`, `datastores()`, `datacenters()`, `resourcePools()`, `dvSwitches()`, `dvPortgroups()`, `serviceContent()`, `licenses()`, `perfCounters()`, `perfSamples()`, `restClusters()`, `restNetworks()`, plus the rollups `hostNames()`, `vmTotalsByHost()` and `vmsByMoref()`. Reuse those rather than querying the same objects again. The `VI SDK Server` column, multi-vCenter merging, sorting, paging, filtering, and the XLSX export all pick the new sheet up automatically.

Look at a response in the **API Explorer** first. In vim25 SOAP responses, members of a top-level array property are named after the declared type (`<VirtualDevice xsi:type="VirtualDisk">`), not the field name. Use `ManagedObject.array()` and `xsiType()` rather than element names.

## Helper API

`GET /status`
```json
{ "helper": "dbh-insights-helper", "version": "0.3.0", "originAllowed": true,
  "configured": true, "capabilities": ["rest", "soap", "perf"],
  "vcenters": [
    { "id": "vc-1a2b3c", "name": "Lab", "host": "vcsa.lab.local", "username": "administrator@vsphere.local" }
  ] }
```

`POST /proxy` (REST) with `Content-Type: application/json`
```json
{ "vcenter": "vc-1a2b3c", "method": "GET", "path": "/api/vcenter/vm?power_states=POWERED_ON" }
```

`POST /soap` (read-only vim25) with `Content-Type: application/json`
```json
{ "vcenter": "vc-1a2b3c",
  "body": "<vim25:RetrieveServiceContent><vim25:_this type=\"ServiceInstance\">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>" }
```
The helper wraps `body` in a SOAP envelope, adds its session cookie (logging in again if the session expired), and returns vCenter's XML. The `vim25`, `xsi`, and `soapenv` prefixes are declared by the envelope.

`vcenter` is the id from `/status`. You can leave it out when only one vCenter is configured, and `method` can be left out too — it defaults to `GET`, the only method the helper passes through. vCenter's status code and body are returned unchanged. Errors raised by the helper itself carry an `X-Helper-Error` header and look like `{"error":{"kind":"...","message":"..."}}`. The possible kinds are `origin_not_allowed`, `not_configured`, `vcenter_required`, `unknown_vcenter`, `vcenter_auth_failed`, `vcenter_unreachable`, `read_only`, `bad_path`, `soap_not_allowed`, `bad_request`, and `forbidden_host`.

Try it with curl (requests with no `Origin` header, which means local tools, are allowed):

```bash
curl -s -H 'Content-Type: application/json' -d '{"path":"/api/vcenter/vm"}' http://127.0.0.1:8765/proxy
```

## Security model

- The helper listens on **127.0.0.1 only** and rejects requests whose `Host` isn't `127.0.0.1` or `localhost`, which blocks DNS-rebinding attacks.
- **Origin allowlist.** Any web page can reach localhost, so only websites the user has listed can use `/proxy` and `/soap`. Other sites see only `originAllowed: false`.
- **Local files are off by default.** A page opened from a file (`file://`) reaches the helper with the origin `null`, which any website can also produce from a sandboxed frame. So `null` can't be added to the websites list; instead the helper has a separate **Allow the website when opened from a local file** setting. While it's on, any page could use the helper, so turn it on only while you need it, or serve `collect/` with a local web server.
- **REST is read-only.** The helper only pulls data: it passes GET requests through and refuses POST, PUT, PATCH, and DELETE. There's no setting to allow writes.
- **REST path rules.** Only `/api/…` and `/rest/…` are allowed, the session endpoints are blocked so a page can't read or revoke the helper's token, and paths carrying `..`, `//`, `\\`, `@`, `#` or non-printable characters are refused.
- **SOAP is always read-only.** The body is parsed as XML and must be exactly one of `RetrieveServiceContent`, `RetrievePropertiesEx`, `ContinueRetrievePropertiesEx`, `CancelRetrievePropertiesEx`, `CreateContainerView`, `DestroyView`, `QueryPerf`, `QueryPerfProviderSummary`, or `QueryAvailablePerfMetric`. Login, Logout, and anything that changes vCenter are refused; so are DOCTYPEs, a second operation, and attempts to close the envelope.
- **Session hygiene.** vCenter keeps abandoned sessions for about 30 minutes, so the helper logs out of REST and SOAP when a vCenter is edited, deleted, or re-tested, and when the helper quits.
- The password stays in the OS keychain. It is never written to disk or returned to the settings window or the website. It's XML-escaped when sent in the SOAP login.
- The website never renders vCenter text with `innerHTML`, so VM names and annotations can't inject script.

## Browser notes

- **Chrome/Edge**: calls from a public site to localhost go through Private Network Access / Local Network Access. The helper sends the required `Access-Control-Allow-Private-Network` preflight header. Newer Chrome versions also show a one-time "access devices on your local network" prompt, which the user should allow.
- **Firefox**: works; `http://127.0.0.1` counts as a secure context, so an `https://` site can call it.
- **Safari**: WebKit has historically blocked `https://` pages from calling `http://127.0.0.1` as mixed content. Test on your Safari version. If it's blocked, Safari users need a Chromium browser or Firefox, or the helper needs a locally trusted certificate.

## Requirements and limits

- vCenter 7.0 U2 or later, because the helper uses the `/api/session` REST API.
- vCLS VMs are excluded everywhere, matching the vSphere UI. VM templates are included in vInfo (flagged in the Template column); the REST VM list leaves them out, so REST and vInfo counts can differ by the number of templates.
- Performance sheets read the newest sample from vCenter's real-time (20-second) interval, so a VM that is powered off reports nothing. They need helper 0.3.0 or later.
- The Impact tab's capacity verdict compares the memory *assigned* to the VMs that would restart against the DRAM of the remaining connected hosts, which is what HA admission control reasons about — not live consumption, and not CPU.
- Not implemented: datastore file browsing (zombie VMDK detection, vFileInfo) and multipath details, which use different vCenter API areas.
