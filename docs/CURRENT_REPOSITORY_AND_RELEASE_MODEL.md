# Current repository and release model

This repository is the source, build, release, and public distribution repository for JustyBase.

## Marketplace identity

1. The active Visual Studio Marketplace publisher is `justybase`.
2. The core extension ID is `justybase.justybase-netezza`.
3. Optional database extensions depend on that core extension ID and use the same publisher.
4. The former publisher, `krzysztof-d`, is a legacy identity that is not managed or updated from this repository. Its extension ID cannot be transferred to the new publisher, and its users do not receive automatic updates to the new extension ID.

## Repository metadata

Marketplace manifests must link to this public repository:

```json
{
  "homepage": "https://github.com/justybase/justybase-vscode",
  "bugs": {
    "url": "https://github.com/justybase/justybase-vscode/issues"
  },
  "repository": {
    "type": "git",
    "url": "https://github.com/justybase/justybase-vscode"
  }
}
```

The repository owns the GitHub Actions release pipeline. A release builds the selected VSIX packages, attaches them to the matching GitHub Release, and can publish them to Marketplace with the `VSCE_PAT` repository secret.

## Release safety

1. Do not use `npm version` for a production release; use the **Release** workflow.
2. A draft release builds and attaches VSIX assets but does not publish them to Marketplace.
3. After reviewing a draft, run **Publish Marketplace Extensions** manually for the same tag and select the packages to publish.
4. Keep `VSCE_PAT` limited to Marketplace publish access, rotate it before expiry, and never commit or log it.
