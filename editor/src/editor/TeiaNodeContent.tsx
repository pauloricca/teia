import { SEQUENCER_INDEX_OUTPUT } from '../graph/nodeTypes';
import { SpagbolNodeFrame, SpagbolNodePort, SpagbolControlNumber, portsFor, useSpagbol, type SpagbolNodeViewProps, type GraphNode } from "@pauloricca/spagbol";
import { portName } from "../spagbol/patchCodec";
import { SpagbolCurveEditor, SpagbolSequencer, SpagbolControlJoystick, SpagbolControlSlider, SpagbolControlButton, type SpagbolControlButtonMode } from '@pauloricca/spagbol';
import '@pauloricca/spagbol/controls.css';
import '@pauloricca/spagbol/editors.css';
import { HostedModeContext } from '../hosted/HostedModeContext';
import { Fm1ModeContext } from './Fm1ModeContext';
import { isFm1NodeImplemented } from '../audio/fm1Support';
import { Handle as FlowHandle, useNodeId, Position, useConnection, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import { createContext, memo, useEffect, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type MouseEvent, type PointerEvent, type ReactNode, type SyntheticEvent } from 'react';
import {
  CUSTOM_WAVE_MODES,
  customWaveUsesSustainEnd,
  customWaveUsesSustainStart,
  customWaveWithBaseLevel,
  customWaveBank,
  normalizedCustomWaveValue,
  normalizeCustomWave,
} from '../graph/customWave';
import { getNodeDefinition, sequencerCellParamName, sequencerGateParamName, sequencerGatesForRow, sequencerTriggerPositionParamName, sequencerTriggersForRow, sequencerUsesGateMode, SEQUENCER_GATE_INITIALIZED_PARAM, SEQUENCER_GATE_MODE_PARAM, rollCellParamName, rollGateParamName, rollGateVelocityParamName, rollGatesForRow, rollShape, sequencerOutputName, sequencerShape, sequencerStepVelocityParamName, trimOverlappingSequencerGates, SEQUENCER_MIN_VELOCITY } from '../graph/nodeTypes';
import type { CustomWavePoint, CustomWaveSettings, NodeDefinition, NodeType, PatchNode } from '../graph/types';
import { midiNoteLabel, normalisePitchClass, PITCH_CLASSES, QUANTISE_SCALES } from '../graph/musicScales';
import {
  MIN_EXECUTION_AREA_WIDTH,
  MIN_SPAWN_WIDTH,
  SPREAD_HEADER_HEIGHT,
  executionAreaPortsHeight,
  executionAreaSize,
} from '../graph/spread';
import {
  clampControlNodeSize,
  clampCustomWaveNodeSize,
  clampImageNodeSize,
  clampKeysNodeSize,
  clampSequencerNodeSize,
  clampScopeNodeSize,
  DEFAULT_IMAGE_ASPECT_RATIO,
  DEFAULT_CUSTOM_WAVE_NODE_SIZE,
  DEFAULT_FFT_NODE_SIZE,
  DEFAULT_JOYSTICK_NODE_SIZE,
  DEFAULT_KEYS_NODE_SIZE,
  DEFAULT_SCOPE_NODE_SIZE,
  SEQUENCER_MIN_CELL_SIZE,
  type ScopeNodeSize,
  type TeiaFlowEdge,
  type TeiaFlowNode,
  type TeiaNodeData,
} from './flowPatch';
import { getSampleWaveform, type SampleWaveform, type SampleWaveformBin } from '../audio/sampleWaveformCache';
import {
  canvasHeaderTitleScale,
  customWaveEditPointScreenScale,
  graphDetailScreenEmphasis,
  graphDetailZoomScale,
} from './canvasZoom';
import { ChartGrid, chartGridColumns, chartGridRows, chartScaleTicks, formatChartValue, type ChartGridTick } from './chartGrid';

const CUSTOM_WAVE_DRAG_UPDATE_INTERVAL_MS = 50;
const SEQUENCER_TRIGGER_GRAB_FRACTION = 0.35;
const FFT_CAPTURE_SECONDS = 0.012;
const FFT_ANALYSIS_MIN_FREQUENCY = 20;
const FFT_ANALYSIS_MAX_FREQUENCY = 20000;

const TeiaNodeModel = createContext<GraphNode | null>(null);
export const TeiaNodeContent = memo(function TeiaNodeContent(props: { data: TeiaNodeData; shared: SpagbolNodeViewProps }) {
  return <TeiaNodeModel.Provider value={props.shared.node}><TeiaNodeContentInner {...props} /></TeiaNodeModel.Provider>;
});
function TeiaNodeContentInner({ data, shared }: { data: TeiaNodeData; shared: SpagbolNodeViewProps }) {
  const { selected } = shared;
  const flowNodeId = useNodeId() ?? `node:${shared.node.id}`;
  const node = data.patchNode;
  const fm1Mode = useContext(Fm1ModeContext);
  const hostedMode = useContext(HostedModeContext);
  const [hostedImageUrl, setHostedImageUrl] = useState<string | undefined>();
  useEffect(() => {
    setHostedImageUrl(undefined);
    if (!hostedMode || !node.image?.url || !hostedMode.assets?.imagePreview) return;
    const controller = new AbortController();
    let url: string | undefined;
    void hostedMode.assets.imagePreview(node.image.url, controller.signal).then(blob => {
      if (!blob || controller.signal.aborted || blob.size > 4 * 1024 * 1024 || !blob.type.startsWith('image/')) return;
      url = URL.createObjectURL(blob); setHostedImageUrl(url);
    }).catch(() => undefined);
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [hostedMode?.assets, node.image?.url]);
  const imagePreviewUrl = hostedMode ? hostedImageUrl : node.image?.url;
  const hostedUnsupported = hostedMode?.nodeTypes && node.type !== null && !hostedMode.nodeTypes.includes(node.type);
  const fm1Unsupported = fm1Mode && node.type !== null && !isFm1NodeImplemented(node.type);
  const connectionInProgress = useConnection((connection) => connection.inProgress);
  const isCanvasLocked = data.isCanvasLocked === true;
  const scopeGradientId = `scope-gradient-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const reactFlow = useReactFlow<TeiaFlowNode, TeiaFlowEdge>();
  const graphZoomScale = graphDetailZoomScale(data.canvasZoom ?? Number.NaN);
  const graphScreenEmphasis = graphDetailScreenEmphasis(graphZoomScale);
  const headerTitleScale = canvasHeaderTitleScale(data.canvasZoom ?? Number.NaN);
  const customWavePointScale = customWaveEditPointScreenScale(graphZoomScale);
  const updateNodeInternals = useUpdateNodeInternals();
  const nodeElementRef = useRef<HTMLDivElement | null>(null);
  const scopeDisplayRef = useRef<HTMLDivElement | null>(null);
  const [scopeFullscreenError, setScopeFullscreenError] = useState('');
  const draggedPortRef = useRef<{ side: 'input' | 'output'; port: string; pointerId: number } | null>(null);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const scopeResizeRef = useRef<{
    pointerId: number;
    corner: 'bottom-left' | 'bottom-right';
    startPointer: { x: number; y: number };
    startSize: ScopeNodeSize;
    lastSize: ScopeNodeSize;
    coordinateScale: number;
    minWidth?: number;
  } | null>(null);
  const fftDisplayRef = useRef<HTMLDivElement | null>(null);
  const fftBoundaryDragRef = useRef<{ boundary: 'min' | 'max'; pointerId: number } | null>(null);
  const customWaveDragCommitRef = useRef<{
    lastCommitTime: number;
    pending: { customWave: CustomWaveSettings; historyKey: string } | null;
    timeout: ReturnType<typeof setTimeout> | null;
  }>({ lastCommitTime: Number.NEGATIVE_INFINITY, pending: null, timeout: null });
  const inputPortRowsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const outputPortRowsRef = useRef<Record<string, HTMLDivElement | null>>({});
  const expressionInputRef = useRef<HTMLInputElement | null>(null);
  const skipNextExpressionBlurRef = useRef(false);
  const [dragSource, setDragSource] = useState<{ side: 'input' | 'output'; port: string } | null>(null);
  const [dragTarget, setDragTarget] = useState<{ side: 'input' | 'output'; port: string } | null>(null);
  const [scopeResizeCorner, setScopeResizeCorner] = useState<'bottom-left' | 'bottom-right' | null>(null);
  const [autoDisplayWidth, setAutoDisplayWidth] = useState<number | null>(null);
  const [expressionDraft, setExpressionDraft] = useState(node.expression ?? '');
  const [imageAspectRatio, setImageAspectRatio] = useState(DEFAULT_IMAGE_ASPECT_RATIO);
  const [pointerOver, setPointerOver] = useState(false);
  const definition = node.type ? getNodeDefinition(node as PatchNode) : null;
  const isExpression = node.type === 'Expression';
  const isGroup = node.type === 'Group';
  const groupUiPreview = isGroup ? data.groupUiPreview : undefined;
  const isSpread = node.type === 'Spread';
  const isSpawn = node.type === 'Spawn';
  const isConditional = node.type === 'ConditionalExecution';
  const isExecutionArea = isSpread || isSpawn || isConditional;
  const isAreaCollapsedPresentation = data.isAreaCollapsedPresentation === true;
  const isAreaUiCollapsedPresentation = data.isAreaUiCollapsedPresentation === true;
  const isSelector = node.type === 'Selector';
  const isRoutingNode = node.type === 'Send' || node.type === 'Receive';
  const canRenameInputs = node.type === 'Outs';
  const canRenameOutputs = node.type === 'Ins' || node.type === 'Params';
  const outputCount = definition?.outputs.length ?? 0;
  const previewInputPort = data.previewPort?.side === 'input' ? data.previewPort.name : null;
  const previewOutputPort = data.previewPort?.side === 'output' ? data.previewPort.name : null;
  const showMeterDisplay = node.type === 'Meter';
  const showScopeDisplay = node.type === 'Scope';
  const showFftDisplay = node.type === 'FFT';
  const showSliderDisplay = node.type === 'Slider';
  const showJoystickDisplay = node.type === 'Joystick';
  const showButtonDisplay = node.type === 'Button';
  const showKeysDisplay = node.type === 'Keys';
  const showAccumulatorDisplay = node.type === 'Accumulator';
  const showQuantiseDisplay = node.type === 'Quantise';
  const showSequencerDisplay = node.type === 'Sequencer';
  const showRollDisplay = node.type === 'Roll';
  const showTempoDisplay = node.type === 'Tempo';
  const showAudioOutputDisplay = node.type === 'AudioOut';
  const showAudioInputDisplay = node.type === 'AudioInput';
  const showCustomWaveEditor = node.type === 'CustomWave';
  const showKinkOscGraphic = node.type === 'KinkOsc';
  const showSampleUpload = node.type === 'SamplePlayer';
  const showSampleVideo = showSampleUpload && Boolean(node.sample?.url && isVideoSampleUrl(node.sample.url));
  const showBufferDisplay = node.type === 'Buffer';
  const showImageDisplay = node.type === 'Image';
  const showTopGraphic = showMeterDisplay || showScopeDisplay || showFftDisplay || showSliderDisplay || showJoystickDisplay || showButtonDisplay || showKeysDisplay || showCustomWaveEditor || showKinkOscGraphic || showSampleUpload || showBufferDisplay || showImageDisplay || showRollDisplay || Boolean(groupUiPreview);
  const imageX = centeredCoordinateToUnit(data.audioImagePosition?.x ?? node.params.x ?? 0);
  const imageY = centeredCoordinateToUnit(data.audioImagePosition?.y ?? node.params.y ?? 0);
  const showResizableDisplay = showMeterDisplay || showScopeDisplay || showFftDisplay || showSliderDisplay || showJoystickDisplay || showButtonDisplay || showKeysDisplay || showCustomWaveEditor || showSampleUpload || showBufferDisplay || showImageDisplay || showSequencerDisplay || showRollDisplay || isExecutionArea;
  const usesAutoInitialWidth = node.scopeSize === undefined && (
    showMeterDisplay
    || showScopeDisplay
    || showFftDisplay
    || showSliderDisplay
    || showJoystickDisplay
    || showButtonDisplay
    || showKeysDisplay
    || showCustomWaveEditor
    || showSampleUpload
    || showBufferDisplay
  );
  const customWaveCount = Math.max(1, Math.min(8, Math.round(node.params.count ?? 1)));
  const customWaveBankValues = showCustomWaveEditor
    ? Array.from({ length: customWaveCount }, (_, index) => customWaveBank(node.customWave, node.params)[index] ?? normalizeCustomWave(undefined))
    : [];
  const [selectedCustomWaveIndex, setSelectedCustomWaveIndex] = useState(0);
  const selectedWaveIndex = Math.min(selectedCustomWaveIndex, customWaveCount - 1);
  const customWave = showCustomWaveEditor ? customWaveBankValues[selectedWaveIndex] ?? customWaveBankValues[0] : null;
  const customWavePlayheads = data.audioPlayheads?.length
    ? data.audioPlayheads.map((playhead) => clamp(playhead, 0, 1))
    : [normalizeUnitInterval(node.params.phase ?? 0)];
  useEffect(() => {
    setSelectedCustomWaveIndex((current) => Math.min(current, customWaveCount - 1));
  }, [customWaveCount]);
  useEffect(() => {
    if (!showCustomWaveEditor || !selected || customWaveCount < 2) return;

    const handleCustomWaveSelectKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableElement(event.target) || isEditableElement(document.activeElement)) return;

      const waveIndex = Number(event.key) - 1;
      if (!Number.isInteger(waveIndex) || waveIndex < 0 || waveIndex >= customWaveCount) return;

      event.preventDefault();
      event.stopPropagation();
      setSelectedCustomWaveIndex(waveIndex);
    };

    window.addEventListener('keydown', handleCustomWaveSelectKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleCustomWaveSelectKeyDown, { capture: true });
  }, [customWaveCount, selected, showCustomWaveEditor]);
  const sequencer = showSequencerDisplay ? sequencerShape(node.params) : null;
  const roll = showRollDisplay ? rollShape(node.params) : null;
  const amplitudeRange = displayAmplitudeRange(node.params.range);
  const meterMode = monitorDisplayMode(node.params.mode, 'unipolar');
  const scopeMode = monitorDisplayMode(node.params.mode, 'bipolar');
  const signedMeterLevel = data.audioMeter?.input ?? 0;
  const unipolarMeterLevel = Math.max(0, Math.min(1, (data.audioMeter?.output ?? 0) / amplitudeRange));
  const bipolarMeterLevel = Math.max(-1, Math.min(1, signedMeterLevel / amplitudeRange));
  const meterPeak = useRecentMaxLevel(unipolarMeterLevel, showMeterDisplay && meterMode === 'unipolar');
  const bipolarMeterPeaks = useRecentBipolarLevels(bipolarMeterLevel, showMeterDisplay && meterMode === 'bipolar');
  const meterLevel = meterMode === 'bipolar' ? bipolarMeterLevel : unipolarMeterLevel;
  const outputMeterLeft = Math.max(0, Math.min(1, data.audioOutputMeter?.left ?? 0));
  const outputMeterRight = Math.max(0, Math.min(1, data.audioOutputMeter?.right ?? 0));
  const scopePath = showScopeDisplay ? samplesToScopePath(data.audioScope?.samples ?? [], amplitudeRange, scopeMode) : '';
  const scopeSize = showKeysDisplay
    ? clampKeysNodeSize(node.scopeSize ?? DEFAULT_KEYS_NODE_SIZE)
    : showSliderDisplay || showJoystickDisplay || showButtonDisplay
    ? clampControlNodeSize(node.scopeSize ?? (showJoystickDisplay ? DEFAULT_JOYSTICK_NODE_SIZE : DEFAULT_SCOPE_NODE_SIZE))
    : showMeterDisplay || showScopeDisplay || showFftDisplay
      ? clampScopeNodeSize(node.scopeSize ?? (showFftDisplay ? DEFAULT_FFT_NODE_SIZE : DEFAULT_SCOPE_NODE_SIZE))
    : DEFAULT_SCOPE_NODE_SIZE;
  const waveformDisplaySize = showImageDisplay
    ? clampImageNodeSize(node.scopeSize ?? DEFAULT_CUSTOM_WAVE_NODE_SIZE, imageAspectRatio)
    : showCustomWaveEditor || showSampleUpload || showBufferDisplay
      ? clampCustomWaveNodeSize(node.scopeSize ?? DEFAULT_CUSTOM_WAVE_NODE_SIZE)
      : DEFAULT_CUSTOM_WAVE_NODE_SIZE;
  const sequencerLabelColumnWidth = node.sequencerRowLabelColumnWidth ?? sequencerRowLabelColumnWidth(node.sequencerRowLabels);
  const sequencerDisplaySize = sequencer
    ? clampSequencerNodeSize(
        node.scopeSize ?? { width: sequencer.steps * 26, height: sequencer.rows * 26 },
        sequencer.steps,
        sequencer.rows,
        sequencerLabelColumnWidth,
      )
    : DEFAULT_SCOPE_NODE_SIZE;
  const rollDisplaySize = roll
    ? clampSequencerNodeSize(node.scopeSize ?? { width: roll.steps * 26 + 32, height: roll.rows.length * 22 }, roll.steps, roll.rows.length, 32)
    : DEFAULT_SCOPE_NODE_SIZE;
  const defaultDisplaySize = isExecutionArea
    ? executionAreaSize(node)
    : showSequencerDisplay
    ? sequencerDisplaySize
    : showRollDisplay
    ? rollDisplaySize
    : showCustomWaveEditor || showSampleUpload || showBufferDisplay || showImageDisplay ? waveformDisplaySize : scopeSize;
  const displaySize = usesAutoInitialWidth && autoDisplayWidth !== null
    ? { ...defaultDisplaySize, width: autoDisplayWidth }
    : defaultDisplaySize;
  const sequencerGridHeight = sequencer
    ? Math.max(1, (displaySize.width - sequencerLabelColumnWidth) * sequencer.rows / sequencer.steps)
    : 0;
  const rollGridHeight = roll ? Math.max(1, (displaySize.width - 32) * roll.rows.length / roll.steps) : 0;
  const graphDetailSize = {
    width: displaySize.width * graphZoomScale,
    height: displaySize.height * graphZoomScale,
  };
  const fftBarCount = clamp(Math.round(displaySize.width / 9), 24, 96);
  const spectrumBars = useMemo(
    () => spectrumBarsFromSamples(data.audioSpectrum?.samples ?? [], fftBarCount),
    [data.audioSpectrum?.samples, fftBarCount],
  );
  const fftMinFrequency = clamp(node.params.minFreq ?? FFT_ANALYSIS_MIN_FREQUENCY, FFT_ANALYSIS_MIN_FREQUENCY, FFT_ANALYSIS_MAX_FREQUENCY);
  const fftMaxFrequency = clamp(node.params.maxFreq ?? FFT_ANALYSIS_MAX_FREQUENCY, FFT_ANALYSIS_MIN_FREQUENCY, FFT_ANALYSIS_MAX_FREQUENCY);
  const fftWindowStart = Math.min(fftMinFrequency, fftMaxFrequency);
  const fftWindowEnd = Math.max(fftMinFrequency, fftMaxFrequency);
  const fftWindowStartFraction = frequencyScaleFraction(fftWindowStart);
  const fftWindowEndFraction = frequencyScaleFraction(fftWindowEnd);
  const meterScaleTicks = showMeterDisplay ? amplitudeScaleTicks(amplitudeRange, graphDetailSize.width, meterMode) : [];
  const meterGridTicks = showMeterDisplay
    ? chartGridColumns(graphDetailSize.width).map((tick) => ({
        ...tick,
        label: meterScaleTicks.find((scaleTick) => Math.abs(scaleTick.fraction - tick.fraction) < 0.0001)?.label,
      }))
    : [];
  const meterGridRows = showMeterDisplay ? chartGridRows(graphDetailSize.height) : [];
  const scopeScaleTicks = showScopeDisplay
    ? chartScaleTicks(amplitudeRange, scopeMode === 'bipolar' ? -amplitudeRange : 0, graphDetailSize.height, 'vertical')
    : [];
  const scopeGridTicks = showScopeDisplay ? chartGridColumns(graphDetailSize.width) : [];
  const fftGridTicks = showFftDisplay ? frequencyGridTicks(graphDetailSize.width) : [];
  const fftGridRows = showFftDisplay ? chartGridRows(graphDetailSize.height) : [];
  const nodeSizeStyle = showResizableDisplay
    ? ({
        ...(!usesAutoInitialWidth || (showSliderDisplay && autoDisplayWidth !== null)
          ? { '--node-display-width': `${displaySize.width}px` }
          : {}),
        '--node-display-height': `${displaySize.height}px`,
        ...(showImageDisplay ? { '--image-aspect-ratio': String(imageAspectRatio) } : {}),
        ...(sequencer ? {
          '--sequencer-steps': String(sequencer.steps),
          '--sequencer-rows': String(sequencer.rows),
          '--spagbol-sequencer-label-width': `${sequencerLabelColumnWidth}px`,
          '--sequencer-grid-height': `${sequencerGridHeight}px`,
        } : {}),
        ...(roll ? {
          '--roll-steps': String(roll.steps),
          '--roll-grid-height': `${rollGridHeight}px`,
        } : {}),
      } as CSSProperties)
    : undefined;
  const previewAddsOutput = Boolean(
    previewOutputPort
    && definition
    && !definition.outputs.some((output) => output.name === previewOutputPort),
  );
  const connectedInputPorts = useMemo(() => new Set(data.connectedPorts?.inputs ?? []), [data.connectedPorts?.inputs]);
  const connectedOutputPorts = useMemo(() => new Set(data.connectedPorts?.outputs ?? []), [data.connectedPorts?.outputs]);
  const setLinkInputPorts = useMemo(() => new Set(data.setLinkInputPorts ?? []), [data.setLinkInputPorts]);
  const forceCompactPorts = definition ? shouldForceCompactPorts(definition) : false;
  const compactPorts = forceCompactPorts || node.compactPorts === true;
  const revealCompactPorts = data.isOnlySelected === true || (data.isConnecting === true && pointerOver);
  const temporarilyRevealCompactPorts = compactPorts && data.isConnecting === true && pointerOver;
  const showAllPorts = !compactPorts || revealCompactPorts;

  useEffect(() => {
    data.onTemporaryPortRevealChange?.(node.id, temporarilyRevealCompactPorts);
    return () => data.onTemporaryPortRevealChange?.(node.id, false);
  }, [data.onTemporaryPortRevealChange, node.id, temporarilyRevealCompactPorts]);
  const showHeaderInput = Boolean(
    node.type !== 'Outs'
    && definition?.inputs.some((input) => input.name === 'signal')
    && previewInputPort !== 'signal',
  );
  const headerInputPort = showHeaderInput ? 'signal' : null;
  const canShowHeaderOutput = node.type !== 'Ins' && node.type !== 'Params' && node.type !== 'Sequencer' && !(node.type === 'CustomWave' && customWaveCount > 1);
  const signalOutputPort = definition?.outputs.find((output) => output.name === 'signal')?.name ?? null;
  const headerOutputPort = canShowHeaderOutput
    ? signalOutputPort ?? (outputCount === 1 && !previewAddsOutput ? definition?.outputs[0]?.name ?? null : null)
    : null;
  const showHeaderInputPort = Boolean(headerInputPort);
  const showHeaderOutputPort = Boolean(headerOutputPort);
  const selectedLinkInputs = data.selectedLinkPorts?.inputs ?? [];
  const selectedLinkOutputs = data.selectedLinkPorts?.outputs ?? [];
  const selectorSelectedIndex = isSelector
    ? Math.floor(Number.isFinite(data.audioSelectorIndex) ? data.audioSelectorIndex ?? 0 : node.params.select ?? 0)
    : 0;
  const inputLabelWidth = definition
    ? `${Math.max(0, ...definition.inputs.filter((input) => input.name !== headerInputPort).map((input) => displayPortName(input.name).length))}ch`
    : '0ch';
  const outputLabelWidth = definition
    ? `${Math.max(0, ...definition.outputs.map((output) => output.name.length))}ch`
    : '0ch';
  const nodeStyle = {
    ...(nodeSizeStyle ?? {}),
    '--input-label-width': inputLabelWidth,
    '--node-scale': String(node.scale ?? 1),
    '--canvas-header-title-scale': String(headerTitleScale),
    '--spagbol-curve-editor-point-scale': String(customWavePointScale),
    '--graph-screen-scale': String(graphScreenEmphasis / graphZoomScale),
    '--graph-stroke-scale': String(1 / graphZoomScale),
    ...(groupUiPreview ? { '--group-ui-width': `${groupUiPreview.width}px` } : {}),
    ...(isRoutingNode ? { '--routing-color': routingNodeColor(node.params.number) } : {}),
  } as CSSProperties;

  useLayoutEffect(() => {
    if (!usesAutoInitialWidth) {
      setAutoDisplayWidth(null);
      return;
    }

    const element = nodeElementRef.current;
    if (!element) return;
    const updateWidth = () => {
      // Reuse the resolved CSS width for Sliders: it is the same border-box
      // value we feed back into CSS, with no border or node-scale drift.
      const resolvedWidth = showSliderDisplay
        ? Number.parseFloat(window.getComputedStyle(element).width)
        : element.clientWidth;
      const width = Math.max(1, Number.isFinite(resolvedWidth) ? resolvedWidth : 1);
      setAutoDisplayWidth((current) => current === width ? current : width);
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, [showSliderDisplay, usesAutoInitialWidth]);

  useLayoutEffect(() => {
    const animationFrame = requestAnimationFrame(() => updateNodeInternals(flowNodeId));
    return () => cancelAnimationFrame(animationFrame);
  }, [
    compactPorts,
    isAreaCollapsedPresentation,
    isAreaUiCollapsedPresentation,
    connectedInputPorts,
    connectedOutputPorts,
    headerInputPort,
    headerTitleScale,
    inputLabelWidth,
    node.id,
    outputCount,
    outputLabelWidth,
    previewAddsOutput,
    showHeaderInputPort,
    showHeaderOutputPort,
    showAllPorts,
    showSampleVideo,
    displaySize.height,
    displaySize.width,
    node.scale,
    imageAspectRatio,
    customWave?.mode,
    customWave?.points,
    customWave?.sustainEnd,
    customWave?.sustainStart,
    sequencer?.rows,
    sequencer?.steps,
    selected,
    updateNodeInternals,
  ]);

  useEffect(() => {
    if (document.activeElement === expressionInputRef.current) return;
    setExpressionDraft(node.expression ?? '');
  }, [node.expression]);

  function commitExpressionDraft() {
    if (!isExpression) return;
    data.onExpressionCommit?.(node.id, expressionDraft);
  }

  function moveDraggedPortToTarget(side: 'input' | 'output', draggedPort: string, targetPort: string, portOrder: string[]) {
    if (draggedPort === targetPort) return;

    const fromIndex = portOrder.indexOf(draggedPort);
    const toIndex = portOrder.indexOf(targetPort);
    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return;

    const direction: -1 | 1 = fromIndex < toIndex ? 1 : -1;
    const steps = Math.abs(toIndex - fromIndex);
    for (let step = 0; step < steps; step += 1) {
      data.onPortMove(node.id, side, draggedPort, direction);
    }
  }

  useEffect(() => {
    return () => {
      const dragCommit = customWaveDragCommitRef.current;
      if (dragCommit.timeout !== null) clearTimeout(dragCommit.timeout);
      dragCommit.timeout = null;
      dragCommit.pending = null;
    };
  }, []);

  useEffect(() => {
    function handlePointerMove(event: globalThis.PointerEvent) {
      const draggedPort = draggedPortRef.current;
      if (!draggedPort || draggedPort.pointerId !== event.pointerId || !definition) return;

      const dragStart = dragStartRef.current;
      if (!dragStart) return;

      const moved = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y) > 3;
      if (!moved) return;

      event.preventDefault();
      const side = draggedPort.side;
      const portOrder = side === 'input'
        ? definition.inputs.map((port) => port.name)
        : definition.outputs.map((port) => port.name);
      const rows = side === 'input' ? inputPortRowsRef.current : outputPortRowsRef.current;

      const targets = portOrder.flatMap((port) => {
        const row = rows[port];
        if (!row) return [];
        const rect = row.getBoundingClientRect();
        return [{
          port,
          centerY: rect.top + rect.height / 2,
        }];
      });

      if (targets.length === 0) return;

      const targetPort = targets.reduce((best, current) => {
        const bestDistance = Math.abs(event.clientY - best.centerY);
        const currentDistance = Math.abs(event.clientY - current.centerY);
        return currentDistance < bestDistance ? current : best;
      }).port;

      setDragSource((current) => current ?? { side, port: draggedPort.port });
      setDragTarget({ side, port: targetPort });
      moveDraggedPortToTarget(side, draggedPort.port, targetPort, portOrder);
    }

    function stopDragging(pointerId: number) {
      if (!draggedPortRef.current || draggedPortRef.current.pointerId !== pointerId) return;

      draggedPortRef.current = null;
      dragStartRef.current = null;
      setDragSource(null);
      setDragTarget(null);
    }

    function handlePointerUp(event: globalThis.PointerEvent) {
      stopDragging(event.pointerId);
    }

    function handlePointerCancel(event: globalThis.PointerEvent) {
      stopDragging(event.pointerId);
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [definition, node.id]);

  useEffect(() => {
    function handlePointerMove(event: globalThis.PointerEvent) {
      const resize = scopeResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) return;

      event.preventDefault();
      const deltaX = (event.clientX - resize.startPointer.x) / resize.coordinateScale;
      const deltaY = (event.clientY - resize.startPointer.y) / resize.coordinateScale;
      const rawWidth = resize.corner === 'bottom-left'
        ? resize.startSize.width - deltaX
        : resize.startSize.width + deltaX;
      const constrainedWidth = resize.minWidth === undefined ? rawWidth : Math.max(resize.minWidth, rawWidth);
      const rawNextSize = { width: constrainedWidth, height: resize.startSize.height + deltaY };
      const nextSize = showSequencerDisplay && sequencer
        ? clampSequencerNodeSize({ width: constrainedWidth, height: constrainedWidth * sequencer.rows / sequencer.steps }, sequencer.steps, sequencer.rows, sequencerLabelColumnWidth)
        : showRollDisplay && roll
        ? clampSequencerNodeSize({ width: constrainedWidth, height: constrainedWidth * roll.rows.length / roll.steps }, roll.steps, roll.rows.length, 32)
        : showImageDisplay
        ? clampImageNodeSize({ width: rawWidth, height: rawWidth / imageAspectRatio }, imageAspectRatio)
        : showCustomWaveEditor || showSampleUpload || showBufferDisplay
        ? clampCustomWaveNodeSize(rawNextSize)
        : showKeysDisplay
          ? clampKeysNodeSize(rawNextSize)
        : showSliderDisplay || showJoystickDisplay || showButtonDisplay
          ? clampControlNodeSize(rawNextSize)
          : clampScopeNodeSize(rawNextSize);
      const previousSize = resize.lastSize;
      resize.lastSize = nextSize;
      data.onScopeResize(node.id, nextSize, resize.corner === 'bottom-left' ? 'left' : 'right', previousSize);
    }

    function stopResizing(pointerId: number) {
      if (!scopeResizeRef.current || scopeResizeRef.current.pointerId !== pointerId) return;

      scopeResizeRef.current = null;
      setScopeResizeCorner(null);
    }

    function handlePointerUp(event: globalThis.PointerEvent) {
      stopResizing(event.pointerId);
    }

    function handlePointerCancel(event: globalThis.PointerEvent) {
      stopResizing(event.pointerId);
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
  }, [data, imageAspectRatio, node.id, reactFlow, roll, sequencer, sequencerLabelColumnWidth, showBufferDisplay, showCustomWaveEditor, showSampleUpload, showImageDisplay, showRollDisplay, showSequencerDisplay, showSliderDisplay, showJoystickDisplay, showButtonDisplay, showKeysDisplay]);

  useEffect(() => {
    setImageAspectRatio(DEFAULT_IMAGE_ASPECT_RATIO);
  }, [node.image?.url]);

  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget;
    const aspect = image.naturalWidth / Math.max(1, image.naturalHeight);
    if (!Number.isFinite(aspect) || aspect <= 0) return;
    setImageAspectRatio(aspect);
    const width = node.scopeSize?.width ?? DEFAULT_CUSTOM_WAVE_NODE_SIZE.width;
    data.onScopeResize(node.id, clampImageNodeSize({ width, height: width / aspect }, aspect), 'right');
  }

  function handlePortPointerDown(
    event: PointerEvent<HTMLSpanElement>,
    side: 'input' | 'output',
    port: string,
  ) {
    if (event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    data.onPortSelect?.(node.id, side, port);
    draggedPortRef.current = { side, port, pointerId: event.pointerId };
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    setDragSource(null);
    setDragTarget(null);
  }

  function handleScopeResizePointerDown(
    event: PointerEvent<HTMLSpanElement>,
    corner: 'bottom-left' | 'bottom-right',
  ) {
    if (isAreaUiCollapsedPresentation || event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const sequencerBody = event.currentTarget.closest('.spagbol-node-frame');
    const hasVisibleSequencerInputs = !!sequencerBody?.querySelector('.spagbol-node-port-row-input');
    const hasVisibleSequencerOutputs = !!sequencerBody?.querySelector('.spagbol-node-port-row-output');
    const coordinateScale = Math.max(0.0001, (reactFlow.getZoom() || 1) * (node.scale ?? 1));
    const sequencerMinWidth = hasVisibleSequencerInputs && hasVisibleSequencerOutputs
      ? Math.max(240, sequencerLabelColumnWidth + (sequencer?.steps ?? 1) * SEQUENCER_MIN_CELL_SIZE)
      : undefined;
    const renderedWidth = usesAutoInitialWidth
      ? showSliderDisplay
        ? autoDisplayWidth ?? (nodeElementRef.current
          ? Number.parseFloat(window.getComputedStyle(nodeElementRef.current).width)
          : undefined)
        : nodeElementRef.current?.clientWidth
      : undefined;
    const startSize = renderedWidth && renderedWidth > 0
      ? { ...displaySize, width: renderedWidth }
      : displaySize;
    scopeResizeRef.current = {
      pointerId: event.pointerId,
      corner,
      startPointer: { x: event.clientX, y: event.clientY },
      startSize,
      lastSize: startSize,
      coordinateScale,
      minWidth: sequencerMinWidth
        ?? (isExecutionArea
          ? (isSpawn ? MIN_SPAWN_WIDTH : MIN_EXECUTION_AREA_WIDTH)
          : undefined),
    };
    setScopeResizeCorner(corner);
  }

  function handleScopeResizeClick(event: MouseEvent<HTMLSpanElement>) {
    event.preventDefault();
    event.stopPropagation();
  }

  function handleSampleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!showSampleUpload || !hasDraggedFiles(event)) return;

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  }

  function handleSampleDrop(event: DragEvent<HTMLDivElement>) {
    if (!showSampleUpload || event.dataTransfer.files.length === 0) return;

    event.preventDefault();
    event.stopPropagation();
    data.onSampleDrop?.(node.id, event.dataTransfer.files);
  }

  function updateFftBoundaryFromPointer(event: Pick<PointerEvent<HTMLElement>, 'clientX'>) {
    const drag = fftBoundaryDragRef.current;
    const bounds = fftDisplayRef.current?.getBoundingClientRect();
    if (!drag || !bounds || bounds.width <= 0) return;

    const fraction = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
    const frequency = Math.round(
      FFT_ANALYSIS_MIN_FREQUENCY
      * (FFT_ANALYSIS_MAX_FREQUENCY / FFT_ANALYSIS_MIN_FREQUENCY) ** fraction,
    );
    if (drag.boundary === 'min') {
      const maxFrequency = clamp(node.params.maxFreq ?? FFT_ANALYSIS_MAX_FREQUENCY, FFT_ANALYSIS_MIN_FREQUENCY, FFT_ANALYSIS_MAX_FREQUENCY);
      data.onParamChange(node.id, 'minFreq', Math.min(frequency, maxFrequency));
    } else {
      const minFrequency = clamp(node.params.minFreq ?? FFT_ANALYSIS_MIN_FREQUENCY, FFT_ANALYSIS_MIN_FREQUENCY, FFT_ANALYSIS_MAX_FREQUENCY);
      data.onParamChange(node.id, 'maxFreq', Math.max(frequency, minFrequency));
    }
  }

  function handleFftBoundaryPointerDown(event: PointerEvent<HTMLSpanElement>, boundary: 'min' | 'max') {
    event.preventDefault();
    event.stopPropagation();
    fftBoundaryDragRef.current = { boundary, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    updateFftBoundaryFromPointer(event);
  }

  function handleFftBoundaryPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (fftBoundaryDragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateFftBoundaryFromPointer(event);
  }

  function finishFftBoundaryDrag(pointerId: number) {
    if (fftBoundaryDragRef.current?.pointerId === pointerId) fftBoundaryDragRef.current = null;
  }

  function commitCustomWave(nextCustomWave: CustomWaveSettings, historyKey?: string) {
    const waves = Array.from({ length: customWaveCount }, (_, index) => (
      index === selectedWaveIndex ? normalizeCustomWave(nextCustomWave) : customWaveBankValues[index] ?? normalizeCustomWave(undefined)
    ));
    const [firstWave, ...additionalWaves] = waves;
    data.onCustomWaveChange?.(node.id, { ...firstWave, ...(additionalWaves.length ? { waves: additionalWaves } : {}) }, historyKey);
  }

  function scheduleCustomWaveDragCommit(nextCustomWave: CustomWaveSettings, historyKey: string) {
    const dragCommit = customWaveDragCommitRef.current;
    const now = performance.now();
    dragCommit.pending = { customWave: nextCustomWave, historyKey };

    const elapsed = now - dragCommit.lastCommitTime;
    if (elapsed >= CUSTOM_WAVE_DRAG_UPDATE_INTERVAL_MS) {
      flushCustomWaveDragCommit(now);
      return;
    }

    if (dragCommit.timeout !== null) return;
    dragCommit.timeout = setTimeout(() => {
      dragCommit.timeout = null;
      flushCustomWaveDragCommit();
    }, CUSTOM_WAVE_DRAG_UPDATE_INTERVAL_MS - elapsed);
  }

  function flushCustomWaveDragCommit(commitTime = performance.now()) {
    const dragCommit = customWaveDragCommitRef.current;
    if (dragCommit.timeout !== null) clearTimeout(dragCommit.timeout);
    dragCommit.timeout = null;

    const pending = dragCommit.pending;
    if (!pending) return;
    dragCommit.pending = null;
    dragCommit.lastCommitTime = commitTime;
    commitCustomWave(pending.customWave, pending.historyKey);
  }

  function insertCustomWavePoint(point: CustomWavePoint): number | null {
    if (!customWave) return null;
    const nextPoints = [...customWave.points, point].sort((a, b) => a.x - b.x);
    const index = nextPoints.indexOf(point);
    commitCustomWave({ ...customWave, points: nextPoints }, `custom-wave-point:${node.id}`);
    return index;
  }

  function moveCustomWavePoint(index: number, point: CustomWavePoint) {
    if (!customWave) return;
    scheduleCustomWaveDragCommit({ ...customWave, points: customWave.points.map((entry, i) => i === index ? point : entry) }, `custom-wave-point:${node.id}`);
  }

  function removeCustomWavePoint(index: number) {
    if (!customWave || index <= 0 || index >= customWave.points.length - 1) return;
    flushCustomWaveDragCommit();
    commitCustomWave({ ...customWave, points: customWave.points.filter((_, i) => i !== index) }, `custom-wave-point:${node.id}`);
  }

  if (isExecutionArea) {
    return (
      <div
        className={`spread-port-panel${isAreaUiCollapsedPresentation ? ' spread-port-panel-collapsed' : ''}`}
        style={{
          '--spread-port-width': `${displaySize.width}px`,
          '--spread-port-height': `${executionAreaPortsHeight(node)}px`,
          '--spread-header-height': `${SPREAD_HEADER_HEIGHT}px`,
          '--node-scale': String(node.scale ?? 1),
        } as CSSProperties}
      >
        {isSpawn ? (
          <div className="spawn-port-inputs">
            <div className="spawn-port-input">
              <Handle
                id="in:trigger"
                type="target"
                position={Position.Left}
                className={[
                  'teia-handle teia-handle-input spread-count-handle spawn-trigger-handle',
                  selectedLinkInputs.includes('trigger') ? 'teia-handle-selected-link' : '',
                ].filter(Boolean).join(' ')}
              />
              <span>trigger</span>
            </div>
            <div className="spawn-port-input">
              <Handle
                id="in:release trigger"
                type="target"
                position={Position.Left}
                className={[
                  'teia-handle teia-handle-input spread-count-handle spawn-release-trigger-handle',
                  selectedLinkInputs.includes('release trigger') ? 'teia-handle-selected-link' : '',
                ].filter(Boolean).join(' ')}
              />
              <span>release trigger</span>
            </div>
          </div>
        ) : (
          <div className="spread-port-input">
            <Handle
              id={isConditional ? 'in:gate' : 'in:count'}
              type="target"
              position={Position.Left}
              className={[
                'teia-handle teia-handle-input spread-count-handle',
                selectedLinkInputs.includes(isConditional ? 'gate' : 'count') ? 'teia-handle-selected-link' : '',
              ].filter(Boolean).join(' ')}
            />
            <span>{isConditional ? 'gate' : 'count'}</span>
            <NumericScrubber
              value={isConditional ? (node.params.gate ?? 0) : (node.params.count ?? 1)}
              min={isConditional ? undefined : 0}
              integer={!isConditional}
              replacedBySetLink={setLinkInputPorts.has(isConditional ? 'gate' : 'count')}
              onChange={(value) => data.onParamChange(node.id, isConditional ? 'gate' : 'count', value)}
            />
          </div>
        )}
        {!isAreaUiCollapsedPresentation && !isConditional ? (
          <>
            {isSpawn ? (
              <div className="spread-port-output spawn-instance-gate-port">
                <span>instance gate</span>
                <Handle
                  id="out:instance gate"
                  type="source"
                  position={Position.Bottom}
                  className={[
                    'teia-handle teia-handle-output spread-item-index-handle',
                    selectedLinkOutputs.includes('instance gate') ? 'teia-handle-selected-link' : '',
                  ].filter(Boolean).join(' ')}
                />
              </div>
            ) : null}
            <div className={`spread-port-output${isSpawn ? ' spawn-kill-trigger-port' : ''}`}>
              <Handle
                id={isSpawn ? 'in:kill trigger' : 'out:item index'}
                type={isSpawn ? 'target' : 'source'}
                position={Position.Bottom}
                className={[
                  `teia-handle ${isSpawn ? 'teia-handle-input' : 'teia-handle-output'} spread-item-index-handle`,
                  (isSpawn
                    ? selectedLinkInputs.includes('kill trigger')
                  : selectedLinkOutputs.includes('item index')) ? 'teia-handle-selected-link' : '',
                ].filter(Boolean).join(' ')}
              />
              <span>{isSpawn ? 'kill trigger' : 'item index'}</span>
            </div>
          </>
        ) : null}
      </div>
    );
  }

  if (isRoutingNode && !selected) {
    const isSend = node.type === 'Send';
    const number = routingNodeNumber(node.params.number);
    return (
      <div
        ref={nodeElementRef}
        className={[
          'routing-node-marker spagbol-canvas-drag-handle',
          fm1Unsupported ? 'teia-node-fm1-unsupported' : '',
          `routing-node-marker-${isSend ? 'send' : 'receive'}`,
          connectionInProgress ? 'routing-node-drop-active' : '',
          data.routingHighlighted === true ? 'routing-node-marker-highlighted' : '',
          node.enabled === false ? 'routing-node-marker-disabled' : '',
        ].filter(Boolean).join(' ')}
        style={nodeStyle}
        title={`${isSend ? 'Send' : 'Receive'} ${number}`}
        aria-label={`${isSend ? 'Send' : 'Receive'} ${number}`}
      >
        <Handle id={isSend ? 'virtual:send' : 'virtual:receive'} type={isSend ? 'source' : 'target'} position={isSend ? Position.Right : Position.Left} isConnectable={false} className="virtual-route-handle" />
        <span className="routing-node-number" aria-hidden="true">{number}</span>
        <Handle
          id={`${isSend ? 'in' : 'out'}:signal`}
          type={isSend ? 'target' : 'source'}
          position={isSend ? Position.Left : Position.Right}
          className="routing-node-handle"
        />
      </div>
    );
  }

  if (!definition) return null;
  function portContent(port: import('@pauloricca/spagbol').PortDefinition) {
    const name = portName(shared.node, port.id, port.direction);
    if (port.direction === 'input') {
      const input = { ...definition!.inputs.find(input => input.name === name)!, preview: false };
      return <div className="teia-node-parameter">              {isSelector && isSelectorValuePort(input.name) && !input.preview ? (
                <button
                  className={[
                    'selector-index-button nodrag nopan',
                    selectorSelectedIndex === Number(input.name) ? 'selector-index-button-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  title={`Select input ${input.name}`}
                  onPointerDown={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    data.onParamChange(node.id, 'select', Number(input.name));
                  }}
                >
                  {input.name}
                </button>
              ) : node.type === 'Reverb' && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="Reverb mode"
                    value={String(Math.round(node.params.mode ?? input.defaultValue ?? 0))}
                    onChange={(event) => {
                      data.onParamChange(node.id, 'mode', Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">original</option>
                    <option value="1">dattorro plate</option>
                    <option value="2">feedback delay network</option>
                  </select>
                </>
              ) : showKeysDisplay && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="Keys mode"
                    value={String(Math.round(node.params.mode ?? input.defaultValue ?? 0))}
                    onChange={(event) => {
                      data.onParamChange(node.id, 'mode', Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">gate</option>
                    <option value="1">hold</option>
                  </select>
                </>
              ) : showCustomWaveEditor && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="Custom Wave mode"
                    value={customWave?.mode ?? CUSTOM_WAVE_MODES[0].value}
                    onChange={(event) => {
                      if (customWave) commitCustomWave({ ...customWave, mode: event.currentTarget.value as CustomWaveSettings['mode'] }, `custom-wave-mode:${node.id}`);
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    {CUSTOM_WAVE_MODES.map((mode) => (
                      <option key={mode.value} value={mode.value}>{mode.label}</option>
                    ))}
                  </select>
                </>
              ) : showSliderDisplay && input.name === 'direction' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    value={String(Math.round(node.params.direction ?? input.defaultValue ?? 0))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">horizontal</option>
                    <option value="1">vertical</option>
                  </select>
                </>
              ) : showSequencerDisplay && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="Sequencer mode"
                    value={sequencerUsesGateMode(node.params) ? '1' : '0'}
                    onChange={(event) => {
                      const gateMode = Number(event.currentTarget.value) >= 0.5;
                      const values: Record<string, number> = {
                        [SEQUENCER_GATE_MODE_PARAM]: gateMode ? 1 : 0,
                      };
                      if (gateMode) {
                        values[SEQUENCER_GATE_INITIALIZED_PARAM] = 1;
                        for (let rowIndex = 0; rowIndex < (sequencer?.rows ?? 0); rowIndex += 1) {
                          const triggers = sequencerTriggersForRow(node.params, rowIndex, sequencer?.steps ?? 0);
                          for (let stepIndex = 0; stepIndex < (sequencer?.steps ?? 0); stepIndex += 1) {
                            values[sequencerGateParamName(rowIndex, stepIndex, 'active')] = 0;
                          }
                          const convertedGates = trimOverlappingSequencerGates(triggers.map((trigger, slot) => {
                            const start = Math.min(sequencer?.steps ?? 0, trigger.position);
                            return { slot, start, end: Math.min(sequencer?.steps ?? 0, start + 1), velocity: trigger.velocity };
                          }));
                          for (const gate of convertedGates) {
                            const { slot, start, end } = gate;
                            values[sequencerGateParamName(rowIndex, slot, 'active')] = 1;
                            values[sequencerGateParamName(rowIndex, slot, 'start')] = start;
                            values[sequencerGateParamName(rowIndex, slot, 'end')] = end;
                            values[sequencerStepVelocityParamName(rowIndex, slot)] = gate.velocity;
                          }
                        }
                      } else {
                        for (let rowIndex = 0; rowIndex < (sequencer?.rows ?? 0); rowIndex += 1) {
                          const gates = sequencerGatesForRow(node.params, rowIndex, sequencer?.steps ?? 0);
                          for (let stepIndex = 0; stepIndex < (sequencer?.steps ?? 0); stepIndex += 1) {
                            values[sequencerCellParamName(rowIndex, stepIndex)] = 0;
                            values[sequencerGateParamName(rowIndex, stepIndex, 'active')] = 0;
                          }
                          for (const [slot, gate] of gates.entries()) {
                            const position = Math.max(0, Math.min((sequencer?.steps ?? 1) - SEQUENCER_TRIGGER_GRAB_FRACTION, gate.start));
                            values[sequencerCellParamName(rowIndex, slot)] = 1;
                            values[sequencerTriggerPositionParamName(rowIndex, slot)] = position;
                          }
                        }
                      }
                      data.onParamsChange(node.id, values);
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">trigger</option>
                    <option value="1">gate</option>
                  </select>
                </>
              ) : (showMeterDisplay || showScopeDisplay) && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label={`${showMeterDisplay ? 'Meter' : 'Scope'} mode`}
                    value={String(Math.round(node.params.mode ?? input.defaultValue ?? 0))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">unipolar</option>
                    <option value="1">bipolar</option>
                  </select>
                </>
              ) : showScopeDisplay && input.name === 'reset' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="Scope reset"
                    value={String(Math.round(node.params.reset ?? input.defaultValue ?? 1))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">none</option>
                    <option value="1">zero-crossing</option>
                  </select>
                </>
              ) : showSampleUpload && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    value={String(Math.round(node.params.mode ?? input.defaultValue ?? 0))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">one-shot</option>
                    <option value="1">loop</option>
                    <option value="2">ping-pong</option>
                  </select>
                </>
              ) : showBufferDisplay && input.name === 'on reset' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="Buffer on reset"
                    value={String(clamp(Math.round(node.params['on reset'] ?? input.defaultValue ?? 0), 0, 1))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">clear</option>
                    <option value="1">preserve</option>
                  </select>
                </>
              ) : showTempoDisplay && input.name === 'source' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="Tempo source"
                    value={String(clamp(Math.round(node.params.source ?? input.defaultValue ?? 0), 0, 1))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">internal</option>
                    <option value="1">midi</option>
                  </select>
                </>
              ) : showTempoDisplay && input.name === 'midiSource' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="MIDI clock source"
                    value={String(clamp(Math.round(node.params.midiSource ?? input.defaultValue ?? 0), 0, Math.max(0, data.midiInput?.devices.length ?? 0)))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">any midi</option>
                    {(data.midiInput?.devices ?? []).map((device, index) => (
                      <option key={device.id || `${device.label}-${index}`} value={index + 1}>
                        {device.label || `MIDI ${index + 1}`}
                      </option>
                    ))}
                  </select>
                </>
              ) : showButtonDisplay && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    value={String(Math.round(node.params.mode ?? input.defaultValue ?? 0))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">toggle</option>
                    <option value="1">trigger</option>
                    <option value="2">temporary</option>
                  </select>
                </>
              ) : showAccumulatorDisplay && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label="Accumulator mode"
                    value={String(Math.round(node.params.mode ?? input.defaultValue ?? 0))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <option value="0">trigger</option>
                    <option value="1">continuous</option>
                  </select>
                </>
              ) : (showQuantiseDisplay || showRollDisplay) && input.name === 'scale' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label={`${node.type} scale`}
                    value={String(clamp(Math.round(node.params.scale ?? input.defaultValue ?? 0), 0, QUANTISE_SCALES.length - 1))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    {QUANTISE_SCALES.map((scale, index) => (
                      <option key={scale.label} value={index}>{scale.label}</option>
                    ))}
                  </select>
                </>
              ) : showQuantiseDisplay && input.name === 'root' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={port.label}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="teia-port-select nodrag nopan"
                    aria-label={`${node.type} root`}
                    value={String(normalisePitchClass(node.params.root ?? input.defaultValue ?? 0))}
                    onChange={(event) => {
                      data.onParamChange(node.id, input.name, Number(event.currentTarget.value));
                      event.currentTarget.blur();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    {PITCH_CLASSES.map((pitchClass, note) => (
                      <option key={pitchClass} value={note}>{pitchClass}</option>
                    ))}
                  </select>
                </>
              ) : showRollDisplay && input.name === 'middle note' && !input.preview ? (
                <NoteRangeSelect
                  label={input.name}
                  value={node.params[input.name] ?? input.defaultValue ?? 60}
                  min={0}
                  max={127}
                  onChange={(value) => data.onParamChange(node.id, input.name, value)}
                />
              ) : (
                <PortNameLabel
                  name={port.label}
                  editable={canRenameInputs && !input.preview}
                  draggable={canRenameInputs && !input.preview}
                  preview={input.preview}
                  selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                  activeDragTarget={dragTarget?.side === 'input' && dragTarget.port === input.name}
                  activeDragSource={dragSource?.side === 'input' && dragSource.port === input.name}
                  onPointerDown={(event) => {
                    if (input.preview) return;
                    if (!canRenameInputs) return;
                    handlePortPointerDown(event, 'input', input.name);
                  }}
                  onChange={(nextName) => data.onPortNameChange(node.id, 'input', input.name, nextName)}
                />
              )}
              {!input.preview && node.type !== 'Outs' && input.valueEditor !== false && input.defaultValue !== undefined && !(showKeysDisplay && input.name === 'mode') && !(showCustomWaveEditor && input.name === 'mode') && !(showSliderDisplay && input.name === 'direction') && !(showSequencerDisplay && input.name === 'mode') && !(showButtonDisplay && input.name === 'mode') && !(showAccumulatorDisplay && input.name === 'mode') && !(showQuantiseDisplay && (input.name === 'scale' || input.name === 'root')) && !(showSampleUpload && input.name === 'mode') && !(showTempoDisplay && (input.name === 'source' || input.name === 'midiSource')) ? (
                <NumericScrubber
                  value={node.params[input.name] ?? input.defaultValue ?? 0}
                  min={input.min}
                  max={input.max}
                  integer={input.integer}
                  step={input.step}
                  replacedBySetLink={setLinkInputPorts.has(input.name)}
                  onChange={(value) => data.onParamChange(node.id, input.name, value)}
                  onClear={isSelector && isSelectorValuePort(input.name) ? () => data.onSelectorInputClear?.(node.id, input.name) : undefined}
                  midiLearnEvent={canLearnMidiCc(node.type, input.name) ? data.midiInput?.lastControlChange : undefined}
                  onEditStart={canLearnMidiCc(node.type, input.name) ? () => {
                    void data.onMidiInputRefresh?.();
                  } : undefined}
                  onMidiLearn={canLearnMidiCc(node.type, input.name) ? (event) => {
                    data.onParamChange(node.id, input.name, event.cc);
                    if (node.type === 'Slider' || node.type === 'Button') {
                      data.onParamChange(node.id, 'midiChannel', event.channel);
                    } else if (node.type === 'Joystick') {
                      data.onParamChange(node.id, input.name === 'xMidiCc' ? 'xMidiChannel' : 'yMidiChannel', event.channel);
                    } else if (node.type === 'MidiCc') {
                      data.onParamChange(node.id, 'channel', event.channel);
                    }
                  } : undefined}
                />
              ) : null}</div>;
    }
    const output = { ...definition!.outputs.find(output => output.name === name)!, preview: false };
    return <div className="teia-node-parameter">                <PortNameLabel
                name={port.label}
                editable={canRenameOutputs && !output.preview}
                draggable={canRenameOutputs && !output.preview}
                  preview={output.preview}
                  selected={data.selectedPort?.side === 'output' && data.selectedPort.name === output.name}
                  activeDragTarget={dragTarget?.side === 'output' && dragTarget.port === output.name}
                  activeDragSource={dragSource?.side === 'output' && dragSource.port === output.name}
                  onPointerDown={(event) => {
                    if (output.preview) return;
                    if (!canRenameOutputs) return;
                    handlePortPointerDown(event, 'output', output.name);
                  }}
                  onChange={(nextName) => data.onPortNameChange(node.id, 'output', output.name, nextName)}
                />
                {!output.preview && (node.type === 'Ins' || node.type === 'Params') && output.valueEditor !== false ? (
                  <div className={node.type === 'Params' ? 'teia-params-values' : undefined}>
                    <NumericScrubber
                      value={node.params[output.name] ?? output.defaultValue ?? 0}
                      min={node.type === 'Ins' ? output.min : undefined}
                      max={node.type === 'Ins' ? output.max : undefined}
                      integer={output.integer}
                      onChange={(value) => data.onParamChange(node.id, output.name, value)}
                    />
                    {node.type === 'Params' ? (['min', 'max'] as const).map((bound) => (
                      <NumericScrubber
                        key={bound}
                        value={output[bound] ?? (bound === 'min' ? 0 : 1)}
                        onChange={(value) => data.onParamRangeChange?.(node.id, output.name, bound, value)}
                      />
                    )) : null}
                  </div>
                ) : null}
</div>;
  }
  const frameStyle: CSSProperties = { ...nodeStyle, ...(showResizableDisplay && (!usesAutoInitialWidth || (showSliderDisplay && autoDisplayWidth !== null)) ? { width: displaySize.width } : {}) };
  const resizeControls = <>          {showResizableDisplay && !isCanvasLocked && !isAreaUiCollapsedPresentation ? (
            <>
              <span
                className={[
                  'audio-node-scope-resize-handle audio-node-scope-resize-handle-left nodrag nopan',
                  scopeResizeCorner === 'bottom-left' ? 'audio-node-scope-resize-handle-active' : '',
                ].filter(Boolean).join(' ')}
                title={showSequencerDisplay ? 'Resize sequencer' : showCustomWaveEditor ? 'Resize custom wave' : showSampleUpload ? 'Resize sample waveform' : showBufferDisplay ? 'Resize buffer waveform' : showImageDisplay ? 'Resize image' : showKeysDisplay ? 'Resize keys' : showSliderDisplay ? 'Resize slider' : showJoystickDisplay ? 'Resize joystick' : showButtonDisplay ? 'Resize button' : showMeterDisplay ? 'Resize meter' : showFftDisplay ? 'Resize FFT' : 'Resize scope'}
                onPointerDown={(event) => handleScopeResizePointerDown(event, 'bottom-left')}
                onClick={handleScopeResizeClick}
                onDoubleClick={(event) => event.stopPropagation()}
              />
              <span
                className={[
                  'audio-node-scope-resize-handle audio-node-scope-resize-handle-right nodrag nopan',
                  scopeResizeCorner === 'bottom-right' ? 'audio-node-scope-resize-handle-active' : '',
                ].filter(Boolean).join(' ')}
                title={showSequencerDisplay ? 'Resize sequencer' : showCustomWaveEditor ? 'Resize custom wave' : showSampleUpload ? 'Resize sample waveform' : showBufferDisplay ? 'Resize buffer waveform' : showImageDisplay ? 'Resize image' : showKeysDisplay ? 'Resize keys' : showSliderDisplay ? 'Resize slider' : showJoystickDisplay ? 'Resize joystick' : showButtonDisplay ? 'Resize button' : showMeterDisplay ? 'Resize meter' : showFftDisplay ? 'Resize FFT' : 'Resize scope'}
                onPointerDown={(event) => handleScopeResizePointerDown(event, 'bottom-right')}
                onClick={handleScopeResizeClick}
                onDoubleClick={(event) => event.stopPropagation()}
              />
            </>
          ) : null}</>;
  return <SpagbolNodeFrame {...shared} forceCompact={forceCompactPorts} portsHeader={node.type === 'Params' ? <div className="teia-params-columns" aria-hidden="true"><span>default</span><span>min</span><span>max</span></div> : undefined} rootRef={nodeElementRef} headerOutput={node.type !== "Params" && !showSequencerDisplay} portVisible={port => !showSequencerDisplay || port.direction !== "output" || portName(shared.node, port.id, "output") === SEQUENCER_INDEX_OUTPUT} style={frameStyle} overlay={resizeControls} className={[node.type === 'Params' ? 'teia-node-params' : '', fm1Unsupported || hostedUnsupported ? 'teia-node-unsupported' : ''].filter(Boolean).join(' ')} renderPortContent={portContent} portExtras={isSelector ? <button type="button" className="selector-add-input-button nodrag nopan" onClick={() => data.onSelectorInputAdd?.(node.id)}>+</button> : null}>
    <div className="teia-node-content" onPointerEnter={() => setPointerOver(true)} onPointerLeave={() => setPointerOver(false)} onDragOver={handleSampleDragOver} onDrop={handleSampleDrop}>
          {isRoutingNode ? <Handle id={node.type === 'Send' ? 'virtual:send' : 'virtual:receive'} type={node.type === 'Send' ? 'source' : 'target'} position={node.type === 'Send' ? Position.Right : Position.Left} isConnectable={false} /> : null}
          {isExpression ? (
            <input
              ref={expressionInputRef}
              aria-label="GLSL expression"
              className="expression-editor nodrag nopan nowheel"
              spellCheck={false}
              type="text"
              value={expressionDraft}
              onChange={(event) => setExpressionDraft(event.currentTarget.value)}
              onBlur={() => {
                if (skipNextExpressionBlurRef.current) {
                  skipNextExpressionBlurRef.current = false;
                  return;
                }
                commitExpressionDraft();
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  commitExpressionDraft();
                  skipNextExpressionBlurRef.current = true;
                  event.currentTarget.blur();
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
          ) : null}
          <div className={showTopGraphic ? 'teia-node-content-graphic' : 'teia-node-content-graphic-empty'}>
          {showSampleUpload ? (
            <SampleWaveformDisplay
              sampleUrl={node.sample?.url}
              playheads={data.audioPlayheads}
              start={data.audioSampleParams?.start ?? node.params.start ?? 0}
              end={data.audioSampleParams?.end ?? node.params.end ?? 1}
              attack={data.audioSampleParams?.attack ?? node.params.attack ?? 0}
              release={data.audioSampleParams?.release ?? node.params.release ?? 0}
              detail={Math.max(120, Math.round(displaySize.width))}
              onStartChange={(value) => data.onParamChange(node.id, 'start', value)}
              onEndChange={(value) => data.onParamChange(node.id, 'end', value)}
            />
          ) : null}
          {showBufferDisplay ? (
            <BufferWaveformDisplay
              bins={data.audioBuffer?.bins ?? []}
              playhead={data.audioBuffer?.playhead ?? normalizeUnitInterval(node.params.playhead ?? 0)}
              recordHead={data.audioBuffer?.recordHead ?? normalizeUnitInterval(node.params['record head'] ?? 0)}
              detail={Math.max(120, Math.round(displaySize.width))}
              onClear={data.onBufferClear}
            />
          ) : null}
          {showSampleUpload ? (
            <div className="sample-upload-row">
              <button
                className="sample-upload-button nodrag nopan"
                type="button"
                title={node.sample?.name ?? 'Select sample'}
                onClick={() => data.onSampleSelect?.(node.id)}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {node.sample?.name ?? 'Select sample'}
              </button>
            </div>
          ) : null}
          {showImageDisplay ? (
            <div className="teia-node-full-width-display image-node-display nodrag nopan" aria-label={node.image?.url ? 'Image coordinate preview' : 'Image preview'}>
              {imagePreviewUrl ? <img src={imagePreviewUrl} alt={node.image?.name ?? 'Host image preview'} draggable={false} onLoad={handleImageLoad} /> : <span>{hostedMode ? 'Image preview requires host data' : 'Select an image'}</span>}
              {imagePreviewUrl ? <>
                <i className="image-node-crosshair image-node-crosshair-vertical" style={{ left: `calc(${imageX} * (100% - 1px))` }} />
                <i className="image-node-crosshair image-node-crosshair-horizontal" style={{ top: `calc(${imageY} * (100% - 1px))` }} />
              </> : null}
            </div>
          ) : null}
          {showImageDisplay ? (
            <div className="sample-upload-row">
              <button className="sample-upload-button nodrag nopan" type="button" title={node.image?.name ?? 'Select image'} onClick={() => data.onImageSelect?.(node.id)} onPointerDown={(event) => event.stopPropagation()}>
                {node.image?.name ?? 'Select image'}
              </button>
            </div>
          ) : null}
          {showAudioInputDisplay ? (
            <AudioInputDisplay
              state={data.audioInput}
              muted={Math.round(node.params.muted ?? 0) === 1}
              onMutedChange={(muted) => data.onParamChange(node.id, 'muted', muted ? 1 : 0)}
              onDeviceChange={(deviceId) => data.onAudioInputDeviceChange?.(deviceId)}
              onRefresh={() => data.onAudioInputRefresh?.()}
            />
          ) : null}
          {showCustomWaveEditor && customWave ? (
            <CustomWaveEditor
              customWave={customWave}
              waves={customWaveBankValues.slice(0, customWaveCount)}
              selectedWaveIndex={selectedWaveIndex}
              onWaveSelect={setSelectedCustomWaveIndex}
              subdivisions={node.params.subdivisions ?? 8}
              subgroups={node.params.subgroups ?? 4}
              baseLevel={node.params.baseLevel ?? 0}
              rangeMin={node.params.rangeMin ?? -1}
              rangeMax={node.params.rangeMax ?? 1}
              frequency={data.audioCustomWaveFrequency ?? node.params.frequency ?? 220}
              hasLivePlayheads={Boolean(data.audioPlayheads?.length)}
              playheads={customWavePlayheads}
              compact={!showAllPorts}
              displaySize={displaySize}
              graphZoomScale={graphZoomScale}
              graphScreenEmphasis={graphScreenEmphasis}
              onInsertPoint={insertCustomWavePoint}
              onMovePoint={moveCustomWavePoint}
              onRemovePoint={removeCustomWavePoint}
              onGestureEnd={() => flushCustomWaveDragCommit()}
              onSustainStartChange={(sustainStart) => {
                commitCustomWave({
                  ...customWave,
                  sustainStart: clamp(sustainStart, 0, customWave.sustainEnd - 0.001),
                }, `custom-wave-sustain:${node.id}`);
              }}
              onSustainEndChange={(sustainEnd) => {
                commitCustomWave({
                  ...customWave,
                  sustainEnd: clamp(sustainEnd, customWave.sustainStart + 0.001, 1),
                }, `custom-wave-sustain:${node.id}`);
              }}
            />
          ) : null}
          {showKinkOscGraphic ? (
            <KinkOscGraphic
              shape={node.params.shape ?? 0}
              squareness={node.params.squareness ?? 0}
            />
          ) : null}
          {showSliderDisplay ? (
            <SpagbolControlSlider
              value={node.params.value ?? 0.5}
              displayValue={data.midiSliderValue ?? data.audioSliderValue}
              direction={Math.round(node.params.direction ?? 0) === 1 ? 'vertical' : 'horizontal'}
              onGestureStart={() => shared.beginGesture('Change slider value')}
              onGestureEnd={(cancel) => shared.endGesture(cancel)}
              onChange={(value) => data.onParamChange(node.id, 'value', value)}
            />
          ) : null}
          {showJoystickDisplay ? (
            <SpagbolControlJoystick
              x={data.midiJoystickPosition?.x ?? node.params.x ?? 0.5}
              y={data.midiJoystickPosition?.y ?? node.params.y ?? 0.5}
              elasticity={node.params.elasticity ?? 0}
              onChange={(x, y) => data.onParamsChange(node.id, { x, y })}
            />
          ) : null}
          {showButtonDisplay ? (
            <SpagbolControlButton
              mode={buttonModeFromValue(node.params.mode ?? 0)}
              pressed={data.midiButtonPressed ?? node.params.pressed ?? 0}
              onPressedChange={(value) => data.onParamChange(node.id, 'pressed', value)}
              onClickPulse={() => data.onParamChange(node.id, 'clicks', (node.params.clicks ?? 0) + 1)}
            />
          ) : null}
          {showKeysDisplay ? (
            <KeysDisplay
              size={node.params.size ?? 12}
              startNote={node.params.startNote ?? 60}
              mode={node.params.mode ?? 0}
              activeNote={node.params.frequency > 0 ? Math.round(node.params.note ?? -1) : null}
              onNoteChange={(note) => {
                data.onParamsChange(node.id, { note: note ?? 0, frequency: note === null ? 0 : midiNoteToFrequency(note), ...(hostedMode?.bridgeVersion === 2 && hostedMode.gestures ? { gate: note === null ? 0 : 1, velocity: note === null ? 0 : 1 } : {}) });
              }}
            />
          ) : null}
          {showMeterDisplay ? (
            <div className="audio-node-meter-display" aria-hidden="true">
              <ChartGrid width={160} height={48} columns={meterGridTicks} rows={meterGridRows} showColumnLabels />
              <span
                className="audio-node-meter-fill"
                style={meterMode === 'bipolar'
                  ? {
                      left: `${(0.5 + Math.min(0, meterLevel) * 0.5) * 100}%`,
                      width: `${Math.abs(meterLevel) * 50}%`,
                    }
                  : { width: `${meterLevel * 100}%` }}
              />
              {meterMode === 'bipolar' ? <>
                <span className="audio-node-meter-peak" style={{ left: `${(0.5 + bipolarMeterPeaks.positive * 0.5) * 100}%` }} />
                <span className="audio-node-meter-peak" style={{ left: `${(0.5 - bipolarMeterPeaks.negative * 0.5) * 100}%` }} />
              </> : (
                <span className="audio-node-meter-peak" style={{ left: `${meterPeak * 100}%` }} />
              )}
            </div>
          ) : null}
          {showScopeDisplay ? (
            <div ref={scopeDisplayRef} data-fullscreen-scope-id={flowNodeId} className="audio-node-scope-display">
              <ChartGrid width={160} height={48} columns={scopeGridTicks} rows={scopeScaleTicks} showRowLabels />
              <svg className="audio-node-scope-waveform" viewBox="0 0 160 48" preserveAspectRatio="none" aria-label="Live scope waveform">
                <defs>
                  <linearGradient id={scopeGradientId} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="160" y2="0">
                    <stop offset="0" stopColor="var(--color-accent)" stopOpacity="0.3" />
                    <stop offset="0.65" stopColor="var(--color-accent)" stopOpacity="0.72" />
                    <stop offset="1" stopColor="var(--color-accent)" stopOpacity="1" />
                  </linearGradient>
                </defs>
                <path d={scopePath} style={{ stroke: `var(--scope-trace-stroke, url(#${scopeGradientId}))` }} />
              </svg>
              <button
                type="button"
                className="audio-node-scope-fullscreen nodrag nopan nowheel"
                aria-label="Show scope full screen"
                title="Show scope full screen (Esc to exit)"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={async (event) => {
                  event.stopPropagation();
                  setScopeFullscreenError('');
                  try {
                    if (!scopeDisplayRef.current?.requestFullscreen) throw new Error('Fullscreen unavailable');
                    await scopeDisplayRef.current.requestFullscreen();
                  } catch {
                    setScopeFullscreenError('Full screen is unavailable in this browser window.');
                  }
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4" />
                </svg>
              </button>
              {scopeFullscreenError ? <span className="audio-node-scope-fullscreen-error" role="alert">{scopeFullscreenError}</span> : null}
            </div>
          ) : null}
          {showFftDisplay ? (
            <div
              ref={fftDisplayRef}
              className="audio-node-spectrum-display nodrag nopan"
              aria-label="Live frequency spectrum"
              onPointerMove={handleFftBoundaryPointerMove}
              onPointerUp={(event) => finishFftBoundaryDrag(event.pointerId)}
              onPointerCancel={(event) => finishFftBoundaryDrag(event.pointerId)}
              onLostPointerCapture={(event) => finishFftBoundaryDrag(event.pointerId)}
              onClick={(event) => event.stopPropagation()}
            >
              <ChartGrid width={320} height={96} columns={fftGridTicks} rows={fftGridRows} showColumnLabels />
              <div className="audio-node-spectrum-bars" aria-hidden="true">
                {spectrumBars.map((bar, index) => (
                  <span
                    className="audio-node-spectrum-bar"
                    key={index}
                    style={{
                      height: `${Math.max(1.5, bar.level * 100)}%`,
                      opacity: spectrumWindowOpacity(bar, fftWindowStart, fftWindowEnd),
                    }}
                  />
                ))}
              </div>
              <span
                className="audio-node-spectrum-window-fade audio-node-spectrum-window-fade-low"
                style={{ width: `${fftWindowStartFraction * 100}%` }}
                aria-hidden="true"
              />
              <span
                className="audio-node-spectrum-window-fade audio-node-spectrum-window-fade-high"
                style={{ left: `${fftWindowEndFraction * 100}%` }}
                aria-hidden="true"
              />
              <span
                className="audio-node-spectrum-boundary audio-node-spectrum-boundary-min"
                style={{ left: `${fftWindowStartFraction * 100}%` }}
                role="slider"
                aria-label="Minimum analysis frequency"
                aria-valuemin={FFT_ANALYSIS_MIN_FREQUENCY}
                aria-valuemax={fftWindowEnd}
                aria-valuenow={fftWindowStart}
                title={`Min frequency: ${fftWindowStart} Hz`}
                onPointerDown={(event) => handleFftBoundaryPointerDown(event, 'min')}
              />
              <span
                className="audio-node-spectrum-boundary audio-node-spectrum-boundary-max"
                style={{ left: `${fftWindowEndFraction * 100}%` }}
                role="slider"
                aria-label="Maximum analysis frequency"
                aria-valuemin={fftWindowStart}
                aria-valuemax={FFT_ANALYSIS_MAX_FREQUENCY}
                aria-valuenow={fftWindowEnd}
                title={`Max frequency: ${fftWindowEnd} Hz`}
                onPointerDown={(event) => handleFftBoundaryPointerDown(event, 'max')}
              />
            </div>
          ) : null}
          </div>
          {showAccumulatorDisplay ? (
            <div className="accumulator-value-label" aria-label="Accumulator current value">
              {formatAccumulatorValue(data.audioAccumulatorValue ?? node.params.min ?? 0)}
            </div>
          ) : null}
          {showSequencerDisplay && sequencer ? (
            <SequencerGrid
              params={node.params}
              rows={sequencer.rows}
              rowLabels={node.sequencerRowLabels}
              hasSavedLabelColumnWidth={node.sequencerRowLabelColumnWidth !== undefined}
              steps={sequencer.steps}
              beatLength={sequencer.beatLength}
              currentStep={data.audioSequencerStep}
              selectedLinkOutputs={selectedLinkOutputs}
              setOutputRowRef={(port, element) => {
                outputPortRowsRef.current[port] = element;
              }}
              onParamsChange={(values) => data.onParamsChange(node.id, values)}
              onRowLabelsChange={(labels) => data.onSequencerRowLabelsChange?.(node.id, labels)}
            />
          ) : null}
          {showRollDisplay && roll ? (
            <RollGrid
              params={node.params}
              steps={roll.steps}
              beatLength={roll.beatLength}
              stepLength={roll.stepLength}
              rows={roll.rows}
              startNote={roll.middleNote}
              currentStep={data.audioSequencerStep}
              onParamsChange={(values) => data.onParamsChange(node.id, values)}
            />
          ) : null}
          {showAudioOutputDisplay ? (
            <div className="audio-out-node-meter" aria-label="Audio output level">
              <AudioOutputMeterRow label="L" level={outputMeterLeft} />
              <AudioOutputMeterRow label="R" level={outputMeterRight} />
            </div>
          ) : null}


    </div>
  </SpagbolNodeFrame>;

}

function KinkOscGraphic({ shape, squareness }: { shape: number; squareness: number }) {
  const safeShape = clamp(Number.isFinite(shape) ? shape : 0, -1, 1);
  const safeSquareness = clamp(Number.isFinite(squareness) ? squareness : 0, -1, 1);
  const magnitude = Math.abs(safeSquareness);
  const split = 0.5 * (1 - safeShape);
  let path: string;
  if (magnitude >= 1) {
    const startY = safeSquareness > 0 ? 43 : 5;
    const endY = safeSquareness > 0 ? 5 : 43;
    if (split === 0 || split === 1) {
      const level = split === 0 ? endY : startY;
      path = `M1 ${level} L155 ${level}`;
    } else {
      const splitX = (1 + split * 154).toFixed(2);
      path = `M1 ${startY} L${splitX} ${startY} L${splitX} ${endY} L155 ${endY} L155 ${startY}`;
    }
  } else {
    const exponent = 1 + 11 * magnitude / (1 - magnitude);
    const point = (phase: number, position: number, rising: boolean) => {
      const curvedPosition = safeSquareness >= 0
        ? position ** exponent
        : 1 - (1 - position) ** exponent;
      const curved = rising
        ? -1 + 2 * curvedPosition
        : 1 - 2 * curvedPosition;
      const straight = rising ? -1 + 2 * position : 1 - 2 * position;
      const value = straight + (curved - straight) * magnitude;
      const x = (1 + phase * 154).toFixed(2);
      const y = (24 - value * 19).toFixed(2);
      return `L${x} ${y}`;
    };
    const points = ['M1 43'];
    if (split === 0) points.push('L1 5');
    else for (let index = 1; index <= 48; index += 1) {
      const position = index / 48;
      points.push(point(split * position, position, true));
    }
    if (split === 1) points.push('L155 43');
    else for (let index = 1; index <= 48; index += 1) {
      const position = index / 48;
      points.push(point(split + (1 - split) * position, position, false));
    }
    path = points.join(' ');
  }

  return (
    <div className="kink-osc-display" role="img" aria-label={`Kink Osc waveform, shape ${safeShape.toFixed(2)}, squareness ${safeSquareness.toFixed(2)}`}>
      <svg viewBox="0 0 156 48" preserveAspectRatio="none" role="img" aria-hidden="true">
        <path className="kink-osc-display-grid" d="M0 5H156M0 24H156M0 43H156M39 0V48M78 0V48M117 0V48" />
        <path className="kink-osc-display-trace" d={path} />
      </svg>
    </div>
  );
}

interface BufferWaveformDisplayProps {
  bins: SampleWaveformBin[];
  playhead: number;
  recordHead: number;
  detail: number;
  onClear?: () => void;
}

function BufferWaveformDisplay({ bins, playhead, recordHead, detail, onClear }: BufferWaveformDisplayProps) {
  const width = 300;
  const height = 128;
  const horizontalPadding = 8;
  const waveformPath = sampleWaveformPath(
    waveformBinsForDetail(bins, detail),
    horizontalPadding,
    width - horizontalPadding,
    height,
    0,
  );
  const headX = (head: number) => horizontalPadding + clamp(head, 0, 1) * (width - horizontalPadding * 2);

  return (
    <div className="sample-waveform-display buffer-waveform-display nodrag nopan">
      <svg
        className="sample-waveform-canvas"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-label="Buffer waveform"
        role="img"
      >
        <g className="sample-waveform-chart-chrome">
          <line className="custom-wave-grid-line" x1={horizontalPadding} y1="0" x2={width - horizontalPadding} y2="0" />
          <line className="custom-wave-grid-line custom-wave-zero" x1={horizontalPadding} y1={height / 2} x2={width - horizontalPadding} y2={height / 2} />
          <line className="custom-wave-grid-line" x1={horizontalPadding} y1={height} x2={width - horizontalPadding} y2={height} />
          {waveformPath ? <path className="sample-waveform-path" d={waveformPath} /> : null}
          <line className="wave-playhead-line" x1={headX(playhead)} y1="0" x2={headX(playhead)} y2={height}><title>Playhead</title></line>
          <line className="buffer-record-head-line" x1={headX(recordHead)} y1="0" x2={headX(recordHead)} y2={height}><title>Record head</title></line>
        </g>
      </svg>
      <button
        className="buffer-clear-button nodrag nopan"
        type="button"
        onClick={onClear}
        onPointerDown={(event) => event.stopPropagation()}
      >
        CLEAR
      </button>
    </div>
  );
}

interface SampleWaveformDisplayProps {
  sampleUrl?: string;
  playheads?: number[];
  start: number;
  end: number;
  attack: number;
  release: number;
  detail: number;
  onStartChange: (value: number) => void;
  onEndChange: (value: number) => void;
}

function SampleWaveformDisplay({
  sampleUrl,
  playheads,
  start,
  end,
  attack,
  release,
  detail,
  onStartChange,
  onEndChange,
}: SampleWaveformDisplayProps) {
  const hostedMode = useContext(HostedModeContext);
  const [waveform, setWaveform] = useState<SampleWaveform | null>(null);
  const canvasRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ boundary: 'start' | 'end'; pointerId: number } | null>(null);
  const safeStart = clamp(start, 0, 1);
  const safeEnd = clamp(end, 0, 1);
  const width = 300;
  const height = 128;
  const horizontalPadding = 8;
  const verticalPadding = 0;
  const innerWidth = width - horizontalPadding * 2;
  const sampleDuration = Math.max(0.001, waveform?.duration ?? 1);
  const safeAttack = Math.max(0, attack);
  const safeRelease = Math.max(0, release);
  const playbackDirection = safeEnd >= safeStart ? 1 : -1;
  const startSeconds = safeStart * sampleDuration;
  const endSeconds = safeEnd * sampleDuration;
  const attackEndSeconds = startSeconds + playbackDirection * safeAttack;
  const releaseEndSeconds = endSeconds + playbackDirection * safeRelease;
  const timelineStart = Math.min(0, attackEndSeconds, releaseEndSeconds);
  const timelineEnd = Math.max(sampleDuration, attackEndSeconds, releaseEndSeconds);
  const timelineDuration = Math.max(0.001, timelineEnd - timelineStart);
  const timelineX = (seconds: number) => horizontalPadding + ((seconds - timelineStart) / timelineDuration) * innerWidth;
  const waveformPath = waveform
    ? sampleWaveformPath(
      waveformBinsForDetail(waveform.bins, detail),
      timelineX(0),
      timelineX(sampleDuration),
      height,
      verticalPadding,
    )
    : '';
  const activePlayheads = playheads ?? [];
  const startX = timelineX(startSeconds);
  const endX = timelineX(endSeconds);
  const attackEndX = timelineX(attackEndSeconds);
  const releaseEndX = timelineX(releaseEndSeconds);
  const rangeStartX = Math.min(startX, endX);
  const rangeEndX = Math.max(startX, endX);
  const attackPhaseX = Math.min(startX, attackEndX);
  const attackPhaseWidth = Math.abs(attackEndX - startX);
  const releasePhaseX = Math.min(endX, releaseEndX);
  const releasePhaseWidth = Math.abs(releaseEndX - endX);

  function updateBoundaryFromPointer(event: Pick<PointerEvent<SVGSVGElement>, 'clientX'>) {
    const drag = dragRef.current;
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!drag || !bounds || bounds.width <= 0) return;
    // Pointer coordinates span the full SVG, while the editable timeline spans
    // the horizontally inset chart area. Convert through the SVG coordinate system first
    // so clicking a boundary leaves it at its current value.
    const svgX = ((event.clientX - bounds.left) / bounds.width) * width;
    const value = clamp((timelineStart + ((svgX - horizontalPadding) / innerWidth) * timelineDuration) / sampleDuration, 0, 1);
    if (drag.boundary === 'start') onStartChange(value);
    else onEndChange(value);
  }

  function handleBoundaryPointerDown(event: PointerEvent<SVGRectElement>, boundary: 'start' | 'end') {
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { boundary, pointerId: event.pointerId };
    canvasRef.current?.setPointerCapture(event.pointerId);
    updateBoundaryFromPointer(event);
  }

  function handlePointerMove(event: PointerEvent<SVGSVGElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    updateBoundaryFromPointer(event);
  }

  function finishBoundaryDrag(pointerId: number) {
    if (dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
  }

  useEffect(() => {
    let cancelled = false;
    setWaveform(null);
    if (!sampleUrl) return () => {
      cancelled = true;
    };

    const controller = new AbortController();
    const request = hostedMode
      ? (hostedMode.assets?.waveform?.(sampleUrl, controller.signal) ?? Promise.resolve(null))
      : getSampleWaveform(sampleUrl);
    void request.then((nextWaveform) => {
      if (!cancelled && nextWaveform && Number.isFinite(nextWaveform.duration) && nextWaveform.duration > 0 && nextWaveform.bins.length <= 1024 && nextWaveform.bins.every(bin => Number.isFinite(bin.min) && Number.isFinite(bin.max) && bin.min <= bin.max)) setWaveform(nextWaveform);
    }).catch(() => undefined);
    return () => { cancelled = true; controller.abort(); };
  }, [sampleUrl, hostedMode?.assets]);

  return (
    <div className="sample-waveform-display nodrag nopan">
      {hostedMode && !hostedMode.assets?.waveform && <span>Waveform preview requires host data</span>}
      {!hostedMode && sampleUrl && isVideoSampleUrl(sampleUrl) ? (
        <SampleVideoPreview
          sampleUrl={sampleUrl}
          startPosition={safeStart}
          playbackPosition={activePlayheads.length > 0 ? activePlayheads[activePlayheads.length - 1] : undefined}
        />
      ) : null}
      <svg
        ref={canvasRef}
        className="sample-waveform-canvas"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-label={sampleUrl ? 'Sample waveform' : 'Sample waveform preview'}
        role="img"
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => {
          event.stopPropagation();
          finishBoundaryDrag(event.pointerId);
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          finishBoundaryDrag(event.pointerId);
        }}
        onLostPointerCapture={(event) => {
          event.stopPropagation();
          finishBoundaryDrag(event.pointerId);
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <g className="sample-waveform-chart-chrome">
          <line className="custom-wave-grid-line" x1={horizontalPadding} y1={verticalPadding} x2={width - horizontalPadding} y2={verticalPadding} />
          <line className="custom-wave-grid-line custom-wave-zero" x1={horizontalPadding} y1={height / 2} x2={width - horizontalPadding} y2={height / 2} />
          <line className="custom-wave-grid-line" x1={horizontalPadding} y1={height - verticalPadding} x2={width - horizontalPadding} y2={height - verticalPadding} />
          {waveformPath ? <path className="sample-waveform-path" d={waveformPath} /> : null}
          <rect className="sample-waveform-fade" x={horizontalPadding} y={verticalPadding} width={rangeStartX - horizontalPadding} height={height - verticalPadding * 2} />
          <rect className="sample-waveform-fade" x={rangeEndX} y={verticalPadding} width={width - horizontalPadding - rangeEndX} height={height - verticalPadding * 2} />
          {safeAttack > 0 ? <rect className="sample-waveform-phase is-attack" x={attackPhaseX} y={verticalPadding} width={attackPhaseWidth} height={height - verticalPadding * 2} /> : null}
          {safeRelease > 0 ? <rect className="sample-waveform-phase is-release" x={releasePhaseX} y={verticalPadding} width={releasePhaseWidth} height={height - verticalPadding * 2} /> : null}
          {activePlayheads.map((playhead, index) => {
            const playheadX = timelineX(clamp(playhead, 0, 1) * sampleDuration);
            return <line className={`wave-playhead-line wave-playhead-${index % 4}`} key={`${index}:${playhead}`} x1={playheadX} y1={verticalPadding} x2={playheadX} y2={height - verticalPadding}><title>Playback {index + 1}</title></line>;
          })}
          <line className="sample-waveform-boundary-line is-start" x1={startX} y1={verticalPadding} x2={startX} y2={height - verticalPadding} />
          <line className="sample-waveform-boundary-line is-end" x1={endX} y1={verticalPadding} x2={endX} y2={height - verticalPadding} />
          {safeAttack > 0 ? <line className="sample-waveform-phase-line is-attack" x1={startX} y1={verticalPadding} x2={attackEndX} y2={height - verticalPadding}><title>Attack phase</title></line> : null}
          {safeRelease > 0 ? <line className="sample-waveform-phase-line is-release" x1={endX} y1={verticalPadding} x2={releaseEndX} y2={height - verticalPadding}><title>Release phase</title></line> : null}
        </g>
        <rect
          className="sample-waveform-boundary-hit-target is-start"
          x={startX - 8}
          y={verticalPadding}
          width={16}
          height={height - verticalPadding * 2}
          aria-label="Drag sample start"
          onPointerDown={(event) => handleBoundaryPointerDown(event, 'start')}
        />
        <rect
          className="sample-waveform-boundary-hit-target is-end"
          x={endX - 8}
          y={verticalPadding}
          width={16}
          height={height - verticalPadding * 2}
          aria-label="Drag sample end"
          onPointerDown={(event) => handleBoundaryPointerDown(event, 'end')}
        />
      </svg>
    </div>
  );
}

interface SampleVideoPreviewProps {
  sampleUrl: string;
  startPosition: number;
  playbackPosition?: number;
}

const MAX_SAMPLE_VIDEO_CACHED_FRAMES = 24;
const SAMPLE_VIDEO_CACHE_WIDTH = 720;

function SampleVideoPreview({ sampleUrl, startPosition, playbackPosition }: SampleVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const preloaderRef = useRef<HTMLVideoElement | null>(null);
  const cachedFrameRef = useRef<HTMLCanvasElement | null>(null);
  const frameCacheRef = useRef(new Map<string, HTMLCanvasElement>());
  const displayPosition = clamp(playbackPosition ?? startPosition, 0, 1);
  const targetPositionRef = useRef(displayPosition);
  const preloadPositionRef = useRef(clamp(startPosition, 0, 1));
  targetPositionRef.current = displayPosition;
  preloadPositionRef.current = clamp(startPosition, 0, 1);

  function seekToPosition(video: HTMLVideoElement, position: number) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const targetTime = clamp(position, 0, 1) * video.duration;
    // currentTime requests an exact seek. fastSeek() is intentionally avoided
    // because browsers may resolve it to a nearby keyframe instead.
    if (Math.abs(video.currentTime - targetTime) > 1 / 240) video.currentTime = targetTime;
  }

  function showCachedFrame(position: number): boolean {
    const frame = frameCacheRef.current.get(sampleVideoFrameCacheKey(position));
    const output = cachedFrameRef.current;
    if (!frame || !output) return false;
    output.width = frame.width;
    output.height = frame.height;
    output.getContext('2d')?.drawImage(frame, 0, 0);
    output.classList.add('is-visible');
    return true;
  }

  function hideCachedFrameIfCurrent(video: HTMLVideoElement) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return;
    const targetTime = targetPositionRef.current * video.duration;
    if (Math.abs(video.currentTime - targetTime) <= 1 / 60) {
      cachedFrameRef.current?.classList.remove('is-visible');
    }
  }

  function cachePreloadedFrame(video: HTMLVideoElement) {
    if (!Number.isFinite(video.duration) || video.duration <= 0 || video.videoWidth <= 0 || video.videoHeight <= 0) return;
    const targetPosition = preloadPositionRef.current;
    const targetTime = targetPosition * video.duration;
    if (Math.abs(video.currentTime - targetTime) > 1 / 60) return;

    const scale = Math.min(1, SAMPLE_VIDEO_CACHE_WIDTH / video.videoWidth);
    const frame = document.createElement('canvas');
    frame.width = Math.max(1, Math.round(video.videoWidth * scale));
    frame.height = Math.max(1, Math.round(video.videoHeight * scale));
    frame.getContext('2d')?.drawImage(video, 0, 0, frame.width, frame.height);
    const cache = frameCacheRef.current;
    const key = sampleVideoFrameCacheKey(targetPosition);
    cache.delete(key);
    cache.set(key, frame);
    while (cache.size > MAX_SAMPLE_VIDEO_CACHED_FRAMES) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey === undefined) break;
      cache.delete(oldestKey);
    }
    if (Math.abs(targetPositionRef.current - targetPosition) <= 1 / 10_000) showCachedFrame(targetPosition);
  }

  useEffect(() => {
    const video = videoRef.current;
    if (!showCachedFrame(displayPosition)) cachedFrameRef.current?.classList.remove('is-visible');
    if (video) seekToPosition(video, displayPosition);
  }, [displayPosition, sampleUrl]);

  useEffect(() => {
    const preloader = preloaderRef.current;
    if (preloader) seekToPosition(preloader, preloadPositionRef.current);
  }, [startPosition, sampleUrl]);

  useEffect(() => {
    frameCacheRef.current.clear();
    cachedFrameRef.current?.classList.remove('is-visible');
  }, [sampleUrl]);

  return (
    <div className="sample-video-preview-frame">
      <video
        ref={videoRef}
        className="sample-video-preview"
        src={sampleUrl}
        aria-label="Sample video preview"
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        onLoadedMetadata={(event) => seekToPosition(event.currentTarget, targetPositionRef.current)}
        onSeeked={(event) => hideCachedFrameIfCurrent(event.currentTarget)}
      />
      <canvas ref={cachedFrameRef} className="sample-video-cached-frame" aria-hidden="true" />
      <video
        ref={preloaderRef}
        className="sample-video-preloader"
        src={sampleUrl}
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        aria-hidden="true"
        onLoadedMetadata={(event) => seekToPosition(event.currentTarget, preloadPositionRef.current)}
        onLoadedData={(event) => cachePreloadedFrame(event.currentTarget)}
        onSeeked={(event) => cachePreloadedFrame(event.currentTarget)}
      />
    </div>
  );
}

function sampleVideoFrameCacheKey(position: number): string {
  return clamp(position, 0, 1).toFixed(5);
}

function isVideoSampleUrl(url: string): boolean {
  try {
    return new URL(url, window.location.href).pathname.toLowerCase().endsWith('.mp4');
  } catch {
    return /\.mp4(?:$|[?#])/i.test(url);
  }
}

function sampleWaveformPath(
  bins: SampleWaveformBin[],
  startX: number,
  endX: number,
  height: number,
  verticalPadding: number,
): string {
  if (bins.length === 0) return '';
  const innerHeight = height - verticalPadding * 2;
  // Native hosts publish point samples as equal min/max pairs. Separate
  // vertical strokes would have zero length, so connect these as a trace.
  if (bins.every((bin) => bin.min === bin.max)) {
    const trace = bins.map((bin, index) => {
      const x = startX + (index / Math.max(1, bins.length - 1)) * (endX - startX);
      const y = verticalPadding + (1 - (clamp(bin.max, -1, 1) + 1) / 2) * innerHeight;
      return `${index === 0 ? 'M' : 'L'}${roundPathNumber(x)} ${roundPathNumber(y)}`;
    }).join(' ');
    return bins.length === 1 ? `${trace} H${roundPathNumber(endX)}` : trace;
  }
  return bins.map((bin, index) => {
    const x = startX + (index / Math.max(1, bins.length - 1)) * (endX - startX);
    const top = verticalPadding + (1 - (clamp(bin.max, -1, 1) + 1) / 2) * innerHeight;
    const bottom = verticalPadding + (1 - (clamp(bin.min, -1, 1) + 1) / 2) * innerHeight;
    return `M${roundPathNumber(x)} ${roundPathNumber(top)} V${roundPathNumber(bottom)}`;
  }).join(' ');
}

function waveformBinsForDetail(bins: SampleWaveformBin[], detail: number): SampleWaveformBin[] {
  const count = Math.max(1, Math.min(bins.length, Math.round(detail)));
  if (count >= bins.length) return bins;
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor(index * bins.length / count);
    const end = Math.max(start + 1, Math.floor((index + 1) * bins.length / count));
    let min = 0;
    let max = 0;
    for (let sourceIndex = start; sourceIndex < end; sourceIndex += 1) {
      const source = bins[sourceIndex];
      min = Math.min(min, source.min);
      max = Math.max(max, source.max);
    }
    return { min, max };
  });
}

function normalizeUnitInterval(value: number): number {
  return ((value % 1) + 1) % 1;
}

function isEditableElement(element: EventTarget | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  return element.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName);
}

function centeredCoordinateToUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return (Math.max(-1, Math.min(1, value)) + 1) * 0.5;
}

interface CustomWaveEditorProps {
  customWave: CustomWaveSettings;
  waves: CustomWaveSettings[];
  selectedWaveIndex: number;
  onWaveSelect: (index: number) => void;
  subdivisions: number;
  subgroups: number;
  baseLevel: number;
  rangeMin: number;
  rangeMax: number;
  frequency: number;
  hasLivePlayheads: boolean;
  playheads: number[];
  compact: boolean;
  displaySize: ScopeNodeSize;
  graphZoomScale: number;
  graphScreenEmphasis: number;
  onInsertPoint: (point: CustomWavePoint) => number | null;
  onMovePoint: (index: number, point: CustomWavePoint) => void;
  onRemovePoint: (index: number) => void;
  onGestureEnd: () => void;
  onSustainStartChange: (value: number) => void;
  onSustainEndChange: (value: number) => void;
}

interface AudioInputDisplayProps {
  state: TeiaNodeData['audioInput'];
  muted: boolean;
  onMutedChange: (muted: boolean) => void;
  onDeviceChange: (deviceId: string) => void;
  onRefresh: () => void;
}

const METER_RECENT_MAX_HOLD_MS = 800;

function useRecentMaxLevel(level: number, enabled: boolean): number {
  const latestLevelRef = useRef(level);
  const timeoutRef = useRef<number | null>(null);
  const [recentMaxLevel, setRecentMaxLevel] = useState(level);

  useEffect(() => {
    latestLevelRef.current = level;
  }, [level]);

  useEffect(() => {
    // Peak-hold readings are visual state; publish outside the commit phase.
    const frame = requestAnimationFrame(() => {
      if (!enabled) {
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        setRecentMaxLevel(level);
        return;
      }

      setRecentMaxLevel((currentMax) => {
        if (level >= currentMax) {
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          return level;
        }

        if (timeoutRef.current === null) {
          timeoutRef.current = window.setTimeout(() => {
            timeoutRef.current = null;
            setRecentMaxLevel(latestLevelRef.current);
          }, METER_RECENT_MAX_HOLD_MS);
        }

        return currentMax;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, level]);

  useEffect(() => () => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
    }
  }, []);

  return recentMaxLevel;
}

function useRecentBipolarLevels(level: number, enabled: boolean): { positive: number; negative: number } {
  const latestLevelRef = useRef(level);
  const timeoutRef = useRef<number | null>(null);
  const [recentLevels, setRecentLevels] = useState({ positive: 0, negative: 0 });

  useEffect(() => {
    latestLevelRef.current = level;
  }, [level]);

  useEffect(() => {
    // Peak-hold readings are visual state; publish outside the commit phase.
    const frame = requestAnimationFrame(() => {
      if (!enabled) {
        if (timeoutRef.current !== null) {
          window.clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        setRecentLevels({ positive: 0, negative: 0 });
        return;
      }

      setRecentLevels((current) => {
        const next = {
          positive: Math.max(current.positive, level, 0),
          negative: Math.max(current.negative, -level, 0),
        };
        if (next.positive !== current.positive || next.negative !== current.negative) {
          if (timeoutRef.current !== null) {
            window.clearTimeout(timeoutRef.current);
            timeoutRef.current = null;
          }
          return next;
        }

        if (timeoutRef.current === null) {
          timeoutRef.current = window.setTimeout(() => {
            timeoutRef.current = null;
            const latest = latestLevelRef.current;
            setRecentLevels({ positive: Math.max(0, latest), negative: Math.max(0, -latest) });
          }, METER_RECENT_MAX_HOLD_MS);
        }
        return current;
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [enabled, level]);

  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);

  return recentLevels;
}

function AudioOutputMeterRow({ label, level }: { label: string; level: number }) {
  const normalized = Math.max(0, Math.min(1, level));
  const recentMax = useRecentMaxLevel(normalized, true);

  return (
    <div className="audio-out-node-meter-row" aria-hidden="true">
      <span className="audio-out-node-meter-label">{label}</span>
      <span className="audio-out-node-meter-track">
        <span className="audio-out-node-meter-fill" style={{ width: `${normalized * 100}%` }} />
        <span className="audio-out-node-meter-peak" style={{ left: `${recentMax * 100}%` }} />
      </span>
    </div>
  );
}

function AudioInputDisplay({ state, muted, onMutedChange, onDeviceChange, onRefresh }: AudioInputDisplayProps) {
  const status = state?.status ?? 'inactive';
  const message = state?.message ?? 'Start audio to request microphone access.';
  const devices = state?.devices ?? [];
  const selectedDeviceId = state?.selectedDeviceId ?? '';
  const canSelectDevice = state?.canSelectDevice ?? false;
  const unavailable = status === 'unsupported' || status === 'denied' || status === 'error';

  return (
    <div className="audio-input-node-panel nodrag nopan">
      <div className="audio-input-node-status-row">
        <span
          className={[
            'audio-input-node-status-dot',
            `audio-input-node-status-dot-${status}`,
          ].join(' ')}
          aria-hidden="true"
        />
        <span className="audio-input-node-status-text" title={message}>
          {audioInputStatusLabel(status)}
        </span>
        <button
          className={[
            'audio-input-node-mute-button',
            muted ? 'audio-input-node-mute-button-active' : '',
          ].filter(Boolean).join(' ')}
          type="button"
          aria-label={muted ? 'Unmute audio input' : 'Mute audio input'}
          aria-pressed={muted}
          title={muted ? 'Unmute input' : 'Mute input'}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onMutedChange(!muted);
          }}
        >
          {muted ? 'muted' : 'live'}
        </button>
      </div>
      <div className={[
        'audio-input-node-message',
        unavailable ? 'audio-input-node-message-warning' : '',
      ].filter(Boolean).join(' ')}>
        {message}
      </div>
      {canSelectDevice ? (
        <div className="audio-input-node-device-row">
          <select
            className="audio-input-node-device-select"
            aria-label="Audio input device"
            value={selectedDeviceId}
            disabled={devices.length === 0}
            onChange={(event) => {
              onDeviceChange(event.currentTarget.value);
              event.currentTarget.blur();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <option value="">Default input</option>
            {devices.map((device) => (
              <option key={device.deviceId || device.label} value={device.deviceId}>
                {device.label}
              </option>
            ))}
          </select>
          <button
            className="audio-input-node-refresh-button"
            type="button"
            aria-label="Refresh audio input devices"
            title="Refresh devices"
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRefresh();
            }}
          >
            refresh
          </button>
        </div>
      ) : null}
    </div>
  );
}

function audioInputStatusLabel(status: NonNullable<TeiaNodeData['audioInput']>['status']): string {
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

interface KeysDisplayProps {
  size: number;
  startNote: number;
  mode: number;
  activeNote: number | null;
  onNoteChange: (note: number | null) => void;
}

function KeysDisplay({ size, startNote, mode, activeNote, onNoteChange }: KeysDisplayProps) {
  const dragRef = useRef<{ pointerId: number; note: number } | null>(null);
  const holdMode = Math.round(mode) === 1;
  const firstNote = clamp(Math.round(startNote), 0, 127);
  const noteCount = clamp(Math.round(size), 1, 128 - firstNote);
  const notes = Array.from({ length: noteCount }, (_, index) => firstNote + index);
  const layouts = pianoKeyLayouts(notes);

  function press(event: PointerEvent<HTMLButtonElement>, note: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, note };
    event.currentTarget.setPointerCapture(event.pointerId);
    const nextNote = holdMode && activeNote === note ? null : note;
    onNoteChange(nextNote);
  }

  function move(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-midi-note]');
    const note = Number(target?.dataset.midiNote);
    if (!Number.isInteger(note) || note === drag.note) return;
    drag.note = note;
    onNoteChange(note);
  }

  function release(event: PointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = null;
    if (!holdMode) {
      onNoteChange(null);
    }
  }

  return (
    <div className="keys-node-keyboard nodrag nopan" aria-label={`Piano keys ${firstNote} to ${firstNote + noteCount - 1}`}>
      {layouts.map(({ note, black, left, width }) => (
        <button
          className={[
            'keys-node-key nodrag nopan',
            black ? 'keys-node-key-black' : 'keys-node-key-white',
            activeNote === note ? 'keys-node-key-active' : '',
          ].filter(Boolean).join(' ')}
          key={note}
          type="button"
          aria-label={`MIDI note ${note}`}
          aria-pressed={activeNote === note}
          data-midi-note={note}
          style={{ left: `${left}%`, width: `${width}%` }}
          onPointerDown={(event) => press(event, note)}
          onPointerMove={move}
          onPointerUp={release}
          onPointerCancel={release}
          onLostPointerCapture={(event) => {
            if (dragRef.current?.pointerId === event.pointerId) {
              dragRef.current = null;
              if (!holdMode) {
                onNoteChange(null);
              }
            }
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ))}
    </div>
  );
}

function pianoKeyLayouts(notes: number[]): Array<{ note: number; black: boolean; left: number; width: number }> {
  const raw = notes.map((note) => {
    const pitchClass = note % 12;
    const black = [1, 3, 6, 8, 10].includes(pitchClass);
    const octave = Math.floor(note / 12);
    const whiteInOctave = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6][pitchClass];
    const whitePosition = octave * 7 + whiteInOctave;
    return {
      note,
      black,
      left: black ? whitePosition + 0.68 : whitePosition,
      width: black ? 0.64 : 1,
    };
  });
  const min = Math.min(...raw.map((key) => key.left));
  const max = Math.max(...raw.map((key) => key.left + key.width));
  const span = Math.max(0.001, max - min);
  return raw.map((key) => ({
    ...key,
    left: ((key.left - min) / span) * 100,
    width: (key.width / span) * 100,
  }));
}

function midiNoteToFrequency(note: number): number {
  return 440 * (2 ** ((note - 69) / 12));
}

function sequencerRowLabelColumnWidth(labels?: string[]): number {
  const longestLabel = Math.max(3, ...(labels?.map((label) => label.length) ?? [0]));
  return 20 + longestLabel * 8;
}

/**
 * The piano-roll adapter for the shared gate-pattern interaction. Keeping this
 * input shape aligned with SequencerGrid makes the remaining visual adapter
 * (pitch labels and MIDI outputs) explicit rather than duplicating pattern
 * state in a second node implementation.
 */
interface RollGridProps {
  params: Record<string, number>;
  steps: number;
  beatLength: number;
  stepLength: number;
  rows: Array<{ index: number; note: number }>;
  /** Retained for the unused legacy renderer while Roll migrates to PatternGrid. */
  startNote: number;
  currentStep?: number;
  onParamsChange: (values: Record<string, number>) => void;
}

function RollGrid({ params, steps, beatLength, stepLength, rows, currentStep, onParamsChange }: RollGridProps) {
  const storageRow = (displayRow: number) => rows.length - displayRow - 1;
  return (
    <SpagbolSequencer
      ariaLabel="Piano roll"
      className="roll-node-panel spagbol-sequencer-roll"
      rows={rows.length}
      steps={steps}
      groupSize={beatLength}
      currentStep={currentStep}
      defaultItemLength={stepLength}
      rowLabel={(displayRow) => midiNoteLabel(rows[storageRow(displayRow)].note)}
      itemsForRow={(displayRow) => rollGatesForRow(params, rows[storageRow(displayRow)].index, steps).map(({ slot, velocity, ...item }) => ({ ...item, id: slot, level: velocity }))}
      onCreateItem={(displayRow, start, end) => {
        const row = rows[storageRow(displayRow)].index;
        const gates = rollGatesForRow(params, row, steps);
        const slot = Array.from({ length: steps }, (_, index) => index).find((index) => !gates.some((gate) => gate.slot === index));
        if (slot === undefined) return;
        const values: Record<string, number> = {
          [rollGateParamName(row, slot, 'active')]: 1,
          [rollGateParamName(row, slot, 'start')]: start,
          [rollGateParamName(row, slot, 'end')]: end,
          [rollGateVelocityParamName(row, slot)]: 1,
          [rollCellParamName(row, slot)]: 0,
        };
        // Editing a row never clears notes in the other rows.
        onParamsChange(values);
      }}
      onUpdateItem={(displayRow, slot, update) => {
        const row = rows[storageRow(displayRow)].index;
        const values: Record<string, number> = {};
        if (update.start !== undefined) values[rollGateParamName(row, slot, 'start')] = update.start;
        if (update.end !== undefined) values[rollGateParamName(row, slot, 'end')] = update.end;
        if (update.level !== undefined) values[rollGateVelocityParamName(row, slot)] = update.level;
        onParamsChange(values);
      }}
      onDeleteItem={(displayRow, slot) => onParamsChange({ [rollGateParamName(rows[storageRow(displayRow)].index, slot, 'active')]: 0 })}
    />
  );
}

/**
 * Shared interaction and rendering system for step-based patterns. Callers
 * adapt node storage to gates and choose which interactions are available.
 */
interface SequencerGridProps {
  params: Record<string, number>;
  rows: number;
  rowLabels?: string[];
  hasSavedLabelColumnWidth: boolean;
  steps: number;
  beatLength: number;
  currentStep?: number;
  selectedLinkOutputs: string[];
  setOutputRowRef: (port: string, element: HTMLDivElement | null) => void;
  onParamsChange: (values: Record<string, number>) => void;
  onRowLabelsChange: (labels: string[]) => void;
}

function SequencerGrid({
  params,
  rows,
  rowLabels,
  hasSavedLabelColumnWidth,
  steps,
  beatLength,
  currentStep,
  selectedLinkOutputs,
  setOutputRowRef,
  onParamsChange,
  onRowLabelsChange,
}: SequencerGridProps) {
  const gateMode = sequencerUsesGateMode(params);
  const [draftRowLabels, setDraftRowLabels] = useState<string[]>([]);

  useEffect(() => {
    setDraftRowLabels(Array.from({ length: rows }, (_, rowIndex) => rowLabels?.[rowIndex] ?? String(rowIndex + 1)));
  }, [rowLabels, rows]);

  useEffect(() => {
    if (hasSavedLabelColumnWidth) return;
    onRowLabelsChange(Array.from({ length: rows }, (_, rowIndex) => rowLabels?.[rowIndex] ?? String(rowIndex + 1)));
  }, [hasSavedLabelColumnWidth, onRowLabelsChange, rowLabels, rows]);

  const updateRowLabel = (rowIndex: number, value: string) => {
    const labels = [...draftRowLabels];
    labels[rowIndex] = value;
    setDraftRowLabels(labels);
    onRowLabelsChange(labels);
  };
  const commitRowLabel = (rowIndex: number) => {
    const label = draftRowLabels[rowIndex]?.trim() || String(rowIndex + 1);
    onRowLabelsChange(Array.from({ length: rows }, (_, index) => (
      index === rowIndex ? label : draftRowLabels[index]?.trim() || rowLabels?.[index] || String(index + 1)
    )));
  };

  const patternGatesForRow = (rowIndex: number): ReturnType<typeof sequencerGatesForRow> => gateMode
    ? sequencerGatesForRow(params, rowIndex, steps)
    : sequencerTriggersForRow(params, rowIndex, steps).map((trigger) => ({
        slot: trigger.slot,
        start: trigger.position,
        end: Math.min(steps, trigger.position + 1),
        velocity: trigger.velocity,
      }));

  const createGates = (rowIndex: number, additions: Array<{ start: number; end: number }>) => {
    const existing = patternGatesForRow(rowIndex);
    const usedSlots = new Set(existing.map((gate) => gate.slot));
    const existingStarts = new Set(existing.map((gate) => Math.round(gate.start * 1000000)));
    const values: Record<string, number> = gateMode ? { [SEQUENCER_GATE_INITIALIZED_PARAM]: 1 } : {};
    for (const addition of additions) {
      if (!gateMode && existingStarts.has(Math.round(addition.start * 1000000))) continue;
      const slot = Array.from({ length: steps }, (_, index) => index).find((index) => !usedSlots.has(index));
      if (slot === undefined) break;
      usedSlots.add(slot);
      if (gateMode) {
        values[sequencerGateParamName(rowIndex, slot, 'active')] = 1;
        values[sequencerGateParamName(rowIndex, slot, 'start')] = addition.start;
        values[sequencerGateParamName(rowIndex, slot, 'end')] = addition.end;
        values[sequencerStepVelocityParamName(rowIndex, slot)] = 1;
      } else {
        values[sequencerCellParamName(rowIndex, slot)] = 1;
        values[sequencerTriggerPositionParamName(rowIndex, slot)] = addition.start;
        values[sequencerStepVelocityParamName(rowIndex, slot)] = 1;
      }
    }
    if (Object.keys(values).length > (gateMode ? 1 : 0)) onParamsChange(values);
  };

  return (
    <SpagbolSequencer
      ariaLabel="Sequencer pattern"
      className="teia-sequencer-grid"
      rows={rows}
      steps={steps}
      groupSize={beatLength}
      currentStep={currentStep}
      mode={gateMode ? 'gate' : 'trigger'}
      labelPosition="right"
      rowLabel={(rowIndex) => draftRowLabels[rowIndex] ?? rowLabels?.[rowIndex] ?? String(rowIndex + 1)}
      renderRowLabel={(rowIndex) => {
        const outputName = sequencerOutputName(rowIndex);
        return (
          <div className="sequencer-output-port">
            <input
              className="sequencer-row-label"
              aria-label={`Label for row ${rowIndex + 1}`}
              value={draftRowLabels[rowIndex] ?? String(rowIndex + 1)}
              size={Math.max(3, (draftRowLabels[rowIndex] ?? String(rowIndex + 1)).length)}
              onChange={(event) => updateRowLabel(rowIndex, event.target.value)}
              onBlur={() => commitRowLabel(rowIndex)}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') event.currentTarget.blur(); }}
            />
            <Handle
              id={`out:${outputName}`}
              type="source"
              position={Position.Right}
              className={[
                'sequencer-row-output-pin',
                selectedLinkOutputs.includes(outputName) ? 'teia-handle-selected-link' : '',
              ].filter(Boolean).join(' ')}
            />
          </div>
        );
      }}
      onRowRef={(rowIndex, element) => setOutputRowRef(sequencerOutputName(rowIndex), element)}
      itemsForRow={(row) => patternGatesForRow(row).map(({ slot, velocity, ...item }) => ({ ...item, id: slot, level: velocity }))}
      defaultItemLength={1}
      allowMove
      allowResize={gateMode}
      allowLevel
      onCreateItem={(rowIndex, start, end) => createGates(rowIndex, [{ start, end }])}
      onCreateItems={createGates}
      onUpdateItem={(rowIndex, slot, update) => {
        const values: Record<string, number> = {};
        if (update.level !== undefined) values[sequencerStepVelocityParamName(rowIndex, slot)] = update.level;
        if (gateMode) {
          if (update.start !== undefined) values[sequencerGateParamName(rowIndex, slot, 'start')] = update.start;
          if (update.end !== undefined) values[sequencerGateParamName(rowIndex, slot, 'end')] = update.end;
        } else if (update.start !== undefined) {
          values[sequencerTriggerPositionParamName(rowIndex, slot)] = update.start;
        }
        onParamsChange(values);
      }}
      onDeleteItem={(rowIndex, slot) => onParamsChange(gateMode
        ? { [sequencerGateParamName(rowIndex, slot, 'active')]: 0 }
        : { [sequencerCellParamName(rowIndex, slot)]: 0 })}
    />
  );
}

function CustomWaveEditor({
  customWave, waves, selectedWaveIndex, onWaveSelect, subdivisions, subgroups,
  baseLevel, rangeMin, rangeMax, frequency, hasLivePlayheads, playheads, compact,
  displaySize, graphZoomScale, graphScreenEmphasis, onInsertPoint, onMovePoint,
  onRemovePoint, onGestureEnd, onSustainStartChange, onSustainEndChange,
}: CustomWaveEditorProps) {
  const points = customWaveWithBaseLevel(customWave, baseLevel, rangeMin, rangeMax).points;
  const showStart = customWaveUsesSustainStart(customWave.mode);
  const showEnd = customWaveUsesSustainEnd(customWave.mode);
  return <SpagbolCurveEditor
    key={selectedWaveIndex}
    points={points.map((point, index) => ({ ...point, locked: index === 0 || index === points.length - 1 }))}
    backgroundCurves={waves.flatMap((wave, index) => index === selectedWaveIndex ? [] : [{ points: customWaveWithBaseLevel(wave, baseLevel, rangeMin, rangeMax).points, className: `wave-color-${index % 8}` }])}
    pathClassName={`wave-color-${selectedWaveIndex % 8}`}
    displaySize={{ width: displaySize.width * graphZoomScale, height: displaySize.height * graphZoomScale }}
    screenEmphasis={graphScreenEmphasis}
    pointScale={customWaveEditPointScreenScale(graphZoomScale)}
    formatValue={(value) => formatChartValue(customWaveOutputValue(value, rangeMin, rangeMax))}
    onInsertPoint={onInsertPoint} onMovePoint={onMovePoint} onRemovePoint={onRemovePoint} onGestureEnd={onGestureEnd}
    toolbar={waves.length > 1 ? <div className="custom-wave-tabs" aria-label="Select wave">
      {waves.map((_, index) => <button key={index} type="button" className={`custom-wave-tab wave-color-${index % 8} ${index === selectedWaveIndex ? 'is-selected' : ''} nodrag nopan`} title={`Edit wave ${index + 1} (${index + 1})`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onWaveSelect(index); }}>{index + 1}</button>)}
    </div> : null}
    underlay={<>
      <svg className="custom-wave-subgroup-bands" viewBox="0 0 300 128" preserveAspectRatio="none" aria-hidden="true">{customWaveSubgroupBands(subdivisions, subgroups, 300, 12).map((band) => <rect key={band.x} x={band.x} y={12} width={band.width} height={104} />)}</svg>
      <ChartGrid width={276} height={104} columns={customWaveGridColumns(subdivisions)} rows={customWaveGridRows(rangeMin, rangeMax, displaySize.height * graphZoomScale)} className="custom-wave-node-grid" showRowLabels />
    </>}
    overlay={<>
      {showStart ? <line className="custom-wave-sustain-line" x1={12 + customWave.sustainStart * 276} y1={12} x2={12 + customWave.sustainStart * 276} y2={116} /> : null}
      {showEnd ? <line className="custom-wave-sustain-line is-end" x1={12 + customWave.sustainEnd * 276} y1={12} x2={12 + customWave.sustainEnd * 276} y2={116} /> : null}
      {hasLivePlayheads && Number.isFinite(frequency) && Math.abs(frequency) < 20 ? playheads.map((playhead, index) => <line key={index} className={`wave-playhead-line wave-playhead-${index % 4} is-low-frequency`} x1={12 + clamp(playhead, 0, 1) * 276} y1={12} x2={12 + clamp(playhead, 0, 1) * 276} y2={116}><title>Playback {index + 1}</title></line>) : null}
    </>}
    footer={!compact && (showStart || showEnd) ? <div className="custom-wave-node-controls">
      {showStart ? <CustomWaveRange label="start" value={customWave.sustainStart} min={0} max={Math.max(0, customWave.sustainEnd - 0.001)} onChange={onSustainStartChange} /> : null}
      {showEnd ? <CustomWaveRange label="end" value={customWave.sustainEnd} min={Math.min(1, customWave.sustainStart + 0.001)} max={1} onChange={onSustainEndChange} /> : null}
    </div> : null}
  />;
}

function customWaveGridColumns(subdivisions: number): ChartGridTick[] {
  const count = Math.max(1, Math.min(64, Math.round(Number.isFinite(subdivisions) ? subdivisions : 8)));
  return Array.from({ length: count + 1 }, (_, index) => ({
    fraction: index / count,
    major: index === 0 || index === count,
  }));
}

function customWaveSubgroupBands(subdivisions: number, subgroups: number, width: number, padding: number): Array<{ x: number; width: number }> {
  const columnCount = Math.max(1, Math.min(64, Math.round(Number.isFinite(subdivisions) ? subdivisions : 8)));
  const groupSize = Math.max(1, Math.min(64, Math.round(Number.isFinite(subgroups) ? subgroups : 4)));
  const innerWidth = width - padding * 2;
  const bands: Array<{ x: number; width: number }> = [];
  for (let column = groupSize; column < columnCount; column += groupSize * 2) {
    const end = Math.min(column + groupSize, columnCount);
    bands.push({ x: padding + (column / columnCount) * innerWidth, width: ((end - column) / columnCount) * innerWidth });
  }
  return bands;
}

function customWaveGridRows(rangeMin: number, rangeMax: number, height: number) {
  const min = Number.isFinite(rangeMin) ? rangeMin : -1;
  const max = Number.isFinite(rangeMax) ? rangeMax : 1;
  const ticks = chartScaleTicks(max, min, height, 'vertical');
  const zeroY = (1 - normalizedCustomWaveValue(0, min, max)) / 2;
  const containsZero = (min <= 0 && max >= 0) || (max <= 0 && min >= 0);
  const existingZero = ticks.find((tick) => Math.abs(tick.fraction - zeroY) < 0.0001);
  if (existingZero) {
    existingZero.origin = true;
    if (containsZero) existingZero.label = '0';
    return ticks;
  }
  return [...ticks, { fraction: zeroY, label: containsZero ? '0' : undefined, major: true, origin: true }]
    .sort((left, right) => left.fraction - right.fraction);
}

interface CustomWaveRangeProps {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}

function CustomWaveRange({ label, value, min, max, onChange }: CustomWaveRangeProps) {
  return (
    <label className="custom-wave-node-field custom-wave-node-range">
      <span>{label}</span>
      <input
        type="range"
        tabIndex={-1}
        min={min}
        max={max}
        step={0.001}
        value={value}
        onChange={(event) => {
          onChange(Number(event.currentTarget.value));
          event.currentTarget.blur();
        }}
        onFocus={(event) => event.currentTarget.blur()}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => {
          event.stopPropagation();
          event.currentTarget.blur();
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          event.currentTarget.blur();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      />
      <input
        type="number"
        min={min}
        max={max}
        step={0.001}
        value={formatUnitValue(value)}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        onPointerDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    </label>
  );
}

function customWaveOutputValue(normalizedValue: number, rangeMin: number, rangeMax: number): number {
  const min = Number.isFinite(rangeMin) ? rangeMin : -1;
  const max = Number.isFinite(rangeMax) ? rangeMax : 1;
  return min + ((normalizedValue + 1) / 2) * (max - min);
}

function screenCircleRadius(
  radiusPx: number,
  viewBoxWidth: number,
  viewBoxHeight: number,
  displaySize: ScopeNodeSize,
): { rx: number; ry: number } {
  const scaleX = displaySize.width / viewBoxWidth;
  const scaleY = displaySize.height / viewBoxHeight;
  return {
    rx: radiusPx / Math.max(0.001, scaleX),
    ry: radiusPx / Math.max(0.001, scaleY),
  };
}

function displayAmplitudeRange(value: number | undefined): number {
  const range = Math.abs(Number(value ?? 1));
  return Number.isFinite(range) && range > 0 ? range : 1;
}

function monitorDisplayMode(value: number | undefined, fallback: 'unipolar' | 'bipolar'): 'unipolar' | 'bipolar' {
  if (value === undefined) return fallback;
  return Math.round(value) === 1 ? 'bipolar' : 'unipolar';
}

function amplitudeScaleTicks(
  range: number,
  size: number,
  mode: 'unipolar' | 'bipolar',
  orientation: 'horizontal' | 'vertical' = 'horizontal',
): Array<{ fraction: number; label: string }> {
  const divisions = amplitudeLabelDivisions(size, orientation, mode);
  return Array.from({ length: divisions + 1 }, (_, index) => {
    const fraction = index / divisions;
    const value = mode === 'bipolar'
      ? orientation === 'horizontal'
        ? -range + fraction * range * 2
        : range - fraction * range * 2
      : orientation === 'horizontal'
        ? range * fraction
        : range * (1 - fraction);
    return {
      fraction,
      label: formatAmplitude(value),
    };
  });
}

function amplitudeLabelDivisions(size: number, orientation: 'horizontal' | 'vertical', mode: 'unipolar' | 'bipolar'): number {
  const base = orientation === 'horizontal'
    ? size >= 1120 ? 16 : size >= 560 ? 8 : size >= 360 ? 4 : 2
    : size >= 352 ? 16 : size >= 176 ? 8 : size >= 104 ? 4 : 2;
  return mode === 'bipolar' ? Math.max(2, base) : base;
}

function shouldForceCompactPorts(definition: NodeDefinition): boolean {
  const onlySignalInput = definition.inputs.length === 0
    || (definition.inputs.length === 1 && definition.inputs[0]?.name === 'signal');

  return onlySignalInput
    && definition.outputs.length <= 1;
}

const ROUTING_NODE_COLORS = [
  '#ff4d6d',
  '#ff922b',
  '#ffd43b',
  '#69db7c',
  '#38d9a9',
  '#22b8cf',
  '#4dabf7',
  '#748ffc',
  '#da77f2',
  '#f06595',
] as const;

function routingNodeNumber(value: number | undefined): number {
  return Math.max(1, Math.min(10, Math.round(Number.isFinite(value) ? value ?? 1 : 1)));
}

export function routingNodeColor(value: number | undefined): string {
  return ROUTING_NODE_COLORS[routingNodeNumber(value) - 1];
}

function isSelectorValuePort(name: string): boolean {
  return /^[1-9][0-9]*$/.test(name);
}

function samplesToScopePath(samples: number[], range: number, mode: 'unipolar' | 'bipolar'): string {
  const restingY = mode === 'bipolar' ? 24 : 46;
  if (samples.length < 2) return `M0 ${restingY} L160 ${restingY}`;

  return samples.map((sample, index) => {
    const x = (index / (samples.length - 1)) * 160;
    const normalized = Math.max(-1, Math.min(1, sample / range));
    const y = mode === 'bipolar'
      ? 24 - normalized * 22
      : 46 - Math.abs(normalized) * 44;
    return `${index === 0 ? 'M' : 'L'}${roundPathNumber(x)} ${roundPathNumber(y)}`;
  }).join(' ');
}

interface SpectrumBar {
  level: number;
  startFrequency: number;
  endFrequency: number;
}

function spectrumBarsFromSamples(samples: number[], barCount: number): SpectrumBar[] {
  const frequencyBounds = Array.from({ length: barCount + 1 }, (_, index) => (
    FFT_ANALYSIS_MIN_FREQUENCY * (
      FFT_ANALYSIS_MAX_FREQUENCY / FFT_ANALYSIS_MIN_FREQUENCY
    ) ** (index / barCount)
  ));
  const empty = () => Array.from({ length: barCount }, (_, index) => ({
    level: 0,
    startFrequency: frequencyBounds[index],
    endFrequency: frequencyBounds[index + 1],
  }));
  if (samples.length < 32) return empty();

  const fftSize = largestPowerOfTwoAtMost(Math.min(samples.length, 512));
  if (fftSize < 32) return empty();

  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  const offset = samples.length - fftSize;
  for (let index = 0; index < fftSize; index += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1));
    real[index] = (Number.isFinite(samples[offset + index]) ? samples[offset + index] : 0) * window;
  }

  fftInPlace(real, imaginary);
  const upperBin = fftSize / 2;
  const binFrequency = 1 / FFT_CAPTURE_SECONDS;
  const magnitudes = new Float64Array(upperBin);
  for (let bin = 1; bin < upperBin; bin += 1) {
    magnitudes[bin] = (2 * Math.hypot(real[bin], imaginary[bin])) / fftSize;
  }

  return Array.from({ length: barCount }, (_, barIndex) => {
    const startFrequency = frequencyBounds[barIndex];
    const endFrequency = frequencyBounds[barIndex + 1];
    const start = Math.max(1, Math.floor(startFrequency / binFrequency));
    const end = Math.max(start + 1, Math.ceil(endFrequency / binFrequency));
    let magnitude = 0;
    for (let bin = start; bin < Math.min(end, upperBin); bin += 1) {
      magnitude = Math.max(magnitude, magnitudes[bin] ?? 0);
    }
    const decibels = 20 * Math.log10(Math.max(1e-6, magnitude));
    return {
      level: clamp((decibels + 84) / 84, 0, 1),
      startFrequency,
      endFrequency,
    };
  });
}

function spectrumWindowOpacity(bar: SpectrumBar, windowStart: number, windowEnd: number): number {
  const overlap = Math.max(0, Math.min(bar.endFrequency, windowEnd) - Math.max(bar.startFrequency, windowStart));
  const overlapFraction = overlap / Math.max(1, bar.endFrequency - bar.startFrequency);
  return 0.14 + overlapFraction * 0.86;
}

function frequencyGridTicks(detailWidth: number): ChartGridTick[] {
  const frequencies = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
  const labelled = detailWidth >= 720
    ? new Set(frequencies)
    : detailWidth >= 400
      ? new Set([20, 100, 200, 500, 1000, 2000, 5000, 10000, 20000])
      : new Set([20, 100, 500, 2000, 10000, 20000]);
  return frequencies.map((frequency) => ({
    fraction: frequencyScaleFraction(frequency),
    label: labelled.has(frequency) ? formatFrequency(frequency) : undefined,
    major: labelled.has(frequency),
  }));
}

function frequencyScaleFraction(frequency: number): number {
  const clampedFrequency = clamp(frequency, FFT_ANALYSIS_MIN_FREQUENCY, FFT_ANALYSIS_MAX_FREQUENCY);
  return Math.log(clampedFrequency / FFT_ANALYSIS_MIN_FREQUENCY)
    / Math.log(FFT_ANALYSIS_MAX_FREQUENCY / FFT_ANALYSIS_MIN_FREQUENCY);
}

function formatFrequency(frequency: number): string {
  if (frequency >= 1000) return `${frequency / 1000}k`;
  return `${frequency}`;
}

function largestPowerOfTwoAtMost(value: number): number {
  return 2 ** Math.floor(Math.log2(Math.max(1, value)));
}

function fftInPlace(real: Float64Array, imaginary: Float64Array): void {
  const size = real.length;
  for (let index = 1, reversed = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; reversed & bit; bit >>= 1) reversed ^= bit;
    reversed ^= bit;
    if (index >= reversed) continue;
    [real[index], real[reversed]] = [real[reversed], real[index]];
    [imaginary[index], imaginary[reversed]] = [imaginary[reversed], imaginary[index]];
  }

  for (let length = 2; length <= size; length <<= 1) {
    const angle = -2 * Math.PI / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const evenIndex = start + offset;
        const oddIndex = evenIndex + length / 2;
        const oddReal = real[oddIndex] * twiddleReal - imaginary[oddIndex] * twiddleImaginary;
        const oddImaginary = real[oddIndex] * twiddleImaginary + imaginary[oddIndex] * twiddleReal;
        real[oddIndex] = real[evenIndex] - oddReal;
        imaginary[oddIndex] = imaginary[evenIndex] - oddImaginary;
        real[evenIndex] += oddReal;
        imaginary[evenIndex] += oddImaginary;
        const nextTwiddleReal = twiddleReal * stepReal - twiddleImaginary * stepImaginary;
        twiddleImaginary = twiddleReal * stepImaginary + twiddleImaginary * stepReal;
        twiddleReal = nextTwiddleReal;
      }
    }
  }
}

function roundPathNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatAmplitude(value: number): string {
  if (!Number.isFinite(value)) return '1';
  if (value >= 100) return `${Math.round(value)}`;
  if (value >= 10) return trimTrailingZeros(value.toFixed(1));
  if (value >= 1) return trimTrailingZeros(value.toFixed(2));
  return trimTrailingZeros(value.toFixed(3));
}

function formatAccumulatorValue(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value)) return `${value}`;
  return trimTrailingZeros(value.toFixed(3));
}

function trimTrailingZeros(value: string): string {
  return value.replace(/\.?0+$/, '');
}

function formatUnitValue(value: number): string {
  return trimTrailingZeros(clamp(value, 0, 1).toFixed(3));
}

function buttonModeFromValue(value: number): SpagbolControlButtonMode {
  const mode = Math.round(value);
  if (mode === 1) return 'trigger';
  if (mode === 2) return 'temporary';
  return 'toggle';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

interface PortNameLabelProps {
  name: string;
  editable: boolean;
  draggable?: boolean;
  selected?: boolean;
  preview?: boolean;
  activeDragTarget?: boolean;
  activeDragSource?: boolean;
  onPointerDown?: (event: PointerEvent<HTMLSpanElement>) => void;
  onChange: (nextName: string) => void;
}

function PortNameLabel({
  name,
  editable,
  draggable = false,
  selected = false,
  preview = false,
  activeDragTarget = false,
  activeDragSource = false,
  onPointerDown,
  onChange,
}: PortNameLabelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(name);
    }
  }, [editing, name]);

  useEffect(() => {
    if (!editing) return;

    const animationFrame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [editing]);

  function commitDraft() {
    onChange(draft);
    setEditing(false);
  }

  function cancelDraft() {
    setDraft(name);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="port-name-editor nodrag nopan"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commitDraft}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            commitDraft();
          }
          if (event.key === 'Escape') {
            cancelDraft();
          }
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        spellCheck={false}
      />
    );
  }

  return (
    <span
      className={[
        'port-name-label',
        editable ? 'port-name-label-editable' : '',
        draggable ? 'port-name-label-draggable nodrag nopan' : '',
          selected ? 'port-name-label-selected' : '',
          preview ? 'port-name-label-preview' : '',
        activeDragTarget ? 'port-name-label-drag-target' : '',
        activeDragSource ? 'port-name-label-drag-source' : '',
      ].filter(Boolean).join(' ')}
      draggable={draggable}
        title={preview
          ? 'Drop a connection here to create this port'
          : editable
            ? 'Drag to reorder. Double-click to rename'
            : undefined}
        onPointerDown={(event) => {
          onPointerDown?.(event);
        }}
      onDoubleClick={(event) => {
        if (!editable) return;
        event.preventDefault();
        event.stopPropagation();
        setEditing(true);
      }}
    >
      {displayPortName(name)}
    </span>
  );
}

function displayPortName(name: string): string {
  if (name === 'originalFrequency') return 'original frequency';
  if (name === 'baseLevel') return 'base level';
  if (name === 'minFreq') return 'min freq';
  if (name === 'maxFreq') return 'max freq';
  if (name === 'rangeMin') return 'range min';
  if (name === 'rangeMax') return 'range max';
  if (name === 'beatLength') return 'beat length';
  if (name === 'gateLength') return 'gate length';
  if (name === 'midiChannel') return 'midi channel';
  if (name === 'midiCc') return 'midi cc';
  if (name === 'xMin') return 'x min';
  if (name === 'xMax') return 'x max';
  if (name === 'xMidiChannel') return 'x midi channel';
  if (name === 'xMidiCc') return 'x midi cc';
  if (name === 'yMin') return 'y min';
  if (name === 'yMax') return 'y max';
  if (name === 'yMidiChannel') return 'y midi channel';
  if (name === 'yMidiCc') return 'y midi cc';
  if (name === 'startNote') return 'start note';
  return name;
}

function canLearnMidiCc(nodeType: NodeType | null, inputName: string): boolean {
  return (
    (nodeType === 'MidiCc' && inputName === 'cc') ||
    ((nodeType === 'Slider' || nodeType === 'Button') && inputName === 'midiCc') ||
    (nodeType === 'Joystick' && (inputName === 'xMidiCc' || inputName === 'yMidiCc'))
  );
}

type MidiCcLearnEvent = NonNullable<NonNullable<TeiaNodeData['midiInput']>['lastControlChange']>;

interface NumericScrubberProps {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  replacedBySetLink?: boolean;
  onChange: (value: number) => void;
  onClear?: () => void;
  midiLearnEvent?: MidiCcLearnEvent;
  onEditStart?: () => void;
  onMidiLearn?: (event: MidiCcLearnEvent) => void;
}

function NoteRangeSelect({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const lower = clamp(Math.round(min), 0, 127);
  const upper = clamp(Math.round(max), lower, 127);
  const selected = clamp(Math.round(value), lower, upper);
  return (
    <>
      <PortNameLabel name={label} editable={false} draggable={false} preview={false} selected={false} activeDragTarget={false} activeDragSource={false} onChange={() => undefined} />
      <select
        className="teia-port-select nodrag nopan"
        aria-label={`Roll ${label}`}
        value={String(selected)}
        onChange={(event) => {
          onChange(Number(event.currentTarget.value));
          event.currentTarget.blur();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
      >
        {Array.from({ length: upper - lower + 1 }, (_, offset) => lower + offset).map((note) => (
          <option key={note} value={note}>{midiNoteLabel(note)}</option>
        ))}
      </select>
    </>
  );
}

function NumericScrubber({ midiLearnEvent, onMidiLearn, replacedBySetLink, ...props }: NumericScrubberProps) {
  const { editor } = useSpagbol();
  return <SpagbolControlNumber {...props} replaced={replacedBySetLink}
    capture={midiLearnEvent && onMidiLearn ? { id: midiLearnEvent.id, value: midiLearnEvent.cc, onCapture: () => onMidiLearn(midiLearnEvent) } : undefined}
    onGestureStart={() => { if (!editor.getSnapshot().gesture) editor.beginGesture('Edit Teia value'); }}
    onGestureEnd={cancel => { if (!editor.getSnapshot().gesture) return; if (cancel) editor.cancelGesture(); else editor.commitGesture(); }} />;
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

export function makeNodeId(type: PatchNode['type'] | 'node', existingIds: Set<string>): string {
  const base = type.toLowerCase();
  let index = 1;
  let id = `${base}_${index}`;
  while (existingIds.has(id)) {
    index += 1;
    id = `${base}_${index}`;
  }
  return id;
}

/** DSP layouts can position shared ports; they never create a second connection system. */
function Handle(props: React.ComponentProps<typeof FlowHandle>) {
  const { editor, projection } = useSpagbol();
  const flowId = useNodeId();
  const presented = useContext(TeiaNodeModel);
  if (projection) return null;
  const node = presented ?? editor.graph.nodes.find(node => `node:${node.id}` === flowId);
  const direction = props.type === 'source' ? 'output' : 'input';
  const name = String(props.id ?? '').replace(/^(in|out):/, '');
  const port = node && portsFor(node, editor.nodes).find(port => port.direction === direction && portName(node, port.id, direction) === name);
  if (!port && String(props.id).startsWith('virtual:')) return <SpagbolNodePort port={{ id: 'teia.virtual', label: 'virtual route', direction }} connectable={false} style={{ opacity: 0 }} />;
  if (!port) return null;
  return <SpagbolNodePort port={port} connectable={props.isConnectable !== false} style={props.style} className={props.className} position={props.position} />;
}
