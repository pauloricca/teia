import type { Patch, SampleAsset, ImageAsset } from '../graph/types';
import { patchToJson } from '../graph/serialize';
import { readDocument, withParameterIds, type Diagnostic } from './document';
import { classifyEdit, preparePatch, type PreparedPatch } from './compiler';
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
  feedback?: Extract<HostEvent, { type: 'feedback' }>;
}
/** One controller per editor session. Source, saved baseline and installed artifact
 * are independent. A failed compile never replaces either source or running graph. */
export class HostedSession {
  private document: Patch;
  private saved: string;
  private sequence = 0;
  private epoch = 0;
  private disposed = false;
  private installed?: PreparedPatch;
  private pending = new Map<string, { revision: number; prepared?: PreparedPatch }>();
  private listeners = new Set<() => void>();
  private unsubscribe: () => void;
  private lastFeedback = -Infinity;
  private state: SessionState;
  constructor(readonly sessionId: string, initial: Patch, readonly capabilities: Capabilities, readonly bridge: HostBridge, generation: string | null = null) {
    const read = readDocument(initial);
    if (!read.patch || read.diagnostics.some(d => d.severity === 'error' || d.code === 'discarded-content')) throw new Error('Initial hosted document is invalid.');
    this.document = withParameterIds(read.patch);
    this.saved = patchToJson(this.document);
    this.state = { revision: 0, savedRevision: 0, installedRevision: generation === null ? null : 0, generation, dirty: false, connected: true, applying: false, diagnostics: read.diagnostics };
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
    this.lastFeedback = -Infinity;
    this.installed = pending.prepared;
    for (const [id, application] of this.pending) if (application.revision <= context.revision) this.pending.delete(id);
    this.publish({ generation: context.generation, installedRevision: context.revision, applying: context.revision === this.state.revision ? false : this.state.applying, feedback: undefined });
  }
  private receive(event: HostEvent) {
    if (this.disposed || event.sessionId !== this.sessionId) return;
    if (event.type === 'connection') {
      this.epoch++;
      this.pending.clear();
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
    this.publish({ feedback: structuredClone(event) });
  }
  async save(saveAs = false): Promise<boolean> {
    if (!this.capabilities.save || (saveAs && !this.capabilities.saveAs) || !this.state.connected || this.disposed) return false;
    const document = this.getDocument();
    const validation = readDocument(document);
    const errors = [...validation.diagnostics, ...(this.capabilities.requireExecutableToSave ? preparePatch(document, { profile: this.capabilities.profile }).diagnostics : [])].filter(d => d.severity === 'error');
    this.publish({ saveDiagnostics: errors });
    if (errors.length) { this.publish({ diagnostics: errors }); return false; }
    const command: HostCommand = { ...this.context(), type: 'save', saveAs, document };
    const snapshot = patchToJson(document);
    const epoch = this.epoch;
    try {
      const reply = await this.bridge.request(command);
      if (epoch !== this.epoch || this.disposed || !this.matching(command, reply)) return false;
      if (reply.status === 'failed') {
        const diagnostics = reply.diagnostics?.slice(0, 128) ?? [];
        this.publish({ diagnostics, saveDiagnostics: diagnostics });
        return false;
      }
      if (reply.status !== 'saved' || command.revision < this.state.savedRevision) return false;
      this.saved = snapshot;
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
    this.publish({ connected: true, generation: reply.generation, installedRevision: null, feedback: undefined });
    // Force working revision through the host's supersession gate.
    const document = this.getDocument();
    await this.edit(document, true);
    return true;
  }
  /** An instance override; never changes working document defaults. */
  async setParameter(parameterId: string, value: number): Promise<boolean> {
    if (!Number.isFinite(value) || !parameterId || !this.state.connected || this.state.generation === null || this.disposed) return false;
    const command: HostCommand = { ...this.context(), type: 'parameter', parameterId, value };
    const epoch = this.epoch;
    try {
      const reply = await this.bridge.request(command);
      return epoch === this.epoch && !this.disposed && this.matching(command, reply) && reply.status === 'updated' && reply.generation === command.generation && this.state.generation === command.generation;
    } catch { return false; }
  }
  async selectMedia(request: { kind: 'sample' | 'image'; nodeId: string; current?: SampleAsset | ImageAsset }): Promise<SampleAsset | ImageAsset | null> {
    const select = this.bridge.assets?.selectMedia;
    if (!select || !this.state.connected || this.disposed) { this.reportUnavailable('Media selection requires a supplied host asset adapter.'); return null; }
    const context = this.context(); const epoch = this.epoch;
    const asset = await select({ ...context, ...request });
    if (this.disposed || epoch !== this.epoch || context.revision !== this.state.revision) return null;
    return asset;
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
  reportUnavailable(message: string): void { this.publish({ diagnostics: [{ severity: 'warning', code: 'host-adapter-required', message }] }); }
  async toggleTransport(): Promise<void> { if (this.capabilities.transport && this.state.connected) await this.bridge.request({ ...this.context(), type: 'transport', action: 'toggle' }); }
  requestFeedback(scopes: Extract<HostCommand, { type: 'feedback' }>['scopes']): void {
    if (this.capabilities.feedback?.length && this.state.connected) void this.bridge.request({ ...this.context(), type: 'feedback', scopes: scopes.slice(0, 32).map(s => ({ ...s, length: Number.isFinite(s.length) ? Math.max(0.0001, Math.min(30, s.length)) : 0.08, points: Number.isFinite(s.points) ? Math.max(1, Math.min(1024, Math.floor(s.points!))) : 256 })) }).catch(() => undefined);
  }
  dispose(): void { this.disposed = true; this.epoch++; this.unsubscribe(); this.listeners.clear(); this.pending.clear(); }
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
