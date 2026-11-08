// Pure document/model check. Does not launch Teia or acquire runtime devices.
import { buildSync } from 'esbuild';
import { mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root = process.cwd();
const temp = resolve(root, 'node_modules/.cache/teia-spagbol-codec-check.mjs');
await mkdir(resolve(root, 'node_modules/.cache'), { recursive: true });
const bundle = buildSync({ stdin: { contents: `export * from './editor/src/spagbol/patchCodec.ts'; export {normalizeTeiaDocument} from './editor/src/spagbol/normalizeDocument.ts'; export {teiaCatalogue} from './editor/src/spagbol/catalogue.ts'; export {compilePatchToDspProgram} from './editor/src/audio/dspProgram.ts'; export {GraphEditor, assertDocument, spagbolNewPortId, portsFor} from '@pauloricca/spagbol'; export {parsePatchJson} from './editor/src/graph/parse.ts';`, resolveDir: root }, bundle: true, platform: 'node', format: 'esm', packages: 'external', write: false });
await writeFile(temp, bundle.outputFiles[0].text);
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? files(resolve(dir, entry.name)) : entry.name.endsWith('.json') ? [resolve(dir, entry.name)] : []))).flat();
}
function difference(a, b, path = '$') {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return path;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) { const result = difference(a[key], b[key], `${path}.${key}`); if (result) return result; }
  return null;
}
try {
  const { patchToGraph, graphToPatch, parsePatchJson, teiaCatalogue, normalizeTeiaDocument, GraphEditor, assertDocument, spagbolNewPortId, portsFor, compilePatchToDspProgram } = await import(pathToFileURL(temp));
  for (const definition of teiaCatalogue.list()) {
    const node = teiaCatalogue.create(definition.kind, { x: 0, y: 0 }, 'creation-check');
    const document = { format: 'spagbol', version: 1, nodes: [node], links: [], areas: [] };
    assertDocument(document);
    parsePatchJson(JSON.stringify(graphToPatch(document)));
  }
  const example = new GraphEditor({ nodes: teiaCatalogue });
  const params = example.addNode('Params', { x: 0, y: 0 });
  const expression = example.addNode('Expression', { x: 300, y: 0 });
  const input = portsFor(example.graph.nodes.find(node => node.id === expression), teiaCatalogue).find(port => port.direction === 'input');
  example.connect({ nodeId: params, portId: spagbolNewPortId }, { type: 'port', nodeId: expression, portId: input.id });
  const exposed = graphToPatch(example.graph).nodes.find(node => node.id === params);
  assert.equal(exposed.outputs.length, 1);
  assert.equal(exposed.params[exposed.outputs[0].name], 0);
  example.select({ nodeIds: [params] }); example.duplicate();
  const cloned = graphToPatch(example.graph).nodes.find(node => node.id === example.getSnapshot().selection.nodeIds[0]);
  assert.notEqual(cloned.outputs[0].parameterId, exposed.outputs[0].parameterId);
  const cached = graphToPatch(example.graph);
  assert.equal(graphToPatch(example.graph), cached, 'immutable document conversions must be reused');
  const unchanged = cached.nodes.find(node => node.id === params);
  example.setValue(expression, input.id, 0.25);
  assert.equal(graphToPatch(example.graph).nodes.find(node => node.id === params), unchanged, 'editing another control must retain the Params presentation');
  const dynamic = new GraphEditor({ nodes: teiaCatalogue, normalizeDocument: normalizeTeiaDocument });
  const crossover = dynamic.addNode('Crossover', { x: 0, y: 0 });
  const sink = dynamic.addNode('Expression', { x: 300, y: 0 });
  dynamic.setValue(crossover, 'points', 2);
  const third = portsFor(dynamic.graph.nodes.find(node => node.id === crossover), teiaCatalogue).find(port => port.label === 'band 3');
  assert(third, 'direct numeric changes must refresh domain-derived ports');
  dynamic.connect({ nodeId: crossover, portId: third.id }, { type: 'port', nodeId: sink, portId: 'a' });
  assert.equal(dynamic.graph.links.length, 1);
  dynamic.setValue(crossover, 'points', 1);
  assert.equal(dynamic.graph.links.length, 0, 'removed dynamic ports prune cables atomically');
  dynamic.undo(); assert.equal(dynamic.graph.links.length, 1);
  let checked = 0, skipped = 0;
  const failures = [];
  for (const file of await files(resolve(root, 'patches'))) {
    let patch;
    try { patch = parsePatchJson(await readFile(file, 'utf8')); } catch { skipped++; continue; }
    const result = graphToPatch(patchToGraph(patch));
    try {
      assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), JSON.parse(JSON.stringify(patch)));
      const editor = new GraphEditor({ nodes: teiaCatalogue, document: patchToGraph(patch), normalizeDocument: normalizeTeiaDocument });
      editor.edit('Migration validation', 'metadata', graph => { graph.data = { ...graph.data, migrationCheck: true }; });
      assertDocument(editor.getSnapshot().document);
      const after = graphToPatch(editor.getSnapshot().document);
      assert.deepStrictEqual(compilePatchToDspProgram(after), compilePatchToDspProgram(patch));
      checked++;
    }
    catch { if (failures.length < 8) failures.push({ file: file.slice(root.length + 1), field: difference(patch, result) ?? 'canonical edit/compiler equivalence' }); }
  }
  if (failures.length) { console.error(JSON.stringify(failures, null, 2)); throw new Error('Teia/Spagbol document round-trip mismatch.'); }
  console.log(`Teia ↔ Spagbol document round-trips and static compiler equivalence passed: ${checked} patch fixtures; ${skipped} non-loadable legacy fixtures skipped.`);
} finally { await rm(temp, { force: true }); }
