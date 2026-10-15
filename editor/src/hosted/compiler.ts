import engineCapabilities from './engineCapabilities.json';
import { requiredEngineApi, dspProgramStructureKey, dspCustomWavePointsKey, dspSequencerConfigKey } from '../audio/dspEdit';
import { compilePatchToDspProgram, type DspProgram } from '../audio/dspProgram';
import { expandGroups } from '../graph/subpatch';
import type { Patch } from '../graph/types';
import { readDocument, withParameterIds, bufferReferences, type Diagnostic } from './document';

export const COMPILER_VERSION = 1;
export const NATIVE_PROFILE = 'native-scalar-v1';
export interface ParameterMetadata {
  id: string;
  name: string;
  nodeId: string;
  defaultValue: number;
  min: number;
  max: number;
  step?: number;
  integer?: boolean;
  binding: { valueIndex: number; layout: string };
  legacyId: string;
}
export interface PreparedPatch {
  version: 1;
  document: Patch;
  program: DspProgram;
  layout: string;
  parameters: ParameterMetadata[];
  requirements: { samples: DspProgram['sampleBindings']; images: DspProgram['imageBindings']; buffers: Patch['buffers']; engineApiVersion: number; audioChannels: number; hostTimeline: boolean; midiKinds: string[] };
  resources: { operations: number; registers: number; state: number; values: number; maxBlockFrames: number; eventLimit: number; midiOutputLimit: number; heldNoteLimit: number };
  diagnostics: Diagnostic[];
  profile: 'web' | typeof NATIVE_PROFILE;
}

/** Pure/off-render compilation. No asset fetches, storage access, devices or mounted editor. */
export function preparePatch(input: Patch | string, options: { profile?: PreparedPatch['profile'] } = {}): PreparedPatch | { diagnostics: Diagnostic[] } {
  const read = readDocument(input);
  if (!read.patch || read.diagnostics.some(d => d.severity === 'error')) return { diagnostics: read.diagnostics };
  const document = withParameterIds(read.patch);
  let program: DspProgram;
  try { program = compilePatchToDspProgram(document); } catch (error) { return { diagnostics: [...read.diagnostics, { severity: 'error', code: 'compile', message: String(error) }] }; }
  const diagnostics = [...read.diagnostics, ...read.diagnostics.filter(d => d.code === 'discarded-content').map(d => ({ ...d, severity: 'error' as const, code: 'lossy-import', message: `Execution blocked pending import review: ${d.message}` })), ...program.errors.map(message => ({ severity: 'error' as const, code: 'compile', message }))];
  // Full layout identity is collision-free, opaque and independent of current values.
  const layout = dspProgramStructureKey(program);
  const parameters = parameterMetadata(document, program, layout);
  for (const p of parameters) if (![p.defaultValue, p.min, p.max].every(Number.isFinite) || p.min > p.max || (p.step !== undefined && (!Number.isFinite(p.step) || p.step <= 0))) diagnostics.push({ severity: 'error', code: 'invalid-parameter-range', nodeId: p.nodeId, port: p.name, message: `Invalid bounds or step for parameter ${p.name}.` });
  const ids = parameters.map(p => p.id);
  if (new Set(ids).size !== ids.length) diagnostics.push({ severity: 'error', code: 'duplicate-parameter', message: 'Exposed parameter IDs must be unique.' });
  const profile = options.profile ?? 'web';
  if (profile === NATIVE_PROFILE) {
    if (program.fftBindings.length && !engineCapabilities.nativeAnalysis) diagnostics.push({ severity: 'error', code: 'native-analysis-unavailable', message: 'FFT analysis currently runs in the browser worklet. Its shared Rust integration is pending; this native program cannot execute FFT outputs yet.' });

    if (program.ops.length > 4096 || program.registerCount > 4096 || program.stateCount > 4096 || program.values.length > 2048) diagnostics.push({ severity: 'error', code: 'resource-limit', message: 'Program exceeds native kernel capacity.' });

  }
  return { version: 1, document, program, layout, parameters, profile, diagnostics,
    requirements: { samples: program.sampleBindings, images: program.imageBindings, buffers: bufferReferences(document), engineApiVersion: requiredEngineApi(program), audioChannels: 2, hostTimeline: profile === NATIVE_PROFILE && program.tempoBindings.length > 0, midiKinds: profile === NATIVE_PROFILE ? ['note on', 'note off', 'control change', 'pitch bend'] : [] },
    resources: { operations: program.ops.length, registers: program.registerCount, state: program.stateCount, values: program.values.length, maxBlockFrames: 2048, eventLimit: 256, midiOutputLimit: 4096, heldNoteLimit: 2048 } };
}

export function parameterMetadata(patch: Patch, program: DspProgram, layout: string): ParameterMetadata[] {
  return expandGroups(patch).nodes.filter(n => n.type === 'Params').flatMap(node => (node.outputs ?? []).flatMap(port => {
    const binding = program.valueBindings.find(b => b.kind === 'node-param' && b.nodeId === node.id && b.port === port.name);
    return binding ? [{ id: port.parameterId ?? `${node.id}.${port.name}`, legacyId: `${node.id}.${port.name}`, name: port.name, nodeId: node.id,
      defaultValue: node.params[port.name] ?? port.defaultValue ?? 0, min: port.min ?? 0, max: port.max ?? 1,
      ...(port.step !== undefined ? { step: port.step } : {}), ...(port.integer !== undefined ? { integer: port.integer } : {}),
      binding: { valueIndex: binding.valueIndex, layout } }] : [];
  }));
}

export type EditClassification =
  | { kind: 'editor-only' }
  | { kind: 'values'; layout: string; updates: { valueIndex: number; value: number }[] }
  | { kind: 'specialized'; layout: string; updates: { valueIndex: number; value: number }[]; customWaves?: DspProgram['customWaveBindings']; sequencers?: DspProgram['sequencerBindings'] }
  | { kind: 'prepare'; reason: string };
/** Keys are shared with standalone in-place Custom Wave and sequencer updates. */
export function classifyEdit(previous: PreparedPatch, next: PreparedPatch): EditClassification {
  if (next.diagnostics.some(d => d.severity === 'error')) return { kind: 'prepare', reason: 'Compilation failed.' };
  if (JSON.stringify(previous.requirements.buffers) !== JSON.stringify(next.requirements.buffers)) return { kind: 'prepare', reason: 'Buffer snapshots changed.' };
  if (previous.layout !== next.layout) return { kind: 'prepare', reason: 'Executable layout or resources changed.' };
  const updates = next.program.values.flatMap((value, valueIndex) => previous.program.values[valueIndex] === value ? [] : [{ valueIndex, value }]);
  const wavesChanged = dspCustomWavePointsKey(previous.program) !== dspCustomWavePointsKey(next.program);
  const sequencersChanged = dspSequencerConfigKey(previous.program) !== dspSequencerConfigKey(next.program);
  if (wavesChanged || sequencersChanged) return { kind: 'specialized', layout: previous.layout, updates, ...(wavesChanged ? { customWaves: next.program.customWaveBindings } : {}), ...(sequencersChanged ? { sequencers: next.program.sequencerBindings } : {}) };
  return updates.length ? { kind: 'values', layout: previous.layout, updates } : { kind: 'editor-only' };
}
