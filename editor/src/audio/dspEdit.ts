import { DSP_OP } from './dspOpcodes';
import type { DspProgram } from './dspProgram';

// Shared executable compatibility keys for standalone and supplied hosted backends.
export function dspProgramStructureKey(program: DspProgram): string {
  return JSON.stringify({
    version: program.version,
    engineApiVersion: program.engineApiVersion ?? 1,
    ops: program.ops,
    valueBindings: program.valueBindings,
    midiControlBindings: program.midiControlBindings,
    tempoBindings: program.tempoBindings,
    stateBindings: program.stateBindings,
    registerCount: program.registerCount,
    stateCount: program.stateCount,
    feedbackLinkIds: program.feedbackLinkIds,
    monitorIds: program.monitorIds,
    sampleBindings: program.sampleBindings,
    imageBindings: program.imageBindings,
    fftBindings: program.fftBindings,
    // Point coordinates have a dedicated in-place worklet update path. Mode
    // and sustain changes still rebuild because they alter oscillator setup.
    customWaveBindings: program.customWaveBindings.map((binding) => ({
      nodeId: binding.nodeId,
      mode: binding.customWave.mode,
      sustainStart: binding.customWave.sustainStart,
      sustainEnd: binding.customWave.sustainEnd,
    })),
    sequencerBindings: program.sequencerBindings.map((binding) => binding.nodeId),
    repeatBindings: program.repeatBindings,
    maxVoices: program.maxVoices,
    usesMidiNote: program.usesMidiNote,
    usesMidiClock: program.usesMidiClock,
    errors: program.errors,
  });
}


export function dspCustomWavePointsKey(program: DspProgram): string {
  return JSON.stringify(program.customWaveBindings.map((binding) => ({
    nodeId: binding.nodeId,
    points: binding.customWave.points,
  })));
}


export function dspSequencerConfigKey(program: DspProgram): string {
  return JSON.stringify(program.sequencerBindings);
}


/** API 2 adds channel selectors; API 1 programs retain legacy mono Input. */
export function requiredEngineApi(program: DspProgram): 1 | 2 {
  return program.ops.some(op => op.opcode === DSP_OP.Input && (op.b === 0 || op.b === 1)) ? 2 : 1;
}
