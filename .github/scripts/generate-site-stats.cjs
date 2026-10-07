// Write public usage figures for the static site:
// - the container image's lifetime download count, which GHCR shows on its public
//   package page but not in its API;
// - the user count the Chrome Web Store shows for the Yamlet Interceptor extension
//   (the store shows none for very new listings, so it may be absent).
// A figure that cannot be read keeps its last known value.
const fs = require("node:fs/promises");
const path = require("node:path");

const repo = process.env.GITHUB_REPOSITORY || "piyushdoorwar/yamlet";
const packageName = process.env.PACKAGE_NAME || repo.split("/")[1];
const packageUrl = `https://github.com/${repo}/pkgs/container/${packageName}`;
const extensionUrl = "https://chromewebstore.google.com/detail/yamlet-interceptor/ojnilooocnngdafipgchmlnaldpejaei";
const outputPath = path.resolve(process.cwd(), "site/stats.json");

function parseTotalDownloads(html) {
  const match = /Total downloads\s*<\/span>\s*<h3[^>]*\btitle="([\d,]+)"/i.exec(html);
  if (!match) return null;
  const count = Number(match[1].replace(/,/g, ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

/** The store's own rounded label, e.g. "15", "1,000" or "10K+". */
function parseExtensionUsers(html) {
  const match = />\s*([\d][\d,.]*\s*[KMB]?\+?)\s+users?\s*</i.exec(html);
  return match ? match[1].replace(/\s+/g, "").toUpperCase() : null;
}

async function readPrevious() {
  try {
    const previous = JSON.parse(await fs.readFile(outputPath, "utf8"));
    return previous && typeof previous === "object" ? previous : {};
  } catch {
    return {};
  }
}

async function fetchPage(url) {
  const response = await fetch(url, { headers: { "User-Agent": "Yamlet-Site-Stats" } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function main() {
  const previous = await readPrevious();
  const stats = { ...previous, package_url: packageUrl, extension_url: extensionUrl };

  try {
    let downloads = parseTotalDownloads(await fetchPage(packageUrl));
    if (downloads === null) throw new Error("download count not found on the package page");
    // A lifetime count only grows; avoid publishing a smaller transient figure.
    if (Number.isSafeInteger(previous.downloads) && downloads < previous.downloads) downloads = previous.downloads;
    stats.downloads = downloads;
  } catch (error) {
    console.warn(`Could not read downloads from ${packageUrl}: ${error.message}. Keeping the last known value.`);
  }

  try {
    const users = parseExtensionUsers(await fetchPage(`${extensionUrl}?hl=en`));
    if (users) stats.extension_users = users;
    else console.log("The Chrome Web Store shows no user count yet.");
  } catch (error) {
    console.warn(`Could not read the extension's users from ${extensionUrl}: ${error.message}. Keeping the last known value.`);
  }

  stats.updated_at = new Date().toISOString();
  await fs.writeFile(outputPath, `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`Wrote ${outputPath}: downloads ${stats.downloads ?? "unknown"}, extension users ${stats.extension_users ?? "not shown"}`);
}

if (require.main === module) {
  main().catch((error) => console.warn(error));
}

module.exports = { parseTotalDownloads, parseExtensionUsers };
