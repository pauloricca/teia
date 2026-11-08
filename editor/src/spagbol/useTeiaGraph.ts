import { createTeiaPresentationReader } from './presentation';
import { normalizeTeiaDocument } from './normalizeDocument';
import { useCallback, useMemo, useState, useRef, useSyncExternalStore, type SetStateAction } from 'react';
import { GraphEditor, graphAt, pruneInvalidPorts, type EditorOptions } from '@pauloricca/spagbol';
import { teiaCatalogue } from './catalogue';
import { nodeToGraph, patchToGraph, portName } from './patchCodec';
import { toFlowNodes, patchFromFlow, type TeiaFlowNode, type TeiaFlowEdge, type EditorArea } from '../editor/flowPatch';
import type { Patch } from '../graph/types';

type Callbacks = Parameters<typeof toFlowNodes>[1];
const apply = <T,>(update: SetStateAction<T>, current: T): T => typeof update === 'function' ? (update as (current: T) => T)(current) : update;
/** Legacy flow records are a read-only domain presentation/codec, never editor state. */
export function useTeiaGraph(initial: Patch, callbacks: Callbacks, onPaste?: EditorOptions['onPaste']) {
  const pasteHandler = useRef(onPaste); pasteHandler.current = onPaste;
  const [editor] = useState(() => new GraphEditor({ nodes: teiaCatalogue, document: patchToGraph(initial), normalizeDocument: normalizeTeiaDocument, onPaste: event => pasteHandler.current?.(event),
    policy: { deletePort(node, port) {
      if (node.kind !== 'Params' || port.direction !== 'output') return;
      const name = portName(node, port.id, 'output');
      node.data.outputs = (node.data.outputs as unknown as {name: string}[] ?? []).filter(item => item.name !== name);
      node.ports = node.ports?.filter(item => item.id !== port.id);
      delete node.values[port.id]; delete node.values[name];
    } },
  }));
  const snapshot = useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
  const present = useMemo(() => createTeiaPresentationReader(callbacks), [callbacks]);
  const read = useCallback(() => present(editor.graph, editor.getSnapshot().selection), [editor, present]);
  const state = useMemo(read, [read, snapshot.document, snapshot.path, snapshot.selection]);
  const setNodes = useCallback((update: SetStateAction<TeiaFlowNode[]>) => {
    const current = read(), next = apply(update, current.nodes);
    if (next === current.nodes) return;
    const document = editor.graph;
    const beforeById = new Map(current.nodes.map(node => [node.id, node]));
    const graphById = new Map(document.nodes.map(node => [node.id, node]));
    const converted = next.filter(node => node.data.patchNode.type !== null).map(node => {
      const previous = beforeById.get(node.id);
      const model = graphById.get(node.id);
      return previous?.data.patchNode === node.data.patchNode && previous?.position === node.position && model
        ? model : nodeToGraph({ ...node.data.patchNode, position: node.position } as Patch['nodes'][number], model);
    });
    const structural = next.length !== current.nodes.length || next.some(node => current.nodes.find(old => old.id === node.id)?.data.patchNode.type !== node.data.patchNode.type);
    const explicitPortsChanged = next.some(node => {
      const before = current.nodes.find(old => old.id === node.id)?.data.patchNode;
      return JSON.stringify([before?.inputs, before?.outputs]) !== JSON.stringify([node.data.patchNode.inputs, node.data.patchNode.outputs]);
    });
    editor.edit('Edit Teia node', structural ? 'structure' : 'values', graph => {
      graph.nodes = converted.map(node => node === graphById.get(node.id) ? graph.nodes.find(current => current.id === node.id)! : node);
      if (!structural && !explicitPortsChanged) for (const node of converted) if (node !== graphById.get(node.id)) pruneInvalidPorts(graph, editor.nodes, node.id);
    });
    const selected = next.filter(node => node.selected).map(node => node.id);
    if (JSON.stringify(selected) !== JSON.stringify(editor.getSnapshot().selection.nodeIds)) editor.select({ ...editor.getSnapshot().selection, nodeIds: selected });
  }, [editor, read]);
  const setEdges = useCallback((update: SetStateAction<TeiaFlowEdge[]>) => {
    const current = read(), next = apply(update, current.edges);
    if (next === current.edges) return;
    const converted = patchToGraph(patchFromFlow(current.nodes, next, current.areas), editor.graph);
    editor.edit('Edit Teia connections', 'structure', graph => { graph.links = converted.links; });
  }, [editor, read]);
  const setAreas = useCallback((update: SetStateAction<EditorArea[]>) => {
    const current = read(), next = apply(update, current.areas);
    if (next === current.areas) return;
    const converted = patchToGraph(patchFromFlow(current.nodes, current.edges, next), editor.graph);
    editor.edit('Edit Teia areas', 'layout', graph => { graph.areas = converted.areas; });
  }, [editor, read]);
  const currentName = snapshot.path.length ? graphAt(snapshot.document, snapshot.path.slice(0, -1)).nodes.find(node => node.id === snapshot.path.at(-1))?.label : undefined;
  const replace = useCallback((patch: Patch) => editor.replace(patchToGraph(patch)), [editor]);
  return { editor, snapshot, ...state, setNodes, setEdges, setAreas, currentName, replace };
}
