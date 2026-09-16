// Topology (hosts by cluster, datastores and their mounts) and the Insights rollup built on it.
// Uses the same cached queries as the sheets, so opening the dashboard after a sheet is free.

function dsUsedGiB(ds) {
  return ds.capacityGiB !== null && ds.freeGiB !== null ? round2(ds.capacityGiB - ds.freeGiB) : null;
}

function dsUsedPercent(ds) {
  const used = dsUsedGiB(ds);
  return ds.capacityGiB > 0 && used !== null ? Math.round((used / ds.capacityGiB) * 1000) / 10 : null;
}

function allHosts(server) {
  return [...server.clusters.flatMap((c) => c.hosts), ...server.standaloneHosts];
}

async function fetchTopology(d) {
  const [datacenters, hostObjects, clusterObjects, datastoreObjects] = await Promise.all([
    d.datacenters(),
    d.hosts(),
    d.clusters(),
    d.datastores(),
  ]);

  const hosts = hostObjects.map((h) => {
    const name = h.str("name");
    if (!name) throw new Error(`HostSystem ${h.moref} returned no name property`);
    return {
      moref: h.moref,
      name,
      cluster: null,
      connectionState: h.str("runtime.connectionState"),
      inMaintenance: h.bool("runtime.inMaintenanceMode") ?? false,
      cpuCores: h.num("summary.hardware.numCpuCores"),
      // With memory tiering on, memorySize includes the NVMe tier; DRAM is shown alongside it.
      memoryGiB: bytesToGiB(h.num("summary.hardware.memorySize")),
      dramGiB: bytesToGiB(memoryTierBytes(h, "DRAM")),
    };
  });

  // Membership comes from each cluster's own host list.
  const clusters = clusterObjects.map((c) => {
    const name = c.str("name");
    if (!name) throw new Error(`ClusterComputeResource ${c.moref} returned no name`);
    const members = [];
    for (const ref of c.array("host")) {
      const host = hosts.find((h) => h.moref === ref.textContent);
      if (host) {
        host.cluster = name;
        members.push(host);
      }
    }
    return { name, hosts: members };
  });

  const datastores = datastoreObjects
    .map((ds) => {
      const name = ds.str("name");
      if (!name) throw new Error(`Datastore ${ds.moref} returned no name property`);
      return {
        moref: ds.moref,
        name,
        kind: ds.str("summary.type"),
        capacityGiB: bytesToGiB(ds.num("summary.capacity")),
        freeGiB: bytesToGiB(ds.num("summary.freeSpace")),
        vmCount: ds.array("vm").length,
        mountedBy: ds.array("host").map((m) => textAt(m, "key")).filter(Boolean),
        accessible: ds.bool("summary.accessible"),
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    server: d.vc.name,
    datacenters: datacenters.map((dc) => dc.str("name")).filter(Boolean),
    clusters,
    standaloneHosts: hosts.filter((h) => !h.cluster),
    datastores,
  };
}

/** Topology across vCenters. An unreachable vCenter yields a warning, not an empty report. */
async function buildTopology(dataList) {
  const results = await Promise.allSettled(dataList.map(fetchTopology));
  const topology = { servers: [], warnings: [] };
  results.forEach((r, i) => {
    if (r.status === "fulfilled") topology.servers.push(r.value);
    else topology.warnings.push(`${dataList[i].vc.name}: ${r.reason?.message ?? r.reason}`);
  });
  return topology;
}

/** Roll every vCenter up into headline numbers. */
async function buildInsights(dataList) {
  const out = {
    servers: [],
    datacenters: 0,
    clusters: 0,
    hosts: 0,
    hostsInMaintenance: 0,
    hostsDisconnected: 0,
    cores: 0,
    dramGiB: 0,
    memoryTotalGiB: 0,
    vmsTotal: 0,
    vmsPoweredOn: 0,
    vcpus: 0,
    vramGiB: 0,
    datastores: 0,
    storageCapacityGiB: 0,
    storageUsedGiB: 0,
    storageFreeGiB: 0,
    storageUsedPercent: 0,
    vcpuCoreRatio: null,
    storageByType: [],
    topDatastores: [],
    clusterSummaries: [],
    warnings: [],
  };

  const results = await Promise.allSettled(dataList.map((d) => Promise.all([fetchTopology(d), d.vmTotalsByHost()])));

  results.forEach((result, i) => {
    const server = dataList[i].vc.name;
    if (result.status === "rejected") {
      out.warnings.push(`${server}: ${result.reason?.message ?? result.reason}`);
      return;
    }
    const [topology, totals] = result.value;
    out.servers.push(server);
    out.datacenters += topology.datacenters.length;
    out.clusters += topology.clusters.length;

    for (const cluster of topology.clusters) {
      out.clusterSummaries.push({
        name: cluster.name,
        server,
        hosts: cluster.hosts.length,
        cores: cluster.hosts.reduce((n, h) => n + (h.cpuCores ?? 0), 0),
        dramGiB: round2(cluster.hosts.reduce((n, h) => n + (h.dramGiB ?? h.memoryGiB ?? 0), 0)),
      });
    }

    for (const host of allHosts(topology)) {
      out.hosts += 1;
      if (host.inMaintenance) out.hostsInMaintenance += 1;
      else if (host.connectionState !== "connected") out.hostsDisconnected += 1;
      out.cores += host.cpuCores ?? 0;
      // Falls back to reported memory where the host exposes no tier detail.
      out.dramGiB += host.dramGiB ?? host.memoryGiB ?? 0;
      out.memoryTotalGiB += host.memoryGiB ?? 0;
      const t = totals.get(host.moref);
      if (t) {
        out.vmsTotal += t.vmsTotal;
        out.vmsPoweredOn += t.vmsPoweredOn;
        out.vcpus += t.vcpus;
        out.vramGiB += t.vramMiB / 1024;
      }
    }

    for (const ds of topology.datastores) {
      out.datastores += 1;
      const capacity = ds.capacityGiB ?? 0;
      const used = dsUsedGiB(ds) ?? 0;
      out.storageCapacityGiB += capacity;
      out.storageUsedGiB += used;
      out.storageFreeGiB += ds.freeGiB ?? 0;

      const kind = ds.kind ?? "Other";
      const entry = out.storageByType.find((t) => t.kind === kind);
      if (entry) {
        entry.datastores += 1;
        entry.capacityGiB += capacity;
        entry.usedGiB += used;
      } else {
        out.storageByType.push({ kind, datastores: 1, capacityGiB: capacity, usedGiB: used });
      }

      out.topDatastores.push({
        name: ds.name,
        kind,
        server,
        capacityGiB: round2(capacity),
        usedGiB: round2(used),
        usedPercent: dsUsedPercent(ds) ?? 0,
      });
    }
  });

  for (const key of ["dramGiB", "memoryTotalGiB", "vramGiB", "storageCapacityGiB", "storageUsedGiB", "storageFreeGiB"]) {
    out[key] = round2(out[key]);
  }
  for (const t of out.storageByType) {
    t.capacityGiB = round2(t.capacityGiB);
    t.usedGiB = round2(t.usedGiB);
  }
  out.storageByType.sort((a, b) => b.capacityGiB - a.capacityGiB);
  out.topDatastores.sort((a, b) => b.usedPercent - a.usedPercent);
  out.topDatastores = out.topDatastores.slice(0, 8);
  out.storageUsedPercent = out.storageCapacityGiB > 0 ? Math.round((out.storageUsedGiB / out.storageCapacityGiB) * 1000) / 10 : 0;
  // vCPUs committed per physical core: the classic overcommit ratio.
  out.vcpuCoreRatio = out.cores > 0 ? round2(out.vcpus / out.cores) : null;
  return out;
}
