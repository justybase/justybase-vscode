# JustyBase SQL Editor (Vertica)

Vertica runtime support for the JustyBase core VS Code extension. The base extension is installed automatically as a technical dependency; Netezza is not required, and you do not need to install or use it.

This package registers the `vertica` database dialect with JustyBase and adds:

- Vertica connections through `vertica-nodejs`
- Schema browsing and metadata queries via `v_catalog` and `v_monitor`
- Vertica-aware SQL authoring, import previews, DDL export, maintenance helpers, and session monitoring

Install this extension from the Marketplace; VS Code resolves the JustyBase core extension dependency automatically. No separate Netezza installation is required.

## License and third-party software

This extension is licensed under Apache-2.0. Its Marketplace VSIX includes the full project license and a generated `THIRD_PARTY_NOTICES.md` covering locked runtime dependencies and their available license texts.
