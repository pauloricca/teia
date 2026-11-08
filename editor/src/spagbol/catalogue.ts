import { NodeRegistry, createId, type GraphNode } from '@pauloricca/spagbol';
import { NODE_TYPE_LIST, defaultParamsFor, getNodeTypeLabel } from '../graph/nodeTypes';
import { DEFAULT_SPAWN_SIZE, DEFAULT_SPREAD_SIZE } from '../graph/spread';
import { expressionInputDefinitions } from '../graph/parse';
import { graphKind, graphPorts, nodeToGraph, nodeToPatch } from './patchCodec';
import type { PatchNode } from '../graph/types';

/** Teia owns DSP definitions; Spagbol owns Group/Ins/Outs and all graph editing. */
export const teiaCatalogue = new NodeRegistry(NODE_TYPE_LIST.filter(type => !['Group', 'Ins', 'Outs'].includes(type)).map(type => ({
  kind: graphKind(type), label: getNodeTypeLabel(type),
  createData: () => nodeToGraph({ id: '', type, params: defaultParamsFor(type), ...(['Spread', 'Spawn', 'ConditionalExecution'].includes(type) ? { scopeSize: { ...(type === 'Spawn' ? DEFAULT_SPAWN_SIZE : DEFAULT_SPREAD_SIZE) } } : {}), ...(type === 'Expression' ? { expression: 'a', inputs: expressionInputDefinitions('a') } : {}) }).data,
  ports: (node: GraphNode) => graphPorts(nodeToPatch(node)),
  ...(type === 'Params' ? {
    editablePorts: 'output' as const,
    newPortLabel: 'new param',
    createPort(node: GraphNode, label: string) {
      const id = createId('parameter');
      const port = { name: label, parameterId: id, defaultValue: 0, min: 0, max: 1 };
      node.data.outputs = [...(Array.isArray(node.data.outputs) ? node.data.outputs : []), port];
      return { id, label, direction: 'output' as const, defaultValue: 0, min: 0, max: 1 };
    },
  } : {}),
  cloneData: data => type === 'Params' && Array.isArray(data.outputs) ? {
    ...data, outputs: data.outputs.map(port => ({ ...(port as Record<string, string | number | boolean>), parameterId: createId('parameter') })),
  } : data,
})));
