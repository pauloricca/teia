import { NATIVE_PROFILE, type PreparedPatch } from './compiler';
import engineCapabilities from './engineCapabilities.json';
export const NATIVE_CAPABILITIES = Object.freeze({ ...engineCapabilities, profile: NATIVE_PROFILE });
/** Authoritative host timeline. Provide offset zero and additional segments at
 * tempo/transport changes; explicit discontinuities accompany seeks and loops. */
export interface TimelineSegment {
  offset: number;
  renderFrame: number;
  beat: number;
  bpm: number;
  running: boolean;
  discontinuity?: 'seek' | 'loop' | 'start' | 'stop';
}
/** Off-render conversion to Operation fields accepted by native PreparedProgram.
 * Rust repeats authoritative validation before constructing any live instance. */
export function nativeProgram(prepared: PreparedPatch, generation: number, options: { includeResources?: boolean } = {}) {
  if (prepared.profile !== NATIVE_PROFILE || prepared.diagnostics.some(d => d.severity === 'error')) throw new Error('A valid native-scalar-v1 preparation is required.');
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Native generation must be a positive safe integer.');
  return { version: 1, generation, operations: prepared.program.ops.map(op => ({ opcode: op.opcode, out: op.out ?? -1, a: op.a ?? -1, b: op.b ?? -1, c: op.c ?? -1, d: op.d ?? -1, e: op.e ?? -1, state: op.state ?? -1, value: op.value ?? 0, value2: op.value2 ?? 0, value3: op.value3 ?? 0, value4: op.value4 ?? 0 })), values: [...prepared.program.values],
    ...(options.includeResources ? { resourceBindings: { samples: prepared.program.sampleBindings, images: prepared.program.imageBindings,
      customWaves: prepared.program.customWaveBindings, sequencers: prepared.program.sequencerBindings,
      buffers: prepared.program.stateBindings.filter(b => b.id.endsWith(':buffer')), snapshots: prepared.requirements.buffers,
      repeats: prepared.program.repeatBindings, fft: prepared.program.fftBindings },
    executionRevision: NATIVE_CAPABILITIES.executionRevision } : {}) };
}

/** Use one ordered list; equal offsets retain caller ordering before that sample. */
export type NativeEvent = { offset: number } & (
  | { type: 'control'; valueIndex: number; value: number; generation: number }
  | { type: 'note on'; channel: number; note: number; velocity: number }
  | { type: 'note off'; channel: number; note: number }
  | { type: 'control change'; channel: number; controller: number; value: number }
  | { type: 'pitch bend'; channel: number; value: number; rangeSemitones: number }
);
export interface NativeMidiOutput { offset: number; type: 'note on' | 'note off' | 'control change'; channel: number; number: number; value: number }
