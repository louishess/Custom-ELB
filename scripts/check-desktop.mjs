import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

let checked = 0;
async function visit(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await visit(filename);
    else if (entry.isFile() && filename.endsWith('.cjs')) {
      execFileSync(process.execPath, ['--check', filename], { stdio: 'inherit' });
      checked++;
    }
  }
}
await visit('electron');
await visit('shared');
console.log(`Validated ${checked} desktop JavaScript modules; preload and backend are packaged as explicit CommonJS sources.`);
