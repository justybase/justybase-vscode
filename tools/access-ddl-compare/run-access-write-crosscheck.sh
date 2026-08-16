#!/usr/bin/env bash
# Cross-check: writes an Access file with the TypeScript direct-mutation
# engine, then reads it back with the C# UCanAccessCs port (independent
# reader) and compares the rows.
#
# Usage: run-access-write-crosscheck.sh
#
# Requires: .NET SDK (net10.0), the cloned port in .clone/ (bootstrap.sh).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -d ".clone" ]; then
    echo "The JustyBase.UCanAccessCs port is not cloned. Run bootstrap.sh first." >&2
    exit 2
fi
if ! command -v dotnet >/dev/null 2>&1; then
    echo "The .NET SDK is not installed." >&2
    exit 2
fi

dotnet build >/dev/null 2>&1

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cp "$SCRIPT_DIR/../../src/__tests__/fixtures/access/sample2007.accdb" "$WORK/source.accdb"

cat > "$WORK/run.cjs" <<EOF
const fs = require('fs');
const { JetTable } = require('$SCRIPT_DIR/../../packages/access-file/dist/jet/JetTable.js');
const { JetPageChannel } = require('$SCRIPT_DIR/../../packages/access-file/dist/jet/JetPageChannel.js');
const { jetLayoutFor } = require('$SCRIPT_DIR/../../packages/access-file/dist/jet/JetLayout.js');
const { writeAccessSnapshotChanges } = require('$SCRIPT_DIR/../../packages/access-file/dist/jet/JetWriter.js');

async function main() {
  const src = process.argv[2];
  const out = process.argv[3];
  const rowsArg = JSON.parse(process.argv[4] || '[]');
  fs.copyFileSync(src, out);

  const open = () => {
    const buf = fs.readFileSync(out);
    const channel = new JetPageChannel(buf, jetLayoutFor('accdb2007'));
    const t = new JetTable(channel, 't_people', 80);
    return { t, rows: t.rowLocations().map(l => t.readRowValues(l)) };
  };
  const snapshot = (rows) => ({
    definition: { name: 't_people', columns: [], rowCount: rows.length, isSystem: false },
    rows,
  });

  const { rows } = open();
  const combined = rows.map(r => [...r]);
  for (const row of rowsArg) combined.push(row);
  await writeAccessSnapshotChanges(out, 'accdb2007', [snapshot(rows)], [snapshot(combined)]);
}

main().catch((e) => { console.error(e); process.exit(1); });
EOF

node "$WORK/run.cjs" "$WORK/source.accdb" "$WORK/out.accdb" "$(cat <<'JSON'
[[4,"Cross Check Row",50,10000,1700000000000,true],[5,"Second Row",25,2500,1600000000000,false]]
JSON
)"

echo "--- C# reader rows of the written file:"
dotnet run -- --source "$WORK/out.accdb" --rows
