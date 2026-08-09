# resources/access-bridge.jar

This directory holds the prebuilt UCanAccess bridge fat-jar that is bundled into
the extension VSIX.

The jar is generated from `../java-bridge/` and is committed to the repository so
packaging works without Maven. Its adjacent `.sha256` file is checked before the
Java process starts, and the CycloneDX SBOM records the locked runtime libraries.
Rebuild it after changing the Java source:

```bash
npm run build:access-jar
```

Requires a JDK 11+ and Maven on the machine running the build.
