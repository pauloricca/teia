import { ParameterOverrides } from './parameters';
import type { HostBridge, HostCommand, HostEvent, HostReply } from './bridge';
/** Host-neutral conformance double. No DSP or independent clock. Explicitly flush
 * preparation/installation and Save to model IPC races and acknowledgements. */
export class MockHostBridge implements HostBridge {
  readonly commands: HostCommand[] = [];
  installed: HostCommand | null = null;
  readonly parameters = new ParameterOverrides();
  liveValues: number[] = [];
  private generation: string | null = null;
  private listeners = new Set<(event: HostEvent) => void>();
  private pending = new Map<string, { command: HostCommand; resolve: (reply: HostReply) => void }>();
  private latest = new Map<string, number>();
  subscribe(listener: (event: HostEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  request(command: HostCommand): Promise<HostReply> {
    this.commands.push(structuredClone(command));
    if (command.type === 'apply' || command.type === 'revision') this.latest.set(command.sessionId, Math.max(command.revision, this.latest.get(command.sessionId) ?? -1));
    return new Promise(resolve => { this.pending.set(command.requestId, { command: structuredClone(command), resolve }); });
  }
  reply(requestId: string, status: HostReply['status'], diagnostics?: HostReply['diagnostics'], payload?: Pick<HostReply, 'capturedDocument' | 'bufferSnapshot'>): void {
    const pending = this.pending.get(requestId);
    if (!pending) throw new Error(`Unknown request ${requestId}.`);
    const command = pending.command;
    if (status === 'installed') {
      if (command.type !== 'apply' || !command.prepared || command.prepared.diagnostics.some(d => d.severity === 'error') || this.latest.get(command.sessionId) !== command.revision) status = 'cancelled';
      else {
        this.installed = command;
        this.generation = `mock:${command.revision}`;
        this.liveValues = [...command.prepared.program.values];
        for (const update of this.parameters.bind(command.prepared)) this.liveValues[update.valueIndex] = update.value;
      }
    }
    if (status === 'updated' && command.type === 'parameter') {
      if (command.generation !== this.generation || this.installed?.type !== 'apply' || !this.installed.prepared) status = 'failed';
      else {
        try { this.parameters.set(this.installed.prepared, command.parameterId, command.value); for (const update of this.parameters.bind(this.installed.prepared)) this.liveValues[update.valueIndex] = update.value; } catch { status = 'failed'; }
      }
    }
    const reply = { ...payload, requestId, sessionId: command.sessionId, revision: command.revision, generation: status === 'installed' ? `mock:${command.revision}` : command.generation, status, ...(diagnostics ? { diagnostics } : {}) };
    pending.resolve(reply);
    this.pending.delete(requestId);
  }
  emit(event: HostEvent): void { for (const listener of this.listeners) listener(structuredClone(event)); }
  dispose(): void { for (const [id] of this.pending) this.reply(id, 'cancelled'); this.listeners.clear(); }
}
