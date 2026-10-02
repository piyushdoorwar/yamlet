/* releases.js — renders releases.json as container image tags + changelog. */
(function () {
  "use strict";

  const IMAGE = "ghcr.io/piyushdoorwar/yamlet";
  const ICONS = "../assets/icons.svg";
  const PER_PAGE = 10;

  let all = [];
  let page = 1;
  let stableOnly = true;

  const $ = (id) => document.getElementById(id);
  const loadingEl = $("rel-loading");
  const errorEl = $("rel-error");
  const emptyEl = $("rel-empty");
  const listEl = $("rel-list");
  const pager = $("pager");
  const prevBtn = $("page-prev");
  const nextBtn = $("page-next");
  const pageLabel = $("page-label");
  const stableToggle = $("stableOnly");

  const esc = (s) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  const icon = (name) => `<svg class="ic" aria-hidden="true"><use href="${ICONS}#i-${name}" /></svg>`;

  const imageTag = (r) => r.image_tag || String(r.tag_name || "").replace(/^v(?=\d)/, "");

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  // Minimal, safe markdown for release notes: escape first, then format.
  function inline(text) {
    return esc(text)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" rel="noreferrer">$2</a>');
  }

  function renderMarkdown(md) {
    const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let list = false;
    let para = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    };
    const closeList = () => {
      if (list) out.push("</ul>");
      list = false;
    };
    for (const raw of lines) {
      const line = raw.trim();
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const item = /^[-*+]\s+(.*)$/.exec(line);
      if (!line) { flushPara(); closeList(); continue; }
      if (heading) { flushPara(); closeList(); out.push(`<h4>${inline(heading[1])}</h4>`); continue; }
      if (item) {
        flushPara();
        if (!list) { out.push("<ul>"); list = true; }
        out.push(`<li>${inline(item[1])}</li>`);
        continue;
      }
      closeList();
      para.push(line);
    }
    flushPara();
    closeList();
    return out.join("");
  }

  function copyBlock(cmd, label) {
    return `<div class="cmd">
      <pre><code><span class="prompt">$ </span>${esc(cmd)}</code></pre>
      <button class="copy-btn" type="button" data-copy="${esc(cmd)}" aria-label="${esc(label)}">
        ${icon("copy").replace('class="ic"', 'class="ic i-copy"')}
        ${icon("check").replace('class="ic"', 'class="ic i-check"')}
        <span>Copy</span>
      </button>
    </div>`;
  }

  function renderRelease(r, latestId) {
    const tag = imageTag(r);
    const isLatest = r.id === latestId;
    const notes = String(r.body || "").trim();
    const title = r.name && r.name !== r.tag_name ? `<p class="release-name">${esc(r.name)}</p>` : "";
    const npmVersion = /^\d+\.\d+\.\d+/.test(tag) ? tag : "";

    return `<article class="release${isLatest ? " latest" : ""}">
      <div class="release-head">
        <h3>${esc(r.tag_name)}</h3>
        ${isLatest ? '<span class="badge badge-latest">Latest</span>' : ""}
        ${r.prerelease ? '<span class="badge badge-pre">Pre-release</span>' : ""}
        <time class="release-date" datetime="${esc(r.published_at)}">${formatDate(r.published_at)}</time>
      </div>
      ${title}
      ${copyBlock(`docker pull ${IMAGE}:${tag}`, `Copy pull command for ${tag}`)}
      <div class="tags" aria-label="Image tags">
        <span>${icon("tag")}${esc(tag)}</span>
        ${isLatest ? `<span>${icon("tag")}latest</span>` : ""}
      </div>
      ${
        notes
          ? `<details class="changelog"${isLatest ? " open" : ""}>
              <summary>${icon("chevron")}Changelog</summary>
              <div class="md">${renderMarkdown(notes)}</div>
            </details>`
          : ""
      }
      <div class="release-links">
        <a href="${esc(r.html_url)}" rel="noreferrer">${icon("github")}Release on GitHub</a>
        ${npmVersion ? `<a href="https://www.npmjs.com/package/@piyushdoorwar/yamlet/v/${esc(npmVersion)}" rel="noreferrer">${icon("terminal")}CLI ${esc(npmVersion)} on npm</a>` : ""}
      </div>
    </article>`;
  }

  function render() {
    const filtered = all.filter((r) => !stableOnly || !r.prerelease);
    const latestStable = all.find((r) => !r.prerelease);

    if (!filtered.length) {
      listEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      pager.hidden = true;
      return;
    }
    emptyEl.classList.add("hidden");

    const pages = Math.ceil(filtered.length / PER_PAGE);
    page = Math.min(Math.max(page, 1), pages);
    const slice = filtered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
    listEl.innerHTML = slice.map((r) => renderRelease(r, latestStable?.id)).join("");

    pager.hidden = pages <= 1;
    pageLabel.textContent = `Page ${page} of ${pages}`;
    prevBtn.disabled = page <= 1;
    nextBtn.disabled = page >= pages;
  }

  stableToggle.addEventListener("change", () => {
    stableOnly = stableToggle.checked;
    page = 1;
    render();
  });
  prevBtn.addEventListener("click", () => { page -= 1; render(); window.scrollTo(0, listEl.offsetTop - 120); });
  nextBtn.addEventListener("click", () => { page += 1; render(); window.scrollTo(0, listEl.offsetTop - 120); });

  (async function init() {
    try {
      const res = await fetch("../releases.json", { cache: "no-cache" });
      if (!res.ok) throw new Error(`Release manifest ${res.status}`);
      const data = await res.json();
      all = (Array.isArray(data) ? data : [])
        .filter((r) => !r.draft)
        .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
      loadingEl.classList.add("hidden");
      render();
    } catch {
      loadingEl.classList.add("hidden");
      errorEl.classList.remove("hidden");
    }
  })();
})();
