// Inventory sheets: columns declared once, rows built per vCenter.
//
// SOAP property paths and response shapes were verified against a live vCenter 9.1
// before being written here. Values that vCenter doesn't report stay null rather
// than becoming 0 or "unknown": "not reported" and "zero" are different facts.

const col = {
  text: (label) => ({ label, kind: "text" }),
  number: (label) => ({ label, kind: "number" }),
  bool: (label) => ({ label, kind: "bool" }),
};

/** The source-vCenter column appended to every sheet. */
const VI_SDK_SERVER = "VI SDK Server";

const round2 = (v) => Math.round(v * 100) / 100;
const bytesToGiB = (b) => (b === null || b === undefined ? null : round2(b / 1024 ** 3));
const bytesToMiB = (b) => (b === null || b === undefined ? null : round2(b / 1024 ** 2));

/** Percentage to two places; null when either side is missing or the total is zero. */
function percent(used, total) {
  return used !== null && total ? round2((used / total) * 100) : null;
}

function ratio(numerator, denominator) {
  return denominator ? round2(numerator / denominator) : null;
}

const isVcls = (name) => name.startsWith("vCLS-");

// ---------- shared queries ----------

// vInfo's properties also carry everything vHost's VM totals and the per-VM context
// columns need, so one VirtualMachine query serves them all.
const VM_INVENTORY_PROPS = [
  "name",
  "config.template",
  "runtime.powerState",
  "runtime.host",
  "guest.ipAddress",
  "guest.hostName",
  "guest.guestFullName",
  "config.guestFullName",
  "guest.toolsVersionStatus",
  "guest.toolsRunningStatus",
  "config.createDate",
  "config.version",
  "config.annotation",
  "config.firmware",
  "config.bootOptions.efiSecureBootEnabled",
  "config.hardware.numCPU",
  "config.hardware.numCoresPerSocket",
  "config.hardware.memoryMB",
  "config.files.vmPathName",
  "config.changeVersion",
  "config.uuid",
  "summary.storage.committed",
  "summary.storage.uncommitted",
  "summary.quickStats.overallCpuUsage",
  "summary.runtime.maxCpuUsage",
  "summary.quickStats.guestMemoryUsage",
  "summary.config.memorySizeMB",
  // vCPU
  "config.cpuAllocation.shares.level",
  "config.cpuAllocation.shares.shares",
  "config.cpuAllocation.reservation",
  "config.cpuAllocation.limit",
  "config.cpuHotAddEnabled",
  "config.cpuHotRemoveEnabled",
  "summary.quickStats.staticCpuEntitlement",
  "summary.quickStats.distributedCpuEntitlement",
  // vMemory
  "config.memoryAllocation.shares.level",
  "config.memoryAllocation.shares.shares",
  "config.memoryAllocation.reservation",
  "config.memoryAllocation.limit",
  "config.memoryHotAddEnabled",
  "summary.quickStats.hostMemoryUsage",
  "summary.quickStats.privateMemory",
  "summary.quickStats.sharedMemory",
  "summary.quickStats.swappedMemory",
  "summary.quickStats.balloonedMemory",
  "summary.quickStats.compressedMemory",
  "summary.quickStats.consumedOverheadMemory",
  "summary.quickStats.staticMemoryEntitlement",
  "summary.quickStats.distributedMemoryEntitlement",
  // vPartition and vTools
  "guest.disk",
  "guest.toolsStatus",
  "guest.toolsVersion",
  "guest.guestState",
  "guest.guestId",
  "guest.guestFamily",
  "config.tools.toolsUpgradePolicy",
  "config.tools.syncTimeWithHost",
  "config.tools.afterPowerOn",
  "config.tools.afterResume",
];

// The device array backs vDisk, vNetwork and vHealth; snapshots back vSnapshot and vHealth.
// Fetched once and shared, never once per sheet.
const VM_DEVICE_PROPS = [
  "name",
  "config.hardware.device",
  "snapshot.rootSnapshotList",
  "snapshot.currentSnapshot",
  "layoutEx.file",
  "layoutEx.snapshot",
];

const HOST_PROPS = [
  "name",
  "overallStatus",
  "runtime.connectionState",
  "runtime.powerState",
  "runtime.inMaintenanceMode",
  "runtime.bootTime",
  "summary.hardware.vendor",
  "summary.hardware.model",
  "summary.hardware.cpuModel",
  "summary.hardware.cpuMhz",
  "summary.hardware.numCpuPkgs",
  "summary.hardware.numCpuCores",
  "summary.hardware.numCpuThreads",
  "summary.hardware.memorySize",
  "hardware.memoryTierInfo",
  "summary.hardware.numNics",
  "summary.hardware.numHBAs",
  "summary.hardware.uuid",
  "summary.quickStats.overallCpuUsage",
  "summary.quickStats.overallMemoryUsage",
  "summary.currentEVCModeKey",
  "summary.maxEVCModeKey",
  "capability.vmotionSupported",
  "capability.storageVMotionSupported",
  "config.product.fullName",
  "config.hyperThread.available",
  "config.hyperThread.active",
  "config.network.dnsConfig.domainName",
  "config.network.dnsConfig.address",
  "config.network.dnsConfig.searchDomain",
  "config.network.dnsConfig.dhcp",
  "config.dateTimeInfo.timeZone.name",
  "config.dateTimeInfo.timeZone.gmtOffset",
  "config.dateTimeInfo.ntpConfig.server",
  "config.service.service",
  "hardware.biosInfo.biosVersion",
  "hardware.biosInfo.releaseDate",
  "hardware.cpuPowerManagementInfo.currentPolicy",
  "hardware.systemInfo.serialNumber",
  "hardware.systemInfo.otherIdentifyingInfo",
  // vHBA, vNIC, vSwitch, vPort and vSC_VMK all come from these arrays.
  "config.storageDevice.hostBusAdapter",
  "config.network.pnic",
  "config.network.vnic",
  "config.network.vswitch",
  "config.network.portgroup",
];

const DATASTORE_PROPS = ["name", "summary.type", "summary.capacity", "summary.freeSpace", "summary.accessible", "host", "vm"];

const RESOURCE_POOL_PROPS = [
  "name",
  "owner",
  "overallStatus",
  "vm",
  "config.cpuAllocation.limit",
  "config.cpuAllocation.reservation",
  "config.cpuAllocation.shares.level",
  "config.cpuAllocation.shares.shares",
  "config.memoryAllocation.limit",
  "config.memoryAllocation.reservation",
  "config.memoryAllocation.shares.level",
  "config.memoryAllocation.shares.shares",
  "summary.quickStats.overallCpuUsage",
  "summary.quickStats.guestMemoryUsage",
  "summary.quickStats.hostMemoryUsage",
];

const DVSWITCH_PROPS = [
  "name",
  "uuid",
  "summary.productInfo",
  "summary.numPorts",
  "summary.hostMember",
  "config.maxPorts",
  "config.createTime",
];

const DVPORTGROUP_PROPS = ["name", "key", "config.numPorts", "config.type", "config.defaultPortConfig", "config.distributedVirtualSwitch"];

/** Performance counters, by the column they fill. */
const HOST_COUNTERS = {
  cpuPercent: "cpu.usage.average",
  cpuMhz: "cpu.usagemhz.average",
  memoryPercent: "mem.usage.average",
  memoryConsumed: "mem.consumed.average",
  network: "net.usage.average",
  disk: "disk.usage.average",
};

const VM_COUNTERS = { ...HOST_COUNTERS, memoryActive: "mem.active.average" };

/**
 * Everything fetched from one vCenter. Queries are cached as promises, so switching
 * sheets reuses data and concurrent sheets share one round trip. A new instance
 * (on Refresh) starts clean.
 */
class VcenterData {
  constructor(vc) {
    this.vc = vc;
    this.api = HelperClient.forVcenter(vc.id);
    this.queries = new Map();
  }

  once(key, run) {
    if (!this.queries.has(key)) {
      const promise = run();
      this.queries.set(key, promise);
      // A failed query is retried the next time it's asked for.
      promise.catch(() => this.queries.delete(key));
    }
    return this.queries.get(key);
  }

  vmInventory() {
    return this.once("vmInventory", () => retrieve(this.api, "VirtualMachine", VM_INVENTORY_PROPS));
  }
  vmDevices() {
    return this.once("vmDevices", () => retrieve(this.api, "VirtualMachine", VM_DEVICE_PROPS));
  }
  hosts() {
    return this.once("hosts", () => retrieve(this.api, "HostSystem", HOST_PROPS));
  }
  clusters() {
    return this.once("clusters", () => retrieve(this.api, "ClusterComputeResource", ["name", "host"]));
  }
  datastores() {
    return this.once("datastores", () => retrieve(this.api, "Datastore", DATASTORE_PROPS));
  }
  datacenters() {
    return this.once("datacenters", () => retrieve(this.api, "Datacenter", ["name"]));
  }
  /** REST: HA and DRS flags. The cluster id matches the SOAP moref (domain-c47). */
  restClusters() {
    return this.once("restClusters", () => this.api.get("/api/vcenter/cluster"));
  }
  /** REST: network id (dvportgroup-…, network-…) → name. */
  restNetworks() {
    return this.once("restNetworks", () => this.api.get("/api/vcenter/network"));
  }

  resourcePools() {
    return this.once("resourcePools", () => retrieve(this.api, "ResourcePool", RESOURCE_POOL_PROPS));
  }
  dvSwitches() {
    return this.once("dvSwitches", () => retrieve(this.api, "VmwareDistributedVirtualSwitch", DVSWITCH_PROPS));
  }
  dvPortgroups() {
    return this.once("dvPortgroups", () => retrieve(this.api, "DistributedVirtualPortgroup", DVPORTGROUP_PROPS));
  }
  /** vCenter's own version details, plus the morefs for licences and performance. */
  serviceContent() {
    return this.once("serviceContent", () => serviceContent(this.api));
  }
  licenses() {
    return this.once("licenses", async () => {
      const content = await this.serviceContent();
      const manager = await retrieveObject(this.api, "LicenseManager", textAt(content, "licenseManager") ?? "LicenseManager", ["licenses"]);
      return manager?.array("licenses") ?? [];
    });
  }
  perfCounters() {
    return this.once("perfCounters", async () => {
      const content = await this.serviceContent();
      // queryPerf() reads this when addressing the performance manager.
      this.api.perfManager = textAt(content, "perfManager") ?? "PerfMgr";
      return perfCounterIds(this.api, this.api.perfManager);
    });
  }

  /** Latest performance sample per entity. Older helpers refuse the query; say so plainly. */
  async perfSamples(key, entityType, morefs, wanted) {
    return this.once(key, async () => {
      try {
        const ids = await this.perfCounters();
        const counters = new Map();
        for (const [column, counter] of Object.entries(wanted)) {
          const id = ids.get(counter);
          if (id) counters.set(column, id);
        }
        return await queryPerf(this.api, entityType, morefs, counters);
      } catch (err) {
        if (err.kind === "soap_not_allowed") {
          throw new Error("Performance data needs DBH Insights Helper 0.3.0 or later.");
        }
        throw err;
      }
    });
  }

  /** HostSystem moref → host name. */
  async hostNames() {
    return new Map((await this.hosts()).map((h) => [h.moref, h.str("name")]));
  }

  /** Per-host rollup of registered VMs. vCLS VMs are excluded, as the vSphere UI does. */
  async vmTotalsByHost() {
    const totals = new Map();
    for (const vm of await this.vmInventory()) {
      const name = vm.str("name");
      const host = vm.str("runtime.host");
      if (!name || isVcls(name) || !host) continue;
      const t = totals.get(host) ?? { vmsTotal: 0, vmsPoweredOn: 0, vcpus: 0, vramMiB: 0 };
      t.vmsTotal += 1;
      if (vm.str("runtime.powerState") === "poweredOn") t.vmsPoweredOn += 1;
      t.vcpus += vm.num("config.hardware.numCPU") ?? 0;
      t.vramMiB += vm.num("config.hardware.memoryMB") ?? 0;
      totals.set(host, t);
    }
    return totals;
  }

  /** vmInventory keyed by moref, for joining with vmDevices. */
  async vmsByMoref() {
    return new Map((await this.vmInventory()).map((vm) => [vm.moref, vm]));
  }
}

/** The per-VM columns repeated on every VM-derived sheet. Null for vCLS VMs. */
function vmContext(vm, hostNames) {
  const name = vm.str("name");
  if (!name) throw new Error(`VirtualMachine ${vm.moref} returned no name property`);
  if (isVcls(name)) return null;
  const host = vm.str("runtime.host");
  return {
    name,
    powerState: vm.str("runtime.powerState"),
    template: vm.bool("config.template"),
    host: host ? hostNames.get(host) ?? host : null,
    annotation: vm.str("config.annotation"),
  };
}

// ---------- host helpers ----------

/** Size in bytes of one memory tier (DRAM, NVMe). With memory tiering on, memorySize is DRAM plus NVMe. */
function memoryTierBytes(host, tierType) {
  const tier = host.array("hardware.memoryTierInfo").find((t) => textAt(t, "type") === tierType);
  return tier ? numberAt(tier, "size") : null;
}

function memoryTieringType(host) {
  const types = host.array("hardware.memoryTierInfo").map((t) => textAt(t, "type")).filter(Boolean);
  return types.length ? types.join(" + ") : null;
}

/** Join a string[] property (elements are <string>). */
function stringArray(obj, prop) {
  const joined = obj.array(prop).map((e) => e.textContent).filter(Boolean).join(", ");
  return joined || null;
}

function serviceRunning(host, key) {
  const service = host.array("config.service.service").find((s) => textAt(s, "key") === key);
  return service ? boolAt(service, "running") : null;
}

function identifyingInfo(host, key) {
  const entry = host.array("hardware.systemInfo.otherIdentifyingInfo").find((e) => textAt(e, "identifierType/key") === key);
  const value = entry ? textAt(entry, "identifierValue") : null;
  return value && value !== "Default string" ? value : null;
}

/** A world wide name as vCenter reports it (a decimal number) in the usual hex form. */
function wwn(value) {
  if (value === null) return null;
  try {
    return BigInt(value).toString(16).padStart(16, "0").replace(/(.{2})(?=.)/g, "$1:");
  } catch {
    return String(value);
  }
}

/** A distributed port group setting, which wraps its value: <securityPolicy><allowPromiscuous><value>. */
function dvBool(el, path) {
  const text = textAt(el, `${path}/value`);
  return text === "true" ? true : text === "false" ? false : null;
}

/** VLAN of a distributed port group: a single id, a trunk range, or private VLAN. */
function dvVlan(portConfig) {
  const vlan = portConfig && childElement(portConfig, "vlan");
  if (!vlan) return null;
  const single = textAt(vlan, "vlanId");
  if (single !== null) return single;
  const ranges = childElements(vlan, "vlanId")
    .map((r) => {
      const start = textAt(r, "start");
      const end = textAt(r, "end");
      return start === end ? start : `${start}-${end}`;
    })
    .filter(Boolean);
  if (ranges.length) return `trunk ${ranges.join(", ")}`;
  const pvlan = textAt(vlan, "pvlanId");
  return pvlan === null ? null : `pvlan ${pvlan}`;
}

// ---------- snapshot helpers ----------

/** Flatten a snapshot tree depth-first; children hang off <childSnapshotList>. */
function flattenSnapshots(node, out = []) {
  out.push({
    moref: textAt(node, "snapshot") ?? "",
    name: textAt(node, "name"),
    description: textAt(node, "description"),
    createTime: textAt(node, "createTime"),
    state: textAt(node, "state"),
    quiesced: boolAt(node, "quiesced"),
  });
  for (const child of childElements(node, "childSnapshotList")) flattenSnapshots(child, out);
  return out;
}

/** yyyy/MM/dd HH:mm:ss in UTC, as vCenter reports it. Unparseable input passes through. */
function formatTimestamp(raw) {
  const date = new Date(raw);
  if (!raw || Number.isNaN(date.getTime())) return raw ?? "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/** The folder of `[datastore] folder/name.vmx`; null for a VM at the datastore root. */
function folderOf(vmPath) {
  const at = vmPath.indexOf("] ");
  if (at < 0) return null;
  const rest = vmPath.slice(at + 2);
  const slash = rest.lastIndexOf("/");
  return slash < 0 ? null : rest.slice(0, slash);
}

// ---------- sheets ----------

const SHEETS = [
  {
    name: "vInfo",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.bool("Template"),
      col.text("DNS Name"),
      col.number("CPUs"),
      col.number("Cores p/s"),
      col.number("Memory"),
      col.number("CPU Usage (%)"),
      col.number("Memory Usage (%)"),
      col.number("Provisioned GiB"),
      col.number("In Use GiB"),
      col.text("Primary IP Address"),
      col.text("OS according to the configuration file"),
      col.text("OS according to the VMware Tools"),
      col.text("Tools Version Status"),
      col.text("Tools Running Status"),
      col.text("Host"),
      col.text("Creation date"),
      col.text("HW version"),
      col.text("Firmware"),
      col.bool("EFI Secure boot"),
      col.text("Path"),
      col.text("Annotation"),
      col.text("Change Version"),
      col.text("VM UUID"),
    ],
    async rows(d) {
      const [hosts, vms] = await Promise.all([d.hostNames(), d.vmInventory()]);
      const rows = [];
      for (const vm of vms) {
        const name = vm.str("name");
        if (!name) throw new Error(`VirtualMachine ${vm.moref} returned no name property`);
        if (isVcls(name)) continue;
        const committed = vm.num("summary.storage.committed");
        const uncommitted = vm.num("summary.storage.uncommitted");
        const host = vm.str("runtime.host");
        rows.push([
          name,
          vm.str("runtime.powerState"),
          vm.bool("config.template"),
          vm.str("guest.hostName"),
          vm.num("config.hardware.numCPU"),
          vm.num("config.hardware.numCoresPerSocket"),
          vm.num("config.hardware.memoryMB"),
          percent(vm.num("summary.quickStats.overallCpuUsage"), vm.num("summary.runtime.maxCpuUsage")),
          percent(vm.num("summary.quickStats.guestMemoryUsage"), vm.num("summary.config.memorySizeMB")),
          committed !== null && uncommitted !== null ? bytesToGiB(committed + uncommitted) : null,
          bytesToGiB(committed),
          vm.str("guest.ipAddress"),
          vm.str("config.guestFullName"),
          vm.str("guest.guestFullName"),
          vm.str("guest.toolsVersionStatus"),
          vm.str("guest.toolsRunningStatus"),
          host ? hosts.get(host) ?? host : null,
          vm.str("config.createDate"),
          vm.str("config.version"),
          vm.str("config.firmware"),
          vm.bool("config.bootOptions.efiSecureBootEnabled"),
          vm.str("config.files.vmPathName"),
          vm.str("config.annotation"),
          vm.str("config.changeVersion"),
          vm.str("config.uuid"),
        ]);
      }
      return rows;
    },
  },

  {
    name: "vCPU",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.bool("Template"),
      col.number("CPUs"),
      col.number("Sockets"),
      col.number("Cores p/s"),
      col.number("Overall MHz"),
      col.number("Max MHz"),
      col.number("CPU Usage (%)"),
      col.text("Level"),
      col.number("Shares"),
      col.number("Reservation"),
      col.number("Limit"),
      col.number("Entitlement"),
      col.number("DRS Entitlement"),
      col.bool("Hot Add"),
      col.bool("Hot Remove"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, vms] = await Promise.all([d.hostNames(), d.vmInventory()]);
      const rows = [];
      for (const vm of vms) {
        const ctx = vmContext(vm, hosts);
        if (!ctx) continue;
        const cpus = vm.num("config.hardware.numCPU");
        const coresPerSocket = vm.num("config.hardware.numCoresPerSocket");
        const used = vm.num("summary.quickStats.overallCpuUsage");
        const max = vm.num("summary.runtime.maxCpuUsage");
        rows.push([
          ctx.name,
          ctx.powerState,
          ctx.template,
          cpus,
          cpus !== null && coresPerSocket ? cpus / coresPerSocket : null,
          coresPerSocket,
          used,
          max,
          percent(used, max),
          vm.str("config.cpuAllocation.shares.level"),
          vm.num("config.cpuAllocation.shares.shares"),
          vm.num("config.cpuAllocation.reservation"),
          vm.num("config.cpuAllocation.limit"),
          vm.num("summary.quickStats.staticCpuEntitlement"),
          vm.num("summary.quickStats.distributedCpuEntitlement"),
          vm.bool("config.cpuHotAddEnabled"),
          vm.bool("config.cpuHotRemoveEnabled"),
          ctx.host,
          ctx.annotation,
        ]);
      }
      return rows;
    },
  },

  {
    // quickStats memory values are MiB; memoryOverhead is bytes.
    name: "vMemory",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.bool("Template"),
      col.number("Size MiB"),
      col.number("Consumed MiB"),
      col.number("Active MiB"),
      col.number("Memory Usage (%)"),
      col.number("Private MiB"),
      col.number("Shared MiB"),
      col.number("Swapped MiB"),
      col.number("Ballooned MiB"),
      col.number("Compressed MiB"),
      col.number("Consumed Overhead MiB"),
      col.number("Entitlement"),
      col.number("DRS Entitlement"),
      col.text("Level"),
      col.number("Shares"),
      col.number("Reservation"),
      col.number("Limit"),
      col.bool("Hot Add"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, vms] = await Promise.all([d.hostNames(), d.vmInventory()]);
      const rows = [];
      for (const vm of vms) {
        const ctx = vmContext(vm, hosts);
        if (!ctx) continue;
        rows.push([
          ctx.name,
          ctx.powerState,
          ctx.template,
          vm.num("config.hardware.memoryMB"),
          vm.num("summary.quickStats.hostMemoryUsage"),
          vm.num("summary.quickStats.guestMemoryUsage"),
          percent(vm.num("summary.quickStats.guestMemoryUsage"), vm.num("summary.config.memorySizeMB")),
          vm.num("summary.quickStats.privateMemory"),
          vm.num("summary.quickStats.sharedMemory"),
          vm.num("summary.quickStats.swappedMemory"),
          vm.num("summary.quickStats.balloonedMemory"),
          vm.num("summary.quickStats.compressedMemory"),
          vm.num("summary.quickStats.consumedOverheadMemory"),
          vm.num("summary.quickStats.staticMemoryEntitlement"),
          vm.num("summary.quickStats.distributedMemoryEntitlement"),
          vm.str("config.memoryAllocation.shares.level"),
          vm.num("config.memoryAllocation.shares.shares"),
          vm.num("config.memoryAllocation.reservation"),
          vm.num("config.memoryAllocation.limit"),
          vm.bool("config.memoryHotAddEnabled"),
          ctx.host,
          ctx.annotation,
        ]);
      }
      return rows;
    },
  },

  {
    name: "vDisk",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.bool("Template"),
      col.text("Disk"),
      col.number("Disk Key"),
      col.text("Disk UUID"),
      col.text("Disk Path"),
      col.number("Capacity MiB"),
      col.bool("Raw"),
      col.text("Disk Mode"),
      col.text("Sharing mode"),
      col.bool("Thin"),
      col.bool("Eagerly Scrub"),
      col.bool("Split"),
      col.bool("Write Through"),
      col.text("Level"),
      col.number("Shares"),
      col.number("Reservation"),
      col.number("Limit"),
      col.text("Controller"),
      col.number("Unit #"),
      col.text("Raw LUN ID"),
      col.text("Raw Comp. Mode"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, inventory, devices] = await Promise.all([d.hostNames(), d.vmsByMoref(), d.vmDevices()]);
      const rows = [];
      for (const vmDev of devices) {
        const ctx = vmContext(inventory.get(vmDev.moref) ?? vmDev, hosts);
        if (!ctx) continue;
        const all = vmDev.array("config.hardware.device");
        const controllers = new Map(all.map((dev) => [textAt(dev, "key"), textAt(dev, "deviceInfo/label")]));
        for (const disk of all.filter((dev) => xsiType(dev) === "VirtualDisk")) {
          const backing = childElement(disk, "backing");
          const isRaw = (xsiType(backing) ?? "").startsWith("RawDiskMapping");
          const kib = numberAt(disk, "capacityInKB");
          rows.push([
            ctx.name,
            ctx.powerState,
            ctx.template,
            textAt(disk, "deviceInfo/label"),
            numberAt(disk, "key"),
            backing && textAt(backing, "uuid"),
            backing && textAt(backing, "fileName"),
            kib === null ? null : round2(kib / 1024),
            isRaw,
            backing && textAt(backing, "diskMode"),
            backing && textAt(backing, "sharing"),
            backing && boolAt(backing, "thinProvisioned"),
            backing && boolAt(backing, "eagerlyScrub"),
            backing && boolAt(backing, "split"),
            backing && boolAt(backing, "writeThrough"),
            textAt(disk, "storageIOAllocation/shares/level"),
            numberAt(disk, "storageIOAllocation/shares/shares"),
            numberAt(disk, "storageIOAllocation/reservation"),
            numberAt(disk, "storageIOAllocation/limit"),
            controllers.get(textAt(disk, "controllerKey")) ?? null,
            numberAt(disk, "unitNumber"),
            backing && textAt(backing, "lunUuid"),
            backing && textAt(backing, "compatibilityMode"),
            ctx.host,
            ctx.annotation,
          ]);
        }
      }
      return rows;
    },
  },

  {
    // Guest filesystems, as VMware Tools reports them. VMs without Tools running have none.
    name: "vPartition",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.text("Disk"),
      col.number("Capacity MiB"),
      col.number("Consumed MiB"),
      col.number("Free MiB"),
      col.number("Free %"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, vms] = await Promise.all([d.hostNames(), d.vmInventory()]);
      const rows = [];
      for (const vm of vms) {
        const ctx = vmContext(vm, hosts);
        if (!ctx) continue;
        for (const disk of vm.array("guest.disk")) {
          const capacity = numberAt(disk, "capacity");
          const free = numberAt(disk, "freeSpace");
          rows.push([
            ctx.name,
            ctx.powerState,
            textAt(disk, "diskPath"),
            bytesToMiB(capacity),
            capacity !== null && free !== null ? bytesToMiB(capacity - free) : null,
            bytesToMiB(free),
            percent(free, capacity),
            ctx.host,
            ctx.annotation,
          ]);
        }
      }
      return rows;
    },
  },

  {
    name: "vNetwork",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.bool("Template"),
      col.text("NIC label"),
      col.text("Adapter"),
      col.text("Network"),
      col.bool("Connected"),
      col.bool("Starts Connected"),
      col.text("Mac Address"),
      col.text("Type"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, inventory, devices, networks] = await Promise.all([
        d.hostNames(),
        d.vmsByMoref(),
        d.vmDevices(),
        // Network names are a convenience; without them the backing key is shown instead.
        d.restNetworks().catch(() => []),
      ]);
      const networkNames = new Map((networks ?? []).map((n) => [n.network, n.name]));
      const rows = [];
      for (const vmDev of devices) {
        const ctx = vmContext(inventory.get(vmDev.moref) ?? vmDev, hosts);
        if (!ctx) continue;
        // Every virtual ethernet card, whatever its concrete type, carries a MAC address.
        for (const nic of vmDev.array("config.hardware.device").filter((dev) => childElement(dev, "macAddress"))) {
          const backing = childElement(nic, "backing");
          const backingType = xsiType(backing) ?? "";
          let network = null;
          if (backingType.includes("DistributedVirtualPort")) {
            const key = textAt(backing, "port/portgroupKey");
            network = key ? networkNames.get(key) ?? key : null;
          } else if (backingType.includes("OpaqueNetwork")) {
            network = textAt(backing, "opaqueNetworkId");
          } else if (backing) {
            network = textAt(backing, "deviceName");
          }
          rows.push([
            ctx.name,
            ctx.powerState,
            ctx.template,
            textAt(nic, "deviceInfo/label"),
            (xsiType(nic) ?? "").replace(/^Virtual/, "") || null,
            network,
            boolAt(nic, "connectable/connected"),
            boolAt(nic, "connectable/startConnected"),
            textAt(nic, "macAddress"),
            textAt(nic, "addressType"),
            ctx.host,
            ctx.annotation,
          ]);
        }
      }
      return rows;
    },
  },

  {
    name: "vSnapshot",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.text("Name"),
      col.text("Description"),
      col.text("Date / time"),
      col.text("Filename"),
      col.number("Size MiB (vmsn)"),
      col.number("Size MiB (total)"),
      col.bool("Quiesced"),
      col.text("State"),
      col.bool("Is current"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, inventory, devices] = await Promise.all([d.hostNames(), d.vmsByMoref(), d.vmDevices()]);
      const rows = [];
      for (const vmDev of devices) {
        const ctx = vmContext(inventory.get(vmDev.moref) ?? vmDev, hosts);
        if (!ctx) continue;
        const snapshots = vmDev.array("snapshot.rootSnapshotList").flatMap((root) => flattenSnapshots(root));
        if (!snapshots.length) continue;

        // layoutEx.file key → {name, size}; layoutEx.snapshot moref → {dataKey, memoryKey}.
        const files = new Map(
          vmDev.array("layoutEx.file").map((f) => [textAt(f, "key"), { name: textAt(f, "name"), size: numberAt(f, "size") }]),
        );
        const layout = new Map(
          vmDev.array("layoutEx.snapshot").map((s) => [textAt(s, "key"), { data: textAt(s, "dataKey"), memory: textAt(s, "memoryKey") }]),
        );
        const current = vmDev.str("snapshot.currentSnapshot");

        for (const snap of snapshots) {
          const keys = layout.get(snap.moref) ?? {};
          // A memoryKey of -1 means the snapshot captured no memory state.
          const fileOf = (key) => (key && key !== "-1" ? files.get(key) ?? null : null);
          const dataFile = fileOf(keys.data);
          const memoryFile = fileOf(keys.memory);
          // Total is the snapshot's own files (.vmsn plus .vmem). Delta-disk growth isn't
          // attributable to one snapshot from layoutEx, so it isn't guessed at.
          const total = dataFile || memoryFile ? (dataFile?.size ?? 0) + (memoryFile?.size ?? 0) : null;
          rows.push([
            ctx.name,
            ctx.powerState,
            snap.name,
            snap.description,
            snap.createTime,
            dataFile?.name ?? null,
            bytesToMiB(dataFile?.size ?? null),
            bytesToMiB(total),
            snap.quiesced,
            snap.state,
            current === snap.moref,
            ctx.host,
            ctx.annotation,
          ]);
        }
      }
      return rows;
    },
  },

  {
    name: "vCD",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.text("Device"),
      col.bool("Connected"),
      col.bool("Starts Connected"),
      col.bool("Allow guest control"),
      col.text("Backing"),
      col.text("Device / ISO"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, inventory, devices] = await Promise.all([d.hostNames(), d.vmsByMoref(), d.vmDevices()]);
      const rows = [];
      for (const vmDev of devices) {
        const ctx = vmContext(inventory.get(vmDev.moref) ?? vmDev, hosts);
        if (!ctx) continue;
        for (const cdrom of vmDev.array("config.hardware.device").filter((dev) => xsiType(dev) === "VirtualCdrom")) {
          const backing = childElement(cdrom, "backing");
          rows.push([
            ctx.name,
            ctx.powerState,
            textAt(cdrom, "deviceInfo/label"),
            boolAt(cdrom, "connectable/connected"),
            boolAt(cdrom, "connectable/startConnected"),
            boolAt(cdrom, "connectable/allowGuestControl"),
            (xsiType(backing) ?? "").replace(/^VirtualCdrom|BackingInfo$/g, "") || null,
            backing && (textAt(backing, "fileName") ?? textAt(backing, "deviceName")),
            ctx.host,
            ctx.annotation,
          ]);
        }
      }
      return rows;
    },
  },

  {
    // USB controllers and any passed-through USB devices.
    name: "vUSB",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.text("Device"),
      col.text("Type"),
      col.bool("Connected"),
      col.bool("Auto connect"),
      col.text("Summary"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, inventory, devices] = await Promise.all([d.hostNames(), d.vmsByMoref(), d.vmDevices()]);
      const rows = [];
      for (const vmDev of devices) {
        const ctx = vmContext(inventory.get(vmDev.moref) ?? vmDev, hosts);
        if (!ctx) continue;
        for (const usb of vmDev.array("config.hardware.device").filter((dev) => (xsiType(dev) ?? "").startsWith("VirtualUSB"))) {
          rows.push([
            ctx.name,
            ctx.powerState,
            (textAt(usb, "deviceInfo/label") ?? "").trim() || null,
            (xsiType(usb) ?? "").replace(/^Virtual/, ""),
            boolAt(usb, "connectable/connected"),
            boolAt(usb, "autoConnectDevices"),
            textAt(usb, "deviceInfo/summary"),
            ctx.host,
            ctx.annotation,
          ]);
        }
      }
      return rows;
    },
  },

  {
    name: "vTools",
    group: "Virtual machines",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.text("Tools status"),
      col.text("Tools version status"),
      col.text("Tools running status"),
      col.text("Tools version"),
      col.text("Upgrade policy"),
      col.bool("Sync time with host"),
      col.bool("Run after power on"),
      col.bool("Run after resume"),
      col.text("Guest state"),
      col.text("Guest id"),
      col.text("Guest family"),
      col.text("DNS Name"),
      col.text("Host"),
      col.text("Annotation"),
    ],
    async rows(d) {
      const [hosts, vms] = await Promise.all([d.hostNames(), d.vmInventory()]);
      const rows = [];
      for (const vm of vms) {
        const ctx = vmContext(vm, hosts);
        if (!ctx) continue;
        rows.push([
          ctx.name,
          ctx.powerState,
          vm.str("guest.toolsStatus"),
          vm.str("guest.toolsVersionStatus"),
          vm.str("guest.toolsRunningStatus"),
          vm.str("guest.toolsVersion"),
          vm.str("config.tools.toolsUpgradePolicy"),
          vm.bool("config.tools.syncTimeWithHost"),
          vm.bool("config.tools.afterPowerOn"),
          vm.bool("config.tools.afterResume"),
          vm.str("guest.guestState"),
          vm.str("guest.guestId"),
          vm.str("guest.guestFamily"),
          vm.str("guest.hostName"),
          ctx.host,
          ctx.annotation,
        ]);
      }
      return rows;
    },
  },

  {
    name: "vHost",
    group: "Inventory",
    columns: [
      col.text("Host"),
      col.text("Cluster"),
      col.text("Config status"),
      col.bool("in Maintenance Mode"),
      col.text("Connection state"),
      col.text("Power state"),
      col.text("CPU Model"),
      col.number("Speed"),
      col.bool("HT Available"),
      col.bool("HT Active"),
      col.number("# CPU"),
      col.number("Cores per CPU"),
      col.number("# Cores"),
      col.number("# CPU Threads"),
      col.number("CPU usage %"),
      col.number("# Memory GiB"),
      col.text("Memory Tiering Type"),
      col.number("DRAM GiB"),
      col.number("NVMe Tier GiB"),
      col.number("Memory usage %"),
      col.number("# NICs"),
      col.number("# HBAs"),
      col.number("# VMs total"),
      col.number("# VMs"),
      col.number("VMs per Core"),
      col.number("# vCPUs"),
      col.number("vCPUs per Core"),
      col.number("vRAM GiB"),
      col.bool("VMotion support"),
      col.bool("Storage VMotion support"),
      col.text("Current EVC"),
      col.text("Max EVC"),
      col.text("Current CPU power man. policy"),
      col.text("ESX Version"),
      col.text("Boot time"),
      col.text("DNS Servers"),
      col.bool("DHCP"),
      col.text("Domain"),
      col.text("DNS Search Order"),
      col.text("NTP Server(s)"),
      col.bool("NTPD running"),
      col.text("Time Zone"),
      col.number("GMT Offset"),
      col.text("Vendor"),
      col.text("Model"),
      col.text("Serial number"),
      col.text("Service tag"),
      col.text("BIOS Version"),
      col.text("BIOS Date"),
      col.text("UUID"),
    ],
    async rows(d) {
      const [hosts, totals, clusters] = await Promise.all([d.hosts(), d.vmTotalsByHost(), d.clusters()]);
      const clusterOf = new Map();
      for (const c of clusters) for (const member of c.array("host")) clusterOf.set(member.textContent, c.str("name"));

      return hosts.map((host) => {
        const name = host.str("name");
        if (!name) throw new Error(`HostSystem ${host.moref} returned no name property`);
        const cores = host.num("summary.hardware.numCpuCores");
        const sockets = host.num("summary.hardware.numCpuPkgs");
        const memoryBytes = host.num("summary.hardware.memorySize");
        const mhz = host.num("summary.hardware.cpuMhz");
        const t = totals.get(host.moref) ?? { vmsTotal: 0, vmsPoweredOn: 0, vcpus: 0, vramMiB: 0 };
        // quickStats memory is MiB while memorySize is bytes.
        const usedMiB = host.num("summary.quickStats.overallMemoryUsage");
        const totalMiB = memoryBytes ? Math.floor(memoryBytes / 1024 / 1024) : null;
        return [
          name,
          clusterOf.get(host.moref) ?? null,
          host.str("overallStatus"),
          host.bool("runtime.inMaintenanceMode"),
          host.str("runtime.connectionState"),
          host.str("runtime.powerState"),
          host.str("summary.hardware.cpuModel"),
          mhz,
          host.bool("config.hyperThread.available"),
          host.bool("config.hyperThread.active"),
          sockets,
          cores !== null && sockets ? Math.trunc(cores / sockets) : null,
          cores,
          host.num("summary.hardware.numCpuThreads"),
          // Host CPU capacity is cores × per-core MHz.
          percent(host.num("summary.quickStats.overallCpuUsage"), cores !== null && mhz !== null ? cores * mhz : null),
          bytesToGiB(memoryBytes),
          memoryTieringType(host),
          bytesToGiB(memoryTierBytes(host, "DRAM")),
          bytesToGiB(memoryTierBytes(host, "NVMe")),
          percent(usedMiB, totalMiB),
          host.num("summary.hardware.numNics"),
          host.num("summary.hardware.numHBAs"),
          t.vmsTotal,
          t.vmsPoweredOn,
          ratio(t.vmsTotal, cores),
          t.vcpus,
          ratio(t.vcpus, cores),
          round2(t.vramMiB / 1024),
          host.bool("capability.vmotionSupported"),
          host.bool("capability.storageVMotionSupported"),
          host.str("summary.currentEVCModeKey"),
          host.str("summary.maxEVCModeKey"),
          host.str("hardware.cpuPowerManagementInfo.currentPolicy"),
          host.str("config.product.fullName"),
          host.str("runtime.bootTime"),
          stringArray(host, "config.network.dnsConfig.address"),
          host.bool("config.network.dnsConfig.dhcp"),
          host.str("config.network.dnsConfig.domainName"),
          stringArray(host, "config.network.dnsConfig.searchDomain"),
          stringArray(host, "config.dateTimeInfo.ntpConfig.server"),
          serviceRunning(host, "ntpd"),
          host.str("config.dateTimeInfo.timeZone.name"),
          host.num("config.dateTimeInfo.timeZone.gmtOffset"),
          host.str("summary.hardware.vendor"),
          host.str("summary.hardware.model"),
          host.str("hardware.systemInfo.serialNumber"),
          identifyingInfo(host, "ServiceTag"),
          host.str("hardware.biosInfo.biosVersion"),
          host.str("hardware.biosInfo.releaseDate"),
          host.str("summary.hardware.uuid"),
        ];
      });
    },
  },

  {
    name: "vCluster",
    group: "Inventory",
    columns: [
      col.text("Name"),
      col.number("NumHosts"),
      col.number("NumCpuCores"),
      col.number("NumCpuThreads"),
      col.number("DRAM GiB"),
      col.number("TotalMemory GiB"),
      col.bool("HA enabled"),
      col.bool("DRS enabled"),
      col.number("# VMs"),
      col.number("# vCPUs"),
      col.number("vCPUs per Core"),
    ],
    async rows(d) {
      const [clusters, hosts, totals, rest] = await Promise.all([
        d.clusters(),
        d.hosts(),
        d.vmTotalsByHost(),
        d.restClusters(),
      ]);
      const restById = new Map((rest ?? []).map((c) => [c.cluster, c]));
      const hostByMoref = new Map(hosts.map((h) => [h.moref, h]));
      return clusters.map((cluster) => {
        const name = cluster.str("name");
        if (!name) throw new Error(`ClusterComputeResource ${cluster.moref} returned no name`);
        const members = cluster.array("host").map((m) => hostByMoref.get(m.textContent)).filter(Boolean);
        const sum = (fn) => members.reduce((n, h) => n + (fn(h) ?? 0), 0);
        const cores = sum((h) => h.num("summary.hardware.numCpuCores"));
        const vcpus = sum((h) => totals.get(h.moref)?.vcpus);
        const info = restById.get(cluster.moref);
        return [
          name,
          members.length,
          cores,
          sum((h) => h.num("summary.hardware.numCpuThreads")),
          bytesToGiB(sum((h) => memoryTierBytes(h, "DRAM") ?? h.num("summary.hardware.memorySize"))),
          bytesToGiB(sum((h) => h.num("summary.hardware.memorySize"))),
          info ? Boolean(info.ha_enabled) : null,
          info ? Boolean(info.drs_enabled) : null,
          sum((h) => totals.get(h.moref)?.vmsTotal),
          vcpus,
          ratio(vcpus, cores),
        ];
      });
    },
  },

  {
    name: "vRP",
    group: "Inventory",
    columns: [
      col.text("Resource pool"),
      col.text("Cluster"),
      col.text("Status"),
      col.number("# VMs"),
      col.number("CPU limit MHz"),
      col.number("CPU reservation MHz"),
      col.text("CPU level"),
      col.number("CPU shares"),
      col.number("CPU usage MHz"),
      col.number("Memory limit MiB"),
      col.number("Memory reservation MiB"),
      col.text("Memory level"),
      col.number("Memory shares"),
      col.number("Memory consumed MiB"),
      col.number("Memory active MiB"),
    ],
    async rows(d) {
      const [pools, clusters] = await Promise.all([d.resourcePools(), d.clusters()]);
      const clusterNames = new Map(clusters.map((c) => [c.moref, c.str("name")]));
      return pools.map((pool) => {
        const name = pool.str("name");
        if (!name) throw new Error(`ResourcePool ${pool.moref} returned no name property`);
        const owner = pool.str("owner");
        return [
          name,
          owner ? clusterNames.get(owner) ?? owner : null,
          pool.str("overallStatus"),
          pool.array("vm").length,
          pool.num("config.cpuAllocation.limit"),
          pool.num("config.cpuAllocation.reservation"),
          pool.str("config.cpuAllocation.shares.level"),
          pool.num("config.cpuAllocation.shares.shares"),
          pool.num("summary.quickStats.overallCpuUsage"),
          pool.num("config.memoryAllocation.limit"),
          pool.num("config.memoryAllocation.reservation"),
          pool.str("config.memoryAllocation.shares.level"),
          pool.num("config.memoryAllocation.shares.shares"),
          pool.num("summary.quickStats.hostMemoryUsage"),
          pool.num("summary.quickStats.guestMemoryUsage"),
        ];
      });
    },
  },

  {
    name: "vDatastore",
    group: "Inventory",
    columns: [
      col.text("Name"),
      col.text("Type"),
      col.bool("Accessible"),
      col.number("# VMs"),
      col.number("Capacity GiB"),
      col.number("In Use GiB"),
      col.number("Free GiB"),
      col.number("Free %"),
      col.number("# Hosts"),
      col.text("Hosts"),
    ],
    async rows(d) {
      const [datastores, hostNames] = await Promise.all([d.datastores(), d.hostNames()]);
      return datastores
        .map((ds) => {
          const name = ds.str("name");
          if (!name) throw new Error(`Datastore ${ds.moref} returned no name property`);
          const capacity = ds.num("summary.capacity");
          const free = ds.num("summary.freeSpace");
          // Each mount is a DatastoreHostMount whose <key type="HostSystem"> names the host.
          const mounts = ds.array("host").map((m) => textAt(m, "key")).filter(Boolean);
          return [
            name,
            ds.str("summary.type"),
            ds.bool("summary.accessible"),
            ds.array("vm").length,
            bytesToGiB(capacity),
            capacity !== null && free !== null ? bytesToGiB(capacity - free) : null,
            bytesToGiB(free),
            percent(free, capacity),
            mounts.length,
            mounts.map((m) => hostNames.get(m) ?? m).sort().join(", ") || null,
          ];
        })
        .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }));
    },
  },

  {
    // Computed from inventory, not alarms: NTP, NTPD, folder-name, CD-ROM and snapshot checks.
    name: "vHealth",
    group: "Health",
    columns: [col.text("Name"), col.text("Message"), col.text("Message type")],
    async rows(d) {
      const [hosts, inventory, devices] = await Promise.all([d.hosts(), d.vmsByMoref(), d.vmDevices()]);
      const rows = [];

      // Hosts first, then VMs.
      for (const host of hosts) {
        const name = host.str("name");
        if (!name) throw new Error(`HostSystem ${host.moref} returned no name property`);
        if (host.array("config.dateTimeInfo.ntpConfig.server").every((s) => !s.textContent)) {
          rows.push([name, "NTP Server value is null!", "NTP"]);
        }
        // A host that doesn't report the service at all isn't running it.
        if (serviceRunning(host, "ntpd") !== true) {
          rows.push([name, "NTPD service is not running!", "NTPD"]);
        }
      }

      for (const vmDev of devices) {
        const name = vmDev.str("name");
        if (!name) throw new Error(`VirtualMachine ${vmDev.moref} returned no name property`);
        if (isVcls(name)) continue;

        // Case-sensitive: a VM named FLASK in folder flask is flagged.
        const path = inventory.get(vmDev.moref)?.str("config.files.vmPathName");
        const folder = path ? folderOf(path) : null;
        if (folder !== null && folder !== name) {
          rows.push([name, `Inconsistent Foldername! VMname = ${name} Foldername = ${folder}`, "Foldername"]);
        }

        // Only CD-ROM devices that are actually connected (NICs have a connectable block too).
        for (const cdrom of vmDev.array("config.hardware.device").filter((dev) => xsiType(dev) === "VirtualCdrom")) {
          if (boolAt(cdrom, "connectable/connected") === true) {
            rows.push([name, `VM has a CDROM device connected! ${textAt(cdrom, "deviceInfo/label") ?? ""}`, "CDROM"]);
          }
        }

        for (const snap of vmDev.array("snapshot.rootSnapshotList").flatMap((root) => flattenSnapshots(root))) {
          rows.push([name, `VM has an active snapshot! ${snap.name ?? ""} created on ${formatTimestamp(snap.createTime)}`, "Snapshot"]);
        }
      }
      return rows;
    },
  },
  {
    name: "vHBA",
    group: "Host network & storage",
    columns: [
      col.text("Host"),
      col.text("Device"),
      col.text("Type"),
      col.text("Status"),
      col.text("Model"),
      col.text("Driver"),
      col.text("Driver version"),
      col.text("Firmware"),
      col.text("PCI"),
      col.text("Protocol"),
      col.text("WWN / iSCSI name"),
    ],
    async rows(d) {
      const rows = [];
      for (const host of await d.hosts()) {
        const name = host.str("name");
        for (const hba of host.array("config.storageDevice.hostBusAdapter")) {
          // Fibre Channel reports world wide names as decimal numbers; iSCSI has a name instead.
          const identity = textAt(hba, "portWorldWideName") !== null
            ? wwn(numberAt(hba, "portWorldWideName"))
            : textAt(hba, "iScsiName");
          rows.push([
            name,
            textAt(hba, "device"),
            (xsiType(hba) ?? "").replace(/^Host/, ""),
            textAt(hba, "status"),
            textAt(hba, "model"),
            textAt(hba, "driver"),
            textAt(hba, "driverVersion"),
            textAt(hba, "firmwareVersion"),
            textAt(hba, "pci"),
            textAt(hba, "storageProtocol"),
            identity,
          ]);
        }
      }
      return rows;
    },
  },

  {
    name: "vNIC",
    group: "Host network & storage",
    columns: [
      col.text("Host"),
      col.text("Network Device"),
      col.text("Driver"),
      col.text("Driver version"),
      col.text("Firmware"),
      col.text("PCI"),
      col.number("Speed Mb"),
      col.bool("Duplex"),
      col.text("MAC Address"),
      col.bool("Wake on LAN"),
    ],
    async rows(d) {
      const rows = [];
      for (const host of await d.hosts()) {
        const name = host.str("name");
        for (const nic of host.array("config.network.pnic")) {
          rows.push([
            name,
            textAt(nic, "device"),
            textAt(nic, "driver"),
            textAt(nic, "driverVersion"),
            textAt(nic, "firmwareVersion"),
            textAt(nic, "pci"),
            numberAt(nic, "linkSpeed/speedMb"),
            boolAt(nic, "linkSpeed/duplex"),
            textAt(nic, "mac"),
            boolAt(nic, "wakeOnLanSupported"),
          ]);
        }
      }
      return rows;
    },
  },

  {
    // Standard switches only. Hosts that use distributed switches have none.
    name: "vSwitch",
    group: "Host network & storage",
    columns: [
      col.text("Host"),
      col.text("Switch"),
      col.number("# Ports"),
      col.number("Free Ports"),
      col.number("MTU"),
      col.bool("Promiscuous Mode"),
      col.bool("Mac Changes"),
      col.bool("Forged Transmits"),
      col.text("Uplinks"),
    ],
    async rows(d) {
      const rows = [];
      for (const host of await d.hosts()) {
        const name = host.str("name");
        for (const sw of host.array("config.network.vswitch")) {
          const uplinks = childElements(sw, "pnic").map((p) => (p.textContent ?? "").split("-").pop()).filter(Boolean);
          rows.push([
            name,
            textAt(sw, "name"),
            numberAt(sw, "numPorts"),
            numberAt(sw, "numPortsAvailable"),
            numberAt(sw, "mtu"),
            boolAt(sw, "spec/policy/security/allowPromiscuous"),
            boolAt(sw, "spec/policy/security/macChanges"),
            boolAt(sw, "spec/policy/security/forgedTransmits"),
            uplinks.join(", ") || null,
          ]);
        }
      }
      return rows;
    },
  },

  {
    // Port groups on standard switches.
    name: "vPort",
    group: "Host network & storage",
    columns: [
      col.text("Host"),
      col.text("Port Group"),
      col.text("Switch"),
      col.number("VLAN"),
      col.bool("Promiscuous Mode"),
      col.bool("Mac Changes"),
      col.bool("Forged Transmits"),
    ],
    async rows(d) {
      const rows = [];
      for (const host of await d.hosts()) {
        const name = host.str("name");
        for (const port of host.array("config.network.portgroup")) {
          rows.push([
            name,
            textAt(port, "spec/name"),
            textAt(port, "spec/vswitchName"),
            numberAt(port, "spec/vlanId"),
            // Port groups usually inherit these from the switch; computedPolicy is what applies.
            boolAt(port, "spec/policy/security/allowPromiscuous") ?? boolAt(port, "computedPolicy/security/allowPromiscuous"),
            boolAt(port, "spec/policy/security/macChanges") ?? boolAt(port, "computedPolicy/security/macChanges"),
            boolAt(port, "spec/policy/security/forgedTransmits") ?? boolAt(port, "computedPolicy/security/forgedTransmits"),
          ]);
        }
      }
      return rows;
    },
  },

  {
    // VMkernel ports: management, vMotion, storage and so on.
    name: "vSC_VMK",
    group: "Host network & storage",
    columns: [
      col.text("Host"),
      col.text("Device"),
      col.text("Port Group"),
      col.text("MAC Address"),
      col.bool("DHCP"),
      col.text("IP Address"),
      col.text("Subnet mask"),
      col.text("Gateway"),
      col.number("MTU"),
      col.bool("TSO"),
      col.text("Stack"),
    ],
    async rows(d) {
      const [hostObjects, portgroups] = await Promise.all([d.hosts(), d.dvPortgroups().catch(() => [])]);
      const dvNames = new Map((portgroups ?? []).map((pg) => [pg.str("key"), pg.str("name")]));
      const rows = [];
      for (const host of hostObjects) {
        const name = host.str("name");
        for (const vmk of host.array("config.network.vnic")) {
          // Standard switches name the port group directly; distributed ones give a key.
          const dvKey = textAt(vmk, "spec/distributedVirtualPort/portgroupKey");
          rows.push([
            name,
            textAt(vmk, "device"),
            textAt(vmk, "portgroup") ?? (dvKey ? dvNames.get(dvKey) ?? dvKey : null),
            textAt(vmk, "spec/mac"),
            boolAt(vmk, "spec/ip/dhcp"),
            textAt(vmk, "spec/ip/ipAddress"),
            textAt(vmk, "spec/ip/subnetMask"),
            textAt(vmk, "spec/ipRouteSpec/ipRouteConfig/defaultGateway"),
            numberAt(vmk, "spec/mtu"),
            boolAt(vmk, "spec/tsoEnabled"),
            textAt(vmk, "spec/netStackInstanceKey"),
          ]);
        }
      }
      return rows;
    },
  },

  {
    name: "dvSwitch",
    group: "Distributed switch",
    columns: [
      col.text("Switch"),
      col.text("Vendor"),
      col.text("Version"),
      col.number("# Ports"),
      col.number("Max Ports"),
      col.number("# Hosts"),
      col.text("Created"),
      col.text("UUID"),
    ],
    async rows(d) {
      return (await d.dvSwitches()).map((sw) => {
        const product = sw.props.get("summary.productInfo");
        return [
          sw.str("name"),
          product && textAt(product, "vendor"),
          product && textAt(product, "version"),
          sw.num("summary.numPorts"),
          sw.num("config.maxPorts"),
          sw.array("summary.hostMember").length,
          sw.str("config.createTime"),
          sw.str("uuid"),
        ];
      });
    },
  },

  {
    name: "dvPort",
    group: "Distributed switch",
    columns: [
      col.text("Port Group"),
      col.text("Switch"),
      col.number("# Ports"),
      col.text("Type"),
      col.text("VLAN"),
      col.bool("Promiscuous Mode"),
      col.bool("Mac Changes"),
      col.bool("Forged Transmits"),
    ],
    async rows(d) {
      const [portgroups, switches] = await Promise.all([d.dvPortgroups(), d.dvSwitches()]);
      const switchNames = new Map(switches.map((sw) => [sw.moref, sw.str("name")]));
      return portgroups.map((pg) => {
        const config = pg.props.get("config.defaultPortConfig");
        const sw = pg.str("config.distributedVirtualSwitch");
        return [
          pg.str("name"),
          sw ? switchNames.get(sw) ?? sw : null,
          pg.num("config.numPorts"),
          pg.str("config.type"),
          dvVlan(config),
          config && dvBool(config, "securityPolicy/allowPromiscuous"),
          config && dvBool(config, "securityPolicy/macChanges"),
          config && dvBool(config, "securityPolicy/forgedTransmits"),
        ];
      });
    },
  },

  {
    // Live counters from vCenter, newest sample per host.
    name: "vHost Performance",
    group: "Performance",
    columns: [
      col.text("Host"),
      col.number("CPU Usage (%)"),
      col.number("CPU Usage MHz"),
      col.number("Memory Usage (%)"),
      col.number("Memory Consumed GiB"),
      col.number("Network KBps"),
      col.number("Disk KBps"),
      col.text("Sampled"),
    ],
    async rows(d) {
      const hosts = await d.hosts();
      // Only connected hosts report counters.
      const connected = hosts.filter((h) => h.str("runtime.connectionState") === "connected");
      const samples = await d.perfSamples("hostPerf", "HostSystem", connected.map((h) => h.moref), HOST_COUNTERS);
      return hosts.map((host) => {
        const sample = samples.get(host.moref);
        const value = (key) => sample?.get(key) ?? null;
        const consumed = value("memoryConsumed");
        return [
          host.str("name"),
          // vCenter reports percentages in hundredths of a percent.
          value("cpuPercent") === null ? null : round2(value("cpuPercent") / 100),
          value("cpuMhz"),
          value("memoryPercent") === null ? null : round2(value("memoryPercent") / 100),
          consumed === null ? null : round2(consumed / 1024 / 1024),
          value("network"),
          value("disk"),
          sample?.get("sampledAt") ?? null,
        ];
      });
    },
  },

  {
    name: "vInfo Performance",
    group: "Performance",
    columns: [
      col.text("VM"),
      col.text("Powerstate"),
      col.number("CPU Usage (%)"),
      col.number("CPU Usage MHz"),
      col.number("Memory Usage (%)"),
      col.number("Memory Active MiB"),
      col.number("Memory Consumed MiB"),
      col.number("Network KBps"),
      col.number("Disk KBps"),
      col.text("Host"),
      col.text("Sampled"),
    ],
    async rows(d) {
      const [hosts, vms] = await Promise.all([d.hostNames(), d.vmInventory()]);
      const listed = vms.filter((vm) => vmContext(vm, hosts));
      // Powered-off VMs have no counters.
      const running = listed.filter((vm) => vm.str("runtime.powerState") === "poweredOn");
      const samples = await d.perfSamples("vmPerf", "VirtualMachine", running.map((vm) => vm.moref), VM_COUNTERS);
      return listed.map((vm) => {
        const ctx = vmContext(vm, hosts);
        const sample = samples.get(vm.moref);
        const value = (key) => sample?.get(key) ?? null;
        return [
          ctx.name,
          ctx.powerState,
          value("cpuPercent") === null ? null : round2(value("cpuPercent") / 100),
          value("cpuMhz"),
          value("memoryPercent") === null ? null : round2(value("memoryPercent") / 100),
          value("memoryActive") === null ? null : round2(value("memoryActive") / 1024),
          value("memoryConsumed") === null ? null : round2(value("memoryConsumed") / 1024),
          value("network"),
          value("disk"),
          ctx.host,
          sample?.get("sampledAt") ?? null,
        ];
      });
    },
  },

  {
    name: "vSource",
    group: "System",
    columns: [
      col.text("Name"),
      col.text("Full name"),
      col.text("Vendor"),
      col.text("Version"),
      col.text("Build"),
      col.text("API version"),
      col.text("API type"),
      col.text("OS type"),
      col.text("Instance UUID"),
      col.text("License product"),
    ],
    async rows(d) {
      const content = await d.serviceContent();
      const about = childElement(content, "about");
      if (!about) return [];
      return [[
        textAt(about, "name"),
        textAt(about, "fullName"),
        textAt(about, "vendor"),
        textAt(about, "version"),
        textAt(about, "build"),
        textAt(about, "apiVersion"),
        textAt(about, "apiType"),
        textAt(about, "osType"),
        textAt(about, "instanceUuid"),
        textAt(about, "licenseProductName"),
      ]];
    },
  },

  {
    name: "vLicense",
    group: "System",
    columns: [
      col.text("Name"),
      col.text("Key"),
      col.text("Edition"),
      col.text("Cost unit"),
      col.number("Total"),
      col.number("Used"),
      col.number("Available"),
      col.text("Expires"),
    ],
    async rows(d) {
      return (await d.licenses()).map((license) => {
        const total = numberAt(license, "total");
        const used = numberAt(license, "used");
        // Extra details arrive as key/value pairs rather than named fields.
        const property = (key) =>
          childElements(license, "properties").find((p) => textAt(p, "key") === key);
        const expiry = property("expirationDate") ?? property("ExpirationDate");
        return [
          textAt(license, "name"),
          textAt(license, "licenseKey"),
          textAt(license, "editionKey"),
          textAt(license, "costUnit"),
          total,
          used,
          total !== null && used !== null ? total - used : null,
          expiry ? textAt(expiry, "value") : "Never",
        ];
      });
    },
  },

  {
    name: "vMetaData",
    group: "System",
    columns: [
      col.text("Tool"),
      col.text("Tool version"),
      col.text("Collected"),
      col.text("vCenter"),
      col.text("vCenter version"),
      col.text("Username"),
    ],
    async rows(d) {
      const content = await d.serviceContent();
      const about = childElement(content, "about");
      return [[
        "DBH Insights",
        typeof APP_VERSION === "string" ? APP_VERSION : "",
        new Date().toISOString(),
        d.vc.host,
        about ? `${textAt(about, "version")} build ${textAt(about, "build")}` : null,
        d.vc.username,
      ]];
    },
  },

];

/**
 * Build one sheet across several vCenters. A vCenter that fails contributes a warning
 * and the others still load: a short list that looks complete is the worst outcome.
 */
async function buildTable(sheet, dataList) {
  const table = {
    name: sheet.name,
    columns: [...sheet.columns, col.text(VI_SDK_SERVER)],
    rows: [],
    warnings: [],
  };
  const results = await Promise.allSettled(dataList.map((d) => sheet.rows(d)));
  results.forEach((result, i) => {
    const server = dataList[i].vc.name;
    if (result.status === "fulfilled") {
      for (const row of result.value) table.rows.push([...row, server]);
    } else {
      table.warnings.push(`${server}: ${result.reason?.message ?? result.reason}`);
    }
  });
  return table;
}
