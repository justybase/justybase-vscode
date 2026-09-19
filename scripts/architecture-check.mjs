#!/usr/bin/env node

/**
 * Repository-wide production dependency graph checker.
 *
 * The graph is deliberately built from TypeScript's AST rather than regular
 * expressions. This keeps comments, strings, type-only imports and dynamic
 * imports distinguishable while still allowing the checker to run without a
 * second build tool or an additional npm dependency.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isBuiltin } from 'node:module';
import { fileURLToPath } from 'node:url';
import * as ts from 'typescript';

export const ARCHITECTURE_RULES_PATH = 'quality/architecture-rules.json';
export const ARCHITECTURE_CODES = Object.freeze({
  forbiddenDependency: 'ARCH001',
  unresolvedImport: 'ARCH002',
  dependencyCycle: 'ARCH003',
  invalidConfiguration: 'ARCH004',
});

export const architectureLayerNames = Object.freeze([
  'contracts',
  'shared',
  'desktop',
  'media',
  'api',
  'web',
  'companions',
]);

// Kept as a public compatibility export for callers that used the original
// boundary scanner. The default check no longer limits itself to these paths.
export const architectureBoundaries = Object.freeze([
  'packages/contracts/src',
  'packages/sql-core/src',
  'packages/database-runtime/src',
  'packages/designer-core/src',
]);

const productionExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const ignoredDirectoryNames = new Set([
  '.git',
  '.vscode-test',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  '__tests__',
  '__mocks__',
]);
const ignoredFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const legacyVscodeImportPattern = /(?:from\s*['"]vscode['"]|require\(\s*['"]vscode['"]\s*\)|import\s+['"]vscode['"])/u;
const legacyDesignerCorePlatformPattern = /(?:from\s*['"](?:react|react-dom|node:[^'"]+|@justybase\/(?:netezza-driver|spreadsheet-tasks))['"]|require\(\s*['"](?:react|react-dom|node:[^'"]+|@justybase\/(?:netezza-driver|spreadsheet-tasks))['"]\s*\))/u;

function normalizeSlashes(value) {
  return value.split(path.sep).join('/');
}

function relativePath(root, absolutePath) {
  return normalizeSlashes(path.relative(root, absolutePath));
}

function absolutePath(root, relative) {
  return path.resolve(root, relative.split('/').join(path.sep));
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isProductionFileName(fileName) {
  return productionExtensions.has(path.extname(fileName))
    && !fileName.endsWith('.d.ts')
    && !ignoredFilePattern.test(fileName);
}

function isIgnoredDirectory(name) {
  return ignoredDirectoryNames.has(name);
}

function walkDirectories(root) {
  if (!fs.existsSync(root)) return [];
  const directories = [];
  const visit = directory => {
    directories.push(directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || isIgnoredDirectory(entry.name)) continue;
      visit(path.join(directory, entry.name));
    }
  };
  visit(root);
  return directories;
}

function walkProductionFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  const visit = currentDirectory => {
    for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!isIgnoredDirectory(entry.name)) visit(path.join(currentDirectory, entry.name));
        continue;
      }
      if (isProductionFileName(entry.name)) files.push(path.join(currentDirectory, entry.name));
    }
  };
  visit(directory);
  return files;
}

function globToRegExp(pattern) {
  let expression = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      expression += '.*';
      index += 1;
    } else if (character === '*') {
      expression += '[^/]*';
    } else if (character === '?') {
      expression += '[^/]';
    } else {
      expression += character.replace(/[|\\{}()[\]^$+?.]/gu, '\\$&');
    }
  }
  return new RegExp(`${expression}$`, 'u');
}

function matchesPathPattern(pattern, relative) {
  return globToRegExp(normalizeSlashes(pattern)).test(relative);
}

function sourcePatternSpecificity(pattern) {
  const wildcardCount = [...pattern].filter(character => character === '*' || character === '?').length;
  return pattern.length - wildcardCount * 2;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function configError(message) {
  return {
    code: ARCHITECTURE_CODES.invalidConfiguration,
    message,
  };
}

function validatePathPattern(value, field, errors, { allowGlob = true } = {}) {
  if (!isNonEmptyString(value)) {
    errors.push(configError(`${field} must be a non-empty path pattern.`));
    return;
  }
  if (path.isAbsolute(value) || value.includes('\\') || value.split('/').includes('..')) {
    errors.push(configError(`${field} must be a repository-relative POSIX path pattern: ${value}`));
  }
  if (!allowGlob && /[*?]/u.test(value)) {
    errors.push(configError(`${field} must be an exact repository-relative path: ${value}`));
  }
}

function validateRules(rawRules) {
  const errors = [];
  if (!rawRules || typeof rawRules !== 'object' || Array.isArray(rawRules)) {
    return { rules: null, errors: [configError('Rules must be a JSON object.')] };
  }
  if (rawRules.version !== 1) errors.push(configError('Rules version must be 1.'));

  const layers = rawRules.layers;
  if (!layers || typeof layers !== 'object' || Array.isArray(layers)) {
    errors.push(configError('Rules must define a layers object.'));
  }
  const layerSet = new Set(architectureLayerNames);
  if (layers && typeof layers === 'object' && !Array.isArray(layers)) {
    for (const layerName of architectureLayerNames) {
      const layer = layers[layerName];
      if (!layer || typeof layer !== 'object' || Array.isArray(layer) || !Array.isArray(layer.sources) || layer.sources.length === 0) {
        errors.push(configError(`Layer ${layerName} must define a non-empty sources array.`));
        continue;
      }
      layer.sources.forEach((source, index) => validatePathPattern(source, `layers.${layerName}.sources[${index}]`, errors));
    }
    for (const layerName of Object.keys(layers)) {
      if (!layerSet.has(layerName)) errors.push(configError(`Unknown layer: ${layerName}`));
    }
  }

  const allowedDependencies = rawRules.allowedDependencies;
  if (!allowedDependencies || typeof allowedDependencies !== 'object' || Array.isArray(allowedDependencies)) {
    errors.push(configError('Rules must define an allowedDependencies object.'));
  } else {
    for (const layerName of architectureLayerNames) {
      const dependencies = allowedDependencies[layerName];
      if (!Array.isArray(dependencies)) {
        errors.push(configError(`allowedDependencies.${layerName} must be an array.`));
        continue;
      }
      for (const dependency of dependencies) {
        if (!layerSet.has(dependency)) errors.push(configError(`Unknown dependency layer ${dependency} in ${layerName}.`));
      }
    }
    for (const layerName of Object.keys(allowedDependencies)) {
      if (!layerSet.has(layerName)) errors.push(configError(`Unknown allowedDependencies layer: ${layerName}`));
    }
  }

  const exceptions = rawRules.exceptions ?? [];
  if (!Array.isArray(exceptions)) {
    errors.push(configError('exceptions must be an array.'));
  } else {
    exceptions.forEach((exception, index) => validateException(exception, `exceptions[${index}]`, errors, { allowGlob: false }));
  }

  const pureSources = rawRules.pureSources ?? [];
  const pureExternalImports = rawRules.pureExternalImports ?? [];
  const pureExternalExceptions = rawRules.pureExternalExceptions ?? [];
  if (!Array.isArray(pureSources)) errors.push(configError('pureSources must be an array.'));
  else pureSources.forEach((source, index) => validatePathPattern(source, `pureSources[${index}]`, errors));
  if (!Array.isArray(pureExternalImports) || pureExternalImports.some(value => !isNonEmptyString(value))) {
    errors.push(configError('pureExternalImports must contain exact module specifiers.'));
  }
  if (!Array.isArray(pureExternalExceptions)) errors.push(configError('pureExternalExceptions must be an array.'));
  else pureExternalExceptions.forEach((exception, index) => validateException(exception, `pureExternalExceptions[${index}]`, errors, { allowGlob: false }));

  const cycleExceptions = rawRules.cycleExceptions ?? [];
  const browserSources = rawRules.browserSources ?? [];
  const browserExternalImports = rawRules.browserExternalImports ?? [];
  if (!Array.isArray(browserSources)) errors.push(configError('browserSources must be an array.'));
  else browserSources.forEach((source, index) => validatePathPattern(source, `browserSources[${index}]`, errors));
  if (!Array.isArray(browserExternalImports) || browserExternalImports.some(value => !isNonEmptyString(value))) {
    errors.push(configError('browserExternalImports must contain exact module specifiers.'));
  }
  const packageDependencies = rawRules.packageDependencies ?? {};
  if (!packageDependencies || typeof packageDependencies !== 'object' || Array.isArray(packageDependencies)) {
    errors.push(configError('packageDependencies must be an object.'));
  } else {
    for (const [owner, dependencies] of Object.entries(packageDependencies)) {
      if (!/^packages\/[^/*]+$/u.test(owner)) errors.push(configError(`Invalid package boundary: ${owner}`));
      if (!Array.isArray(dependencies)) {
        errors.push(configError(`packageDependencies.${owner} must be an array.`));
      } else {
        for (const dependency of dependencies) {
          if (!Object.hasOwn(packageDependencies, dependency)) errors.push(configError(`Unknown package dependency ${dependency} in ${owner}.`));
        }
      }
    }
  }
  if (!Array.isArray(cycleExceptions)) {
    errors.push(configError('cycleExceptions must be an array.'));
  } else {
    cycleExceptions.forEach((exception, index) => {
      validateException(exception, `cycleExceptions[${index}]`, errors, { allowGlob: false });
      if (!Array.isArray(exception?.nodes) || exception.nodes.length === 0) {
        errors.push(configError(`cycleExceptions[${index}].nodes must be a non-empty array.`));
      } else {
        exception.nodes.forEach((node, nodeIndex) => validatePathPattern(node, `cycleExceptions[${index}].nodes[${nodeIndex}]`, errors, { allowGlob: false }));
      }
      if (!/^[a-f0-9]{64}$/u.test(exception?.edgeFingerprint ?? '')) {
        errors.push(configError(`cycleExceptions[${index}].edgeFingerprint must be a SHA-256 hex string.`));
      }
    });
  }

  const workspaceEntryPoints = rawRules.workspaceEntryPoints ?? {};
  if (!workspaceEntryPoints || typeof workspaceEntryPoints !== 'object' || Array.isArray(workspaceEntryPoints)) {
    errors.push(configError('workspaceEntryPoints must be an object.'));
  } else {
    for (const [packageName, entryPoint] of Object.entries(workspaceEntryPoints)) {
      if (!packageName.startsWith('@') && packageName.includes('/')) {
        errors.push(configError(`workspaceEntryPoints key is not a package name: ${packageName}`));
      }
      validatePathPattern(entryPoint, `workspaceEntryPoints.${packageName}`, errors, { allowGlob: false });
    }
  }

  const forbiddenImports = rawRules.forbiddenImports ?? [];
  if (!Array.isArray(forbiddenImports)) {
    errors.push(configError('forbiddenImports must be an array.'));
  } else {
    forbiddenImports.forEach((rule, index) => {
      if (!rule || typeof rule !== 'object' || !isNonEmptyString(rule.specifier)) {
        errors.push(configError(`forbiddenImports[${index}] must define a specifier.`));
      } else {
        try {
          new RegExp(rule.specifier, 'u');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(configError(`forbiddenImports[${index}].specifier is not a valid regular expression: ${message}`));
        }
      }
      if (rule?.source !== undefined) validatePathPattern(rule.source, `forbiddenImports[${index}].source`, errors);
      if (rule?.layer !== undefined && !layerSet.has(rule.layer)) errors.push(configError(`Unknown forbidden import layer ${rule.layer}.`));
    });
  }

  if (errors.length > 0) return { rules: null, errors };
  return {
    rules: {
      version: 1,
      layers,
      allowedDependencies,
      exceptions,
      cycleExceptions,
      workspaceEntryPoints,
      forbiddenImports,
      pureSources,
      pureExternalImports,
      pureExternalExceptions,
      browserSources,
      browserExternalImports,
      packageDependencies,
    },
    errors: [],
  };
}

function validateException(exception, field, errors, { allowGlob = true } = {}) {
  if (!exception || typeof exception !== 'object' || Array.isArray(exception)) {
    errors.push(configError(`${field} must be an object.`));
    return;
  }
  validatePathPattern(exception.source, `${field}.source`, errors, { allowGlob });
  validatePathPattern(exception.target, `${field}.target`, errors, { allowGlob });
  if (!isNonEmptyString(exception.reason)) errors.push(configError(`${field}.reason must be a non-empty string.`));
  if (!isNonEmptyString(exception.owner)) errors.push(configError(`${field}.owner must be a non-empty string.`));
  if (!isNonEmptyString(exception.removeWhen)) errors.push(configError(`${field}.removeWhen must be a non-empty string.`));
  if (exception.allowCycle !== undefined && typeof exception.allowCycle !== 'boolean') {
    errors.push(configError(`${field}.allowCycle must be boolean when present.`));
  }
}

export function loadArchitectureRules(root = process.cwd()) {
  const filePath = path.join(root, ARCHITECTURE_RULES_PATH);
  let rawRules;
  try {
    rawRules = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { rules: null, errors: [configError(`Cannot read ${ARCHITECTURE_RULES_PATH}: ${message}`)] };
  }
  return validateRules(rawRules);
}

function validateSourceDirectories(root, rules) {
  const errors = [];
  const directoryMatches = new Map();
  const allDirectories = walkDirectories(root);
  for (const layerName of architectureLayerNames) {
    const patterns = rules.layers[layerName].sources;
    for (const pattern of patterns) {
      const matches = allDirectories.filter(directory => matchesPathPattern(pattern, relativePath(root, directory)));
      if (matches.length === 0) errors.push(configError(`Source pattern ${pattern} for layer ${layerName} matches no directory.`));
      for (const directory of matches) {
        const absolute = path.resolve(directory);
        if (!directoryMatches.has(absolute)) directoryMatches.set(absolute, []);
        directoryMatches.get(absolute).push({ layerName, pattern, specificity: sourcePatternSpecificity(pattern) });
      }
    }
  }

  const layerDirectories = new Map(architectureLayerNames.map(layerName => [layerName, []]));
  for (const [directory, matches] of directoryMatches) {
    const highestSpecificity = Math.max(...matches.map(match => match.specificity));
    const owners = [...new Set(matches.filter(match => match.specificity === highestSpecificity).map(match => match.layerName))];
    if (owners.length > 1) {
      errors.push(configError(`Source directory ${relativePath(root, directory)} has equally specific owners: ${owners.join(', ')}.`));
      continue;
    }
    layerDirectories.get(owners[0]).push(directory);
  }
  for (const directories of layerDirectories.values()) directories.sort();
  return { errors, layerDirectories };
}

function collectProductionGraphFiles(root, layerDirectories) {
  const files = [];
  const fileLayers = new Map();
  const errors = [];
  for (const layerName of architectureLayerNames) {
    for (const directory of layerDirectories.get(layerName) ?? []) {
      for (const file of walkProductionFiles(directory)) {
        const absolute = path.resolve(file);
        const previous = fileLayers.get(absolute);
        if (previous && previous !== layerName) {
          errors.push(configError(`Production file ${relativePath(root, absolute)} belongs to both ${previous} and ${layerName}.`));
        } else if (!previous) {
          fileLayers.set(absolute, layerName);
          files.push(absolute);
        }
      }
    }
  }
  files.sort();
  return { files, fileLayers, errors };
}

function createTsConfigHost() {
  return {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  };
}

function findTsConfigFiles(root) {
  return walkDirectories(root)
    .map(directory => path.join(directory, 'tsconfig.json'))
    .filter(file => fs.existsSync(file));
}

function fallbackCompilerOptions() {
  return {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2020,
    allowJs: true,
    resolveJsonModule: true,
  };
}

function formatTsConfigDiagnostic(configPath, diagnostic) {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  const location = diagnostic.file && typeof diagnostic.start === 'number'
    ? `:${diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1}`
    : '';
  return configError(`${relativePath(path.dirname(configPath), configPath)}${location}: ${message}`);
}

function readCompilerOptions(_root, configPath) {
  try {
    const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, createTsConfigHost());
    if (!parsed) {
      return {
        options: fallbackCompilerOptions(),
        errors: [configError(`Cannot parse tsconfig ${configPath}.`)],
      };
    }
    if (parsed.errors?.length > 0) {
      return {
        options: parsed.options ?? fallbackCompilerOptions(),
        errors: parsed.errors.map(diagnostic => formatTsConfigDiagnostic(configPath, diagnostic)),
      };
    }
    if (parsed.options) return { options: parsed.options, errors: [] };
    return {
      options: fallbackCompilerOptions(),
      errors: [configError(`Cannot read compiler options from tsconfig ${configPath}.`)],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      options: fallbackCompilerOptions(),
      errors: [configError(`Cannot parse tsconfig ${configPath}: ${message}`)],
    };
  }
}

function createCompilerOptionsResolver(root) {
  const configs = findTsConfigFiles(root)
    .map(configPath => ({ configPath: path.resolve(configPath), directory: path.dirname(path.resolve(configPath)) }))
    .sort((left, right) => right.directory.length - left.directory.length);
  const cache = new Map();
  const errors = [];
  const resolve = filePath => {
    const config = configs.find(candidate => isPathInside(candidate.directory, filePath));
    const configPath = config?.configPath ?? '<default>';
    if (!cache.has(configPath)) {
      const parsed = configPath === '<default>'
        ? { options: fallbackCompilerOptions(), errors: [] }
        : readCompilerOptions(root, configPath);
      cache.set(configPath, parsed.options);
      errors.push(...parsed.errors);
    }
    const options = { ...cache.get(configPath) };
    options.__architectureConfigDirectory = config?.directory ?? root;
    if (options.moduleResolution === undefined) options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    if (options.module === undefined) options.module = ts.ModuleKind.ESNext;
    if (options.target === undefined) options.target = ts.ScriptTarget.ES2020;
    options.allowJs = true;
    options.resolveJsonModule = true;
    return options;
  };
  return { resolve, errors };
}

function discoverWorkspacePackages(root, rules) {
  const packages = new Map();
  for (const parentName of ['packages', 'apps']) {
    const parentDirectory = path.join(root, parentName);
    if (!fs.existsSync(parentDirectory)) continue;
    for (const entry of fs.readdirSync(parentDirectory, { withFileTypes: true })) {
      if (!entry.isDirectory() || isIgnoredDirectory(entry.name)) continue;
      const packageDirectory = path.join(parentDirectory, entry.name);
      const packageJsonPath = path.join(packageDirectory, 'package.json');
      const sourceDirectory = path.join(packageDirectory, 'src');
      if (!fs.existsSync(packageJsonPath) || !fs.existsSync(sourceDirectory)) continue;
      let packageJson;
      try {
        packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      } catch {
        continue;
      }
      if (!isNonEmptyString(packageJson.name)) continue;
      const configuredEntry = rules.workspaceEntryPoints[packageJson.name];
      const candidates = [];
      if (configuredEntry) candidates.push(absolutePath(root, configuredEntry));
      const mainName = typeof packageJson.main === 'string' ? path.basename(packageJson.main, path.extname(packageJson.main)) : 'index';
      candidates.push(path.join(sourceDirectory, `${mainName}.ts`));
      candidates.push(path.join(sourceDirectory, `${mainName}.tsx`));
      candidates.push(path.join(sourceDirectory, 'index.ts'));
      candidates.push(path.join(sourceDirectory, 'index.tsx'));
      const sourceFiles = walkProductionFiles(sourceDirectory);
      const entryPoint = candidates.find(candidate => sourceFiles.includes(path.resolve(candidate)))
        ?? (sourceFiles.length === 1 ? sourceFiles[0] : undefined);
      packages.set(packageJson.name, {
        name: packageJson.name,
        directory: path.resolve(packageDirectory),
        sourceDirectory: path.resolve(sourceDirectory),
        entryPoint: entryPoint ? path.resolve(entryPoint) : undefined,
      });
    }
  }
  return packages;
}

function sourceAliasMatch(specifier, compilerOptions) {
  const paths = compilerOptions.paths;
  if (!paths || typeof paths !== 'object') return undefined;
  for (const alias of Object.keys(paths)) {
    const starIndex = alias.indexOf('*');
    if (starIndex < 0) {
      if (specifier === alias) return { alias, remainder: '' };
      continue;
    }
    const prefix = alias.slice(0, starIndex);
    const suffix = alias.slice(starIndex + 1);
    if (specifier.startsWith(prefix) && specifier.endsWith(suffix) && specifier.length >= prefix.length + suffix.length) {
      return { alias, remainder: specifier.slice(prefix.length, specifier.length - suffix.length || undefined) };
    }
  }
  return undefined;
}

function isTypeScriptSourceFile(filePath) {
  return productionExtensions.has(path.extname(filePath)) && !filePath.endsWith('.d.ts');
}

function sourcePathCandidates(basePath) {
  const candidates = [];
  const add = candidate => {
    const absolute = path.resolve(candidate);
    if (isTypeScriptSourceFile(absolute) && fs.existsSync(absolute) && fs.statSync(absolute).isFile()) candidates.push(absolute);
  };
  const extension = path.extname(basePath);
  if (productionExtensions.has(extension)) {
    add(basePath);
  } else if (['.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    const stem = basePath.slice(0, -extension.length);
    for (const sourceExtension of productionExtensions) add(`${stem}${sourceExtension}`);
  } else if (extension.length === 0) {
    for (const sourceExtension of productionExtensions) add(`${basePath}${sourceExtension}`);
  }
  const directory = path.resolve(basePath);
  if (fs.existsSync(directory) && fs.statSync(directory).isDirectory()) {
    for (const sourceExtension of productionExtensions) add(path.join(directory, `index${sourceExtension}`));
  }
  return [...new Set(candidates)];
}

function codeCandidates(basePath, productionFiles) {
  return sourcePathCandidates(basePath).filter(candidate => productionFiles.has(candidate));
}

function existingNonCodePath(basePath) {
  const absolute = path.resolve(basePath);
  if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) return absolute;
  return undefined;
}

function isPathAliasSpecifier(specifier, compilerOptions) {
  return Boolean(sourceAliasMatch(specifier, compilerOptions));
}

function resolveKnownSpecifier({ root, importer, specifier, compilerOptions, productionFiles, workspacePackages }) {
  let basePath;
  let internal = false;

  if (specifier.startsWith('.')) {
    internal = true;
    basePath = path.resolve(path.dirname(importer), specifier);
  } else if (specifier.startsWith('/')) {
    internal = true;
    basePath = path.resolve(root, `.${specifier}`);
  } else if (/^(?:src|packages|apps|extensions)\//u.test(specifier)) {
    internal = true;
    basePath = path.resolve(root, specifier);
  } else if (isPathAliasSpecifier(specifier, compilerOptions)) {
    internal = true;
    const alias = sourceAliasMatch(specifier, compilerOptions);
    const targets = compilerOptions.paths[alias.alias];
    const baseUrl = compilerOptions.baseUrl
      ? path.resolve(compilerOptions.baseUrl)
      : compilerOptions.__architectureConfigDirectory ?? root;
    basePath = targets?.[0] ? path.resolve(baseUrl, targets[0].replace('*', alias.remainder)) : undefined;
  } else {
    for (const [packageName, workspacePackage] of workspacePackages) {
      if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue;
      internal = true;
      const subpath = specifier === packageName
        ? workspacePackage.entryPoint
        : path.join(workspacePackage.sourceDirectory, specifier.slice(packageName.length + 1));
      basePath = subpath;
      break;
    }
  }

  if (!internal) return { kind: 'external' };
  if (!basePath || !isPathInside(root, path.resolve(basePath))) return { kind: 'unresolved' };

  const candidate = codeCandidates(basePath, productionFiles)[0];
  if (candidate) return { kind: 'source', target: candidate };

  const outsideProductionCandidate = sourcePathCandidates(basePath)[0];
  if (outsideProductionCandidate) return { kind: 'outside-production', target: outsideProductionCandidate };

  const resolvedAsset = existingNonCodePath(basePath);
  if (resolvedAsset) return { kind: 'asset', target: resolvedAsset };

  const resolution = ts.resolveModuleName(
    specifier,
    importer,
    compilerOptions,
    ts.sys,
  ).resolvedModule;
  if (resolution?.resolvedFileName) {
    const resolvedFile = path.resolve(resolution.resolvedFileName);
    const resolvedCandidate = codeCandidates(resolvedFile, productionFiles)[0];
    if (resolvedCandidate) return { kind: 'source', target: resolvedCandidate };
    if (resolution.isExternalLibraryImport || resolvedFile.includes(`${path.sep}node_modules${path.sep}`)) return { kind: 'external' };
    if (resolution.extension === ts.Extension.Dts || resolvedFile.endsWith('.d.ts')) return { kind: 'declaration' };
    if (isTypeScriptSourceFile(resolvedFile)) return { kind: 'outside-production', target: resolvedFile };
    if (fs.existsSync(resolvedFile)) return { kind: 'asset', target: resolvedFile };
  }
  return { kind: 'unresolved' };
}

function importReferences(sourceFile) {
  const references = [];
  const add = (specifier, node, kind) => {
    const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
    const bindings = clause?.namedBindings;
    const typeOnly = kind === 'import-type' || node.isTypeOnly === true || clause?.isTypeOnly === true
      || Boolean(!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(element => element.isTypeOnly))
      || Boolean(ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)
        && node.exportClause.elements.length > 0 && node.exportClause.elements.every(element => element.isTypeOnly));
    references.push({ specifier, node, kind, typeOnly });
  };
  const visit = node => {
    if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression;
      if (ts.isStringLiteralLike(expression)) {
        add(expression.text, node, 'import-equals');
      } else if (ts.isCallExpression(expression)
        && expression.arguments.length >= 1
        && ts.isStringLiteralLike(expression.arguments[0])) {
        add(expression.arguments[0].text, node, 'import-equals');
      }
    } else if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      add(node.moduleSpecifier.text, node, ts.isImportDeclaration(node) ? 'import' : 'export');
    } else if (ts.isCallExpression(node)
      && node.arguments.length >= 1
      && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && !ts.findAncestor(node, ancestor => ts.isImportEqualsDeclaration(ancestor))) {
      add(node.arguments[0].text, node, node.expression.kind === ts.SyntaxKind.ImportKeyword ? 'dynamic-import' : 'require');
    } else if (ts.isImportTypeNode(node)
      && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteralLike(node.argument.literal)) {
      add(node.argument.literal.text, node, 'import-type');
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return references;
}

function lineNumber(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function forbiddenImportRuleMatches(rule, source, layer, specifier) {
  if (rule.layer && rule.layer !== layer) return false;
  if (rule.source && !matchesPathPattern(rule.source, source)) return false;
  if (rule.excludeSource && matchesPathPattern(rule.excludeSource, source)) return false;
  return new RegExp(rule.specifier, 'u').test(specifier);
}

function exceptionMatches(exception, source, target) {
  return matchesPathPattern(exception.source, source) && matchesPathPattern(exception.target, target);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function edgeKey(source, target) {
  return `${source}\0${target}`;
}

function cycleFingerprint(nodes, edges) {
  const nodeSet = new Set(nodes);
  const internalEdges = [...new Set(edges
    .filter(edge => nodeSet.has(edge.source) && nodeSet.has(edge.target))
    .map(edge => edgeKey(edge.source, edge.target)))]
    .sort();
  return sha256(internalEdges.join('\n'));
}

function stronglyConnectedComponents(nodes, edges) {
  const adjacency = new Map(nodes.map(node => [node, []]));
  for (const edge of edges) adjacency.get(edge.source)?.push(edge.target);
  let index = 0;
  const indexes = new Map();
  const lowLinks = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = node => {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node), lowLinks.get(target)));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node), indexes.get(target)));
      }
    }
    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      onStack.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || (adjacency.get(node) ?? []).includes(node)) components.push(component.sort());
  };
  for (const node of nodes) if (!indexes.has(node)) visit(node);
  return components.sort((left, right) => left[0].localeCompare(right[0]));
}

function isCycleExceptionMatch(exception, component, edges) {
  const expectedNodes = [...exception.nodes].sort();
  const actualNodes = [...component].sort();
  if (expectedNodes.length !== actualNodes.length || expectedNodes.some((node, index) => node !== actualNodes[index])) return false;
  if (cycleFingerprint(actualNodes, edges) !== exception.edgeFingerprint) return false;
  const componentNodes = new Set(component);
  return edges.some(edge => componentNodes.has(edge.source)
    && componentNodes.has(edge.target)
    && exceptionMatches(exception, edge.source, edge.target));
}

function makeDiagnostic(code, message, extra = {}) {
  return { code, message, ...extra };
}

function legacyFindArchitectureViolations(root, boundaries) {
  const violations = [];
  for (const relativeDirectory of boundaries) {
    for (const file of walkProductionFiles(path.join(root, relativeDirectory))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/u);
      lines.forEach((line, index) => {
        if (legacyVscodeImportPattern.test(line)) violations.push(`${relativePath(root, file)}:${index + 1}`);
        if (relativeDirectory === 'packages/designer-core/src' && legacyDesignerCorePlatformPattern.test(line)) {
          violations.push(`${relativePath(root, file)}:${index + 1} (designer-core platform import)`);
        }
      });
    }
  }
  return violations;
}

export function analyzeArchitecture(root = process.cwd(), suppliedRules) {
  const absoluteRoot = path.resolve(root);
  const loaded = suppliedRules ? validateRules(suppliedRules) : loadArchitectureRules(absoluteRoot);
  if (loaded.errors.length > 0) return { rules: null, diagnostics: loaded.errors, files: [], edges: [], cycles: [] };
  const rules = loaded.rules;
  const sourceValidation = validateSourceDirectories(absoluteRoot, rules);
  if (sourceValidation.errors.length > 0) return { rules, diagnostics: sourceValidation.errors, files: [], edges: [], cycles: [] };
  const collected = collectProductionGraphFiles(absoluteRoot, sourceValidation.layerDirectories);
  if (collected.errors.length > 0) return { rules, diagnostics: collected.errors, files: [], edges: [], cycles: [] };

  const productionFiles = new Set(collected.files);
  const compilerOptionsResolver = createCompilerOptionsResolver(absoluteRoot);
  const workspacePackages = discoverWorkspacePackages(absoluteRoot, rules);
  const sourceFiles = new Map();
  for (const file of collected.files) {
    const text = fs.readFileSync(file, 'utf8');
    sourceFiles.set(file, ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX));
  }

  const graphNodes = [...sourceFiles.keys()].map(file => relativePath(absoluteRoot, file)).sort();
  for (const file of sourceFiles.keys()) compilerOptionsResolver.resolve(file);
  if (compilerOptionsResolver.errors.length > 0) {
    return {
      rules,
      diagnostics: compilerOptionsResolver.errors,
      files: graphNodes,
      edges: [],
      cycles: [],
    };
  }

  const diagnostics = [];
  const edges = [];
  const uniqueEdges = new Map();
  const matchedExceptions = new Set();
  const matchedPureExternalExceptions = new Set();
  const runtimeEdges = [];
  const externalReferences = [];
  const packageOwner = source => source.startsWith('packages/') ? source.split('/').slice(0, 2).join('/') : undefined;
  if (Object.keys(rules.packageDependencies).length > 0) {
    for (const owner of new Set(graphNodes.map(packageOwner).filter(Boolean))) {
      if (!Object.hasOwn(rules.packageDependencies, owner)) diagnostics.push(configError(`Missing packageDependencies boundary for ${owner}.`));
    }
  }
  const isPure = source => rules.pureSources.some(pattern => matchesPathPattern(pattern, source));
  const forbiddenImports = rules.forbiddenImports;
  for (const [file, sourceFile] of sourceFiles) {
    const source = relativePath(absoluteRoot, file);
    const layer = collected.fileLayers.get(file);
    const compilerOptions = compilerOptionsResolver.resolve(file);
    for (const reference of importReferences(sourceFile)) {
      const target = resolveKnownSpecifier({
        root: absoluteRoot,
        importer: file,
        specifier: reference.specifier,
        compilerOptions,
        productionFiles,
        workspacePackages,
      });
      const line = lineNumber(sourceFile, reference.node);
      if (target.kind === 'external' && !reference.typeOnly) externalReferences.push({ source, specifier: reference.specifier, line });
      if (isPure(source) && target.kind === 'external') {
        const exceptionIndex = rules.pureExternalExceptions.findIndex(exception => exceptionMatches(exception, source, reference.specifier));
        const platform = isBuiltin(reference.specifier) || /^(?:node:|vscode(?:\/|$)|react(?:\/|$)|react-dom(?:\/|$)|electron(?:\/|$))/u.test(reference.specifier);
        if (exceptionIndex >= 0) matchedPureExternalExceptions.add(exceptionIndex);
        else if (platform || !rules.pureExternalImports.includes(reference.specifier)) {
          diagnostics.push(makeDiagnostic(ARCHITECTURE_CODES.forbiddenDependency,
            `${source}:${line} imports module ${reference.specifier} not approved for pure packages.`,
            { source, specifier: reference.specifier, line }));
        }
      }
      for (const rule of forbiddenImports) {
        if (forbiddenImportRuleMatches(rule, source, layer, reference.specifier)) {
          diagnostics.push(makeDiagnostic(
            ARCHITECTURE_CODES.forbiddenDependency,
            `${source}:${line} imports forbidden platform module ${reference.specifier}.`,
            { source, specifier: reference.specifier, line },
          ));
          break;
        }
      }
      if (target.kind === 'unresolved' || target.kind === 'outside-production') {
        const targetDescription = target.target
          ? ` outside the configured production graph: ${relativePath(absoluteRoot, target.target)}`
          : '';
        diagnostics.push(makeDiagnostic(
          ARCHITECTURE_CODES.unresolvedImport,
          `${source}:${line} cannot resolve internal import ${JSON.stringify(reference.specifier)}${targetDescription}.`,
          { source, specifier: reference.specifier, line, ...(target.target ? { target: relativePath(absoluteRoot, target.target) } : {}) },
        ));
        continue;
      }
      if (target.kind !== 'source') continue;
      const targetRelative = relativePath(absoluteRoot, target.target);
      const targetLayer = collected.fileLayers.get(target.target);
      if (!targetLayer) {
        diagnostics.push(makeDiagnostic(
          ARCHITECTURE_CODES.unresolvedImport,
          `${source}:${line} resolves to a file outside the configured production graph: ${targetRelative}.`,
          { source, target: targetRelative, line },
        ));
        continue;
      }
      const edge = {
        source,
        target: targetRelative,
        sourceLayer: layer,
        targetLayer,
        specifier: reference.specifier,
        line,
        kind: reference.kind,
      };
      edges.push(edge);
      if (!reference.typeOnly) runtimeEdges.push(edge);
      const sourcePackage = packageOwner(source);
      const targetPackage = packageOwner(targetRelative);
      if (sourcePackage && targetPackage && sourcePackage !== targetPackage
        && Object.hasOwn(rules.packageDependencies, sourcePackage)
        && !rules.packageDependencies[sourcePackage].includes(targetPackage)) {
        diagnostics.push(makeDiagnostic(ARCHITECTURE_CODES.forbiddenDependency,
          `${source}:${line} imports ${targetRelative} outside its package boundary.`,
          { source, target: targetRelative, line }));
      }
      const key = edgeKey(edge.source, edge.target);
      if (!uniqueEdges.has(key)) uniqueEdges.set(key, edge);
      const pureToRuntime = isPure(source) && targetLayer === 'shared' && !isPure(targetRelative);
      const crossCompanion = layer === 'companions' && targetLayer === 'companions'
        && source.split('/')[1] !== targetRelative.split('/')[1];
      if (layer !== targetLayer || pureToRuntime || crossCompanion) {
        const allowed = !pureToRuntime && !crossCompanion && (rules.allowedDependencies[layer]?.includes(targetLayer) ?? false);
        const exceptionIndex = rules.exceptions.findIndex(exception => exceptionMatches(exception, source, targetRelative));
        if (!allowed && exceptionIndex < 0) {
          diagnostics.push(makeDiagnostic(
            ARCHITECTURE_CODES.forbiddenDependency,
            `${source}:${line} (${layer}) depends on ${targetRelative} (${targetLayer}), which is outside the configured direction.`,
            { source, target: targetRelative, sourceLayer: layer, targetLayer, line },
          ));
        } else if (exceptionIndex >= 0) {
          matchedExceptions.add(exceptionIndex);
        }
      }
    }
  }

  const graphEdges = [...uniqueEdges.values()].sort((left, right) => edgeKey(left.source, left.target).localeCompare(edgeKey(right.source, right.target)));
  // Traverse value imports only: a renderer's erased host type does not bundle
  // the host runtime. The full graph above still checks type dependency cycles.
  const browserReachable = new Set(graphNodes.filter(source => rules.browserSources.some(pattern => matchesPathPattern(pattern, source))));
  const outgoing = new Map();
  for (const edge of runtimeEdges) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    outgoing.get(edge.source).push(edge);
  }
  const pending = [...browserReachable];
  for (let index = 0; index < pending.length; index += 1) {
    for (const edge of outgoing.get(pending[index]) ?? []) {
      if (edge.targetLayer === 'shared' && !isPure(edge.target)) {
        diagnostics.push(makeDiagnostic(ARCHITECTURE_CODES.forbiddenDependency,
          `${edge.source}:${edge.line} brings Node runtime ${edge.target} into the browser graph.`,
          { source: edge.source, target: edge.target, line: edge.line }));
      }
      if (!browserReachable.has(edge.target)) {
        browserReachable.add(edge.target);
        pending.push(edge.target);
      }
    }
  }
  for (const reference of externalReferences) {
    if (!browserReachable.has(reference.source)) continue;
    const platform = isBuiltin(reference.specifier) || /^(?:node:|vscode(?:\/|$)|electron(?:\/|$))/u.test(reference.specifier);
    if (platform || !rules.browserExternalImports.includes(reference.specifier)) {
      diagnostics.push(makeDiagnostic(ARCHITECTURE_CODES.forbiddenDependency,
        `${reference.source}:${reference.line} imports ${reference.specifier} not approved for the browser graph.`, reference));
    }
  }
  const components = stronglyConnectedComponents(graphNodes, graphEdges);
  const cycleDiagnostics = [];
  const matchedCycleExceptions = new Set();
  for (const component of components) {
    const matchingIndex = rules.cycleExceptions.findIndex(exception => isCycleExceptionMatch(exception, component, graphEdges));
    if (matchingIndex >= 0) {
      matchedCycleExceptions.add(matchingIndex);
      continue;
    }
    const componentEdges = graphEdges.filter(edge => component.includes(edge.source) && component.includes(edge.target));
    const cycleExceptionEdgesAllowed = componentEdges.length > 0
      && componentEdges.every(edge => rules.exceptions.some((exception, index) => {
        if (!exception.allowCycle || !exceptionMatches(exception, edge.source, edge.target)) return false;
        matchedExceptions.add(index);
        return true;
      }));
    if (cycleExceptionEdgesAllowed) continue;
    const firstNode = component[0];
    cycleDiagnostics.push(makeDiagnostic(
      ARCHITECTURE_CODES.dependencyCycle,
      `${firstNode} participates in an unapproved dependency cycle (${component.length} nodes, ${componentEdges.length} edges, fingerprint ${cycleFingerprint(component, graphEdges)}).`,
      {
        source: firstNode,
        nodes: component,
        edgeCount: componentEdges.length,
        edgeFingerprint: cycleFingerprint(component, graphEdges),
      },
    ));
  }

  for (const [index] of rules.exceptions.entries()) {
    if (!matchedExceptions.has(index)) {
      diagnostics.push(makeDiagnostic(
        ARCHITECTURE_CODES.invalidConfiguration,
        `exceptions[${index}] does not match any resolved production edge.`,
      ));
    }
  }
  for (const [index] of rules.cycleExceptions.entries()) {
    if (!matchedCycleExceptions.has(index)) {
      diagnostics.push(makeDiagnostic(
        ARCHITECTURE_CODES.invalidConfiguration,
        `cycleExceptions[${index}] does not match the current graph exactly.`,
      ));
    }
  }
  for (const [index] of rules.pureExternalExceptions.entries()) {
    if (!matchedPureExternalExceptions.has(index)) diagnostics.push(configError(`pureExternalExceptions[${index}] does not match a pure production import.`));
  }

  return {
    rules,
    diagnostics: [...diagnostics, ...cycleDiagnostics].sort((left, right) => {
      const leftKey = `${left.code}:${left.source ?? ''}:${left.line ?? 0}:${left.message}`;
      const rightKey = `${right.code}:${right.source ?? ''}:${right.line ?? 0}:${right.message}`;
      return leftKey.localeCompare(rightKey);
    }),
    files: graphNodes,
    edges: graphEdges,
    cycles: components.map(component => ({
      nodes: component,
      edgeCount: graphEdges.filter(edge => component.includes(edge.source) && component.includes(edge.target)).length,
      edgeFingerprint: cycleFingerprint(component, graphEdges),
    })),
  };
}

export function findArchitectureDiagnostics(root = process.cwd(), suppliedRules) {
  return analyzeArchitecture(root, suppliedRules).diagnostics;
}

export function findArchitectureViolations(root = process.cwd(), boundariesOrRules) {
  if (boundariesOrRules && !Array.isArray(boundariesOrRules)) {
    return findArchitectureDiagnostics(root, boundariesOrRules).map(diagnostic => `${diagnostic.code} ${diagnostic.message}`);
  }
  if (Array.isArray(boundariesOrRules)) return legacyFindArchitectureViolations(path.resolve(root), boundariesOrRules);
  return findArchitectureDiagnostics(root).map(diagnostic => `${diagnostic.code} ${diagnostic.message}`);
}

export function runArchitectureCheck(root = process.cwd(), suppliedRules) {
  const result = analyzeArchitecture(root, suppliedRules);
  if (result.diagnostics.length > 0) {
    console.error('Architecture dependency graph violations:');
    for (const diagnostic of result.diagnostics) console.error(`- ${diagnostic.code}: ${diagnostic.message}`);
    return false;
  }
  console.log(`Architecture dependency graph passed (${result.files.length} production files, ${result.edges.length} resolved internal edges, ${result.cycles.length} explicitly described cycles).`);
  return true;
}

/** Read-only inventory: exact debt and graph plus counts for each import direction. */
export function createArchitectureReport(result) {
  const layerEdges = {};
  for (const edge of result.edges) {
    const key = `${edge.sourceLayer} -> ${edge.targetLayer}`;
    layerEdges[key] = (layerEdges[key] ?? 0) + 1;
  }
  return { reportVersion: 1, ...result, layerEdges };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--report')) {
    const result = analyzeArchitecture();
    console.log(JSON.stringify(createArchitectureReport(result), null, 2));
    if (result.diagnostics.length > 0) process.exitCode = 1;
  } else if (!runArchitectureCheck()) process.exitCode = 1;
}
