import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import archiver from 'archiver';

const require = createRequire(import.meta.url);
const { packager } = require('@electron/packager');

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const electronRoot = path.join(repositoryRoot, 'apps', 'electron');
const electronDist = path.join(electronRoot, 'dist');
const dialectsDirectory = path.join(repositoryRoot, 'dialects');
const artifactsDirectory = path.join(repositoryRoot, 'artifacts', 'electron');
const stagingDirectory = path.join(artifactsDirectory, 'staging');
const packagedDirectory = path.join(artifactsDirectory, 'packaged');

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next workspace/node_modules location.
    }
  }
  throw new Error(`Could not find a required file. Tried: ${candidates.join(', ')}`);
}

async function assertDirectory(directory, label) {
  try {
    const details = await stat(directory);
    if (!details.isDirectory()) throw new Error(`${label} is not a directory.`);
  } catch (error) {
    throw new Error(`${label} is unavailable at ${directory}. Run the Electron build first.`, { cause: error });
  }
}

async function copyWithoutSourceMaps(source, destination) {
  await cp(source, destination, {
    recursive: true,
    filter: candidate => !candidate.endsWith('.map'),
  });
}

async function createZip(sourceDirectory, zipPath) {
  await mkdir(path.dirname(zipPath), { recursive: true });
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const completion = new Promise((resolve, reject) => {
    output.once('close', resolve);
    output.once('error', reject);
    archive.once('error', reject);
  });

  archive.pipe(output);
  archive.directory(sourceDirectory, path.basename(sourceDirectory));
  await archive.finalize();
  await completion;
}

async function main() {
  const rootPackage = await readJson(path.join(repositoryRoot, 'package.json'));
  const electronManifestPath = await firstExistingPath([
    path.join(repositoryRoot, 'node_modules', 'electron', 'package.json'),
    path.join(electronRoot, 'node_modules', 'electron', 'package.json'),
  ]);
  const electronPackage = await readJson(electronManifestPath);

  await assertDirectory(electronDist, 'Electron dist');
  await assertDirectory(dialectsDirectory, 'Dialect resources');

  await rm(stagingDirectory, { recursive: true, force: true });
  await rm(packagedDirectory, { recursive: true, force: true });
  await mkdir(stagingDirectory, { recursive: true });

  await copyWithoutSourceMaps(electronDist, path.join(stagingDirectory, 'dist'));
  await cp(dialectsDirectory, path.join(stagingDirectory, 'dialects'), { recursive: true });
  await cp(path.join(repositoryRoot, 'LICENSE'), path.join(stagingDirectory, 'LICENSE'));

  const packageManifest = {
    name: 'justybase-electron',
    productName: 'JustyBase',
    version: rootPackage.version,
    description: 'Portable JustyBase SQL workspace.',
    main: 'dist/main/main.js',
    license: 'Apache-2.0',
  };
  await writeFile(
    path.join(stagingDirectory, 'package.json'),
    `${JSON.stringify(packageManifest, null, 2)}\n`,
    'utf8',
  );

  const packagedPaths = await packager({
    dir: stagingDirectory,
    name: 'JustyBase',
    executableName: 'JustyBase',
    platform: 'win32',
    arch: 'x64',
    electronVersion: electronPackage.version,
    out: packagedDirectory,
    overwrite: true,
    asar: true,
    prune: false,
    derefSymlinks: true,
    quiet: false,
  });

  const packagedAppDirectory = packagedPaths[0];
  if (!packagedAppDirectory) throw new Error('Electron packager did not return an output directory.');

  const executablePath = path.join(packagedAppDirectory, 'JustyBase.exe');
  const asarPath = path.join(packagedAppDirectory, 'resources', 'app.asar');
  await access(executablePath);
  await access(asarPath);

  const zipName = `justybase-electron-win-x64-v${rootPackage.version}.zip`;
  const zipPath = path.join(artifactsDirectory, zipName);
  await rm(zipPath, { force: true });
  await createZip(packagedAppDirectory, zipPath);

  const zipDetails = await stat(zipPath);
  if (zipDetails.size === 0) throw new Error(`Created ZIP is empty: ${zipPath}`);

  console.log(`Portable Electron package created: ${path.relative(repositoryRoot, zipPath)}`);
  console.log(`Electron runtime: ${electronPackage.version}`);
  console.log(`Packaged app: ${path.relative(repositoryRoot, packagedAppDirectory)}`);
  console.log(`ZIP size: ${zipDetails.size} bytes`);
}

await main();
