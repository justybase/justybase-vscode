# UCanAccess Bridge (Java)

A small JSON-lines sidecar that exposes Microsoft Access (`.mdb` / `.accdb`)
databases to the Node.js extension through the [UCanAccess](https://ucanaccess.sourceforge.net/)
JDBC driver. It requires no native ODBC bindings — just a Java 11+ runtime on
the user's machine.

## Building the fat-jar

The prebuilt jar lives at `../resources/access-bridge.jar` and is shipped inside
the extension VSIX, so end users never build it. Rebuild it when the Java source
changes (requires a JDK 11+ and Maven):

```bash
npm run build:access-jar
```

This runs `mvn package` in this directory and copies
`target/access-bridge.jar` to `../resources/access-bridge.jar`.

## Protocol

One JSON document per line on stdin; one response with the matching `id` on
stdout. Diagnostics go to stderr.

| op | request | response |
|----|---------|----------|
| `connect` | `{"path": "...", "readOnly": false, "password": "..."}` | `{ok: true}` |
| `query` | `{"sql": "...", "params": [], "maxRows": 50000}` | `{kind:"query", columns:[{name,type,jdbcType,precision,scale}], rows:[...], recordsAffected}` or `{kind:"update", recordsAffected}` |
| `cancel` | `{"queryId": N}` | `{ok: true}` |
| `metadata` | `{"kind": "tables", "table": null}` | `{kind:"metadata", columns:[{name,type}], rows:[...]}` |
| `ping` | `{}` | `{ok: true}` |
| `close` | `{}` | `{ok: true}` |

The connection uses `jdbc:ucanaccess://<path>;memory=false` so large `.accdb`
files are mirrored on disk (HSQLDB) instead of being loaded into RAM.

### Metadata kinds

`databases`, `schemas`, `tables`, `views`, `procedures`, `object_type`,
`type_groups`, `columns`, `table_columns`, `column_metadata`, `table_comment`,
`object_search`, `view_source_search`, `procedure_source_search`.

## Cancellation

Queries run on a single worker thread (Access files are written by one process
at a time). `cancel` is handled on the reader thread via `Statement.cancel()`;
a cancelled query responds with `cancelled: true`.
