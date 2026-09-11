# Vendored Dockyard

JustyBase Web embeds the browser-only `avalondock-web` implementation from
[`wieslawsoltes/Dockyard`](https://github.com/wieslawsoltes/Dockyard).

- Upstream commit: `921b9a66cac88b07af6edb3ebd5cd47af500c900`
- Package version: `0.1.0`
- License: MIT (see [`LICENSE`](LICENSE))
- File checksums: [`SHA256SUMS`](SHA256SUMS)

The snapshot was verified from its own checkout with:

```text
npm run build
npm test
npm run api
```

The output is used only by the Web adapter. It is an independent JavaScript
implementation with a DOM/TypeScript API; it is not a WPF/AvalonDock runtime,
does not parse XAML, and does not claim .NET binary or full API compatibility.
The JustyBase adapter must not import this package from `ui-core` or
`ui-react`.

Do not update this directory in place. Fetch a new upstream commit, rerun the
three checks above, refresh `SHA256SUMS`, and update the commit and notice
before replacing the snapshot.
