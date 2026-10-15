import { dspProgramStructureKey, dspCustomWavePointsKey, dspSequencerConfigKey } from './dspEdit';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AUDIO_ENGINE_CONFIG } from './config';
import { createParallelEngine, type ParallelEngine } from './parallelEngine';
import { DSP_OP, type DspProgram } from './dspProgram';
import { logDiagnosticEvent, serializeError } from '../diagnostics';
import { AUDIO_SIMD_WASM_ASSET_VERSION, AUDIO_WASM_ASSET_VERSION, AUDIO_WORKLET_ASSET_VERSION } from 'virtual:audio-engine-assets';

type AudioStatus = 'idle' | 'starting' | 'running' | 'error';
type RecordingStatus = 'idle' | 'waiting' | 'recording' | 'saving' | 'saved' | 'error';
export type AudioInputStatus = 'inactive' | 'needs-permission' | 'requesting' | 'connected' | 'denied' | 'unsupported' | 'error';
export type MidiInputStatus = 'inactive' | 'needs-permission' | 'requesting' | 'connected' | 'denied' | 'unsupported' | 'error';

const MIDI_CLOCK_TICKS_PER_BEAT = 24;
const MIDI_CLOCK_TEMPO_MIN = 1;
const MIDI_CLOCK_TEMPO_MAX = 999;
const MIDI_CLOCK_EMA_WEIGHT = 0.18;

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

export interface AudioInputState {
  status: AudioInputStatus;
  message: string;
  devices: AudioInputDevice[];
  selectedDeviceId: string;
  canSelectDevice: boolean;
}

export interface MidiInputDevice {
  id: string;
  label: string;
  state: string;
}

export interface MidiControlChange {
  id: number;
  sourceIndex: number;
  channel: number;
  cc: number;
  value: number;
  receivedAt: number;
}

export interface MidiInputState {
  status: MidiInputStatus;
  message: string;
  devices: MidiInputDevice[];
  outputDevices: MidiInputDevice[];
  canRequestAccess: boolean;
  lastControlChange?: MidiControlChange;
}

export interface LinkMeterReading {
  input: number;
  output: number;
  envelope: number;
}

export interface LinkScopeReading {
  mode: string;
  samples: number[];
}

export interface BufferVisualization {
  playhead: number;
  recordHead: number;
  bins: Array<{ min: number; max: number }>;
}

export interface BufferSnapshot {
  samples: Float32Array;
  sampleRate: number;
}

export interface BufferCopy {
  sourceNodeId: string;
  targetNodeId: string;
}

export interface ScopeCaptureRequest {
  id: string;
  length: number;
  points?: number;
  reset?: 'none' | 'zero-crossing';
}

export interface RecordingState {
  status: RecordingStatus;
  message: string;
  fileName: string | null;
  elapsedSeconds: number;
}

export interface AudioEngineState {
  status: AudioStatus;
  message: string;
  cpuLoad: number;
  cpuPeakLoad: number;
  cpuDeadlineMisses: number;
  rendering: { mode: string; workers: number; parallelRepeats: number; reason: string };
  peak: number;
  linkMeters: Record<string, LinkMeterReading>;
  linkScopes: Record<string, LinkScopeReading>;
  playheads: Record<string, number[]>;
  buffers: Record<string, BufferVisualization>;
  recording: RecordingState;
  audioInput: AudioInputState;
  midiInput: MidiInputState;
  start: () => Promise<void>;
  stop: () => void;
  startRecording: () => void;
  stopRecording: () => void;
  captureBuffer: (nodeId: string) => Promise<BufferSnapshot | null>;
  clearBuffer: (nodeId: string) => void;
  copyBuffers: (copies: BufferCopy[]) => void;
  restoreBuffers: (snapshots: Record<string, BufferSnapshot>) => void;
  syncGraph: (program: DspProgram) => void;
  setLinkScopes: (requests: ScopeCaptureRequest[]) => void;
  setAudioInputDeviceId: (deviceId: string) => void;
  refreshAudioInputDevices: () => Promise<void>;
  refreshMidiInputDevices: () => Promise<void>;
}

interface UseAudioEngineOptions {
  selectedMidiInputDeviceIds?: string[];
  selectedMidiOutputDeviceIds?: string[];
  midiClockOutputEnabled?: boolean;
  recordingPatchName?: string;
}

interface MidiInputLike {
  id?: string;
  name?: string;
  manufacturer?: string;
  state?: string;
  onmidimessage: ((event: any) => void) | null;
}

interface MidiOutputLike {
  id?: string;
  name?: string;
  manufacturer?: string;
  state?: string;
  send: (data: number[] | Uint8Array, timestamp?: number) => void;
}

interface MidiAccessLike {
  inputs: {
    values: () => Iterable<MidiInputLike>;
  };
  outputs: {
    values: () => Iterable<MidiOutputLike>;
  };
  onstatechange: (() => void) | null;
}

interface RecordingCapture {
  id: number;
  patchName: string;
  chunks: Float32Array[][];
  channelCount: number;
  sampleRate: number;
  frames: number;
  stopping: boolean;
  sampleEvents: SamplePlaybackEvent[];
}

interface SamplePlaybackEvent {
  nodeId: string;
  sampleName: string;
  startMs: number;
  endMs: number;
  speed: number;
  volume: number;
  attackMs: number;
  releaseMs: number;
  triggerTimeMs: number;
}

interface SampleDataCacheEntry {
  key: string;
  data: Float32Array;
  sampleRate: number;
  name: string;
  storageKey: string;
}

interface SampleDataRequest {
  key: string;
  promise: Promise<SampleDataCacheEntry | null>;
}

interface AudioInputRequest {
  id: number;
  deviceId: string;
  context: AudioContext;
  node: AudioWorkletNode;
}

interface ImageDataCacheEntry {
  key: string;
  data: Uint8Array;
  width: number;
  height: number;
  name: string;
}

interface ImageDataRequest {
  key: string;
  promise: Promise<ImageDataCacheEntry | null>;
}

const WORKLET_URL = `/audio/audio-worklet-wasm.js?v=${AUDIO_WORKLET_ASSET_VERSION}`;
const WASM_URL = `/audio/teia-kernel.wasm?v=${AUDIO_WASM_ASSET_VERSION}`;
const SIMD_WASM_URL = `/audio/teia-kernel-simd.wasm?v=${AUDIO_SIMD_WASM_ASSET_VERSION}`;

async function loadCompatibleWasmBytes(preferSimd: boolean): Promise<ArrayBuffer> {
  if (preferSimd) {
    try {
      const response = await fetch(SIMD_WASM_URL, { cache: 'no-store' });
      if (response.ok) {
        const bytes = await response.arrayBuffer();
        if (WebAssembly.validate(bytes)) return bytes;
      }
    } catch { /* The ordinary kernel is the compatibility fallback. */ }
  }
  const response = await fetch(WASM_URL, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load WASM kernel (${response.status}).`);
  return response.arrayBuffer();
}
const METER_UPDATE_INTERVAL_MS = 80;
const RECORDING_CHUNK_FRAMES = 16384;
const RECORDING_CHANNEL_COUNT = 2;
const SCOPE_DISPLAY_POINTS = 160;
// Continuous scopes capture on the display grid so old points simply move left
// as new points enter the ring. Zero-crossing scopes use twice this count: the
// first window provides a stable crossing search and the second is displayed.
const SCOPE_CAPTURE_POINTS = SCOPE_DISPLAY_POINTS;
const SCOPE_MODE = 'continuous';
const AUDIO_OUTPUT_FADE_SECONDS = 0.02;
const AUDIO_OUTPUT_STOP_DELAY_MS = Math.ceil(AUDIO_OUTPUT_FADE_SECONDS * 1000) + 24;
const AUDIO_SILENCE_PEAK_THRESHOLD = 0.00001;
const AUDIO_UNEXPECTED_SILENCE_MS = 5000;
const AUDIO_SILENCE_REPORT_INTERVAL_MS = 15000;
const AUDIO_HEALTH_REPORT_INTERVAL_MS = 5000;

async function closeAudioContext(
  contextRef: { current: AudioContext | null },
  nodeRef: { current: AudioWorkletNode | null },
  analyserRef: { current: AnalyserNode | null },
  outputGainRef: { current: GainNode | null },
  inputSourceRef: { current: MediaStreamAudioSourceNode | null },
  inputStreamRef: { current: MediaStream | null },
  stopTimeoutRef?: { current: number | null },
  generation = 0,
  reason = 'unknown',
): Promise<void> {
  if (stopTimeoutRef && stopTimeoutRef.current !== null) {
    window.clearTimeout(stopTimeoutRef.current);
    stopTimeoutRef.current = null;
  }
  const context = contextRef.current;
  const node = nodeRef.current;
  const analyser = analyserRef.current;
  const outputGain = outputGainRef.current;
  const inputSource = inputSourceRef.current;
  const inputStream = inputStreamRef.current;

  logDiagnosticEvent('audio-context-close-requested', {
    details: {
      generation,
      reason,
      state: context?.state ?? 'none',
    },
  });
  node?.port.postMessage({ type: 'panic' });
  inputSource?.disconnect();
  inputStream?.getTracks().forEach((track) => track.stop());
  if (node) {
    node.port.onmessage = null;
    node.port.close();
  }
  if (context) {
    context.onstatechange = null;
  }
  node?.disconnect();
  analyser?.disconnect();
  outputGain?.disconnect();
  if (inputSourceRef.current === inputSource) inputSourceRef.current = null;
  if (inputStreamRef.current === inputStream) inputStreamRef.current = null;
  if (nodeRef.current === node) nodeRef.current = null;
  if (analyserRef.current === analyser) analyserRef.current = null;
  if (outputGainRef.current === outputGain) outputGainRef.current = null;
  if (contextRef.current === context) contextRef.current = null;

  try {
    if (context && context.state !== 'closed') await context.close();
    logDiagnosticEvent('audio-context-close-completed', {
      details: { generation, reason, state: context?.state ?? 'none' },
    });
  } catch (error) {
    logDiagnosticEvent('audio-context-close-error', {
      level: 'error',
      details: { generation, reason, error: serializeError(error) },
    });
  }
}

function parkAudioContext(
  contextRef: { current: AudioContext | null },
  nodeRef: { current: AudioWorkletNode | null },
  outputGainRef: { current: GainNode | null },
  inputSourceRef: { current: MediaStreamAudioSourceNode | null },
  inputStreamRef: { current: MediaStream | null },
  stopTimeoutRef: { current: number | null },
): void {
  stopTimeoutRef.current = null;
  nodeRef.current?.port.postMessage({ type: 'setMuted', payload: { muted: true } });
  inputSourceRef.current?.disconnect();
  inputStreamRef.current?.getTracks().forEach((track) => track.stop());
  outputGainRef.current?.gain.cancelScheduledValues(0);
  if (outputGainRef.current) {
    outputGainRef.current.gain.value = 0;
  }
  inputSourceRef.current = null;
  inputStreamRef.current = null;
  const context = contextRef.current;
  if (context && context.state !== 'closed') {
    // Muting alone still schedules the worklet and its CPU telemetry every block.
    void context.suspend().catch((error) => {
      logDiagnosticEvent('audio-context-suspend-error', {
        level: 'error',
        details: { error: serializeError(error) },
      });
    });
  }
}

function fadeAudioOutputIn(context: AudioContext, gain: GainNode): void {
  const now = context.currentTime;
  holdAudioParamAtCurrentValue(gain.gain, now);
  gain.gain.linearRampToValueAtTime(1, now + AUDIO_OUTPUT_FADE_SECONDS);
}

function fadeAudioOutputOut(context: AudioContext, gain: GainNode): void {
  const now = context.currentTime;
  gain.gain.cancelScheduledValues(now);
  gain.gain.setValueAtTime(1, now);
  gain.gain.linearRampToValueAtTime(0, now + AUDIO_OUTPUT_FADE_SECONDS);
}

function holdAudioParamAtCurrentValue(param: AudioParam, time: number): void {
  const holdableParam = param as AudioParam & {
    cancelAndHoldAtTime?: (cancelTime: number) => AudioParam;
  };
  if (typeof holdableParam.cancelAndHoldAtTime === 'function') {
    holdableParam.cancelAndHoldAtTime(time);
    return;
  }
  param.cancelScheduledValues(time);
  param.setValueAtTime(param.value, time);
}

export function useAudioEngine(options: UseAudioEngineOptions = {}): AudioEngineState {
  const selectedMidiInputDeviceIds = options.selectedMidiInputDeviceIds ?? [];
  const selectedMidiOutputDeviceIds = options.selectedMidiOutputDeviceIds ?? [];
  const midiClockOutputEnabled = options.midiClockOutputEnabled === true;
  const recordingPatchNameRef = useRef(options.recordingPatchName ?? 'untitled-patch');
  recordingPatchNameRef.current = options.recordingPatchName ?? 'untitled-patch';
  const selectedMidiInputDeviceKey = selectedMidiInputDeviceIds.join('\n');
  const selectedMidiInputDeviceIdSet = useMemo(() => new Set(selectedMidiInputDeviceIds), [selectedMidiInputDeviceKey]);
  const selectedMidiOutputDeviceKey = selectedMidiOutputDeviceIds.join('\n');
  const selectedMidiOutputDeviceIdSet = useMemo(() => new Set(selectedMidiOutputDeviceIds), [selectedMidiOutputDeviceKey]);
  const midiInputEnabled = selectedMidiInputDeviceIds.length > 0;
  const [status, setStatus] = useState<AudioStatus>('idle');
  const [message, setMessage] = useState('audio stopped');
  const [cpuLoad, setCpuLoad] = useState(0);
  const [cpuPeakLoad, setCpuPeakLoad] = useState(0);
  const [cpuDeadlineMisses, setCpuDeadlineMisses] = useState(0);
  const [rendering, setRendering] = useState({ mode: 'single', workers: 0, parallelRepeats: 0, reason: '' });
  const [peak, setPeak] = useState(0);
  const [linkMeters, setLinkMeters] = useState<Record<string, LinkMeterReading>>({});
  const [linkScopes, setLinkScopeReadings] = useState<Record<string, LinkScopeReading>>({});
  const [playheads, setPlayheads] = useState<Record<string, number[]>>({});
  const [buffers, setBuffers] = useState<Record<string, BufferVisualization>>({});
  const [recordingStatus, setRecordingStatus] = useState<RecordingStatus>('idle');
  const [recordingMessage, setRecordingMessage] = useState('recording stopped');
  const [recordingFileName, setRecordingFileName] = useState<string | null>(null);
  const [recordingElapsedSeconds, setRecordingElapsedSeconds] = useState(0);
  const [audioInputStatus, setAudioInputStatus] = useState<AudioInputStatus>('inactive');
  const [audioInputMessage, setAudioInputMessage] = useState('Add an AudioInput node, then start audio.');
  const [audioInputDevices, setAudioInputDevices] = useState<AudioInputDevice[]>([]);
  const [selectedAudioInputDeviceId, setSelectedAudioInputDeviceId] = useState('');
  const [midiInputStatus, setMidiInputStatus] = useState<MidiInputStatus>('inactive');
  const [midiInputMessage, setMidiInputMessage] = useState('Add a MIDI Note, MIDI CC, or MIDI Tempo source, then start audio.');
  const [midiInputDevices, setMidiInputDevices] = useState<MidiInputDevice[]>([]);
  const [midiOutputDevices, setMidiOutputDevices] = useState<MidiInputDevice[]>([]);
  const [lastMidiControlChange, setLastMidiControlChange] = useState<MidiControlChange | undefined>(undefined);
  const contextRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const parallelEngineRef = useRef<ParallelEngine | null>(null);
  const parallelEngineAbortRef = useRef<AbortController | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const outputGainRef = useRef<GainNode | null>(null);
  const inputSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const inputStreamRef = useRef<MediaStream | null>(null);
  const stopTimeoutRef = useRef<number | null>(null);
  const inputRequestIdRef = useRef(0);
  const inputRequestRef = useRef<AudioInputRequest | null>(null);
  const currentInputDeviceIdRef = useRef('');
  const midiAccessRef = useRef<MidiAccessLike | null>(null);
  const midiRequestRef = useRef<Promise<MidiAccessLike> | null>(null);
  const midiAccessRequestedRef = useRef(false);
  const midiClockOutputEnabledRef = useRef(midiClockOutputEnabled);
  midiClockOutputEnabledRef.current = midiClockOutputEnabled;
  const midiClockTickMsBySourceRef = useRef<Record<number, number>>({});
  const midiClockTempoBySourceRef = useRef<Record<number, number>>({});
  const midiClockOutputTimerRef = useRef<number | null>(null);
  const midiClockOutputRunningRef = useRef(false);
  const midiControlChangeIdRef = useRef(0);
  const meterFrameRef = useRef<number | null>(null);
  const lastAudibleAtRef = useRef(0);
  const lastSilenceReportAtRef = useRef(0);
  const lastAudioHealthReportAtRef = useRef(0);
  const graphRef = useRef<DspProgram | null>(null);
  const audioEngineRequestRef = useRef<Promise<void> | null>(null);
  const audioEngineCloseRef = useRef<Promise<void> | null>(null);
  const audioEngineGenerationRef = useRef(0);
  const audioActivationRequestedRef = useRef(false);
  const backendReadyRef = useRef(false);
  const lastSentProgramStructureRef = useRef<string | null>(null);
  const lastSentValuesRef = useRef<number[] | null>(null);
  const lastSentCustomWavePointsRef = useRef<string | null>(null);
  const lastSentSequencerConfigRef = useRef<string | null>(null);
  const activeScopeRequestsRef = useRef<ScopeCaptureRequest[]>([]);
  const sampleDataKeysRef = useRef<Record<string, string>>({});
  const sampleDataCacheRef = useRef<Record<string, SampleDataCacheEntry>>({});
  const sampleDataRequestRef = useRef<Record<string, SampleDataRequest>>({});
  const imageDataKeysRef = useRef<Record<string, string>>({});
  const imageDataCacheRef = useRef<Record<string, ImageDataCacheEntry>>({});
  const imageDataRequestRef = useRef<Record<string, ImageDataRequest>>({});
  const imageDataWorkletRef = useRef<AudioWorkletNode | null>(null);
  const recordingRequestedRef = useRef(false);
  const recordingCaptureRef = useRef<RecordingCapture | null>(null);
  const recordingSessionIdRef = useRef(0);
  const recordingSaveIdRef = useRef(0);
  const bufferSnapshotRequestIdRef = useRef(0);
  const bufferSnapshotRequestsRef = useRef(new Map<number, {
    resolve: (snapshot: BufferSnapshot | null) => void;
    timeout: number;
  }>());
  const bufferRestoresRef = useRef<Record<string, BufferSnapshot>>({});
  const pendingBufferClearsRef = useRef(new Set<string>());
  const pendingBufferCopiesRef = useRef(new Map<string, BufferCopy>());
  const recordingStartedAtRef = useRef(0);
  const recordingTimerRef = useRef<number | null>(null);

  const stopMeter = useCallback(() => {
    if (meterFrameRef.current !== null) {
      window.cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    lastAudibleAtRef.current = 0;
    lastSilenceReportAtRef.current = 0;
    lastAudioHealthReportAtRef.current = 0;
    setPeak(0);
    setCpuLoad(0);
  }, []);

  const sendMidiAllNotesOff = useCallback(() => {
    for (const [index, output] of [...(midiAccessRef.current?.outputs.values() ?? [])].entries()) {
      if (!selectedMidiOutputDeviceIdSet.has(midiDeviceFromPort(output, index, 'output').id)) continue;
      if (output.state === 'disconnected') continue;
      try {
        for (let channel = 0; channel < 16; channel += 1) {
          output.send([0xb0 | channel, 123, 0]);
        }
      } catch {
        // A device can disappear while playback is stopping.
      }
    }
  }, [selectedMidiOutputDeviceIdSet, selectedMidiOutputDeviceKey]);

  const closeAudioEngine = useCallback((reason: string): Promise<void> => {
    if (audioEngineCloseRef.current) return audioEngineCloseRef.current;

    backendReadyRef.current = false;
    parallelEngineAbortRef.current?.abort();
    parallelEngineAbortRef.current = null;
    const closingParallelEngine = parallelEngineRef.current;
    parallelEngineRef.current = null;
    lastSentProgramStructureRef.current = null;
    lastSentValuesRef.current = null;
    lastSentCustomWavePointsRef.current = null;
    lastSentSequencerConfigRef.current = null;
    sendMidiAllNotesOff();
    const closePromise = closeAudioContext(
      contextRef,
      nodeRef,
      analyserRef,
      outputGainRef,
      inputSourceRef,
      inputStreamRef,
      stopTimeoutRef,
      audioEngineGenerationRef.current,
      reason,
    );
    audioEngineCloseRef.current = closePromise;
    void closePromise.finally(() => {
      closingParallelEngine?.dispose();
      if (audioEngineCloseRef.current === closePromise) {
        audioEngineCloseRef.current = null;
      }
    });
    return closePromise;
  }, [sendMidiAllNotesOff]);

  const startMeter = useCallback(() => {
    stopMeter();
    const analyser = analyserRef.current;
    if (!analyser) return;

    const samples = new Float32Array(analyser.fftSize);
    let lastMeterUpdateAt = 0;
    const tick = (timestamp: number) => {
      analyser.getFloatTimeDomainData(samples);
      let nextPeak = 0;
      for (const sample of samples) {
        nextPeak = Math.max(nextPeak, Math.abs(sample));
      }
      if (
        contextRef.current?.state === 'running' &&
        audioActivationRequestedRef.current &&
        backendReadyRef.current
      ) {
        if (timestamp - lastAudioHealthReportAtRef.current >= AUDIO_HEALTH_REPORT_INTERVAL_MS) {
          lastAudioHealthReportAtRef.current = timestamp;
          logDiagnosticEvent('audio-health', {
            details: {
              generation: audioEngineGenerationRef.current,
              contextState: contextRef.current.state,
              contextTime: contextRef.current.currentTime,
              sampleRate: contextRef.current.sampleRate,
              peak: nextPeak,
              graph: dspProgramDiagnosticSnapshot(graphRef.current),
            },
          });
        }
        if (nextPeak > AUDIO_SILENCE_PEAK_THRESHOLD) {
          lastAudibleAtRef.current = timestamp;
        } else if (
          lastAudibleAtRef.current > 0 &&
          timestamp - lastAudibleAtRef.current >= AUDIO_UNEXPECTED_SILENCE_MS &&
          timestamp - lastSilenceReportAtRef.current >= AUDIO_SILENCE_REPORT_INTERVAL_MS
        ) {
          lastSilenceReportAtRef.current = timestamp;
          logDiagnosticEvent('audio-output-silent-after-signal', {
            details: {
              generation: audioEngineGenerationRef.current,
              contextState: contextRef.current.state,
              mutedByUi: !audioActivationRequestedRef.current,
              lastAudibleAgoMs: Math.round(timestamp - lastAudibleAtRef.current),
              peak: nextPeak,
              graph: dspProgramDiagnosticSnapshot(graphRef.current),
            },
          });
        }
      }
      if (timestamp - lastMeterUpdateAt >= METER_UPDATE_INTERVAL_MS) {
        lastMeterUpdateAt = timestamp;
        setPeak(nextPeak);
      }
      meterFrameRef.current = window.requestAnimationFrame(tick);
    };
    meterFrameRef.current = window.requestAnimationFrame(tick);
  }, [stopMeter]);

  const stopRecordingTimer = useCallback(() => {
    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    recordingStartedAtRef.current = 0;
  }, []);

  const appendRecordingChunk = useCallback((payload: unknown) => {
    if (!isRecord(payload)) return;
    const id = Number(payload.id);
    const capture = recordingCaptureRef.current;
    if (!capture || capture.id !== id) return;

    const chunk = recordingChunkFromPayload(payload, capture.channelCount);
    if (!chunk) return;

    capture.chunks.push(chunk);
    capture.frames += chunk[0]?.length ?? 0;
  }, []);

  const completeRecordingCapture = useCallback((id: number) => {
    const capture = recordingCaptureRef.current;
    if (!capture || capture.id !== id) return;

    recordingCaptureRef.current = null;
    const saveId = recordingSaveIdRef.current + 1;
    recordingSaveIdRef.current = saveId;
    const wavBlob = encodeWav(capture.chunks, capture.sampleRate, capture.channelCount);
    logDiagnosticEvent('audio-recording-stopped', {
      details: {
        chunks: capture.chunks.length,
        frames: capture.frames,
        sampleRate: capture.sampleRate,
        channelCount: capture.channelCount,
        bytes: wavBlob.size,
      },
    });
    setRecordingElapsedSeconds(Math.floor(capture.frames / Math.max(1, capture.sampleRate)));
    setRecordingStatus('saving');
    setRecordingMessage('saving recording');

    void uploadRecording(wavBlob, capture.patchName, capture.sampleEvents).then((result) => {
      if (recordingSaveIdRef.current !== saveId) return;
      setRecordingStatus('saved');
      setRecordingMessage(`saved ${result.name}`);
      setRecordingFileName(result.name);
    }).catch((error) => {
      if (recordingSaveIdRef.current !== saveId) return;
      setRecordingStatus('error');
      setRecordingMessage(error instanceof Error ? error.message : 'recording save failed');
    });
  }, []);

  const beginRecordingCapture = useCallback((context: AudioContext, node: AudioWorkletNode) => {
    if (
      recordingCaptureRef.current ||
      !audioActivationRequestedRef.current ||
      context.state !== 'running'
    ) return;

    const id = recordingSessionIdRef.current;
    const chunks: Float32Array[][] = [];
    recordingCaptureRef.current = {
      id,
      patchName: recordingPatchNameRef.current,
      chunks,
      channelCount: RECORDING_CHANNEL_COUNT,
      sampleRate: context.sampleRate,
      frames: 0,
      stopping: false,
      sampleEvents: [],
    };
    node.port.postMessage({
      type: 'startRecording',
      payload: {
        id,
        channelCount: RECORDING_CHANNEL_COUNT,
        chunkFrames: RECORDING_CHUNK_FRAMES,
      },
    });
    logDiagnosticEvent('audio-recording-started', {
      details: {
        id,
        sampleRate: context.sampleRate,
        channelCount: RECORDING_CHANNEL_COUNT,
      },
    });
    stopRecordingTimer();
    recordingStartedAtRef.current = performance.now();
    setRecordingElapsedSeconds(0);
    recordingTimerRef.current = window.setInterval(() => {
      setRecordingElapsedSeconds(Math.floor((performance.now() - recordingStartedAtRef.current) / 1000));
    }, 250);
    setRecordingStatus('recording');
    setRecordingMessage('recording audio');
    setRecordingFileName(null);
  }, [stopRecordingTimer]);

  const finishRecordingCapture = useCallback(() => {
    recordingRequestedRef.current = false;
    stopRecordingTimer();
    const capture = recordingCaptureRef.current;
    if (!capture) {
      setRecordingStatus('idle');
      setRecordingMessage('recording stopped');
      setRecordingElapsedSeconds(0);
      return;
    }

    if (capture.stopping) return;

    capture.stopping = true;
    setRecordingStatus('saving');
    setRecordingMessage('finalizing recording');
    const node = nodeRef.current;
    if (node && contextRef.current?.state !== 'closed') {
      node.port.postMessage({ type: 'stopRecording', payload: { id: capture.id } });
      return;
    }

    completeRecordingCapture(capture.id);
  }, [completeRecordingCapture, stopRecordingTimer]);

  const startRecording = useCallback(() => {
    if (recordingCaptureRef.current) {
      setRecordingStatus('saving');
      setRecordingMessage('finalizing recording');
      return;
    }
    recordingSessionIdRef.current += 1;
    recordingSaveIdRef.current += 1;
    recordingRequestedRef.current = true;
    setRecordingFileName(null);
    setRecordingElapsedSeconds(0);
    const context = contextRef.current;
    const node = nodeRef.current;
    if (audioActivationRequestedRef.current && context?.state === 'running' && node) {
      beginRecordingCapture(context, node);
      return;
    }

    setRecordingStatus('waiting');
    setRecordingMessage('waiting for audio to start');
  }, [beginRecordingCapture]);

  const stopRecording = useCallback(() => {
    finishRecordingCapture();
  }, [finishRecordingCapture]);

  const refreshAudioInputDevices = useCallback(async () => {
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.enumerateDevices) {
      setAudioInputDevices((current) => current.length === 0 ? current : []);
      return;
    }

    try {
      const devices = await mediaDevices.enumerateDevices();
      const audioInputs = devices
        .filter((device) => device.kind === 'audioinput')
        .map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Input ${index + 1}`,
        }));
      setAudioInputDevices(audioInputs);
      setSelectedAudioInputDeviceId((current) => {
        if (!current) return current;
        return audioInputs.some((device) => device.deviceId === current) ? current : '';
      });
    } catch {
      setAudioInputDevices((current) => current.length === 0 ? current : []);
    }
  }, []);

  const disconnectAudioInput = useCallback((nextStatus: AudioInputStatus = 'inactive', nextMessage = 'Audio input is not used by this patch.') => {
    inputRequestIdRef.current += 1;
    inputRequestRef.current = null;
    inputSourceRef.current?.disconnect();
    inputStreamRef.current?.getTracks().forEach((track) => track.stop());
    inputSourceRef.current = null;
    inputStreamRef.current = null;
    currentInputDeviceIdRef.current = '';
    setAudioInputStatus(nextStatus);
    setAudioInputMessage(nextMessage);
  }, []);

  const sendMidiClockMessage = useCallback((message: number, force = false) => {
    if (!force && !midiClockOutputEnabledRef.current) return;
    for (const [index, output] of [...(midiAccessRef.current?.outputs.values() ?? [])].entries()) {
      if (!selectedMidiOutputDeviceIdSet.has(midiDeviceFromPort(output, index, 'output').id)) continue;
      if (output.state === 'disconnected') continue;
      try {
        output.send([message]);
      } catch {
        // A device can disappear between enumeration and send; state changes refresh on the next MIDI event.
      }
    }
  }, [selectedMidiOutputDeviceIdSet, selectedMidiOutputDeviceKey]);

  const sendMidiOutputEvents = useCallback((events: unknown) => {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      const noteOn = event?.noteOn === true;
      const channel = clampMidiInteger(event?.channel, 1, 16);
      if (event?.isCc === true) {
        const cc = clampMidiInteger(event?.cc, 0, 127);
        const value = clampMidiInteger(Number(event?.value) * 127, 0, 127);
        const status = 0xb0 | (channel - 1);
        for (const [index, output] of [...(midiAccessRef.current?.outputs.values() ?? [])].entries()) {
          if (!selectedMidiOutputDeviceIdSet.has(midiDeviceFromPort(output, index, 'output').id)) continue;
          if (output.state === 'disconnected') continue;
          try {
            output.send([status, cc, value]);
          } catch {
            // A device can disappear between audio rendering and MIDI dispatch.
          }
        }
        continue;
      }
      const note = clampMidiInteger(event?.note, 0, 127);
      const velocity = clampMidiInteger(Number(event?.velocity) * 127, 0, 127);
      const status = (noteOn ? 0x90 : 0x80) | (channel - 1);
      for (const [index, output] of [...(midiAccessRef.current?.outputs.values() ?? [])].entries()) {
        if (!selectedMidiOutputDeviceIdSet.has(midiDeviceFromPort(output, index, 'output').id)) continue;
        if (output.state === 'disconnected') continue;
        try {
          output.send([status, note, velocity]);
        } catch {
          // A device can disappear between audio rendering and MIDI dispatch.
        }
      }
    }
  }, [selectedMidiOutputDeviceIdSet, selectedMidiOutputDeviceKey]);

  const stopMidiClockOutput = useCallback((sendStop = true) => {
    if (midiClockOutputTimerRef.current !== null) {
      window.clearTimeout(midiClockOutputTimerRef.current);
      midiClockOutputTimerRef.current = null;
    }
    const wasRunning = midiClockOutputRunningRef.current;
    midiClockOutputRunningRef.current = false;
    if (sendStop && wasRunning) sendMidiClockMessage(0xfc, true);
  }, [sendMidiClockMessage]);

  const startMidiClockOutput = useCallback((sendStart = true) => {
    const graph = graphRef.current;
    if (!midiClockOutputEnabledRef.current || !programHasTempo(graph)) return;

    stopMidiClockOutput(false);
    midiClockOutputRunningRef.current = true;
    if (sendStart) sendMidiClockMessage(0xfa);

    const scheduleNextTick = () => {
      if (!midiClockOutputRunningRef.current) return;
      const currentGraph = graphRef.current;
      const clock = midiClockOutputTempo(currentGraph);
      // A MIDI-sourced Tempo is forwarded directly from its input handler, preserving its timing.
      if (!clock || clock.source === 'midi') return;
      sendMidiClockMessage(0xf8);
      const delayMs = 60_000 / (clock.bpm * MIDI_CLOCK_TICKS_PER_BEAT);
      midiClockOutputTimerRef.current = window.setTimeout(scheduleNextTick, delayMs);
    };
    scheduleNextTick();
  }, [sendMidiClockMessage, stopMidiClockOutput]);

  const updateMidiInputDevices = useCallback((midiAccess: MidiAccessLike): MidiInputDevice[] => {
    const inputs = [...midiAccess.inputs.values()];
    const devices = inputs.map(midiInputDeviceFromInput);
    setMidiInputDevices((current) => midiInputDevicesEqual(current, devices) ? current : devices);
    const outputs = [...midiAccess.outputs.values()].map((output, index) => midiDeviceFromPort(output, index, 'output'));
    setMidiOutputDevices((current) => midiInputDevicesEqual(current, outputs) ? current : outputs);
    return devices;
  }, []);

  const disconnectMidiInput = useCallback((nextStatus: MidiInputStatus = 'inactive', nextMessage = 'MIDI input is not used by this patch.') => {
    stopMidiClockOutput();
    const midiAccess = midiAccessRef.current;
    if (midiAccess) {
      midiAccess.onstatechange = null;
      for (const input of midiAccess.inputs.values()) {
        input.onmidimessage = null;
      }
    }
    midiAccessRef.current = null;
    midiRequestRef.current = null;
    setMidiInputDevices((current) => current.length === 0 ? current : []);
    setMidiOutputDevices((current) => current.length === 0 ? current : []);
    setMidiInputStatus(nextStatus);
    setMidiInputMessage(nextMessage);
  }, [stopMidiClockOutput]);

  const attachMidiInputs = useCallback((midiAccess: MidiAccessLike, node: AudioWorkletNode | null) => {
    const devices = updateMidiInputDevices(midiAccess);
    const outputCount = [...midiAccess.outputs.values()].length;
    const selectedConnectedCount = devices.filter((device) => selectedMidiInputDeviceIdSet.has(device.id)).length;
    setMidiInputStatus(devices.length + outputCount > 0 ? 'connected' : 'unsupported');
    setMidiInputMessage(midiInputStatusMessage(devices.length, outputCount, selectedMidiInputDeviceIds.length, selectedConnectedCount));

    const handleMidiClock = (sourceIndex: number, event: { timeStamp?: number }) => {
      const graph = graphRef.current;
      if (!node || !programUsesMidiClock(graph)) return;

      const activeSources = activeMidiClockSourceIndexes(graph);
      if (activeSources.size > 0 && !activeSources.has(0) && !activeSources.has(sourceIndex)) return;

      const now = Number.isFinite(event.timeStamp) ? Number(event.timeStamp) : performance.now();
      const previous = midiClockTickMsBySourceRef.current[sourceIndex];
      midiClockTickMsBySourceRef.current[sourceIndex] = now;
      if (!Number.isFinite(previous) || previous <= 0 || now <= previous) return;

      const intervalMs = now - previous;
      const measuredBpm = 60_000 / (intervalMs * MIDI_CLOCK_TICKS_PER_BEAT);
      if (!Number.isFinite(measuredBpm)) return;

      const previousTempo = midiClockTempoBySourceRef.current[sourceIndex] || measuredBpm;
      const bpm = clampNumber(
        previousTempo + (measuredBpm - previousTempo) * MIDI_CLOCK_EMA_WEIGHT,
        MIDI_CLOCK_TEMPO_MIN,
        MIDI_CLOCK_TEMPO_MAX,
      );
      midiClockTempoBySourceRef.current[sourceIndex] = bpm;
      node.port.postMessage({ type: 'midiClockTempo', payload: { sourceIndex, bpm } });
    };

    const handleMidiMessage = (sourceIndex: number, event: { data: ArrayLike<number>; timeStamp?: number }) => {
      const status = Number(event.data[0] ?? 0);
      if (status === 0xf8) {
        handleMidiClock(sourceIndex, event);
        const clock = midiClockOutputTempo(graphRef.current);
        if (midiClockOutputRunningRef.current && clock?.source === 'midi' && (clock.sourceIndex === 0 || clock.sourceIndex === sourceIndex)) {
          sendMidiClockMessage(0xf8);
        }
        return;
      }
      if (status === 0xfa || status === 0xfb || status === 0xfc) {
        delete midiClockTickMsBySourceRef.current[sourceIndex];
        delete midiClockTempoBySourceRef.current[sourceIndex];
        return;
      }
      const data1 = Number(event.data[1] ?? 0);
      const data2 = Number(event.data[2] ?? 0);
      const command = status & 0xf0;
      const channel = (status & 0x0f) + 1;
      if (command === 0x90 && data2 > 0) {
        node?.port.postMessage({ type: 'noteOn', payload: { channel, note: data1, velocity: data2 / 127 } });
        return;
      }
      if (command === 0x80 || (command === 0x90 && data2 === 0)) {
        node?.port.postMessage({ type: 'noteOff', payload: { channel, note: data1 } });
        return;
      }
      if (command === 0xb0) {
        const value = data2 / 127;
        setLastMidiControlChange({
          id: midiControlChangeIdRef.current + 1,
          sourceIndex,
          channel,
          cc: data1,
          value,
          receivedAt: Number.isFinite(event.timeStamp) ? Number(event.timeStamp) : performance.now(),
        });
        midiControlChangeIdRef.current += 1;
        node?.port.postMessage({ type: 'midiCc', payload: { channel, cc: data1, value } });
      }
    };

    for (const [index, input] of [...midiAccess.inputs.values()].entries()) {
      const sourceIndex = index + 1;
      const device = midiInputDeviceFromInput(input, index);
      input.onmidimessage = selectedMidiInputDeviceIdSet.has(device.id)
        ? (event) => handleMidiMessage(sourceIndex, event)
        : null;
    }
    midiAccess.onstatechange = () => attachMidiInputs(
      midiAccess,
      graphRef.current && programUsesMidi(graphRef.current) ? nodeRef.current : null,
    );
    if (midiClockOutputRunningRef.current) startMidiClockOutput(false);
  }, [selectedMidiInputDeviceIdSet, selectedMidiInputDeviceIds.length, selectedMidiInputDeviceKey, sendMidiClockMessage, startMidiClockOutput, updateMidiInputDevices]);

  const refreshMidiInputDevices = useCallback(async () => {
    const navigatorWithMidi = navigator as Navigator & {
      requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<unknown>;
    };
    if (!navigatorWithMidi.requestMIDIAccess) {
      setMidiInputDevices((current) => current.length === 0 ? current : []);
      setMidiOutputDevices((current) => current.length === 0 ? current : []);
      setMidiInputStatus('unsupported');
      setMidiInputMessage('MIDI input is unavailable in this browser.');
      return;
    }

    midiAccessRequestedRef.current = true;
    if (midiAccessRef.current) {
      attachMidiInputs(
        midiAccessRef.current,
        graphRef.current && programUsesMidi(graphRef.current) ? nodeRef.current : null,
      );
      return;
    }

    setMidiInputStatus('requesting');
    setMidiInputMessage('Requesting MIDI permission...');
    try {
      const midiAccess = await navigatorWithMidi.requestMIDIAccess({ sysex: false }) as MidiAccessLike;
      midiAccessRef.current = midiAccess;
      attachMidiInputs(
        midiAccess,
        graphRef.current && programUsesMidi(graphRef.current) ? nodeRef.current : null,
      );
    } catch (error) {
      setMidiInputStatus(error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError') ? 'denied' : 'error');
      setMidiInputMessage(error instanceof Error ? error.message : 'MIDI permission was denied.');
      setMidiInputDevices((current) => current.length === 0 ? current : []);
      setMidiOutputDevices((current) => current.length === 0 ? current : []);
    }
  }, [attachMidiInputs]);

  const syncAudioInput = useCallback((graph: DspProgram, context: AudioContext, node: AudioWorkletNode) => {
    if (!programUsesAudioInput(graph)) {
      disconnectAudioInput();
      return;
    }

    if (inputSourceRef.current && currentInputDeviceIdRef.current === selectedAudioInputDeviceId) return;
    if (inputSourceRef.current) {
      disconnectAudioInput('requesting', 'Switching audio input device...');
    }

    const pendingRequest = inputRequestRef.current;
    if (
      pendingRequest
      && pendingRequest.deviceId === selectedAudioInputDeviceId
      && pendingRequest.context === context
      && pendingRequest.node === node
    ) {
      return;
    }

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.getUserMedia) {
      setAudioInputStatus('unsupported');
      setAudioInputMessage('Audio input is unavailable in this browser.');
      setMessage('audio input unavailable: this browser does not expose getUserMedia');
      return;
    }

    setAudioInputStatus('requesting');
    setAudioInputMessage(selectedAudioInputDeviceId
      ? `Requesting ${audioInputDeviceLabel(audioInputDevices, selectedAudioInputDeviceId)}...`
      : 'Requesting microphone permission...');
    const requestId = inputRequestIdRef.current + 1;
    inputRequestIdRef.current = requestId;
    inputRequestRef.current = {
      id: requestId,
      deviceId: selectedAudioInputDeviceId,
      context,
      node,
    };
    const audioConstraints: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(selectedAudioInputDeviceId ? { deviceId: { exact: selectedAudioInputDeviceId } } : {}),
    };
    void mediaDevices.getUserMedia({
      audio: audioConstraints,
    }).then((stream) => {
      if (inputRequestRef.current?.id === requestId) {
        inputRequestRef.current = null;
      }
      const stillCurrent = (
        inputRequestIdRef.current === requestId &&
        contextRef.current === context &&
        nodeRef.current === node &&
        graphRef.current &&
        programUsesAudioInput(graphRef.current)
      );
      if (!stillCurrent) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const source = context.createMediaStreamSource(stream);
      source.connect(node);
      inputStreamRef.current = stream;
      inputSourceRef.current = source;
      const track = stream.getAudioTracks()[0] ?? null;
      track?.addEventListener('ended', () => {
        logDiagnosticEvent('audio-input-track-ended', {
          level: 'warn',
          details: {
            label: track.label,
            readyState: track.readyState,
            settings: track.getSettings(),
          },
        });
      });
      const connectedDeviceId = track?.getSettings().deviceId ?? selectedAudioInputDeviceId;
      currentInputDeviceIdRef.current = selectedAudioInputDeviceId;
      setAudioInputStatus('connected');
      setAudioInputMessage(`${track?.label || audioInputDeviceLabel(audioInputDevices, connectedDeviceId) || 'Audio input'} connected.`);
      void refreshAudioInputDevices();
      setMessage(`WASM audio ${context.state} (${AUDIO_WASM_ASSET_VERSION})`);
    }).catch((error) => {
      logDiagnosticEvent('audio-input-error', {
        level: 'warn',
        details: {
          error: serializeError(error),
        },
      });
      if (inputRequestIdRef.current !== requestId) return;
      if (inputRequestRef.current?.id === requestId) {
        inputRequestRef.current = null;
      }
      const errorName = error instanceof DOMException ? error.name : '';
      if (errorName === 'NotAllowedError' || errorName === 'SecurityError') {
        setAudioInputStatus('denied');
        setAudioInputMessage('Microphone permission was denied. Allow microphone access for this site and try again.');
      } else if (errorName === 'NotFoundError' || errorName === 'DevicesNotFoundError') {
        setAudioInputStatus('unsupported');
        setAudioInputMessage('No microphone or audio input device was found.');
      } else if (errorName === 'OverconstrainedError') {
        setAudioInputStatus('error');
        setAudioInputMessage('The selected input device is unavailable. Choose another input.');
        setSelectedAudioInputDeviceId('');
      } else {
        setAudioInputStatus('error');
        setAudioInputMessage(error instanceof Error ? error.message : 'Audio input failed.');
      }
      void refreshAudioInputDevices();
      setMessage(`audio input unavailable: ${error instanceof Error ? error.message : 'permission denied'}`);
    });
  }, [audioInputDevices, disconnectAudioInput, refreshAudioInputDevices, selectedAudioInputDeviceId]);

  const syncGraphSamples = useCallback((graph: DspProgram, context: AudioContext, node: AudioWorkletNode) => {
    const nextKeys: Record<string, string> = {};
    const bindingsBySampleKey = new Map<string, typeof graph.sampleBindings>();

    for (const binding of graph.sampleBindings) {
      const sampleUrl = binding.sample.url.trim();
      if (!sampleUrl) continue;

      const sampleName = binding.sample.name;
      // The URL identifies the actual audio resource; a display-name change
      // must not cause another fetch, decode, transfer, or WASM allocation.
      const sampleKey = sampleUrl;
      nextKeys[binding.nodeId] = sampleKey;
      const bindings = bindingsBySampleKey.get(sampleKey) ?? [];
      bindings.push(binding);
      bindingsBySampleKey.set(sampleKey, bindings);
    }

    for (const [sampleKey, bindings] of bindingsBySampleKey) {
      const [owner, ...aliases] = bindings;
      if (!owner) continue;
      const sampleUrl = owner.sample.url.trim();
      const sampleName = owner.sample.name;
      const needsUpload = bindings.some((binding) => sampleDataKeysRef.current[binding.nodeId] !== sampleKey);
      if (!needsUpload) continue;

      for (const binding of bindings) sampleDataKeysRef.current[binding.nodeId] = sampleKey;
      void loadAndPostSampleData(
        context,
        node,
        owner.nodeId,
        sampleUrl,
        sampleName,
        sampleKey,
        sampleDataKeysRef,
        sampleDataCacheRef,
        sampleDataRequestRef,
      ).then((entry) => {
        if (!entry) return;
        for (const binding of aliases) {
          if (sampleDataKeysRef.current[binding.nodeId] !== sampleKey) continue;
          postSampleReference(node, binding.nodeId, entry);
        }
      })
        .catch(() => {
          for (const binding of bindings) {
            if (sampleDataKeysRef.current[binding.nodeId] === sampleKey) {
              delete sampleDataKeysRef.current[binding.nodeId];
            }
          }
        });
    }

    for (const nodeId of Object.keys(sampleDataKeysRef.current)) {
      if (nextKeys[nodeId]) continue;
      delete sampleDataKeysRef.current[nodeId];
      node.port.postMessage({ type: 'sampleData', payload: { nodeId, data: [], sampleRate: context.sampleRate, name: '', storageKey: '' } });
    }
  }, []);

  const preloadGraphSamples = useCallback((graph: DspProgram) => {
    const nextKeys: Record<string, string> = {};

    for (const binding of graph.sampleBindings) {
      const sampleUrl = binding.sample.url.trim();
      if (!sampleUrl) continue;

      const sampleName = binding.sample.name;
      const sampleKey = sampleUrl;
      nextKeys[binding.nodeId] = sampleKey;
      void loadCachedSampleData(
        binding.nodeId,
        sampleUrl,
        sampleName,
        sampleKey,
        sampleDataCacheRef,
        sampleDataRequestRef,
      ).catch(() => undefined);
    }

    const activeSampleKeys = new Set(Object.values(nextKeys));
    for (const sampleKey of Object.keys(sampleDataCacheRef.current)) {
      if (activeSampleKeys.has(sampleKey)) continue;
      delete sampleDataCacheRef.current[sampleKey];
    }
    for (const sampleKey of Object.keys(sampleDataRequestRef.current)) {
      if (activeSampleKeys.has(sampleKey)) continue;
      delete sampleDataRequestRef.current[sampleKey];
    }
  }, []);

  const syncGraphImages = useCallback((graph: DspProgram, node: AudioWorkletNode) => {
    // The cache records delivery to a particular worklet, not merely that the
    // image was decoded once. A recreated AudioContext starts with blank WASM
    // image slots and must receive the bytes again.
    if (imageDataWorkletRef.current !== node) {
      imageDataWorkletRef.current = node;
      imageDataKeysRef.current = {};
    }
    const nextKeys: Record<string, string> = {};
    for (const binding of graph.imageBindings) {
      const imageUrl = binding.image.url.trim();
      if (!imageUrl) continue;
      const key = `${imageUrl}\n${binding.image.name}`;
      nextKeys[binding.nodeId] = key;
      if (imageDataKeysRef.current[binding.nodeId] === key) continue;
      imageDataKeysRef.current[binding.nodeId] = key;
      void loadAndPostImageData(binding.nodeId, imageUrl, binding.image.name, key, node, imageDataCacheRef, imageDataRequestRef)
        .catch(() => {
          if (imageDataKeysRef.current[binding.nodeId] === key) delete imageDataKeysRef.current[binding.nodeId];
        });
    }
    for (const nodeId of Object.keys(imageDataKeysRef.current)) {
      if (nextKeys[nodeId]) continue;
      delete imageDataKeysRef.current[nodeId];
      node.port.postMessage({ type: 'imageData', payload: { nodeId, data: new Uint8Array(), width: 0, height: 0, name: '' } });
    }
  }, []);

  const preloadGraphImages = useCallback((graph: DspProgram) => {
    const nextKeys: Record<string, string> = {};
    for (const binding of graph.imageBindings) {
      const imageUrl = binding.image.url.trim();
      if (!imageUrl) continue;
      const key = `${imageUrl}\n${binding.image.name}`;
      nextKeys[binding.nodeId] = key;
      void loadCachedImageData(binding.nodeId, imageUrl, binding.image.name, key, imageDataCacheRef, imageDataRequestRef).catch(() => undefined);
    }
    for (const nodeId of Object.keys(imageDataCacheRef.current)) {
      if (nextKeys[nodeId] !== imageDataCacheRef.current[nodeId]?.key) delete imageDataCacheRef.current[nodeId];
    }
  }, []);

  const syncMidiInput = useCallback((graph: DspProgram, node: AudioWorkletNode) => {
    if (!programUsesMidi(graph) && !midiInputEnabled && !midiClockOutputEnabled && !midiAccessRequestedRef.current) {
      disconnectMidiInput();
      return;
    }

    const navigatorWithMidi = navigator as Navigator & {
      requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<unknown>;
    };
    if (!navigatorWithMidi.requestMIDIAccess) {
      setMidiInputStatus('unsupported');
      setMidiInputDevices((current) => current.length === 0 ? current : []);
      setMidiOutputDevices((current) => current.length === 0 ? current : []);
      setMidiInputMessage('MIDI input is unavailable in this browser.');
      setMessage('MIDI input unavailable: this browser does not expose Web MIDI');
      return;
    }

    if (midiAccessRef.current) {
      attachMidiInputs(midiAccessRef.current, node);
      return;
    }

    if (!midiRequestRef.current) {
      setMidiInputStatus('requesting');
      setMidiInputMessage('Requesting MIDI permission...');
      midiRequestRef.current = navigatorWithMidi
        .requestMIDIAccess({ sysex: false })
        .then((midiAccess) => midiAccess as MidiAccessLike);
    }

    const midiRequest = midiRequestRef.current as Promise<MidiAccessLike>;
    void midiRequest.then((midiAccess) => {
      midiAccessRef.current = midiAccess;
      attachMidiInputs(midiAccess, node);
    }).catch((error) => {
      setMidiInputStatus(error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError') ? 'denied' : 'error');
      setMidiInputMessage(error instanceof Error ? error.message : 'MIDI permission was denied.');
      setMidiInputDevices((current) => current.length === 0 ? current : []);
      setMidiOutputDevices((current) => current.length === 0 ? current : []);
      setMessage(`MIDI input unavailable: ${error instanceof Error ? error.message : 'permission denied'}`);
      midiRequestRef.current = null;
    });
  }, [attachMidiInputs, disconnectMidiInput, midiClockOutputEnabled, midiInputEnabled]);

  const activateAudioEngine = useCallback(async () => {
    const context = contextRef.current;
    const node = nodeRef.current;
    const outputGain = outputGainRef.current;
    const analyser = analyserRef.current;
    if (!context || !node || !outputGain) return;

    if (!audioActivationRequestedRef.current) return;
    logDiagnosticEvent('audio-activation-requested', {
      details: {
        generation: audioEngineGenerationRef.current,
        contextState: context.state,
        graph: dspProgramDiagnosticSnapshot(graphRef.current),
      },
    });
    await resumeAudioContext(context);
    if (!audioActivationRequestedRef.current || contextRef.current !== context) {
      if (context.state !== 'closed') await context.suspend();
      return;
    }
    node.port.postMessage({ type: 'setMuted', payload: { muted: false } });
    fadeAudioOutputIn(context, outputGain);

    if (graphRef.current) {
      syncGraphSamples(graphRef.current, context, node);
      syncGraphImages(graphRef.current, node);
      syncAudioInput(graphRef.current, context, node);
      syncMidiInput(graphRef.current, node);
    }

    setStatus(context.state === 'running' ? 'running' : 'idle');
    setMessage(`audio context ${context.state}`);
    if (context.state === 'running') {
      logDiagnosticEvent('audio-context-running', {
        details: {
          generation: audioEngineGenerationRef.current,
          sampleRate: context.sampleRate,
          baseLatency: context.baseLatency,
          outputLatency: audioContextOutputLatency(context),
          graph: dspProgramDiagnosticSnapshot(graphRef.current),
        },
      });
      startMeter();
      if (recordingRequestedRef.current && node) {
        beginRecordingCapture(context, node);
      }
    }
  }, [beginRecordingCapture, startMeter, syncAudioInput, syncGraphImages, syncGraphSamples, syncMidiInput]);

  const ensureAudioEngine = useCallback(async (activate: boolean) => {
    if (stopTimeoutRef.current !== null) {
      window.clearTimeout(stopTimeoutRef.current);
      stopTimeoutRef.current = null;
    }

    if (activate) {
      audioActivationRequestedRef.current = true;
      setStatus('starting');
      setMessage(backendReadyRef.current ? 'starting audio' : 'preparing audio');
    }

    if (audioEngineCloseRef.current) {
      await audioEngineCloseRef.current;
    }

    if (nodeRef.current && contextRef.current) {
      if (activate) {
        await activateAudioEngine();
      }
      return;
    }

    if (!audioEngineRequestRef.current) {
      audioEngineRequestRef.current = (async () => {
        try {
          if (!activate) {
            setMessage('preparing audio');
          }

          backendReadyRef.current = false;
          const context = new AudioContext();
          const generation = audioEngineGenerationRef.current + 1;
          audioEngineGenerationRef.current = generation;
          contextRef.current = context;
          await context.suspend();
          logDiagnosticEvent('audio-context-created', {
            details: {
              generation,
              sampleRate: context.sampleRate,
              baseLatency: context.baseLatency,
              outputLatency: audioContextOutputLatency(context),
              state: context.state,
            },
          });
          const wasmBytes = await loadCompatibleWasmBytes(AUDIO_ENGINE_CONFIG.rendering.mode !== 'multi');
          let parallelFallbackReason = '';
          if (AUDIO_ENGINE_CONFIG.rendering.mode === 'multi') {
            const abort = new AbortController();
            parallelEngineAbortRef.current = abort;
            try {
              const parallelEngine = await createParallelEngine(AUDIO_ENGINE_CONFIG.rendering.workers, abort.signal, (error) => {
                if (audioEngineGenerationRef.current !== generation || contextRef.current !== context) return;
                setStatus('error');
                setMessage(error);
                void closeAudioEngine('parallel-worker-error');
              });
              if (abort.signal.aborted) {
                parallelEngine.dispose();
                abort.signal.throwIfAborted();
              }
              parallelEngineRef.current = parallelEngine;
            } catch (error) {
              if (abort.signal.aborted) throw error;
              parallelFallbackReason = error instanceof Error ? error.message : String(error);
              logDiagnosticEvent('audio-parallel-fallback', { level: 'warn', details: { reason: parallelFallbackReason } });
            }
          }
          await context.audioWorklet.addModule(WORKLET_URL);
          const analyser = context.createAnalyser();
          analyser.fftSize = 1024;
          const outputGain = context.createGain();
          outputGain.gain.value = 0;
          const createNode = (parallelEngine: ParallelEngine['processorOptions'] | undefined, fallbackReason: string) => new AudioWorkletNode(context, 'teia-wasm-engine', {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [2],
            processorOptions: {
              wasmBytes, audioConfig: AUDIO_ENGINE_CONFIG,
              parallelEngine,
              parallelFallbackReason: fallbackReason,
            },
          });
          let node: AudioWorkletNode;
          try {
            node = createNode(parallelEngineRef.current?.processorOptions, parallelFallbackReason);
          } catch (error) {
            if (!parallelEngineRef.current) throw error;
            parallelEngineRef.current.dispose();
            parallelEngineRef.current = null;
            parallelFallbackReason = error instanceof Error ? error.message : String(error);
            node = createNode(undefined, parallelFallbackReason);
          }
          setCpuPeakLoad(0);
          setCpuDeadlineMisses(0);
          postBufferRestores(node, bufferRestoresRef.current);
          const pendingBufferCopies = [...pendingBufferCopiesRef.current.values()];
          pendingBufferCopiesRef.current.clear();
          postBufferCopies(node, pendingBufferCopies);
          postBufferClears(node, [...pendingBufferClearsRef.current]);
          pendingBufferClearsRef.current.clear();
          node.addEventListener('processorerror', () => {
            logDiagnosticEvent('audio-worklet-processor-error', {
              level: 'error',
              details: {
                generation,
                contextState: context.state,
                graph: dspProgramDiagnosticSnapshot(graphRef.current),
              },
            });
            void closeAudioEngine('processor-error');
          });

          node.port.onmessage = (event) => {
            if (contextRef.current !== context) return;
            const { type, payload } = event.data || {};
            if (type === 'renderingStatus') {
              setRendering({
                mode: payload?.mode === 'multi' ? 'multi' : 'single',
                workers: Number(payload?.workers) || 0,
                parallelRepeats: Number(payload?.parallelRepeats) || 0,
                reason: String(payload?.reason || ''),
              });
              if (payload?.mode !== 'multi') {
                parallelEngineRef.current?.dispose();
                parallelEngineRef.current = null;
              }
              logDiagnosticEvent('audio-rendering-mode', { details: payload });
              return;
            }
            if (type === 'parallelFailure') {
              setStatus('error');
              setMessage(payload?.message || 'Parallel audio failed.');
              logDiagnosticEvent('audio-parallel-failure', { level: 'error', details: payload });
              void closeAudioEngine('parallel-render-failed');
              return;
            }
            if (type === 'midiOutput') {
              sendMidiOutputEvents(payload?.events);
              return;
            }
            if (type === 'backendStatus') {
              backendReadyRef.current = Boolean(payload?.ready);
              logDiagnosticEvent('audio-backend-status', {
                level: payload?.ready ? 'info' : 'error',
                details: {
                  generation,
                  payload,
                  contextState: context.state,
                  graph: dspProgramDiagnosticSnapshot(graphRef.current),
                },
              });
              if (payload?.ready) {
                if (audioActivationRequestedRef.current && context.state === 'running') {
                  fadeAudioOutputIn(context, outputGain);
                  setStatus('running');
                  setMessage(`WASM audio ${context.state} (${AUDIO_WASM_ASSET_VERSION})`);
                } else {
                  setStatus((current) => current === 'starting' ? current : 'idle');
                  setMessage('audio ready');
                }
              } else {
                setStatus('error');
                setMessage(payload?.error || 'WASM audio failed');
              }
              return;
            }
            if (type === 'wasmMemory') {
              logDiagnosticEvent('audio-wasm-memory-change', {
                details: {
                  generation,
                  payload,
                  contextState: context.state,
                  graph: dspProgramDiagnosticSnapshot(graphRef.current),
                },
              });
              return;
            }
            if (type === 'cpuLoad') {
              const load = Number(payload?.load);
              if (Number.isFinite(load)) setCpuLoad(Math.max(0, load));
              setCpuPeakLoad(Math.max(0, Number(payload?.peakLoad) || 0));
              setCpuDeadlineMisses(Math.max(0, Number(payload?.deadlineMisses) || 0));
              return;
            }
            if (type === 'wasmScopeMemory') {
              logDiagnosticEvent('audio-wasm-scope-memory', {
                details: {
                  generation,
                  payload,
                  contextState: context.state,
                  graph: dspProgramDiagnosticSnapshot(graphRef.current),
                },
              });
              return;
            }
            if (type === 'processorError') {
              logDiagnosticEvent('audio-worklet-runtime-error', {
                level: 'error',
                details: {
                  payload,
                  contextState: context.state,
                  graph: dspProgramDiagnosticSnapshot(graphRef.current),
                },
              });
              return;
            }
            if (type === 'sampleLoadError') {
              const sampleMessage = typeof payload?.message === 'string'
                ? payload.message
                : 'Sample could not be loaded by the audio engine.';
              setMessage(sampleMessage);
              logDiagnosticEvent('audio-sample-load-error', {
                level: 'error',
                details: {
                  generation,
                  payload,
                  contextState: context.state,
                  graph: dspProgramDiagnosticSnapshot(graphRef.current),
                },
              });
              return;
            }
            if (type === 'recordingStarted') {
              logDiagnosticEvent('audio-recording-worklet-started', {
                details: {
                  payload,
                  contextState: context.state,
                },
              });
              return;
            }
            if (type === 'recordingChunk') {
              appendRecordingChunk(payload);
              return;
            }
            if (type === 'recordingStopped') {
              const id = Number(payload?.id);
              if (Number.isFinite(id)) {
                const capture = recordingCaptureRef.current;
                if (capture?.id === id) capture.sampleEvents = samplePlaybackEventsFromPayload(payload?.sampleEvents);
                completeRecordingCapture(id);
              }
              return;
            }
            if (type === 'bufferSnapshot') {
              const requestId = Number(payload?.requestId);
              const request = bufferSnapshotRequestsRef.current.get(requestId);
              if (!request) return;
              window.clearTimeout(request.timeout);
              bufferSnapshotRequestsRef.current.delete(requestId);
              const samples = float32ArrayFromUnknown(payload?.samples);
              const snapshotSampleRate = Number(payload?.sampleRate);
              request.resolve(samples && samples.length > 0 && Number.isFinite(snapshotSampleRate)
                ? { samples, sampleRate: snapshotSampleRate }
                : null);
              return;
            }
            if (type === 'visualizationFrame') {
              setLinkMeters(linkMetersFromPayload(payload));
              if (audioActivationRequestedRef.current) {
                setPlayheads(playheadsFromPayload({ values: payload?.playheads }));
                setBuffers(buffersFromPayload(payload));
              }
              setLinkScopeReadings(linkScopesFromPayload(payload));
              return;
            }
            if (type === 'linkMeters') {
              setLinkMeters(linkMetersFromPayload(payload));
              return;
            }
            if (type === 'playheads') {
              if (audioActivationRequestedRef.current) {
                setPlayheads(playheadsFromPayload(payload));
              }
              return;
            }
            if (type === 'linkScope') {
              const id = typeof payload?.id === 'string' ? payload.id : null;
              if (!id) return;
              setLinkScopeReadings((current) => ({
                ...current,
                [id]: {
                  mode: typeof payload?.mode === 'string' ? payload.mode : 'continuous',
                  samples: Array.isArray(payload?.samples) ? payload.samples.map(Number).filter(Number.isFinite) : [],
                },
              }));
            }
          };
          context.onstatechange = () => {
            const contextState = context.state as string;
            logDiagnosticEvent('audio-context-state-change', {
              level: contextState === 'interrupted' || contextState === 'closed' ? 'warn' : 'info',
              details: {
                generation,
                state: contextState,
                sampleRate: context.sampleRate,
                baseLatency: context.baseLatency,
                outputLatency: audioContextOutputLatency(context),
              },
            });
            setMessage((current) => current.replace(/(audio|context) (running|suspended|interrupted|closed)/, `$1 ${context.state}`));
            if (recordingRequestedRef.current && context.state === 'running') {
              beginRecordingCapture(context, node);
            }
          };

          node.connect(analyser);
          analyser.connect(outputGain);
          outputGain.connect(context.destination);
          node.port.postMessage({ type: 'setMuted', payload: { muted: true } });
          nodeRef.current = node;
          analyserRef.current = analyser;
          outputGainRef.current = outputGain;

          if (graphRef.current) {
            sampleDataKeysRef.current = {};
            imageDataKeysRef.current = {};
            lastSentProgramStructureRef.current = dspProgramStructureKey(graphRef.current);
            lastSentValuesRef.current = [...graphRef.current.values];
            lastSentCustomWavePointsRef.current = dspCustomWavePointsKey(graphRef.current);
            lastSentSequencerConfigRef.current = dspSequencerConfigKey(graphRef.current);
            node.port.postMessage({ type: 'dspProgram', payload: graphRef.current });
            syncGraphSamples(graphRef.current, context, node);
            syncGraphImages(graphRef.current, node);
          }
          if (activeScopeRequestsRef.current.length > 0) {
            node.port.postMessage({
              type: 'setLinkScopes',
              payload: scopePayload(activeScopeRequestsRef.current),
            });
          }
        } catch (error) {
          logDiagnosticEvent('audio-engine-start-error', {
            level: 'error',
            details: {
              error: serializeError(error),
              graph: dspProgramDiagnosticSnapshot(graphRef.current),
            },
          });
          if (activate) {
            setStatus('error');
            setMessage(error instanceof Error ? error.message : 'audio failed');
          } else {
            setMessage('audio stopped');
          }
          await closeAudioEngine('engine-start-error');
          throw error;
        } finally {
          audioEngineRequestRef.current = null;
        }
      })();
    }

    try {
      await audioEngineRequestRef.current;
    } catch {
      if (!activate) return;
      throw new Error('audio failed');
    }

    if (activate) {
      await activateAudioEngine();
    }
  }, [activateAudioEngine, appendRecordingChunk, beginRecordingCapture, closeAudioEngine, completeRecordingCapture, sendMidiOutputEvents, syncGraphImages, syncGraphSamples]);

  const syncGraph = useCallback((graph: DspProgram) => {
    graphRef.current = graph;
    if (midiClockOutputRunningRef.current && !programHasTempo(graph)) stopMidiClockOutput();
    else if (midiClockOutputRunningRef.current) startMidiClockOutput(false);
    preloadGraphSamples(graph);
    preloadGraphImages(graph);
    if (!nodeRef.current || !contextRef.current) {
      if (programUsesAudioInput(graph)) {
        const mediaDevices = navigator.mediaDevices;
        if (!mediaDevices?.getUserMedia) {
          setAudioInputStatus('unsupported');
          setAudioInputMessage('Audio input is unavailable in this browser.');
        } else {
          setAudioInputStatus('needs-permission');
          setAudioInputMessage('Start audio to request microphone access.');
          void refreshAudioInputDevices();
        }
      } else {
        disconnectAudioInput();
      }
      if (programUsesMidi(graph) || midiInputEnabled || midiClockOutputEnabled || midiAccessRequestedRef.current) {
        const navigatorWithMidi = navigator as Navigator & {
          requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<unknown>;
        };
        if (!navigatorWithMidi.requestMIDIAccess) {
          setMidiInputStatus('unsupported');
          setMidiInputDevices((current) => current.length === 0 ? current : []);
          setMidiOutputDevices((current) => current.length === 0 ? current : []);
          setMidiInputMessage('MIDI input is unavailable in this browser.');
        } else if (midiAccessRef.current) {
          const devices = updateMidiInputDevices(midiAccessRef.current);
          const selectedConnectedCount = devices.filter((device) => selectedMidiInputDeviceIdSet.has(device.id)).length;
          const outputCount = [...midiAccessRef.current.outputs.values()].length;
          setMidiInputStatus(devices.length + outputCount > 0 ? 'connected' : 'unsupported');
          setMidiInputMessage(midiInputStatusMessage(devices.length, outputCount, selectedMidiInputDeviceIds.length, selectedConnectedCount));
        } else {
          setMidiInputStatus('needs-permission');
          setMidiInputMessage(midiInputEnabled || midiClockOutputEnabled || midiAccessRequestedRef.current
            ? 'Open MIDI settings to request browser MIDI access.'
            : 'Start audio or refresh MIDI to request browser MIDI access.');
        }
      } else {
        disconnectMidiInput();
      }
      return;
    }
    const shouldSyncExternalInputs = audioActivationRequestedRef.current;
    const structureKey = dspProgramStructureKey(graph);
    const customWavePointsKey = dspCustomWavePointsKey(graph);
    const sequencerConfigKey = dspSequencerConfigKey(graph);
    if (
      lastSentProgramStructureRef.current === structureKey
      && lastSentCustomWavePointsRef.current !== customWavePointsKey
    ) {
      lastSentCustomWavePointsRef.current = customWavePointsKey;
      nodeRef.current.port.postMessage({
        type: 'dspCustomWaves',
        payload: { bindings: graph.customWaveBindings },
      });
    }
    if (
      lastSentProgramStructureRef.current === structureKey
      && lastSentSequencerConfigRef.current !== sequencerConfigKey
    ) {
      lastSentSequencerConfigRef.current = sequencerConfigKey;
      nodeRef.current.port.postMessage({
        type: 'dspSequencers',
        payload: { bindings: graph.sequencerBindings },
      });
    }
    if (
      lastSentProgramStructureRef.current === structureKey
      && arraysEqual(lastSentValuesRef.current, graph.values)
    ) {
      syncGraphSamples(graph, contextRef.current, nodeRef.current);
      syncGraphImages(graph, nodeRef.current);
      if (shouldSyncExternalInputs) {
        syncAudioInput(graph, contextRef.current, nodeRef.current);
        syncMidiInput(graph, nodeRef.current);
      }
      return;
    }

    if (lastSentProgramStructureRef.current === structureKey) {
      lastSentValuesRef.current = [...graph.values];
      nodeRef.current.port.postMessage({ type: 'dspValues', payload: { values: graph.values } });
      syncGraphSamples(graph, contextRef.current, nodeRef.current);
      syncGraphImages(graph, nodeRef.current);
      if (shouldSyncExternalInputs) {
        syncAudioInput(graph, contextRef.current, nodeRef.current);
        syncMidiInput(graph, nodeRef.current);
      }
      return;
    }

    lastSentProgramStructureRef.current = structureKey;
    lastSentValuesRef.current = [...graph.values];
    lastSentCustomWavePointsRef.current = customWavePointsKey;
    lastSentSequencerConfigRef.current = sequencerConfigKey;
    nodeRef.current.port.postMessage({ type: 'dspProgram', payload: graph });
    syncGraphSamples(graph, contextRef.current, nodeRef.current);
    syncGraphImages(graph, nodeRef.current);
    if (shouldSyncExternalInputs) {
      syncAudioInput(graph, contextRef.current, nodeRef.current);
      syncMidiInput(graph, nodeRef.current);
    }
    nodeRef.current.port.postMessage({
      type: 'setLinkScopes',
      payload: activeScopeRequestsRef.current.length > 0
        ? scopePayload(activeScopeRequestsRef.current)
        : {},
    });
  }, [disconnectAudioInput, disconnectMidiInput, ensureAudioEngine, midiClockOutputEnabled, midiInputEnabled, preloadGraphImages, preloadGraphSamples, refreshAudioInputDevices, selectedMidiInputDeviceIdSet, selectedMidiInputDeviceIds.length, selectedMidiInputDeviceKey, stopMidiClockOutput, syncAudioInput, syncGraphImages, syncGraphSamples, syncMidiInput, updateMidiInputDevices]);

  const setLinkScopes = useCallback((requests: ScopeCaptureRequest[]) => {
    const nextRequests = normalizeScopeCaptureRequests(requests);
    if (scopeCaptureRequestsEqual(activeScopeRequestsRef.current, nextRequests)) return;

    activeScopeRequestsRef.current = nextRequests;
    nodeRef.current?.port.postMessage({
      type: 'setLinkScopes',
      payload: activeScopeRequestsRef.current.length > 0
        ? scopePayload(activeScopeRequestsRef.current)
        : {},
    });
  }, []);

  const captureBuffer = useCallback((nodeId: string): Promise<BufferSnapshot | null> => {
    const node = nodeRef.current;
    if (!node || !nodeId) return Promise.resolve(null);

    const requestId = bufferSnapshotRequestIdRef.current + 1;
    bufferSnapshotRequestIdRef.current = requestId;
    return new Promise((resolve) => {
      const timeout = window.setTimeout(() => {
        bufferSnapshotRequestsRef.current.delete(requestId);
        resolve(null);
      }, 2000);
      bufferSnapshotRequestsRef.current.set(requestId, { resolve, timeout });
      node.port.postMessage({
        type: 'captureBuffer',
        payload: { requestId, nodeId },
      });
    });
  }, []);

  const restoreBuffers = useCallback((snapshots: Record<string, BufferSnapshot>) => {
    bufferRestoresRef.current = snapshots;
    const node = nodeRef.current;
    if (node) postBufferRestores(node, snapshots);
  }, []);

  const clearBuffer = useCallback((nodeId: string) => {
    if (!nodeId) return;
    const restored = bufferRestoresRef.current[nodeId];
    if (restored) restored.samples.fill(0);
    setBuffers((current) => {
      const visualization = current[nodeId];
      if (!visualization) return current;
      return {
        ...current,
        [nodeId]: {
          ...visualization,
          bins: visualization.bins.map(() => ({ min: 0, max: 0 })),
        },
      };
    });
    const node = nodeRef.current;
    if (node) {
      postBufferClears(node, [nodeId]);
    } else {
      pendingBufferClearsRef.current.add(nodeId);
    }
  }, []);

  const copyBuffers = useCallback((copies: BufferCopy[]) => {
    if (copies.length === 0) return;
    const node = nodeRef.current;
    if (node) {
      postBufferCopies(node, copies);
      return;
    }
    for (const copy of copies) pendingBufferCopiesRef.current.set(copy.targetNodeId, copy);
  }, []);

  const start = useCallback(async () => {
    try {
      logDiagnosticEvent('audio-start-clicked', {
        details: {
          graph: dspProgramDiagnosticSnapshot(graphRef.current),
        },
      });
      await ensureAudioEngine(true);
      if (audioActivationRequestedRef.current) startMidiClockOutput();
    } catch (error) {
      logDiagnosticEvent('audio-start-error', {
        level: 'error',
        details: {
          error: serializeError(error),
          graph: dspProgramDiagnosticSnapshot(graphRef.current),
        },
      });
      setStatus('error');
      setMessage(error instanceof Error ? error.message : 'audio failed');
    }
  }, [ensureAudioEngine, startMidiClockOutput]);

  const stop = useCallback(() => {
    logDiagnosticEvent('audio-stop-clicked', {
      details: {
        generation: audioEngineGenerationRef.current,
        contextState: contextRef.current?.state ?? 'none',
        graph: dspProgramDiagnosticSnapshot(graphRef.current),
      },
    });
    audioActivationRequestedRef.current = false;
    sendMidiAllNotesOff();
    stopMidiClockOutput();
    finishRecordingCapture();
    setPlayheads({});
    setBuffers((current) => preservedBufferVisualizations(current, graphRef.current));
    const context = contextRef.current;
    const outputGain = outputGainRef.current;
    if (context && outputGain && context.state !== 'closed') {
      fadeAudioOutputOut(context, outputGain);
      if (stopTimeoutRef.current !== null) {
        window.clearTimeout(stopTimeoutRef.current);
      }
      stopTimeoutRef.current = window.setTimeout(() => {
        parkAudioContext(contextRef, nodeRef, outputGainRef, inputSourceRef, inputStreamRef, stopTimeoutRef);
        logDiagnosticEvent('audio-context-parked', {
          details: {
            generation: audioEngineGenerationRef.current,
            contextState: contextRef.current?.state ?? 'none',
          },
        });
        setLinkMeters({});
        setLinkScopeReadings({});
      }, AUDIO_OUTPUT_STOP_DELAY_MS);
    } else {
      parkAudioContext(contextRef, nodeRef, outputGainRef, inputSourceRef, inputStreamRef, stopTimeoutRef);
      logDiagnosticEvent('audio-context-parked', {
        details: {
          generation: audioEngineGenerationRef.current,
          contextState: contextRef.current?.state ?? 'none',
        },
      });
      setLinkMeters({});
      setLinkScopeReadings({});
    }
    if ((midiInputEnabled || midiClockOutputEnabled || midiAccessRequestedRef.current) && midiAccessRef.current) {
      attachMidiInputs(midiAccessRef.current, null);
    } else {
      disconnectMidiInput();
    }
    inputRequestIdRef.current += 1;
    inputRequestRef.current = null;
    currentInputDeviceIdRef.current = '';
    stopMeter();
    setLinkMeters({});
    setLinkScopeReadings({});
    setStatus('idle');
    setMessage('audio stopped');
    setAudioInputStatus(programUsesAudioInput(graphRef.current) ? 'needs-permission' : 'inactive');
    setAudioInputMessage(programUsesAudioInput(graphRef.current)
      ? 'Start audio to request microphone access.'
      : 'Audio input is not used by this patch.');
    setMidiInputStatus(programUsesMidi(graphRef.current) || midiInputEnabled || midiClockOutputEnabled || midiAccessRequestedRef.current ? 'needs-permission' : 'inactive');
    setMidiInputMessage(programUsesMidi(graphRef.current) || midiInputEnabled || midiClockOutputEnabled || midiAccessRequestedRef.current
      ? 'Open MIDI settings to request browser MIDI access.'
      : 'MIDI input is not used by this patch.');
    if (!midiInputEnabled && !midiClockOutputEnabled && !midiAccessRequestedRef.current) {
      setMidiInputDevices((current) => current.length === 0 ? current : []);
    }
  }, [attachMidiInputs, disconnectMidiInput, finishRecordingCapture, midiClockOutputEnabled, midiInputEnabled, sendMidiAllNotesOff, stopMeter, stopMidiClockOutput]);

  useEffect(() => {
    if (!midiClockOutputEnabled) {
      stopMidiClockOutput();
      return;
    }
    if (audioActivationRequestedRef.current) startMidiClockOutput();
  }, [midiClockOutputEnabled, startMidiClockOutput, stopMidiClockOutput]);

  useEffect(() => {
    if (!midiAccessRef.current) return;
    attachMidiInputs(
      midiAccessRef.current,
      graphRef.current && programUsesMidi(graphRef.current) ? nodeRef.current : null,
    );
  }, [attachMidiInputs]);

  useEffect(() => () => {
    audioActivationRequestedRef.current = false;
    finishRecordingCapture();
    stopMeter();
    void closeAudioEngine('component-unmount');
    disconnectMidiInput();
  }, [closeAudioEngine, disconnectMidiInput, finishRecordingCapture, stopMeter]);

  useEffect(() => {
    void refreshAudioInputDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;

    const handleDeviceChange = () => {
      void refreshAudioInputDevices();
    };
    mediaDevices.addEventListener('devicechange', handleDeviceChange);
    return () => mediaDevices.removeEventListener('devicechange', handleDeviceChange);
  }, [refreshAudioInputDevices]);

  const audioInput: AudioInputState = useMemo(() => ({
    status: audioInputStatus,
    message: audioInputMessage,
    devices: audioInputDevices,
    selectedDeviceId: selectedAudioInputDeviceId,
    canSelectDevice: Boolean(navigator.mediaDevices?.enumerateDevices),
  }), [audioInputDevices, audioInputMessage, audioInputStatus, selectedAudioInputDeviceId]);
  const midiInput: MidiInputState = useMemo(() => ({
    status: midiInputStatus,
    message: midiInputMessage,
    devices: midiInputDevices,
    outputDevices: midiOutputDevices,
    canRequestAccess: Boolean((navigator as Navigator & {
      requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<unknown>;
    }).requestMIDIAccess),
    lastControlChange: lastMidiControlChange,
  }), [lastMidiControlChange, midiInputDevices, midiInputMessage, midiInputStatus, midiOutputDevices]);
  const recording: RecordingState = useMemo(() => ({
    status: recordingStatus,
    message: recordingMessage,
    fileName: recordingFileName,
    elapsedSeconds: recordingElapsedSeconds,
  }), [recordingElapsedSeconds, recordingFileName, recordingMessage, recordingStatus]);

  return {
    status,
    message,
    cpuLoad,
    cpuPeakLoad,
    cpuDeadlineMisses,
    rendering,
    peak,
    linkMeters,
    linkScopes,
    playheads,
    buffers,
    recording,
    audioInput,
    midiInput,
    start,
    stop,
    startRecording,
    stopRecording,
    captureBuffer,
    clearBuffer,
    copyBuffers,
    restoreBuffers,
    syncGraph,
    setLinkScopes,
    setAudioInputDeviceId: setSelectedAudioInputDeviceId,
    refreshAudioInputDevices,
    refreshMidiInputDevices,
  };
}

function postBufferRestores(node: AudioWorkletNode, snapshots: Record<string, BufferSnapshot>): void {
  node.port.postMessage({
    type: 'restoreBuffers',
    payload: {
      buffers: Object.entries(snapshots).map(([nodeId, snapshot]) => ({
        nodeId,
        sampleRate: snapshot.sampleRate,
        samples: snapshot.samples,
      })),
    },
  });
}

function postBufferCopies(node: AudioWorkletNode, copies: BufferCopy[]): void {
  if (copies.length === 0) return;
  node.port.postMessage({
    type: 'copyBuffers',
    payload: { copies },
  });
}

function postBufferClears(node: AudioWorkletNode, nodeIds: string[]): void {
  if (nodeIds.length === 0) return;
  node.port.postMessage({
    type: 'clearBuffers',
    payload: { nodeIds },
  });
}

function encodeWav(chunks: Float32Array[][], sampleRate: number, channelCount: number): Blob {
  const frameCount = chunks.reduce((total, chunk) => total + (chunk[0]?.length ?? 0), 0);
  const bytesPerSample = 2;
  const dataByteLength = frameCount * channelCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (const chunk of chunks) {
    const frames = chunk[0]?.length ?? 0;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let channel = 0; channel < channelCount; channel += 1) {
        const channelSamples = chunk[channel] ?? chunk[0];
        const sample = Math.max(-1, Math.min(1, channelSamples?.[frame] ?? 0));
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        offset += bytesPerSample;
      }
    }
  }

  return new Blob([view], { type: 'audio/wav' });
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

function recordingChunkFromPayload(payload: Record<string, unknown>, channelCount: number): Float32Array[] | null {
  const channels = Array.isArray(payload.channels) ? payload.channels : [];
  const firstChannel = float32ArrayFromUnknown(channels[0]);
  if (!firstChannel || firstChannel.length === 0) return null;

  const frameCount = firstChannel.length;
  const output: Float32Array[] = [];
  for (let channel = 0; channel < channelCount; channel += 1) {
    const source = float32ArrayFromUnknown(channels[channel]) ?? firstChannel;
    output.push(source.length === frameCount ? source : source.slice(0, frameCount));
  }
  return output;
}

function float32ArrayFromUnknown(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) {
    return Float32Array.from(value.map((sample) => {
      const numeric = Number(sample);
      return Number.isFinite(numeric) ? numeric : 0;
    }));
  }
  if (ArrayBuffer.isView(value) && !(value instanceof DataView) && 'length' in value) {
    return Float32Array.from(Array.from(value as unknown as ArrayLike<number>, (sample) => {
      const numeric = Number(sample);
      return Number.isFinite(numeric) ? numeric : 0;
    }));
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function uploadRecording(blob: Blob, patchName: string, sampleEvents: SamplePlaybackEvent[]): Promise<{ name: string }> {
  const response = await fetch('/api/recordings', {
    method: 'POST',
    headers: {
      'Content-Type': 'audio/wav',
      // HTTP header values are limited to Latin-1. Patch names are user text,
      // so encode them before placing them in a header (for example, "été").
      'X-Teia-Patch-Name-Encoded': encodeURIComponent(patchName),
    },
    body: blob,
  });
  if (!response.ok) {
    throw new Error(await response.text() || `Recording save failed (${response.status}).`);
  }

  const payload = await response.json() as unknown;
  if (!isRecord(payload) || typeof payload.name !== 'string') {
    throw new Error('Recording save returned an invalid response.');
  }
  const videoSampleEvents = sampleEvents.filter(isVideoSamplePlaybackEvent);
  if (videoSampleEvents.length > 0) {
    const metadataResponse = await fetch('/api/recording-metadata', {
      method: 'POST',
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'X-Teia-Recording-Name': payload.name,
      },
      body: samplePlaybackEventsCsv(videoSampleEvents),
    });
    if (!metadataResponse.ok) {
      throw new Error(await metadataResponse.text() || `Recording metadata save failed (${metadataResponse.status}).`);
    }
  }
  return { name: payload.name };
}

function isVideoSamplePlaybackEvent(event: SamplePlaybackEvent): boolean {
  return event.sampleName.toLowerCase().endsWith('.mp4');
}

function samplePlaybackEventsFromPayload(value: unknown): SamplePlaybackEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((event) => ({
    nodeId: String(event.nodeId ?? ''),
    sampleName: String(event.sampleName ?? ''),
    startMs: Number(event.startMs) || 0,
    endMs: Number(event.endMs) || 0,
    speed: Number(event.speed) || 0,
    volume: Number(event.volume) || 0,
    attackMs: Number(event.attackMs) || 0,
    releaseMs: Number(event.releaseMs) || 0,
    triggerTimeMs: Number(event.triggerTimeMs) || 0,
  }));
}

function samplePlaybackEventsCsv(events: SamplePlaybackEvent[]): string {
  const escape = (value: string | number) => `"${String(value).replaceAll('"', '""')}"`;
  const header = ['node_id', 'sample_name', 'start_ms', 'end_ms', 'speed', 'volume', 'attack_ms', 'release_ms', 'trigger_time_ms'];
  const rows = events
    .map((event, captureOrder) => ({ event, captureOrder }))
    .sort((left, right) => (
      left.event.triggerTimeMs - right.event.triggerTimeMs
      || left.captureOrder - right.captureOrder
    ))
    .map(({ event }) => [
      event.nodeId, event.sampleName, event.startMs, event.endMs, event.speed, event.volume,
      event.attackMs, event.releaseMs, event.triggerTimeMs,
    ].map(escape).join(','));
  return `${header.join(',')}\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

function scopePayload(requests: ScopeCaptureRequest[]) {
  return {
    linkIds: requests.map((request) => request.id),
    scopes: requests.map((request) => {
      const displayPoints = request.points ?? SCOPE_DISPLAY_POINTS;
      const mode = request.reset ?? SCOPE_MODE;
      return {
        id: request.id,
        // Preserve the selected `length`: doubling both the capture duration
        // and count keeps sample spacing unchanged, leaving a full display
        // window after any eligible zero crossing.
        seconds: mode === 'zero-crossing' ? request.length * 2 : request.length,
        points: mode === 'zero-crossing' ? Math.min(1024, displayPoints * 2) : request.points ?? SCOPE_CAPTURE_POINTS,
        displayPoints,
        mode,
      };
    }),
    points: SCOPE_CAPTURE_POINTS,
    displayPoints: SCOPE_DISPLAY_POINTS,
    mode: SCOPE_MODE,
  };
}




function arraysEqual(left: number[] | null, right: number[]): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function normalizeScopeCaptureRequests(requests: ScopeCaptureRequest[]): ScopeCaptureRequest[] {
  const seen = new Set<string>();
  return requests.flatMap((request) => {
    if (!request.id || seen.has(request.id)) return [];
    seen.add(request.id);
    const points = request.points === undefined
      ? undefined
      : Math.round(clampNumber(request.points, 32, 512));
    return [{
      id: request.id,
      length: clampNumber(request.length, 0.01, 30),
      ...(points === undefined ? {} : { points }),
      ...(request.reset === 'zero-crossing' ? { reset: 'zero-crossing' as const } : { reset: 'none' as const }),
    }];
  });
}

function scopeCaptureRequestsEqual(left: ScopeCaptureRequest[], right: ScopeCaptureRequest[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (
      left[index].id !== right[index].id
      || left[index].length !== right[index].length
      || left[index].points !== right[index].points
      || left[index].reset !== right[index].reset
    ) return false;
  }
  return true;
}

function programUsesAudioInput(program: DspProgram | null): boolean {
  return Boolean(program?.ops.some((op) => op.opcode === DSP_OP.Input));
}

function audioInputDeviceLabel(devices: AudioInputDevice[], deviceId: string): string {
  return devices.find((device) => device.deviceId === deviceId)?.label ?? '';
}

function midiInputDeviceFromInput(input: MidiInputLike, index: number): MidiInputDevice {
  return midiDeviceFromPort(input, index, 'input');
}

function midiDeviceFromPort(port: Pick<MidiInputLike, 'id' | 'name' | 'manufacturer' | 'state'>, index: number, kind: 'input' | 'output'): MidiInputDevice {
  const name = port.name?.trim();
  const manufacturer = port.manufacturer?.trim();
  return {
    id: port.id || `${manufacturer || 'midi'}-${name || index}`,
    label: [manufacturer, name].filter(Boolean).join(' ') || `MIDI ${kind} ${index + 1}`,
    state: port.state || 'connected',
  };
}

function midiInputDevicesEqual(left: MidiInputDevice[], right: MidiInputDevice[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((device, index) => (
    device.id === right[index]?.id &&
    device.label === right[index]?.label &&
    device.state === right[index]?.state
  ));
}

function midiInputStatusMessage(inputCount: number, outputCount: number, selectedCount: number, selectedConnectedCount: number): string {
  if (inputCount + outputCount === 0) {
    return 'MIDI permission is granted, but no devices were found.';
  }
  if (selectedCount === 0) {
    return `${inputCount} input${inputCount === 1 ? '' : 's'} and ${outputCount} output${outputCount === 1 ? '' : 's'} available.`;
  }
  if (selectedConnectedCount === 0) {
    return 'Selected MIDI input is not currently available.';
  }
  return `${selectedConnectedCount} of ${inputCount} MIDI input${inputCount === 1 ? '' : 's'} selected; ${outputCount} output${outputCount === 1 ? '' : 's'} available.`;
}

function programUsesMidi(program: DspProgram | null): boolean {
  return Boolean(
    program?.ops.some((op) => op.opcode === DSP_OP.MidiNote || op.opcode === DSP_OP.MidiCc || op.opcode === DSP_OP.MidiNoteSend || op.opcode === DSP_OP.MidiCcSend) ||
    (program?.midiControlBindings.length ?? 0) > 0 ||
    programUsesMidiClock(program)
  );
}

function programUsesMidiClock(program: DspProgram | null): boolean {
  return Boolean(program?.usesMidiClock);
}

function programHasTempo(program: DspProgram | null): boolean {
  return (program?.tempoBindings.length ?? 0) > 0;
}

function midiClockOutputTempo(program: DspProgram | null): { bpm: number; source: 'internal' | 'midi'; sourceIndex: number } | null {
  const binding = program?.tempoBindings[0];
  if (!binding || !program) return null;
  const source = Math.round(program.values[binding.sourceValueIndex] ?? 0);
  const sourceIndex = Math.max(0, Math.round(program.values[binding.midiSourceValueIndex] ?? 0));
  return {
    bpm: clampNumber(program.values[binding.bpmValueIndex] ?? 120, MIDI_CLOCK_TEMPO_MIN, MIDI_CLOCK_TEMPO_MAX),
    source: source === 1 ? 'midi' : 'internal',
    sourceIndex,
  };
}

function activeMidiClockSourceIndexes(program: DspProgram | null): Set<number> {
  const indexes = new Set<number>();
  if (!program?.usesMidiClock) return indexes;

  for (const binding of program.tempoBindings) {
    const source = Math.round(program.values[binding.sourceValueIndex] ?? 0);
    if (source !== 1) continue;
    indexes.add(Math.max(0, Math.round(program.values[binding.midiSourceValueIndex] ?? 0)));
  }
  return indexes;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clampMidiInteger(value: unknown, min: number, max: number): number {
  const numeric = Number(value);
  return Math.round(clampNumber(numeric, min, max));
}

async function resumeAudioContext(context: AudioContext): Promise<void> {
  if (context.state === 'running') return;

  await Promise.race([
    context.resume().then(() => undefined),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, 350);
    }),
  ]);
}

function linkMetersFromPayload(payload: unknown): Record<string, LinkMeterReading> {
  const levels = (payload as { levels?: unknown })?.levels;
  if (!Array.isArray(levels)) return {};

  const readings: Record<string, LinkMeterReading> = {};
  for (const entry of levels) {
    if (!Array.isArray(entry)) continue;
    const [id, input, output, envelope] = entry;
    if (typeof id !== 'string') continue;
    readings[id] = {
      input: finiteNumber(input),
      output: finiteNumber(output),
      envelope: finiteNumber(envelope),
    };
  }
  return readings;
}

function playheadsFromPayload(payload: unknown): Record<string, number[]> {
  const values = (payload as { values?: unknown })?.values;
  if (!Array.isArray(values)) return {};

  const playheads: Record<string, number[]> = {};
  const latestPlayheads: Record<string, number> = {};
  for (const entry of values) {
    if (!Array.isArray(entry)) continue;
    const [id, value, isLatest] = entry;
    const playhead = Number(value);
    if (typeof id !== 'string' || !Number.isFinite(playhead)) continue;
    const safePlayhead = clampNumber(playhead, 0, 1);
    if (isLatest === true) latestPlayheads[id] = safePlayhead;
    else (playheads[id] ??= []).push(safePlayhead);
  }
  for (const [id, playhead] of Object.entries(latestPlayheads)) (playheads[id] ??= []).push(playhead);
  return playheads;
}

function buffersFromPayload(payload: unknown): Record<string, BufferVisualization> {
  const values = (payload as { buffers?: unknown })?.buffers;
  if (!Array.isArray(values)) return {};

  const buffers: Record<string, BufferVisualization> = {};
  for (const entry of values) {
    if (!Array.isArray(entry)) continue;
    const [id, rawPlayhead, rawRecordHead, rawBins] = entry;
    if (typeof id !== 'string' || !Array.isArray(rawBins)) continue;
    const bins = rawBins.flatMap((bin) => {
      if (!Array.isArray(bin)) return [];
      const min = Number(bin[0]);
      const max = Number(bin[1]);
      return Number.isFinite(min) && Number.isFinite(max) ? [{ min, max }] : [];
    });
    buffers[id] = {
      playhead: clampNumber(Number(rawPlayhead), 0, 1),
      recordHead: clampNumber(Number(rawRecordHead), 0, 1),
      bins,
    };
  }
  return buffers;
}

function preservedBufferVisualizations(
  buffers: Record<string, BufferVisualization>,
  program: DspProgram | null,
): Record<string, BufferVisualization> {
  if (!program) return {};
  const preservedNodeIds = new Set(program.stateBindings.flatMap((binding) => {
    if (!binding.id.endsWith(':buffer')) return [];
    const op = program.ops.find((candidate) => candidate.opcode === DSP_OP.Buffer && candidate.state === binding.state);
    return (op?.value ?? 0) >= 0.5 ? [binding.nodeId] : [];
  }));
  return Object.fromEntries(Object.entries(buffers).filter(([nodeId]) => preservedNodeIds.has(nodeId)));
}

function linkScopesFromPayload(payload: unknown): Record<string, LinkScopeReading> {
  const scopes = (payload as { scopes?: unknown })?.scopes;
  if (!Array.isArray(scopes)) return {};

  const readings: Record<string, LinkScopeReading> = {};
  for (const entry of scopes) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, mode, samples } = entry as { id?: unknown; mode?: unknown; samples?: unknown };
    if (typeof id !== 'string' || !Array.isArray(samples)) continue;
    readings[id] = {
      mode: typeof mode === 'string' ? mode : 'continuous',
      samples: samples.map(Number).filter(Number.isFinite),
    };
  }
  return readings;
}

function finiteNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

async function loadAndPostSampleData(
  context: AudioContext,
  node: AudioWorkletNode,
  nodeId: string,
  url: string,
  name: string,
  key: string,
  keysRef: { current: Record<string, string> },
  cacheRef: { current: Record<string, SampleDataCacheEntry> },
  requestRef: { current: Record<string, SampleDataRequest> },
): Promise<SampleDataCacheEntry | null> {
  const entry = await loadCachedSampleData(nodeId, url, name, key, cacheRef, requestRef, context);
  if (!entry || keysRef.current[nodeId] !== key) return null;
  postSampleData(node, nodeId, entry);
  return entry;
}

async function loadAndPostImageData(
  nodeId: string,
  url: string,
  name: string,
  key: string,
  node: AudioWorkletNode,
  cacheRef: { current: Record<string, ImageDataCacheEntry> },
  requestRef: { current: Record<string, ImageDataRequest> },
): Promise<void> {
  const entry = await loadCachedImageData(nodeId, url, name, key, cacheRef, requestRef);
  if (!entry) return;
  node.port.postMessage({
    type: 'imageData',
    payload: { nodeId, data: entry.data, width: entry.width, height: entry.height, name: entry.name },
  });
}

async function loadCachedImageData(
  nodeId: string,
  url: string,
  name: string,
  key: string,
  cacheRef: { current: Record<string, ImageDataCacheEntry> },
  requestRef: { current: Record<string, ImageDataRequest> },
): Promise<ImageDataCacheEntry | null> {
  if (cacheRef.current[nodeId]?.key === key) return cacheRef.current[nodeId];
  const existing = requestRef.current[nodeId];
  if (existing?.key === key) return existing.promise;
  const promise = (async (): Promise<ImageDataCacheEntry | null> => {
    const response = await fetch(url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`Could not load image "${name || url}" (${response.status}).`);
    const decoded = await decodeImageRgba(await response.blob());
    const entry: ImageDataCacheEntry = { key, name, ...decoded };
    cacheRef.current[nodeId] = entry;
    return entry;
  })().finally(() => {
    if (requestRef.current[nodeId]?.key === key) delete requestRef.current[nodeId];
  });
  requestRef.current[nodeId] = { key, promise };
  return promise;
}

async function decodeImageRgba(blob: Blob): Promise<{ data: Uint8Array; width: number; height: number }> {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas === 'undefined'
    ? document.createElement('canvas')
    : new OffscreenCanvas(width, height);
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) {
    bitmap.close();
    throw new Error('This browser cannot read image pixels.');
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { data: new Uint8Array(context.getImageData(0, 0, width, height).data), width, height };
}

async function loadCachedSampleData(
  nodeId: string,
  url: string,
  name: string,
  key: string,
  cacheRef: { current: Record<string, SampleDataCacheEntry> },
  requestRef: { current: Record<string, SampleDataRequest> },
  context?: BaseAudioContext,
): Promise<SampleDataCacheEntry | null> {
  const cached = cacheRef.current[key];
  if (cached?.key === key) return cached;

  const currentRequest = requestRef.current[key];
  if (currentRequest?.key === key) return currentRequest.promise;

  delete cacheRef.current[key];
  const requestState: SampleDataRequest = {
    key,
    promise: Promise.resolve(null),
  };
  const request = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load sample "${name || url}" (${response.status}).`);
      }

      const buffer = await decodeSampleAudioData(await response.arrayBuffer(), context);
      const entry: SampleDataCacheEntry = {
        key,
        data: audioBufferToMonoData(buffer),
        sampleRate: buffer.sampleRate,
        name,
        storageKey: url,
      };
      if (requestRef.current[key] === requestState) {
        cacheRef.current[key] = entry;
        delete requestRef.current[key];
      }
      return entry;
    } catch (error) {
      logDiagnosticEvent('audio-sample-load-error', {
        level: 'warn',
        details: {
          nodeId,
          url,
          name,
          error: serializeError(error),
        },
      });
      if (requestRef.current[key] === requestState) {
        delete requestRef.current[key];
      }
      throw error;
    }
  })();
  requestState.promise = request;
  requestRef.current[key] = requestState;
  return request;
}

async function decodeSampleAudioData(arrayBuffer: ArrayBuffer, context?: BaseAudioContext): Promise<AudioBuffer> {
  if (context) {
    return context.decodeAudioData(arrayBuffer);
  }

  const windowWithOfflineAudio = window as Window & {
    webkitOfflineAudioContext?: typeof OfflineAudioContext;
  };
  const OfflineAudioContextConstructor = window.OfflineAudioContext || windowWithOfflineAudio.webkitOfflineAudioContext;
  if (!OfflineAudioContextConstructor) {
    throw new Error('This browser cannot preload samples while audio is stopped.');
  }
  const decodeContext = new OfflineAudioContextConstructor(1, 1, 44100);
  return decodeContext.decodeAudioData(arrayBuffer);
}

function postSampleData(node: AudioWorkletNode, nodeId: string, entry: SampleDataCacheEntry): void {
  const data = new Float32Array(entry.data);
  node.port.postMessage({
    type: 'sampleData',
    payload: {
      nodeId,
      data,
      sampleRate: entry.sampleRate,
      name: entry.name,
      storageKey: entry.key,
    },
  }, [data.buffer]);
}

function postSampleReference(node: AudioWorkletNode, nodeId: string, entry: SampleDataCacheEntry): void {
  node.port.postMessage({
    type: 'sampleData',
    payload: { nodeId, sampleRate: entry.sampleRate, name: entry.name, storageKey: entry.key },
  });
}

function audioBufferToMonoData(buffer: AudioBuffer): Float32Array {
  const output = new Float32Array(buffer.length);
  if (buffer.numberOfChannels === 0) return output;

  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const input = buffer.getChannelData(channel);
    for (let index = 0; index < output.length; index += 1) {
      output[index] += input[index] / buffer.numberOfChannels;
    }
  }

  return output;
}

function audioContextOutputLatency(context: AudioContext): number | null {
  const contextWithOutputLatency = context as AudioContext & { outputLatency?: number };
  return typeof contextWithOutputLatency.outputLatency === 'number' ? contextWithOutputLatency.outputLatency : null;
}

function dspProgramDiagnosticSnapshot(program: DspProgram | null) {
  if (!program) return null;
  return {
    ops: program.ops.length,
    values: program.values.length,
    stateBindings: program.stateBindings.length,
    registerCount: program.registerCount,
    stateCount: program.stateCount,
    sampleBindings: program.sampleBindings.length,
    customWaveBindings: program.customWaveBindings.length,
    midiControlBindings: program.midiControlBindings.length,
    tempoBindings: program.tempoBindings.length,
    maxVoices: program.maxVoices,
    usesMidiNote: program.usesMidiNote,
    usesMidiClock: program.usesMidiClock,
    errors: program.errors.slice(0, 8),
  };
}
