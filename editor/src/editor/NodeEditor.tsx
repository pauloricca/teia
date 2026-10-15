import { useSyncExternalStore } from 'react';
import { HostedSession } from '../hosted/session';
import { useHostedAudio } from '../hosted/useHostedAudio';
import { HostedModeContext } from '../hosted/HostedModeContext';
import { preparePatch } from '../hosted/compiler';
import { withParameterIds, cloneParameterIds, retainNestedBufferReferences } from '../hosted/document';
import type { AudioEngineState } from '../audio/useAudioEngine';
import { parsePatchJson, normalizeSelectedMidiDeviceIds, expressionInputDefinitions, syncParamsToInputs, isRecord, isNodeType, isNumberRecord, isSampleAsset, isImageAsset } from '../graph/parse';
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Connection,
  ConnectionMode,
  ControlButton,
  Controls,
  EdgeChange,
  HandleType,
  NodeChange,
  OnConnectEnd,
  OnConnectStartParams,
  type ReactFlowProps,
  Position,
  ReactFlow,
  ReactFlowInstance,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  Viewport,
  useNodesInitialized,
  useStoreApi,
  type CoordinateExtent,
} from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent, type FocusEvent as ReactFocusEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { DSP_OP, compilePatchToDspProgram, type DspProgram } from '../audio/dspProgram';
import { Fm1ModeContext } from './Fm1ModeContext';
import { useFm1LiveEdit } from '../audio/useFm1LiveEdit';
import { Fm1UploadDialog } from './Fm1UploadDialog';
import { createPatchPackage } from '../audio/patchPackage';
import {
  loadBufferSnapshot,
  removeUnreferencedBufferContents,
  storeBufferAssetData,
  storeBufferSnapshot,
} from '../audio/bufferStorage';
import { useAudioEngine, type BufferCopy, type BufferSnapshot, type LinkMeterReading, type MidiControlChange, type MidiInputState, type ScopeCaptureRequest } from '../audio/useAudioEngine';
import { normalizeCustomWave } from '../graph/customWave';
import { demoPatch } from '../graph/demoPatch';
import { extractExpressionInputs } from '../graph/expression';
import { defaultParamsFor, getDefinition, getNodeDefinition, rollShape, sequencerShape } from '../graph/nodeTypes';
import { normalizePatchCompatibility } from '../graph/patchCompatibility';
import { patchToJson } from '../graph/serialize';
import {
  DEFAULT_SPAWN_SIZE,
  DEFAULT_SPREAD_SIZE,
  MIN_RUNTIME_CONTAINER_WIDTH,
  MIN_SPAWN_WIDTH,
  SPAWN_PORTS_HEIGHT,
  SPREAD_PORTS_HEIGHT,
  runtimeContainerPortsHeight,
  runtimeContainerSize,
  spreadCloneNodeId,
} from '../graph/spread';
import type { BufferAsset, CustomWaveSettings, ImageAsset, LinkMode, NodeType, Patch, PatchLink, PatchNode, PortDefinition, SampleAsset } from '../graph/types';
import { EdgeOverlayProvider } from './EdgeOverlayContext';
import { canvasHeaderTitleScale, USER_ZOOM_BASELINE } from './canvasZoom';
import { scopedDspNodeId } from './dspNodeScope';
import {
  edgeFromLink,
  dedupeEdges,
  edgeId,
  clampControlNodeSize,
  clampCustomWaveNodeSize,
  clampImageNodeSize,
  clampKeysNodeSize,
  clampSequencerNodeSize,
  clampScopeNodeSize,
  DEFAULT_CUSTOM_WAVE_NODE_SIZE,
  DEFAULT_FFT_NODE_SIZE,
  DEFAULT_JOYSTICK_NODE_SIZE,
  DEFAULT_KEYS_NODE_SIZE,
  DEFAULT_SEQUENCER_NODE_SIZE,
  DEFAULT_SCOPE_NODE_SIZE,
  SEQUENCER_MIN_CELL_SIZE,
  editorStateToFlowEdges,
  editorStateToFlowNodes,
  flowToEditorState,
  linkFromEdge,
  patchFromFlow,
  type PersistedEditorState,
  type EditorArea,
  type ScopeNodeSize,
  type ShaderFlowEdge,
  type ShaderFlowNode,
  type ShaderNodeData,
  toFlowEdges,
  toFlowNodes,
} from './flowPatch';
import { getShaderEdgePath, ShaderEdge, VirtualRouteEdge } from './ShaderEdge';
import { makeNodeId, routingNodeColor, ShaderNode } from './ShaderNode';

const nodeTypes = { shaderNode: ShaderNode };
const edgeTypes = { shaderEdge: ShaderEdge, virtualRoute: VirtualRouteEdge };
const STORAGE_KEY = 'teia.editor-state.v1';
const VIEWPORT_STORAGE_KEY = 'teia.viewport.v1';
const HISTORY_LIMIT = 100;
const DRAFT_NODE_PREVIEW_ID = '__draft_node_preview__';
const DUPLICATE_NODE_PREVIEW_PREFIX = '__duplicate_node_preview__:';
const DUPLICATE_AREA_PREVIEW_PREFIX = '__duplicate_area_preview__:';
const COMPACT_NODE_Z_INDEX = 0;
const EXPANDED_NODE_Z_INDEX = 1;
const SELECTED_NODE_Z_INDEX = 2;
const SELECTED_EDGE_Z_INDEX = 10000;
const DEFAULT_FIT_VIEW_PADDING = 0.2;
const MIN_CANVAS_ZOOM = 0.05;
const ZOOM_RESET_TARGET = USER_ZOOM_BASELINE;
const ZOOM_SETTLE_THRESHOLD = USER_ZOOM_BASELINE * 0.1;
const ZOOM_CHANGE_EPSILON = 0.0001;
const GRAPH_DETAIL_ZOOM_SETTLE_MS = 80;
const BUFFER_CHECKPOINT_INTERVAL_MS = 5000;
const PASTE_OFFSET = { x: 36, y: 36 };
const DRAFT_NODE_WIDTH = 168;
const DRAFT_NODE_HANDLE_X_OFFSET = 13;
const DRAFT_NODE_FIRST_PORT_Y = 52;
const DEFAULT_EXPRESSION = 'a';
const FLOW_INFINITE_EXTENT: CoordinateExtent = [[Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY], [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY]];
const MAX_EMPTY_SCREEN_RATIO = 0.7;
const DEFAULT_NODE_BOUNDS_SIZE = { width: 240, height: 96 };
const NODE_HEADER_HEIGHT = 32;
const DSP_ERROR_PANEL_LIMIT = 4;
const FIT_VIEW_OPTIONS = { padding: DEFAULT_FIT_VIEW_PADDING };
const CONNECTION_LINE_COLORS: Record<LinkMode, string> = {
  set: 'var(--color-link-set)',
  add: 'var(--color-link-add)',
  multiply: 'var(--color-link-multiply)',
  bend: 'var(--color-link-bend)',
};
const DELETE_KEY_CODES = ['Backspace', 'Delete'];
const MULTI_SELECTION_KEY_CODES = ['Meta', 'Shift'];
const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };

let subpatchCloneSequence = 0;

type GraphSnapshot = Pick<PersistedEditorState, 'nodes' | 'edges' | 'areas'>;
type HistoryState = { past: GraphSnapshot[]; future: GraphSnapshot[] };

interface DraftNodeConnection {
  originNodeId: string;
  originHandleId: string;
  originHandleType: HandleType;
  pointer: { x: number; y: number };
  modifierActive: boolean;
  mode: LinkMode;
}

interface DuplicateDragState {
  nodeIds: Set<string>;
  originalPositions: Record<string, { x: number; y: number }>;
  currentPositions: Record<string, { x: number; y: number }>;
  duplicating: boolean;
  linkExternal: boolean;
}

interface NodeDragSelectionSnapshot {
  nodeId: string;
  preserveSelection: boolean;
  nodeSelection: Record<string, boolean>;
  edgeSelection: Record<string, boolean>;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface AreaDrawState {
  start: ScreenPoint;
  current: ScreenPoint;
}

interface AreaDragState {
  areaId: string;
  start: ScreenPoint;
  captureTarget: HTMLElement;
  areaPositions: Record<string, { x: number; y: number }>;
  nodePositions: Record<string, { x: number; y: number }>;
  currentAreaPositions: Record<string, { x: number; y: number }>;
  currentNodePositions: Record<string, { x: number; y: number }>;
  duplicating: boolean;
  linkExternal: boolean;
  historyCommitted: boolean;
}

interface AreaResizeState {
  areaId: string;
  start: ScreenPoint;
  corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  originalPosition: { x: number; y: number };
  originalSize: { width: number; height: number };
  historyCommitted: boolean;
}

interface AreaUiResizeState {
  areaId: string;
  start: ScreenPoint;
  originalUiHeight: number;
  historyCommitted: boolean;
}

interface SubpatchEditFrame {
  groupId: string;
  parentNodes: ShaderFlowNode[];
  parentEdges: ShaderFlowEdge[];
  parentAreas: EditorArea[];
  parentPatchName: string;
  parentHistory: HistoryState;
}

interface BoundaryPortSelection {
  nodeId: string;
  side: 'input' | 'output';
  port: string;
}

interface DspEditorDiagnostics {
  nodeErrors: Map<string, string[]>;
  edgeErrors: Map<string, string[]>;
  globalErrors: string[];
}

interface LocalPatchVersion {
  id: string;
  savedAt: string;
}

interface LocalPatchEntry {
  name: string;
  versionCount: number;
  versions: LocalPatchVersion[];
}

interface LocalPatchLibraryState {
  patches: LocalPatchEntry[];
  selectedPatchName: string | null;
  selectedVersionId: string | null;
  loading: boolean;
  error: string | null;
}

interface SampleLibraryState {
  nodeId: string;
  samples: SampleAsset[];
  selectedUrl: string | null;
  loading: boolean;
  error: string | null;
}

interface BufferSamplePromptState {
  nodeId: string;
  name: string;
}

type SampleRecordingStatus = 'idle' | 'requesting' | 'recording' | 'processing' | 'naming' | 'saving';

interface SampleRecordingState {
  status: SampleRecordingStatus;
  blob: Blob | null;
  extension: string;
  elapsedSeconds: number;
  name: string;
}

const IDLE_SAMPLE_RECORDING: SampleRecordingState = {
  status: 'idle',
  blob: null,
  extension: '.wav',
  elapsedSeconds: 0,
  name: 'recording',
};

interface ImageLibraryState {
  nodeId: string;
  images: ImageAsset[];
  selectedUrl: string | null;
  loading: boolean;
  error: string | null;
}

interface ImportedSubpatchCandidate {
  key: string;
  name: string;
  path: string;
  subpatch: Patch;
  inputCount: number;
  outputCount: number;
  nodeCount: number;
}

interface SubpatchImportModalState {
  fileName: string;
  candidates: ImportedSubpatchCandidate[];
  selectedKey: string | null;
  error: string | null;
}

interface LocalSubpatchImportSource {
  key: string;
  patchName: string;
  versionId: string;
  savedAt: string;
  candidate: ImportedSubpatchCandidate;
}

interface LocalSubpatchImportEntry {
  name: string;
  sources: LocalSubpatchImportSource[];
}

interface LocalSubpatchImportState {
  subpatches: LocalSubpatchImportEntry[];
  selectedSubpatchName: string | null;
  selectedSourceKey: string | null;
  loading: boolean;
  error: string | null;
}

interface MidiControlVisualState {
  sliderValue?: number;
  joystickX?: number;
  joystickY?: number;
  buttonPressed?: number;
  lastRawValue?: number;
}

interface CopiedGraph {
  nodes: ShaderFlowNode[];
  edges: ShaderFlowEdge[];
}

export function NodeEditor({ hosted }: { hosted?: HostedSession } = {}) {
  return <ReactFlowProvider>{hosted
    ? <HostedEditorInner key={hosted.sessionId} hosted={hosted} />
    : <StandaloneEditorInner />}</ReactFlowProvider>;
}
function StandaloneEditorInner() {
  const [options, setOptions] = useState({});
  const audio = useAudioEngine(options);
  return <NodeEditorInner audio={audio} onAudioOptions={setOptions} />;
}
function HostedEditorInner({ hosted }: { hosted: HostedSession }) {
  const audio = useHostedAudio(hosted);
  const capabilities = useMemo(() => ({ ...hosted.capabilities, assets: hosted.bridge.assets }), [hosted]);
  return <HostedModeContext.Provider value={capabilities}><NodeEditorInner audio={audio} hosted={hosted} /></HostedModeContext.Provider>;
}
function NodeEditorInner({ audio, hosted, onAudioOptions }: { audio: AudioEngineState; hosted?: HostedSession; onAudioOptions?: (options: { selectedMidiInputDeviceIds: string[]; selectedMidiOutputDeviceIds: string[]; midiClockOutputEnabled: boolean; recordingPatchName: string }) => void }) {
  // Backend and initial source are chosen at construction, before device/storage hooks.
  const hostedState = useSyncExternalStore(hosted?.subscribe ?? emptySubscribe, hosted?.getSnapshot ?? emptySnapshot, hosted?.getSnapshot ?? emptySnapshot);
  const flowStore = useStoreApi();
  const nodesInitialized = useNodesInitialized();
  const initialState = useMemo(() => {
    if (!hosted) return loadInitialEditorState();
    const document = hosted.getDocument();
    const callbacks = nodeCallbacksPlaceholder();
    const state = flowToEditorState(toFlowNodes(document, callbacks, null), toFlowEdges(document, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder), { patchName: document.name ?? 'hosted patch', ...(document.midiInput ? { midiInput: document.midiInput } : {}) });
    state.areas = document.areas;
    state.buffers = document.buffers;
    return state;
  }, []);
  const storedViewport = useMemo(() => hosted ? null : loadStoredViewport(), []);
  const initialViewport = useMemo(
    () => storedViewport ?? initialState?.ui?.viewport ?? { x: 0, y: 0, zoom: USER_ZOOM_BASELINE },
    [initialState, storedViewport],
  );
  const [patchName, setPatchName] = useState(initialState?.ui?.patchName ?? 'single-patch');
  // React Flow owns the live viewport transform. React state only receives a
  // settled snapshot so pan/zoom frames do not rerender and serialize the full patch.
  const [settledViewport, setSettledViewport] = useState<Viewport>(initialViewport);
  const [fullscreenScopeId, setFullscreenScopeId] = useState<string | null>(null);
  useEffect(() => {
    const updateFullscreenScope = () => {
      setFullscreenScopeId(document.fullscreenElement?.getAttribute('data-fullscreen-scope-id') ?? null);
    };
    updateFullscreenScope();
    document.addEventListener('fullscreenchange', updateFullscreenScope);
    return () => document.removeEventListener('fullscreenchange', updateFullscreenScope);
  }, []);

  const viewportRef = useRef<Viewport>(initialViewport);
  const [canvasLocked, setCanvasLocked] = useState(false);
  const [settledGraphZoom, setSettledGraphZoom] = useState(initialViewport.zoom);
  const [editorSize, setEditorSize] = useState({ width: 0, height: 0 });
  const [editingTypeNodeId, setEditingTypeNodeId] = useState<string | null>(null);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge> | null>(null);
  const [edgeOverlayElement, setEdgeOverlayElement] = useState<HTMLElement | null>(null);
  const [nodes, setNodes] = useState<ShaderFlowNode[]>(() => {
    const callbacks = nodeCallbacksPlaceholder();
    return initialState
      ? editorStateToFlowNodes(initialState, callbacks, null)
      : toFlowNodes(demoPatch, callbacks, null);
  });
  const [areas, setAreas] = useState<EditorArea[]>(() => initialState?.areas ?? []);
  const [nodeStackOrder, setNodeStackOrder] = useState<string[]>(() => nodes.map((node) => node.id));
  const [edges, setEdges] = useState<ShaderFlowEdge[]>(() => {
    return initialState
      ? editorStateToFlowEdges(initialState, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder)
      : toFlowEdges(demoPatch, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder);
  });
  const [weightTargetEdgeId, setWeightTargetEdgeId] = useState<string | null>(null);
  const [reconnectingEdgeId, setReconnectingEdgeId] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryState>({ past: [], future: [] });
  const zoomInteractionRef = useRef({ zoomChanged: false, lastZoom: initialViewport.zoom });

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setSettledGraphZoom(settledViewport.zoom);
    }, GRAPH_DETAIL_ZOOM_SETTLE_MS);
    return () => window.clearTimeout(timeout);
  }, [settledViewport.zoom]);
  const nodesRef = useRef(nodes);
  // React Flow gives us a new nodes array for every drag frame. Keep the
  // presentation objects for unaffected nodes referentially stable so the
  // memoized node components do not render just because another node moved.
  const nodePresentationCacheRef = useRef<ShaderFlowNode[]>([]);
  // Live visual data is attached in a later pass. It needs its own cache: the
  // audio payload object is replaced frequently even when a particular node's
  // displayed value did not change.
  const renderedNodeCacheRef = useRef<ShaderFlowNode[]>([]);
  const areasRef = useRef(areas);
  const edgesRef = useRef(edges);
  const weightTargetEdgeIdRef = useRef<string | null>(null);
  const editorShellRef = useRef<HTMLElement | null>(null);
  const historyGroupRef = useRef<{ key: string; time: number } | null>(null);
  const draftNodeConnectionRef = useRef<DraftNodeConnection | null>(null);
  const provisionalNodeIdsRef = useRef(new Set<string>());
  const duplicateDragRef = useRef<DuplicateDragState | null>(null);
  const pendingNodeDragChangesRef = useRef<Map<string, NodeChange<ShaderFlowNode>>>(new Map());
  const nodeDragAnimationFrameRef = useRef<number | null>(null);
  const pendingNodeDragSelectionRef = useRef<NodeDragSelectionSnapshot | null>(null);
  const activeNodeDragSelectionRef = useRef<NodeDragSelectionSnapshot | null>(null);
  const routingAppendicesRef = useRef<Array<{
    id: string;
    ownerId: string;
    offset: { x: number; y: number };
  }>>([]);
  const selectionDragStartRef = useRef<ScreenPoint | null>(null);
  const canvasDragPointerRef = useRef<ScreenPoint | null>(null);
  const canvasDragActiveRef = useRef(false);
  const canvasDragPointerIdRef = useRef<number | null>(null);
  const ignoreSyntheticSelectionPointerDownRef = useRef(false);
  const ignoreSyntheticSelectionPointerUpRef = useRef(false);
  const areaDrawRef = useRef<AreaDrawState | null>(null);
  const areaDragRef = useRef<AreaDragState | null>(null);
  const areaResizeRef = useRef<AreaResizeState | null>(null);
  const areaUiResizeRef = useRef<AreaUiResizeState | null>(null);
  const pendingBoundaryPortRef = useRef<BoundaryPortSelection | null>(null);
  const [draftNodeConnection, setDraftNodeConnection] = useState<DraftNodeConnection | null>(null);
  const [temporarilyRevealedNodeId, setTemporarilyRevealedNodeId] = useState<string | null>(null);
  const [duplicateDrag, setDuplicateDrag] = useState<DuplicateDragState | null>(null);
  const [areaDuplicateDrag, setAreaDuplicateDrag] = useState<AreaDragState | null>(null);
  const [editingStack, setEditingStack] = useState<SubpatchEditFrame[]>([]);
  const [pendingBoundaryPort, setPendingBoundaryPort] = useState<BoundaryPortSelection | null>(null);
  const [selectedBoundaryPort, setSelectedBoundaryPort] = useState<BoundaryPortSelection | null>(null);
  const [newPatchConfirmationOpen, setNewPatchConfirmationOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const fm1BusyRef = useRef(false);
  const [fm1Mode, setFm1Mode] = useState(() => !hosted && initialState?.ui?.fm1Mode === true);
  const [fm1Live, setFm1Live] = useState(false);
  const [fm1Preset, setFm1Preset] = useState(1);
  const [fm1Patch, setFm1Patch] = useState<Patch | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [saveFeedbackActive, setSaveFeedbackActive] = useState(false);
  const [localPatchLibrary, setLocalPatchLibrary] = useState<LocalPatchLibraryState | null>(null);
  const [sampleLibrary, setSampleLibrary] = useState<SampleLibraryState | null>(null);
  const [bufferSamplePrompt, setBufferSamplePrompt] = useState<BufferSamplePromptState | null>(null);
  const [sampleRecording, setSampleRecording] = useState<SampleRecordingState>(IDLE_SAMPLE_RECORDING);
  const [imageLibrary, setImageLibrary] = useState<ImageLibraryState | null>(null);
  const [subpatchImportModal, setSubpatchImportModal] = useState<SubpatchImportModalState | null>(null);
  const [localSubpatchImport, setLocalSubpatchImport] = useState<LocalSubpatchImportState | null>(null);
  const [midiSettingsOpen, setMidiSettingsOpen] = useState(false);
  const [selectedMidiInputDeviceIds, setSelectedMidiInputDeviceIds] = useState<string[]>(() => (
    normalizeSelectedMidiDeviceIds(initialState?.ui?.midiInput?.selectedDeviceIds)
  ));
  const [selectedMidiOutputDeviceIds, setSelectedMidiOutputDeviceIds] = useState<string[]>(() => (
    normalizeSelectedMidiDeviceIds(initialState?.ui?.midiInput?.selectedOutputDeviceIds)
  ));
  const [midiClockOutputEnabled, setMidiClockOutputEnabled] = useState(() => initialState?.ui?.midiInput?.sendClock === true);
  const [midiControlVisuals, setMidiControlVisuals] = useState<Record<string, MidiControlVisualState>>({});
  const midiControlVisualsRef = useRef<Record<string, MidiControlVisualState>>({});
  const [bufferAssets, setBufferAssets] = useState<Record<string, BufferAsset>>(() => initialState?.buffers ?? {});
  const copiedGraphRef = useRef<CopiedGraph | null>(null);
  const pasteCountRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importFileInputRef = useRef<HTMLInputElement | null>(null);
  const sampleFileInputRef = useRef<HTMLInputElement | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSampleUploadNodeIdRef = useRef<string | null>(null);
  const bufferSamplePromptResolverRef = useRef<((name: string | null) => void) | null>(null);
  const sampleRecorderRef = useRef<MediaRecorder | null>(null);
  const sampleRecordingStreamRef = useRef<MediaStream | null>(null);
  const sampleRecordingChunksRef = useRef<Blob[]>([]);
  const sampleRecordingCancelledRef = useRef(false);
  const sampleRecordingStartedAtRef = useRef(0);
  const sampleRecordingTimerRef = useRef<number | null>(null);
  const sampleRecordingSessionIdRef = useRef(0);
  const pendingImageUploadNodeIdRef = useRef<string | null>(null);
  const saveFeedbackTimeoutRef = useRef<number | null>(null);
  const bufferAssetsRef = useRef(bufferAssets);
  const bufferCheckpointRef = useRef<Promise<Record<string, BufferAsset>> | null>(null);
  const bufferLoadGenerationRef = useRef(0);
  const persistedEditorStateJsonRef = useRef<string | null>(null);
  const selectedLocalPatchOptionRef = useRef<HTMLButtonElement | null>(null);
  const reconnectingEdgeRef = useRef(false);
  const reconnectFixedHandleRef = useRef<HandleType | null>(null);
  const reconnectCompletedRef = useRef(false);
  const reconnectCancelledRef = useRef(false);
  const nodeConnectionCompletedRef = useRef(false);
  const reconnectDuplicateRef = useRef(false);
  const reconnectingEdgeSnapshotRef = useRef<ShaderFlowEdge | null>(null);
  const rootPatchName = editingStack[0]?.parentPatchName ?? patchName;
  useEffect(() => {
    onAudioOptions?.({ selectedMidiInputDeviceIds, selectedMidiOutputDeviceIds, midiClockOutputEnabled, recordingPatchName: rootPatchName });
  }, [onAudioOptions, selectedMidiInputDeviceIds, selectedMidiOutputDeviceIds, midiClockOutputEnabled, rootPatchName]);

  useEffect(() => {
    bufferAssetsRef.current = bufferAssets;
  }, [bufferAssets]);

  const replaceBufferAssets = useCallback((assets: Record<string, BufferAsset>) => {
    bufferAssetsRef.current = assets;
    setBufferAssets(assets);
  }, []);

  const clearBufferRecording = useCallback((nodeId: string) => {
    if (hosted) { void hosted.mutateBuffer('clear', nodeId).then(applied => { if (!applied) setImportError('The host did not acknowledge clearing the Buffer.'); }); return; }
    audio.clearBuffer(nodeId);
    bufferLoadGenerationRef.current += 1;
    if (!bufferAssetsRef.current[nodeId]) return;
    const nextAssets = { ...bufferAssetsRef.current };
    delete nextAssets[nodeId];
    replaceBufferAssets(nextAssets);
    void removeUnreferencedBufferContents(Object.values(nextAssets).map((asset) => asset.hash));
  }, [audio.clearBuffer, replaceBufferAssets]);

  const restoreBufferAssets = useCallback(async (assets: Record<string, BufferAsset>) => {
    if (hosted) { replaceBufferAssets(assets); return; }
    const generation = bufferLoadGenerationRef.current + 1;
    bufferLoadGenerationRef.current = generation;
    replaceBufferAssets(assets);
    audio.restoreBuffers({});

    const snapshots: Record<string, BufferSnapshot> = {};
    await Promise.all(Object.entries(assets).map(async ([nodeId, asset]) => {
      let snapshot = await loadBufferSnapshot(asset);
      if (!snapshot) {
        const data = await fetchLocalBufferContent(asset.hash);
        await storeBufferAssetData(asset, data);
        snapshot = { samples: new Float32Array(data), sampleRate: asset.sampleRate };
      }
      snapshots[nodeId] = snapshot;
    }));
    if (bufferLoadGenerationRef.current !== generation) return;
    audio.restoreBuffers(snapshots);
    await removeUnreferencedBufferContents(Object.values(assets).map((asset) => asset.hash));
  }, [audio.restoreBuffers, replaceBufferAssets]);

  useEffect(() => {
    if (Object.keys(bufferAssetsRef.current).length === 0) return;
    void restoreBufferAssets(bufferAssetsRef.current).catch((error) => {
      setImportError(error instanceof Error ? error.message : String(error));
    });
  }, [restoreBufferAssets]);

  const requestBufferSampleName = useCallback((nodeId: string, defaultName: string): Promise<string | null> => {
    bufferSamplePromptResolverRef.current?.(null);
    return new Promise((resolve) => {
      bufferSamplePromptResolverRef.current = resolve;
      setBufferSamplePrompt({ nodeId, name: defaultName });
    });
  }, []);

  const answerBufferSamplePrompt = useCallback((useBufferContent: boolean) => {
    const resolver = bufferSamplePromptResolverRef.current;
    bufferSamplePromptResolverRef.current = null;
    const name = useBufferContent ? bufferSamplePrompt?.name.trim() || null : null;
    setBufferSamplePrompt(null);
    resolver?.(name);
  }, [bufferSamplePrompt]);

  useEffect(() => () => {
    bufferSamplePromptResolverRef.current?.(null);
    bufferSamplePromptResolverRef.current = null;
  }, []);
  const selectedMidiInputDeviceKey = useMemo(() => selectedMidiInputDeviceIds.join('\n'), [selectedMidiInputDeviceIds]);
  const audioPlaybackActive = audio.status === 'running' || audio.status === 'starting';
  const cpuLoad = audio.status === 'running' ? Math.min(1, audio.cpuLoad) : 0;
  const cpuPercentage = Math.round((audio.status === 'running' ? audio.cpuLoad : 0) * 100);
  const cpuDetails = [
    audio.status === 'running' ? `Audio CPU: ${cpuPercentage}%` : 'Audio CPU: stopped',
    `Render mode: ${audio.rendering.mode}${audio.rendering.workers ? ` (${audio.rendering.workers} helper threads)` : ''}`,
    ...(audio.rendering.mode === 'multi' ? [`${audio.rendering.parallelRepeats} eligible Spread/Spawn templates (parallel above each template's workload threshold)`] : []),
    `Peak block: ${Math.round(audio.cpuPeakLoad * 100)}%; missed deadlines: ${audio.cpuDeadlineMisses}`,
    ...(audio.rendering.reason ? [`Fallback: ${audio.rendering.reason}`] : []),
  ].join('\n');
  const audioRecordingActive = audio.recording.status === 'waiting' || audio.recording.status === 'recording';
  const recordingButtonLabel = audioRecordingActive
    ? formatRecordingTimestamp(audio.recording.elapsedSeconds)
    : 'REC';
  const localPatchStorageEnabled = useMemo(() => !hosted && canUseLocalPatchStorage(), []);
  const [reconnectPreviewEdge, setReconnectPreviewEdge] = useState<ShaderFlowEdge | null>(null);
  const [areaDraw, setAreaDraw] = useState<AreaDrawState | null>(null);
  const [resumedSelectionDraw, setResumedSelectionDraw] = useState<AreaDrawState | null>(null);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [surfacedAreaId, setSurfacedAreaId] = useState<string | null>(null);
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null);
  const areaTitleInputRef = useRef<HTMLInputElement | null>(null);
  const areaTitlePointerStartRef = useRef<ScreenPoint | null>(null);

  useEffect(() => {
    if (!editingAreaId) return;
    const animationFrame = requestAnimationFrame(() => {
      areaTitleInputRef.current?.focus();
      areaTitleInputRef.current?.select();
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [editingAreaId]);

  const toggleAudioPlayback = useCallback(() => {
    if (hosted) { void hosted.toggleTransport(); return; }
    if (fm1Mode) { setFm1Live(current => current ? false : !fm1BusyRef.current); return; }
    if (audioPlaybackActive) {
      audio.stop();
      return;
    }
    void audio.start();
  }, [fm1Mode, audioPlaybackActive, audio.start, audio.stop]);

  const toggleAudioRecording = useCallback(() => {
    if (hosted) { setImportError('Recording is owned by the host.'); return; }
    if (audioRecordingActive) {
      audio.stopRecording();
      return;
    }
    audio.startRecording();
  }, [audio.startRecording, audio.stopRecording, audioRecordingActive]);

  const toggleMidiInputDevice = useCallback((deviceId: string, selected: boolean) => {
    setSelectedMidiInputDeviceIds((current) => {
      if (selected) {
        return current.includes(deviceId) ? current : [...current, deviceId];
      }
      return current.filter((entry) => entry !== deviceId);
    });
    if (selected) {
      void audio.refreshMidiInputDevices();
    }
  }, [audio.refreshMidiInputDevices]);

  const toggleMidiOutputDevice = useCallback((deviceId: string, selected: boolean) => {
    setSelectedMidiOutputDeviceIds((current) => selected
      ? (current.includes(deviceId) ? current : [...current, deviceId])
      : current.filter((entry) => entry !== deviceId));
    if (selected) void audio.refreshMidiInputDevices();
  }, [audio.refreshMidiInputDevices]);

  const toggleMidiClockOutput = useCallback((enabled: boolean) => {
    setMidiClockOutputEnabled(enabled);
    if (enabled) void audio.refreshMidiInputDevices();
  }, [audio.refreshMidiInputDevices]);

  useEffect(() => {
    if (selectedMidiInputDeviceIds.length === 0 && selectedMidiOutputDeviceIds.length === 0 && !midiClockOutputEnabled) return;
    void audio.refreshMidiInputDevices();
  }, [audio.refreshMidiInputDevices, midiClockOutputEnabled, selectedMidiInputDeviceIds.length, selectedMidiInputDeviceKey, selectedMidiOutputDeviceIds.length]);

  useEffect(() => {
    const controlChange = audio.midiInput.lastControlChange;
    if (!controlChange) return;
    const previousVisuals = midiControlVisualsRef.current;
    const nextVisuals = midiControlVisualsForChange(previousVisuals, nodesRef.current, edgesRef.current, controlChange);
    midiControlVisualsRef.current = nextVisuals;
    setMidiControlVisuals(nextVisuals);
    setNodes((current) => applyMidiControlChangeToNodes(current, edgesRef.current, controlChange, previousVisuals, nextVisuals));
  }, [audio.midiInput.lastControlChange]);

  useEffect(() => {
    const handlePlaybackKeyDown = (event: KeyboardEvent) => {
      if (event.key !== ' ' || event.repeat) return;
      if (hosted && !hosted.capabilities.transport) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableEventTarget(event.target) && !isPlaybackShortcutControlEventTarget(event.target)) return;

      event.preventDefault();
      toggleAudioPlayback();
    };

    window.addEventListener('keydown', handlePlaybackKeyDown);
    return () => window.removeEventListener('keydown', handlePlaybackKeyDown);
  }, [toggleAudioPlayback]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    midiControlVisualsRef.current = midiControlVisuals;
  }, [midiControlVisuals]);

  useEffect(() => {
    areasRef.current = areas;
    setNodes((current) => {
      let changed = false;
      const next = current.map((node) => {
        if (node.data.patchNode.type !== 'Spread' && node.data.patchNode.type !== 'Spawn') return node;
        const area = areas.find((candidate) => candidate.kind === 'spread' && candidate.spreadNodeId === node.id);
        const spreadNodeIds = area?.locked ? [...(area.nodeIds ?? [])] : undefined;
        if (optionalStringArraysEqual(node.data.patchNode.spreadNodeIds, spreadNodeIds)) return node;
        changed = true;
        return {
          ...node,
          data: {
            ...node.data,
            patchNode: { ...node.data.patchNode, spreadNodeIds },
          },
        };
      });
      return changed ? next : current;
    });
  }, [areas]);

  useEffect(() => {
    setAreas((current) => reconcileSpreadAreas(current, nodesRef.current));
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    const element = editorShellRef.current;
    if (!element) return;

    const updateEditorSize = () => {
      const rect = element.getBoundingClientRect();
      setEditorSize((current) => {
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (current.width === width && current.height === height) return current;
        return { width, height };
      });
    };

    updateEditorSize();
    const observer = new ResizeObserver(updateEditorSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    pendingBoundaryPortRef.current = pendingBoundaryPort;
  }, [pendingBoundaryPort]);

  const updateDraftNodeConnection = useCallback((
    value: DraftNodeConnection | null | ((current: DraftNodeConnection | null) => DraftNodeConnection | null),
  ) => {
    const next = typeof value === 'function' ? value(draftNodeConnectionRef.current) : value;
    draftNodeConnectionRef.current = next;
    setDraftNodeConnection(next);
  }, []);

  const updateDuplicateDrag = useCallback((
    value: DuplicateDragState | null | ((current: DuplicateDragState | null) => DuplicateDragState | null),
  ) => {
    const next = typeof value === 'function' ? value(duplicateDragRef.current) : value;
    duplicateDragRef.current = next;
    setDuplicateDrag(next);
  }, []);

  const commitHistory = useCallback((groupKey?: string) => {
    const now = Date.now();
    const lastGroup = historyGroupRef.current;
    if (groupKey && lastGroup?.key === groupKey && now - lastGroup.time < 800) {
      historyGroupRef.current = { key: groupKey, time: now };
      return;
    }

    const snapshot = graphSnapshot(nodesRef.current, edgesRef.current, areasRef.current);
    const snapshotKey = graphSnapshotKey(snapshot);
    setHistory((current) => {
      const lastSnapshot = current.past[current.past.length - 1];
      if (lastSnapshot && graphSnapshotKey(lastSnapshot) === snapshotKey) return current;
      return {
        past: [...current.past, snapshot].slice(-HISTORY_LIMIT),
        future: [],
      };
    });
    historyGroupRef.current = groupKey ? { key: groupKey, time: now } : null;
  }, []);

  const [hostedTransient, setHostedTransient] = useState<Record<string, Record<string, number>>>({});
  const sendHostedGesture = useCallback((nodeId: string, type: string | null, values: Record<string, number>) => {
    if (!hosted?.capabilities.gestures || hosted.capabilities.bridgeVersion !== 2) return false;
    const ports = type === 'Button' ? ['pressed', 'clicks'] : type === 'Keys' ? ['note', 'frequency', 'gate', 'velocity'] : [];
    if (!Object.keys(values).length || !Object.keys(values).every(port => ports.includes(port))) return false;
    hosted.gesture(nodeId, values);
    setHostedTransient(current => ({ ...current, [nodeId]: { ...current[nodeId], ...values } }));
    return true;
  }, [hosted]);
  useEffect(() => {
    if (!hosted?.capabilities.gestures) return;
    const release = () => { hosted.releaseGestures('focus loss'); setHostedTransient({}); };
    const hidden = () => { if (document.hidden) release(); };
    window.addEventListener('blur', release); document.addEventListener('visibilitychange', hidden);
    return () => { window.removeEventListener('blur', release); document.removeEventListener('visibilitychange', hidden); release(); };
  }, [hosted]);
  useEffect(() => { setHostedTransient({}); }, [hostedState?.generation, hostedState?.connected]);

  const updateNodeParam = useCallback((nodeId: string, port: string, value: number) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (sendHostedGesture(scopedDspNodeId(nodeId, editingStack.map(frame => frame.groupId)), relatedNode?.data.patchNode.type ?? null, { [port]: value })) return;
    commitHistory(`param:${nodeId}:${port}`);
    if (relatedNode?.data.patchNode.type === 'Joystick') {
      const clearX = port === 'xMidiChannel' || port === 'xMidiCc';
      const clearY = port === 'yMidiChannel' || port === 'yMidiCc';
      if (clearX || clearY) {
        setMidiControlVisuals((current) => {
          const next = clearJoystickMidiVisual(current, nodeId, clearX, clearY);
          midiControlVisualsRef.current = next;
          return next;
        });
      }
    }
    if (
      (relatedNode?.data.patchNode.type === 'Slider' && port === 'value')
      || (relatedNode?.data.patchNode.type === 'Button' && (port === 'pressed' || port === 'clicks'))
    ) {
      const controlType = relatedNode?.data.patchNode.type === 'Slider' ? 'Slider' : 'Button';
      setMidiControlVisuals((current) => {
        const next = clearMidiControlVisual(current, nodeId, controlType);
        midiControlVisualsRef.current = next;
        return next;
      });
    }
    const nextPatchNode = relatedNode?.data.patchNode.type === 'Sequencer'
      ? {
          ...relatedNode.data.patchNode,
          params: { ...relatedNode.data.patchNode.params, [port]: value },
        }
      : null;
    const nextPatternScopeSize = relatedNode && (
      port === 'steps'
      || (relatedNode.data.patchNode.type === 'Sequencer' && port === 'rows')
      || (relatedNode.data.patchNode.type === 'Roll' && ['scale', 'middle note', 'range down', 'range up'].includes(port))
    )
      ? resizedPatternScopeSize(relatedNode.data.patchNode as PatchNode, { ...relatedNode.data.patchNode.params, [port]: value })
      : undefined;
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              params: { ...node.data.patchNode.params, [port]: value },
              ...(nextPatternScopeSize ? { scopeSize: nextPatternScopeSize } : {}),
              outputs: node.data.patchNode.type === 'Ins' || node.data.patchNode.type === 'Params'
                ? setPortDefaultValue(node.data.patchNode.outputs, port, value)
                : node.data.patchNode.outputs,
            },
          },
        }
      : node,
    ));
    if (nextPatchNode) {
      const nextDefinition = getNodeDefinition(nextPatchNode as PatchNode);
      setEdges((current) => dedupeEdges(current.flatMap((edge) => {
        const link = linkFromEdge(edge);
        if (!link || link.from.node !== nodeId) return [edge];
        return nextDefinition.outputs.some((output) => output.name === link.from.port) ? [edge] : [];
      })));
    }
  }, [commitHistory, sendHostedGesture, editingStack]);

  const updateNodeParams = useCallback((nodeId: string, values: Record<string, number>) => {
    if (Object.keys(values).length === 0) return;
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (sendHostedGesture(scopedDspNodeId(nodeId, editingStack.map(frame => frame.groupId)), relatedNode?.data.patchNode.type ?? null, values)) return;
    commitHistory(`params:${nodeId}`);
    if (relatedNode?.data.patchNode.type === 'Joystick') {
      const clearX = Object.hasOwn(values, 'x');
      const clearY = Object.hasOwn(values, 'y');
      if (clearX || clearY) {
        setMidiControlVisuals((current) => {
          const next = clearJoystickMidiVisual(current, nodeId, clearX, clearY);
          midiControlVisualsRef.current = next;
          return next;
        });
      }
    }
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              params: { ...node.data.patchNode.params, ...values },
            },
          },
        }
      : node));
  }, [commitHistory, sendHostedGesture, editingStack]);

  const updateNodeCustomWave = useCallback((nodeId: string, customWave: CustomWaveSettings, historyKey?: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'CustomWave') return;

    commitHistory(historyKey ?? `custom-wave:${nodeId}`);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              customWave: normalizeCustomWave(customWave),
            },
          },
        }
      : node,
    ));
  }, [commitHistory]);

  const updateExpression = useCallback((nodeId: string, expression: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'Expression') return;

    const inputs = expressionInputDefinitions(expression);
    const nextParams = syncParamsToInputs(relatedNode.data.patchNode.params, inputs);
    const previousInputs = relatedNode.data.patchNode.inputs ?? [];
    const inputsChanged = !samePortDefinitions(previousInputs, inputs);
    if (
      relatedNode.data.patchNode.expression === expression &&
      !inputsChanged
    ) {
      return;
    }

    commitHistory(`expression:${nodeId}`);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              expression,
              inputs,
              params: nextParams,
            },
          },
        }
      : node,
    ));

    if (inputsChanged) {
      const nextInputNames = new Set(inputs.map((input) => input.name));
      setEdges((current) => current.filter((edge) => {
        const link = linkFromEdge(edge);
        return !link || link.to.node !== nodeId || nextInputNames.has(link.to.port);
      }));
    }
  }, [commitHistory]);

  const updateGroupSubpatchName = useCallback((nodeId: string, requestedName: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'Group') return;

    const nextName = normalizeSubpatchName(requestedName, relatedNode.data.patchNode.subpatchName ?? nodeId);
    if (nextName === relatedNode.data.patchNode.subpatchName) return;

    const cloneId = relatedNode.data.patchNode.subpatchCloneId;
    commitHistory(`subpatch-name:${nodeId}`);
    setNodes((current) => current.map((node) => {
      const isLinkedGroup = node.id === nodeId || (
        node.data.patchNode.type === 'Group' &&
        cloneId !== undefined &&
        node.data.patchNode.subpatchCloneId === cloneId
      );
      if (!isLinkedGroup) return node;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            subpatchName: nextName,
          },
        },
      };
    }));
  }, [commitHistory]);

  const updateNodeSample = useCallback((nodeId: string, sample: SampleAsset) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'SamplePlayer') return;

    commitHistory(`sample:${nodeId}`);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              sample,
            },
          },
        }
      : node,
    ));
  }, [commitHistory]);

  const updateNodeImage = useCallback((nodeId: string, image: ImageAsset) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'Image') return;
    commitHistory(`image:${nodeId}`);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? { ...node, data: { ...node.data, patchNode: { ...node.data.patchNode, image } } }
      : node));
  }, [commitHistory]);

  const resetSampleRecording = useCallback(() => {
    sampleRecordingSessionIdRef.current += 1;
    sampleRecordingCancelledRef.current = true;
    if (sampleRecordingTimerRef.current !== null) {
      window.clearInterval(sampleRecordingTimerRef.current);
      sampleRecordingTimerRef.current = null;
    }
    const recorder = sampleRecorderRef.current;
    sampleRecorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
    }
    sampleRecordingStreamRef.current?.getTracks().forEach((track) => track.stop());
    sampleRecordingStreamRef.current = null;
    sampleRecordingChunksRef.current = [];
    sampleRecordingStartedAtRef.current = 0;
    setSampleRecording(IDLE_SAMPLE_RECORDING);
  }, []);

  useEffect(() => resetSampleRecording, [resetSampleRecording]);

  const startSampleRecording = useCallback(async () => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    if (!sampleLibrary || sampleRecording.status !== 'idle') return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setSampleLibrary((current) => current ? { ...current, error: 'Microphone recording is not supported by this browser.' } : current);
      return;
    }

    sampleRecordingCancelledRef.current = false;
    const recordingSessionId = sampleRecordingSessionIdRef.current + 1;
    sampleRecordingSessionIdRef.current = recordingSessionId;
    setSampleRecording((current) => ({ ...current, status: 'requesting', elapsedSeconds: 0 }));
    setSampleLibrary((current) => current ? { ...current, error: null } : current);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (sampleRecordingCancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      const recordingFormat = preferredSampleRecordingFormat();
      const recorder = recordingFormat.mimeType
        ? new MediaRecorder(stream, { mimeType: recordingFormat.mimeType })
        : new MediaRecorder(stream);
      sampleRecordingStreamRef.current = stream;
      sampleRecorderRef.current = recorder;
      sampleRecordingChunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) sampleRecordingChunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        resetSampleRecording();
        setSampleLibrary((current) => current ? { ...current, error: 'Microphone recording failed.' } : current);
      };
      recorder.onstop = async () => {
        if (sampleRecordingTimerRef.current !== null) {
          window.clearInterval(sampleRecordingTimerRef.current);
          sampleRecordingTimerRef.current = null;
        }
        stream.getTracks().forEach((track) => track.stop());
        sampleRecordingStreamRef.current = null;
        sampleRecorderRef.current = null;
        if (sampleRecordingCancelledRef.current) return;

        const chunks = sampleRecordingChunksRef.current;
        sampleRecordingChunksRef.current = [];
        const recordedBlob = new Blob(chunks, { type: recorder.mimeType || recordingFormat.mimeType || 'audio/webm' });
        if (recordedBlob.size === 0) {
          setSampleRecording(IDLE_SAMPLE_RECORDING);
          setSampleLibrary((current) => current ? { ...current, error: 'The microphone recording was empty.' } : current);
          return;
        }
        try {
          const wavBlob = await convertRecordedAudioToWav(recordedBlob);
          if (sampleRecordingCancelledRef.current || sampleRecordingSessionIdRef.current !== recordingSessionId) return;
          setSampleRecording((current) => ({
            ...current,
            status: 'naming',
            blob: wavBlob,
            extension: '.wav',
            name: 'recording',
          }));
        } catch (error) {
          if (sampleRecordingCancelledRef.current || sampleRecordingSessionIdRef.current !== recordingSessionId) return;
          setSampleRecording(IDLE_SAMPLE_RECORDING);
          const message = error instanceof Error ? error.message : 'Could not convert the microphone recording to WAV.';
          setSampleLibrary((current) => current ? { ...current, error: message } : current);
        }
      };

      recorder.start(250);
      sampleRecordingStartedAtRef.current = performance.now();
      sampleRecordingTimerRef.current = window.setInterval(() => {
        setSampleRecording((current) => ({
          ...current,
          elapsedSeconds: Math.floor((performance.now() - sampleRecordingStartedAtRef.current) / 1000),
        }));
      }, 250);
      setSampleRecording((current) => ({ ...current, status: 'recording', extension: '.wav' }));
    } catch (error) {
      resetSampleRecording();
      const message = error instanceof DOMException && error.name === 'NotAllowedError'
        ? 'Microphone permission was denied.'
        : error instanceof Error ? error.message : 'Could not access the microphone.';
      setSampleLibrary((current) => current ? { ...current, error: message } : current);
    }
  }, [resetSampleRecording, sampleLibrary, sampleRecording.status]);

  const stopSampleRecording = useCallback(() => {
    const recorder = sampleRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    setSampleRecording((current) => ({ ...current, status: 'processing' }));
    recorder.stop();
  }, []);

  const openSampleLibrary = useCallback(async (nodeId: string) => {
    if (hosted) {
      const select = hosted.bridge.assets?.selectMedia;
      if (!select) { setImportError('Media selection requires a supplied host asset adapter.'); return; }
      try {
        const current = nodesRef.current.find(node => node.id === nodeId)?.data.patchNode.sample;
        const asset = await hosted.selectMedia({ kind: 'sample', nodeId, current });
        if (asset) updateNodeSample(nodeId, asset);
      } catch (error) { setImportError(String(error)); }
      return;
    }
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'SamplePlayer') return;

    resetSampleRecording();
    const currentSample = relatedNode.data.patchNode.sample ?? null;
    setSampleLibrary({
      nodeId,
      samples: currentSample ? [currentSample] : [],
      selectedUrl: currentSample?.url ?? null,
      loading: true,
      error: null,
    });

    try {
      const samples = await fetchLocalSampleLibrary();
      const visibleSamples = currentSample && !samples.some((sample) => sample.url === currentSample.url)
        ? [currentSample, ...samples]
        : samples;
      setSampleLibrary((current) => current && current.nodeId === nodeId ? {
        ...current,
        samples: visibleSamples,
        selectedUrl: current.selectedUrl ?? visibleSamples[0]?.url ?? null,
        loading: false,
        error: visibleSamples.length === 0 ? 'No samples found in samples/.' : null,
      } : current);
      setImportError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSampleLibrary((current) => current && current.nodeId === nodeId ? {
        ...current,
        samples: currentSample ? [currentSample] : [],
        loading: false,
        error: message,
      } : current);
      setImportError(message);
    }
  }, [resetSampleRecording]);

  const closeSampleLibrary = useCallback(() => {
    resetSampleRecording();
    setSampleLibrary(null);
  }, [resetSampleRecording]);

  const selectSampleFromLibrary = useCallback((sample: SampleAsset) => {
    if (!sampleLibrary) return;
    updateNodeSample(sampleLibrary.nodeId, sample);
    setSampleLibrary(null);
    setImportError(null);
  }, [sampleLibrary, updateNodeSample]);

  const requestSampleUpload = useCallback((nodeId: string) => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    pendingSampleUploadNodeIdRef.current = nodeId;
    sampleFileInputRef.current?.click();
  }, []);

  const requestSampleUploadFromLibrary = useCallback(() => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    if (!sampleLibrary) return;
    requestSampleUpload(sampleLibrary.nodeId);
  }, [requestSampleUpload, sampleLibrary]);

  const uploadSampleForNode = useCallback(async (nodeId: string, file: File) => {
    if (hosted) { setImportError('Media editing requires a supplied host asset adapter.'); return; }
    if (!file || !nodeId) return false;

    try {
      setSampleLibrary((current) => current && current.nodeId === nodeId ? { ...current, loading: true, error: null } : current);
      const sample = await uploadLocalSample(file);
      updateNodeSample(nodeId, sample);
      setSampleLibrary((current) => current && current.nodeId === nodeId ? null : current);
      setImportError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSampleLibrary((current) => current && current.nodeId === nodeId ? { ...current, loading: false, error: message } : current);
      setImportError(message);
      return false;
    }
  }, [updateNodeSample]);

  const saveSampleRecording = useCallback(async () => {
    if (!sampleLibrary || sampleRecording.status !== 'naming' || !sampleRecording.blob) return;
    const trimmedName = sampleRecording.name.trim();
    if (!trimmedName) {
      setSampleLibrary((current) => current ? { ...current, error: 'Enter a name for the recording.' } : current);
      return;
    }

    setSampleRecording((current) => ({ ...current, status: 'saving' }));
    const fileName = sampleRecordingFileName(trimmedName, sampleRecording.extension);
    const file = new File([sampleRecording.blob], fileName, { type: sampleRecording.blob.type });
    const saved = await uploadSampleForNode(sampleLibrary.nodeId, file);
    if (!saved) setSampleRecording((current) => ({ ...current, status: 'naming' }));
  }, [sampleLibrary, sampleRecording, uploadSampleForNode]);

  const uploadDroppedSampleFiles = useCallback((nodeId: string, files: FileList) => {
    if (hosted) { setImportError('Media editing requires a supplied host asset adapter.'); return; }
    const file = files[0];
    if (!file) return;
    void uploadSampleForNode(nodeId, file);
  }, [uploadSampleForNode]);

  const uploadSampleFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const nodeId = pendingSampleUploadNodeIdRef.current;
    pendingSampleUploadNodeIdRef.current = null;
    if (!file || !nodeId) return;

    await uploadSampleForNode(nodeId, file);
  }, [uploadSampleForNode]);

  const handleSampleLibraryDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!sampleLibrary || !hasDraggedFiles(event)) return;

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }, [sampleLibrary]);

  const handleSampleLibraryDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!sampleLibrary || event.dataTransfer.files.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    uploadDroppedSampleFiles(sampleLibrary.nodeId, event.dataTransfer.files);
  }, [sampleLibrary, uploadDroppedSampleFiles]);

  const openImageLibrary = useCallback(async (nodeId: string) => {
    if (hosted) {
      const select = hosted.bridge.assets?.selectMedia;
      if (!select) { setImportError('Media selection requires a supplied host asset adapter.'); return; }
      try {
        const current = nodesRef.current.find(node => node.id === nodeId)?.data.patchNode.image;
        const asset = await hosted.selectMedia({ kind: 'image', nodeId, current });
        if (asset) updateNodeImage(nodeId, asset);
      } catch (error) { setImportError(String(error)); }
      return;
    }
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'Image') return;
    const currentImage = relatedNode.data.patchNode.image ?? null;
    setImageLibrary({ nodeId, images: currentImage ? [currentImage] : [], selectedUrl: currentImage?.url ?? null, loading: true, error: null });
    try {
      const images = await fetchLocalImageLibrary();
      const visibleImages = currentImage && !images.some((image) => image.url === currentImage.url) ? [currentImage, ...images] : images;
      setImageLibrary((current) => current && current.nodeId === nodeId ? {
        ...current,
        images: visibleImages,
        selectedUrl: current.selectedUrl ?? visibleImages[0]?.url ?? null,
        loading: false,
        error: visibleImages.length === 0 ? 'No images found in images/.' : null,
      } : current);
      setImportError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImageLibrary((current) => current && current.nodeId === nodeId ? { ...current, images: currentImage ? [currentImage] : [], loading: false, error: message } : current);
      setImportError(message);
    }
  }, []);

  const requestImageUpload = useCallback((nodeId: string) => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    pendingImageUploadNodeIdRef.current = nodeId;
    imageFileInputRef.current?.click();
  }, []);

  const uploadImageForNode = useCallback(async (nodeId: string, file: File) => {
    if (hosted) { setImportError('Media editing requires a supplied host asset adapter.'); return; }
    if (!file || !nodeId) return;
    try {
      setImageLibrary((current) => current && current.nodeId === nodeId ? { ...current, loading: true, error: null } : current);
      const formData = new FormData();
      formData.append('image', file);
      const response = await fetch('/api/local-images', { method: 'POST', body: formData });
      if (!response.ok) throw new Error(await response.text() || `Image upload failed (${response.status}).`);
      const payload = await response.json() as unknown;
      if (!isRecord(payload) || typeof payload.name !== 'string' || typeof payload.url !== 'string') throw new Error('Image upload returned an invalid response.');
      updateNodeImage(nodeId, { name: payload.name, url: payload.url });
      setImageLibrary((current) => current && current.nodeId === nodeId ? null : current);
      setImportError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setImageLibrary((current) => current && current.nodeId === nodeId ? { ...current, loading: false, error: message } : current);
      setImportError(message);
    }
  }, [updateNodeImage]);

  const uploadImageFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    if (hosted) { setImportError('Media editing requires a supplied host asset adapter.'); return; }
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const nodeId = pendingImageUploadNodeIdRef.current;
    pendingImageUploadNodeIdRef.current = null;
    if (file && nodeId) await uploadImageForNode(nodeId, file);
  }, [uploadImageForNode]);

  const handleImageLibraryDragOver = useCallback((event: DragEvent<HTMLElement>) => {
    if (!imageLibrary || !hasDraggedFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }, [imageLibrary]);

  const handleImageLibraryDrop = useCallback((event: DragEvent<HTMLElement>) => {
    if (!imageLibrary || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void uploadImageForNode(imageLibrary.nodeId, event.dataTransfer.files[0]);
  }, [imageLibrary, uploadImageForNode]);

  const selectImageFromLibrary = useCallback((image: ImageAsset) => {
    if (!imageLibrary) return;
    updateNodeImage(imageLibrary.nodeId, image);
    setImageLibrary(null);
    setImportError(null);
  }, [imageLibrary, updateNodeImage]);

  const requestImageUploadFromLibrary = useCallback(() => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    if (imageLibrary) requestImageUpload(imageLibrary.nodeId);
  }, [imageLibrary, requestImageUpload]);

  const updateEdgeWeight = useCallback((edgeIdToUpdate: string, weight: number) => {
    commitHistory(`weight:${edgeIdToUpdate}`);
    setEdges((current) => current.map((edge) => edge.id === edgeIdToUpdate
      ? {
          ...edge,
          data: {
            ...edge.data,
            weight,
            mode: edge.data?.mode ?? 'set',
            enabled: edge.data?.enabled !== false,
            onWeightChange: updateEdgeWeightPlaceholder,
            onModeChange: updateEdgeModePlaceholder,
            onInsertNode: insertNodeOnEdgePlaceholder,
          },
        }
      : edge,
    ));
  }, [commitHistory]);

  const updateEdgeMode = useCallback((edgeIdToUpdate: string, mode: LinkMode) => {
    commitHistory(`mode:${edgeIdToUpdate}`);
    setEdges((current) => current.map((edge) => edge.id === edgeIdToUpdate
      ? {
          ...edge,
          data: {
            ...edge.data,
            weight: edge.data?.weight ?? 1,
            mode,
            enabled: edge.data?.enabled !== false,
            onWeightChange: updateEdgeWeightPlaceholder,
            onModeChange: updateEdgeModePlaceholder,
            onInsertNode: insertNodeOnEdgePlaceholder,
          },
        }
      : edge,
    ));
  }, [commitHistory]);

  const updateEdgeEnabled = useCallback((edgeIdToUpdate: string, enabled: boolean) => {
    commitHistory();
    setEdges((current) => current.map((edge) => edge.id === edgeIdToUpdate
      ? {
          ...edge,
          data: {
            ...edge.data,
            weight: edge.data?.weight ?? 1,
            mode: edge.data?.mode ?? 'set',
            enabled,
            onWeightChange: updateEdgeWeightPlaceholder,
            onModeChange: updateEdgeModePlaceholder,
            onInsertNode: insertNodeOnEdgePlaceholder,
          },
        }
      : edge,
    ));
  }, [commitHistory]);

  const toggleSelectedEdges = useCallback(() => {
    const selectedEdgeIds = new Set(
      edgesRef.current.filter((edge) => edge.selected === true).map((edge) => edge.id),
    );
    if (selectedEdgeIds.size === 0) return false;

    commitHistory();
    setEdges((current) => current.map((edge) => (
      selectedEdgeIds.has(edge.id)
        ? {
            ...edge,
            data: {
              ...edge.data,
              weight: edge.data?.weight ?? 1,
              mode: edge.data?.mode ?? 'set',
              enabled: edge.data?.enabled === false,
              onWeightChange: updateEdgeWeightPlaceholder,
              onModeChange: updateEdgeModePlaceholder,
              onInsertNode: insertNodeOnEdgePlaceholder,
            },
          }
        : edge
    )));
    return true;
  }, [commitHistory]);

  const setSelectedEdgesMode = useCallback((mode: LinkMode) => {
    const selectedEdgeIds = new Set(
      edgesRef.current
        .filter((edge) => edge.selected === true && (edge.data?.mode ?? 'set') !== mode)
        .map((edge) => edge.id),
    );
    if (selectedEdgeIds.size === 0) return false;

    commitHistory(`mode:${mode}`);
    setEdges((current) => current.map((edge) => (
      selectedEdgeIds.has(edge.id)
        ? {
            ...edge,
            data: {
              ...edge.data,
              weight: edge.data?.weight ?? 1,
              mode,
              enabled: edge.data?.enabled !== false,
              onWeightChange: updateEdgeWeightPlaceholder,
              onModeChange: updateEdgeModePlaceholder,
              onInsertNode: insertNodeOnEdgePlaceholder,
            },
          }
        : edge
    )));
    return true;
  }, [commitHistory]);

  const updateNodeId = useCallback((nodeId: string, requestedId: string) => {
    const nextId = uniqueNodeId(requestedId, nodeId, nodesRef.current);
    if (!nextId || nextId === nodeId) return;

    commitHistory();
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          id: nextId,
          data: {
            ...node.data,
            patchNode: { ...node.data.patchNode, id: nextId },
          },
        }
      : node,
    ));
    setEdges((current) => transformEdgeTree(current, (edge) => renameEdgeNode(edge, nodeId, nextId)));
    setEditingTypeNodeId((current) => current === nodeId ? nextId : current);
  }, [commitHistory]);

  const updateNodeType = useCallback(async (nodeId: string, type: NodeType) => {
    let relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode) return;

    let convertedBufferSample: SampleAsset | undefined;
    if (relatedNode.data.patchNode.type === 'Buffer' && type === 'SamplePlayer') {
      if (hosted) { setImportError('Buffer to Sample conversion requires a host media conversion adapter.'); return; }
      const dspNodeId = runtimeDspNodeIdForFlowNode(
        relatedNode,
        nodesRef.current,
        editingStack.map((frame) => frame.groupId),
      );
      const snapshot = await audio.captureBuffer(dspNodeId);
      relatedNode = nodesRef.current.find((node) => node.id === nodeId);
      if (!relatedNode || relatedNode.data.patchNode.type !== 'Buffer') return;

      if (!snapshot && bufferVisualizationContainsAudio(audio.buffers[dspNodeId])) {
        setImportError('The recorded Buffer could not be read, so it was kept unchanged. Try switching it to Sample again.');
        return;
      }

      if (snapshot && bufferContainsAudio(snapshot.samples)) {
        const requestedName = await requestBufferSampleName(
          nodeId,
          relatedNode.data.patchNode.customLabel?.trim() || `${nodeId}-buffer`,
        );
        relatedNode = nodesRef.current.find((node) => node.id === nodeId);
        if (!relatedNode || relatedNode.data.patchNode.type !== 'Buffer') return;

        if (requestedName === null) {
          convertedBufferSample = undefined;
        } else {
          try {
            const wav = encodeMonoSamplesAsWav(snapshot.samples, snapshot.sampleRate);
            const file = new File([wav], sampleRecordingFileName(requestedName, '.wav'), { type: 'audio/wav' });
            convertedBufferSample = await uploadLocalSample(file);
            relatedNode = nodesRef.current.find((node) => node.id === nodeId);
            if (!relatedNode || relatedNode.data.patchNode.type !== 'Buffer') return;
            setImportError(null);
          } catch (error) {
            setImportError(error instanceof Error ? error.message : String(error));
            return;
          }
        }
      }
    }

    provisionalNodeIdsRef.current.delete(nodeId);

    const previousDefinition = relatedNode.data.patchNode.type
      ? getNodeDefinition(relatedNode.data.patchNode as PatchNode)
      : null;
    const nextId = shouldAutoRenameForTypeChange(nodeId, relatedNode.data.patchNode.type)
      ? nextTypeNodeId(nodeId, type, nodesRef.current)
      : nodeId;
    const expression = type === 'Expression' ? DEFAULT_EXPRESSION : undefined;
    const expressionInputs = expression ? expressionInputDefinitions(expression) : undefined;
    const nextDefinition = expressionInputs
      ? { ...getDefinition(type), inputs: expressionInputs }
      : getDefinition(type);
    const groupPatchNode = type === 'Group'
      ? {
          id: nextId,
          type: 'Group' as const,
          params: {},
          position: relatedNode.position,
          inputs: [] as PortDefinition[],
          outputs: [] as PortDefinition[],
        }
      : null;
    const groupSubpatch = groupPatchNode ? emptySubpatchForGroup(groupPatchNode, relatedNode.position) : undefined;
    const nextParams = expressionInputs
      ? syncParamsToInputs({}, expressionInputs)
      : defaultParamsFor(type);

    previousDefinition?.inputs.forEach((input) => {
      const nextInput = nextDefinition.inputs.find((candidate) => candidate.name === input.name);
      if (!nextInput) return;
      const previousValue = relatedNode.data.patchNode.params[input.name];
      if (previousValue !== undefined) nextParams[nextInput.name] = previousValue;
    });

    commitHistory();
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          id: nextId,
          data: {
            ...node.data,
            patchNode: {
              id: nextId,
              type,
              ...(node.data.patchNode.customLabel ? { customLabel: node.data.patchNode.customLabel } : {}),
              ...(type === 'Group' ? {
                subpatchName: node.data.patchNode.subpatchName ?? nextId,
                subpatchCloneId: node.data.patchNode.subpatchCloneId ?? makeSubpatchCloneId(nextId),
                inputs: [] as PortDefinition[],
                outputs: [] as PortDefinition[],
                subpatch: groupSubpatch,
              } : {}),
              ...(expression !== undefined ? { expression } : {}),
              ...(type === 'CustomWave' ? {
                customWave: normalizeCustomWave(node.data.patchNode.customWave, node.data.patchNode.params),
              } : {}),
              ...(type === 'SamplePlayer' && convertedBufferSample ? { sample: convertedBufferSample } : {}),
              ...((type === 'Spread' || type === 'Spawn') ? {
                scopeSize: { ...(type === 'Spawn' ? DEFAULT_SPAWN_SIZE : DEFAULT_SPREAD_SIZE) },
              } : {}),
              params: nextParams,
              position: node.position,
              ...(expressionInputs ? { inputs: expressionInputs } : {}),
            },
          },
        }
      : node,
    ));
    setEdges((current) => transformEdgeTree(current, (edge) => {
      const renamed = renameEdgeNode(edge, nodeId, nextId);
      return remapEdgeForNodeType(renamed, nextId, previousDefinition, nextDefinition);
    }));
    setAreas((current) => {
      const withoutPreviousSpread = current.filter((area) => area.spreadNodeId !== nodeId);
      if (type !== 'Spread' && type !== 'Spawn') return withoutPreviousSpread;
      return [...withoutPreviousSpread, spreadAreaForNode({
        ...relatedNode,
        id: nextId,
        data: {
          ...relatedNode.data,
          patchNode: {
            ...relatedNode.data.patchNode,
            id: nextId,
            type,
            scopeSize: { ...(type === 'Spawn' ? DEFAULT_SPAWN_SIZE : DEFAULT_SPREAD_SIZE) },
          },
        },
      })];
    });
    setEditingTypeNodeId((current) => current === nodeId ? nextId : current);
  }, [audio, commitHistory, editingStack, requestBufferSampleName]);

  const convertNodeToArea = useCallback((nodeId: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode) return;

    const nodeSize = viewportNodeSize(relatedNode);
    const areaId = `area-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

    provisionalNodeIdsRef.current.delete(nodeId);
    commitHistory();
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setAreas((current) => [...current, {
      id: areaId,
      title: 'Area',
      position: { ...relatedNode.position },
      size: {
        width: Math.max(48, nodeSize.width),
        height: Math.max(48, nodeSize.height),
      },
    }]);
    setEditingTypeNodeId(null);
    setSelectedAreaId(areaId);
    setSurfacedAreaId(areaId);
  }, [commitHistory]);

  const updateNodeCustomLabel = useCallback((nodeId: string, requestedLabel: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode) return;

    const customLabel = requestedLabel.trim();
    if ((relatedNode.data.patchNode.customLabel ?? '') === customLabel) return;

    commitHistory(`label:${nodeId}`);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              ...(customLabel ? { customLabel } : { customLabel: undefined }),
            },
          },
        }
      : node,
    ));
  }, [commitHistory]);

  const updateSequencerRowLabels = useCallback((nodeId: string, labels: string[]) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'Sequencer') return;
    const sequencerRowLabels = [...labels];
    const sequencerRowLabelColumnWidth = rowLabelColumnWidth(sequencerRowLabels);
    if (
      JSON.stringify(relatedNode.data.patchNode.sequencerRowLabels ?? []) === JSON.stringify(sequencerRowLabels)
      && relatedNode.data.patchNode.sequencerRowLabelColumnWidth === sequencerRowLabelColumnWidth
    ) return;

    const shape = sequencerShape(relatedNode.data.patchNode.params);
    const currentSize = clampSequencerNodeSize(
      relatedNode.data.patchNode.scopeSize ?? DEFAULT_SEQUENCER_NODE_SIZE,
      shape.steps,
      shape.rows,
      relatedNode.data.patchNode.sequencerRowLabelColumnWidth ?? 0,
    );
    const nextSize = clampSequencerNodeSize({
      width: currentSize.width + sequencerRowLabelColumnWidth - (relatedNode.data.patchNode.sequencerRowLabelColumnWidth ?? 0),
      height: currentSize.height,
    }, shape.steps, shape.rows, sequencerRowLabelColumnWidth);

    commitHistory(`sequencer-row-labels:${nodeId}`);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              sequencerRowLabels,
              sequencerRowLabelColumnWidth,
              scopeSize: nextSize,
            },
          },
        }
      : node,
    ));
  }, [commitHistory]);

  const updateBoundaryPortName = useCallback((nodeId: string, side: 'input' | 'output', port: string, requestedPort: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, side)) return;

    const ports = side === 'input'
      ? relatedNode.data.patchNode.inputs ?? []
      : relatedNode.data.patchNode.outputs ?? [];
    const nextPort = uniqueBoundaryPortName(requestedPort, port, ports.map((entry) => entry.name), relatedNode.data.patchNode.type === 'Params');
    if (!nextPort || nextPort === port) return;

    commitHistory(`port-name:${nodeId}:${side}:${port}`);
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            inputs: side === 'input'
              ? renamePortDefinitions(node.data.patchNode.inputs, port, nextPort)
              : node.data.patchNode.inputs,
            outputs: side === 'output'
              ? renamePortDefinitions(node.data.patchNode.type === 'Params' ? withParameterIds({ nodes: [node.data.patchNode as PatchNode], links: [] }).nodes[0].outputs : node.data.patchNode.outputs, port, nextPort)
              : node.data.patchNode.outputs,
            params: nextBoundaryPortParams(node.data.patchNode as PatchNode, side, port, nextPort),
          },
        },
      };
    }));
    setEdges((current) => transformEdgeTree(current, (edge) => renameEdgePort(edge, nodeId, side, port, nextPort)));
  }, [commitHistory]);

  const updateParamRange = useCallback((nodeId: string, port: string, bound: 'min' | 'max', value: number) => {
    if (!Number.isFinite(value)) return;
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (relatedNode?.data.patchNode.type !== 'Params' || !relatedNode.data.patchNode.outputs?.some((output) => output.name === port)) return;
    commitHistory(`param-range:${nodeId}:${port}:${bound}`);
    setNodes((current) => current.map((node) => node.id === nodeId ? {
      ...node,
      data: {
        ...node.data,
        patchNode: {
          ...node.data.patchNode,
          outputs: node.data.patchNode.outputs?.map((output) => output.name === port ? { ...output, [bound]: value } : output),
        },
      },
    } : node));
  }, [commitHistory]);

  const addBoundaryPort = useCallback((nodeId: string, side: 'input' | 'output', requestedName: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, side)) return;
    const ports = side === 'input' ? relatedNode.data.patchNode.inputs ?? [] : relatedNode.data.patchNode.outputs ?? [];
    const baseName = requestedName.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!baseName) return;
    const usedNames = new Set(ports.map((port) => port.name));
    let name = baseName;
    for (let suffix = 2; usedNames.has(name); suffix += 1) name = `${baseName} ${suffix}`;
    commitHistory(`port-add:${nodeId}:${side}`);
    setNodes((current) => current.map((node) => node.id === nodeId ? {
      ...node,
      data: {
        ...node.data,
        patchNode: {
          ...node.data.patchNode,
          ...(side === 'input'
            ? { inputs: [...(node.data.patchNode.inputs ?? []), { name }] }
            : { outputs: [...(node.data.patchNode.outputs ?? []), node.data.patchNode.type === 'Params' ? { name, defaultValue: 0, min: 0, max: 1 } : { name }] }),
          ...((node.data.patchNode.type === 'Ins' || node.data.patchNode.type === 'Params')
            ? { params: { ...node.data.patchNode.params, [name]: 0 } }
            : {}),
        },
      },
    } : node));
  }, [commitHistory]);

  const updateBoundaryPortOrder = useCallback((nodeId: string, side: 'input' | 'output', port: string, direction: -1 | 1) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, side)) return;

    commitHistory(`port-order:${nodeId}:${side}`);
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            inputs: side === 'input'
              ? movePortDefinitions(node.data.patchNode.inputs, port, direction)
              : node.data.patchNode.inputs,
            outputs: side === 'output'
              ? movePortDefinitions(node.data.patchNode.outputs, port, direction)
              : node.data.patchNode.outputs,
          },
        },
      };
    }));
  }, [commitHistory]);

  const updateNodeCompactPorts = useCallback((nodeId: string, compact: boolean) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.compactPorts === compact) return;

    commitHistory(`compact:${nodeId}`);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          selected: compact ? false : node.selected,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              compactPorts: compact,
            },
          },
        }
      : node,
    ));
  }, [commitHistory]);

  const updateNodeEnabled = useCallback((nodeId: string, enabled: boolean) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || (relatedNode.data.patchNode.enabled !== false) === enabled) return;

    commitHistory(`node-enabled:${nodeId}`);
    setNodes((current) => current.map((node) => node.id === nodeId
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              ...(enabled ? { enabled: undefined } : { enabled: false }),
            },
          },
        }
      : node,
    ));
  }, [commitHistory]);

  const toggleSelectedNodes = useCallback(() => {
    const selectedNodeIds = new Set(nodesRef.current.filter((node) => node.selected === true).map((node) => node.id));
    if (selectedNodeIds.size === 0) return false;

    const shouldEnable = [...selectedNodeIds].some((nodeId) => (
      nodesRef.current.find((node) => node.id === nodeId)?.data.patchNode.enabled === false
    ));
    commitHistory('node-enabled');
    setNodes((current) => current.map((node) => selectedNodeIds.has(node.id)
      ? {
          ...node,
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              ...(shouldEnable ? { enabled: undefined } : { enabled: false }),
            },
          },
        }
      : node,
    ));
    return true;
  }, [commitHistory]);

  const updateNodeScopeSize = useCallback((nodeId: string, size: ScopeNodeSize, anchor: 'left' | 'right', renderedPreviousSize?: ScopeNodeSize) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (
      !relatedNode ||
      (
        relatedNode.data.patchNode.type !== 'Scope' &&
        relatedNode.data.patchNode.type !== 'Meter' &&
        relatedNode.data.patchNode.type !== 'FFT' &&
        relatedNode.data.patchNode.type !== 'CustomWave' &&
        relatedNode.data.patchNode.type !== 'SamplePlayer' &&
        relatedNode.data.patchNode.type !== 'Buffer' &&
        relatedNode.data.patchNode.type !== 'Image' &&
        relatedNode.data.patchNode.type !== 'Slider' &&
        relatedNode.data.patchNode.type !== 'Joystick' &&
        relatedNode.data.patchNode.type !== 'Button' &&
        relatedNode.data.patchNode.type !== 'Keys' &&
        relatedNode.data.patchNode.type !== 'Sequencer' &&
        relatedNode.data.patchNode.type !== 'Roll' &&
        relatedNode.data.patchNode.type !== 'Spread' &&
        relatedNode.data.patchNode.type !== 'Spawn'
      )
    ) {
      return;
    }

    const nextSize = relatedNode.data.patchNode.type === 'Spread' || relatedNode.data.patchNode.type === 'Spawn'
      ? {
          width: Math.max(
            relatedNode.data.patchNode.type === 'Spawn' ? MIN_SPAWN_WIDTH : MIN_RUNTIME_CONTAINER_WIDTH,
            Math.round(size.width),
          ),
          height: Math.max(140, Math.round(size.height)),
        }
      : relatedNode.data.patchNode.type === 'Sequencer'
      ? (() => {
          const shape = sequencerShape(relatedNode.data.patchNode.params);
          return clampSequencerNodeSize(size, shape.steps, shape.rows, relatedNode.data.patchNode.sequencerRowLabelColumnWidth ?? 0);
        })()
      : relatedNode.data.patchNode.type === 'Roll'
      ? (() => {
          const shape = rollShape(relatedNode.data.patchNode.params);
          return clampSequencerNodeSize(size, shape.steps, shape.rows.length, 32);
        })()
      : relatedNode.data.patchNode.type === 'Image'
      ? clampImageNodeSize(size, size.width / Math.max(1, size.height))
      : relatedNode.data.patchNode.type === 'CustomWave' || relatedNode.data.patchNode.type === 'SamplePlayer' || relatedNode.data.patchNode.type === 'Buffer'
      ? clampCustomWaveNodeSize(size)
      : relatedNode.data.patchNode.type === 'Keys'
        ? clampKeysNodeSize(size)
      : relatedNode.data.patchNode.type === 'Slider' || relatedNode.data.patchNode.type === 'Joystick' || relatedNode.data.patchNode.type === 'Button'
        ? clampControlNodeSize(size)
        : clampScopeNodeSize(size);
    const previousSize = relatedNode.data.patchNode.scopeSize;
    if (
      previousSize?.width === nextSize.width &&
      previousSize.height === nextSize.height
    ) {
      return;
    }

    commitHistory(`node-size:${nodeId}`);
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node;

      const currentSize = renderedPreviousSize ?? node.data.patchNode.scopeSize ?? (
        node.data.patchNode.type === 'Spread' || node.data.patchNode.type === 'Spawn'
          ? (node.data.patchNode.type === 'Spawn' ? DEFAULT_SPAWN_SIZE : DEFAULT_SPREAD_SIZE)
        : node.data.patchNode.type === 'Sequencer'
          ? clampSequencerNodeSize(
              DEFAULT_SEQUENCER_NODE_SIZE,
              sequencerShape(node.data.patchNode.params).steps,
              sequencerShape(node.data.patchNode.params).rows,
              node.data.patchNode.sequencerRowLabelColumnWidth ?? 0,
          )
        : node.data.patchNode.type === 'Roll'
          ? (() => {
              const shape = rollShape(node.data.patchNode.params);
              return clampSequencerNodeSize({ width: shape.steps * 26 + 32, height: shape.rows.length * 22 }, shape.steps, shape.rows.length, 32);
            })()
        : node.data.patchNode.type === 'Keys'
          ? DEFAULT_KEYS_NODE_SIZE
        : node.data.patchNode.type === 'FFT'
          ? DEFAULT_FFT_NODE_SIZE
        : node.data.patchNode.type === 'CustomWave' || node.data.patchNode.type === 'SamplePlayer' || node.data.patchNode.type === 'Buffer' || node.data.patchNode.type === 'Image'
          ? DEFAULT_CUSTOM_WAVE_NODE_SIZE
        : node.data.patchNode.type === 'Joystick'
          ? DEFAULT_JOYSTICK_NODE_SIZE
          : DEFAULT_SCOPE_NODE_SIZE
      );
      const positionDeltaX = anchor === 'left' ? currentSize.width - nextSize.width : 0;
      const position = positionDeltaX === 0
        ? node.position
        : { ...node.position, x: node.position.x + positionDeltaX };

      return {
        ...node,
        position,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            position,
            scopeSize: nextSize,
          },
        },
      };
    }));
  }, [commitHistory]);

  const addSelectorInput = useCallback((nodeId: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'Selector') return;

    const definition = getNodeDefinition(relatedNode.data.patchNode as PatchNode);
    const valueInputs = selectorValueInputs(definition.inputs);
    const nextIndex = Math.max(0, ...valueInputs.map((input) => Number(input.name))) + 1;
    const nextPort = String(nextIndex);
    if (definition.inputs.some((input) => input.name === nextPort)) return;

    commitHistory(`selector-input:${nodeId}`);
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node;

      const currentInputs = getNodeDefinition(node.data.patchNode as PatchNode).inputs;
      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            inputs: [...currentInputs, { name: nextPort, defaultValue: 0 }],
            params: {
              ...node.data.patchNode.params,
              [nextPort]: 0,
            },
          },
        },
      };
    }));
  }, [commitHistory]);

  const clearSelectorInput = useCallback((nodeId: string, port: string) => {
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode || relatedNode.data.patchNode.type !== 'Selector') return;
    if (!isSelectorValuePortName(port)) return;

    const definition = getNodeDefinition(relatedNode.data.patchNode as PatchNode);
    const valueInputs = selectorValueInputs(definition.inputs);
    if (!valueInputs.some((input) => input.name === port)) return;

    if (valueInputs.length <= 1) {
      updateNodeParam(nodeId, port, 0);
      return;
    }

    const removedIndex = Number(port);
    const orderedPorts = valueInputs
      .map((input) => input.name)
      .sort((left, right) => Number(left) - Number(right));
    const portMap = selectorPortMapAfterRemoval(orderedPorts, removedIndex);

    commitHistory(`selector-input-clear:${nodeId}:${port}`);
    setNodes((current) => current.map((node) => {
      if (node.id !== nodeId) return node;

      const currentDefinition = getNodeDefinition(node.data.patchNode as PatchNode);
      const currentValuePorts = selectorValueInputs(currentDefinition.inputs)
        .map((input) => input.name)
        .sort((left, right) => Number(left) - Number(right));
      const currentPortMap = selectorPortMapAfterRemoval(currentValuePorts, removedIndex);
      const nextInputs = currentDefinition.inputs.flatMap((input) => {
        const nextName = currentPortMap.get(input.name);
        if (nextName === undefined) return isSelectorValuePortName(input.name) ? [] : [input];
        return [{ ...input, name: nextName }];
      });
      const nextParams = remapSelectorParamsAfterRemoval(
        node.data.patchNode.params,
        currentValuePorts,
        currentPortMap,
        removedIndex,
      );

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            inputs: nextInputs,
            params: nextParams,
          },
        },
      };
    }));
    setEdges((current) => dedupeEdges(current.flatMap((edge) => remapSelectorEdgeAfterRemoval(edge, nodeId, portMap, removedIndex))));
  }, [commitHistory, updateNodeParam]);

  const addDraftNode = useCallback((position: { x: number; y: number }) => {
    const id = makeNodeId('node', new Set(nodesRef.current.map((node) => node.id)));
    provisionalNodeIdsRef.current.add(id);
    commitHistory();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      {
        id,
        type: 'shaderNode',
        position,
        selected: true,
        data: {
          patchNode: { id, type: null, params: {}, position },
          ...nodeCallbacksPlaceholder(),
          isTypePickerOpen: true,
        },
      },
    ]);
    setEditingTypeNodeId(id);
  }, [commitHistory]);

  const cancelProvisionalNode = useCallback((nodeId: string) => {
    if (!provisionalNodeIdsRef.current.delete(nodeId)) {
      setEditingTypeNodeId(null);
      return;
    }

    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => {
      const link = linkFromEdge(edge);
      return !link || (link.from.node !== nodeId && link.to.node !== nodeId);
    }));
    setEditingTypeNodeId((current) => current === nodeId ? null : current);
    setHistory((current) => ({
      ...current,
      past: current.past.slice(0, -1),
    }));
  }, []);

  const insertNodeOnEdges = useCallback((relatedEdges: ShaderFlowEdge[]) => {
    if (relatedEdges.length === 0) return;

    const firstLink = edgeEndpoints(relatedEdges[0]);
    if (!firstLink) return;

    const sourceNode = nodesRef.current.find((node) => node.id === firstLink.from.node);
    const targetNode = nodesRef.current.find((node) => node.id === firstLink.to.node);
    const position = midpointPosition(sourceNode?.position, targetNode?.position);
    const id = makeNodeId('node', new Set(nodesRef.current.map((node) => node.id)));
    const relatedEdgeIds = new Set(relatedEdges.map((edge) => edge.id));

    commitHistory();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      {
        id,
        type: 'shaderNode',
        position,
        selected: true,
        data: {
          patchNode: { id, type: null, params: {}, position },
          ...nodeCallbacksPlaceholder(),
          isTypePickerOpen: true,
        },
      },
    ]);
    setEdges((current) => {
      const incoming: ShaderFlowEdge[] = [];
      const downstream = transformEdgeTree(current, (edge) => {
        if (!relatedEdgeIds.has(edge.id)) return { ...edge, selected: false };
        const link = edgeEndpoints(edge);
        if (!link) return edge;
        incoming.push(edgeFromLink({ from: link.from, to: { node: id, port: 'value' },
          weight: 1, mode: 'set', enabled: link.enabled,
        }, updateEdgeWeight, updateEdgeMode, insertNodeOnEdgePlaceholder));
        if (edge.data?.modulatesEdgeId) {
          return { ...edge, source: id, sourceHandle: 'out:value', selected: false };
        }
        return edgeFromLink({ ...link, from: { node: id, port: 'value' } },
          updateEdgeWeight, updateEdgeMode, insertNodeOnEdgePlaceholder);
      });
      return dedupeEdges([...incoming, ...downstream]);
    });
    setEditingTypeNodeId(id);
  }, [commitHistory, updateEdgeMode, updateEdgeWeight]);

  const insertNodeOnEdge = useCallback((edgeIdToInsert: string) => {
    const edge = edgesRef.current.find((candidate) => candidate.id === edgeIdToInsert);
    if (!edge) return;
    insertNodeOnEdges([edge]);
  }, [insertNodeOnEdges]);

  const insertNodeOnPort = useCallback((nodeId: string, side: 'input' | 'output', port: string) => {
    const relatedEdges = edgesRef.current.filter((edge) => {
      const link = linkFromEdge(edge);
      if (!link) return false;
      return side === 'output'
        ? link.from.node === nodeId && link.from.port === port
        : link.to.node === nodeId && link.to.port === port;
    });
    insertNodeOnEdges(relatedEdges);
  }, [insertNodeOnEdges]);

  const deleteSelectedNodesWithBridge = useCallback(() => {
    const selectedNodeIds = new Set(
      nodesRef.current
        .filter((node) => node.selected)
        .map((node) => node.id),
    );
    if (selectedNodeIds.size === 0) return false;

    const bridgeEdges = buildBridgeEdges(nodesRef.current, edgesRef.current, selectedNodeIds, updateEdgeWeight, updateEdgeMode, insertNodeOnEdgePlaceholder);
    // Strength connections are real editor edges too. Filtering via
    // linkFromEdge would discard all of them, including unrelated cables.
    // The tree transform also removes descendants of a removed target cable.
    const remainingEdges = transformEdgeTree(edgesRef.current, (edge) => (
      selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target) ? null : edge
    ));

    commitHistory();
    setNodes((current) => current.filter((node) => !selectedNodeIds.has(node.id)));
    setEdges(dedupeEdges([...remainingEdges, ...bridgeEdges]));
    setEditingTypeNodeId((current) => current && selectedNodeIds.has(current) ? null : current);
    return true;
  }, [commitHistory, updateEdgeMode, updateEdgeWeight]);

  const deleteSelectedBoundaryPort = useCallback(() => {
    const selected = selectedBoundaryPort;
    if (!selected) return false;

    const relatedNode = nodesRef.current.find((node) => node.id === selected.nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, selected.side)) return false;

    commitHistory();
    setNodes((current) => current.map((node) => {
      if (node.id !== selected.nodeId) return node;

      const nextInputs = selected.side === 'input'
        ? (node.data.patchNode.inputs ?? []).filter((port) => port.name !== selected.port)
        : node.data.patchNode.inputs;
      const nextOutputs = selected.side === 'output'
        ? (node.data.patchNode.outputs ?? []).filter((port) => port.name !== selected.port)
        : node.data.patchNode.outputs;
      const nextParams = boundaryPortHasDefaultValue(node.data.patchNode as PatchNode, selected.side) || selected.side === 'input'
        ? Object.fromEntries(Object.entries(node.data.patchNode.params).filter(([key]) => key !== selected.port))
        : node.data.patchNode.params;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            params: nextParams,
            ...(nextInputs ? { inputs: nextInputs } : {}),
            ...(nextOutputs ? { outputs: nextOutputs } : {}),
          },
        },
      };
    }));
    setEdges((current) => dedupeEdges(current.filter((edge) => {
      const link = linkFromEdge(edge);
      if (!link) return true;

      if (selected.side === 'input') {
        return !(link.to.node === selected.nodeId && link.to.port === selected.port);
      }

      return !(link.from.node === selected.nodeId && link.from.port === selected.port);
    })));

    const frame = editingStack[editingStack.length - 1];
    if (frame) {
      setEditingStack((current) => current.map((entry, index) => {
        if (index !== current.length - 1) return entry;

        const parentEdges = dedupeEdges(entry.parentEdges.filter((edge) => {
          const link = linkFromEdge(edge);
          if (!link) return true;

          if (relatedNode.data.patchNode.type === 'Ins' && selected.side === 'output') {
            return !(link.to.node === entry.groupId && link.to.port === selected.port);
          }

          if (relatedNode.data.patchNode.type === 'Outs' && selected.side === 'input') {
            return !(link.from.node === entry.groupId && link.from.port === selected.port);
          }

          return true;
        }));

        const parentNodes = entry.parentNodes.map((node) => {
          if (node.id !== entry.groupId) return node;

          if (relatedNode.data.patchNode.type === 'Ins' && selected.side === 'output') {
            return {
              ...node,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  params: Object.fromEntries(Object.entries(node.data.patchNode.params).filter(([key]) => key !== selected.port)),
                  inputs: (node.data.patchNode.inputs ?? []).filter((port) => port.name !== selected.port),
                },
              },
            };
          }

          if (relatedNode.data.patchNode.type === 'Outs' && selected.side === 'input') {
            return {
              ...node,
              data: {
                ...node.data,
                patchNode: {
                  ...node.data.patchNode,
                  params: Object.fromEntries(Object.entries(node.data.patchNode.params).filter(([key]) => key !== selected.port)),
                  outputs: (node.data.patchNode.outputs ?? []).filter((port) => port.name !== selected.port),
                },
              },
            };
          }

          return node;
        });

        return {
          ...entry,
          parentEdges,
          parentNodes,
        };
      }));
    }

    setPendingBoundaryPort((current) => (
      current && current.nodeId === selected.nodeId && current.side === selected.side && current.port === selected.port
        ? null
        : current
    ));
    setSelectedBoundaryPort(null);
    return true;
  }, [commitHistory, editingStack, selectedBoundaryPort]);

  const copySelectedNodes = useCallback(() => {
    const selectedGraph = selectedGraphFromNodes(nodesRef.current, edgesRef.current);
    if (!selectedGraph) return false;

    copiedGraphRef.current = selectedGraph;
    pasteCountRef.current = 1;
    void writeCopiedGraphToClipboard(selectedGraph);
    return true;
  }, []);

  const groupSelectedNodes = useCallback(() => {
    const groupedGraph = groupSelectedGraph(nodesRef.current, edgesRef.current, updateEdgeWeight, updateEdgeMode, insertNodeOnEdgePlaceholder);
    if (!groupedGraph) return false;

    commitHistory();
    setNodes(groupedGraph.nodes);
    setEdges(groupedGraph.edges);
    setEditingTypeNodeId(null);
    return true;
  }, [commitHistory, updateEdgeMode, updateEdgeWeight]);

  const scaleSelectedNodes = useCallback((factor: number) => {
    const selectedNodes = nodesRef.current.filter((node) => node.selected);
    if (selectedNodes.length === 0) return false;

    const bounds = selectedNodes.map((node) => {
      const width = node.measured?.width ?? node.width ?? DEFAULT_NODE_BOUNDS_SIZE.width;
      const height = node.measured?.height ?? node.height ?? DEFAULT_NODE_BOUNDS_SIZE.height;
      return { node, width, height };
    });
    const minX = Math.min(...bounds.map(({ node }) => node.position.x));
    const minY = Math.min(...bounds.map(({ node }) => node.position.y));
    const maxX = Math.max(...bounds.map(({ node, width }) => node.position.x + width));
    const maxY = Math.max(...bounds.map(({ node, height }) => node.position.y + height));
    const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
    const selectedById = new Map(bounds.map((entry) => [entry.node.id, entry]));

    commitHistory();
    setNodes((current) => current.map((node) => {
      const entry = selectedById.get(node.id);
      if (!entry) return node;

      const nextWidth = entry.width * factor;
      const nextHeight = entry.height * factor;
      const currentCenter = {
        x: node.position.x + entry.width / 2,
        y: node.position.y + entry.height / 2,
      };
      const nextCenter = {
        x: center.x + (currentCenter.x - center.x) * factor,
        y: center.y + (currentCenter.y - center.y) * factor,
      };
      const position = { x: nextCenter.x - nextWidth / 2, y: nextCenter.y - nextHeight / 2 };
      return {
        ...node,
        position,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            position,
            scale: (node.data.patchNode.scale ?? 1) * factor,
          },
        },
      };
    }));
    return true;
  }, [commitHistory]);

  const pasteCopiedNodes = useCallback(async () => {
    const clipboardGraph = await readCopiedGraphFromClipboard();
    const copiedGraph = clipboardGraph ?? copiedGraphRef.current;
    if (!copiedGraph) return false;

    if (clipboardGraph) {
      copiedGraphRef.current = clipboardGraph;
      if (pasteCountRef.current === 0) pasteCountRef.current = 1;
    }
    const pasteOffset = {
      x: PASTE_OFFSET.x * pasteCountRef.current,
      y: PASTE_OFFSET.y * pasteCountRef.current,
    };
    const duplicatedGraph = duplicateCopiedGraph(
      copiedGraph,
      nodesRef.current,
      pasteOffset,
      updateEdgeWeight,
      updateEdgeMode,
      insertNodeOnEdgePlaceholder,
    );
    if (duplicatedGraph.nodes.length === 0) return false;

    const bufferCopies = duplicatedBufferCopies(
      copiedGraph.nodes,
      duplicatedGraph.nodes,
      nodesRef.current,
      [...nodesRef.current, ...duplicatedGraph.nodes],
      editingStack.map((frame) => frame.groupId),
    );

    pasteCountRef.current += 1;
    commitHistory();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...duplicatedGraph.nodes.map((node) => ({ ...node, selected: true })),
    ]);
    setEdges((current) => dedupeEdges([
      ...current.map((edge) => ({ ...edge, selected: false })),
      ...duplicatedGraph.edges,
    ]));
    copyBufferAssets(bufferCopies, bufferAssetsRef.current, replaceBufferAssets);
    audio.copyBuffers(bufferCopies);
    setEditingTypeNodeId(null);
    return true;
  }, [audio.copyBuffers, commitHistory, editingStack, replaceBufferAssets, updateEdgeMode, updateEdgeWeight]);

  const createDraftNodeFromConnection = useCallback((draftConnection = draftNodeConnectionRef.current) => {
    if (!draftConnection || !draftConnection.modifierActive || !reactFlow) return;

    const id = makeNodeId('node', new Set(nodesRef.current.map((node) => node.id)));
    const position = draftNodePosition(draftConnection, reactFlow);
    const link = linkForDraftNodeConnection(draftConnection, id);
    if (!link) return;

    provisionalNodeIdsRef.current.add(id);
    commitHistory();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      {
        id,
        type: 'shaderNode',
        position,
        selected: true,
        data: {
          patchNode: { id, type: null, params: {}, position },
          ...nodeCallbacksPlaceholder(),
          isTypePickerOpen: true,
        },
      },
    ]);
    setEdges((current) => dedupeEdges([
      ...current.map((edge) => ({ ...edge, selected: false })),
      edgeFromLink(link, updateEdgeWeight, updateEdgeMode, insertNodeOnEdgePlaceholder),
    ]));
    setEditingTypeNodeId(id);
  }, [commitHistory, reactFlow, updateEdgeMode, updateEdgeWeight]);

  const materializePendingBoundaryPort = useCallback((pending: BoundaryPortSelection): void => {
    const relatedNode = nodesRef.current.find((node) => node.id === pending.nodeId);
    if (!relatedNode || !canRenameBoundaryPort(relatedNode.data.patchNode as PatchNode, pending.side)) return;

    setNodes((current) => current.map((node) => {
      if (node.id !== pending.nodeId) return node;

      const nextPort: PortDefinition = boundaryPortHasDefaultValue(relatedNode.data.patchNode as PatchNode, pending.side)
        ? { name: pending.port, defaultValue: 0, ...(relatedNode.data.patchNode.type === 'Params' ? { min: 0, max: 1 } : {}) }
        : { name: pending.port };
      const ports = pending.side === 'input'
        ? node.data.patchNode.inputs ?? []
        : node.data.patchNode.outputs ?? [];
      if (ports.some((port) => port.name === pending.port)) return node;

      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            inputs: pending.side === 'input'
              ? [...ports, nextPort]
              : node.data.patchNode.inputs,
            outputs: pending.side === 'output'
              ? [...ports, nextPort]
              : node.data.patchNode.outputs,
            params: boundaryPortHasDefaultValue(node.data.patchNode as PatchNode, pending.side)
              ? { ...node.data.patchNode.params, [pending.port]: 0 }
              : node.data.patchNode.params,
          },
        },
      };
    }));
  }, []);

  const enterGroupNode = useCallback((node: ShaderFlowNode) => {
    const patchNode = node.data.patchNode;
    if (patchNode.type !== 'Group') return false;

    const subpatch = patchNode.subpatch ?? emptySubpatchForGroup(patchNode as PatchNode, node.position);
    setEditingStack((current) => [
      ...current,
      {
        groupId: node.id,
        parentNodes: nodesRef.current.map(cloneFlowNodeSnapshot),
        parentEdges: edgesRef.current.map(cloneFlowEdgeSnapshot),
        parentAreas: structuredClone(areasRef.current),
        parentPatchName: patchName,
        parentHistory: history,
      },
    ]);
    const callbacks = nodeCallbacksPlaceholder();
    setNodes(toFlowNodes(subpatch, callbacks, null));
    setEdges(toFlowEdges(subpatch, updateEdgeWeight, updateEdgeMode, insertNodeOnEdgePlaceholder));
    setAreas(structuredClone(subpatch.areas ?? []));
    setSelectedAreaId(null);
    setSurfacedAreaId(null);
    setPatchName(patchNode.subpatchName ?? node.id);
    setEditingTypeNodeId(null);
    setPendingBoundaryPort(null);
    copiedGraphRef.current = null;
    pasteCountRef.current = 0;
    historyGroupRef.current = null;
    setHistory({ past: [], future: [] });
    return true;
  }, [history, patchName, updateEdgeMode, updateEdgeWeight]);

  const exitSubpatch = useCallback(() => {
    const frame = editingStack[editingStack.length - 1];
    if (!frame) return false;

    const subpatch = patchFromFlow(nodesRef.current, edgesRef.current, areasRef.current);
    const parentGraph = applySubpatchToParent(frame, subpatch, patchName);
    const previousParentSnapshot = graphSnapshot(frame.parentNodes, frame.parentEdges, frame.parentAreas);

    setEditingStack((current) => current.slice(0, -1));
    setNodes(parentGraph.nodes);
    setEdges(parentGraph.edges);
    setAreas(structuredClone(frame.parentAreas));
    setSelectedAreaId(null);
    setSurfacedAreaId(null);
    setPatchName(frame.parentPatchName);
    setEditingTypeNodeId(null);
    setPendingBoundaryPort(null);
    copiedGraphRef.current = null;
    pasteCountRef.current = 0;
    historyGroupRef.current = null;
    setHistory({
      past: [...frame.parentHistory.past, previousParentSnapshot].slice(-HISTORY_LIMIT),
      future: [],
    });
    return true;
  }, [editingStack, patchName]);

  const updateGroupUiNodeOverride = useCallback((
    groupId: string,
    innerNodeId: string,
    historyKey: string,
    update: (override: NonNullable<PatchNode['subpatchUiOverrides']>[string]) => NonNullable<PatchNode['subpatchUiOverrides']>[string],
  ) => {
    const group = nodesRef.current.find((node) => node.id === groupId)?.data.patchNode;
    if (group?.type !== 'Group' || !group.subpatch) return;
    commitHistory(`group-ui:${groupId}:${historyKey}`);
    setNodes((current) => current.map((node) => {
      const patchNode = node.data.patchNode;
      if (node.id !== groupId || patchNode.type !== 'Group' || !patchNode.subpatch) return node;
      const currentOverrides = patchNode.subpatchUiOverrides ?? {};
      return {
        ...node,
        data: {
          ...node.data,
          patchNode: {
            ...patchNode,
            subpatchUiOverrides: {
              ...currentOverrides,
              [innerNodeId]: update(currentOverrides[innerNodeId] ?? {}),
            },
          },
        },
      };
    }));
  }, [commitHistory]);

  const resetGroupUiNodeOverride = useCallback((groupId: string, innerNodeId: string) => {
    const group = nodesRef.current.find((node) => node.id === groupId)?.data.patchNode;
    if (group?.type !== 'Group' || !group.subpatchUiOverrides?.[innerNodeId]) return;

    commitHistory();
    setNodes((current) => current.map((node) => {
      const patchNode = node.data.patchNode;
      if (node.id !== groupId || patchNode.type !== 'Group' || !patchNode.subpatchUiOverrides?.[innerNodeId]) return node;
      const { [innerNodeId]: _removed, ...remainingOverrides } = patchNode.subpatchUiOverrides;
      const { subpatchUiOverrides: _previousOverrides, ...sharedPatchNode } = patchNode;
      return {
        ...node,
        data: {
          ...node.data,
          patchNode: Object.keys(remainingOverrides).length > 0
            ? { ...sharedPatchNode, subpatchUiOverrides: remainingOverrides }
            : sharedPatchNode,
        },
      };
    }));
  }, [commitHistory]);

  const selectedLinkPortsByNode = useMemo(() => {
    const portsByNode = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();
    const ensureEntry = (nodeId: string) => {
      const existing = portsByNode.get(nodeId);
      if (existing) return existing;
      const entry = { inputs: new Set<string>(), outputs: new Set<string>() };
      portsByNode.set(nodeId, entry);
      return entry;
    };

    for (const edge of edges) {
      if (edge.selected !== true) continue;
      const link = linkFromEdge(edge);
      if (!link) continue;
      ensureEntry(link.from.node).outputs.add(link.from.port);
      ensureEntry(link.to.node).inputs.add(link.to.port);
    }

    return new Map([...portsByNode].map(([nodeId, ports]) => [
      nodeId,
      {
        inputs: [...ports.inputs],
        outputs: [...ports.outputs],
      },
    ]));
  }, [edges]);

  const connectedPortsByNode = useMemo(() => {
    const portsByNode = new Map<string, { inputs: Set<string>; outputs: Set<string> }>();
    const ensureEntry = (nodeId: string) => {
      const existing = portsByNode.get(nodeId);
      if (existing) return existing;
      const entry = { inputs: new Set<string>(), outputs: new Set<string>() };
      portsByNode.set(nodeId, entry);
      return entry;
    };

    for (const edge of edges) {
      const link = linkFromEdge(edge);
      if (!link) continue;
      ensureEntry(link.from.node).outputs.add(link.from.port);
      ensureEntry(link.to.node).inputs.add(link.to.port);
    }

    return new Map([...portsByNode].map(([nodeId, ports]) => [
      nodeId,
      {
        inputs: [...ports.inputs],
        outputs: [...ports.outputs],
      },
    ]));
  }, [edges]);

  const setLinkInputPortsByNode = useMemo(() => {
    const portsByNode = new Map<string, Set<string>>();
    const disabledNodeIds = new Set(
      nodes.filter((node) => node.data.patchNode.enabled === false).map((node) => node.id),
    );

    for (const edge of edges) {
      if (edge.data?.enabled === false || (edge.data?.mode ?? 'set') !== 'set') continue;
      const link = linkFromEdge(edge);
      if (!link) continue;
      if (disabledNodeIds.has(link.from.node) || disabledNodeIds.has(link.to.node)) continue;
      const ports = portsByNode.get(link.to.node) ?? new Set<string>();
      ports.add(link.to.port);
      portsByNode.set(link.to.node, ports);
    }

    return new Map([...portsByNode].map(([nodeId, ports]) => [nodeId, [...ports]]));
  }, [edges, nodes]);

  const selectedNodeCount = nodes.filter((node) => node.selected).length;
  const routingSelection = useMemo(
    () => routingSelectionHighlights(nodes, edges),
    [edges, nodes],
  );
  const selectNodeFromTitle = useCallback((nodeId: string, additive: boolean) => {
    setSelectedAreaId(null);
    setNodes((current) => current.map((node) => {
      if (node.id === nodeId) return { ...node, selected: additive ? !node.selected : true };
      return additive || !node.selected ? node : { ...node, selected: false };
    }));
    setEdges((current) => updateSelection(current, new Set()));
  }, []);
  const finishTypeEdit = useCallback(() => {
    setEditingTypeNodeId(null);
  }, []);
  const selectBoundaryPort = useCallback((nodeId: string, side: 'input' | 'output', port: string) => {
    setSelectedBoundaryPort({ nodeId, side, port });
  }, []);
  const selectedAreaNodeIds = useMemo(() => (
    selectedAreaId
      ? nodeIdsContainedByAreaHierarchy(areas, nodes, selectedAreaId)
      : new Set<string>()
  ), [areas, nodes, selectedAreaId]);
  const nodeStackRanks = useMemo(() => {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const orderedNodeIds = nodeStackOrder.filter((nodeId) => nodeIds.has(nodeId));
    const rankedNodeIds = new Set(orderedNodeIds);

    for (const node of nodes) {
      if (rankedNodeIds.has(node.id)) continue;
      orderedNodeIds.push(node.id);
      rankedNodeIds.add(node.id);
    }

    return new Map(orderedNodeIds.map((nodeId, index) => [nodeId, index]));
  }, [nodes, nodeStackOrder]);
  const surfacedAreaIds = useMemo(() => (
    surfacedAreaId ? connectedAreaIds(areas, surfacedAreaId) : new Set<string>()
  ), [areas, surfacedAreaId]);
  const surfacedAreaNodeIds = useMemo(() => (
    surfacedAreaId
      ? nodeIdsContainedByAreaHierarchy(areas, nodes, surfacedAreaId)
      : new Set<string>()
  ), [areas, nodes, surfacedAreaId]);
  const surfacedAreaRanks = useMemo(() => new Map(
    areas
      .filter((area) => surfacedAreaIds.has(area.id))
      .map((area, index) => [area.id, index]),
  ), [areas, surfacedAreaIds]);
  const baseNodeLayerSize = Math.max(1, nodes.length);
  const surfacedAreaLayerBase = (SELECTED_NODE_Z_INDEX + 1) * baseNodeLayerSize + 1;
  const surfacedNodeLayerBase = surfacedAreaLayerBase + surfacedAreaIds.size;
  const temporaryNodeLayer = surfacedNodeLayerBase + (SELECTED_NODE_Z_INDEX + 1) * baseNodeLayerSize;
  const updateTemporaryPortReveal = useCallback((nodeId: string, revealed: boolean) => {
    setTemporarilyRevealedNodeId((current) => revealed ? nodeId : (current === nodeId ? null : current));
  }, []);

  const nodesWithCallbacks = useMemo(() => {
    const nextNodes = nodes.map((node) => {
    const compactPorts = node.data.patchNode.compactPorts === true;
    const baseZIndex = node.data.patchNode.type === 'Spread' || node.data.patchNode.type === 'Spawn'
      ? 0
      : 1 + nodeZIndex(
          node.selected === true || selectedAreaNodeIds.has(node.id),
          compactPorts,
          nodeStackRanks.get(node.id) ?? 0,
          nodes.length,
        );

    return {
      ...node,
      ...((node.data.patchNode.type === 'Spread' || node.data.patchNode.type === 'Spawn') ? { draggable: false, selectable: false } : {}),
      zIndex: temporarilyRevealedNodeId === node.id
        ? temporaryNodeLayer
        : surfacedAreaNodeIds.has(node.id)
          ? surfacedNodeLayerBase + baseZIndex
          : baseZIndex,
      data: {
        ...node.data,
        onParamChange: updateNodeParam,
        onParamsChange: updateNodeParams,
        onCustomWaveChange: updateNodeCustomWave,
        onAudioInputDeviceChange: audio.setAudioInputDeviceId,
        onAudioInputRefresh: audio.refreshAudioInputDevices,
        onMidiInputRefresh: audio.refreshMidiInputDevices,
        onTypeChange: updateNodeType,
        onConvertToArea: convertNodeToArea,
        onCustomLabelChange: updateNodeCustomLabel,
        onSequencerRowLabelsChange: updateSequencerRowLabels,
        onTitleSelect: canvasLocked ? undefined : selectNodeFromTitle,
        onExpressionCommit: updateExpression,
        onTypeEditStart: setEditingTypeNodeId,
        onTypeEditEnd: finishTypeEdit,
        onTypeEditCancel: cancelProvisionalNode,
        onIdChange: updateNodeId,
        onSubpatchNameChange: updateGroupSubpatchName,
        onSampleSelect: openSampleLibrary,
        onSampleDrop: uploadDroppedSampleFiles,
        onImageSelect: openImageLibrary,
        onPortDoubleClick: insertNodeOnPort,
        onPortSelect: selectBoundaryPort,
        onPortNameChange: updateBoundaryPortName,
        onParamRangeChange: updateParamRange,
        onPortAdd: addBoundaryPort,
        onPortMove: updateBoundaryPortOrder,
        onCompactToggle: updateNodeCompactPorts,
        onEnabledChange: updateNodeEnabled,
        onScopeResize: updateNodeScopeSize,
        onSelectorInputAdd: addSelectorInput,
        onSelectorInputClear: clearSelectorInput,
        selectedLinkPorts: selectedLinkPortsByNode.get(node.id),
        ...(node.data.patchNode.type === 'AudioInput' ? { audioInput: audio.audioInput } : {}),
        ...(node.data.patchNode.type === 'MidiNote'
          || node.data.patchNode.type === 'MidiNoteOn'
          || node.data.patchNode.type === 'MidiNoteOff'
          || node.data.patchNode.type === 'MidiCc'
          || node.data.patchNode.type === 'Slider'
          || node.data.patchNode.type === 'Joystick'
          || node.data.patchNode.type === 'Button'
          || node.data.patchNode.type === 'Tempo'
          ? { midiInput: audio.midiInput }
          : {}),
        connectedPorts: connectedPortsByNode.get(node.id),
        setLinkInputPorts: setLinkInputPortsByNode.get(node.id),
        isCanvasLocked: canvasLocked,
        canvasZoom: settledGraphZoom,
        previewPort: pendingBoundaryPort && pendingBoundaryPort.nodeId === node.id
          ? { side: pendingBoundaryPort.side, name: pendingBoundaryPort.port }
          : null,
        selectedPort: selectedBoundaryPort && selectedBoundaryPort.nodeId === node.id
          ? { side: selectedBoundaryPort.side, name: selectedBoundaryPort.port }
          : null,
        isOnlySelected: node.selected === true && selectedNodeCount === 1,
        routingHighlighted: node.selected !== true && routingSelection.nodeIds.has(node.id),
        isConnecting: draftNodeConnection !== null || reconnectingEdgeId !== null,
        onTemporaryPortRevealChange: updateTemporaryPortReveal,
        isTypePickerOpen: editingTypeNodeId === node.id,
        isEditingSubpatch: editingStack.length > 0,
      },
    };
    });
    const reconciledNodes = reuseUnchangedNodePresentations(nodePresentationCacheRef.current, nextNodes);
    nodePresentationCacheRef.current = reconciledNodes;
    return reconciledNodes;
  }, [
    canvasLocked,
    connectedPortsByNode,
    setLinkInputPortsByNode,
    draftNodeConnection,
    reconnectingEdgeId,
    editingStack.length,
    editingTypeNodeId,
    finishTypeEdit,
    insertNodeOnPort,
    nodes,
    pendingBoundaryPort,
    openSampleLibrary,
    uploadDroppedSampleFiles,
    openImageLibrary,
    nodeStackRanks,
    selectedAreaNodeIds,
    surfacedAreaNodeIds,
    surfacedNodeLayerBase,
    temporaryNodeLayer,
    temporarilyRevealedNodeId,
    updateTemporaryPortReveal,
    selectedBoundaryPort,
    selectedLinkPortsByNode,
    routingSelection,
    selectBoundaryPort,
    selectNodeFromTitle,
    settledGraphZoom,
    updateBoundaryPortName,
    addBoundaryPort,
    updateBoundaryPortOrder,
    updateExpression,
    updateGroupSubpatchName,
    addSelectorInput,
    clearSelectorInput,
    cancelProvisionalNode,
    convertNodeToArea,
    audio.audioInput,
    audio.midiInput,
    audio.refreshAudioInputDevices,
    audio.refreshMidiInputDevices,
    audio.setAudioInputDeviceId,
    updateNodeCompactPorts,
    updateNodeEnabled,
    updateNodeCustomWave,
    updateNodeScopeSize,
    updateNodeId,
    updateNodeParam,
    updateNodeParams,
    updateParamRange,
    updateNodeCustomLabel,
    updateSequencerRowLabels,
    updateNodeType,
    selectedNodeCount,
  ]);

  const onReconnectStart = useCallback((event: ReactMouseEvent, edge: ShaderFlowEdge, handleType: HandleType) => {
    if (canvasLocked) return;
    const duplicateActive = isReconnectDuplicateModifierPressed(event);
    reconnectingEdgeRef.current = true;
    setReconnectingEdgeId(edge.id);
    reconnectFixedHandleRef.current = handleType;
    reconnectCompletedRef.current = false;
    reconnectCancelledRef.current = false;
    reconnectDuplicateRef.current = duplicateActive;
    reconnectingEdgeSnapshotRef.current = cloneFlowEdgeSnapshot(edge);
    setReconnectPreviewEdge(duplicateActive ? reconnectPreviewEdgeFromEdge(edge) : null);

    let nextPending: BoundaryPortSelection | null = null;
    if (editingStack.length > 0 || nodesRef.current.some((node) => node.data.patchNode.type === 'Params')) {
      // React Flow reports the endpoint that stays attached during a reconnect,
      // so a fixed target means the source endpoint is the one being moved.
      if (handleType === 'target') {
        const insNode = nodesRef.current.find((node) => node.data.patchNode.type === (editingStack.length > 0 ? 'Ins' : 'Params'));
        if (insNode && edge.target !== insNode.id) {
          const usedNames = new Set((insNode.data.patchNode.outputs ?? []).map((port) => port.name));
          nextPending = {
            nodeId: insNode.id,
            side: 'output',
            port: uniquePortName(editingStack.length > 0 ? 'new input' : 'new parameter', usedNames),
          };
        }
      } else {
        const outsNode = nodesRef.current.find((node) => node.data.patchNode.type === 'Outs');
        if (outsNode && edge.source !== outsNode.id) {
          const usedNames = new Set((outsNode.data.patchNode.inputs ?? []).map((port) => port.name));
          nextPending = {
            nodeId: outsNode.id,
            side: 'input',
            port: uniquePortName('new output', usedNames),
          };
        }
      }
    }
    pendingBoundaryPortRef.current = nextPending;
    setPendingBoundaryPort(nextPending);
    updateDraftNodeConnection(null);
  }, [canvasLocked, editingStack.length, updateDraftNodeConnection]);

  const onReconnectEnd = useCallback<NonNullable<ReactFlowProps<ShaderFlowNode, ShaderFlowEdge>['onReconnectEnd']>>((event, edge, fixedHandle, connectionState) => {
    // React Flow commits node-pin drops through onReconnect. A cable body is
    // not a React Flow handle, so its drop must be committed here instead.
    const pointer = clientPointFromEvent(event);
    if (!canvasLocked && !reconnectCancelledRef.current && fixedHandle === 'source' && !reconnectCompletedRef.current && !connectionState.toHandle && pointer) {
      const targetId = linkAtScreenPoint(pointer, edgesRef.current.filter(
        (candidate) => strengthTargetIsAllowed(edge.id, candidate.id, edgesRef.current),
      ));
      const target = edgesRef.current.find((candidate) => candidate.id === targetId);
      if (target) {
        const duplicate = reconnectDuplicateRef.current;
        const replacement: ShaderFlowEdge = {
          ...edge,
          id: duplicate ? `weight-modulation:${crypto.randomUUID()}` : edge.id,
          target: target.target,
          targetHandle: target.targetHandle,
          selected: true,
          data: { ...edge.data!, modulatesEdgeId: target.id, isFeedback: false },
        };
        commitHistory();
        setNodes((current) => current.map((node) => ({ ...node, selected: false })));
        setEdges((current) => duplicate
          ? dedupeEdges([...current.map((candidate) => ({ ...candidate, selected: false })), replacement])
          : transformEdgeTree(current, (candidate) => candidate.id === edge.id
            ? replacement : { ...candidate, selected: false }));
      }
    }
    reconnectingEdgeRef.current = false;
    reconnectCancelledRef.current = false;
    setReconnectingEdgeId(null);
    reconnectFixedHandleRef.current = null;
    reconnectCompletedRef.current = false;
    reconnectDuplicateRef.current = false;
    reconnectingEdgeSnapshotRef.current = null;
    pendingBoundaryPortRef.current = null;
    setPendingBoundaryPort(null);
    setReconnectPreviewEdge(null);
    weightTargetEdgeIdRef.current = null;
    setWeightTargetEdgeId(null);
    updateDraftNodeConnection(null);
  }, [canvasLocked, commitHistory, updateDraftNodeConnection]);

  useEffect(() => {
    const updateReconnectDuplicateModifier = (event: KeyboardEvent) => {
      if (!reconnectingEdgeRef.current) return;
      if (event.key === 'Escape') {
        reconnectCancelledRef.current = true;
        flowStore.getState().cancelConnection();
        setReconnectingEdgeId(null);
        setReconnectPreviewEdge(null);
        weightTargetEdgeIdRef.current = null;
        setWeightTargetEdgeId(null);
        return;
      }
      if (reconnectCancelledRef.current) return;
      const duplicateActive = isReconnectDuplicateModifierPressed(event);
      reconnectDuplicateRef.current = duplicateActive;
      setReconnectPreviewEdge(
        duplicateActive && reconnectingEdgeSnapshotRef.current
          ? reconnectPreviewEdgeFromEdge(reconnectingEdgeSnapshotRef.current)
          : null,
      );
    };

    window.addEventListener('keydown', updateReconnectDuplicateModifier);
    window.addEventListener('keyup', updateReconnectDuplicateModifier);
    return () => {
      window.removeEventListener('keydown', updateReconnectDuplicateModifier);
      window.removeEventListener('keyup', updateReconnectDuplicateModifier);
    };
  }, [flowStore]);

  const onReconnect = useCallback((oldEdge: ShaderFlowEdge, connection: Connection) => {
    if (canvasLocked || reconnectCancelledRef.current) return;
    reconnectCompletedRef.current = true;
    if (oldEdge.data?.modulatesEdgeId && reconnectFixedHandleRef.current === 'target') {
      const sourceHandle = connection.sourceHandle ? parseHandleId(connection.sourceHandle) : null;
      if (!connection.source || sourceHandle?.kind !== 'out') return;
      if (oldEdge.source === connection.source && oldEdge.sourceHandle === connection.sourceHandle) return;
      commitHistory();
      const pending = pendingBoundaryPortRef.current;
      if (pending?.side === 'output' && connection.source === pending.nodeId && connection.sourceHandle === `out:${pending.port}`) {
        materializePendingBoundaryPort(pending);
      }
      setNodes((current) => current.map((node) => ({ ...node, selected: false })));
      const shouldDuplicate = reconnectDuplicateRef.current;
      const replacement = { ...oldEdge, id: shouldDuplicate ? `weight-modulation:${crypto.randomUUID()}` : oldEdge.id,
        source: connection.source, sourceHandle: connection.sourceHandle, selected: true };
      setEdges((current) => dedupeEdges(shouldDuplicate
        ? [...current.map((edge) => ({ ...edge, selected: false })), replacement]
        : current.map((edge) => edge.id === oldEdge.id ? replacement : { ...edge, selected: false })));
      return;
    }
    const candidate: ShaderFlowEdge = {
      ...oldEdge,
      data: oldEdge.data ? { ...oldEdge.data, modulatesEdgeId: undefined } : undefined,
      source: connection.source ?? '',
      sourceHandle: connection.sourceHandle,
      target: connection.target ?? '',
      targetHandle: connection.targetHandle,
    };
    const link = linkFromEdge(candidate);
    if (!link) return;
    if (!runtimeContainerLinkIsAllowed(link, nodesRef.current)) return;

    const oldLink = linkFromEdge(oldEdge);
    const weight = oldEdge.data?.weight ?? oldLink?.weight ?? 1;
    const mode = oldEdge.data?.mode ?? oldLink?.mode ?? 'set';
    const enabled = oldEdge.data?.enabled ?? oldLink?.enabled ?? true;
    const nextEdge = {
      ...edgeFromLink({ from: link.from, to: link.to, weight, mode, enabled }, updateEdgeWeight, updateEdgeMode, insertNodeOnEdge),
      selected: true,
      reconnectable: true,
    };
    const nextLink = linkFromEdge(nextEdge);
    if (!nextLink) return;
    const nextEdgeId = edgeId(nextLink);
    if (oldEdge.id === nextEdgeId && oldLink && samePatchLink(oldLink, nextLink)) return;

    const shouldDuplicate = reconnectDuplicateRef.current;
    commitHistory();
    const pending = pendingBoundaryPortRef.current;
    if (pending) {
      const isPendingSource = pending.side === 'output'
        && connection.source === pending.nodeId
        && connection.sourceHandle === `out:${pending.port}`;
      const isPendingTarget = pending.side === 'input'
        && connection.target === pending.nodeId
        && connection.targetHandle === `in:${pending.port}`;
      if (isPendingSource || isPendingTarget) {
        materializePendingBoundaryPort(pending);
      }
    }
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => {
      const duplicate = current.find((edge) => {
        if (edge.id === oldEdge.id) return false;
        const existing = linkFromEdge(edge);
        return existing ? samePatchLink(existing, nextLink) : false;
      });

      if (duplicate) {
        if (shouldDuplicate) return current.map((edge) => ({ ...edge, selected: edge.id === duplicate.id }));
        return transformEdgeTree(current, (edge) => edge.id === oldEdge.id
          ? { ...duplicate, selected: true }
          : { ...edge, selected: edge.id === duplicate.id });
      }

      if (shouldDuplicate) {
        return dedupeEdges([
          ...current.map((edge) => ({ ...edge, selected: false })),
          nextEdge,
        ]);
      }

      return transformEdgeTree(current, (edge) => edge.id === oldEdge.id
        ? nextEdge
        : { ...edge, selected: false });
    });
  }, [canvasLocked, commitHistory, insertNodeOnEdge, materializePendingBoundaryPort, updateEdgeMode, updateEdgeWeight]);

  const edgesWithCallbacks = useMemo(() => {
    const selectedEdgeCount = edges.filter((edge) => edge.selected).length;
    const selectedNodeIds = new Set(
      nodes.filter((node) => node.selected).map((node) => node.id),
    );
    const disabledNodeIds = new Set(
      nodes.filter((node) => node.data.patchNode.enabled === false).map((node) => node.id),
    );
    const hasHighlightedLinks = selectedEdgeCount > 0 || selectedNodeIds.size > 0;
    return edges.map((edge) => {
      const link = linkFromEdge(edge);
      const sourceNode = link ? nodes.find((node) => node.id === link.from.node) : undefined;
      const targetNode = link ? nodes.find((node) => node.id === link.to.node) : undefined;
      // Runtime-container lifecycle pins live inside the container's body.
      // Unlike ordinary boundary pins, their endpoint drag target would
      // otherwise be painted behind the node and the Handle would always begin
      // a new connection. Elevate just these endpoint targets above the
      // container so an attached cable can be grabbed at its visible pin.
      const hasInternalRuntimeEndpoint = Boolean(link && (
        ((sourceNode?.data.patchNode.type === 'Spread' && link.from.port === 'item index')
          || (sourceNode?.data.patchNode.type === 'Spawn' && link.from.port === 'instance gate'))
        || (targetNode?.data.patchNode.type === 'Spawn' && link.to.port === 'kill trigger')
      ));
      const isConnectedToSelectedNode = isEdgeConnectedToSelectedNode(edge, selectedNodeIds)
        || routingSelection.edgeIds.has(edge.id);
      const isHighlighted = edge.selected === true || isConnectedToSelectedNode;
      return {
        ...edge,
        // Keep endpoint reconnection available even before an edge is selected.
        // Otherwise a pointer down where an edge meets a Spawn/Spread's internal
        // handle is captured by that handle and begins a second link instead of
        // moving the endpoint the user grabbed.
        reconnectable: edge.data?.modulatesEdgeId ? 'source' as const : true,
        // Incident-node emphasis stays in the normal edge layer so the selected
        // node and its controls remain unobscured. Internal runtime endpoints
        // are the sole exception because their visible pins are inside a node.
        zIndex: edge.selected || hasInternalRuntimeEndpoint ? SELECTED_EDGE_Z_INDEX : undefined,
        className: [edge.className, hasInternalRuntimeEndpoint ? 'shader-edge-internal-runtime-endpoint' : '']
          .filter(Boolean)
          .join(' '),
        data: {
          ...edge.data,
          weight: edge.data?.weight ?? 1,
          mode: edge.data?.mode ?? 'set',
          enabled: edge.data?.enabled !== false,
          isIncidentToDisabledNode: disabledNodeIds.has(edge.source) || disabledNodeIds.has(edge.target),
          onWeightChange: updateEdgeWeight,
          onModeChange: updateEdgeMode,
          onEnabledChange: updateEdgeEnabled,
          onInsertNode: insertNodeOnEdge,
          onReconnect,
          onReconnectStart,
          onReconnectEnd,
          isReconnecting: edge.id === reconnectingEdgeId,
          showLinkControls: edge.selected === true && selectedEdgeCount === 1,
          isConnectedToSelectedNode,
          isDimmedBySelection: hasHighlightedLinks && !isHighlighted,
        },
      };
    });
  }, [edges, insertNodeOnEdge, nodes, routingSelection, onReconnect, onReconnectStart, onReconnectEnd, reconnectingEdgeId, updateEdgeEnabled, updateEdgeMode, updateEdgeWeight]);

  const materializedGraph = useMemo(
    () => materializeRootGraph(nodesWithCallbacks, edgesWithCallbacks, areas, editingStack, patchName),
    [areas, edgesWithCallbacks, editingStack, nodesWithCallbacks, patchName],
  );
  const isEditingSubpatch = editingStack.length > 0;
  const canGroupSelection = useMemo(() => (
    nodes.some((node) => node.selected) &&
    nodes.filter((node) => node.selected).every((node) => node.data.patchNode.type !== null)
  ), [nodes]);
  const canScaleSelection = selectedNodeCount > 0;
  const patch = useMemo(() => ({
    ...patchFromFlow(materializedGraph.nodes, materializedGraph.edges, editingStack.length === 0 ? areas : editingStack[0]?.parentAreas),
    name: rootPatchName,
    ...(hosted?.getDocument().schemaVersion ? { schemaVersion: 1 as const } : {}),
    ...(selectedMidiInputDeviceIds.length > 0 || selectedMidiOutputDeviceIds.length > 0 || midiClockOutputEnabled
      ? { midiInput: {
        selectedDeviceIds: selectedMidiInputDeviceIds,
        ...(selectedMidiOutputDeviceIds.length > 0 ? { selectedOutputDeviceIds: selectedMidiOutputDeviceIds } : {}),
        ...(midiClockOutputEnabled ? { sendClock: true } : {}),
      } }
      : {}),
  }), [areas, editingStack, materializedGraph, midiClockOutputEnabled, rootPatchName, selectedMidiInputDeviceIds, selectedMidiOutputDeviceIds]);
  const hostedInitialViewRef = useRef(false);
  useEffect(() => {
    if (hosted && !hostedInitialViewRef.current) { hostedInitialViewRef.current = true; return; }
    if (hosted) void hosted.edit(retainNestedBufferReferences({ ...patch, ...(Object.keys(bufferAssets).length ? { buffers: bufferAssets } : {}) }, hosted.getDocument()));
  }, [hosted, patch, bufferAssets]);
  const fm1LiveState = useFm1LiveEdit(patch, fm1Mode && fm1Live, fm1Preset, () => setFm1Live(false));
  fm1BusyRef.current = fm1LiveState.busy;
  const trimmedRootPatchName = rootPatchName.trim();
  const selectedLocalPatch = localPatchLibrary?.patches.find((entry) => entry.name === localPatchLibrary.selectedPatchName) ?? null;
  const selectedSample = sampleLibrary?.samples.find((sample) => sample.url === sampleLibrary.selectedUrl) ?? null;
  const selectedImage = imageLibrary?.images.find((image) => image.url === imageLibrary.selectedUrl) ?? null;
  const selectedSubpatchCandidate = subpatchImportModal?.candidates.find((candidate) => candidate.key === subpatchImportModal.selectedKey) ?? null;
  const selectedLocalSubpatch = localSubpatchImport?.subpatches.find((entry) => entry.name === localSubpatchImport.selectedSubpatchName) ?? null;
  const dspPatch = useMemo(() => stripPatchForDsp(patch), [patch]);
  const liveDspPatch = useMemo(() => patchWithMidiControlVisuals(dspPatch, midiControlVisuals), [dspPatch, midiControlVisuals]);
  const dspPatchKey = useMemo(() => patchToDspKey(liveDspPatch), [liveDspPatch]);
  // `liveDspPatch` is rebuilt from editor state on every canvas move. Its key
  // contains every DSP-relevant field, so using the key as the memo boundary
  // prevents a layout-only update from recompiling the program.
  const audioGraph = useMemo(() => {
    const prepared = preparePatch(liveDspPatch);
    const program = 'program' in prepared ? prepared.program : compilePatchToDspProgram({ nodes: [], links: [] });
    return { ...program, errors: [...new Set([...program.errors, ...prepared.diagnostics.filter(d => d.severity === 'error').map(d => d.message)])] };
  }, [dspPatchKey]);
  const preservedBufferNodeIds = useMemo(() => preservedBufferIds(audioGraph), [audioGraph]);
  const referencedBufferAssets = useMemo(() => filterBufferAssets(bufferAssets, preservedBufferNodeIds), [bufferAssets, preservedBufferNodeIds]);
  const persistedEditorStateJson = useMemo(() => {
    const state = flowToEditorState(materializedGraph.nodes, materializedGraph.edges, {
      patchName: rootPatchName,
      viewport: viewportRef.current,
      fm1Mode,
      ...(selectedMidiInputDeviceIds.length > 0 || selectedMidiOutputDeviceIds.length > 0 || midiClockOutputEnabled
        ? { midiInput: {
          selectedDeviceIds: selectedMidiInputDeviceIds,
          ...(selectedMidiOutputDeviceIds.length > 0 ? { selectedOutputDeviceIds: selectedMidiOutputDeviceIds } : {}),
          ...(midiClockOutputEnabled ? { sendClock: true } : {}),
        } }
        : {}),
    });
    state.areas = areas;
    state.buffers = referencedBufferAssets;
    return JSON.stringify(state);
  }, [areas, fm1Mode, materializedGraph, midiClockOutputEnabled, referencedBufferAssets, rootPatchName, selectedMidiInputDeviceIds, selectedMidiOutputDeviceIds]);
  persistedEditorStateJsonRef.current = persistedEditorStateJson;
  const dspDiagnostics = useMemo(
    () => classifyDspErrors(audioGraph.errors, dspPatch),
    [audioGraph, dspPatchKey],
  );
  const monitorLinkIdByNode = useMemo(() => {
    const linkIdsByNode = new Map<string, string>();
    for (const nodeId of Object.keys(audioGraph.monitorIds)) {
      linkIdsByNode.set(nodeId, nodeId);
    }
    return linkIdsByNode;
  }, [audioGraph]);
  const activeDspGroupIds = useMemo(() => editingStack.map((frame) => frame.groupId), [editingStack]);

  const nodesWithGroupUi = useMemo(() => nodesWithCallbacks.map((node) => {
    const groupNode = node.data.patchNode;
    if (groupNode.type !== 'Group' || !groupNode.subpatch) return node;
    const layout = groupUiPreviewLayout(groupNode.subpatch);
    if (!layout) return node;
    const previewNodes = layout.nodes.map((innerNode) => {
      const previewId = `__group_ui__${node.id}__${innerNode.id}`;
      const override = groupNode.subpatchUiOverrides?.[innerNode.id];
      const effectiveParams = { ...innerNode.params, ...override?.params };
      const effectiveInnerNode = {
        ...innerNode,
        params: effectiveParams,
        ...(override?.customWave ? { customWave: normalizeCustomWave(override.customWave, effectiveParams) } : {}),
      };
      const dspNodeId = scopedDspNodeId(innerNode.id, [...activeDspGroupIds, node.id]);
      const monitorLinkId = monitorLinkIdByNode.get(dspNodeId);
      const midiControlVisual = midiControlVisuals[previewId];
      const data = {
        ...nodeCallbacksPlaceholder(),
        patchNode: { ...effectiveInnerNode, id: previewId, position: undefined, params: { ...effectiveParams, ...hostedTransient[dspNodeId] } },
        isCanvasLocked: canvasLocked,
        canvasZoom: settledGraphZoom,
        isAreaUiCollapsedPresentation: true,
        isTypePickerOpen: false,
        ...(innerNode.type === 'MidiNote'
          || innerNode.type === 'MidiNoteOn'
          || innerNode.type === 'MidiNoteOff'
          || innerNode.type === 'MidiCc'
          || innerNode.type === 'Slider'
          || innerNode.type === 'Joystick'
          || innerNode.type === 'Button'
          || innerNode.type === 'Tempo'
          ? {
              midiInput: audio.midiInput,
              onMidiInputRefresh: audio.refreshMidiInputDevices,
            }
          : {}),
        onParamChange: (_previewNodeId: string, port: string, value: number) => sendHostedGesture(dspNodeId, innerNode.type, { [port]: value }) || updateGroupUiNodeOverride(
          node.id, innerNode.id, `param:${innerNode.id}:${port}`,
          (current) => ({ ...current, params: { ...current.params, [port]: value } }),
        ),
        onParamsChange: (_previewNodeId: string, values: Record<string, number>) => sendHostedGesture(dspNodeId, innerNode.type, values) || updateGroupUiNodeOverride(
          node.id, innerNode.id, `params:${innerNode.id}`,
          (current) => ({ ...current, params: { ...current.params, ...values } }),
        ),
        onCustomWaveChange: (_previewNodeId: string, customWave: CustomWaveSettings, historyKey?: string) => updateGroupUiNodeOverride(
          node.id, innerNode.id, historyKey ?? `custom-wave:${innerNode.id}`,
          (current) => ({ ...current, customWave: normalizeCustomWave(customWave, { ...innerNode.params, ...current.params }) }),
        ),
        onHeaderDoubleClick: () => resetGroupUiNodeOverride(node.id, innerNode.id),
        ...(monitorLinkId && innerNode.type === 'Meter' ? { audioMeter: audio.linkMeters[monitorLinkId] } : {}),
        ...(monitorLinkId && innerNode.type === 'Scope' ? { audioScope: audio.linkScopes[dspNodeId] } : {}),
        ...(monitorLinkId && innerNode.type === 'FFT' ? { audioSpectrum: audio.linkScopes[dspNodeId] } : {}),
        // Meter messages can arrive just after playback stops. Do not let that
        // stale runtime reading mask the saved control value while offline.
        ...(audio.status === 'running' && monitorLinkId && innerNode.type === 'Slider'
          ? { audioSliderValue: audio.linkMeters[monitorLinkId]?.output }
          : {}),
        ...(midiControlVisual?.sliderValue !== undefined ? { midiSliderValue: midiControlVisual.sliderValue } : {}),
        ...(midiControlVisual?.joystickX !== undefined || midiControlVisual?.joystickY !== undefined
          ? {
              midiJoystickPosition: {
                ...(midiControlVisual.joystickX !== undefined ? { x: midiControlVisual.joystickX } : {}),
                ...(midiControlVisual.joystickY !== undefined ? { y: midiControlVisual.joystickY } : {}),
              },
            }
          : {}),
        ...(midiControlVisual?.buttonPressed !== undefined ? { midiButtonPressed: midiControlVisual.buttonPressed } : {}),
        ...(monitorLinkId && (innerNode.type === 'Sequencer' || innerNode.type === 'Roll') ? { audioSequencerStep: audio.linkMeters[monitorLinkId]?.output } : {}),
        ...((innerNode.type === 'CustomWave' || innerNode.type === 'SamplePlayer') ? { audioPlayheads: audio.playheads[dspNodeId] } : {}),
        ...(innerNode.type === 'CustomWave' ? { audioCustomWaveFrequency: audio.linkMeters[`${dspNodeId}:frequency`]?.input } : {}),
        ...(innerNode.type === 'Buffer' ? { audioBuffer: audio.buffers[dspNodeId] } : {}),
        ...(innerNode.type === 'Buffer' && (!hosted || hosted.capabilities.bufferMutation) ? { onBufferClear: () => clearBufferRecording(dspNodeId) } : {}),
        ...(innerNode.type === 'SamplePlayer' ? { audioSampleParams: samplePlayerVisualizationParams(dspNodeId, audio.linkMeters) } : {}),
      } satisfies ShaderNodeData;
      return {
        id: previewId,
        position: {
          x: (innerNode.position?.x ?? 0) - layout.position.x,
          y: (innerNode.position?.y ?? 0) - layout.position.y,
        },
        data,
      };
    });
    return {
      ...node,
      data: { ...node.data, groupUiPreview: { width: layout.size.width, height: layout.size.height, nodes: previewNodes } },
    };
  }), [
    hostedTransient, sendHostedGesture,
    activeDspGroupIds,
    audio.buffers,
    audio.midiInput,
    audio.refreshMidiInputDevices,
    clearBufferRecording,
    audio.linkMeters,
    audio.linkScopes,
    audio.playheads,
    audio.status,
    canvasLocked,
    midiControlVisuals,
    monitorLinkIdByNode,
    nodesWithCallbacks,
    settledGraphZoom,
    resetGroupUiNodeOverride,
    updateGroupUiNodeOverride,
  ]);

  const renderedNodes = useMemo(() => {
    const nextNodes = nodesWithGroupUi.map((sourceNode) => {
    const dspNodeId = runtimeDspNodeIdForFlowNode(sourceNode, nodesWithGroupUi, activeDspGroupIds);
    const node = hostedTransient[dspNodeId] ? { ...sourceNode, data: { ...sourceNode.data, patchNode: { ...sourceNode.data.patchNode, params: { ...sourceNode.data.patchNode.params, ...hostedTransient[dspNodeId] } } } } : sourceNode;
    const monitorLinkId = monitorLinkIdByNode.get(dspNodeId);
    const audioOutputLeft = audio.linkMeters[`${dspNodeId}:left`]?.output ?? 0;
    const audioOutputRight = audio.linkMeters[`${dspNodeId}:right`]?.output ?? 0;
    const dspErrors = dspDiagnostics.nodeErrors.get(dspNodeId) ?? [];
    const hasAudioMonitor = Boolean(monitorLinkId);
    const hasAudioOutputMeter = node.data.patchNode.type === 'AudioOut';
    const midiControlVisual = midiControlVisuals[node.id];
    const audioSelectorIndex = node.data.patchNode.type === 'Selector'
      ? audio.linkMeters[`${dspNodeId}:selector`]?.output
      : undefined;
    const audioAccumulatorValue = node.data.patchNode.type === 'Accumulator'
      ? audio.linkMeters[`${dspNodeId}:accumulator`]?.output
      : undefined;
    const audioImageX = node.data.patchNode.type === 'Image'
      ? audio.linkMeters[`${dspNodeId}:image-x`]?.output
      : undefined;
    const audioImageY = node.data.patchNode.type === 'Image'
      ? audio.linkMeters[`${dspNodeId}:image-y`]?.output
      : undefined;
    const audioImagePosition = typeof audioImageX === 'number' && typeof audioImageY === 'number'
      ? { x: audioImageX, y: audioImageY }
      : undefined;
    const showsPlaybackVisual = node.data.patchNode.type === 'CustomWave' || node.data.patchNode.type === 'SamplePlayer';
    const audioPlayheads = showsPlaybackVisual ? audio.playheads[dspNodeId] : undefined;
    const showsBufferVisual = node.data.patchNode.type === 'Buffer';
    const audioBuffer = showsBufferVisual ? audio.buffers[dspNodeId] : undefined;
    const audioSampleParams = node.data.patchNode.type === 'SamplePlayer'
      ? samplePlayerVisualizationParams(dspNodeId, audio.linkMeters)
      : undefined;
    if (!hasAudioMonitor && !hasAudioOutputMeter && audioSelectorIndex === undefined && audioAccumulatorValue === undefined && !audioImagePosition && !midiControlVisual && dspErrors.length === 0 && !showsPlaybackVisual && !showsBufferVisual) return node;

    return {
      ...node,
      data: {
        ...node.data,
        ...(dspErrors.length > 0 ? { dspErrors } : {}),
        ...(hasAudioOutputMeter ? { audioOutputMeter: { left: audioOutputLeft, right: audioOutputRight } } : {}),
        ...(monitorLinkId && node.data.patchNode.type === 'Meter' ? { audioMeter: audio.linkMeters[monitorLinkId] } : {}),
        ...(monitorLinkId && node.data.patchNode.type === 'Scope' ? { audioScope: audio.linkScopes[dspNodeId] } : {}),
        ...(monitorLinkId && node.data.patchNode.type === 'FFT' ? { audioSpectrum: audio.linkScopes[dspNodeId] } : {}),
        ...(audio.status === 'running' && monitorLinkId && node.data.patchNode.type === 'Slider'
          ? { audioSliderValue: audio.linkMeters[monitorLinkId]?.output }
          : {}),
        ...(audioSelectorIndex !== undefined ? { audioSelectorIndex } : {}),
        ...(audioAccumulatorValue !== undefined ? { audioAccumulatorValue } : {}),
        ...(audioImagePosition ? { audioImagePosition } : {}),
        ...(monitorLinkId && (node.data.patchNode.type === 'Sequencer' || node.data.patchNode.type === 'Roll') ? { audioSequencerStep: audio.linkMeters[monitorLinkId]?.output } : {}),
        ...(audioPlayheads !== undefined ? { audioPlayheads } : {}),
        ...(node.data.patchNode.type === 'CustomWave' ? { audioCustomWaveFrequency: audio.linkMeters[`${dspNodeId}:frequency`]?.input } : {}),
        ...(audioBuffer !== undefined ? { audioBuffer } : {}),
        ...(showsBufferVisual && (!hosted || hosted.capabilities.bufferMutation) ? { onBufferClear: () => clearBufferRecording(dspNodeId) } : {}),
        ...(audioSampleParams ? { audioSampleParams } : {}),
        ...(midiControlVisual?.sliderValue !== undefined ? { midiSliderValue: midiControlVisual.sliderValue } : {}),
        ...(midiControlVisual?.joystickX !== undefined || midiControlVisual?.joystickY !== undefined
          ? {
              midiJoystickPosition: {
                ...(midiControlVisual.joystickX !== undefined ? { x: midiControlVisual.joystickX } : {}),
                ...(midiControlVisual.joystickY !== undefined ? { y: midiControlVisual.joystickY } : {}),
              },
            }
          : {}),
        ...(midiControlVisual?.buttonPressed !== undefined ? { midiButtonPressed: midiControlVisual.buttonPressed } : {}),
      },
    };
    });
    const reconciledNodes = reuseUnchangedNodePresentations(renderedNodeCacheRef.current, nextNodes);
    renderedNodeCacheRef.current = reconciledNodes;
    return reconciledNodes;
  }, [hostedTransient, activeDspGroupIds, audio.buffers, audio.linkMeters, audio.linkScopes, audio.playheads, audio.status, clearBufferRecording, dspDiagnostics, midiControlVisuals, monitorLinkIdByNode, nodesWithGroupUi]);

  const renderedEdges = useMemo<ShaderFlowEdge[]>(() => {
    const edgeById = new Map(edgesWithCallbacks.map((edge) => [edge.id, edge]));
    const midpoint = (edge: ShaderFlowEdge, visited = new Set<string>()): { x: number; y: number } | null => {
      if (visited.has(edge.id)) return null;
      const sourceNode = reactFlow?.getInternalNode(edge.source);
      const sourceHandle = sourceNode?.internals.handleBounds?.source?.find((handle) => handle.id === edge.sourceHandle);
      const parent = edge.data?.modulatesEdgeId ? edgeById.get(edge.data.modulatesEdgeId) : undefined;
      const parentPoint = parent ? midpoint(parent, new Set([...visited, edge.id])) : null;
      const targetNode = reactFlow?.getInternalNode(edge.target);
      const targetHandle = targetNode?.internals.handleBounds?.target?.find((handle) => handle.id === edge.targetHandle);
      if (sourceNode && sourceHandle && (parentPoint || (targetNode && targetHandle))) {
        const [, x, y] = getShaderEdgePath({
          source: edge.source,
          target: edge.target,
          data: edge.data,
          sourceX: sourceNode.internals.positionAbsolute.x + sourceHandle.x + sourceHandle.width / 2,
          sourceY: sourceNode.internals.positionAbsolute.y + sourceHandle.y + sourceHandle.height / 2,
          sourcePosition: sourceHandle.position,
          targetX: parentPoint?.x ?? targetNode!.internals.positionAbsolute.x + targetHandle!.x + targetHandle!.width / 2,
          targetY: parentPoint?.y ?? targetNode!.internals.positionAbsolute.y + targetHandle!.y + targetHandle!.height / 2,
          targetPosition: parentPoint ? Position.Left : targetHandle!.position,
        });
        return { x, y };
      }
      const source = nodes.find((node) => node.id === edge.source);
      const target = nodes.find((node) => node.id === edge.target);
      return source && target ? { x: (source.position.x + target.position.x) / 2, y: (source.position.y + target.position.y) / 2 } : null;
    };
    return [...edgesWithCallbacks.map((edge) => {
      const dspErrors = dspDiagnostics.edgeErrors.get(edge.id) ?? [];
      const targetPoint = edge.data?.modulatesEdgeId
        ? midpoint(edgeById.get(edge.data.modulatesEdgeId) ?? edge)
        : null;
      if (dspErrors.length === 0 && edge.id !== weightTargetEdgeId && !targetPoint) return edge;
      return {
        ...edge,
        data: {
          ...edge.data!,
          ...(dspErrors.length > 0 ? { dspErrors } : {}),
          isWeightTarget: edge.id === weightTargetEdgeId,
          ...(targetPoint ? { visualTarget: targetPoint } : {}),
        },
      };
    }), ...routingSelection.pairs.map(([source, target]): ShaderFlowEdge => ({
      id: `virtual-route:${JSON.stringify([source, target])}`,
      type: 'virtualRoute',
      source,
      target,
      sourceHandle: 'virtual:send',
      targetHandle: 'virtual:receive',
      selectable: false,
      deletable: false,
      reconnectable: false,
      focusable: false,
      style: {
        pointerEvents: 'none',
        color: routingNodeColor(nodes.find((node) => node.id === source)?.data.patchNode.params.number),
      },
    }))];
  }, [dspDiagnostics, edgesWithCallbacks, reactFlow, routingSelection, nodes, nodesInitialized, weightTargetEdgeId]);

  const collapsedAreaByNode = useMemo(() => {
    const collapsedAreas = areas.filter((area) => area.collapsed);
    return new Map(renderedNodes.flatMap((node) => {
      const area = innermostAreaContainingNode(collapsedAreas, node);
      return area ? [[node.id, area] as const] : [];
    }));
  }, [areas, renderedNodes]);

  const collapsedUiAreaByNode = useMemo(() => new Map(renderedNodes.flatMap((node) => {
    const area = collapsedAreaByNode.get(node.id);
    return area && (
      nodeIsInAreaUiSection(area, node)
      || (area.kind === 'spread' && area.spreadNodeId === node.id)
    ) ? [[node.id, area] as const] : [];
  })), [collapsedAreaByNode, renderedNodes]);

  const collapsedRenderedNodes = useMemo(() => renderedNodes.map((node) => (
    collapsedAreaByNode.has(node.id) && !collapsedUiAreaByNode.has(node.id) ? {
      ...node,
      selected: false,
      draggable: false,
      selectable: false,
      connectable: false,
      data: { ...node.data, isAreaCollapsedPresentation: true },
    } : collapsedUiAreaByNode.has(node.id) ? {
      ...node,
      selected: false,
      draggable: false,
      selectable: false,
      connectable: node.data.patchNode.type === 'Spread' || node.data.patchNode.type === 'Spawn',
      // React Flow disables pointer events when a node is neither selectable nor
      // draggable. This presentation is intentionally canvas-locked, but its
      // surfaced controls must remain operable.
      style: { ...node.style, pointerEvents: 'all' as const },
      data: { ...node.data, isAreaUiCollapsedPresentation: true },
    } : node
  )), [collapsedAreaByNode, collapsedUiAreaByNode, renderedNodes]);

  const collapsedRenderedEdges = useMemo(() => renderedEdges.flatMap((edge) => {
    const containedSourceArea = collapsedAreaByNode.get(edge.source);
    const containedTargetArea = collapsedAreaByNode.get(edge.target);
    if (
      containedSourceArea?.kind === 'spread'
      && containedSourceArea.spreadNodeId === edge.source
      && containedSourceArea.id === containedTargetArea?.id
    ) {
      return [];
    }
    if (
      containedTargetArea?.kind === 'spread'
      && containedTargetArea.spreadNodeId === edge.target
      && containedTargetArea.id === containedSourceArea?.id
    ) {
      return [];
    }
    const sourceArea = containedSourceArea?.kind === 'spread' && containedSourceArea.spreadNodeId === edge.source
      ? undefined
      : containedSourceArea;
    const targetArea = containedTargetArea?.kind === 'spread' && containedTargetArea.spreadNodeId === edge.target
      ? undefined
      : containedTargetArea;

    // Links completely inside one collapsed area have no external presentation.
    if (sourceArea && sourceArea.id === targetArea?.id) return [];

    if (!sourceArea && !targetArea) return [edge];
    return [{
      ...edge,
      reconnectable: false,
      data: {
        ...edge.data,
        isAreaCollapsedPresentation: true,
        weight: edge.data?.weight ?? 1,
        mode: edge.data?.mode ?? 'set',
        enabled: edge.data?.enabled !== false,
        onWeightChange: edge.data?.onWeightChange ?? updateEdgeWeightPlaceholder,
        onModeChange: edge.data?.onModeChange ?? updateEdgeModePlaceholder,
        onInsertNode: edge.data?.onInsertNode ?? insertNodeOnEdgePlaceholder,
        showLinkControls: false,
        ...(sourceArea ? { visualSource: collapsedAreaOutputPin(sourceArea) } : {}),
        ...(targetArea ? { visualTarget: collapsedAreaInputPin(targetArea) } : {}),
      },
    }];
  }), [collapsedAreaByNode, renderedEdges]);

  const duplicateDragPreview = useMemo(() => {
    if (!duplicateDrag?.duplicating) return null;

    const idMap = new Map([...duplicateDrag.nodeIds].map((nodeId) => [nodeId, duplicatePreviewNodeId(nodeId)]));
    const previewNodes = renderedNodes
      .filter((node) => duplicateDrag.nodeIds.has(node.id))
      .map((node): ShaderFlowNode => {
        const id = idMap.get(node.id) ?? duplicatePreviewNodeId(node.id);
        const position = duplicateDrag.currentPositions[node.id] ?? node.position;

        return {
          ...node,
          id,
          position,
          draggable: false,
          selectable: false,
          connectable: false,
          deletable: false,
          className: ['shader-node-preview', node.className ?? ''].filter(Boolean).join(' '),
          data: {
            ...node.data,
            patchNode: {
              ...node.data.patchNode,
              id: node.data.patchNode.id,
              params: { ...node.data.patchNode.params },
              position,
            },
            ...nodeCallbacksPlaceholder(),
            isTypePickerOpen: false,
          },
        };
      });

    const previewEdges = renderedEdges.flatMap((edge) => {
      const link = linkFromEdge(edge);
      if (!link) return [];

      const fromSelected = duplicateDrag.nodeIds.has(link.from.node);
      const toSelected = duplicateDrag.nodeIds.has(link.to.node);
      if (!fromSelected && !toSelected) return [];
      if (fromSelected !== toSelected && !duplicateDrag.linkExternal) return [];

      const fromNode = idMap.get(link.from.node) ?? link.from.node;
      const toNode = idMap.get(link.to.node) ?? link.to.node;
      if (fromNode === link.from.node && toNode === link.to.node) return [];

      return [{
        ...edgeFromLink({
          from: { ...link.from, node: fromNode },
          to: { ...link.to, node: toNode },
          weight: link.weight,
          mode: link.mode,
          enabled: link.enabled,
          weightModulations: link.weightModulations,
        }, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder),
        selectable: false,
        deletable: false,
        className: 'shader-edge shader-edge-preview',
      }];
    });

    return { nodes: previewNodes, edges: previewEdges };
  }, [duplicateDrag, renderedEdges, renderedNodes]);

  const areaDuplicatePreview = useMemo(() => {
    if (!areaDuplicateDrag?.duplicating) return null;

    const sourceAreaIds = new Set(Object.keys(areaDuplicateDrag.areaPositions));
    const sourceNodeIds = new Set(Object.keys(areaDuplicateDrag.nodePositions));
    const nodeIdMap = new Map([...sourceNodeIds].map((nodeId) => [nodeId, duplicatePreviewNodeId(nodeId)]));
    const nodes = collapsedRenderedNodes
      .filter((node) => sourceNodeIds.has(node.id))
      .map((node): ShaderFlowNode => {
        const id = nodeIdMap.get(node.id) ?? duplicatePreviewNodeId(node.id);
        const position = areaDuplicateDrag.currentNodePositions[node.id] ?? node.position;
        return {
          ...node,
          id,
          position,
          draggable: false,
          selectable: false,
          connectable: false,
          deletable: false,
          className: ['shader-node-preview', node.className ?? ''].filter(Boolean).join(' '),
          data: {
            ...node.data,
            patchNode: { ...node.data.patchNode, position },
            ...nodeCallbacksPlaceholder(),
            isTypePickerOpen: false,
          },
        };
      });
    const edges = renderedEdges.flatMap((edge) => {
      const link = linkFromEdge(edge);
      if (!link) return [];
      const fromSelected = sourceNodeIds.has(link.from.node);
      const toSelected = sourceNodeIds.has(link.to.node);
      if (!fromSelected && !toSelected) return [];
      if (fromSelected !== toSelected && !areaDuplicateDrag.linkExternal) return [];
      const fromNode = nodeIdMap.get(link.from.node) ?? link.from.node;
      const toNode = nodeIdMap.get(link.to.node) ?? link.to.node;
      if (fromNode === link.from.node && toNode === link.to.node) return [];
      return [{
        ...edgeFromLink({
          from: { ...link.from, node: fromNode },
          to: { ...link.to, node: toNode },
          weight: link.weight,
          mode: link.mode,
          enabled: link.enabled,
          weightModulations: link.weightModulations,
        }, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder),
        selectable: false,
        deletable: false,
        className: 'shader-edge shader-edge-preview',
      }];
    });
    const previewAreas = areas
      .filter((area) => sourceAreaIds.has(area.id))
      .map((area): EditorArea => ({
        ...area,
        id: `${DUPLICATE_AREA_PREVIEW_PREFIX}${area.id}`,
        position: areaDuplicateDrag.currentAreaPositions[area.id] ?? area.position,
        ...(area.spreadNodeId ? { spreadNodeId: nodeIdMap.get(area.spreadNodeId) ?? area.spreadNodeId } : {}),
      }));
    return { areas: previewAreas, nodes, edges };
  }, [areaDuplicateDrag, areas, collapsedRenderedNodes, renderedEdges]);

  const draftNodePreview = useMemo(() => {
    if (!draftNodeConnection?.modifierActive || !reactFlow) return null;

    const position = draftNodePosition(draftNodeConnection, reactFlow);
    const link = linkForDraftNodeConnection(draftNodeConnection, DRAFT_NODE_PREVIEW_ID);
    if (!link) return null;

    const node: ShaderFlowNode = {
      id: DRAFT_NODE_PREVIEW_ID,
      type: 'shaderNode',
      position,
      draggable: false,
      selectable: false,
      connectable: false,
      deletable: false,
      className: 'shader-node-preview',
      data: {
        patchNode: {
          id: 'new',
          type: null,
          params: {},
          position,
        },
        ...nodeCallbacksPlaceholder(),
        isTypePickerOpen: false,
      },
    };

    return {
      node,
      edge: {
        ...edgeFromLink(link, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder),
        id: `preview:${edgeId(link)}`,
        selectable: false,
        deletable: false,
        className: 'shader-edge shader-edge-preview',
      },
    };
  }, [draftNodeConnection, reactFlow]);

  const displayNodes = useMemo(() => [
    ...collapsedRenderedNodes,
    ...(duplicateDragPreview?.nodes ?? []),
    ...(areaDuplicatePreview?.nodes ?? []),
    ...(draftNodePreview ? [draftNodePreview.node] : []),
  ], [areaDuplicatePreview, collapsedRenderedNodes, draftNodePreview, duplicateDragPreview]);

  const displayEdges = useMemo(() => canvasLocked ? [] : [
    ...collapsedRenderedEdges,
    ...(duplicateDragPreview?.edges ?? []),
    ...(areaDuplicatePreview?.edges ?? []),
    ...(reconnectPreviewEdge ? [reconnectPreviewEdge] : []),
    ...(draftNodePreview ? [draftNodePreview.edge] : []),
  ], [areaDuplicatePreview, canvasLocked, collapsedRenderedEdges, draftNodePreview, duplicateDragPreview, reconnectPreviewEdge]);

  const panTranslateExtent = useMemo(
    () => translateExtentForVisibleContent(renderedNodes, settledViewport, editorSize),
    [editorSize, renderedNodes, settledViewport.zoom],
  );

  useEffect(() => {
    if (!hosted) audio.syncGraph(audioGraph);
  }, [audio.syncGraph, audioGraph]);

  const checkpointPreservedBuffers = useCallback((): Promise<Record<string, BufferAsset>> => {
    if (hosted) return Promise.resolve(bufferAssetsRef.current);
    if (bufferCheckpointRef.current) return bufferCheckpointRef.current;
    const loadGeneration = bufferLoadGenerationRef.current;
    const checkpoint = (async () => {
      const nextAssets = filterBufferAssets(bufferAssetsRef.current, preservedBufferIds(audioGraph));
      await Promise.all([...preservedBufferIds(audioGraph)].map(async (nodeId) => {
        const snapshot = await audio.captureBuffer(nodeId);
        if (snapshot) nextAssets[nodeId] = await storeBufferSnapshot(snapshot);
      }));
      if (bufferLoadGenerationRef.current !== loadGeneration) return bufferAssetsRef.current;
      replaceBufferAssets(nextAssets);
      await removeUnreferencedBufferContents(Object.values(nextAssets).map((asset) => asset.hash));
      return nextAssets;
    })().finally(() => {
      bufferCheckpointRef.current = null;
    });
    bufferCheckpointRef.current = checkpoint;
    return checkpoint;
  }, [audio.captureBuffer, audioGraph, replaceBufferAssets]);

  useEffect(() => {
    if (hosted || audio.status !== 'running' || preservedBufferNodeIds.size === 0) return;
    const interval = window.setInterval(() => {
      void checkpointPreservedBuffers().catch(() => undefined);
    }, BUFFER_CHECKPOINT_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [audio.status, checkpointPreservedBuffers, preservedBufferNodeIds]);

  const previousAudioStatusRef = useRef(audio.status);
  useEffect(() => {
    const previousStatus = previousAudioStatusRef.current;
    previousAudioStatusRef.current = audio.status;
    if (!hosted && previousStatus === 'running' && audio.status !== 'running' && preservedBufferNodeIds.size > 0) {
      void checkpointPreservedBuffers().catch(() => undefined);
    }
  }, [audio.status, checkpointPreservedBuffers, preservedBufferNodeIds]);

  useEffect(() => {
    if (hosted) return;
    const checkpointWhenHidden = () => {
      if (document.visibilityState === 'hidden' && preservedBufferNodeIds.size > 0) {
        void checkpointPreservedBuffers().catch(() => undefined);
      }
    };
    document.addEventListener('visibilitychange', checkpointWhenHidden);
    return () => document.removeEventListener('visibilitychange', checkpointWhenHidden);
  }, [checkpointPreservedBuffers, preservedBufferNodeIds]);

  useEffect(() => {
    if (!reactFlow || !isFiniteCoordinateExtent(panTranslateExtent)) return;

    const clampedViewport = clampViewportToTranslateExtent(settledViewport, panTranslateExtent, editorSize);
    if (clampedViewport.x === settledViewport.x && clampedViewport.y === settledViewport.y && clampedViewport.zoom === settledViewport.zoom) {
      return;
    }

    viewportRef.current = clampedViewport;
    setSettledViewport(clampedViewport);
    if (!hosted) storeViewport(clampedViewport);
    void reactFlow.setViewport(clampedViewport);
  }, [editorSize, panTranslateExtent, reactFlow, settledViewport]);

  useEffect(() => {
    const scopeRequests: ScopeCaptureRequest[] = nodesWithCallbacks.flatMap((node): ScopeCaptureRequest[] => {
      const type = node.data.patchNode.type;
      if (type !== 'Scope' && type !== 'FFT') return [];
      const hasConnectedOutput = edges.some((edge) => edge.source === node.id && edge.data?.enabled !== false);
      if (node.id !== fullscreenScopeId && !isNodeVisibleInViewport(node, settledViewport, editorSize) && (type === 'Scope' || !hasConnectedOutput)) return [];
      const dspNodeId = runtimeDspNodeIdForFlowNode(node, nodesWithCallbacks, activeDspGroupIds);
      const linkId = monitorLinkIdByNode.get(dspNodeId);
      if (!linkId) return [];
      return type === 'FFT'
        ? [{ id: dspNodeId, length: 0.012, points: 512 }]
        : [{
          id: dspNodeId,
          length: node.data.patchNode.params.length ?? 0.08,
          ...(node.id === fullscreenScopeId ? { points: 512 } : {}),
          reset: Math.round(node.data.patchNode.params.reset ?? 1) === 1 ? 'zero-crossing' : 'none',
        }];
    });
    audio.setLinkScopes(scopeRequests);
  }, [activeDspGroupIds, audio.setLinkScopes, editorSize, edges, fullscreenScopeId, monitorLinkIdByNode, nodesWithCallbacks, settledViewport]);

  useEffect(() => {
    if (!hosted) window.localStorage.setItem(STORAGE_KEY, persistedEditorStateJson);
  }, [persistedEditorStateJson]);

  useEffect(() => {
    if (hosted) return;
    const persistLatestEditorState = () => {
      const json = persistedEditorStateJsonRef.current;
      if (json !== null) window.localStorage.setItem(STORAGE_KEY, json);
      storeViewport(viewportRef.current);
    };
    window.addEventListener('pagehide', persistLatestEditorState);
    return () => window.removeEventListener('pagehide', persistLatestEditorState);
  }, []);

  const applyNodeChangesNow = useCallback((changes: NodeChange<ShaderFlowNode>[]) => {
    if (changes.length === 0) return;
    if (canvasLocked) return;
    const movedIds = new Set(changes.filter((change) => change.type === 'position').map((change) => change.id));
    const appendixChanges: NodeChange<ShaderFlowNode>[] = [];
    for (const appendix of routingAppendicesRef.current) {
      if (movedIds.has(appendix.id)) continue;
      const ownerChange = changes.find((change) => change.type === 'position' && change.id === appendix.ownerId);
      if (ownerChange?.type !== 'position' || !ownerChange.position) continue;
      appendixChanges.push({
        id: appendix.id,
        type: 'position',
        position: {
          x: ownerChange.position.x + appendix.offset.x,
          y: ownerChange.position.y + appendix.offset.y,
        },
        dragging: ownerChange.dragging,
      });
    }
    changes = [...changes, ...appendixChanges];
    const duplicateState = duplicateDragRef.current;
    if (duplicateState?.duplicating) {
      updateDuplicateDrag(syncDuplicateDragPositionsFromChanges(duplicateState, changes));
      setNodes((current) => applyNodeChanges(
        anchorDuplicatedNodePositionChanges(changes, duplicateState.originalPositions),
        current,
      ));
      return;
    }

    if (changes.some((change) => change.type === 'position' && change.dragging === false)) {
      commitHistory('node-position');
    }
    const removedNodeIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
    if (removedNodeIds.size > 0) {
      commitHistory();
      setEdges((current) => current.map((edge) => {
        const modulations = edge.data?.weightModulations;
        if (!modulations?.some((modulation) => removedNodeIds.has(modulation.from.node))) return edge;
        return {
          ...edge,
          data: {
            ...edge.data!,
            weightModulations: modulations.filter((modulation) => !removedNodeIds.has(modulation.from.node)),
          },
        };
      }));
    }
    setNodes((current) => restoreNodeSelectionAfterDeselectedDrag(
      applyNodeChanges(changes, current),
      activeNodeDragSelectionRef.current,
    ));
  }, [canvasLocked, commitHistory, updateDuplicateDrag]);

  const flushQueuedNodeDragChanges = useCallback(() => {
    if (nodeDragAnimationFrameRef.current !== null) {
      cancelAnimationFrame(nodeDragAnimationFrameRef.current);
      nodeDragAnimationFrameRef.current = null;
    }
    const changes = [...pendingNodeDragChangesRef.current.values()];
    pendingNodeDragChangesRef.current.clear();
    applyNodeChangesNow(changes);
  }, [applyNodeChangesNow]);

  useEffect(() => () => {
    if (nodeDragAnimationFrameRef.current !== null) {
      cancelAnimationFrame(nodeDragAnimationFrameRef.current);
    }
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<ShaderFlowNode>[]) => {
    const dragPositionChanges = changes.filter((change) => change.type === 'position' && change.dragging === true);
    const immediateChanges = changes.filter((change) => change.type !== 'position' || change.dragging !== true);

    if (dragPositionChanges.length > 0) {
      for (const change of dragPositionChanges) {
        if (change.type === 'position') pendingNodeDragChangesRef.current.set(change.id, change);
      }
      if (nodeDragAnimationFrameRef.current === null) {
        nodeDragAnimationFrameRef.current = requestAnimationFrame(() => {
          nodeDragAnimationFrameRef.current = null;
          flushQueuedNodeDragChanges();
        });
      }
    }
    if (immediateChanges.length > 0) {
      flushQueuedNodeDragChanges();
      applyNodeChangesNow(immediateChanges);
    }
  }, [applyNodeChangesNow, flushQueuedNodeDragChanges]);

  const onEdgesChange = useCallback((changes: EdgeChange<ShaderFlowEdge>[]) => {
    if (canvasLocked) return;
    const removedIds = new Set(changes.filter((change) => change.type === 'remove').map((change) => change.id));
    if (removedIds.size > 0) {
      commitHistory();
    }
    setEdges((current) => {
      const next = applyEdgeChanges(changes, current);
      if (removedIds.size === 0) return next;
      let size = -1;
      while (size !== removedIds.size) {
        size = removedIds.size;
        for (const edge of next) {
          if (edge.data?.modulatesEdgeId && removedIds.has(edge.data.modulatesEdgeId)) removedIds.add(edge.id);
        }
      }
      return next.filter((edge) => !removedIds.has(edge.id));
    });
  }, [canvasLocked, commitHistory]);

  const onNodeDragStart = useCallback((
    event: globalThis.MouseEvent | TouchEvent,
    node: ShaderFlowNode,
    dragNodes: ShaderFlowNode[],
  ) => {
    const selectionSnapshot = pendingNodeDragSelectionRef.current;
    const duplicating = isDuplicateModifierPressed(event);
    activeNodeDragSelectionRef.current = !duplicating && selectionSnapshot?.nodeId === node.id && selectionSnapshot.preserveSelection
      ? selectionSnapshot
      : null;
    const relatedNodes = dragNodes.length > 0 ? dragNodes : [node];
    const draggedIds = new Set(relatedNodes.map((entry) => entry.id));
    routingAppendicesRef.current = nodesRef.current.flatMap((candidate) => {
      if (duplicating || draggedIds.has(candidate.id)) return [];
      if (candidate.data.patchNode.type !== 'Send' && candidate.data.patchNode.type !== 'Receive') return [];
      const neighbors = new Set(edgesRef.current.flatMap((edge) => {
        if (edge.type === 'virtualRoute') return [];
        if (edge.source === candidate.id) return [edge.target];
        if (edge.target === candidate.id) return [edge.source];
        return [];
      }));
      if (neighbors.size !== 1) return [];
      const ownerId = [...neighbors][0];
      const owner = relatedNodes.find((entry) => entry.id === ownerId);
      if (!owner) return [];
      return [{
        id: candidate.id,
        ownerId,
        offset: { x: candidate.position.x - owner.position.x, y: candidate.position.y - owner.position.y },
      }];
    });
    const positions = Object.fromEntries(relatedNodes.map((entry) => [
      entry.id,
      { ...entry.position },
    ]));
    updateDuplicateDrag({
      nodeIds: new Set(relatedNodes.map((entry) => entry.id)),
      originalPositions: positions,
      currentPositions: positions,
      duplicating,
      linkExternal: isCommandModifierPressed(event),
    });
    if (!activeNodeDragSelectionRef.current) return;

    setNodes((current) => restoreNodeSelectionAfterDeselectedDrag(current, activeNodeDragSelectionRef.current));
    setEdges((current) => restoreEdgeSelectionAfterDeselectedDrag(current, activeNodeDragSelectionRef.current));
  }, [updateDuplicateDrag]);

  const onNodeDrag = useCallback((
    _event: globalThis.MouseEvent | TouchEvent,
    _node: ShaderFlowNode,
    dragNodes: ShaderFlowNode[],
  ) => {
    updateDuplicateDrag((current) => syncDuplicateDragPositions(current, dragNodes));
  }, [updateDuplicateDrag]);

  const onNodeDragStop = useCallback((
    _event: globalThis.MouseEvent | TouchEvent,
    _node: ShaderFlowNode,
    dragNodes: ShaderFlowNode[],
  ) => {
    flushQueuedNodeDragChanges();
    const dragState = duplicateDragRef.current;
    routingAppendicesRef.current = [];
    activeNodeDragSelectionRef.current = null;
    pendingNodeDragSelectionRef.current = null;
    updateDuplicateDrag(null);
    if (!dragState?.duplicating) return;

    const restoredNodes = restoreGraphNodePositions(nodesRef.current, dragState.originalPositions);
    nodesRef.current = restoredNodes;

    const duplicatedGraph = duplicateDraggedGraph(
      restoredNodes,
      edgesRef.current,
      dragState,
      dragState.currentPositions,
      updateEdgeWeight,
      updateEdgeMode,
      insertNodeOnEdgePlaceholder,
    );
    if (duplicatedGraph.nodes.length === 0) return;

    const sourceNodes = restoredNodes.filter((node) => dragState.nodeIds.has(node.id));
    const bufferCopies = duplicatedBufferCopies(
      sourceNodes,
      duplicatedGraph.nodes,
      restoredNodes,
      [...restoredNodes, ...duplicatedGraph.nodes],
      activeDspGroupIds,
    );

    commitHistory();
    setNodes((current) => [
      ...restoreGraphNodePositions(current, dragState.originalPositions)
        .map((node) => ({ ...node, selected: false })),
      ...duplicatedGraph.nodes,
    ]);
    setEdges((current) => dedupeEdges([
      ...current.map((edge) => ({ ...edge, selected: false })),
      ...duplicatedGraph.edges,
    ]));
    copyBufferAssets(bufferCopies, bufferAssetsRef.current, replaceBufferAssets);
    audio.copyBuffers(bufferCopies);
    setEditingTypeNodeId(null);
  }, [activeDspGroupIds, audio.copyBuffers, commitHistory, flushQueuedNodeDragChanges, replaceBufferAssets, updateDuplicateDrag, updateEdgeMode, updateEdgeWeight]);

  useEffect(() => {
    const updateModifier = (event: KeyboardEvent) => {
      const dragState = duplicateDragRef.current;
      if (dragState && event.key === 'Alt') {
        if (event.altKey && !dragState.duplicating) {
          setNodes((current) => restoreGraphNodePositions(current, dragState.originalPositions));
          updateDuplicateDrag({ ...dragState, duplicating: true });
          return;
        }

        if (!event.altKey && dragState.duplicating) {
          commitHistory('node-position');
          setNodes((current) => applyGraphNodePositions(current, dragState.currentPositions));
          updateDuplicateDrag({ ...dragState, duplicating: false });
          return;
        }
      }
      if (dragState && (event.key === 'Meta' || event.key === 'Control' || event.key === 'Shift')) {
        updateDuplicateDrag({ ...dragState, linkExternal: isCommandModifierPressed(event) });
      }

      const areaDrag = areaDragRef.current;
      if (!areaDrag) return;
      if (event.key === 'Alt') {
        if (event.altKey && !areaDrag.duplicating) {
          setAreas((current) => current.map((area) => {
            const position = areaDrag.areaPositions[area.id];
            return position ? { ...area, position: { ...position } } : area;
          }));
          setNodes((current) => applyGraphNodePositions(current, areaDrag.nodePositions));
          areaDrag.duplicating = true;
          setAreaDuplicateDrag({ ...areaDrag });
          return;
        }
        if (!event.altKey && areaDrag.duplicating) {
          if (!areaDrag.historyCommitted) {
            commitHistory();
            areaDrag.historyCommitted = true;
          }
          setAreas((current) => current.map((area) => {
            const position = areaDrag.currentAreaPositions[area.id];
            return position ? { ...area, position: { ...position } } : area;
          }));
          setNodes((current) => applyGraphNodePositions(current, areaDrag.currentNodePositions));
          areaDrag.duplicating = false;
          setAreaDuplicateDrag(null);
          return;
        }
      }
      if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Shift') {
        areaDrag.linkExternal = isCommandModifierPressed(event);
        if (areaDrag.duplicating) setAreaDuplicateDrag({ ...areaDrag });
      }
    };

    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    return () => {
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
    };
  }, [commitHistory, updateDuplicateDrag]);

  const onConnect = useCallback((connection: Connection) => {
    if (canvasLocked) return;
    if (connection.source === DRAFT_NODE_PREVIEW_ID || connection.target === DRAFT_NODE_PREVIEW_ID) {
      setPendingBoundaryPort(null);
      return;
    }

    const pending = pendingBoundaryPortRef.current;
    if (pending) {
      const isPendingSource = pending.side === 'output'
        && connection.source === pending.nodeId
        && connection.sourceHandle === `out:${pending.port}`;
      const isPendingTarget = pending.side === 'input'
        && connection.target === pending.nodeId
        && connection.targetHandle === `in:${pending.port}`;
      if (isPendingSource || isPendingTarget) {
        materializePendingBoundaryPort(pending);
      }
    }

    const link = linkFromConnection(connection, draftNodeConnectionRef.current?.mode);
    if (!link) {
      setPendingBoundaryPort(null);
      return;
    }
    const internalRuntimeSource = nodesRef.current.find((node) => (
      node.id === link.from.node
      && (
        (node.data.patchNode.type === 'Spread' && link.from.port === 'item index')
        || (node.data.patchNode.type === 'Spawn' && link.from.port === 'instance gate')
      )
    ));
    const targetNode = nodesRef.current.find((node) => node.id === link.to.node);
    if (internalRuntimeSource && (!targetNode || !flowNodeIsInsideSpread(internalRuntimeSource, targetNode))) {
      setPendingBoundaryPort(null);
      return;
    }
    const spawnTarget = nodesRef.current.find((node) => (
      node.id === link.to.node
      && node.data.patchNode.type === 'Spawn'
      && link.to.port === 'kill trigger'
    ));
    const sourceNode = nodesRef.current.find((node) => node.id === link.from.node);
    if (spawnTarget && (!sourceNode || !flowNodeIsInsideSpread(spawnTarget, sourceNode))) {
      setPendingBoundaryPort(null);
      return;
    }
    const runtimeControlTarget = nodesRef.current.find((node) => (
      node.id === link.to.node
      && (
        (node.data.patchNode.type === 'Spread' && link.to.port === 'count')
        || (
          node.data.patchNode.type === 'Spawn'
          && (link.to.port === 'trigger' || link.to.port === 'release trigger')
        )
      )
    ));
    if (runtimeControlTarget && sourceNode && flowNodeIsInsideSpread(runtimeControlTarget, sourceNode)) {
      setPendingBoundaryPort(null);
      return;
    }

    commitHistory();
    const edge = edgeFromLink(link, updateEdgeWeight, updateEdgeMode, insertNodeOnEdge);
    nodeConnectionCompletedRef.current = true;
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => dedupeEdges([
      ...current.map((candidate) => ({ ...candidate, selected: false })),
      { ...edge, selected: true },
    ]));
    setPendingBoundaryPort(null);
  }, [canvasLocked, commitHistory, insertNodeOnEdge, materializePendingBoundaryPort, updateEdgeMode, updateEdgeWeight]);

  const onConnectStart = useCallback((event: globalThis.MouseEvent | TouchEvent, params: OnConnectStartParams) => {
    if (canvasLocked) return;
    nodeConnectionCompletedRef.current = false;
    weightTargetEdgeIdRef.current = null;
    setWeightTargetEdgeId(null);
    if (reconnectingEdgeRef.current) {
      updateDraftNodeConnection(null);
      return;
    }

    const pointer = clientPointFromEvent(event);
    if (!pointer || !params.nodeId || !params.handleId || !params.handleType) {
      updateDraftNodeConnection(null);
      setPendingBoundaryPort(null);
      return;
    }

    if (editingStack.length > 0 || nodesRef.current.some((node) => node.data.patchNode.type === 'Params')) {
      const insNode = nodesRef.current.find((node) => node.data.patchNode.type === (editingStack.length > 0 ? 'Ins' : 'Params'));
      const outsNode = editingStack.length > 0 ? nodesRef.current.find((node) => node.data.patchNode.type === 'Outs') : undefined;
      let nextPending: BoundaryPortSelection | null = null;

      if (params.handleType === 'target' && insNode && params.nodeId !== insNode.id) {
        const usedNames = new Set((insNode.data.patchNode.outputs ?? []).map((port) => port.name));
        nextPending = {
          nodeId: insNode.id,
          side: 'output',
          port: uniquePortName(editingStack.length > 0 ? 'new input' : 'new parameter', usedNames),
        };
      }

      if (params.handleType === 'source' && outsNode && params.nodeId !== outsNode.id) {
        const usedNames = new Set((outsNode.data.patchNode.inputs ?? []).map((port) => port.name));
        nextPending = {
          nodeId: outsNode.id,
          side: 'input',
          port: uniquePortName('new output', usedNames),
        };
      }

      setPendingBoundaryPort(nextPending);
    } else {
      setPendingBoundaryPort(null);
    }

    updateDraftNodeConnection({
      originNodeId: params.nodeId,
      originHandleId: params.handleId,
      originHandleType: params.handleType,
      pointer,
      modifierActive: isCommandModifierPressed(event),
      mode: 'set',
    });
  }, [canvasLocked, editingStack.length, updateDraftNodeConnection]);

  const onConnectEnd = useCallback<OnConnectEnd>((event, connectionState) => {
    if (reconnectingEdgeRef.current) {
      updateDraftNodeConnection(null);
      setPendingBoundaryPort(null);
      return;
    }

    // A node handle always owns the drop, even when its existing cable is
    // inside the cable hit area. onConnect already handles this connection.
    if (nodeConnectionCompletedRef.current || (connectionState.toHandle && connectionState.toHandle.nodeId !== DRAFT_NODE_PREVIEW_ID)) {
      nodeConnectionCompletedRef.current = false;
      updateDraftNodeConnection(null);
      setPendingBoundaryPort(null);
      weightTargetEdgeIdRef.current = null;
      setWeightTargetEdgeId(null);
      return;
    }

    let draftConnection = draftNodeConnectionRef.current;
    const pointer = clientPointFromEvent(event);
    if (pointer && draftConnection) {
      draftConnection = {
        ...draftConnection,
        pointer,
        modifierActive: draftConnection.modifierActive || isCommandModifierPressed(event),
      };
    }

    const targetEdgeId = pointer
      ? linkAtScreenPoint(pointer, edgesRef.current)
      : weightTargetEdgeIdRef.current;
    if (targetEdgeId && draftConnection && draftConnection.originHandleType === 'source') {
      const sourcePort = parseHandleId(draftConnection.originHandleId);
      const targetEdge = edgesRef.current.find((candidate) => candidate.id === targetEdgeId);
      if (sourcePort?.kind === 'out' && targetEdge) {
        commitHistory();
        const modulationEdge: ShaderFlowEdge = {
          id: `weight-modulation:${crypto.randomUUID()}`,
          type: 'shaderEdge',
          source: draftConnection.originNodeId,
          sourceHandle: draftConnection.originHandleId,
          target: targetEdge.target,
          targetHandle: targetEdge.targetHandle,
          selected: true,
          reconnectable: false,
          className: 'shader-edge',
          data: {
            weight: 1,
            mode: draftConnection.mode,
            enabled: true,
            modulatesEdgeId: targetEdgeId,
            onWeightChange: updateEdgeWeight,
            onModeChange: updateEdgeMode,
            onInsertNode: insertNodeOnEdge,
          },
        };
        setEdges((current) => dedupeEdges([...current.map((edge) => ({ ...edge, selected: false })), modulationEdge]));
        setNodes((current) => current.map((node) => ({ ...node, selected: false })));
      }
      updateDraftNodeConnection(null);
      setPendingBoundaryPort(null);
      weightTargetEdgeIdRef.current = null;
      setWeightTargetEdgeId(null);
      return;
    }
    updateDraftNodeConnection(null);
    if (!connectionState.toHandle || connectionState.toHandle.nodeId === DRAFT_NODE_PREVIEW_ID) {
      createDraftNodeFromConnection(draftConnection);
    }
    setPendingBoundaryPort(null);
    weightTargetEdgeIdRef.current = null;
    setWeightTargetEdgeId(null);
  }, [commitHistory, createDraftNodeFromConnection, insertNodeOnEdge, updateDraftNodeConnection, updateEdgeMode, updateEdgeWeight]);

  useEffect(() => {
    const updatePointer = (event: PointerEvent) => {
      if (reconnectingEdgeRef.current) {
        const edge = reconnectingEdgeSnapshotRef.current;
        const targetId = edge && !reconnectCancelledRef.current && reconnectFixedHandleRef.current === 'source'
          ? linkAtScreenPoint({ x: event.clientX, y: event.clientY }, edgesRef.current.filter(
            (candidate) => strengthTargetIsAllowed(edge.id, candidate.id, edgesRef.current),
          ))
          : null;
        weightTargetEdgeIdRef.current = targetId;
        setWeightTargetEdgeId(targetId);
        return;
      }
      const draft = draftNodeConnectionRef.current;
      if (!draft) return;
      const targetId = linkAtScreenPoint({ x: event.clientX, y: event.clientY }, edgesRef.current);
      if (draft.originHandleType === 'source' && targetId !== weightTargetEdgeIdRef.current) {
        weightTargetEdgeIdRef.current = targetId;
        setWeightTargetEdgeId(targetId);
      }
      updateDraftNodeConnection({
        ...draft,
        pointer: { x: event.clientX, y: event.clientY },
        modifierActive: isCommandModifierPressed(event),
      });
    };
    const updateModifier = (event: KeyboardEvent) => {
      const draft = draftNodeConnectionRef.current;
      if (!draft) return;
      updateDraftNodeConnection({
        ...draft,
        modifierActive: isCommandModifierPressed(event),
      });
    };

    window.addEventListener('pointermove', updatePointer);
    window.addEventListener('keydown', updateModifier);
    window.addEventListener('keyup', updateModifier);
    return () => {
      window.removeEventListener('pointermove', updatePointer);
      window.removeEventListener('keydown', updateModifier);
      window.removeEventListener('keyup', updateModifier);
    };
  }, [edgesRef, updateDraftNodeConnection]);

  const addNodeAt = useCallback((event: ReactMouseEvent) => {
    if (canvasLocked) return;
    if (!reactFlow) return;
    addDraftNode(reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }));
  }, [addDraftNode, canvasLocked, reactFlow]);

  const toggleCanvasLock = useCallback(() => {
    setCanvasLocked((locked) => !locked);
    setNodes((current) => current.map((node) => ({ ...node, selected: false })));
    setEdges((current) => current.map((edge) => ({ ...edge, selected: false })));
    setSelectedAreaId(null);
    setEditingAreaId(null);
    setEditingTypeNodeId(null);
    setPendingBoundaryPort(null);
    updateDraftNodeConnection(null);
  }, [updateDraftNodeConnection]);

  const showSaveFeedback = useCallback(() => {
    setSaveFeedbackActive(true);
    if (saveFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(saveFeedbackTimeoutRef.current);
    }
    saveFeedbackTimeoutRef.current = window.setTimeout(() => {
      setSaveFeedbackActive(false);
      saveFeedbackTimeoutRef.current = null;
    }, 900);
  }, []);

  const loadPatchJson = useCallback((json: string) => {
    let loadedPatch: Patch;
    try {
      loadedPatch = parsePatchJson(json);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
      return;
    }

    commitHistory();
    const callbacks = nodeCallbacksPlaceholder();
    setEditingStack([]);
    setPendingBoundaryPort(null);
    setNodes(toFlowNodes(loadedPatch, callbacks, null));
    setEdges(toFlowEdges(loadedPatch, updateEdgeWeight, updateEdgeMode, insertNodeOnEdgePlaceholder));
    setAreas(structuredClone(loadedPatch.areas ?? []));
    setSelectedAreaId(null);
    setSurfacedAreaId(null);
    setEditingAreaId(null);
    setPatchName(loadedPatch.name ?? 'single-patch');
    setSelectedMidiInputDeviceIds(normalizeSelectedMidiDeviceIds(loadedPatch.midiInput?.selectedDeviceIds));
    setSelectedMidiOutputDeviceIds(normalizeSelectedMidiDeviceIds(loadedPatch.midiInput?.selectedOutputDeviceIds));
    setMidiClockOutputEnabled(loadedPatch.midiInput?.sendClock === true);
    setMidiControlVisuals({});
    setEditingTypeNodeId(null);
    setImportError(null);
    void restoreBufferAssets(loadedPatch.buffers ?? {}).catch((error) => {
      setImportError(error instanceof Error ? error.message : String(error));
    });
  }, [commitHistory, restoreBufferAssets, updateEdgeMode, updateEdgeWeight]);

  const openLocalPatchLibrary = useCallback(async () => {
    setLocalPatchLibrary({
      patches: [],
      selectedPatchName: null,
      selectedVersionId: null,
      loading: true,
      error: null,
    });

    try {
      const patches = await fetchLocalPatchLibrary();
      const selectedPatch = selectInitialLocalPatch(patches, rootPatchName);
      setLocalPatchLibrary({
        patches,
        selectedPatchName: selectedPatch?.name ?? null,
        selectedVersionId: selectedPatch?.versions[0]?.id ?? null,
        loading: false,
        error: patches.length === 0 ? 'No saved patches found in patches/.' : null,
      });
      setImportError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalPatchLibrary({
        patches: [],
        selectedPatchName: null,
        selectedVersionId: null,
        loading: false,
        error: message,
      });
      setImportError(message);
    }
  }, [rootPatchName]);

  const closeLocalPatchLibrary = useCallback(() => {
    setLocalPatchLibrary(null);
  }, []);

  const selectLocalPatch = useCallback((patchEntry: LocalPatchEntry) => {
    setLocalPatchLibrary((current) => current ? {
      ...current,
      selectedPatchName: patchEntry.name,
      selectedVersionId: patchEntry.versions[0]?.id ?? null,
    } : current);
  }, []);

  const selectLocalPatchVersion = useCallback((version: LocalPatchVersion) => {
    setLocalPatchLibrary((current) => current ? {
      ...current,
      selectedVersionId: version.id,
    } : current);
  }, []);

  const loadSelectedLocalPatch = useCallback(async () => {
    const selectedPatchName = localPatchLibrary?.selectedPatchName;
    const selectedVersionId = localPatchLibrary?.selectedVersionId;
    if (!selectedPatchName || !selectedVersionId) return;

    try {
      loadPatchJson(await fetchLocalPatchVersion(selectedPatchName, selectedVersionId));
      setLocalPatchLibrary(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalPatchLibrary((current) => current ? { ...current, error: message } : current);
      setImportError(message);
    }
  }, [loadPatchJson, localPatchLibrary]);

  const openLocalSubpatchImport = useCallback(async () => {
    setSubpatchImportModal(null);
    setLocalSubpatchImport({
      subpatches: [],
      selectedSubpatchName: null,
      selectedSourceKey: null,
      loading: true,
      error: null,
    });

    try {
      const patches = await fetchLocalPatchLibrary();
      const subpatches = await buildLocalSubpatchImportEntries(patches);
      const selectedSubpatch = subpatches[0] ?? null;
      setLocalSubpatchImport({
        subpatches,
        selectedSubpatchName: selectedSubpatch?.name ?? null,
        selectedSourceKey: selectedSubpatch?.sources[0]?.key ?? null,
        loading: false,
        error: subpatches.length === 0 ? 'No saved subpatches found in patches/.' : null,
      });
      setImportError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalSubpatchImport({
        subpatches: [],
        selectedSubpatchName: null,
        selectedSourceKey: null,
        loading: false,
        error: message,
      });
      setImportError(message);
    }
  }, []);

  const closeLocalSubpatchImport = useCallback(() => {
    setLocalSubpatchImport(null);
  }, []);

  const selectLocalSubpatch = useCallback((entry: LocalSubpatchImportEntry) => {
    setLocalSubpatchImport((current) => current ? {
      ...current,
      selectedSubpatchName: entry.name,
      selectedSourceKey: entry.sources[0]?.key ?? null,
    } : current);
  }, []);

  const selectLocalSubpatchSource = useCallback((source: LocalSubpatchImportSource) => {
    setLocalSubpatchImport((current) => current ? {
      ...current,
      selectedSourceKey: source.key,
    } : current);
  }, []);

  const savePatchJson = useCallback(async (saveAs = false) => {
    if (hosted) {
      if (!hosted.capabilities.save || (saveAs && !hosted.capabilities.saveAs)) { setImportError('The host does not allow this Save operation.'); return; }
      // Snapshot the latest React document before Save, even if an effect is pending.
      void hosted.edit(retainNestedBufferReferences({ ...patch, ...(Object.keys(bufferAssetsRef.current).length ? { buffers: bufferAssetsRef.current } : {}) }, hosted.getDocument()));
      if (await hosted.save(saveAs)) {
        if (hosted.getSnapshot().savedRevision === hosted.getSnapshot().revision) replaceBufferAssets(hosted.getDocument().buffers ?? {});
        setImportError(null); showSaveFeedback();
      }
      else setImportError(hosted.getSnapshot().saveDiagnostics?.map(d => d.message).join('\n') || 'The host did not acknowledge Save. The working document is retained.');
      return;
    }
    let savedBufferAssets: Record<string, BufferAsset>;
    try {
      savedBufferAssets = await checkpointPreservedBuffers();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
      return;
    }
    const savedPatchJson = patchToJson({
      ...patch,
      ...(Object.keys(savedBufferAssets).length > 0 ? { buffers: savedBufferAssets } : {}),
    });

    if (localPatchStorageEnabled) {
      if (trimmedRootPatchName.length === 0) {
        setImportError('Enter a patch name before saving locally.');
        return;
      }

      try {
        await uploadLocalBufferContents(savedBufferAssets);
        await saveLocalPatchVersion(trimmedRootPatchName, savedPatchJson);
        setImportError(null);
        showSaveFeedback();
      } catch (error) {
        setImportError(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    const blob = new Blob([savedPatchJson], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${sanitizePatchFilename(rootPatchName)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    showSaveFeedback();
  }, [checkpointPreservedBuffers, localPatchStorageEnabled, patch, rootPatchName, showSaveFeedback, trimmedRootPatchName]);

  useEffect(() => {
    if (!hosted) return;
    const saveKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        if (!event.repeat) void savePatchJson(event.shiftKey);
      }
    };
    window.addEventListener('keydown', saveKey);
    return () => window.removeEventListener('keydown', saveKey);
  }, [hosted, savePatchJson]);

  const exportPatchPackage = useCallback(async () => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    try {
      const savedBufferAssets = await checkpointPreservedBuffers();
      const exportPatch: Patch = {
        ...patch,
        ...(Object.keys(savedBufferAssets).length > 0 ? { buffers: savedBufferAssets } : {}),
      };
      const compiledPatch: Patch = {
        ...exportPatch,
        nodes: exportPatch.nodes.map((node) => node.type === 'Params' ? { ...node, enabled: true } : node),
      };
      const blob = await createPatchPackage(compiledPatch);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sanitizePatchFilename(rootPatchName)}.zip`;
      document.body.append(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setImportError(null);
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  }, [checkpointPreservedBuffers, patch, rootPatchName]);

  const requestPatchLoad = useCallback(() => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    if (localPatchStorageEnabled) {
      void openLocalPatchLibrary();
      return;
    }
    fileInputRef.current?.click();
  }, [localPatchStorageEnabled, openLocalPatchLibrary]);

  const loadPatchFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    try {
      loadPatchJson(await file.text());
    } catch (error) {
      setImportError(error instanceof Error ? error.message : String(error));
    }
  }, [loadPatchJson]);

  const importSubpatchCandidate = useCallback((candidate: ImportedSubpatchCandidate) => {
    const existingIds = new Set(nodesRef.current.map((node) => node.id));
    const id = makeNodeId('Group', existingIds);
    const position = flowPositionForNewImport(reactFlow, nodesRef.current);
    const inputDefinitions = boundaryPortDefinitions(candidate.subpatch, 'Ins', 'outputs');
    const outputDefinitions = boundaryPortDefinitions(candidate.subpatch, 'Outs', 'inputs').map((port) => ({
      name: port.name,
      ...(port.connectable === undefined ? {} : { connectable: port.connectable }),
      ...(port.min === undefined ? {} : { min: port.min }),
      ...(port.max === undefined ? {} : { max: port.max }),
      ...(port.integer === undefined ? {} : { integer: port.integer }),
    }));

    commitHistory();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      {
        id,
        type: 'shaderNode',
        position,
        selected: true,
        data: {
          patchNode: {
            id,
            type: 'Group',
            subpatchName: candidate.name,
            subpatchCloneId: makeSubpatchCloneId(id),
            params: Object.fromEntries(inputDefinitions.map((port) => [port.name, port.defaultValue ?? 0])),
            position,
            inputs: inputDefinitions,
            outputs: outputDefinitions,
            subpatch: clonePatch(candidate.subpatch),
          },
          ...nodeCallbacksPlaceholder(),
          isTypePickerOpen: false,
        },
      },
    ]);
    setSubpatchImportModal(null);
    setLocalSubpatchImport(null);
    setImportError(null);
  }, [commitHistory, reactFlow]);

  const importSelectedLocalSubpatch = useCallback(() => {
    const selectedSourceKey = localSubpatchImport?.selectedSourceKey;
    const source = localSubpatchImport?.subpatches
      .flatMap((entry) => entry.sources)
      .find((entry) => entry.key === selectedSourceKey);
    if (!source) return;

    importSubpatchCandidate(source.candidate);
  }, [importSubpatchCandidate, localSubpatchImport]);

  const requestSubpatchImport = useCallback(() => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    if (!localPatchStorageEnabled) {
      importFileInputRef.current?.click();
      return;
    }

    void openLocalSubpatchImport();
  }, [localPatchStorageEnabled, openLocalSubpatchImport]);

  const loadSubpatchImportFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;

    try {
      const importedPatch = parsePatchJson(await file.text());
      const candidates = collectSubpatchImportCandidates(importedPatch);
      setLocalSubpatchImport(null);
      setSubpatchImportModal({
        fileName: file.name,
        candidates,
        selectedKey: candidates[0]?.key ?? null,
        error: candidates.length === 0 ? 'No subpatches found in this patch.' : null,
      });
      setImportError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLocalSubpatchImport(null);
      setSubpatchImportModal({
        fileName: file.name,
        candidates: [],
        selectedKey: null,
        error: message,
      });
      setImportError(message);
    }
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => {
      const previous = current.past[current.past.length - 1];
      if (!previous) return current;
      const now = graphSnapshot(nodesRef.current, edgesRef.current, areasRef.current);
      restoreGraphSnapshot(previous, setNodes, setEdges, setAreas);
      setSelectedAreaId(null);
      setSurfacedAreaId(null);
      setEditingAreaId(null);
      return {
        past: current.past.slice(0, -1),
        future: [now, ...current.future].slice(0, HISTORY_LIMIT),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((current) => {
      const next = current.future[0];
      if (!next) return current;
      const now = graphSnapshot(nodesRef.current, edgesRef.current, areasRef.current);
      restoreGraphSnapshot(next, setNodes, setEdges, setAreas);
      setSelectedAreaId(null);
      setSurfacedAreaId(null);
      setEditingAreaId(null);
      return {
        past: [...current.past, now].slice(-HISTORY_LIMIT),
        future: current.future.slice(1),
      };
    });
  }, []);

  const newPatch = useCallback(() => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    setNewPatchConfirmationOpen(true);
  }, []);

  const confirmNewPatch = useCallback(() => {
    setEditingStack([]);
    setPendingBoundaryPort(null);
    setSelectedBoundaryPort(null);
    setPatchName(localPatchStorageEnabled ? '' : 'untitled-patch');
    setSelectedMidiInputDeviceIds([]);
    setMidiClockOutputEnabled(false);
    setMidiControlVisuals({});
    setNodes([]);
    setEdges([]);
    setAreas([]);
    setSelectedAreaId(null);
    setSurfacedAreaId(null);
    setEditingAreaId(null);
    setEditingTypeNodeId(null);
    setHistory({ past: [], future: [] });
    setNewPatchConfirmationOpen(false);
    void restoreBufferAssets({}).catch(() => undefined);
  }, [localPatchStorageEnabled, restoreBufferAssets]);

  useEffect(() => {
    if (!newPatchConfirmationOpen) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setNewPatchConfirmationOpen(false);
    };
    window.addEventListener('keydown', handleEscape, { capture: true });
    return () => window.removeEventListener('keydown', handleEscape, { capture: true });
  }, [newPatchConfirmationOpen]);

  useEffect(() => {
    const handleHistoryKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier) return;

      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        undo();
        return;
      }
      if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleHistoryKeyDown);
    return () => window.removeEventListener('keydown', handleHistoryKeyDown);
  }, [redo, undo]);

  useEffect(() => {
    if (!selectedBoundaryPort) return;

    const node = nodes.find((entry) => entry.id === selectedBoundaryPort.nodeId);
    if (!node) {
      setSelectedBoundaryPort(null);
      return;
    }

    const ports = selectedBoundaryPort.side === 'input'
      ? node.data.patchNode.inputs ?? []
      : node.data.patchNode.outputs ?? [];
    if (!ports.some((port) => port.name === selectedBoundaryPort.port)) {
      setSelectedBoundaryPort(null);
    }
  }, [nodes, selectedBoundaryPort]);

  useEffect(() => {
    if (!selectedBoundaryPort) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.port-name-label')) return;
      setSelectedBoundaryPort(null);
    };

    window.addEventListener('pointerdown', handlePointerDown, { capture: true });
    return () => window.removeEventListener('pointerdown', handlePointerDown, { capture: true });
  }, [selectedBoundaryPort]);

  useEffect(() => {
    const handleSelectedEdgeModeKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableEventTarget(event.target)) return;

      const modeByKey: Record<string, LinkMode> = {
        a: 'add',
        s: 'set',
        m: 'multiply',
        b: 'bend',
      };
      const mode = modeByKey[event.key.toLowerCase()];
      if (!mode) return;

      if (draftNodeConnectionRef.current) {
        updateDraftNodeConnection((current) => current ? { ...current, mode } : null);
      } else if (!setSelectedEdgesMode(mode)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleSelectedEdgeModeKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleSelectedEdgeModeKeyDown, { capture: true });
  }, [setSelectedEdgesMode, updateDraftNodeConnection]);

  useEffect(() => {
    const handleToggleSelectedEdgesKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableEventTarget(event.target) || event.key.toLowerCase() !== 'x') return;
      if (!toggleSelectedNodes() && !toggleSelectedEdges()) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleToggleSelectedEdgesKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleToggleSelectedEdgesKeyDown, { capture: true });
  }, [toggleSelectedEdges, toggleSelectedNodes]);

  useEffect(() => {
    const handleBoundaryPortDeleteKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (!deleteSelectedBoundaryPort()) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleBoundaryPortDeleteKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleBoundaryPortDeleteKeyDown, { capture: true });
  }, [deleteSelectedBoundaryPort]);

  useEffect(() => {
    const handleBridgeDeleteKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (!deleteSelectedNodesWithBridge()) return;

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener('keydown', handleBridgeDeleteKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleBridgeDeleteKeyDown, { capture: true });
  }, [deleteSelectedNodesWithBridge]);

  useEffect(() => {
    const handleClipboardKeyDown = (event: KeyboardEvent) => {
      if (isEditableEventTarget(event.target)) return;
      const hasModifier = event.metaKey || event.ctrlKey;
      if (!hasModifier || event.shiftKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === 'c' && copySelectedNodes()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (key === 'v') {
        event.preventDefault();
        event.stopPropagation();
        void pasteCopiedNodes();
      }
    };

    window.addEventListener('keydown', handleClipboardKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleClipboardKeyDown, { capture: true });
  }, [copySelectedNodes, pasteCopiedNodes]);

  useEffect(() => {
    const handleSelectorIndexKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableEventTarget(event.target)) return;

      const index = selectorIndexFromKeyboardEvent(event);
      if (index === null) return;

      const selectedSelectors = nodesRef.current.filter((node) => (
        node.selected === true && node.data.patchNode.type === 'Selector'
      ));
      if (selectedSelectors.length !== 1) return;

      const selector = selectedSelectors[0];
      const definition = getNodeDefinition(selector.data.patchNode as PatchNode);
      const port = String(index);
      if (!definition.inputs.some((input) => input.name === port)) return;

      event.preventDefault();
      event.stopPropagation();
      updateNodeParam(selector.id, 'select', index);
    };

    window.addEventListener('keydown', handleSelectorIndexKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleSelectorIndexKeyDown, { capture: true });
  }, [updateNodeParam]);

  useEffect(() => () => {
    if (saveFeedbackTimeoutRef.current !== null) {
      window.clearTimeout(saveFeedbackTimeoutRef.current);
    }
  }, []);

  const promoteNodeFromTarget = useCallback((eventTarget: EventTarget | null) => {
    const target = eventTarget instanceof Element ? eventTarget : null;
    const nodeElement = target?.closest<HTMLElement>('.react-flow__node[data-id]');
    const nodeId = nodeElement?.dataset.id;
    if (!nodeId) return;

    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    const containingArea = node
      ? innermostAreaContainingNode(areasRef.current, node)
      : undefined;
    setSurfacedAreaId(containingArea?.id ?? null);

    setNodeStackOrder((current) => {
      if (containingArea) {
        const containedNodeIds = nodeIdsContainedByAreaHierarchy(
          areasRef.current,
          nodesRef.current,
          containingArea.id,
        );
        const promotedAreaOrder = promoteNodeIdsInStackOrder(
          current,
          nodesRef.current.map((candidate) => candidate.id),
          containedNodeIds,
        );
        return promoteNodeIdsInStackOrder(
          promotedAreaOrder,
          nodesRef.current.map((candidate) => candidate.id),
          new Set([nodeId]),
        );
      }

      const currentNodeIds = new Set(nodesRef.current.map((node) => node.id));
      const activeOrder = current.filter((entry) => entry !== nodeId && currentNodeIds.has(entry));
      if (activeOrder.length === current.length - 1 && current.at(-1) === nodeId) return current;
      return [...activeOrder, nodeId];
    });
  }, []);

  const promoteAreaFromTarget = useCallback((eventTarget: EventTarget | null) => {
    const target = eventTarget instanceof Element ? eventTarget : null;
    const areaId = target?.closest<HTMLElement>('.canvas-area[data-area-id]')?.dataset.areaId;
    if (!areaId) return;

    const containedNodeIds = nodeIdsContainedByAreaHierarchy(
      areasRef.current,
      nodesRef.current,
      areaId,
    );
    setSelectedAreaId(areaId);
    setSurfacedAreaId(areaId);
    setNodeStackOrder((current) => promoteNodeIdsInStackOrder(
      current,
      nodesRef.current.map((node) => node.id),
      containedNodeIds,
    ));
  }, []);

  const handleEditorFocusCapture = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    if (canvasLocked) return;
    if (isSurfacedControlTarget(event.target)) return;
    promoteNodeFromTarget(event.target);
    promoteAreaFromTarget(event.target);
  }, [canvasLocked, promoteAreaFromTarget, promoteNodeFromTarget]);

  const handleEditorPointerDownCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (canvasLocked) return;
    if (!event.nativeEvent.isTrusted && ignoreSyntheticSelectionPointerDownRef.current) {
      ignoreSyntheticSelectionPointerDownRef.current = false;
      return;
    }
    if (isSurfacedControlTarget(event.target)) {
      pendingNodeDragSelectionRef.current = null;
      selectionDragStartRef.current = null;
      canvasDragActiveRef.current = false;
      canvasDragPointerRef.current = null;
      canvasDragPointerIdRef.current = null;
      setResumedSelectionDraw(null);
      return;
    }
    promoteNodeFromTarget(event.target);
    promoteAreaFromTarget(event.target);
    const target = event.target instanceof Element ? event.target : null;
    const nodeElement = target?.closest<HTMLElement>('.react-flow__node[data-id]');
    const nodeId = nodeElement?.dataset.id;
    if (!nodeId && !target?.closest('.canvas-area')) setSurfacedAreaId(null);

    if (event.button !== 0) {
      pendingNodeDragSelectionRef.current = null;
      selectionDragStartRef.current = null;
      setResumedSelectionDraw(null);
      return;
    }

    setResumedSelectionDraw(null);

    if (!target?.closest('.canvas-area')) setSelectedAreaId(null);

    const isCanvasPointerDown = target?.classList.contains('react-flow__pane') === true;
    canvasDragActiveRef.current = isCanvasPointerDown;
    canvasDragPointerRef.current = isCanvasPointerDown ? { x: event.clientX, y: event.clientY } : null;
    canvasDragPointerIdRef.current = isCanvasPointerDown ? event.pointerId : null;

    // Cmd/Ctrl-drag reserves the canvas gesture for a visual area rather than
    // React Flow's normal selection rectangle.
    if ((event.metaKey || event.ctrlKey) && isCanvasPointerDown) {
      event.preventDefault();
      event.stopPropagation();
      const draw = { start: { x: event.clientX, y: event.clientY }, current: { x: event.clientX, y: event.clientY } };
      areaDrawRef.current = draw;
      setAreaDraw(draw);
      setResumedSelectionDraw(null);
      selectionDragStartRef.current = null;
      return;
    }

    if (isCanvasPointerDown) {
      selectionDragStartRef.current = { x: event.clientX, y: event.clientY };
    } else {
      selectionDragStartRef.current = null;
    }
    if (!nodeId) {
      pendingNodeDragSelectionRef.current = null;
      return;
    }

    const node = nodesRef.current.find((entry) => entry.id === nodeId);
    if (!node) {
      pendingNodeDragSelectionRef.current = null;
      return;
    }

    pendingNodeDragSelectionRef.current = {
      nodeId,
      preserveSelection: node.selected !== true,
      nodeSelection: selectionById(nodesRef.current),
      edgeSelection: selectionById(edgesRef.current),
    };
  }, [promoteAreaFromTarget, promoteNodeFromTarget]);

  const screenToFlow = useCallback((point: ScreenPoint) => {
    const rect = editorShellRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const viewport = viewportRef.current;
    return { x: (point.x - rect.left - viewport.x) / viewport.zoom, y: (point.y - rect.top - viewport.y) / viewport.zoom };
  }, []);

  const endNativeSelection = useCallback(() => {
    const pane = editorShellRef.current?.querySelector<HTMLElement>('.react-flow__pane');
    const point = canvasDragPointerRef.current;
    const pointerId = canvasDragPointerIdRef.current;
    if (!pane || !point || pointerId === null) return;
    ignoreSyntheticSelectionPointerUpRef.current = true;
    pane.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: point.x,
      clientY: point.y,
      pointerId,
      isPrimary: true,
    }));
  }, [canvasLocked, promoteAreaFromTarget, promoteNodeFromTarget]);

  const startNativeSelection = useCallback((start: ScreenPoint) => {
    const pane = editorShellRef.current?.querySelector<HTMLElement>('.react-flow__pane');
    const pointerId = canvasDragPointerIdRef.current;
    if (!pane || pointerId === null) return;
    ignoreSyntheticSelectionPointerDownRef.current = true;
    pane.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: 1,
      clientX: start.x,
      clientY: start.y,
      pointerId,
      isPrimary: true,
    }));
  }, []);

  const updateAreaDraw = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (canvasLocked) return false;
    const current = areaDrawRef.current;
    if (!current) return false;
    // Releasing Cmd/Ctrl during the gesture returns to the ordinary selection
    // rectangle, retaining the original pointer-down point.
    if (!event.metaKey && !event.ctrlKey) {
      areaDrawRef.current = null;
      selectionDragStartRef.current = current.start;
      setAreaDraw(null);
      setResumedSelectionDraw({
        start: current.start,
        current: { x: event.clientX, y: event.clientY },
      });
      startNativeSelection(current.start);
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    const next = { ...current, current: { x: event.clientX, y: event.clientY } };
    areaDrawRef.current = next;
    setAreaDraw(next);
    return true;
  }, [canvasLocked, startNativeSelection]);

  const finishAreaDraw = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (canvasLocked) return false;
    const draw = areaDrawRef.current;
    if (!draw) return false;
    event.preventDefault();
    event.stopPropagation();
    const end = { x: event.clientX, y: event.clientY };
    const start = screenToFlow(draw.start);
    const finish = screenToFlow(end);
    const width = Math.abs(finish.x - start.x);
    const height = Math.abs(finish.y - start.y);
    if (width >= 24 && height >= 24) {
      commitHistory();
      const id = `area-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const newArea: EditorArea = {
        id,
        title: 'Area',
        position: { x: Math.min(start.x, finish.x), y: Math.min(start.y, finish.y) },
        size: { width, height },
      };
      const nextAreas = [...areasRef.current, newArea];
      const containedNodeIds = nodeIdsContainedByAreaHierarchy(nextAreas, nodesRef.current, id);
      setAreas((current) => [...current, newArea]);
      setSelectedAreaId(id);
      setSurfacedAreaId(id);
      setNodeStackOrder((current) => promoteNodeIdsInStackOrder(
        current,
        nodesRef.current.map((node) => node.id),
        containedNodeIds,
      ));
    }
    areaDrawRef.current = null;
    setAreaDraw(null);
    return true;
  }, [canvasLocked, commitHistory, screenToFlow]);

  const startAreaDrag = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    area: EditorArea,
    preserveClick = false,
  ) => {
    if (event.button !== 0) return;
    if (!preserveClick) event.preventDefault();
    event.stopPropagation();
    setSelectedAreaId(area.id);
    const movedAreaIds = connectedAreaIds(areas, area.id);
    const movedAreas = areas.filter((candidate) => movedAreaIds.has(candidate.id));
    const areaPositions = Object.fromEntries(movedAreas.map((candidate) => [candidate.id, { ...candidate.position }]));
    const nodePositions = Object.fromEntries(nodesRef.current
      .filter((node) => movedAreas.some((candidate) => (
        areaContainsNode(candidate, node) || candidate.spreadNodeId === node.id
      )))
      .map((node) => [node.id, { ...node.position }]));
    const dragState: AreaDragState = {
      areaId: area.id,
      start: { x: event.clientX, y: event.clientY },
      captureTarget: event.currentTarget,
      areaPositions,
      nodePositions,
      currentAreaPositions: structuredClone(areaPositions),
      currentNodePositions: structuredClone(nodePositions),
      duplicating: event.altKey,
      linkExternal: isCommandModifierPressed(event),
      historyCommitted: false,
    };
    areaDragRef.current = dragState;
    setAreaDuplicateDrag(dragState.duplicating ? { ...dragState } : null);
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [areas]);

  const dragArea = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = areaDragRef.current;
    if (!drag) return;
    event.preventDefault();
    const zoom = viewportRef.current.zoom;
    const delta = { x: (event.clientX - drag.start.x) / zoom, y: (event.clientY - drag.start.y) / zoom };
    drag.currentAreaPositions = Object.fromEntries(Object.entries(drag.areaPositions).map(([id, position]) => [id, {
      x: position.x + delta.x,
      y: position.y + delta.y,
    }]));
    drag.currentNodePositions = Object.fromEntries(Object.entries(drag.nodePositions).map(([id, position]) => [id, {
      x: position.x + delta.x,
      y: position.y + delta.y,
    }]));
    drag.linkExternal = isCommandModifierPressed(event);
    if (drag.duplicating) {
      setAreaDuplicateDrag({ ...drag });
      return;
    }
    if (!drag.historyCommitted && (delta.x !== 0 || delta.y !== 0)) {
      commitHistory();
      drag.historyCommitted = true;
    }
    setAreas((current) => current.map((area) => {
      const position = drag.currentAreaPositions[area.id];
      return position ? { ...area, position } : area;
    }));
    setNodes((current) => current.map((node) => {
      const position = drag.currentNodePositions[node.id];
      return position ? { ...node, position } : node;
    }));
  }, [commitHistory]);

  const stopAreaDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const drag = areaDragRef.current;
    if (!drag) return;
    if (drag.captureTarget.hasPointerCapture(event.pointerId)) {
      drag.captureTarget.releasePointerCapture(event.pointerId);
    }
    areaDragRef.current = null;
    setAreaDuplicateDrag(null);
    if (!drag.duplicating) return;

    const duplicated = duplicateAreaHierarchy(
      areasRef.current,
      nodesRef.current,
      edgesRef.current,
      drag,
      updateEdgeWeight,
      updateEdgeMode,
      insertNodeOnEdgePlaceholder,
    );
    if (duplicated.nodes.length === 0 && duplicated.areas.length === 0) return;
    const sourceNodes = nodesRef.current.filter((node) => Object.hasOwn(drag.nodePositions, node.id));
    const bufferCopies = duplicatedBufferCopies(
      sourceNodes,
      duplicated.nodes,
      nodesRef.current,
      [...nodesRef.current, ...duplicated.nodes],
      activeDspGroupIds,
    );
    commitHistory();
    setNodes((current) => [
      ...current.map((node) => ({ ...node, selected: false })),
      ...duplicated.nodes.map((node) => ({ ...node, selected: false })),
    ]);
    setEdges((current) => dedupeEdges([
      ...current.map((edge) => ({ ...edge, selected: false })),
      ...duplicated.edges,
    ]));
    setAreas((current) => [...current, ...duplicated.areas]);
    setSelectedAreaId(duplicated.rootAreaId);
    setSurfacedAreaId(duplicated.rootAreaId);
    setNodeStackOrder((current) => [...current, ...duplicated.nodes.map((node) => node.id)]);
    copyBufferAssets(bufferCopies, bufferAssetsRef.current, replaceBufferAssets);
    audio.copyBuffers(bufferCopies);
  }, [activeDspGroupIds, audio.copyBuffers, commitHistory, replaceBufferAssets, updateEdgeMode, updateEdgeWeight]);

  const startAreaResize = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    area: EditorArea,
    corner: AreaResizeState['corner'],
  ) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedAreaId(area.id);
    areaResizeRef.current = {
      areaId: area.id,
      start: { x: event.clientX, y: event.clientY },
      corner,
      originalPosition: area.position,
      originalSize: area.size,
      historyCommitted: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const resizeArea = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = areaResizeRef.current;
    if (!resize) return;
    event.preventDefault();
    const zoom = viewportRef.current.zoom;
    const delta = { x: (event.clientX - resize.start.x) / zoom, y: (event.clientY - resize.start.y) / zoom };
    if (!resize.historyCommitted && (delta.x !== 0 || delta.y !== 0)) {
      commitHistory();
      resize.historyCommitted = true;
    }
    const resizedArea = areasRef.current.find((area) => area.id === resize.areaId);
    const containedBounds = resizedArea?.locked
      ? lockedAreaNodeBounds(resizedArea, nodesRef.current)
      : null;
    const runtimeContainerNode = resizedArea?.spreadNodeId
      ? nodesRef.current.find((node) => node.id === resizedArea.spreadNodeId)
      : undefined;
    const minimumWidth = Math.max(
      runtimeContainerNode?.data.patchNode.type === 'Spawn'
        ? MIN_SPAWN_WIDTH
        : resizedArea?.kind === 'spread' ? MIN_RUNTIME_CONTAINER_WIDTH : 48,
      containedBounds?.width ?? 0,
    );
    const minimumHeight = Math.max(
      resizedArea?.kind === 'spread'
        ? NODE_HEADER_HEIGHT + (runtimeContainerNode?.data.patchNode.type === 'Spawn' ? SPAWN_PORTS_HEIGHT : SPREAD_PORTS_HEIGHT) + 48
        : 48,
      containedBounds?.height ?? 0,
    );
    const originalRight = resize.originalPosition.x + resize.originalSize.width;
    const originalBottom = resize.originalPosition.y + resize.originalSize.height;
    const resizingLeft = resize.corner.includes('left');
    const resizingTop = resize.corner.includes('top');
    const left = resizingLeft
      ? Math.min(
        resize.originalPosition.x + delta.x,
        originalRight - minimumWidth,
        containedBounds?.x ?? Number.POSITIVE_INFINITY,
      )
      : resize.originalPosition.x;
    const right = resizingLeft
      ? originalRight
      : Math.max(
        originalRight + delta.x,
        resize.originalPosition.x + minimumWidth,
        containedBounds ? containedBounds.x + containedBounds.width : Number.NEGATIVE_INFINITY,
      );
    const top = resizingTop
      ? Math.min(
        resize.originalPosition.y + delta.y,
        originalBottom - minimumHeight,
        containedBounds?.y ?? Number.POSITIVE_INFINITY,
      )
      : resize.originalPosition.y;
    const bottom = resizingTop
      ? originalBottom
      : Math.max(
        originalBottom + delta.y,
        resize.originalPosition.y + minimumHeight,
        containedBounds ? containedBounds.y + containedBounds.height : Number.NEGATIVE_INFINITY,
      );
    const width = right - left;
    const height = bottom - top;
    const position = {
      x: left,
      y: top,
    };
    setAreas((current) => current.map((area) => area.id === resize.areaId ? {
      ...area,
      position,
      size: { width, height },
      ...(area.uiHeight === undefined ? {} : { uiHeight: Math.min(area.uiHeight, Math.max(0, height - NODE_HEADER_HEIGHT)) }),
    } : area));
    if (resizedArea?.spreadNodeId) {
      setNodes((current) => current.map((node) => node.id === resizedArea.spreadNodeId ? {
        ...node,
        position,
        data: {
          ...node.data,
          patchNode: {
            ...node.data.patchNode,
            position,
            scopeSize: {
              width,
              height: Math.max(
                node.data.patchNode.type === 'Spawn' ? SPAWN_PORTS_HEIGHT : SPREAD_PORTS_HEIGHT,
                height - NODE_HEADER_HEIGHT,
              ),
            },
          },
        },
      } : node));
    }
  }, [commitHistory]);

  const stopAreaResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!areaResizeRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    areaResizeRef.current = null;
  }, []);

  const startAreaUiResize = useCallback((event: ReactPointerEvent<HTMLDivElement>, area: EditorArea) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedAreaId(area.id);
    areaUiResizeRef.current = {
      areaId: area.id,
      start: { x: event.clientX, y: event.clientY },
      originalUiHeight: area.uiHeight ?? 0,
      historyCommitted: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, []);

  const resizeAreaUi = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = areaUiResizeRef.current;
    if (!resize) return;
    event.preventDefault();
    const delta = (event.clientY - resize.start.y) / viewportRef.current.zoom;
    const nextUiHeight = Math.max(0, resize.originalUiHeight + delta);
    if (!resize.historyCommitted && nextUiHeight !== resize.originalUiHeight) {
      commitHistory();
      resize.historyCommitted = true;
    }
    setAreas((current) => current.map((area) => area.id === resize.areaId ? {
      ...area,
      uiHeight: Math.min(Math.max(0, area.size.height - NODE_HEADER_HEIGHT), nextUiHeight),
    } : area));
  }, [commitHistory]);

  const stopAreaUiResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!areaUiResizeRef.current) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    areaUiResizeRef.current = null;
  }, []);

  const renameArea = useCallback((areaId: string, title: string) => {
    commitHistory(`area-title:${areaId}`);
    setAreas((current) => current.map((area) => area.id === areaId ? { ...area, title } : area));
  }, [commitHistory]);

  const finishAreaRename = useCallback((areaId: string) => {
    setAreas((current) => current.map((area) => (
      area.id === areaId && !area.title
        ? {
            ...area,
            title: area.kind === 'spread'
              ? nodesRef.current.find((node) => node.id === area.spreadNodeId)?.data.patchNode.type === 'Spawn'
                ? 'Spawn'
                : 'Spread'
              : 'Area',
          }
        : area
    )));
    setEditingAreaId(null);
  }, []);

  const toggleAreaCollapsed = useCallback((areaId: string) => {
    const area = areasRef.current.find((candidate) => candidate.id === areaId);
    if (!area) return;

    commitHistory(`area-collapse:${areaId}`);
    setEditingAreaId(null);
    setEditingTypeNodeId(null);
    if (area.collapsed) {
      const containedNodeIds = nodeIdsContainedByAreaHierarchy(
        areasRef.current,
        nodesRef.current,
        areaId,
      );
      setSurfacedAreaId(areaId);
      setSelectedAreaId(areaId);
      setNodeStackOrder((current) => promoteNodeIdsInStackOrder(
        current,
        nodesRef.current.map((node) => node.id),
        containedNodeIds,
      ));
    }
    setAreas((current) => current.map((area) => {
      if (area.id !== areaId) return area;
      if (area.collapsed || area.locked) return { ...area, collapsed: !area.collapsed };
      return {
        ...area,
        collapsed: true,
        locked: true,
        nodeIds: nodesRef.current
          .filter((node) => areaContainsPoint(area, node.position))
          .map((node) => node.id),
        areaIds: areaIdsWithinBounds(current, area),
      };
    }));
  }, [commitHistory]);

  const toggleAreaLocked = useCallback((areaId: string) => {
    const area = areasRef.current.find((candidate) => candidate.id === areaId);
    if (!area) return;

    commitHistory(`area-lock:${areaId}`);
    setAreas((current) => current.map((candidate) => {
      if (candidate.id !== areaId) return candidate;
      if (candidate.locked) return {
        ...candidate,
        locked: false,
        nodeIds: undefined,
        areaIds: undefined,
      };
      return {
        ...candidate,
        locked: true,
        nodeIds: nodesRef.current
          .filter((node) => areaContainsPoint(candidate, node.position))
          .map((node) => node.id),
        areaIds: areaIdsWithinBounds(current, candidate),
      };
    }));
  }, [commitHistory]);

  const areaDrawBounds = useMemo(() => {
    if (!areaDraw) return null;
    const start = screenToFlow(areaDraw.start);
    const end = screenToFlow(areaDraw.current);
    return {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
  }, [areaDraw, screenToFlow]);

  const clearPendingNodeDragSelection = useCallback(() => {
    if (!activeNodeDragSelectionRef.current) {
      pendingNodeDragSelectionRef.current = null;
    }
  }, []);

  const syncRectangleSelection = useCallback((end: ScreenPoint) => {
    const start = selectionDragStartRef.current;
    const editorShell = editorShellRef.current;
    if (!start || !editorShell) return;

    const selectedNodeIds = selectedNodeIdsInScreenRect(
      editorShell,
      start,
      end,
      new Set(nodesRef.current.map((node) => node.id)),
    );
    setNodes((current) => updateSelection(current, selectedNodeIds));
    setEdges((current) => updateSelection(current, new Set()));
  }, []);

  const handleRectangleSelectionMove = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (event.buttons !== 1 || !selectionDragStartRef.current) return;
    if (event.metaKey || event.ctrlKey) {
      const draw = { start: selectionDragStartRef.current, current: { x: event.clientX, y: event.clientY } };
      event.preventDefault();
      event.stopPropagation();
      areaDrawRef.current = draw;
      selectionDragStartRef.current = null;
      setAreaDraw(draw);
      setResumedSelectionDraw(null);
      endNativeSelection();
      setNodes((current) => updateSelection(current, new Set()));
      setEdges((current) => updateSelection(current, new Set()));
      return;
    }
    setResumedSelectionDraw((current) => current
      ? { ...current, current: { x: event.clientX, y: event.clientY } }
      : null);
    syncRectangleSelection({ x: event.clientX, y: event.clientY });
  }, [endNativeSelection, syncRectangleSelection]);

  const validateRectangleSelection = useCallback((event: ReactMouseEvent) => {
    syncRectangleSelection({ x: event.clientX, y: event.clientY });
    selectionDragStartRef.current = null;
    setResumedSelectionDraw(null);
  }, [syncRectangleSelection]);

  useEffect(() => {
    const updateModeForModifier = (modifierActive: boolean) => {
      if (!canvasDragActiveRef.current || !canvasDragPointerRef.current) return;

      if (modifierActive && !areaDrawRef.current && selectionDragStartRef.current) {
        const draw = { start: selectionDragStartRef.current, current: canvasDragPointerRef.current };
        areaDrawRef.current = draw;
        selectionDragStartRef.current = null;
        setAreaDraw(draw);
        setResumedSelectionDraw(null);
        endNativeSelection();
        setNodes((current) => updateSelection(current, new Set()));
        setEdges((current) => updateSelection(current, new Set()));
        return;
      }

      if (!modifierActive && areaDrawRef.current) {
        const draw = areaDrawRef.current;
        areaDrawRef.current = null;
        selectionDragStartRef.current = draw.start;
        setAreaDraw(null);
        setResumedSelectionDraw({ start: draw.start, current: canvasDragPointerRef.current });
        startNativeSelection(draw.start);
        syncRectangleSelection(canvasDragPointerRef.current);
      }
    };

    const handleModifierKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') updateModeForModifier(true);
    };
    const handleModifierKeyUp = (event: KeyboardEvent) => {
      if (event.key === 'Meta' || event.key === 'Control') updateModeForModifier(false);
    };

    window.addEventListener('keydown', handleModifierKeyDown, { capture: true });
    window.addEventListener('keyup', handleModifierKeyUp, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleModifierKeyDown, { capture: true });
      window.removeEventListener('keyup', handleModifierKeyUp, { capture: true });
    };
  }, [endNativeSelection, startNativeSelection, syncRectangleSelection]);

  const resumedSelectionBounds = useMemo(() => {
    if (!resumedSelectionDraw || !editorShellRef.current) return null;
    const shellBounds = editorShellRef.current.getBoundingClientRect();
    return {
      left: Math.min(resumedSelectionDraw.start.x, resumedSelectionDraw.current.x) - shellBounds.left,
      top: Math.min(resumedSelectionDraw.start.y, resumedSelectionDraw.current.y) - shellBounds.top,
      width: Math.abs(resumedSelectionDraw.current.x - resumedSelectionDraw.start.x),
      height: Math.abs(resumedSelectionDraw.current.y - resumedSelectionDraw.start.y),
    };
  }, [resumedSelectionDraw]);

  const handleMove = useCallback((event: globalThis.MouseEvent | TouchEvent | null, nextViewport: Viewport) => {
    if (event !== null && Math.abs(nextViewport.zoom - zoomInteractionRef.current.lastZoom) > ZOOM_CHANGE_EPSILON) {
      zoomInteractionRef.current.zoomChanged = true;
    }
    zoomInteractionRef.current.lastZoom = nextViewport.zoom;
    viewportRef.current = nextViewport;
  }, []);

  const handleMoveEnd = useCallback((event: globalThis.MouseEvent | TouchEvent | null, nextViewport: Viewport) => {
    const zoomChanged = zoomInteractionRef.current.zoomChanged
      || (event !== null && Math.abs(nextViewport.zoom - zoomInteractionRef.current.lastZoom) > ZOOM_CHANGE_EPSILON);
    zoomInteractionRef.current = { zoomChanged: false, lastZoom: nextViewport.zoom };
    viewportRef.current = nextViewport;
    setSettledViewport(nextViewport);
    if (!hosted) storeViewport(nextViewport);

    // React Flow reports programmatic viewport changes with a null event. Only
    // settle direct pinch/zoom gestures; otherwise a reset animation can start
    // another zoom transition and interrupt its own absolute 100% target.
    if (event !== null && zoomChanged && shouldSettleZoomToBaseline(nextViewport.zoom)) {
      void reactFlow?.zoomTo(ZOOM_RESET_TARGET, { duration: 120 });
    }
  }, [reactFlow]);

  const resetZoom = useCallback(() => {
    void reactFlow?.zoomTo(ZOOM_RESET_TARGET);
  }, [reactFlow]);

  useEffect(() => {
    const handleResetZoomKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.altKey || event.shiftKey) return;
      if (isEditableEventTarget(event.target)) return;
      if (!event.metaKey && !event.ctrlKey) return;
      if (event.key !== '0' && event.code !== 'Digit0' && event.code !== 'Numpad0') return;

      event.preventDefault();
      event.stopPropagation();
      resetZoom();
    };

    window.addEventListener('keydown', handleResetZoomKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleResetZoomKeyDown, { capture: true });
  }, [resetZoom]);

  useEffect(() => {
    const deleteSelectedArea = (event: KeyboardEvent) => {
      if (canvasLocked) return;
      if ((event.key !== 'Backspace' && event.key !== 'Delete') || isEditableEventTarget(event.target)) return;
      if (!selectedAreaId) return;
      event.preventDefault();
      event.stopPropagation();
      commitHistory();
      const selectedArea = areasRef.current.find((area) => area.id === selectedAreaId);
      if (selectedArea?.spreadNodeId) {
        setNodes((current) => current.filter((node) => node.id !== selectedArea.spreadNodeId));
        setEdges((current) => current.filter((edge) => (
          edge.source !== selectedArea.spreadNodeId && edge.target !== selectedArea.spreadNodeId
        )));
      }
      setAreas((current) => current.filter((area) => area.id !== selectedAreaId));
      setSelectedAreaId(null);
      setSurfacedAreaId((current) => current === selectedAreaId ? null : current);
    };

    window.addEventListener('keydown', deleteSelectedArea, { capture: true });
    return () => window.removeEventListener('keydown', deleteSelectedArea, { capture: true });
  }, [canvasLocked, commitHistory, selectedAreaId]);

  const handleFlowNodeDoubleClick = useCallback((event: ReactMouseEvent, node: ShaderFlowNode) => {
    if (!enterGroupNode(node)) return;
    event.preventDefault();
    event.stopPropagation();
  }, [enterGroupNode]);
  const handleFlowEdgeDoubleClick = useCallback((event: ReactMouseEvent, edge: ShaderFlowEdge) => {
    event.preventDefault();
    event.stopPropagation();
    if (edge.data?.isAreaCollapsedPresentation) return;
    insertNodeOnEdge(edge.id);
  }, [insertNodeOnEdge]);
  const connectionLineStyle = useMemo(() => ({
    '--connection-line-color': draftNodePreview
      ? 'transparent'
      : CONNECTION_LINE_COLORS[draftNodeConnection?.mode ?? 'set'],
  }) as CSSProperties, [draftNodeConnection?.mode, draftNodePreview]);

  return (
    <div className="app-shell app-shell-panel-closed">
      <EdgeOverlayProvider target={edgeOverlayElement}>
        <main
          ref={editorShellRef}
          className={`editor-shell${areaDraw ? ' editor-shell-area-drawing' : ''}${resumedSelectionDraw ? ' editor-shell-resumed-selection' : ''}`}
          onFocusCapture={handleEditorFocusCapture}
          onPointerDownCapture={handleEditorPointerDownCapture}
          onPointerMove={(event) => {
            if (canvasLocked) return;
            if (canvasDragActiveRef.current && event.buttons === 1) {
              canvasDragPointerRef.current = { x: event.clientX, y: event.clientY };
            }
            if (!updateAreaDraw(event)) handleRectangleSelectionMove(event);
          }}
          onPointerUpCapture={(event) => {
            if (canvasLocked) return;
            if (!event.nativeEvent.isTrusted && ignoreSyntheticSelectionPointerUpRef.current) {
              ignoreSyntheticSelectionPointerUpRef.current = false;
              return;
            }
            if (!finishAreaDraw(event)) clearPendingNodeDragSelection();
            canvasDragActiveRef.current = false;
            canvasDragPointerRef.current = null;
            canvasDragPointerIdRef.current = null;
            setResumedSelectionDraw(null);
          }}
          onPointerCancelCapture={() => {
            clearPendingNodeDragSelection();
            canvasDragActiveRef.current = false;
            canvasDragPointerRef.current = null;
            canvasDragPointerIdRef.current = null;
            setResumedSelectionDraw(null);
          }}
          onDoubleClick={(event) => {
            const target = event.target as HTMLElement;
            if (!target.classList.contains('react-flow__pane')) return;

            event.preventDefault();
            event.stopPropagation();
            addNodeAt(event);
          }}
        >
          <Fm1ModeContext.Provider value={fm1Mode}>
          <ReactFlow
            nodes={displayNodes}
            edges={displayEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onInit={setReactFlow}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onSelectionEnd={validateRectangleSelection}
            onNodeDoubleClick={handleFlowNodeDoubleClick}
            onConnect={onConnect}
            onConnectStart={onConnectStart}
            onConnectEnd={onConnectEnd}
            onReconnect={onReconnect}
            onReconnectStart={onReconnectStart}
            onReconnectEnd={onReconnectEnd}
            reconnectRadius={12}
            nodesDraggable={!canvasLocked}
            nodesConnectable={!canvasLocked}
            // Keep node pointer events available for playable controls while LK
            // rejects selection changes in onNodesChange/onEdgesChange.
            elementsSelectable
            connectionLineStyle={connectionLineStyle}
            onEdgeDoubleClick={handleFlowEdgeDoubleClick}
            onMove={handleMove}
            onMoveEnd={handleMoveEnd}
            connectionMode={ConnectionMode.Loose}
            panOnScroll
            panOnDrag={false}
            zoomOnScroll={false}
            zoomOnPinch
            zoomOnDoubleClick={false}
            selectionOnDrag={!canvasLocked && !areaDraw}
            selectionMode={SelectionMode.Partial}
            selectionKeyCode={null}
            panActivationKeyCode={null}
            defaultViewport={initialViewport}
            minZoom={MIN_CANVAS_ZOOM}
            fitView={!initialState?.ui?.viewport && !storedViewport}
            fitViewOptions={FIT_VIEW_OPTIONS}
            translateExtent={panTranslateExtent}
            nodeExtent={FLOW_INFINITE_EXTENT}
            onlyRenderVisibleElements
            deleteKeyCode={canvasLocked ? null : DELETE_KEY_CODES}
            multiSelectionKeyCode={MULTI_SELECTION_KEY_CODES}
            snapToGrid={false}
            proOptions={REACT_FLOW_PRO_OPTIONS}
          >
            <ViewportPortal>
              <div
                className="area-layer"
                style={{
                  '--canvas-header-title-scale': String(canvasHeaderTitleScale(settledGraphZoom)),
                } as CSSProperties}
              >
                {areaDrawBounds && (
                  <div
                    className="canvas-area canvas-area-drawing"
                    style={{ left: areaDrawBounds.x, top: areaDrawBounds.y, width: areaDrawBounds.width, height: areaDrawBounds.height }}
                  />
                )}
                {areaDuplicatePreview?.areas.map((area) => (
                  <div
                    key={area.id}
                    className={`canvas-area canvas-area-preview${area.kind === 'spread' ? ' canvas-area-spread' : ''}${area.collapsed ? ' canvas-area-collapsed' : ''}`}
                    style={{ left: area.position.x, top: area.position.y, width: area.size.width, height: area.collapsed ? NODE_HEADER_HEIGHT + (area.uiHeight ?? 0) : area.size.height }}
                    aria-hidden="true"
                  >
                    <div className="canvas-area-header">
                      <span className="canvas-area-title">{area.title}</span>
                    </div>
                  </div>
                ))}
                {areas.map((area) => (
                  <div
                    key={area.id}
                    data-area-id={area.id}
                    className={`canvas-area${area.kind === 'spread' ? ' canvas-area-spread' : ''}${area.collapsed ? ' canvas-area-collapsed' : ''}${selectedAreaId === area.id ? ' canvas-area-selected' : ''}`}
                    style={{
                      left: area.position.x,
                      top: area.position.y,
                      width: area.size.width,
                      height: area.collapsed ? NODE_HEADER_HEIGHT + (area.uiHeight ?? 0) : area.size.height,
                      zIndex: surfacedAreaRanks.has(area.id)
                        ? surfacedAreaLayerBase + (surfacedAreaRanks.get(area.id) ?? 0)
                        : -1,
                    }}
                  >
                    <div
                      className="canvas-area-header nodrag nopan"
                      onPointerDown={(event) => { if (!canvasLocked) startAreaDrag(event, area); }}
                      onPointerMove={canvasLocked ? undefined : dragArea}
                      onPointerUp={canvasLocked ? undefined : stopAreaDrag}
                      onPointerCancel={canvasLocked ? undefined : stopAreaDrag}
                      onDoubleClick={(event) => {
                        if (canvasLocked) return;
                        event.preventDefault();
                        event.stopPropagation();
                        toggleAreaCollapsed(area.id);
                      }}
                    >
                      {editingAreaId === area.id ? (
                        <input
                          ref={areaTitleInputRef}
                          className="canvas-area-title-input"
                          value={area.title}
                          aria-label={area.kind === 'spread'
                            ? nodesRef.current.find((node) => node.id === area.spreadNodeId)?.data.patchNode.type === 'Spawn'
                              ? 'Spawn name'
                              : 'Spread name'
                            : 'Area name'}
                          onPointerDown={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => {
                            event.stopPropagation();
                            event.currentTarget.select();
                          }}
                          onBlur={() => finishAreaRename(area.id)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter' || event.key === 'Escape') {
                              event.preventDefault();
                              event.currentTarget.blur();
                            }
                          }}
                          onChange={(event) => renameArea(area.id, event.target.value)}
                        />
                      ) : (
                        <button
                          className="canvas-area-title nodrag nopan"
                          type="button"
                          onPointerDown={(event) => {
                            if (canvasLocked) return;
                            areaTitlePointerStartRef.current = { x: event.clientX, y: event.clientY };
                            startAreaDrag(event, area, true);
                          }}
                          onPointerCancel={() => {
                            areaTitlePointerStartRef.current = null;
                          }}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            if (canvasLocked) return;
                            const pointerStart = areaTitlePointerStartRef.current;
                            areaTitlePointerStartRef.current = null;
                            const moved = pointerStart
                              ? Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4
                              : false;
                            if (moved) {
                              event.preventDefault();
                              return;
                            }

                            event.stopPropagation();
                            setSelectedAreaId(area.id);
                            setEditingAreaId(area.id);
                          }}
                        >
                          {area.title}
                          {area.kind === 'spread'
                            && nodesRef.current.find((node) => node.id === area.spreadNodeId)?.data.patchNode.type === 'Spawn'
                            ? ` (${Math.max(0, Math.floor(
                                audio.linkMeters[
                                  `${scopedDspNodeId(area.spreadNodeId ?? '', activeDspGroupIds)}:spawn-count`
                                ]?.output ?? 0,
                              ))})`
                            : ''}
                        </button>
                      )}
                      {!canvasLocked && !area.collapsed ? (
                        <button
                          className={`area-lock-toggle nodrag nopan${area.locked ? ' area-lock-toggle-locked' : ''}`}
                          type="button"
                          aria-label={area.locked ? 'Unlock area membership' : 'Lock area membership'}
                          title={area.locked ? 'Unlock area membership' : 'Lock area membership'}
                          aria-pressed={area.locked === true}
                          onPointerDown={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            toggleAreaLocked(area.id);
                          }}
                        >
                          <span className="area-lock-icon" aria-hidden="true" />
                        </button>
                      ) : null}
                      {!canvasLocked ? <button
                        className="area-compact-toggle nodrag nopan"
                        type="button"
                        aria-label={area.collapsed ? 'Expand area' : 'Collapse area'}
                        title={area.collapsed ? 'Expand area' : 'Collapse area'}
                        aria-pressed={area.collapsed === true}
                        onPointerDown={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          toggleAreaCollapsed(area.id);
                        }}
                      >
                        <span
                          className={`node-compact-icon ${area.collapsed ? 'node-compact-icon-compact' : 'node-compact-icon-expanded'}`}
                          aria-hidden="true"
                        />
                      </button> : null}
                    </div>
                    {!canvasLocked && !area.collapsed && area.kind !== 'spread' && (
                      <div
                        className="canvas-area-ui-resize-handle nodrag nopan"
                        aria-label="Resize area UI section"
                        title="Drag to create or resize the user-facing section"
                        style={{ top: area.uiHeight && area.uiHeight > 0 ? NODE_HEADER_HEIGHT + area.uiHeight - 4 : 28 }}
                        onPointerDown={(event) => startAreaUiResize(event, area)}
                        onPointerMove={resizeAreaUi}
                        onPointerUp={stopAreaUiResize}
                        onPointerCancel={stopAreaUiResize}
                      />
                    )}
                    {area.uiHeight !== undefined && area.uiHeight > 0 && (
                      <div className="canvas-area-ui-divider" style={{ top: NODE_HEADER_HEIGHT + area.uiHeight }} />
                    )}
                    {!canvasLocked && !area.collapsed && (['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const).map((corner) => (
                      <div
                        key={corner}
                        className={`canvas-area-resize-handle canvas-area-resize-${corner} nodrag nopan`}
                        aria-label={`Resize area from ${corner}`}
                        onPointerDown={(event) => startAreaResize(event, area, corner)}
                        onPointerMove={resizeArea}
                        onPointerUp={stopAreaResize}
                        onPointerCancel={stopAreaResize}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </ViewportPortal>
            <Background color="var(--color-foreground-08)" gap={28} size={1} />
            <Controls showInteractive={false}>
              <ControlButton
                className="react-flow__controls-zoom-percentage"
                type="button"
                onClick={resetZoom}
                aria-label={`Reset zoom to 100% (currently ${formatZoomPercentage(settledViewport.zoom)})`}
                title={`Reset zoom to 100% (currently ${formatZoomPercentage(settledViewport.zoom)})`}
              >
                {formatZoomPercentage(settledViewport.zoom)}
              </ControlButton>
              <div
                hidden={Boolean(hosted)}
                className={`react-flow__controls-cpu-meter${audio.status === 'running' ? ' is-running' : ''}`}
                style={{ '--cpu-load': cpuLoad, display: hosted ? 'none' : undefined } as CSSProperties}
                role="meter"
                aria-label={audio.status === 'running' ? `CPU usage ${cpuPercentage}%` : 'CPU usage, audio stopped'}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={audio.status === 'running' ? Math.min(100, cpuPercentage) : 0}
                title={cpuDetails}
              >
                <span className="cpu-meter-label">CPU</span>
                <span className="cpu-meter-percentage" aria-hidden="true">{cpuPercentage}%</span>
              </div>
            </Controls>
          </ReactFlow>
          </Fm1ModeContext.Provider>
          {resumedSelectionBounds ? (
            <div
              className="editor-selection-marquee"
              style={resumedSelectionBounds}
              aria-hidden="true"
            />
          ) : null}
          <div ref={setEdgeOverlayElement} className="edge-overlay-layer" />
          <div className="viewport-buttons">
            {fm1Mode && fm1LiveState.message && <span className="fm1-live-status" role="status">{fm1LiveState.message}</span>}
            <input
              className="patch-name-input"
              value={patchName}
              onChange={(event) => setPatchName(event.target.value)}
              aria-label={isEditingSubpatch ? 'Subpatch name' : 'Patch name'}
              title={isEditingSubpatch ? 'Subpatch name' : 'Patch name'}
              placeholder={isEditingSubpatch ? 'subpatch name' : 'patch name'}
              spellCheck={false}
            />
            {isEditingSubpatch ? (
              <button className="viewport-button viewport-button-history" type="button" onClick={exitSubpatch} aria-label="Exit subpatch" title="Exit subpatch">EXIT</button>
            ) : null}
            {hosted ? <>
              <span title="Audio and document paths are owned by the host">HOSTED · {hostedState?.dirty ? 'unsaved' : 'saved'}</span>
              {hosted.capabilities.transport && <button className="viewport-button" type="button" onClick={toggleAudioPlayback}>TRANSPORT</button>}
            </> : fm1Mode ? <>
              <button className="viewport-button" type="button" role="switch" aria-checked={fm1Live}
                disabled={!fm1Live && fm1LiveState.busy} onClick={() => setFm1Live(value => !value)} title={fm1LiveState.message}>LIVE EDIT</button>
              <button className="viewport-button" type="button" disabled={fm1Live || fm1LiveState.busy}
                onClick={() => setFm1Patch(patch)} aria-label="Send patch to FM-1" title="FM-1 limits and upload">SEND TO FM1</button>
              <select className="viewport-button" aria-label="FM1 live preset" value={fm1Preset} disabled={fm1Live || fm1LiveState.busy}
                onChange={event => setFm1Preset(Number(event.target.value))}>
                <option value={1}>PRESET 1</option><option value={2}>PRESET 2</option>
              </select>
            </> : <>
            <button
              className="viewport-button"
              type="button"
              role="switch"
              aria-checked={audioPlaybackActive}
              aria-label={audioPlaybackActive ? 'Stop audio' : 'Play audio'}
              title={audioPlaybackActive ? 'Stop audio' : 'Play audio'}
              onClick={toggleAudioPlayback}
            >
              PLAY
            </button>
            <button
              className="viewport-button viewport-button-record"
              type="button"
              role="switch"
              aria-checked={audioRecordingActive}
              aria-label={audioRecordingActive ? 'Stop recording' : 'Record audio'}
              title={audio.recording.message}
              onClick={toggleAudioRecording}
            >
              {recordingButtonLabel}
            </button>
            </>}
            {!hosted && <button className="viewport-button" type="button" onClick={newPatch} aria-label="New patch" title="New patch">NEW</button>}
            <button
              className={['viewport-button', saveFeedbackActive ? 'viewport-button-save-confirmed' : ''].filter(Boolean).join(' ')}
              type="button"
              onClick={() => void savePatchJson()}
              disabled={hosted ? !hosted.capabilities.save || !hostedState?.connected : localPatchStorageEnabled && trimmedRootPatchName.length === 0}
              aria-label="Save patch"
              title={hosted ? !hosted.capabilities.save ? 'The host does not allow saving' : !hostedState?.connected ? 'Host disconnected' : 'Save through the host' : localPatchStorageEnabled && trimmedRootPatchName.length === 0 ? 'Enter a patch name before saving locally' : 'Save patch'}
            >
              SAVE
            </button>
            {!hosted && <button className="viewport-button" type="button" onClick={requestPatchLoad} aria-label="Load patch" title="Load patch">LOAD</button>}
            {hosted?.capabilities.saveAs && <button className="viewport-button" type="button" onClick={() => void savePatchJson(true)}>SAVE AS</button>}
            <button className="viewport-button viewport-button-history" type="button" onClick={undo} disabled={history.past.length === 0} aria-label="Undo" title="Undo">UNDO</button>
            <button className="viewport-button viewport-button-history" type="button" onClick={redo} disabled={history.future.length === 0} aria-label="Redo" title="Redo">REDO</button>
            <div className="viewport-more" data-open={moreMenuOpen}
              onMouseEnter={() => setMoreMenuOpen(true)} onMouseLeave={() => setMoreMenuOpen(false)}
              onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setMoreMenuOpen(false); }}
              onKeyDown={event => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  moreMenuTriggerRef.current?.focus();
                  setMoreMenuOpen(false);
                }
              }}>
              <button ref={moreMenuTriggerRef} className="viewport-button viewport-more-trigger" type="button"
                aria-haspopup="menu" aria-expanded={moreMenuOpen} aria-label="More actions" title="More actions"
                onFocus={() => setMoreMenuOpen(true)} onClick={() => setMoreMenuOpen(true)}>MORE ˆ</button>
              <div className="viewport-more-menu" role="menu" aria-label="More actions"
                onClick={event => {
                  if (!(event.target instanceof Element) || !event.target.closest('button')) return;
                  if (event.currentTarget.contains(document.activeElement)) moreMenuTriggerRef.current?.focus();
                  setMoreMenuOpen(false);
                }}>
                {!hosted && <>
                <button className="viewport-button" type="button" onClick={() => setMidiSettingsOpen(true)} aria-label="MIDI settings" title="MIDI settings" role="menuitem">MIDI SETTINGS</button>
                <button className="viewport-button" type="button" onClick={() => void exportPatchPackage()} aria-label="Export patch package" title="Export patch package" role="menuitem">EXPORT PATCH</button>
                <button className="viewport-button" type="button" role="menuitemcheckbox" aria-checked={fm1Mode}
                  disabled={fm1LiveState.busy} onClick={() => { audio.stopRecording(); audio.stop(); setFm1Live(false); setFm1Mode(value => !value); }}>FM1 MODE</button>
                {!fm1Mode && <button className="viewport-button" type="button" disabled={fm1Live || fm1LiveState.busy} onClick={() => setFm1Patch(patch)} aria-label="Send patch to FM-1" title="FM-1 limits and upload" role="menuitem">SEND TO FM1</button>}
                </>}
                <button className="viewport-button" type="button" onClick={() => scaleSelectedNodes(2)} disabled={!canScaleSelection} aria-label="Increase selected node scale" title="Increase selected node scale" role="menuitem">SCALE UP SELECTION</button>
                <button className="viewport-button" type="button" onClick={() => scaleSelectedNodes(0.5)} disabled={!canScaleSelection} aria-label="Decrease selected node scale" title="Decrease selected node scale" role="menuitem">SCALE DOWN SELECTION</button>
                <button className="viewport-button" type="button" onClick={groupSelectedNodes} disabled={!canGroupSelection || isEditingSubpatch} aria-label="Group to subpatch" title="Group to subpatch" role="menuitem">GROUP TO SUBPATCH</button>
                <button className="viewport-button" type="button" onClick={() => void requestSubpatchImport()} aria-label="Import subpatch" title="Import subpatch" role="menuitem">IMPORT SUBPATCH</button>
                <button className="viewport-button" type="button" role="menuitemcheckbox" aria-checked={canvasLocked} aria-label={canvasLocked ? 'Unlock UI' : 'Lock UI'} title={canvasLocked ? 'Unlock UI' : 'Lock UI'} onClick={toggleCanvasLock}>LOCK UI</button>
              </div>
            </div>
          </div>
          <input ref={fileInputRef} className="file-input" type="file" accept="application/json,.json" onChange={loadPatchFile} />
          <input ref={importFileInputRef} className="file-input" type="file" accept="application/json,.json" onChange={loadSubpatchImportFile} />
          <input ref={sampleFileInputRef} className="file-input" type="file" accept="audio/*,video/mp4,.wav,.mp3,.aiff,.aif,.flac,.ogg,.m4a,.mp4" onChange={uploadSampleFile} />
          <input ref={imageFileInputRef} className="file-input" type="file" accept="image/avif,image/gif,image/jpeg,image/png,image/webp,.avif,.gif,.jpg,.jpeg,.png,.webp" onChange={uploadImageFile} />
          {fm1Patch && <Fm1UploadDialog patch={fm1Patch} onClose={() => setFm1Patch(null)} />}
          {hostedState && <p className="import-error-floating" aria-live="polite">{hostedState.connected ? `revision ${hostedState.revision}; installed ${hostedState.installedRevision ?? 'host initial'}; generation ${hostedState.generation ?? 'unknown'}` : 'Host disconnected; working document retained.'}{hostedState.diagnostics.filter(d => d.severity !== 'info').map(d => ` · ${d.message}`).join('')}</p>}
          {hostedState?.feedback?.tempo && <output className="hosted-tempo-feedback" aria-label="Host tempo">{hostedState.feedback.tempo.bpm} beats per minute · {hostedState.feedback.tempo.running ? 'running' : 'stopped'}</output>}
          {hostedState?.feedback?.parameters && <output className="hosted-parameter-feedback" aria-label="Host instance parameters">{Object.entries(hostedState.feedback.parameters).map(([id, value]) => <span key={id}>{hosted?.getParameterLabel(id)}: {value} </span>)}</output>}
          {importError ? <p className="import-error-floating">{importError}</p> : null}
          {audioGraph.errors.length > 0 ? (
            <section className="dsp-error-panel" aria-live="polite" aria-label="DSP compile errors">
              <div className="dsp-error-panel-heading">
                <span>DSP errors</span>
                <span>{audioGraph.errors.length}</span>
              </div>
              <ul className="dsp-error-list">
                {audioGraph.errors.slice(0, DSP_ERROR_PANEL_LIMIT).map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
              {audioGraph.errors.length > DSP_ERROR_PANEL_LIMIT ? (
                <p className="dsp-error-more">+{audioGraph.errors.length - DSP_ERROR_PANEL_LIMIT} more</p>
              ) : null}
            </section>
          ) : null}
          {newPatchConfirmationOpen ? (
            <div
              className="import-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setNewPatchConfirmationOpen(false);
              }}
            >
              <section className="import-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="new-patch-modal-title" aria-describedby="new-patch-modal-message">
                <header className="import-modal-header">
                  <h2 id="new-patch-modal-title">New patch</h2>
                  <button className="import-modal-close" type="button" onClick={() => setNewPatchConfirmationOpen(false)} aria-label="Close new patch confirmation" title="Close">X</button>
                </header>
                <p className="import-modal-message" id="new-patch-modal-message">Start a new empty patch? Unsaved changes will be lost.</p>
                <footer className="import-modal-actions">
                  <button type="button" onClick={() => setNewPatchConfirmationOpen(false)}>Cancel</button>
                  <button type="button" onClick={confirmNewPatch}>New patch</button>
                </footer>
              </section>
            </div>
          ) : null}
          {midiSettingsOpen ? (
            <MidiSettingsModal
              state={audio.midiInput}
              selectedDeviceIds={selectedMidiInputDeviceIds}
              selectedOutputDeviceIds={selectedMidiOutputDeviceIds}
              midiClockOutputEnabled={midiClockOutputEnabled}
              onToggleDevice={toggleMidiInputDevice}
              onToggleOutputDevice={toggleMidiOutputDevice}
              onMidiClockOutputChange={toggleMidiClockOutput}
              onRefresh={() => void audio.refreshMidiInputDevices()}
              onClose={() => setMidiSettingsOpen(false)}
            />
          ) : null}
          {bufferSamplePrompt ? (
            <div
              className="import-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) answerBufferSamplePrompt(false);
              }}
            >
              <section
                className="import-modal confirm-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="buffer-sample-modal-title"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') answerBufferSamplePrompt(false);
                }}
              >
                <header className="import-modal-header">
                  <h2 id="buffer-sample-modal-title">Use buffer content as sample?</h2>
                </header>
                <p className="import-modal-message">The Buffer contains recorded audio. Save it as a permanent sample before converting the node?</p>
                <form
                  className="sample-recording-name-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    answerBufferSamplePrompt(true);
                  }}
                >
                  <label htmlFor="buffer-sample-name">Sample name</label>
                  <div className="sample-recording-name-row">
                    <input
                      id="buffer-sample-name"
                      type="text"
                      value={bufferSamplePrompt.name}
                      onChange={(event) => setBufferSamplePrompt((current) => current ? { ...current, name: event.target.value } : current)}
                      autoFocus
                    />
                    <span>.wav</span>
                  </div>
                  <footer className="import-modal-actions">
                    <button type="button" onClick={() => answerBufferSamplePrompt(false)}>No</button>
                    <button type="submit" disabled={!bufferSamplePrompt.name.trim()}>Yes</button>
                  </footer>
                </form>
              </section>
            </div>
          ) : null}
          {sampleLibrary ? (
            <div
              className="import-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeSampleLibrary();
              }}
            >
              <section
                className="import-modal sample-modal"
                role="dialog"
                aria-modal="true"
                aria-labelledby="sample-modal-title"
                onDragOver={handleSampleLibraryDragOver}
                onDrop={handleSampleLibraryDrop}
              >
                <header className="import-modal-header">
                  <div>
                    <h2 id="sample-modal-title">Select sample</h2>
                    <p>samples/</p>
                  </div>
                  <button className="import-modal-close" type="button" onClick={closeSampleLibrary} aria-label="Close sample picker" title="Close">X</button>
                </header>
                {sampleLibrary.loading || sampleLibrary.error ? (
                  <p className={['import-modal-message', sampleLibrary.error ? 'error' : ''].filter(Boolean).join(' ')}>
                    {sampleLibrary.error ?? 'Reading samples...'}
                  </p>
                ) : null}
                {sampleRecording.status === 'naming' || sampleRecording.status === 'saving' ? (
                  <form
                    className="sample-recording-name-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void saveSampleRecording();
                    }}
                  >
                    <label htmlFor="sample-recording-name">Name this recording</label>
                    <div className="sample-recording-name-row">
                      <input
                        id="sample-recording-name"
                        type="text"
                        value={sampleRecording.name}
                        onChange={(event) => setSampleRecording((current) => ({ ...current, name: event.target.value }))}
                        autoFocus
                        disabled={sampleRecording.status === 'saving'}
                      />
                      <span>{sampleRecording.extension}</span>
                    </div>
                    <footer className="import-modal-actions">
                      <button type="button" onClick={resetSampleRecording} disabled={sampleRecording.status === 'saving'}>Discard</button>
                      <button type="submit" disabled={sampleRecording.status === 'saving' || !sampleRecording.name.trim()}>
                        {sampleRecording.status === 'saving' ? 'Saving...' : 'Save and select'}
                      </button>
                    </footer>
                  </form>
                ) : (
                  <>
                    {sampleRecording.status !== 'idle' ? (
                      <p className="sample-recording-status" aria-live="polite">
                        {sampleRecording.status === 'requesting'
                          ? 'Waiting for microphone permission...'
                          : sampleRecording.status === 'processing'
                            ? 'Finishing recording...'
                            : `Recording ${formatRecordingTimestamp(sampleRecording.elapsedSeconds)}`}
                      </p>
                    ) : null}
                    {sampleLibrary.samples.length > 0 ? (
                      <div className="sample-list" role="listbox" aria-label="Samples">
                        {sampleLibrary.samples.map((sample) => (
                          <button
                            className={[
                              'sample-option',
                              sample.url === sampleLibrary.selectedUrl ? 'sample-option-selected' : '',
                            ].filter(Boolean).join(' ')}
                            key={sample.url}
                            type="button"
                            role="option"
                            aria-selected={sample.url === sampleLibrary.selectedUrl}
                            onClick={() => setSampleLibrary((current) => current ? { ...current, selectedUrl: sample.url } : current)}
                            onDoubleClick={() => selectSampleFromLibrary(sample)}
                          >
                            <span>{sample.name}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                    <footer className="import-modal-actions">
                      <button type="button" onClick={closeSampleLibrary}>Cancel</button>
                      <button
                        className="viewport-button-record"
                        type="button"
                        aria-checked={sampleRecording.status !== 'idle'}
                        onClick={sampleRecording.status === 'recording' ? stopSampleRecording : () => void startSampleRecording()}
                        disabled={sampleRecording.status === 'requesting' || sampleRecording.status === 'processing'}
                      >
                        {sampleRecording.status === 'recording' ? 'Stop' : 'Record'}
                      </button>
                      <button type="button" onClick={requestSampleUploadFromLibrary} disabled={sampleRecording.status !== 'idle'}>Upload new</button>
                      <button type="button" onClick={() => selectedSample && selectSampleFromLibrary(selectedSample)} disabled={!selectedSample || sampleRecording.status !== 'idle'}>Select</button>
                    </footer>
                  </>
                )}
              </section>
            </div>
          ) : null}
          {imageLibrary ? (
            <div className="import-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setImageLibrary(null); }}>
              <section className="import-modal image-modal" role="dialog" aria-modal="true" aria-labelledby="image-modal-title" onDragOver={handleImageLibraryDragOver} onDrop={handleImageLibraryDrop}>
                <header className="import-modal-header">
                  <div><h2 id="image-modal-title">Select image</h2><p>images/</p></div>
                  <button className="import-modal-close" type="button" onClick={() => setImageLibrary(null)} aria-label="Close image picker" title="Close">X</button>
                </header>
                {imageLibrary.loading || imageLibrary.error ? <p className={['import-modal-message', imageLibrary.error ? 'error' : ''].filter(Boolean).join(' ')}>{imageLibrary.error ?? 'Reading images...'}</p> : null}
                <div className="image-library-browser">
                  {imageLibrary.images.length > 0 ? (
                    <div className="image-list" role="listbox" aria-label="Images">
                      {imageLibrary.images.map((image) => (
                        <button className={['image-option', image.url === imageLibrary.selectedUrl ? 'image-option-selected' : ''].filter(Boolean).join(' ')} key={image.url} type="button" role="option" aria-selected={image.url === imageLibrary.selectedUrl} onClick={() => setImageLibrary((current) => current ? { ...current, selectedUrl: image.url } : current)} onDoubleClick={() => selectImageFromLibrary(image)}>
                          <img src={image.url} alt="" /><span>{image.name}</span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  <div className="image-modal-preview" aria-label="Selected image preview">
                    {selectedImage ? <img src={selectedImage.url} alt={selectedImage.name} /> : <span>No image selected</span>}
                  </div>
                </div>
                <footer className="import-modal-actions">
                  <button type="button" onClick={() => setImageLibrary(null)}>Cancel</button>
                  <button type="button" onClick={requestImageUploadFromLibrary}>Upload new</button>
                  <button type="button" onClick={() => selectedImage && selectImageFromLibrary(selectedImage)} disabled={!selectedImage}>Select</button>
                </footer>
              </section>
            </div>
          ) : null}
          {localPatchLibrary ? (
            <div
              className="import-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeLocalPatchLibrary();
              }}
            >
              <section className="import-modal local-patch-modal" role="dialog" aria-modal="true" aria-labelledby="local-patch-modal-title">
                <header className="import-modal-header">
                  <div>
                    <h2 id="local-patch-modal-title">Load patch</h2>
                    <p>patches/</p>
                  </div>
                  <button className="import-modal-close" type="button" onClick={closeLocalPatchLibrary} aria-label="Close patch loader" title="Close">X</button>
                </header>
                {localPatchLibrary.loading || localPatchLibrary.error ? (
                  <p className={['import-modal-message', localPatchLibrary.error ? 'error' : ''].filter(Boolean).join(' ')}>
                    {localPatchLibrary.error ?? 'Reading saved patches...'}
                  </p>
                ) : (
                  <div className="local-patch-browser">
                    <section className="local-patch-column" aria-label="Patches">
                      <h3>PATCH</h3>
                      <div className="local-patch-list" role="listbox" aria-label="Patches">
                        {localPatchLibrary.patches.map((patchEntry) => (
                          <button
                            className={[
                              'local-patch-option',
                              patchEntry.name === localPatchLibrary.selectedPatchName ? 'local-patch-option-selected' : '',
                            ].filter(Boolean).join(' ')}
                            key={patchEntry.name}
                            ref={patchEntry.name === localPatchLibrary.selectedPatchName ? selectedLocalPatchOptionRef : null}
                            type="button"
                            role="option"
                            aria-selected={patchEntry.name === localPatchLibrary.selectedPatchName}
                            onClick={() => selectLocalPatch(patchEntry)}
                          >
                            <span>{patchEntry.name}</span>
                            <span>{patchEntry.versionCount}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                    <section className="local-patch-column" aria-label="Saved versions">
                      <h3>SAVED AT</h3>
                      <div className="local-patch-list" role="listbox" aria-label="Saved versions">
                        {selectedLocalPatch?.versions.map((version) => (
                          <button
                            className={[
                              'local-patch-option',
                              version.id === localPatchLibrary.selectedVersionId ? 'local-patch-option-selected' : '',
                            ].filter(Boolean).join(' ')}
                            key={version.id}
                            type="button"
                            role="option"
                            aria-selected={version.id === localPatchLibrary.selectedVersionId}
                            onClick={() => selectLocalPatchVersion(version)}
                            onDoubleClick={() => void loadSelectedLocalPatch()}
                          >
                            <span>{formatSavedPatchTimestamp(version.savedAt)}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  </div>
                )}
                <footer className="import-modal-actions">
                  <button type="button" onClick={closeLocalPatchLibrary}>Cancel</button>
                  <button type="button" onClick={() => void loadSelectedLocalPatch()} disabled={!localPatchLibrary.selectedPatchName || !localPatchLibrary.selectedVersionId}>Load</button>
                </footer>
              </section>
            </div>
          ) : null}
          {localSubpatchImport ? (
            <div
              className="import-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) closeLocalSubpatchImport();
              }}
            >
              <section className="import-modal local-patch-modal" role="dialog" aria-modal="true" aria-labelledby="local-subpatch-import-title">
                <header className="import-modal-header">
                  <div>
                    <h2 id="local-subpatch-import-title">Import subpatch</h2>
                    <p>patches/</p>
                  </div>
                  <button className="import-modal-close" type="button" onClick={closeLocalSubpatchImport} aria-label="Close subpatch import" title="Close">X</button>
                </header>
                {localSubpatchImport.loading || localSubpatchImport.error ? (
                  <p className={['import-modal-message', localSubpatchImport.error ? 'error' : ''].filter(Boolean).join(' ')}>
                    {localSubpatchImport.error ?? 'Reading saved subpatches...'}
                  </p>
                ) : (
                  <div className="local-patch-browser">
                    <section className="local-patch-column" aria-label="Subpatches">
                      <h3>SUBPATCH</h3>
                      <div className="local-patch-list" role="listbox" aria-label="Subpatches">
                        {localSubpatchImport.subpatches.map((entry) => (
                          <button
                            className={[
                              'local-patch-option',
                              entry.name === localSubpatchImport.selectedSubpatchName ? 'local-patch-option-selected' : '',
                            ].filter(Boolean).join(' ')}
                            key={entry.name}
                            type="button"
                            role="option"
                            aria-selected={entry.name === localSubpatchImport.selectedSubpatchName}
                            onClick={() => selectLocalSubpatch(entry)}
                          >
                            <span>{entry.name}</span>
                            <span>{entry.sources.length}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                    <section className="local-patch-column" aria-label="Subpatch versions">
                      <h3>SAVED AT</h3>
                      <div className="local-patch-list" role="listbox" aria-label="Subpatch versions">
                        {selectedLocalSubpatch?.sources.map((source) => (
                          <button
                            className={[
                              'local-patch-option',
                              source.key === localSubpatchImport.selectedSourceKey ? 'local-patch-option-selected' : '',
                            ].filter(Boolean).join(' ')}
                            key={source.key}
                            type="button"
                            role="option"
                            aria-selected={source.key === localSubpatchImport.selectedSourceKey}
                            onClick={() => selectLocalSubpatchSource(source)}
                            onDoubleClick={importSelectedLocalSubpatch}
                          >
                            <span>{formatSavedPatchTimestamp(source.savedAt)}</span>
                            <span>{source.patchName}</span>
                          </button>
                        ))}
                      </div>
                    </section>
                  </div>
                )}
                <footer className="import-modal-actions">
                  <button type="button" onClick={closeLocalSubpatchImport}>Cancel</button>
                  <button type="button" onClick={importSelectedLocalSubpatch} disabled={!localSubpatchImport.selectedSourceKey || localSubpatchImport.subpatches.length === 0}>Import</button>
                </footer>
              </section>
            </div>
          ) : null}
          {subpatchImportModal ? (
            <div
              className="import-modal-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setSubpatchImportModal(null);
              }}
            >
              <section className="import-modal" role="dialog" aria-modal="true" aria-labelledby="import-modal-title">
                <header className="import-modal-header">
                  <div>
                    <h2 id="import-modal-title">Import subpatch</h2>
                    <p>{subpatchImportModal.fileName}</p>
                  </div>
                  <button className="import-modal-close" type="button" onClick={() => setSubpatchImportModal(null)} aria-label="Close subpatch import" title="Close">X</button>
                </header>
                {subpatchImportModal.error ? (
                  <p className="import-modal-message error">{subpatchImportModal.error}</p>
                ) : (
                  <div className="import-subpatch-list" role="listbox" aria-label="Subpatches">
                    {subpatchImportModal.candidates.map((candidate) => (
                      <button
                        className={[
                          'import-subpatch-option',
                          candidate.key === subpatchImportModal.selectedKey ? 'import-subpatch-option-selected' : '',
                        ].filter(Boolean).join(' ')}
                        key={candidate.key}
                        type="button"
                        role="option"
                        aria-selected={candidate.key === subpatchImportModal.selectedKey}
                        onClick={() => setSubpatchImportModal((current) => current ? { ...current, selectedKey: candidate.key } : current)}
                        onDoubleClick={() => importSubpatchCandidate(candidate)}
                      >
                        <span className="import-subpatch-name">{candidate.name}</span>
                        <span className="import-subpatch-path">{candidate.path}</span>
                        <span className="import-subpatch-meta">{candidate.inputCount} in / {candidate.outputCount} out / {candidate.nodeCount} nodes</span>
                      </button>
                    ))}
                  </div>
                )}
                <footer className="import-modal-actions">
                  <button type="button" onClick={() => setSubpatchImportModal(null)}>Cancel</button>
                  <button type="button" onClick={() => selectedSubpatchCandidate && importSubpatchCandidate(selectedSubpatchCandidate)} disabled={!selectedSubpatchCandidate}>Import</button>
                </footer>
              </section>
            </div>
          ) : null}
        </main>
      </EdgeOverlayProvider>
    </div>
  );
}

function canUseLocalPatchStorage(): boolean {
  const viteEnv = (import.meta as ImportMeta & {
    env?: {
      DEV?: boolean;
      VITE_TEIA_PATCH_STORAGE?: string;
    };
  }).env;
  const storageMode = viteEnv?.VITE_TEIA_PATCH_STORAGE;
  if (storageMode === 'browser') return false;
  if (storageMode === 'local') return true;
  return viteEnv?.DEV === true;
}

async function fetchLocalPatchLibrary(): Promise<LocalPatchEntry[]> {
  const response = await fetch('/api/local-patches', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await localPatchStorageError(response));
  }

  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.patches)) {
    throw new Error('Local patch library response was not valid.');
  }

  return payload.patches.flatMap((entry): LocalPatchEntry[] => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || !Array.isArray(entry.versions)) return [];
    const versions = entry.versions.flatMap((version): LocalPatchVersion[] => (
      isRecord(version) && typeof version.id === 'string' && typeof version.savedAt === 'string'
        ? [{ id: version.id, savedAt: version.savedAt }]
        : []
    ));
    return [{
      name: entry.name,
      versionCount: typeof entry.versionCount === 'number' ? entry.versionCount : versions.length,
      versions,
    }];
  });
}

async function fetchLocalSampleLibrary(): Promise<SampleAsset[]> {
  const response = await fetch('/api/local-samples', {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await localPatchStorageError(response));
  }

  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.samples)) {
    throw new Error('Local sample library response was not valid.');
  }

  return payload.samples.flatMap((entry): SampleAsset[] => (
    isRecord(entry) && typeof entry.name === 'string' && typeof entry.url === 'string'
      ? [{
          name: entry.name,
          url: entry.url,
          ...(typeof entry.originalUrl === 'string' ? { originalUrl: entry.originalUrl } : {}),
        }]
      : []
  ));
}

async function fetchLocalImageLibrary(): Promise<ImageAsset[]> {
  const response = await fetch('/api/local-images', { method: 'GET', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(await localPatchStorageError(response));
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.images)) throw new Error('Local image library response was not valid.');
  return payload.images.flatMap((entry): ImageAsset[] => (
    isImageAsset(entry) ? [{ name: entry.name, url: entry.url }] : []
  ));
}

function selectInitialLocalPatch(patches: LocalPatchEntry[], currentPatchName: string): LocalPatchEntry | null {
  const trimmedName = currentPatchName.trim();
  if (!trimmedName) return patches[0] ?? null;

  const storageName = sanitizeLocalPatchStorageSegment(trimmedName);
  const normalizedName = trimmedName.toLowerCase();
  const normalizedStorageName = storageName.toLowerCase();

  return patches.find((entry) => (
    entry.name === trimmedName ||
    entry.name === storageName ||
    entry.name.toLowerCase() === normalizedName ||
    entry.name.toLowerCase() === normalizedStorageName
  )) ?? patches[0] ?? null;
}

async function saveLocalPatchVersion(patchName: string, patchJson: string): Promise<void> {
  const response = await fetch('/api/local-patches', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: patchName, patchJson }),
  });
  if (!response.ok) {
    throw new Error(await localPatchStorageError(response));
  }
}

async function uploadLocalBufferContents(assets: Record<string, BufferAsset>): Promise<void> {
  const uniqueAssets = [...new Map(Object.values(assets).map((asset) => [asset.hash, asset])).values()];
  if (uniqueAssets.length === 0) return;
  const missingResponse = await fetch('/api/local-buffers/missing', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashes: uniqueAssets.map((asset) => asset.hash) }),
  });
  if (!missingResponse.ok) throw new Error(await localPatchStorageError(missingResponse));
  const missingPayload = await missingResponse.json() as unknown;
  if (!isRecord(missingPayload) || !Array.isArray(missingPayload.missing)) {
    throw new Error('Local Buffer storage response was not valid.');
  }
  const missing = new Set(missingPayload.missing.filter((hash): hash is string => typeof hash === 'string'));
  await Promise.all(uniqueAssets.filter((asset) => missing.has(asset.hash)).map(async (asset) => {
    const snapshot = await loadBufferSnapshot(asset);
    if (!snapshot) throw new Error(`Buffer ${asset.hash} is missing from browser storage.`);
    const bytes = new Uint8Array(snapshot.samples.byteLength);
    bytes.set(new Uint8Array(snapshot.samples.buffer, snapshot.samples.byteOffset, snapshot.samples.byteLength));
    const data = bytes.buffer;
    const response = await fetch(`/api/local-buffers/${asset.hash}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: data,
    });
    if (!response.ok) throw new Error(await localPatchStorageError(response));
  }));
}

async function fetchLocalBufferContent(hash: string): Promise<ArrayBuffer> {
  const response = await fetch(`/api/local-buffers/${hash}`, {
    method: 'GET',
    headers: { Accept: 'application/octet-stream' },
  });
  if (!response.ok) throw new Error(await localPatchStorageError(response));
  return response.arrayBuffer();
}

async function fetchLocalPatchVersion(patchName: string, versionId: string): Promise<string> {
  const params = new URLSearchParams({ patch: patchName, version: versionId });
  const response = await fetch(`/api/local-patches/version?${params.toString()}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(await localPatchStorageError(response));
  }
  return response.text();
}

async function localPatchStorageError(response: Response): Promise<string> {
  const message = await response.text();
  return message || `Local patch storage failed with HTTP ${response.status}.`;
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

function sanitizeLocalPatchStorageSegment(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return cleaned || 'untitled-patch';
}

function sanitizePatchFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return cleaned || 'untitled-patch';
}

function formatSavedPatchTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  const year = date.getFullYear();
  const month = padDatePart(date.getMonth() + 1);
  const day = padDatePart(date.getDate());
  const hour = padDatePart(date.getHours());
  const minute = padDatePart(date.getMinutes());
  const second = padDatePart(date.getSeconds());
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function formatRecordingTimestamp(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${padDatePart(minutes)}:${padDatePart(seconds)}`;
}

function preferredSampleRecordingFormat(): { mimeType: string; extension: string } {
  const formats = [
    { mimeType: 'audio/webm;codecs=opus', extension: '.webm' },
    { mimeType: 'audio/ogg;codecs=opus', extension: '.ogg' },
    { mimeType: 'audio/mp4', extension: '.m4a' },
    { mimeType: 'audio/webm', extension: '.webm' },
    { mimeType: 'audio/ogg', extension: '.ogg' },
  ];
  return formats.find((format) => MediaRecorder.isTypeSupported(format.mimeType))
    ?? { mimeType: '', extension: '.webm' };
}

function sampleRecordingFileName(name: string, extension: string): string {
  const stem = name.replace(/\.(?:aac|aif|aiff|flac|m4a|mp3|oga|ogg|wav|wave|webm)$/i, '').trim() || 'recording';
  return `${stem}${extension}`;
}

async function uploadLocalSample(file: File): Promise<SampleAsset> {
  const response = await fetch(`/api/local-samples?name=${encodeURIComponent(file.name)}`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  if (!response.ok) {
    throw new Error(await response.text() || `Sample upload failed (${response.status}).`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || typeof payload.name !== 'string' || typeof payload.url !== 'string') {
    throw new Error('Sample upload returned an invalid response.');
  }
  return {
    name: payload.name,
    url: payload.url,
    ...(typeof payload.originalUrl === 'string' ? { originalUrl: payload.originalUrl } : {}),
  };
}

function bufferContainsAudio(samples: Float32Array): boolean {
  return samples.some((sample) => Number.isFinite(sample) && sample !== 0);
}

function preservedBufferIds(program: DspProgram): Set<string> {
  const repeatedStateRanges = program.repeatBindings.map((binding) => ({
    start: binding.stateStart,
    end: binding.stateStart + binding.stateCount,
  }));
  const preservedStates = new Set(program.ops.flatMap((op) => (
    op.opcode === DSP_OP.Buffer
      && (op.value ?? 0) >= 0.5
      && op.state !== undefined
      && !repeatedStateRanges.some((range) => op.state! >= range.start && op.state! < range.end)
      ? [op.state]
      : []
  )));
  return new Set(program.stateBindings.flatMap((binding) => (
    binding.id.endsWith(':buffer') && preservedStates.has(binding.state)
      ? [binding.nodeId]
      : []
  )));
}

function filterBufferAssets(
  assets: Record<string, BufferAsset>,
  nodeIds: ReadonlySet<string>,
): Record<string, BufferAsset> {
  return Object.fromEntries(Object.entries(assets).filter(([nodeId]) => nodeIds.has(nodeId)));
}

function bufferVisualizationContainsAudio(buffer: { bins: Array<{ min: number; max: number }> } | undefined): boolean {
  return buffer?.bins.some((bin) => bin.min !== 0 || bin.max !== 0) === true;
}

function encodeMonoSamplesAsWav(samples: Float32Array, sampleRate: number): Blob {
  const safeSampleRate = Math.max(1, Math.round(sampleRate));
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  writeWavText(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeWavText(view, 8, 'WAVE');
  writeWavText(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, safeSampleRate, true);
  view.setUint32(28, safeSampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeWavText(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const value of samples) {
    const sample = Math.max(-1, Math.min(1, Number.isFinite(value) ? value : 0));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += bytesPerSample;
  }
  return new Blob([view], { type: 'audio/wav' });
}

async function convertRecordedAudioToWav(recording: Blob): Promise<Blob> {
  const context = new AudioContext();
  try {
    const audioBuffer = await context.decodeAudioData(await recording.arrayBuffer());
    return encodeAudioBufferAsWav(audioBuffer);
  } catch (error) {
    throw new Error('Could not convert the microphone recording to WAV.', { cause: error });
  } finally {
    await context.close();
  }
}

function encodeAudioBufferAsWav(audioBuffer: AudioBuffer): Blob {
  const channelCount = audioBuffer.numberOfChannels;
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = audioBuffer.length * blockAlign;
  const wav = new ArrayBuffer(44 + dataSize);
  const view = new DataView(wav);

  writeWavText(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeWavText(view, 8, 'WAVE');
  writeWavText(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, audioBuffer.sampleRate, true);
  view.setUint32(28, audioBuffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeWavText(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = Array.from({ length: channelCount }, (_, channel) => audioBuffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < audioBuffer.length; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return new Blob([wav], { type: 'audio/wav' });
}

function writeWavText(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}

interface MidiSettingsModalProps {
  state: MidiInputState;
  selectedDeviceIds: string[];
  selectedOutputDeviceIds: string[];
  midiClockOutputEnabled: boolean;
  onToggleDevice: (deviceId: string, selected: boolean) => void;
  onToggleOutputDevice: (deviceId: string, selected: boolean) => void;
  onMidiClockOutputChange: (enabled: boolean) => void;
  onRefresh: () => void;
  onClose: () => void;
}

function MidiSettingsModal({
  state,
  selectedDeviceIds,
  selectedOutputDeviceIds,
  midiClockOutputEnabled,
  onToggleDevice,
  onToggleOutputDevice,
  onMidiClockOutputChange,
  onRefresh,
  onClose,
}: MidiSettingsModalProps) {
  const selectedDeviceIdSet = new Set(selectedDeviceIds);
  const knownDeviceIds = new Set(state.devices.map((device) => device.id));
  const missingSelectedDeviceIds = selectedDeviceIds.filter((deviceId) => !knownDeviceIds.has(deviceId));
  const selectedOutputDeviceIdSet = new Set(selectedOutputDeviceIds);
  const knownOutputDeviceIds = new Set(state.outputDevices.map((device) => device.id));
  const missingSelectedOutputDeviceIds = selectedOutputDeviceIds.filter((deviceId) => !knownOutputDeviceIds.has(deviceId));
  const unavailable = state.status === 'unsupported' || state.status === 'denied' || state.status === 'error';
  const refreshLabel = state.status === 'inactive' || state.status === 'needs-permission'
    ? 'Enable'
    : 'Refresh';

  return (
    <div
      className="import-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="import-modal midi-settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="midi-settings-modal-title"
      >
        <header className="import-modal-header">
          <div>
            <h2 id="midi-settings-modal-title">MIDI</h2>
            <p>{midiInputModalStatusLabel(state.status)}</p>
          </div>
          <button className="import-modal-close" type="button" onClick={onClose} aria-label="Close MIDI settings" title="Close">X</button>
        </header>

        <p className={['import-modal-message', unavailable ? 'error' : ''].filter(Boolean).join(' ')}>
          {state.message}
        </p>

        <h3 className="midi-settings-section-title">Inputs</h3>
        <div className="midi-settings-device-list">
          {state.devices.map((device) => (
            <label className="midi-settings-device" key={device.id}>
              <input
                type="checkbox"
                checked={selectedDeviceIdSet.has(device.id)}
                onChange={(event) => onToggleDevice(device.id, event.currentTarget.checked)}
              />
              <span>{device.label}</span>
              <small>{device.state}</small>
            </label>
          ))}
          {missingSelectedDeviceIds.map((deviceId) => (
            <label className="midi-settings-device midi-settings-device-missing" key={deviceId}>
              <input
                type="checkbox"
                checked
                onChange={(event) => onToggleDevice(deviceId, event.currentTarget.checked)}
              />
              <span>{deviceId}</span>
              <small>missing</small>
            </label>
          ))}
        </div>

        <h3 className="midi-settings-section-title">Outputs</h3>
        <div className="midi-settings-device-list">
          {state.outputDevices.map((device) => (
            <label className="midi-settings-device" key={device.id}>
              <input
                type="checkbox"
                checked={selectedOutputDeviceIdSet.has(device.id)}
                onChange={(event) => onToggleOutputDevice(device.id, event.currentTarget.checked)}
              />
              <span>{device.label}</span>
              <small>{device.state}</small>
            </label>
          ))}
          {missingSelectedOutputDeviceIds.map((deviceId) => (
            <label className="midi-settings-device midi-settings-device-missing" key={deviceId}>
              <input type="checkbox" checked onChange={(event) => onToggleOutputDevice(deviceId, event.currentTarget.checked)} />
              <span>{deviceId}</span>
              <small>missing</small>
            </label>
          ))}
        </div>

        <label className="midi-settings-device midi-settings-clock-output">
          <input
            type="checkbox"
            checked={midiClockOutputEnabled}
            onChange={(event) => onMidiClockOutputChange(event.currentTarget.checked)}
            disabled={unavailable}
          />
          <span>Send MIDI clock and transport</span>
        </label>

        <footer className="import-modal-actions">
          <button type="button" onClick={onClose}>Close</button>
          {state.canRequestAccess ? (
            <button type="button" onClick={onRefresh}>{refreshLabel}</button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function midiInputModalStatusLabel(status: MidiInputState['status']): string {
  switch (status) {
    case 'connected':
      return 'connected';
    case 'requesting':
      return 'requesting';
    case 'needs-permission':
      return 'permission';
    case 'denied':
      return 'denied';
    case 'unsupported':
      return 'unavailable';
    case 'error':
      return 'check input';
    case 'inactive':
    default:
      return 'idle';
  }
}

function padDatePart(value: number): string {
  return String(value).padStart(2, '0');
}






function patchToDspKey(patch: Patch): string {
  return JSON.stringify(patch);
}

function stripPatchForDsp(patch: Patch): Patch {
  // Positions only affect DSP when an unlocked Spread/Spawn derives its
  // membership from canvas containment. Ordinary layout changes must not
  // rebuild the program.
  const includesPositionBasedRuntimeContainer = patch.nodes.some((node) => (
    (node.type === 'Spread' || node.type === 'Spawn') && !node.spreadNodeIds
  ));
  return {
    nodes: patch.nodes.map((node) => stripPatchNodeForDsp(node, includesPositionBasedRuntimeContainer)),
    links: patch.links.map((link) => ({
      from: { ...link.from },
      to: { ...link.to },
      weight: link.weight,
      mode: link.mode,
      ...(link.enabled === false ? { enabled: false } : {}),
      ...(link.weightModulations?.length ? { weightModulations: link.weightModulations } : {}),
    })),
  };
}

function classifyDspErrors(errors: string[], patch: Patch): DspEditorDiagnostics {
  const diagnostics: DspEditorDiagnostics = {
    nodeErrors: new Map(),
    edgeErrors: new Map(),
    globalErrors: [],
  };
  const nodeById = new Set(patch.nodes.map((node) => node.id));
  const nodeIdsByType = new Map<NodeType, string[]>();
  for (const node of patch.nodes) {
    nodeIdsByType.set(node.type, [...(nodeIdsByType.get(node.type) ?? []), node.id]);
  }

  for (const error of errors) {
    let localized = false;

    const explicitNodeId = extractDspErrorNodeId(error);
    if (explicitNodeId && nodeById.has(explicitNodeId)) {
      addDiagnostic(diagnostics.nodeErrors, explicitNodeId, error);
      localized = true;
    }

    const unsupportedType = error.match(/^Node type "([^"]+)"/)?.[1] as NodeType | undefined;
    if (unsupportedType) {
      for (const nodeId of nodeIdsByType.get(unsupportedType) ?? []) {
        addDiagnostic(diagnostics.nodeErrors, nodeId, error);
        localized = true;
      }
    }

    for (const edgeKey of edgeKeysForDspError(error, patch)) {
      addDiagnostic(diagnostics.edgeErrors, edgeKey, error);
      localized = true;
    }

    if (!localized) diagnostics.globalErrors.push(error);
  }

  return diagnostics;
}

function extractDspErrorNodeId(error: string): string | null {
  return error.match(/^(?:Expression node|Audio Out node|Node) "([^"]+)"/)?.[1]
    ?? error.match(/^Link (?:source|target) node "([^"]+)"/)?.[1]
    ?? error.match(/ on node "([^"]+)"/)?.[1]
    ?? null;
}

function edgeKeysForDspError(error: string, patch: Patch): string[] {
  const formattedLink = error.match(/^Link "([^"]+)"/)?.[1];
  if (formattedLink) {
    const key = edgeKeyFromFormattedLink(formattedLink);
    return key ? [key] : [];
  }

  const sourceNode = error.match(/^Link source node "([^"]+)"/)?.[1];
  if (sourceNode) {
    return patch.links
      .filter((link) => link.from.node === sourceNode)
      .map(edgeId);
  }

  const targetNode = error.match(/^Link target node "([^"]+)"/)?.[1];
  if (targetNode) {
    return patch.links
      .filter((link) => link.to.node === targetNode)
      .map(edgeId);
  }

  const unsupportedOutput = error.match(/^Node "([^"]+)" does not have supported output "([^"]+)"/);
  if (unsupportedOutput) {
    const [, nodeId, port] = unsupportedOutput;
    return patch.links
      .filter((link) => link.from.node === nodeId && link.from.port === port)
      .map(edgeId);
  }

  return [];
}

function edgeKeyFromFormattedLink(value: string): string | null {
  const match = value.match(/^(.+):([^:]+) -> (.+):([^:]+)$/);
  if (!match) return null;
  const [, fromNode, fromPort, toNode, toPort] = match;
  return edgeId({
    from: { node: fromNode, port: fromPort },
    to: { node: toNode, port: toPort },
  });
}

function addDiagnostic(map: Map<string, string[]>, key: string, error: string): void {
  map.set(key, [...(map.get(key) ?? []), error]);
}

/**
 * The controlled React Flow API updates the nodes array while a node is being
 * dragged. Decoration below adds callbacks and visual state, so rebuilding
 * that decoration naively changes every node's `data` reference and defeats
 * `memo(ShaderNode)`. Reuse a prior presentation whenever its shallow values
 * are identical; the moved/resized node still receives its new object.
 */
function reuseUnchangedNodePresentations(
  previousNodes: ShaderFlowNode[],
  nextNodes: ShaderFlowNode[],
): ShaderFlowNode[] {
  const previousById = new Map(previousNodes.map((node) => [node.id, node]));
  return nextNodes.map((nextNode) => {
    const previousNode = previousById.get(nextNode.id);
    return previousNode && shallowEqualFlowNodePresentation(previousNode, nextNode)
      ? previousNode
      : nextNode;
  });
}

function shallowEqualFlowNodePresentation(left: ShaderFlowNode, right: ShaderFlowNode): boolean {
  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;

  for (const key of leftKeys) {
    if (!(key in rightRecord)) return false;
    if (key === 'data') {
      if (!shallowEqualRecord(
        leftRecord.data as Record<string, unknown>,
        rightRecord.data as Record<string, unknown>,
      )) return false;
    } else if (leftRecord[key] !== rightRecord[key]) {
      return false;
    }
  }
  return true;
}

function shallowEqualRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => key in right && shallowEqualPresentationValue(left[key], right[key]));
}

function shallowEqualPresentationValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => key in right && left[key] === right[key]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function stripPatchNodeForDsp(node: PatchNode, includeLayout: boolean): PatchNode {
  return {
    id: node.id,
    type: node.type,
    ...(node.subpatchName ? { subpatchName: node.subpatchName } : {}),
    ...(node.subpatchCloneId ? { subpatchCloneId: node.subpatchCloneId } : {}),
    ...(node.subpatchUiOverrides ? { subpatchUiOverrides: structuredClone(node.subpatchUiOverrides) } : {}),
    ...(node.expression !== undefined ? { expression: node.expression } : {}),
    ...(node.sample ? { sample: { ...node.sample } } : {}),
    ...(node.image ? { image: { ...node.image } } : {}),
    ...(node.customWave ? { customWave: normalizeCustomWave(node.customWave, node.params) } : {}),
    params: { ...node.params },
    // Canvas coordinates normally are editor-only. Unlocked runtime containers
    // are the exception: their membership is calculated from these bounds.
    ...(includeLayout && node.position ? { position: { ...node.position } } : {}),
    ...(includeLayout && (node.type === 'Spread' || node.type === 'Spawn') && node.scopeSize
      ? { scopeSize: { ...node.scopeSize } }
      : {}),
    ...(node.spreadNodeIds ? { spreadNodeIds: [...node.spreadNodeIds] } : {}),
    ...(node.inputs ? { inputs: node.inputs.map((port) => ({ ...port })) } : {}),
    ...(node.outputs ? { outputs: node.outputs.map((port) => ({ ...port })) } : {}),
    ...(node.subpatch ? { subpatch: stripPatchForDsp(node.subpatch) } : {}),
    ...(node.enabled === false ? { enabled: false } : {}),
  };
}


















function collectSubpatchImportCandidates(patch: Patch): ImportedSubpatchCandidate[] {
  const candidates: ImportedSubpatchCandidate[] = [];

  function visit(currentPatch: Patch, pathParts: string[]) {
    currentPatch.nodes.forEach((node, index) => {
      if (node.type !== 'Group' || !node.subpatch) return;

      const name = node.subpatchName ?? node.id;
      const path = [...pathParts, name];
      const inputCount = boundaryPortDefinitions(node.subpatch, 'Ins', 'outputs').length;
      const outputCount = boundaryPortDefinitions(node.subpatch, 'Outs', 'inputs').length;
      candidates.push({
        key: `${path.join('/')}:${node.id}:${index}`,
        name,
        path: path.join(' / '),
        subpatch: node.subpatch,
        inputCount,
        outputCount,
        nodeCount: node.subpatch.nodes.length,
      });

      visit(node.subpatch, path);
    });
  }

  visit(patch, []);
  return candidates;
}

async function buildLocalSubpatchImportEntries(patches: LocalPatchEntry[]): Promise<LocalSubpatchImportEntry[]> {
  const sourcesBySubpatchName = new Map<string, LocalSubpatchImportSource[]>();
  const versionTasks = patches.flatMap((patchEntry) => patchEntry.versions.map(async (version) => {
    const patch = parsePatchJson(await fetchLocalPatchVersion(patchEntry.name, version.id));
    collectSubpatchImportCandidates(patch).forEach((candidate) => {
      const key = `${patchEntry.name}/${version.id}/${candidate.key}`;
      const source: LocalSubpatchImportSource = {
        key,
        patchName: patchEntry.name,
        versionId: version.id,
        savedAt: version.savedAt,
        candidate: {
          ...candidate,
          key,
          path: `${patchEntry.name} / ${formatSavedPatchTimestamp(version.savedAt)} / ${candidate.path}`,
        },
      };
      const sources = sourcesBySubpatchName.get(candidate.name);
      if (sources) {
        sources.push(source);
      } else {
        sourcesBySubpatchName.set(candidate.name, [source]);
      }
    });
  }));
  await Promise.all(versionTasks);

  return Array.from(sourcesBySubpatchName.entries())
    .map(([name, sources]) => ({
      name,
      sources: sources.sort(compareLocalSubpatchSources),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function compareLocalSubpatchSources(a: LocalSubpatchImportSource, b: LocalSubpatchImportSource): number {
  const savedAtDelta = Date.parse(b.savedAt) - Date.parse(a.savedAt);
  if (Number.isFinite(savedAtDelta) && savedAtDelta !== 0) return savedAtDelta;

  const patchNameDelta = a.patchName.localeCompare(b.patchName);
  if (patchNameDelta !== 0) return patchNameDelta;

  return b.versionId.localeCompare(a.versionId);
}

function flowPositionForNewImport(
  reactFlow: ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge> | null,
  nodes: ShaderFlowNode[],
): { x: number; y: number } {
  if (reactFlow) {
    return reactFlow.screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
  }

  if (nodes.length === 0) return { x: 0, y: 0 };
  const bounds = nodeBounds(nodes);
  return { x: bounds.x + bounds.width + 180, y: bounds.y };
}

function loadInitialEditorState(): PersistedEditorState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedEditorState;
    if (parsed?.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadStoredViewport(): Viewport | null {
  try {
    const raw = window.localStorage.getItem(VIEWPORT_STORAGE_KEY);
    if (!raw) return null;
    const viewport = JSON.parse(raw) as Partial<Viewport>;
    if (!Number.isFinite(Number(viewport.x)) || !Number.isFinite(Number(viewport.y)) || !Number.isFinite(Number(viewport.zoom))) return null;
    return {
      x: Number(viewport.x),
      y: Number(viewport.y),
      zoom: Math.max(MIN_CANVAS_ZOOM, Number(viewport.zoom)),
    };
  } catch {
    return null;
  }
}

function storeViewport(viewport: Viewport): void {
  try {
    window.localStorage.setItem(VIEWPORT_STORAGE_KEY, JSON.stringify(viewport));
  } catch {
    // Persistence is optional when storage is unavailable or full.
  }
}


function patchWithMidiControlVisuals(patch: Patch, visuals: Record<string, MidiControlVisualState>): Patch {
  if (Object.keys(visuals).length === 0) return patch;

  let changed = false;
  const nodes = patch.nodes.map((node) => {
    const visual = visuals[node.id];
    if (!visual) return node;

    if (node.type === 'Slider' && visual.sliderValue !== undefined) {
      changed = true;
      return {
        ...node,
        params: {
          ...node.params,
          value: clampNumber(visual.sliderValue, 0, 1),
        },
      };
    }

    if (node.type === 'Joystick' && (visual.joystickX !== undefined || visual.joystickY !== undefined)) {
      changed = true;
      return {
        ...node,
        params: {
          ...node.params,
          ...(visual.joystickX !== undefined ? { x: clampNumber(visual.joystickX, 0, 1) } : {}),
          ...(visual.joystickY !== undefined ? { y: clampNumber(visual.joystickY, 0, 1) } : {}),
        },
      };
    }

    if (node.type === 'Button' && visual.buttonPressed !== undefined) {
      const mode = clampInteger(node.params.mode ?? 0, 0, 2);
      if (mode === 1) return node;
      changed = true;
      return {
        ...node,
        params: {
          ...node.params,
          pressed: visual.buttonPressed >= 0.5 ? 1 : 0,
        },
      };
    }

    return node;
  });

  return changed ? { ...patch, nodes } : patch;
}

function midiControlVisualsForChange(
  current: Record<string, MidiControlVisualState>,
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  controlChange: MidiControlChange,
): Record<string, MidiControlVisualState> {
  let next = current;

  for (const node of nodes) {
    const patchNode = node.data.patchNode;
    if (patchNode.type !== 'Slider' && patchNode.type !== 'Joystick' && patchNode.type !== 'Button') continue;

    if (patchNode.type === 'Joystick') {
      const previous = next[patchNode.id] ?? {};
      const xMatches = (
        clampInteger(patchNode.params.xMidiChannel ?? 0, 0, 16) === controlChange.channel
        && clampInteger(patchNode.params.xMidiCc ?? 1, 0, 127) === controlChange.cc
      );
      const yMatches = (
        clampInteger(patchNode.params.yMidiChannel ?? 0, 0, 16) === controlChange.channel
        && clampInteger(patchNode.params.yMidiCc ?? 2, 0, 127) === controlChange.cc
      );
      if (!xMatches && !yMatches) continue;
      next = setMidiControlVisual(next, patchNode.id, {
        ...previous,
        ...(xMatches ? { joystickX: clampNumber(controlChange.value, 0, 1) } : {}),
        ...(yMatches ? { joystickY: clampNumber(controlChange.value, 0, 1) } : {}),
      });
      continue;
    }

    const channel = clampInteger(patchNode.params.midiChannel ?? 0, 0, 16);
    const cc = clampInteger(patchNode.params.midiCc ?? 1, 0, 127);
    if (channel === 0 || channel !== controlChange.channel || cc !== controlChange.cc) continue;

    if (patchNode.type === 'Slider') {
      if (nodeInputIsConnected(edges, patchNode.id, 'value')) continue;
      next = setMidiControlVisual(next, patchNode.id, {
        ...(next[patchNode.id] ?? {}),
        sliderValue: clampNumber(controlChange.value, 0, 1),
        lastRawValue: controlChange.value,
      });
      continue;
    }

    const previous = next[patchNode.id] ?? {};
    const rawPressed = controlChange.value >= 0.5;
    const rawWasPressed = (previous.lastRawValue ?? 0) >= 0.5;
    const mode = clampInteger(patchNode.params.mode ?? 0, 0, 2);
    const currentPressed = previous.buttonPressed ?? patchNode.params.pressed ?? 0;
    let buttonPressed = currentPressed;

    if (mode === 0) {
      buttonPressed = rawPressed && !rawWasPressed ? (currentPressed >= 0.5 ? 0 : 1) : currentPressed;
    } else {
      buttonPressed = rawPressed ? 1 : 0;
    }

    next = setMidiControlVisual(next, patchNode.id, {
      ...previous,
      buttonPressed,
      lastRawValue: controlChange.value,
    });
  }

  for (const node of nodes) {
    const group = node.data.patchNode;
    if (group.type !== 'Group' || !group.subpatch) continue;
    const layout = groupUiPreviewLayout(group.subpatch);
    if (!layout) continue;

    for (const innerNode of layout.nodes) {
      if (innerNode.type !== 'Slider' && innerNode.type !== 'Joystick' && innerNode.type !== 'Button') continue;
      const previewId = `__group_ui__${node.id}__${innerNode.id}`;
      const params = { ...innerNode.params, ...group.subpatchUiOverrides?.[innerNode.id]?.params };
      const previous = next[previewId] ?? {};

      if (innerNode.type === 'Joystick') {
        const xMatches = clampInteger(params.xMidiChannel ?? 0, 0, 16) === controlChange.channel
          && clampInteger(params.xMidiCc ?? 1, 0, 127) === controlChange.cc;
        const yMatches = clampInteger(params.yMidiChannel ?? 0, 0, 16) === controlChange.channel
          && clampInteger(params.yMidiCc ?? 2, 0, 127) === controlChange.cc;
        if (!xMatches && !yMatches) continue;
        next = setMidiControlVisual(next, previewId, {
          ...previous,
          ...(xMatches ? { joystickX: clampNumber(controlChange.value, 0, 1) } : {}),
          ...(yMatches ? { joystickY: clampNumber(controlChange.value, 0, 1) } : {}),
        });
        continue;
      }

      const channel = clampInteger(params.midiChannel ?? 0, 0, 16);
      const cc = clampInteger(params.midiCc ?? 1, 0, 127);
      if (channel === 0 || channel !== controlChange.channel || cc !== controlChange.cc) continue;

      if (innerNode.type === 'Slider') {
        if (patchInputIsConnected(group.subpatch.links, innerNode.id, 'value')) continue;
        next = setMidiControlVisual(next, previewId, {
          ...previous,
          sliderValue: clampNumber(controlChange.value, 0, 1),
          lastRawValue: controlChange.value,
        });
        continue;
      }

      const rawPressed = controlChange.value >= 0.5;
      const rawWasPressed = (previous.lastRawValue ?? 0) >= 0.5;
      const mode = clampInteger(params.mode ?? 0, 0, 2);
      const currentPressed = previous.buttonPressed ?? params.pressed ?? 0;
      const buttonPressed = mode === 0
        ? (rawPressed && !rawWasPressed ? (currentPressed >= 0.5 ? 0 : 1) : currentPressed)
        : (rawPressed ? 1 : 0);
      next = setMidiControlVisual(next, previewId, {
        ...previous,
        buttonPressed,
        lastRawValue: controlChange.value,
      });
    }
  }

  return next;
}

function applyMidiControlChangeToNodes(
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  controlChange: MidiControlChange,
  previousVisuals: Record<string, MidiControlVisualState>,
  nextVisuals: Record<string, MidiControlVisualState>,
): ShaderFlowNode[] {
  let changed = false;

  const nextNodes = nodes.map((node) => {
    const patchNode = node.data.patchNode;
    if (patchNode.type !== 'Slider' && patchNode.type !== 'Joystick' && patchNode.type !== 'Button') return node;

    const visual = nextVisuals[patchNode.id];
    if (!visual) return node;
    let params: Record<string, number> | null = null;

    if (patchNode.type === 'Slider') {
      const matches = clampInteger(patchNode.params.midiChannel ?? 0, 0, 16) === controlChange.channel
        && clampInteger(patchNode.params.midiCc ?? 1, 0, 127) === controlChange.cc;
      if (matches && !nodeInputIsConnected(edges, patchNode.id, 'value') && visual.sliderValue !== undefined) {
        params = { ...patchNode.params, value: clampNumber(visual.sliderValue, 0, 1) };
      }
    } else if (patchNode.type === 'Joystick') {
      const xMatches = clampInteger(patchNode.params.xMidiChannel ?? 0, 0, 16) === controlChange.channel
        && clampInteger(patchNode.params.xMidiCc ?? 1, 0, 127) === controlChange.cc;
      const yMatches = clampInteger(patchNode.params.yMidiChannel ?? 0, 0, 16) === controlChange.channel
        && clampInteger(patchNode.params.yMidiCc ?? 2, 0, 127) === controlChange.cc;
      if (xMatches || yMatches) {
        params = {
          ...patchNode.params,
          ...(xMatches && visual.joystickX !== undefined ? { x: clampNumber(visual.joystickX, 0, 1) } : {}),
          ...(yMatches && visual.joystickY !== undefined ? { y: clampNumber(visual.joystickY, 0, 1) } : {}),
        };
      }
    } else {
      const matches = clampInteger(patchNode.params.midiChannel ?? 0, 0, 16) === controlChange.channel
        && clampInteger(patchNode.params.midiCc ?? 1, 0, 127) === controlChange.cc;
      if (matches) {
        const mode = clampInteger(patchNode.params.mode ?? 0, 0, 2);
        if (mode === 1) {
          const previousRaw = previousVisuals[patchNode.id]?.lastRawValue ?? 0;
          if (controlChange.value >= 0.5 && previousRaw < 0.5) {
            params = { ...patchNode.params, clicks: (patchNode.params.clicks ?? 0) + 1 };
          }
        } else if (visual.buttonPressed !== undefined) {
          params = { ...patchNode.params, pressed: visual.buttonPressed >= 0.5 ? 1 : 0 };
        }
      }
    }

    if (!params) return node;
    changed = true;
    return {
      ...node,
      data: {
        ...node.data,
        patchNode: { ...patchNode, params },
      },
    };
  });

  return changed ? nextNodes : nodes;
}

function setMidiControlVisual(
  current: Record<string, MidiControlVisualState>,
  nodeId: string,
  visual: MidiControlVisualState,
): Record<string, MidiControlVisualState> {
  const previous = current[nodeId];
  if (
    previous?.sliderValue === visual.sliderValue &&
    previous?.joystickX === visual.joystickX &&
    previous?.joystickY === visual.joystickY &&
    previous?.buttonPressed === visual.buttonPressed &&
    previous?.lastRawValue === visual.lastRawValue
  ) {
    return current;
  }
  return { ...current, [nodeId]: visual };
}

function clearJoystickMidiVisual(
  current: Record<string, MidiControlVisualState>,
  nodeId: string,
  clearX: boolean,
  clearY: boolean,
): Record<string, MidiControlVisualState> {
  const visual = current[nodeId];
  if (!visual) return current;
  const nextVisual = { ...visual };
  if (clearX) delete nextVisual.joystickX;
  if (clearY) delete nextVisual.joystickY;
  return { ...current, [nodeId]: nextVisual };
}

function clearMidiControlVisual(
  current: Record<string, MidiControlVisualState>,
  nodeId: string,
  type: 'Slider' | 'Button',
): Record<string, MidiControlVisualState> {
  const visual = current[nodeId];
  if (!visual) return current;
  const nextVisual = { ...visual };
  if (type === 'Slider') delete nextVisual.sliderValue;
  else delete nextVisual.buttonPressed;
  return { ...current, [nodeId]: nextVisual };
}

function isEdgeConnectedToSelectedNode(edge: ShaderFlowEdge, selectedNodeIds: Set<string>): boolean {
  return selectedNodeIds.has(edge.source) || (!edge.data?.modulatesEdgeId && selectedNodeIds.has(edge.target));
}

function routingSelectionHighlights(
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
): { nodeIds: Set<string>; edgeIds: Set<string>; pairs: Array<[string, string]> } {
  const nodeById = new Map(nodes.map((node) => [node.id, node.data.patchNode]));
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  const forwardNumbers = new Set<number>();
  const backwardNumbers = new Set<number>();
  // Keep traversal provenance separate from visual emphasis. An upstream
  // edge must never become a new downstream seed (or vice versa).
  const forwardEdges = new Set<string>();
  const backwardEdges = new Set<string>();

  for (const node of nodes) {
    if (node.selected !== true) continue;
    const patchNode = node.data.patchNode;
    if (patchNode.type === 'Send') forwardNumbers.add(routingNodeNumber(patchNode.params.number));
    if (patchNode.type === 'Receive') backwardNumbers.add(routingNodeNumber(patchNode.params.number));
    for (const edge of edges) {
      const link = edgeEndpoints(edge);
      if (!link) continue;
      if (link.from.node === node.id) forwardEdges.add(edge.id);
      if (!edge.data?.modulatesEdgeId && link.to.node === node.id) backwardEdges.add(edge.id);
    }
  }

  for (const edge of edges) {
    if (edge.selected === true) {
      forwardEdges.add(edge.id);
      backwardEdges.add(edge.id);
    }
  }

  let changed = true;
  while (changed) {
    const previousNodeCount = nodeIds.size;
    const previousEdgeCount = forwardEdges.size + backwardEdges.size;
    const previousForwardCount = forwardNumbers.size;
    const previousBackwardCount = backwardNumbers.size;

    for (const edge of edges) {
      // A cable's strength is an input: tracing upstream from that cable also
      // visits its incoming modulation cables, recursively. Keep this in the
      // backward traversal so highlighting does not spill into route siblings.
      if (edge.data?.modulatesEdgeId && backwardEdges.has(edge.data.modulatesEdgeId)) {
        backwardEdges.add(edge.id);
      }
      // Trace downstream into the cable this output modulates. Keep it a
      // forward-only seed so unrelated modulators of that cable stay dimmed.
      if (edge.data?.modulatesEdgeId && forwardEdges.has(edge.id)) {
        forwardEdges.add(edge.data.modulatesEdgeId);
      }
      if (!forwardEdges.has(edge.id) && !backwardEdges.has(edge.id)) continue;
      edgeIds.add(edge.id);
      const link = edgeEndpoints(edge);
      if (!link) continue;
      const source = nodeById.get(link.from.node);
      const target = nodeById.get(link.to.node);
      if (backwardEdges.has(edge.id) && source?.type === 'Receive' && link.from.port === 'signal') {
        nodeIds.add(source.id);
        backwardNumbers.add(routingNodeNumber(source.params.number));
      }
      if (!edge.data?.modulatesEdgeId && forwardEdges.has(edge.id) && target?.type === 'Send' && link.to.port === 'signal') {
        nodeIds.add(target.id);
        forwardNumbers.add(routingNodeNumber(target.params.number));
      }
    }

    for (const node of nodes) {
      const patchNode = node.data.patchNode;
      if (patchNode.type !== 'Send' && patchNode.type !== 'Receive') continue;
      const number = routingNodeNumber(patchNode.params.number);

      for (const edge of edges) {
        const link = edgeEndpoints(edge);
        if (!link) continue;
        if (
          !edge.data?.modulatesEdgeId
          && patchNode.type === 'Send'
          && backwardNumbers.has(number)
          && link.to.node === node.id
          && link.to.port === 'signal'
        ) {
          nodeIds.add(node.id);
          backwardEdges.add(edge.id);
        }
        if (
          patchNode.type === 'Receive'
          && forwardNumbers.has(number)
          && link.from.node === node.id
          && link.from.port === 'signal'
        ) {
          nodeIds.add(node.id);
          forwardEdges.add(edge.id);
        }
      }
    }

    changed = nodeIds.size !== previousNodeCount
      || forwardEdges.size + backwardEdges.size !== previousEdgeCount
      || forwardNumbers.size !== previousForwardCount
      || backwardNumbers.size !== previousBackwardCount;
  }

  const forwardSends = new Set(nodes.filter((node) => node.selected && node.data.patchNode.type === 'Send').map((node) => node.id));
  const backwardReceives = new Set(nodes.filter((node) => node.selected && node.data.patchNode.type === 'Receive').map((node) => node.id));
  for (const edge of edges) {
    const link = edgeEndpoints(edge);
    if (!link) continue;
    if (!edge.data?.modulatesEdgeId && forwardEdges.has(edge.id) && link.to.port === 'signal' && nodeById.get(link.to.node)?.type === 'Send') forwardSends.add(link.to.node);
    if (backwardEdges.has(edge.id) && link.from.port === 'signal' && nodeById.get(link.from.node)?.type === 'Receive') backwardReceives.add(link.from.node);
  }
  const pairs: Array<[string, string]> = [];
  for (const send of nodes.filter((node) => node.data.patchNode.type === 'Send')) {
    for (const receive of nodes.filter((node) => node.data.patchNode.type === 'Receive')) {
      if (!forwardSends.has(send.id) && !backwardReceives.has(receive.id)) continue;
      if (routingNodeNumber(send.data.patchNode.params.number) !== routingNodeNumber(receive.data.patchNode.params.number)) continue;
      pairs.push([send.id, receive.id]);
    }
  }
  return { nodeIds, edgeIds, pairs };
}

function routingNodeNumber(value: number | undefined): number {
  return clampInteger(value ?? 1, 1, 10);
}

function nodeInputIsConnected(edges: ShaderFlowEdge[], nodeId: string, port: string): boolean {
  return edges.some((edge) => {
    const link = linkFromEdge(edge);
    return link?.to.node === nodeId && link.to.port === port;
  });
}

function patchInputIsConnected(links: Patch['links'], nodeId: string, port: string): boolean {
  return links.some((link) => link.to.node === nodeId && link.to.port === port);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.round(clampNumber(Number.isFinite(value) ? value : min, min, max));
}

function graphSnapshot(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[], areas: EditorArea[] = []): GraphSnapshot {
  const state = flowToEditorState(nodes, edges);
  return {
    nodes: state.nodes,
    edges: state.edges,
    areas: structuredClone(areas),
  };
}

function graphSnapshotKey(snapshot: GraphSnapshot): string {
  return JSON.stringify(snapshot);
}



function samePortDefinitions(left: PortDefinition[], right: PortDefinition[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((port, index) => (
    port.name === right[index]?.name &&
    port.defaultValue === right[index]?.defaultValue &&
    port.connectable === right[index]?.connectable &&
    port.valueEditor === right[index]?.valueEditor &&
    port.min === right[index]?.min &&
    port.max === right[index]?.max &&
    port.integer === right[index]?.integer
  ));
}

function restoreGraphSnapshot(
  snapshot: GraphSnapshot,
  setNodes: (value: ShaderFlowNode[]) => void,
  setEdges: (value: ShaderFlowEdge[]) => void,
  setAreas: (value: EditorArea[]) => void,
): void {
  const state: PersistedEditorState = { version: 1, nodes: snapshot.nodes, edges: snapshot.edges, areas: snapshot.areas };
  const callbacks = nodeCallbacksPlaceholder();
  setNodes(editorStateToFlowNodes(state, callbacks, null));
  setEdges(editorStateToFlowEdges(state, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder));
  setAreas(snapshot.areas ? structuredClone(snapshot.areas) : []);
}

function linkFromConnection(connection: Connection, mode: LinkMode = 'set'): PatchLink | null {
  if (!connection.source || !connection.target || !connection.sourceHandle || !connection.targetHandle) return null;
  const edge = {
    id: '',
    source: connection.source,
    sourceHandle: connection.sourceHandle,
    target: connection.target,
    targetHandle: connection.targetHandle,
    data: { mode },
  };
  return linkFromEdge(edge);
}

function linkForDraftNodeConnection(connection: DraftNodeConnection, nodeId: string): PatchLink | null {
  const originPort = parseHandleId(connection.originHandleId);
  if (!originPort) return null;

  if (connection.originHandleType === 'source') {
    return {
      from: { node: connection.originNodeId, port: originPort.port },
      to: { node: nodeId, port: 'value' },
      weight: 1,
      mode: connection.mode,
    };
  }

  return {
    from: { node: nodeId, port: 'value' },
    to: { node: connection.originNodeId, port: originPort.port },
    weight: 1,
    mode: connection.mode,
  };
}

function parseHandleId(handleId: string): { kind: 'in' | 'out'; port: string } | null {
  const [kind, port] = handleId.split(':');
  if ((kind !== 'in' && kind !== 'out') || !port) return null;
  return { kind, port };
}

function clientPointFromEvent(event: globalThis.MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('touches' in event) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch ? { x: touch.clientX, y: touch.clientY } : null;
  }

  return { x: event.clientX, y: event.clientY };
}

function nodeHandleAtScreenPoint(point: { x: number; y: number }): { nodeId: string; handleId: string } | null {
  for (const handle of document.querySelectorAll<HTMLElement>('.react-flow__handle')) {
    const bounds = handle.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    if (point.x < bounds.left - 8 || point.x > bounds.right + 8 || point.y < bounds.top - 8 || point.y > bounds.bottom + 8) continue;
    const nodeId = handle.getAttribute('data-nodeid');
    const handleId = handle.getAttribute('data-handleid');
    if (nodeId && handleId) return { nodeId, handleId };
  }
  return null;
}

function strengthTargetIsAllowed(edgeId: string, targetId: string, edges: ShaderFlowEdge[]): boolean {
  const visited = new Set([edgeId]);
  let target: ShaderFlowEdge | undefined = edges.find((edge) => edge.id === targetId);
  while (target) {
    if (visited.has(target.id)) return false;
    visited.add(target.id);
    target = target.data?.modulatesEdgeId ? edges.find((edge) => edge.id === target!.data?.modulatesEdgeId) : undefined;
  }
  return true;
}

function linkAtScreenPoint(point: { x: number; y: number }, edges: ShaderFlowEdge[]): string | null {
  if (nodeHandleAtScreenPoint(point)) return null;
  const edgeIds = new Set(edges.map((edge) => edge.id));
  for (const element of document.elementsFromPoint(point.x, point.y)) {
    const edgeElement = element.closest('.react-flow__edge[data-id]');
    const id = edgeElement?.getAttribute('data-id');
    if (id && edgeIds.has(id)) return id;
  }

  let nearestId: string | null = null;
  let nearestDistanceSquared = 14 * 14;
  for (const path of document.querySelectorAll<SVGPathElement>('.react-flow__edge[data-id] path.shader-edge-path-foreground')) {
    const id = path.closest('.react-flow__edge[data-id]')?.getAttribute('data-id');
    if (!id || !edgeIds.has(id)) continue;
    const bounds = path.getBoundingClientRect();
    if (point.x < bounds.left - 14 || point.x > bounds.right + 14 || point.y < bounds.top - 14 || point.y > bounds.bottom + 14) continue;
    const transform = path.getScreenCTM();
    if (!transform) continue;
    const length = path.getTotalLength();
    const screenScale = Math.hypot(transform.a, transform.b);
    const steps = Math.min(512, Math.max(12, Math.ceil(length * screenScale / 10)));
    for (let step = 0; step <= steps; step += 1) {
      const sample = path.getPointAtLength((length * step) / steps).matrixTransform(transform);
      const distanceSquared = (sample.x - point.x) ** 2 + (sample.y - point.y) ** 2;
      if (distanceSquared < nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared;
        nearestId = id;
      }
    }
  }
  return nearestId;
}

function isCommandModifierPressed(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey || event.shiftKey;
}

function isReconnectDuplicateModifierPressed(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

function isDuplicateModifierPressed(event: globalThis.MouseEvent | TouchEvent): boolean {
  return event instanceof MouseEvent ? event.altKey : false;
}

function samePatchLink(a: PatchLink, b: PatchLink): boolean {
  return (
    a.from.node === b.from.node &&
    a.from.port === b.from.port &&
    a.to.node === b.to.node &&
    a.to.port === b.to.port
  );
}

function materializeRootGraph(
  activeNodes: ShaderFlowNode[],
  activeEdges: ShaderFlowEdge[],
  activeAreas: EditorArea[],
  editingStack: SubpatchEditFrame[],
  activePatchName: string,
): { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } {
  if (editingStack.length === 0) {
    return { nodes: activeNodes, edges: activeEdges };
  }

  let subpatch = patchFromFlow(activeNodes, activeEdges, activeAreas);
  let requestedGroupName = activePatchName;
  let materialized: { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } | null = null;

  for (let index = editingStack.length - 1; index >= 0; index -= 1) {
    const frame = editingStack[index];
    materialized = applySubpatchToParent(frame, subpatch, requestedGroupName);
    subpatch = patchFromFlow(materialized.nodes, materialized.edges, frame.parentAreas);
    requestedGroupName = frame.parentPatchName;
  }

  return materialized ?? { nodes: activeNodes, edges: activeEdges };
}

function applySubpatchToParent(
  frame: SubpatchEditFrame,
  subpatch: ReturnType<typeof patchFromFlow>,
  requestedGroupName: string,
): { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } {
  const inputDefinitions = boundaryPortDefinitions(subpatch, 'Ins', 'outputs');
  const outputDefinitions = boundaryPortDefinitions(subpatch, 'Outs', 'inputs').map((port) => ({
    name: port.name,
    ...(port.connectable === undefined ? {} : { connectable: port.connectable }),
    ...(port.min === undefined ? {} : { min: port.min }),
    ...(port.max === undefined ? {} : { max: port.max }),
    ...(port.integer === undefined ? {} : { integer: port.integer }),
  }));
  const groupNode = frame.parentNodes.find((node) => node.id === frame.groupId);
  if (!groupNode) {
    return { nodes: frame.parentNodes, edges: frame.parentEdges };
  }

  const cloneId = groupNode.data.patchNode.subpatchCloneId;
  const linkedGroupIds = new Set(
    frame.parentNodes
      .filter((node) => (
        node.data.patchNode.type === 'Group' &&
        cloneId !== undefined &&
        node.data.patchNode.subpatchCloneId === cloneId
      ))
      .map((node) => node.id),
  );
  linkedGroupIds.add(frame.groupId);

  const nextSubpatchName = normalizeSubpatchName(requestedGroupName, groupNode.data.patchNode.subpatchName ?? frame.groupId);
  const inputNames = new Set(inputDefinitions.map((port) => port.name));
  const outputNames = new Set(outputDefinitions.map((port) => port.name));
  const nodes: ShaderFlowNode[] = frame.parentNodes.map((node) => {
    if (!linkedGroupIds.has(node.id)) return { ...node, selected: false };

    const previousPatchNode = node.data.patchNode;
    const previousParams = previousPatchNode.params;
    const previousInputs = new Map((previousPatchNode.inputs ?? []).map((port) => [port.name, port]));
    const params = Object.fromEntries(inputDefinitions.map((port) => [
      port.name,
      nextGroupInputParam(previousParams, previousInputs.get(port.name), port),
    ]));
    const subpatchUiOverrides = pruneSubpatchUiOverrides(previousPatchNode.subpatchUiOverrides, subpatch);
    const { subpatchUiOverrides: _previousOverrides, ...sharedPatchNode } = previousPatchNode;

    return {
      ...node,
      selected: node.id === frame.groupId,
      data: {
        ...node.data,
        patchNode: {
          ...sharedPatchNode,
          id: node.id,
          type: 'Group',
          subpatchName: nextSubpatchName,
          subpatchCloneId: node.data.patchNode.subpatchCloneId ?? cloneId ?? makeSubpatchCloneId(node.id),
          params,
          inputs: inputDefinitions,
          outputs: outputDefinitions,
          subpatch: clonePatch(subpatch),
          ...(subpatchUiOverrides ? { subpatchUiOverrides } : {}),
        },
      },
    };
  });

  const edges = dedupeEdges(frame.parentEdges.flatMap((edge) => {
    const link = linkFromEdge(edge);
    if (!link) return [];
    if (linkedGroupIds.has(link.to.node) && !inputNames.has(link.to.port)) return [];
    if (linkedGroupIds.has(link.from.node) && !outputNames.has(link.from.port)) return [];
    return [{ ...edge, selected: false }];
  }));

  return { nodes, edges };
}

function pruneSubpatchUiOverrides(
  overrides: PatchNode['subpatchUiOverrides'],
  subpatch: Patch,
): PatchNode['subpatchUiOverrides'] | undefined {
  if (!overrides) return undefined;
  const nodeIds = new Set(subpatch.nodes.map((node) => node.id));
  const retained = Object.fromEntries(Object.entries(overrides)
    .filter(([nodeId]) => nodeIds.has(nodeId)));
  return Object.keys(retained).length > 0 ? retained : undefined;
}

function emptySubpatchForGroup(groupNode: PatchNode, position: { x: number; y: number }): ReturnType<typeof patchFromFlow> {
  return {
    nodes: [
      {
        id: 'ins_1',
        type: 'Ins',
        params: Object.fromEntries((groupNode.inputs ?? []).map((port) => [
          port.name,
          groupNode.params[port.name] ?? port.defaultValue ?? 0,
        ])),
        outputs: groupNode.inputs?.map((port) => ({
          ...port,
          defaultValue: groupNode.params[port.name] ?? port.defaultValue ?? 0,
        })) ?? [],
        position: { x: position.x - 220, y: position.y },
      },
      {
        id: 'outs_1',
        type: 'Outs',
        params: {},
        inputs: groupNode.outputs?.map((port) => ({ ...port, defaultValue: undefined })) ?? [],
        position: { x: position.x + 220, y: position.y },
      },
    ],
    links: [],
  };
}

function boundaryPortDefinitions(
  patch: ReturnType<typeof patchFromFlow>,
  boundaryType: 'Ins' | 'Outs',
  side: 'inputs' | 'outputs',
): PortDefinition[] {
  const usedNames = new Set<string>();
  const definitions: PortDefinition[] = [];

  for (const node of patch.nodes) {
    if (node.type !== boundaryType) continue;

    for (const port of node[side] ?? []) {
      if (usedNames.has(port.name)) continue;
      usedNames.add(port.name);
      definitions.push({
        ...port,
        ...(boundaryType === 'Ins' && side === 'outputs'
          ? { defaultValue: node.params[port.name] ?? port.defaultValue ?? 0 }
          : {}),
      });
    }
  }

  return definitions;
}

function nextGroupInputParam(
  previousParams: Record<string, number>,
  previousInput: PortDefinition | undefined,
  nextInput: PortDefinition,
): number {
  const nextDefault = nextInput.defaultValue ?? 0;
  const previousValue = previousParams[nextInput.name];
  if (previousValue === undefined) return nextDefault;
  if (previousValue === (previousInput?.defaultValue ?? 0)) return nextDefault;
  return previousValue;
}

function groupSelectedGraph(
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  onWeightChange: (edgeId: string, weight: number) => void,
  onModeChange: (edgeId: string, mode: LinkMode) => void,
  onInsertNode: (edgeId: string) => void,
): { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } | null {
  const selectedNodes = nodes.filter((node) => node.selected);
  if (!selectedNodes.length || selectedNodes.some((node) => node.data.patchNode.type === null)) return null;
  const selected = new Set(selectedNodes.map((node) => node.id));
  const groupId = makeNodeId('Group', new Set(nodes.map((node) => node.id)));
  const bounds = nodeBounds(selectedNodes);
  const position = { x: bounds.x, y: bounds.y };
  const boundaryIds = new Set(selected);
  const insId = makeNodeId('Ins', boundaryIds);
  boundaryIds.add(insId);
  const outsId = makeNodeId('Outs', boundaryIds);
  const inputs: PortDefinition[] = [];
  const outputs: PortDefinition[] = [];
  const inputBySource = new Map<string, string>();
  const outputBySource = new Map<string, string>();
  const inside: ShaderFlowEdge[] = [];
  const outside: ShaderFlowEdge[] = [];
  const replacements = new Map<string, ShaderFlowEdge>();
  const makeEdge = (link: PatchLink) => edgeFromLink(link, onWeightChange, onModeChange, onInsertNode);
  const portName = (base: string, ports: PortDefinition[]) => {
    const readable = base.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase();
    let name = readable || 'signal';
    let suffix = 2;
    while (ports.some((port) => port.name === name)) name = `${readable} ${suffix++}`;
    return name;
  };
  for (const edge of edges) {
    const link = edgeEndpoints(edge);
    if (!link) continue;
    // A strength input belongs to the same side of a group boundary as its
    // target cable's destination. Boundary links carry the unweighted source;
    // the original mode and strength are applied once at the real destination.
    const sourceInside = selected.has(edge.source);
    const targetInside = selected.has(edge.target);
    let from = link.from;
    if (sourceInside !== targetInside) {
      const key = endpointKey(link.from);
      if (targetInside) {
        let port = inputBySource.get(key);
        if (!port) {
          port = portName(edge.data?.modulatesEdgeId ? 'strength' : link.to.port, inputs);
          inputs.push({ name: port, defaultValue: 0 });
          inputBySource.set(key, port);
          outside.push(makeEdge({ from: link.from, to: { node: groupId, port }, weight: 1, mode: 'set' }));
        }
        from = { node: insId, port };
      } else {
        let port = outputBySource.get(key);
        if (!port) {
          port = portName(link.from.port, outputs);
          outputs.push({ name: port });
          outputBySource.set(key, port);
          inside.push(makeEdge({ from: link.from, to: { node: outsId, port }, weight: 1, mode: 'set' }));
        }
        from = { node: groupId, port };
      }
    }
    const replacement = edge.data?.modulatesEdgeId
      ? { ...edge, source: from.node, sourceHandle: `out:${from.port}`, selected: false }
      : { ...makeEdge({ ...link, from }), selected: false };
    replacements.set(edge.id, replacement);
    (targetInside ? inside : outside).push(replacement);
  }
  const retarget = (edge: ShaderFlowEdge): ShaderFlowEdge => {
    if (!edge.data?.modulatesEdgeId) return edge;
    const parent = replacements.get(edge.data.modulatesEdgeId);
    if (!parent) return edge;
    return { ...edge, target: parent.target, targetHandle: parent.targetHandle,
      data: { ...edge.data, modulatesEdgeId: parent.id } };
  };
  const boundaryNode = (patchNode: PatchNode): ShaderFlowNode => ({
    id: patchNode.id, type: 'shaderNode', position: patchNode.position!,
    data: { patchNode, ...nodeCallbacksPlaceholder(), isTypePickerOpen: false },
  });
  const subpatchNodes = [
    boundaryNode({ id: insId, type: 'Ins', params: Object.fromEntries(inputs.map((port) => [port.name, 0])),
      outputs: inputs, position: { x: bounds.x - 220, y: bounds.y } }),
    ...selectedNodes,
    boundaryNode({ id: outsId, type: 'Outs', params: {}, inputs: outputs,
      position: { x: bounds.x + bounds.width + 220, y: bounds.y } }),
  ];
  const groupNode = boundaryNode({ id: groupId, type: 'Group', subpatchName: groupId,
    subpatchCloneId: makeSubpatchCloneId(groupId), position,
    params: Object.fromEntries(inputs.map((port) => [port.name, 0])), inputs, outputs,
    subpatch: patchFromFlow(subpatchNodes, inside.map(retarget)),
  });
  return {
    nodes: [...nodes.filter((node) => !selected.has(node.id)).map((node) => ({ ...node, selected: false })),
      { ...groupNode, selected: true }],
    edges: dedupeEdges(outside.map(retarget)),
  };
}

function edgeEndpoints(edge: ShaderFlowEdge): PatchLink | null {
  return linkFromEdge(edge.data?.modulatesEdgeId
    ? { ...edge, data: { ...edge.data, modulatesEdgeId: undefined } }
    : edge);
}

function clonePatch(patch: ReturnType<typeof patchFromFlow>): ReturnType<typeof patchFromFlow> {
  return {
    ...(patch.areas ? { areas: structuredClone(patch.areas) } : {}),
    nodes: patch.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      ...(node.customLabel ? { customLabel: node.customLabel } : {}),
      ...(node.subpatchName ? { subpatchName: node.subpatchName } : {}),
      ...(node.subpatchCloneId ? { subpatchCloneId: node.subpatchCloneId } : {}),
      ...(node.subpatchUiOverrides ? { subpatchUiOverrides: structuredClone(node.subpatchUiOverrides) } : {}),
      ...(node.expression !== undefined ? { expression: node.expression } : {}),
      ...(node.sample ? { sample: { ...node.sample } } : {}),
      ...(node.image ? { image: { ...node.image } } : {}),
      ...(node.customWave ? { customWave: normalizeCustomWave(node.customWave, node.params) } : {}),
      params: { ...node.params },
      ...(node.position ? { position: { ...node.position } } : {}),
      ...(node.scale !== undefined ? { scale: node.scale } : {}),
      ...(node.scopeSize ? { scopeSize: { ...node.scopeSize } } : {}),
      ...(node.inputs ? { inputs: node.inputs.map((port) => ({ ...port })) } : {}),
      ...(node.outputs ? { outputs: node.outputs.map((port) => ({ ...port })) } : {}),
      ...(node.subpatch ? { subpatch: clonePatch(node.subpatch) } : {}),
      ...(node.compactPorts !== undefined ? { compactPorts: node.compactPorts } : {}),
      ...(node.enabled === false ? { enabled: false } : {}),
    })),
    links: patch.links.map((link) => ({
      from: { ...link.from },
      to: { ...link.to },
      weight: link.weight,
      mode: link.mode,
      enabled: link.enabled,
      weightModulations: link.weightModulations ? structuredClone(link.weightModulations) : undefined,
    })),
  };
}

function translateExtentForVisibleContent(
  nodes: ShaderFlowNode[],
  viewport: Viewport,
  editorSize: { width: number; height: number },
): CoordinateExtent {
  if (editorSize.width <= 0 || editorSize.height <= 0) {
    return FLOW_INFINITE_EXTENT;
  }

  const bounds = viewportContentBounds(nodes);
  const zoom = normalizedViewportZoom(viewport.zoom);
  const emptyWidth = (editorSize.width / zoom) * MAX_EMPTY_SCREEN_RATIO;
  const emptyHeight = (editorSize.height / zoom) * MAX_EMPTY_SCREEN_RATIO;

  return [
    [bounds.x - emptyWidth, bounds.y - emptyHeight],
    [bounds.x + bounds.width + emptyWidth, bounds.y + bounds.height + emptyHeight],
  ];
}

function clampViewportToTranslateExtent(
  viewport: Viewport,
  translateExtent: CoordinateExtent,
  editorSize: { width: number; height: number },
): Viewport {
  if (editorSize.width <= 0 || editorSize.height <= 0) return viewport;

  const zoom = normalizedViewportZoom(viewport.zoom);
  const visibleWidth = editorSize.width / zoom;
  const visibleHeight = editorSize.height / zoom;
  const left = -viewport.x / zoom;
  const top = -viewport.y / zoom;
  const minLeft = translateExtent[0][0];
  const minTop = translateExtent[0][1];
  const maxLeft = translateExtent[1][0] - visibleWidth;
  const maxTop = translateExtent[1][1] - visibleHeight;
  const clampedLeft = clampNumber(left, Math.min(minLeft, maxLeft), Math.max(minLeft, maxLeft));
  const clampedTop = clampNumber(top, Math.min(minTop, maxTop), Math.max(minTop, maxTop));

  return {
    x: -clampedLeft * zoom,
    y: -clampedTop * zoom,
    zoom,
  };
}

function viewportContentBounds(nodes: ShaderFlowNode[]): { x: number; y: number; width: number; height: number } {
  const visibleNodes = nodes.filter((node) => node.hidden !== true);
  if (visibleNodes.length === 0) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of visibleNodes) {
    const size = viewportNodeSize(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }

  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function resizedPatternScopeSize(patchNode: PatchNode, nextParams: Record<string, number>): ScopeNodeSize | undefined {
  if (patchNode.type === 'Sequencer') {
    const previous = sequencerShape(patchNode.params);
    const next = sequencerShape(nextParams);
    const labelWidth = patchNode.sequencerRowLabelColumnWidth ?? 0;
    const current = clampSequencerNodeSize(patchNode.scopeSize ?? DEFAULT_SEQUENCER_NODE_SIZE, previous.steps, previous.rows, labelWidth);
    const cellWidth = Math.max(SEQUENCER_MIN_CELL_SIZE, (current.width - labelWidth) / previous.steps);
    return clampSequencerNodeSize({ width: labelWidth + next.steps * cellWidth, height: 0 }, next.steps, next.rows, labelWidth);
  }
  if (patchNode.type === 'Roll') {
    const previous = rollShape(patchNode.params);
    const next = rollShape(nextParams);
    const current = clampSequencerNodeSize(
      patchNode.scopeSize ?? { width: previous.steps * 26 + 32, height: previous.rows.length * 22 },
      previous.steps,
      previous.rows.length,
      32,
    );
    const cellWidth = Math.max(SEQUENCER_MIN_CELL_SIZE, (current.width - 32) / previous.steps);
    return clampSequencerNodeSize({ width: 32 + next.steps * cellWidth, height: 0 }, next.steps, next.rows.length, 32);
  }
  return undefined;
}

function viewportNodeSize(node: ShaderFlowNode): { width: number; height: number } {
  const measuredWidth = finitePositiveNumber(node.measured?.width ?? node.width ?? node.initialWidth);
  const measuredHeight = finitePositiveNumber(node.measured?.height ?? node.height ?? node.initialHeight);
  if (measuredWidth !== null && measuredHeight !== null) {
    return { width: measuredWidth, height: measuredHeight };
  }

  const patchNode = node.data.patchNode;
  if (patchNode.type === 'Slider' || patchNode.type === 'Joystick' || patchNode.type === 'Button') {
    const size = clampControlNodeSize(
      patchNode.scopeSize ?? (patchNode.type === 'Joystick' ? DEFAULT_JOYSTICK_NODE_SIZE : DEFAULT_SCOPE_NODE_SIZE),
    );
    return { width: size.width, height: size.height + NODE_HEADER_HEIGHT };
  }

  if (patchNode.type === 'Spread' || patchNode.type === 'Spawn') {
    const size = runtimeContainerSize(patchNode);
    return { width: size.width, height: size.height + NODE_HEADER_HEIGHT };
  }

  if (patchNode.type === 'Scope' || patchNode.type === 'Meter' || patchNode.type === 'FFT') {
    const size = clampScopeNodeSize(
      patchNode.scopeSize ?? (patchNode.type === 'FFT' ? DEFAULT_FFT_NODE_SIZE : DEFAULT_SCOPE_NODE_SIZE),
    );
    return { width: size.width, height: size.height + NODE_HEADER_HEIGHT };
  }

  if (patchNode.type === 'Image') {
    const size = clampImageNodeSize(patchNode.scopeSize ?? DEFAULT_CUSTOM_WAVE_NODE_SIZE, (patchNode.scopeSize?.width ?? DEFAULT_CUSTOM_WAVE_NODE_SIZE.width) / Math.max(1, patchNode.scopeSize?.height ?? DEFAULT_CUSTOM_WAVE_NODE_SIZE.height));
    return { width: size.width, height: size.height + NODE_HEADER_HEIGHT };
  }

  if (patchNode.type === 'CustomWave' || patchNode.type === 'SamplePlayer' || patchNode.type === 'Buffer') {
    const size = clampCustomWaveNodeSize(patchNode.scopeSize ?? DEFAULT_CUSTOM_WAVE_NODE_SIZE);
    return { width: size.width, height: size.height + NODE_HEADER_HEIGHT };
  }

  if (patchNode.type === 'Sequencer') {
    const shape = sequencerShape(patchNode.params);
    const size = clampSequencerNodeSize(
      patchNode.scopeSize ?? DEFAULT_SEQUENCER_NODE_SIZE,
      shape.steps,
      shape.rows,
      patchNode.sequencerRowLabelColumnWidth ?? 0,
    );
    return {
      width: size.width,
      height: NODE_HEADER_HEIGHT + size.height + 92,
    };
  }

  if (patchNode.type === 'Roll') {
    const shape = rollShape(patchNode.params);
    const size = clampSequencerNodeSize(patchNode.scopeSize ?? { width: shape.steps * 26 + 32, height: shape.rows.length * 22 }, shape.steps, shape.rows.length, 32);
    return { width: size.width, height: NODE_HEADER_HEIGHT + size.height + 92 };
  }

  if (patchNode.type === 'Expression') {
    return { width: 240, height: DEFAULT_NODE_BOUNDS_SIZE.height };
  }

  if (patchNode.type === null) {
    return { width: DRAFT_NODE_WIDTH, height: DEFAULT_NODE_BOUNDS_SIZE.height };
  }

  return DEFAULT_NODE_BOUNDS_SIZE;
}

/**
 * Scope rendering is purely visual, so keep its capture work proportional to
 * the part of the graph the user can actually see. A small graph-space margin
 * prevents traces from stopping while a node sits just outside the viewport.
 */
function isNodeVisibleInViewport(
  node: ShaderFlowNode,
  viewport: Viewport,
  editorSize: { width: number; height: number },
): boolean {
  if (editorSize.width <= 0 || editorSize.height <= 0) return true;

  const zoom = normalizedViewportZoom(viewport.zoom);
  const margin = 120 / zoom;
  const left = -viewport.x / zoom - margin;
  const top = -viewport.y / zoom - margin;
  const right = left + editorSize.width / zoom + margin * 2;
  const bottom = top + editorSize.height / zoom + margin * 2;
  const size = viewportNodeSize(node);

  return node.position.x + size.width >= left
    && node.position.x <= right
    && node.position.y + size.height >= top
    && node.position.y <= bottom;
}

function lockedAreaNodeBounds(
  area: EditorArea,
  nodes: ShaderFlowNode[],
): { x: number; y: number; width: number; height: number } | null {
  const containedNodeIds = new Set(area.nodeIds ?? []);
  const containedNodes = nodes.filter((node) => (
    node.id !== area.spreadNodeId
    && containedNodeIds.has(node.id)
  ));
  if (containedNodes.length === 0) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const node of containedNodes) {
    const size = viewportNodeSize(node);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + size.width);
    maxY = Math.max(maxY, node.position.y + size.height);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function flowNodeIsInsideSpread(spread: ShaderFlowNode, node: ShaderFlowNode): boolean {
  if (
    (spread.data.patchNode.type !== 'Spread' && spread.data.patchNode.type !== 'Spawn')
    || node.id === spread.id
  ) return false;
  if (spread.data.patchNode.spreadNodeIds) {
    return spread.data.patchNode.spreadNodeIds.includes(node.id);
  }
  const size = runtimeContainerSize(spread.data.patchNode);
  const portsHeight = runtimeContainerPortsHeight(spread.data.patchNode);
  return (
    node.position.x >= spread.position.x
    && node.position.x < spread.position.x + size.width
    && node.position.y >= spread.position.y + NODE_HEADER_HEIGHT + portsHeight
    && node.position.y < spread.position.y + NODE_HEADER_HEIGHT + size.height
  );
}

function runtimeDspNodeIdForFlowNode(
  node: ShaderFlowNode,
  nodes: ShaderFlowNode[],
  groupIds: readonly string[],
): string {
  const container = nodes.find((candidate) => flowNodeIsInsideSpread(candidate, node));
  const nodeId = container ? spreadCloneNodeId(container.id, 0, node.id) : node.id;
  return scopedDspNodeId(nodeId, groupIds);
}

function runtimeContainerLinkIsAllowed(link: PatchLink, nodes: ShaderFlowNode[]): boolean {
  const sourceNode = nodes.find((node) => node.id === link.from.node);
  const targetNode = nodes.find((node) => node.id === link.to.node);

  if (
    (
      (sourceNode?.data.patchNode.type === 'Spread' && link.from.port === 'item index')
      || (sourceNode?.data.patchNode.type === 'Spawn' && link.from.port === 'instance gate')
    )
    && (!targetNode || !flowNodeIsInsideSpread(sourceNode, targetNode))
  ) {
    return false;
  }
  if (
    targetNode?.data.patchNode.type === 'Spawn'
    && link.to.port === 'kill trigger'
    && (!sourceNode || !flowNodeIsInsideSpread(targetNode, sourceNode))
  ) {
    return false;
  }
  if (
    targetNode
    && sourceNode
    && (
      (targetNode.data.patchNode.type === 'Spread' && link.to.port === 'count')
      || (
        targetNode.data.patchNode.type === 'Spawn'
        && (link.to.port === 'trigger' || link.to.port === 'release trigger')
      )
    )
    && flowNodeIsInsideSpread(targetNode, sourceNode)
  ) {
    return false;
  }
  return true;
}

function normalizedViewportZoom(zoom: number): number {
  return finitePositiveNumber(zoom) ?? USER_ZOOM_BASELINE;
}

function shouldSettleZoomToBaseline(zoom: number): boolean {
  const normalizedZoom = normalizedViewportZoom(zoom);
  const distance = Math.abs(normalizedZoom - ZOOM_RESET_TARGET);
  return distance > ZOOM_CHANGE_EPSILON && distance <= ZOOM_SETTLE_THRESHOLD;
}

function formatZoomPercentage(zoom: number): string {
  return `${Math.round((zoom / USER_ZOOM_BASELINE) * 100)}%`;
}

function finitePositiveNumber(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
}

function isFiniteCoordinateExtent(extent: CoordinateExtent): boolean {
  return extent.every((point) => point.every(Number.isFinite));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function nodeBounds(nodes: ShaderFlowNode[]): { x: number; y: number; width: number; height: number } {
  const xs = nodes.map((node) => node.position.x);
  const ys = nodes.map((node) => node.position.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

function connectedAreaIds(areas: EditorArea[], rootId: string): Set<string> {
  const root = areas.find((area) => area.id === rootId);
  if (!root) return new Set();

  const connected = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of areas) {
      if (connected.has(candidate.id)) continue;
      if (!areas.some((area) => connected.has(area.id) && areaContainsArea(area, candidate))) continue;
      connected.add(candidate.id);
      changed = true;
    }
  }
  return connected;
}

function nodeIdsContainedByAreaHierarchy(
  areas: EditorArea[],
  nodes: ShaderFlowNode[],
  rootId: string,
): Set<string> {
  const containedAreaIds = connectedAreaIds(areas, rootId);
  const containedAreas = areas.filter((area) => containedAreaIds.has(area.id));
  return new Set(nodes.flatMap((node) => (
    containedAreas.some((area) => (
      areaContainsNode(area, node) || area.spreadNodeId === node.id
    ))
      ? [node.id]
      : []
  )));
}

function promoteNodeIdsInStackOrder(
  stackOrder: string[],
  activeNodeIds: string[],
  promotedNodeIds: Set<string>,
): string[] {
  const activeNodeIdSet = new Set(activeNodeIds);
  const orderedActiveIds = stackOrder.filter((nodeId) => activeNodeIdSet.has(nodeId));
  const orderedActiveIdSet = new Set(orderedActiveIds);
  const completeOrder = [
    ...orderedActiveIds,
    ...activeNodeIds.filter((nodeId) => !orderedActiveIdSet.has(nodeId)),
  ];
  const nextOrder = [
    ...completeOrder.filter((nodeId) => !promotedNodeIds.has(nodeId)),
    ...completeOrder.filter((nodeId) => promotedNodeIds.has(nodeId)),
  ];

  return nextOrder.length === stackOrder.length
    && nextOrder.every((nodeId, index) => nodeId === stackOrder[index])
    ? stackOrder
    : nextOrder;
}

function spreadAreaForNode(node: ShaderFlowNode): EditorArea {
  const size = runtimeContainerSize(node.data.patchNode);
  const portsHeight = runtimeContainerPortsHeight(node.data.patchNode);
  const title = node.data.patchNode.type === 'Spawn' ? 'Spawn' : 'Spread';
  return {
    id: `spread-area:${node.id}`,
    kind: 'spread',
    spreadNodeId: node.id,
    title,
    position: { ...node.position },
    size: {
      width: size.width,
      height: Math.max(NODE_HEADER_HEIGHT + portsHeight + 48, NODE_HEADER_HEIGHT + size.height),
    },
    uiHeight: portsHeight,
    ...(node.data.patchNode.spreadNodeIds ? {
      locked: true,
      nodeIds: [...node.data.patchNode.spreadNodeIds],
    } : {}),
  };
}

function reconcileSpreadAreas(areas: EditorArea[], nodes: ShaderFlowNode[]): EditorArea[] {
  const spreadNodes = nodes.filter((node) => (
    node.data.patchNode.type === 'Spread' || node.data.patchNode.type === 'Spawn'
  ));
  const spreadNodeIds = new Set(spreadNodes.map((node) => node.id));
  let resizedExistingSpawn = false;
  const retained = areas.flatMap((area) => {
    if (area.kind !== 'spread') return [area];
    if (area.spreadNodeId === undefined || !spreadNodeIds.has(area.spreadNodeId)) return [];
    const spawnNode = spreadNodes.find((node) => (
      node.id === area.spreadNodeId && node.data.patchNode.type === 'Spawn'
    ));
    if (
      !spawnNode
      || (area.size.width >= MIN_SPAWN_WIDTH && (area.uiHeight ?? 0) >= SPAWN_PORTS_HEIGHT)
    ) return [area];
    resizedExistingSpawn = true;
    return [{
      ...area,
      size: { ...area.size, width: Math.max(area.size.width, MIN_SPAWN_WIDTH) },
      uiHeight: Math.max(area.uiHeight ?? 0, SPAWN_PORTS_HEIGHT),
    }];
  });
  const existingSpreadNodeIds = new Set(retained.flatMap((area) => (
    area.kind === 'spread' && area.spreadNodeId ? [area.spreadNodeId] : []
  )));
  const added = spreadNodes
    .filter((node) => !existingSpreadNodeIds.has(node.id))
    .map(spreadAreaForNode);
  return retained.length === areas.length && added.length === 0 && !resizedExistingSpawn
    ? areas
    : [...retained, ...added];
}

function optionalStringArraysEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function areaContainsPoint(area: EditorArea, point: { x: number; y: number }): boolean {
  return point.x >= area.position.x
    && point.x < area.position.x + area.size.width
    && point.y >= area.position.y
    && point.y < area.position.y + area.size.height;
}

function areaContainsArea(area: EditorArea, candidate: EditorArea): boolean {
  if (area.id === candidate.id) return false;
  // Once locked, the saved membership is authoritative. Geometry must never
  // allow a container dragged across unrelated content to absorb it.
  return area.locked
    ? area.areaIds?.includes(candidate.id) === true
    : areaContainsPoint(area, candidate.position);
}

function areaIdsWithinBounds(areas: EditorArea[], area: EditorArea): string[] {
  return areas
    .filter((candidate) => candidate.id !== area.id && areaContainsPoint(area, candidate.position))
    .map((candidate) => candidate.id);
}

function isSurfacedControlTarget(eventTarget: EventTarget | null): boolean {
  const target = eventTarget instanceof Element ? eventTarget : null;
  return target !== null
    && target.closest('.shader-node-area-ui-collapsed, .group-ui-preview') !== null;
}

function innermostAreaContainingNode(areas: EditorArea[], node: ShaderFlowNode): EditorArea | undefined {
  return areas
    .filter((area) => area.spreadNodeId === node.id || areaContainsNode(area, node))
    .sort((left, right) => (left.size.width * left.size.height) - (right.size.width * right.size.height))[0];
}

function areaContainsNode(area: EditorArea, node: ShaderFlowNode): boolean {
  // Locked membership is an explicit snapshot, including an explicitly empty
  // one. Never fall back to overlap for a locked Area, Spread, or Spawn.
  return area.locked
    ? area.nodeIds?.includes(node.id) === true
    : areaContainsPoint(area, node.position);
}

function nodeIsInAreaUiSection(area: EditorArea, node: ShaderFlowNode): boolean {
  return area.uiHeight !== undefined
    && node.position.x >= area.position.x
    && node.position.x < area.position.x + area.size.width
    && node.position.y >= area.position.y + NODE_HEADER_HEIGHT
    && node.position.y < area.position.y + NODE_HEADER_HEIGHT + area.uiHeight;
}

function groupUiPreviewLayout(patch: Patch): {
  position: { x: number; y: number };
  size: { width: number; height: number };
  nodes: PatchNode[];
} | null {
  const controlAreas = (patch.areas ?? []).filter((area) => {
    const title = area.title.trim().toLocaleLowerCase();
    return area.kind !== 'spread' && (title === 'ui' || title === 'controls');
  });
  if (controlAreas.length === 0) return null;

  const left = Math.min(...controlAreas.map((area) => area.position.x));
  const contentTop = Math.min(...controlAreas.map((area) => area.position.y + NODE_HEADER_HEIGHT));
  const right = Math.max(...controlAreas.map((area) => area.position.x + area.size.width));
  const bottom = Math.max(...controlAreas.map((area) => area.position.y + area.size.height));
  const nodeIds = new Set<string>();
  for (const area of controlAreas) {
    if (area.locked) {
      for (const nodeId of area.nodeIds ?? []) nodeIds.add(nodeId);
      continue;
    }
    for (const node of patch.nodes) {
      const position = node.position ?? { x: 0, y: 0 };
      if (
        position.x >= area.position.x
        && position.x < area.position.x + area.size.width
        && position.y >= area.position.y
        && position.y < area.position.y + area.size.height
      ) nodeIds.add(node.id);
    }
  }
  const nodes = patch.nodes.filter((node) => nodeIds.has(node.id));
  // A UI-area member can overlap its source area's header. The projected panel
  // normally begins below that header, so account for that overlap instead of
  // clipping the projected node's own header with the panel's overflow.
  const top = Math.min(
    contentTop,
    ...nodes.map((node) => node.position?.y ?? contentTop),
  );
  return {
    position: { x: left, y: top },
    size: { width: right - left, height: bottom - top },
    nodes,
  };
}

function collapsedAreaInputPin(area: EditorArea): { x: number; y: number } {
  return { x: area.position.x, y: area.position.y + NODE_HEADER_HEIGHT / 2 };
}

function collapsedAreaOutputPin(area: EditorArea): { x: number; y: number } {
  return { x: area.position.x + area.size.width, y: area.position.y + NODE_HEADER_HEIGHT / 2 };
}

function endpointKey(endpoint: PatchLink['from']): string {
  return `${endpoint.node}.${endpoint.port}`;
}

function canRenameBoundaryPort(node: PatchNode, side: 'input' | 'output'): boolean {
  return ((node.type === 'Ins' || node.type === 'Params') && side === 'output') || (node.type === 'Outs' && side === 'input');
}

function renamePortDefinitions(
  ports: PortDefinition[] | undefined,
  previousPort: string,
  nextPort: string,
): PortDefinition[] | undefined {
  return ports?.map((port) => port.name === previousPort ? { ...port, name: nextPort } : port);
}

function setPortDefaultValue(
  ports: PortDefinition[] | undefined,
  portName: string,
  value: number,
): PortDefinition[] | undefined {
  return ports?.map((port) => port.name === portName ? { ...port, defaultValue: value } : port);
}

function movePortDefinitions(
  ports: PortDefinition[] | undefined,
  portName: string,
  direction: -1 | 1,
): PortDefinition[] | undefined {
  if (!ports) return ports;

  const fromIndex = ports.findIndex((port) => port.name === portName);
  const toIndex = fromIndex + direction;
  if (fromIndex < 0 || toIndex < 0 || toIndex >= ports.length) return ports;

  const nextPorts = ports.map((port) => ({ ...port }));
  [nextPorts[fromIndex], nextPorts[toIndex]] = [nextPorts[toIndex], nextPorts[fromIndex]];
  return nextPorts;
}

function renameParamKey(params: Record<string, number>, previousKey: string, nextKey: string): Record<string, number> {
  if (previousKey === nextKey || params[previousKey] === undefined) return params;

  const nextParams = { ...params, [nextKey]: params[previousKey] };
  delete nextParams[previousKey];
  return nextParams;
}

function removeParamKey(params: Record<string, number>, key: string): Record<string, number> {
  if (params[key] === undefined) return params;

  const nextParams = { ...params };
  delete nextParams[key];
  return nextParams;
}

function boundaryPortHasDefaultValue(node: PatchNode, side: 'input' | 'output'): boolean {
  return (node.type === 'Ins' || node.type === 'Params') && side === 'output';
}

function nextBoundaryPortParams(
  node: PatchNode,
  side: 'input' | 'output',
  previousPort: string,
  nextPort: string,
): Record<string, number> {
  if (boundaryPortHasDefaultValue(node, side)) {
    return renameParamKey(node.params, previousPort, nextPort);
  }

  if (node.type === 'Outs' && side === 'input') {
    return removeParamKey(node.params, previousPort);
  }

  return node.params;
}

function renameEdgePort(
  edge: ShaderFlowEdge,
  nodeId: string,
  side: 'input' | 'output',
  previousPort: string,
  nextPort: string,
): ShaderFlowEdge {
  if (edge.data?.modulatesEdgeId) {
    if (side === 'output' && edge.source === nodeId && edge.sourceHandle === `out:${previousPort}`) {
      return { ...edge, sourceHandle: `out:${nextPort}` };
    }
    if (side === 'input' && edge.target === nodeId && edge.targetHandle === `in:${previousPort}`) {
      return { ...edge, targetHandle: `in:${nextPort}` };
    }
    return edge;
  }
  const link = linkFromEdge(edge);
  if (!link) return edge;
  const weightModulations = side === 'output'
    ? link.weightModulations?.map((modulation) => modulation.from.node === nodeId && modulation.from.port === previousPort
      ? { ...modulation, from: { node: nodeId, port: nextPort } }
      : modulation)
    : link.weightModulations;

  if (side === 'input' && link.to.node === nodeId && link.to.port === previousPort) {
    return {
      ...edgeFromLink({ from: link.from, to: { node: nodeId, port: nextPort }, weight: link.weight, mode: link.mode, enabled: link.enabled, weightModulations }, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder),
      selected: edge.selected,
    };
  }

  if (side === 'output' && link.from.node === nodeId && link.from.port === previousPort) {
    return {
      ...edgeFromLink({ from: { node: nodeId, port: nextPort }, to: link.to, weight: link.weight, mode: link.mode, enabled: link.enabled, weightModulations }, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder),
      selected: edge.selected,
    };
  }

  if (weightModulations !== link.weightModulations && weightModulations?.some((modulation, index) => modulation !== link.weightModulations?.[index])) {
    return {
      ...edgeFromLink({ ...link, weightModulations }, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder),
      selected: edge.selected,
    };
  }

  return edge;
}

function normalizePortName(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[-_]+|[-_]+$/g, '');
}

function uniqueBoundaryPortName(requestedPort: string, currentPort: string, ports: string[], preserveText = false): string | null {
  const normalized = preserveText ? requestedPort.trim().replace(/[\u0000-\u001f\u007f-\u009f]/gu, '') : normalizePortName(requestedPort);
  if (!normalized) return null;
  if (normalized === currentPort) return currentPort;

  const usedNames = new Set(ports);
  usedNames.delete(currentPort);
  return uniquePortName(normalized, usedNames);
}

function uniquePortName(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) return baseName;

  let index = 2;
  let candidate = `${baseName}_${index}`;
  while (usedNames.has(candidate)) {
    index += 1;
    candidate = `${baseName}_${index}`;
  }
  return candidate;
}

function isSelectorValuePortName(name: string): boolean {
  return /^[1-9][0-9]*$/.test(name);
}

function selectorValueInputs(inputs: PortDefinition[]): PortDefinition[] {
  return inputs.filter((input) => isSelectorValuePortName(input.name));
}

function selectorPortMapAfterRemoval(orderedPorts: string[], removedIndex: number): Map<string, string> {
  const portMap = new Map<string, string>();
  orderedPorts
    .filter((port) => Number(port) !== removedIndex)
    .forEach((port, nextIndex) => {
      portMap.set(port, String(nextIndex + 1));
    });
  return portMap;
}

function remapSelectorParamsAfterRemoval(
  params: Record<string, number>,
  valuePorts: string[],
  portMap: Map<string, string>,
  removedIndex: number,
): Record<string, number> {
  const nextParams = { ...params };
  for (const port of valuePorts) {
    delete nextParams[port];
  }
  for (const [previousPort, nextPort] of portMap.entries()) {
    nextParams[nextPort] = params[previousPort] ?? 0;
  }

  const nextInputCount = portMap.size;
  const rawSelect = Number(params.select ?? 0);
  const currentSelect = Number.isFinite(rawSelect) ? rawSelect : 0;
  const shiftedSelect = currentSelect > removedIndex ? currentSelect - 1 : currentSelect;
  nextParams.select = Math.min(Math.max(shiftedSelect, 0), nextInputCount);
  return nextParams;
}

function remapSelectorEdgeAfterRemoval(
  edge: ShaderFlowEdge,
  nodeId: string,
  portMap: Map<string, string>,
  removedIndex: number,
): ShaderFlowEdge[] {
  const link = linkFromEdge(edge);
  if (!link || link.to.node !== nodeId || !isSelectorValuePortName(link.to.port)) return [edge];
  if (Number(link.to.port) === removedIndex) return [];

  const nextPort = portMap.get(link.to.port);
  if (nextPort === undefined || nextPort === link.to.port) return [edge];

  return [{
    ...edgeFromLink(
      { from: link.from, to: { node: nodeId, port: nextPort }, weight: link.weight, mode: link.mode, enabled: link.enabled, weightModulations: link.weightModulations },
      updateEdgeWeightPlaceholder,
      updateEdgeModePlaceholder,
      insertNodeOnEdgePlaceholder,
    ),
    selected: edge.selected,
  }];
}

function selectorIndexFromKeyboardEvent(event: KeyboardEvent): number | null {
  if (!/^[1-9]$/.test(event.key)) return null;
  return Number(event.key);
}

function normalizeSubpatchName(requestedName: string, fallback: string): string {
  const trimmed = requestedName.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function makeSubpatchCloneId(seed: string): string {
  subpatchCloneSequence += 1;
  const normalizedSeed = seed.replace(/[^A-Za-z0-9_-]/g, '_') || 'group';
  return `subpatch_clone_${normalizedSeed}_${subpatchCloneSequence}`;
}

function dedupePatchLinks(links: PatchLink[]): PatchLink[] {
  const seen = new Set<string>();
  const deduped: PatchLink[] = [];
  for (const link of links) {
    const key = `${link.from.node}:${link.from.port}->${link.to.node}:${link.to.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(link);
  }
  return deduped;
}

function cloneFlowNodeSnapshot(node: ShaderFlowNode): ShaderFlowNode {
  const position = { ...node.position };

  return {
    ...node,
    position,
    data: {
      ...node.data,
      patchNode: {
        ...node.data.patchNode,
        params: { ...node.data.patchNode.params },
        position,
        ...(node.data.patchNode.inputs ? { inputs: node.data.patchNode.inputs.map((port) => ({ ...port })) } : {}),
        ...(node.data.patchNode.outputs ? { outputs: node.data.patchNode.outputs.map((port) => ({ ...port })) } : {}),
        ...(node.data.patchNode.subpatchUiOverrides
          ? { subpatchUiOverrides: structuredClone(node.data.patchNode.subpatchUiOverrides) }
          : {}),
        ...(node.data.patchNode.subpatch ? { subpatch: clonePatch(node.data.patchNode.subpatch) } : {}),
      },
    },
  };
}

function cloneFlowEdgeSnapshot(edge: ShaderFlowEdge): ShaderFlowEdge {
  return {
    ...edge,
    data: {
      ...edge.data,
      weight: edge.data?.weight ?? 1,
      mode: edge.data?.mode ?? 'set',
      enabled: edge.data?.enabled !== false,
      onWeightChange: updateEdgeWeightPlaceholder,
      onModeChange: updateEdgeModePlaceholder,
      onInsertNode: insertNodeOnEdgePlaceholder,
    },
  };
}

function reconnectPreviewEdgeFromEdge(edge: ShaderFlowEdge): ShaderFlowEdge {
  const snapshot = cloneFlowEdgeSnapshot(edge);
  return {
    ...snapshot,
    id: `reconnect-preview:${snapshot.id}`,
    selected: false,
    selectable: false,
    deletable: false,
    reconnectable: false,
    zIndex: SELECTED_EDGE_Z_INDEX - 1,
    data: {
      ...snapshot.data,
      weight: snapshot.data?.weight ?? 1,
      mode: snapshot.data?.mode ?? 'set',
      enabled: snapshot.data?.enabled !== false,
      onWeightChange: snapshot.data?.onWeightChange ?? updateEdgeWeightPlaceholder,
      onModeChange: snapshot.data?.onModeChange ?? updateEdgeModePlaceholder,
      onInsertNode: snapshot.data?.onInsertNode ?? insertNodeOnEdgePlaceholder,
      showLinkControls: false,
    },
  };
}

function syncDuplicateDragPositions(
  state: DuplicateDragState | null,
  dragNodes: ShaderFlowNode[],
): DuplicateDragState | null {
  if (!state || dragNodes.length === 0) return state;

  const sourceIds = state.nodeIds;
  let changed = false;
  const currentPositions = { ...state.currentPositions };

  for (const node of dragNodes) {
    if (!sourceIds.has(node.id)) continue;
    const previous = currentPositions[node.id];
    if (previous && previous.x === node.position.x && previous.y === node.position.y) continue;

    currentPositions[node.id] = { ...node.position };
    changed = true;
  }

  return changed ? { ...state, currentPositions } : state;
}

function syncDuplicateDragPositionsFromChanges(
  state: DuplicateDragState,
  changes: NodeChange<ShaderFlowNode>[],
): DuplicateDragState {
  let changed = false;
  const currentPositions = { ...state.currentPositions };

  for (const change of changes) {
    if (change.type !== 'position' || !change.position || !state.nodeIds.has(change.id)) continue;

    const previous = currentPositions[change.id];
    if (previous && previous.x === change.position.x && previous.y === change.position.y) continue;

    currentPositions[change.id] = { ...change.position };
    changed = true;
  }

  return changed ? { ...state, currentPositions } : state;
}

function anchorDuplicatedNodePositionChanges(
  changes: NodeChange<ShaderFlowNode>[],
  originalPositions: Record<string, { x: number; y: number }>,
): NodeChange<ShaderFlowNode>[] {
  return changes.map((change) => {
    if (change.type !== 'position') return change;
    const position = originalPositions[change.id];
    if (!position) return change;

    return {
      ...change,
      position: { ...position },
      positionAbsolute: { ...position },
    };
  });
}

function restoreGraphNodePositions(
  nodes: ShaderFlowNode[],
  positions: Record<string, { x: number; y: number }>,
): ShaderFlowNode[] {
  return applyGraphNodePositions(nodes, positions);
}

function applyGraphNodePositions(
  nodes: ShaderFlowNode[],
  positions: Record<string, { x: number; y: number }>,
): ShaderFlowNode[] {
  return nodes.map((node) => {
    const position = positions[node.id];
    if (!position) return node;

    return {
      ...node,
      position: { ...position },
      data: {
        ...node.data,
        patchNode: {
          ...node.data.patchNode,
          position: { ...position },
        },
      },
    };
  });
}

function duplicatePreviewNodeId(nodeId: string): string {
  return `${DUPLICATE_NODE_PREVIEW_PREFIX}${nodeId}`;
}

function draftNodePosition(
  connection: DraftNodeConnection,
  reactFlow: ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge>,
): { x: number; y: number } {
  const pointer = reactFlow.screenToFlowPosition(connection.pointer);
  const x = connection.originHandleType === 'source'
    ? pointer.x + DRAFT_NODE_HANDLE_X_OFFSET
    : pointer.x - DRAFT_NODE_WIDTH - DRAFT_NODE_HANDLE_X_OFFSET;

  return {
    x,
    y: pointer.y - DRAFT_NODE_FIRST_PORT_Y,
  };
}

function duplicateAreaHierarchy(
  areas: EditorArea[],
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  dragState: AreaDragState,
  onWeightChange: (edgeId: string, weight: number) => void,
  onModeChange: (edgeId: string, mode: LinkMode) => void,
  onInsertNode: (edgeId: string) => void,
): { rootAreaId: string; areas: EditorArea[]; nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } {
  const sourceAreaIds = new Set(Object.keys(dragState.areaPositions));
  const sourceNodeIds = new Set(Object.keys(dragState.nodePositions));
  const existingNodeIds = new Set(nodes.map((node) => node.id));
  const existingAreaIds = new Set(areas.map((area) => area.id));
  const nodeIdMap = new Map<string, string>();
  const areaIdMap = new Map<string, string>();

  for (const node of nodes) {
    if (!sourceNodeIds.has(node.id)) continue;
    const nextId = makeNodeId(node.data.patchNode.type ?? 'node', existingNodeIds);
    existingNodeIds.add(nextId);
    nodeIdMap.set(node.id, nextId);
  }
  for (const area of areas) {
    if (!sourceAreaIds.has(area.id)) continue;
    let nextId = `area-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    while (existingAreaIds.has(nextId)) {
      nextId = `area-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    }
    existingAreaIds.add(nextId);
    areaIdMap.set(area.id, nextId);
  }

  const duplicatedNodes = nodes.flatMap((node): ShaderFlowNode[] => {
    const nextId = nodeIdMap.get(node.id);
    if (!nextId) return [];
    const position = dragState.currentNodePositions[node.id] ?? node.position;
    const patchNode = cloneParameterIds(node.data.patchNode, nextId);
    return [{
      ...node,
      id: nextId,
      position,
      selected: false,
      data: {
        ...node.data,
        patchNode: {
          ...patchNode,
          id: nextId,
          position,
          ...(patchNode.spreadNodeIds ? {
            spreadNodeIds: patchNode.spreadNodeIds.flatMap((nodeId) => {
              const mapped = nodeIdMap.get(nodeId);
              return mapped ? [mapped] : [];
            }),
          } : {}),
        },
        isTypePickerOpen: false,
      },
    }];
  });

  const duplicatedAreas = areas.flatMap((area): EditorArea[] => {
    const nextId = areaIdMap.get(area.id);
    if (!nextId) return [];
    const spreadNodeId = area.spreadNodeId ? nodeIdMap.get(area.spreadNodeId) : undefined;
    return [{
      ...structuredClone(area),
      id: nextId,
      position: dragState.currentAreaPositions[area.id] ?? area.position,
      ...(spreadNodeId ? { spreadNodeId } : {}),
      ...(area.nodeIds ? {
        nodeIds: area.nodeIds.flatMap((nodeId) => {
          const mapped = nodeIdMap.get(nodeId);
          return mapped ? [mapped] : [];
        }),
      } : {}),
      ...(area.areaIds ? {
        areaIds: area.areaIds.flatMap((areaId) => {
          const mapped = areaIdMap.get(areaId);
          return mapped ? [mapped] : [];
        }),
      } : {}),
    }];
  });

  const duplicatedEdges = duplicateEdgesForNodes(edges, nodeIdMap, dragState.linkExternal, onWeightChange, onModeChange, onInsertNode);

  return {
    rootAreaId: areaIdMap.get(dragState.areaId) ?? dragState.areaId,
    areas: duplicatedAreas,
    nodes: duplicatedNodes,
    edges: duplicatedEdges,
  };
}

function duplicateDraggedGraph(
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  dragState: DuplicateDragState,
  draggedPositions: Record<string, { x: number; y: number }>,
  onWeightChange: (edgeId: string, weight: number) => void,
  onModeChange: (edgeId: string, mode: LinkMode) => void,
  onInsertNode: (edgeId: string) => void,
): { nodes: ShaderFlowNode[]; edges: ShaderFlowEdge[] } {
  const existingIds = new Set(nodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  const selectedNodes = nodes.filter((node) => dragState.nodeIds.has(node.id));

  const duplicatedNodes = selectedNodes.map((node) => {
    const nextId = makeNodeId(node.data.patchNode.type ?? 'node', existingIds);
    existingIds.add(nextId);
    idMap.set(node.id, nextId);
    const position = draggedPositions[node.id] ?? node.position;

    return {
      ...node,
      id: nextId,
      selected: true,
      position,
      data: {
        ...node.data,
        patchNode: {
          ...cloneParameterIds(node.data.patchNode, nextId),
          id: nextId,
          params: { ...node.data.patchNode.params },
          position,
        },
        isTypePickerOpen: false,
      },
    };
  });

  const duplicatedEdges = duplicateEdgesForNodes(edges, idMap, dragState.linkExternal, onWeightChange, onModeChange, onInsertNode);

  return {
    nodes: duplicatedNodes,
    edges: duplicatedEdges,
  };
}

function buildBridgeEdges(
  nodes: ShaderFlowNode[],
  edges: ShaderFlowEdge[],
  selectedNodeIds: Set<string>,
  onWeightChange: (edgeId: string, weight: number) => void,
  onModeChange: (edgeId: string, mode: LinkMode) => void,
  onInsertNode: (edgeId: string) => void,
): ShaderFlowEdge[] {
  return nodes.flatMap((node) => {
    if (!selectedNodeIds.has(node.id)) return [];

    const incoming = edges
      .map(linkFromEdge)
      .filter((link): link is PatchLink => {
        if (!link) return false;
        return link.to.node === node.id && !selectedNodeIds.has(link.from.node);
      });
    const outgoing = edges
      .map(linkFromEdge)
      .filter((link): link is PatchLink => {
        if (!link) return false;
        return link.from.node === node.id && !selectedNodeIds.has(link.to.node);
      });

    return incoming.flatMap((input) => outgoing.map((output) => edgeFromLink({
      from: input.from,
      to: output.to,
      weight: output.weight,
      mode: output.mode,
      enabled: input.enabled !== false && output.enabled !== false,
    }, onWeightChange, onModeChange, onInsertNode)));
  });
}

function selectedGraphFromNodes(nodes: ShaderFlowNode[], edges: ShaderFlowEdge[]): CopiedGraph | null {
  const selectedNodeIds = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
  if (selectedNodeIds.size === 0) return null;

  const includedEdgeIds = new Set(edges.flatMap((edge) => {
    const link = linkFromEdge(edge);
    return link && selectedNodeIds.has(link.from.node) && selectedNodeIds.has(link.to.node) ? [edge.id] : [];
  }));
  let previousSize = -1;
  while (previousSize !== includedEdgeIds.size) {
    previousSize = includedEdgeIds.size;
    for (const edge of edges) {
      if (edge.data?.modulatesEdgeId && selectedNodeIds.has(edge.source) && includedEdgeIds.has(edge.data.modulatesEdgeId)) {
        includedEdgeIds.add(edge.id);
      }
    }
  }

  return {
    nodes: nodes.filter((node) => selectedNodeIds.has(node.id)).map(cloneFlowNodeForClipboard),
    edges: edges.filter((edge) => includedEdgeIds.has(edge.id)).map(cloneFlowEdgeForClipboard),
  };
}

function duplicateCopiedGraph(
  graph: CopiedGraph,
  existingNodes: ShaderFlowNode[],
  offset: { x: number; y: number },
  onWeightChange: (edgeId: string, weight: number) => void,
  onModeChange: (edgeId: string, mode: LinkMode) => void,
  onInsertNode: (edgeId: string) => void,
): CopiedGraph {
  const existingIds = new Set(existingNodes.map((node) => node.id));
  const idMap = new Map<string, string>();
  const nodes = graph.nodes.map((node) => {
    const nextId = makeNodeId(node.data.patchNode.type ?? 'node', existingIds);
    existingIds.add(nextId);
    idMap.set(node.id, nextId);
    const position = {
      x: node.position.x + offset.x,
      y: node.position.y + offset.y,
    };

    return {
      ...node,
      id: nextId,
      position,
      selected: true,
      data: {
        ...node.data,
        patchNode: {
          ...cloneParameterIds(node.data.patchNode, nextId),
          id: nextId,
          params: { ...node.data.patchNode.params },
          position,
        },
        isTypePickerOpen: false,
      },
    };
  });

  const edges = duplicateEdgesForNodes(graph.edges, idMap, false, onWeightChange, onModeChange, onInsertNode);
  return { nodes, edges };
}

function duplicateEdgesForNodes(
  edges: ShaderFlowEdge[],
  nodeIds: Map<string, string>,
  linkExternal: boolean,
  onWeightChange: NonNullable<ShaderFlowEdge['data']>['onWeightChange'],
  onModeChange: NonNullable<ShaderFlowEdge['data']>['onModeChange'],
  onInsertNode: NonNullable<ShaderFlowEdge['data']>['onInsertNode'],
): ShaderFlowEdge[] {
  const copies = new Map<string, ShaderFlowEdge | null>();
  const byId = new Map(edges.map((edge) => [edge.id, edge]));
  const copy = (edge: ShaderFlowEdge, visited = new Set<string>()): ShaderFlowEdge | null => {
    if (copies.has(edge.id)) return copies.get(edge.id) ?? null;
    if (visited.has(edge.id)) return null;
    const source = nodeIds.get(edge.source);
    let result: ShaderFlowEdge | null = null;
    if (edge.data?.modulatesEdgeId) {
      const parent = byId.get(edge.data.modulatesEdgeId);
      const parentCopy = parent ? copy(parent, new Set([...visited, edge.id])) : null;
      const target = parentCopy ?? (linkExternal ? parent : undefined);
      if (target && (source || (linkExternal && parentCopy))) {
        result = { ...edge, id: `weight-modulation:${crypto.randomUUID()}`, source: source ?? edge.source,
          target: target.target, targetHandle: target.targetHandle, selected: false,
          data: { ...edge.data, modulatesEdgeId: target.id, onWeightChange, onModeChange, onInsertNode } };
      }
    } else {
      const link = linkFromEdge(edge);
      const target = nodeIds.get(edge.target);
      if (link && (source || target) && (linkExternal || (source && target))) {
        result = edgeFromLink({ ...link,
          from: { ...link.from, node: source ?? link.from.node },
          to: { ...link.to, node: target ?? link.to.node },
        }, onWeightChange, onModeChange, onInsertNode);
      }
    }
    copies.set(edge.id, result);
    return result;
  };
  return edges.flatMap((edge) => { const result = copy(edge); return result ? [result] : []; });
}

function duplicatedBufferCopies(
  sourceNodes: ShaderFlowNode[],
  targetNodes: ShaderFlowNode[],
  sourceGraphNodes: ShaderFlowNode[],
  targetGraphNodes: ShaderFlowNode[],
  groupIds: readonly string[],
): BufferCopy[] {
  return sourceNodes.flatMap((sourceNode, index) => {
    const targetNode = targetNodes[index];
    if (sourceNode.data.patchNode.type !== 'Buffer' || targetNode?.data.patchNode.type !== 'Buffer') return [];
    return [{
      sourceNodeId: runtimeDspNodeIdForFlowNode(sourceNode, sourceGraphNodes, groupIds),
      targetNodeId: runtimeDspNodeIdForFlowNode(targetNode, targetGraphNodes, groupIds),
    }];
  });
}

function copyBufferAssets(
  copies: BufferCopy[],
  currentAssets: Record<string, BufferAsset>,
  replaceAssets: (assets: Record<string, BufferAsset>) => void,
): void {
  const copiedAssets = copies.flatMap(({ sourceNodeId, targetNodeId }) => {
    const asset = currentAssets[sourceNodeId];
    return asset ? [[targetNodeId, asset] as const] : [];
  });
  if (copiedAssets.length === 0) return;
  replaceAssets({ ...currentAssets, ...Object.fromEntries(copiedAssets) });
}

function cloneFlowNodeForClipboard(node: ShaderFlowNode): ShaderFlowNode {
  return {
    ...node,
    selected: false,
    data: {
      ...node.data,
      patchNode: {
        ...node.data.patchNode,
        params: { ...node.data.patchNode.params },
        position: { ...node.position },
      },
      isTypePickerOpen: false,
    },
  };
}

function cloneFlowEdgeForClipboard(edge: ShaderFlowEdge): ShaderFlowEdge {
  return {
    ...edge,
    selected: false,
    data: {
      weight: edge.data?.weight ?? 1,
      mode: edge.data?.mode ?? 'set',
      enabled: edge.data?.enabled !== false,
      modulatesEdgeId: edge.data?.modulatesEdgeId,
      onWeightChange: updateEdgeWeightPlaceholder,
      onModeChange: updateEdgeModePlaceholder,
      onInsertNode: insertNodeOnEdgePlaceholder,
    },
  };
}

async function writeCopiedGraphToClipboard(graph: CopiedGraph): Promise<void> {
  const payload = JSON.stringify({
    app: 'teia',
    kind: 'copied-graph',
    version: 1,
    graph: flowToEditorState(graph.nodes, graph.edges),
  });
  try {
    await navigator.clipboard?.writeText(payload);
  } catch {
    // Browser clipboard permissions are best-effort; the in-memory copy still works.
  }
}

async function readCopiedGraphFromClipboard(): Promise<CopiedGraph | null> {
  try {
    const raw = await navigator.clipboard?.readText();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      app?: string;
      kind?: string;
      version?: number;
      graph?: PersistedEditorState;
    };
    if (parsed.app !== 'teia' || parsed.kind !== 'copied-graph' || parsed.version !== 1 || !parsed.graph) {
      return null;
    }
    const callbacks = nodeCallbacksPlaceholder();
    return {
      nodes: editorStateToFlowNodes(parsed.graph, callbacks, null),
      edges: editorStateToFlowEdges(parsed.graph, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder),
    };
  } catch {
    return null;
  }
}

function isEditableEventTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('dialog[open]')) return true;
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

function isPlaybackShortcutControlEventTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLElement && target.closest('dialog[open]')) return false;
  if (target instanceof HTMLInputElement) {
    return target.type === 'range';
  }
  return target instanceof HTMLSelectElement;
}

function selectionById<T extends { id: string; selected?: boolean }>(items: T[]): Record<string, boolean> {
  return Object.fromEntries(items.map((item) => [item.id, item.selected === true]));
}

function selectedNodeIdsInScreenRect(
  editorShell: HTMLElement,
  start: ScreenPoint,
  end: ScreenPoint,
  nodeIds: Set<string>,
): Set<string> {
  const left = Math.min(start.x, end.x);
  const right = Math.max(start.x, end.x);
  const top = Math.min(start.y, end.y);
  const bottom = Math.max(start.y, end.y);
  const selectedNodeIds = new Set<string>();

  for (const element of editorShell.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')) {
    const nodeId = element.dataset.id;
    if (!nodeId || !nodeIds.has(nodeId)) continue;

    const bounds = element.getBoundingClientRect();
    const overlapsSelection = bounds.left < right
      && bounds.right > left
      && bounds.top < bottom
      && bounds.bottom > top;
    if (overlapsSelection) selectedNodeIds.add(nodeId);
  }

  return selectedNodeIds;
}

function updateSelection<T extends { id: string; selected?: boolean }>(items: T[], selectedIds: Set<string>): T[] {
  let changed = false;
  const nextItems = items.map((item) => {
    const selected = selectedIds.has(item.id);
    if (item.selected === selected) return item;

    changed = true;
    return { ...item, selected };
  });

  return changed ? nextItems : items;
}

function nodeZIndex(
  selected: boolean,
  compactPorts: boolean,
  stackRank = 0,
  nodeCount = 1,
): number {
  const classificationZIndex = selected
    ? SELECTED_NODE_Z_INDEX
    : compactPorts
      ? COMPACT_NODE_Z_INDEX
      : EXPANDED_NODE_Z_INDEX;
  // Reserve one integer slot per node so recency can never cross a classification boundary.
  const classificationSize = Math.max(1, nodeCount);
  return classificationZIndex * classificationSize + Math.max(0, stackRank);
}

function restoreNodeSelectionAfterDeselectedDrag(
  nodes: ShaderFlowNode[],
  snapshot: NodeDragSelectionSnapshot | null,
): ShaderFlowNode[] {
  return restoreSelectionAfterDeselectedDrag(nodes, snapshot, snapshot?.nodeSelection);
}

function restoreEdgeSelectionAfterDeselectedDrag(
  edges: ShaderFlowEdge[],
  snapshot: NodeDragSelectionSnapshot | null,
): ShaderFlowEdge[] {
  return restoreSelectionAfterDeselectedDrag(edges, snapshot, snapshot?.edgeSelection);
}

function restoreSelectionAfterDeselectedDrag<T extends { id: string; selected?: boolean }>(
  items: T[],
  snapshot: NodeDragSelectionSnapshot | null,
  selectedById: Record<string, boolean> | undefined,
): T[] {
  if (!snapshot?.preserveSelection || !selectedById) return items;

  let changed = false;
  const restoredItems = items.map((item) => {
    if (!Object.prototype.hasOwnProperty.call(selectedById, item.id)) return item;
    const selected = selectedById[item.id] === true;
    if ((item.selected === true) === selected) return item;

    changed = true;
    return { ...item, selected };
  });

  return changed ? restoredItems : items;
}


function transformEdgeTree(
  edges: ShaderFlowEdge[],
  transform: (edge: ShaderFlowEdge) => ShaderFlowEdge | null,
): ShaderFlowEdge[] {
  const replacements = new Map<string, ShaderFlowEdge>();
  for (const edge of edges) {
    const replacement = transform(edge);
    if (replacement) replacements.set(edge.id, replacement);
  }
  const resolved = new Map<string, ShaderFlowEdge | null>();
  const resolve = (edge: ShaderFlowEdge, visited = new Set<string>()): ShaderFlowEdge | null => {
    if (resolved.has(edge.id)) return resolved.get(edge.id) ?? null;
    if (visited.has(edge.id)) return null;
    const replacement = replacements.get(edge.id);
    if (!replacement) return null;
    const parentId = replacement.data?.modulatesEdgeId;
    if (!parentId) {
      resolved.set(edge.id, replacement);
      return replacement;
    }
    const parent = edges.find((candidate) => candidate.id === parentId);
    const nextParent = parent ? resolve(parent, new Set([...visited, edge.id])) : null;
    if (!nextParent) return null;
    const next = {
      ...replacement,
      target: nextParent.target,
      targetHandle: nextParent.targetHandle,
      data: { ...replacement.data!, modulatesEdgeId: nextParent.id },
    };
    resolved.set(edge.id, next);
    return next;
  };
  return dedupeEdges(edges.flatMap((edge) => {
    const next = resolve(edge);
    return next ? [next] : [];
  }));
}

function samplePlayerVisualizationParams(
  nodeId: string,
  linkMeters: Record<string, LinkMeterReading>,
): Partial<Record<'start' | 'end' | 'attack' | 'release', number>> | undefined {
  const params: Partial<Record<'start' | 'end' | 'attack' | 'release', number>> = {};
  for (const port of ['start', 'end', 'attack', 'release'] as const) {
    const reading = linkMeters[`${nodeId}:sample-${port}`];
    if (reading) params[port] = reading.input;
  }
  return Object.keys(params).length > 0 ? params : undefined;
}

function renameEdgeNode(edge: ShaderFlowEdge, fromNodeId: string, toNodeId: string): ShaderFlowEdge {
  if (edge.data?.modulatesEdgeId) {
    return {
      ...edge,
      source: edge.source === fromNodeId ? toNodeId : edge.source,
      target: edge.target === fromNodeId ? toNodeId : edge.target,
    };
  }
  const link = linkFromEdge(edge);
  if (!link) return edge;
  const renamedLink: PatchLink = {
    from: { ...link.from, node: link.from.node === fromNodeId ? toNodeId : link.from.node },
    to: { ...link.to, node: link.to.node === fromNodeId ? toNodeId : link.to.node },
    weight: link.weight,
    mode: link.mode,
    enabled: link.enabled,
    weightModulations: link.weightModulations?.map((modulation) => modulation.from.node === fromNodeId
      ? { ...modulation, from: { ...modulation.from, node: toNodeId } }
      : modulation),
  };
  return edgeFromLink(renamedLink, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder);
}

function remapEdgeForNodeType(
  edge: ShaderFlowEdge,
  nodeId: string,
  previousDefinition: ReturnType<typeof getDefinition> | null,
  nextDefinition: ReturnType<typeof getDefinition>,
): ShaderFlowEdge | null {
  if (edge.data?.modulatesEdgeId) {
    if (edge.source !== nodeId) return edge;
    const sourcePort = edge.sourceHandle?.startsWith('out:') ? edge.sourceHandle.slice(4) : '';
    const previousIndex = previousDefinition?.outputs.findIndex((port) => port.name === sourcePort) ?? 0;
    const nextPort = nextDefinition.outputs[Math.max(0, previousIndex)]?.name;
    return nextPort ? { ...edge, sourceHandle: `out:${nextPort}` } : null;
  }
  const link = linkFromEdge(edge);
  if (!link) return null;

  if (link.from.node === nodeId) {
    const previousIndex = previousDefinition?.outputs.findIndex((port) => port.name === link.from.port) ?? 0;
    const nextPort = nextDefinition.outputs[Math.max(0, previousIndex)]?.name;
    if (!nextPort) return null;
    return edgeFromLink({ ...link, from: { node: nodeId, port: nextPort } }, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder);
  }

  if (link.to.node === nodeId) {
    const previousIndex = previousDefinition?.inputs.findIndex((port) => port.name === link.to.port) ?? 0;
    const nextPort = nextDefinition.inputs[Math.max(0, previousIndex)]?.name;
    if (!nextPort) return null;
    return edgeFromLink({ ...link, to: { node: nodeId, port: nextPort } }, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder);
  }

  return edge;
}

function uniqueNodeId(requestedId: string, currentId: string, nodes: ShaderFlowNode[]): string {
  const sanitized = requestedId.trim().replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
  const fallback = currentId || 'node';
  const base = sanitized || fallback;
  const existingIds = new Set(nodes.map((node) => node.id).filter((id) => id !== currentId));
  if (!existingIds.has(base)) return base;

  let index = 2;
  let candidate = `${base}_${index}`;
  while (existingIds.has(candidate)) {
    index += 1;
    candidate = `${base}_${index}`;
  }
  return candidate;
}

function rowLabelColumnWidth(labels: string[]): number {
  const longestLabel = Math.max(3, ...labels.map((label) => label.length));
  return 20 + longestLabel * 8;
}

function shouldAutoRenameForTypeChange(nodeId: string, previousType: NodeType | null): boolean {
  return previousType === null || /^node_\d+$/.test(nodeId);
}

function nextTypeNodeId(nodeId: string, type: NodeType, nodes: ShaderFlowNode[]): string {
  return uniqueNodeId(makeNodeId(type, new Set(nodes.map((node) => node.id))), nodeId, nodes);
}

function midpointPosition(
  source?: { x: number; y: number },
  target?: { x: number; y: number },
): { x: number; y: number } {
  if (source && target) {
    return {
      x: (source.x + target.x) / 2,
      y: (source.y + target.y) / 2,
    };
  }
  return { x: 0, y: 0 };
}

function nodeCallbacksPlaceholder() {
  return {
    onParamChange: updateParamPlaceholder,
    onParamsChange: updateParamsPlaceholder,
    onTypeChange: updateTypePlaceholder,
    onConvertToArea: updateConvertToAreaPlaceholder,
    onTypeEditStart: updateTypeEditStartPlaceholder,
    onTypeEditEnd: updateTypeEditEndPlaceholder,
    onTypeEditCancel: updateTypeEditCancelPlaceholder,
    onIdChange: updateIdPlaceholder,
    onPortDoubleClick: noopPortDoubleClick,
    onPortNameChange: noopPortNameChange,
    onPortAdd: noopPortNameChange,
    onPortMove: noopPortMove,
    onCompactToggle: noopCompactToggle,
    onScopeResize: noopScopeResize,
  };
}

function updateParamPlaceholder() {}
function updateParamsPlaceholder() {}
function updateTypePlaceholder() {}
function updateConvertToAreaPlaceholder() {}
function updateTypeEditStartPlaceholder() {}
function updateTypeEditEndPlaceholder() {}
function updateTypeEditCancelPlaceholder() {}
function updateIdPlaceholder() {}
function updateEdgeWeightPlaceholder() {}
function updateEdgeModePlaceholder() {}
function insertNodeOnEdgePlaceholder() {}
function noopPortDoubleClick() {}
function noopPortNameChange() {}
function noopPortMove() {}
function noopCompactToggle() {}
function noopScopeResize() {}

const emptySubscribe = () => () => undefined;
const emptySnapshot = () => null;
