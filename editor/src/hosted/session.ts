import type { Patch, SampleAsset, ImageAsset } from '../graph/types';
import { patchToJson } from '../graph/serialize';
import { readDocument, withParameterIds, type Diagnostic } from './document';
import { classifyEdit, preparePatch, type PreparedPatch, type ParameterMetadata } from './compiler';
import { normalizeParameterValue } from './parameters';
import type { Capabilities, Context, HostBridge, HostCommand, HostEvent, HostReply } from './bridge';

export interface SessionState {
  revision: number;
  savedRevision: number;
  installedRevision: number | null;
  generation: string | null;
  dirty: boolean;
  connected: boolean;
  applying: boolean;
  diagnostics: Diagnostic[];
  saveDiagnostics?: Diagnostic[];
  parameters: ParameterMetadata[];
  parameterValues: Record<string, number>;
  feedback?: Extract<HostEvent, { type: 'feedback' }>;
}
/** One controller per editor session. Source, saved baseline and installed artifact
 * are independent. A failed compile never replaces either source or running graph. */
export class HostedSession {
  private document: Patch;
  private saved: string;
  private sequence = 0;
  private gestureSequence = 0;
  private gestureValues = new Map<string, Record<string, number>>();
  private epoch = 0;
  private disposed = false;
  private installed?: PreparedPatch;
  private pending = new Map<string, { revision: number; prepared?: PreparedPatch }>();
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private lastFeedback = -Infinity;
  private parameterWrites = new Map<string, string>();
  private state: SessionState;
  constructor(readonly sessionId: string, initial: Patch, readonly capabilities: Capabilities, readonly bridge: HostBridge, generation: string | null = null) {
    const read = readDocument(initial);
    if (!read.patch || read.diagnostics.some(d => d.severity === 'error' || d.code === 'discarded-content')) throw new Error('Initial hosted document is invalid.');
    this.document = withParameterIds(read.patch);
    this.saved = patchToJson(this.document);
    this.state = { revision: 0, savedRevision: 0, installedRevision: generation === null ? null : 0, generation, dirty: false, connected: true, applying: false, diagnostics: read.diagnostics, parameters: [], parameterValues: {} };
    if (generation !== null) {
      const prepared = preparePatch(this.document, { profile: capabilities.profile });
      if ('program' in prepared && !prepared.diagnostics.some(d => d.severity === 'error')) this.installed = prepared;
    }
    this.state.parameters = this.installed?.parameters ?? [];
    this.unsubscribe = bridge.subscribe(event => this.receive(event));
  }
  getSnapshot = (): SessionState => this.state;
  getDocument = (): Patch => structuredClone(this.document);
  getParameterLabel(id: string): string {
    const find = (patch: Patch): string | undefined => {
      for (const node of patch.nodes) {
        const port = node.outputs?.find(p => p.parameterId === id);
        if (node.type === 'Params' && port) return port.name;
        if (node.subpatch) { const label = find(node.subpatch); if (label) return label; }
      }
      return undefined;
    };
    return find(this.document) ?? id;
  }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(update: Partial<SessionState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...update };
    for (const listener of this.listeners) listener();
  }
  private context(): Context { return { requestId: `${this.sessionId}:${++this.sequence}`, sessionId: this.sessionId, revision: this.state.revision, generation: this.state.generation }; }
  private matching(command: Context, reply: HostReply): boolean { return reply.requestId === command.requestId && reply.sessionId === command.sessionId && reply.revision === command.revision; }
  async edit(document: Patch, force = false): Promise<void> {
    if (this.disposed) return;
    const editable = withParameterIds(document);
    if (!force && patchToJson(editable) === patchToJson(this.document)) return;
    this.document = structuredClone(editable);
    const revision = this.state.revision + 1;
    this.publish({ revision, dirty: patchToJson(editable) !== this.saved, applying: this.state.connected });
    // Announce BEFORE compilation so the host can supersede older preparation.
    if (this.state.connected) {
      try { void this.bridge.request({ ...this.context(), type: 'revision' }).catch(() => undefined); } catch { /* Apply below reports transport failure. */ }
    }
    const result = preparePatch(editable, { profile: this.capabilities.profile });
    const prepared = 'program' in result ? result : undefined;
    const valid = prepared && !prepared.diagnostics.some(d => d.severity === 'error');
    this.publish({ revision, dirty: patchToJson(editable) !== this.saved, diagnostics: result.diagnostics, applying: this.state.connected });
    if (!this.state.connected) return;
    // Even invalid revisions are announced: they supersede older pending installs.
    let change = valid && this.installed ? classifyEdit(this.installed, prepared) : { kind: 'prepare' as const, reason: valid ? 'Initial apply.' : 'Invalid working revision; preserve installed graph.' };
    if (change.kind === 'specialized' && ((change.customWaves && !this.capabilities.specializedControls?.includes('custom wave')) || (change.sequencers && !this.capabilities.specializedControls?.includes('sequencer')))) change = { kind: 'prepare', reason: 'Host does not advertise the specialized control update.' };
    const command: HostCommand = { ...this.context(), type: 'apply' , document: this.getDocument(), ...(valid ? { prepared } : {}),
      change };
    this.pending.set(command.requestId, { revision, ...(valid ? { prepared } : {}) });
    const epoch = this.epoch;
    try {
      const reply = await this.bridge.request(command);
      if (epoch !== this.epoch || !this.matching(command, reply)) return;
      if (reply.status === 'installed') this.acceptInstall(reply);
      else if (reply.status !== 'queued') {
        this.pending.delete(command.requestId);
        if (revision === this.state.revision) this.publish({ applying: false, ...(reply.status === 'failed' ? { diagnostics: [...result.diagnostics, ...(reply.diagnostics ?? [])] } : {}) });
      }
    } catch (error) {
      this.pending.delete(command.requestId);
      if (epoch === this.epoch && revision === this.state.revision) this.publish({ applying: false, diagnostics: [{ severity: 'error', code: 'bridge-apply', message: String(error) }] });
    }
  }
  private acceptInstall(context: Context) {
    const pending = this.pending.get(context.requestId);
    // A newer draft can fail while an earlier, already installed graph's ack is
    // still in transit. Track installation independently, but never roll back
    // after a newer installed revision has been confirmed.
    if (!pending?.prepared || context.revision !== pending.revision || context.generation === null || context.revision <= (this.state.installedRevision ?? -1)) return;
    // Host MUST release old gestures atomically with graph retirement; an IPC
    // cleanup against the old generation is supplementary, never authoritative.
    this.releaseGestures('graph swap');
    this.lastFeedback = -Infinity;
    this.installed = pending.prepared;
    this.parameterWrites.clear();
    const parameterValues: Record<string, number> = {};
    for (const parameter of this.installed.parameters) {
      const value = this.state.parameterValues[parameter.id];
      if (value !== undefined) parameterValues[parameter.id] = normalizeParameterValue(parameter, value);
    }
    for (const [id, application] of this.pending) if (application.revision <= context.revision) this.pending.delete(id);
    this.publish({ parameters: this.installed.parameters, parameterValues, generation: context.generation, installedRevision: context.revision, applying: context.revision === this.state.revision ? false : this.state.applying, feedback: undefined });
  }
  private receive(event: HostEvent) {
    if (this.disposed || event.sessionId !== this.sessionId) return;
    if (event.type === 'connection') {
      this.epoch++;
      this.pending.clear();
      this.gestureValues.clear();
      this.parameterWrites.clear();
      this.publish({ connected: event.connected, applying: false, feedback: undefined });
      return;
    }
    if (!this.state.connected) return;
    if (event.type === 'installed') { this.acceptInstall(event); return; }
    if (event.type === 'diagnostics') {
      if (event.revision === this.state.revision) this.publish({ diagnostics: event.diagnostics.slice(0, 128), applying: false });
      return;
    }
    if (event.generation !== this.state.generation || event.revision !== this.state.installedRevision) return;
    const now = performance.now();
    const hz = Math.max(1, Math.min(60, Number.isFinite(this.capabilities.maxFeedbackHz) ? this.capabilities.maxFeedbackHz! : 30));
    if (now - this.lastFeedback < 1000 / hz || !boundedFeedback(event)) return;
    this.lastFeedback = now;
    const allowed = this.capabilities.feedback ?? [];
    const parameterValues = { ...this.state.parameterValues };
    if (allowed.includes('parameters') && event.parameters) {
      for (const parameter of this.state.parameters) {
        const value = event.parameters[parameter.id];
        if (Number.isFinite(value) && !this.parameterWrites.has(parameter.id)) parameterValues[parameter.id] = normalizeParameterValue(parameter, value);
      }
    }
    this.publish({ parameterValues, feedback: structuredClone({ ...event,
      meters: allowed.includes('meters') ? event.meters : undefined,
      scopes: allowed.includes('scopes') ? event.scopes : undefined,
      playheads: allowed.includes('playheads') ? event.playheads : undefined,
      buffers: allowed.includes('buffers') ? event.buffers : undefined,
      parameters: allowed.includes('parameters') ? event.parameters : undefined,
    }) });
  }
  async save(saveAs = false): Promise<boolean> {
    if (!this.capabilities.save || (saveAs && !this.capabilities.saveAs) || !this.state.connected || this.disposed) return false;
    let document = this.getDocument();
    const validation = readDocument(document);
    const errors = [...validation.diagnostics, ...(this.capabilities.requireExecutableToSave ? preparePatch(document, { profile: this.capabilities.profile }).diagnostics : [])].filter(d => d.severity === 'error');
    this.publish({ saveDiagnostics: errors });
    if (errors.length) { this.publish({ diagnostics: errors }); return false; }
    const context = this.context();
    const epoch = this.epoch;
    try {
      if (this.capabilities.bridgeVersion === 2 && this.capabilities.bufferCapture === 1) {
        const capture: HostCommand = { ...context, type: 'capture save', version: 1, document, installedRevision: this.state.installedRevision };
        const reply = await this.bridge.request(capture);
        if (epoch !== this.epoch || this.disposed || !this.matching(capture, reply) || reply.generation !== context.generation || this.state.generation !== context.generation || reply.status !== 'captured' || !reply.capturedDocument) throw new Error('Host Buffer capture did not complete.');
        const captured = readDocument(reply.capturedDocument);
        if (!captured.patch || captured.diagnostics.some(d => d.severity === 'error' || d.code === 'discarded-content') || withoutBuffers(captured.patch) !== withoutBuffers(document)) throw new Error(`Capture must return the exact document with only durable Buffer references changed. ${JSON.stringify(captured.diagnostics)}`);
        document = mergeCapturedBuffers(document, captured.patch);
      }
      const command: HostCommand = { ...context, requestId: `${context.requestId}:persist`, type: 'save', saveAs, document };
      const snapshot = patchToJson(document);
      const reply = await this.bridge.request(command);
      if (epoch !== this.epoch || this.disposed || !this.matching(command, reply)) return false;
      if (reply.status === 'failed') {
        const diagnostics = reply.diagnostics?.slice(0, 128) ?? [];
        this.publish({ diagnostics, saveDiagnostics: diagnostics });
        return false;
      }
      if (reply.status !== 'saved' || command.revision < this.state.savedRevision) return false;
      this.saved = snapshot;
      if (this.state.revision === command.revision) this.document = structuredClone(document);
      this.publish({ savedRevision: command.revision, dirty: patchToJson(this.document) !== snapshot });
      return true;
    } catch (error) {
      if (epoch === this.epoch) {
        const diagnostics: Diagnostic[] = [{ severity: 'error', code: 'bridge-save', message: String(error) }];
        this.publish({ diagnostics, saveDiagnostics: diagnostics });
      }
      return false;
    }
  }
  async close(): Promise<boolean> {
    this.releaseGestures('close');
    const command: HostCommand = { ...this.context(), type: 'close', dirty: this.state.dirty, document: this.getDocument() };
    const epoch = this.epoch;
    const reply = await this.bridge.request(command);
    return epoch === this.epoch && this.matching(command, reply) && reply.status === 'closed' && command.revision === this.state.revision;
  }
  async resync(): Promise<boolean> {
    const command: HostCommand = { ...this.context(), type: 'resync' };
    const epoch = this.epoch;
    const reply = await this.bridge.request(command);
    if (epoch !== this.epoch || this.disposed || !this.matching(command, reply) || reply.status !== 'connected') return false;
    this.installed = undefined;
    this.parameterWrites.clear();
    this.publish({ connected: true, generation: reply.generation, installedRevision: null, feedback: undefined, parameters: [], parameterValues: {} });
    // Force working revision through the host's supersession gate.
    const document = this.getDocument();
    await this.edit(document, true);
    return true;
  }
  /** An instance override; never changes working document defaults. */
  async setParameter(parameterId: string, value: number): Promise<boolean> {
    const parameter = this.state.parameters.find(p => p.id === parameterId);
    if (!parameter || !Number.isFinite(value) || !this.state.connected || this.state.generation === null || this.disposed) return false;
    const normalized = normalizeParameterValue(parameter, value);
    const command: HostCommand = { ...this.context(), type: 'parameter', parameterId, value: normalized };
    const epoch = this.epoch;
    this.parameterWrites.set(parameterId, command.requestId);
    let accepted = false;
    try {
      const reply = await this.bridge.request(command);
      accepted = epoch === this.epoch && !this.disposed && this.matching(command, reply) && reply.status === 'updated' && reply.generation === command.generation && this.state.generation === command.generation;
      if (accepted && this.parameterWrites.get(parameterId) === command.requestId) {
        this.publish({ parameterValues: { ...this.state.parameterValues, [parameterId]: normalized } });
      }
      return accepted;
    } catch { return false; }
    finally {
      if (this.parameterWrites.get(parameterId) === command.requestId) this.parameterWrites.delete(parameterId);
    }
  }

  async selectMedia(request: { kind: 'sample' | 'image'; nodeId: string; current?: SampleAsset | ImageAsset }): Promise<SampleAsset | ImageAsset | null> {
    const select = this.bridge.assets?.selectMedia;
    if (!select || !this.state.connected || this.disposed) { this.reportUnavailable('Media selection requires a supplied host asset adapter.'); return null; }
    const context = this.context(); const epoch = this.epoch;
    const asset = await select({ ...context, ...request });
    if (this.disposed || epoch !== this.epoch || context.revision !== this.state.revision) return null;
    return asset;
  }
  async captureBuffer(nodeId: string): Promise<import('../audio/useAudioEngine').BufferSnapshot | null> {
    if (this.capabilities.bridgeVersion !== 2 || !this.capabilities.bufferCapture || !this.state.connected || !this.state.generation || this.disposed) { this.reportUnavailable('Buffer capture requires bridge v2 and a host capture adapter.'); return null; }
    const command: HostCommand = { ...this.context(), type: 'capture buffer', version: 1, nodeId };
    const epoch = this.epoch;
    try {
      const reply = await this.bridge.request(command);
      const snapshot = reply.bufferSnapshot;
      if (epoch !== this.epoch || this.disposed || !this.matching(command, reply) || reply.generation !== command.generation || this.state.generation !== command.generation || reply.status !== 'captured' || !snapshot || !(snapshot.samples instanceof Float32Array) || snapshot.samples.length < 2 || snapshot.samples.length > 960000 || !Number.isFinite(snapshot.sampleRate) || snapshot.sampleRate <= 0 || !snapshot.samples.every(Number.isFinite)) return null;
      return snapshot;
    } catch { return null; }
  }
  async restoreBuffer(nodeId: string, snapshot: import('../audio/useAudioEngine').BufferSnapshot): Promise<boolean> {
    if (this.capabilities.bridgeVersion !== 2 || !this.capabilities.bufferCapture || !this.capabilities.bufferMutation || !this.state.connected || !this.state.generation || this.disposed || snapshot.samples.length < 2 || snapshot.samples.length > 960000 || !snapshot.samples.every(Number.isFinite) || !Number.isFinite(snapshot.sampleRate) || snapshot.sampleRate <= 0) return false;
    const command: HostCommand = { ...this.context(), type: 'restore buffer', version: 1, nodeId, snapshot };
    const epoch = this.epoch;
    try {
      const reply = await this.bridge.request(command);
      return epoch === this.epoch && !this.disposed && this.matching(command, reply) && reply.status === 'updated' && reply.generation === command.generation && this.state.generation === command.generation;
    } catch { return false; }
  }
  async mutateBuffer(action: 'clear' | 'copy', nodeId: string, targetNodeId?: string): Promise<boolean> {
    if (!this.capabilities.bufferMutation || !this.state.connected || !this.state.generation || this.disposed) {
      this.reportUnavailable('Buffer mutation requires a supplied host capability.'); return false;
    }
    const command: HostCommand = { ...this.context(), type: 'buffer', action, nodeId, ...(targetNodeId ? { targetNodeId } : {}) };
    const epoch = this.epoch;
    try {
      const reply = await this.bridge.request(command);
      return epoch === this.epoch && !this.disposed && this.matching(command, reply) && reply.status === 'updated' && reply.generation === command.generation && this.state.generation === command.generation;
    } catch { return false; }
  }
  /** Ordered transient controls bypass document edits and graph supersession.
   * Host validates bindings against layout, schedules in sequence order, and
   * acknowledges updated only after acceptance in its bounded render queue.
   * Queue overflow must cancel/release the generation, never discard a release.
   */
  gesture(nodeId: string, values: Record<string, number>): void {
    if (!this.capabilities.gestures || this.capabilities.bridgeVersion !== 2) return;
    if (!this.state.connected || !this.state.generation || !this.installed || this.disposed) { this.reportUnavailable('Gestures require an installed, connected host graph.'); return; }
    if (!Object.values(values).every(Number.isFinite)) return;
    const previous = this.gestureValues.get(nodeId) ?? {};
    if ('clicks' in values) values = { ...values, clicks: (previous.clicks ?? 0) + 1 };
    this.gestureValues.set(nodeId, { ...previous, ...values });
    const command: HostCommand = { ...this.context(), type: 'gesture', version: 1, sequence: ++this.gestureSequence, layout: this.installed.layout, nodeId, values, timestamp: performance.now() };
    const epoch = this.epoch;
    void this.bridge.request(command).then(reply => {
      if (epoch !== this.epoch || this.disposed || this.state.generation !== command.generation) return;
      if (!this.matching(command, reply) || reply.generation !== command.generation || reply.status !== 'updated') {
        this.releaseGestures('focus loss'); this.reportUnavailable('Host rejected a transient gesture; held controls were cancelled.');
      }
    }).catch(() => { if (epoch === this.epoch && !this.disposed) { this.releaseGestures('focus loss'); this.reportUnavailable('Gesture transport failed; host must release controls on disconnect.'); } });
  }
  releaseGestures(reason: 'focus loss' | 'close' | 'dispose' | 'graph swap'): void {
    this.gestureValues.clear();
    if (this.capabilities.bridgeVersion !== 2 || !this.capabilities.gestures || !this.state.connected || !this.state.generation || this.disposed) return;
    try { void this.bridge.request({ ...this.context(), type: 'release gestures', version: 1, sequence: ++this.gestureSequence, reason }).catch(() => undefined); } catch { /* Host owns disconnect fencing. */ }
  }
  reportUnavailable(message: string): void { this.publish({ diagnostics: [{ severity: 'warning', code: 'host-adapter-required', message }] }); }
  async toggleTransport(): Promise<void> { if (this.capabilities.transport && this.state.connected) await this.bridge.request({ ...this.context(), type: 'transport', action: 'toggle' }); }
  requestFeedback(scopes: Extract<HostCommand, { type: 'feedback' }>['scopes']): void {
    if (this.capabilities.feedback?.length && this.state.connected) void this.bridge.request({ ...this.context(), type: 'feedback', scopes: scopes.slice(0, 32).map(s => ({ ...s, length: Number.isFinite(s.length) ? Math.max(0.0001, Math.min(30, s.length)) : 0.08, points: Number.isFinite(s.points) ? Math.max(1, Math.min(1024, Math.floor(s.points!))) : 256 })) }).catch(() => undefined);
  }
  dispose(): void { this.releaseGestures('dispose'); this.disposed = true; this.epoch++; this.unsubscribe(); this.listeners.clear(); this.pending.clear(); this.parameterWrites.clear(); }
}
function boundedFeedback(event: Extract<HostEvent, { type: 'feedback' }>): boolean {
  for (const map of [event.meters, event.scopes, event.playheads, event.buffers, event.parameters]) if (map && Object.keys(map).length > 128) return false;
  if (event.tempo && (![event.tempo.bpm, event.tempo.beat, event.tempo.renderFrame].every(Number.isFinite) || event.tempo.bpm <= 0 || typeof event.tempo.running !== 'boolean')) return false;
  if (Object.values(event.parameters ?? {}).some(value => !Number.isFinite(value))) return false;
  if (Object.values(event.scopes ?? {}).some(s => s.samples.length > 1024)) return false;
  if (Object.values(event.playheads ?? {}).some(s => s.length > 128)) return false;
  if (Object.values(event.buffers ?? {}).some(s => s.bins.length > 1024)) return false;
  return true;
}

function withoutBuffers(patch: Patch): string {
  const copy = structuredClone(patch);
  const strip = (p: Patch) => { delete p.buffers; for (const node of p.nodes) if (node.subpatch) strip(node.subpatch); };
  strip(copy);
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)])) : value;
  return JSON.stringify(canonical(JSON.parse(patchToJson(copy))));
}

function mergeCapturedBuffers(source: Patch, captured: Patch): Patch {
  const copy = structuredClone(source);
  if (captured.buffers) copy.buffers = structuredClone(captured.buffers); else delete copy.buffers;
  for (const node of copy.nodes) if (node.subpatch) {
    const matched = captured.nodes.find(n => n.id === node.id)?.subpatch;
    if (matched) node.subpatch = mergeCapturedBuffers(node.subpatch, matched);
  }
  return copy;
}
