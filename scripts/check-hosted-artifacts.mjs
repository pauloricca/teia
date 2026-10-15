// Read-only artifact/source integrity audit. Does not launch or execute Teia.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, relative, isAbsolute } from 'node:path';
import assert from 'node:assert/strict';
import { runtimeFingerprint } from './runtime-fingerprint.mjs';
const root = resolve('hosted/dist');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const manifest = JSON.parse(await readFile(`${root}/compatibility.json`, 'utf8'));
const expected = new Set(['compatibility.json']);
for (const file of manifest.artifacts) {
  const path = resolve(root, file.path);
  assert.ok(!isAbsolute(file.path) && !relative(root, path).startsWith('..'), 'Invalid artifact path');
  const bytes = await readFile(path);
  assert.equal(bytes.length, file.bytes, `${file.path} byte length`);
  assert.equal(await hash(path), file.sha256, `${file.path} hash`);
  expected.add(file.path);
}
for (const file of manifest.sourceChecksums) assert.equal(await hash(file.path), file.sha256, `${file.path} source hash`);
async function visit(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory()) await visit(path);
    else assert.ok(expected.has(relative(root, path)), `Unmanifested artifact ${relative(root, path)}`);
  }
}
await visit(root);
const evidence = JSON.parse(await readFile(`${root}/verification.json`, 'utf8'));
assert.equal(evidence.rustSourceSha256, await runtimeFingerprint());
assert.equal(evidence.wasmSha256, await hash('editor/public/audio/teia-kernel.wasm'));
assert.equal(evidence.fixtureRustSha256, await hash(`${root}/native/teia-kernel/tests/fixtures/shared.rs`));
assert.equal(evidence.fixtureSha256, await hash(`${root}/native/teia-kernel/tests/fixtures/shared.json`));
const fixtures = JSON.parse(await readFile(`${root}/native/teia-kernel/tests/fixtures/shared.json`, 'utf8'));
assert.equal(fixtures.length, evidence.corpusFixtures);
assert.equal(evidence.fixtures, evidence.fixtureNames.length);
assert.deepEqual(new Set([...evidence.fixtureNames,...evidence.excludedFixtures]), new Set(fixtures.map(p=>p.name)));
console.log(`Artifact integrity passed: ${manifest.artifacts.length} files; source-matched ${evidence.fixtures}/${fixtures.length} Node-WASM/native fixtures; excluded fixtures explicitly named.`);
