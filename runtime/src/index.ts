import { readPackageZip } from './zip.js';

interface ParameterDefinition {
  id: string;
  name: string;
  persistentId?: string;
  step?: number;
  integer?: boolean;
  nodeId: string;
  valueIndex: number;
  defaultValue: number;
  min?: number;
  max?: number;
}

interface Manifest {
  format: string;
  version: number;
  programVersion: number;
  engineApiVersion: number;
  runtimePackage: string;
  paths: { patch: string; program: string };
  parameters: ParameterDefinition[];
  assets: Array<{ path: string; sha256: string; bytes: number }>;
}

interface Program {
  version: number;
  engineApiVersion?: number;
  errors: string[];
  values: number[];
  sampleBindings: Array<{ nodeId: string; sample: { name: string; url: string } }>;
  imageBindings: Array<{ nodeId: string; image: { name: string; url: string } }>;
  [key: string]: unknown;
}

interface Patch { buffers?: Record<string, { hash: string; sampleRate: number; sampleCount: number }>; nodes?: { id: string; type?: string; subpatch?: Patch }[] }

const registeredWorklets = new WeakMap<BaseAudioContext, { hash: string; ready: Promise<void> }>();
const workletUrl = new URL('./audio-worklet-wasm.js', import.meta.url);
const wasmUrl = new URL('./teia-kernel.wasm', import.meta.url);
const simdWasmUrl = new URL('./teia-kernel-simd.wasm', import.meta.url);
let wasmBytesPromise: Promise<ArrayBuffer> | undefined;

export class PatchPlayer {
  readonly node: AudioWorkletNode;
  readonly parameters: readonly ParameterDefinition[];
  readonly manifest: Manifest;
  private readonly context: BaseAudioContext;
  private readonly values: number[];
  private disposed = false;

  private constructor(context: BaseAudioContext, node: AudioWorkletNode, manifest: Manifest, values: number[]) {
    this.context = context;
    this.node = node;
    this.manifest = manifest;
    this.parameters = manifest.parameters;
    this.values = values;
  }

  static async load(context: BaseAudioContext, packageFile: Blob | ArrayBuffer): Promise<PatchPlayer> {
    const bytes = packageFile instanceof Blob ? await packageFile.arrayBuffer() : packageFile;
    const files = readPackageZip(bytes);
    const manifest = readJson<Manifest>(files, 'manifest.json');
    if (manifest.format !== 'teia-patch' || manifest.version !== 2 || ![1, 2].includes(manifest.engineApiVersion)
      || manifest.runtimePackage !== '@pauloricca/teia-runtime') {
      throw new Error('Unsupported patch package or engine API version.');
    }
    const program = readJson<Program>(files, manifest.paths.program);
    const patch = readJson<Patch>(files, manifest.paths.patch);
    program.engineApiVersion = manifest.engineApiVersion;
    if (program.version !== manifest.programVersion || program.errors?.length) throw new Error('Invalid compiled DSP program.');
    if (!Array.isArray(program.values) || !Array.isArray(manifest.parameters)) throw new Error('Invalid parameter metadata.');
    await verifyAssets(files, manifest);

    const preparedSamples = await prepareSamples(context, files, program);
    const preparedImages = await prepareImages(files, program);
    const preparedBuffers = prepareBuffers(files, patch);
    const wasmBytes = await loadWasmBytes();
    const workletHash = workletUrl.href;
    const registered = registeredWorklets.get(context);
    if (registered && registered.hash !== workletHash) throw new Error('This AudioContext already uses a different Teia worklet version.');
    if (!registered) {
      const ready = context.audioWorklet.addModule(workletUrl.href);
      registeredWorklets.set(context, { hash: workletHash, ready });
      try { await ready; }
      catch (error) { registeredWorklets.delete(context); throw error; }
    } else {
      await registered.ready;
    }
    const node = new AudioWorkletNode(context, 'teia-wasm-engine', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { wasmBytes },
    });
    try {
      await waitForReady(node);
      node.port.postMessage({ type: 'dspProgram', payload: program });
      for (const sample of preparedSamples) node.port.postMessage(
        { type: 'sampleData', payload: sample },
        sample.data ? [sample.data.buffer] : [],
      );
      for (const image of preparedImages) node.port.postMessage({ type: 'imageData', payload: image }, [image.data.buffer]);
      node.port.postMessage({ type: 'restoreBuffers', payload: { buffers: preparedBuffers } });
      await waitForPackageReady(node);
      return new PatchPlayer(context, node, manifest, [...program.values]);
    } catch (error) {
      node.disconnect();
      node.port.close();
      throw error;
    }
  }

  connect(destination: AudioNode): void { this.ensureOpen(); this.node.connect(destination); }
  disconnect(): void { this.node.disconnect(); }

  setParameter(id: string, value: number): void {
    this.ensureOpen();
    const parameter = this.parameters.find((entry) => entry.id === id) ?? this.parameters.find((entry) => entry.persistentId === id);
    if (!parameter) throw new Error(`Unknown parameter: ${id}`);
    if (!Number.isFinite(value)) throw new Error('Parameter value must be finite.');
    const bounded = Math.min(parameter.max ?? Infinity, Math.max(parameter.min ?? -Infinity, value));
    this.values[parameter.valueIndex] = bounded;
    this.node.port.postMessage({ type: 'externalParameter', payload: { valueIndex: parameter.valueIndex, value: bounded } });
  }

  getParameter(id: string): number {
    const parameter = this.parameters.find((entry) => entry.id === id) ?? this.parameters.find((entry) => entry.persistentId === id);
    if (!parameter) throw new Error(`Unknown parameter: ${id}`);
    return this.values[parameter.valueIndex];
  }

  noteOn(note: number, velocity = 1, channel = 1): void {
    this.ensureOpen();
    this.node.port.postMessage({ type: 'noteOn', payload: { note, velocity, channel } });
  }

  noteOff(note: number, channel = 1): void {
    this.ensureOpen();
    this.node.port.postMessage({ type: 'noteOff', payload: { note, velocity: 0, channel } });
  }

  midiCc(cc: number, value: number, channel = 1): void {
    this.ensureOpen();
    this.node.port.postMessage({ type: 'midiCc', payload: { cc, value, channel } });
  }

  reset(): void { this.ensureOpen(); this.node.port.postMessage({ type: 'panic' }); }
  setMuted(muted: boolean): void { this.ensureOpen(); this.node.port.postMessage({ type: 'setMuted', payload: { muted } }); }
  dispose(): void { if (this.disposed) return; this.reset(); this.node.disconnect(); this.node.port.close(); this.disposed = true; }
  get sampleRate(): number { return this.context.sampleRate; }
  private ensureOpen(): void { if (this.disposed) throw new Error('Patch player has been disposed.'); }
}

function readJson<T>(files: Map<string, Uint8Array<ArrayBuffer>>, path: string): T {
  return JSON.parse(new TextDecoder().decode(requiredFile(files, path))) as T;
}

async function loadWasmBytes(): Promise<ArrayBuffer> {
  if (!wasmBytesPromise) {
    wasmBytesPromise = (async () => {
      try {
        const response = await fetch(simdWasmUrl);
        if (response.ok) {
          const bytes = await response.arrayBuffer();
          if (WebAssembly.validate(bytes)) return bytes;
        }
      } catch { /* Use the ordinary module on older hosts or missing assets. */ }
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`Could not load runtime WASM (${response.status}).`);
      return response.arrayBuffer();
    })().catch((error) => {
      wasmBytesPromise = undefined;
      throw error;
    });
  }
  return wasmBytesPromise;
}

function requiredFile(files: Map<string, Uint8Array<ArrayBuffer>>, path: string): Uint8Array<ArrayBuffer> {
  const file = files.get(path);
  if (!file) throw new Error(`Patch package is missing ${path}.`);
  return file;
}

async function verifyAssets(files: Map<string, Uint8Array<ArrayBuffer>>, manifest: Manifest): Promise<void> {
  for (const asset of manifest.assets) {
    const bytes = requiredFile(files, asset.path);
    if (bytes.byteLength !== asset.bytes) throw new Error(`Asset size mismatch: ${asset.path}`);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (hash !== asset.sha256) throw new Error(`Asset hash mismatch: ${asset.path}`);
  }
}

async function prepareSamples(context: BaseAudioContext, files: Map<string, Uint8Array<ArrayBuffer>>, program: Program) {
  const decoded = new Map<string, AudioBuffer>();
  const uploaded = new Set<string>();
  const prepared: Array<{ nodeId: string; data?: Float32Array<ArrayBuffer>; sampleRate: number; name: string; storageKey: string }> = [];
  for (const binding of program.sampleBindings ?? []) {
    const path = binding.sample.url;
    if (!path) continue;
    let buffer = decoded.get(path);
    if (!buffer) {
      const file = requiredFile(files, path);
      buffer = await context.decodeAudioData(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
      decoded.set(path, buffer);
    }
    let data: Float32Array<ArrayBuffer> | undefined;
    if (!uploaded.has(path)) {
      data = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const source = buffer.getChannelData(channel);
        for (let index = 0; index < data.length; index++) data[index] += source[index] / buffer.numberOfChannels;
      }
      uploaded.add(path);
    }
    prepared.push({ nodeId: binding.nodeId, ...(data ? { data } : {}), sampleRate: buffer.sampleRate, name: binding.sample.name, storageKey: path });
  }
  return prepared;
}

async function prepareImages(files: Map<string, Uint8Array<ArrayBuffer>>, program: Program) {
  const prepared: Array<{ nodeId: string; data: Uint8Array<ArrayBuffer>; width: number; height: number; name: string }> = [];
  for (const binding of program.imageBindings ?? []) {
    const path = binding.image.url;
    if (!path) continue;
    const bitmap = await createImageBitmap(new Blob([requiredFile(files, path)]));
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas: OffscreenCanvas | HTMLCanvasElement = typeof OffscreenCanvas === 'undefined'
      ? document.createElement('canvas')
      : new OffscreenCanvas(width, height);
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) { bitmap.close(); throw new Error(`Could not decode image ${path}.`); }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const pixels = context.getImageData(0, 0, width, height).data;
    const data = new Uint8Array(pixels.length);
    data.set(pixels);
    prepared.push({ nodeId: binding.nodeId, data, width, height, name: binding.image.name });
  }
  return prepared;
}

function prepareBuffers(files: Map<string, Uint8Array<ArrayBuffer>>, patch: Patch) {
  const references: NonNullable<Patch['buffers']> = {};
  const visit = (source: Patch, prefix: string) => {
    for (const [id, asset] of Object.entries(source.buffers ?? {})) references[`${prefix}${id}`] = asset;
    for (const node of source.nodes ?? []) if (node.type === 'Group' && node.subpatch) visit(node.subpatch, `${prefix}${node.id}__`);
  };
  visit(patch, '');
  return Object.entries(references).map(([nodeId, asset]) => {
    const path = `assets/buffers/${asset.hash}.f32`;
    const file = requiredFile(files, path);
    if (file.byteLength !== asset.sampleCount * 4) throw new Error(`Invalid Buffer data: ${path}`);
    const samples = new Float32Array(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength));
    return { nodeId, sampleRate: asset.sampleRate, samples };
  });
}

function waitForReady(node: AudioWorkletNode): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Audio engine did not become ready.')), 15_000);
    node.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== 'backendStatus') return;
      clearTimeout(timeout);
      if (event.data.payload?.ready) resolve();
      else reject(new Error(event.data.payload?.error || 'Audio engine failed to load.'));
    };
  });
}

function waitForPackageReady(node: AudioWorkletNode): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Patch program did not become ready.')), 15_000);
    node.port.onmessage = (event: MessageEvent) => {
      if (event.data?.type !== 'packageReady') return;
      clearTimeout(timeout);
      resolve();
    };
    node.port.postMessage({ type: 'packageReady' });
  });
}
