const linuxLink = document.querySelector("#linuxDownloadLink");
const windowsLink = document.querySelector("#windowsDownloadLink");
const heroDownloadLink = document.querySelector("#downloadLink");

if (heroDownloadLink) heroDownloadLink.href = "#download";

function enableDownload(link, url) {
  if (!link) return;
  link.href = url;
  link.classList.remove("disabled");
  link.removeAttribute("aria-disabled");
}

function linuxAsset(release) {
  return release.assets.find((asset) => /_amd64\.deb$/i.test(asset.name));
}

function windowsAsset(release) {
  return (
    release.assets.find((asset) => /win-x64.*_setup\.exe$/i.test(asset.name)) ??
    release.assets.find((asset) => /win-x64.*\.msix$/i.test(asset.name))
  );
}

function latestAssetWithInstaller(releases, findAsset) {
  for (const release of releases) {
    const asset = findAsset(release);
    if (asset?.browser_download_url) return asset;
  }
  return null;
}

async function hydrateDownloadLinks() {
  try {
    const response = await fetch("releases.json");
    if (!response.ok) return;

    const releases = await response.json();
    const stableReleases = releases
      .filter((item) => !item.draft && !item.prerelease && item.assets?.length)
      .sort((a, b) => new Date(b.published_at) - new Date(a.published_at));

    const linux = latestAssetWithInstaller(stableReleases, linuxAsset);
    const windows = latestAssetWithInstaller(stableReleases, windowsAsset);

    if (linux?.browser_download_url) enableDownload(linuxLink, linux.browser_download_url);
    if (windows?.browser_download_url) enableDownload(windowsLink, windows.browser_download_url);
  } catch {
    // Keep the buttons disabled if GitHub is unreachable or matching assets are absent.
  }
}

hydrateDownloadLinks();

// ── Interactive API preview ───────────────────────────────────────────────
(function () {
  const sendButton = document.getElementById("apiPreviewSend");
  const responseEl = document.getElementById("apiPreviewResponse");
  const pathEl = document.getElementById("apiPreviewPath");
  const statusEl = document.getElementById("apiPreviewStatus");
  const timeEl = document.getElementById("apiPreviewTime");
  const sizeEl = document.getElementById("apiPreviewSize");
  const resultEl = document.getElementById("apiPreviewResult");
  const jsonEl = document.getElementById("apiPreviewJson");
  const pageEl = document.getElementById("apiPreviewPage");
  const prevButton = document.getElementById("apiPreviewPrev");
  const nextButton = document.getElementById("apiPreviewNext");

  if (!sendButton || !responseEl || !pathEl || !resultEl || !jsonEl || !pageEl || !prevButton || !nextButton) return;

  const pages = [
    [
      { id: "course_pubpol", name: "MPhil in Public Policy", institutionName: "Cambridge University", isVisible: true },
      { id: "course_analytics", name: "Product Analytics", institutionName: "Example Labs", isVisible: true },
      { id: "course_dist_api", name: "Intro to Distributed APIs", institutionName: "Northwind School", isVisible: true },
    ],
    [
      { id: "course_design", name: "Service Design Studio", institutionName: "Example Labs", isVisible: true },
      { id: "course_ethics", name: "Data Ethics", institutionName: "Cambridge University", isVisible: true },
      { id: "course_http", name: "HTTP Fundamentals", institutionName: "Northwind School", isVisible: true },
    ],
  ];

  let pageIndex = 0;
  let timer = null;

  function setMeta(state) {
    responseEl.dataset.state = state;
    statusEl.textContent = state === "loaded" ? "200 OK" : state === "loading" ? "Sending" : "Ready";
    timeEl.textContent = state === "loaded" ? "128 ms" : "-- ms";
    sizeEl.textContent = state === "loaded" ? "1.8 KB" : "-- KB";
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function highlightJson(json) {
    return escapeHtml(json).replace(
      /("(?:\\.|[^"\\])*"(?=\s*:))|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
      (match, key, string, literal, number) => {
        if (key) return `<span class="k">${key}</span>`;
        if (string) return `<span class="s">${string}</span>`;
        if (literal) return `<span class="n">${literal}</span>`;
        if (number) return `<span class="n">${number}</span>`;
        return match;
      }
    );
  }

  function renderPage() {
    const body = {
      page: pageIndex + 1,
      pageSize: pages[pageIndex].length,
      totalItems: pages.flat().length,
      data: pages[pageIndex],
    };

    jsonEl.innerHTML = highlightJson(JSON.stringify(body, null, 2));
    pathEl.textContent = `api/courses?page=${pageIndex + 1}`;
    pageEl.textContent = `Page ${pageIndex + 1} of ${pages.length}`;
    prevButton.disabled = pageIndex === 0;
    nextButton.disabled = pageIndex === pages.length - 1;
  }

  function showResponse() {
    setMeta("loaded");
    renderPage();
    resultEl.hidden = false;
    sendButton.disabled = false;
    sendButton.textContent = "Send";
  }

  function sendPreviewRequest() {
    window.clearTimeout(timer);
    resultEl.hidden = true;
    pageIndex = 0;
    setMeta("loading");
    sendButton.disabled = true;
    sendButton.textContent = "Sending";
    timer = window.setTimeout(showResponse, 380);
  }

  sendButton.addEventListener("click", sendPreviewRequest);
  prevButton.addEventListener("click", () => {
    if (pageIndex > 0) {
      pageIndex -= 1;
      renderPage();
    }
  });
  nextButton.addEventListener("click", () => {
    if (pageIndex < pages.length - 1) {
      pageIndex += 1;
      renderPage();
    }
  });
})();

// ── Scroll reveal ─────────────────────────────────────────────────────────
(function () {
  const obs = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("revealed");
          obs.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1 }
  );
  document.querySelectorAll("[data-reveal]").forEach((el) => obs.observe(el));
})();
