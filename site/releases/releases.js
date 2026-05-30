/* releases.js - powers the /releases/ page */

(function () {
  const PER_PAGE = 10;

  let allReleases = [];
  let currentOS = "all";
  let currentPage = 1;
  let stableOnly = true;

  const loadingEl = document.getElementById("releases-loading");
  const errorEl = document.getElementById("releases-error");
  const emptyEl = document.getElementById("releases-empty");
  const itemsEl = document.getElementById("releases-items");
  const pagination = document.getElementById("pagination");
  const prevBtn = document.getElementById("page-prev");
  const nextBtn = document.getElementById("page-next");
  const pageLabel = document.getElementById("page-label");
  const osTabs = document.querySelectorAll(".os-tab");
  const stableToggle = document.getElementById("stableOnlyToggle");

  async function fetchAllReleases() {
    const res = await fetch("../releases.json");
    if (!res.ok) throw new Error(`Release manifest ${res.status}`);
    const results = await res.json();
    results.sort((a, b) => new Date(b.published_at) - new Date(a.published_at));
    return results;
  }

  // ── Asset helpers ──────────────────────────────────────────────────────────
  function linuxAsset(release) {
    return release.assets.find((a) => /_amd64\.deb$/i.test(a.name));
  }
  function windowsExeAsset(release) {
    return (
      release.assets.find((a) => /win-x64.*_setup\.exe$/i.test(a.name)) ??
      release.assets.find((a) => /win-x64.*\.exe$/i.test(a.name))
    );
  }
  function windowsMsixAsset(release) {
    return release.assets.find((a) => /win-x64.*\.msix$/i.test(a.name));
  }

  function hasOsAsset(release, os) {
    if (os === "all") return true;
    if (os === "linux") return !!linuxAsset(release);
    if (os === "windows") return !!windowsExeAsset(release) || !!windowsMsixAsset(release);
    return true;
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function timeAgo(iso) {
    const seconds = Math.floor((Date.now() - new Date(iso)) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    if (months < 12) return `${months}mo ago`;
    return `${Math.floor(months / 12)}y ago`;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function dlBtn(asset, imgSrc, label) {
    if (!asset) return "";
    return `<a class="button secondary release-dl-btn" href="${escHtml(asset.browser_download_url)}" download title="Download ${escHtml(asset.name)}">
      <img src="${imgSrc}" alt="" /><span>${label}</span>
    </a>`;
  }

  function renderPage() {
    const filtered = allReleases.filter((r) => hasOsAsset(r, currentOS) && (!stableOnly || !r.prerelease));
    const latestStable = filtered.find((r) => !r.prerelease);

    if (filtered.length === 0) {
      itemsEl.innerHTML = "";
      emptyEl.classList.remove("hidden");
      pagination.hidden = true;
      return;
    }
    emptyEl.classList.add("hidden");

    const totalPages = Math.ceil(filtered.length / PER_PAGE);
    currentPage = Math.min(currentPage, totalPages);
    const start = (currentPage - 1) * PER_PAGE;
    const page = filtered.slice(start, start + PER_PAGE);

    const showLinux = currentOS === "all" || currentOS === "linux";
    const showWindows = currentOS === "all" || currentOS === "windows";

    itemsEl.innerHTML = page.map((release) => {
      const isLatest = latestStable?.id === release.id;

      const downloads = [
        showLinux ? dlBtn(linuxAsset(release), "../assets/ubuntu.svg", ".deb") : "",
        showWindows ? dlBtn(windowsExeAsset(release), "../assets/windows.svg", ".exe") : "",
        showWindows ? dlBtn(windowsMsixAsset(release), "../assets/windows.svg", ".msix") : "",
      ].join("");

      return `<article class="release-item">
        <div class="release-meta">
          <div class="release-tag-row">
            <span class="release-version">${escHtml(release.tag_name)}</span>
            ${isLatest ? '<span class="badge-latest">Latest</span>' : ""}
            ${release.prerelease ? '<span class="badge-pre">Pre-release</span>' : ""}
          </div>
          <time class="release-date" datetime="${escHtml(release.published_at)}" title="${formatDate(release.published_at)}">${timeAgo(release.published_at)} · ${formatDate(release.published_at)}</time>
        </div>
        <div class="release-downloads">
          ${downloads || `<a class="release-gh-link github-link" href="${escHtml(release.html_url)}" rel="noreferrer"><img src="../assets/github.svg" alt="" /><span>View on GitHub</span></a>`}
        </div>
      </article>`;
    }).join("");

    pagination.hidden = totalPages <= 1;
    pageLabel.textContent = `Page ${currentPage} of ${totalPages}`;
    prevBtn.disabled = currentPage <= 1;
    nextBtn.disabled = currentPage >= totalPages;
  }

  osTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      osTabs.forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      tab.classList.add("active");
      tab.setAttribute("aria-selected", "true");
      currentOS = tab.dataset.os;
      currentPage = 1;
      renderPage();
    });
  });

  prevBtn.addEventListener("click", () => { if (currentPage > 1) { currentPage--; renderPage(); window.scrollTo(0, 0); } });
  nextBtn.addEventListener("click", () => { currentPage++; renderPage(); window.scrollTo(0, 0); });

  stableToggle.addEventListener("change", () => {
    stableOnly = stableToggle.checked;
    currentPage = 1;
    renderPage();
  });

  // Main tab switching (Versions / Installation)
  const tabButtons = document.querySelectorAll(".releases-tabs .tab-button");
  const tabContents = document.querySelectorAll(".releases-tabs .tab-content");
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabName = button.dataset.tab;
      tabButtons.forEach((b) => b.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));
      button.classList.add("active");
      document.querySelector(`.releases-tabs [data-tab="${tabName}"].tab-content`)?.classList.add("active");
    });
  });

  (async function init() {
    try {
      allReleases = await fetchAllReleases();
      loadingEl.classList.add("hidden");
      renderPage();
    } catch {
      loadingEl.classList.add("hidden");
      errorEl.classList.remove("hidden");
    }
  })();
})();
