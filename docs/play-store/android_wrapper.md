# Packaging the app for Google Play (Trusted Web Activity)

The app is a web app (PWA). The usual way to put it on Play is a Trusted Web Activity: a thin Android shell that opens the web app full screen. I cannot build or sign the final file from here, because that needs your signing key and the Android build tools. Do these steps on a computer, or use the PWABuilder website, which does the same thing.

## What you need
- The app address: https://ashelzbible.github.io/Ashelz-Bible-App/
- Its manifest: https://ashelzbible.github.io/Ashelz-Bible-App/manifest.webmanifest
- A package name, for example `io.github.ashelzbible.bible`. It can never be changed after the first upload.
- Node.js and Java installed, or just a browser for PWABuilder.

## Option A: PWABuilder (easiest)
1. Go to pwabuilder.com and paste the app address.
2. Choose Package for stores, Android, Google Play.
3. Enter the package name and the app name, and keep "Signing key: create new". Download the zip. Keep the signing key file and its password somewhere very safe. If you lose them you cannot update the app.
4. The zip holds the `.aab` file to upload, and a page that shows the SHA-256 fingerprint.

## Option B: Bubblewrap (command line)
```
npm install -g @bubblewrap/cli
bubblewrap init --manifest https://ashelzbible.github.io/Ashelz-Bible-App/manifest.webmanifest
bubblewrap build
```
`build` writes `app-release-bundle.aab` and the signing key, and prints the SHA-256 fingerprint.

## The address check (assetlinks.json), and staying on this domain
A Trusted Web Activity hides the browser bar only if Google can verify that the app and the website belong together. The proof is a file at the **root** of the website's domain:

`https://ashelzbible.github.io/.well-known/assetlinks.json`

The Ashelz app lives in a sub folder (`/Ashelz-Bible-App/`), so that root address is not served by the app's repository. You can stay on the same domain like this:
1. In the GitHub account `ashelzbible`, create a second, almost empty repository named exactly `ashelzbible.github.io` and turn on GitHub Pages for it.
2. Add an empty file named `.nojekyll` and a folder `.well-known` containing `assetlinks.json`, made from `assetlinks.template.json` in this folder.
3. Replace the package name and the fingerprint in the file. Use the fingerprint of the **app signing key shown in Play Console, Setup, App signing**, once you have uploaded the first build, because Google re-signs the app.
4. Open the address in a browser to check that the file is served.

Without this check the app still opens, but it shows a browser address bar at the top, and Google may see it as a simple website wrapper. Doing the steps above is worth it.

## After uploading
- Fill in the store listing from store_listing.md, the Data safety form from data_safety.md, and the content rating from content_rating.md.
- Add the privacy policy link: https://ashelzbible.github.io/Ashelz-Bible-App/privacy.html
- Run the closed test (closed_test.md), then apply for production.

## If Google rejects it as "minimum functionality"
Say that the app is an offline capable Bible and devotional app with its own features (reader, prayers, journal, notes, devotions, Homecell). If it still fails, the fallback is to bundle the app files inside the Android app with Capacitor, so it is a real installed app and not a website view. Tell me and I will prepare that version.
