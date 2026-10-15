import { expandGroups } from '../graph/subpatch';
import { expandSpreads } from '../graph/spread';
import { customWaveBank, customWaveWithBaseLevel } from '../graph/customWave';
import {
  SEQUENCER_DEFAULT_ROWS,
  SEQUENCER_DEFAULT_STEPS,
  SEQUENCER_INDEX_OUTPUT,
  ROLL_MAX_ROWS,
  getNodeDefinition,
  rollCellParamName,
  rollGatesForRow,
  rollShape,
  sequencerGatesForRow,
  sequencerOutputIndex,
  sequencerShape,
  sequencerTriggersForRow,
  sequencerUsesGateMode,
} from '../graph/nodeTypes';
import type { CustomWaveSettings, LinkMode, NodeType, Patch, PatchLink, PatchNode } from '../graph/types';
import { simplifyDspOperations, type DspOptimizationOptions, type DspOptimizationReport } from './dspOptimizer';

import { DSP_OP } from './dspOpcodes';
import { analyzeDspSchedule, type DspScheduleReport } from './dspSchedule';
export { DSP_OP } from './dspOpcodes';

export interface DspProgram {
  version: 1;
  /** Missing means legacy engine API 1 (mono Input selectors ignored). */
  engineApiVersion?: 1 | 2;
  ops: DspOp[];
  values: number[];
  valueBindings: DspValueBinding[];
  midiControlBindings: DspMidiControlBinding[];
  tempoBindings: DspTempoBinding[];
  stateBindings: DspStateBinding[];
  registerCount: number;
  stateCount: number;
  feedbackLinkIds: string[];
  monitorIds: Record<string, number>;
  signedMeterIds: string[];
  sampleBindings: DspSampleBinding[];
  imageBindings: DspImageBinding[];
  customWaveBindings: DspCustomWaveBinding[];
  sequencerBindings: DspSequencerBinding[];
  repeatBindings: DspRepeatBinding[];
  fftBindings: DspFftBinding[];
  maxVoices: number;
  usesMidiNote: boolean;
  usesMidiClock: boolean;
  errors: string[];
  optimization?: DspOptimizationReport;
  schedule?: DspScheduleReport;
}

export interface DspOp {
  opcode: number;
  out?: number;
  a?: number;
  b?: number;
  c?: number;
  d?: number;
  e?: number;
  state?: number;
  value?: number;
  value2?: number;
  value3?: number;
  value4?: number;
}

export interface DspValueBinding {
  id: string;
  valueIndex: number;
  kind: 'node-param' | 'link-weight' | 'constant' | 'analyser-output';
  nodeId?: string;
  port?: string;
  linkId?: string;
}

export interface DspStateBinding {
  id: string;
  state: number;
  count: number;
  kind: 'oscillator' | 'filter' | 'feedback' | 'selector' | 'effect' | 'sequencer' | 'spread';
  nodeId: string;
}

export interface DspMidiControlBinding {
  nodeId: string;
  kind: 'slider' | 'button';
  channel: number;
  cc: number;
  valueIndex: number;
  modeValueIndex?: number;
  clicksValueIndex?: number;
}

export interface DspTempoBinding {
  nodeId: string;
  bpmValueIndex: number;
  sourceValueIndex: number;
  midiSourceValueIndex: number;
}

export interface DspSampleBinding {
  nodeId: string;
  sample: {
    name: string;
    url: string;
  };
  release: number;
}

export interface DspCustomWaveBinding {
  nodeId: string;
  customWave: CustomWaveSettings;
}

export interface DspSequencerEventBinding {
  active: boolean;
  start: number;
  end: number;
  velocity: number;
  note: number;
}

export interface DspSequencerBinding {
  nodeId: string;
  mode: 'trigger' | 'gate';
  steps: number;
  rows: number;
  events: DspSequencerEventBinding[][];
}

export interface DspRepeatBinding {
  nodeId: string;
  type: 'Spread' | 'Spawn';
  slot: number;
  stateStart: number;
  stateCount: number;
}

export interface DspFftBinding {
  nodeId: string;
  inputRegister: number;
  minFrequencyValueIndex: number;
  maxFrequencyValueIndex: number;
  frequencyValueIndex: number;
  amplitudeValueIndex: number;
}

export interface DspImageBinding {
  nodeId: string;
  image: { name: string; url: string };
}

interface FeedbackBinding {
  readRegister: number;
  state: number;
  writeEmitted: boolean;
}

interface CompileContext {
  patch: Patch;
  nodeById: Map<string, PatchNode>;
  incomingByInput: Map<string, PatchLink[]>;
  outputCache: Map<string, number>;
  bufferRecordHeadOutputByNodeId: Map<string, number>;
  buttonGateOutputByNodeId: Map<string, number>;
  joystickUnitValueByAxis: Map<string, number>;
  sliderUnitValueByNodeId: Map<string, number>;
  sendSignalByNodeId: Map<string, number>;
  visitingOutputs: Set<string>;
  feedbackByOutput: Map<string, FeedbackBinding>;
  sequencerStateByNodeId: Map<string, number>;
  sequencerStepRegisterByNodeId: Map<string, number>;
  ops: DspOp[];
  values: number[];
  valueBindings: DspValueBinding[];
  midiControlBindings: DspMidiControlBinding[];
  tempoBindings: DspTempoBinding[];
  stateBindings: DspStateBinding[];
  constantValueIndexes: Map<number, number>;
  constantRegisters: Map<string, number>;
  deduplicatedLoads: number;
  optimizationOptions: DspCompileOptions;
  errors: string[];
  feedbackLinkIds: string[];
  monitorIds: Record<string, number>;
  signedMeterIds: string[];
  sampleBindings: DspSampleBinding[];
  imageBindings: DspImageBinding[];
  imageBindingIndexByNodeId: Map<string, number>;
  customWaveBindings: DspCustomWaveBinding[];
  sequencerBindings: DspSequencerBinding[];
  sequencerBindingIndexByNodeId: Map<string, number>;
  repeatBindings: DspRepeatBinding[];
  fftBindings: DspFftBinding[];
  fftBindingByNodeId: Map<string, DspFftBinding>;
  spreadCountRegisterById: Map<string, number>;
  spawnActiveCountRegisterById: Map<string, number>;
  spreadBoundaryRegisterByLink: Map<PatchLink, number>;
  usesMidiNote: boolean;
  usesMidiClock: boolean;
  maxVoices: number;
  registerCount: number;
  stateCount: number;
}

const BUTTON_GATE_FADE_SECONDS = 0.008;
const MAX_DSP_OPS = 4096;
const MAX_DSP_REGISTERS = 4096;
const MAX_DSP_VALUES = 2048;
const MAX_DSP_STATE = 4096;
const MAX_DSP_EFFECT_BUFFERS = 64;
const MAX_DSP_BUFFERS = 16;

const OSC_WAVES: Partial<Record<NodeType, number>> = {
  SineOsc: 0,
  TriangleOsc: 1,
  SawOsc: 2,
  RampOsc: 3,
  SquareOsc: 4,
  SampleHoldOsc: 5,
  KinkOsc: 12,
};

const FILTER_TYPES: Partial<Record<NodeType, number>> = {
  LowpassFilter: 1,
  HighpassFilter: 2,
  BandpassFilter: 3,
  AllpassFilter: 8,
};

const DISTORTION_TYPES: Partial<Record<NodeType, number>> = {
  HardClipDistortion: 1,
  SoftClipDistortion: 2,
  FuzzDistortion: 3,
  SaturateDistortion: 4,
  WavefoldDistortion: 5,
};

const EXPRESSION_FUNCTIONS: Record<string, { id: number; minArgs: number; maxArgs: number }> = {
  abs: { id: 1, minArgs: 1, maxArgs: 1 },
  sin: { id: 2, minArgs: 1, maxArgs: 1 },
  cos: { id: 3, minArgs: 1, maxArgs: 1 },
  tan: { id: 4, minArgs: 1, maxArgs: 1 },
  tanh: { id: 5, minArgs: 1, maxArgs: 1 },
  min: { id: 6, minArgs: 2, maxArgs: 2 },
  max: { id: 7, minArgs: 2, maxArgs: 2 },
  clamp: { id: 8, minArgs: 3, maxArgs: 3 },
  pow: { id: 9, minArgs: 2, maxArgs: 2 },
  exp: { id: 10, minArgs: 1, maxArgs: 1 },
  log: { id: 11, minArgs: 1, maxArgs: 1 },
  sqrt: { id: 12, minArgs: 1, maxArgs: 1 },
  floor: { id: 13, minArgs: 1, maxArgs: 1 },
  ceil: { id: 14, minArgs: 1, maxArgs: 1 },
  round: { id: 15, minArgs: 1, maxArgs: 1 },
  sign: { id: 16, minArgs: 1, maxArgs: 1 },
  fract: { id: 17, minArgs: 1, maxArgs: 1 },
  mix: { id: 18, minArgs: 3, maxArgs: 3 },
};

const EXPRESSION_LOGIC_FUNCTIONS = {
  less: 19,
  lessEqual: 20,
  greater: 21,
  greaterEqual: 22,
  equal: 23,
  notEqual: 24,
  and: 25,
  or: 26,
  not: 27,
} as const;

export interface DspCompileOptions extends DspOptimizationOptions {
  target?: 'web' | 'fm1';
}

export function compilePatchToDspProgram(patch: Patch, optimizationOptions: DspCompileOptions = {}): DspProgram {
  const spreadExpansion = expandSpreads(patch);
  // Materialize strength inputs before group boundaries disappear, so they
  // participate in the same boundary rewiring as every other input.
  const expandedPatch = expandGroups(withLinkWeightModulationNodes(spreadExpansion.patch));
  const context = createContext(expandedPatch);
  context.optimizationOptions = optimizationOptions;
  context.errors.push(...spreadExpansion.errors);
  const ordinaryNodes = expandedPatch.nodes.filter((node) => !node.runtimeSpread);
  const audioOutNodes = ordinaryNodes.filter((node) => node.type === 'AudioOut');
  const hasRuntimeAudioOut = expandedPatch.nodes.some((node) => node.runtimeSpread && node.type === 'AudioOut');
  const monitorNodes = ordinaryNodes.filter((node) => node.type === 'Meter' || node.type === 'Scope' || node.type === 'FFT');
  const sliderMonitorNodes = ordinaryNodes.filter((node) => node.type === 'Slider');
  const sequencerMonitorNodes = ordinaryNodes.filter((node) => node.type === 'Sequencer' || node.type === 'Roll');
  const imagePreviewNodes = ordinaryNodes.filter((node) => node.type === 'Image');
  const samplePreviewNodes = ordinaryNodes.filter((node) => node.type === 'SamplePlayer');
  const bufferPreviewNodes = ordinaryNodes.filter((node) => node.type === 'Buffer');

  validatePatchLinks(context);
  compileSpreadTemplates(context);

  if (audioOutNodes.length === 0 && !hasRuntimeAudioOut && monitorNodes.length === 0 && sequencerMonitorNodes.length === 0 && imagePreviewNodes.length === 0) {
    context.errors.push('Patch needs an Audio Out node.');
  }

  for (const node of audioOutNodes) {
    compileAudioOut(node, context);
  }

  for (const node of ordinaryNodes.filter((candidate) => (
    candidate.enabled !== false
    && (candidate.type === 'MidiNoteOnSend' || candidate.type === 'MidiNoteOffSend')
  ))) {
    compileMidiNoteSend(node, context);
  }
  for (const node of ordinaryNodes.filter((candidate) => candidate.enabled !== false && candidate.type === 'MidiCcSend')) {
    compileMidiCcSend(node, context);
  }

  for (const node of monitorNodes) {
    if (node.type === 'FFT') {
      ensureFftBinding(node, context);
    } else {
      resolveOutput(node, 'signal', context);
    }
  }

  for (const node of sliderMonitorNodes) {
    registerSliderMonitor(node, context);
  }

  for (const node of ordinaryNodes.filter((candidate) => candidate.type === 'Params')) {
    for (const output of node.outputs ?? []) resolveOutput(node, output.name, context);
  }

  for (const node of sequencerMonitorNodes) {
    registerSequencerMonitor(node, context);
  }

  // The image preview needs the actual signals arriving at its coordinate
  // inputs, even when no image output is otherwise connected to a monitor.
  // Expose those registers through the existing control-meter channel.
  for (const node of imagePreviewNodes) {
    context.monitorIds[`${node.id}:image-x`] = resolveInput(node, 'x', 0.5, context);
    context.monitorIds[`${node.id}:image-y`] = resolveInput(node, 'y', 0.5, context);
  }

  // Compile sample players even when their audio output is not routed yet so
  // linked region and envelope controls can still drive the node preview.
  for (const node of samplePreviewNodes) {
    resolveOutput(node, 'signal', context);
  }
  for (const node of bufferPreviewNodes) {
    resolveOutput(node, 'signal', context);
  }

  const optimization = simplifyDspOperations(context, optimizationOptions);
  const schedule = optimizationOptions.analyzeSchedule
    ? analyzeDspSchedule(expandedPatch, context.ops, context.feedbackLinkIds)
    : undefined;

  if (context.ops.length > MAX_DSP_OPS) {
    context.errors.push(`DSP program needs ${context.ops.length} operations; the engine limit is ${MAX_DSP_OPS}. Reduce the nodes inside Spreads.`);
  }
  if (context.registerCount > MAX_DSP_REGISTERS) {
    context.errors.push(`DSP program needs ${context.registerCount} registers; the engine limit is ${MAX_DSP_REGISTERS}. Reduce the nodes inside Spreads.`);
  }
  if (context.values.length > MAX_DSP_VALUES) {
    context.errors.push(`DSP program needs ${context.values.length} values; the engine limit is ${MAX_DSP_VALUES}. Reduce the nodes inside Spreads.`);
  }
  if (context.stateCount > MAX_DSP_STATE) {
    context.errors.push(`DSP program needs ${context.stateCount} state slots; the engine limit is ${MAX_DSP_STATE}. Reduce the nodes inside Spreads.`);
  }
  const effectBufferCount = new Set(context.ops
    .filter(dspOpUsesEffectBuffer)
    .flatMap((op) => typeof op.state === 'number' ? [op.state] : [])).size;
  if (effectBufferCount > MAX_DSP_EFFECT_BUFFERS) {
    context.errors.push(`DSP program needs ${effectBufferCount} buffered effects; the engine limit is ${MAX_DSP_EFFECT_BUFFERS}. Reduce Delay, Chorus, Reverb, Comb/Notch, or Limiter nodes.`);
  }
  const bufferCount = new Set(context.ops
    .filter((op) => op.opcode === DSP_OP.Buffer)
    .flatMap((op) => typeof op.state === 'number' ? [op.state] : [])).size;
  if (bufferCount > MAX_DSP_BUFFERS) {
    context.errors.push(`DSP program needs ${bufferCount} Buffer nodes; the engine limit is ${MAX_DSP_BUFFERS}.`);
  }

  if (context.errors.length > 0) {
    return {
      version: 1,
      ops: [],
      values: context.values,
      valueBindings: context.valueBindings,
      midiControlBindings: context.midiControlBindings,
      tempoBindings: context.tempoBindings,
      stateBindings: context.stateBindings,
      registerCount: context.registerCount,
      stateCount: context.stateCount,
      feedbackLinkIds: context.feedbackLinkIds,
      monitorIds: context.monitorIds,
      signedMeterIds: context.signedMeterIds,
      sampleBindings: context.sampleBindings,
      imageBindings: context.imageBindings,
      customWaveBindings: context.customWaveBindings,
      sequencerBindings: context.sequencerBindings,
      repeatBindings: context.repeatBindings,
      fftBindings: context.fftBindings,
      maxVoices: context.maxVoices,
      usesMidiNote: context.usesMidiNote,
      usesMidiClock: context.usesMidiClock,
      errors: [...new Set(context.errors)],
      optimization,
      schedule,
    };
  }

  return {
    version: 1,
    engineApiVersion: context.ops.some(op => op.opcode === DSP_OP.Input && (op.b === 0 || op.b === 1)) ? 2 : 1,
    ops: context.ops,
    values: context.values,
    valueBindings: context.valueBindings,
    midiControlBindings: context.midiControlBindings,
    tempoBindings: context.tempoBindings,
    stateBindings: context.stateBindings,
    registerCount: context.registerCount,
    stateCount: context.stateCount,
    feedbackLinkIds: context.feedbackLinkIds,
    monitorIds: context.monitorIds,
    signedMeterIds: context.signedMeterIds,
    sampleBindings: context.sampleBindings,
    imageBindings: context.imageBindings,
    customWaveBindings: context.customWaveBindings,
    sequencerBindings: context.sequencerBindings,
    repeatBindings: context.repeatBindings,
    fftBindings: context.fftBindings,
    maxVoices: context.maxVoices,
    usesMidiNote: context.usesMidiNote,
    usesMidiClock: context.usesMidiClock,
    errors: [],
    optimization,
    schedule,
  };
}

/** Lower cable strength modulation to ordinary Multiply nodes before DSP compilation. */
function withLinkWeightModulationNodes(patch: Patch): Patch {
  const nodes = patch.nodes.map((node) => node.subpatch
    ? { ...node, subpatch: withLinkWeightModulationNodes(node.subpatch) }
    : node);
  const links: PatchLink[] = [];
  let nextId = 0;
  const lower = (link: PatchLink): void => {
    const modulators = link.weightModulations?.filter((entry) => entry.enabled !== false) ?? [];
    if (modulators.length === 0) {
      links.push({ ...link, weightModulations: undefined });
      return;
    }
    let id = `__link_strength_${nextId++}`;
    while (nodes.some((node) => node.id === id)) id = `${id}_generated`;
    const runtimeSpread = nodes.find((node) => node.id === link.from.node)?.runtimeSpread
      ?? nodes.find((node) => node.id === link.to.node)?.runtimeSpread;
    nodes.push({
      id,
      type: 'Multiply',
      params: { factor: finiteNumber(link.weight, 1) },
      enabled: nodes.find((node) => node.id === link.from.node)?.enabled !== false,
      ...(runtimeSpread ? { runtimeSpread: { ...runtimeSpread, originalNodeId: id } } : {}),
    });
    links.push({ from: link.from, to: { node: id, port: 'signal' }, weight: 1, mode: 'set', enabled: link.enabled });
    for (const modulation of modulators) {
      lower({
        from: modulation.from,
        to: { node: id, port: 'factor' },
        weight: modulation.weight ?? 1,
        mode: modulation.mode ?? 'set',
        enabled: modulation.enabled,
        weightModulations: modulation.weightModulations,
      });
    }
    links.push({ from: { node: id, port: 'signal' }, to: link.to, weight: 1, mode: link.mode, enabled: link.enabled });
  };
  patch.links.forEach(lower);
  return { ...patch, nodes, links };
}

function createContext(patch: Patch): CompileContext {
  const nodeById = new Map(patch.nodes.map((node) => [node.id, node]));
  const incomingByInput = new Map<string, PatchLink[]>();
  for (const link of patch.links) {
    if (link.enabled === false) continue;
    if (nodeById.get(link.from.node)?.enabled === false || nodeById.get(link.to.node)?.enabled === false) continue;
    const target = nodeById.get(link.to.node);
    const targetPort = target?.type === 'Sequencer' && link.to.port === 'tick'
      ? 'signal'
      : link.to.port;
    const key = inputKey(link.to.node, targetPort);
    incomingByInput.set(key, [...(incomingByInput.get(key) ?? []), link]);
  }

  return {
    patch,
    nodeById,
    incomingByInput,
    outputCache: new Map(),
    bufferRecordHeadOutputByNodeId: new Map(),
    buttonGateOutputByNodeId: new Map(),
    joystickUnitValueByAxis: new Map(),
    sliderUnitValueByNodeId: new Map(),
    sendSignalByNodeId: new Map(),
    visitingOutputs: new Set(),
    feedbackByOutput: new Map(),
    sequencerStateByNodeId: new Map(),
    sequencerStepRegisterByNodeId: new Map(),
    ops: [],
    values: [],
    valueBindings: [],
    midiControlBindings: [],
    tempoBindings: [],
    stateBindings: [],
    constantValueIndexes: new Map(),
    constantRegisters: new Map(),
    deduplicatedLoads: 0,
    optimizationOptions: {},
    errors: [],
    feedbackLinkIds: [],
    monitorIds: {},
    signedMeterIds: [],
    sampleBindings: [],
    imageBindings: [],
    imageBindingIndexByNodeId: new Map(),
    customWaveBindings: [],
    sequencerBindings: [],
    sequencerBindingIndexByNodeId: new Map(),
    repeatBindings: [],
    fftBindings: [],
    fftBindingByNodeId: new Map(),
    spreadCountRegisterById: new Map(),
    spawnActiveCountRegisterById: new Map(),
    spreadBoundaryRegisterByLink: new Map(),
    usesMidiNote: false,
    usesMidiClock: false,
    maxVoices: 1,
    registerCount: 0,
    stateCount: 0,
  };
}

function compileSpreadTemplates(context: CompileContext): void {
  const spreads = context.patch.nodes.filter((node) => node.type === 'Spread' || node.type === 'Spawn');

  for (let spreadSlot = 0; spreadSlot < spreads.length; spreadSlot += 1) {
    const spread = spreads[spreadSlot];
    const templateNodes = context.patch.nodes.filter((node) => node.runtimeSpread?.spreadId === spread.id);
    const templateIds = new Set(templateNodes.map((node) => node.id));

    // Compile every signal entering the template before its repeat bracket so
    // external stateful nodes run once per sample, not once per Spread item.
    for (const link of context.patch.links) {
      if (link.enabled === false || context.nodeById.get(link.from.node)?.enabled === false || context.nodeById.get(link.to.node)?.enabled === false || !templateIds.has(link.to.node) || templateIds.has(link.from.node)) continue;
      const source = context.nodeById.get(link.from.node);
      if (source) resolveOutput(source, link.from.port, context);
    }

    // Virtual routes entering a repeated template need the same treatment as
    // explicit external links: compile the Send once before the repeat begins.
    const receives = templateNodes.filter((node) => node.type === 'Receive');
    for (const send of context.patch.nodes) {
      if (send.type !== 'Send' || send.enabled === false || send.runtimeSpread) continue;
      if (receives.some((receive) => routingNumber(receive) === routingNumber(send)
        && routingNodesShareRuntime(receive, send))) resolveSendSignal(send, context);
    }

    const countRegister = spread.type === 'Spread'
      ? ensureSpreadCountRegister(spread, context)
      : nextRegister(context);
    const triggerRegister = spread.type === 'Spawn'
      ? resolveInput(spread, 'trigger', 0, context, 'immediate')
      : -1;
    const releaseTriggerRegister = spread.type === 'Spawn'
      ? resolveInput(spread, 'release trigger', 0, context, 'immediate')
      : -1;
    const stateStart = context.stateCount;
    const begin: DspOp = {
      opcode: spread.type === 'Spawn' ? DSP_OP.SpawnBegin : DSP_OP.SpreadBegin,
      out: spread.type === 'Spawn' ? countRegister : -1,
      a: spread.type === 'Spawn' ? triggerRegister : countRegister,
      b: -1,
      c: -1,
      d: releaseTriggerRegister,
      state: stateStart,
      value: spreadSlot,
      value2: 0,
    };
    context.ops.push(begin);
    context.constantRegisters.clear();
    if (spread.type === 'Spawn') {
      context.spawnActiveCountRegisterById.set(spread.id, countRegister);
      context.monitorIds[`${spread.id}:spawn-count`] = countRegister;
    }

    // Sinks and previews contained by the Spread are part of the repeated
    // template even when they do not lead to an external output link.
    for (const node of templateNodes) {
      if (node.type === 'AudioOut') compileAudioOut(node, context);
      else if (node.type === 'FFT') ensureFftBinding(node, context);
      else if (node.type === 'Meter' || node.type === 'Scope') resolveOutput(node, 'signal', context);
      else if (node.type === 'SamplePlayer') resolveOutput(node, 'signal', context);
      else if (node.enabled !== false && (node.type === 'MidiNoteOnSend' || node.type === 'MidiNoteOffSend')) compileMidiNoteSend(node, context);
      else if (node.enabled !== false && node.type === 'MidiCcSend') compileMidiCcSend(node, context);
    }

    for (const link of context.patch.links) {
      if (link.enabled === false || context.nodeById.get(link.from.node)?.enabled === false || context.nodeById.get(link.to.node)?.enabled === false || !templateIds.has(link.from.node) || templateIds.has(link.to.node)) continue;
      if (spread.type === 'Spawn' && link.to.node === spread.id && link.to.port === 'kill trigger') continue;
      const source = context.nodeById.get(link.from.node);
      if (!source) continue;
      const sourceRegister = resolveOutput(source, link.from.port, context);
      if (sourceRegister === null) continue;
      const weightedRegister = emitBinary(
        DSP_OP.Mul,
        sourceRegister,
        valueRegisterForLinkWeight(link, context),
        context,
      );
      const aggregateRegister = nextRegister(context);
      context.ops.push({
        opcode: DSP_OP.SpreadCollect,
        out: aggregateRegister,
        a: weightedRegister,
        b: (link.mode ?? 'set') === 'multiply' ? 1 : 0,
      });
      context.spreadBoundaryRegisterByLink.set(link, aggregateRegister);
    }

    if (spread.type === 'Spawn' && hasInput(spread, 'kill trigger', context)) {
      begin.c = resolveInput(spread, 'kill trigger', 0, context, 'immediate', spread.id);
    }
    const endIndex = context.ops.length;
    context.ops.push({
      opcode: spread.type === 'Spawn' ? DSP_OP.SpawnEnd : DSP_OP.SpreadEnd,
      value: spreadSlot,
    });
    context.constantRegisters.clear();
    begin.b = endIndex;
    begin.value2 = context.stateCount - stateStart;
    context.repeatBindings.push({
      nodeId: spread.id,
      type: spread.type === 'Spawn' ? 'Spawn' : 'Spread',
      slot: spreadSlot,
      stateStart,
      stateCount: context.stateCount - stateStart,
    });
  }
}

function ensureSpreadCountRegister(spread: PatchNode, context: CompileContext): number {
  const existing = context.spreadCountRegisterById.get(spread.id);
  if (existing !== undefined) return existing;

  const liveCount = resolveInput(spread, 'count', 1, context, 'immediate');
  const countRegister = nextRegister(context);
  const state = nextState(context, 1);
  context.ops.push({ opcode: DSP_OP.BlockLatch, out: countRegister, a: liveCount, state });
  context.stateBindings.push({
    id: `${spread.id}:count`,
    state,
    count: 1,
    kind: 'spread',
    nodeId: spread.id,
  });
  context.spreadCountRegisterById.set(spread.id, countRegister);
  return countRegister;
}

function compileAudioOut(node: PatchNode, context: CompileContext): void {
  const level = resolveInput(node, 'level', 0.75, context);
  const leftRegisters: number[] = [];
  const rightRegisters: number[] = [];
  let outputLinkCount = 0;

  for (const port of ['both', 'left', 'right'] as const) {
    const links = context.incomingByInput.get(inputKey(node.id, port)) ?? [];
    if (links.length === 0) continue;

    outputLinkCount += links.length;
    const input = resolveInput(node, port, 0, context);
    const scaled = emitBinary(DSP_OP.Mul, input, level, context);
    if (port === 'both' || port === 'left') {
      context.ops.push({ opcode: DSP_OP.Output, a: scaled, b: 0 });
      leftRegisters.push(scaled);
    }
    if (port === 'both' || port === 'right') {
      context.ops.push({ opcode: DSP_OP.Output, a: scaled, b: 1 });
      rightRegisters.push(scaled);
    }
  }

  if (outputLinkCount === 0) {
    context.errors.push(`Audio Out node "${node.id}" has no connected audio signal.`);
    return;
  }

  context.monitorIds[`${node.id}:left`] = sumRegisters(leftRegisters, context);
  context.monitorIds[`${node.id}:right`] = sumRegisters(rightRegisters, context);
}

function compileMidiNoteSend(node: PatchNode, context: CompileContext): void {
  const state = nextState(context, 1);
  context.stateBindings.push({
    id: `${node.id}:trigger`,
    state,
    count: 1,
    kind: 'effect',
    nodeId: node.id,
  });
  context.ops.push({
    opcode: DSP_OP.MidiNoteSend,
    a: resolveInput(node, 'trigger', 0, context),
    b: resolveInput(node, 'note', 60, context),
    c: resolveInput(node, 'velocity', node.type === 'MidiNoteOnSend' ? 1 : 0, context),
    d: resolveInput(node, 'channel', 1, context),
    state,
    value: node.type === 'MidiNoteOnSend' ? 1 : 0,
  });
}

function compileMidiCcSend(node: PatchNode, context: CompileContext): void {
  const state = nextState(context, 5);
  context.stateBindings.push({
    id: `${node.id}:midi-cc-send`,
    state,
    count: 5,
    kind: 'effect',
    nodeId: node.id,
  });
  context.ops.push({
    opcode: DSP_OP.MidiCcSend,
    a: resolveInput(node, 'signal', 0, context),
    b: resolveInput(node, 'trigger', 0, context),
    c: resolveInput(node, 'cc', 1, context),
    d: resolveInput(node, 'channel', 1, context),
    e: resolveInput(node, 'throttle', 0.1, context),
    state,
    value: hasInput(node, 'trigger', context) ? 1 : 0,
  });
}

function validatePatchLinks(context: CompileContext): void {
  for (const link of context.patch.links) {
    if (link.enabled === false || context.nodeById.get(link.from.node)?.enabled === false || context.nodeById.get(link.to.node)?.enabled === false) continue;
    const source = context.nodeById.get(link.from.node);
    const target = context.nodeById.get(link.to.node);

    if (!source) {
      context.errors.push(`Link source node "${link.from.node}" does not exist.`);
    } else if (!portExists(getNodeDefinition(source), 'outputs', link.from.port)) {
      context.errors.push(`Link "${formatLink(link)}" uses invalid output port "${link.from.port}" on node "${link.from.node}".`);
    }

    if (!target) {
      context.errors.push(`Link target node "${link.to.node}" does not exist.`);
    } else if (!portExists(getNodeDefinition(target), 'inputs', link.to.port) && !isLegacySequencerTickInput(target, link.to.port)) {
      context.errors.push(`Link "${formatLink(link)}" uses invalid input port "${link.to.port}" on node "${link.to.node}".`);
    }
  }
}

function isLegacySequencerTickInput(node: PatchNode, port: string): boolean {
  return node.type === 'Sequencer' && port === 'tick';
}

function portExists(definition: ReturnType<typeof getNodeDefinition>, side: 'inputs' | 'outputs', port: string): boolean {
  return definition[side].some((entry) => entry.name === port);
}

function formatLink(link: PatchLink): string {
  return `${link.from.node}:${link.from.port} -> ${link.to.node}:${link.to.port}`;
}

function resolveInput(
  node: PatchNode,
  port: string,
  fallback: number,
  context: CompileContext,
  valueMode: 'smoothed' | 'immediate' = 'smoothed',
  runtimeTargetSpreadId?: string,
): number {
  const links = context.incomingByInput.get(inputKey(node.id, port)) ?? [];
  if (links.length === 0) {
    return valueRegisterForNodeParam(node, port, fallback, context, valueMode);
  }

  const setRegisters: number[] = [];
  const setSpreadGroups = new Map<string, number>();
  let ordinarySetCount = 0;
  const addRegisters: number[] = [];
  const multiplyRegisters: number[] = [];
  const bendRegisters: number[] = [];

  for (const link of links) {
    let register = resolveLinkValue(link, context);
    if (register === null) continue;

    switch (link.mode ?? 'set') {
      case 'add':
        addRegisters.push(register);
        break;
      case 'multiply':
        multiplyRegisters.push(register);
        break;
      case 'bend':
        bendRegisters.push(register);
        break;
      case 'set':
        setRegisters.push(register);
        {
          const source = context.nodeById.get(link.from.node);
          const spread = source?.runtimeSpread;
          const targetSpreadId = node.runtimeSpread?.spreadId ?? runtimeTargetSpreadId;
          if (spread && spread.spreadId !== targetSpreadId) {
            const countRegister = context.spreadCountRegisterById.get(spread.spreadId)
              ?? context.spawnActiveCountRegisterById.get(spread.spreadId);
            if (countRegister !== undefined) {
              setSpreadGroups.set(
                `${spread.spreadId}:${spread.originalNodeId}:${link.from.port}`,
                countRegister,
              );
            }
          } else {
            ordinarySetCount += 1;
          }
        }
        break;
    }
  }

  const setDenominatorRegisters = [
    ...(ordinarySetCount > 0 ? [constantRegister(ordinarySetCount, context)] : []),
    ...setSpreadGroups.values(),
  ];
  let result = setRegisters.length > 0
    ? emitBinary(
        DSP_OP.Div,
        sumRegisters(setRegisters, context),
        sumRegisters(setDenominatorRegisters, context),
        context,
      )
    : valueRegisterForNodeParam(node, port, fallback, context, valueMode);

  for (const register of addRegisters) {
    result = emitBinary(DSP_OP.Add, result, register, context);
  }

  for (const register of multiplyRegisters) {
    result = emitBinary(DSP_OP.Mul, result, register, context);
  }

  for (const register of bendRegisters) {
    result = emitBinary(DSP_OP.Mul, result, emitUnary(DSP_OP.Bend, register, context), context);
  }

  return result;
}

function hasInput(node: PatchNode, port: string, context: CompileContext): boolean {
  return (context.incomingByInput.get(inputKey(node.id, port)) ?? []).length > 0;
}

function resolveOptionalZeroInput(
  node: PatchNode,
  port: string,
  context: CompileContext,
): number {
  if (!hasInput(node, port, context) && finiteNumber(node.params[port], 0) === 0) {
    return -1;
  }
  return resolveInput(node, port, 0, context);
}

function resolveLinkValue(link: PatchLink, context: CompileContext): number | null {
  const spreadBoundaryRegister = context.spreadBoundaryRegisterByLink.get(link);
  if (spreadBoundaryRegister !== undefined) return spreadBoundaryRegister;

  const source = context.nodeById.get(link.from.node);
  if (!source) {
    context.errors.push(`Link source node "${link.from.node}" does not exist.`);
    return null;
  }

  const sourceRegister = resolveOutput(source, link.from.port, context);
  if (sourceRegister === null) return null;

  const weightRegister = valueRegisterForLinkWeight(link, context);
  return emitBinary(DSP_OP.Mul, sourceRegister, weightRegister, context);
}

function resolveOutput(node: PatchNode, port: string, context: CompileContext): number | null {
  if (!getNodeDefinition(node).outputs.some((output) => output.name === port)) {
    context.errors.push(`Node "${node.id}" does not have supported output "${port}".`);
    return null;
  }

  const key = inputKey(node.id, port);
  const cached = context.outputCache.get(key);
  if (cached !== undefined) return cached;

  if (context.visitingOutputs.has(key)) {
    return feedbackRegisterForOutput(node, port, context);
  }

  context.visitingOutputs.add(key);
  const register = compileNodeOutput(node, port, context);
  context.visitingOutputs.delete(key);

  if (register !== null) {
    context.outputCache.set(key, register);
    emitFeedbackWriteIfNeeded(key, register, context);
    return register;
  }
  return register;
}

function feedbackRegisterForOutput(node: PatchNode, port: string, context: CompileContext): number {
  const key = inputKey(node.id, port);
  const existing = context.feedbackByOutput.get(key);
  if (existing) return existing.readRegister;

  const state = nextState(context, 1);
  const readRegister = nextRegister(context);
  context.ops.push({ opcode: DSP_OP.FeedbackRead, out: readRegister, state });
  context.feedbackByOutput.set(key, { readRegister, state, writeEmitted: false });
  context.feedbackLinkIds.push(key);
  context.stateBindings.push({
    id: `${key}:feedback`,
    state,
    count: 1,
    kind: 'feedback',
    nodeId: node.id,
  });
  return readRegister;
}

function emitFeedbackWriteIfNeeded(key: string, register: number, context: CompileContext): void {
  const feedback = context.feedbackByOutput.get(key);
  if (!feedback || feedback.writeEmitted) return;
  context.ops.push({ opcode: DSP_OP.FeedbackWrite, a: register, state: feedback.state });
  feedback.writeEmitted = true;
}

function compileNodeOutput(node: PatchNode, port: string, context: CompileContext): number | null {
  if (node.type === 'Params') {
    return valueRegisterForNodeParam(node, port, 0, context);
  }
  if (node.type === 'Spread' || node.type === 'Spawn') {
    context.errors.push(`${node.type} "${node.id}" does not expose that output.`);
    return null;
  }
  if (node.type === 'Constant') {
    if (node.runtimeSpread?.originalNodeId === '__item_index__') {
      const output = nextRegister(context);
      context.ops.push({ opcode: DSP_OP.SpreadIndex, out: output });
      return output;
    }
    if (node.runtimeSpread?.originalNodeId === '__instance_gate__') {
      const output = nextRegister(context);
      context.ops.push({ opcode: DSP_OP.SpawnInstanceGate, out: output });
      return output;
    }
    return resolveInput(node, 'value', 1, context);
  }

  if (node.type === 'Pass') {
    return resolveInput(node, 'signal', 0, context);
  }

  if (node.type === 'Receive') {
    const number = routingNumber(node);
    const sendRegisters = context.patch.nodes
      .filter((candidate) => (
        candidate.enabled !== false
        && candidate.type === 'Send'
        && routingNumber(candidate) === number
        && routingNodesShareRuntime(node, candidate)
      ))
      .map((send) => resolveSendSignal(send, context));
    return sumRegisters(sendRegisters, context);
  }

  if (node.type === 'Buffer' && port === 'record head out') {
    resolveOutput(node, 'signal', context);
    const output = context.bufferRecordHeadOutputByNodeId.get(node.id);
    if (output === undefined) {
      context.errors.push(`Could not compile record head output for node "${node.id}".`);
      return constantRegister(0, context);
    }
    return output;
  }

  if ((node.type === 'Envelope' || node.type === 'CustomWave') && port === 'end trigger') {
    // Compile the primary output first so the end trigger can observe the
    // exact engine state used to render this node, even when only the trigger
    // output is connected.
    resolveOutput(node, node.type === 'CustomWave' && Math.round(node.params.count ?? 1) > 1 ? 'signal 1' : 'signal', context);
    const bindingId = node.type === 'Envelope'
      ? `${node.id}:envelope`
      : `${node.id}:oscillator:0`;
    const sourceState = context.stateBindings.find((binding) => binding.id === bindingId)?.state;
    if (sourceState === undefined) {
      context.errors.push(`Could not compile end trigger for node "${node.id}".`);
      return null;
    }
    const output = nextRegister(context);
    const state = nextState(context, node.type === 'Envelope' ? 1 : 5);
    context.stateBindings.push({
      id: `${node.id}:end-trigger`,
      state,
      count: node.type === 'Envelope' ? 1 : 5,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.EndTrigger,
      out: output,
      a: sourceState,
      b: node.type === 'CustomWave'
        ? context.customWaveBindings.findIndex((binding) => binding.nodeId === `${node.id}:wave:0`)
        : -1,
      state,
      value: node.type === 'CustomWave' ? 1 : 0,
    });
    return output;
  }

  if (node.type === 'FFT') {
    const binding = ensureFftBinding(node, context);
    if (port === 'frequency') return emitValue(binding.frequencyValueIndex, context, 'immediate');
    if (port === 'amplitude') return emitValue(binding.amplitudeValueIndex, context, 'immediate');
    context.errors.push(`FFT node "${node.id}" does not have supported output "${port}".`);
    return null;
  }

  if (node.type === 'Slider') {
    const unitValue = resolveSliderUnitValue(node, context);
    context.monitorIds[node.id] = unitValue;
    const mappedUnitValue = applySliderCurve(node, unitValue, context);
    const hasSignal = hasInput(node, 'signal', context);
    const hasInverseSignal = hasInput(node, 'inverse signal', context);
    if (hasSignal || hasInverseSignal) {
      return compileControlSignalOutput(node, port, mappedUnitValue, hasSignal, hasInverseSignal, context);
    }
    const outputUnitValue = port === 'inverse'
      ? emitBinary(DSP_OP.Sub, constantRegister(1, context), mappedUnitValue, context)
      : mappedUnitValue;
    const min = resolveInput(node, 'min', 0, context);
    const max = resolveInput(node, 'max', 1, context);
    return emitBinary(DSP_OP.Add, min, emitBinary(DSP_OP.Mul, outputUnitValue, emitBinary(DSP_OP.Sub, max, min, context), context), context);
  }

  if (node.type === 'Joystick') {
    const axis = port.startsWith('x') ? 'x' : 'y';
    const unitValue = resolveJoystickUnitValue(node, axis, context);
    const outputUnitValue = port.endsWith(' inverse')
      ? emitBinary(DSP_OP.Sub, constantRegister(1, context), unitValue, context)
      : unitValue;
    const min = resolveInput(node, `${axis}Min`, 0, context);
    const max = resolveInput(node, `${axis}Max`, 1, context);
    return emitBinary(
      DSP_OP.Add,
      min,
      emitBinary(DSP_OP.Mul, outputUnitValue, emitBinary(DSP_OP.Sub, max, min, context), context),
      context,
    );
  }

  if (node.type === 'Button') {
    const gateOutput = resolveButtonGateOutput(node, context);
    const hasSignal = hasInput(node, 'signal', context);
    const hasInverseSignal = hasInput(node, 'inverse signal', context);
    if (hasSignal || hasInverseSignal) {
      return compileControlSignalOutput(node, port, gateOutput, hasSignal, hasInverseSignal, context);
    }
    return port === 'inverse'
      ? emitBinary(DSP_OP.Sub, constantRegister(1, context), gateOutput, context)
      : gateOutput;
  }

  if (node.type === 'Keys') {
    const valueIndex = valueIndexForNodeParam(node, port === 'frequency' ? 'frequency' : 'note', 0, context);
    const output = emitValue(valueIndex, context, 'immediate');
    if (port !== 'frequency') return output;

    const smoothedOutput = nextRegister(context);
    const state = nextState(context, 4);
    context.stateBindings.push({
      id: `${node.id}:keys-frequency-glide`,
      state,
      count: 4,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Slew,
      out: smoothedOutput,
      a: output,
      b: resolveInput(node, 'glide', 0, context),
      state,
      value: 0,
      value2: 1,
      value3: 1,
    });
    return smoothedOutput;
  }

  if (node.type === 'Expression') {
    return compileExpression(node, context);
  }

  if (node.type === 'MidiNote' || node.type === 'MidiNoteOn' || node.type === 'MidiNoteOff') {
    const output = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.MidiNote,
      out: output,
      a: midiNoteOutputKind(node.type, port),
      b: resolveInput(node, 'channel', 0, context),
    });
    return output;
  }

  if (node.type === 'Tempo') {
    return compileTempo(node, port, context);
  }

  if (node.type === 'MidiCc') {
    const output = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.MidiCc,
      out: output,
      a: resolveInput(node, 'cc', 1, context),
      b: resolveInput(node, 'channel', 0, context),
    });
    return output;
  }

  if (node.type === 'Noise') {
    const rangeMin = resolveInput(node, 'rangeMin', -1, context);
    const rangeMax = resolveInput(node, 'rangeMax', 1, context);
    const output = nextRegister(context);
    const state = nextState(context, 1);
    context.ops.push({
      opcode: DSP_OP.Osc,
      out: output,
      a: 6,
      b: -1,
      state,
      value2: rangeMin,
      value3: rangeMax,
      value4: 1,
    });
    return output;
  }

  if (node.type === 'Random') {
    const output = nextRegister(context);
    const state = nextState(context, 4);
    context.stateBindings.push({
      id: `${node.id}:random`,
      state,
      count: 4,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Random,
      out: output,
      a: resolveOptionalZeroInput(node, 'trigger', context),
      b: resolveInput(node, 'rangeMin', -1, context),
      c: resolveInput(node, 'rangeMax', 1, context),
      state,
    });
    return output;
  }

  const wave = OSC_WAVES[node.type];
  if (wave !== undefined) {
    const frequency = wave === 5 ? -1 : resolveInput(node, 'frequency', 220, context);
    const signal = hasInput(node, 'signal', context) ? resolveInput(node, 'signal', 0, context) : -1;
    const phaseOrTrigger = wave === 5
      ? resolveOptionalZeroInput(node, 'trigger', context)
      : resolveOptionalZeroInput(node, 'phase', context);
    const phaseReset = wave === 5
      ? -1
      : resolveOptionalZeroInput(node, wave === 12 ? 'phase reset' : 'phaseReset', context);
    const rangeMin = wave === 5 ? -1 : resolveInput(node, wave === 12 ? 'range min' : 'rangeMin', -1, context);
    const rangeMax = wave === 5 ? -1 : resolveInput(node, wave === 12 ? 'range max' : 'rangeMax', 1, context);
    const pulseWidth = wave === 4 ? resolveInput(node, 'pulse width', 0.5, context) : -1;
    const kinkShape = wave === 12 ? resolveInput(node, 'shape', 0, context) : -1;
    const kinkSquareness = wave === 12 ? resolveInput(node, 'squareness', 0, context) : -1;
    const output = nextRegister(context);
    const stateCount = wave === 5 ? 3 : phaseReset >= 0 ? 4 : 1;
    const state = nextState(context, stateCount);
    context.stateBindings.push({
      id: `${node.id}:oscillator`,
      state,
      count: stateCount,
      kind: 'oscillator',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Osc,
      out: output,
      a: wave,
      b: frequency,
      c: wave === 12 ? kinkSquareness : signal,
      d: phaseOrTrigger,
      e: phaseReset,
      state,
      value2: rangeMin,
      value3: rangeMax,
      value4: wave === 5 ? 0 : 1,
      value: wave === 12 ? kinkShape : pulseWidth,
    });
    return output;
  }

  if (node.type === 'CustomWave') {
    const waveNumber = port === 'signal' ? 0 : /^signal (\d+)$/.exec(port)?.[1];
    const waveIndex = waveNumber === undefined ? 0 : Math.max(0, Number(waveNumber) - 1);
    const waves = customWaveBank(node.customWave, node.params);
    const customWave = waves[waveIndex] ?? waves[0];
    const staticBaseLevel = node.params.baseLevel ?? 0;
    const staticRangeMin = node.params.rangeMin ?? -1;
    const staticRangeMax = node.params.rangeMax ?? 1;
    const customWaveIndex = context.customWaveBindings.length;
    context.customWaveBindings.push({
      nodeId: `${node.id}:wave:${waveIndex}`,
      customWave: customWaveWithBaseLevel(
        customWave,
        staticBaseLevel,
        staticRangeMin,
        staticRangeMax,
      ),
    });
    const frequency = resolveInput(node, 'frequency', 220, context);
    const frequencyMonitorId = `${node.id}:frequency`;
    context.monitorIds[frequencyMonitorId] = frequency;
    context.signedMeterIds.push(frequencyMonitorId);
    const baseLevel = resolveInput(node, 'baseLevel', 0, context);
    const rangeMin = resolveInput(node, 'rangeMin', -1, context);
    const rangeMax = resolveInput(node, 'rangeMax', 1, context);
    const mappedBaseLevel = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.Map,
      out: mappedBaseLevel,
      a: baseLevel,
      b: rangeMin,
      c: rangeMax,
      d: constantRegister(-1, context),
      e: constantRegister(1, context),
    });
    const normalizedBaseLevel = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.HardClip,
      out: normalizedBaseLevel,
      a: mappedBaseLevel,
      b: constantRegister(1, context),
    });
    const output = nextRegister(context);
    const state = nextState(context, 6);
    context.stateBindings.push({
      id: `${node.id}:oscillator:${waveIndex}`,
      state,
      count: 6,
      kind: 'oscillator',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Osc,
      out: output,
      a: 9,
      b: frequency,
      c: normalizedBaseLevel,
      d: resolveOptionalZeroInput(node, 'phase', context),
      e: resolveOptionalZeroInput(node, 'trigger', context),
      state,
      value: customWaveIndex,
      value2: rangeMin,
      value3: rangeMax,
      value4: 1,
    });
    return output;
  }

  if (node.type === 'PerlinNoise') {
    const speed = resolveInput(node, 'speed', 8, context);
    const rangeMin = resolveInput(node, 'rangeMin', -1, context);
    const rangeMax = resolveInput(node, 'rangeMax', 1, context);
    const output = nextRegister(context);
    const state = nextState(context, 3);
    context.stateBindings.push({
      id: `${node.id}:oscillator`,
      state,
      count: 3,
      kind: 'oscillator',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Osc,
      out: output,
      a: 7,
      b: speed,
      state,
      value2: rangeMin,
      value3: rangeMax,
      value4: 1,
    });
    return output;
  }

  if (node.type === 'AudioInput') {
    const output = nextRegister(context);
    const gain = Math.round(node.params.muted ?? 0) === 1
      ? 0
      : resolveInput(node, 'gain', 1, context);
    context.ops.push({
      opcode: DSP_OP.Input,
      out: output,
      a: gain,
      b: port === 'left' ? 0 : port === 'right' ? 1 : -1,
    });
    return emitBinary(DSP_OP.Mul, output, resolveInput(node, 'level', 0.7, context), context);
  }

  if (node.type === 'SamplePlayer') {
    return compileSamplePlayer(node, context);
  }

  if (node.type === 'Image') {
    let imageIndex = context.imageBindingIndexByNodeId.get(node.id);
    if (imageIndex === undefined) {
      imageIndex = context.imageBindings.length;
      context.imageBindingIndexByNodeId.set(node.id, imageIndex);
      context.imageBindings.push({
        nodeId: node.id,
        image: { name: node.image?.name ?? '', url: node.image?.url ?? '' },
      });
    }
    const channel = port === 'brightness' ? 0
      : port === 'r' ? 1
        : port === 'g' ? 2
          : port === 'b' ? 3
            : port === 'hue' ? 4
              : port === 'saturation' ? 5
                : -1;
    if (channel < 0) {
      context.errors.push(`Node "${node.id}" does not have supported output "${port}".`);
      return null;
    }
    const output = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.Image,
      out: output,
      a: resolveInput(node, 'x', 0.5, context),
      b: resolveInput(node, 'y', 0.5, context),
      c: channel,
      value: imageIndex,
    });
    return output;
  }

  if (node.type === 'Playhead') {
    const output = nextRegister(context);
    const state = nextState(context, 2);
    context.stateBindings.push({
      id: `${node.id}:playhead`,
      state,
      count: 2,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Playhead,
      out: output,
      a: resolveInput(node, 'start', 0, context),
      b: resolveInput(node, 'speed', 1, context),
      c: resolveInput(node, 'length', 1, context),
      e: resolveInput(node, 'reset trigger', 0, context),
      state,
    });
    return output;
  }

  if (node.type === 'Time') {
    const output = nextRegister(context);
    const state = nextState(context, 1);
    context.stateBindings.push({
      id: `${node.id}:time`,
      state,
      count: 1,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Time,
      out: output,
      state,
    });
    return output;
  }

  if (node.type === 'Freq2Length') {
    return emitBinary(
      DSP_OP.Div,
      constantRegister(1, context),
      resolveInput(node, 'frequency', 1, context),
      context,
    );
  }

  if (node.type === 'Length2Freq') {
    return emitBinary(
      DSP_OP.Div,
      constantRegister(1, context),
      resolveInput(node, 'length', 1, context),
      context,
    );
  }

  if (node.type === 'Buffer') {
    const output = nextRegister(context);
    const recordHeadOutput = nextRegister(context);
    const state = nextState(context, 7);
    const externallyDrivenHeads = (hasInput(node, 'playhead', context) ? 1 : 0)
      | (hasInput(node, 'record head', context) ? 2 : 0);
    context.bufferRecordHeadOutputByNodeId.set(node.id, recordHeadOutput);
    context.stateBindings.push({
      id: `${node.id}:buffer`,
      state,
      count: 7,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Buffer,
      out: output,
      a: resolveInput(node, 'signal', 0, context),
      b: resolveInput(node, 'playhead', 0, context),
      c: resolveInput(node, 'record head', 0, context),
      d: resolveInput(node, 'length', 1, context),
      e: recordHeadOutput,
      state,
      value: Math.round(node.params['on reset'] ?? 0),
      value2: resolveInput(node, 'playhead speed', 1, context),
      value3: resolveInput(node, 'record head speed', 1, context),
      value4: externallyDrivenHeads,
    });
    return output;
  }

  if (node.type === 'Multiply') {
    return emitBinary(
      DSP_OP.Mul,
      resolveInput(node, 'signal', 0, context),
      resolveInput(node, 'factor', 1, context),
      context,
    );
  }

  if (node.type === 'Pow') {
    return emitFunction(
      EXPRESSION_FUNCTIONS.pow.id,
      [
        resolveInput(node, 'signal', 0, context),
        resolveInput(node, 'exponent', 1, context),
      ],
      context,
    );
  }

  if (node.type === 'Fold') {
    const output = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.Fold,
      out: output,
      a: resolveInput(node, 'signal', 0, context),
      b: resolveInput(node, 'amount', 1, context),
    });
    return output;
  }

  if (node.type === 'Pan') {
    return compilePan(node, port, context);
  }

  if (node.type === 'Envelope') {
    const envelope = nextRegister(context);
    const state = nextState(context, 8);
    // Trigger and gate are event inputs, not editable node parameters. Older
    // patches can still contain saved values for them, so force an unconnected
    // port low instead of letting a stale value hold the envelope open.
    const trigger = hasInput(node, 'trigger', context)
      ? resolveInput(node, 'trigger', 0, context)
      : constantRegister(0, context);
    const gate = hasInput(node, 'gate', context)
      ? resolveInput(node, 'gate', 0, context)
      : constantRegister(0, context);
    const sustain = resolveInput(node, 'sustain', 0.72, context);
    const gateLength = resolveInput(node, 'gateLength', 0, context);
    const release = resolveInput(node, 'release', 0.24, context);
    context.stateBindings.push({
      id: `${node.id}:envelope`,
      state,
      count: 8,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Envelope,
      out: envelope,
      a: trigger,
      b: gate,
      c: resolveInput(node, 'delay', 0, context),
      d: resolveInput(node, 'attack', 0.01, context),
      e: resolveInput(node, 'decay', 0.16, context),
      state,
      value: packRegisterPair(sustain, release),
      value2: gateLength + 1,
    });
    // An Envelope also serves as a standalone modulation source. With no
    // signal connected, use a unit signal so its output is the envelope itself.
    const signal = hasInput(node, 'signal', context)
      ? resolveInput(node, 'signal', 0, context)
      : constantRegister(1, context);
    return emitBinary(DSP_OP.Mul, signal, envelope, context);
  }

  if (node.type === 'Follower') {
    const output = nextRegister(context);
    const state = nextState(context, 1);
    context.stateBindings.push({
      id: `${node.id}:follower`,
      state,
      count: 1,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Follower,
      out: output,
      a: resolveInput(node, 'signal', 0, context),
      b: resolveInput(node, 'attack', 0.01, context),
      c: resolveInput(node, 'release', 0.12, context),
      state,
    });
    return output;
  }

  if (node.type === 'RemoveDc') {
    const output = nextRegister(context);
    const state = nextState(context, 2);
    context.stateBindings.push({
      id: `${node.id}:dc-block`,
      state,
      count: 2,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.DcBlock,
      out: output,
      a: resolveInput(node, 'signal', 0, context),
      state,
    });
    return output;
  }

  const distortionType = DISTORTION_TYPES[node.type];
  if (distortionType !== undefined) {
    const output = nextRegister(context);
    const state = distortionType === 3 ? nextState(context, 1) : -1;
    context.ops.push({
      opcode: DSP_OP.Distortion,
      out: output,
      a: resolveInput(node, 'signal', 0, context),
      b: resolveInput(node, 'drive', 2.5, context),
      c: -1,
      state,
      value: distortionType,
    });
    return output;
  }

  if (node.type === 'Delay') {
    return compileEffect(node, DSP_OP.Delay, [
      ['time', 0.28],
      ['feedback', 0.35],
      ['mix', 0.25],
    ], context);
  }

  if (node.type === 'Chorus') {
    return compileEffect(node, DSP_OP.Chorus, [
      ['rate', 0.8],
      ['depth', 0.012],
      ['mix', 0.25],
    ], context);
  }

  if (node.type === 'Reverb') {
    return compileReverb(node, port, context);
  }

  if (node.type === 'Compress') {
    const output = nextRegister(context);
    const state = nextState(context, 1);
    const signal = resolveInput(node, 'signal', 0, context);
    const sidechain = hasInput(node, 'sidechain', context)
      ? resolveInput(node, 'sidechain', 0, context)
      : -1;
    const knee = resolveInput(node, 'knee', 6, context);
    const makeup = resolveInput(node, 'makeup', 0, context);
    context.stateBindings.push({
      id: `${node.id}:compressor`,
      state,
      count: 1,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Compress,
      out: output,
      a: signal,
      b: resolveInput(node, 'threshold', -24, context),
      c: resolveInput(node, 'ratio', 4, context),
      d: resolveInput(node, 'attack', 0.01, context),
      e: resolveInput(node, 'release', 0.1, context),
      state,
      value: packRegisterPair(knee, makeup),
      value2: sidechain,
    });
    return output;
  }

  if (node.type === 'Limiter') {
    const output = nextRegister(context);
    const state = nextState(context, 2);
    context.stateBindings.push({
      id: `${node.id}:limiter`,
      state,
      count: 2,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Limiter,
      out: output,
      a: resolveInput(node, 'signal', 0, context),
      b: resolveInput(node, 'inputGain', 0, context),
      c: resolveInput(node, 'ceiling', -1, context),
      d: resolveInput(node, 'release', 0.05, context),
      e: resolveInput(node, 'lookahead', 0.005, context),
      state,
    });
    return output;
  }

  if (node.type === 'Abs') {
    const output = nextRegister(context);
    context.ops.push({ opcode: DSP_OP.Abs, out: output, a: resolveInput(node, 'signal', 0, context) });
    return output;
  }

  if (node.type === 'Quantise') {
    const output = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.Quantise,
      out: output,
      a: resolveInput(node, 'signal', 0, context),
      b: resolveInput(node, 'scale', 0, context, 'immediate'),
      c: resolveInput(node, 'root', 0, context, 'immediate'),
    });
    return output;
  }

  if (node.type === 'Map') {
    const output = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.Map,
      out: output,
      a: resolveInput(node, 'signal', 0, context),
      b: resolveInput(node, 'srcMin', 0, context),
      c: resolveInput(node, 'srcMax', 1, context),
      d: resolveInput(node, 'trgtMin', 0, context),
      e: resolveInput(node, 'trgtMax', 1, context),
    });
    return output;
  }

  if (node.type === 'Clamp') {
    const output = nextRegister(context);
    context.ops.push({
      opcode: DSP_OP.Function,
      out: output,
      a: EXPRESSION_FUNCTIONS.clamp.id,
      b: resolveInput(node, 'signal', 0, context),
      c: resolveInput(node, 'min', 0, context),
      d: resolveInput(node, 'max', 1, context),
      value: 3,
    });
    return output;
  }

  if (node.type === 'Selector') {
    return compileSelector(node, context);
  }

  if (node.type === 'Accumulator') {
    const output = nextRegister(context);
    const state = nextState(context, 3);
    context.stateBindings.push({
      id: `${node.id}:accumulator`,
      state,
      count: 3,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Accumulator,
      out: output,
      a: resolveInput(node, 'trigger', 0, context),
      b: resolveInput(node, 'min', 0, context),
      c: resolveInput(node, 'max', 1, context),
      d: resolveInput(node, 'increment', 1, context),
      e: resolveInput(node, 'reset', 0, context),
      state,
      value: Math.round(node.params.mode ?? 0) === 1 ? 1 : 0,
    });
    return output;
  }

  if (node.type === 'Sequencer') {
    return compileSequencer(node, port, context);
  }

  if (node.type === 'Roll') {
    return compileRoll(node, port, context);
  }

  if (node.type === 'FormantFilter') {
    const output = nextRegister(context);
    const state = nextState(context, 12);
    context.stateBindings.push({
      id: `${node.id}:filter`,
      state,
      count: 12,
      kind: 'filter',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Filter,
      out: output,
      a: 4,
      b: resolveInput(node, 'signal', 0, context),
      c: resolveInput(node, 'morph', 0, context),
      d: resolveInput(node, 'intensity', 8, context),
      state,
    });
    return output;
  }

  if (node.type === 'Equalizer') {
    const output = nextRegister(context);
    const state = nextState(context, 12);
    context.stateBindings.push({
      id: `${node.id}:equalizer`,
      state,
      count: 12,
      kind: 'filter',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Filter,
      out: output,
      a: 7,
      b: resolveInput(node, 'signal', 0, context),
      c: resolveInput(node, 'lows', 0, context),
      d: resolveInput(node, 'mids', 0, context),
      e: resolveInput(node, 'highs', 0, context),
      state,
    });
    return output;
  }

  if (node.type === 'CombFilter' || node.type === 'CombNotchFilter') {
    const output = nextRegister(context);
    const state = nextState(context, 1);
    context.stateBindings.push({
      id: `${node.id}:comb`,
      state,
      count: 1,
      kind: 'effect',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Filter,
      out: output,
      a: node.type === 'CombFilter' ? 5 : 6,
      b: resolveInput(node, 'signal', 0, context),
      c: resolveInput(node, 'frequency', 440, context),
      d: resolveInput(node, 'feedback', 0.45, context),
      state,
    });
    return output;
  }

  const filterType = FILTER_TYPES[node.type];
  if (node.type === 'Crossover') {
    const slope = Math.max(12, Math.min(48, Math.round(finiteNumber(node.params.slope, 24) / 12) * 12));
    const stages = slope / 12;
    const bandMatch = /^band (\d+)$/.exec(port);
    if (!bandMatch) {
      context.errors.push(`Crossover node "${node.id}" does not have supported output "${port}".`);
      return null;
    }
    const band = Number(bandMatch[1]);
    const points = Math.max(1, Math.min(8, Math.round(finiteNumber(node.params.points, 1))));
    if (band < 1 || band > points + 1) return null;
    let signal = resolveInput(node, 'signal', 0, context);
    const applyBoundary = (boundary: number, lowPass: boolean): void => {
      const legacyFrequency = boundary === 1 ? finiteNumber(node.params.frequency, 1200) : 1200;
      const frequency = resolveInput(node, `frequency ${boundary}`, legacyFrequency, context);
      for (let stage = 0; stage < stages; stage += 1) {
        const output = nextRegister(context);
        const state = nextState(context, 4);
        context.stateBindings.push({
          id: `${node.id}:crossover:${boundary}:${lowPass ? 'low' : 'high'}:${stage}`,
          state,
          count: 4,
          kind: 'filter',
          nodeId: node.id,
        });
        // Butterworth section Q values produce an even, maximally-flat response
        // when the selected 12 dB/octave stages are cascaded.
        const q = 1 / (2 * Math.sin(((2 * stage + 1) * Math.PI) / (4 * stages)));
        context.ops.push({
          opcode: DSP_OP.Filter,
          out: output,
          a: lowPass ? 1 : 2,
          b: signal,
          c: frequency,
          d: constantRegister(q, context),
          state,
        });
        signal = output;
      }
    };
    if (band > 1) applyBoundary(band - 1, false);
    if (band <= points) applyBoundary(band, true);
    return signal;
  }

  if (filterType !== undefined) {
    const output = nextRegister(context);
    const state = nextState(context, 4);
    context.stateBindings.push({
      id: `${node.id}:filter`,
      state,
      count: 4,
      kind: 'filter',
      nodeId: node.id,
    });
    context.ops.push({
      opcode: DSP_OP.Filter,
      out: output,
      a: filterType,
      b: resolveInput(node, 'signal', 0, context),
      c: resolveInput(node, 'cutoff', 1200, context),
      d: resolveInput(node, 'resonance', 0.7, context),
      state,
    });
    return output;
  }

  if (node.type === 'Meter' || node.type === 'Scope') {
    const signal = resolveInput(node, 'signal', 0, context);
    context.monitorIds[node.id] = signal;
    if (node.type === 'Meter' && !context.signedMeterIds.includes(node.id)) {
      context.signedMeterIds.push(node.id);
    }
    return signal;
  }

  context.errors.push(`Node type "${node.type}" is not supported by the first DSP program slice.`);
  return null;
}

function ensureFftBinding(node: PatchNode, context: CompileContext): DspFftBinding {
  const existing = context.fftBindingByNodeId.get(node.id);
  if (existing) return existing;

  const inputRegister = resolveInput(node, 'signal', 0, context);
  const minFrequencyValueIndex = valueIndexForNodeParam(node, 'minFreq', 20, context);
  const maxFrequencyValueIndex = valueIndexForNodeParam(node, 'maxFreq', 20000, context);
  const frequencyValueIndex = valueIndex(0, {
    id: `${node.id}.frequency`,
    kind: 'analyser-output',
    nodeId: node.id,
    port: 'frequency',
  }, context);
  const amplitudeValueIndex = valueIndex(0, {
    id: `${node.id}.amplitude`,
    kind: 'analyser-output',
    nodeId: node.id,
    port: 'amplitude',
  }, context);
  const binding = {
    nodeId: node.id,
    inputRegister,
    minFrequencyValueIndex,
    maxFrequencyValueIndex,
    frequencyValueIndex,
    amplitudeValueIndex,
  };
  context.monitorIds[node.id] = inputRegister;
  context.fftBindings.push(binding);
  context.fftBindingByNodeId.set(node.id, binding);
  return binding;
}

function resolveSliderUnitValue(node: PatchNode, context: CompileContext): number {
  const cached = context.sliderUnitValueByNodeId.get(node.id);
  if (cached !== undefined) return cached;

  let register: number;
  if (hasInput(node, 'value', context)) {
    register = resolveInput(node, 'value', 0.5, context);
  } else {
    const valueIndex = valueIndexForNodeParam(node, 'value', 0.5, context);
    if (context.optimizationOptions.target !== 'fm1') {
      addMidiControlBinding(node, 'slider', valueIndex, context);
    }
    register = emitValue(valueIndex, context);
  }

  context.sliderUnitValueByNodeId.set(node.id, register);
  return register;
}

function registerSliderMonitor(node: PatchNode, context: CompileContext): void {
  context.monitorIds[node.id] = resolveSliderUnitValue(node, context);
}

function applySliderCurve(node: PatchNode, unitValue: number, context: CompileContext): number {
  // Preserve the linear slider path used by patches created before curves were
  // added. Besides avoiding needless per-sample work, this keeps a zero,
  // unlinked curve from consuming intermediate DSP registers.
  if (!hasInput(node, 'curve', context) && finiteNumber(node.params.curve, 0) === 0) {
    return unitValue;
  }

  const clampedUnitValue = emitFunction(
    EXPRESSION_FUNCTIONS.clamp.id,
    [unitValue, constantRegister(0, context), constantRegister(1, context)],
    context,
  );
  const curve = emitFunction(
    EXPRESSION_FUNCTIONS.clamp.id,
    [resolveInput(node, 'curve', 0, context), constantRegister(-8, context), constantRegister(8, context)],
    context,
  );
  const exponent = emitFunction(
    EXPRESSION_FUNCTIONS.pow.id,
    [constantRegister(2, context), emitBinary(DSP_OP.Neg, curve, constantRegister(0, context), context)],
    context,
  );
  return emitFunction(EXPRESSION_FUNCTIONS.pow.id, [clampedUnitValue, exponent], context);
}

function compileControlSignalOutput(
  node: PatchNode,
  port: string,
  value: number,
  hasSignal: boolean,
  hasInverseSignal: boolean,
  context: CompileContext,
): number {
  const inverseValue = emitBinary(DSP_OP.Sub, constantRegister(1, context), value, context);
  const mainWeight = port === 'inverse' ? inverseValue : value;
  const inverseWeight = port === 'inverse' ? value : inverseValue;
  const outputs: number[] = [];
  if (hasSignal) {
    outputs.push(emitBinary(DSP_OP.Mul, resolveInput(node, 'signal', 0, context), mainWeight, context));
  }
  if (hasInverseSignal) {
    outputs.push(emitBinary(DSP_OP.Mul, resolveInput(node, 'inverse signal', 0, context), inverseWeight, context));
  }
  return sumRegisters(outputs, context);
}

function resolveJoystickUnitValue(node: PatchNode, axis: 'x' | 'y', context: CompileContext): number {
  const key = `${node.id}:${axis}`;
  const cached = context.joystickUnitValueByAxis.get(key);
  if (cached !== undefined) return cached;

  const unitValueIndex = valueIndexForNodeParam(node, axis, 0.5, context);
  addMidiControlBinding(node, 'slider', unitValueIndex, context, {}, {
    channel: `${axis}MidiChannel`,
    cc: `${axis}MidiCc`,
  });
  const register = emitValue(unitValueIndex, context);
  context.joystickUnitValueByAxis.set(key, register);
  return register;
}

function resolveButtonGateOutput(node: PatchNode, context: CompileContext): number {
  const cached = context.buttonGateOutputByNodeId.get(node.id);
  if (cached !== undefined) return cached;

  if (context.optimizationOptions.target === 'fm1') {
    // UI/MIDI events are unavailable on the device. Keep the saved gate or
    // toggle state; trigger mode starts idle and must not replay saved clicks.
    const mode = Math.round(finiteNumber(node.params.mode, 0));
    const gate = mode !== 1 && finiteNumber(node.params.pressed, 0) >= 0.5 ? 1 : 0;
    const output = constantRegister(gate, context);
    context.buttonGateOutputByNodeId.set(node.id, output);
    return output;
  }

  const output = nextRegister(context);
  const state = nextState(context, 3);
  const pressedValueIndex = valueIndexForNodeParam(node, 'pressed', 0, context);
  const modeValueIndex = valueIndexForNodeParam(node, 'mode', 0, context);
  const clicksValueIndex = valueIndexForNodeParam(node, 'clicks', 0, context);
  addMidiControlBinding(node, 'button', pressedValueIndex, context, {
    modeValueIndex,
    clicksValueIndex,
  });
  context.stateBindings.push({
    id: `${node.id}:button`,
    state,
    count: 3,
    kind: 'effect',
    nodeId: node.id,
  });
  context.ops.push({
    opcode: DSP_OP.Button,
    out: output,
    a: pressedValueIndex,
    b: modeValueIndex,
    c: clicksValueIndex,
    state,
  });

  if (!hasInput(node, 'signal', context) && !hasInput(node, 'inverse signal', context)) {
    context.buttonGateOutputByNodeId.set(node.id, output);
    return output;
  }

  const smoothedOutput = nextRegister(context);
  const smoothingState = nextState(context, 2);
  context.stateBindings.push({
    id: `${node.id}:button-gate-slew`,
    state: smoothingState,
    count: 2,
    kind: 'effect',
    nodeId: node.id,
  });
  context.ops.push({
    opcode: DSP_OP.Slew,
    out: smoothedOutput,
    a: output,
    state: smoothingState,
    value: BUTTON_GATE_FADE_SECONDS,
    value2: 1,
  });
  context.buttonGateOutputByNodeId.set(node.id, smoothedOutput);
  return smoothedOutput;
}

function addMidiControlBinding(
  node: PatchNode,
  kind: DspMidiControlBinding['kind'],
  valueIndex: number,
  context: CompileContext,
  indexes: Pick<DspMidiControlBinding, 'modeValueIndex' | 'clicksValueIndex'> = {},
  ports: { channel: string; cc: string } = { channel: 'midiChannel', cc: 'midiCc' },
): void {
  const definition = getNodeDefinition(node);
  const channelDefault = definition.inputs.find((input) => input.name === ports.channel)?.defaultValue ?? 0;
  const ccDefault = definition.inputs.find((input) => input.name === ports.cc)?.defaultValue ?? 1;
  const channel = clampInteger(node.params[ports.channel] ?? channelDefault, 0, 16);
  const cc = clampInteger(node.params[ports.cc] ?? ccDefault, 0, 127);
  if (channel === 0) return;

  context.midiControlBindings.push({
    nodeId: node.id,
    kind,
    channel,
    cc,
    valueIndex,
    ...indexes,
  });
}

function compileTempo(node: PatchNode, port: string, context: CompileContext): number {
  const outputKind = tempoOutputKind(port);
  if (outputKind < 0) {
    context.errors.push(`Tempo node "${node.id}" does not have supported output "${port}".`);
    return constantRegister(0, context);
  }

  const output = nextRegister(context);
  const sourceValueIndex = valueIndexForNodeParam(node, 'source', 0, context);
  const midiSourceValueIndex = valueIndexForNodeParam(node, 'midiSource', 0, context);

  if (!context.tempoBindings.some((binding) => binding.nodeId === node.id)) {
    context.tempoBindings.push({
      nodeId: node.id,
      bpmValueIndex: valueIndexForNodeParam(node, 'bpm', 120, context),
      sourceValueIndex,
      midiSourceValueIndex,
    });
  }
  if (Math.round(node.params.source ?? 0) === 1) {
    context.usesMidiClock = true;
  }

  context.ops.push({
    opcode: DSP_OP.Tempo,
    out: output,
    a: resolveInput(node, 'bpm', 120, context),
    b: emitValue(sourceValueIndex, context),
    c: outputKind,
    d: emitValue(midiSourceValueIndex, context),
    e: resolveInput(node, 'swing', 0, context),
    state: -1,
  });
  return output;
}

const TEMPO_OUTPUT_LABELS = ['4 bar', '2 bar', 'bar', 'whole', 'half', 'quarter / beat', 'upbeat', 'eighth', 'sixteenth', 'thirty-second'] as const;

function tempoOutputKind(port: string): number {
  const clickIndex = TEMPO_OUTPUT_LABELS.indexOf(port as typeof TEMPO_OUTPUT_LABELS[number]);
  if (clickIndex >= 0) return clickIndex;
  const freqIndex = TEMPO_OUTPUT_LABELS.indexOf(port.replace(/ freq$/, '') as typeof TEMPO_OUTPUT_LABELS[number]);
  return freqIndex >= 0 && port.endsWith(' freq') ? freqIndex + TEMPO_OUTPUT_LABELS.length : -1;
}

function compileSamplePlayer(node: PatchNode, context: CompileContext): number {
  const sampleIndex = context.sampleBindings.length;
  context.sampleBindings.push({
    nodeId: node.id,
    sample: {
      name: node.sample?.name ?? '',
      url: node.sample?.url ?? '',
    },
    release: Math.max(0, Number(node.params.release) || 0),
  });

  const state = nextState(context, 1);
  context.stateBindings.push({
    id: `${node.id}:sample`,
    state,
    count: 1,
    kind: 'effect',
    nodeId: node.id,
  });

  const originalFrequency = resolveSampleOriginalFrequency(node, context);
  const sampleParams: Array<[kind: number, port: string | null, fallback: number, register?: number]> = [
    [0, 'mode', 0],
    [1, 'start', 0],
    [2, 'end', 1],
    [3, 'attack', 0],
    [4, 'release', 0],
    [5, 'stretch', 1],
    [6, 'cycleLength', 4096],
    [7, 'overlapRatio', 0.09],
    [8, null, 440, originalFrequency],
  ];
  for (const [kind, port, fallback, register] of sampleParams) {
    const inputRegister = register ?? resolveInput(node, port ?? '', fallback, context);
    context.ops.push({
      opcode: DSP_OP.SampleParam,
      a: sampleIndex,
      b: kind,
      c: inputRegister,
    });
    if (
      (port === 'start' || port === 'end' || port === 'attack' || port === 'release')
      && hasInput(node, port, context)
    ) {
      const monitorId = `${node.id}:sample-${port}`;
      context.monitorIds[monitorId] = inputRegister;
      context.signedMeterIds.push(monitorId);
    }
  }

  const output = nextRegister(context);
  context.ops.push({
    opcode: DSP_OP.Sample,
    out: output,
    a: sampleIndex,
    b: resolveInput(node, 'frequency', 220, context),
    c: resolveInput(node, 'trigger', 0, context),
    d: resolveInput(node, 'voices', 1, context),
    e: resolveInput(node, 'level', 0.7, context),
    state,
    value2: node.sample?.name?.toLowerCase().endsWith('.mp4')
      || /\.mp4(?:$|[?#])/i.test(node.sample?.url ?? '') ? 1 : 0,
  });
  return output;
}

function resolveSampleOriginalFrequency(node: PatchNode, context: CompileContext): number {
  if (node.params.originalFrequency !== undefined || node.inputs?.some((input) => input.name === 'originalFrequency')) {
    return resolveInput(node, 'originalFrequency', 440, context);
  }

  const originalPitch = node.params.originalPitch;
  if (originalPitch !== undefined) {
    return constantRegister(midiNoteFrequency(originalPitch), context);
  }

  return constantRegister(440, context);
}

function midiNoteFrequency(note: number): number {
  return 440 * (2 ** ((note - 69) / 12));
}

function compileSelector(node: PatchNode, context: CompileContext): number {
  const definition = getNodeDefinition(node);
  const valueInputs = definition.inputs
    .filter((input) => /^[1-9][0-9]*$/.test(input.name))
    .sort((left, right) => Number(left.name) - Number(right.name));
  if (valueInputs.length === 0) return constantRegister(0, context);

  // A selector index is categorical. Updating it must not pass through the
  // intervening numeric indices, because they can refer to unrelated values.
  const select = resolveInput(node, 'select', 0, context, 'immediate');
  const slide = resolveInput(node, 'slide', 0, context);
  const output = nextRegister(context);
  const state = nextState(context, 4);
  const maxInputIndex = Math.max(...valueInputs.map((input) => Number(input.name)));
  context.stateBindings.push({
    id: `${node.id}:selector`,
    state,
    count: 4,
    kind: 'selector',
    nodeId: node.id,
  });

  valueInputs.forEach((input) => {
    context.ops.push({
      opcode: DSP_OP.Select,
      out: output,
      a: select,
      b: slide,
      c: resolveInput(node, input.name, input.defaultValue ?? 0, context),
      d: Number(input.name),
      e: maxInputIndex,
      state,
    });
  });
  return output;
}

function compileSequencer(node: PatchNode, port: string, context: CompileContext): number {
  if (port === SEQUENCER_INDEX_OUTPUT) {
    return compileSequencerIndex(node, context);
  }

  const rowIndex = sequencerOutputIndex(port);
  if (rowIndex === null) {
    context.errors.push(`Sequencer node "${node.id}" does not have supported output "${port}".`);
    return constantRegister(0, context);
  }

  return compileSequencerRow(node, rowIndex, context);
}

function compileRoll(node: PatchNode, port: string, context: CompileContext): number {
  if (!['note', 'frequency', 'velocity', 'gate', 'trigger', 'note on', 'note off'].includes(port)) {
    context.errors.push(`Roll node "${node.id}" does not have supported output "${port}".`);
    return constantRegister(0, context);
  }
  const shape = rollShape(node.params);
  if (port === 'note on' || port === 'note off' || port === 'frequency' || port === 'velocity' || port === 'trigger') {
    const event = port === 'note off' ? 'off' : 'on';
    const value = port === 'frequency' ? 'frequency' : port === 'velocity' ? 'velocity' : 'note';
    return compileRollNoteEvent(node, event, value, context);
  }
  const rowGates = Array.from({ length: shape.rows.length }, (_, row) => compileSequencerRow(node, row, context));
  const gate = emitFunction(EXPRESSION_FUNCTIONS.clamp.id, [
    rowGates.reduce((sum, rowGate) => emitBinary(DSP_OP.Add, sum, rowGate, context), constantRegister(0, context)),
    constantRegister(0, context),
    constantRegister(1, context),
  ], context);
  if (port === 'gate') return gate;

  // In mono mode, the highest active note is selected. Poly mode retains all
  // gates/triggers, while this scalar pitch output reports the highest voice.
  let note = constantRegister(0, context);
  for (let row = 0; row < shape.rows.length; row += 1) {
    const noteValue = constantRegister(shape.rows[row].note, context);
    note = emitBinary(DSP_OP.Add, emitBinary(DSP_OP.Mul, rowGates[row], noteValue, context), emitBinary(DSP_OP.Mul, emitBinary(DSP_OP.Sub, constantRegister(1, context), rowGates[row], context), note, context), context);
  }
  if (port === 'note') return note;
  const exponent = emitBinary(DSP_OP.Div, emitBinary(DSP_OP.Sub, note, constantRegister(69, context), context), constantRegister(12, context), context);
  return emitBinary(DSP_OP.Mul, constantRegister(440, context), emitFunction(EXPRESSION_FUNCTIONS.pow.id, [constantRegister(2, context), exponent], context), context);
}

/**
 * Emits one aligned field of Roll's queued note-event bundle. A zero frame is
 * inserted between events so Spawn and Sample & Hold can treat every chord
 * note as a distinct event while retaining its matching frequency/velocity.
 */
function compileRollNoteEvent(
  node: PatchNode,
  event: 'on' | 'off',
  value: 'note' | 'frequency' | 'velocity',
  context: CompileContext,
): number {
  const output = nextRegister(context);
  // Note-off additionally remembers the note originally emitted by every
  // relative Roll row, so a later scale/range/middle edit cannot release a
  // different Spawn tag.
  const stateCount = 5 + ROLL_MAX_ROWS * (event === 'off' ? 3 : 2);
  const state = nextState(context, stateCount);
  context.stateBindings.push({
    id: `${node.id}:roll-note-${event}-${value}`,
    state,
    count: stateCount,
    kind: 'effect',
    nodeId: node.id,
  });
  context.ops.push({
    opcode: DSP_OP.RollNoteEvent,
    out: output,
    a: ensureSequencerStepRegister(node, context).state,
    state,
    value: ensureSequencerBinding(node, context),
    value2: event === 'on' ? 0 : 1,
    value3: value === 'note' ? 0 : value === 'frequency' ? 1 : 2,
  });
  return output;
}

function compileSequencerIndex(node: PatchNode, context: CompileContext): number {
  const shape = sequencerShape(node.params);
  let index = constantRegister(0, context);
  let noEarlierTrigger = constantRegister(1, context);

  for (let rowIndex = 0; rowIndex < shape.rows; rowIndex += 1) {
    const trigger = compileSequencerRow(node, rowIndex, context);
    const selectedTrigger = emitBinary(DSP_OP.Mul, trigger, noEarlierTrigger, context);
    index = emitBinary(
      DSP_OP.Add,
      index,
      emitBinary(DSP_OP.Mul, selectedTrigger, constantRegister(rowIndex + 1, context), context),
      context,
    );
    noEarlierTrigger = emitBinary(
      DSP_OP.Mul,
      noEarlierTrigger,
      emitBinary(DSP_OP.Sub, constantRegister(1, context), trigger, context),
      context,
    );
  }

  return index;
}

function compileSequencerRow(node: PatchNode, rowIndex: number, context: CompileContext): number {
  const state = ensureSequencerStepRegister(node, context).state;
  const output = nextRegister(context);
  context.ops.push({
    opcode: DSP_OP.Sequencer,
    out: output,
    a: resolveInput(node, 'signal', 0, context),
    b: resolveInput(node, 'steps', SEQUENCER_DEFAULT_STEPS, context),
    c: constantRegister(rowIndex, context),
    d: node.type === 'Roll' ? constantRegister(rollShape(node.params).rows.length, context) : resolveInput(node, 'rows', SEQUENCER_DEFAULT_ROWS, context),
    e: resolveInput(node, 'reset', 0, context),
    state,
    value: ensureSequencerBinding(node, context),
  });
  return output;
}

function registerSequencerMonitor(node: PatchNode, context: CompileContext): void {
  ensureSequencerStepRegister(node, context);
}

function ensureSequencerStepRegister(node: PatchNode, context: CompileContext): { state: number; register: number } {
  let state = context.sequencerStateByNodeId.get(node.id);
  if (state === undefined) {
    state = nextState(context, 8);
    context.sequencerStateByNodeId.set(node.id, state);
    context.stateBindings.push({
      id: `${node.id}:sequencer`,
      state,
      count: 8,
      kind: 'sequencer',
      nodeId: node.id,
    });
  }

  let register = context.sequencerStepRegisterByNodeId.get(node.id);
  if (register === undefined) {
    register = nextRegister(context);
    context.sequencerStepRegisterByNodeId.set(node.id, register);
    context.monitorIds[node.id] = register;
    context.ops.push({
      opcode: DSP_OP.Sequencer,
      out: register,
      a: resolveInput(node, 'signal', 0, context),
      b: resolveInput(node, 'steps', SEQUENCER_DEFAULT_STEPS, context),
      c: constantRegister(-1, context),
      d: node.type === 'Roll' ? constantRegister(rollShape(node.params).rows.length, context) : resolveInput(node, 'rows', SEQUENCER_DEFAULT_ROWS, context),
      e: resolveInput(node, 'reset', 0, context),
      state,
      value: ensureSequencerBinding(node, context),
    });
  }

  return { state, register };
}

function ensureSequencerBinding(node: PatchNode, context: CompileContext): number {
  const existing = context.sequencerBindingIndexByNodeId.get(node.id);
  if (existing !== undefined) return existing;

  const roll = node.type === 'Roll' ? rollShape(node.params) : null;
  const shape = roll ? { ...roll, rowCount: roll.rows.length } : { ...sequencerShape(node.params), rowCount: sequencerShape(node.params).rows };
  const gateMode = node.type === 'Roll' || sequencerUsesGateMode(node.params);
  const events = Array.from({ length: shape.rowCount }, (_, rowIndex) => {
    const activeEvents = node.type === 'Roll'
      ? rollGatesForRow(node.params, roll!.rows[rowIndex].index, shape.steps)
        .map((gate) => ({ ...gate }))
      : gateMode
      ? sequencerGatesForRow(node.params, rowIndex, shape.steps)
        .map((gate) => ({ slot: gate.slot, start: gate.start, end: gate.end, velocity: gate.velocity }))
      : sequencerTriggersForRow(node.params, rowIndex, shape.steps)
        .map((trigger) => ({
          slot: trigger.slot,
          start: trigger.position,
          end: trigger.position,
          velocity: trigger.velocity,
        }));
    const eventsBySlot = new Map(activeEvents.map((event) => [event.slot, event]));
    return Array.from({ length: shape.steps }, (_, slot) => {
      const event = eventsBySlot.get(slot);
      return {
        active: Boolean(event),
        start: event?.start ?? slot,
        end: event?.end ?? slot,
        velocity: event?.velocity ?? 1,
        note: roll?.rows[rowIndex].note ?? rowIndex,
      };
    });
  });
  const bindingIndex = context.sequencerBindings.length;
  context.sequencerBindings.push({
    nodeId: node.id,
    mode: gateMode ? 'gate' : 'trigger',
    steps: shape.steps,
    rows: shape.rowCount,
    events,
  });
  context.sequencerBindingIndexByNodeId.set(node.id, bindingIndex);
  return bindingIndex;
}

function compilePan(node: PatchNode, port: string, context: CompileContext): number {
  if (port !== 'left' && port !== 'right') {
    context.errors.push(`Pan node "${node.id}" does not have supported output "${port}".`);
    return constantRegister(0, context);
  }

  const signal = resolveInput(node, 'signal', 0, context);
  const pan = emitFunction(
    EXPRESSION_FUNCTIONS.clamp.id,
    [
      resolveInput(node, 'pan', 0, context),
      constantRegister(-1, context),
      constantRegister(1, context),
    ],
    context,
  );
  const panned = port === 'left'
    ? emitBinary(DSP_OP.Sub, constantRegister(1, context), pan, context)
    : emitBinary(DSP_OP.Add, constantRegister(1, context), pan, context);
  const gain = emitFunction(
    EXPRESSION_FUNCTIONS.sqrt.id,
    [emitBinary(DSP_OP.Mul, panned, constantRegister(0.5, context), context)],
    context,
  );
  return emitBinary(DSP_OP.Mul, signal, gain, context);
}

function midiNoteOutputKind(type: 'MidiNote' | 'MidiNoteOn' | 'MidiNoteOff', port: string): number {
  if (type === 'MidiNoteOn') {
    if (port === 'frequency') return 6;
    if (port === 'velocity') return 7;
    return 5;
  }
  if (type === 'MidiNoteOff') {
    return port === 'frequency' ? 9 : 8;
  }
  switch (port) {
    case 'note':
      return 0;
    case 'frequency':
      return 1;
    case 'velocity':
      return 2;
    case 'gate':
      return 3;
    case 'trigger':
      return 4;
    default:
      return 0;
  }
}

function compileEffect(
  node: PatchNode,
  opcode: number,
  params: Array<[port: string, fallback: number]>,
  context: CompileContext,
): number {
  const output = nextRegister(context);
  const state = nextState(context, 1);
  context.stateBindings.push({
    id: `${node.id}:effect`,
    state,
    count: 1,
    kind: 'effect',
    nodeId: node.id,
  });
  context.ops.push({
    opcode,
    out: output,
    a: resolveInput(node, 'signal', 0, context),
    b: resolveInput(node, params[0]?.[0] ?? 'unused', params[0]?.[1] ?? 0, context),
    c: resolveInput(node, params[1]?.[0] ?? 'unused', params[1]?.[1] ?? 0, context),
    d: resolveInput(node, params[2]?.[0] ?? 'unused', params[2]?.[1] ?? 0, context),
    state,
  });
  return output;
}

function compileReverb(node: PatchNode, port: string, context: CompileContext): number {
  if (port !== 'left' && port !== 'right') {
    context.errors.push(`Reverb node "${node.id}" does not have supported output "${port}".`);
    return constantRegister(0, context);
  }

  const cached = context.outputCache.get(inputKey(node.id, port));
  if (cached !== undefined) return cached;

  const left = nextRegister(context);
  const right = nextRegister(context);
  const state = nextState(context, 64);
  context.stateBindings.push({ id: `${node.id}:effect`, state, count: 64, kind: 'effect', nodeId: node.id });
  context.ops.push({
    opcode: DSP_OP.Reverb,
    out: left,
    e: right,
    a: resolveInput(node, 'signal', 0, context),
    b: resolveInput(node, 'size', 0.55, context),
    c: resolveInput(node, 'decay', 0.45, context),
    d: resolveInput(node, 'mix', 0.25, context),
    // Zero retains the legacy single-output bytecode format.
    value2: valueRegisterForNodeParam(node, 'mode', 0, context, 'immediate') + 1,
    state,
  });
  context.outputCache.set(inputKey(node.id, 'left'), left);
  context.outputCache.set(inputKey(node.id, 'right'), right);
  return port === 'left' ? left : right;
}

type ExpressionToken =
  | { type: 'number'; value: number }
  | { type: 'identifier'; value: string }
  | {
      type: 'operator';
      value:
        | '+' | '-' | '*' | '/'
        | '<' | '<=' | '>' | '>=' | '==' | '!='
        | '&&' | '||' | '!'
        | '(' | ')' | ',';
    }
  | { type: 'invalid'; value: string };

function compileExpression(node: PatchNode, context: CompileContext): number {
  const source = typeof node.expression === 'string' && node.expression.trim()
    ? node.expression
    : '0';
  const parser = new ExpressionParser(tokenizeExpression(source), node, context);
  return parser.parse();
}

class ExpressionParser {
  private index = 0;

  constructor(
    private readonly tokens: ExpressionToken[],
    private readonly node: PatchNode,
    private readonly context: CompileContext,
  ) {}

  parse(): number {
    const register = this.parseLogicalOr();
    if (!this.isAtEnd()) {
      this.context.errors.push(`Expression node "${this.node.id}" has unsupported syntax near "${this.peekLabel()}".`);
      return constantRegister(0, this.context);
    }
    return register;
  }

  private parseLogicalOr(): number {
    let left = this.parseLogicalAnd();
    while (this.matchOperator('||')) {
      left = this.emitLogicFunction(EXPRESSION_LOGIC_FUNCTIONS.or, left, this.parseLogicalAnd());
    }
    return left;
  }

  private parseLogicalAnd(): number {
    let left = this.parseEquality();
    while (this.matchOperator('&&')) {
      left = this.emitLogicFunction(EXPRESSION_LOGIC_FUNCTIONS.and, left, this.parseEquality());
    }
    return left;
  }

  private parseEquality(): number {
    let left = this.parseComparison();
    while (this.matchOperator('==') || this.matchOperator('!=')) {
      const operator = this.previous().value;
      const right = this.parseComparison();
      left = this.emitLogicFunction(
        operator === '==' ? EXPRESSION_LOGIC_FUNCTIONS.equal : EXPRESSION_LOGIC_FUNCTIONS.notEqual,
        left,
        right,
      );
    }
    return left;
  }

  private parseComparison(): number {
    let left = this.parseAdditive();
    while (
      this.matchOperator('<')
      || this.matchOperator('<=')
      || this.matchOperator('>')
      || this.matchOperator('>=')
    ) {
      const operator = this.previous().value;
      const right = this.parseAdditive();
      const functionId = operator === '<'
        ? EXPRESSION_LOGIC_FUNCTIONS.less
        : operator === '<='
          ? EXPRESSION_LOGIC_FUNCTIONS.lessEqual
          : operator === '>'
            ? EXPRESSION_LOGIC_FUNCTIONS.greater
            : EXPRESSION_LOGIC_FUNCTIONS.greaterEqual;
      left = this.emitLogicFunction(functionId, left, right);
    }
    return left;
  }

  private parseAdditive(): number {
    let left = this.parseMultiplicative();
    while (this.matchOperator('+') || this.matchOperator('-')) {
      const operator = this.previous().value;
      const right = this.parseMultiplicative();
      left = emitBinary(operator === '+' ? DSP_OP.Add : DSP_OP.Sub, left, right, this.context);
    }
    return left;
  }

  private parseMultiplicative(): number {
    let left = this.parseUnary();
    while (this.matchOperator('*') || this.matchOperator('/')) {
      const operator = this.previous().value;
      const right = this.parseUnary();
      left = emitBinary(operator === '*' ? DSP_OP.Mul : DSP_OP.Div, left, right, this.context);
    }
    return left;
  }

  private parseUnary(): number {
    if (this.matchOperator('!')) {
      return this.emitLogicFunction(EXPRESSION_LOGIC_FUNCTIONS.not, this.parseUnary());
    }
    if (this.matchOperator('-')) {
      const output = nextRegister(this.context);
      this.context.ops.push({ opcode: DSP_OP.Neg, out: output, a: this.parseUnary() });
      return output;
    }
    if (this.matchOperator('+')) {
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    if (this.match('number')) {
      const token = this.previous();
      return constantRegister(token.type === 'number' ? token.value : 0, this.context);
    }
    if (this.match('identifier')) {
      const token = this.previous();
      const name = token.type === 'identifier' ? token.value : '';
      if (this.matchOperator('(')) {
        return this.parseFunctionCall(name);
      }
      if (name === 'true') return constantRegister(1, this.context);
      if (name === 'false') return constantRegister(0, this.context);
      return resolveInput(this.node, name, 0, this.context);
    }
    if (this.matchOperator('(')) {
      const register = this.parseLogicalOr();
      if (!this.matchOperator(')')) {
        this.context.errors.push(`Expression node "${this.node.id}" is missing a closing parenthesis.`);
        return constantRegister(0, this.context);
      }
      return register;
    }

    this.context.errors.push(`Expression node "${this.node.id}" has unsupported syntax near "${this.peekLabel()}".`);
    this.advance();
    return constantRegister(0, this.context);
  }

  private parseFunctionCall(name: string): number {
    const args: number[] = [];
    if (!this.matchOperator(')')) {
      do {
        args.push(this.parseLogicalOr());
        if (this.matchOperator(')')) break;
        if (!this.matchOperator(',')) {
          this.context.errors.push(`Expression node "${this.node.id}" is missing a comma or closing parenthesis in "${name}(...)"`);
          return constantRegister(0, this.context);
        }
      } while (!this.isAtEnd());
    }

    const definition = EXPRESSION_FUNCTIONS[name.toLowerCase()];
    if (!definition) {
      this.context.errors.push(`Expression node "${this.node.id}" uses unsupported function "${name}".`);
      return constantRegister(0, this.context);
    }
    if (args.length < definition.minArgs || args.length > definition.maxArgs) {
      this.context.errors.push(`Expression function "${name}" expects ${arityLabel(definition.minArgs, definition.maxArgs)}.`);
      return constantRegister(0, this.context);
    }

    const paddedArgs = [...args];
    while (paddedArgs.length < 3) paddedArgs.push(constantRegister(0, this.context));
    const output = nextRegister(this.context);
    this.context.ops.push({
      opcode: DSP_OP.Function,
      out: output,
      a: definition.id,
      b: paddedArgs[0],
      c: paddedArgs[1],
      d: paddedArgs[2],
      value: args.length,
    });
    return output;
  }

  private emitLogicFunction(functionId: number, left: number, right?: number): number {
    const output = nextRegister(this.context);
    this.context.ops.push({
      opcode: DSP_OP.Function,
      out: output,
      a: functionId,
      b: left,
      c: right ?? constantRegister(0, this.context),
      d: constantRegister(0, this.context),
      value: right === undefined ? 1 : 2,
    });
    return output;
  }

  private match(type: ExpressionToken['type']): boolean {
    if (this.isAtEnd() || this.peek().type !== type) return false;
    this.advance();
    return true;
  }

  private matchOperator(value: Extract<ExpressionToken, { type: 'operator' }>['value']): boolean {
    if (this.isAtEnd()) return false;
    const token = this.peek();
    if (token.type !== 'operator' || token.value !== value) return false;
    this.advance();
    return true;
  }

  private advance(): ExpressionToken {
    if (!this.isAtEnd()) this.index += 1;
    return this.previous();
  }

  private previous(): ExpressionToken {
    return this.tokens[Math.max(0, this.index - 1)] ?? { type: 'number', value: 0 };
  }

  private peek(): ExpressionToken {
    return this.tokens[this.index] ?? { type: 'number', value: 0 };
  }

  private peekLabel(): string {
    const token = this.tokens[this.index];
    return token ? String(token.value) : 'end of expression';
  }

  private isAtEnd(): boolean {
    return this.index >= this.tokens.length;
  }
}

function tokenizeExpression(source: string): ExpressionToken[] {
  const tokens: ExpressionToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    const compoundOperator = source.slice(index, index + 2);
    if (['<=', '>=', '==', '!=', '&&', '||'].includes(compoundOperator)) {
      tokens.push({
        type: 'operator',
        value: compoundOperator as Extract<ExpressionToken, { type: 'operator' }>['value'],
      });
      index += 2;
      continue;
    }

    if (/[+\-*/(),<>!]/.test(char)) {
      tokens.push({ type: 'operator', value: char as Extract<ExpressionToken, { type: 'operator' }>['value'] });
      index += 1;
      continue;
    }

    const numberMatch = source.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);
    if (numberMatch) {
      tokens.push({ type: 'number', value: finiteNumber(Number(numberMatch[0]), 0) });
      index += numberMatch[0].length;
      continue;
    }

    const identifierMatch = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (identifierMatch) {
      tokens.push({ type: 'identifier', value: identifierMatch[0] });
      index += identifierMatch[0].length;
      continue;
    }

    tokens.push({ type: 'invalid', value: char });
    index += 1;
  }

  return tokens;
}

function arityLabel(minArgs: number, maxArgs: number): string {
  if (minArgs === maxArgs) return `${minArgs} argument${minArgs === 1 ? '' : 's'}`;
  return `${minArgs}-${maxArgs} arguments`;
}

function averageRegisters(registers: number[], context: CompileContext): number {
  if (registers.length === 1) return registers[0];
  let sum = registers[0];
  for (const register of registers.slice(1)) {
    sum = emitBinary(DSP_OP.Add, sum, register, context);
  }
  return emitBinary(DSP_OP.Mul, sum, constantRegister(1 / registers.length, context), context);
}

function sumRegisters(registers: number[], context: CompileContext): number {
  if (registers.length === 0) return constantRegister(0, context);
  if (registers.length === 1) return registers[0];
  let sum = registers[0];
  for (const register of registers.slice(1)) {
    sum = emitBinary(DSP_OP.Add, sum, register, context);
  }
  return sum;
}

function emitBinary(opcode: number, a: number, b: number, context: CompileContext): number {
  const out = nextRegister(context);
  context.ops.push({ opcode, out, a, b });
  return out;
}

function emitUnary(opcode: number, a: number, context: CompileContext): number {
  const out = nextRegister(context);
  context.ops.push({
    opcode,
    out,
    a,
    b: -1,
    c: -1,
    d: -1,
    e: -1,
    state: -1,
    value: 0,
    value2: 0,
    value3: 0,
    value4: 0,
  });
  return out;
}

function emitFunction(functionId: number, args: number[], context: CompileContext): number {
  const paddedArgs = [...args];
  while (paddedArgs.length < 3) paddedArgs.push(constantRegister(0, context));
  const output = nextRegister(context);
  context.ops.push({
    opcode: DSP_OP.Function,
    out: output,
    a: functionId,
    b: paddedArgs[0],
    c: paddedArgs[1],
    d: paddedArgs[2],
    value: args.length,
  });
  return output;
}

function valueRegisterForNodeParam(
  node: PatchNode,
  port: string,
  fallback: number,
  context: CompileContext,
  mode: 'smoothed' | 'immediate' = 'smoothed',
): number {
  return emitValue(valueIndexForNodeParam(node, port, fallback, context), context, mode);
}

function valueIndexForNodeParam(
  node: PatchNode,
  port: string,
  fallback: number,
  context: CompileContext,
): number {
  const definition = getNodeDefinition(node);
  const input = definition.inputs.find((candidate) => candidate.name === port);
  const value = finiteNumber(node.params[port], input?.defaultValue ?? fallback);
  return valueIndex(value, {
    id: `${node.id}.${port}`,
    kind: 'node-param',
    nodeId: node.id,
    port,
  }, context);
}

function valueRegisterForLinkWeight(link: PatchLink, context: CompileContext): number {
  const id = linkId(link);
  return valueRegister(finiteNumber(link.weight, 1), {
    id: `${id}.weight`,
    kind: 'link-weight',
    linkId: id,
  }, context);
}

function constantRegister(value: number, context: CompileContext): number {
  const normalized = finiteNumber(value, 0);
  const existingIndex = context.constantValueIndexes.get(normalized);
  if (existingIndex !== undefined) return emitValue(existingIndex, context);

  const valueIndex = context.values.length;
  context.constantValueIndexes.set(normalized, valueIndex);
  context.values.push(normalized);
  context.valueBindings.push({
    id: `constant.${normalized}`,
    valueIndex,
    kind: 'constant',
  });
  return emitValue(valueIndex, context);
}

function valueRegister(
  value: number,
  binding: Omit<DspValueBinding, 'valueIndex'>,
  context: CompileContext,
): number {
  return emitValue(valueIndex(value, binding, context), context);
}

function valueIndex(
  value: number,
  binding: Omit<DspValueBinding, 'valueIndex'>,
  context: CompileContext,
): number {
  const valueIndex = context.values.length;
  context.values.push(value);
  context.valueBindings.push({ ...binding, valueIndex });
  return valueIndex;
}

function emitValue(
  valueIndex: number,
  context: CompileContext,
  mode: 'smoothed' | 'immediate' = 'smoothed',
): number {
  const isConstant = context.valueBindings[valueIndex]?.kind === 'constant';
  const cacheKey = `${valueIndex}:${mode}`;
  if (isConstant && context.optimizationOptions.deduplicateLoads !== false) {
    const existing = context.constantRegisters.get(cacheKey);
    if (existing !== undefined) {
      context.deduplicatedLoads += 1;
      return existing;
    }
  }
  const out = nextRegister(context);
  context.ops.push({
    opcode: DSP_OP.Value,
    out,
    a: valueIndex,
    value: mode === 'immediate' ? 1 : 0,
  });
  if (isConstant && context.optimizationOptions.deduplicateLoads !== false) context.constantRegisters.set(cacheKey, out);
  return out;
}

function packRegisterPair(left: number, right: number): number {
  return left + right * MAX_DSP_REGISTERS;
}

function nextRegister(context: CompileContext): number {
  const register = context.registerCount;
  context.registerCount += 1;
  return register;
}

function nextState(context: CompileContext, count: number): number {
  const state = context.stateCount;
  context.stateCount += count;
  return state;
}

function dspOpUsesEffectBuffer(op: DspOp): boolean {
  return op.opcode === DSP_OP.Delay
    || op.opcode === DSP_OP.Chorus
    || op.opcode === DSP_OP.Reverb
    || op.opcode === DSP_OP.Limiter
    || (op.opcode === DSP_OP.Filter && (op.a === 5 || op.a === 6));
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function routingNumber(node: PatchNode): number {
  return Math.max(1, Math.min(10, Math.round(finiteNumber(node.params.number, 1))));
}

function routingNodesShareRuntime(receive: PatchNode, send: PatchNode): boolean {
  if ((receive.routingScope ?? '') !== (send.routingScope ?? '')) return false;
  if (!receive.runtimeSpread) return !send.runtimeSpread;
  if (!send.runtimeSpread) return true;
  return receive.runtimeSpread.spreadId === send.runtimeSpread.spreadId
    && receive.runtimeSpread.itemIndex === send.runtimeSpread.itemIndex;
}

function resolveSendSignal(node: PatchNode, context: CompileContext): number {
  const cached = context.sendSignalByNodeId.get(node.id);
  if (cached !== undefined) return cached;
  const signal = resolveInput(node, 'signal', 0, context);
  context.sendSignalByNodeId.set(node.id, signal);
  return signal;
}

function clampInteger(value: unknown, min: number, max: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return min;
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}

function inputKey(nodeId: string, port: string): string {
  return `${nodeId}.${port}`;
}

function linkId(link: PatchLink): string {
  return `${link.from.node}:${link.from.port}->${link.to.node}:${link.to.port}`;
}
