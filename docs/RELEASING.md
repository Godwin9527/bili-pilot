# Releasing Bili Pilot

## First public release

The public repository should begin with one source commit. Prepare the complete source tree, documentation, screenshots, and license before initializing its public Git history.

```bash
npm test
npm run check
npm run package

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

Create GitHub Release `v0.1.0` and upload both files generated in `dist/`:

- `Bili-Pilot-0.1.0.zip`
- `Bili-Pilot-0.1.0.zip.sha256`

The ZIP contains one top-level `bili-pilot` directory. Users extract it and select that directory from Chrome's **Load unpacked** action.

## Release checklist

1. Update `manifest.json` and the UI preview fixture to the same version.
2. Run `npm test` and `npm run check`.
3. Run `npm run package`.
4. Inspect the ZIP and confirm `bili-pilot/manifest.json` has the intended version.
5. Test the extracted package in a clean Chrome profile.
6. Upload the ZIP and checksum to a GitHub Release matching the version tag.
7. Verify the README's latest-release link resolves to that release.

Do not commit `dist/`. Release archives and checksums belong to GitHub Releases rather than the source history.
