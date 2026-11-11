import { cp, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

function packageName(packagePath) {
  if (typeof packagePath !== 'string' || packagePath.includes('\\') || packagePath.includes('\0')) throw new Error('Invalid production package path.');
  const parts = packagePath.split('/');
  let name;
  for (let index = 0; index < parts.length;) {
    if (parts[index++] !== 'node_modules') throw new Error(`Invalid production package path: ${packagePath}`);
    const head = parts[index++];
    if (!head || head === '.' || head === '..' || !/^@?[A-Za-z0-9_.-]+$/.test(head)) throw new Error(`Invalid production package path: ${packagePath}`);
    name = head;
    if (head.startsWith('@')) {
      const tail = parts[index++];
      if (!tail || tail === '.' || tail === '..' || !/^[A-Za-z0-9_.-]+$/.test(tail)) throw new Error(`Invalid production package path: ${packagePath}`);
      name += `/${tail}`;
    }
  }
  return name;
}

const sortedEntries = value => Object.entries(value || {}).sort(([a], [b]) => a.localeCompare(b));

/** Windows canonical paths may differ only in case or the extended-path
 * prefix. Root realpath resolution below also expands checkout 8.3 aliases. */
export function sameProductionPath(expected, actual, platform = process.platform) {
  if (platform !== 'win32') return path.normalize(expected) === path.normalize(actual);
  const normalize = value => {
    let normalized = path.win32.normalize(value);
    if (normalized.slice(0, 8).toLowerCase() === '\\\\?\\unc\\') normalized = '\\\\' + normalized.slice(8);
    else if (normalized.startsWith('\\\\?\\')) normalized = normalized.slice(4);
    return normalized.toLowerCase();
  };
  return normalize(expected) === normalize(actual);
}

/** Resolve the installed production closure from npm's committed v3 lockfile.
 * Do not run dependency installation or lifecycle scripts during packaging.
 */
export async function productionPackages(projectRoot) {
  const root = await realpath(path.resolve(projectRoot));
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages?.['']) throw new Error('Windows staging requires the committed npm v3 package lock. Run npm ci first.');
  if (JSON.stringify(sortedEntries(lock.packages[''].dependencies)) !== JSON.stringify(sortedEntries(metadata.dependencies))) {
    throw new Error('Production dependencies differ from package-lock.json. Update the lock and run npm ci.');
  }
  const packages = [];
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative || entry.dev === true) continue;
    const name = packageName(relative);
    if (entry.link || !entry.version) throw new Error(`Production package ${relative} is not a locked registry package.`);
    const source = path.join(root, ...relative.split('/'));
    let information;
    try { information = await lstat(source); }
    catch (error) {
      if (error.code === 'ENOENT' && entry.optional === true) continue;
      throw new Error(`Required production package ${relative}@${entry.version} is missing. Run npm ci.`, { cause: error });
    }
    if (!information.isDirectory() || information.isSymbolicLink() || !sameProductionPath(source, await realpath(source))) {
      throw new Error(`Production package ${relative} must be a real installed directory, not a link.`);
    }
    const installed = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    if (installed.version !== entry.version) throw new Error(`Expected ${relative}@${entry.version}, found ${installed.version}. Run npm ci.`);
    packages.push({ path: relative, name: installed.name || name, version: entry.version, ...(entry.integrity ? { integrity: entry.integrity } : {}) });
  }
  for (const [name, version] of Object.entries(metadata.dependencies || {})) {
    const entry = packages.find(item => item.path === `node_modules/${name}`);
    if (!entry || version !== entry.version) throw new Error(`Top-level production dependency ${name} must be installed at its exact pinned version ${version}.`);
  }
  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

export async function copyProductionPackages({ projectRoot, destination }) {
  const root = await realpath(path.resolve(projectRoot));
  const packages = await productionPackages(root);
  for (const entry of packages) {
    const source = path.join(root, ...entry.path.split('/'));
    const target = path.join(destination, ...entry.path.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target, {
      recursive: true,
      filter: async file => {
        // Nested packages are copied from their own lockfile entries below.
        // This also excludes unrelated developer dependencies and .bin links.
        const relative = path.relative(source, file);
        if (relative.split(path.sep).includes('node_modules')) return false;
        if ((await lstat(file)).isSymbolicLink()) throw new Error(`Production package contains an unsupported symbolic link: ${file}`);
        return true;
      },
    });
  }
  return packages;
}
