import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = [];
async function collect(directory) {
  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(relative);
    else if (entry.isFile() && /\.(?:mjs|cjs|js)$/u.test(entry.name)) files.push(relative);
  }
}
for (const directory of ['src', 'public', 'desktop', 'scripts', 'examples', 'test']) await collect(directory);
files.sort();
let next = 0, failed = false;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const code = await new Promise(resolve => {
      const child = spawn(process.execPath, ['--check', file], { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true, shell: false });
      child.once('error', error => { console.error(`Syntax check could not start for ${file}: ${error.message}`); resolve(1); });
      child.once('exit', code => resolve(code ?? 1));
    });
    if (code !== 0) failed = true;
  }
}
await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
if (failed) process.exitCode = 1;
else console.log(`Syntax checked ${files.length} JavaScript files, including backend, desktop, UI, examples, tests and QA scripts.`);
