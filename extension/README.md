# Yamlet Interceptor

This Manifest V3 extension syncs cookies for sites you explicitly approve into a Yamlet workspace on your own computer. Install it from the [Chrome Web Store](https://chromewebstore.google.com/detail/yamlet-interceptor/ojnilooocnngdafipgchmlnaldpejaei); the steps below load this folder for development. It does not capture requests, read page content, or transmit cookies to a Yamlet cloud service.

## Local test

1. Run Yamlet 1.1.6 or newer with the `yamlet-data` volume, using the command in the repository README (build from this checkout to test unreleased server changes).
2. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose this `extension/` folder.
3. Open `http://localhost:7878`, then Cookies → **Pair extension**.
4. Select **Connect** in the window the extension opens. If no window opens (for example, the Yamlet tab was open before the extension was loaded), reload the tab, or choose **Use a code instead** in Yamlet and paste the code into the extension popup.
5. Open a normal browser tab on a site that has cookies. Select **Allow and sync this site** in the extension popup.
6. Refresh Yamlet's Cookies modal. Try a request to the approved site. Change or delete a browser cookie, wait about a minute, and refresh the modal again.
7. Restart the container and choose **Sync approved sites now** in the popup. Pairing should still work when `/data` is mounted.
8. Recreate the container without the `/data` volume, keeping a Yamlet tab open. Within a minute the extension reconnects by itself and syncs the approved sites again.

## Pairing

Yamlet has no login, so the one-time pairing code proves that you, in Yamlet's own page, approved this extension. Without it any other extension in the browser could push cookies into Yamlet. You do not have to copy it: a small bridge script on `localhost` pages hands the code from Yamlet's **Pair extension** button to the extension. The first time you pair with an address, the extension asks you to confirm it in its own window, so another local page cannot pair the extension with itself.

If Yamlet no longer knows the pairing (it answers 401, for example after its `/data` volume was replaced), the extension keeps your approved sites and pairs again by itself the next time a Yamlet tab at the same address is open. A pairing you end with **Disconnect extensions** is remembered as disconnected (403); the extension then forgets it and does not reconnect until you pair again.

Chrome grants access per site. The extension excludes incognito and partitioned cookies in this version. Cookies remain in the Yamlet server's memory; pairing credentials are stored in the private `/data` volume and in this browser's extension storage. Disconnect in Yamlet's Cookies modal to revoke pairings and clear browser-imported cookies. The popup's **Forget connection** clears this browser's cookies from Yamlet and ends the pairing there when Yamlet is reachable; **Disconnect extensions** in Yamlet revokes every pairing for the workspace.

## ZIP for local distribution

From the repository root run `npm run package:extension` (latest `v*` tag) or `bash extension/package.sh v1.2.3`. The output is `dist/yamlet-interceptor-<version>.zip` with that version stamped into its manifest; the `version` in the source `manifest.json` is a placeholder (`0.0.0`) and is never edited by hand. Chrome takes only `X.Y.Z` as `version`, so a pre-release tag such as `v1.3.0-beta.1` becomes `version: 1.3.0` plus `version_name: 1.3.0-beta.1`. Each `v*` release builds the ZIP and attaches it to the GitHub release. Chrome's **Load unpacked** command uses the folder, not the ZIP. The Chrome Web Store accepts the ZIP.

The extension only connects to `http://localhost` or `http://127.0.0.1`. Cookie snapshot contents are encrypted with AES-GCM before being posted to the local Yamlet server. The Chrome Web Store's secure-transmission requirements must be checked before public submission; the local test package is not a claim of Store approval.
