#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultArtifactRoot = path.join(root, 'artifacts', 'quality');
const defaultCoverageRoot = path.join(root, 'coverage');

export function prepareQualityArtifacts({
  artifactRoot = defaultArtifactRoot,
  coverageRoot = defaultCoverageRoot,
} = {}) {
  fs.rmSync(artifactRoot, { recursive: true, force: true });
  fs.rmSync(coverageRoot, { recursive: true, force: true });
  fs.mkdirSync(artifactRoot, { recursive: true });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareQualityArtifacts();
}
