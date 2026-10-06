# Yamlet Interceptor

This Manifest V3 extension syncs cookies for sites you explicitly approve into a Yamlet workspace on your own computer. It does not capture requests, read page content, or transmit cookies to a Yamlet cloud service.

## Local test

1. Build and run the updated Yamlet container using the command in the repository README.
2. Open `chrome://extensions`, enable Developer mode, select **Load unpacked**, and choose this `extension/` folder.
3. Open `http://localhost:7878`, then Cookies → **Pair extension**.
4. Open the extension popup, paste the pairing code, and select **Connect**.
5. Open a normal browser tab on a site that has cookies. Select **Allow & sync this site** in the extension popup.
6. Refresh Yamlet's Cookies modal. Try a request to the approved site. Change or delete a browser cookie, wait about a minute, and refresh the modal again.
7. Restart the container and choose **Sync approved sites now** in the popup. Pairing should still work when `/data` is mounted.

Chrome grants access per site. The extension excludes incognito and partitioned cookies in this version. Cookies remain in the Yamlet server's memory; pairing credentials are stored in the private `/data` volume and in this browser's extension storage. Disconnect in Yamlet's Cookies modal to revoke pairings and clear browser-imported cookies. The popup's **Forget connection** removes this browser's saved pairing but cannot revoke the server copy; use **Disconnect extensions** in Yamlet for revocation.

## ZIP for local distribution

From the repository root run `npm run package:extension`. The output is `dist/yamlet-interceptor-0.1.0.zip`. Chrome's **Load unpacked** command uses the folder, not the ZIP. The Chrome Web Store accepts the ZIP.

The extension only connects to `http://localhost` or `http://127.0.0.1`. Cookie snapshot contents are encrypted with AES-GCM before being posted to the local Yamlet server. The Chrome Web Store's secure-transmission requirements must be checked before public submission; the local test package is not a claim of Store approval.
