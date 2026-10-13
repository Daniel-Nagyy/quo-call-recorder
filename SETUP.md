# Quo Call Recorder — setup guide

What it does:
- Records every Quo call (incoming and outgoing) made in Chrome, both sides, automatically.
- Saves each call to **Google Drive → Quo Call Recordings → [Driver name] → "Driver name - 2026-10-11 3.05 PM.webm"**.
- Logs each call in a Google Sheet: date, time, caller, duration and a link to the recording.
- Dispatchers don't need to do anything. There's no button, settings page or pop-up.

---

## Step 1 — Google Sheet + Drive upload (one time, ~10 min)

1. Create a Google Sheet called **Quo Call Log**.
2. Click **Extensions → Apps Script**, delete what's there, and paste in all of **Code.gs**.
3. On the first line, replace `PUT-THE-SAME-SECRET-AS-config.js-HERE` with a long random password.
4. Click **Save**. Choose **setup** in the dropdown and click **Run**, then approve the permissions.
5. Click **Deploy → New deployment → ⚙ → Web app**, set Execute as **Me** and Who has access **Anyone**, then click **Deploy**. **Copy the Web app URL.**
6. (Optional) In the **Drivers** tab, click **File → Import → Upload → Drivers_for_sheet.csv → Replace current sheet**. This is only used when Quo shows a number instead of a name.

## Step 2 — Fill in config.js

In the `extension` folder, open `config.js` and paste in:
```
DRIVE_UPLOAD_URL: "https://script.google.com/macros/s/....../exec",
UPLOAD_TOKEN: "the same password as in Code.gs",
```

## Step 3 — Publish privately for your company (Chrome Web Store)

1. Zip the `extension` folder. Zip the folder's contents, so `manifest.json` is at the top of the zip.
2. Go to the Chrome Web Store Developer Dashboard (chrome.google.com/webstore/devconsole) and sign in with your **Workspace** account. There's a one-time $5 fee.
3. Click **New item** and upload the zip.
4. Under **Distribution → Visibility**, choose **Private** and your Workspace domain only. Fill in the required listing fields; a short description and a screenshot are enough. Submit it for review.
5. After it's approved, copy the **Extension ID**. It's a 32-letter code.

## Step 4 — Force-install it so it can't be turned off (Google Admin console)

1. Go to admin.google.com → **Devices → Chrome → Apps & extensions → Users & browsers**.
2. Select the group or OU your dispatchers are in.
3. Click **+ → Add from Chrome Web Store**, paste the Extension ID, and set it to **Force install**.
4. Under **Devices → Chrome → Settings → Users & browsers** for the same group:
   - **Incognito mode** → Disallow incognito mode
   - **Developer tools** → Never allow use of built-in developer tools
   - **Browser sign-in** → Force users to sign in to use the browser, with your domain only

Dispatchers sign into Chrome with their Workspace account and the extension installs itself. It can't be disabled or removed from `chrome://extensions`. It starts working the next time they open or refresh Quo.

> If dispatchers don't sign into Chrome with Workspace accounts, you can enroll each computer's browser instead. Use **Chrome Enterprise Core** (free) under **Devices → Chrome → Managed browsers**, which gives you an enrollment token to install on each PC. The same force-install settings then apply to the whole computer.

## Step 5 — Close the gaps outside Chrome
- The extension only sees calls made in **Quo's website in Chrome**. It can't record the Quo desktop app or phone app.
- So also turn on **Quo's own Auto-record calls**: Quo → Settings → Phone numbers → each number → Auto-record. This needs the Business or Scale plan, and only Quo admins can turn it off.

## Test
Make a short call in Quo. Within a minute, the file should appear in Drive and a row should appear in Call Log.

## How the names work
- The name comes from Quo's **"Call in progress"** box: the person on the call who isn't marked "You".
- That's the Quo contact name, for example "ROC". If the caller isn't saved as a contact, Quo shows the number. In that case the script looks the number up in the **Drivers** tab and uses the driver's name.
- To get the nicest names, save drivers as contacts in Quo.

## Updating the script later
After pasting new code into Apps Script, go to **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same. Saving alone does **not** update the live script.

## Good to know
- If a dispatcher closes the tab mid-call, the recorded part is uploaded and marked "(partial)".
- If the internet or Google is down, recordings are kept and retried every 5 minutes.
- When you change the extension later, raise `"version"` in `manifest.json` and upload the new zip to the Web Store. All computers update automatically.
