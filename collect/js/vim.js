// vim25 SOAP querying: RetrievePropertiesEx over a ContainerView of one object type.
//
// The biggest gotcha in vim25 responses: elements of a top-level array property are
// named after the property's declared *type*, not its field name
// (config.hardware.device comes back as <VirtualDevice xsi:type="VirtualDisk">),
// while arrays nested inside a data object repeat the field name (<childSnapshotList>).
// ManagedObject.array() returns the element children, so callers never depend on
// those names and filter on xsiType() instead.

const XSI_NS = "http://www.w3.org/2001/XMLSchema-instance";

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);
}

function childElement(el, name) {
  for (const c of el.children) if (c.localName === name) return c;
  return null;
}

function childElements(el, name) {
  return [...el.children].filter((c) => c.localName === name);
}

/** Text at a slash-separated child path, or null when any step is missing. Empty text is null too. */
function textAt(el, path) {
  let node = el;
  for (const part of path.split("/")) {
    if (!node) return null;
    node = childElement(node, part);
  }
  const text = node?.textContent;
  return text ? text : null;
}

function numberAt(el, path) {
  const text = textAt(el, path);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function boolAt(el, path) {
  const text = textAt(el, path);
  return text === "true" ? true : text === "false" ? false : null;
}

/** The concrete type of a polymorphic element, without any namespace prefix. */
function xsiType(el) {
  const value = el?.getAttributeNS(XSI_NS, "type") || el?.getAttribute("xsi:type");
  return value ? value.replace(/^.*:/, "") : null;
}

/** One managed object plus the properties that were asked for. */
class ManagedObject {
  constructor(objectsEl) {
    const obj = childElement(objectsEl, "obj");
    this.moref = obj?.textContent ?? "";
    this.type = obj?.getAttribute("type") ?? "";
    this.props = new Map();
    for (const propSet of childElements(objectsEl, "propSet")) {
      const name = childElement(propSet, "name")?.textContent;
      const val = childElement(propSet, "val");
      if (name && val) this.props.set(name, val);
    }
  }

  /** Scalar property as text; null when absent or empty. */
  str(name) {
    const text = this.props.get(name)?.textContent;
    return text ? text : null;
  }

  num(name) {
    const text = this.str(name);
    if (text === null) return null;
    const n = Number(text);
    return Number.isFinite(n) ? n : null;
  }

  bool(name) {
    const text = this.str(name);
    if (text === "true" || text === "1") return true;
    if (text === "false" || text === "0") return false;
    return null;
  }

  /** Members of an array-valued property. */
  array(name) {
    const val = this.props.get(name);
    return val ? [...val.children] : [];
  }
}

/**
 * Retrieve `props` for one object whose moref is already known (LicenseManager,
 * PerformanceManager, …). These sit outside the inventory, so no container view applies.
 */
async function retrieveObject(api, type, moref, props) {
  const pathSet = props.map((p) => `<vim25:pathSet>${xmlEscape(p)}</vim25:pathSet>`).join("");
  const doc = await api.soap(
    `<vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>` +
      `<vim25:specSet><vim25:propSet><vim25:type>${xmlEscape(type)}</vim25:type>${pathSet}</vim25:propSet>` +
      `<vim25:objectSet><vim25:obj type="${xmlEscape(type)}">${xmlEscape(moref)}</vim25:obj>` +
      `<vim25:skip>false</vim25:skip></vim25:objectSet></vim25:specSet><vim25:options/></vim25:RetrievePropertiesEx>`,
  );
  const returnval = firstByLocalName(doc, "returnval");
  const objects = returnval ? childElements(returnval, "objects") : [];
  return objects.length ? new ManagedObject(objects[0]) : null;
}

/**
 * ServiceContent: vCenter's own version details (`about`) plus the morefs for the
 * licence and performance managers. Needs no inventory access.
 */
async function serviceContent(api) {
  const doc = await api.soap(
    `<vim25:RetrieveServiceContent><vim25:_this type="ServiceInstance">ServiceInstance</vim25:_this></vim25:RetrieveServiceContent>`,
  );
  const returnval = firstByLocalName(doc, "returnval");
  if (!returnval) throw new Error("RetrieveServiceContent returned nothing");
  return returnval;
}

/** Performance counter ids, keyed "group.name.rollup" (e.g. "cpu.usage.average"). */
async function perfCounterIds(api, perfManager) {
  const manager = await retrieveObject(api, "PerformanceManager", perfManager, ["perfCounter"]);
  const ids = new Map();
  for (const counter of manager?.array("perfCounter") ?? []) {
    const key = textAt(counter, "key");
    const group = textAt(counter, "groupInfo/key");
    const name = textAt(counter, "nameInfo/key");
    const rollup = textAt(counter, "rollupType");
    if (key && group && name && rollup) ids.set(`${group}.${name}.${rollup}`, key);
  }
  return ids;
}

/**
 * The most recent sample of `counters` for each entity, in one QueryPerf call.
 * `counters` maps a column key to a counter id. Returns Map moref → Map column key → number.
 * Entities with no data (powered off, no provider) are simply absent.
 */
async function queryPerf(api, entityType, morefs, counters, intervalId = 20) {
  if (!morefs.length || counters.size === 0) return new Map();
  const metricIds = [...counters.values()]
    .map((id) => `<vim25:metricId><vim25:counterId>${xmlEscape(id)}</vim25:counterId><vim25:instance></vim25:instance></vim25:metricId>`)
    .join("");
  const specs = morefs
    .map(
      (moref) =>
        `<vim25:querySpec><vim25:entity type="${xmlEscape(entityType)}">${xmlEscape(moref)}</vim25:entity>` +
        `<vim25:maxSample>1</vim25:maxSample>${metricIds}<vim25:intervalId>${xmlEscape(intervalId)}</vim25:intervalId></vim25:querySpec>`,
    )
    .join("");
  const doc = await api.soap(
    `<vim25:QueryPerf><vim25:_this type="PerformanceManager">${xmlEscape(api.perfManager ?? "PerfMgr")}</vim25:_this>${specs}</vim25:QueryPerf>`,
  );

  const byCounterId = new Map([...counters].map(([column, id]) => [id, column]));
  const samples = new Map();
  for (const metric of doc.getElementsByTagNameNS("*", "returnval")) {
    const entity = childElement(metric, "entity")?.textContent;
    if (!entity) continue;
    const values = new Map();
    for (const series of childElements(metric, "value")) {
      const column = byCounterId.get(textAt(series, "id/counterId"));
      const value = Number(childElement(series, "value")?.textContent);
      // Aggregate (instance-less) series only; per-device series repeat the counter.
      if (column && Number.isFinite(value) && !textAt(series, "id/instance")) values.set(column, value);
    }
    values.set("sampledAt", textAt(metric, "sampleInfo/timestamp"));
    samples.set(entity, values);
  }
  return samples;
}

/**
 * Retrieve `props` for every managed object of `type` in the inventory.
 *
 * Follows the continuation token: silently accepting a truncated result would
 * under-report the inventory, which is the worst failure an inventory tool can have.
 */
async function retrieve(api, type, props) {
  const created = await api.soap(
    `<vim25:CreateContainerView><vim25:_this type="ViewManager">ViewManager</vim25:_this>` +
      `<vim25:container type="Folder">group-d1</vim25:container><vim25:type>${xmlEscape(type)}</vim25:type>` +
      `<vim25:recursive>true</vim25:recursive></vim25:CreateContainerView>`,
  );
  const view = firstByLocalName(created, "returnval")?.textContent;
  if (!view) throw new Error(`CreateContainerView for ${type} returned no view`);

  try {
    const pathSet = props.map((p) => `<vim25:pathSet>${xmlEscape(p)}</vim25:pathSet>`).join("");
    let page = await api.soap(
      `<vim25:RetrievePropertiesEx><vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>` +
        `<vim25:specSet><vim25:propSet><vim25:type>${xmlEscape(type)}</vim25:type>${pathSet}</vim25:propSet>` +
        `<vim25:objectSet><vim25:obj type="ContainerView">${xmlEscape(view)}</vim25:obj><vim25:skip>true</vim25:skip>` +
        `<vim25:selectSet xsi:type="vim25:TraversalSpec"><vim25:name>view</vim25:name><vim25:type>ContainerView</vim25:type>` +
        `<vim25:path>view</vim25:path><vim25:skip>false</vim25:skip></vim25:selectSet></vim25:objectSet>` +
        `</vim25:specSet><vim25:options/></vim25:RetrievePropertiesEx>`,
    );

    const objects = [];
    for (;;) {
      const returnval = firstByLocalName(page, "returnval");
      if (!returnval) break; // no matching objects at all
      for (const el of childElements(returnval, "objects")) objects.push(new ManagedObject(el));
      const token = childElement(returnval, "token")?.textContent;
      if (!token) break;
      page = await api.soap(
        `<vim25:ContinueRetrievePropertiesEx><vim25:_this type="PropertyCollector">propertyCollector</vim25:_this>` +
          `<vim25:token>${xmlEscape(token)}</vim25:token></vim25:ContinueRetrievePropertiesEx>`,
      );
    }
    return objects;
  } finally {
    // Views live on the session until logout; drop this one either way.
    api
      .soap(`<vim25:DestroyView><vim25:_this type="ContainerView">${xmlEscape(view)}</vim25:_this></vim25:DestroyView>`)
      .catch(() => {});
  }
}
