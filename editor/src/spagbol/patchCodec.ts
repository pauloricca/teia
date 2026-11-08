import {
  emptyGraph, createId, spagbolGroupKinds,
  type GraphDocument, type GraphNode, type GraphLink, type NodeData,
  type PortDefinition as GraphPort,
} from '@pauloricca/spagbol';
import { getNodeDefinition, NODE_TYPE_LIST } from '../graph/nodeTypes';
import type { Patch, PatchNode, PatchLink, LinkWeightModulation, LinkMode, NodeType, PortDefinition } from '../graph/types';

const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
export const graphKind = (type: NodeType): string => type === 'Group' ? spagbolGroupKinds.group : type === 'Ins' ? spagbolGroupKinds.inputs : type === 'Outs' ? spagbolGroupKinds.outputs : type;
export const patchType = (kind: string): NodeType => kind === spagbolGroupKinds.group ? 'Group' : kind === spagbolGroupKinds.inputs ? 'Ins' : kind === spagbolGroupKinds.outputs ? 'Outs' : kind as NodeType;
const readable = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
const boundary = (node: GraphNode) => Object.values(spagbolGroupKinds).includes(node.kind as typeof spagbolGroupKinds.group);

export function portName(node: GraphNode, id: string, direction: 'input' | 'output'): string {
  const port = node.ports?.find(port => port.id === id && port.direction === direction);
  const originalNames = node.data.portNames as Record<string, string> | undefined;
  const originalLabels = node.data.portLabels as Record<string, string> | undefined;
  const key = `${direction}:${id}`;
  return boundary(node) && port && originalLabels?.[key] !== port.label ? port.label : originalNames?.[key] ?? (node.kind === 'Params' && port ? port.label : id);
}
function portId(node: GraphNode, name: string, direction: 'input' | 'output'): string {
  return node.ports?.find(port => port.direction === direction && portName(node, port.id, direction) === name)?.id ?? name;
}
export function graphPorts(node: PatchNode, previous?: GraphNode): GraphPort[] {
  const definition = getNodeDefinition(node);
  return ([['input', definition.inputs], ['output', definition.outputs]] as const).flatMap(([direction, ports]) => ports.map(port => {
    const old = previous?.ports?.find(item => item.direction === direction && portName(previous, item.id, direction) === port.name);
    return {
      id: old?.id ?? port.parameterId ?? port.name,
      label: old?.label ?? readable(port.name), direction,
      ...(port.defaultValue === undefined ? {} : { defaultValue: port.defaultValue }),
      ...(port.connectable === undefined ? {} : { connectable: port.connectable }),
      ...(port.valueEditor === undefined ? {} : { valueEditor: port.valueEditor }),
      ...(port.min === undefined ? {} : { min: port.min }),
      ...(port.max === undefined ? {} : { max: port.max }),
      ...(port.step === undefined ? {} : { step: port.step }),
      ...(port.integer === undefined ? {} : { integer: port.integer }),
    };
  }));
}
export function nodeToGraph(node: PatchNode, previous?: GraphNode): GraphNode {
  const { id, type, params, position, subpatch, compactPorts, enabled, subpatchCloneId, subpatchUiOverrides, ...metadata } = json(node);
  const result: GraphNode = {
    id, kind: graphKind(type), position: position ?? { x: 0, y: 0 }, data: { ...metadata } as NodeData, values: {},
    ...(compactPorts === undefined ? {} : { compact: compactPorts }),
    ...(node.customLabel === undefined ? {} : { compactLabel: node.customLabel }),
    ...(node.scale === undefined ? {} : { scale: node.scale }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(previous?.size ? { size: previous.size } : {}),
  };
  result.ports = graphPorts(node, previous);
  const names: Record<string, string> = {}, labels: Record<string, string> = {};
  const definitions = getNodeDefinition(node);
  for (const direction of ['input', 'output'] as const) {
    const definitionsForDirection = direction === 'input' ? definitions.inputs : definitions.outputs;
    const ports = result.ports.filter(port => port.direction === direction);
    for (let index = 0; index < ports.length; index++) {
      const port = ports[index]!;
      names[`${direction}:${port.id}`] = definitionsForDirection[index]!.name;
      labels[`${direction}:${port.id}`] = port.label;
    }
  }
  // Retain removed-port names through an atomic domain conversion so Teia can
  // remap existing cables by their original port order before pruning them.
  result.data.portNames = { ...(previous?.data.portNames as Record<string, string> | undefined), ...names };
  result.data.portLabels = { ...(previous?.data.portLabels as Record<string, string> | undefined), ...labels };
  if (!position) result.data.positionWasAbsent = true;
  for (const [name, value] of Object.entries(params)) {
    const direction = type === 'Ins' || type === 'Params' ? 'output' : 'input';
    const port = result.ports.find(port => port.direction === direction && names[`${direction}:${port.id}`] === name);
    result.values[port?.id ?? name] = value;
  }
  if (subpatch) result.graph = patchToGraph(subpatch, previous?.graph);
  if (subpatchCloneId) result.sharedGraphId = subpatchCloneId;
  if (type === 'Group' && node.subpatchName) result.label = node.subpatchName;
  if (subpatchUiOverrides && result.graph) for (const [innerId, override] of Object.entries(subpatchUiOverrides)) {
    const inner = result.graph.nodes.find(node => node.id === innerId);
    if (override.params) {
      result.overrides ??= {}; result.overrides[innerId] = {};
      for (const [name, value] of Object.entries(override.params)) result.overrides[innerId]![inner ? portId(inner, name, 'input') : name] = value;
    }
    if (override.customWave) { result.dataOverrides ??= {}; result.dataOverrides[innerId] = { customWave: json(override.customWave) as unknown as NodeData[string] }; }
  }
  return result;
}
const nodePatchCache = new WeakMap<GraphNode, PatchNode>();
const documentPatchCache = new WeakMap<GraphDocument, Patch>();
export function nodeToPatch(node: GraphNode): PatchNode {
  const cached = Object.isFrozen(node) ? nodePatchCache.get(node) : undefined;
  if (cached) return cached;
  const { portNames: _names, portLabels: _labels, positionWasAbsent, ...metadata } = json(node.data);
  const params: Record<string, number> = {};
  const valueDirection = node.kind === spagbolGroupKinds.inputs || node.kind === 'Params' ? 'output' : 'input';
  for (const [id, value] of Object.entries(node.values)) params[portName(node, id, valueDirection)] = value;
  const result = {
    ...metadata, id: node.id, type: patchType(node.kind), params,
    ...(!positionWasAbsent || node.position.x !== 0 || node.position.y !== 0 ? { position: { ...node.position } } : {}),
    ...(node.compact === undefined ? {} : { compactPorts: node.compact }),
    ...(node.enabled === undefined ? {} : { enabled: node.enabled }),
  } as unknown as PatchNode;
  if (node.scale !== undefined) result.scale = node.scale;
  if (node.compactLabel !== undefined) { if (node.compactLabel.trim()) result.customLabel = node.compactLabel; else delete result.customLabel; }
  if (node.graph) result.subpatch = graphToPatch(node.graph);
  if (node.sharedGraphId) result.subpatchCloneId = node.sharedGraphId;
  if (node.label && node.kind === spagbolGroupKinds.group) result.subpatchName = node.label;
  if (boundary(node)) {
    const mapped = (direction: 'input' | 'output'): PortDefinition[] => (node.ports ?? []).filter(port => port.direction === direction).map(port => {
      const original = (direction === 'input' ? result.inputs : result.outputs)?.find(item => item.name === portName(node, port.id, direction));
      return { ...original, name: portName(node, port.id, direction),
        ...(port.defaultValue === undefined ? {} : { defaultValue: port.defaultValue }),
        ...(port.connectable === undefined ? {} : { connectable: port.connectable }),
        ...(port.min === undefined ? {} : { min: port.min }), ...(port.max === undefined ? {} : { max: port.max }),
        ...(port.integer === undefined ? {} : { integer: port.integer }),
      };
    });
    if (node.kind !== spagbolGroupKinds.inputs) result.inputs = mapped('input');
    if (node.kind !== spagbolGroupKinds.outputs) result.outputs = mapped('output');
  }
  if (node.overrides || node.dataOverrides) {
    result.subpatchUiOverrides = {};
    for (const id of new Set([...Object.keys(node.overrides ?? {}), ...Object.keys(node.dataOverrides ?? {})])) {
      const inner = node.graph?.nodes.find(node => node.id === id);
      const values = node.overrides?.[id];
      result.subpatchUiOverrides[id] = {
        ...(values ? { params: Object.fromEntries(Object.entries(values).map(([port, value]) => [inner ? portName(inner, port, 'input') : port, value])) } : {}),
        ...(node.dataOverrides?.[id]?.customWave ? { customWave: json(node.dataOverrides[id]!.customWave) as unknown as PatchNode['customWave'] } : {}),
      };
    }
  }
  if (Object.isFrozen(node)) nodePatchCache.set(node, result);
  return result;
}

export function patchToGraph(patch: Patch, previous?: GraphDocument): GraphDocument {
  const { nodes, links, areas, ...metadata } = json(patch);
  const graph = emptyGraph();
  graph.data = metadata as NodeData;
  graph.nodes = nodes.map(node => nodeToGraph(node, previous?.nodes.find(item => item.id === node.id)));
  graph.areas = (areas ?? []).map(area => ({ id: area.id, title: area.title, position: area.position, size: area.size,
    ...(area.spreadNodeId ? { ownerNodeId: area.spreadNodeId } : {}),
    ...(area.locked === undefined ? {} : { locked: area.locked }), ...(area.collapsed === undefined ? {} : { collapsed: area.collapsed }),
    ...(area.nodeIds ? { nodeIds: area.nodeIds } : {}), ...(area.areaIds ? { areaIds: area.areaIds } : {}),
    ...(area.uiHeight === undefined ? {} : { controlHeight: area.uiHeight }), data: json(area) as unknown as NodeData,
  }));
  const endpoint = (value: PatchLink['from'], direction: 'input' | 'output') => {
    const node = graph.nodes.find(node => node.id === value.node);
    return { nodeId: value.node, portId: node ? portId(node, value.port, direction) : value.port };
  };
  const add = (link: PatchLink | LinkWeightModulation, target: GraphLink['target'], old?: GraphLink) => {
    const source = endpoint(link.from, 'output');
    const entry: GraphLink = { id: old?.id ?? createId('link'), source, target, mode: link.mode ?? 'set', weight: link.weight ?? 1, ...(link.enabled === undefined ? {} : { enabled: link.enabled }) };
    entry.data = { teiaWeightWasAbsent: link.weight === undefined, teiaModeWasAbsent: link.mode === undefined };
    graph.links.push(entry);
    for (const modulation of link.weightModulations ?? []) {
      const from = endpoint(modulation.from, 'output');
      const oldChild = previous?.links.find(item => item.source.nodeId === from.nodeId && item.source.portId === from.portId && item.target.type === 'link' && item.target.linkId === entry.id);
      add(modulation, { type: 'link', linkId: entry.id, property: 'weight' }, oldChild);
    }
  };
  for (const link of links) {
    const source = endpoint(link.from, 'output'), target = { type: 'port' as const, ...endpoint(link.to, 'input') };
    const old = previous?.links.find(item => item.source.nodeId === source.nodeId && item.source.portId === source.portId && item.target.type === 'port' && item.target.nodeId === target.nodeId && item.target.portId === target.portId);
    add(link, target, old);
  }
  return graph;
}
export function graphToPatch(graph: GraphDocument): Patch {
  const cached = Object.isFrozen(graph) ? documentPatchCache.get(graph) : undefined;
  if (cached) return cached;
  const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
  const childrenByLink = new Map<string, GraphLink[]>();
  for (const link of graph.links) if (link.target.type === 'link') {
    const children = childrenByLink.get(link.target.linkId) ?? [];
    children.push(link); childrenByLink.set(link.target.linkId, children);
  }
  const endpoint = (nodeId: string, id: string, direction: 'input' | 'output') => {
    const node = nodesById.get(nodeId);
    return { node: nodeId, port: node ? portName(node, id, direction) : id };
  };
  const settings = (link: GraphLink, seen: Set<string> = new Set()): LinkWeightModulation => {
    if (seen.has(link.id)) throw new Error('Cyclic strength modulation.');
    const next = new Set([...seen, link.id]);
    const modulations = (childrenByLink.get(link.id) ?? []).map(item => settings(item, next));
    return { from: endpoint(link.source.nodeId, link.source.portId, 'output'),
      ...(link.data?.teiaWeightWasAbsent && link.weight === 1 ? {} : { weight: link.weight }),
      ...(link.data?.teiaModeWasAbsent && link.mode === 'set' ? {} : { mode: link.mode as LinkMode }),
      ...(link.enabled === undefined ? {} : { enabled: link.enabled }), ...(modulations.length ? { weightModulations: modulations } : {}),
    };
  };
  const result: Patch = {
    ...json(graph.data ?? {}), nodes: graph.nodes.map(nodeToPatch),
    links: graph.links.flatMap(link => link.target.type === 'port' ? [{ ...settings(link), to: endpoint(link.target.nodeId, link.target.portId, 'input') }] : []),
    ...(graph.areas.length ? { areas: graph.areas.map(area => ({ ...json(area.data ?? {}), id: area.id, title: area.title, position: area.position, size: area.size,
      ...(area.ownerNodeId ? { spreadNodeId: area.ownerNodeId } : {}),
      ...(area.locked === undefined ? {} : { locked: area.locked }), ...(area.collapsed === undefined ? {} : { collapsed: area.collapsed }),
      ...(area.nodeIds ? { nodeIds: area.nodeIds } : {}), ...(area.areaIds ? { areaIds: area.areaIds } : {}),
      ...(area.controlHeight === undefined ? {} : { uiHeight: area.controlHeight }),
    })) as Patch['areas'] } : {}),
  } as Patch;
  if (Object.isFrozen(graph)) documentPatchCache.set(graph, result);
  return result;
}

/** Map stable shared IDs to the endpoint IDs used by Teia compiler diagnostics. */
export function teiaLinkIds(graph: GraphDocument): Map<string, string> {
  const result = new Map<string, string>();
  const endpoint = (nodeId: string, id: string, direction: 'input' | 'output') => {
    const node = graph.nodes.find(node => node.id === nodeId);
    return `${nodeId}:${node ? portName(node, id, direction) : id}`;
  };
  const visit = (link: GraphLink, id: string) => {
    result.set(link.id, id);
    graph.links.filter(child => child.target.type === 'link' && child.target.linkId === link.id).forEach((child, index) => visit(child, `weight-modulation:${id}:${index}`));
  };
  for (const link of graph.links) if (link.target.type === 'port') visit(link, `${endpoint(link.source.nodeId, link.source.portId, 'output')}->${endpoint(link.target.nodeId, link.target.portId, 'input')}`);
  return result;
}
