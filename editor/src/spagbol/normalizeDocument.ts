import { pruneInvalidPorts, type GraphDocument } from '@pauloricca/spagbol';
import { executionAreaSize, executionAreaPortsHeight } from '../graph/spread';
import { getNodeTypeLabel } from '../graph/nodeTypes';
import { nodeToGraph, nodeToPatch } from './patchCodec';
import { teiaCatalogue } from './catalogue';

/** Domain port and geometry invariants only. Selection, dragging, sizing and undo remain in Spagbol. */
export function normalizeTeiaDocument(graph: GraphDocument, previous: GraphDocument): void {
  const previousNodes = new Map(previous.nodes.map(node => [node.id, node]));
  for (const node of graph.nodes) {
    const old = previousNodes.get(node.id);
    const shapePort = node.kind === 'CustomWave' ? 'count' : node.kind === 'Crossover' ? 'points' : node.kind === 'Sequencer' ? 'rows' : undefined;
    if (old && shapePort && node.values[shapePort] !== old.values[shapePort]) {
      // Numeric commands remain generic; Teia owns ports derived from DSP modes.
      const refreshed = nodeToGraph(nodeToPatch(node), old);
      node.ports = refreshed.ports;
      node.data.portNames = refreshed.data.portNames!;
      node.data.portLabels = refreshed.data.portLabels!;
      pruneInvalidPorts(graph, teiaCatalogue, node.id);
    }
    if (node.graph) normalizeTeiaDocument(node.graph, old?.graph ?? node.graph);
  }
  // Teia's small routing markers follow their single physical owner.
  for (const marker of graph.nodes) {
    if (!['Send', 'Receive'].includes(marker.kind)) continue;
    const old = previous.nodes.find(node => node.id === marker.id);
    if (!old || marker.position.x !== old.position.x || marker.position.y !== old.position.y) continue;
    const neighbors = new Set(graph.links.flatMap(link => link.target.type !== 'port' ? [] : link.source.nodeId === marker.id ? [link.target.nodeId] : link.target.nodeId === marker.id ? [link.source.nodeId] : []));
    if (neighbors.size !== 1) continue;
    const id = [...neighbors][0];
    const owner = graph.nodes.find(node => node.id === id);
    const oldOwner = previous.nodes.find(node => node.id === id);
    if (owner && oldOwner && !['Send', 'Receive'].includes(owner.kind)) marker.position = { x: marker.position.x + owner.position.x - oldOwner.position.x, y: marker.position.y + owner.position.y - oldOwner.position.y };
  }
  graph.areas = graph.areas.filter(area => !area.ownerNodeId || graph.nodes.some(node => node.id === area.ownerNodeId && ['Spread', 'Spawn', 'ConditionalExecution'].includes(node.kind)));
  for (const owner of graph.nodes) {
    if (!['Spread', 'Spawn', 'ConditionalExecution'].includes(owner.kind) || graph.areas.some(area => area.ownerNodeId === owner.id)) continue;
    const patch = nodeToPatch(owner);
    const size = executionAreaSize(patch);
    graph.areas.push({ id: `spread-area:${owner.id}`, ownerNodeId: owner.id, title: getNodeTypeLabel(patch.type), position: { ...owner.position }, size: { width: size.width, height: size.height + 32 }, controlHeight: executionAreaPortsHeight(patch), data: { kind: 'spread', spreadNodeId: owner.id }, ...(patch.spreadNodeIds ? { locked: true, nodeIds: [...patch.spreadNodeIds] } : {}) });
  }
  for (const area of graph.areas) {
    if (!area.ownerNodeId) continue;
    const owner = graph.nodes.find(node => node.id === area.ownerNodeId);
    if (!owner || !['Spread', 'Spawn', 'ConditionalExecution'].includes(owner.kind)) continue;
    const old = previous.areas.find(item => item.id === area.id);
    const oldOwner = previous.nodes.find(item => item.id === owner.id);
    const areaMoved = old && (area.position.x !== old.position.x || area.position.y !== old.position.y);
    if (areaMoved) owner.position = { ...area.position };
    else if (oldOwner && (owner.position.x !== oldOwner.position.x || owner.position.y !== oldOwner.position.y)) area.position = { ...owner.position };
    if (old && (area.size.width !== old.size.width || area.size.height !== old.size.height)) owner.data.scopeSize = { width: area.size.width, height: Math.max(140, area.size.height - 32) };
    const patch = nodeToPatch(owner);
    const size = executionAreaSize(patch);
    area.size = { width: size.width, height: 32 + size.height };
    area.controlHeight = executionAreaPortsHeight(patch);
    if (area.locked) owner.data.spreadNodeIds = (area.nodeIds ?? []).filter(id => id !== owner.id);
    else delete owner.data.spreadNodeIds;
  }
}
