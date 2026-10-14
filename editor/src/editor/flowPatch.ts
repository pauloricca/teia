import type { Edge, Node, ReactFlowProps } from '@xyflow/react';
import type { AudioInputState, BufferVisualization, MidiInputState } from '../audio/useAudioEngine';
import { normalizeCustomWave } from '../graph/customWave';
import { getDefinition, getNodeDefinition } from '../graph/nodeTypes';
import { normalizePatchCompatibility } from '../graph/patchCompatibility';
import type { LinkMode, LinkWeightModulation, NodeType, Patch, PatchArea, PatchLink, PatchNode, PortDefinition } from '../graph/types';

export interface ScopeNodeSize {
  width: number;
  height: number;
}

export const DEFAULT_SCOPE_NODE_SIZE: ScopeNodeSize = { width: 224, height: 48 };
export const DEFAULT_JOYSTICK_NODE_SIZE: ScopeNodeSize = { width: 160, height: 120 };
export const DEFAULT_FFT_NODE_SIZE: ScopeNodeSize = { width: 420, height: 96 };
export const DEFAULT_KEYS_NODE_SIZE: ScopeNodeSize = { width: 372, height: 120 };
export const DEFAULT_CUSTOM_WAVE_NODE_SIZE: ScopeNodeSize = { width: 372, height: 128 };
export const DEFAULT_SEQUENCER_NODE_SIZE: ScopeNodeSize = { width: 416, height: 104 };
export const SEQUENCER_MIN_CELL_SIZE = 22;
export const DEFAULT_IMAGE_ASPECT_RATIO = 16 / 9;

export type EditorPatchNode = Omit<PatchNode, 'type'> & {
  type: NodeType | null;
  expression?: string;
  compactPorts?: boolean;
  scopeSize?: ScopeNodeSize;
};

export interface ShaderNodeData extends Record<string, unknown> {
  patchNode: EditorPatchNode;
  /** Canvas-wide view lock: preserves layout while hiding connection affordances. */
  isCanvasLocked?: boolean;
  canvasZoom?: number;
  audioMeter?: {
    input: number;
    output: number;
    envelope: number;
  };
  audioOutputMeter?: {
    left: number;
    right: number;
  };
  audioScope?: {
    samples: number[];
  };
  audioSpectrum?: {
    samples: number[];
  };
  audioSliderValue?: number;
  audioImagePosition?: {
    x: number;
    y: number;
  };
  audioAccumulatorValue?: number;
  audioSelectorIndex?: number;
  audioSequencerStep?: number;
  audioPlayheads?: number[];
  audioCustomWaveFrequency?: number;
  audioBuffer?: BufferVisualization;
  audioSampleParams?: Partial<{
    start: number;
    end: number;
    attack: number;
    release: number;
  }>;
  midiSliderValue?: number;
  midiJoystickPosition?: {
    x?: number;
    y?: number;
  };
  midiButtonPressed?: number;
  audioInput?: AudioInputState;
  midiInput?: MidiInputState;
  dspErrors?: string[];
  onParamChange: (nodeId: string, port: string, value: number) => void;
  onParamsChange: (nodeId: string, values: Record<string, number>) => void;
  onAudioInputDeviceChange?: (deviceId: string) => void;
  onAudioInputRefresh?: () => void;
  onMidiInputRefresh?: () => void;
  onCustomWaveChange?: (nodeId: string, customWave: NonNullable<PatchNode['customWave']>, historyKey?: string) => void;
  onSequencerRowLabelsChange?: (nodeId: string, labels: string[]) => void;
  onExpressionChange?: (nodeId: string, expression: string) => void;
  onExpressionCommit?: (nodeId: string, expression: string) => void;
  onTypeChange: (nodeId: string, type: NodeType) => void;
  onConvertToArea: (nodeId: string) => void;
  onCustomLabelChange?: (nodeId: string, label: string) => void;
  onTitleSelect?: (nodeId: string, additive: boolean) => void;
  onHeaderDoubleClick?: (nodeId: string) => void;
  onSubpatchNameChange?: (nodeId: string, nextName: string) => void;
  onSampleSelect?: (nodeId: string) => void;
  onSampleDrop?: (nodeId: string, files: FileList) => void;
  onBufferClear?: () => void;
  onImageSelect?: (nodeId: string) => void;
  onTypeEditStart: (nodeId: string) => void;
  onTypeEditEnd: () => void;
  onTypeEditCancel: (nodeId: string) => void;
  onIdChange: (nodeId: string, nextId: string) => void;
  onPortDoubleClick: (nodeId: string, side: 'input' | 'output', port: string) => void;
  onPortNameChange: (nodeId: string, side: 'input' | 'output', port: string, nextPort: string) => void;
  onParamRangeChange?: (nodeId: string, port: string, bound: 'min' | 'max', value: number) => void;
  onPortAdd: (nodeId: string, side: 'input' | 'output', name: string) => void;
  onPortMove: (nodeId: string, side: 'input' | 'output', port: string, direction: -1 | 1) => void;
  onCompactToggle: (nodeId: string, compact: boolean) => void;
  onEnabledChange?: (nodeId: string, enabled: boolean) => void;
  onScopeResize: (nodeId: string, size: ScopeNodeSize, anchor: 'left' | 'right', previousSize?: ScopeNodeSize) => void;
  onSelectorInputAdd?: (nodeId: string) => void;
  onSelectorInputClear?: (nodeId: string, port: string) => void;
  onPortSelect?: (nodeId: string, side: 'input' | 'output', port: string) => void;
  selectedPort?: { side: 'input' | 'output'; name: string } | null;
  selectedLinkPorts?: { inputs: string[]; outputs: string[] };
  connectedPorts?: { inputs: string[]; outputs: string[] };
  /** Input ports with an enabled incoming link in set mode, which replaces the local value. */
  setLinkInputPorts?: string[];
  previewPort?: { side: 'input' | 'output'; name: string } | null;
  isOnlySelected?: boolean;
  /** Highlight this Send/Receive because its virtual route participates in the current selection. */
  routingHighlighted?: boolean;
  isConnecting?: boolean;
  onTemporaryPortRevealChange?: (nodeId: string, revealed: boolean) => void;
  isTypePickerOpen: boolean;
  isEditingSubpatch?: boolean;
  isAreaCollapsedPresentation?: boolean;
  /** This node remains visible in the UI portion of a collapsed area, but has no pins. */
  isAreaUiCollapsedPresentation?: boolean;
  /** Static, externally operable controls projected from a UI/Controls area in a Group subpatch. */
  groupUiPreview?: {
    width: number;
    height: number;
    nodes: Array<{
      id: string;
      position: { x: number; y: number };
      data: ShaderNodeData;
    }>;
  };
}

export type ShaderFlowNode = Node<ShaderNodeData, 'shaderNode'>;

export interface ShaderEdgeData extends Record<string, unknown> {
  weight: number;
  mode: LinkMode;
  enabled: boolean;
  /** Derived editor-only state: either endpoint node is disabled. */
  isIncidentToDisabledNode?: boolean;
  onWeightChange: (edgeId: string, weight: number) => void;
  onModeChange: (edgeId: string, mode: LinkMode) => void;
  onEnabledChange?: (edgeId: string, enabled: boolean) => void;
  onInsertNode: (edgeId: string) => void;
  /** The edge whose strength input this ordinary editor edge targets. */
  modulatesEdgeId?: string;
  weightModulations?: LinkWeightModulation[];
  isWeightTarget?: boolean;
  onReconnect?: ReactFlowProps<ShaderFlowNode, ShaderFlowEdge>['onReconnect'];
  onReconnectStart?: ReactFlowProps<ShaderFlowNode, ShaderFlowEdge>['onReconnectStart'];
  onReconnectEnd?: ReactFlowProps<ShaderFlowNode, ShaderFlowEdge>['onReconnectEnd'];
  isReconnecting?: boolean;
  showLinkControls?: boolean;
  /** Draw this link with the selected-link treatment because one of its nodes is selected. */
  isConnectedToSelectedNode?: boolean;
  /** De-emphasize this link while another selected node or link is highlighted. */
  isDimmedBySelection?: boolean;
  isFeedback?: boolean;
  isControl?: boolean;
  dspErrors?: string[];
  /** Canvas-only endpoints used when an area presents its contained nodes as collapsed. */
  visualSource?: { x: number; y: number };
  visualTarget?: { x: number; y: number };
  isAreaCollapsedPresentation?: boolean;
}

export type ShaderFlowEdge = Edge<ShaderEdgeData, 'shaderEdge' | 'virtualRoute'>;

export interface PersistedEditorState {
  version: 1;
  /** Binary data lives in IndexedDB; this map keeps the content-addressed references. */
  buffers?: Patch['buffers'];
  /** Visual-only canvas groupings. They deliberately do not affect the patch graph. */
  areas?: EditorArea[];
  ui?: {
    patchName?: string;
    viewport?: {
      x: number;
      y: number;
      zoom: number;
    };
    midiInput?: Patch['midiInput'];
    fm1Mode?: boolean;
  };
  nodes: Array<{
    id: string;
    type: NodeType | null;
    customLabel?: string;
    sequencerRowLabels?: string[];
    sequencerRowLabelColumnWidth?: number;
    subpatchName?: string;
    subpatchCloneId?: string;
    subpatchUiOverrides?: PatchNode['subpatchUiOverrides'];
    expression?: string;
    sample?: PatchNode['sample'];
    image?: PatchNode['image'];
    customWave?: PatchNode['customWave'];
    params: Record<string, number>;
    position: { x: number; y: number };
    inputs?: PortDefinition[];
    outputs?: PortDefinition[];
    subpatch?: Patch;
    compactPorts?: boolean;
    enabled?: boolean;
    spreadNodeIds?: string[];
    scale?: number;
    scopeSize?: ScopeNodeSize;
  }>;
  edges: Array<{
    id: string;
    source: string;
    sourceHandle: string | null;
    target: string;
    targetHandle: string | null;
    weight?: number;
    mode?: LinkMode;
    enabled?: boolean;
    modulatesEdgeId?: string;
    weightModulations?: LinkWeightModulation[];
  }>;
}

export type EditorArea = PatchArea;

type NodeCallbacks = Pick<
  ShaderNodeData,
  | 'onParamChange'
  | 'onParamsChange'
  | 'onCustomWaveChange'
  | 'onSequencerRowLabelsChange'
  | 'onTypeChange'
  | 'onConvertToArea'
  | 'onTypeEditStart'
  | 'onTypeEditEnd'
  | 'onTypeEditCancel'
  | 'onIdChange'
  | 'onPortDoubleClick'
  | 'onPortNameChange'
  | 'onParamRangeChange'
  | 'onPortAdd'
  | 'onPortMove'
  | 'onCompactToggle'
  | 'onEnabledChange'
  | 'onScopeResize'
  | 'onSelectorInputAdd'
  | 'onSelectorInputClear'
>;

export function toFlowNodes(
  patch: Patch,
  callbacks: NodeCallbacks,
  editingTypeNodeId: string | null,
): ShaderFlowNode[] {
  return patch.nodes.map((patchNode) => ({
    id: patchNode.id,
    type: 'shaderNode',
    position: patchNode.position ?? { x: 0, y: 0 },
    data: {
      patchNode,
      ...callbacks,
      isTypePickerOpen: editingTypeNodeId === patchNode.id,
    },
  }));
}

export function toFlowEdges(
  patch: Patch,
  onWeightChange: ShaderEdgeData['onWeightChange'],
  onModeChange: ShaderEdgeData['onModeChange'],
  onInsertNode: ShaderEdgeData['onInsertNode'],
): ShaderFlowEdge[] {
  return expandWeightModulationEdges(
    patch.links.map((link) => edgeFromLink(link, onWeightChange, onModeChange, onInsertNode)),
    onWeightChange, onModeChange, onInsertNode,
  );
}

export function editorStateToFlowNodes(
  state: PersistedEditorState,
  callbacks: NodeCallbacks,
  editingTypeNodeId: string | null,
): ShaderFlowNode[] {
  const normalizedState = normalizePersistedState(state);
  return normalizedState.nodes.map((node) => ({
    id: node.id,
    type: 'shaderNode',
    position: node.position,
    data: {
      patchNode: {
        id: node.id,
        type: node.type,
        customLabel: node.customLabel,
        sequencerRowLabels: node.sequencerRowLabels,
        sequencerRowLabelColumnWidth: node.sequencerRowLabelColumnWidth,
        subpatchName: node.subpatchName,
        subpatchCloneId: node.subpatchCloneId,
        subpatchUiOverrides: node.subpatchUiOverrides,
        expression: node.expression,
        sample: node.sample,
        image: node.image,
        customWave: node.customWave ? normalizeCustomWave(node.customWave, node.params) : undefined,
        params: node.params,
        position: node.position,
        scale: node.scale,
        inputs: node.inputs,
        outputs: node.outputs,
        subpatch: node.subpatch,
        compactPorts: node.compactPorts,
        enabled: node.enabled,
        spreadNodeIds: node.spreadNodeIds,
        scopeSize: node.scopeSize,
      },
      ...callbacks,
      isTypePickerOpen: editingTypeNodeId === node.id,
    },
  }));
}

export function editorStateToFlowEdges(
  state: PersistedEditorState,
  onWeightChange: ShaderEdgeData['onWeightChange'],
  onModeChange: ShaderEdgeData['onModeChange'],
  onInsertNode: ShaderEdgeData['onInsertNode'],
): ShaderFlowEdge[] {
  const normalizedState = normalizePersistedState(state);
  return expandWeightModulationEdges(normalizedState.edges.map((edge) => ({
    ...edge,
    type: 'shaderEdge',
    data: {
      weight: edge.weight ?? 1,
      mode: edge.mode ?? 'set',
      enabled: edge.enabled !== false,
      modulatesEdgeId: edge.modulatesEdgeId,
      weightModulations: edge.weightModulations,
      onWeightChange,
      onModeChange,
      onInsertNode,
      isFeedback: !edge.modulatesEdgeId && edge.source === edge.target,
    },
    className: 'shader-edge',
  })), onWeightChange, onModeChange, onInsertNode);
}

export function flowToEditorState(
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  ui?: PersistedEditorState['ui'],
): PersistedEditorState {
  return {
    version: 1,
    ...(ui ? { ui } : {}),
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.patchNode.type,
      customLabel: node.data.patchNode.customLabel,
      sequencerRowLabels: node.data.patchNode.sequencerRowLabels,
      sequencerRowLabelColumnWidth: node.data.patchNode.sequencerRowLabelColumnWidth,
      subpatchName: node.data.patchNode.subpatchName,
      subpatchCloneId: node.data.patchNode.subpatchCloneId,
      subpatchUiOverrides: node.data.patchNode.subpatchUiOverrides,
      expression: node.data.patchNode.expression,
      sample: node.data.patchNode.sample,
      image: node.data.patchNode.image,
      customWave: node.data.patchNode.customWave
        ? normalizeCustomWave(node.data.patchNode.customWave, node.data.patchNode.params)
        : undefined,
      params: node.data.patchNode.params,
      position: node.position,
      scale: node.data.patchNode.scale,
      inputs: node.data.patchNode.inputs,
      outputs: node.data.patchNode.outputs,
      subpatch: node.data.patchNode.subpatch,
      compactPorts: node.data.patchNode.compactPorts,
      enabled: node.data.patchNode.enabled,
      spreadNodeIds: node.data.patchNode.spreadNodeIds,
      scopeSize: node.data.patchNode.scopeSize,
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      sourceHandle: edge.sourceHandle ?? null,
      target: edge.target,
      targetHandle: edge.targetHandle ?? null,
      weight: edge.data?.weight ?? 1,
      mode: edge.data?.mode ?? 'set',
      ...(edge.data?.enabled === false ? { enabled: false } : {}),
      ...(edge.data?.modulatesEdgeId ? { modulatesEdgeId: edge.data.modulatesEdgeId } : {}),
      ...(edge.data?.weightModulations?.length ? { weightModulations: edge.data.weightModulations } : {}),
    })),
  };
}

export function clampScopeNodeSize(size: ScopeNodeSize): ScopeNodeSize {
  return normalizeNodeSize(size);
}

export function clampControlNodeSize(size: ScopeNodeSize): ScopeNodeSize {
  return normalizeNodeSize(size);
}

export function clampKeysNodeSize(size: ScopeNodeSize): ScopeNodeSize {
  return normalizeNodeSize(size);
}

export function clampCustomWaveNodeSize(size: ScopeNodeSize): ScopeNodeSize {
  return normalizeNodeSize(size);
}

export function clampImageNodeSize(size: ScopeNodeSize, aspectRatio: number): ScopeNodeSize {
  const aspect = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : DEFAULT_IMAGE_ASPECT_RATIO;
  const width = normalizeNodeDimension(size.width);
  return { width, height: normalizeNodeDimension(width / aspect) };
}

export function clampSequencerNodeSize(size: ScopeNodeSize, steps: number, rows: number, labelColumnWidth = 0): ScopeNodeSize {
  const safeSteps = Number.isFinite(steps) && steps > 0 ? steps : 1;
  const safeRows = Number.isFinite(rows) && rows > 0 ? rows : 1;
  const minimumWidth = Math.max(0, labelColumnWidth) + safeSteps * SEQUENCER_MIN_CELL_SIZE;
  const width = Math.max(minimumWidth, normalizeNodeDimension(size.width));
  const gridWidth = Math.max(1, width - Math.max(0, labelColumnWidth));
  return { width, height: normalizeNodeDimension(gridWidth * safeRows / safeSteps) };
}

function normalizeNodeSize(size: ScopeNodeSize): ScopeNodeSize {
  return {
    width: normalizeNodeDimension(size.width),
    height: normalizeNodeDimension(size.height),
  };
}

function normalizeNodeDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}

export function patchFromFlow(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[], areas?: EditorArea[]): Patch {
  const typedNodeIds = new Set<string>();
  const passthroughNodeIds = new Set<string>();
  const patchNodes: PatchNode[] = [];

  for (const node of nodes) {
    const patchNode = node.data.patchNode;
    if (patchNode.type === null) {
      passthroughNodeIds.add(patchNode.id);
      continue;
    }

    typedNodeIds.add(patchNode.id);
    patchNodes.push({
      id: patchNode.id,
      type: patchNode.type,
      ...(patchNode.customLabel ? { customLabel: patchNode.customLabel } : {}),
      ...(patchNode.sequencerRowLabels ? { sequencerRowLabels: [...patchNode.sequencerRowLabels] } : {}),
      ...(patchNode.sequencerRowLabelColumnWidth !== undefined ? { sequencerRowLabelColumnWidth: patchNode.sequencerRowLabelColumnWidth } : {}),
      ...(patchNode.subpatchName ? { subpatchName: patchNode.subpatchName } : {}),
      ...(patchNode.subpatchCloneId ? { subpatchCloneId: patchNode.subpatchCloneId } : {}),
      ...(patchNode.subpatchUiOverrides ? { subpatchUiOverrides: structuredClone(patchNode.subpatchUiOverrides) } : {}),
      ...(patchNode.expression !== undefined ? { expression: patchNode.expression } : {}),
      ...(patchNode.sample ? { sample: patchNode.sample } : {}),
      ...(patchNode.image ? { image: patchNode.image } : {}),
      ...(patchNode.customWave ? { customWave: normalizeCustomWave(patchNode.customWave, patchNode.params) } : {}),
      params: patchNode.params,
      position: node.position,
      ...(patchNode.scale !== undefined ? { scale: patchNode.scale } : {}),
      ...(patchNode.scopeSize ? { scopeSize: patchNode.scopeSize } : {}),
      ...(patchNode.inputs ? { inputs: patchNode.inputs } : {}),
      ...(patchNode.outputs ? { outputs: patchNode.outputs } : {}),
      ...(patchNode.subpatch ? { subpatch: patchNode.subpatch } : {}),
      ...(patchNode.compactPorts !== undefined ? { compactPorts: patchNode.compactPorts } : {}),
      ...(patchNode.enabled === false ? { enabled: false } : {}),
      ...(patchNode.spreadNodeIds ? { spreadNodeIds: [...patchNode.spreadNodeIds] } : {}),
    });
  }

  const modulationsByTarget = new Map<string, ShaderFlowEdge[]>();
  for (const edge of edges) {
    const targetId = edge.data?.modulatesEdgeId;
    if (targetId) modulationsByTarget.set(targetId, [...(modulationsByTarget.get(targetId) ?? []), edge]);
  }
  const modulationFromEdge = (edge: ShaderFlowEdge, visited: Set<string>): LinkWeightModulation | null => {
    if (visited.has(edge.id)) return null;
    const source = parseHandle(edge.sourceHandle);
    if (source?.kind !== 'out' || !typedNodeIds.has(edge.source)) return null;
    const nextVisited = new Set([...visited, edge.id]);
    const nested = (modulationsByTarget.get(edge.id) ?? [])
      .map((candidate) => modulationFromEdge(candidate, nextVisited))
      .filter((entry): entry is LinkWeightModulation => entry !== null);
    return {
      from: { node: edge.source, port: source.port },
      weight: edge.data?.weight ?? 1,
      mode: edge.data?.mode ?? 'set',
      ...(edge.data?.enabled === false ? { enabled: false } : {}),
      ...(nested.length ? { weightModulations: nested } : {}),
    };
  };
  const links = edges.flatMap((edge) => {
    const link = linkFromEdge(edge);
    if (!link) return [];
    const nested = (modulationsByTarget.get(edge.id) ?? [])
      .map((candidate) => modulationFromEdge(candidate, new Set([edge.id])))
      .filter((entry): entry is LinkWeightModulation => entry !== null);
    return [{
      ...link,
      ...(nested.length ? { weightModulations: [...(link.weightModulations ?? []), ...nested] } : {}),
    }];
  });

  return {
    nodes: patchNodes,
    links: materializeTypedLinks(links, typedNodeIds, passthroughNodeIds),
    ...(areas && areas.length > 0 ? { areas: structuredClone(areas) } : {}),
  };
}

export function edgeFromLink(
  link: PatchLink,
  onWeightChange: ShaderEdgeData['onWeightChange'],
  onModeChange: ShaderEdgeData['onModeChange'],
  onInsertNode: ShaderEdgeData['onInsertNode'],
): ShaderFlowEdge {
  return {
    id: edgeId(link),
    type: 'shaderEdge',
    source: link.from.node,
    sourceHandle: `out:${link.from.port}`,
    target: link.to.node,
    targetHandle: `in:${link.to.port}`,
    data: {
      weight: link.weight ?? 1,
      mode: link.mode ?? 'set',
      enabled: link.enabled !== false,
      weightModulations: link.weightModulations,
      onWeightChange,
      onModeChange,
      onInsertNode,
      isFeedback: link.from.node === link.to.node,
    },
    className: 'shader-edge',
  };
}

function expandWeightModulationEdges(
  edges: ShaderFlowEdge[],
  onWeightChange: ShaderEdgeData['onWeightChange'],
  onModeChange: ShaderEdgeData['onModeChange'],
  onInsertNode: ShaderEdgeData['onInsertNode'],
): ShaderFlowEdge[] {
  const expanded: ShaderFlowEdge[] = [];
  const append = (edge: ShaderFlowEdge, modulation: LinkWeightModulation, index: number) => {
    const id = `weight-modulation:${edge.id}:${index}`;
    const child: ShaderFlowEdge = {
      id,
      type: 'shaderEdge',
      source: modulation.from.node,
      sourceHandle: `out:${modulation.from.port}`,
      target: edge.target,
      targetHandle: edge.targetHandle,
      className: 'shader-edge',
      reconnectable: false,
      data: {
        weight: modulation.weight ?? 1,
        mode: modulation.mode ?? 'set',
        enabled: modulation.enabled !== false,
        modulatesEdgeId: edge.id,
        onWeightChange,
        onModeChange,
        onInsertNode,
      },
    };
    expanded.push(child);
    modulation.weightModulations?.forEach((nested, nestedIndex) => append(child, nested, nestedIndex));
  };
  for (const edge of edges) {
    expanded.push(edge.data?.weightModulations?.length
      ? { ...edge, data: { ...edge.data, weightModulations: undefined } }
      : edge);
    edge.data?.weightModulations?.forEach((modulation, index) => append(edge, modulation, index));
  }
  return dedupeEdges(expanded);
}

export function linkFromEdge(edge: Edge): PatchLink | null {
  if (edge.data?.modulatesEdgeId) return null;
  const sourcePort = parseHandle(edge.sourceHandle);
  const targetPort = parseHandle(edge.targetHandle);
  if (!sourcePort || !targetPort) return null;

  if (sourcePort.kind === 'out' && targetPort.kind === 'in') {
    return {
      from: { node: edge.source, port: sourcePort.port },
      to: { node: edge.target, port: targetPort.port },
      weight: edge.data?.weight as number | undefined,
      mode: edge.data?.mode as LinkMode | undefined,
      ...(edge.data?.enabled === false ? { enabled: false } : {}),
      ...(Array.isArray(edge.data?.weightModulations) ? { weightModulations: edge.data.weightModulations as LinkWeightModulation[] } : {}),
    };
  }

  if (sourcePort.kind === 'in' && targetPort.kind === 'out') {
    return {
      from: { node: edge.target, port: targetPort.port },
      to: { node: edge.source, port: sourcePort.port },
      weight: edge.data?.weight as number | undefined,
      mode: edge.data?.mode as LinkMode | undefined,
      ...(edge.data?.enabled === false ? { enabled: false } : {}),
      ...(Array.isArray(edge.data?.weightModulations) ? { weightModulations: edge.data.weightModulations as LinkWeightModulation[] } : {}),
    };
  }

  return null;
}

export function edgeId(link: PatchLink): string {
  return `${link.from.node}:${link.from.port}->${link.to.node}:${link.to.port}`;
}

function materializeTypedLinks(
  links: PatchLink[],
  typedNodeIds: Set<string>,
  passthroughNodeIds: Set<string>,
): PatchLink[] {
  const outgoing = new Map<string, PatchLink[]>();
  for (const link of links) {
    outgoing.set(link.from.node, [...(outgoing.get(link.from.node) ?? []), link]);
  }

  const materialized: PatchLink[] = [];
  for (const link of links) {
    if (!typedNodeIds.has(link.from.node)) continue;

    if (typedNodeIds.has(link.to.node)) {
      materialized.push(link);
      continue;
    }

    if (!passthroughNodeIds.has(link.to.node)) continue;

    for (const downstream of resolvePassthroughLinks(link.to.node, outgoing, typedNodeIds, passthroughNodeIds, new Set())) {
      if (link.from.node === downstream.to.node) continue;
      materialized.push({
        from: link.from,
        to: downstream.to,
        weight: downstream.weight,
        mode: downstream.mode,
        enabled: link.enabled !== false && downstream.enabled !== false,
        weightModulations: downstream.weightModulations,
      });
    }
  }

  return dedupePatchLinks(materialized);
}

function resolvePassthroughLinks(
  nodeId: string,
  outgoing: Map<string, PatchLink[]>,
  typedNodeIds: Set<string>,
  passthroughNodeIds: Set<string>,
  visited: Set<string>,
): PatchLink[] {
  if (visited.has(nodeId)) return [];

  const nextVisited = new Set(visited);
  nextVisited.add(nodeId);
  const resolved: PatchLink[] = [];

  for (const link of outgoing.get(nodeId) ?? []) {
    if (typedNodeIds.has(link.to.node)) {
      resolved.push(link);
      continue;
    }

    if (passthroughNodeIds.has(link.to.node)) {
      resolved.push(...resolvePassthroughLinks(link.to.node, outgoing, typedNodeIds, passthroughNodeIds, nextVisited).map((downstream) => ({
        ...downstream,
        enabled: link.enabled !== false && downstream.enabled !== false,
      })));
    }
  }

  return resolved;
}

function dedupePatchLinks(links: PatchLink[]): PatchLink[] {
  const deduped: PatchLink[] = [];
  const seen = new Set<string>();

  for (const link of links) {
    const key = edgeId(link);
    if (seen.has(key)) continue;

    seen.add(key);
    deduped.push(link);
  }

  return deduped;
}

function parseHandle(handle: string | null | undefined): { kind: 'in' | 'out'; port: string } | null {
  if (!handle) return null;
  const [kind, port] = handle.split(':');
  if ((kind !== 'in' && kind !== 'out') || !port) return null;
  return { kind, port };
}

function normalizePersistedState(state: PersistedEditorState): PersistedEditorState {
  const originalNodesById = new Map(state.nodes.map((node) => [node.id, node]));
  const passthroughNodes = state.nodes.filter((node) => node.type === null);
  const typedNodes = state.nodes
    .filter(isKnownPersistedTypedNode)
    .map((node) => ({
      id: node.id,
      type: node.type,
      ...(node.customLabel ? { customLabel: node.customLabel } : {}),
      ...(node.sequencerRowLabels ? { sequencerRowLabels: [...node.sequencerRowLabels] } : {}),
      ...(node.sequencerRowLabelColumnWidth !== undefined ? { sequencerRowLabelColumnWidth: node.sequencerRowLabelColumnWidth } : {}),
      ...(node.subpatchName ? { subpatchName: node.subpatchName } : {}),
      ...(node.subpatchCloneId ? { subpatchCloneId: node.subpatchCloneId } : {}),
      ...(node.subpatchUiOverrides ? { subpatchUiOverrides: structuredClone(node.subpatchUiOverrides) } : {}),
      ...(node.expression !== undefined ? { expression: node.expression } : {}),
      ...(node.sample ? { sample: node.sample } : {}),
      ...(node.image ? { image: node.image } : {}),
      ...(node.customWave ? { customWave: normalizeCustomWave(node.customWave, normalizePersistedNodeParams(node)) } : {}),
      params: normalizePersistedNodeParams(node),
      position: node.position,
      ...(node.scale !== undefined ? { scale: node.scale } : {}),
      ...(node.inputs ? { inputs: normalizePersistedInputDefinitions(node) } : {}),
      ...(node.outputs ? { outputs: normalizePersistedOutputDefinitions(node) } : {}),
      ...(node.subpatch ? { subpatch: normalizePatchCompatibility(node.subpatch) } : {}),
      ...(node.compactPorts !== undefined ? { compactPorts: node.compactPorts } : {}),
      ...(node.enabled === false ? { enabled: false } : {}),
      ...(node.spreadNodeIds ? { spreadNodeIds: [...node.spreadNodeIds] } : {}),
      ...(node.scopeSize ? { scopeSize: node.scopeSize } : {}),
    }));
  const typedPatch: Patch = {
    nodes: typedNodes,
    links: state.edges
      .filter((edge) => !edge.modulatesEdgeId)
      .map(patchLinkFromPersistedEdge)
      .map((link) => normalizePersistedPatchLink(link, originalNodesById))
      .filter((link): link is PatchLink => link !== null && persistedLinkPortsExist(link, originalNodesById)),
  };
  const normalizedTypedPatch = normalizePatchCompatibility(typedPatch);
  return {
    ...state,
    ui: normalizePersistedUi(state.ui),
    nodes: [
      ...normalizedTypedPatch.nodes.map((node) => persistedNodeFromPatchNode(node, originalNodesById.get(node.id))),
      ...passthroughNodes,
    ],
    edges: [
      ...normalizedTypedPatch.links.map(persistedEdgeFromPatchLink),
      ...state.edges.filter((edge) => edge.modulatesEdgeId && originalNodesById.has(edge.source)),
    ],
  };
}

function normalizePersistedUi(ui: PersistedEditorState['ui']): PersistedEditorState['ui'] {
  if (!ui) return ui;
  const selectedDeviceIds = normalizeSelectedMidiDeviceIds(ui.midiInput?.selectedDeviceIds);
  const selectedOutputDeviceIds = normalizeSelectedMidiDeviceIds(ui.midiInput?.selectedOutputDeviceIds);
  const sendClock = ui.midiInput?.sendClock === true;
  const { midiInput: _midiInput, ...nextUi } = ui;
  return {
    ...nextUi,
    ...(selectedDeviceIds.length > 0 || selectedOutputDeviceIds.length > 0 || sendClock ? { midiInput: {
      selectedDeviceIds,
      ...(selectedOutputDeviceIds.length > 0 ? { selectedOutputDeviceIds } : {}),
      ...(sendClock ? { sendClock: true } : {}),
    } } : {}),
  };
}

function normalizeSelectedMidiDeviceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
}

function isKnownPersistedTypedNode(
  node: PersistedEditorState['nodes'][number],
): node is PersistedEditorState['nodes'][number] & { type: NodeType } {
  return isKnownNodeType(node.type);
}

function isKnownNodeType(value: unknown): value is NodeType {
  if (typeof value !== 'string') return false;
  const definition = getDefinition(value as NodeType) as ReturnType<typeof getDefinition> | undefined;
  return definition?.type === value;
}

function persistedLinkPortsExist(
  link: PatchLink,
  nodesById: Map<string, PersistedEditorState['nodes'][number]>,
): boolean {
  return (
    persistedPortExists(nodesById.get(link.from.node), 'outputs', link.from.port) &&
    persistedPortExists(nodesById.get(link.to.node), 'inputs', link.to.port)
  );
}

function persistedPortExists(
  node: PersistedEditorState['nodes'][number] | undefined,
  side: 'inputs' | 'outputs',
  port: string,
): boolean {
  if (!node) return false;
  if (node.type === null) return true;
  if (!isKnownNodeType(node.type)) return false;

  return getNodeDefinition({
    id: node.id,
    type: node.type,
    params: normalizePersistedNodeParams(node),
    ...(node.inputs ? { inputs: normalizePersistedInputDefinitions(node) } : {}),
    ...(node.outputs ? { outputs: normalizePersistedOutputDefinitions(node) } : {}),
  })[side].some((entry) => entry.name === port);
}

function normalizePersistedNodeParams(node: PersistedEditorState['nodes'][number]): Record<string, number> {
  if (node.type === 'CustomWave' && node.params.phaseReset !== undefined) {
    const { phaseReset, ...params } = node.params;
    return {
      ...params,
      trigger: node.params.trigger ?? phaseReset,
    };
  }

  if (node.type !== 'SamplePlayer' || node.params.originalFrequency !== undefined || node.params.originalPitch === undefined) {
    return node.params;
  }

  const { originalPitch, ...params } = node.params;
  return {
    ...params,
    originalFrequency: midiNoteFrequency(originalPitch),
  };
}

function normalizePersistedInputDefinitions(
  node: PersistedEditorState['nodes'][number],
): PortDefinition[] | undefined {
  if (node.type === 'CustomWave') {
    return node.inputs?.map((input) => (
      input.name === 'phaseReset' ? { ...input, name: 'trigger' } : input
    ));
  }

  if (node.type !== 'SamplePlayer') return node.inputs;
  return node.inputs?.map((input) => (
    input.name === 'originalPitch'
      ? { ...input, name: 'originalFrequency', defaultValue: input.defaultValue === 60 ? 440 : input.defaultValue }
      : input
  ));
}

function normalizePersistedOutputDefinitions(
  node: PersistedEditorState['nodes'][number],
): PortDefinition[] | undefined {
  if (node.type === 'CustomWave') {
    // Custom Wave outputs are derived from its count parameter. Old saved
    // explicit `signal` ports must not prevent a multi-wave node from growing.
    return undefined;
  }
  if (node.type !== 'Reverb') return node.outputs;
  const outputs = node.outputs?.filter((output) => output.name !== 'signal');
  return outputs && outputs.length > 0 ? outputs : undefined;
}

function normalizePersistedPatchLink(
  link: PatchLink | null,
  nodesById: Map<string, PersistedEditorState['nodes'][number]>,
): PatchLink | null {
  if (!link) return null;
  const sourceNode = nodesById.get(link.from.node);
  if (sourceNode?.type === 'Reverb' && link.from.port === 'signal') {
    return {
      ...link,
      from: {
        ...link.from,
        port: 'left',
      },
    };
  }

  const targetNode = nodesById.get(link.to.node);
  if (targetNode?.type === 'CustomWave' && link.to.port === 'phaseReset') {
    return {
      ...link,
      to: {
        ...link.to,
        port: 'trigger',
      },
    };
  }

  if (targetNode?.type === 'Sequencer' && link.to.port === 'tick') {
    return {
      ...link,
      to: {
        ...link.to,
        port: 'signal',
      },
    };
  }

  if (targetNode?.type !== 'SamplePlayer' || link.to.port !== 'originalPitch') return link;
  return {
    ...link,
    to: {
      ...link.to,
      port: 'originalFrequency',
    },
  };
}

function midiNoteFrequency(note: number): number {
  return 440 * (2 ** ((note - 69) / 12));
}

function patchLinkFromPersistedEdge(edge: PersistedEditorState['edges'][number]): PatchLink | null {
  const sourcePort = parseHandle(edge.sourceHandle);
  const targetPort = parseHandle(edge.targetHandle);
  if (!sourcePort || !targetPort || sourcePort.kind !== 'out' || targetPort.kind !== 'in') return null;
  return {
    from: { node: edge.source, port: sourcePort.port },
    to: { node: edge.target, port: targetPort.port },
    ...(edge.weight !== undefined ? { weight: edge.weight } : {}),
    ...(edge.mode !== undefined ? { mode: edge.mode } : {}),
    ...(edge.enabled === false ? { enabled: false } : {}),
    ...(edge.weightModulations ? { weightModulations: edge.weightModulations } : {}),
  };
}

function persistedNodeFromPatchNode(
  node: PatchNode,
  original?: PersistedEditorState['nodes'][number],
): PersistedEditorState['nodes'][number] {
  return {
    id: node.id,
    type: node.type,
    customLabel: node.customLabel,
    sequencerRowLabels: node.sequencerRowLabels,
    sequencerRowLabelColumnWidth: node.sequencerRowLabelColumnWidth,
    subpatchName: node.subpatchName,
    subpatchCloneId: node.subpatchCloneId,
    subpatchUiOverrides: node.subpatchUiOverrides,
    expression: node.expression,
    sample: node.sample,
    image: node.image,
    customWave: node.customWave,
    params: node.params,
    position: node.position ?? original?.position ?? { x: 0, y: 0 },
    scale: node.scale ?? original?.scale,
    inputs: node.inputs,
    outputs: node.outputs,
    subpatch: node.subpatch,
    compactPorts: node.compactPorts ?? original?.compactPorts,
    enabled: node.enabled,
    spreadNodeIds: node.spreadNodeIds ?? original?.spreadNodeIds,
    scopeSize: node.scopeSize ?? original?.scopeSize,
  };
}

function persistedEdgeFromPatchLink(link: PatchLink): PersistedEditorState['edges'][number] {
  return {
    id: edgeId(link),
    source: link.from.node,
    sourceHandle: `out:${link.from.port}`,
    target: link.to.node,
    targetHandle: `in:${link.to.port}`,
    weight: link.weight ?? 1,
    mode: link.mode ?? 'set',
    ...(link.enabled === false ? { enabled: false } : {}),
    ...(link.weightModulations?.length ? { weightModulations: link.weightModulations } : {}),
  };
}

export function dedupeEdges(edges: ShaderFlowEdge[]): ShaderFlowEdge[] {
  const deduped: ShaderFlowEdge[] = [];
  const seen = new Map<string, ShaderFlowEdge>();
  const aliases = new Map<string, string>();
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const identity = (edge: ShaderFlowEdge, visited = new Set<string>()): string => {
    const parent = edge.data?.modulatesEdgeId ? byId.get(edge.data.modulatesEdgeId) : undefined;
    if (!parent || visited.has(edge.id)) return linkFromEdge(edge) ? edgeId(linkFromEdge(edge)!) : edge.id;
    return JSON.stringify([edge.source, edge.sourceHandle, identity(parent, new Set([...visited, edge.id]))]);
  };
  for (const edge of edges) {
    const link = linkFromEdge(edge);
    const key = identity(edge);
    const existing = seen.get(key);
    if (existing) {
      aliases.set(edge.id, existing.id);
      if (edge.selected) existing.selected = true;
      continue;
    }
    const next = { ...edge, id: link ? edgeId(link) : edge.id };
    aliases.set(edge.id, next.id);
    seen.set(key, next);
    deduped.push(next);
  }
  return deduped.map((edge) => edge.data?.modulatesEdgeId
    ? { ...edge, data: { ...edge.data, modulatesEdgeId: aliases.get(edge.data.modulatesEdgeId) ?? edge.data.modulatesEdgeId } }
    : edge);
}
