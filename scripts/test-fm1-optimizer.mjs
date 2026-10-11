// Offline native firmware tests. Does not launch the editor or access a device.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const root = resolve(import.meta.dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'teia-fm1-optimizer-'));
for (const mode of ['before', 'after']) {
  await build({ stdin: { contents: 'export {compileFm1Patch} from "./editor/src/audio/fm1Package"; export {optimizeFm1Ops} from "./editor/src/audio/fm1Optimizer";', resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: join(work, mode+'.mjs'),
    plugins: mode === 'before' ? [{ name: 'disable-optimization', setup(b) { b.onLoad({ filter: /fm1Optimizer\.ts$/ }, () => ({ contents: 'export const optimizeFm1Ops = ops => ops;', loader: 'ts' })); } }] : [] });
}
const { compileFm1Patch: before } = await import(pathToFileURL(join(work, 'before.mjs')));
const { compileFm1Patch: after, optimizeFm1Ops: optimize } = await import(pathToFileURL(join(work, 'after.mjs')));
const Q = 65536;
const output = r => [5, 0, r, 0, 0, 0];
// Negative multiplication rounds down, division truncates toward zero.
for (const [code, expected] of [[2, -1], [23, -32768]]) {
  const values = [-1, 2];
  const ops = optimize([[0,0,0,0,0,0],[0,1,1,0,0,0],[code,2,0,1,0,0],output(2)],values,new Set(),128);
  assert.equal(values[ops[0][2]],expected);
}
// Equal defaults do not make independent knobs interchangeable or immutable.
const knobs = optimize([[0,0,0,0,0,0],[0,1,1,0,0,0],[21,2,0,1,0,0],output(2)],[Q,Q],new Set([0,1]),128);
assert.equal(knobs.length,4);
// Raw Pow may exceed the graph limit: its following divide-by-one must still clip.
const clipped = optimize([[0,0,0,0,0,0],[0,1,1,0,0,0],[47,2,0,1,0,0],[1,3,2,0,0,0],output(3)],[200*Q,2*Q],new Set(),128);
assert(clipped.some(op=>op[0]===1));
// Saturation must happen before subtraction; do not reassociate.
const values = [10000*Q];
const saturated = optimize([[0,0,0,0,0,0],[21,1,0,0,0,0],[22,2,1,0,0,0],output(2)],values,new Set(),128);
assert.equal(values[saturated[0][2]],2000*Q);
// Keep dead stateful work and all feedback boundaries in their original order.
const states = [[42,0,0,0,0,0],[37,1,0,0,0,1],[43,0,0,0,0,0],output(0)];
assert.deepEqual(optimize(states,[],new Set(),128),states);
// A full value pool must leave an unmaterializable constant calculation intact.
const full = optimize([[0,0,0,0,0,0],[21,1,0,0,0,0],output(1)],[Q],new Set(),1);
assert(full.some(op=>op[0]===21));

execFileSync(process.execPath, ['firmware/fm1/export-patch.mjs', work], { cwd: root });
execFileSync('cc',['-std=c11','-O2','-Wall','-Wextra','-Werror','-Wno-unused-function','-fsanitize=address,undefined','-fno-sanitize-recover=all','-I',join(root,'firmware/fm1'),'-I',work,join(root,'firmware/fm1/test-optimizer-render.c'),'-o',join(work,'render')]);
const fixtures = ['abs','accumulator','allpass','arithmetic','bandpass','bend','clamp','crossover','expression-functions','feedback-bend','fold','hardclip','highpass','noise','octave','phase-fm','random','remove-dc','saturate','sine','subtractive','tremolo','wavefold'];
for (const name of fixtures) {
  const patch = JSON.parse(readFileSync(join(root, 'firmware/fm1/patches',name+'.json'),'utf8'));
  const a = before(patch), b = after(patch);
  const render = (p, name) => {
    const file = join(work,name+'.tgp'); writeFileSync(file,p.bytes);
    return execFileSync(join(work,'render'),[file],{maxBuffer:32*1024*1024});
  };
  assert.deepEqual(render(a,'a'),render(b,'b'),name+' PCM/state mismatch');
  console.log(`${name}: ${a.ops.length} -> ${b.ops.length} instructions; identical PCM, DSP state, feedback and delay`);
}
console.log(`Passed arithmetic guards and ${fixtures.length} native differential fixtures. Artifacts: ${work}`);
