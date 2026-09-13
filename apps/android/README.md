# FLT-Exchange for Android

A **Trusted Web Activity**: a real Android app that opens `https://ftlexchange.com`
full-screen using Chrome. Every screen, login and trade is the live website, so
**every web deploy updates the app instantly**. Only the shell needs a new release,
and only when its icon, name, package or version changes.

It is not part of the pnpm workspace (no `package.json`), so `pnpm typecheck` and
the web builds never touch it.

---

## One-time setup (on your machine)

### 1. Tools

Bubblewrap needs **JDK 17** and the **Android SDK**. On first run it offers to
download both; accepting means accepting Google's Android SDK license.

```bash
npm install -g @bubblewrap/cli
bubblewrap doctor
```

### 2. The upload key — keep it forever, never commit it

The key path in `twa-manifest.json` is **outside the repo**
(`C:\FLT-signing\flt-upload.keystore`). `.gitignore` also blocks `*.keystore`
and `*.jks` as a second line of defence.

```bash
mkdir C:\FLT-signing
keytool -genkeypair -v -keystore C:\FLT-signing\flt-upload.keystore -alias flt-upload -keyalg RSA -keysize 2048 -validity 10000
```

Store the keystore file and both passwords in your password manager. **Losing
this key means you cannot update the direct-download APK.** Never paste the
passwords into chat, email or a ticket.

Get its SHA-256 fingerprint:

```bash
keytool -list -v -keystore C:\FLT-signing\flt-upload.keystore -alias flt-upload
```

Copy the `SHA256:` line, not `SHA1:`, which is a common mistake.

### 3. Generate the Android project

From this directory:

```bash
bubblewrap update
```

This reads `twa-manifest.json` and generates the Gradle project here. Commit the
generated project; build outputs are gitignored.

---

## Every release

1. Bump `appVersionCode` (must increase) and `appVersionName` in `twa-manifest.json`.
2. `bubblewrap update` then `bubblewrap build`. You get:
   - `app-release-bundle.aab` for the **Play Store**
   - `app-release-signed.apk` for the **direct download**
3. **Play Store**: upload the `.aab` to the **internal testing** track first.
4. **Direct APK**:
   ```bash
   scp app-release-signed.apk root@<server>:/var/www/flt-downloads/flt-1.0.0.apk
   ssh root@<server> sha256sum /var/www/flt-downloads/flt-1.0.0.apk
   ```
   Then in **Admin → Mobile app** enter the URL
   `https://ftlexchange.com/downloads/flt-1.0.0.apk`, the version, and the checksum.

---

## Making it open full-screen (Digital Asset Links)

The site must vouch for the app, or it opens **with a URL bar**. Put **both**
fingerprints in the server `.env`:

```
ANDROID_PACKAGE_NAME=com.ftlexchange.app
ANDROID_CERT_SHA256=<Play app-signing SHA-256>,<upload key SHA-256>
```

- **Play app-signing certificate**: Play Console → your app → Setup → App
  signing. Play re-signs the app with this key, so Play installs need it.
- **Upload key certificate**: from step 2 above. The direct APK is signed with
  it, so sideloaded installs need it.

Check it:

```bash
curl https://ftlexchange.com/.well-known/assetlinks.json
```

---

## Play Console checklist

- [ ] **Privacy policy URL**: `https://ftlexchange.com/privacy` (the draft needs legal review first)
- [ ] **Account deletion URL**: `https://ftlexchange.com/delete-account`
- [ ] **Data safety form**: email, phone, name, government ID (KYC), financial info, transaction history
- [ ] **Financial features declaration**: cryptocurrency exchange. Google requires proof of
      licensing **for each country you target**. Restrict distribution to countries where FLT is licensed.
- [ ] **Content rating** questionnaire
- [ ] **Target audience**: 18+
- [ ] **Store listing**: icon (512px), feature graphic (1024×500), phone screenshots
- [ ] Internal testing → closed testing → production

## Testing a build

Install the APK on a phone or emulator, then check:

- [ ] It opens **with no URL bar**. A bar means the fingerprints above don't match.
- [ ] Log in, close the app, reopen: still logged in.
- [ ] A small trade, the deposit screen, the withdraw screen.
- [ ] Links to other sites (block explorer, admin) open in a Chrome tab, not inside the app.
- [ ] The Android back button goes back through pages, then exits.
