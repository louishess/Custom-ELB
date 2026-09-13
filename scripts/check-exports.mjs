import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { fixture } = require('../tests/helpers/export-fixture.cjs');
const { createExportService } = require('../electron/backend/exports.cjs');
const output = path.resolve(process.argv[2] || 'artifacts/exports');
await fs.mkdir(output, { recursive: true });
const { snapshot, previews } = fixture();
const service = createExportService({snapshot:()=>snapshot}, {preview:async ({id})=>previews[id]});
const checks = [];
for (const scope of ['entry','notebook']) {
  for (const format of ['html','docx','rtf','md','txt']) {
    const destination = path.join(output, `${scope}.${format}`);
    const result = await service.write({scope,notebookId:'notebook',runIds:scope === 'entry' ? ['run-1'] : [],format,order:'scheme',schemeId:'scheme',sections:['information','method','notes','data'],data:'previews',jobId:`specimen-${scope}-${format}`,destination});
    assert.equal(result.cancelled,false);
    assert.ok((await fs.stat(destination)).size > 100);
    checks.push({scope,format,warnings:result.warnings});
  }
}
await fs.writeFile(path.join(output,'checks.json'),JSON.stringify(checks,null,2)+'\n');
console.log(`Generated and checked ${checks.length} exports in ${output}`);
