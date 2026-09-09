import fs from 'node:fs/promises';
import path from 'node:path';

const manifest = JSON.parse(await fs.readFile('package.json', 'utf8'));
const lock = JSON.parse(await fs.readFile('package-lock.json', 'utf8'));
const rows = [];
for (const [location, entry] of Object.entries(lock.packages)) {
  if (!location || !location.includes('node_modules/')) continue;
  let installed = {};
  try { installed = JSON.parse(await fs.readFile(path.join(location, 'package.json'), 'utf8')); } catch { /* Optional platform package may not be installed. */ }
  const name = installed.name || location.slice(location.lastIndexOf('node_modules/') + 13);
  const license = installed.license || entry.license || 'See package LICENSE';
  rows.push({ name, version: entry.version, license: typeof license === 'string' ? license : JSON.stringify(license), kind: entry.dev ? 'development' : 'production', optional: Boolean(entry.optional), location });
}
rows.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const escape = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const direct = rows.filter(row => Object.hasOwn(manifest.dependencies || {}, row.name) || Object.hasOwn(manifest.devDependencies || {}, row.name));
const table = values => '| Package | Resolved version | License | Use |\n| --- | --- | --- | --- |\n' + values.map(row => `| ${escape(row.name)} | ${row.version} | ${escape(row.license)} | ${row.kind} |`).join('\n');
await fs.mkdir('docs', { recursive: true });
await fs.mkdir('artifacts', { recursive: true });
await fs.writeFile('docs/DEPENDENCIES.md', `# LabMate dependency inventory\n\nGenerated from package-lock.json by npm run check:dependencies. Optional platform packages are included even when not installed on this Mac. Package LICENSE files remain with distributed dependencies; this inventory does not replace their terms.\n\n## Direct dependencies\n\n${table(direct)}\n\n## Complete resolved inventory\n\n${table(rows)}\n\n## Reviewed override\n\nExcelJS uses the UUID v4 function. Its UUID dependency is pinned to 11.1.1 to address GHSA-w5hq-g745-h8pq while retaining CommonJS support. XLSX read/write and conditional-formatting round trips verify the override.\n`);
await fs.writeFile('artifacts/dependencies.json', JSON.stringify({ generatedAt: new Date().toISOString(), packages: rows }, null, 2));
console.log(`Inventoried ${rows.length} resolved packages (${direct.length} direct) in docs/DEPENDENCIES.md.`);
