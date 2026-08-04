# Releasing Bili Pilot

## First public release

The public repository should begin with one source commit. Prepare the complete source tree, documentation, screenshots, and license before initializing its public Git history.

```bash
npm test
npm run check
npm run package:chrome
AMO_JWT_ISSUER=... AMO_JWT_SECRET=... npm run package:firefox

git init
git add .
git commit -m "Initial public release"
git branch -M main
git tag v0.1.0
```

Create a GitHub repository without an automatically generated README, license, or `.gitignore`, then push this existing history:

```bash
git remote add origin <repository-url>
git push -u origin main
git push origin v0.1.0
```

Create GitHub Release `v0.1.0` and upload the browser-specific artifacts and checksums generated in `dist/`:

- `Bili-Pilot-Chrome-0.1.0.zip`
- `Bili-Pilot-Chrome-0.1.0.zip.sha256`
- `Bili-Pilot-Firefox-0.1.0.xpi`
- `Bili-Pilot-Firefox-0.1.0.xpi.sha256`

The ZIP contains one top-level `bili-pilot` directory. Users extract it and select that directory from Chrome's **Load unpacked** action.

The Firefox script submits the staged runtime files to Mozilla's unlisted signing channel and fails before producing an artifact when `AMO_JWT_ISSUER` or `AMO_JWT_SECRET` is missing. Never rename the Chrome ZIP to `.xpi` or advertise an unsigned archive as a Firefox installer.

## Release checklist

1. Update `manifest.json` and the UI preview fixture to the same version.
2. Run `npm test` and `npm run check`.
3. Run `npm run package:chrome`.
4. Run `npm run package:firefox` with the AMO signing credentials in the environment.
5. Inspect the Chrome ZIP and confirm `bili-pilot/manifest.json` has the intended version.
6. Test the extracted Chrome package in a clean Chrome profile and the signed XPI in a clean Firefox profile.
7. Upload both browser artifacts and checksums to a GitHub Release matching the version tag.
8. Verify the README's latest-release link resolves to that release.

Do not commit `dist/`. Release archives and checksums belong to GitHub Releases rather than the source history.
