import type { NodeDefinition, NodeType, PatchNode, PortDefinition } from './types';
import { QUANTISE_SCALES } from './musicScales';

export const SEQUENCER_MIN_STEPS = 1;
export const SEQUENCER_MAX_STEPS = 128;
export const SEQUENCER_DEFAULT_STEPS = 16;
export const SEQUENCER_MIN_ROWS = 1;
export const SEQUENCER_MAX_ROWS = 16;
export const SEQUENCER_DEFAULT_ROWS = 4;
export const SEQUENCER_MIN_BEAT_LENGTH = 1;
export const SEQUENCER_DEFAULT_BEAT_LENGTH = 4;
export const SEQUENCER_INDEX_OUTPUT = 'trigger index';
export const ROLL_ROWS = 12;
export const ROLL_MAX_ROWS = 128;
export const ROLL_DEFAULT_START_NOTE = 60;

export const NODE_DEFINITIONS: Record<NodeType, NodeDefinition> = {
  Expression: {
    type: 'Expression',
    inputs: [],
    outputs: [{ name: 'value' }],
  },
  Group: {
    type: 'Group',
    inputs: [],
    outputs: [],
  },
  Spread: {
    type: 'Spread',
    inputs: [{ name: 'count', defaultValue: 1, min: 0, integer: true }],
    outputs: [{ name: 'item index' }],
  },
  Spawn: {
    type: 'Spawn',
    inputs: [
      { name: 'trigger', defaultValue: 0 },
      { name: 'release trigger', defaultValue: 0 },
      { name: 'kill trigger', defaultValue: 0, valueEditor: false },
    ],
    outputs: [{ name: 'instance gate' }],
  },
  Ins: {
    type: 'Ins',
    inputs: [],
    outputs: [],
  },
  Params: {
    type: 'Params',
    inputs: [],
    outputs: [],
  },
  Outs: {
    type: 'Outs',
    inputs: [],
    outputs: [],
  },
  AudioOut: {
    type: 'AudioOut',
    inputs: [
      { name: 'both', valueEditor: false },
      { name: 'left', valueEditor: false },
      { name: 'right', valueEditor: false },
      { name: 'level', defaultValue: 0.75 },
    ],
    outputs: [],
  },
  SineOsc: oscillator('SineOsc'),
  TriangleOsc: oscillator('TriangleOsc'),
  SawOsc: oscillator('SawOsc'),
  RampOsc: oscillator('RampOsc'),
  SquareOsc: {
    ...oscillator('SquareOsc'),
    inputs: [
      { name: 'frequency', defaultValue: 220 },
      { name: 'phase', defaultValue: 0 },
      { name: 'phaseReset', defaultValue: 0 },
      { name: 'pulse width', defaultValue: 0.5, min: 0, max: 1 },
      { name: 'rangeMin', defaultValue: -1 },
      { name: 'rangeMax', defaultValue: 1 },
    ],
  },
  KinkOsc: {
    ...oscillator('KinkOsc'),
    inputs: [
      { name: 'frequency', defaultValue: 220 },
      { name: 'phase', defaultValue: 0 },
      { name: 'phase reset', defaultValue: 0 },
      { name: 'shape', defaultValue: 0, min: -1, max: 1 },
      { name: 'squareness', defaultValue: 0, min: -1, max: 1 },
      { name: 'range min', defaultValue: -1 },
      { name: 'range max', defaultValue: 1 },
    ],
  },
  SampleHoldOsc: {
    type: 'SampleHoldOsc',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'trigger', defaultValue: 0 },
    ],
    outputs: [{ name: 'signal' }],
  },
  PerlinNoise: {
    type: 'PerlinNoise',
    inputs: [
      { name: 'speed', defaultValue: 8 },
      { name: 'rangeMin', defaultValue: -1 },
      { name: 'rangeMax', defaultValue: 1 },
    ],
    outputs: [{ name: 'signal' }],
  },
  Noise: {
    type: 'Noise',
    inputs: [
      { name: 'rangeMin', defaultValue: -1 },
      { name: 'rangeMax', defaultValue: 1 },
    ],
    outputs: [{ name: 'signal' }],
  },
  Random: {
    type: 'Random',
    inputs: [
      { name: 'trigger', defaultValue: 0 },
      { name: 'rangeMin', defaultValue: -1 },
      { name: 'rangeMax', defaultValue: 1 },
    ],
    outputs: [{ name: 'signal' }],
  },
  AudioInput: {
    type: 'AudioInput',
    inputs: [
      { name: 'gain', defaultValue: 1 },
      { name: 'level', defaultValue: 0.7 },
    ],
    outputs: [{ name: 'signal' }, { name: 'left' }, { name: 'right' }],
  },
  CustomWave: {
    type: 'CustomWave',
    inputs: [
      { name: 'mode', defaultValue: 0, min: 0, max: 5, integer: true, connectable: false, valueEditor: false },
      { name: 'frequency', defaultValue: 220 },
      { name: 'phase', defaultValue: 0 },
      { name: 'trigger', defaultValue: 0 },
      { name: 'count', defaultValue: 1, min: 1, max: 8, integer: true, connectable: false },
      { name: 'subdivisions', defaultValue: 8, min: 1, max: 64, integer: true, connectable: false },
      { name: 'subgroups', defaultValue: 4, min: 1, max: 64, integer: true, connectable: false },
      { name: 'baseLevel', defaultValue: 0 },
      { name: 'rangeMin', defaultValue: -1 },
      { name: 'rangeMax', defaultValue: 1 },
    ],
    outputs: [
      { name: 'signal' },
      { name: 'end trigger' },
    ],
  },
  SamplePlayer: {
    type: 'SamplePlayer',
    inputs: [
      { name: 'frequency', defaultValue: 440 },
      { name: 'originalFrequency', defaultValue: 440, min: 0.0001 },
      { name: 'trigger', defaultValue: 0 },
      { name: 'voices', defaultValue: 1, min: 1, max: 16, integer: true },
      { name: 'start', defaultValue: 0, min: 0, max: 1 },
      { name: 'end', defaultValue: 1, min: 0, max: 1 },
      { name: 'attack', defaultValue: 0, min: 0, step: 0.001 },
      { name: 'release', defaultValue: 0, min: 0, step: 0.001 },
      { name: 'stretch', defaultValue: 1, min: 0.001 },
      { name: 'cycleLength', defaultValue: 4096, min: 1 },
      { name: 'overlapRatio', defaultValue: 0.09, min: 0, max: 1 },
      { name: 'mode', defaultValue: 0, min: 0, max: 2, integer: true, connectable: false, valueEditor: false },
      { name: 'level', defaultValue: 0.7 },
    ],
    outputs: [{ name: 'signal' }],
  },
  Image: {
    type: 'Image',
    inputs: [
      { name: 'x', defaultValue: 0, min: -1, max: 1 },
      { name: 'y', defaultValue: 0, min: -1, max: 1 },
    ],
    outputs: [
      { name: 'brightness' },
      { name: 'r' },
      { name: 'g' },
      { name: 'b' },
      { name: 'hue' },
      { name: 'saturation' },
    ],
  },
  Buffer: {
    type: 'Buffer',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'playhead', defaultValue: 0 },
      { name: 'playhead speed', defaultValue: 1 },
      { name: 'record head', defaultValue: 0 },
      { name: 'record head speed', defaultValue: 1 },
      { name: 'length', defaultValue: 1, min: 0.01, max: 10 },
      { name: 'on reset', defaultValue: 0, min: 0, max: 1, integer: true, connectable: false, valueEditor: false },
    ],
    outputs: [{ name: 'signal' }, { name: 'record head out' }],
  },
  Playhead: {
    type: 'Playhead',
    inputs: [
      { name: 'start', defaultValue: 0 },
      { name: 'speed', defaultValue: 1 },
      { name: 'length', defaultValue: 1, min: 0.001 },
      { name: 'reset trigger', defaultValue: 0, valueEditor: false },
    ],
    outputs: [{ name: 'playhead' }],
  },
  Time: {
    type: 'Time',
    inputs: [],
    outputs: [{ name: 'seconds' }],
  },
  Freq2Length: {
    type: 'Freq2Length',
    inputs: [{ name: 'frequency', defaultValue: 1 }],
    outputs: [{ name: 'length' }],
  },
  Length2Freq: {
    type: 'Length2Freq',
    inputs: [{ name: 'length', defaultValue: 1 }],
    outputs: [{ name: 'frequency' }],
  },
  Constant: {
    type: 'Constant',
    inputs: [{ name: 'value', defaultValue: 1 }],
    outputs: [{ name: 'signal' }],
  },
  Pass: {
    type: 'Pass',
    inputs: [{ name: 'signal', valueEditor: false }],
    outputs: [{ name: 'signal' }],
  },
  Send: {
    type: 'Send',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'number', defaultValue: 1, min: 1, max: 10, integer: true, connectable: false },
    ],
    outputs: [],
  },
  Receive: {
    type: 'Receive',
    inputs: [
      { name: 'number', defaultValue: 1, min: 1, max: 10, integer: true, connectable: false },
    ],
    outputs: [{ name: 'signal' }],
  },
  Slider: {
    type: 'Slider',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'inverse signal', valueEditor: false },
      { name: 'value', defaultValue: 0.5, min: 0, max: 1 },
      { name: 'curve', defaultValue: 0, min: -8, max: 8 },
      { name: 'min', defaultValue: 0 },
      { name: 'max', defaultValue: 1 },
      { name: 'direction', defaultValue: 0, min: 0, max: 1, integer: true },
      { name: 'midiChannel', defaultValue: 0, min: 0, max: 16, integer: true, connectable: false },
      { name: 'midiCc', defaultValue: 1, min: 0, max: 127, integer: true, connectable: false },
    ],
    outputs: [{ name: 'signal' }, { name: 'inverse' }],
  },
  Joystick: {
    type: 'Joystick',
    inputs: [
      { name: 'xMin', defaultValue: 0 },
      { name: 'xMax', defaultValue: 1 },
      { name: 'xMidiChannel', defaultValue: 0, min: 0, max: 16, integer: true, connectable: false },
      { name: 'xMidiCc', defaultValue: 1, min: 0, max: 127, integer: true, connectable: false },
      { name: 'yMin', defaultValue: 0 },
      { name: 'yMax', defaultValue: 1 },
      { name: 'yMidiChannel', defaultValue: 0, min: 0, max: 16, integer: true, connectable: false },
      { name: 'yMidiCc', defaultValue: 2, min: 0, max: 127, integer: true, connectable: false },
      { name: 'elasticity', defaultValue: 0, min: 0, connectable: false },
    ],
    outputs: [
      { name: 'x' },
      { name: 'x inverse' },
      { name: 'y' },
      { name: 'y inverse' },
    ],
  },
  Button: {
    type: 'Button',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'inverse signal', valueEditor: false },
      { name: 'mode', defaultValue: 0, min: 0, max: 2, integer: true, connectable: false, valueEditor: false },
      { name: 'midiChannel', defaultValue: 0, min: 0, max: 16, integer: true, connectable: false },
      { name: 'midiCc', defaultValue: 1, min: 0, max: 127, integer: true, connectable: false },
    ],
    outputs: [{ name: 'signal' }, { name: 'inverse' }],
  },
  Keys: {
    type: 'Keys',
    inputs: [
      { name: 'size', defaultValue: 12, min: 1, max: 128, integer: true },
      { name: 'startNote', defaultValue: 60, min: 0, max: 127, integer: true },
      { name: 'mode', defaultValue: 0, min: 0, max: 1, integer: true, connectable: false },
      { name: 'glide', defaultValue: 0, min: 0, max: 10, step: 0.01 },
    ],
    outputs: [
      { name: 'midi note' },
      { name: 'frequency' },
    ],
  },
  Sequencer: {
    type: 'Sequencer',
    inputs: [
      { name: 'steps', defaultValue: SEQUENCER_DEFAULT_STEPS, min: SEQUENCER_MIN_STEPS, max: SEQUENCER_MAX_STEPS, integer: true, connectable: false },
      { name: 'rows', defaultValue: SEQUENCER_DEFAULT_ROWS, min: SEQUENCER_MIN_ROWS, max: SEQUENCER_MAX_ROWS, integer: true, connectable: false },
      { name: 'beat length', defaultValue: SEQUENCER_DEFAULT_BEAT_LENGTH, min: SEQUENCER_MIN_BEAT_LENGTH, max: SEQUENCER_MAX_STEPS, integer: true, connectable: false },
      { name: 'mode', defaultValue: 0, min: 0, max: 1, integer: true, connectable: false, valueEditor: false },
      { name: 'signal', defaultValue: 0, valueEditor: false },
      { name: 'reset', defaultValue: 0, valueEditor: false },
    ],
    outputs: sequencerOutputDefinitions(SEQUENCER_DEFAULT_ROWS),
  },
  Roll: {
    type: 'Roll',
    inputs: [
      { name: 'steps', defaultValue: SEQUENCER_DEFAULT_STEPS, min: SEQUENCER_MIN_STEPS, max: SEQUENCER_MAX_STEPS, integer: true, connectable: false },
      { name: 'beat length', defaultValue: SEQUENCER_DEFAULT_BEAT_LENGTH, min: SEQUENCER_MIN_BEAT_LENGTH, max: SEQUENCER_MAX_STEPS, integer: true, connectable: false },
      { name: 'step length', defaultValue: 1, min: 0.05, max: SEQUENCER_MAX_STEPS, step: 0.05, connectable: false },
      { name: 'scale', defaultValue: 0, min: 0, max: QUANTISE_SCALES.length - 1, integer: true, connectable: false, valueEditor: false },
      { name: 'middle note', defaultValue: ROLL_DEFAULT_START_NOTE, min: 0, max: 127, integer: true, connectable: false, valueEditor: false },
      { name: 'range down', defaultValue: 5, min: 0, max: 63, integer: true, connectable: false },
      { name: 'range up', defaultValue: 6, min: 0, max: 63, integer: true, connectable: false },
      { name: 'signal', defaultValue: 0, valueEditor: false },
      { name: 'reset', defaultValue: 0, valueEditor: false },
    ],
    outputs: [
      { name: 'note' },
      { name: 'frequency' },
      { name: 'velocity' },
      { name: 'gate' },
      { name: 'trigger' },
      { name: 'note on' },
      { name: 'note off' },
    ],
  },
  Tempo: {
    type: 'Tempo',
    inputs: [
      { name: 'bpm', defaultValue: 120, min: 1 },
      { name: 'swing', defaultValue: 0, min: -1, max: 1, step: 0.001 },
      { name: 'source', defaultValue: 0, min: 0, max: 1, integer: true, connectable: false, valueEditor: false },
      { name: 'midiSource', defaultValue: 0, min: 0, integer: true, connectable: false, valueEditor: false },
    ],
    outputs: [
      { name: '4 bar' },
      { name: '2 bar' },
      { name: 'bar' },
      { name: 'whole' },
      { name: 'half' },
      { name: 'quarter / beat' },
      { name: 'upbeat' },
      { name: 'eighth' },
      { name: 'sixteenth' },
      { name: 'thirty-second' },
      { name: '4 bar freq' },
      { name: '2 bar freq' },
      { name: 'bar freq' },
      { name: 'whole freq' },
      { name: 'half freq' },
      { name: 'quarter / beat freq' },
      { name: 'upbeat freq' },
      { name: 'eighth freq' },
      { name: 'sixteenth freq' },
      { name: 'thirty-second freq' },
    ],
  },
  MidiNote: {
    type: 'MidiNote',
    inputs: [{ name: 'channel', defaultValue: 0, min: 0, max: 16, integer: true }],
    outputs: [
      { name: 'note' },
      { name: 'frequency' },
      { name: 'velocity' },
      { name: 'gate' },
      { name: 'trigger' },
    ],
  },
  MidiNoteOn: {
    type: 'MidiNoteOn',
    inputs: [{ name: 'channel', defaultValue: 0, min: 0, max: 16, integer: true }],
    outputs: [
      { name: 'note' },
      { name: 'frequency' },
      { name: 'velocity' },
    ],
  },
  MidiNoteOff: {
    type: 'MidiNoteOff',
    inputs: [{ name: 'channel', defaultValue: 0, min: 0, max: 16, integer: true }],
    outputs: [
      { name: 'note' },
      { name: 'frequency' },
    ],
  },
  MidiNoteOnSend: {
    type: 'MidiNoteOnSend',
    inputs: [
      { name: 'trigger', defaultValue: 0, min: 0, max: 1, valueEditor: false },
      { name: 'note', defaultValue: 60, min: 0, max: 127, integer: true },
      { name: 'velocity', defaultValue: 1, min: 0, max: 1 },
      { name: 'channel', defaultValue: 1, min: 1, max: 16, integer: true },
    ],
    outputs: [],
  },
  MidiNoteOffSend: {
    type: 'MidiNoteOffSend',
    inputs: [
      { name: 'trigger', defaultValue: 0, min: 0, max: 1, valueEditor: false },
      { name: 'note', defaultValue: 60, min: 0, max: 127, integer: true },
      { name: 'velocity', defaultValue: 0, min: 0, max: 1 },
      { name: 'channel', defaultValue: 1, min: 1, max: 16, integer: true },
    ],
    outputs: [],
  },
  MidiCcSend: {
    type: 'MidiCcSend',
    inputs: [
      { name: 'signal', defaultValue: 0, min: 0, max: 1 },
      { name: 'trigger', defaultValue: 0, min: 0, max: 1, valueEditor: false },
      { name: 'cc', defaultValue: 1, min: 0, max: 127, integer: true },
      { name: 'channel', defaultValue: 1, min: 1, max: 16, integer: true },
      { name: 'throttle', defaultValue: 0.1, min: 0 },
    ],
    outputs: [],
  },
  MidiCc: {
    type: 'MidiCc',
    inputs: [
      { name: 'channel', defaultValue: 0, min: 0, max: 16, integer: true },
      { name: 'cc', defaultValue: 1, min: 0, max: 127, integer: true },
    ],
    outputs: [{ name: 'signal' }],
  },
  Selector: {
    type: 'Selector',
    inputs: [
      { name: 'select', defaultValue: 0, min: 0, integer: true },
      { name: 'slide', defaultValue: 0, min: 0 },
      { name: '1', defaultValue: 0 },
    ],
    outputs: [{ name: 'signal' }],
  },
  Accumulator: {
    type: 'Accumulator',
    inputs: [
      { name: 'mode', defaultValue: 0, min: 0, max: 1, integer: true, connectable: false, valueEditor: false },
      { name: 'trigger', defaultValue: 0 },
      { name: 'reset', defaultValue: 0, valueEditor: false },
      { name: 'increment', defaultValue: 1 },
      { name: 'min', defaultValue: 0 },
      { name: 'max', defaultValue: 1 },
    ],
    outputs: [{ name: 'signal' }],
  },
  Quantise: {
    type: 'Quantise',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'scale', defaultValue: 0, min: 0, max: 15, integer: true, connectable: false, valueEditor: false },
      { name: 'root', defaultValue: 0, min: 0, max: 11, integer: true, connectable: false, valueEditor: false },
    ],
    outputs: [{ name: 'signal' }],
  },
  Abs: processor('Abs', []),
  Map: processor('Map', [
    { name: 'srcMin', defaultValue: 0 },
    { name: 'srcMax', defaultValue: 1 },
    { name: 'trgtMin', defaultValue: 0 },
    { name: 'trgtMax', defaultValue: 1 },
  ]),
  Clamp: processor('Clamp', [
    { name: 'min', defaultValue: 0 },
    { name: 'max', defaultValue: 1 },
  ]),
  Multiply: processor('Multiply', [
    { name: 'factor', defaultValue: 1 },
  ]),
  Pow: processor('Pow', [
    { name: 'exponent', defaultValue: 1 },
  ]),
  Pan: {
    type: 'Pan',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'pan', defaultValue: 0, min: -1, max: 1 },
    ],
    outputs: [
      { name: 'left' },
      { name: 'right' },
    ],
  },
  Delay: processor('Delay', [
    { name: 'time', defaultValue: 0.28, min: 0, max: 1.5 },
    { name: 'feedback', defaultValue: 0.35, min: 0, max: 2 },
    { name: 'mix', defaultValue: 0.25, min: 0, max: 1 },
  ]),
  Chorus: processor('Chorus', [
    { name: 'rate', defaultValue: 0.8, min: 0.05, max: 6 },
    { name: 'depth', defaultValue: 0.012, min: 0.001, max: 0.04 },
    { name: 'mix', defaultValue: 0.25, min: 0, max: 1 },
  ]),
  Reverb: {
    type: 'Reverb',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'mode', defaultValue: 0, min: 0, max: 2, integer: true, connectable: false, valueEditor: false },
      { name: 'size', defaultValue: 0.55, min: 0.1, max: 1 },
      { name: 'decay', defaultValue: 0.45, min: 0, max: 0.94 },
      { name: 'mix', defaultValue: 0.25, min: 0, max: 1 },
    ],
    outputs: [
      { name: 'left' },
      { name: 'right' },
    ],
  },
  Compress: processor('Compress', [
    { name: 'sidechain', valueEditor: false },
    { name: 'threshold', defaultValue: -24, min: -80, max: 0, step: 0.1 },
    { name: 'ratio', defaultValue: 4, min: 1, max: 20, step: 0.1 },
    { name: 'attack', defaultValue: 0.01, min: 0, max: 1, step: 0.001 },
    { name: 'release', defaultValue: 0.1, min: 0, max: 3, step: 0.001 },
    { name: 'knee', defaultValue: 6, min: 0, max: 40, step: 0.1 },
    { name: 'makeup', defaultValue: 0, min: -24, max: 24, step: 0.1 },
  ]),
  Limiter: processor('Limiter', [
    { name: 'inputGain', defaultValue: 0, min: -24, max: 24, step: 0.1 },
    { name: 'ceiling', defaultValue: -1, min: -24, max: 0, step: 0.1 },
    { name: 'release', defaultValue: 0.05, min: 0.001, max: 3, step: 0.001 },
    { name: 'lookahead', defaultValue: 0.005, min: 0, max: 0.02, step: 0.001 },
  ]),
  Envelope: {
    type: 'Envelope',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'trigger', valueEditor: false },
      { name: 'gate', valueEditor: false },
      { name: 'delay', defaultValue: 0, min: 0 },
      { name: 'attack', defaultValue: 0.01, min: 0 },
      { name: 'decay', defaultValue: 0.16, min: 0 },
      { name: 'sustain', defaultValue: 0.72 },
      { name: 'gateLength', defaultValue: 0, min: 0 },
      { name: 'release', defaultValue: 0.24, min: 0 },
    ],
    outputs: [
      { name: 'signal' },
      { name: 'end trigger' },
    ],
  },
  Follower: processor('Follower', [
    { name: 'attack', defaultValue: 0.01, min: 0 },
    { name: 'release', defaultValue: 0.12, min: 0 },
  ]),
  RemoveDc: processor('RemoveDc', []),
  Fold: processor('Fold', [
    { name: 'amount', defaultValue: 1 },
  ]),
  Meter: processor('Meter', [
    { name: 'range', defaultValue: 1, min: 0.001 },
    { name: 'mode', defaultValue: 0, min: 0, max: 1, integer: true, connectable: false, valueEditor: false },
  ]),
  Scope: processor('Scope', [
    { name: 'range', defaultValue: 1, min: 0.001 },
    { name: 'mode', defaultValue: 1, min: 0, max: 1, integer: true, connectable: false, valueEditor: false },
    { name: 'length', defaultValue: 0.08, min: 0.01, max: 30, step: 0.01, connectable: false },
    { name: 'reset', defaultValue: 1, min: 0, max: 1, integer: true, connectable: false, valueEditor: false },
  ]),
  FFT: {
    type: 'FFT',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'minFreq', defaultValue: 20, min: 20, max: 20000, step: 1, connectable: false },
      { name: 'maxFreq', defaultValue: 20000, min: 20, max: 20000, step: 1, connectable: false },
    ],
    outputs: [
      { name: 'frequency' },
      { name: 'amplitude' },
    ],
  },
  LowpassFilter: filter('LowpassFilter'),
  HighpassFilter: filter('HighpassFilter'),
  BandpassFilter: filter('BandpassFilter'),
  AllpassFilter: filter('AllpassFilter'),
  Crossover: {
    type: 'Crossover',
    inputs: [
      { name: 'signal', valueEditor: false },
      { name: 'points', defaultValue: 1, min: 1, max: 8, integer: true, connectable: false },
      { name: 'slope', defaultValue: 24, min: 12, max: 48, step: 12, integer: true, connectable: false },
    ],
    outputs: [],
  },
  Equalizer: processor('Equalizer', [
    { name: 'lows', defaultValue: 0, min: -24, max: 24, step: 0.1 },
    { name: 'mids', defaultValue: 0, min: -24, max: 24, step: 0.1 },
    { name: 'highs', defaultValue: 0, min: -24, max: 24, step: 0.1 },
  ]),
  FormantFilter: processor('FormantFilter', [
    { name: 'morph', defaultValue: 0, min: 0, max: 1 },
    { name: 'intensity', defaultValue: 8, min: 0 },
  ]),
  CombFilter: processor('CombFilter', [
    { name: 'frequency', defaultValue: 440 },
    { name: 'feedback', defaultValue: 0.45, min: -0.999, max: 0.999 },
  ]),
  CombNotchFilter: processor('CombNotchFilter', [
    { name: 'frequency', defaultValue: 440 },
    { name: 'feedback', defaultValue: 0.45, min: -0.999, max: 0.999 },
  ]),
  HardClipDistortion: distortion('HardClipDistortion'),
  SoftClipDistortion: distortion('SoftClipDistortion'),
  FuzzDistortion: distortion('FuzzDistortion'),
  SaturateDistortion: distortion('SaturateDistortion'),
  WavefoldDistortion: distortion('WavefoldDistortion'),
};

export const NODE_TYPE_LIST = Object.keys(NODE_DEFINITIONS) as NodeType[];

const NODE_TYPE_LABELS: Record<NodeType, string> = {
  Expression: 'Expression',
  Group: 'Group',
  Spread: 'Spread',
  Spawn: 'Spawn',
  Ins: 'Ins',
  Params: 'Params',
  Outs: 'Outs',
  AudioOut: 'Audio Out',
  SineOsc: 'Sine Osc',
  TriangleOsc: 'Triangle Osc',
  SawOsc: 'Saw Osc',
  RampOsc: 'Ramp Osc',
  SquareOsc: 'Square Osc',
  KinkOsc: 'Kink Osc',
  SampleHoldOsc: 'Sample Hold',
  PerlinNoise: 'Perlin Noise',
  Noise: 'Noise',
  Random: 'Random',
  AudioInput: 'Audio Input',
  CustomWave: 'Custom Wave',
  SamplePlayer: 'Sample',
  Image: 'Image',
  Buffer: 'Buffer',
  Playhead: 'Playhead',
  Time: 'Time',
  Freq2Length: 'freq2length',
  Length2Freq: 'length2freq',
  Constant: 'Constant',
  Pass: 'Pass',
  Send: 'Send',
  Receive: 'Receive',
  Slider: 'Slider',
  Joystick: 'Joystick',
  Button: 'Button',
  Keys: 'Keys',
  Sequencer: 'Sequencer',
  Roll: 'Roll',
  Tempo: 'Tempo',
  MidiNote: 'MIDI Note',
  MidiNoteOn: 'MIDI Note On',
  MidiNoteOff: 'MIDI Note Off',
  MidiNoteOnSend: 'MIDI Note On Send',
  MidiNoteOffSend: 'MIDI Note Off Send',
  MidiCcSend: 'MIDI CC Send',
  MidiCc: 'MIDI CC',
  Selector: 'Selector',
  Accumulator: 'Accumulator',
  Quantise: 'Quantise',
  Abs: 'Abs',
  Map: 'Map',
  Clamp: 'Clamp',
  Multiply: 'Multiply',
  Pow: 'pow',
  Pan: 'Pan',
  Delay: 'Delay',
  Chorus: 'Chorus',
  Reverb: 'Reverb',
  Compress: 'Compress',
  Limiter: 'Limiter',
  Envelope: 'Envelope',
  Follower: 'Follower',
  RemoveDc: 'Remove DC',
  Fold: 'Fold',
  Meter: 'Meter',
  Scope: 'Scope',
  FFT: 'FFT',
  LowpassFilter: 'Lowpass Filter',
  HighpassFilter: 'Highpass Filter',
  BandpassFilter: 'Bandpass Filter',
  AllpassFilter: 'Allpass Filter',
  Crossover: 'Crossover',
  Equalizer: 'Equaliser',
  FormantFilter: 'Formant Filter',
  CombFilter: 'Comb Filter',
  CombNotchFilter: 'Comb Notch',
  HardClipDistortion: 'Hard Clip',
  SoftClipDistortion: 'Soft Clip',
  FuzzDistortion: 'Fuzz',
  SaturateDistortion: 'Saturate',
  WavefoldDistortion: 'Wavefold',
};

export function getDefinition(type: NodeType): NodeDefinition {
  return NODE_DEFINITIONS[type];
}

export function getNodeDefinition(node: PatchNode): NodeDefinition {
  if (node.type === 'Expression') {
    return {
      type: node.type,
      inputs: node.inputs ?? [],
      outputs: getDefinition(node.type).outputs,
    };
  }

  if (node.type === 'Group') {
    return {
      type: node.type,
      inputs: node.inputs ?? [],
      outputs: node.outputs ?? [],
    };
  }

  if (node.type === 'Ins' || node.type === 'Params') {
    return {
      type: node.type,
      inputs: [],
      outputs: node.outputs ?? [],
    };
  }

  if (node.type === 'Outs') {
    return {
      type: node.type,
      inputs: node.inputs ?? [],
      outputs: [],
    };
  }

  if (node.type === 'Accumulator') {
    const definition = getDefinition(node.type);
    const inputs = [...(node.inputs ?? definition.inputs)];
    for (const [name, precedingName] of [['increment', 'reset'], ['mode', 'increment']] as const) {
      if (inputs.some((input) => input.name === name)) continue;
      const input = definition.inputs.find((candidate) => candidate.name === name);
      if (!input) continue;
      const precedingIndex = inputs.findIndex((candidate) => candidate.name === precedingName);
      inputs.splice(precedingIndex >= 0 ? precedingIndex + 1 : inputs.length, 0, input);
    }
    const modeIndex = inputs.findIndex((input) => input.name === 'mode');
    if (modeIndex > 0) inputs.unshift(...inputs.splice(modeIndex, 1));
    return {
      ...definition,
      inputs,
      outputs: node.outputs ?? definition.outputs,
    };
  }

  if (node.type === 'Slider') {
    const definition = getDefinition(node.type);
    const inputs = [...(node.inputs ?? definition.inputs)];
    if (!inputs.some((input) => input.name === 'curve')) {
      const curve = definition.inputs.find((input) => input.name === 'curve');
      const valueIndex = inputs.findIndex((input) => input.name === 'value');
      if (curve) inputs.splice(valueIndex >= 0 ? valueIndex + 1 : inputs.length, 0, curve);
    }
    return {
      ...definition,
      inputs,
      outputs: node.outputs ?? definition.outputs,
    };
  }

  if (node.type === 'CustomWave') {
    const definition = getDefinition(node.type);
    const inputs = [...(node.inputs ?? definition.inputs)];
    if (!inputs.some((input) => input.name === 'mode')) {
      const mode = definition.inputs.find((input) => input.name === 'mode');
      if (mode) inputs.unshift(mode);
    }
    if (!inputs.some((input) => input.name === 'baseLevel')) {
      const baseLevel = definition.inputs.find((input) => input.name === 'baseLevel');
      const rangeMinIndex = inputs.findIndex((input) => input.name === 'rangeMin');
      if (baseLevel) inputs.splice(rangeMinIndex >= 0 ? rangeMinIndex : inputs.length, 0, baseLevel);
    }
    return {
      ...definition,
      inputs,
      outputs: node.outputs ?? customWaveOutputDefinitions(node.params.count),
    };
  }

  if (node.type === 'Crossover') {
    const points = clampInteger(node.params.points, 1, 8, 1);
    const definition = getDefinition(node.type);
    return {
      ...definition,
      inputs: [
        ...definition.inputs,
        ...Array.from({ length: points }, (_, index) => ({
          name: `frequency ${index + 1}`,
          defaultValue: [1200, 4000, 8000, 12000, 15000, 17000, 18500, 19500][index],
          min: 20,
          max: 20000,
        })),
      ],
      outputs: Array.from({ length: points + 1 }, (_, index) => ({ name: `band ${index + 1}` })),
    };
  }

  if (node.type === 'Sequencer') {
    return {
      ...getDefinition(node.type),
      inputs: node.inputs ?? getDefinition(node.type).inputs,
      outputs: sequencerOutputDefinitions(sequencerShape(node.params).rows),
    };
  }

  if (node.type === 'Reverb') {
    const definition = getDefinition(node.type);
    const mode = definition.inputs.find((input) => input.name === 'mode')!;
    const inputs = (node.inputs ?? definition.inputs).filter((input) => input.name !== 'mode');
    inputs.splice(1, 0, mode);
    return { ...definition, inputs, outputs: node.outputs ?? definition.outputs };
  }

  if (node.type === 'Roll') {
    // Roll's controls are a fixed UI contract. Ignore persisted legacy input
    // definitions so removed controls (such as the old mode selector) do not
    // reappear when loading an existing patch.
    return getDefinition(node.type);
  }

  return {
    ...getDefinition(node.type),
    inputs: node.inputs ?? getDefinition(node.type).inputs,
    outputs: node.outputs ?? getDefinition(node.type).outputs,
  };
}

function customWaveOutputDefinitions(count: number | undefined): PortDefinition[] {
  const waveCount = Math.max(1, Math.min(8, Math.round(Number.isFinite(count) ? count! : 1)));
  return waveCount === 1
    ? getDefinition('CustomWave').outputs
    : [...Array.from({ length: waveCount }, (_, index) => ({ name: `signal ${index + 1}` })), { name: 'end trigger' }];
}

export function sequencerShape(params: Record<string, number>): { steps: number; rows: number; beatLength: number } {
  return {
    steps: clampInteger(params.steps, SEQUENCER_MIN_STEPS, SEQUENCER_MAX_STEPS, SEQUENCER_DEFAULT_STEPS),
    rows: clampInteger(params.rows, SEQUENCER_MIN_ROWS, SEQUENCER_MAX_ROWS, SEQUENCER_DEFAULT_ROWS),
    beatLength: clampInteger(params['beat length'] ?? params.beatLength, SEQUENCER_MIN_BEAT_LENGTH, SEQUENCER_MAX_STEPS, SEQUENCER_DEFAULT_BEAT_LENGTH),
  };
}

export function rollShape(params: Record<string, number>): {
  steps: number;
  beatLength: number;
  stepLength: number;
  scale: number;
  middleNote: number;
  rangeDown: number;
  rangeUp: number;
  rows: Array<{ index: number; note: number }>;
} {
  const legacyStartNote = clampInteger(params.startNote, 0, 127, ROLL_DEFAULT_START_NOTE);
  const middleNote = clampInteger(params['middle note'] ?? legacyStartNote, 0, 127, ROLL_DEFAULT_START_NOTE);
  const scale = clampInteger(params.scale, 0, QUANTISE_SCALES.length - 1, 0);
  const scaleSemitones = QUANTISE_SCALES[scale].semitones;
  const legacyRangeUp = params['highest note'] === undefined
    ? ROLL_ROWS - 1
    : Math.max(0, Math.round(params['highest note']) - legacyStartNote);
  const rangeDown = clampInteger(params['range down'] ?? (params['lowest note'] === undefined ? 0 : Math.max(0, legacyStartNote - Math.round(params['lowest note']))), 0, 63, 5);
  const rangeUp = clampInteger(params['range up'] ?? legacyRangeUp, 0, Math.min(63, ROLL_MAX_ROWS - rangeDown - 1), 6);
  const scaleOffset = (index: number) => {
    const octave = Math.floor(index / scaleSemitones.length);
    const degree = ((index % scaleSemitones.length) + scaleSemitones.length) % scaleSemitones.length;
    return octave * 12 + scaleSemitones[degree];
  };
  const rows = Array.from({ length: rangeDown + rangeUp + 1 }, (_, offset) => {
    const index = offset - rangeDown;
    return { index, note: clampInteger(middleNote + scaleOffset(index), 0, 127, middleNote) };
  });
  return {
    steps: clampInteger(params.steps, SEQUENCER_MIN_STEPS, SEQUENCER_MAX_STEPS, SEQUENCER_DEFAULT_STEPS),
    beatLength: clampInteger(params['beat length'] ?? params.beatLength, SEQUENCER_MIN_BEAT_LENGTH, SEQUENCER_MAX_STEPS, SEQUENCER_DEFAULT_BEAT_LENGTH),
    stepLength: Math.max(0.05, Math.min(SEQUENCER_MAX_STEPS, Number.isFinite(params['step length']) ? params['step length'] : Number.isFinite(params.stepLength) ? params.stepLength : 1)),
    scale,
    middleNote,
    rangeDown,
    rangeUp,
    rows,
  };
}

export function rollCellParamName(rowIndex: number, stepIndex: number): string {
  return `roll:${rowIndex}:${stepIndex}`;
}

export interface RollGate { slot: number; start: number; end: number; velocity: number; }

export function rollGateParamName(rowIndex: number, slot: number, field: 'active' | 'start' | 'end'): string {
  return `roll:gate:${field}:${rowIndex}:${slot}`;
}

export function rollGateVelocityParamName(rowIndex: number, slot: number): string {
  return `roll:velocity:${rowIndex}:${slot}`;
}

export function rollGatesForRow(params: Record<string, number>, rowIndex: number, steps: number): RollGate[] {
  const gates: RollGate[] = [];
  for (let slot = 0; slot < steps; slot += 1) {
    if ((params[rollGateParamName(rowIndex, slot, 'active')] ?? params[rollCellParamName(rowIndex, slot)] ?? 0) < 0.5) continue;
    const start = Math.max(0, Math.min(steps, params[rollGateParamName(rowIndex, slot, 'start')] ?? slot));
    const end = Math.max(start, Math.min(steps, params[rollGateParamName(rowIndex, slot, 'end')] ?? start + 1));
    const velocity = Math.max(SEQUENCER_MIN_VELOCITY, Math.min(1, params[rollGateVelocityParamName(rowIndex, slot)] ?? 1));
    if (end > start) gates.push({ slot, start, end, velocity });
  }
  return trimOverlappingSequencerGates(gates);
}

export function sequencerOutputName(rowIndex: number): string {
  return String(rowIndex + 1);
}

export function sequencerOutputIndex(port: string): number | null {
  if (!/^(0|[1-9][0-9]*)$/.test(port)) return null;
  const value = Number(port);
  if (!Number.isInteger(value) || value < 1 || value > SEQUENCER_MAX_ROWS) return null;
  return value - 1;
}

export function sequencerCellParamName(rowIndex: number, stepIndex: number): string {
  return `cell:${rowIndex}:${stepIndex}`;
}

export const SEQUENCER_GATE_MODE_PARAM = 'mode';
export const SEQUENCER_GATE_INITIALIZED_PARAM = 'gate:initialized';

export const SEQUENCER_MIN_VELOCITY = 0.1;

export interface SequencerGate {
  slot: number;
  start: number;
  end: number;
  velocity: number;
}

export interface SequencerTrigger {
  slot: number;
  position: number;
  velocity: number;
}

/**
 * Gate rows are monophonic. Keep the later gate intact and shorten the end of
 * an earlier gate when stored data (or a pattern-length change) overlaps it.
 */
export function trimOverlappingSequencerGates(gates: SequencerGate[]): SequencerGate[] {
  const ordered = [...gates].sort((a, b) => a.start - b.start || a.slot - b.slot);
  return ordered.flatMap((gate, index) => {
    const nextStart = ordered[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    const end = Math.min(gate.end, nextStart);
    return end > gate.start ? [{ ...gate, end }] : [];
  });
}

export function sequencerUsesGateMode(params: Record<string, number>): boolean {
  return (params[SEQUENCER_GATE_MODE_PARAM] ?? params.gateMode ?? 0) >= 0.5;
}

export function sequencerGateParamName(
  rowIndex: number,
  slot: number,
  field: 'active' | 'start' | 'end',
): string {
  return `gate:${field}:${rowIndex}:${slot}`;
}

export function sequencerTriggerPositionParamName(rowIndex: number, slot: number): string {
  return `trigger:position:${rowIndex}:${slot}`;
}

export function sequencerStepVelocityParamName(rowIndex: number, slot: number): string {
  return `velocity:${rowIndex}:${slot}`;
}

export function sequencerStepVelocity(params: Record<string, number>, rowIndex: number, slot: number): number {
  const value = params[sequencerStepVelocityParamName(rowIndex, slot)] ?? 1;
  if (!Number.isFinite(value)) return 1;
  return Math.max(SEQUENCER_MIN_VELOCITY, Math.min(1, value));
}

export function sequencerTriggersForRow(
  params: Record<string, number>,
  rowIndex: number,
  steps: number,
): SequencerTrigger[] {
  const triggers: SequencerTrigger[] = [];
  for (let slot = 0; slot < steps; slot += 1) {
    if ((params[sequencerCellParamName(rowIndex, slot)] ?? 0) < 0.5) continue;
    const position = params[sequencerTriggerPositionParamName(rowIndex, slot)] ?? slot;
    // Keep triggers stored outside the current pattern length so they return if
    // the sequence grows again, but do not render or compile them while hidden.
    if (position < 0 || position >= steps) continue;
    triggers.push({
      slot,
      position,
      velocity: sequencerStepVelocity(params, rowIndex, slot),
    });
  }
  return triggers;
}

export function sequencerGatesForRow(
  params: Record<string, number>,
  rowIndex: number,
  steps: number,
): SequencerGate[] {
  if ((params[SEQUENCER_GATE_INITIALIZED_PARAM] ?? 0) < 0.5) {
    const legacy: SequencerGate[] = [];
    for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
      if ((params[sequencerCellParamName(rowIndex, stepIndex)] ?? 0) >= 0.5) {
        legacy.push({ slot: stepIndex, start: stepIndex, end: stepIndex + 1, velocity: sequencerStepVelocity(params, rowIndex, stepIndex) });
      }
    }
    return trimOverlappingSequencerGates(legacy);
  }

  const gates: SequencerGate[] = [];
  for (let slot = 0; slot < steps; slot += 1) {
    if ((params[sequencerGateParamName(rowIndex, slot, 'active')] ?? 0) < 0.5) continue;
    const start = Math.max(0, Math.min(steps, params[sequencerGateParamName(rowIndex, slot, 'start')] ?? slot));
    const end = Math.max(start, Math.min(steps, params[sequencerGateParamName(rowIndex, slot, 'end')] ?? start + 1));
    if (end > start) gates.push({ slot, start, end, velocity: sequencerStepVelocity(params, rowIndex, slot) });
  }
  return trimOverlappingSequencerGates(gates);
}

export function sequencerPatternValue(params: Record<string, number>, rowIndex: number, steps: number): [number, number, number, number] {
  const pattern: [number, number, number, number] = [0, 0, 0, 0];
  for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
    if (
      (params[sequencerCellParamName(rowIndex, stepIndex)] ?? 0) >= 0.5
      && params[sequencerTriggerPositionParamName(rowIndex, stepIndex)] === undefined
      && sequencerStepVelocity(params, rowIndex, stepIndex) >= 1
    ) {
      const laneIndex = Math.floor(stepIndex / 32);
      if (laneIndex < pattern.length) {
        pattern[laneIndex] += 2 ** (stepIndex % 32);
      }
    }
  }
  return pattern;
}

function sequencerOutputDefinitions(rows: number): NodeDefinition['outputs'] {
  return [
    ...Array.from({ length: rows }, (_, rowIndex) => ({ name: sequencerOutputName(rowIndex) })),
    { name: SEQUENCER_INDEX_OUTPUT },
  ];
}

export function getNodeTypeLabel(type: NodeType): string {
  return NODE_TYPE_LABELS[type];
}

export function defaultParamsFor(type: NodeType): Record<string, number> {
  const params: Record<string, number> = {};
  for (const input of getDefinition(type).inputs) {
    if (input.defaultValue !== undefined) {
      params[input.name] = input.defaultValue;
    }
  }
  if (type === 'Crossover') {
    [1200, 4000, 8000, 12000, 15000, 17000, 18500, 19500].forEach((frequency, index) => {
      params[`frequency ${index + 1}`] = frequency;
    });
  }
  return params;
}

function oscillator(type: NodeType): NodeDefinition {
  return {
    type,
    inputs: [
      { name: 'frequency', defaultValue: 220 },
      { name: 'phase', defaultValue: 0 },
      { name: 'phaseReset', defaultValue: 0 },
      { name: 'rangeMin', defaultValue: -1 },
      { name: 'rangeMax', defaultValue: 1 },
    ],
    outputs: [{ name: 'signal' }],
  };
}

function processor(type: NodeType, params: NodeDefinition['inputs']): NodeDefinition {
  return {
    type,
    inputs: [
      { name: 'signal', valueEditor: false },
      ...params,
    ],
    outputs: [{ name: 'signal' }],
  };
}

function filter(type: NodeType): NodeDefinition {
  return processor(type, [
    { name: 'cutoff', defaultValue: 1200, min: 0 },
    { name: 'resonance', defaultValue: 0.7, min: 0 },
  ]);
}

function distortion(type: NodeType): NodeDefinition {
  return processor(type, [
    { name: 'drive', defaultValue: 2.5, min: 0 },
  ]);
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.min(max, Math.max(min, Math.round(numberValue)));
}
