# Force-install Quo Call Recorder from GitHub Releases

This replaces Steps 3 and 4 of `SETUP.md`. No Chrome Web Store listing, no $5 fee,
no review — Chrome downloads the `.crx` straight from a GitHub Release, and Google
Admin force-installs it by ID.

**Extension ID:** `kbcnjcgikeadnikgppijagaaefkgfobi`

That ID comes from `extension.pem`. It is the one thing you must never lose and
never publish: with that key, anyone can sign an "update" that every managed
browser in the company will install automatically. `.gitignore` keeps it out of
the repo — back it up somewhere private (a password manager, not Drive).

---

## Read this first: the token problem

A force-installed extension has to be downloadable by every managed Chrome
**without signing in**, so the repo hosting it must be public. And a `.crx` is a
signed zip — anyone can unzip it and read `config.js`, which contains
`UPLOAD_TOKEN` and `DRIVE_UPLOAD_URL`.

`Code.gs` accepts any upload that presents that token:

```js
if (b.token !== TOKEN) return json({ ok: false, error: 'Wrong token' });
```

and the web app is deployed as **"Anyone"**. So publishing the `.crx` publicly
hands out a working write key to your company Drive. Fix it before you publish,
not after — a public GitHub repo is crawled and archived quickly.

**Fix it like this (about 5 minutes):**

1. In the Apps Script editor, **Deploy → Manage deployments → ✏️ → Who has
   access → "Anyone within <your Workspace domain>"**, then Deploy.
   A leaked token is then useless without a Workspace login.
2. Confirm an upload still works afterwards — a domain-restricted web app needs
   the browser's Google session, so the request must carry credentials. If calls
   start failing, `background.js` line ~162 needs `credentials: "include"` on the
   `fetch`. Test one call before rolling out to everyone.
3. Rotate `UPLOAD_TOKEN` (new random value in **both** `Code.gs` and
   `config.js`), then repack — the old token is in the old `.crx`.

If you would rather not make the repo public at all, the alternative is to serve
`updates.xml` and the `.crx` from the portal you already run
(`ndk-portal.up.railway.app`). It is still publicly fetchable — it has to be —
but it is not indexed or permanently archived. Ask me and I will add the route.

---

## Step 1 — Create the repo (public, no `.pem`, no `.crx`)

From the `quo-call-recorder` folder:

```bash
git init -b main
git add .gitignore updates.xml SETUP.md DEPLOY-GITHUB.md Code.gs Drivers_for_sheet.csv extension/
git commit -m "Quo Call Recorder 4.4 + self-hosted update manifest"
gh repo create quo-call-recorder --public --source=. --push
```

Check that the key and the build did **not** go in:

```bash
git ls-files | grep -E "\.pem$|\.crx$" && echo "STOP: secret committed" || echo "clean"
```

> `extension/config.js` is committed by the command above and contains your
> token. If you have not rotated it yet, add `extension/config.js` to
> `.gitignore` first and keep a local copy.

## Step 2 — Publish the `.crx` as a release asset

The asset filename must match `codebase` in `updates.xml` exactly:

```bash
cp extension.crx quo-call-recorder-4.4.crx
gh release create v4.4 quo-call-recorder-4.4.crx \
  --title "Quo Call Recorder 4.4" \
  --notes "Force-install build for Google Admin."
```

Verify Chrome can actually reach both URLs anonymously — this is the step people
skip, and a 404 here is why force-install silently does nothing:

```bash
curl -sIL https://raw.githubusercontent.com/Daniel-Nagyy/quo-call-recorder/main/updates.xml | head -1
curl -sIL https://github.com/Daniel-Nagyy/quo-call-recorder/releases/download/v4.4/quo-call-recorder-4.4.crx | tail -3
```

Both must end in `200`.

## Step 3 — Force-install in Google Admin

1. **admin.google.com → Devices → Chrome → Apps & extensions → Users & browsers**
2. Pick the OU or group your dispatchers are in (not the top-level org, unless
   you really mean everyone).
3. Bottom-right **+** → **Add Chrome app or extension by ID**.
4. **Extension ID:** `kbcnjcgikeadnikgppijagaaefkgfobi`
5. Change **From the Chrome Web Store** to **From a custom URL**, and paste:
   ```
   https://raw.githubusercontent.com/Daniel-Nagyy/quo-call-recorder/main/updates.xml
   ```
   This is the **XML**, not the `.crx`. Pointing it at the `.crx` is the single
   most common mistake here and fails with no useful error.
6. Set **Installation policy → Force install**. Dispatchers then cannot remove or
   disable it.
7. Save. Allow up to an hour, or have them visit `chrome://policy` → **Reload
   policies**, then `chrome://extensions` to confirm it appears as
   *Installed by enterprise policy*.

### If it does not appear

- `chrome://policy` — is `ExtensionInstallForcelist` listed, with the ID and URL?
  If not, the policy has not reached the machine; check the OU and that the user
  is signed into Chrome with the Workspace account.
- `chrome://extensions` with Developer mode on shows load errors.
- The `.crx` must be **CRX3** (`Cr24`, version 3). Yours is — I checked.
- Chrome caches the update manifest. `chrome://extensions` → **Update** forces a
  re-check.

## Shipping a new version later

Chrome only upgrades when the version **increases**, in both places:

1. Bump `version` in `extension/manifest.json` (e.g. `4.5`).
2. Repack **with the same `extension.pem`**, or the ID changes and every managed
   browser treats it as a different extension:
   ```
   "C:\Program Files\Google\Chrome\Application\chrome.exe" ^
     --pack-extension="<path>\extension" --pack-extension-key="<path>\extension.pem"
   ```
3. `gh release create v4.5 quo-call-recorder-4.5.crx --title "Quo Call Recorder 4.5"`
4. Edit `updates.xml` — `version` **and** the `codebase` tag/filename — and push.
   Its URL never changes, which is why Admin never needs touching again.
