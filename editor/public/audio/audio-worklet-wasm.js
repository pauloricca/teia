const MAX_WASM_FRAMES = 2048;
const TWO_PI = Math.PI * 2;
const LEFT_OFFSET = 0;
const RIGHT_OFFSET = 8192;
const MAX_ACTIVE_VOICES = 16;
const MAX_SAMPLE_PLAYER_VOICES = 16;
const DEFAULT_TEMPO = 120;
const TEMPO_MIN = 20;
const TEMPO_MAX = 300;
const DEFAULT_SYNC_BEATS = 1;
const DRONE_SLOT = MAX_ACTIVE_VOICES;
const AUDIO_TARGET = -1;
const LINK_TARGET_BASE = -2;
const DSP_OUTPUT_START_FADE_SECONDS = 0.02;
const VOICE_START_FADE_SECONDS = 0.006;
const VOICE_STEAL_FADE_SECONDS = 0.03;
const VISUALIZATION_POST_SECONDS = 1 / 15;
const SCOPE_VISUALIZATION_POST_SECONDS = 1 / 30;
const LINK_SCOPE_SECONDS_MAX = 30;
const MASTER_DC_BLOCK_HZ = 10;
const DENORMAL_EPSILON = 1e-20;
const FORMANT_INTENSITY_MAX = 36;
const MAX_CUSTOM_WAVE_POINTS = 64;
const RECORDING_CHUNK_FRAMES = 16384;
const RECORDING_CHANNEL_COUNT = 2;
const QUANTISE_MIDI_ROOT = "midi-note";
const DEFAULT_GRAPH_UPDATE_CROSSFADE_SECONDS = 0.02;
// The player package build replaces this constant and removes editor-only work.
const TEIA_RUNTIME_BUILD = false;

// Active playback uses DspProgram messages compiled by editor/src/audio/dspProgram.ts.

const WAVE_IDS = new Map([
  ["sine", 0],
  ["triangle", 1],
  ["saw", 2],
  ["ramp", 3],
  ["square", 4],
  ["sample-hold", 5],
  ["noise", 6],
  ["perlin", 7],
  ["audio-input", 8],
  ["custom", 9],
  ["sample", 10],
  ["constant", 11],
]);

const MODULATION_TARGET_IDS = new Map([
  ["phase", 0],
  ["frequency", 1],
  ["wave", 5],
  ["phaseResetTrigger", 6],
  ["ring", 2],
  ["fold", 3],
  ["mix", 4],
  ["amplitude", 10],
  ["pan", 11],
  ["noise", 12],
  ["delay", 13],
  ["envelopeTrigger", 14],
  ["envelope.delay", 15],
  ["envelope.attack", 16],
  ["envelope.decay", 17],
  ["envelope.sustain", 18],
  ["envelope.release", 19],
  ["filterCutoff", 20],
  ["filterResonance", 21],
  ["distortionGain", 22],
  ["sampleTrigger", 23],
  ["sampleStart", 24],
  ["sampleEnd", 25],
  ["sampleStretch", 26],
  ["mapSrcMin", 27],
  ["mapSrcMax", 28],
  ["mapTargetMin", 29],
  ["mapTargetMax", 30],
]);

const SIGNAL_MODE_IDS = new Map([
  ["raw", 0],
  ["envelope", 1],
  ["inverted-envelope", 2],
  ["abs", 3],
  ["map", 4],
  ["abs-map", 5],
  ["map-abs", 6],
]);

const PARAMETER_MODE_IDS = new Map([
  ["set", 0],
  ["add", 1],
  ["multiply", 2],
  ["bend", 3],
]);

const FILTER_TYPE_IDS = new Map([
  ["none", 0],
  ["lowpass", 1],
  ["highpass", 2],
  ["bandpass", 3],
  ["formant", 4],
  ["comb", 5],
  ["comb-notch", 6],
]);
const DISTORTION_TYPE_IDS = new Map([
  ["hard-clip", 1],
  ["soft-clip", 2],
  ["fuzz", 3],
  ["saturate", 4],
  ["wavefold", 5],
]);
const CUSTOM_WAVE_MODE_IDS = new Map([
  ["loop", 0],
  ["once", 1],
  ["ping-pong", 2],
  ["sustain", 3],
  ["sustain-loop", 4],
  ["sustain-ping-pong", 5],
]);
const SAMPLE_MODE_IDS = new Map([
  ["one-shot", 0],
  ["loop", 1],
  ["ping-pong", 2],
]);
const DEFAULT_CUSTOM_WAVE = Object.freeze({
  mode: "loop",
  sustainStart: 0.5,
  sustainEnd: 0.75,
  points: Object.freeze([
    Object.freeze({ x: 0, y: 0 }),
    Object.freeze({ x: 1, y: 0 }),
  ]),
});
const QUANTISE_ROOT_NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const QUANTISE_SCALE_IDS = new Map([
  ["chromatic", 0],
  ["major", 1],
  ["minor", 2],
  ["major-pentatonic", 3],
  ["minor-pentatonic", 4],
  ["blues", 5],
  ["dorian", 6],
  ["mixolydian", 7],
  ["harmonic-minor", 8],
]);

class TeiaWasmEngine extends AudioWorkletProcessor {
  constructor(options = {}) {
    super();
    this.nodes = [];
    this.nodesById = new Map();
    this.links = [];
    this.linksById = new Map();
    this.dspProgram = null;
    this.sampleDataByNodeId = new Map();
    this.sampleDataByStorageKey = new Map();
    this.sampleSlotByStorageKey = new Map();
    this.imageDataByNodeId = new Map();
    this.graphUpdateCrossfade = this.normalizeGraphUpdateCrossfade(options.processorOptions?.audioConfig?.graphUpdateCrossfade);
    this.renderingStatus = {
      requestedMode: options.processorOptions?.audioConfig?.rendering?.mode || "single",
      mode: "single", workers: 0, parallelRepeats: 0,
      reason: options.processorOptions?.parallelFallbackReason || "",
    };
    this.parallelControls = [];
    this.parallelFailed = false;
    this.graphUpdateTransition = null;
    this.customWaveMorphEndSamples = new Map();
    this.pendingCustomWaveUpdates = new Map();
    this.maxVoices = 5;
    this.tempo = DEFAULT_TEMPO;
    this.voices = new Map();
    this.activeVoicesByNote = new Map();
    this.pendingVoiceStarts = [];
    this.pendingMidiNoteEvents = [];
    this.voiceCounter = 1;
    this.freeSlots = Array.from({ length: MAX_ACTIVE_VOICES }, (_, index) => index);
    this.sampleCursor = 0;
    this.nextLinkMeterPostSample = 0;
    this.lastOutputPeak = 0;
    this.lastGraphLeftSample = 0;
    this.lastGraphRightSample = 0;
    this.lastProcessFrames = 128;
    this.lastProcessorErrorAt = -Infinity;
    this.cpuLoad = null;
    this.cpuElapsedMs = 0;
    this.cpuDeadlineMs = 0;
    this.cpuPeakLoad = 0;
    this.cpuDeadlineMisses = 0;
    this.nextCpuLoadPostTime = 0;
    this.outputLifecycleGain = 0;
    this.dspRandomSeed = (Math.random() * 0x1_0000_0000) >>> 0;
    this.ready = false;
    this.muted = false;
    this.zeroVoicePhasesOnStart = false;
    this.wasmBytes = null;
    this.wasm = null;
    this.wasmMemoryBuffer = null;
    this.wasmMemoryBytes = 0;
    this.leftBuffer = null;
    this.rightBuffer = null;
    this.inputBuffer = null;
    this.inputLeftBuffer = null;
    this.inputRightBuffer = null;
    this.linkMeterInputSums = null;
    this.linkMeterOutputSums = null;
    this.linkMeterEnvelopeSums = null;
    this.linkMeterCounts = null;
    this.linkScopeRequest = null;
    this.linkScopeRequests = [];
    this.linkScopeRequestIndex = 0;
    this.monitorScopeStates = new Map();
    this.dspScopeStates = new Map();
    this.dspMeterStates = new Map();
    this.bufferSampleCounts = new Map();
    this.pendingBufferRestores = new Map();
    this.pendingBufferCopies = new Map();
    this.pendingBufferClears = new Set();
    this.bufferRestoreReplacementPending = false;
    this.midiButtonControlValues = new Map();
    this.graphVersion = 0;
    this.linkScopeSamples = null;
    if (!TEIA_RUNTIME_BUILD) {
      this.masterEffects = this.normalizeEffects();
      this.chorusBuffers = [
        new Float32Array(Math.ceil(sampleRate * 0.08)),
        new Float32Array(Math.ceil(sampleRate * 0.08)),
      ];
      this.chorusIndices = [0, 0];
      this.chorusPhases = [0, Math.PI * 0.5];
      this.delayBuffers = [
        new Float32Array(Math.ceil(sampleRate * 1.6)),
        new Float32Array(Math.ceil(sampleRate * 1.6)),
      ];
      this.delayIndices = [0, 0];
      this.reverbDelays = [this.createReverbDelays(), this.createReverbDelays()];
      this.inputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
      this.outputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
    }
    this.recordingCapture = null;

    this.port.onmessage = (event) => {
      // A timed-out helper may still own DSP memory. Quarantine this instance
      // until the main thread terminates every helper and closes the context.
      if (this.parallelFailed) return;
      const { type, payload } = event.data || {};
      if (type === "dspProgram") {
        this.setDspProgram(payload);
      } else if (type === "dspValues") {
        this.setDspValues(payload);
      } else if (type === "externalParameter") {
        this.setDspValueAt(payload?.valueIndex, payload?.value);
      } else if (type === "dspCustomWaves") {
        this.setDspCustomWaves(payload);
      } else if (type === "dspSequencers") {
        this.setDspSequencers(payload);
      } else if (type === "sampleData") {
        this.setSampleData(payload);
      } else if (type === "imageData") {
        this.setImageData(payload);
      } else if (type === "noteOn") {
        if (!this.muted) this.queueMidiNoteEvent(true, payload.channel, payload.note, payload.velocity);
      } else if (type === "noteOff") {
        this.queueMidiNoteEvent(false, payload.channel, payload.note, payload.velocity);
      } else if (type === "midiCc") {
        this.setMidiCc(payload);
      } else if (type === "midiClockTempo") {
        this.setMidiClockTempo(payload);
      } else if (type === "panic") {
        this.resetRuntimeState();
      } else if (type === "setMuted") {
        this.setMuted(Boolean(payload?.muted));
      } else if (type === "startRecording") {
        this.startRecordingCapture(payload);
      } else if (type === "stopRecording") {
        this.stopRecordingCapture(payload);
      } else if (type === "captureBuffer") {
        this.captureBuffer(payload);
      } else if (type === "copyBuffers") {
        this.copyBuffers(payload);
      } else if (type === "clearBuffers") {
        this.clearBuffers(payload);
      } else if (type === "restoreBuffers") {
        this.setBufferRestores(payload);
      } else if (type === "packageReady") {
        this.port.postMessage({ type: "packageReady" });
      } else if (type === "setLinkScope") {
        this.setLinkScopes(payload);
      } else if (type === "setLinkScopes") {
        this.setLinkScopes(payload);
      }
    };

    this.loadWasm(options.processorOptions || {});
  }

  captureBuffer(payload = {}) {
    const requestId = Number(payload?.requestId);
    const nodeId = String(payload?.nodeId || "");
    let samples = null;
    if (Number.isFinite(requestId) && nodeId && this.wasm?.memory && this.wasm?.dspBufferPtr) {
      const binding = (this.dspProgram?.stateBindings || []).find((candidate) => (
        candidate.nodeId === nodeId && String(candidate.id || "").endsWith(":buffer")
      ));
      const bufferLength = Math.max(0, Math.trunc(Number(this.wasm.dspBufferLength?.()) || 0));
      if (binding && bufferLength > 0) {
        const ptr = this.wasm.dspBufferPtr(binding.state);
        if (ptr) {
          const lengthSeconds = Number(this.wasm.getDspState?.(binding.state + 3));
          const renderedSampleCount = Number.isFinite(lengthSeconds) && lengthSeconds > 0
            ? Math.round(lengthSeconds * sampleRate)
            : 0;
          const sampleCount = this.clamp(
            renderedSampleCount || this.bufferSampleCounts.get(nodeId) || 2,
            2,
            bufferLength,
          );
          samples = new Float32Array(this.wasm.memory.buffer, ptr, sampleCount).slice();
        }
      }
    }
    const message = {
      type: "bufferSnapshot",
      payload: { requestId, nodeId, sampleRate, samples },
    };
    this.port.postMessage(message, samples ? [samples.buffer] : []);
  }

  setBufferRestores(payload = {}) {
    this.pendingBufferRestores.clear();
    this.bufferRestoreReplacementPending = true;
    for (const entry of Array.isArray(payload?.buffers) ? payload.buffers : []) {
      const nodeId = String(entry?.nodeId || "");
      const sourceSampleRate = Number(entry?.sampleRate);
      const samples = entry?.samples instanceof Float32Array
        ? entry.samples
        : entry?.samples instanceof ArrayBuffer
          ? new Float32Array(entry.samples)
          : null;
      if (!nodeId || !samples?.length || !Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0) continue;
      this.pendingBufferRestores.set(nodeId, { samples, sampleRate: sourceSampleRate });
    }
    this.applyPendingBufferRestores();
  }

  copyBuffers(payload = {}) {
    for (const entry of Array.isArray(payload?.copies) ? payload.copies : []) {
      const sourceNodeId = String(entry?.sourceNodeId || "");
      const targetNodeId = String(entry?.targetNodeId || "");
      if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) continue;
      this.pendingBufferCopies.set(targetNodeId, sourceNodeId);
    }
    this.applyPendingBufferCopies();
  }

  clearBuffers(payload = {}) {
    for (const nodeIdValue of Array.isArray(payload?.nodeIds) ? payload.nodeIds : []) {
      const nodeId = String(nodeIdValue || "");
      if (nodeId) this.pendingBufferClears.add(nodeId);
    }
    this.applyPendingBufferClears();
  }

  applyPendingBufferClears() {
    if (!this.wasm?.memory || !this.wasm?.dspBufferPtr || !this.dspProgram) return;
    const bufferLength = Math.max(0, Math.trunc(Number(this.wasm.dspBufferLength?.()) || 0));
    if (bufferLength <= 0) return;

    for (const nodeId of this.pendingBufferClears) {
      const binding = this.dspProgram.stateBindings?.find((candidate) => (
        candidate.nodeId === nodeId && String(candidate.id || "").endsWith(":buffer")
      ));
      if (!binding) continue;
      const ptr = this.wasm.dspBufferPtr(binding.state);
      if (!ptr) continue;
      new Float32Array(this.wasm.memory.buffer, ptr, bufferLength).fill(0);
      this.pendingBufferClears.delete(nodeId);
    }
  }

  applyPendingBufferCopies() {
    if (!this.wasm?.memory || !this.wasm?.dspBufferPtr || !this.dspProgram) return;
    const bufferLength = Math.max(0, Math.trunc(Number(this.wasm.dspBufferLength?.()) || 0));
    if (bufferLength <= 0) return;

    for (const [targetNodeId, sourceNodeId] of this.pendingBufferCopies) {
      const sourceBinding = (this.dspProgram.stateBindings || []).find((candidate) => (
        candidate.nodeId === sourceNodeId && String(candidate.id || "").endsWith(":buffer")
      ));
      const targetBinding = (this.dspProgram.stateBindings || []).find((candidate) => (
        candidate.nodeId === targetNodeId && String(candidate.id || "").endsWith(":buffer")
      ));
      if (!sourceBinding || !targetBinding) continue;

      const sourcePtr = this.wasm.dspBufferPtr(sourceBinding.state);
      const targetPtr = this.wasm.dspBufferPtr(targetBinding.state);
      if (!sourcePtr || !targetPtr) continue;

      const source = new Float32Array(this.wasm.memory.buffer, sourcePtr, bufferLength);
      const target = new Float32Array(this.wasm.memory.buffer, targetPtr, bufferLength);
      target.set(source);
      const lengthSeconds = Number(this.wasm.getDspState?.(sourceBinding.state + 3));
      if (Number.isFinite(lengthSeconds)) {
        this.wasm.setDspState?.(targetBinding.state + 3, lengthSeconds);
      }
      const sourceSampleCount = this.bufferSampleCounts.get(sourceNodeId);
      if (sourceSampleCount !== undefined) {
        this.bufferSampleCounts.set(targetNodeId, sourceSampleCount);
      }
      this.pendingBufferCopies.delete(targetNodeId);
    }
  }

  applyPendingBufferRestores() {
    if (!this.wasm?.memory || !this.wasm?.dspBufferPtr || !this.dspProgram) return;
    const bufferLength = Math.max(0, Math.trunc(Number(this.wasm.dspBufferLength?.()) || 0));
    if (bufferLength <= 0) return;

    if (this.bufferRestoreReplacementPending) {
      for (const binding of this.dspProgram.stateBindings || []) {
        if (!String(binding.id || "").endsWith(":buffer")) continue;
        const ptr = this.wasm.dspBufferPtr(binding.state);
        if (ptr) new Float32Array(this.wasm.memory.buffer, ptr, bufferLength).fill(0);
      }
      this.bufferSampleCounts.clear();
      this.bufferRestoreReplacementPending = false;
    }

    for (const [nodeId, snapshot] of this.pendingBufferRestores) {
      const binding = (this.dspProgram.stateBindings || []).find((candidate) => (
        candidate.nodeId === nodeId && String(candidate.id || "").endsWith(":buffer")
      ));
      if (!binding) continue;
      const ptr = this.wasm.dspBufferPtr(binding.state);
      if (!ptr) continue;
      const target = new Float32Array(this.wasm.memory.buffer, ptr, bufferLength);
      target.fill(0);
      if (this.wasm.restoreDspBufferSnapshot) {
        target.set(snapshot.samples.subarray(0, bufferLength));
        const restored = this.wasm.restoreDspBufferSnapshot(binding.state, snapshot.samples.length, snapshot.sampleRate, sampleRate);
        if (restored >= 0) {
          this.bufferSampleCounts.set(nodeId, restored);
          this.pendingBufferRestores.delete(nodeId);
        }
        continue;
      }
      // Compatibility with kernels predating shared snapshot preparation.
      const targetCount = this.clamp(
        Math.round(snapshot.samples.length * sampleRate / snapshot.sampleRate),
        2,
        bufferLength,
      );
      if (targetCount === snapshot.samples.length && snapshot.sampleRate === sampleRate) {
        target.set(snapshot.samples.subarray(0, targetCount));
      } else {
        for (let index = 0; index < targetCount; index += 1) {
          const sourcePosition = targetCount <= 1
            ? 0
            : index * (snapshot.samples.length - 1) / (targetCount - 1);
          const sourceIndex = Math.floor(sourcePosition);
          const nextIndex = Math.min(snapshot.samples.length - 1, sourceIndex + 1);
          const mix = sourcePosition - sourceIndex;
          target[index] = snapshot.samples[sourceIndex] * (1 - mix) + snapshot.samples[nextIndex] * mix;
        }
      }
      this.wasm.setDspState?.(binding.state + 3, targetCount / sampleRate);
      this.bufferSampleCounts.set(nodeId, targetCount);
      this.pendingBufferRestores.delete(nodeId);
    }
  }

  normalizeGraphUpdateCrossfade(config = {}) {
    const seconds = Number(config?.seconds);
    return {
      enabled: Boolean(config?.enabled),
      seconds: Number.isFinite(seconds)
        ? this.clamp(seconds, 0.001, MAX_WASM_FRAMES / sampleRate)
        : DEFAULT_GRAPH_UPDATE_CROSSFADE_SECONDS,
    };
  }

  startRecordingCapture(payload = {}) {
    const id = String(payload?.id ?? "");
    const channelCount = this.clamp(
      Math.round(Number(payload?.channelCount) || RECORDING_CHANNEL_COUNT),
      1,
      RECORDING_CHANNEL_COUNT,
    );
    const chunkFrames = this.clamp(
      Math.round(Number(payload?.chunkFrames) || RECORDING_CHUNK_FRAMES),
      128,
      Math.max(128, Math.round(sampleRate * 2)),
    );
    this.recordingCapture = {
      id,
      channelCount,
      chunkFrames,
      buffers: Array.from({ length: channelCount }, () => new Float32Array(chunkFrames)),
      index: 0,
      frames: 0,
      chunks: 0,
      sampleEvents: [],
    };
    this.port.postMessage({
      type: "recordingStarted",
      payload: {
        id,
        sampleRate,
        channelCount,
        chunkFrames,
      },
    });
  }

  stopRecordingCapture(payload = {}) {
    const id = String(payload?.id ?? "");
    const capture = this.recordingCapture;
    if (!capture || (id && capture.id !== id)) return;
    this.flushRecordingChunk(capture);
    this.recordingCapture = null;
    this.port.postMessage({
      type: "recordingStopped",
      payload: {
        id: capture.id,
        sampleRate,
        channelCount: capture.channelCount,
        frames: capture.frames,
        chunks: capture.chunks,
        sampleEvents: capture.sampleEvents,
      },
    });
  }

  recordOutputSamples(left, right, frames) {
    const capture = this.recordingCapture;
    if (!capture || !left) return;
    const rightSource = right || left;
    const usableFrames = Math.max(0, Math.min(frames, left.length));
    let offset = 0;
    while (offset < usableFrames) {
      const count = Math.min(usableFrames - offset, capture.chunkFrames - capture.index);
      capture.buffers[0].set(left.subarray(offset, offset + count), capture.index);
      if (capture.channelCount > 1) {
        capture.buffers[1].set(rightSource.subarray(offset, offset + count), capture.index);
      }
      capture.index += count;
      capture.frames += count;
      offset += count;
      if (capture.index >= capture.chunkFrames) {
        this.flushRecordingChunk(capture);
      }
    }
  }

  captureSampleTriggerEvents() {
    const capture = this.recordingCapture;
    const wasm = this.wasm;
    if (!capture || !wasm?.sampleTriggerEventCount || !wasm?.sampleTriggerEventValue) return;
    const count = Math.max(0, Math.trunc(Number(wasm.sampleTriggerEventCount()) || 0));
    for (let event = 0; event < count; event += 1) {
      const value = (field) => Number(wasm.sampleTriggerEventValue(event, field)) || 0;
      const sampleIndex = Math.trunc(value(0));
      const binding = this.dspProgram?.sampleBindings?.[sampleIndex];
      capture.sampleEvents.push({
        nodeId: binding?.nodeId || "",
        sampleName: binding?.sample?.name || "",
        startMs: value(2),
        endMs: value(3),
        speed: value(4),
        volume: value(5),
        attackMs: value(6),
        releaseMs: value(7),
        triggerTimeMs: (capture.frames + value(1)) / sampleRate * 1000,
      });
    }
  }

  flushRecordingChunk(capture) {
    const frames = capture.index;
    if (frames <= 0) return;
    const channels = capture.buffers.map((buffer) => (
      frames === buffer.length ? buffer : buffer.slice(0, frames)
    ));
    const startFrame = capture.frames - frames;
    capture.chunks += 1;
    capture.buffers = Array.from({ length: capture.channelCount }, () => new Float32Array(capture.chunkFrames));
    capture.index = 0;
    const message = {
      type: "recordingChunk",
      payload: {
        id: capture.id,
        sequence: capture.chunks,
        startFrame,
        frames,
        channels,
      },
    };
    this.port.postMessage(message, channels.map((channel) => channel.buffer));
  }

  async loadWasm({ wasmBytes, wasmUrl, parallelEngine, audioConfig } = {}) {
    try {
      let bytes = wasmBytes;
      if (!bytes) {
        if (!wasmUrl || typeof fetch !== "function") {
          throw new Error("Missing WASM kernel bytes.");
        }
        const response = await fetch(wasmUrl);
        if (!response.ok) {
          throw new Error(`Could not fetch WASM kernel (${response.status}).`);
        }
        bytes = await response.arrayBuffer();
      }
      let instance;
      if (parallelEngine) {
        try {
          instance = await WebAssembly.instantiate(parallelEngine.module, {
            env: { memory: parallelEngine.memory },
            parallel: {
              now: () => this.cpuClockNow(),
              wake: () => {
                for (const control of this.parallelControls) Atomics.notify(control, 0, 1);
              },
            },
          });
          if (instance.exports.__tls_size.value > 65536 || instance.exports.__tls_align.value > 65536) {
            throw new Error("Parallel WASM thread-local storage is too large.");
          }
          instance.exports.__wasm_init_tls(instance.exports.dspParallelTlsPtr(1));
          this.parallelControls = Array.from({ length: parallelEngine.workers }, (_, worker) => (
            new Int32Array(parallelEngine.memory.buffer, instance.exports.dspParallelControlPtr(worker), 3)
          ));
          instance.exports.configureDspParallel(parallelEngine.workers);
          this.renderingStatus.mode = "multi";
          this.renderingStatus.workers = parallelEngine.workers;
        } catch (error) {
          this.renderingStatus.reason = error?.message || "Shared WASM could not start.";
          this.parallelControls = [];
        }
      }
      if (this.renderingStatus.mode !== "multi") {
        ({ instance } = await WebAssembly.instantiate(bytes, {}));
      }
      this.wasmBytes = bytes;
      this.wasm = instance.exports;
      this.refreshWasmViews(false);
      this.wasm.resetPhases();
      this.wasm.seedDspRandom?.(this.dspRandomSeed || 1);
      this.ready = true;
      this.syncDspProgram();
      this.refreshWasmViews(true);
      this.configureDspScopes();
      this.configureDspMeters();
      this.wasm.compileDspBlockPlan?.();
      this.refreshWasmViews(true);
      if (!TEIA_RUNTIME_BUILD) this.postRenderingStatus();
      this.port.postMessage({
        type: "backendStatus",
        payload: {
          backend: "wasm",
          ready: true,
          memoryBytes: this.wasm.memory.buffer.byteLength,
          lazyBufferBytes: Number(this.wasm.lazyBufferBytes?.()) || 0,
        },
      });
    } catch (error) {
      this.port.postMessage({
        type: "backendStatus",
        payload: { backend: "wasm", ready: false, error: error?.message || "WASM failed to load." },
      });
    }
  }

  postRenderingStatus() {
    this.renderingStatus.parallelRepeats = Number(this.wasm?.dspParallelRepeatCount?.()) || 0;
    this.port.postMessage({ type: "renderingStatus", payload: this.renderingStatus });
  }

  refreshWasmViews(reportGrowth = true) {
    const buffer = this.wasm?.memory?.buffer;
    if (!buffer || buffer === this.wasmMemoryBuffer) return false;
    const previousBytes = this.wasmMemoryBytes;
    this.wasmMemoryBuffer = buffer;
    this.wasmMemoryBytes = buffer.byteLength;
    const leftOffset = typeof this.wasm.leftPtr === "function" ? this.wasm.leftPtr() : LEFT_OFFSET;
    const rightOffset = typeof this.wasm.rightPtr === "function" ? this.wasm.rightPtr() : RIGHT_OFFSET;
    this.inputLeftBuffer = typeof this.wasm.inputLeftPtr === "function" ? new Float32Array(buffer, this.wasm.inputLeftPtr(), MAX_WASM_FRAMES) : null;
    this.inputRightBuffer = typeof this.wasm.inputRightPtr === "function" ? new Float32Array(buffer, this.wasm.inputRightPtr(), MAX_WASM_FRAMES) : null;
    this.leftBuffer = new Float32Array(buffer, leftOffset, MAX_WASM_FRAMES);
    this.rightBuffer = new Float32Array(buffer, rightOffset, MAX_WASM_FRAMES);
    this.inputBuffer = typeof this.wasm.inputPtr === "function"
      ? new Float32Array(buffer, this.wasm.inputPtr(), MAX_WASM_FRAMES)
      : null;
    if (!TEIA_RUNTIME_BUILD &&
      typeof this.wasm.linkMeterInputPtr === "function"
      && typeof this.wasm.linkMeterOutputPtr === "function"
      && typeof this.wasm.linkMeterEnvelopePtr === "function"
      && typeof this.wasm.linkMeterCountPtr === "function"
    ) {
      this.linkMeterInputSums = new Float64Array(buffer, this.wasm.linkMeterInputPtr(), 1024);
      this.linkMeterOutputSums = new Float64Array(buffer, this.wasm.linkMeterOutputPtr(), 1024);
      this.linkMeterEnvelopeSums = new Float64Array(buffer, this.wasm.linkMeterEnvelopePtr(), 1024);
      this.linkMeterCounts = new Uint32Array(buffer, this.wasm.linkMeterCountPtr(), 1024);
    }
    this.linkScopeSamples = !TEIA_RUNTIME_BUILD && typeof this.wasm.linkScopePtr === "function"
      ? new Float32Array(buffer, this.wasm.linkScopePtr(), 1024)
      : null;
    this.refreshDspScopeViews(buffer);
    if (reportGrowth && !TEIA_RUNTIME_BUILD) {
      this.port.postMessage({
        type: "wasmMemory",
        payload: {
          previousBytes,
          memoryBytes: buffer.byteLength,
          lazyBufferBytes: Number(this.wasm.lazyBufferBytes?.()) || 0,
        },
      });
    }
    return true;
  }

  refreshDspScopeViews(buffer = this.wasm?.memory?.buffer) {
    if (!buffer || !this.wasm?.dspScopePtr) return;
    for (const state of this.dspScopeStates.values()) {
      const ptr = this.wasm.dspScopePtr(state.slot);
      state.samples = ptr ? new Float32Array(buffer, ptr, 1024) : null;
    }
  }

  setDspProgram(program = {}) {
    const previousProgram = this.dspProgram;
    const preservedState = this.captureDspState(previousProgram);
    const preservedMidiControls = this.captureMidiControlValues(previousProgram);
    const hasTransition = this.prepareGraphUpdateCrossfade();
    const nextProgram = this.normalizeDspProgram(program);
    this.restoreMidiControlValues(nextProgram, preservedMidiControls);
    const repeatMigration = this.captureDspRepeatMigration(previousProgram, nextProgram);
    const sampleMigration = this.captureDspSampleMigration(previousProgram, nextProgram);
    this.dspProgram = nextProgram;
    if (!hasTransition) {
      this.outputLifecycleGain = 0;
    }
    this.nodes = [];
    this.nodesById = new Map();
    this.links = [];
    this.linksById = new Map();
    this.monitorScopeStates.clear();
    this.customWaveMorphEndSamples.clear();
    this.pendingCustomWaveUpdates.clear();
    this.syncDspProgram(preservedState, repeatMigration, sampleMigration);
    this.refreshWasmViews(true);
    this.configureDspScopes();
    this.configureDspMeters();
    this.wasm?.compileDspBlockPlan?.();
    this.refreshWasmViews(true);
  }

  captureMidiControlValues(program) {
    const values = new Map();
    if (!program) return values;

    for (const binding of program.midiControlBindings || []) {
      const key = this.midiControlBindingKey(binding);
      const previous = values.get(key) || {};
      previous.value = Number(program.values[binding.valueIndex] ?? 0);
      if (binding.kind === "button" && binding.clicksValueIndex >= 0) {
        previous.clicks = Number(program.values[binding.clicksValueIndex] ?? 0);
      }
      values.set(key, previous);
    }

    return values;
  }

  restoreMidiControlValues(program, preservedValues) {
    if (!program || !preservedValues?.size) return;

    for (const binding of program.midiControlBindings || []) {
      const preserved = preservedValues.get(this.midiControlBindingKey(binding));
      if (!preserved) continue;
      if (Number.isFinite(preserved.value)) program.values[binding.valueIndex] = preserved.value;
      if (binding.kind === "button" && binding.clicksValueIndex >= 0 && Number.isFinite(preserved.clicks)) {
        program.values[binding.clicksValueIndex] = preserved.clicks;
      }
    }
  }

  midiControlBindingKey(binding) {
    return `${binding.nodeId}:${binding.kind}:${binding.channel}:${binding.cc}`;
  }

  prepareGraphUpdateCrossfade() {
    if (
      !this.graphUpdateCrossfade.enabled
      || this.muted
      || !this.ready
      || !this.wasm
      || !this.dspProgram
      || this.dspProgram.errors.length > 0
      || this.dspProgram.ops.length === 0
    ) {
      this.graphUpdateTransition = null;
      return false;
    }

    const frames = Math.max(1, Math.min(MAX_WASM_FRAMES, Math.round(this.graphUpdateCrossfade.seconds * sampleRate)));
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    left.fill(this.lastGraphLeftSample || 0);
    right.fill(this.lastGraphRightSample || this.lastGraphLeftSample || 0);

    this.graphUpdateTransition = {
      left,
      right,
      index: 0,
      frames,
    };
    return true;
  }

  setDspValues(payload = {}) {
    if (!this.dspProgram || !this.wasm?.setDspValue) return;
    const values = Array.isArray(payload.values)
      ? payload.values.map(Number).map((value) => Number.isFinite(value) ? value : 0)
      : [];
    if (values.length !== this.dspProgram.values.length) return;

    const analyserValueIndexes = new Set((this.dspProgram.fftBindings || []).flatMap((binding) => [
      binding.frequencyValueIndex,
      binding.amplitudeValueIndex,
    ]));
    for (let index = 0; index < values.length; index += 1) {
      if (analyserValueIndexes.has(index)) continue;
      if (values[index] === this.dspProgram.values[index]) continue;
      this.setDspValueAt(index, values[index]);
    }
  }

  setDspCustomWaves(payload = {}) {
    if (!this.dspProgram || !this.wasm?.beginCustomWaveUpdate || !this.wasm?.finishCustomWaveUpdate) return;
    const incomingBindings = Array.isArray(payload.bindings) ? payload.bindings : [];
    const currentBindingsByNodeId = new Map(
      this.dspProgram.customWaveBindings.map((binding, index) => [binding.nodeId, { binding, index }]),
    );

    for (const incomingBinding of incomingBindings) {
      const nodeId = String(incomingBinding?.nodeId || "");
      const current = currentBindingsByNodeId.get(nodeId);
      const node = this.nodesById.get(nodeId);
      if (!current || !node || node.wasmIndex < 0) continue;

      const nextCustomWave = this.normalizeCustomWave(incomingBinding?.customWave);
      if (this.customWavePointsEqual(current.binding.customWave.points, nextCustomWave.points)) {
        this.pendingCustomWaveUpdates.delete(nodeId);
        continue;
      }
      if ((this.customWaveMorphEndSamples.get(nodeId) || 0) > this.sampleCursor) {
        // Coalesce rapid edits so a new curve never interrupts an active morph.
        this.pendingCustomWaveUpdates.set(nodeId, nextCustomWave);
        continue;
      }

      this.applyDspCustomWaveUpdate(nodeId, nextCustomWave);
    }
  }

  setDspSequencers(payload = {}) {
    if (!this.dspProgram) return;
    const bindings = this.normalizeSequencerBindings(payload.bindings);
    if (
      bindings.length !== this.dspProgram.sequencerBindings.length
      || bindings.some((binding, index) => binding.nodeId !== this.dspProgram.sequencerBindings[index]?.nodeId)
    ) {
      return;
    }
    this.dspProgram.sequencerBindings = bindings;
    this.syncDspSequencers();
  }

  normalizeSequencerBindings(bindings) {
    if (!Array.isArray(bindings)) return [];
    return bindings.map((binding) => {
      const steps = this.clamp(Math.round(Number(binding?.steps) || 1), 1, 128);
      const rows = this.clamp(Math.round(Number(binding?.rows) || 1), 1, 128);
      return {
        nodeId: String(binding?.nodeId || ""),
        mode: binding?.mode === "gate" ? "gate" : "trigger",
        steps,
        rows,
        events: Array.from({ length: rows }, (_, row) => (
          Array.from({ length: steps }, (_, slot) => {
            const event = binding?.events?.[row]?.[slot];
            return {
              active: Boolean(event?.active),
              start: Number.isFinite(Number(event?.start)) ? Number(event.start) : slot,
              end: Number.isFinite(Number(event?.end)) ? Number(event.end) : slot,
              velocity: this.clamp(Number(event?.velocity) || 1, 0, 1),
              note: Number.isFinite(Number(event?.note)) ? Number(event.note) : row,
            };
          })
        )),
      };
    }).filter((binding) => binding.nodeId);
  }

  syncDspSequencers() {
    if (!this.wasm?.beginDspSequencerUpdate || !this.wasm?.setDspSequencerEvent) return;
    for (let bindingIndex = 0; bindingIndex < this.dspProgram.sequencerBindings.length; bindingIndex += 1) {
      const binding = this.dspProgram.sequencerBindings[bindingIndex];
      this.wasm.beginDspSequencerUpdate(
        bindingIndex,
        binding.mode === "gate" ? 1 : 0,
        binding.steps,
        binding.rows,
      );
      for (let row = 0; row < binding.rows; row += 1) {
        for (let slot = 0; slot < binding.steps; slot += 1) {
          const event = binding.events[row][slot];
          this.wasm.setDspSequencerEvent(
            bindingIndex,
            row,
            slot,
            event.active ? 1 : 0,
            event.start,
            event.end,
            event.velocity,
            event.note,
          );
        }
      }
    }
  }

  applyDspCustomWaveUpdate(nodeId, nextCustomWave) {
    const bindingIndex = this.dspProgram?.customWaveBindings.findIndex((binding) => binding.nodeId === nodeId) ?? -1;
    const node = this.nodesById.get(nodeId);
    if (bindingIndex < 0 || !node || node.wasmIndex < 0) return;

    const morphFrames = Math.max(1, Math.round(this.graphUpdateCrossfade.seconds * sampleRate));
    this.wasm.beginCustomWaveUpdate(node.wasmIndex);
    for (const point of nextCustomWave.points) {
      this.wasm.addCustomWavePoint(node.wasmIndex, point.x, point.y);
    }
    this.wasm.finishCustomWaveUpdate(node.wasmIndex, morphFrames);
    node.customWave = nextCustomWave;
    this.dspProgram.customWaveBindings[bindingIndex] = {
      ...this.dspProgram.customWaveBindings[bindingIndex],
      customWave: nextCustomWave,
    };
    this.customWaveMorphEndSamples.set(nodeId, this.sampleCursor + morphFrames);
    this.pendingCustomWaveUpdates.delete(nodeId);
  }

  flushPendingCustomWaveUpdates() {
    for (const [nodeId, customWave] of this.pendingCustomWaveUpdates) {
      if ((this.customWaveMorphEndSamples.get(nodeId) || 0) > this.sampleCursor) continue;
      this.applyDspCustomWaveUpdate(nodeId, customWave);
    }
  }

  customWavePointsEqual(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (left[index]?.x !== right[index]?.x || left[index]?.y !== right[index]?.y) return false;
    }
    return true;
  }

  setDspValueAt(index, value) {
    if (!this.dspProgram || !this.wasm?.setDspValue) return;
    const valueIndex = Math.trunc(Number(index));
    if (!Number.isFinite(valueIndex) || valueIndex < 0 || valueIndex >= this.dspProgram.values.length) return;
    const normalized = Number(value);
    const nextValue = Number.isFinite(normalized) ? normalized : 0;
    if (this.dspProgram.values[valueIndex] === nextValue) return;
    this.dspProgram.values[valueIndex] = nextValue;
    const isImmediate = this.dspProgram.immediateValueIndexes?.has(valueIndex);
    const setValue = isImmediate && this.wasm.setDspValueImmediate
      ? this.wasm.setDspValueImmediate.bind(this.wasm)
      : this.wasm.setDspValue.bind(this.wasm);
    setValue(valueIndex, nextValue);
  }

  normalizeDspProgram(program = {}) {
    const ops = Array.isArray(program.ops)
      ? program.ops.map((op) => ({
        opcode: Math.trunc(Number(op.opcode)),
        out: Math.trunc(Number(op.out ?? -1)),
        a: Math.trunc(Number(op.a ?? -1)),
        b: Math.trunc(Number(op.b ?? -1)),
        c: Math.trunc(Number(op.c ?? -1)),
        d: Math.trunc(Number(op.d ?? -1)),
        e: Math.trunc(Number(op.e ?? -1)),
        state: Math.trunc(Number(op.state ?? -1)),
        value: Number(op.value ?? 0),
        value2: Number(op.value2 ?? 0),
        value3: Number(op.value3 ?? 0),
        value4: Number(op.value4 ?? 0),
      })).filter((op) => Number.isFinite(op.opcode))
      : [];
    const values = Array.isArray(program.values)
      ? program.values.map(Number).map((value) => Number.isFinite(value) ? value : 0)
      : [];
    const errors = Array.isArray(program.errors)
      ? program.errors.map(String).filter(Boolean)
      : [];
    const immediateValueIndexes = new Set(
      ops
        .filter((op) => op.opcode === 0 && op.value >= 1)
        .map((op) => op.a)
        .filter((valueIndex) => valueIndex >= 0 && valueIndex < values.length),
    );
    const stateBindings = Array.isArray(program.stateBindings)
      ? program.stateBindings.map((binding) => ({
        id: String(binding?.id || ""),
        state: Math.trunc(Number(binding?.state ?? -1)),
        count: Math.max(0, Math.trunc(Number(binding?.count ?? 0))),
        kind: ["filter", "feedback", "selector", "effect", "sequencer"].includes(binding?.kind) ? binding.kind : "oscillator",
        nodeId: String(binding?.nodeId || ""),
      })).filter((binding) => binding.id && binding.state >= 0 && binding.count > 0)
      : [];
    const monitorIds = {};
    if (program.monitorIds && typeof program.monitorIds === "object") {
      for (const [id, register] of Object.entries(program.monitorIds)) {
        const registerNumber = Math.trunc(Number(register));
        if (id && Number.isFinite(registerNumber)) monitorIds[String(id)] = registerNumber;
      }
    }
    const sampleBindings = Array.isArray(program.sampleBindings)
      ? program.sampleBindings.map((binding) => ({
        nodeId: String(binding?.nodeId || ""),
        sample: {
          name: String(binding?.sample?.name || ""),
          url: String(binding?.sample?.url || ""),
        },
        release: Math.max(0, Number(binding?.release) || 0),
      })).filter((binding) => binding.nodeId)
      : [];
    const imageBindings = Array.isArray(program.imageBindings)
      ? program.imageBindings.map((binding) => ({
        nodeId: String(binding?.nodeId || ""),
        image: { name: String(binding?.image?.name || ""), url: String(binding?.image?.url || "") },
      })).filter((binding) => binding.nodeId)
      : [];
    const customWaveBindings = Array.isArray(program.customWaveBindings)
      ? program.customWaveBindings.map((binding) => ({
        nodeId: String(binding?.nodeId || ""),
        customWave: this.normalizeCustomWave(binding?.customWave),
      })).filter((binding) => binding.nodeId)
      : [];
    const sequencerBindings = this.normalizeSequencerBindings(program.sequencerBindings);
    const repeatBindings = Array.isArray(program.repeatBindings)
      ? program.repeatBindings.map((binding) => ({
        nodeId: String(binding?.nodeId || ""),
        type: binding?.type === "Spawn" ? "Spawn" : "Spread",
        slot: Math.max(0, Math.trunc(Number(binding?.slot) || 0)),
        stateStart: Math.max(0, Math.trunc(Number(binding?.stateStart) || 0)),
        stateCount: Math.max(0, Math.trunc(Number(binding?.stateCount) || 0)),
      })).filter((binding) => binding.nodeId)
      : [];
    const fftBindings = Array.isArray(program.fftBindings)
      ? program.fftBindings.map((binding) => ({
        nodeId: String(binding?.nodeId || ""),
        inputRegister: Math.trunc(Number(binding?.inputRegister ?? -1)),
        minFrequencyValueIndex: Math.trunc(Number(binding?.minFrequencyValueIndex ?? -1)),
        maxFrequencyValueIndex: Math.trunc(Number(binding?.maxFrequencyValueIndex ?? -1)),
        frequencyValueIndex: Math.trunc(Number(binding?.frequencyValueIndex ?? -1)),
        amplitudeValueIndex: Math.trunc(Number(binding?.amplitudeValueIndex ?? -1)),
      })).filter((binding) => (
        binding.nodeId
        && binding.inputRegister >= 0
        && binding.minFrequencyValueIndex >= 0
        && binding.minFrequencyValueIndex < values.length
        && binding.maxFrequencyValueIndex >= 0
        && binding.maxFrequencyValueIndex < values.length
        && binding.frequencyValueIndex >= 0
        && binding.frequencyValueIndex < values.length
        && binding.amplitudeValueIndex >= 0
        && binding.amplitudeValueIndex < values.length
      ))
      : [];
    const midiControlBindings = Array.isArray(program.midiControlBindings)
      ? program.midiControlBindings.map((binding) => ({
        nodeId: String(binding?.nodeId || ""),
        kind: binding?.kind === "button" ? "button" : "slider",
        channel: this.clamp(Math.round(Number(binding?.channel)), 1, 16),
        cc: this.clamp(Math.round(Number(binding?.cc)), 0, 127),
        valueIndex: Math.trunc(Number(binding?.valueIndex ?? -1)),
        modeValueIndex: Math.trunc(Number(binding?.modeValueIndex ?? -1)),
        clicksValueIndex: Math.trunc(Number(binding?.clicksValueIndex ?? -1)),
      })).filter((binding) => (
        binding.nodeId &&
        binding.valueIndex >= 0 &&
        binding.valueIndex < values.length &&
        binding.cc >= 0 &&
        binding.cc <= 127 &&
        binding.channel >= 1 &&
        binding.channel <= 16
      ))
      : [];
    const tempoBindings = Array.isArray(program.tempoBindings)
      ? program.tempoBindings.map((binding) => ({
        nodeId: String(binding?.nodeId || ""),
        sourceValueIndex: Math.trunc(Number(binding?.sourceValueIndex ?? -1)),
        midiSourceValueIndex: Math.trunc(Number(binding?.midiSourceValueIndex ?? -1)),
      })).filter((binding) => (
        binding.nodeId &&
        binding.sourceValueIndex >= 0 &&
        binding.sourceValueIndex < values.length &&
        binding.midiSourceValueIndex >= 0 &&
        binding.midiSourceValueIndex < values.length
      ))
      : [];

    return {
      version: 1,
      engineApiVersion: program.engineApiVersion === 2 ? 2 : 1,
      ops,
      values,
      immediateValueIndexes,
      midiControlBindings,
      tempoBindings,
      stateBindings,
      registerCount: Math.max(0, Math.trunc(Number(program.registerCount) || 0)),
      stateCount: Math.max(0, Math.trunc(Number(program.stateCount) || 0)),
      monitorIds,
      signedMeterIds: Array.isArray(program.signedMeterIds)
        ? program.signedMeterIds.map(String)
        : [],
      sampleBindings,
      imageBindings,
      customWaveBindings,
      sequencerBindings,
      repeatBindings,
      fftBindings,
      maxVoices: this.clamp(Math.round(Number(program.maxVoices) || 1), 1, MAX_ACTIVE_VOICES),
      usesMidiNote: Boolean(program.usesMidiNote),
      usesMidiClock: Boolean(program.usesMidiClock),
      feedbackLinkIds: Array.isArray(program.feedbackLinkIds) ? program.feedbackLinkIds.map(String) : [],
      errors,
    };
  }

  captureDspState(program) {
    if (!program || !this.wasm?.getDspState) return new Map();

    const states = new Map();
    for (const binding of program.stateBindings || []) {
      const values = [];
      for (let offset = 0; offset < binding.count; offset += 1) {
        values.push(Number(this.wasm.getDspState(binding.state + offset)) || 0);
      }
      states.set(binding.id, values);
    }
    for (const op of program.ops || []) {
      if (op.opcode !== 3 || op.a !== 9 || op.state < 0) continue;
      const binding = program.customWaveBindings?.[Math.trunc(op.value)];
      if (binding?.customWave?.mode === "once") {
        states.set(`${binding.nodeId}:oscillator:custom-wave-once`, true);
      }
    }
    this.captureDspMemoryState(program, states);
    return states;
  }

  captureDspRepeatMigration(previousProgram, nextProgram) {
    if (
      !previousProgram
      || !nextProgram
      || !this.wasm?.beginDspProgramUpdate
      || !this.wasm?.beginDspRepeatRuntimeMigration
      || !this.wasm?.finishDspRepeatRuntimeMigration
      || !this.wasm?.finishDspProgramUpdate
    ) {
      return null;
    }
    const nextById = new Map((nextProgram.repeatBindings || []).map((binding) => [binding.nodeId, binding]));
    return (previousProgram.repeatBindings || []).flatMap((previous) => {
      const next = nextById.get(previous.nodeId);
      if (!next || next.type !== previous.type) return [];
      const previousStates = (previousProgram.stateBindings || []).filter((binding) => (
        binding.state >= previous.stateStart
        && binding.state + binding.count <= previous.stateStart + previous.stateCount
      ));
      const nextStatesById = new Map((nextProgram.stateBindings || [])
        .filter((binding) => (
          binding.state >= next.stateStart
          && binding.state + binding.count <= next.stateStart + next.stateCount
        ))
        .map((binding) => [binding.id, binding]));
      const stateMappings = previousStates.flatMap((binding) => {
        const nextBinding = nextStatesById.get(binding.id);
        if (!nextBinding) return [];
        return [{
          id: binding.id,
          oldOffset: binding.state - previous.stateStart,
          newOffset: nextBinding.state - next.stateStart,
          count: Math.min(binding.count, nextBinding.count),
          oldState: binding.state,
          newState: nextBinding.state,
        }];
      });
      const nodePrefix = `${previous.nodeId}__item_0__`;
      const nextSamplesByNodeId = new Map((nextProgram.sampleBindings || [])
        .map((binding, index) => [binding.nodeId, index]));
      const sampleMappings = (previousProgram.sampleBindings || []).flatMap((binding, oldSlot) => {
        if (!binding.nodeId.startsWith(nodePrefix)) return [];
        const newSlot = nextSamplesByNodeId.get(binding.nodeId);
        return newSlot === undefined ? [] : [{ oldSlot, newSlot }];
      });
      const previousTemplate = this.repeatTemplateOps(previousProgram, previous);
      const effectStates = new Set(previousTemplate
        .filter((op) => this.dspOpUsesEffectBuffer(op))
        .map((op) => op.state));
      const bufferStates = new Set(previousTemplate
        .filter((op) => op.opcode === 34)
        .map((op) => op.state));
      return [{
        previous,
        next,
        stateMappings,
        sampleMappings,
        effectMappings: stateMappings.flatMap((mapping) => {
          if (!effectStates.has(mapping.oldState)) return [];
          const oldSlot = Math.trunc(Number(this.wasm.dspEffectSlotForState?.(mapping.oldState)));
          return oldSlot >= 0 ? [{ ...mapping, oldSlot }] : [];
        }),
        bufferMappings: stateMappings.flatMap((mapping) => {
          if (!bufferStates.has(mapping.oldState)) return [];
          const oldSlot = Math.trunc(Number(this.wasm.dspBufferSlotForState?.(mapping.oldState)));
          return oldSlot >= 0 ? [{ ...mapping, oldSlot }] : [];
        }),
      }];
    });
  }

  captureDspSampleMigration(previousProgram, nextProgram) {
    if (
      !previousProgram
      || !nextProgram
      || !this.wasm?.beginDspProgramUpdate
      || !this.wasm?.migrateDspSampleState
      || !this.wasm?.finishDspProgramUpdate
    ) {
      return null;
    }
    const nextByNodeId = new Map((nextProgram.sampleBindings || [])
      .map((binding, slot) => [binding.nodeId, { binding, slot }]));
    return (previousProgram.sampleBindings || []).flatMap((binding, oldSlot) => {
      const next = nextByNodeId.get(binding.nodeId);
      if (!next || JSON.stringify(binding.sample || {}) !== JSON.stringify(next.binding.sample || {})) {
        return [];
      }
      return [{ oldSlot, newSlot: next.slot }];
    });
  }

  repeatTemplateOps(program, binding) {
    const opcode = binding.type === "Spawn" ? 46 : 42;
    const beginIndex = (program.ops || []).findIndex((op) => (
      op.opcode === opcode && Math.trunc(op.value) === binding.slot
    ));
    if (beginIndex < 0) return [];
    const endIndex = Math.trunc(program.ops[beginIndex].b);
    return program.ops.slice(beginIndex + 1, Math.max(beginIndex + 1, endIndex));
  }

  dspOpUsesEffectBuffer(op) {
    return op.opcode === 12
      || op.opcode === 13
      || op.opcode === 14
      || op.opcode === 39
      || (op.opcode === 4 && (op.a === 5 || op.a === 6));
  }

  applyDspRepeatMigration(migrations) {
    if (!migrations) return;
    for (const migration of migrations) {
      this.wasm.beginDspRepeatRuntimeMigration();
      for (const mapping of migration.stateMappings) {
        this.wasm.addDspRepeatStateMigration?.(mapping.oldOffset, mapping.newOffset, mapping.count);
      }
      for (const mapping of migration.sampleMappings) {
        this.wasm.addDspRepeatSampleMigration?.(mapping.oldSlot, mapping.newSlot);
      }
      for (const mapping of migration.effectMappings) {
        const newSlot = Math.trunc(Number(this.wasm.dspEffectSlotForState?.(mapping.newState)));
        if (newSlot >= 0) this.wasm.addDspRepeatEffectMigration?.(mapping.oldSlot, newSlot);
      }
      for (const mapping of migration.bufferMappings) {
        const newSlot = Math.trunc(Number(this.wasm.dspBufferSlotForState?.(mapping.newState)));
        if (newSlot >= 0) this.wasm.addDspRepeatBufferMigration?.(mapping.oldSlot, newSlot);
      }
      const opcode = migration.next.type === "Spawn" ? 46 : 42;
      const beginIndex = this.dspProgram.ops.findIndex((op) => (
        op.opcode === opcode && Math.trunc(op.value) === migration.next.slot
      ));
      if (beginIndex < 0) continue;
      this.wasm.finishDspRepeatRuntimeMigration(
        migration.next.type === "Spawn" ? 1 : 0,
        migration.previous.slot,
        migration.next.slot,
        beginIndex,
      );
    }
  }

  captureDspMemoryState(program, states) {
    if (!program || !states || !this.wasm?.memory) return;

    const effectLength = Math.trunc(Number(this.wasm.dspEffectBufferLength?.()) || 0);
    if (effectLength > 0 && this.wasm.dspEffectBufferPtr) {
      const effectOpsByState = new Map();
      for (const op of program.ops || []) {
        if (
          op.opcode === 12
          || op.opcode === 13
          || op.opcode === 14
          || op.opcode === 39
          || (op.opcode === 4 && (op.a === 5 || op.a === 6))
        ) {
          effectOpsByState.set(op.state, true);
        }
      }

      for (const binding of program.stateBindings || []) {
        if (!effectOpsByState.has(binding.state)) continue;
        const assignedSlot = Math.trunc(Number(this.wasm.dspEffectSlotForState?.(binding.state)));
        const slot = Number.isInteger(assignedSlot) && assignedSlot >= 0
          ? assignedSlot
          : binding.state % 64;
        const ptr = this.wasm.dspEffectBufferPtr(slot);
        if (!ptr) continue;
        states.set(`${binding.id}:effect-memory`, {
          index: Math.trunc(Number(this.wasm.getDspEffectIndex?.(slot)) || 0),
          samples: new Float32Array(this.wasm.memory.buffer, ptr, effectLength).slice(),
        });
      }
    }

    const bufferLength = Math.trunc(Number(this.wasm.dspBufferLength?.()) || 0);
    if (bufferLength > 0 && this.wasm.dspBufferPtr) {
      for (const binding of program.stateBindings || []) {
        if (binding.id.endsWith(":buffer")) {
          const ptr = this.wasm.dspBufferPtr(binding.state);
          if (!ptr) continue;
          states.set(`${binding.id}:buffer-memory`, new Float32Array(this.wasm.memory.buffer, ptr, bufferLength).slice());
        }
      }
    }
  }

  restoreDspState(preservedState) {
    if (!preservedState || !this.dspProgram || !this.wasm?.setDspState) return;

    for (const binding of this.dspProgram.stateBindings || []) {
      const values = preservedState.get(binding.id);
      if (!values) continue;
      const count = Math.min(binding.count, values.length);
      for (let offset = 0; offset < count; offset += 1) {
        this.wasm.setDspState(binding.state + offset, values[offset]);
      }
    }
    this.restoreDspMemoryState(preservedState);
  }

  restoreDspMemoryState(preservedState) {
    if (!preservedState || !this.dspProgram || !this.wasm?.memory) return;

    const effectLength = Math.trunc(Number(this.wasm.dspEffectBufferLength?.()) || 0);
    if (effectLength > 0 && this.wasm.dspEffectBufferPtr) {
      const effectOpsByState = new Map();
      for (const op of this.dspProgram.ops || []) {
        if (
          op.opcode === 12
          || op.opcode === 13
          || op.opcode === 14
          || op.opcode === 39
          || (op.opcode === 4 && (op.a === 5 || op.a === 6))
        ) {
          effectOpsByState.set(op.state, true);
        }
      }

      for (const binding of this.dspProgram.stateBindings || []) {
        if (!effectOpsByState.has(binding.state)) continue;
        const memoryState = preservedState.get(`${binding.id}:effect-memory`);
        if (!memoryState?.samples) continue;
        const assignedSlot = Math.trunc(Number(this.wasm.dspEffectSlotForState?.(binding.state)));
        const slot = Number.isInteger(assignedSlot) && assignedSlot >= 0
          ? assignedSlot
          : binding.state % 64;
        const ptr = this.wasm.dspEffectBufferPtr(slot);
        if (!ptr) continue;
        new Float32Array(this.wasm.memory.buffer, ptr, effectLength).set(memoryState.samples.subarray(0, effectLength));
        this.wasm.setDspEffectIndex?.(slot, memoryState.index || 0);
      }
    }

    const bufferLength = Math.trunc(Number(this.wasm.dspBufferLength?.()) || 0);
    if (bufferLength > 0 && this.wasm.dspBufferPtr) {
      for (const binding of this.dspProgram.stateBindings || []) {
        if (!binding.id.endsWith(":buffer")) continue;
        const samples = preservedState.get(`${binding.id}:buffer-memory`);
        if (!samples) continue;
        const ptr = this.wasm.dspBufferPtr(binding.state);
        if (!ptr) continue;
        new Float32Array(this.wasm.memory.buffer, ptr, bufferLength).set(samples.subarray(0, bufferLength));
      }
    }
  }

  syncDspProgram(preservedState = null, repeatMigration = null, sampleMigration = null) {
    if (!this.wasm?.clearDspProgram || !this.dspProgram) return;

    const hasProgramMigration = repeatMigration !== null || sampleMigration !== null;
    if (hasProgramMigration) this.wasm.beginDspProgramUpdate();
    this.wasm.clearDspProgram();
    this.wasm.clearGraph?.();
    this.wasm.setDspStereoInputEnabled?.(this.dspProgram.engineApiVersion === 2 ? 1 : 0);
    this.maxVoices = this.dspProgram.maxVoices;
    this.nodes = [];
    this.nodesById = new Map();
    this.midiButtonControlValues.clear();
    if (this.dspProgram.errors.length > 0) {
      if (hasProgramMigration) this.wasm.finishDspProgramUpdate();
      if (!TEIA_RUNTIME_BUILD) this.postRenderingStatus();
      return;
    }

    for (let index = 0; index < this.dspProgram.values.length; index += 1) {
      this.wasm.setDspValue?.(index, this.dspProgram.values[index]);
    }
    const customWaveNodeIndexes = [];
    for (let index = 0; index < this.dspProgram.customWaveBindings.length; index += 1) {
      const binding = this.dspProgram.customWaveBindings[index];
      const customNode = this.normalizeNode({
        id: binding.nodeId,
        wave: "custom",
        frequencyMode: "fixed",
        frequency: 220,
        customWave: binding.customWave,
      });
      customNode.wasmIndex = this.wasm.addDspResourceNode?.(9,
        CUSTOM_WAVE_MODE_IDS.get(customNode.customWave?.mode) ?? 0,
        customNode.customWave?.sustainStart ?? 0.5,
        customNode.customWave?.sustainEnd ?? 0.75, 0) ?? this.wasm.addNode?.(
        this.waveId(customNode),
        this.frequencyModeId(customNode),
        customNode.ratio,
        customNode.frequency,
        customNode.syncBeats,
        customNode.quantise.enabled ? 1 : 0,
        customNode.quantise.root === QUANTISE_MIDI_ROOT ? -1 : QUANTISE_ROOT_NOTES.indexOf(customNode.quantise.root),
        QUANTISE_SCALE_IDS.get(customNode.quantise.scale) ?? 0,
        customNode.quantise.glide,
        customNode.speed,
        customNode.audioInputGain,
        CUSTOM_WAVE_MODE_IDS.get(customNode.customWave?.mode) ?? 0,
        customNode.customWave?.sustainStart ?? 0.5,
        customNode.customWave?.sustainEnd ?? 0.75,
        SAMPLE_MODE_IDS.get(customNode.sample?.mode) ?? 0,
        customNode.sample?.start ?? 0,
        customNode.sample?.end ?? 1,
        customNode.sample?.stretch ?? 1,
        customNode.sample?.cycleLength ?? 4096,
        customNode.sample?.overlapRatio ?? 0.09,
        customNode.sample?.originalFrequency ?? 440,
        0,
        0,
      ) ?? -1;
      if (customNode.wasmIndex >= 0 && typeof this.wasm.addCustomWavePoint === "function") {
        for (const point of customNode.customWave.points) {
          this.wasm.addCustomWavePoint(customNode.wasmIndex, point.x, point.y);
        }
      }
      customWaveNodeIndexes[index] = customNode.wasmIndex;
      this.nodes.push(customNode);
      this.nodesById.set(customNode.id, customNode);
    }
    for (let index = 0; index < this.dspProgram.sampleBindings.length; index += 1) {
      const binding = this.dspProgram.sampleBindings[index];
      const sampleNode = this.normalizeNode({
        id: binding.nodeId,
        wave: "sample",
        frequencyMode: "fixed",
        frequency: 220,
        sample: {
          name: binding.sample.name,
          mode: "one-shot",
          start: 0,
          end: 1,
          stretch: 1,
          cycleLength: 4096,
          overlapRatio: 0.09,
          originalFrequency: 440,
          release: binding.release,
        },
      });
      sampleNode.wasmIndex = this.wasm.addDspResourceNode?.(10, 0, 0.5, 0.75, binding.release) ?? this.wasm.addNode?.(
        this.waveId(sampleNode),
        this.frequencyModeId(sampleNode),
        sampleNode.ratio,
        sampleNode.frequency,
        sampleNode.syncBeats,
        sampleNode.quantise.enabled ? 1 : 0,
        sampleNode.quantise.root === QUANTISE_MIDI_ROOT ? -1 : QUANTISE_ROOT_NOTES.indexOf(sampleNode.quantise.root),
        QUANTISE_SCALE_IDS.get(sampleNode.quantise.scale) ?? 0,
        sampleNode.quantise.glide,
        sampleNode.speed,
        sampleNode.audioInputGain,
        CUSTOM_WAVE_MODE_IDS.get(sampleNode.customWave?.mode) ?? 0,
        sampleNode.customWave?.sustainStart ?? 0.5,
        sampleNode.customWave?.sustainEnd ?? 0.75,
        SAMPLE_MODE_IDS.get(sampleNode.sample?.mode) ?? 0,
        sampleNode.sample?.start ?? 0,
        sampleNode.sample?.end ?? 1,
        sampleNode.sample?.stretch ?? 1,
        sampleNode.sample?.cycleLength ?? 4096,
        sampleNode.sample?.overlapRatio ?? 0.09,
        sampleNode.sample?.originalFrequency ?? 440,
        0,
        binding.release,
      ) ?? -1;
      this.nodes.push(sampleNode);
      this.nodesById.set(sampleNode.id, sampleNode);
      this.wasm.setDspSampleNode?.(index, sampleNode.wasmIndex);
      this.copySampleDataToWasm(sampleNode);
    }
    for (let index = 0; index < this.dspProgram.imageBindings.length; index += 1) {
      this.copyImageDataToWasm(index, this.dspProgram.imageBindings[index].nodeId);
    }
    for (const op of this.dspProgram.ops) {
      const opValue = op.opcode === 3 && op.a === 9
        ? customWaveNodeIndexes[Math.trunc(op.value)] ?? -1
        : op.value;
      const opB = op.opcode === 48 && op.value >= 0.5
        ? customWaveNodeIndexes[Math.trunc(op.b)] ?? -1
        : op.b;
      this.wasm.addDspOp?.(
        op.opcode,
        op.out,
        op.a,
        opB,
        op.c,
        op.d,
        op.e,
        op.state,
        opValue,
        op.value2 ?? 0,
        op.value3 ?? 0,
        op.value4 ?? 0,
      );
    }

    const invalidInstruction = this.wasm.validateDspProgram?.() ?? -1;
    if (invalidInstruction >= 0) {
      this.dspProgram.errors.push(`Rust rejected instruction ${invalidInstruction}.`);
      if (hasProgramMigration) this.wasm.finishDspProgramUpdate();
      return;
    }

    this.applyDspRepeatMigration(repeatMigration);
    for (const mapping of sampleMigration || []) {
      this.wasm.migrateDspSampleState?.(mapping.oldSlot, mapping.newSlot);
    }
    if (hasProgramMigration) this.wasm.finishDspProgramUpdate();
    this.syncDspSequencers();
    this.restoreDspState(preservedState);
    this.applyPendingBufferRestores();
    this.applyPendingBufferCopies();
    this.applyPendingBufferClears();

    // A newly created one-shot custom wave is an event-driven source. It must
    // stay silent until its trigger input receives a rising edge. Preserve the
    // state of an existing one-shot so unrelated graph updates do not interrupt
    // it while it is playing.
    this.armDspCustomWaveOneShots(preservedState);
    this.wasm.compileDspParallelPlan?.();
    if (!TEIA_RUNTIME_BUILD) this.postRenderingStatus();
  }

  armDspCustomWaveOneShots(preservedState = null) {
    if (!this.dspProgram || !this.wasm?.setDspState) return;
    for (const op of this.dspProgram.ops) {
      if (op.opcode !== 3 || op.a !== 9 || op.state < 0) continue;
      const binding = this.dspProgram.customWaveBindings[Math.trunc(op.value)];
      const wasAlreadyOneShot = preservedState?.has(`${binding?.nodeId}:oscillator:custom-wave-once`);
      if (binding?.customWave?.mode === "once" && !wasAlreadyOneShot) {
        this.wasm.setDspState(op.state + 3, 1);
      }
    }
  }

  setMidiCc(payload = {}) {
    if (!this.dspProgram) return;
    const channel = this.clamp(Math.round(Number(payload.channel ?? 1)), 1, 16);
    const cc = this.clamp(Math.round(Number(payload.cc)), 0, 127);
    const value = this.clamp(Number(payload.value), 0, 1);
    this.wasm?.setDspMidiCc?.(channel, cc, value);

    for (const binding of this.dspProgram.midiControlBindings || []) {
      if (binding.channel !== channel || binding.cc !== cc) continue;

      if (binding.kind === "slider") {
        this.setDspValueAt(binding.valueIndex, value);
        continue;
      }

      const key = `${binding.nodeId}:${binding.valueIndex}:${binding.channel}:${binding.cc}`;
      const previousValue = this.midiButtonControlValues.get(key) ?? 0;
      const pressed = value >= 0.5;
      const wasPressed = previousValue >= 0.5;
      const mode = Math.round(Number(this.dspProgram.values[binding.modeValueIndex] ?? 0));

      if (mode === 1) {
        if (pressed && !wasPressed && binding.clicksValueIndex >= 0) {
          const clicks = Math.round(Number(this.dspProgram.values[binding.clicksValueIndex] ?? 0)) + 1;
          this.setDspValueAt(binding.clicksValueIndex, clicks);
        }
      } else if (mode === 0) {
        if (pressed && !wasPressed) {
          const current = Number(this.dspProgram.values[binding.valueIndex] ?? 0) >= 0.5;
          this.setDspValueAt(binding.valueIndex, current ? 0 : 1);
        }
      } else {
        this.setDspValueAt(binding.valueIndex, pressed ? 1 : 0);
      }

      this.midiButtonControlValues.set(key, value);
    }
  }

  setMidiClockTempo(payload = {}) {
    const sourceIndex = this.clamp(Math.round(Number(payload.sourceIndex ?? 0)), 0, 128);
    const bpm = this.clamp(Number(payload.bpm), TEMPO_MIN, TEMPO_MAX);
    this.tempo = bpm;
    this.wasm?.setDspTempo?.(bpm);
    this.wasm?.setDspTempoSource?.(sourceIndex, bpm);
  }

  configureDspScopes() {
    if (!this.dspProgram || !this.wasm?.setDspScope || !this.wasm?.dspScopePtr) return;

    const requestsById = new Map(this.linkScopeRequests.map((request) => [request.linkId, request]));
    if (TEIA_RUNTIME_BUILD) {
      for (const binding of this.dspProgram.fftBindings || []) {
        requestsById.set(binding.nodeId, {
          linkId: binding.nodeId,
          mode: "continuous",
          points: 512,
          displayPoints: 512,
          seconds: 0.012,
        });
      }
    }
    const nextScopes = [];
    let slot = 0;
    for (const request of requestsById.values()) {
      if (slot >= 32) break;
      const register = Math.trunc(Number(this.dspProgram.monitorIds?.[request.linkId]));
      if (!Number.isFinite(register) || register < 0) continue;
      nextScopes.push({ request, register, slot });
      slot += 1;
    }

    const scopeConfigurationIsUnchanged = nextScopes.length === this.dspScopeStates.size
      && nextScopes.every(({ request, register, slot }) => {
        const existing = this.dspScopeStates.get(request.linkId);
        return existing
          && existing.slot === slot
          && existing.register === register
          && sameScopeRequest(existing.request, request);
      });
    if (scopeConfigurationIsUnchanged) return;

    // A new DSP program can move monitor registers even when the user has not
    // changed a scope. Preserve the ring buffer so the trace can continue
    // advancing immediately on the newly compiled signal.
    const previousStateById = new Map();
    for (const [linkId, state] of this.dspScopeStates) {
      if (state.samples?.buffer !== this.wasm.memory.buffer) {
        const ptr = this.wasm.dspScopePtr?.(state.slot);
        state.samples = ptr ? new Float32Array(this.wasm.memory.buffer, ptr, 1024) : null;
      }
      if (!state.samples || !sameScopeRequest(state.request, nextScopes.find((scope) => scope.request.linkId === linkId)?.request)) continue;
      previousStateById.set(linkId, {
        samples: state.samples.slice(0, state.request.points),
        count: this.clamp(Math.round(this.wasm.dspScopeCount?.(state.slot) || 0), 0, state.request.points),
        writeIndex: this.clamp(Math.round(this.wasm.dspScopeWriteIndex?.(state.slot) || 0), 0, state.request.points - 1),
      });
    }
    this.dspScopeStates.clear();
    this.wasm.clearDspScopes?.();
    for (const { request, register, slot } of nextScopes) {
      const scopeSlot = this.wasm.setDspScope(slot, register, request.seconds, request.points, sampleRate);
      if (scopeSlot < 0) continue;
      const ptr = this.wasm.dspScopePtr(slot);
      if (!ptr) continue;
      const samples = new Float32Array(this.wasm.memory.buffer, ptr, 1024);
      const previous = previousStateById.get(request.linkId);
      if (previous) {
        samples.set(previous.samples.subarray(0, request.points));
        this.wasm.restoreDspScopeHistory?.(slot, previous.count, previous.writeIndex);
      }
      this.dspScopeStates.set(request.linkId, {
        request,
        slot,
        register,
        samples,
      });
    }
    this.wasm?.compileDspBlockPlan?.();
    this.refreshWasmViews(true);
  }

  configureDspMeters() {
    if (TEIA_RUNTIME_BUILD) return;
    this.dspMeterStates.clear();
    this.wasm?.clearDspMeters?.();
    if (!this.dspProgram || !this.wasm?.setDspMeter) return;

    let slot = 0;
    for (const [id, registerValue] of Object.entries(this.dspProgram.monitorIds || {})) {
      if (slot >= 128) break;
      const register = Math.trunc(Number(registerValue));
      if (!Number.isFinite(register) || register < 0) continue;
      const meterSlot = this.wasm.setDspMeter(slot, register);
      if (meterSlot < 0) continue;
      this.dspMeterStates.set(String(id), { id: String(id), slot });
      slot += 1;
    }
  }

  normalizeNode(node = {}) {
    const ratio = Number(node.ratio);
    const frequency = Number(node.frequency);
    const speed = Number(node.speed);
    const audioInputGain = Number(node.audioInputGain);
    const quantiseGlide = Number(node.quantise?.glide);
    return {
      id: node.id,
      wave: WAVE_IDS.has(node.wave) ? node.wave : "sine",
      frequencyMode: ["ratio", "fixed", "sync"].includes(node.frequencyMode) ? node.frequencyMode : "ratio",
      ratio: Number.isFinite(ratio) ? ratio : 1,
      frequency: Number.isFinite(frequency)
        ? frequency
        : node.wave === "constant" ? 1 : 440,
      baseFrequency: Number.isFinite(frequency)
        ? frequency
        : node.wave === "constant" ? 1 : 440,
      syncBeats: this.normalizeSyncBeats(node.syncBeats),
      quantise: {
        enabled: Boolean(node.quantise?.enabled),
        root: node.quantise?.root === QUANTISE_MIDI_ROOT || QUANTISE_ROOT_NOTES.includes(node.quantise?.root) ? node.quantise.root : "C",
        scale: QUANTISE_SCALE_IDS.has(node.quantise?.scale) ? node.quantise.scale : "chromatic",
        glide: Number.isFinite(quantiseGlide) ? this.clamp(quantiseGlide, 0, 4) : 0,
      },
      speed: Number.isFinite(speed) ? speed : 8,
      audioInputGain: Number.isFinite(audioInputGain) ? audioInputGain : 1,
      customWave: this.normalizeCustomWave(node.customWave),
      sample: this.normalizeSample(node.sample),
    };
  }

  normalizeSample(sample = {}) {
    const start = Number(sample.start);
    const end = Number(sample.end);
    const stretch = Number(sample.stretch);
    const cycleLength = Number(sample.cycleLength);
    const overlapRatio = Number(sample.overlapRatio);
    const originalFrequency = Number(sample.originalFrequency);
    const legacyOriginalPitch = Number(sample.originalPitch);
    return {
      name: sample.name || "",
      sampleRate: Number.isFinite(Number(sample.sampleRate)) ? Math.max(1, Number(sample.sampleRate)) : sampleRate,
      mode: SAMPLE_MODE_IDS.has(sample.mode) ? sample.mode : "one-shot",
      start: Number.isFinite(start) ? this.clamp(start, 0, 1) : 0,
      end: Number.isFinite(end) ? this.clamp(end, 0, 1) : 1,
      stretch: Number.isFinite(stretch) ? Math.max(0.001, stretch) : 1,
      cycleLength: Number.isFinite(cycleLength) ? Math.max(1, Math.round(cycleLength)) : 4096,
      overlapRatio: Number.isFinite(overlapRatio) ? this.clamp(overlapRatio, 0, 1) : 0.09,
      originalFrequency: Number.isFinite(originalFrequency)
        ? Math.max(0.0001, originalFrequency)
        : Number.isFinite(legacyOriginalPitch) ? this.midiNoteFrequency(legacyOriginalPitch) : 440,
    };
  }

  normalizeTempo(tempo) {
    const value = Number(tempo);
    return Number.isFinite(value) ? this.clamp(value, TEMPO_MIN, TEMPO_MAX) : DEFAULT_TEMPO;
  }

  normalizeSyncBeats(syncBeats) {
    const value = Number(syncBeats);
    return Number.isFinite(value) && value > 0 ? this.clamp(value, 1 / 64, 64) : DEFAULT_SYNC_BEATS;
  }

  normalizeCustomWave(customWave = {}) {
    const customWaveModes = new Set(["loop", "once", "ping-pong", "sustain", "sustain-loop", "sustain-ping-pong"]);
    const sourceMode = customWave.mode || customWave.playback;
    const mode = customWaveModes.has(sourceMode) ? sourceMode : DEFAULT_CUSTOM_WAVE.mode;
    const sustainStart = Number.isFinite(Number(customWave.sustainStart))
      ? this.clamp(Number(customWave.sustainStart), 0, 0.999)
      : DEFAULT_CUSTOM_WAVE.sustainStart;
    const sustainEnd = Number.isFinite(Number(customWave.sustainEnd))
      ? this.clamp(Number(customWave.sustainEnd), sustainStart + 0.001, 1)
      : Math.max(sustainStart + 0.001, DEFAULT_CUSTOM_WAVE.sustainEnd);
    const sourcePoints = Array.isArray(customWave.points) ? customWave.points : DEFAULT_CUSTOM_WAVE.points;
    const pointsByX = new Map();
    for (const point of sourcePoints) {
      const x = Number(point?.x);
      const y = Number(point?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      pointsByX.set(this.clamp(x, 0, 1), this.clamp(y, -1, 1));
    }
    pointsByX.set(0, 0);
    pointsByX.set(1, 0);
    const points = [...pointsByX.entries()]
      .map(([x, y]) => ({ x, y }))
      .sort((a, b) => a.x - b.x);
    const cappedPoints = points.length > MAX_CUSTOM_WAVE_POINTS
      ? [...points.slice(0, MAX_CUSTOM_WAVE_POINTS - 1), points[points.length - 1]]
      : points;
    return {
      mode,
      sustainStart,
      sustainEnd,
      points: cappedPoints,
    };
  }

  normalizeLink(link = {}) {
    const amount = Number(link.amount);
    const delay = Number(link.delay);
    const noise = Number(link.noise);
    const pan = Number(link.pan);
    const velocitySensitivity = Number(link.velocitySensitivity);
    const envelopeDelay = Number(link.envelope?.delay);
    const attack = Number(link.envelope?.attack);
    const decay = Number(link.envelope?.decay);
    const sustain = Number(link.envelope?.sustain);
    const release = Number(link.envelope?.release);
    const followerAttack = Number(link.follower?.attack);
    const followerRelease = Number(link.follower?.release);
    const mapSrcMin = Number(link.map?.srcMin);
    const mapSrcMax = Number(link.map?.srcMax);
    const mapTargetMin = Number(link.map?.trgtMin);
    const mapTargetMax = Number(link.map?.trgtMax);
    const filterCutoff = Number(link.filter?.cutoff);
    const filterResonance = Number(link.filter?.resonance);
    const isComb = link.filter?.type === "comb" || link.filter?.type === "comb-notch";
    const distortionGain = Number(link.distortion?.gain);
    return {
      id: link.id,
      from: link.from,
      to: link.to,
      amount: this.normalizeLinkAmount(link, amount),
      delay: Number.isFinite(delay) ? Math.max(0, delay) : 0,
      noise: Number.isFinite(noise) ? this.clamp(noise, 0, 1) : 0,
      pan: Number.isFinite(pan) ? this.clamp(pan, -1, 1) : 0,
      velocitySensitivity: Number.isFinite(velocitySensitivity) ? this.clamp(velocitySensitivity, -8, 8) : 0,
      modulationTarget: link.modulationTarget || "phase",
      parameterMode: ["set", "add", "multiply", "bend"].includes(link.parameterMode) ? link.parameterMode : "set",
      internalTarget: Boolean(link.internalTarget),
      monitorOnly: Boolean(link.monitorOnly),
      drone: Boolean(link.drone),
      signalMode: SIGNAL_MODE_IDS.has(link.signalMode) ? link.signalMode : "raw",
      follower: {
        attack: Number.isFinite(followerAttack) ? Math.max(0, followerAttack) : 0.01,
        release: Number.isFinite(followerRelease) ? Math.max(0, followerRelease) : 0.12,
      },
      map: {
        srcMin: Number.isFinite(mapSrcMin) ? mapSrcMin : 0,
        srcMax: Number.isFinite(mapSrcMax) ? mapSrcMax : 1,
        trgtMin: Number.isFinite(mapTargetMin) ? mapTargetMin : 0,
        trgtMax: Number.isFinite(mapTargetMax) ? mapTargetMax : 1,
      },
      filter: {
        type: FILTER_TYPE_IDS.has(link.filter?.type) ? link.filter.type : "none",
        cutoff: link.filter?.type === "formant"
          ? this.clamp(Number.isFinite(filterCutoff) ? filterCutoff : 0, 0, 1)
          : Number.isFinite(filterCutoff) ? Math.max(0, filterCutoff) : isComb ? 440 : 5000,
        resonance: Number.isFinite(filterResonance)
          ? isComb ? this.clamp(filterResonance, -0.999, 0.999) : Math.max(0, filterResonance)
          : isComb ? 0.45 : 0.7,
      },
      distortion: {
        enabled: Boolean(link.distortion?.enabled),
        type: DISTORTION_TYPE_IDS.has(link.distortion?.type) ? link.distortion.type : "soft-clip",
        gain: Number.isFinite(distortionGain) ? Math.max(0, distortionGain) : 1.5,
      },
      envelope: {
        delay: Number.isFinite(envelopeDelay) ? Math.max(0, envelopeDelay) : 0,
        attack: Number.isFinite(attack) ? Math.max(0, attack) : 0.01,
        decay: Number.isFinite(decay) ? Math.max(0, decay) : 0.16,
        sustain: Number.isFinite(sustain) ? sustain : 0.72,
        release: Number.isFinite(release) ? Math.max(0, release) : 0.24,
      },
    };
  }

  normalizeLinkAmount(link, amount) {
    if (!Number.isFinite(amount)) return 0;
    return amount;
  }

  setSampleData(payload = {}) {
    if (!payload.nodeId) return;
    const storageKey = payload.storageKey || payload.nodeId;
    const hasData = payload.data instanceof Float32Array || Array.isArray(payload.data);
    if (!hasData) {
      const entry = this.sampleDataByStorageKey.get(storageKey);
      if (!entry) return;
      this.sampleDataByNodeId.set(payload.nodeId, entry);
      const node = this.nodesById.get(payload.nodeId);
      if (node) this.copySampleDataToWasm(node);
      return;
    }
    const data = payload.data instanceof Float32Array
      ? payload.data
      : Float32Array.from(Array.isArray(payload.data) ? payload.data : []);
    if (!data.length) {
      this.sampleDataByNodeId.delete(payload.nodeId);
      return;
    }
    const entry = {
      data,
      sampleRate: Number.isFinite(Number(payload.sampleRate)) ? Math.max(1, Number(payload.sampleRate)) : sampleRate,
      name: payload.name || "",
      storageKey,
    };
    // A fresh upload may replace data at the same logical key. Make its owner
    // perform the update before later players bind to the resulting slot.
    this.sampleSlotByStorageKey.delete(storageKey);
    this.sampleDataByStorageKey.set(storageKey, entry);
    this.sampleDataByNodeId.set(payload.nodeId, entry);
    const node = this.nodesById.get(payload.nodeId);
    if (node) this.copySampleDataToWasm(node);
    if (this.linkScopeRequests.length > 0) {
      this.monitorScopeStates.clear();
      this.setLinkScopes({ ...this.linkScopeRequests[0], linkIds: this.linkScopeRequests.map((request) => request.linkId) });
    }
  }

  setImageData(payload = {}) {
    if (!payload.nodeId) return;
    const data = payload.data instanceof Uint8Array
      ? payload.data
      : Uint8Array.from(Array.isArray(payload.data) ? payload.data : []);
    this.imageDataByNodeId.set(payload.nodeId, {
      data,
      width: Math.max(0, Math.trunc(Number(payload.width) || 0)),
      height: Math.max(0, Math.trunc(Number(payload.height) || 0)),
      name: payload.name || "",
    });
    const index = this.dspProgram?.imageBindings?.findIndex((binding) => binding.nodeId === payload.nodeId) ?? -1;
    if (index >= 0) this.copyImageDataToWasm(index, payload.nodeId);
  }

  copyImageDataToWasm(slot, nodeId) {
    if (!this.wasm || typeof this.wasm.setImageData !== "function" || typeof this.wasm.imageDataPtr !== "function") return;
    const entry = this.imageDataByNodeId.get(nodeId);
    if (!entry?.data?.length || !entry.width || !entry.height) return;
    const maxBytes = typeof this.wasm.maxImageBytes === "function" ? this.wasm.maxImageBytes() : entry.data.length;
    const length = Math.min(entry.data.length, Math.max(0, maxBytes || 0));
    if (!length) return;
    if (this.wasm.setImageData(slot, entry.width, entry.height, length) < 0) return;
    const ptr = this.wasm.imageDataPtr(slot);
    if (!ptr) return;
    new Uint8Array(this.wasm.memory.buffer, ptr, length).set(entry.data.subarray(0, length));
    this.refreshWasmViews(true);
  }

  copySampleDataToWasm(node) {
    if (!this.wasm || node?.wave !== "sample" || node.wasmIndex < 0) return;
    const entry = this.sampleDataByNodeId.get(node.id);
    if (!entry?.data?.length || typeof this.wasm.setSampleData !== "function" || typeof this.wasm.sampleDataPtr !== "function") return;
    const maxFrames = typeof this.wasm.maxSampleFrames === "function" ? this.wasm.maxSampleFrames() : entry.data.length;
    if (entry.data.length > Math.max(0, maxFrames || 0)) {
      this.reportSampleLoadError(node.id, entry, maxFrames, "sample-too-long");
      return;
    }
    const length = entry.data.length;
    let slot;
    try {
      const sharedSlot = this.sampleSlotByStorageKey.get(entry.storageKey);
      slot = Number.isInteger(sharedSlot) && typeof this.wasm.bindSampleData === "function"
        ? this.wasm.bindSampleData(node.wasmIndex, sharedSlot)
        : this.wasm.setSampleData(node.wasmIndex, entry.sampleRate || sampleRate, length);
    } catch {
      this.reportSampleLoadError(node.id, entry, maxFrames, "sample-allocation-failed");
      return;
    }
    if (slot < 0) {
      this.reportSampleLoadError(node.id, entry, maxFrames, slot === -3 ? "sample-memory-limit" : "sample-allocation-failed");
      return;
    }
    if (slot === this.sampleSlotByStorageKey.get(entry.storageKey)) return;
    const ptr = this.wasm.sampleDataPtr(slot);
    if (!ptr) return;
    new Float32Array(this.wasm.memory.buffer, ptr, length).set(entry.data.subarray(0, length));
    this.sampleSlotByStorageKey.set(entry.storageKey, slot);
    this.refreshWasmViews(true);
  }

  normalizeEffects(effects = {}) {
    return {
      chorus: {
        enabled: Boolean(effects.chorus?.enabled),
        rate: this.clamp(Number(effects.chorus?.rate) || 0.8, 0.05, 6),
        depth: this.clamp(Number(effects.chorus?.depth) || 0.012, 0.001, 0.04),
        mix: this.clamp(Number(effects.chorus?.mix) || 0.25, 0, 1),
      },
      delay: {
        enabled: Boolean(effects.delay?.enabled),
        time: this.clamp(Number(effects.delay?.time) || 0.28, 0.02, 1.5),
        feedback: this.clamp(Number(effects.delay?.feedback) || 0.35, 0, 2),
        mix: this.clamp(Number(effects.delay?.mix) || 0.25, 0, 1),
      },
      reverb: {
        enabled: Boolean(effects.reverb?.enabled),
        size: this.clamp(Number(effects.reverb?.size) || 0.55, 0.1, 1),
        decay: this.clamp(Number(effects.reverb?.decay) || 0.45, 0, 0.94),
        mix: this.clamp(Number(effects.reverb?.mix) || 0.25, 0, 1),
      },
    };
  }

  clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  sanitizeSample(value, limit = 16) {
    if (!Number.isFinite(value)) return 0;
    if (Math.abs(value) < DENORMAL_EPSILON) return 0;
    return this.clamp(value, -limit, limit);
  }

  smoothStep(t) {
    const x = this.clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  createReverbDelays() {
    return [0.043, 0.061, 0.079, 0.097].map((time) => ({
      buffer: new Float32Array(Math.ceil(sampleRate * time)),
      index: 0,
    }));
  }

  createDcBlocker() {
    return {
      input: 0,
      output: 0,
      coefficient: Math.exp((-TWO_PI * MASTER_DC_BLOCK_HZ) / sampleRate),
    };
  }

  readDelay(buffer, writeIndex, delaySamples) {
    const length = buffer.length;
    let index = writeIndex - delaySamples;
    if (index < 0) index += length;

    const indexA = Math.floor(index) % length;
    const indexB = (indexA + 1) % length;
    const fraction = index - Math.floor(index);
    return this.sanitizeSample(buffer[indexA] * (1 - fraction) + buffer[indexB] * fraction);
  }

  applyChorus(sample, channel) {
    const cleanSample = this.sanitizeSample(sample);
    const effect = this.masterEffects.chorus;
    const buffer = this.chorusBuffers[channel];
    const index = this.chorusIndices[channel];
    if (!effect.enabled || effect.mix <= 0) {
      buffer[index] = cleanSample;
      this.chorusIndices[channel] = (index + 1) % buffer.length;
      return cleanSample;
    }

    const baseDelay = 0.012 * sampleRate;
    const depthSamples = effect.depth * sampleRate;
    const lfo = 0.5 + 0.5 * Math.sin(this.chorusPhases[channel]);
    const delayed = this.readDelay(buffer, index, baseDelay + depthSamples * lfo);
    buffer[index] = cleanSample;
    this.chorusIndices[channel] = (index + 1) % buffer.length;
    this.chorusPhases[channel] = (this.chorusPhases[channel] + (TWO_PI * effect.rate) / sampleRate) % TWO_PI;
    return this.sanitizeSample(cleanSample * (1 - effect.mix) + delayed * effect.mix);
  }

  applyDelay(sample, channel) {
    const cleanSample = this.sanitizeSample(sample);
    const effect = this.masterEffects.delay;
    const buffer = this.delayBuffers[channel];
    const index = this.delayIndices[channel];
    const active = effect.enabled && effect.mix > 0;
    const delaySamples = Math.min(buffer.length - 1, Math.max(1, effect.time * sampleRate));
    const delayed = this.readDelay(buffer, index, delaySamples);
    buffer[index] = this.sanitizeSample(cleanSample + delayed * (active ? effect.feedback : 0));
    this.delayIndices[channel] = (index + 1) % buffer.length;

    if (!active) return cleanSample;
    return this.sanitizeSample(cleanSample * (1 - effect.mix) + delayed * effect.mix);
  }

  applyReverb(sample, channel) {
    const cleanSample = this.sanitizeSample(sample);
    const effect = this.masterEffects.reverb;
    const active = effect.enabled && effect.mix > 0;
    let wet = 0;

    for (const delay of this.reverbDelays[channel]) {
      const readIndex = delay.index;
      const delayed = this.sanitizeSample(delay.buffer[readIndex]);
      wet += delayed;
      const damping = active ? effect.decay * (0.55 + effect.size * 0.4) : 0;
      delay.buffer[readIndex] = this.sanitizeSample(cleanSample + delayed * damping);
      delay.index = (delay.index + 1) % delay.buffer.length;
    }

    wet *= 0.25;
    if (!active) return cleanSample;
    return this.sanitizeSample(cleanSample * (1 - effect.mix) + wet * effect.mix);
  }

  applyDcBlocker(sample, channel, blockers) {
    const state = blockers[channel];
    const cleanSample = this.sanitizeSample(sample, 4);
    const output = cleanSample - state.input + state.coefficient * state.output;
    state.input = cleanSample;
    state.output = this.sanitizeSample(output, 4);
    return state.output;
  }

  applyMasterEffects(sample, channel) {
    let effected = this.applyDcBlocker(sample, channel, this.inputDcBlockers);
    effected = this.applyChorus(effected, channel);
    effected = this.applyDelay(effected, channel);
    effected = this.applyReverb(effected, channel);
    return this.sanitizeSample(Math.tanh(this.applyDcBlocker(effected, channel, this.outputDcBlockers)), 1);
  }

  midiNoteFrequency(note) {
    return 440 * Math.pow(2, (note - 69) / 12);
  }

  queueMidiNoteEvent(noteOn, channel, note, velocity = 0) {
    const numericChannel = this.clamp(Math.round(Number(channel ?? 1)), 1, 16);
    const numericNote = Number(note);
    if (!Number.isFinite(numericNote)) return;
    this.pendingMidiNoteEvents.push({
      noteOn: Boolean(noteOn),
      channel: numericChannel,
      note: this.clamp(numericNote, 0, 127),
      velocity: this.clamp(Number(velocity) || 0, 0, 1),
    });
    if (this.pendingMidiNoteEvents.length > 4096) {
      this.pendingMidiNoteEvents.splice(0, this.pendingMidiNoteEvents.length - 4096);
    }
  }

  flushMidiNoteEventsToWasm() {
    if (!this.pendingMidiNoteEvents.length || !this.wasm?.queueDspMidiNoteEvent) return;
    for (const event of this.pendingMidiNoteEvents) {
      this.wasm.queueDspMidiNoteEvent(
        event.noteOn ? 1 : 0,
        event.channel,
        event.note,
        event.velocity,
      );
    }
    this.pendingMidiNoteEvents = [];
  }

  allocateSlot() {
    if (this.freeSlots.length) return this.freeSlots.shift();
    const stolenVoice = [...this.voices.values()]
      .filter((voice) => voice.stolenAt !== null)
      .sort((a, b) => a.stolenAt - b.stolenAt)[0];
    if (stolenVoice) {
      const slot = stolenVoice.slot;
      this.deleteVoice(stolenVoice.id, { keepSlot: true });
      return slot;
    }
    return null;
  }

  voiceToSteal() {
    const voices = [...this.voices.values()];
    return voices
      .filter((voice) => voice.stolenAt === null)
      .sort((a, b) => {
        if ((a.releasedAt === null) !== (b.releasedAt === null)) return a.releasedAt === null ? 1 : -1;
        return (a.releasedAt ?? a.startedAt) - (b.releasedAt ?? b.startedAt);
      })[0] || null;
  }

  activeVoiceToSteal() {
    return [...this.voices.values()]
      .filter((voice) => voice.stolenAt === null && voice.releasedAt === null)
      .sort((a, b) => a.startedAt - b.startedAt)[0] || null;
  }

  activeVoiceCount() {
    let count = 0;
    for (const voice of this.voices.values()) {
      if (voice.stolenAt === null) count += 1;
    }
    return count;
  }

  stealVoiceForFade() {
    const candidate = this.voiceToSteal();
    if (!candidate) return false;
    candidate.stolenAt = this.sampleCursor / sampleRate;
    this.forgetActiveVoice(candidate.id);
    return true;
  }

  enforceVoiceLimit(limit = this.maxVoices) {
    while (this.activeVoiceCount() > limit) {
      const candidate = this.activeVoiceToSteal() || this.voiceToSteal();
      if (!candidate) return;
      candidate.stolenAt = this.sampleCursor / sampleRate;
      this.forgetActiveVoice(candidate.id);
    }
  }

  forgetActiveVoice(voiceId) {
    for (const [note, activeVoiceId] of this.activeVoicesByNote) {
      if (activeVoiceId === voiceId) this.activeVoicesByNote.delete(note);
    }
  }

  latestStolenFadeEnd(now = this.sampleCursor / sampleRate) {
    let fadeEnd = now;
    for (const voice of this.voices.values()) {
      if (voice.stolenAt !== null) {
        fadeEnd = Math.max(fadeEnd, voice.stolenAt + VOICE_STEAL_FADE_SECONDS);
      }
    }
    return fadeEnd;
  }

  voiceNoteKey(channel, note) {
    return `${channel}:${note}`;
  }

  queueVoiceStart(channel, note, velocity, readyAt) {
    const key = this.voiceNoteKey(channel, note);
    this.pendingVoiceStarts = this.pendingVoiceStarts.filter((pending) => pending.key !== key);
    this.pendingVoiceStarts.push({ key, channel, note, velocity, readyAt });
  }

  flushPendingVoiceStarts(now) {
    if (!this.pendingVoiceStarts.length) return;

    let ready = [];
    const remaining = [];
    for (const pending of this.pendingVoiceStarts) {
      if (pending.readyAt > now) {
        remaining.push(pending);
      } else {
        ready.push(pending);
      }
    }
    if (!ready.length) {
      this.pendingVoiceStarts = remaining;
      return;
    }

    if (ready.length > this.maxVoices) {
      ready = ready.slice(ready.length - this.maxVoices);
    }

    const freeActiveSlots = Math.max(0, this.maxVoices - this.activeVoiceCount());
    const slotsToReserve = Math.max(0, ready.length - freeActiveSlots);
    if (slotsToReserve > 0) {
      let reservedSlots = 0;
      while (reservedSlots < slotsToReserve && this.stealVoiceForFade()) {
        reservedSlots += 1;
      }
      this.pendingVoiceStarts = [
        ...remaining,
        ...ready.map((pending) => ({ ...pending, readyAt: this.latestStolenFadeEnd(now) })),
      ];
      return;
    }

    const stillPending = [];
    for (const pending of ready) {
      if (this.startVoice(pending.channel, pending.note, pending.velocity, now)) continue;
      stillPending.push({ ...pending, readyAt: this.latestStolenFadeEnd(now) });
    }
    this.pendingVoiceStarts = [...remaining, ...stillPending];
    this.enforceVoiceLimit();
  }

  startVoice(channel, note, velocity = 1, startedAt = this.sampleCursor / sampleRate) {
    const numericChannel = this.clamp(Math.round(Number(channel ?? 1)), 1, 16);
    const numericNote = Number(note);
    if (!Number.isFinite(numericNote)) return false;
    const slot = this.allocateSlot();
    if (slot === null) return false;
    this.wasm?.resetVoiceSlot?.(slot);
    this.wasm?.resetDspVoiceState?.(slot);
    if (this.zeroVoicePhasesOnStart) this.wasm?.resetVoiceSlotPhases?.(slot);
    const voice = {
      id: `voice-${this.voiceCounter++}`,
      slot,
      channel: numericChannel,
      note: numericNote,
      frequency: this.midiNoteFrequency(numericNote),
      velocity: this.clamp(Number(velocity) || 0, 0.05, 1),
      startedAt,
      releasedAt: null,
      stolenAt: null,
      releaseSeconds: 0.24,
      releaseGain: 1,
      oneShotSampleEndAt: this.oneShotSampleEndAt(startedAt, this.midiNoteFrequency(numericNote)),
    };
    this.voices.set(voice.id, voice);
    this.activeVoicesByNote.set(this.voiceNoteKey(numericChannel, numericNote), voice.id);
    return true;
  }

  noteOn(channel, note, velocity = 1) {
    const numericChannel = this.clamp(Math.round(Number(channel ?? 1)), 1, 16);
    const numericNote = Number(note);
    if (!Number.isFinite(numericNote)) return;
    const key = this.voiceNoteKey(numericChannel, numericNote);
    const now = this.sampleCursor / sampleRate;
    const activeVoice = this.voices.get(this.activeVoicesByNote.get(key));
    if (activeVoice && activeVoice.releasedAt === null) {
      activeVoice.releasedAt = now;
      this.activeVoicesByNote.delete(key);
    }
    this.queueVoiceStart(numericChannel, numericNote, velocity, now);
    this.flushPendingVoiceStarts(now);
  }

  noteOff(channel, note) {
    const numericChannel = this.clamp(Math.round(Number(channel ?? 1)), 1, 16);
    const numericNote = Number(note);
    const key = this.voiceNoteKey(numericChannel, numericNote);
    this.pendingVoiceStarts = this.pendingVoiceStarts.filter((pending) => pending.key !== key);
    const voice = this.voices.get(this.activeVoicesByNote.get(key));
    if (!voice) return;
    if (voice.oneShotSampleEndAt !== null && this.sampleCursor / sampleRate < voice.oneShotSampleEndAt) {
      return;
    }
    this.releaseVoice(voice, this.sampleCursor / sampleRate, this.outputReleaseSeconds());
  }

  releaseVoice(voice, now, releaseSeconds) {
    if (voice.releasedAt !== null) return;
    voice.releaseGain = this.voiceLifecycleGain(voice, now);
    voice.releaseSeconds = releaseSeconds;
    voice.releasedAt = now;
    this.activeVoicesByNote.delete(this.voiceNoteKey(voice.channel ?? 1, voice.note));
  }

  deleteVoice(voiceId, { keepSlot = false } = {}) {
    const voice = this.voices.get(voiceId);
    if (!voice) return;
    this.voices.delete(voiceId);
    for (const [note, activeVoiceId] of this.activeVoicesByNote) {
      if (activeVoiceId === voiceId) this.activeVoicesByNote.delete(note);
    }
    if (!keepSlot && Number.isInteger(voice.slot)) {
      this.freeSlots.push(voice.slot);
      this.freeSlots.sort((a, b) => a - b);
    }
  }

  outputReleaseSeconds() {
    const outputReleases = this.links
      .filter((link) => link.to === "audio" && !link.monitorOnly)
      .map((link) => link.envelope?.release || 0.24);
    return Math.max(0.001, ...outputReleases);
  }

  sampleRangeLength(node) {
    const entry = this.sampleDataByNodeId.get(node.id);
    const length = entry?.data?.length || 0;
    if (!length) return 0;
    const start = this.clamp(Number(node.sample?.start) || 0, 0, 1);
    const end = this.clamp(Number.isFinite(Number(node.sample?.end)) ? Number(node.sample.end) : 1, 0, 1);
    const maxFrame = Math.max(0, length - 1);
    return Math.abs(Math.round(end * maxFrame) - Math.round(start * maxFrame)) + 1;
  }

  oneShotSampleDuration(node, noteFrequency) {
    if (node.wave !== "sample" || node.sample?.mode !== "one-shot") return 0;
    const rangeLength = this.sampleRangeLength(node);
    if (!rangeLength) return 0;
    const entry = this.sampleDataByNodeId.get(node.id);
    const original = Math.max(0.0001, Number(node.sample?.originalFrequency) || 440);
    const base = this.baseFrequency(node, noteFrequency);
    const playbackRate = Math.max(0.0001, base) / Math.max(0.0001, original);
    const sourceRate = Math.max(1, entry?.sampleRate || sampleRate);
    return (rangeLength / sourceRate / playbackRate) + Math.max(0, Number(node.sample?.release) || 0);
  }

  baseFrequency(node, noteFrequency) {
    if (node?.frequencyMode === "fixed") return Number(node.frequency) || 0;
    if (node?.frequencyMode === "sync") return (this.tempo / 60) / this.normalizeSyncBeats(node.syncBeats);
    return noteFrequency * (Number.isFinite(Number(node?.ratio)) ? Number(node.ratio) : 1);
  }

  oneShotSampleEndAt(startedAt, noteFrequency) {
    let duration = 0;
    for (const node of this.nodes) {
      duration = Math.max(duration, this.oneShotSampleDuration(node, noteFrequency));
    }
    return duration > 0 ? startedAt + duration : null;
  }

  voiceLifecycleGain(voice, now) {
    const startGain = this.smoothStep((now - voice.startedAt) / VOICE_START_FADE_SECONDS);
    if (voice.stolenAt === null) return startGain;
    const stealFade = 1 - this.smoothStep((now - voice.stolenAt) / VOICE_STEAL_FADE_SECONDS);
    return startGain * stealFade;
  }

  pruneVoices(now) {
    for (const voice of [...this.voices.values()]) {
      if (voice.releasedAt === null && voice.oneShotSampleEndAt !== null && now >= voice.oneShotSampleEndAt) {
        this.deleteVoice(voice.id);
        continue;
      }
      const stealFinished = voice.stolenAt !== null && now - voice.stolenAt > VOICE_STEAL_FADE_SECONDS;
      const releaseFinished = voice.releasedAt !== null && now - voice.releasedAt > (voice.releaseSeconds || 0.24) + 0.02;
      if (stealFinished || releaseFinished) {
        this.deleteVoice(voice.id);
      }
    }
    this.enforceVoiceLimit();
    this.flushPendingVoiceStarts(now);
  }

  resetRuntimeState() {
    this.voices.clear();
    this.activeVoicesByNote.clear();
    this.pendingVoiceStarts = [];
    this.pendingMidiNoteEvents = [];
    this.freeSlots = Array.from({ length: MAX_ACTIVE_VOICES }, (_, index) => index);
    this.outputLifecycleGain = 0;
    if (!TEIA_RUNTIME_BUILD) {
      this.chorusBuffers.forEach((buffer) => buffer.fill(0));
      this.chorusIndices = [0, 0];
      this.chorusPhases = [0, Math.PI * 0.5];
      this.delayBuffers.forEach((buffer) => buffer.fill(0));
      this.delayIndices = [0, 0];
      this.reverbDelays = [this.createReverbDelays(), this.createReverbDelays()];
      this.inputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
      this.outputDcBlockers = [this.createDcBlocker(), this.createDcBlocker()];
    }
    if (this.wasm) this.wasm.resetPhases();
    this.dspRandomSeed = (this.dspRandomSeed + 0x9e37_79b9) >>> 0;
    this.wasm?.seedDspRandom?.(this.dspRandomSeed || 1);
    this.wasm?.resetDspRuntimeState?.();
    this.armDspCustomWaveOneShots();
    this.wasm?.clearLinkMeters?.();
    // Retaining scope history is only for live DSP hot-swaps. A transport
    // stop/panic must begin the next run with fresh visualization buffers.
    this.dspScopeStates.clear();
    this.wasm?.clearDspScopes?.();
    if (this.dspProgram) this.configureDspScopes();
    this.wasm?.compileDspBlockPlan?.();
    this.refreshWasmViews(true);
  }

  setMuted(muted) {
    this.muted = muted;
    this.cpuLoad = null;
    this.cpuElapsedMs = 0;
    this.cpuDeadlineMs = 0;
    this.nextCpuLoadPostTime = 0;
    this.zeroVoicePhasesOnStart = !muted;
    this.resetRuntimeState();
  }

  waveId(node) {
    return WAVE_IDS.get(node?.wave) || 0;
  }

  frequencyModeId(node) {
    if (node?.frequencyMode === "fixed") return 1;
    if (node?.frequencyMode === "sync") return 2;
    return 0;
  }

  setLinkScopes(payload = {}) {
    const linkIds = Array.isArray(payload.linkIds)
      ? payload.linkIds.map((id) => String(id)).filter(Boolean)
      : payload.linkId
      ? [String(payload.linkId)]
      : [];

    if (linkIds.length === 0) {
      this.linkScopeRequest = null;
      this.linkScopeRequests = [];
      this.linkScopeRequestIndex = 0;
      this.monitorScopeStates.clear();
      this.wasm?.setLinkScope?.(-1, 0, 0.08, 256, sampleRate);
      if ((this.dspProgram?.fftBindings?.length || 0) > 0) {
        this.configureDspScopes();
      } else {
        this.dspScopeStates.clear();
        this.wasm?.clearDspScopes?.();
        this.wasm?.compileDspBlockPlan?.();
        this.refreshWasmViews(true);
      }
      return;
    }

    const scopeSettings = new Map(
      (Array.isArray(payload.scopes) ? payload.scopes : [])
        .filter((scope) => scope && typeof scope.id === "string")
        .map((scope) => [scope.id, scope]),
    );
    const points = this.clamp(Math.round(Number(payload.points) || 256), 32, 1024);
    const displayPoints = this.clamp(Math.round(Number(payload.displayPoints) || points), 32, points);
    const defaultSeconds = this.clamp(Number(payload.seconds) || 0.08, 0.01, LINK_SCOPE_SECONDS_MAX);
    const mode = payload.mode === "zero-crossing" ? "zero-crossing" : payload.mode === "envelope" ? "envelope" : "continuous";
    const nextRequests = [...new Set(linkIds)].map((linkId) => {
      const settings = scopeSettings.get(linkId);
      const requestPoints = this.clamp(Math.round(Number(settings?.points) || points), 32, 1024);
      return {
        linkId,
        mode: settings?.mode === "zero-crossing" ? "zero-crossing" : settings?.mode === "envelope" ? "envelope" : mode,
        points: requestPoints,
        displayPoints: this.clamp(Math.round(Number(settings?.displayPoints) || displayPoints), 32, requestPoints),
        seconds: this.clamp(Number(settings?.seconds) || defaultSeconds, 0.01, LINK_SCOPE_SECONDS_MAX),
      };
    });
    if (scopeRequestListsEqual(this.linkScopeRequests, nextRequests)) return;

    this.linkScopeRequests = nextRequests;
    this.linkScopeRequestIndex = Math.min(this.linkScopeRequestIndex, this.linkScopeRequests.length - 1);
    this.linkScopeRequest = this.linkScopeRequests[this.linkScopeRequestIndex] || null;
    this.wasm?.setLinkScope?.(-1, 0, 0.08, 256, sampleRate);

    if (this.dspProgram) {
      this.monitorScopeStates.clear();
      this.configureDspScopes();
      return;
    }

    this.dspScopeStates.clear();
    this.wasm?.clearDspScopes?.();
    const requestIds = new Set(this.linkScopeRequests.map((request) => request.linkId));
    for (const linkId of this.monitorScopeStates.keys()) {
      if (!requestIds.has(linkId)) this.monitorScopeStates.delete(linkId);
    }
    for (const request of this.linkScopeRequests) {
      this.ensureMonitorScopeState(request);
    }
  }

  applyLinkScopeRequest() {
    if (!this.linkScopeRequest) {
      this.wasm?.setLinkScope?.(-1, 0, 0.08, 256, sampleRate);
      return;
    }

    const link = this.linksById.get(this.linkScopeRequest.linkId);
    const modeId = this.linkScopeRequest.mode === "zero-crossing" ? 1 : this.linkScopeRequest.mode === "envelope" ? 2 : 0;
    this.wasm?.setLinkScope?.(
      link?.wasmIndex ?? -1,
      modeId,
      this.linkScopeRequest.seconds,
      this.linkScopeRequest.points,
      sampleRate,
    );
  }

  advanceLinkScopeRequest() {
    if (this.linkScopeRequests.length <= 1) return;
    this.linkScopeRequestIndex = (this.linkScopeRequestIndex + 1) % this.linkScopeRequests.length;
    this.linkScopeRequest = this.linkScopeRequests[this.linkScopeRequestIndex];
    this.applyLinkScopeRequest();
  }

  ensureMonitorScopeState(request) {
    const existing = this.monitorScopeStates.get(request.linkId);
    if (existing?.graphVersion === this.graphVersion) {
      existing.request = request;
      return existing;
    }

    const state = {
      request,
      graphVersion: this.graphVersion,
      ready: false,
      loading: true,
      wasm: null,
      linkIndex: -1,
      linkScopeSamples: null,
      sampleCursor: 0,
    };
    this.monitorScopeStates.set(request.linkId, state);

    void this.createMonitorScopeState(state).catch(() => {
      const current = this.monitorScopeStates.get(request.linkId);
      if (current === state) this.monitorScopeStates.delete(request.linkId);
    });

    return state;
  }

  async createMonitorScopeState(state) {
    if (!this.wasmBytes) return;
    const link = this.linksById.get(state.request.linkId);
    if (!link) return;

    const { instance } = await WebAssembly.instantiate(this.wasmBytes, {});
    if (this.monitorScopeStates.get(state.request.linkId) !== state) return;

    const wasm = instance.exports;
    const nodeIndices = new Map();
    const sampleSlotsByStorageKey = new Map();
    wasm.clearGraph?.();
    wasm.clearLinkMeters?.();
    wasm.setTempo?.(this.tempo);

    for (const node of this.nodes) {
      const nodeIndex = wasm.addNode(
        this.waveId(node),
        this.frequencyModeId(node),
        node.ratio,
        node.frequency,
        node.syncBeats,
        node.quantise.enabled ? 1 : 0,
        node.quantise.root === QUANTISE_MIDI_ROOT ? -1 : QUANTISE_ROOT_NOTES.indexOf(node.quantise.root),
        QUANTISE_SCALE_IDS.get(node.quantise.scale) ?? 0,
        node.quantise.glide,
        node.speed,
        node.audioInputGain,
        CUSTOM_WAVE_MODE_IDS.get(node.customWave?.mode) ?? 0,
        node.customWave?.sustainStart ?? 0.5,
        node.customWave?.sustainEnd ?? 0.75,
        SAMPLE_MODE_IDS.get(node.sample?.mode) ?? 0,
        node.sample?.start ?? 0,
        node.sample?.end ?? 1,
        node.sample?.stretch ?? 1,
        node.sample?.cycleLength ?? 4096,
        node.sample?.overlapRatio ?? 0.09,
        node.sample?.originalFrequency ?? 440,
        0,
        node.sample?.release ?? 0,
      );
      nodeIndices.set(node.id, nodeIndex);
      if (nodeIndex >= 0 && node.wave === "custom" && typeof wasm.addCustomWavePoint === "function") {
        for (const point of node.customWave.points) {
          wasm.addCustomWavePoint(nodeIndex, point.x, point.y);
        }
      }
      this.copySampleDataToWasmInstance(wasm, node, nodeIndex, sampleSlotsByStorageKey);
    }

    const linkIndices = new Map();
    const addLinkToInstance = (candidate, to) => {
      const from = nodeIndices.get(candidate.from) ?? -1;
      if (from < 0) return -1;
      const linkIndex = wasm.addLink(
        from,
        to,
        candidate.amount,
        candidate.delay || 0,
        candidate.noise || 0,
        candidate.pan || 0,
        MODULATION_TARGET_IDS.get(candidate.modulationTarget) ?? 0,
        PARAMETER_MODE_IDS.get(candidate.parameterMode) ?? 0,
        candidate.velocitySensitivity || 0,
        candidate.drone ? 1 : 0,
        SIGNAL_MODE_IDS.get(candidate.signalMode) ?? 0,
        candidate.follower?.attack || 0.01,
        candidate.follower?.release || 0.12,
        FILTER_TYPE_IDS.get(candidate.filter?.type) ?? 0,
        candidate.filter?.cutoff ?? 5000,
        candidate.filter?.resonance || 0.7,
        candidate.distortion?.enabled ? DISTORTION_TYPE_IDS.get(candidate.distortion?.type) ?? 2 : 0,
        candidate.distortion?.gain || 1.5,
        candidate.envelope?.delay || 0,
        candidate.envelope?.attack || 0.01,
        candidate.envelope?.decay || 0.16,
        candidate.envelope?.sustain ?? 0.72,
        candidate.envelope?.release || 0.24,
        candidate.map?.srcMin ?? 0,
        candidate.map?.srcMax ?? 1,
        candidate.map?.trgtMin ?? 0,
        candidate.map?.trgtMax ?? 1,
      );
      if (linkIndex >= 0) linkIndices.set(candidate.id, linkIndex);
      return linkIndex;
    };

    for (const candidate of this.links) {
      if (candidate === link || candidate.monitorOnly || candidate.internalTarget || candidate.to === "audio") continue;
      const to = this.nodesById.has(candidate.to) ? nodeIndices.get(candidate.to) ?? -1 : -1;
      if (to >= 0) addLinkToInstance(candidate, to);
    }

    const linkIndex = addLinkToInstance(link, AUDIO_TARGET);
    if (linkIndex < 0) return;

    let addedInternalLink = true;
    while (addedInternalLink) {
      addedInternalLink = false;
      for (const internalLink of this.links) {
        if (!internalLink.internalTarget || linkIndices.has(internalLink.id)) continue;
        const targetIndex = linkIndices.get(internalLink.to);
        if (targetIndex === undefined) continue;
        const internalIndex = addLinkToInstance(internalLink, LINK_TARGET_BASE - targetIndex);
        if (internalIndex >= 0) addedInternalLink = true;
      }
    }

    const modeId = state.request.mode === "zero-crossing" ? 1 : state.request.mode === "envelope" ? 2 : 0;
    wasm.setLinkScope?.(linkIndex, modeId, state.request.seconds, state.request.points, sampleRate);
    wasm.armCustomOnceTriggers?.(DRONE_SLOT);

    state.wasm = wasm;
    state.linkIndex = linkIndex;
    state.linkScopeSamples = typeof wasm.linkScopePtr === "function"
      ? new Float32Array(wasm.memory.buffer, wasm.linkScopePtr(), 1024)
      : null;
    state.ready = true;
    state.loading = false;
    this.port.postMessage({
      type: "wasmScopeMemory",
      payload: {
        linkId: state.request.linkId,
        memoryBytes: wasm.memory.buffer.byteLength,
        lazyBufferBytes: Number(wasm.lazyBufferBytes?.()) || 0,
        scopeCount: this.monitorScopeStates.size,
      },
    });
  }

  copySampleDataToWasmInstance(wasm, node, nodeIndex, sampleSlotsByStorageKey = new Map()) {
    if (!wasm || node?.wave !== "sample" || nodeIndex < 0) return;
    const entry = this.sampleDataByNodeId.get(node.id);
    if (!entry?.data?.length || typeof wasm.setSampleData !== "function" || typeof wasm.sampleDataPtr !== "function") return;
    const maxFrames = typeof wasm.maxSampleFrames === "function" ? wasm.maxSampleFrames() : entry.data.length;
    if (entry.data.length > Math.max(0, maxFrames || 0)) return;
    const length = entry.data.length;
    const sharedSlot = sampleSlotsByStorageKey.get(entry.storageKey);
    const slot = Number.isInteger(sharedSlot) && typeof wasm.bindSampleData === "function"
      ? wasm.bindSampleData(nodeIndex, sharedSlot)
      : wasm.setSampleData(nodeIndex, entry.sampleRate || sampleRate, length);
    if (slot < 0) return;
    if (slot === sharedSlot) return;
    const ptr = wasm.sampleDataPtr(slot);
    if (!ptr) return;
    new Float32Array(wasm.memory.buffer, ptr, length).set(entry.data.subarray(0, length));
    sampleSlotsByStorageKey.set(entry.storageKey, slot);
  }

  reportSampleLoadError(nodeId, entry, maxFrames, reason) {
    const sampleRateValue = Math.max(1, Number(entry?.sampleRate) || sampleRate);
    const maxSeconds = Math.max(0, Number(maxFrames) || 0) / sampleRateValue;
    const durationSeconds = (entry?.data?.length || 0) / sampleRateValue;
    const message = reason === "sample-too-long"
      ? `Sample "${entry?.name || nodeId}" is ${this.formatDuration(durationSeconds)}, exceeding the ${this.formatDuration(maxSeconds)} decoded-audio safety limit.`
      : reason === "sample-memory-limit"
        ? `Sample "${entry?.name || nodeId}" could not load because the patch's decoded sample memory limit was reached.`
        : `Sample "${entry?.name || nodeId}" could not be allocated in the audio engine.`;
    this.port.postMessage({
      type: "sampleLoadError",
      payload: { nodeId, name: entry?.name || "", reason, message, durationSeconds, maxSeconds },
    });
  }

  formatDuration(seconds) {
    const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
  }

  renderMonitorScopes(frames) {
    for (const state of this.monitorScopeStates.values()) {
      if (!state.ready || !state.wasm) continue;
      const now = state.sampleCursor / sampleRate;
      state.wasm.clear?.(frames);
      state.wasm.renderVoiceGraph?.(
        DRONE_SLOT,
        frames,
        sampleRate,
        440,
        1,
        1,
        now,
        -1,
        -1,
      );
      state.sampleCursor += frames;
    }
  }

  monitorScopeFrameSamples(state) {
    if (!state.ready || !state.linkScopeSamples || !state.wasm) return [];
    const count = this.clamp(Math.round(state.wasm.linkScopeCount?.() || 0), 0, state.request.points);
    const mode = state.request.mode;
    const displayPoints = state.request.displayPoints || state.request.points;
    const writeIndex = mode === "envelope"
      ? 0
      : this.clamp(Math.round(state.wasm.linkScopeWriteIndex?.() || 0), 0, state.request.points - 1);
    const raw = Array.from(state.linkScopeSamples.slice(0, state.request.points));
    const samples = mode === "envelope"
      ? raw.slice(0, count).concat(Array(Math.max(0, state.request.points - count)).fill(0))
      : count < state.request.points
      ? raw.slice(0, count)
      : raw.slice(writeIndex).concat(raw.slice(0, writeIndex));
    if (mode !== "zero-crossing") return resampleScopeSamples(samples, displayPoints);
    return alignScopeToZeroCrossing(samples, displayPoints);
  }

  linkScopeFrameSamples() {
    if (!this.linkScopeRequest || !this.linkScopeSamples || !this.wasm) return [];
    const count = this.clamp(Math.round(this.wasm.linkScopeCount?.() || 0), 0, this.linkScopeRequest.points);
    const mode = this.linkScopeRequest.mode;
    const displayPoints = this.linkScopeRequest.displayPoints || this.linkScopeRequest.points;
    const writeIndex = mode === "envelope"
      ? 0
      : this.clamp(Math.round(this.wasm.linkScopeWriteIndex?.() || 0), 0, this.linkScopeRequest.points - 1);
    const raw = Array.from(this.linkScopeSamples.slice(0, this.linkScopeRequest.points));
    const samples = mode === "envelope"
      ? raw.slice(0, count).concat(Array(Math.max(0, this.linkScopeRequest.points - count)).fill(0))
      : count < this.linkScopeRequest.points
      ? raw.slice(0, count)
      : raw.slice(writeIndex).concat(raw.slice(0, writeIndex));
    if (mode !== "zero-crossing") return resampleScopeSamples(samples, displayPoints);
    return alignScopeToZeroCrossing(samples, displayPoints);
  }

  dspScopeFrameSamples(state) {
    if (!state?.samples || !this.wasm) return [];
    if (state.samples.buffer !== this.wasm.memory.buffer) {
      const ptr = this.wasm.dspScopePtr?.(state.slot);
      state.samples = ptr ? new Float32Array(this.wasm.memory.buffer, ptr, 1024) : null;
      if (!state.samples) return [];
    }
    const count = this.clamp(Math.round(this.wasm.dspScopeCount?.(state.slot) || 0), 0, state.request.points);
    const mode = state.request.mode;
    const displayPoints = state.request.displayPoints || state.request.points;
    const writeIndex = mode === "envelope"
      ? 0
      : this.clamp(Math.round(this.wasm.dspScopeWriteIndex?.(state.slot) || 0), 0, state.request.points - 1);
    const raw = Array.from(state.samples.slice(0, state.request.points));
    const samples = mode === "envelope"
      ? raw.slice(0, count).concat(Array(Math.max(0, state.request.points - count)).fill(0))
      : count < state.request.points
      ? raw.slice(0, count)
      : raw.slice(writeIndex).concat(raw.slice(0, writeIndex));
    if (mode !== "zero-crossing") return resampleScopeSamples(samples, displayPoints);
    return alignScopeToZeroCrossing(samples, displayPoints);
  }

  flushLinkMeters() {
    if (this.sampleCursor < this.nextLinkMeterPostSample) return;
    const postSeconds = this.monitorScopeStates.size > 0 || this.dspScopeStates.size > 0
      ? SCOPE_VISUALIZATION_POST_SECONDS
      : VISUALIZATION_POST_SECONDS;
    this.nextLinkMeterPostSample = this.sampleCursor + Math.max(1, Math.round(sampleRate * postSeconds));
    const levels = this.links.filter((link) => !link.monitorOnly).map((link) => {
      const index = link.wasmIndex;
      const count = index >= 0 ? this.linkMeterCounts?.[index] || 0 : 0;
      if (count > 0) {
        return [
          link.id,
          Math.max(0, (this.linkMeterInputSums?.[index] || 0) / count),
          Math.max(0, (this.linkMeterOutputSums?.[index] || 0) / count),
          Math.max(0, (this.linkMeterEnvelopeSums?.[index] || 0) / count),
        ];
      }
      return [link.id, 0, 0, 0];
    });
    for (const state of this.monitorScopeStates.values()) {
      if (!state.ready || !state.wasm || state.linkIndex < 0) continue;
      const count = state.wasm.linkMeterCountPtr
        ? new Uint32Array(state.wasm.memory.buffer, state.wasm.linkMeterCountPtr(), 1024)[state.linkIndex] || 0
        : 0;
      if (count > 0) {
        const inputSums = new Float64Array(state.wasm.memory.buffer, state.wasm.linkMeterInputPtr(), 1024);
        const outputSums = new Float64Array(state.wasm.memory.buffer, state.wasm.linkMeterOutputPtr(), 1024);
        const envelopeSums = new Float64Array(state.wasm.memory.buffer, state.wasm.linkMeterEnvelopePtr(), 1024);
        levels.push([
          state.request.linkId,
          Math.max(0, (inputSums[state.linkIndex] || 0) / count),
          Math.max(0, (outputSums[state.linkIndex] || 0) / count),
          Math.max(0, (envelopeSums[state.linkIndex] || 0) / count),
        ]);
      }
      state.wasm.clearLinkMeters?.();
    }
    for (const state of this.dspMeterStates.values()) {
      const isImageCoordinate = state.id.endsWith(":image-x") || state.id.endsWith(":image-y");
      const isSignedMeter = this.dspProgram?.signedMeterIds?.includes(state.id);
      const signedLevel = Number(this.wasm?.dspMeterSignedLevel?.(state.slot)) || 0;
      const absoluteLevel = Math.max(0, Number(this.wasm?.dspMeterLevel?.(state.slot)) || 0);
      const displayedLevel = isImageCoordinate ? signedLevel : absoluteLevel;
      levels.push([
        state.id,
        isImageCoordinate || isSignedMeter ? signedLevel : displayedLevel,
        displayedLevel,
        displayedLevel,
      ]);
    }
    for (const binding of this.dspProgram?.stateBindings || []) {
      if (binding.kind !== "selector") continue;
      const selectedIndex = Number(this.wasm?.getDspState?.(binding.state + 1));
      if (!Number.isFinite(selectedIndex)) continue;
      levels.push([binding.id, selectedIndex, selectedIndex, selectedIndex]);
    }
    for (const binding of this.dspProgram?.stateBindings || []) {
      if (!String(binding.id || "").endsWith(":accumulator")) continue;
      const currentValue = Number(this.wasm?.getDspState?.(binding.state));
      if (!Number.isFinite(currentValue)) continue;
      levels.push([binding.id, currentValue, currentValue, currentValue]);
    }
    const playheads = [];
    // Custom-wave bindings identify an individual curve (`node:wave:N`), while
    // oscillator state bindings belong to their parent node. Normalize to the
    // parent ID so the editor receives the live playback position.
    const customWaveNodeIds = new Set((this.dspProgram?.customWaveBindings || []).map((binding) => (
      String(binding.nodeId || "").replace(/:wave:\d+$/, "")
    )));
    const repeatedOps = (this.dspProgram?.ops || []).filter((op) => op.opcode === 42 || op.opcode === 46);
    for (const binding of this.dspProgram?.stateBindings || []) {
      if (binding.kind !== "oscillator" || !customWaveNodeIds.has(binding.nodeId)) continue;
      const repeated = repeatedOps.some((op) => (
        binding.state >= op.state
        && binding.state < op.state + Math.max(0, Math.trunc(Number(op.value2) || 0))
      ));
      if (repeated && this.wasm?.dspRepeatedStateValueCount && this.wasm?.dspRepeatedStateValue) {
        const count = Math.max(0, Math.trunc(Number(this.wasm.dspRepeatedStateValueCount(binding.state)) || 0));
        for (let index = 0; index < count; index += 1) {
          const playhead = Number(this.wasm.dspRepeatedStateValue(binding.state, index));
          if (Number.isFinite(playhead)) playheads.push([binding.nodeId, this.clamp(playhead, 0, 1)]);
        }
        continue;
      }
      const playhead = Number(this.wasm?.getDspState?.(binding.state));
      if (Number.isFinite(playhead)) playheads.push([binding.nodeId, this.clamp(playhead, 0, 1)]);
    }
    for (let slot = 0; slot < (this.dspProgram?.sampleBindings?.length || 0); slot += 1) {
      const nodeId = this.dspProgram.sampleBindings[slot]?.nodeId;
      const samplePlayheads = [];
      const playheadCount = this.wasm?.dspSamplePlayheadCount
        ? Math.max(0, Math.trunc(Number(this.wasm.dspSamplePlayheadCount(slot)) || 0))
        : MAX_SAMPLE_PLAYER_VOICES;
      for (let index = 0; index < playheadCount; index += 1) {
        const playhead = Number(this.wasm?.dspSamplePlayheadValue
          ? this.wasm.dspSamplePlayheadValue(slot, index)
          : this.wasm?.dspSamplePlayheadVoice?.(slot, index));
        if (nodeId && Number.isFinite(playhead) && playhead >= 0) {
          const entry = [nodeId, this.clamp(playhead, 0, 1), false];
          samplePlayheads.push(entry);
          playheads.push(entry);
        }
      }
      const latestPlayhead = Number(this.wasm?.dspSampleLatestPlayhead?.(slot));
      if (samplePlayheads.length > 0 && Number.isFinite(latestPlayhead) && latestPlayhead >= 0) {
        let latestEntry = samplePlayheads[0];
        let smallestDistance = Math.abs(latestEntry[1] - latestPlayhead);
        for (let index = 1; index < samplePlayheads.length; index += 1) {
          const distance = Math.abs(samplePlayheads[index][1] - latestPlayhead);
          if (distance <= smallestDistance) {
            latestEntry = samplePlayheads[index];
            smallestDistance = distance;
          }
        }
        latestEntry[2] = true;
      }
    }
    const buffers = [];
    const repeatedRanges = repeatedOps.map((op) => ({
      start: Math.max(0, Math.trunc(Number(op.state) || 0)),
      end: Math.max(0, Math.trunc(Number(op.state) || 0)) + Math.max(0, Math.trunc(Number(op.value2) || 0)),
    }));
    const bufferLength = Math.max(0, Math.trunc(Number(this.wasm?.dspBufferLength?.()) || 0));
    if (bufferLength > 0 && this.wasm?.dspBufferPtr && this.wasm?.memory) {
      for (const binding of this.dspProgram?.stateBindings || []) {
        if (!String(binding.id || "").endsWith(":buffer")) continue;
        if (repeatedRanges.some((range) => binding.state >= range.start && binding.state < range.end)) continue;
        const op = (this.dspProgram?.ops || []).find((candidate) => candidate.opcode === 34 && candidate.state === binding.state);
        if (!op) continue;
        const ptr = this.wasm.dspBufferPtr(binding.state);
        if (!ptr) continue;
        const lengthSeconds = Number(this.wasm.getDspState?.(binding.state + 3));
        const renderedSampleCount = Number.isFinite(lengthSeconds) && lengthSeconds > 0
          ? Math.round(lengthSeconds * sampleRate)
          : 0;
        const sampleCount = this.clamp(
          renderedSampleCount || this.bufferSampleCounts.get(binding.nodeId) || 2,
          2,
          bufferLength,
        );
        if (renderedSampleCount > 0) this.bufferSampleCounts.set(binding.nodeId, sampleCount);
        const samples = new Float32Array(this.wasm.memory.buffer, ptr, sampleCount);
        const playhead = this.clamp(Number(this.wasm.getDspState?.(binding.state + 1)) || 0, 0, 1);
        const recordHead = this.clamp(Number(this.wasm.getDspState?.(binding.state + 2)) || 0, 0, 1);
        buffers.push([binding.nodeId, playhead, recordHead, waveformBinsFromBuffer(samples, 240)]);
      }
    }
    this.lastOutputPeak = 0;
    this.wasm?.clearLinkMeters?.();
    this.wasm?.resetDspMeterLevels?.();
    const scopes = [];
    for (const state of this.monitorScopeStates.values()) {
      if (!state.ready) continue;
      scopes.push({
        id: state.request.linkId,
        mode: state.request.mode,
        samples: this.monitorScopeFrameSamples(state),
      });
    }
    for (const state of this.dspScopeStates.values()) {
      const samples = this.dspScopeFrameSamples(state);
      const fftBinding = (this.dspProgram?.fftBindings || []).find((binding) => binding.nodeId === state.request.linkId);
      if (fftBinding) {
        const minFrequency = this.dspProgram.values[fftBinding.minFrequencyValueIndex];
        const maxFrequency = this.dspProgram.values[fftBinding.maxFrequencyValueIndex];
        const peak = dominantSpectrumPeak(samples, state.request.seconds, minFrequency, maxFrequency);
        this.setDspValueAt(fftBinding.frequencyValueIndex, peak.frequency);
        this.setDspValueAt(fftBinding.amplitudeValueIndex, peak.amplitude);
      }
      scopes.push({
        id: state.request.linkId,
        mode: state.request.mode,
        samples,
      });
    }
    this.port.postMessage({
      type: "visualizationFrame",
      payload: { levels, playheads, scopes, buffers },
    });
  }

  updatePlayerFftOutputs() {
    if (this.dspScopeStates.size === 0 || this.sampleCursor < this.nextLinkMeterPostSample) return;
    this.nextLinkMeterPostSample = this.sampleCursor + Math.max(1, Math.round(sampleRate / 30));
    for (const binding of this.dspProgram?.fftBindings || []) {
      const state = this.dspScopeStates.get(binding.nodeId);
      if (!state) continue;
      const samples = this.dspScopeFrameSamples(state);
      const minFrequency = this.dspProgram.values[binding.minFrequencyValueIndex];
      const maxFrequency = this.dspProgram.values[binding.maxFrequencyValueIndex];
      const peak = dominantSpectrumPeak(samples, state.request.seconds, minFrequency, maxFrequency);
      this.setDspValueAt(binding.frequencyValueIndex, peak.frequency);
      this.setDspValueAt(binding.amplitudeValueIndex, peak.amplitude);
    }
  }

  fillSilence(outputs) {
    const output = outputs[0];
    const left = output?.[0];
    const right = output?.[1] || left;
    if (!left) return;
    left.fill(0);
    if (right !== left) right.fill(0);
    if (!TEIA_RUNTIME_BUILD) this.recordOutputSamples(left, right, left.length);
    this.lastGraphLeftSample = 0;
    this.lastGraphRightSample = 0;
    this.outputLifecycleGain = 0;
  }

  nextOutputLifecycleGain() {
    if (this.outputLifecycleGain >= 1) return 1;
    const step = 1 / (DSP_OUTPUT_START_FADE_SECONDS * sampleRate);
    this.outputLifecycleGain = Math.min(1, this.outputLifecycleGain + step);
    return this.outputLifecycleGain;
  }

  copyInput(inputs, frames) {
    if (!this.inputBuffer) return;
    const input = inputs[0];
    const inputLeft = input?.[0];
    const inputRight = input?.[1] || inputLeft;
    for (let i = 0; i < frames; i += 1) {
      if (this.inputLeftBuffer) this.inputLeftBuffer[i] = inputLeft?.[i] || 0;
      if (this.inputRightBuffer) this.inputRightBuffer[i] = inputRight?.[i] || 0;
    }
    if (!inputLeft) {
      this.inputBuffer.fill(0, 0, frames);
      return;
    }
    if (inputRight === inputLeft) {
      this.inputBuffer.set(inputLeft.subarray(0, frames));
      if (inputLeft.length < frames) this.inputBuffer.fill(0, inputLeft.length, frames);
      return;
    }
    for (let i = 0; i < frames; i += 1) {
      this.inputBuffer[i] = ((inputLeft[i] || 0) + (inputRight[i] || 0)) * 0.5;
    }
  }

  renderCurrentDspProgramToWasm(frames) {
    this.flushMidiNoteEventsToWasm();
    this.wasm.renderDspProgram?.(frames, sampleRate);
    if (this.wasm.dspParallelFault?.()) {
      this.parallelFailed = true;
      this.ready = false;
      this.port.postMessage({
        type: "parallelFailure",
        payload: { message: "Parallel audio workers stalled. Playback stopped; switch DSP mode to single or press play to retry." },
      });
      throw new Error("Parallel audio workers stalled.");
    }
    this.flushMidiOutputEvents();
  }

  flushMidiOutputEvents() {
    if (!this.wasm?.takeDspMidiOutputEvent) return;
    const events = [];
    while (this.wasm.takeDspMidiOutputEvent()) {
      events.push({
        isCc: Boolean(this.wasm.dspMidiOutputEventIsCc?.()),
        noteOn: Boolean(this.wasm.dspMidiOutputEventNoteOn?.()),
        channel: Math.trunc(Number(this.wasm.dspMidiOutputEventChannel?.()) || 1),
        note: Number(this.wasm.dspMidiOutputEventNote?.()) || 0,
        velocity: Number(this.wasm.dspMidiOutputEventVelocity?.()) || 0,
        cc: Number(this.wasm.dspMidiOutputEventCc?.()) || 0,
        value: Number(this.wasm.dspMidiOutputEventValue?.()) || 0,
      });
    }
    if (events.length) this.port.postMessage({ type: "midiOutput", payload: { events } });
  }

  nextGraphUpdateCrossfadeSample(leftSample, rightSample) {
    const transition = this.graphUpdateTransition;
    if (!transition) {
      return [leftSample, rightSample];
    }

    const index = transition.index;
    if (index >= transition.frames) {
      this.graphUpdateTransition = null;
      return [leftSample, rightSample];
    }

    const mix = this.smoothStep(index / Math.max(1, transition.frames - 1));
    const oldLeft = transition.left[index] || 0;
    const oldRight = transition.right[index] || oldLeft;
    transition.index += 1;
    if (transition.index >= transition.frames) {
      this.graphUpdateTransition = null;
    }

    return [
      oldLeft + (leftSample - oldLeft) * mix,
      oldRight + (rightSample - oldRight) * mix,
    ];
  }

  renderDspProgramToOutput(inputs, outputs, frames) {
    const output = outputs[0];
    const left = output?.[0];
    const right = output?.[1] || left;
    if (!left) return true;

    if (!this.ready || !this.dspProgram || this.dspProgram.errors.length > 0 || this.dspProgram.ops.length === 0) {
      this.fillSilence(outputs);
      this.sampleCursor += left.length;
      return true;
    }

    if (!TEIA_RUNTIME_BUILD) {
      this.pruneVoices(this.sampleCursor / sampleRate);
      this.flushPendingVoiceStarts(this.sampleCursor / sampleRate);
    }
    this.wasm.clear(frames);
    this.copyInput(inputs, frames);
    this.wasm.beginDspRenderQuantum?.();
    this.renderCurrentDspProgramToWasm(frames);
    if (!TEIA_RUNTIME_BUILD) this.captureSampleTriggerEvents();

    let peak = 0;
    for (let i = 0; i < frames; i += 1) {
      const lifecycleGain = this.nextOutputLifecycleGain();
      const rawLeftSample = (this.leftBuffer[i] || 0) * lifecycleGain;
      const rawRightSample = (this.rightBuffer[i] || 0) * lifecycleGain;
      let mixedLeftSample = rawLeftSample;
      let mixedRightSample = rawRightSample;
      if (this.graphUpdateTransition) {
        [mixedLeftSample, mixedRightSample] = this.nextGraphUpdateCrossfadeSample(rawLeftSample, rawRightSample);
      }
      const leftSample = this.sanitizeSample(mixedLeftSample);
      const rightSample = this.sanitizeSample(mixedRightSample);
      this.lastGraphLeftSample = mixedLeftSample;
      this.lastGraphRightSample = mixedRightSample;
      left[i] = leftSample;
      right[i] = rightSample;
      if (!TEIA_RUNTIME_BUILD) peak = Math.max(peak, Math.abs(leftSample), Math.abs(rightSample));
    }
    for (let i = frames; i < left.length; i += 1) {
      left[i] = 0;
      right[i] = 0;
    }
    if (!TEIA_RUNTIME_BUILD) {
      this.lastOutputPeak = Math.max(this.lastOutputPeak, peak);
      this.recordOutputSamples(left, right, left.length);
    }
    this.sampleCursor += left.length;
    this.flushPendingCustomWaveUpdates();
    if (TEIA_RUNTIME_BUILD) this.updatePlayerFftOutputs();
    else this.flushLinkMeters();
    return true;
  }

  reportProcessorError(error) {
    const now = currentTime || 0;
    if (now - this.lastProcessorErrorAt < 1) return;
    this.lastProcessorErrorAt = now;
    this.port.postMessage({
      type: "processorError",
      payload: {
        name: error?.name || "Error",
        message: error?.message || String(error),
        stack: error?.stack || "",
        sampleCursor: this.sampleCursor,
        graphVersion: this.graphVersion,
        ready: this.ready,
        muted: this.muted,
        nodes: this.nodes.length,
        links: this.links.length,
      },
    });
  }

  processUnsafe(inputs, outputs) {
    if (this.parallelFailed) {
      this.fillSilence(outputs);
      return true;
    }
    this.refreshWasmViews(true);
    const output = outputs[0];
    const left = output?.[0];
    const right = output?.[1] || left;
    if (!left) return true;

    const frames = Math.min(left.length, MAX_WASM_FRAMES);
    this.lastProcessFrames = frames;
    if (this.muted) {
      this.fillSilence(outputs);
      return true;
    }

    if (this.dspProgram) {
      return this.renderDspProgramToOutput(inputs, outputs, frames);
    }

    this.fillSilence(outputs);
    this.sampleCursor += left.length;
    return true;
  }

  process(inputs, outputs) {
    const startedAt = TEIA_RUNTIME_BUILD ? 0 : this.cpuClockNow();
    try {
      return this.processUnsafe(inputs, outputs);
    } catch (error) {
      if (this.renderingStatus.mode === "multi" && !this.parallelFailed) {
        this.parallelFailed = true;
        this.ready = false;
        this.port.postMessage({ type: "parallelFailure", payload: { message: error?.message || "Parallel audio failed." } });
      }
      this.reportProcessorError(error);
      this.fillSilence(outputs);
      return true;
    } finally {
      if (!TEIA_RUNTIME_BUILD) {
        this.updateCpuLoad(
          this.cpuClockNow() - startedAt,
          outputs[0]?.[0]?.length || this.lastProcessFrames,
        );
      }
    }
  }

  cpuClockNow() {
    return globalThis.performance?.now?.() ?? Date.now();
  }

  updateCpuLoad(elapsedMs, frames) {
    const deadlineMs = frames / sampleRate * 1000;
    if (!(deadlineMs > 0) || !Number.isFinite(elapsedMs)) return;

    this.cpuElapsedMs += Math.max(0, elapsedMs);
    this.cpuDeadlineMs += deadlineMs;
    this.cpuPeakLoad = Math.max(this.cpuPeakLoad, elapsedMs / deadlineMs);
    if (elapsedMs > deadlineMs) this.cpuDeadlineMisses += 1;
    if (currentTime < this.nextCpuLoadPostTime) return;

    const intervalLoad = this.cpuElapsedMs / this.cpuDeadlineMs;
    this.cpuLoad = this.cpuLoad === null
      ? intervalLoad
      : this.cpuLoad + (intervalLoad - this.cpuLoad) * 0.35;
    this.cpuElapsedMs = 0;
    this.cpuDeadlineMs = 0;

    this.nextCpuLoadPostTime = currentTime + 0.1;
    this.port.postMessage({
      type: "cpuLoad",
      payload: { load: this.cpuLoad, peakLoad: this.cpuPeakLoad, deadlineMisses: this.cpuDeadlineMisses },
    });
    this.cpuPeakLoad = 0;
  }
}

function sameScopeRequest(left, right) {
  return Boolean(left)
    && Boolean(right)
    && left.linkId === right.linkId
    && left.mode === right.mode
    && left.points === right.points
    && left.displayPoints === right.displayPoints
    && left.seconds === right.seconds;
}

function scopeRequestListsEqual(left, right) {
  return left.length === right.length
    && left.every((request, index) => sameScopeRequest(request, right[index]));
}

function resampleScopeSamples(samples, targetCount) {
  if (samples.length <= targetCount) return samples;
  if (targetCount <= 1) return [samples[samples.length - 1]];

  return Array.from({ length: targetCount }, (_, index) => {
    const sourcePosition = index * (samples.length - 1) / (targetCount - 1);
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    return samples[leftIndex] + (samples[rightIndex] - samples[leftIndex]) * fraction;
  });
}

function alignScopeToZeroCrossing(samples, targetCount) {
  const count = Math.max(1, Math.min(samples.length, Math.trunc(targetCount) || 1));
  const maxStart = samples.length - count;
  if (maxStart < 1) return resampleScopeSamples(samples, count);

  // A complex periodic wave can cross zero several times per cycle. Choosing
  // the oldest crossing makes the trace alternate between those phases as the
  // ring buffer advances. Use the most decisive rising crossing instead, with
  // a small neighbourhood so near-zero ripples and noise do not win.
  const slopeRadius = Math.max(1, Math.round(count / 128));
  let bestStart = -1;
  let bestStrength = -Infinity;
  for (let index = 1; index <= maxStart; index += 1) {
    const before = Number(samples[index - 1]) || 0;
    const after = Number(samples[index]) || 0;
    if (!(before < 0 && after >= 0)) continue;

    const interval = after - before;
    const fraction = interval > 0 ? -before / interval : 0;
    const crossingStart = index - 1 + fraction;
    if (crossingStart > maxStart) continue;

    const left = Number(samples[Math.max(0, index - slopeRadius)]) || 0;
    const right = Number(samples[Math.min(samples.length - 1, index + slopeRadius - 1)]) || 0;
    const strength = right - left;
    if (strength <= bestStrength) continue;

    bestStart = crossingStart;
    bestStrength = strength;
  }

  if (bestStart < 0) return resampleScopeSamples(samples, count);

  // Interpolate the fractional crossing position so the trace begins exactly
  // at zero instead of jittering by one captured sample between frames.
  return Array.from({ length: count }, (_, index) => {
    const sourcePosition = bestStart + index;
    const leftIndex = Math.floor(sourcePosition);
    const rightIndex = Math.min(samples.length - 1, leftIndex + 1);
    const fraction = sourcePosition - leftIndex;
    return samples[leftIndex] + (samples[rightIndex] - samples[leftIndex]) * fraction;
  });
}

function waveformBinsFromBuffer(samples, targetCount) {
  const count = Math.max(1, Math.min(samples.length, Math.trunc(targetCount) || 1));
  const maxSamplesPerBin = 64;
  const bins = [];
  for (let index = 0; index < count; index += 1) {
    const start = Math.floor(index * samples.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * samples.length / count));
    const stride = Math.max(1, Math.ceil((end - start) / maxSamplesPerBin));
    let min = 0;
    let max = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += stride) {
      const sample = Number(samples[sourceIndex]) || 0;
      min = Math.min(min, sample);
      max = Math.max(max, sample);
    }
    const lastSample = Number(samples[end - 1]) || 0;
    min = Math.min(min, lastSample);
    max = Math.max(max, lastSample);
    bins.push([min, max]);
  }
  return bins;
}

function dominantSpectrumPeak(samples, seconds, minFrequency = 20, maxFrequency = 20000) {
  const size = largestPowerOfTwoAtMost(Math.min(512, samples.length));
  if (size < 32 || !(seconds > 0)) return { frequency: 0, amplitude: 0 };

  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  const offset = samples.length - size;
  for (let index = 0; index < size; index += 1) {
    const sample = Number(samples[offset + index]);
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * index / (size - 1));
    real[index] = (Number.isFinite(sample) ? sample : 0) * window;
  }
  fftInPlace(real, imaginary);

  const binFrequency = 1 / seconds;
  const windowStart = Math.max(20, Math.min(20000, Math.min(minFrequency, maxFrequency)));
  const windowEnd = Math.max(20, Math.min(20000, Math.max(minFrequency, maxFrequency)));
  const upperBin = Math.min(size / 2 - 1, Math.floor(windowEnd / binFrequency));
  const lowerBin = Math.max(1, Math.ceil(windowStart / binFrequency));
  if (upperBin < lowerBin) return { frequency: 0, amplitude: 0 };
  const magnitudes = new Float64Array(size / 2);
  let peakBin = lowerBin;
  let peakMagnitude = 0;
  for (let bin = lowerBin; bin <= upperBin; bin += 1) {
    const magnitude = Math.hypot(real[bin], imaginary[bin]);
    magnitudes[bin] = magnitude;
    if (magnitude > peakMagnitude) {
      peakMagnitude = magnitude;
      peakBin = bin;
    }
  }
  if (peakMagnitude <= 1e-9) return { frequency: 0, amplitude: 0 };

  const left = magnitudes[peakBin - 1] || peakMagnitude;
  const right = magnitudes[peakBin + 1] || peakMagnitude;
  const denominator = left - 2 * peakMagnitude + right;
  const offsetBins = Math.abs(denominator) <= 1e-12
    ? 0
    : Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator));
  return {
    frequency: Math.max(windowStart, Math.min(windowEnd, (peakBin + offsetBins) * binFrequency)),
    // A Hann window has a coherent gain of 0.5, hence the factor of four.
    amplitude: 4 * peakMagnitude / size,
  };
}

function largestPowerOfTwoAtMost(value) {
  return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}

function fftInPlace(real, imaginary) {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index >= reversed) continue;
    [real[index], real[reversed]] = [real[reversed], real[index]];
    [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const evenIndex = start + offset;
        const oddIndex = evenIndex + length / 2;
        const oddReal = real[oddIndex] * twiddleReal - imaginary[oddIndex] * twiddleImaginary;
        const oddImaginary = real[oddIndex] * twiddleImaginary + imaginary[oddIndex] * twiddleReal;
        real[oddIndex] = real[evenIndex] - oddReal;
        imaginary[oddIndex] = imaginary[evenIndex] - oddImaginary;
        real[evenIndex] += oddReal;
        imaginary[evenIndex] += oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
}

registerProcessor("teia-wasm-engine", TeiaWasmEngine);
