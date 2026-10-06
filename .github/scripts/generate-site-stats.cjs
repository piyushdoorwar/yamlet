// Write the container image's lifetime download count for the static site.
// GHCR exposes this figure on its public package page, but not in its API.
const fs = require("node:fs/promises");
const path = require("node:path");

const repo = process.env.GITHUB_REPOSITORY || "piyushdoorwar/yamlet";
const packageName = process.env.PACKAGE_NAME || repo.split("/")[1];
const packageUrl = `https://github.com/${repo}/pkgs/container/${packageName}`;
const outputPath = path.resolve(process.cwd(), "site/stats.json");

function parseTotalDownloads(html) {
  const match = /Total downloads\s*<\/span>\s*<h3[^>]*\btitle="([\d,]+)"/i.exec(html);
  if (!match) return null;
  const count = Number(match[1].replace(/,/g, ""));
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

async function readPrevious() {
  try {
    const previous = JSON.parse(await fs.readFile(outputPath, "utf8"));
    return Number.isSafeInteger(previous.downloads) && previous.downloads >= 0 ? previous : null;
  } catch {
    return null;
  }
}

async function main() {
  const previous = await readPrevious();
  let downloads;
  try {
    const response = await fetch(packageUrl, { headers: { "User-Agent": "Yamlet-Site-Stats" } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    downloads = parseTotalDownloads(await response.text());
    if (downloads === null) throw new Error("download count not found on the package page");
  } catch (error) {
    console.warn(`Could not read downloads from ${packageUrl}: ${error.message}. Keeping the last known value.`);
    return;
  }

  // A lifetime count only grows; avoid publishing a smaller transient figure.
  if (previous && downloads < previous.downloads) downloads = previous.downloads;
  const stats = { downloads, package_url: packageUrl, updated_at: new Date().toISOString() };
  await fs.writeFile(outputPath, `${JSON.stringify(stats, null, 2)}\n`);
  console.log(`Wrote ${downloads} downloads to ${outputPath}`);
}

if (require.main === module) {
  main().catch((error) => console.warn(error));
}

module.exports = { parseTotalDownloads };
