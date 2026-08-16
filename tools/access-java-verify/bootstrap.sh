#!/usr/bin/env bash
# Downloads the Jackcess jar (and dependencies) into tools/access-java-verify/lib
# and compiles DumpFile.java.
#
# Requires: any JDK distribution version 11+ (JAVA_HOME or PATH).
# Jackcess 5.1.5 requires: commons-lang3, commons-logging, commons-math3, agrona.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$SCRIPT_DIR/lib"
CLASSES_DIR="$SCRIPT_DIR/classes"
JACK_VERSION="5.1.5"
M2="https://repo1.maven.org/maven2"

mkdir -p "$LIB_DIR" "$CLASSES_DIR"

download() {
    local group="$1" artifact="$2" version="$3"
    local url="$M2/$group/$artifact/$version/$artifact-$version.jar"
    local target="$LIB_DIR/$artifact-$version.jar"
    if [ ! -f "$target" ]; then
        echo "Downloading $artifact-$version.jar ..."
        curl -fsSL "$url" -o "$target"
    fi
}

download "io/github/spannm" "jackcess" "$JACK_VERSION"
download "org/apache/commons" "commons-lang3" "3.17.0"
download "commons-logging" "commons-logging" "1.3.4"
download "org/apache/commons" "commons-math3" "3.6.1"
download "org/agrona" "agrona" "1.21.2"

CP="$(find "$LIB_DIR" -name '*.jar' | paste -sd: -)"
javac -cp "$CP" -d "$CLASSES_DIR" "$SCRIPT_DIR/DumpFile.java"
echo "Java Jackcess verify tool ready."
