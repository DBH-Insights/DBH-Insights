// Release notes, newest first. The landing page renders them, and the app takes its
// version number from the first entry, so this is the one place a release is recorded.
//
// To publish a release, add an entry at the top:
//   version  website version (semantic: major.minor.patch)
//   date     release date, YYYY-MM-DD
//   helper   the DBH Insights Helper version this release needs
//   title    one line that sums the release up
//   changes  { type, text } where type is new | improved | fixed | security | docs.
//            Wrap code and paths in `backticks`; they render as code.
//   images   optional screenshots, shown under the changes:
//            { src, alt, caption, width, height } with src relative to the page (img/…).
//            Give width and height so the page doesn't jump while they load.

const RELEASE_NOTES = [
  {
    version: "0.5.0",
    date: "2026-09-18",
    helper: "0.3.0",
    title: "Totals, group-by summaries, and cluster capacity",
    changes: [
      { type: "new", text: "Every sheet ends with a totals row that follows the filter and covers every page, not just the one on screen. Amounts are summed, usage percentages are averaged, and ratios such as Free % or vCPUs per Core are worked out from the totals rather than averaged." },
      { type: "new", text: "Group by: pick a column — cluster, host, datastore, power state, guest OS, VLAN and more — and each sheet becomes one row per group with a count and totals. Sort, filter and page the groups like any sheet." },
      { type: "new", text: "Cluster Capacity, under Overview: one row per cluster with hosts, cores and DRAM against VM counts, vCPUs, vRAM and storage, the vCPU-to-core ratio, running vRAM as a share of DRAM, and whether the cluster could lose its largest host and still hold its running VMs' memory." },
      { type: "improved", text: "Yes/no columns show how many are True in the totals row, such as how many clusters have HA enabled." },
      { type: "improved", text: "Export XLSX includes the Cluster Capacity sheet." },
    ],
    images: [
      {
        src: "img/release-0.5.0-group-by.jpg",
        width: 2000,
        height: 1194,
        alt: "The vInfo sheet grouped by host: four rows, one per ESXi host, with a count of VMs, CPUs, memory, average CPU and memory usage, provisioned and in-use storage, and a totals row underneath",
        caption: "Group by Host on vInfo: one row per host, with a totals row for all 31 VMs across both vCenters.",
      },
      {
        src: "img/release-0.5.0-cluster-capacity.jpg",
        width: 2000,
        height: 1194,
        alt: "The Cluster Capacity sheet listing three clusters with HA and DRS state, hosts, cores, DRAM, VM counts, vCPUs and the vCPU-to-core ratio, with a totals row",
        caption: "Cluster Capacity: hosts, cores and DRAM against VMs, vCPUs and vRAM, for every cluster at once.",
      },
    ],
  },
  {
    version: "0.4.0",
    date: "2026-09-17",
    helper: "0.3.0",
    title: "A home page, failure-impact answers, and a tidier site",
    changes: [
      { type: "new", text: "A landing page at the site's root explains what DBH Insights does and lists these release notes. The app itself now opens from `app/`." },
      { type: "new", text: "The helper can be downloaded from the site itself: a Download section offers the macOS and Windows installers and points out which one matches the visitor's computer." },
      { type: "new", text: "Impact tab: pick a host or datastore and see the VMs that depend on it, whether vSphere HA could restart them, whether the rest of the cluster has the memory to take them, and any datastore only that host can reach." },
      { type: "new", text: "The Impact picker is searchable. Type to filter hundreds of hosts and datastores by name, cluster or datastore type, and use the arrow keys and Enter to choose." },
      { type: "improved", text: "The DBH Insights name in the app's sidebar now links back to the home page." },
      { type: "improved", text: "Website files are organised into `css/`, `js/` and `img/` folders, with the colour scheme shared through `css/theme.css`." },
      { type: "docs", text: "A copy-and-paste PowerShell guide for building the helper on a new Windows Server." },
      { type: "docs", text: "The README gains screenshots and is brought up to date with every feature." },
    ],
  },
  {
    version: "0.3.0",
    date: "2026-09-15",
    helper: "0.3.0",
    title: "The full inventory: 27 sheets and performance data",
    changes: [
      { type: "new", text: "19 more sheets, for 27 in all: vCPU, vMemory, vPartition, vCD, vUSB, vTools, vRP, vHBA, vNIC, vSwitch, vPort, vSC_VMK, dvSwitch, dvPort, vHost Performance, vInfo Performance, vSource, vLicense and vMetaData." },
      { type: "new", text: "Performance sheets show the newest CPU, memory, network and disk sample for every host and powered-on VM." },
      { type: "new", text: "Helper 0.3.0 allows vCenter's three read-only performance queries, which the performance sheets need." },
      { type: "improved", text: "The sidebar groups sheets the way vSphere does: Inventory, Virtual machines, Host network & storage, Distributed switch, Performance, Health and System." },
      { type: "improved", text: "Export XLSX includes all 27 sheets in one workbook." },
      { type: "fixed", text: "vPort shows a port group's security settings even when they're inherited from the switch." },
    ],
  },
  {
    version: "0.2.0",
    date: "2026-09-14",
    helper: "0.2.0",
    title: "REST and SOAP, a new look, and a read-only, hardened helper",
    changes: [
      { type: "new", text: "Data comes from both vCenter APIs: REST, plus read-only SOAP for host hardware, snapshots and health details that REST doesn't provide." },
      { type: "new", text: "A redesigned app in VMware's Clarity dark style, with the Insights dashboard and sortable, filterable sheets: vInfo, vDisk, vNetwork, vSnapshot, vHost, vCluster, vDatastore and vHealth." },
      { type: "new", text: "Export XLSX builds a formatted Excel workbook in the browser." },
      { type: "new", text: "Topology tab: hosts by cluster, their datastores, and a line for every mount. Hover to isolate one." },
      { type: "new", text: "Download HTML saves the Insights dashboard or the topology as a standalone file." },
      { type: "new", text: "Paging, with 5, 10, 25, 50, 100, 250, 500 or all rows per page." },
      { type: "improved", text: "The product is now called DBH Insights, and the helper has a new icon: DBH and Insights on orange." },
      { type: "improved", text: "`https://dbh-insights.github.io` is allowed by the helper out of the box." },
      { type: "improved", text: "The helper window sizes itself so every field is visible when it opens." },
      { type: "security", text: "The helper only reads from vCenter. REST requests are GET only, SOAP is limited to read-only operations, and no setting turns writes on." },
      { type: "security", text: "Pages opened from a local file need an explicit opt-in in the helper, instead of trusting the `null` origin that any website can send." },
      { type: "fixed", text: "Changing the helper's port takes effect straight away." },
      { type: "fixed", text: "Mac builds are signed as a whole app, so other Macs no longer report them as damaged." },
    ],
  },
  {
    version: "0.1.0",
    date: "2026-09-13",
    helper: "0.1.0",
    title: "First version",
    changes: [
      { type: "new", text: "DBH Insights Helper, a small desktop app for macOS, Windows and Linux that lives in the tray, keeps vCenter passwords in the operating system's keychain, and passes the website's requests to vCenter from `127.0.0.1`." },
      { type: "new", text: "Add, edit, test and delete any number of vCenters." },
      { type: "new", text: "A web page that lists your VMs with power state, vCPUs and memory." },
      { type: "new", text: "API Explorer for trying vCenter REST requests through the helper." },
    ],
  },
];
