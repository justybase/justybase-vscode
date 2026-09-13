# Portable Electron build

The repository can produce a Windows x64 portable ZIP for the Electron shell.
This is a development/distribution artifact and is separate from the VS Code
extension release workflow.

## Local build

From the repository root, with Node.js 22 and the workspace dependencies
installed:

```bash
npm ci
npm run package:electron:win
```

The command can be run from WSL2. It downloads the Windows Electron runtime,
builds the shared API/UI and Electron bundles, and writes:

```text
artifacts/electron/justybase-electron-win-x64-v<version>.zip
```

The ZIP contains `JustyBase.exe` and the complete portable application
directory. User data and credentials are stored by Electron under the Windows
user-data directory and are not included in the archive.

## GitHub Actions

Run **Actions → Build Portable Electron → Run workflow**. Enter the branch,
tag, or commit to build. The workflow runs the Electron tests, creates the
Windows x64 ZIP, and uploads it as the `justybase-electron-win-x64` artifact.

The workflow is intentionally manual and does not attach the ZIP to the
official VS Code release or publish an installer.
