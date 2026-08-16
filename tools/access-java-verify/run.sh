#!/usr/bin/env bash
# Runs the Jackcess DumpFile tool against the given Access file.
#
# Usage: run.sh <path-to-mdb-or-accdb>
# Requires: any JDK distribution version 11+ (JAVA_HOME or PATH).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

if [ "$#" -ne 1 ]; then
    echo "Usage: run.sh <path-to-mdb-or-accdb>" >&2
    exit 2
fi
if [ ! -f "$1" ]; then
    echo "File not found: $1" >&2
    exit 2
fi
if [ ! -d "$SCRIPT_DIR/classes" ] || [ ! -d "$SCRIPT_DIR/lib" ]; then
    "$SCRIPT_DIR/bootstrap.sh"
fi

CP="$SCRIPT_DIR/classes:$(find "$SCRIPT_DIR/lib" -name '*.jar' | paste -sd: -)"
java -cp "$CP" DumpFile "$1"
