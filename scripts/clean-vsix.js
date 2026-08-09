#!/usr/bin/env node
"use strict";
const fs = require("fs");
const path = require("path");

/**
 * Removes stale `.vsix` artifacts from the repository root.
 * These unsigned archives are gitignored but tend to accumulate in the working
 * tree and bloat the workspace / accidental `git add .`.
 */
const root = path.resolve(__dirname, "..");

let count = 0;
let removedBytes = 0;

for (const entry of fs.readdirSync(root)) {
    if (!entry.toLowerCase().endsWith(".vsix")) {
        continue;
    }
    const file = path.join(root, entry);
    try {
        const stat = fs.statSync(file);
        removedBytes += stat.size;
        fs.unlinkSync(file);
        count += 1;
        process.stdout.write(`Removed ${entry} (${stat.size} bytes)\n`);
    } catch (err) {
        process.stderr.write(`Failed to remove ${entry}: ${err.message}\n`);
    }
}

process.stdout.write(
    `clean-vsix: removed ${count} file(s), freed ${(removedBytes / 1024 / 1024).toFixed(1)} MiB\n`
);