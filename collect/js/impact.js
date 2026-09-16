// Impact ("what depends on this?"): what stops working if one host or one datastore fails.
//
// Nothing new is queried. Hosts, clusters, datastores and VMs are already cached for the
// sheets; this file joins them into a fabric (host → VMs, datastore → VMs and mounts) and
// answers one question at a time against it.
//
// Capacity verdicts use *assigned* memory, which is what an HA restart admits against —
// not live consumption. They are stated as estimates on screen for that reason.

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });

/** Powered-on VMs first, then by name: the ones that actually stop are read first. */
function vmOrder(a, b) {
  const on = (v) => (v.powerState === "poweredOn" && !v.template ? 0 : 1);
  return on(a) - on(b) || byName(a, b);
}

const isRunning = (vm) => vm.powerState === "poweredOn" && !vm.template;
const sumBy = (list, fn) => round2(list.reduce((n, item) => n + (fn(item) ?? 0), 0));

/** One vCenter as a graph of hosts, clusters, datastores and the VMs that tie them together. */
async function fetchFabric(d) {
  const [hostObjects, clusterObjects, datastoreObjects, vmObjects, restClusters] = await Promise.all([
    d.hosts(),
    d.clusters(),
    d.datastores(),
    d.vmInventory(),
    // HA and DRS flags come from REST. Without them the verdict says "unknown" rather than failing.
    d.restClusters().catch(() => null),
  ]);
  const restById = new Map((restClusters ?? []).map((c) => [c.cluster, c]));

  const hosts = new Map();
  for (const h of hostObjects) {
    const name = h.str("name");
    if (!name) throw new Error(`HostSystem ${h.moref} returned no name property`);
    hosts.set(h.moref, {
      moref: h.moref,
      name,
      cluster: null,
      clusterMoref: null,
      connectionState: h.str("runtime.connectionState"),
      inMaintenance: h.bool("runtime.inMaintenanceMode") ?? false,
      cores: h.num("summary.hardware.numCpuCores"),
      // DRAM, not the tiered total: a restart needs real memory.
      memoryGiB: bytesToGiB(memoryTierBytes(h, "DRAM") ?? h.num("summary.hardware.memorySize")),
      vms: [],
      datastores: [],
    });
  }

  const clusters = new Map();
  for (const c of clusterObjects) {
    const name = c.str("name") ?? c.moref;
    const members = c.array("host").map((m) => m.textContent).filter((ref) => hosts.has(ref));
    for (const ref of members) {
      hosts.get(ref).cluster = name;
      hosts.get(ref).clusterMoref = c.moref;
    }
    const info = restById.get(c.moref);
    clusters.set(c.moref, {
      name,
      hosts: members.map((ref) => hosts.get(ref)),
      haEnabled: info ? Boolean(info.ha_enabled) : null,
      drsEnabled: info ? Boolean(info.drs_enabled) : null,
    });
  }

  // vCLS VMs are vSphere's own agents; they are excluded here as they are on every sheet.
  const vms = new Map();
  for (const vm of vmObjects) {
    const name = vm.str("name");
    if (!name || isVcls(name)) continue;
    const entry = {
      moref: vm.moref,
      name,
      powerState: vm.str("runtime.powerState"),
      template: vm.bool("config.template") ?? false,
      vcpu: vm.num("config.hardware.numCPU") ?? 0,
      memoryGiB: round2((vm.num("config.hardware.memoryMB") ?? 0) / 1024),
      host: null,
      datastores: [],
    };
    vms.set(vm.moref, entry);
    const host = hosts.get(vm.str("runtime.host"));
    if (host) {
      entry.host = host;
      host.vms.push(entry);
    }
  }

  const datastores = datastoreObjects
    .map((ds) => {
      const capacityGiB = bytesToGiB(ds.num("summary.capacity"));
      const freeGiB = bytesToGiB(ds.num("summary.freeSpace"));
      const entry = {
        moref: ds.moref,
        name: ds.str("name") ?? ds.moref,
        kind: ds.str("summary.type"),
        capacityGiB,
        freeGiB,
        usedGiB: capacityGiB !== null && freeGiB !== null ? round2(capacityGiB - freeGiB) : null,
        accessible: ds.bool("summary.accessible"),
        hosts: [],
        vms: [],
      };
      for (const mount of ds.array("host")) {
        const host = hosts.get(textAt(mount, "key"));
        if (host) {
          entry.hosts.push(host);
          host.datastores.push(entry);
        }
      }
      // A VM is listed on every datastore holding any of its files, so this catches split VMs.
      for (const ref of ds.array("vm")) {
        const vm = vms.get(ref.textContent);
        if (vm) {
          entry.vms.push(vm);
          vm.datastores.push(entry);
        }
      }
      return entry;
    })
    .sort(byName);

  return { server: d.vc.name, hosts: [...hosts.values()].sort(byName), clusters, datastores };
}

/** The fabric of every selected vCenter. An unreachable one yields a warning, not an empty tab. */
async function buildFabric(dataList) {
  const results = await Promise.allSettled(dataList.map(fetchFabric));
  const fabric = { servers: [], warnings: [] };
  results.forEach((r, i) => {
    if (r.status === "fulfilled") fabric.servers.push(r.value);
    else fabric.warnings.push(`${dataList[i].vc.name}: ${r.reason?.message ?? r.reason}`);
  });
  return fabric;
}

// ---------- the two questions ----------

/** What a single host failing would take with it. */
function hostImpact(server, host) {
  const cluster = host.clusterMoref ? server.clusters.get(host.clusterMoref) : null;
  const vms = [...host.vms].sort(vmOrder);
  const running = vms.filter(isRunning);
  const templates = vms.filter((v) => v.template);
  const needMemoryGiB = sumBy(running, (v) => v.memoryGiB);
  const needVcpus = running.reduce((n, v) => n + v.vcpu, 0);

  // Hosts that could take the load: same cluster, connected, not already in maintenance.
  const siblings = (cluster?.hosts ?? []).filter((h) => h.moref !== host.moref);
  const survivors = siblings.filter((h) => h.connectionState === "connected" && !h.inMaintenance);
  const survivorMemoryGiB = sumBy(survivors, (h) => h.memoryGiB);
  const survivorCores = survivors.reduce((n, h) => n + (h.cores ?? 0), 0);
  const committedGiB = sumBy(survivors, (h) => sumBy(h.vms.filter(isRunning), (v) => v.memoryGiB));
  const headroomGiB = round2(survivorMemoryGiB - committedGiB);
  const fits = survivors.length > 0 && headroomGiB >= needMemoryGiB;

  // Storage only this host presents: local disks, or a LUN nobody else has mounted.
  const lostDatastores = host.datastores.filter((ds) => ds.hosts.length === 1).sort(byName);
  const strandedVms = [...new Set(lostDatastores.flatMap((ds) => ds.vms))].filter((v) => v.host !== host).sort(vmOrder);

  let severity = "low";
  let headline = `No virtual machines are registered on ${host.name}.`;
  let detail = "Losing this host would take compute capacity out of the cluster, but nothing would stop running.";
  if (running.length || lostDatastores.length) {
    if (!cluster) {
      severity = "crit";
      headline = `${running.length} running VM${running.length === 1 ? "" : "s"} would stay down.`;
      detail = `${host.name} is a standalone host, so there is no HA to restart anything. Each VM would need a manual recovery.`;
    } else if (cluster.haEnabled === false) {
      severity = "crit";
      headline = `${running.length} running VM${running.length === 1 ? "" : "s"} would stay down.`;
      detail = `vSphere HA is turned off on ${cluster.name}, so nothing would restart automatically.`;
    } else if (!survivors.length) {
      severity = "crit";
      headline = `${running.length} running VM${running.length === 1 ? "" : "s"} would stay down.`;
      detail = `No other host in ${cluster.name} is connected and out of maintenance, so there is nowhere to restart them.`;
    } else if (!fits) {
      severity = "crit";
      headline = `${running.length} running VM${running.length === 1 ? "" : "s"} would restart — but the cluster looks short of memory.`;
      detail = `They need ${size(needMemoryGiB)}; the ${survivors.length} remaining host${survivors.length === 1 ? " has" : "s have"} about ${size(headroomGiB)} uncommitted.`;
    } else {
      severity = "warn";
      headline = `${running.length} running VM${running.length === 1 ? "" : "s"} would restart elsewhere.`;
      detail = `vSphere HA${cluster.haEnabled === null ? " (state unknown)" : ""} would restart them on the ${survivors.length} remaining host${survivors.length === 1 ? "" : "s"} in ${cluster.name}, which have about ${size(headroomGiB)} uncommitted memory. Expect a reboot, not a live migration.`;
    }
    if (lostDatastores.length) {
      severity = "crit";
      detail += ` ${lostDatastores.length} datastore${lostDatastores.length === 1 ? " is" : "s are"} mounted by this host alone and would go offline with it.`;
    }
  }

  return {
    kind: "host",
    server: server.server,
    title: host.name,
    subtitle: cluster ? `Host in ${cluster.name}` : "Standalone host",
    severity,
    headline,
    detail,
    status: `${vms.length} VM${vms.length === 1 ? "" : "s"} registered · ${running.length} running · ${size(needMemoryGiB)} to restart`,
    kpis: [
      ["VMs affected", num(vms.length), `${num(running.length)} running · ${num(templates.length)} template${templates.length === 1 ? "" : "s"}`],
      ["Memory to restart", size(needMemoryGiB), `${num(needVcpus)} vCPUs assigned`],
      ["Hosts left in cluster", cluster ? num(survivors.length) : "—", cluster ? `${num(survivorCores)} cores · ${size(survivorMemoryGiB)}` : "No cluster"],
      ["Spare memory after failure", cluster && survivors.length ? size(headroomGiB) : "—", fits ? "Enough for the restarts" : cluster && survivors.length ? "Short of what is needed" : "Nothing to restart onto"],
    ],
    facts: [
      ["Cluster", cluster?.name ?? "Standalone"],
      ["vSphere HA", cluster ? (cluster.haEnabled === null ? "Unknown" : cluster.haEnabled ? "Enabled" : "Disabled") : "Not applicable"],
      ["DRS", cluster ? (cluster.drsEnabled === null ? "Unknown" : cluster.drsEnabled ? "Enabled" : "Disabled") : "Not applicable"],
      ["Host state", `${host.connectionState ?? "unknown"}${host.inMaintenance ? " · in maintenance" : ""}`],
      ["Cores / memory", `${num(host.cores)} cores · ${size(host.memoryGiB)}`],
      ["Datastores mounted", num(host.datastores.length)],
    ],
    lists: [
      lostDatastores.length && {
        title: "Datastores this host alone can reach",
        note: "No other host has these mounted, so they go offline with the host.",
        columns: ["Datastore", "Type", "VMs", "Used"],
        rows: lostDatastores.map((ds) => [ds.name, ds.kind ?? "", { num: ds.vms.length }, { num: ds.usedGiB === null ? "—" : size(ds.usedGiB) }]),
      },
      strandedVms.length && {
        title: "VMs on other hosts using that storage",
        note: "Registered elsewhere, but their files live on a datastore only this host presents.",
        columns: ["Virtual machine", "Power", "Registered on"],
        rows: strandedVms.map((vm) => [vm.name, powerLabel(vm), vm.host?.name ?? "—"]),
      },
    ].filter(Boolean),
    table: {
      title: "Virtual machines on this host",
      columns: ["Virtual machine", "Power", "vCPU", "Memory", "Storage"],
      rows: vms.map((vm) => [
        vm.name,
        powerLabel(vm),
        { num: num(vm.vcpu) },
        { num: size(vm.memoryGiB) },
        vm.datastores.map((ds) => ds.name).join(", ") || "—",
      ]),
      empty: "No virtual machines are registered on this host.",
    },
  };
}

/** What a single datastore going offline would take with it. */
function datastoreImpact(server, ds) {
  const vms = [...ds.vms].sort(vmOrder);
  const running = vms.filter(isRunning);
  const whollyHere = vms.filter((vm) => vm.datastores.length === 1);
  const spanning = vms.filter((vm) => vm.datastores.length > 1);
  const clusters = [...new Set(vms.map((vm) => vm.host?.cluster ?? "Standalone hosts"))].sort();
  const memoryGiB = sumBy(running, (v) => v.memoryGiB);

  let severity = "low";
  let headline = `Nothing is stored on ${ds.name}.`;
  let detail = "No registered VM has files here, so losing it would cost capacity only.";
  if (vms.length) {
    severity = running.length ? "crit" : "warn";
    headline = running.length
      ? `${running.length} running VM${running.length === 1 ? "" : "s"} would crash.`
      : `${vms.length} registered VM${vms.length === 1 ? "" : "s"} would become unusable.`;
    const split = spanning.length
      ? ` ${whollyHere.length} VM${whollyHere.length === 1 ? " has" : "s have"} every file here; ${spanning.length} also use other datastores and would lose only part of themselves.`
      : " Every one of them has all its files here.";
    detail = running.length
      ? `Their disks live here, so HA cannot help: the storage itself is the failure.${split}`
      : `They are powered off, so nothing stops now — but none could be started until the datastore is back.${split}`;
  }

  return {
    kind: "datastore",
    server: server.server,
    title: ds.name,
    subtitle: `${ds.kind ?? "Datastore"} · mounted by ${ds.hosts.length} host${ds.hosts.length === 1 ? "" : "s"}`,
    severity,
    headline,
    detail,
    status: `${vms.length} VM${vms.length === 1 ? "" : "s"} stored here · ${running.length} running · ${ds.usedGiB === null ? "size unknown" : `${size(ds.usedGiB)} used`}`,
    kpis: [
      ["VMs affected", num(vms.length), `${num(running.length)} running now`],
      ["Entirely on this datastore", num(whollyHere.length), `${num(spanning.length)} also use other datastores`],
      ["Hosts that mount it", num(ds.hosts.length), clusters.length ? clusters.join(", ") : "No VMs registered"],
      ["Capacity offline", ds.capacityGiB === null ? "—" : size(ds.capacityGiB), ds.usedGiB === null ? "" : `${size(ds.usedGiB)} used · ${size(ds.freeGiB)} free`],
    ],
    facts: [
      ["Type", ds.kind ?? "Unknown"],
      ["Accessible now", ds.accessible === null ? "Unknown" : ds.accessible ? "Yes" : "No"],
      ["Capacity", ds.capacityGiB === null ? "—" : size(ds.capacityGiB)],
      ["Used", ds.usedGiB === null ? "—" : size(ds.usedGiB)],
      ["Running VM memory", size(memoryGiB)],
      ["Single-host storage", ds.hosts.length === 1 ? `Yes — only ${ds.hosts[0].name}` : "No"],
    ],
    lists: [
      ds.hosts.length && {
        title: "Hosts that mount it",
        note: "These hosts would see the datastore disappear.",
        columns: ["Host", "Cluster", "VMs here"],
        rows: ds.hosts
          .slice()
          .sort(byName)
          .map((h) => [h.name, h.cluster ?? "Standalone", { num: vms.filter((vm) => vm.host === h).length }]),
      },
    ].filter(Boolean),
    table: {
      title: "Virtual machines with files here",
      columns: ["Virtual machine", "Power", "Registered on", "Cluster", "Scope"],
      rows: vms.map((vm) => [
        vm.name,
        powerLabel(vm),
        vm.host?.name ?? "—",
        vm.host?.cluster ?? "Standalone",
        vm.datastores.length === 1 ? "All files here" : `Split across ${vm.datastores.length} datastores`,
      ]),
      empty: "No registered VM has files on this datastore.",
    },
  };
}

function powerLabel(vm) {
  if (vm.template) return "Template";
  return vm.powerState === "poweredOn" ? "Powered on" : vm.powerState === "suspended" ? "Suspended" : "Powered off";
}
