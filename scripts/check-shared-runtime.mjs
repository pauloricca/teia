// Functional equivalence: actual standalone WASM versus owned native Rust.
// Requires explicit functional-test authorization and the existing Rust image.
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runtimeFingerprint, runtimeFingerprint64 } from './runtime-fingerprint.mjs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const corpus=JSON.parse(readFileSync('rust/teia-kernel/tests/fixtures/shared.json'));
const fixtures=corpus.filter(p=>!p.sampleBindings.length&&!p.imageBindings.length&&!p.customWaveBindings.length&&!p.sequencerBindings.length&&!p.fftBindings.length);
const input=Float32Array.from({length:128},(_,i)=>Math.sin(i*0.13)*0.25);
const fields=['opcode','out','a','b','c','d','e','state','value','value2','value3','value4'];
const wire=[fixtures.length,...input];
for(const p of fixtures){wire.push(p.values.length,p.ops.length,...p.values);for(const op of p.ops)wire.push(...fields.map((k,i)=>op[k]??(i<8?-1:0)));}
if (process.argv.includes('--wire-only')) { process.stdout.write(wire.join(' ')); process.exit(0); }
const rawNative=process.env.TEIA_NATIVE_FIXTURE_FILE ? readFileSync(process.env.TEIA_NATIVE_FIXTURE_FILE) : execFileSync('docker',['run','--rm','-i','-v',`${process.cwd()}:/work`,'-w','/work/rust/teia-kernel','teia-rust-wasm:1.87','target/debug/examples/shared_fixture'],{input:wire.join(' '),maxBuffer:16*1024*1024});
assert.equal(rawNative.readBigUInt64LE(0),await runtimeFingerprint64(),'Native fixture runner is stale; rebuild the example.');
const native=rawNative.subarray(8);
const {instance}=await WebAssembly.instantiate(readFileSync('editor/public/audio/teia-kernel.wasm'),{});const w=instance.exports;
let offset=0;let maxError=0;
for(const p of fixtures){
  w.clearDspProgram();w.clearGraph();w.setDspStereoInputEnabled(1);
  p.values.forEach((v,i)=>w.setDspValue(i,v));
  for(const op of p.ops)assert.ok(w.addDspOp(...fields.map((k,i)=>op[k]??(i<8?-1:0)))>=0,p.name);
  if(p.repeatBindings.length)assert.equal(w.prepareDspRealtime(8,64*1024*1024),1,p.name);
  if(process.argv.includes('--block-plan'))w.compileDspBlockPlan();
  for(let block=0;block<6;block++){
    if(block===2&&p.values.length)w.setDspValue(0,p.values[0]*0.5+0.1);
    w.clear(128);w.beginDspRenderQuantum();
    for(const fn of ['inputPtr','inputLeftPtr','inputRightPtr'])new Float32Array(w.memory.buffer,w[fn](),128).set(input);
    w.renderDspProgram(128,48000);
    for(const fn of ['leftPtr','rightPtr'])for(const sample of new Float32Array(w.memory.buffer,w[fn](),128)){
      const expected=native.readFloatLE(offset);offset+=4;const error=Math.abs(sample-expected);maxError=Math.max(maxError,error);
      assert.ok(Number.isFinite(error)&&error<2e-5,`${p.name}, block ${block}: ${sample} vs ${expected}`);
    }
    if(block===3)w.resetDspRuntimeState();
  }
}
assert.equal(offset,native.byteLength);
console.log(`WASM/native equivalence passed: ${fixtures.length} fixtures, six blocks each, smoothing and reset; maximum absolute sample error ${maxError}.`);

await mkdir('hosted/verification',{recursive:true});
await writeFile('hosted/verification/shared-runtime.json',JSON.stringify({
  format:'teia-shared-runtime-evidence',version:1,rustSourceSha256:await runtimeFingerprint(),
  wasmSha256:createHash('sha256').update(readFileSync('editor/public/audio/teia-kernel.wasm')).digest('hex'),
  fixtureRustSha256:createHash('sha256').update(readFileSync('rust/teia-kernel/tests/fixtures/shared.rs')).digest('hex'),
  corpusFixtures:corpus.length, fixtureNames:fixtures.map(p=>p.name), excludedFixtures:corpus.filter(p=>!fixtures.includes(p)).map(p=>p.name),
  fixtureSha256:createHash('sha256').update(readFileSync('rust/teia-kernel/tests/fixtures/shared.json')).digest('hex'),
  platform:'Linux ARM64 native container versus Node WASM',fixtures:fixtures.length,blocksPerFixture:6,
  repeatPolicy:'both adapters explicitly prepared with capacity 8 / 64 MiB; legacy dynamic policy is not this equivalence claim',
  controls:'standalone smoothing, change at block 2, reset after block 3',
  blockPlan:process.argv.includes('--block-plan'),maxAbsoluteSampleError:maxError,
  limitations:['No macOS-native or audio-deadline measurements','No browser isolation or Vira integration claim']
},null,2)+'\n');
