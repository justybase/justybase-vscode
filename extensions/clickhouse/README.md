# JustyBase SQL Editor (ClickHouse)

Optional ClickHouse companion for JustyBase SQL Editor.

The companion connects to self-hosted ClickHouse and ClickHouse Cloud through
the HTTP interface using `@clickhouse/client`. It provides streaming query
results, metadata browsing, ClickHouse SQL authoring, imports, EXPLAIN, query
monitoring, cancellation, and `OPTIMIZE TABLE` maintenance.

The extension is currently published as a preview. It supports user/password
authentication over HTTP or HTTPS; credentials are stored by the core extension
in VS Code Secret Storage.
