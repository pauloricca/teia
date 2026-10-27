import type { Patch, PatchNode } from '../graph/types';
import { DSP_OP } from './dspOpcodes';
import type { DspOp } from './dspProgram';

export type DspDependencyKind = 'cable' | 'send receive' | 'repeat boundary' | 'resource order' | 'event order';

export interface DspScheduleDependency {
  from: string;
  to: string;
  kind: DspDependencyKind;
}

export interface DspScheduleRegion {
  id: number;
  nodes: string[];
  dependencies: number[];
  cyclic: boolean;
  eligibility: 'block candidate' | 'scalar';
  reasons: string[];
}

export interface DspScheduleReport {
  rendering: 'scalar';
  expandedNodeCount: number;
  operationCount: number;
  operationFallbacks: Record<string, number>;
  dependencies: DspScheduleDependency[];
  feedbackBoundaries: string[];
  regions: DspScheduleRegion[];
  order: number[];
}

const OPCODE_NAMES = new Map<number, string>(Object.entries(DSP_OP).map(([name, code]) => [code, name]));
// Stage 5A only identifies simple candidates. Actual block kernels and their
// timing/state audit belong to 5B; no region is executed from this report.
const CANDIDATE_NODES = new Set([
  'Constant', 'Params', 'Pass', 'Multiply', 'Abs', 'Map', 'Clamp',
  'Pan', 'SineOsc', 'TriangleOsc', 'SawOsc', 'RampOsc', 'SquareOsc',
  'LowpassFilter', 'HighpassFilter', 'BandpassFilter', 'AllpassFilter',
  'AudioOut',
]);
const CANDIDATE_OPS = new Set<number>([
  DSP_OP.Value, DSP_OP.Add, DSP_OP.Mul, DSP_OP.Sub, DSP_OP.Div,
  DSP_OP.Neg, DSP_OP.Abs, DSP_OP.Map, DSP_OP.Osc, DSP_OP.Filter,
  DSP_OP.Output,
]);
const EVENT_NODES = new Set(['MidiNoteOnSend', 'MidiNoteOffSend', 'MidiCcSend', 'Roll', 'Sequencer']);
const RESOURCE_NODES = new Set(['Buffer', 'SamplePlayer', 'Image']);

function sharesRuntime(receive: PatchNode, send: PatchNode): boolean {
  if ((receive.routingScope ?? '') !== (send.routingScope ?? '')) return false;
  const receiveRuntime = receive.runtimeSpread?.conditional ? undefined : receive.runtimeSpread;
  const sendRuntime = send.runtimeSpread?.conditional ? undefined : send.runtimeSpread;
  if (!receiveRuntime) return !sendRuntime;
  if (!sendRuntime) return true;
  return receiveRuntime.spreadId === sendRuntime.spreadId
    && receiveRuntime.itemIndex === sendRuntime.itemIndex;
}

function route(node: PatchNode): number {
  const value = Number(node.params.number);
  return Number.isFinite(value) ? Math.max(1, Math.min(10, Math.round(value))) : 1;
}

export function analyzeDspSchedule(patch: Patch, ops: DspOp[], feedbackLinkIds: string[]): DspScheduleReport {
  const nodes = patch.nodes.filter((node) => node.enabled !== false);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const dependencies: DspScheduleDependency[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string, kind: DspDependencyKind): void => {
    if (!byId.has(from) || !byId.has(to)) return;
    const key = `${from}\u0000${to}\u0000${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    dependencies.push({ from, to, kind });
  };

  for (const link of patch.links) {
    const from = byId.get(link.from.node);
    const to = byId.get(link.to.node);
    if (!from || !to || link.enabled === false) continue;
    const boundary = from.runtimeSpread?.spreadId !== to.runtimeSpread?.spreadId
      || from.runtimeSpread?.itemIndex !== to.runtimeSpread?.itemIndex;
    add(from.id, to.id, boundary ? 'repeat boundary' : 'cable');
  }
  for (const receive of nodes.filter((node) => node.type === 'Receive')) {
    for (const send of nodes.filter((node) => node.type === 'Send')) {
      if (route(receive) === route(send) && sharesRuntime(receive, send)) {
        add(send.id, receive.id, 'send receive');
      }
    }
  }
  // Serial event emission and resource access order are observable even when
  // there is no cable. Preserve their expanded-patch order conservatively.
  for (const [types, kind] of [[EVENT_NODES, 'event order'], [RESOURCE_NODES, 'resource order']] as const) {
    const ordered = nodes.filter((node) => types.has(node.type));
    for (let index = 1; index < ordered.length; index += 1) {
      add(ordered[index - 1].id, ordered[index].id, kind);
    }
  }

  const outgoing = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of dependencies) outgoing.get(edge.from)!.add(edge.to);
  let nextIndex = 0;
  const indexByNode = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (id: string): void => {
    indexByNode.set(id, nextIndex);
    low.set(id, nextIndex++);
    stack.push(id);
    onStack.add(id);
    for (const next of outgoing.get(id)!) {
      if (!indexByNode.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id)!, indexByNode.get(next)!));
      }
    }
    if (low.get(id) === indexByNode.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component.sort());
    }
  };
  for (const node of nodes) if (!indexByNode.has(node.id)) visit(node.id);

  const componentOf = new Map(components.flatMap((members, index) => members.map((id) => [id, index] as const)));
  const incoming = components.map(() => new Set<number>());
  const outgoingComponents = components.map(() => new Set<number>());
  for (const edge of dependencies) {
    const from = componentOf.get(edge.from)!;
    const to = componentOf.get(edge.to)!;
    if (from !== to) {
      incoming[to].add(from);
      outgoingComponents[from].add(to);
    }
  }
  const indegree = incoming.map((set) => set.size);
  const ready = indegree.map((count, index) => count === 0 ? index : -1).filter((index) => index >= 0);
  const order: number[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of outgoingComponents[id]) if (--indegree[next] === 0) ready.push(next);
  }

  const regions = components.map((members, id): DspScheduleRegion => {
    const cyclic = members.length > 1 || dependencies.some((edge) => edge.from === members[0] && edge.to === members[0]);
    const reasons: string[] = [];
    if (cyclic) reasons.push('cross-node feedback or self-loop');
    if (feedbackLinkIds.some((key) => members.some((nodeId) => key.startsWith(`${nodeId}.`)))) {
      reasons.push('lowered feedback history');
    }
    for (const nodeId of members) {
      const node = byId.get(nodeId)!;
      if (!CANDIDATE_NODES.has(node.type)) reasons.push(`unsupported node: ${node.type}`);
      if (node.runtimeSpread) reasons.push('repeat template or instance boundary');
    }
    if (dependencies.some((edge) => members.includes(edge.from) && (edge.kind === 'resource order' || edge.kind === 'event order'))) {
      reasons.push('ordering-sensitive resource or event');
    }
    return {
      id, nodes: members, dependencies: [...incoming[id]].sort((a, b) => a - b), cyclic,
      eligibility: reasons.length ? 'scalar' : 'block candidate', reasons: [...new Set(reasons)],
    };
  });
  const operationFallbacks: Record<string, number> = {};
  for (const op of ops) if (!CANDIDATE_OPS.has(op.opcode)) {
    const name = OPCODE_NAMES.get(op.opcode) ?? `unknown ${op.opcode}`;
    operationFallbacks[name] = (operationFallbacks[name] ?? 0) + 1;
  }
  return {
    rendering: 'scalar', expandedNodeCount: nodes.length, operationCount: ops.length,
    operationFallbacks, dependencies, feedbackBoundaries: [...feedbackLinkIds], regions, order,
  };
}
