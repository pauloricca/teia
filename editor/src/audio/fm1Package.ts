import { compilePatchToDspProgram, type DspProgram, type DspOp } from './dspProgram';
import { optimizeFm1Ops } from './fm1Optimizer';
import type { Patch } from '../graph/types';
import { fm1Capabilities, fm1Limits as limits, fm1FilterModes, fm1DistortionModes, fm1FunctionArity, inspectFm1Package } from './fm1Capabilities';
import { getFm1SupportErrors } from './fm1Support';
export { limits as fm1Limits };
export type Fm1Patch = Patch;
export interface Fm1Usage { operations: number; registers: number; values: number; states: number; bytes: number }
export interface Fm1Compiled { program: DspProgram; ops: number[][]; parameters: Record<string, number>; bytes: Uint8Array }
export interface Fm1Analysis { usage: Fm1Usage | null; errors: string[]; compiled: Fm1Compiled | null }
export const fm1MaximumBytes = 187 + limits.operations * limits.operationBytes + limits.values * 4;
export function q16(n: number): number {
  const value = Math.round(n * 65536);
  if (!Number.isFinite(n) || n < -32768 || value < -2147483648 || value > 2147483647) throw new Error('Value outside Q16.16 range');
  return value;
}
function writeOperand(view: DataView, at: number, value: number) {
  if (!Number.isInteger(value) || value < -32768 || value > 32767) throw new Error('Invalid compiled operand');
  view.setInt16(at, value, true);
}
export function analyzeFm1Patch(patch: Fm1Patch): Fm1Analysis {
  let usage: Fm1Usage | null = null;
  try {
    const fm1Patch = migrateLegacyKeyboardControls(patch);
    const eligibilityErrors = getFm1SupportErrors(fm1Patch);
    if (eligibilityErrors.length) return { usage, errors: eligibilityErrors, compiled: null };
    const program = compilePatchToDspProgram(fm1Patch, { deduplicateLoads: false, foldConstants: false, eliminateDeadPureOps: false, analyzeSchedule: false });
    usage = { operations: program.ops.length, registers: program.registerCount, values: program.values.length, states: program.stateCount, bytes: 187 + program.ops.length * limits.operationBytes + program.values.length * 4 };
    if (program.errors.length) return { usage, errors: program.errors, compiled: null };
    const compiled = lowerFm1Patch(fm1Patch, program);
    usage = { operations: compiled.ops.length, registers: program.registerCount, values: program.values.length, states: program.stateCount, bytes: compiled.bytes.length };
    return { usage, errors: [], compiled };
  } catch (error) {
    return { usage, errors: [error instanceof Error ? error.message : String(error)], compiled: null };
  }
}
function migrateLegacyKeyboardControls(patch: Fm1Patch): Fm1Patch {
  if (patch.nodes.some(node => node.enabled !== false && node.type === 'MidiNote')) return patch;
  const roles = ['frequency', 'gate'];
  const candidates = patch.nodes.filter(node => node.type === 'Params' && node.enabled !== false
    && roles.every(name => node.outputs?.some(output => output.name === name)));
  if (candidates.length !== 1) return patch;
  const controls = candidates[0];
  const idBase = 'fm1-midi-note';
  let id = idBase, suffix = 2;
  const ids = new Set(patch.nodes.map(node => node.id));
  while (ids.has(id)) id = `${idBase}-${suffix++}`;
  return {
    ...patch,
    nodes: [...patch.nodes, { id, type: 'MidiNote', params: {} }],
    links: patch.links.map(link => link.from.node === controls.id && roles.includes(link.from.port)
      ? { ...link, from: { ...link.from, node: id } }
      : link),
  };
}
export function compileFm1Patch(patch: Fm1Patch): Fm1Compiled {
  const result = analyzeFm1Patch(patch);
  if (!result.compiled) throw new Error(result.errors.join('\n'));
  return result.compiled;
}
function lowerFm1Patch(patch: Fm1Patch, program: DspProgram): Fm1Compiled {
  const controls = patch.nodes.filter(node => node.type === 'Params' && node.enabled !== false);
  if (controls.length > 1) throw new Error('FM-1 patches can use one enabled Params node so its output order maps to the device controls.');
  const controlsNode = controls[0];
  const controlsId = controlsNode?.id;
  const controlOutputs = controlsNode?.outputs ?? [];
  if (controlOutputs.length > 6) throw new Error('FM-1 supports at most six Params outputs: Knob 1, Knob 2, Knob 3, Knob 4, Select, Algorithm.');
  for (const node of patch.nodes.filter(node => node.enabled !== false && node.type === 'MidiNote')) {
    if ((node.params.channel ?? 0) !== 0 && (node.params.channel ?? 0) !== 1) {
      throw new Error(`MIDI Note ${node.id}: FM-1 supports only channel 1 or all channels.`);
    }
  }
  if (controlsNode) for (const output of controlOutputs) {
    if (program.valueBindings.some(b => b.nodeId === controlsId && b.port === output.name)) continue;
    const valueIndex = program.values.length;
    program.values.push(controlsNode.params[output.name] ?? 0);
    program.valueBindings.push({ id: `${controlsId}.${output.name}`, kind: 'node-param', nodeId: controlsId, port: output.name, valueIndex });
  }
  const literalValues = new Set(program.valueBindings.filter(b => b.kind === 'constant').map(b => b.valueIndex));
  const literalRegisters = new Map<number, number>();
  let ops: number[][] = [];
  let fm1DelayCount = 0;
  // The browser's Tempo opcode has no state because its transport is global.
  // FM-1 patches are self-contained, so reserve one state entry per output.
  let fm1StateCount = program.stateCount;
  const appendCustomWaveAsset = (bindingIndex: number) => {
    const binding = program.customWaveBindings[bindingIndex];
    if (!binding) throw new Error(`${context}: missing Custom Wave data`);
    const mode = ['loop', 'ping-pong', 'once', 'sustain', 'sustain-loop', 'sustain-ping-pong'].indexOf(binding.customWave.mode);
    if (mode < 0 || binding.customWave.points.length < 2) throw new Error(`${context}: invalid Custom Wave data`);
    const first = program.values.length;
    // Assets are immutable trailing values, separate from editable parameter bindings.
    program.values.push(mode, binding.customWave.sustainStart, binding.customWave.sustainEnd);
    for (const point of binding.customWave.points) program.values.push(point.x, point.y);
    return { first, points: binding.customWave.points.length };
  };
  let context = '';
  for (const source of program.ops) {
    const o = source as Required<DspOp>;
    context = program.stateBindings.find(binding => binding.state === o.state)?.nodeId ?? `operation ${o.opcode}`;
    if (!fm1Capabilities.compiler.opcodes.includes(o.opcode)) {
      throw new Error(`Unsupported opcode ${o.opcode} (${context}) for ${fm1Capabilities.firmware}`);
    }
    switch (o.opcode) {
      case 0:
        ops.push([0, o.out, o.a, 0, 0, 0]);
        if (literalValues.has(o.a)) literalRegisters.set(o.out, program.values[o.a]);
        break;
      case 2:
        ops.push([2, o.out, o.a, o.b, 0, 0]);
        break;
      case 1: case 16: case 17: case 18: {
        // Link normalisation frequently divides by a literal one. Keep that a cheap copy.
        if (o.opcode === 17 && literalRegisters.get(o.b) === 1) {
          ops.push([1, o.out, o.a, 0, 0, 0]);
          break;
        }
        const code = {1: 21, 16: 22, 17: 23, 18: 24}[o.opcode]!;
        ops.push([code, o.out, o.a, o.opcode === 18 ? 0 : o.b, 0, 0]);
        break;
      }
      case 3:
        if ((o.value4 !== 1 && o.a !== 5) || !fm1Capabilities.compiler.oscillatorModes.includes(o.a)) throw new Error(`${context}: unsupported oscillator mode`);
        if (o.a === 6) ops.push([28, o.out, o.value2, o.value3, 0, o.state]);
        else if (o.a === 5) ops.push([50, o.out, o.c, o.d, 0, o.state]);
        else if (o.a === 9) {
          const asset = appendCustomWaveAsset(o.value);
          ops.push([51, o.out, o.b, o.d, o.e, o.state, o.c, o.value2, o.value3, asset.first, asset.points]);
        }
        else {
          if (o.c !== -1 && o.a !== 12) throw new Error(`${context}: oscillator signal input is not supported`);
          ops.push([25, o.out, o.b, o.value2, o.value3, o.state, o.d, o.e,
            o.a === 4 || o.a === 12 ? o.value : -1, o.a, o.a === 12 ? o.c : -1]);
        }
        break;
      case 19:
        ops.push([26, o.out, o.b, o.d, o.e, o.state, o.value % 4096, Math.floor(o.value / 4096), o.a, o.c, o.value2 - 1]);
        break;
      case 4: {
        const code = fm1FilterModes[o.a];
        if (code === undefined) throw new Error(`${context}: unsupported FM-1 filter mode ${o.a}`);
        ops.push([code, o.out, o.b, o.c, o.d, o.state]);
        break;
      }
      case 8:
        ops.push([42, o.out, 0, 0, 0, o.state]);
        break;
      case 9:
        ops.push([43, 0, o.a, 0, 0, o.state]);
        break;
      case 6: ops.push([32, o.out, o.a, 0, 0, 0]); break;
      case 21: ops.push([34, o.out, o.a, o.b, 0, 0]); break;
      case 15: ops.push([33, o.out, o.a, o.b, 0, 0]); break;
      case 23: {
        // Fixed node modes only: runtime-selected link distortions are not supported.
        const code = fm1DistortionModes[o.value];
        if (o.c !== -1 || code === undefined) throw new Error(`${context}: unsupported FM-1 distortion mode`);
        ops.push([code, o.out, o.a, o.b, 0, 0]);
        break;
      }
      case 26: {
        if (o.a === 9 && o.value === 2) {
          ops.push([47, o.out, o.b, o.c, 0, 0]);
          break;
        }
        const arity = fm1FunctionArity(o.a);
        if (!arity || o.value !== arity) throw new Error(`${context}: unsupported FM-1 expression function ${o.a}`);
        ops.push([38, o.out, o.b, arity >= 2 ? o.c : 0, arity === 3 ? o.d : 0, 0, o.a]);
        break;
      }
      case 27:
        if (o.a < 0 || o.a > 4) throw new Error(`${context}: FM-1 supports the MIDI Note node, not MIDI Note On or MIDI Note Off.`);
        ops.push([52, o.out, o.a, o.b, 0, 0]);
        break;
      case 29: ops.push([39, o.out, o.a, o.b, o.c, o.state, o.d, o.e, o.value]); break;
      case 7: ops.push([46, o.out, o.a, o.b, o.c, 0, o.d, o.e]); break;
      case 12:
        if (++fm1DelayCount > 1) throw new Error('FM-1 supports one Delay node per patch');
        ops.push([44, o.out, o.a, o.b, o.c, o.state, o.d]);
        break;
      case 20: ops.push([45, o.out, o.a, o.b, o.c, o.state]); break;
      case 32: ops.push([49, o.out, o.a, o.c, o.e, fm1StateCount++]); break;
      case 40: ops.push([48, o.out, o.a, o.b, o.c, 0]); break;
      case 49: ops.push([40, o.out, o.b, o.c, o.a, o.state]); break;
      case 55: ops.push([41, o.out, o.a, 0, 0, 0]); break;
      case 51: ops.push([37, o.out, o.a, 0, 0, o.state]); break;
      case 5: ops.push([5, 0, o.a, o.b, 0, 0]); break;
      default: throw new Error(`Unsupported opcode ${o.opcode}`);
    }
  }
  const fixedValues = program.values.map(q16);
  const mutableValues = new Set(program.valueBindings.filter(b => b.nodeId === controlsId && controlsId !== undefined).map(b => b.valueIndex));
  ops = optimizeFm1Ops(ops, fixedValues, mutableValues, limits.values);
  for (let i = program.values.length; i < fixedValues.length; i++) program.values.push(fixedValues[i] / 65536);
  for (const [label, used, maximum] of [
    ['operations', ops.length, limits.operations], ['registers', program.registerCount, limits.registers],
    ['values', program.values.length, limits.values], ['state entries', fm1StateCount, limits.states],
  ]) if (used > maximum) throw new Error(`Patch uses ${used} ${label}; FM-1 limit is ${maximum}`);
  program.stateCount = fm1StateCount;
  const parameters: Record<string, number> = {};
  // Portable little-endian package, independent of the C compiler's structure layout.
  for (const op of ops) while (op.length < 12) op.push(0);
  const bytes = new Uint8Array(187 + ops.length * limits.operationBytes + program.values.length * 4);
  const view = new DataView(bytes.buffer);
  const text = (value: string, at: number) => bytes.set(new TextEncoder().encode(value), at);
  text('TGP1', 0); view.setUint16(4, limits.packageVersion, true);
  view.setUint16(6, ops.length, true); view.setUint16(8, program.registerCount, true); view.setUint16(10, program.values.length, true);
  const name = patch.name ?? 'untitled';
  if (!/^[ -~]{1,23}$/.test(name)) throw new Error('Patch name must be 1–23 printable ASCII characters');
  text(name, 12);
  const usedKnobs = new Set<number>();
  bytes[36] = controlOutputs.length;
  controlOutputs.forEach((output, i) => {
    const binding = program.valueBindings.find(b => b.nodeId === controlsId && b.port === output.name);
    if (!binding || usedKnobs.has(binding.valueIndex)) throw new Error(`Invalid or duplicate Params output "${output.name}".`);
    usedKnobs.add(binding.valueIndex);
    if (!/^[a-z]+(?: [a-z]+)*$/.test(output.name) || output.name.length > 11) throw new Error('FM-1 Params labels use lowercase English words, at most 11 characters.');
    const lo = q16(output.min ?? 0), hi = q16(output.max ?? 1);
    const step = Math.max(1, Math.round((hi - lo) / 100));
    if (lo >= hi || program.values[binding.valueIndex] < (output.min ?? 0) || program.values[binding.valueIndex] > (output.max ?? 1)) throw new Error(`Invalid range or default for Params output "${output.name}".`);
    parameters[output.name] = binding.valueIndex;
    const at = 37 + i * 25; bytes[at] = binding.valueIndex; text(output.name, at + 1);
    view.setInt32(at + 13, lo, true); view.setInt32(at + 17, hi, true); view.setInt32(at + 21, step, true);
  });
  let at = 187;
  for (const op of ops) for (const v of op) { writeOperand(view, at, v); at += 2; }
  for (const v of program.values) { view.setInt32(at, q16(v), true); at += 4; }
  inspectFm1Package(bytes);
  return { program, ops, parameters, bytes };
}
