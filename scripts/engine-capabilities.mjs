// Rust ships this exact contract; the frontend copy is generated, not editable.
import { readFile, writeFile } from 'node:fs/promises';
const source='rust/teia-kernel/src/runtime-capabilities.json';
const target='editor/src/hosted/engineCapabilities.json';
const canonical=await readFile(source,'utf8');JSON.parse(canonical);
if(process.argv[2]==='--write')await writeFile(target,canonical);
else if(await readFile(target,'utf8').catch(()=>null)!==canonical)throw new Error('Engine capability copy is stale; run npm run engine:capabilities:write.');
