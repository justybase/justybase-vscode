#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  listPresentOptionalExtensions,
  repoRoot,
} = require("./optional-extensions");

const coreDir = repoRoot;
const contractsPackage = {
  id: "contracts",
  directory: path.join(repoRoot, "packages/contracts"),
  packageJson: path.join(repoRoot, "packages/contracts/package.json"),
  packageLock: path.join(repoRoot, "packages/contracts/package-lock.json"),
};

const paths = {
  corePackage: path.join(coreDir, "package.json"),
  coreLock: path.join(coreDir, "package-lock.json"),
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function normalizeTag(releaseTag) {
  return releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag;
}

function isValidSemver(version) {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/.test(
    version,
  );
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return undefined;
  }

  return readJson(filePath);
}

function resolveNpmInvocation() {
  if (process.platform !== "win32") {
    return { command: "npm", prefixArgs: [] };
  }

  const npmExecPath = process.env.npm_execpath;
  if (
    npmExecPath &&
    fs.existsSync(npmExecPath) &&
    npmExecPath.toLowerCase().endsWith("npm-cli.js")
  ) {
    return {
      command: process.execPath,
      prefixArgs: [npmExecPath],
    };
  }

  const whereResult = spawnSync("where.exe", ["npm.cmd"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (whereResult.status === 0) {
    const resolvedPath = whereResult.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (resolvedPath) {
      return {
        command: resolvedPath,
        prefixArgs: [],
      };
    }
  }

  return {
    command: "npm.cmd",
    prefixArgs: [],
  };
}

function getManagedExtensions() {
  const managed = [contractsPackage, ...listPresentOptionalExtensions()];
  return managed.filter((item) => fs.existsSync(item.directory));
}

function getManagedPackages(includeOptionalExtensions = false) {
  const managed = [contractsPackage];
  if (includeOptionalExtensions) {
    managed.push(...listPresentOptionalExtensions());
  }
  return managed.filter((item) => fs.existsSync(item.directory));
}

function getVersionEntries(options = {}) {
  const includeOptionalExtensions = options.includeOptionalExtensions === true;
  const corePackage = readJson(paths.corePackage);
  const coreLock = readJson(paths.coreLock);
  const contractsLockVersion =
    coreLock.packages?.["packages/contracts"]?.version ??
    coreLock.packages?.["packages@justybase/contracts"]?.version;

  const entries = [
    ["core package.json", corePackage.version],
    ["core package-lock.json", coreLock.version],
    ['core package-lock.json packages[""]', coreLock.packages?.[""]?.version],
    [
      'core package-lock.json packages["packages/contracts"]',
      contractsLockVersion,
    ],
  ];

  for (const extension of getManagedPackages(includeOptionalExtensions)) {
    const extensionPackage = readJsonIfExists(extension.packageJson);
    const extensionLock = readJsonIfExists(extension.packageLock);

    let extensionLockVersion = extensionLock?.version;
    let extensionPackagesRootVersion = extensionLock?.packages?.[""]?.version;

    if (!extensionLock && coreLock?.packages) {
      const relativeExtensionPath = path.relative(repoRoot, extension.directory).replace(/\\/g, "/");
      const corePackageLockEntry = coreLock.packages?.[relativeExtensionPath];

      if (corePackageLockEntry) {
        extensionLockVersion = extensionLockVersion ?? corePackageLockEntry.version;
        extensionPackagesRootVersion = extensionPackagesRootVersion ?? corePackageLockEntry.version;
      }
    }

    entries.push(
      [`${extension.id} package.json`, extensionPackage?.version],
      [`${extension.id} package-lock.json`, extensionLockVersion],
      [
        `${extension.id} package-lock.json packages[""]`,
        extensionPackagesRootVersion,
      ],
    );
  }

  return entries;
}

function describeManagedTargets(options = {}) {
  return [
    "core",
    ...getManagedPackages(options.includeOptionalExtensions).map(
      (extension) => extension.id,
    ),
  ].join(", ");
}

function validateVersions(options = {}) {
  const entries = getVersionEntries(options);
  const mismatches = [];
  const expected = entries[0][1];

  for (const [label, value] of entries) {
    if (value !== expected) {
      mismatches.push(`${label}=${value ?? "missing"}`);
    }
  }

  if (mismatches.length > 0) {
    fail(
      `Version mismatch detected. Expected all extension manifests/lockfiles to equal ${expected}. ` +
        `Found: ${mismatches.join(", ")}.`,
    );
  }

  if (options.releaseTag) {
    const normalizedTag = normalizeTag(options.releaseTag);
    if (normalizedTag !== expected) {
      fail(
        `Release tag "${options.releaseTag}" must match package version "${expected}" ` +
          '(an optional leading "v" is allowed).',
      );
    }
  }

  return expected;
}

function runNpmVersion(targetDir, versionArg) {
  const npmInvocation = resolveNpmInvocation();
  const result = spawnSync(
    npmInvocation.command,
    [
      ...npmInvocation.prefixArgs,
      "version",
      versionArg,
      "--no-git-tag-version",
      "--allow-same-version",
    ],
    {
      cwd: targetDir,
      stdio: "inherit",
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function setVersion(version, options = {}) {
  if (!isValidSemver(version)) {
    fail(`Invalid semver version: ${version}`);
  }

  runNpmVersion(coreDir, version);
  for (const extension of getManagedPackages(options.includeOptionalExtensions)) {
    runNpmVersion(extension.directory, version);
  }

  const synchronizedVersion = validateVersions(options);
  console.log(
    `Synchronized ${describeManagedTargets(options)} to version ${synchronizedVersion}.`,
  );
}

function bumpVersion(releaseType, options = {}) {
  const allowedReleaseTypes = new Set([
    "patch",
    "minor",
    "major",
    "prepatch",
    "preminor",
    "premajor",
    "prerelease",
  ]);
  if (!allowedReleaseTypes.has(releaseType)) {
    fail(`Unsupported release type: ${releaseType}`);
  }

  runNpmVersion(coreDir, releaseType);

  const corePackage = readJson(paths.corePackage);
  for (const extension of getManagedPackages(options.includeOptionalExtensions)) {
    runNpmVersion(extension.directory, corePackage.version);
  }

  const synchronizedVersion = validateVersions(options);
  console.log(
    `Bumped ${describeManagedTargets(options)} to version ${synchronizedVersion}.`,
  );
}

function printUsage() {
  console.log(
    "Usage: node scripts/version-sync.js <check|set|bump> [value] [--release-tag <tag>] [--include-optionals]",
  );
  console.log("  check [--release-tag v1.2.3]");
  console.log("  set <1.2.3>");
  console.log(
    "  bump <patch|minor|major|prepatch|preminor|premajor|prerelease>",
  );
}

function parseArgs(argv) {
  const positional = [];
  let releaseTag;
  let includeOptionalExtensions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--release-tag") {
      releaseTag = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg === "--include-optionals" || arg === "--all") {
      includeOptionalExtensions = true;
      continue;
    }

    positional.push(arg);
  }

  return { includeOptionalExtensions, positional, releaseTag };
}

function main() {
  const { includeOptionalExtensions, positional, releaseTag } = parseArgs(process.argv.slice(2));
  const [command, value] = positional;
  const options = { includeOptionalExtensions, releaseTag };

  switch (command) {
    case "check": {
      const version = validateVersions(options);
      console.log(`Version metadata is synchronized at ${version}.`);
      return;
    }
    case "set":
      if (!value) {
        fail("Missing version. Example: npm run version:set -- 1.2.3");
      }
      setVersion(value, options);
      return;
    case "bump":
      if (!value) {
        fail("Missing release type. Example: npm run version:bump -- patch");
      }
      bumpVersion(value, options);
      return;
    default:
      printUsage();
      if (command) {
        process.exit(1);
      }
  }
}

main();
