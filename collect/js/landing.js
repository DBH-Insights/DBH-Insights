// DBH Insights landing page: release notes, the screenshot tour, and version text.
// Like the app, it builds nodes with createElement and textContent, never innerHTML.

(() => {
  const $ = (id) => document.getElementById(id);

  function make(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** Text with `backtick` spans turned into <code>. */
  function richText(parent, text) {
    text.split("`").forEach((part, i) => {
      if (!part) return;
      parent.append(i % 2 ? make("code", "", part) : document.createTextNode(part));
    });
    return parent;
  }

  /** "2026-09-17" → "September 17, 2026", fixed to UTC so the day never shifts with the time zone. */
  function formatDate(iso) {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    });
  }

  const GROUPS = [
    ["new", "New"],
    ["improved", "Improved"],
    ["fixed", "Fixed"],
    ["security", "Security"],
    ["docs", "Documentation"],
  ];

  function renderReleases(notes) {
    const box = $("releases");
    box.replaceChildren();

    notes.forEach((release, index) => {
      const latest = index === 0;
      const details = make("details", `release${latest ? " latest" : ""}`);
      details.id = `v${release.version}`;
      // The newest release starts open; older ones stay tidy until asked for.
      details.open = latest;

      const summary = make("summary");
      summary.append(make("span", "version", `v${release.version}`));
      summary.append(make("span", "release-title", release.title));
      const meta = make("span", "release-meta");
      const time = make("time", "", formatDate(release.date));
      time.dateTime = release.date;
      meta.append(time);
      if (latest) meta.append(make("span", "chip chip-latest", "Latest"));
      if (release.helper) meta.append(make("span", "chip", `Helper ${release.helper}`));
      meta.append(make("span", "", `${release.changes.length} change${release.changes.length === 1 ? "" : "s"}`));
      summary.append(meta);
      details.append(summary);

      const body = make("div", "release-body");
      for (const [type, label] of GROUPS) {
        const items = release.changes.filter((c) => c.type === type);
        if (!items.length) continue;
        const group = make("section", "change-group");
        group.dataset.type = type;
        group.append(make("h4", "", label));
        const list = make("ul");
        for (const item of items) list.append(richText(make("li"), item.text));
        group.append(list);
        body.append(group);
      }
      // Screenshots for this release, if it has any.
      for (const shot of release.images ?? []) {
        const figure = make("figure", "release-shot");
        const img = make("img");
        img.src = shot.src;
        img.alt = shot.alt ?? "";
        img.loading = "lazy";
        if (shot.width) img.width = shot.width;
        if (shot.height) img.height = shot.height;
        figure.append(img);
        if (shot.caption) figure.append(make("figcaption", "", shot.caption));
        body.append(figure);
      }

      details.append(body);
      box.append(details);
    });
  }

  function renderVersion(notes) {
    const current = notes[0];
    $("whatsNewText").textContent = `v${current.version}: ${current.title}`;
    $("whatsNew").href = `#v${current.version}`;
    $("footerVersion").textContent = `Version ${current.version} · ${formatDate(current.date)}`;
  }

  /** Opening a release by link (the hero pill, or a shared #v0.3.0 URL) expands it first. */
  function openLinkedRelease() {
    const target = location.hash.slice(1);
    if (!target.startsWith("v")) return;
    const release = document.getElementById(target);
    if (release && release.tagName === "DETAILS") {
      release.open = true;
      release.scrollIntoView({ block: "start" });
    }
  }


  // ---- helper downloads ----

  const PLATFORM_ICONS = {
    mac: "M15.2 12.6c0-2.2 1.8-3.3 1.9-3.4-1-1.5-2.7-1.7-3.3-1.7-1.4-.1-2.7.8-3.4.8-.7 0-1.8-.8-3-.8-1.5 0-2.9.9-3.7 2.3-1.6 2.7-.4 6.8 1.1 9 .8 1.1 1.7 2.3 2.9 2.3 1.2 0 1.6-.7 3-.7s1.8.7 3 .7 2-1.1 2.8-2.2c.9-1.2 1.2-2.4 1.2-2.5-.1 0-2.4-.9-2.5-3.8ZM13 5.9c.6-.8 1-1.8.9-2.9-.9 0-2 .6-2.6 1.4-.6.7-1.1 1.7-.9 2.8 1 0 2-.5 2.6-1.3Z",
    windows: "M3 5.8 10 4.8v6.7H3V5.8Zm0 12.4 7 1v-6.6H3v5.6Zm8.2 1.2L21 20.8V12.9h-9.8v6.5Zm0-15.6v6.6H21V3.2l-9.8 1.6Z",
    linux: "M12 2.5c-2.4 0-3.6 2-3.4 4.6.1 1.6-.2 2.4-1 3.6C6.3 12.7 5.4 14.4 5.4 16c0 1 .4 1.6 1 2.2.4.4.3.9.2 1.3-.1.5.2.9.8 1 1 .1 1.7-.2 2.2-.7.4-.4.9-.5 1.4-.5h2c.5 0 1 .1 1.4.5.5.5 1.2.8 2.2.7.6-.1.9-.5.8-1-.1-.4-.2-.9.2-1.3.6-.6 1-1.2 1-2.2 0-1.6-.9-3.3-2.2-5.3-.8-1.2-1.1-2-1-3.6.2-2.6-1-4.6-3.4-4.6Z M10.2 7.4v.1M13.8 7.4v.1",
  };

  function iconFor(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "dl-icon");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", PLATFORM_ICONS[id] ?? "");
    svg.append(path);
    return svg;
  }

  /** The visitor's platform, so their card can be marked. Unknown platforms mark nothing. */
  function currentPlatform(platforms) {
    const name = navigator.userAgentData?.platform || navigator.platform || "";
    return platforms.find((p) => p.detect.test(name))?.id ?? null;
  }

  function renderDownloads(config) {
    const box = $("downloads");
    if (!box) return;
    box.replaceChildren();
    const mine = currentPlatform(config.platforms);

    for (const platform of config.platforms) {
      const card = make("article", `dl-card${platform.id === mine ? " mine" : ""}${platform.file ? "" : " unavailable"}`);
      card.append(iconFor(platform.id));

      const head = make("div", "dl-head");
      head.append(make("h3", "", platform.name));
      if (platform.id === mine) head.append(make("span", "chip chip-latest", "Your platform"));
      card.append(head);
      card.append(make("p", "dl-note", platform.note));

      if (platform.file) {
        const link = make("a", "btn btn-primary dl-btn");
        // encodeURI keeps the spaces in the file name valid in a URL.
        link.href = encodeURI(config.folder + platform.file);
        link.append(make("span", "", `Download ${platform.kind ?? "installer"}`));
        link.append(make("span", "dl-size", platform.size ?? ""));
        // The file is served from this site, so a plain link downloads it.
        link.setAttribute("download", "");
        card.append(link);
        card.append(make("p", "dl-file", platform.file));
      } else {
        card.append(make("p", "dl-btn dl-none", "No build yet"));
      }

      if (platform.tip) card.append(richText(make("p", "dl-tip"), platform.tip));
      box.append(card);
    }

    const version = $("downloadVersion");
    if (version) version.textContent = `Helper ${config.version} · works with this website`;
  }

  // ---- screenshot tour: an ARIA tab list with arrow-key movement ----

  function setupTour() {
    const tabs = [...document.querySelectorAll(".tour-tabs [role=tab]")];
    const img = $("tourImg");
    const caption = $("tourCaption");
    const panel = $("panel-tour");
    if (!tabs.length || !img) return;

    // Fetch the other screens once the page is idle, so switching is instant.
    const preload = () => tabs.forEach((t) => { new Image().src = t.dataset.img; });
    if ("requestIdleCallback" in window) requestIdleCallback(preload);
    else setTimeout(preload, 1500);

    function select(tab, focus) {
      for (const t of tabs) {
        const on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
      }
      if (focus) tab.focus();
      panel.setAttribute("aria-labelledby", tab.id);
      if (img.getAttribute("src") === tab.dataset.img) return;
      img.classList.add("swapping");
      const next = new Image();
      next.onload = next.onerror = () => {
        img.src = tab.dataset.img;
        img.alt = tab.dataset.alt;
        caption.textContent = tab.dataset.caption;
        img.classList.remove("swapping");
      };
      next.src = tab.dataset.img;
    }

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => select(tab, false));
      tab.addEventListener("keydown", (event) => {
        const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 };
        if (!(event.key in moves)) return;
        event.preventDefault();
        select(tabs[(moves[event.key] + tabs.length) % tabs.length], true);
      });
    });
  }

  if (typeof RELEASE_NOTES !== "undefined" && RELEASE_NOTES.length) {
    renderReleases(RELEASE_NOTES);
    renderVersion(RELEASE_NOTES);
    openLinkedRelease();
    window.addEventListener("hashchange", openLinkedRelease);
  }
  if (typeof DOWNLOADS !== "undefined") renderDownloads(DOWNLOADS);
  setupTour();
})();
