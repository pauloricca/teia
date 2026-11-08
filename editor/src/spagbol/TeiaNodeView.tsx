import { createContext, memo, useContext, useMemo, useRef, useEffect, useState, type ReactNode } from 'react';
import { useSpagbol, type SpagbolNodeViewProps, type SpagbolNodeView, type GraphNode } from '@pauloricca/spagbol';
import { TeiaNodeContent } from '../editor/TeiaNodeContent';
import { nodeToPatch, portName } from './patchCodec';
import type { ShaderFlowNode, ShaderNodeData } from '../editor/flowPatch';
import { teiaCatalogue } from './catalogue';

type HostGesture = (node: GraphNode, path: readonly string[], values: Record<string, number>) => boolean;
interface NodeBindings {
  data: Map<string, ShaderNodeData>;
  listeners: Map<string, Set<() => void>>;
  gesture: HostGesture;
  subscribe(key: string, listener: () => void): () => void;
}
const Bindings = createContext<NodeBindings | null>(null);
function presentationMap(nodes: ShaderFlowNode[]) {
  const entries = new Map<string, ShaderNodeData>();
  const add = (id: string, value: ShaderNodeData) => {
    entries.set(id, value);
    for (const child of value.groupUiPreview?.nodes ?? []) {
      const prefix = `__group_ui__${id}__`;
      add(`${id}/${child.id.startsWith(prefix) ? child.id.slice(prefix.length) : child.id}`, child.data);
    }
  };
  for (const node of nodes) add(node.id, node.data);
  return entries;
}
export function TeiaGraphBindings({ nodes, children, gesture }: { nodes: ShaderFlowNode[]; children: ReactNode; gesture: HostGesture }) {
  const [store] = useMemo(() => {
    const listeners = new Map<string, Set<() => void>>();
    return [{ data: presentationMap(nodes), listeners, gesture, subscribe(key: string, listener: () => void) {
      const subscribers = listeners.get(key) ?? new Set(); subscribers.add(listener); listeners.set(key, subscribers);
      return () => { subscribers.delete(listener); if (!subscribers.size) listeners.delete(key); };
    } }];
  }, []);
  store.gesture = gesture;
  const latest = useRef(nodes); latest.current = nodes;
  useEffect(() => {
    // Audio observations are visual state: publish at most once per animation
    // frame, outside React's commit, rather than synchronously reentering it.
    const frame = requestAnimationFrame(() => {
      const previous = store.data, next = presentationMap(latest.current); store.data = next;
      for (const [key, subscribers] of store.listeners) if (previous.get(key) !== next.get(key)) for (const notify of [...subscribers]) notify();
    });
    return () => cancelAnimationFrame(frame);
  }, [store, nodes]);
  return <Bindings.Provider value={store}>{children}</Bindings.Provider>;
}
const TeiaNodeView = memo(function TeiaNodeView(shared: SpagbolNodeViewProps) {
  const bindings = useContext(Bindings)!;
  const context = useSpagbol();
  const { editor, zoom, connecting } = context;
  const relative = [...shared.path.slice(editor.getSnapshot().path.length), shared.node.id].join('/');
  const [source, setSource] = useState(() => bindings.data.get(relative));
  useEffect(() => {
    const update = () => setSource(bindings.data.get(relative));
    update(); return bindings.subscribe(relative, update);
  }, [bindings, relative]);
  const gesture: HostGesture = (...args) => bindings.gesture(...args);
  const data = useMemo(() => {
    if (!source) return null;
  const patch = nodeToPatch(shared.node);
  const node = shared.node;
  const result: ShaderNodeData = {
    ...source, patchNode: { ...patch, params: { ...patch.params, ...source.patchNode.params } }, canvasZoom: zoom, isCanvasLocked: !editor.editing,
    isOnlySelected: shared.selected && editor.getSnapshot().selection.nodeIds.length === 1,
    isConnecting: connecting, groupUiPreview: undefined,
    selectedPort: editor.getSnapshot().selection.port?.nodeId === node.id ? { side: editor.getSnapshot().selection.port!.direction, name: portName(node, editor.getSnapshot().selection.port!.portId, editor.getSnapshot().selection.port!.direction) } : null,
    onTypeChange: (_, kind) => editor.changeNodeKind(node.id, kind),
    onCompactToggle: (_, compact) => editor.updateNode(node.id, { compact }, 'layout'),
    onEnabledChange: (_, enabled) => editor.updateNode(node.id, { enabled }, 'structure'),
    onTitleSelect: (_, additive) => editor.select({ nodeIds: additive ? [...editor.getSnapshot().selection.nodeIds, node.id] : [node.id] }),
    onPortDoubleClick: () => undefined,
    onPortSelect: (_, side, name) => {
      const direction = side === 'input' ? 'input' : 'output';
      const port = node.ports?.find(port => port.direction === direction && portName(node, port.id, direction) === name);
      if (port) editor.select({ nodeIds: [node.id], port: { nodeId: node.id, portId: port.id, direction } });
    },
    onTypeEditStart: () => undefined, onTypeEditEnd: () => undefined, onTypeEditCancel: () => undefined,
    ...(shared.projected ? {
      onParamChange: (_: string, name: string, value: number) => gesture(node, shared.path, { [name]: value }) || shared.setValue(node.ports?.find(port => port.direction === 'input' && portName(node, port.id, 'input') === name)?.id ?? name, value),
      onParamsChange: (_: string, values: Record<string, number>) => { if (gesture(node, shared.path, values)) return; for (const [name, value] of Object.entries(values)) shared.setValue(node.ports?.find(port => port.direction === 'input' && portName(node, port.id, 'input') === name)?.id ?? name, value); },
      onCustomWaveChange: (_: string, customWave: NonNullable<typeof patch.customWave>) => shared.patchData({ customWave: customWave as unknown as GraphNode['data'][string] }),
      onHeaderDoubleClick: () => shared.resetOverride?.(),
    } : {}),
  };
  return result;
  }, [source, shared.node, shared.selected, shared.projected, shared.path, shared.setValue, shared.patchData, shared.resetOverride, editor, zoom, connecting, bindings]);
  return data ? <TeiaNodeContent data={data} shared={shared} /> : null;
});
export const teiaNodeViews: Readonly<Record<string, SpagbolNodeView>> = Object.fromEntries(teiaCatalogue.list().filter(definition => !definition.kind.startsWith('spagbol.')).map(definition => [definition.kind, { render: TeiaNodeView, projected: TeiaNodeView, autoWidth: true, compact: definition.kind !== 'Params', selectable: !['Spread', 'Spawn', 'ConditionalExecution'].includes(definition.kind), draggable: !['Spread', 'Spawn', 'ConditionalExecution'].includes(definition.kind) }]));
