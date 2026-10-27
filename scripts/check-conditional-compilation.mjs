// Static patch compilation only. Never creates an audio context or runs DSP.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const directory = await mkdtemp(join(tmpdir(), 'teia-conditional-compile-'));
try {
  const result = await build({
    stdin: { contents: `export { compilePatchToDspProgram, DSP_OP } from './editor/src/audio/dspProgram';
      export { parsePatchJson } from './editor/src/graph/parse';
      export { patchToJson } from './editor/src/graph/serialize';
      export { analyzeFm1Patch } from './editor/src/audio/fm1Package';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm',
  });
  const modulePath = join(directory, 'compiler.mjs');
  await writeFile(modulePath, result.outputFiles[0].text);
  const { compilePatchToDspProgram: compile, DSP_OP: op, parsePatchJson, patchToJson, analyzeFm1Patch } = await import(pathToFileURL(modulePath));
  const node = (id, type, params = {}, extra = {}) => ({ id, type, params, ...extra });
  const link = (from, to, input = 'signal', output = 'signal', mode = 'set') => ({ from: { node: from, port: output }, to: { node: to, port: input }, mode });
  const conditional = (id, members, extra = {}) => node(id, 'ConditionalExecution', { gate: 1 }, { spreadNodeIds: members, ...extra });
  const patch = {
    nodes: [conditional('condition', ['osc', 'send']), node('osc', 'SineOsc'), node('gate', 'SineOsc'),
      node('send', 'Send', { number: 1 }), node('receive', 'Receive', { number: 1 }), node('output', 'AudioOut')],
    links: [link('gate', 'condition', 'gate'), link('osc', 'send'), link('receive', 'output', 'left'),
      link('osc', 'output', 'right', 'signal', 'multiply')],
  };
  function checked(source) {
    const program = compile(source);
    assert.deepEqual(program.errors, []);
    for (const [index, instruction] of program.ops.entries()) {
      if (![op.SpreadBegin, op.SpawnBegin].includes(instruction.opcode)) continue;
      assert(instruction.b > index);
      assert.equal(program.ops[instruction.b].opcode, instruction.opcode === op.SpawnBegin ? op.SpawnEnd : op.SpreadEnd);
    }
    return program;
  }
  const program = checked(patch);
  assert.equal(program.engineApiVersion, 3);
  const beginIndex = program.ops.findIndex(instruction => instruction.opcode === op.SpreadBegin);
  const begin = program.ops[beginIndex];
  assert.equal(begin.value3, 1);
  assert(program.ops.slice(0, beginIndex).some(instruction => instruction.out === begin.a), 'Gate must execute before the boundary.');
  assert.equal(program.ops.filter(instruction => instruction.opcode === op.Osc).length, 2);
  assert.equal(program.ops.slice(beginIndex + 1, begin.b).filter(instruction => instruction.opcode === op.Osc).length, 1);
  assert(program.ops.slice(beginIndex + 1, begin.b).some(instruction => instruction.opcode === op.SpreadCollect && instruction.b === 1));
  assert.equal(program.repeatBindings[0].type, 'ConditionalExecution');
  assert(analyzeFm1Patch(patch).errors.some(error => error.includes('not supported on FM-1')));

  // Saved order must not cause a downstream area to pull an upstream node out
  // of its gated execution bracket.
  const ordered = checked({ nodes: [conditional('downstream', ['second']), conditional('upstream', ['first']),
    node('first', 'SineOsc'), node('second', 'LowpassFilter'), node('output', 'AudioOut')],
    links: [link('first', 'second'), link('second', 'output', 'both')] });
  assert.deepEqual(ordered.repeatBindings.map(binding => binding.nodeId), ['upstream', 'downstream']);
  assert.equal(ordered.ops.filter(instruction => instruction.opcode === op.Osc).length, 1);

  const group = { nodes: [conditional('condition', ['osc']), node('osc', 'SineOsc'),
    node('outs', 'Outs', {}, { inputs: [{ name: 'signal' }] })], links: [link('osc', 'outs')] };
  const grouped = checked({ nodes: [node('group', 'Group', {}, { subpatch: group, inputs: [], outputs: [{ name: 'signal' }] }),
    node('output', 'AudioOut')], links: [link('group', 'output', 'both')] });
  assert.equal(grouped.repeatBindings[0].nodeId, 'group__condition');
  const groupedBegin = grouped.ops.findIndex(instruction => instruction.opcode === op.SpreadBegin);
  assert(grouped.ops.slice(groupedBegin + 1, grouped.ops[groupedBegin].b).some(instruction => instruction.opcode === op.Osc));

  const analysed = checked({ nodes: [conditional('condition', ['fft']), node('fft', 'FFT'), node('input', 'SineOsc'), node('output', 'AudioOut')],
    links: [link('input', 'fft'), link('fft', 'output', 'both', 'amplitude')] });
  const analysedBegin = analysed.ops.find(instruction => instruction.opcode === op.SpreadBegin);
  assert.equal(analysed.fftBindings[0].gateRegister, analysedBegin.a);
  const sideEffects = checked({ nodes: [conditional('condition', ['osc', 'inside output', 'midi', 'buffer']), node('osc', 'SineOsc'),
    node('inside output', 'AudioOut'), node('midi', 'MidiNoteOnSend'), node('buffer', 'Buffer')],
    links: [link('osc', 'inside output', 'both')] });
  const sideBegin = sideEffects.ops.findIndex(instruction => instruction.opcode === op.SpreadBegin);
  const sideBody = sideEffects.ops.slice(sideBegin + 1, sideEffects.ops[sideBegin].b);
  assert(sideBody.some(instruction => instruction.opcode === op.Output));
  assert(sideBody.some(instruction => instruction.opcode === op.MidiNoteSend));
  assert(sideBody.some(instruction => instruction.opcode === op.Buffer));
  assert(!sideEffects.ops.slice(sideEffects.ops[sideBegin].b + 1).some(instruction => [op.Output, op.MidiNoteSend, op.Buffer].includes(instruction.opcode)));

  const restored = parsePatchJson(patchToJson(patch));
  assert.deepEqual(restored.nodes.find(candidate => candidate.id === 'condition').spreadNodeIds, ['osc', 'send']);
  checked(restored);
  const disabled = checked({ ...patch, nodes: patch.nodes.map(candidate => candidate.id === 'condition' ? { ...candidate, enabled: false } : candidate) });
  assert(!disabled.ops.some(instruction => instruction.opcode === op.SpreadBegin && instruction.value3 === 1));
  const selfGate = compile({ ...patch, links: [...patch.links, link('osc', 'condition', 'gate')] });
  assert(selfGate.errors.some(error => error.includes('cannot be driven')));
  console.log('Conditional Execution static compilation checks passed (no audio rendered).');
} finally {
  await rm(directory, { recursive: true, force: true });
}
