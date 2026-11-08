import type { GraphDocument, Selection } from '@pauloricca/spagbol';
import { graphToPatch, teiaLinkIds } from './patchCodec';
import { toFlowNodes, toFlowEdges, type TeiaFlowNode, type TeiaFlowEdge, type EditorArea } from '../editor/flowPatch';
import type { PatchNode } from '../graph/types';

type Presentation = { nodes: TeiaFlowNode[]; edges: TeiaFlowEdge[]; areas: EditorArea[] };
const noop = () => undefined;
/** Cache domain presentations; these are derived records, never graph state. */
export function createTeiaPresentationReader(callbacks: Parameters<typeof toFlowNodes>[1]) {
  const nodes = new WeakMap<PatchNode, { selected: TeiaFlowNode; idle: TeiaFlowNode }>();
  let previous: { graph: GraphDocument; selection: Selection; state: Presentation } | undefined;
  return (graph: GraphDocument, selection: Selection): Presentation => {
    if (previous?.graph === graph && previous.selection === selection) return previous.state;
    const patch = graphToPatch(graph);
    const selectedNodes = new Set(selection.nodeIds);
    const sameEndpoints = previous && previous.graph.nodes.length === graph.nodes.length && graph.nodes.every((node, index) => {
      const old = previous!.graph.nodes[index];
      return old?.id === node.id && old.kind === node.kind && old.ports === node.ports && old.data.portNames === node.data.portNames && old.data.portLabels === node.data.portLabels;
    });
    const sameEdges = previous && previous.graph.links === graph.links && sameEndpoints && JSON.stringify(previous.selection.linkIds) === JSON.stringify(selection.linkIds);
    const selectedEdges = sameEdges || !selection.linkIds.length ? undefined : new Set(selection.linkIds.map(id => teiaLinkIds(graph).get(id)));
    const state: Presentation = {
      nodes: patch.nodes.map(node => {
        let cached = nodes.get(node);
        if (!cached) {
          const base = toFlowNodes({ nodes: [node], links: [] }, callbacks, null)[0]!;
          cached = { idle: { ...base, selected: false }, selected: { ...base, selected: true } }; nodes.set(node, cached);
        }
        return selectedNodes.has(node.id) ? cached.selected : cached.idle;
      }),
      edges: sameEdges ? previous!.state.edges : toFlowEdges(patch, noop, noop, noop).map(edge => ({ ...edge, selected: selectedEdges?.has(edge.id) ?? false })),
      areas: previous?.graph.areas === graph.areas ? previous.state.areas : (patch.areas ?? []) as EditorArea[],
    };
    previous = { graph, selection, state }; return state;
  };
}
