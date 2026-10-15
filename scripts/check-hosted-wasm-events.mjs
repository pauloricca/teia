// Authorized headless functional harness. No GUI, devices, clock or server.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const fields = ['opcode','out','a','b','c','d','e','state','value','value2','value3','value4'];
const op = (opcode,out=-1,a=-1,b=-1) => ({opcode,out,a,b});
const ops = [op(0,0,0),op(0,1,1),op(27,2,5,0),op(2,3,2,1),op(27,4,8,0),op(2,5,4,1),op(5,-1,3,0),op(5,-1,5,1)];
for (const path of ['editor/public/audio/teia-kernel.wasm', 'editor/public/audio/teia-kernel-simd.wasm']) {
  const { instance: { exports: w } } = await WebAssembly.instantiate(readFileSync(path), {});
  w.clearDspProgram();w.setDspValueImmediate(0,0);w.setDspValueImmediate(1,0.001);
  for (const operation of ops) assert.ok(w.addDspOp(...fields.map((field,i)=>operation[field]??(i<8?-1:0)))>=0);
  assert.equal(w.prepareDspRealtime(8,64*1024*1024),1);
  for (const event of [[1,1,60,0.5],[1,2,64,1],[0,1,60,0],[1,2,64,0]]) w.queueDspMidiNoteEvent(...event);
  w.clear(8);w.beginDspRenderQuantum();w.renderDspProgram(8,48000);
  assert.deepEqual([...new Float32Array(w.memory.buffer,w.leftPtr(),8)], [...Float32Array.from([0.06,0,0.064,0,0,0,0,0])]);
  assert.deepEqual([...new Float32Array(w.memory.buffer,w.rightPtr(),8)], [...Float32Array.from([0,0,0,0,0.06,0,0.064,0])]);
  w.queueDspMidiNoteEvent(1,1,72,1);w.resetDspRuntimeState();w.clear(8);w.beginDspRenderQuantum();w.renderDspProgram(8,48000);
  assert.ok([...new Float32Array(w.memory.buffer,w.leftPtr(),8)].every(v=>v===0));
  const before=w.dspMidiInputOverflows();
  for(let i=0;i<4097;i++)w.queueDspMidiNoteEvent(1,1,60,1);
  assert.equal(w.dspMidiInputOverflows()-before,1);
  console.log(`${path}: ordered equal-offset note pulses, velocity-zero release, reset and overflow passed.`);
}
