// Talks to the DBH Insights Helper running on the user's machine.
// The helper is a thin pass-through: every vCenter REST and SOAP call is decided here, on the website.

const DEFAULT_HELPER_URL = "http://127.0.0.1:8765";

class HelperError extends Error {
  // kind: helper_offline | origin_not_allowed | not_configured | vcenter_required | unknown_vcenter |
  //       vcenter_auth_failed | vcenter_unreachable | read_only | bad_path | soap_not_allowed |
  //       bad_request | forbidden_host
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

class VcenterError extends Error {
  constructor(status, data, message) {
    const detail = data?.messages?.[0]?.default_message ?? data?.error_type ?? "";
    super(message ?? `vCenter returned HTTP ${status}${detail ? `: ${detail}` : ""}`);
    this.status = status;
    this.data = data;
  }
}

/** First element anywhere under `node` with this local name, ignoring namespaces. */
function firstByLocalName(node, name) {
  return node.getElementsByTagNameNS("*", name)[0] ?? null;
}

const HelperClient = {
  get url() {
    try {
      return localStorage.getItem("helperUrl") || DEFAULT_HELPER_URL;
    } catch {
      return DEFAULT_HELPER_URL;
    }
  },

  set url(value) {
    try {
      localStorage.setItem("helperUrl", value.replace(/\/+$/, ""));
    } catch { /* storage unavailable; keep default */ }
  },

  async _fetch(path, options) {
    try {
      return await fetch(`${this.url}${path}`, { cache: "no-store", ...options });
    } catch {
      // Network-level failure: helper not running, wrong port, or the browser blocked local access.
      throw new HelperError(
        "helper_offline",
        `Can't reach the DBH Insights Helper at ${this.url}. Make sure it's running, and allow local network access if your browser asks.`,
      );
    }
  },

  _post(path, payload) {
    return this._fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  /** Throws the helper's own error, if the response carries one. */
  _helperError(res, text) {
    const kind = res.headers.get("x-helper-error");
    if (!kind) return;
    let message = text;
    try {
      message = JSON.parse(text).error.message;
    } catch { /* keep raw text */ }
    throw new HelperError(kind, message);
  },

  /** GET /status -> { helper, version, originAllowed, configured, vcenters: [{id, name, host, username}], capabilities } */
  async status() {
    const res = await this._fetch("/status");
    return res.json();
  },

  /** Pass a REST request through to one vCenter. Returns parsed JSON (or text), throws HelperError / VcenterError. */
  async call(method, path, body, vcenter) {
    const res = await this._post("/proxy", { vcenter: vcenter ?? null, method, path, body: body ?? null });
    const text = await res.text();
    this._helperError(res, text);
    let data = text;
    try {
      data = text ? JSON.parse(text) : null;
    } catch { /* not JSON */ }
    if (!res.ok) throw new VcenterError(res.status, data);
    return data;
  },

  /**
   * Send one read-only vim25 SOAP operation (e.g. `<vim25:RetrievePropertiesEx>…`) to a vCenter.
   * The helper adds the envelope and session. Returns the parsed response XML Document.
   */
  async soap(vcenter, operation) {
    const res = await this._post("/soap", { vcenter: vcenter ?? null, body: operation });
    const text = await res.text();
    this._helperError(res, text);

    const doc = new DOMParser().parseFromString(text, "text/xml");
    if (doc.querySelector("parsererror")) {
      throw new VcenterError(res.status, null, `vCenter returned an unreadable SOAP response (HTTP ${res.status}).`);
    }
    const fault = firstByLocalName(doc, "Fault");
    if (fault) {
      const message =
        firstByLocalName(fault, "localizedMessage")?.textContent ||
        firstByLocalName(fault, "faultstring")?.textContent ||
        "unspecified SOAP fault";
      throw new VcenterError(res.status, null, `vCenter SOAP fault: ${message}`);
    }
    if (!res.ok) throw new VcenterError(res.status, null, `vCenter SOAP call returned HTTP ${res.status}.`);
    return doc;
  },

  /** API bound to one vCenter. This is what the sheet builders receive. */
  forVcenter(id) {
    return {
      get: (path) => this.call("GET", path, null, id),
      call: (method, path, body) => this.call(method, path, body, id),
      soap: (operation) => this.soap(id, operation),
    };
  },
};
