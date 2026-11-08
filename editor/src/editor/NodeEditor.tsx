import { portName } from '../spagbol/patchCodec';
import { isFm1NodeImplemented } from '../audio/fm1Support';
import { NODE_TYPE_LIST } from '../graph/nodeTypes';
import { SpagbolCanvas, groupPanelLayout, graphAt } from '@pauloricca/spagbol';
import '@pauloricca/spagbol/styles.css';
import { graphKind, graphToPatch, nodeToPatch, patchToGraph, teiaLinkIds, patchType } from '../spagbol/patchCodec';
import { useTeiaGraph } from '../spagbol/useTeiaGraph';
import { TeiaGraphBindings, teiaNodeViews } from '../spagbol/TeiaNodeView';
import { useSyncExternalStore } from 'react';
import { HostedParameters } from '../hosted/HostedParameters';
import { HostedSession } from '../hosted/session';
import { useHostedAudio } from '../hosted/useHostedAudio';
import { HostedModeContext } from '../hosted/HostedModeContext';
import { preparePatch } from '../hosted/compiler';
import { withParameterIds, retainNestedBufferReferences } from '../hosted/document';
import type { AudioEngineState } from '../audio/useAudioEngine';
import { parsePatchJson, normalizeSelectedMidiDeviceIds, expressionInputDefinitions, syncParamsToInputs, isRecord, isImageAsset } from '../graph/parse';
import { ReactFlowInstance, Viewport } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type DragEvent } from 'react';
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
import { useAudioEngine, type BufferSnapshot, type LinkMeterReading, type MidiControlChange, type MidiInputState, type ScopeCaptureRequest } from '../audio/useAudioEngine';
import { normalizeCustomWave } from '../graph/customWave';
import { demoPatch } from '../graph/demoPatch';
import { getNodeDefinition, rollShape, sequencerShape } from '../graph/nodeTypes';
import { patchToJson } from '../graph/serialize';
import { DEFAULT_SPAWN_SIZE, DEFAULT_SPREAD_SIZE, MIN_RUNTIME_CONTAINER_WIDTH, MIN_SPAWN_WIDTH, runtimeContainerPortsHeight, runtimeContainerSize, spreadCloneNodeId } from '../graph/spread';
import type { BufferAsset, CustomWaveSettings, ImageAsset, LinkMode, NodeType, Patch, PatchLink, PatchNode, PortDefinition, SampleAsset } from '../graph/types';
import { USER_ZOOM_BASELINE } from './canvasZoom';
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
import { makeNodeId } from './TeiaNodeContent';
const STORAGE_KEY = 'teia.editor-state.v1';
const VIEWPORT_STORAGE_KEY = 'teia.viewport.v1';
const COMPACT_NODE_Z_INDEX = 0;
const EXPANDED_NODE_Z_INDEX = 1;
const SELECTED_NODE_Z_INDEX = 2;
const MIN_CANVAS_ZOOM = 0.05;
const GRAPH_DETAIL_ZOOM_SETTLE_MS = 80;
const BUFFER_CHECKPOINT_INTERVAL_MS = 5000;
const DRAFT_NODE_WIDTH = 168;
const DEFAULT_NODE_BOUNDS_SIZE = { width: 240, height: 96 };
const NODE_HEADER_HEIGHT = 32;
const DSP_ERROR_PANEL_LIMIT = 4;

let subpatchCloneSequence = 0;

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

export function NodeEditor({ hosted }: { hosted?: HostedSession } = {}) {
  return <>{hosted
    ? <HostedEditorInner key={hosted.sessionId} hosted={hosted} />
    : <StandaloneEditorInner />}</>;
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

  const [settledGraphZoom, setSettledGraphZoom] = useState(initialViewport.zoom);
  const [editorSize, setEditorSize] = useState({ width: 0, height: 0 });
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge> | null>(null);
  const initialPatch = useMemo(() => initialState
    ? { ...patchFromFlow(editorStateToFlowNodes(initialState, nodeCallbacksPlaceholder(), null), editorStateToFlowEdges(initialState, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder), initialState.areas), name: initialState.ui?.patchName, buffers: initialState.buffers }
    : demoPatch, []);
  const legacyCallbacks = useMemo(nodeCallbacksPlaceholder, []);
  const shared = useTeiaGraph(initialPatch, legacyCallbacks, event => {
    const graph = graphAt(event.document, event.path);
    const presentation = toFlowNodes(graphToPatch(graph), legacyCallbacks, null);
    const copies = event.fragment.nodes.flatMap((node, index) => {
      if (node.kind !== 'Buffer') return [];
      const source = presentation.find(item => item.id === node.id);
      const target = presentation.find(item => item.id === event.nodeIds[index]);
      return source && target ? [{ sourceNodeId: runtimeDspNodeIdForFlowNode(source, presentation, event.path), targetNodeId: runtimeDspNodeIdForFlowNode(target, presentation, event.path) }] : [];
    });
    audio.copyBuffers(copies);
    const assets = copies.flatMap(copy => bufferAssetsRef.current[copy.sourceNodeId] ? [[copy.targetNodeId, bufferAssetsRef.current[copy.sourceNodeId]]] : []);
    if (assets.length) replaceBufferAssets({ ...bufferAssetsRef.current, ...Object.fromEntries(assets) });
  });
  const { nodes, edges, areas, setNodes, setEdges, setAreas } = shared;
  const [nodeStackOrder, setNodeStackOrder] = useState<string[]>(() => nodes.map(node => node.id));
  const canvasLocked = shared.snapshot.mode !== 'edit';

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
  const editorShellRef = useRef<HTMLElement | null>(null);
  const nodeDragAnimationFrameRef = useRef<number | null>(null);
  const pendingBoundaryPortRef = useRef<BoundaryPortSelection | null>(null);
  const [temporarilyRevealedNodeId, setTemporarilyRevealedNodeId] = useState<string | null>(null);
  const graphPath = shared.snapshot.path;
  const [pendingBoundaryPort, setPendingBoundaryPort] = useState<BoundaryPortSelection | null>(null);
  const [selectedBoundaryPort, setSelectedBoundaryPort] = useState<BoundaryPortSelection | null>(null);
  const [newPatchConfirmationOpen, setNewPatchConfirmationOpen] = useState(false);
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
  const rootPatchName = patchName;
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
    return new Promise(resolve => {
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
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [surfacedAreaId, setSurfacedAreaId] = useState<string | null>(null);
  const [editingAreaId, setEditingAreaId] = useState<string | null>(null);
  const areaTitleInputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => { areasRef.current = areas; }, [areas]);

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

  const commitHistory = useCallback((_groupKey?: string) => {
    if (shared.editor.getSnapshot().gesture) return;
    shared.editor.beginGesture('Edit Teia control');
    queueMicrotask(() => { if (shared.editor.getSnapshot().gesture) shared.editor.commitGesture(); });
  }, [shared.editor]);

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
    if (sendHostedGesture(scopedDspNodeId(nodeId, graphPath), relatedNode?.data.patchNode.type ?? null, { [port]: value })) return;
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
    if (!nextPatchNode && !nextPatternScopeSize && relatedNode?.data.patchNode.type !== 'Ins' && relatedNode?.data.patchNode.type !== 'Params') {
      const node = shared.editor.graph.nodes.find(node => node.id === nodeId);
      const id = node?.ports?.find(candidate => candidate.direction === 'input' && portName(node, candidate.id, 'input') === port)?.id ?? port;
      shared.editor.setValue(nodeId, id, value);
      return;
    }
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
  }, [commitHistory, sendHostedGesture, graphPath, shared.editor]);

  const updateNodeParams = useCallback((nodeId: string, values: Record<string, number>) => {
    if (Object.keys(values).length === 0) return;
    const relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (sendHostedGesture(scopedDspNodeId(nodeId, graphPath), relatedNode?.data.patchNode.type ?? null, values)) return;
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
    const node = shared.editor.graph.nodes.find(node => node.id === nodeId);
    shared.editor.setValues(nodeId, Object.fromEntries(Object.entries(values).map(([name, value]) => [node?.ports?.find(port => port.direction === 'input' && portName(node, port.id, 'input') === name)?.id ?? name, value])));
  }, [commitHistory, sendHostedGesture, graphPath, shared.editor]);

  const updateNodeType = useCallback(async (nodeId: string, type: NodeType) => {
    let relatedNode = nodesRef.current.find((node) => node.id === nodeId);
    if (!relatedNode) return;
    if (['Group', 'Ins', 'Outs'].includes(type)) { shared.editor.changeNodeKind(nodeId, graphKind(type)); return; }

    let convertedBufferSample: SampleAsset | undefined;
    if (relatedNode.data.patchNode.type === 'Buffer' && type === 'SamplePlayer') {
      if (hosted) { setImportError('Buffer to Sample conversion requires a host media conversion adapter.'); return; }
      const dspNodeId = runtimeDspNodeIdForFlowNode(
        relatedNode,
        nodesRef.current,
        graphPath,
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

    shared.editor.changeNodeKind(nodeId, graphKind(type), JSON.parse(JSON.stringify({
      ...(type === 'CustomWave' ? { customWave: normalizeCustomWave(relatedNode.data.patchNode.customWave, relatedNode.data.patchNode.params) } : {}),
      ...(type === 'SamplePlayer' && convertedBufferSample ? { sample: convertedBufferSample } : {}),
    })));
  }, [audio.captureBuffer, audio.buffers, hosted, graphPath, requestBufferSampleName, shared.editor]);

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
        relatedNode.data.patchNode.type !== 'Spawn' &&
        relatedNode.data.patchNode.type !== 'ConditionalExecution'
      )
    ) {
      return;
    }

    const nextSize = relatedNode.data.patchNode.type === 'Spread' || relatedNode.data.patchNode.type === 'Spawn' || relatedNode.data.patchNode.type === 'ConditionalExecution'
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
        node.data.patchNode.type === 'Spread' || node.data.patchNode.type === 'Spawn' || node.data.patchNode.type === 'ConditionalExecution'
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
  const baseNodeLayerSize = Math.max(1, nodes.length);
  const surfacedAreaLayerBase = (SELECTED_NODE_Z_INDEX + 1) * baseNodeLayerSize + 1;
  const surfacedNodeLayerBase = surfacedAreaLayerBase + surfacedAreaIds.size;
  const temporaryNodeLayer = surfacedNodeLayerBase + (SELECTED_NODE_Z_INDEX + 1) * baseNodeLayerSize;

  const nodesWithCallbacks = useMemo(() => {
    const nextNodes = nodes.map((node) => {
    const compactPorts = node.data.patchNode.compactPorts === true;
    const baseZIndex = node.data.patchNode.type === 'Spread' || node.data.patchNode.type === 'Spawn' || node.data.patchNode.type === 'ConditionalExecution'
      ? 0
      : 1 + nodeZIndex(
          node.selected === true || selectedAreaNodeIds.has(node.id),
          compactPorts,
          nodeStackRanks.get(node.id) ?? 0,
          nodes.length,
        );

    return {
      ...node,
      ...((node.data.patchNode.type === 'Spread' || node.data.patchNode.type === 'Spawn' || node.data.patchNode.type === 'ConditionalExecution') ? { draggable: false, selectable: false } : {}),
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
        onCustomLabelChange: updateNodeCustomLabel,
        onSequencerRowLabelsChange: updateSequencerRowLabels,
        onExpressionCommit: updateExpression,
        onSampleSelect: openSampleLibrary,
        onSampleDrop: uploadDroppedSampleFiles,
        onImageSelect: openImageLibrary,
        onPortSelect: selectBoundaryPort,
        onPortNameChange: updateBoundaryPortName,
        onParamRangeChange: updateParamRange,
        onPortAdd: addBoundaryPort,
        onPortMove: updateBoundaryPortOrder,
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
        isOnlySelected: node.selected === true && selectedNodeCount === 1,
        routingHighlighted: node.selected !== true && routingSelection.nodeIds.has(node.id),
        isEditingSubpatch: graphPath.length > 0,
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
    graphPath.length,
    nodes,
    openSampleLibrary,
    uploadDroppedSampleFiles,
    openImageLibrary,
    nodeStackRanks,
    selectedAreaNodeIds,
    surfacedAreaNodeIds,
    surfacedNodeLayerBase,
    temporaryNodeLayer,
    temporarilyRevealedNodeId,
    selectedLinkPortsByNode,
    routingSelection,
    selectBoundaryPort,
    settledGraphZoom,
    updateBoundaryPortName,
    addBoundaryPort,
    updateBoundaryPortOrder,
    updateExpression,
    addSelectorInput,
    clearSelectorInput,
    audio.audioInput,
    audio.midiInput,
    audio.refreshAudioInputDevices,
    audio.refreshMidiInputDevices,
    audio.setAudioInputDeviceId,
    updateNodeCustomWave,
    updateNodeScopeSize,
    updateNodeParam,
    updateNodeParams,
    updateParamRange,
    updateNodeCustomLabel,
    updateSequencerRowLabels,
    selectedNodeCount,
  ]);

  const materializedGraph = useMemo(() => {
    const root = graphToPatch(shared.snapshot.document);
    return { nodes: toFlowNodes(root, legacyCallbacks, null), edges: toFlowEdges(root, updateEdgeWeightPlaceholder, updateEdgeModePlaceholder, insertNodeOnEdgePlaceholder) };
  }, [shared.snapshot.document, legacyCallbacks]);
  const isEditingSubpatch = graphPath.length > 0;
  const patch = useMemo(() => ({
    ...graphToPatch(shared.snapshot.document),
    name: rootPatchName,
    ...(hosted?.getDocument().schemaVersion ? { schemaVersion: 1 as const } : {}),
    ...(selectedMidiInputDeviceIds.length > 0 || selectedMidiOutputDeviceIds.length > 0 || midiClockOutputEnabled
      ? { midiInput: {
        selectedDeviceIds: selectedMidiInputDeviceIds,
        ...(selectedMidiOutputDeviceIds.length > 0 ? { selectedOutputDeviceIds: selectedMidiOutputDeviceIds } : {}),
        ...(midiClockOutputEnabled ? { sendClock: true } : {}),
      } }
      : {}),
  }), [areas, graphPath, materializedGraph, midiClockOutputEnabled, rootPatchName, selectedMidiInputDeviceIds, selectedMidiOutputDeviceIds]);
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
    state.areas = graphToPatch(shared.snapshot.document).areas;
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
  const activeDspGroupIds = useMemo(() => graphPath, [graphPath]);

  const nodesWithGroupUi = useMemo(() => nodesWithCallbacks.map((node) => {
    const groupNode = node.data.patchNode;
    if (groupNode.type !== 'Group' || !groupNode.subpatch) return node;
    const coreGroup = shared.editor.graph.nodes.find(item => item.id === node.id);
    const coreLayout = coreGroup && groupPanelLayout(coreGroup);
    const layout = coreLayout && { position: coreLayout.position, size: coreLayout.size, nodes: coreLayout.nodes.map(nodeToPatch) };
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

  const canvasKinds = useMemo(() => NODE_TYPE_LIST.filter(type => (graphPath.length > 0 ? type !== 'Params' : type !== 'Ins' && type !== 'Outs') && (!hosted?.capabilities.nodeTypes || hosted.capabilities.nodeTypes.includes(type)) && (!fm1Mode || isFm1NodeImplemented(type))).map(graphKind), [graphPath.length, hosted, fm1Mode]);
  const canvasVirtualLinks = useMemo(() => routingSelection.pairs.map(([source, target]) => ({ id: `route:${source}:${target}`, source: { nodeId: source, portId: 'teia.virtual' }, target: { type: 'port' as const, nodeId: target, portId: 'teia.virtual' }, mode: 'set', weight: 1 })), [routingSelection.pairs]);
  const canvasDiagnostics = useMemo(() => [
    ...nodes.flatMap(node => (dspDiagnostics.nodeErrors.get(scopedDspNodeId(node.id, shared.snapshot.path)) ?? []).map(message => ({ path: [...shared.snapshot.path], nodeId: node.id, code: 'teia-dsp', severity: 'error' as const, message }))),
    ...[...teiaLinkIds(shared.editor.graph)].flatMap(([linkId, legacyId]) => (dspDiagnostics.edgeErrors.get(legacyId) ?? []).map(message => ({ path: [...shared.snapshot.path], linkId, code: 'teia-dsp', severity: 'error' as const, message }))),
  ], [nodes, dspDiagnostics, shared.snapshot.path, shared.editor.graph]);
  const changeNodeKindRef = useRef(updateNodeType); changeNodeKindRef.current = updateNodeType;
  const changeCanvasNodeKind = useCallback(async (id: string, kind: string) => { try { await changeNodeKindRef.current(id, patchType(kind)); } catch (error) { setImportError(error instanceof Error ? error.message : String(error)); } }, []);

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

  useEffect(() => () => {
    if (nodeDragAnimationFrameRef.current !== null) {
      cancelAnimationFrame(nodeDragAnimationFrameRef.current);
    }
  }, []);

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

    shared.replace(loadedPatch);
    setPendingBoundaryPort(null);
    setSelectedAreaId(null);
    setSurfacedAreaId(null);
    setEditingAreaId(null);
    setPatchName(loadedPatch.name ?? 'single-patch');
    setSelectedMidiInputDeviceIds(normalizeSelectedMidiDeviceIds(loadedPatch.midiInput?.selectedDeviceIds));
    setSelectedMidiOutputDeviceIds(normalizeSelectedMidiDeviceIds(loadedPatch.midiInput?.selectedOutputDeviceIds));
    setMidiClockOutputEnabled(loadedPatch.midiInput?.sendClock === true);
    setMidiControlVisuals({});
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

  const newPatch = useCallback(() => {
    if (hosted) { setImportError('This operation is owned by the host and has no supplied adapter.'); return; }
    setNewPatchConfirmationOpen(true);
  }, []);

  const confirmNewPatch = useCallback(() => {
    setPendingBoundaryPort(null);
    setSelectedBoundaryPort(null);
    setPatchName(localPatchStorageEnabled ? '' : 'untitled-patch');
    setSelectedMidiInputDeviceIds([]);
    setMidiClockOutputEnabled(false);
    setMidiControlVisuals({});
    shared.replace({ nodes: [], links: [] });
    setSelectedAreaId(null);
    setSurfacedAreaId(null);
    setEditingAreaId(null);
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

  return (
    <div className="app-shell app-shell-panel-closed">
      <main ref={editorShellRef} className="editor-shell">
        <Fm1ModeContext.Provider value={fm1Mode}>
          <TeiaGraphBindings nodes={renderedNodes} gesture={(node, path, values) => sendHostedGesture(scopedDspNodeId(node.id, path), node.kind, values)}>
            <SpagbolCanvas editor={shared.editor} views={teiaNodeViews}
              nodeKinds={canvasKinds}
              virtualLinks={canvasVirtualLinks}
              diagnostics={canvasDiagnostics}
              onChangeNodeKind={changeCanvasNodeKind}
              className="teia-graph-canvas"
              defaultViewport={initialViewport}
              onInit={instance => setReactFlow(instance as unknown as ReactFlowInstance<ShaderFlowNode, ShaderFlowEdge>)}
              onViewportChange={viewport => { viewportRef.current = viewport; setSettledViewport(viewport); if (!hosted) storeViewport(viewport); }}
              controls={{
                leading: <>
            {fm1Mode && fm1LiveState.message && <span className="fm1-live-status" role="status">{fm1LiveState.message}</span>}
            <input
              className="patch-name-input"
              value={shared.snapshot.path.length ? shared.currentName ?? shared.snapshot.path.at(-1) : patchName}
              onChange={(event) => { if (shared.snapshot.path.length) { const id = shared.snapshot.path.at(-1)!; shared.editor.navigate(shared.snapshot.path.slice(0, -1)); shared.editor.updateNode(id, { label: event.target.value }, "metadata"); shared.editor.enter(id); } else setPatchName(event.target.value); }}
              aria-label={isEditingSubpatch ? 'Subpatch name' : 'Patch name'}
              title={isEditingSubpatch ? 'Subpatch name' : 'Patch name'}
              placeholder={isEditingSubpatch ? 'subpatch name' : 'patch name'}
              spellCheck={false}
            />

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
</>,
                zoomExtra: <>              <div
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
</>,
                menuItems: [
                  ...(!hosted ? [
                    { id: 'midi', label: 'MIDI SETTINGS', onSelect: () => setMidiSettingsOpen(true) },
                    { id: 'export', label: 'EXPORT PATCH', onSelect: () => exportPatchPackage() },
                    { id: 'fm1', label: 'FM1 MODE', checked: fm1Mode, disabled: fm1LiveState.busy, onSelect: () => { audio.stopRecording(); audio.stop(); setFm1Live(false); setFm1Mode(value => !value); } },
                    ...(!fm1Mode ? [{ id: 'upload', label: 'SEND TO FM1', disabled: fm1Live || fm1LiveState.busy, onSelect: () => setFm1Patch(patch) }] : []),
                  ] : []),
                  { id: 'import-group', label: 'IMPORT SUBPATCH', onSelect: () => requestSubpatchImport() },
                ],
              }}
            />
          </TeiaGraphBindings>
        </Fm1ModeContext.Provider>
          <input ref={fileInputRef} className="file-input" type="file" accept="application/json,.json" onChange={loadPatchFile} />
          <input ref={importFileInputRef} className="file-input" type="file" accept="application/json,.json" onChange={loadSubpatchImportFile} />
          <input ref={sampleFileInputRef} className="file-input" type="file" accept="audio/*,video/mp4,.wav,.mp3,.aiff,.aif,.flac,.ogg,.m4a,.mp4" onChange={uploadSampleFile} />
          <input ref={imageFileInputRef} className="file-input" type="file" accept="image/avif,image/gif,image/jpeg,image/png,image/webp,.avif,.gif,.jpg,.jpeg,.png,.webp" onChange={uploadImageFile} />
          {fm1Patch && <Fm1UploadDialog patch={fm1Patch} onClose={() => setFm1Patch(null)} />}
          {hostedState && (!hostedState.connected || hostedState.diagnostics.some(d => d.severity !== 'info')) && <p className="import-error-floating" aria-live="polite">{[...(!hostedState.connected ? ['Host disconnected; working document retained.'] : []), ...hostedState.diagnostics.filter(d => d.severity !== 'info').map(d => d.message)].join(' · ')}</p>}
          {hosted && <HostedParameters session={hosted} />}
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
    (node.type === 'Spread' || node.type === 'Spawn' || node.type === 'ConditionalExecution') && !node.spreadNodeIds
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
    ...(includeLayout && (node.type === 'Spread' || node.type === 'Spawn' || node.type === 'ConditionalExecution') && node.scopeSize
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

  if (patchNode.type === 'Spread' || patchNode.type === 'Spawn' || patchNode.type === 'ConditionalExecution') {
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

function flowNodeIsInsideSpread(spread: ShaderFlowNode, node: ShaderFlowNode): boolean {
  if (
    (spread.data.patchNode.type !== 'Spread' && spread.data.patchNode.type !== 'Spawn' && spread.data.patchNode.type !== 'ConditionalExecution')
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

function normalizedViewportZoom(zoom: number): number {
  return finitePositiveNumber(zoom) ?? USER_ZOOM_BASELINE;
}

function finitePositiveNumber(value: number | undefined): number | null {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
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

function areaContainsNode(area: EditorArea, node: ShaderFlowNode): boolean {
  // Locked membership is an explicit snapshot, including an explicitly empty
  // one. Never fall back to overlap for a locked Area, Spread, or Spawn.
  return area.locked
    ? area.nodeIds?.includes(node.id) === true
    : areaContainsPoint(area, node.position);
}

function groupUiPreviewLayout(patch: Patch) {
  const layout = groupPanelLayout({ id: 'preview', kind: 'spagbol.group', position: { x: 0, y: 0 }, values: {}, data: {}, graph: patchToGraph(patch) });
  return layout ? { position: layout.position, size: layout.size, nodes: layout.nodes.map(nodeToPatch) } : null;
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

function makeSubpatchCloneId(seed: string): string {
  subpatchCloneSequence += 1;
  const normalizedSeed = seed.replace(/[^A-Za-z0-9_-]/g, '_') || 'group';
  return `subpatch_clone_${normalizedSeed}_${subpatchCloneSequence}`;
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

function rowLabelColumnWidth(labels: string[]): number {
  const longestLabel = Math.max(3, ...labels.map((label) => label.length));
  return 20 + longestLabel * 8;
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

function bufferContainsAudio(samples: Float32Array): boolean {
  return samples.some((sample) => Number.isFinite(sample) && sample !== 0);
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
