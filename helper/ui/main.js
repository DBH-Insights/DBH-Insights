const { invoke } = window.__TAURI__.core;

const $ = (id) => document.getElementById(id);

let settings = null;
let editingId = null; // null = editor closed, "" = adding a new vCenter, otherwise the id being edited
let generalLoaded = false;
// The port the website looks for the helper on unless told otherwise.
const DEFAULT_PORT = 8765;

// ---------- helpers ----------

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, onClick) {
  const node = el("button", "", label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

function setMessage(node, text, kind = "") {
  node.textContent = text;
  node.className = kind ? `msg ${kind}` : "msg";
}

function listMessage(id, text, kind) {
  const item = [...$("vcenterList").children].find((li) => li.dataset.id === id);
  if (item) setMessage(item.querySelector(".msg"), text, kind);
}

// ---------- rendering ----------

/** Grow the allowed-websites box to show every entry, so none hide behind a scrollbar. */
function fitOrigins() {
  const box = $("allowedOrigins");
  const lines = box.value.split("\n").length;
  box.rows = Math.max(3, lines + 1);
}

async function load() {
  settings = await invoke("get_settings");
  if (!generalLoaded) {
    $("allowedOrigins").value = settings.allowedOrigins.join("\n");
    fitOrigins();
    $("allowLocalFiles").checked = settings.allowLocalFiles;
    $("port").value = settings.port;
    generalLoaded = true;
  }
  renderServer();
  renderList();
}

function renderServer() {
  const { server } = settings;
  const pill = $("server");
  if (server.listening) {
    pill.textContent = `Listening on http://127.0.0.1:${server.port}`;
    pill.className = "pill ok";
  } else if (server.error) {
    pill.textContent = server.error;
    pill.className = "pill bad";
  } else {
    pill.textContent = "Starting…";
    pill.className = "pill";
    setTimeout(() => load().catch(() => {}), 500);
  }
  $("portHint").hidden = Number($("port").value) === DEFAULT_PORT;
}

function renderList() {
  const list = $("vcenterList");
  list.replaceChildren();
  $("emptyList").hidden = settings.vcenters.length > 0;

  for (const vc of settings.vcenters) {
    const item = el("li", "vc");
    item.dataset.id = vc.id;

    const info = el("div", "vc-info");
    info.append(el("div", "vc-name", vc.name), el("div", "vc-sub", `${vc.username} @ ${vc.host}`));

    const badge = vc.hasPassword
      ? el("span", "badge", "Password saved")
      : el("span", "badge bad", "No password");

    const actions = el("div", "vc-actions");
    const del = button("Delete", () => armDelete(del, vc));
    del.classList.add("danger");
    actions.append(
      button("Test", () => testVcenter(vc.id)),
      button("Edit", () => openEditor(vc)),
      del,
    );

    item.append(info, badge, actions, el("p", "msg"));
    list.append(item);
  }
}

// ---------- vCenter actions ----------

async function testVcenter(id) {
  listMessage(id, "Testing…");
  try {
    listMessage(id, await invoke("test_vcenter", { id }), "ok");
  } catch (err) {
    listMessage(id, String(err), "bad");
  }
}

// The webview has no reliable confirm() dialog, so Delete needs a second click.
function armDelete(node, vc) {
  if (node.dataset.armed) {
    deleteVcenter(vc);
    return;
  }
  node.dataset.armed = "1";
  node.textContent = "Click again to delete";
  setTimeout(() => {
    delete node.dataset.armed;
    node.textContent = "Delete";
  }, 4000);
}

async function deleteVcenter(vc) {
  try {
    await invoke("delete_vcenter", { id: vc.id });
    if (editingId === vc.id) closeEditor();
    await load();
  } catch (err) {
    listMessage(vc.id, String(err), "bad");
  }
}

function openEditor(vc) {
  editingId = vc ? vc.id : "";
  $("editorTitle").textContent = vc ? `Edit ${vc.name}` : "Add vCenter";
  $("vcName").value = vc ? vc.name : "";
  $("vcHost").value = vc ? vc.host : "";
  $("vcUser").value = vc ? vc.username : "";
  $("vcInsecure").checked = vc ? vc.acceptInvalidCerts : true;
  $("vcPassword").value = "";
  $("vcPassword").placeholder = vc?.hasPassword ? "Saved in keychain (leave blank to keep)" : "Required";
  setMessage($("editorMessage"), "");
  $("editor").hidden = false;
  $("addVcenter").disabled = true;
  (vc ? $("vcPassword") : $("vcHost")).focus();
}

function closeEditor() {
  editingId = null;
  $("editor").hidden = true;
  $("addVcenter").disabled = false;
}

async function saveEditor(thenTest) {
  if (!$("editor").reportValidity()) return;
  const password = $("vcPassword").value;
  if (editingId === "" && !password) {
    setMessage($("editorMessage"), "Enter the password for this vCenter.", "bad");
    $("vcPassword").focus();
    return;
  }
  try {
    const id = await invoke("save_vcenter", {
      vcenter: {
        id: editingId,
        name: $("vcName").value,
        host: $("vcHost").value,
        username: $("vcUser").value,
        acceptInvalidCerts: $("vcInsecure").checked,
      },
      password: password || null,
    });
    closeEditor();
    await load();
    if (thenTest) await testVcenter(id);
    else listMessage(id, "Saved.", "ok");
  } catch (err) {
    setMessage($("editorMessage"), String(err), "bad");
  }
}

$("addVcenter").addEventListener("click", () => openEditor(null));
$("editor").addEventListener("submit", (event) => {
  event.preventDefault();
  saveEditor(false);
});
$("editorTest").addEventListener("click", () => saveEditor(true));
$("editorCancel").addEventListener("click", closeEditor);

// ---------- general settings ----------

$("allowedOrigins").addEventListener("input", fitOrigins);

$("port").addEventListener("input", () => {
  $("portHint").hidden = Number($("port").value) === DEFAULT_PORT;
});

$("general").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await invoke("save_general", {
      settings: {
        port: Number($("port").value),
        allowedOrigins: $("allowedOrigins").value.split("\n"),
        allowLocalFiles: $("allowLocalFiles").checked,
      },
    });
    generalLoaded = false;
    await load();
    setMessage($("generalMessage"), `Saved. Listening on http://127.0.0.1:${settings.server.port}.`, "ok");
  } catch (err) {
    setMessage($("generalMessage"), String(err), "bad");
  }
});

// ---------- window sizing ----------

// Size the window so every field is visible without scrolling, keeping the user's width.
// Re-runs whenever the content height changes (editor opening, messages, list changes).
async function fitWindow() {
  const { getCurrentWindow } = window.__TAURI__.window;
  const { LogicalSize } = window.__TAURI__.dpi;
  const win = getCurrentWindow();
  const scale = await win.scaleFactor();
  const current = (await win.innerSize()).toLogical(scale);
  // Measure <main>, not the document: the document is never shorter than the window.
  const content = Math.ceil(document.querySelector("main").getBoundingClientRect().height);
  const maxHeight = window.screen.availHeight - 60;
  const height = Math.min(content, maxHeight);
  if (Math.abs(current.height - height) > 1) {
    await win.setSize(new LogicalSize(current.width, height));
  }
}

let fitQueued = false;
new ResizeObserver(() => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitWindow().catch((err) => console.error("fitWindow", err));
  });
}).observe(document.querySelector("main"));

load()
  .then(() => {
    if (settings.vcenters.length === 0) openEditor(null);
  })
  .catch((err) => setMessage($("generalMessage"), String(err), "bad"))
  .finally(() => fitWindow().catch((err) => console.error("fitWindow", err)));
