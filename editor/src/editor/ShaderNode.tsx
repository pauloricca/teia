import { Fm1ModeContext } from './Fm1ModeContext';
import { isFm1NodeImplemented } from '../audio/fm1Support';
import { Handle, Position, useConnection, useReactFlow, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import {
  memo,
  useEffect,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import {
  CUSTOM_WAVE_MODES,
  customWaveUsesSustainEnd,
  customWaveUsesSustainStart,
  customWaveWithBaseLevel,
  customWaveBank,
  normalizedCustomWaveValue,
  normalizeCustomWave,
} from '../graph/customWave';
import {
  getNodeDefinition,
  getNodeTypeLabel,
  NODE_TYPE_LIST,
  sequencerCellParamName,
  sequencerGateParamName,
  sequencerGatesForRow,
  sequencerTriggerPositionParamName,
  sequencerTriggersForRow,
  sequencerUsesGateMode,
  SEQUENCER_GATE_INITIALIZED_PARAM,
  SEQUENCER_GATE_MODE_PARAM,
  SEQUENCER_INDEX_OUTPUT,
  ROLL_ROWS,
  rollCellParamName,
  rollGateParamName,
  rollGateVelocityParamName,
  rollGatesForRow,
  rollShape,
  sequencerOutputName,
  sequencerShape,
  sequencerStepVelocityParamName,
  trimOverlappingSequencerGates,
  SEQUENCER_MIN_VELOCITY,
} from '../graph/nodeTypes';
import type { CustomWavePoint, CustomWaveSettings, NodeDefinition, NodeType, PatchNode } from '../graph/types';
import { midiNoteLabel, normalisePitchClass, PITCH_CLASSES, QUANTISE_SCALES } from '../graph/musicScales';
import {
  MIN_RUNTIME_CONTAINER_WIDTH,
  MIN_SPAWN_WIDTH,
  SPREAD_HEADER_HEIGHT,
  runtimeContainerPortsHeight,
  runtimeContainerSize,
} from '../graph/spread';
import { formatNumericValue } from './numericDisplay';
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
  type ShaderFlowEdge,
  type ShaderFlowNode,
  type ShaderNodeData,
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
const FFT_CAPTURE_SECONDS = 0.012;
const FFT_ANALYSIS_MIN_FREQUENCY = 20;
const FFT_ANALYSIS_MAX_FREQUENCY = 20000;

export const ShaderNode = memo(function ShaderNode({ id: flowNodeId, data, selected, dragging }: NodeProps<ShaderFlowNode>) {
  const node = data.patchNode;
  const fm1Mode = useContext(Fm1ModeContext);
  const fm1Unsupported = fm1Mode && node.type !== null && !isFm1NodeImplemented(node.type);
  const connectionInProgress = useConnection((connection) => connection.inProgress);
  const isCanvasLocked = data.isCanvasLocked === true;
  const scopeGradientId = `scope-gradient-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const reactFlow = useReactFlow<ShaderFlowNode, ShaderFlowEdge>();
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
  const customWaveEditorRef = useRef<SVGSVGElement | null>(null);
  const fftDisplayRef = useRef<HTMLDivElement | null>(null);
  const fftBoundaryDragRef = useRef<{ boundary: 'min' | 'max'; pointerId: number } | null>(null);
  const customWaveDragRef = useRef<{ pointerId: number; index: number } | null>(null);
  const customWaveClickRef = useRef<{ index: number | null; time: number }>({ index: null, time: 0 });
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
  const [customWaveDragPointIndex, setCustomWaveDragPointIndex] = useState<number | null>(null);
  const [expressionDraft, setExpressionDraft] = useState(node.expression ?? '');
  const [imageAspectRatio, setImageAspectRatio] = useState(DEFAULT_IMAGE_ASPECT_RATIO);
  const [pointerOver, setPointerOver] = useState(false);
  const definition = node.type ? getNodeDefinition(node as PatchNode) : null;
  const isExpression = node.type === 'Expression';
  const isGroup = node.type === 'Group';
  const groupUiPreview = isGroup ? data.groupUiPreview : undefined;
  const isSpread = node.type === 'Spread';
  const isSpawn = node.type === 'Spawn';
  const isRuntimeContainer = isSpread || isSpawn;
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
  const showMidiNoteDisplay = node.type === 'MidiNote'
    || node.type === 'MidiNoteOn'
    || node.type === 'MidiNoteOff';
  const showCustomWaveEditor = node.type === 'CustomWave';
  const showKinkOscGraphic = node.type === 'KinkOsc';
  const showSampleUpload = node.type === 'SamplePlayer';
  const showSampleVideo = showSampleUpload && Boolean(node.sample?.url && isVideoSampleUrl(node.sample.url));
  const showBufferDisplay = node.type === 'Buffer';
  const showImageDisplay = node.type === 'Image';
  const sliderUnitValue = showSliderDisplay
    ? clamp(data.midiSliderValue ?? data.audioSliderValue ?? node.params.value ?? 0.5, 0, 1)
    : 0;
  const sliderMappedUnitValue = sliderUnitValue ** (2 ** -clamp(node.params.curve ?? 0, -8, 8));
  const sliderAbsoluteValue = (node.params.min ?? 0)
    + sliderMappedUnitValue * ((node.params.max ?? 1) - (node.params.min ?? 0));
  const sliderTitleSuffix = showSliderDisplay && pointerOver
    ? `: ${formatSliderReadoutValue(sliderAbsoluteValue)} (${formatUnitValue(sliderMappedUnitValue)})`
    : undefined;
  const showTopGraphic = showMeterDisplay || showScopeDisplay || showFftDisplay || showSliderDisplay || showJoystickDisplay || showButtonDisplay || showKeysDisplay || showCustomWaveEditor || showKinkOscGraphic || showSampleUpload || showBufferDisplay || showImageDisplay || showRollDisplay || Boolean(groupUiPreview);
  const imageX = centeredCoordinateToUnit(data.audioImagePosition?.x ?? node.params.x ?? 0);
  const imageY = centeredCoordinateToUnit(data.audioImagePosition?.y ?? node.params.y ?? 0);
  const showResizableDisplay = showMeterDisplay || showScopeDisplay || showFftDisplay || showSliderDisplay || showJoystickDisplay || showButtonDisplay || showKeysDisplay || showCustomWaveEditor || showSampleUpload || showBufferDisplay || showImageDisplay || showSequencerDisplay || showRollDisplay || isRuntimeContainer;
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
  const defaultDisplaySize = isRuntimeContainer
    ? runtimeContainerSize(node)
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
          '--sequencer-label-column-width': `${sequencerLabelColumnWidth}px`,
          '--sequencer-grid-height': `${sequencerGridHeight}px`,
        } : {}),
        ...(roll ? {
          '--roll-steps': String(roll.steps),
          '--roll-grid-height': `${rollGridHeight}px`,
        } : {}),
      } as CSSProperties)
    : undefined;
  const dspErrors = data.dspErrors ?? [];
  const hasDspErrors = dspErrors.length > 0;
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
  const inputStyle = { '--input-label-width': inputLabelWidth } as CSSProperties;
  const nodeStyle = {
    ...(nodeSizeStyle ?? {}),
    '--input-label-width': inputLabelWidth,
    '--node-scale': String(node.scale ?? 1),
    '--canvas-header-title-scale': String(headerTitleScale),
    '--custom-wave-point-screen-scale': String(customWavePointScale),
    '--graph-screen-scale': String(graphScreenEmphasis / graphZoomScale),
    '--graph-stroke-scale': String(1 / graphZoomScale),
    ...(groupUiPreview ? { '--group-ui-width': `${groupUiPreview.width}px` } : {}),
    ...(isRoutingNode ? { '--routing-color': routingNodeColor(node.params.number) } : {}),
  } as CSSProperties;
  const className = [
    'shader-node',
    showMeterDisplay ? 'shader-node-meter' : '',
    showScopeDisplay ? 'shader-node-scope' : '',
    showFftDisplay ? 'shader-node-fft' : '',
    showSliderDisplay ? 'shader-node-slider' : '',
    showJoystickDisplay ? 'shader-node-joystick' : '',
    showButtonDisplay ? 'shader-node-button' : '',
    showKeysDisplay ? 'shader-node-keys' : '',
    showAccumulatorDisplay ? 'shader-node-accumulator' : '',
    showQuantiseDisplay ? 'shader-node-quantise' : '',
    showSequencerDisplay ? 'shader-node-sequencer' : '',
    showRollDisplay ? 'shader-node-roll' : '',
    showAudioOutputDisplay ? 'shader-node-audio-out' : '',
    showSampleUpload ? 'shader-node-sampleplayer' : '',
    showBufferDisplay ? 'shader-node-buffer' : '',
    showImageDisplay ? 'shader-node-image' : '',
    showAudioInputDisplay ? 'shader-node-audio-input' : '',
    showMidiNoteDisplay ? 'shader-node-midi-note' : '',
    isRuntimeContainer ? 'shader-node-spread' : '',
    showCustomWaveEditor ? 'shader-node-custom-wave' : '',
    isExpression ? 'shader-node-expression' : '',
    isGroup ? 'shader-node-group' : '',
    hasDspErrors ? 'shader-node-dsp-error' : '',
    fm1Unsupported ? 'shader-node-fm1-unsupported' : '',
    selected ? 'shader-node-selected' : '',
    dragging ? 'shader-node-dragging' : '',
    compactPorts ? 'shader-node-compact' : '',
    isAreaCollapsedPresentation ? 'shader-node-area-hidden' : '',
    isAreaUiCollapsedPresentation ? 'shader-node-area-ui-collapsed' : '',
    isCanvasLocked ? 'shader-node-canvas-locked' : '',
    node.enabled === false ? 'shader-node-disabled' : '',
    data.onHeaderDoubleClick ? 'shader-node-resettable-header' : '',
    usesAutoInitialWidth ? 'shader-node-auto-width' : '',
  ].filter(Boolean).join(' ');

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
    const animationFrame = requestAnimationFrame(() => updateNodeInternals(node.id));
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

  useEffect(() => {
    function handlePointerMove(event: globalThis.PointerEvent) {
      const drag = customWaveDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !customWave) return;

      event.preventDefault();
      const point = customWavePointFromPointer(event);
      if (!point) return;
      const lastIndex = customWave.points.length - 1;
      const previous = customWave.points[drag.index - 1]?.x ?? 0;
      const next = customWave.points[drag.index + 1]?.x ?? 1;
      const x = drag.index === 0
        ? 0
        : drag.index === lastIndex
          ? 1
          : clamp(point.x, previous + 0.001, next - 0.001);
      const nextPoints = customWave.points.map((entry, index) => (
        index === drag.index ? { x, y: point.y } : entry
      ));
      scheduleCustomWaveDragCommit({ ...customWave, points: nextPoints }, `custom-wave-point:${node.id}`);
    }

    function stopDragging(pointerId: number) {
      if (!customWaveDragRef.current || customWaveDragRef.current.pointerId !== pointerId) return;

      flushCustomWaveDragCommit();
      customWaveDragRef.current = null;
      setCustomWaveDragPointIndex(null);
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
  }, [customWave, node.id]);

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
    const sequencerBody = event.currentTarget.closest('.shader-node-sequencer')?.querySelector<HTMLElement>('.shader-node-body-sequencer');
    const sequencerInputs = sequencerBody?.querySelector<HTMLElement>('.shader-inputs');
    const sequencerOutputs = sequencerBody?.querySelector<HTMLElement>('.shader-outputs');
    const hasVisibleSequencerInputs = sequencerInputs?.querySelector('.shader-port') !== null;
    const hasVisibleSequencerOutputs = sequencerOutputs?.querySelector('.shader-port') !== null;
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
        ?? (isRuntimeContainer
          ? (isSpawn ? MIN_SPAWN_WIDTH : MIN_RUNTIME_CONTAINER_WIDTH)
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

  function customWavePointFromPointer(event: Pick<globalThis.PointerEvent, 'clientX' | 'clientY'>): CustomWavePoint | null {
    const editor = customWaveEditorRef.current;
    if (!editor) return null;

    const rect = editor.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const padding = 12;
    const width = 300;
    const height = 128;
    const innerWidth = width - padding * 2;
    const innerHeight = height - padding * 2;
    const screenX = clamp(((event.clientX - rect.left) / rect.width) * width, padding, width - padding);
    const screenY = clamp(((event.clientY - rect.top) / rect.height) * height, padding, height - padding);

    return {
      x: clamp((screenX - padding) / innerWidth, 0, 1),
      y: clamp((1 - ((screenY - padding) / innerHeight)) * 2 - 1, -1, 1),
    };
  }

  function removeCustomWavePoint(index: number): boolean {
    if (!customWave || index <= 0 || index >= customWave.points.length - 1) return false;

    const nextPoints = customWave.points.filter((_, pointIndex) => pointIndex !== index);
    customWaveDragRef.current = null;
    setCustomWaveDragPointIndex(null);
    commitCustomWave({ ...customWave, points: nextPoints }, `custom-wave-point:${node.id}`);
    return true;
  }

  function handleCustomWavePointerDown(event: PointerEvent<SVGSVGElement>) {
    if (!customWave || event.button !== 0) return;

    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element
      ? event.target.closest<SVGElement>('.custom-wave-hit-target, .custom-wave-handle')
      : null;
    const targetIndex = target?.dataset.index ? Number(target.dataset.index) : null;
    const lastIndex = customWave.points.length - 1;

    if (target && Number.isInteger(targetIndex)) {
      const now = performance.now();
      if (
        targetIndex !== null &&
        targetIndex > 0 &&
        targetIndex < lastIndex &&
        customWaveClickRef.current.index === targetIndex &&
        now - customWaveClickRef.current.time < 360
      ) {
        customWaveClickRef.current = { index: null, time: 0 };
        removeCustomWavePoint(targetIndex);
        return;
      }

      customWaveClickRef.current = { index: targetIndex, time: now };
      if (targetIndex === null || targetIndex <= 0 || targetIndex >= lastIndex) return;
      customWaveDragRef.current = { pointerId: event.pointerId, index: targetIndex };
      setCustomWaveDragPointIndex(targetIndex);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }

    const point = customWavePointFromPointer(event);
    if (!point) return;

    customWaveClickRef.current = { index: null, time: 0 };
    const nextPoints = [...customWave.points, point].sort((a, b) => a.x - b.x);
    const nextIndex = nextPoints.reduce((bestIndex, item, index) => {
      const best = nextPoints[bestIndex];
      const distance = Math.abs(item.x - point.x) + Math.abs(item.y - point.y);
      const bestDistance = Math.abs(best.x - point.x) + Math.abs(best.y - point.y);
      return distance < bestDistance ? index : bestIndex;
    }, 0);
    commitCustomWave({ ...customWave, points: nextPoints }, `custom-wave-point:${node.id}`);
    customWaveDragRef.current = { pointerId: event.pointerId, index: nextIndex };
    setCustomWaveDragPointIndex(nextIndex);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleCustomWaveDoubleClick(event: MouseEvent<SVGSVGElement>) {
    if (!customWave) return;

    const target = event.target instanceof Element
      ? event.target.closest<SVGElement>('.custom-wave-hit-target, .custom-wave-handle')
      : null;
    if (!target?.dataset.index) return;

    event.preventDefault();
    event.stopPropagation();
    removeCustomWavePoint(Number(target.dataset.index));
  }

  if (isRuntimeContainer) {
    return (
      <div
        className={`spread-port-panel${isAreaUiCollapsedPresentation ? ' spread-port-panel-collapsed' : ''}`}
        style={{
          '--spread-port-width': `${displaySize.width}px`,
          '--spread-port-height': `${runtimeContainerPortsHeight(node)}px`,
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
                  'shader-handle shader-handle-input spread-count-handle spawn-trigger-handle',
                  selectedLinkInputs.includes('trigger') ? 'shader-handle-selected-link' : '',
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
                  'shader-handle shader-handle-input spread-count-handle spawn-release-trigger-handle',
                  selectedLinkInputs.includes('release trigger') ? 'shader-handle-selected-link' : '',
                ].filter(Boolean).join(' ')}
              />
              <span>release trigger</span>
            </div>
          </div>
        ) : (
          <div className="spread-port-input">
            <Handle
              id="in:count"
              type="target"
              position={Position.Left}
              className={[
                'shader-handle shader-handle-input spread-count-handle',
                selectedLinkInputs.includes('count') ? 'shader-handle-selected-link' : '',
              ].filter(Boolean).join(' ')}
            />
            <span>count</span>
            <NumericScrubber
              value={node.params.count ?? 1}
              min={0}
              integer
              replacedBySetLink={setLinkInputPorts.has('count')}
              onChange={(value) => data.onParamChange(node.id, 'count', value)}
            />
          </div>
        )}
        {!isAreaUiCollapsedPresentation ? (
          <>
            {isSpawn ? (
              <div className="spread-port-output spawn-instance-gate-port">
                <span>instance gate</span>
                <Handle
                  id="out:instance gate"
                  type="source"
                  position={Position.Bottom}
                  className={[
                    'shader-handle shader-handle-output spread-item-index-handle',
                    selectedLinkOutputs.includes('instance gate') ? 'shader-handle-selected-link' : '',
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
                  `shader-handle ${isSpawn ? 'shader-handle-input' : 'shader-handle-output'} spread-item-index-handle`,
                  (isSpawn
                    ? selectedLinkInputs.includes('kill trigger')
                  : selectedLinkOutputs.includes('item index')) ? 'shader-handle-selected-link' : '',
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
          'routing-node-marker',
          fm1Unsupported ? 'shader-node-fm1-unsupported' : '',
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

  return (
    <div
      ref={nodeElementRef}
      className={className}
      style={nodeStyle}
      onPointerEnter={() => setPointerOver(true)}
      onPointerLeave={() => setPointerOver(false)}
      onDragOver={handleSampleDragOver}
      onDrop={handleSampleDrop}
    >
      <div
        className="shader-node-title"
        title={data.onHeaderDoubleClick ? 'Double-click to reset this control to the subpatch defaults' : undefined}
        onPointerDown={data.onHeaderDoubleClick ? (event) => event.stopPropagation() : undefined}
        onMouseDown={data.onHeaderDoubleClick ? (event) => event.stopPropagation() : undefined}
        onClick={data.onHeaderDoubleClick ? (event) => event.stopPropagation() : undefined}
        onDoubleClickCapture={data.onHeaderDoubleClick ? (event) => {
          event.preventDefault();
          event.stopPropagation();
          data.onHeaderDoubleClick?.(node.id);
        } : undefined}
      >
        {isRoutingNode ? <Handle id={node.type === 'Send' ? 'virtual:send' : 'virtual:receive'} type={node.type === 'Send' ? 'source' : 'target'} position={node.type === 'Send' ? Position.Right : Position.Left} isConnectable={false} className="virtual-route-handle" /> : null}
        {showHeaderInputPort && headerInputPort ? (
          <Handle
            id={`in:${headerInputPort}`}
            type="target"
            position={Position.Left}
            className={[
              'shader-handle shader-handle-input shader-handle-input-title',
              selectedLinkInputs.includes(headerInputPort) ? 'shader-handle-selected-link' : '',
            ].filter(Boolean).join(' ')}
            onDoubleClick={(event) => {
              event.stopPropagation();
              data.onPortDoubleClick(node.id, 'input', headerInputPort);
            }}
          />
        ) : null}
        <div className="node-title-control-shell">
          {compactPorts && !revealCompactPorts ? (
            <CollapsedNodeLabel
              nodeType={node.type}
              customLabel={node.customLabel}
              displaySuffix={sliderTitleSuffix}
              onChange={(label) => data.onCustomLabelChange?.(node.id, label)}
              onSelect={(additive) => data.onTitleSelect?.(node.id, additive)}
            />
          ) : (
            <NodeTypePicker
              nodeType={node.type}
              displayLabel={isGroup ? node.subpatchName ?? node.id : undefined}
              closedSuffix={sliderTitleSuffix}
              isEditingSubpatch={data.isEditingSubpatch === true}
              open={data.isTypePickerOpen}
              onOpen={() => data.onTypeEditStart(node.id)}
              onClose={data.onTypeEditEnd}
              onCancel={() => data.onTypeEditCancel(node.id)}
              onChange={(type) => data.onTypeChange(node.id, type)}
              onConvertToArea={() => data.onConvertToArea(node.id)}
              onCustomLabelCommit={isGroup ? (label) => data.onSubpatchNameChange?.(node.id, label) : undefined}
            />
          )}
        </div>
        {!forceCompactPorts && !isAreaUiCollapsedPresentation ? (
          <button
            className="node-enabled-toggle nodrag nopan"
            type="button"
            aria-label={node.enabled === false ? 'Enable node' : 'Disable node'}
            title={node.enabled === false ? 'Enable node' : 'Disable node'}
            aria-pressed={node.enabled !== false}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              data.onEnabledChange?.(node.id, node.enabled === false);
            }}
          >
            <span className="node-enabled-icon" aria-hidden="true" />
          </button>
        ) : null}
        {!forceCompactPorts && !isAreaUiCollapsedPresentation ? (
          <button
            className="node-compact-toggle nodrag nopan"
            type="button"
            aria-label={compactPorts ? 'Expand ports' : 'Compact ports'}
            title={compactPorts ? 'Expand ports' : 'Compact ports'}
            aria-pressed={compactPorts}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              data.onCompactToggle(node.id, !compactPorts);
            }}
          >
            <span
              className={[
                'node-compact-icon',
                compactPorts ? 'node-compact-icon-compact' : 'node-compact-icon-expanded',
              ].join(' ')}
              aria-hidden="true"
            />
          </button>
        ) : null}
        {fm1Unsupported ? <span className="node-dsp-error-marker" title="This node is not implemented or verified on FM1" aria-label="Not supported on FM1">!</span> : null}
        {hasDspErrors ? (
          <span
            className="node-dsp-error-marker"
            title={dspErrors.join('\n')}
            aria-label={`${dspErrors.length} DSP error${dspErrors.length === 1 ? '' : 's'}`}
          >
            !
          </span>
        ) : null}
        {showHeaderOutputPort && headerOutputPort ? (
          <Handle
            id={`out:${headerOutputPort}`}
            type="source"
            position={Position.Right}
            className={[
              'shader-handle shader-handle-output shader-handle-output-title',
              selectedLinkOutputs.includes(headerOutputPort) ? 'shader-handle-selected-link' : '',
            ].filter(Boolean).join(' ')}
            onDoubleClick={(event) => {
              event.stopPropagation();
              data.onPortDoubleClick(node.id, 'output', headerOutputPort);
            }}
          />
        ) : null}
      </div>
      {definition ? (
        (() => {
          const inputPorts = [
            ...definition.inputs
              .filter((input) => input.name !== headerInputPort)
              .map((input) => ({ ...input, preview: false })),
            ...(previewInputPort && !definition.inputs.some((input) => input.name === previewInputPort)
              ? [{ name: previewInputPort, preview: true }]
              : []),
          ];
          const outputPorts = [
            ...definition.outputs.map((output) => ({ ...output, preview: false })),
            ...(previewOutputPort && !definition.outputs.some((output) => output.name === previewOutputPort)
              ? [{ name: previewOutputPort, preview: true }]
              : []),
          ];
          const visibleInputPorts = inputPorts.filter((input) => (
            input.preview || showAllPorts || connectedInputPorts.has(input.name)
          ));
          const visibleOutputPorts = outputPorts.filter((output) => (
            output.preview || showAllPorts || connectedOutputPorts.has(output.name)
          ));
          const normalOutputPorts = showSequencerDisplay
            ? visibleOutputPorts.filter((output) => output.name === SEQUENCER_INDEX_OUTPUT)
            : visibleOutputPorts.filter((output) => output.name !== headerOutputPort);
          const newPortSide = node.type === 'Outs' ? 'input' : 'output';
          const newPortLabel = node.type === 'Outs' ? 'new output' : node.type === 'Params' ? 'new param' : 'new input';
          const hasNewPortPlaceholder = node.type === 'Ins' || node.type === 'Params' || node.type === 'Outs';
          const showBody = !compactPorts
            || isExpression
            || showSampleUpload
            || showBufferDisplay
            || showImageDisplay
            || showAudioInputDisplay
            || showMidiNoteDisplay
            || showTempoDisplay
            || showSequencerDisplay
            || showRollDisplay
            || showCustomWaveEditor
            || showSliderDisplay
            || showJoystickDisplay
            || showButtonDisplay
            || showKeysDisplay
            || showAccumulatorDisplay
            || showAudioOutputDisplay
            || visibleInputPorts.length > 0
            || normalOutputPorts.length > 0
            || hasNewPortPlaceholder
            || showMeterDisplay
            || showScopeDisplay
            || showFftDisplay
            || isRuntimeContainer;

          if (!showBody) return null;

          return (
        <div className={[
          'shader-node-body',
          isExpression ? 'shader-node-body-expression' : '',
          showAccumulatorDisplay ? 'shader-node-body-accumulator' : '',
          showSequencerDisplay ? 'shader-node-body-sequencer' : '',
          showRollDisplay ? 'shader-node-body-roll' : '',
          showAudioOutputDisplay ? 'shader-node-body-audio-out' : '',
          showAudioInputDisplay ? 'shader-node-body-audio-input' : '',
          showMidiNoteDisplay ? 'shader-node-body-midi-note' : '',
          isRuntimeContainer ? 'shader-node-body-spread' : '',
          showTopGraphic ? 'shader-node-body-graphic' : '',
          !showSequencerDisplay && normalOutputPorts.length === 0 ? 'shader-node-body-no-outputs' : '',
        ].filter(Boolean).join(' ')}>
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
          <div className={showTopGraphic ? 'shader-node-content-graphic' : 'shader-node-content-graphic-empty'}>
          {groupUiPreview ? (
            <div
              className="group-ui-preview nodrag nopan"
              style={{ width: groupUiPreview.width, height: groupUiPreview.height }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              {groupUiPreview.nodes.map((previewNode) => (
                <div
                  key={previewNode.id}
                  className="group-ui-preview-node"
                  style={{ left: previewNode.position.x, top: previewNode.position.y }}
                >
                  <ShaderNode {...({ data: previewNode.data, selected: false, dragging: false } as NodeProps<ShaderFlowNode>)} />
                </div>
              ))}
            </div>
          ) : null}
          {isRuntimeContainer ? <div className="spread-node-fill" aria-hidden="true" /> : null}
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
            <div className="shader-node-full-width-display image-node-display nodrag nopan" aria-label={node.image?.url ? 'Image coordinate preview' : 'Image preview'}>
              {node.image?.url ? <img src={node.image.url} alt={node.image.name} draggable={false} onLoad={handleImageLoad} /> : <span>Select an image</span>}
              {node.image?.url ? <>
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
              activePointIndex={customWaveDragPointIndex}
              editorRef={customWaveEditorRef}
              onPointerDown={handleCustomWavePointerDown}
              onDoubleClick={handleCustomWaveDoubleClick}
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
            <SliderDisplay
              value={node.params.value ?? 0.5}
              displayValue={data.midiSliderValue ?? data.audioSliderValue}
              direction={Math.round(node.params.direction ?? 0) === 1 ? 'vertical' : 'horizontal'}
              onChange={(value) => data.onParamChange(node.id, 'value', value)}
            />
          ) : null}
          {showJoystickDisplay ? (
            <JoystickDisplay
              x={data.midiJoystickPosition?.x ?? node.params.x ?? 0.5}
              y={data.midiJoystickPosition?.y ?? node.params.y ?? 0.5}
              elasticity={node.params.elasticity ?? 0}
              onChange={(x, y) => data.onParamsChange(node.id, { x, y })}
            />
          ) : null}
          {showButtonDisplay ? (
            <ButtonDisplay
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
                data.onParamChange(node.id, 'note', note ?? 0);
                data.onParamChange(node.id, 'frequency', note === null ? 0 : midiNoteToFrequency(note));
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
          <div className={[
            showTopGraphic ? 'shader-node-content-ports' : 'shader-node-content-ports-empty',
            normalOutputPorts.length === 0 ? 'shader-node-content-ports-no-outputs' : '',
          ].filter(Boolean).join(' ')}>
          <div className="shader-ports shader-inputs" style={inputStyle}>
            {visibleInputPorts.map((input) => (
            <div
              className={[
                'shader-port shader-port-input',
                input.preview ? 'shader-port-preview' : '',
              ].filter(Boolean).join(' ')}
              key={`${input.preview ? 'preview' : 'port'}:${input.name}`}
              ref={(element) => {
                inputPortRowsRef.current[input.name] = element;
              }}
              onDoubleClick={(event) => {
                if (input.preview) return;
                if (input.connectable === false) return;
                event.stopPropagation();
                data.onPortDoubleClick(node.id, 'input', input.name);
              }}
            >
              {input.connectable !== false ? (
                <Handle
                  id={`in:${input.name}`}
                  type="target"
                  position={Position.Left}
                  className={[
                    'shader-handle shader-handle-input',
                    selectedLinkInputs.includes(input.name) ? 'shader-handle-selected-link' : '',
                  ].filter(Boolean).join(' ')}
                  onDoubleClick={(event) => {
                    if (input.preview) return;
                    event.stopPropagation();
                    data.onPortDoubleClick(node.id, 'input', input.name);
                  }}
                />
              ) : null}
              {isSelector && isSelectorValuePort(input.name) && !input.preview ? (
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
              ) : showKeysDisplay && input.name === 'mode' && !input.preview ? (
                <>
                  <PortNameLabel
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                    name={input.name}
                    editable={false}
                    draggable={false}
                    preview={false}
                    selected={data.selectedPort?.side === 'input' && data.selectedPort.name === input.name}
                    activeDragTarget={false}
                    activeDragSource={false}
                    onChange={() => undefined}
                  />
                  <select
                    className="shader-port-select nodrag nopan"
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
                  name={input.name}
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
              ) : null}
            </div>
            ))}
            {isSelector && showAllPorts ? (
              <button
                className="selector-add-input-button nodrag nopan"
                type="button"
                aria-label="Add selector input"
                title="Add selector input"
                onPointerDown={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  data.onSelectorInputAdd?.(node.id);
                }}
              >
                +
              </button>
            ) : null}
            {node.type === 'Outs' ? (
              <NewPortPlaceholder label={newPortLabel} onAdd={(name) => data.onPortAdd(node.id, newPortSide, name)} />
            ) : null}
          </div>
          {normalOutputPorts.length > 0 || (hasNewPortPlaceholder && newPortSide === 'output') ? (
            <div className={`shader-ports shader-outputs${node.type === 'Params' ? ' shader-params-outputs' : ''}`}>
              {node.type === 'Params' ? (
                <div className="shader-params-columns" aria-hidden="true"><span>default</span><span>min</span><span>max</span></div>
              ) : null}
              {normalOutputPorts.map((output) => (
              <div
                className={[
                  'shader-port shader-port-output',
                  output.preview ? 'shader-port-preview' : '',
                ].filter(Boolean).join(' ')}
                key={`${output.preview ? 'preview' : 'port'}:${output.name}`}
                ref={(element) => {
                  outputPortRowsRef.current[output.name] = element;
                }}
                onDoubleClick={(event) => {
                  if (output.preview) return;
                  event.stopPropagation();
                  data.onPortDoubleClick(node.id, 'output', output.name);
                }}
              >
                <PortNameLabel
                name={output.name}
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
                  <div className={node.type === 'Params' ? 'shader-params-values' : undefined}>
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
                <Handle
                  id={`out:${output.name}`}
                  type="source"
                  position={Position.Right}
                  className={[
                    'shader-handle shader-handle-output',
                    selectedLinkOutputs.includes(output.name) ? 'shader-handle-selected-link' : '',
                  ].filter(Boolean).join(' ')}
                  onDoubleClick={(event) => {
                    if (output.preview) return;
                    event.stopPropagation();
                    data.onPortDoubleClick(node.id, 'output', output.name);
                  }}
                />
              </div>
              ))}
              {hasNewPortPlaceholder && newPortSide === 'output' ? (
                <NewPortPlaceholder label={newPortLabel} onAdd={(name) => data.onPortAdd(node.id, newPortSide, name)} />
              ) : null}
            </div>
          ) : null}
          </div>
          {showResizableDisplay && !isCanvasLocked && !isAreaUiCollapsedPresentation ? (
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
          ) : null}
        </div>
          );
        })()
      ) : (
        <div className="shader-node-body shader-node-body-draft">
          <div className="shader-ports shader-inputs">
            <div className="shader-port shader-port-input">
              <Handle
                id="in:value"
                type="target"
                position={Position.Left}
                className="shader-handle shader-handle-input"
              />
              <span>in</span>
            </div>
          </div>
          <div className="shader-ports shader-outputs">
            <div className="shader-port shader-port-output">
              <span>out</span>
              <Handle
                id="out:value"
                type="source"
                position={Position.Right}
                className="shader-handle shader-handle-output"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

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

    void getSampleWaveform(sampleUrl).then((nextWaveform) => {
      if (!cancelled) setWaveform(nextWaveform);
    });
    return () => {
      cancelled = true;
    };
  }, [sampleUrl]);

  return (
    <div className="sample-waveform-display nodrag nopan">
      {sampleUrl && isVideoSampleUrl(sampleUrl) ? (
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
  activePointIndex: number | null;
  editorRef: RefObject<SVGSVGElement | null>;
  onPointerDown: (event: PointerEvent<SVGSVGElement>) => void;
  onDoubleClick: (event: MouseEvent<SVGSVGElement>) => void;
  onSustainStartChange: (value: number) => void;
  onSustainEndChange: (value: number) => void;
}

interface AudioInputDisplayProps {
  state: ShaderNodeData['audioInput'];
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

function audioInputStatusLabel(status: NonNullable<ShaderNodeData['audioInput']>['status']): string {
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

interface SliderDisplayProps {
  value: number;
  displayValue?: number;
  direction: 'horizontal' | 'vertical';
  onChange: (value: number) => void;
}

const SLIDER_WHEEL_SPEED = 0.5;

function sliderPrecisionDivisor(event: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): number {
  if (event.metaKey || event.ctrlKey) return 5;
  if (event.shiftKey && event.altKey) return 3;
  return 1;
}

function SliderDisplay({ value, displayValue, direction, onChange }: SliderDisplayProps) {
  const dragRef = useRef<{
    pointerId: number;
    lastPointerValue: number;
    value: number;
    cursorBias: number;
    precisionDivisor: number;
  } | null>(null);
  const normalized = clamp(displayValue ?? value, 0, 1);
  const wheelValueRef = useRef(normalized);
  const lastWheelTimeRef = useRef(-Infinity);
  const wheelTargetRef = useModifiedWheel<HTMLInputElement>((event, target) => {
    if (event.timeStamp - lastWheelTimeRef.current > 160) {
      wheelValueRef.current = normalized;
    }
    lastWheelTimeRef.current = event.timeStamp;
    const travel = direction === 'vertical' ? target.clientHeight : target.clientWidth;
    const precisionDivisor = sliderPrecisionDivisor(event);
    const wheelDelta = wheelAxisDeltaPixels(event, direction);
    if (wheelDelta === 0) return;
    const nextValue = clamp(
      wheelValueRef.current
        + wheelDelta * (direction === 'vertical' ? 1 : -1) * SLIDER_WHEEL_SPEED
          / Math.max(1, travel)
          / precisionDivisor,
      0,
      1,
    );
    wheelValueRef.current = nextValue;
    onChange(nextValue);
  });
  const fillStyle = direction === 'vertical'
    ? { height: `${normalized * 100}%` }
    : { width: `${normalized * 100}%` };

  function pointerValue(event: PointerEvent<HTMLInputElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    // Keep this unbounded while dragging. Fine control uses relative travel,
    // so clamping here would lose movement once the pointer passed an edge.
    return direction === 'vertical'
      ? 1 - ((event.clientY - bounds.top) / Math.max(1, bounds.height))
      : (event.clientX - bounds.left) / Math.max(1, bounds.width);
  }

  function updateFromPointer(event: PointerEvent<HTMLInputElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const cursorValue = pointerValue(event);
    const precisionDivisor = sliderPrecisionDivisor(event);
    if (precisionDivisor !== drag.precisionDivisor) {
      // Re-anchor when the modifier changes so switching speeds never snaps to
      // the cursor. Without fine control, the bias preserves this position.
      drag.lastPointerValue = cursorValue;
      drag.cursorBias = drag.value - cursorValue;
      drag.precisionDivisor = precisionDivisor;
      return;
    }

    const nextValue = precisionDivisor > 1
      ? drag.value + (cursorValue - drag.lastPointerValue) / precisionDivisor
      : cursorValue + drag.cursorBias;
    drag.lastPointerValue = cursorValue;
    drag.value = clamp(nextValue, 0, 1);
    onChange(drag.value);
  }

  return (
    <div className={[
      'audio-node-slider-display nodrag nopan',
      direction === 'vertical' ? 'audio-node-slider-display-vertical' : 'audio-node-slider-display-horizontal',
    ].join(' ')}
      onClick={(event) => event.stopPropagation()}
    >
      <span className="audio-node-slider-fill" style={fillStyle} aria-hidden="true" />
      <input
        ref={wheelTargetRef}
        aria-label="Slider value"
        type="range"
        tabIndex={-1}
        min={0}
        max={1}
        step={0.001}
        value={normalized}
        onChange={(event) => {
          if (dragRef.current) return;
          onChange(Number(event.currentTarget.value));
          event.currentTarget.blur();
        }}
        onFocus={(event) => event.currentTarget.blur()}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (!event.isPrimary || event.button !== 0) return;
          const cursorValue = pointerValue(event);
          const precisionDivisor = sliderPrecisionDivisor(event);
          const initialValue = precisionDivisor > 1 ? normalized : clamp(cursorValue, 0, 1);
          dragRef.current = {
            pointerId: event.pointerId,
            lastPointerValue: cursorValue,
            value: initialValue,
            cursorBias: initialValue - cursorValue,
            precisionDivisor,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
          if (precisionDivisor === 1) onChange(initialValue);
        }}
        onPointerMove={(event) => {
          if (dragRef.current?.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          updateFromPointer(event);
        }}
        onPointerUp={(event) => {
          event.stopPropagation();
          if (dragRef.current?.pointerId === event.pointerId) {
            dragRef.current = null;
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
          }
          event.currentTarget.blur();
        }}
        onPointerCancel={(event) => {
          event.stopPropagation();
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
          event.currentTarget.blur();
        }}
        onLostPointerCapture={(event) => {
          if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.blur();
        }}
        onDoubleClick={(event) => event.stopPropagation()}
      />
    </div>
  );
}

interface JoystickDisplayProps {
  x: number;
  y: number;
  elasticity: number;
  onChange: (x: number, y: number) => void;
}

function JoystickDisplay({ x, y, elasticity, onChange }: JoystickDisplayProps) {
  const dragPointerRef = useRef<number | null>(null);
  const returnFrameRef = useRef<number | null>(null);
  const returnTimeRef = useRef(0);
  const elasticityRef = useRef(elasticity);
  const normalizedX = clamp(x, 0, 1);
  const normalizedY = clamp(y, 0, 1);
  const positionRef = useRef({ x: normalizedX, y: normalizedY });

  elasticityRef.current = elasticity;
  if (dragPointerRef.current === null && returnFrameRef.current === null) {
    positionRef.current = { x: normalizedX, y: normalizedY };
  }

  useEffect(() => () => {
    if (returnFrameRef.current !== null) {
      window.cancelAnimationFrame(returnFrameRef.current);
    }
  }, []);

  function stopReturn() {
    if (returnFrameRef.current !== null) {
      window.cancelAnimationFrame(returnFrameRef.current);
      returnFrameRef.current = null;
    }
  }

  function startReturn() {
    stopReturn();
    if (!(elasticityRef.current > 0)) return;
    returnTimeRef.current = performance.now();

    function stepReturn(timestamp: number) {
      if (dragPointerRef.current !== null || !(elasticityRef.current > 0)) {
        returnFrameRef.current = null;
        return;
      }

      const elapsedSeconds = Math.min(0.05, Math.max(0, (timestamp - returnTimeRef.current) / 1000));
      returnTimeRef.current = timestamp;
      const current = positionRef.current;
      const deltaX = 0.5 - current.x;
      const deltaY = 0.5 - current.y;
      const distance = Math.hypot(deltaX, deltaY);
      const travel = elasticityRef.current * elapsedSeconds;

      if (distance <= Math.max(0.0001, travel)) {
        positionRef.current = { x: 0.5, y: 0.5 };
        returnFrameRef.current = null;
        onChange(0.5, 0.5);
        return;
      }

      const scale = travel / distance;
      const next = {
        x: current.x + deltaX * scale,
        y: current.y + deltaY * scale,
      };
      positionRef.current = next;
      onChange(next.x, next.y);
      returnFrameRef.current = window.requestAnimationFrame(stepReturn);
    }

    returnFrameRef.current = window.requestAnimationFrame(stepReturn);
  }

  function updateFromPointer(event: PointerEvent<HTMLDivElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const nextX = (event.clientX - bounds.left) / Math.max(1, bounds.width);
    const nextY = 1 - ((event.clientY - bounds.top) / Math.max(1, bounds.height));
    const next = { x: clamp(nextX, 0, 1), y: clamp(nextY, 0, 1) };
    positionRef.current = next;
    onChange(next.x, next.y);
  }

  return (
    <div
      className="audio-node-joystick-display nodrag nopan"
      role="group"
      aria-label="Joystick"
      aria-valuetext={`X ${normalizedX.toFixed(3)}, Y ${normalizedY.toFixed(3)}`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isPrimary || event.button !== 0) return;
        stopReturn();
        dragPointerRef.current = event.pointerId;
        event.currentTarget.setPointerCapture(event.pointerId);
        updateFromPointer(event);
      }}
      onPointerMove={(event) => {
        if (dragPointerRef.current !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        updateFromPointer(event);
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        if (dragPointerRef.current === event.pointerId) {
          dragPointerRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          startReturn();
        }
      }}
      onPointerCancel={(event) => {
        event.stopPropagation();
        if (dragPointerRef.current === event.pointerId) {
          dragPointerRef.current = null;
          startReturn();
        }
      }}
      onLostPointerCapture={(event) => {
        if (dragPointerRef.current === event.pointerId) {
          dragPointerRef.current = null;
          startReturn();
        }
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <span
        className="audio-node-joystick-handle"
        style={{
          left: `calc(${normalizedX} * (100% - var(--joystick-handle-size)))`,
          top: `calc(${1 - normalizedY} * (100% - var(--joystick-handle-size)))`,
        }}
        aria-hidden="true"
      />
    </div>
  );
}

type ButtonMode = 'toggle' | 'trigger' | 'temporary';
const BUTTON_CLICK_FLASH_MS = 120;

interface ButtonDisplayProps {
  mode: ButtonMode;
  pressed: number;
  onPressedChange: (value: number) => void;
  onClickPulse: () => void;
}

function ButtonDisplay({ mode, pressed, onPressedChange, onClickPulse }: ButtonDisplayProps) {
  const [pointerActive, setPointerActive] = useState(false);
  const [clickFlashActive, setClickFlashActive] = useState(false);
  const clickFlashTimeoutRef = useRef<number | null>(null);
  const previousPressedRef = useRef(false);
  const isPressed = pressed >= 0.5;
  const isLit = mode === 'trigger'
    ? clickFlashActive
    : mode === 'temporary'
      ? pointerActive || isPressed
      : isPressed;

  function flashClick() {
    if (clickFlashTimeoutRef.current !== null) {
      window.clearTimeout(clickFlashTimeoutRef.current);
    }
    setClickFlashActive(true);
    clickFlashTimeoutRef.current = window.setTimeout(() => {
      clickFlashTimeoutRef.current = null;
      setClickFlashActive(false);
    }, BUTTON_CLICK_FLASH_MS);
  }

  useEffect(() => {
    if (mode === 'trigger' && isPressed && !previousPressedRef.current) {
      flashClick();
    }
    previousPressedRef.current = isPressed;
  }, [isPressed, mode]);

  useEffect(() => () => {
    if (clickFlashTimeoutRef.current !== null) {
      window.clearTimeout(clickFlashTimeoutRef.current);
    }
  }, []);

  function releaseTemporary() {
    setPointerActive(false);
    if (mode === 'temporary') {
      onPressedChange(0);
    }
  }

  return (
    <button
      className={[
        'audio-node-button-display nodrag nopan',
        isLit ? 'audio-node-button-display-active' : '',
      ].filter(Boolean).join(' ')}
      type="button"
      aria-label="Button value"
      aria-pressed={isLit}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        if (mode === 'temporary') {
          setPointerActive(true);
          onPressedChange(1);
        } else if (mode === 'trigger') {
          flashClick();
          onClickPulse();
        }
      }}
      onPointerUp={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
        releaseTemporary();
      }}
      onPointerCancel={(event) => {
        event.stopPropagation();
        releaseTemporary();
      }}
      onLostPointerCapture={releaseTemporary}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (mode === 'toggle') {
          onPressedChange(isPressed ? 0 : 1);
        }
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    />
  );
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
    <PatternGrid
      ariaLabel="Piano roll"
      className="roll-node-panel pattern-grid-roll"
      rows={rows.length}
      steps={steps}
      beatLength={beatLength}
      currentStep={currentStep}
      defaultGateLength={stepLength}
      rowLabel={(displayRow) => midiNoteLabel(rows[storageRow(displayRow)].note)}
      gatesForRow={(displayRow) => rollGatesForRow(params, rows[storageRow(displayRow)].index, steps)}
      onCreateGate={(displayRow, start, end) => {
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
      onUpdateGate={(displayRow, slot, update) => {
        const row = rows[storageRow(displayRow)].index;
        const values: Record<string, number> = {};
        if (update.start !== undefined) values[rollGateParamName(row, slot, 'start')] = update.start;
        if (update.end !== undefined) values[rollGateParamName(row, slot, 'end')] = update.end;
        if (update.velocity !== undefined) values[rollGateVelocityParamName(row, slot)] = update.velocity;
        onParamsChange(values);
      }}
      onDeleteGate={(displayRow, slot) => onParamsChange({ [rollGateParamName(rows[storageRow(displayRow)].index, slot, 'active')]: 0 })}
    />
  );
}

function LegacyRollGrid({ params, steps, beatLength, stepLength, startNote, currentStep, onParamsChange }: RollGridProps) {
  const polyphonic = true;
  const activeStep = Number.isFinite(currentStep) ? Math.floor(currentStep ?? -1) : -1;
  const dragRef = useRef<{ pointerId: number; row: number; slot: number; start: number; end: number; x: number; y: number; velocity: number; action: 'move' | 'left' | 'right' | 'velocity' } | null>(null);
  const beginDrag = (event: PointerEvent<HTMLElement>, row: number, slot: number, start: number, end: number, velocity: number, action: 'move' | 'left' | 'right' | 'velocity') => {
    event.preventDefault(); event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, row, slot, start, end, x: event.clientX, y: event.clientY, velocity, action };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const width = event.currentTarget.closest('.roll-cells')?.getBoundingClientRect().width ?? steps * 26;
    const delta = ((event.clientX - drag.x) / Math.max(1, width)) * steps;
    const height = event.currentTarget.closest('.roll-cells')?.getBoundingClientRect().height ?? 26;
    if (drag.action === 'velocity') {
      onParamsChange({ [rollGateVelocityParamName(drag.row, drag.slot)]: Math.max(SEQUENCER_MIN_VELOCITY, Math.min(1, drag.velocity - (event.clientY - drag.y) / Math.max(1, height))) });
      return;
    }
    const length = drag.end - drag.start;
    let start = drag.start;
    let end = drag.end;
    if (drag.action === 'move') { start = Math.max(0, Math.min(steps - length, start + delta)); end = start + length; }
    else if (drag.action === 'left') start = Math.max(0, Math.min(end - 0.05, start + delta));
    else end = Math.max(start + 0.05, Math.min(steps, end + delta));
    onParamsChange({ [rollGateParamName(drag.row, drag.slot, 'start')]: start, [rollGateParamName(drag.row, drag.slot, 'end')]: end });
  };
  const endDrag = (event: PointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };
  return (
    <div className="roll-node-panel nodrag nopan" style={{ '--roll-steps': steps } as CSSProperties} aria-label="Piano roll">
      {Array.from({ length: ROLL_ROWS }, (_, displayRow) => {
        const row = ROLL_ROWS - displayRow - 1;
        const note = startNote + row;
        const gates = rollGatesForRow(params, row, steps);
        return (
          <div className="roll-row" key={note}>
            <div className={['roll-note-label', isBlackKey(note) ? 'roll-note-label-black' : ''].filter(Boolean).join(' ')}>{midiNoteLabel(note)}</div>
            <div className="roll-cells" role="row">
              {Array.from({ length: steps }, (_, step) => {
                const highlightedBeat = Math.floor(step / beatLength) % 2 === 1;
                return (
                  <button
                    type="button"
                    key={step}
                    className={['roll-cell', highlightedBeat ? 'roll-cell-beat-highlight' : '', activeStep === step ? 'roll-cell-current' : '', isBlackKey(note) ? 'roll-cell-black-key' : ''].filter(Boolean).join(' ')}
                    aria-label={`${midiNoteLabel(note)}, step ${step + 1}`}
                    aria-pressed={false}
                    onPointerDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const slot = Array.from({ length: steps }, (_, index) => index).find((index) => !gates.some((gate) => gate.slot === index));
                      if (slot === undefined) return;
                      const values: Record<string, number> = {
                        [rollGateParamName(row, slot, 'active')]: 1,
                        [rollGateParamName(row, slot, 'start')]: step,
                        [rollGateParamName(row, slot, 'end')]: Math.min(steps, step + stepLength),
                        [rollGateVelocityParamName(row, slot)]: 1,
                        [rollCellParamName(row, slot)]: 0,
                      };
                      if (!polyphonic) for (let otherRow = 0; otherRow < ROLL_ROWS; otherRow += 1) for (const otherGate of rollGatesForRow(params, otherRow, steps)) values[rollGateParamName(otherRow, otherGate.slot, 'active')] = 0;
                      onParamsChange(values);
                    }}
                  />
                );
              })}
              {gates.map((gate) => (
                <div key={gate.slot} className="roll-gate" style={{ top: `${(1 - gate.velocity) * 100}%`, left: `${gate.start / steps * 100}%`, width: `${(gate.end - gate.start) / steps * 100}%` }} onPointerDown={(event) => beginDrag(event, row, gate.slot, gate.start, gate.end, gate.velocity, 'move')} onPointerMove={moveDrag} onPointerUp={endDrag}>
                  <span className="roll-velocity-handle" onPointerDown={(event) => beginDrag(event, row, gate.slot, gate.start, gate.end, gate.velocity, 'velocity')} />
                  <span className="roll-gate-handle roll-gate-handle-left" onPointerDown={(event) => beginDrag(event, row, gate.slot, gate.start, gate.end, gate.velocity, 'left')} />
                  <span className="roll-gate-handle roll-gate-handle-right" onPointerDown={(event) => beginDrag(event, row, gate.slot, gate.start, gate.end, gate.velocity, 'right')} />
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function isBlackKey(note: number): boolean {
  return [1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);
}

/**
 * Shared interaction and rendering system for step-based patterns. Callers
 * adapt node storage to gates and choose which interactions are available.
 */
interface PatternGridGate {
  slot: number;
  start: number;
  end: number;
  velocity: number;
}

interface PatternGridProps {
  ariaLabel: string;
  className: string;
  rows: number;
  steps: number;
  beatLength: number;
  currentStep?: number;
  rowLabel: (row: number) => string;
  renderRowLabel?: (row: number) => ReactNode;
  labelPosition?: 'left' | 'right';
  onRowRef?: (row: number, element: HTMLDivElement | null) => void;
  gatesForRow: (row: number) => PatternGridGate[];
  mode?: 'gate' | 'trigger';
  defaultGateLength?: number;
  allowMove?: boolean;
  allowResize?: boolean;
  allowVelocity?: boolean;
  onCreateGate: (row: number, start: number, end: number) => void;
  onCreateGates?: (row: number, gates: Array<{ start: number; end: number }>) => void;
  onUpdateGate: (row: number, slot: number, update: Partial<Pick<PatternGridGate, 'start' | 'end' | 'velocity'>>) => void;
  onDeleteGate: (row: number, slot: number) => void;
}

function PatternGrid({
  ariaLabel,
  className,
  rows,
  steps,
  beatLength,
  currentStep,
  rowLabel,
  renderRowLabel,
  labelPosition = 'left',
  onRowRef,
  gatesForRow,
  mode = 'gate',
  defaultGateLength = 1,
  allowMove = true,
  allowResize = true,
  allowVelocity = true,
  onCreateGate,
  onCreateGates,
  onUpdateGate,
  onDeleteGate,
}: PatternGridProps) {
  const activeStep = Number.isFinite(currentStep) ? Math.floor(currentStep ?? -1) : -1;
  const dragRef = useRef<{ pointerId: number; row: number; gate: PatternGridGate; x: number; y: number; action: 'move' | 'left' | 'right' | 'velocity'; moved: boolean } | null>(null);
  const createRef = useRef<{
    pointerId: number;
    row: number;
    anchorX: number;
    start: number;
    end: number;
    lastStep: number;
    positions: Set<number>;
    moved: boolean;
  } | null>(null);
  const [createPreview, setCreatePreview] = useState<{ row: number; gates: Array<{ start: number; end: number }> } | null>(null);

  const positionInRow = (event: PointerEvent<HTMLElement>) => {
    const bounds = event.currentTarget.closest('.pattern-grid-cells')?.getBoundingClientRect();
    if (!bounds) return 0;
    return Math.max(0, Math.min(steps, ((event.clientX - bounds.left) / Math.max(1, bounds.width)) * steps));
  };

  const beginCreate = (event: PointerEvent<HTMLButtonElement>, row: number, step: number) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const existing = gatesForRow(row);
    if (existing.some((gate) => step >= gate.start && step < gate.end)) return;
    const nextStart = mode === 'gate'
      ? existing.filter((gate) => gate.start > step).reduce((boundary, gate) => Math.min(boundary, gate.start), steps)
      : steps;
    const end = mode === 'trigger' ? Math.min(steps, step + 1) : Math.min(nextStart, step + defaultGateLength);
    if (end - step < 0.05) return;
    createRef.current = {
      pointerId: event.pointerId,
      row,
      anchorX: event.clientX,
      start: step,
      end,
      lastStep: step,
      positions: new Set([step]),
      moved: false,
    };
    setCreatePreview({ row, gates: [{ start: step, end }] });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveCreate = (event: PointerEvent<HTMLButtonElement>) => {
    const create = createRef.current;
    if (!create || create.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - create.anchorX) >= 3) create.moved = true;
    if (mode === 'trigger') {
      const nextStep = Math.max(0, Math.min(steps - 1, Math.floor(positionInRow(event))));
      const direction = nextStep >= create.lastStep ? 1 : -1;
      for (let step = create.lastStep; step !== nextStep + direction; step += direction) create.positions.add(step);
      create.lastStep = nextStep;
      const occupied = gatesForRow(create.row);
      const gates = [...create.positions]
        .filter((step) => !occupied.some((gate) => Math.abs(gate.start - step) < 0.000001))
        .sort((left, right) => left - right)
        .map((step) => ({ start: step, end: Math.min(steps, step + 1) }));
      setCreatePreview({ row: create.row, gates });
      return;
    }
    if (!create.moved) return;
    const nextStart = gatesForRow(create.row)
      .filter((gate) => gate.start > create.start)
      .reduce((boundary, gate) => Math.min(boundary, gate.start), steps);
    create.end = Math.max(create.start + 0.05, Math.min(nextStart, positionInRow(event)));
    setCreatePreview({ row: create.row, gates: [{ start: create.start, end: create.end }] });
  };

  const finishCreate = (pointerId: number) => {
    const create = createRef.current;
    if (!create || create.pointerId !== pointerId) return;
    const occupied = gatesForRow(create.row);
    const gates = mode === 'trigger'
      ? [...create.positions]
          .filter((step) => !occupied.some((gate) => Math.abs(gate.start - step) < 0.000001))
          .sort((left, right) => left - right)
          .map((step) => ({ start: step, end: Math.min(steps, step + 1) }))
      : [{ start: create.start, end: create.end }];
    if (onCreateGates) onCreateGates(create.row, gates);
    else for (const gate of gates) onCreateGate(create.row, gate.start, gate.end);
    createRef.current = null;
    setCreatePreview(null);
  };

  const beginDrag = (event: PointerEvent<HTMLElement>, row: number, gate: PatternGridGate, action: 'move' | 'left' | 'right' | 'velocity') => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    dragRef.current = { pointerId: event.pointerId, row, gate, x: event.clientX, y: event.clientY, action, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const bounds = event.currentTarget.closest('.pattern-grid-cells')?.getBoundingClientRect();
    const delta = ((event.clientX - drag.x) / Math.max(1, bounds?.width ?? steps * 26)) * steps;
    const velocityDelta = (event.clientY - drag.y) / Math.max(1, bounds?.height ?? 26);
    drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 3;
    if (!drag.moved) return;
    if (drag.action === 'velocity') return onUpdateGate(drag.row, drag.gate.slot, { velocity: Math.max(SEQUENCER_MIN_VELOCITY, Math.min(1, drag.gate.velocity - velocityDelta)) });
    const length = drag.gate.end - drag.gate.start;
    if (mode === 'trigger') {
      const start = Math.max(0, Math.min(steps - 1, drag.gate.start + delta));
      return onUpdateGate(drag.row, drag.gate.slot, { start, end: Math.min(steps, start + 1) });
    }
    const otherGates = gatesForRow(drag.row).filter((gate) => gate.slot !== drag.gate.slot);
    const previousEnd = otherGates
      .filter((gate) => gate.start < drag.gate.start)
      .reduce((boundary, gate) => Math.max(boundary, gate.end), 0);
    const nextStart = otherGates
      .filter((gate) => gate.start >= drag.gate.end)
      .reduce((boundary, gate) => Math.min(boundary, gate.start), steps);
    if (drag.action === 'move') {
      const start = Math.max(previousEnd, Math.min(nextStart - length, drag.gate.start + delta));
      return onUpdateGate(drag.row, drag.gate.slot, { start, end: start + length });
    }
    if (drag.action === 'left') return onUpdateGate(drag.row, drag.gate.slot, { start: Math.max(previousEnd, Math.min(drag.gate.end - 0.05, drag.gate.start + delta)) });
    onUpdateGate(drag.row, drag.gate.slot, { end: Math.max(drag.gate.start + 0.05, Math.min(nextStart, drag.gate.end + delta)) });
  };
  const finishDrag = (pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (!drag.moved && drag.action === 'move') onDeleteGate(drag.row, drag.gate.slot);
    dragRef.current = null;
  };
  const endDrag = (event: PointerEvent<HTMLElement>) => finishDrag(event.pointerId);
  const cancelDrag = (pointerId: number) => {
    if (dragRef.current?.pointerId === pointerId) dragRef.current = null;
  };

  useEffect(() => {
    const finishPointer = (event: globalThis.PointerEvent) => {
      finishCreate(event.pointerId);
      finishDrag(event.pointerId);
    };
    const cancelPointer = (event: globalThis.PointerEvent) => {
      if (createRef.current?.pointerId === event.pointerId) {
        createRef.current = null;
        setCreatePreview(null);
      }
      cancelDrag(event.pointerId);
    };
    window.addEventListener('pointerup', finishPointer);
    window.addEventListener('pointercancel', cancelPointer);
    return () => {
      window.removeEventListener('pointerup', finishPointer);
      window.removeEventListener('pointercancel', cancelPointer);
    };
  });

  return (
    <div className={`pattern-grid pattern-grid-label-${labelPosition} ${className} nodrag nopan`} style={{ '--pattern-grid-steps': steps } as CSSProperties} aria-label={ariaLabel}>
      {Array.from({ length: rows }, (_, row) => (
        <div className="pattern-grid-row" key={row} ref={(element) => onRowRef?.(row, element)}>
          {labelPosition === 'left' ? <div className="pattern-grid-label">{renderRowLabel?.(row) ?? rowLabel(row)}</div> : null}
          <div className="pattern-grid-cells" role="row">
            {Array.from({ length: steps }, (_, step) => (
              <button
                className={['pattern-grid-cell', Math.floor(step / beatLength) % 2 === 1 ? 'pattern-grid-cell-beat-highlight' : '', activeStep === step ? 'pattern-grid-cell-current' : ''].filter(Boolean).join(' ')}
                key={step}
                type="button"
                aria-label={`${rowLabel(row)}, step ${step + 1}`}
                data-pattern-grid-cell="true"
                data-row-index={row}
                data-step-index={step}
                onPointerDown={(event) => beginCreate(event, row, step)}
                onPointerMove={moveCreate}
                onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); finishCreate(event.pointerId); }}
                onPointerCancel={(event) => { createRef.current = null; setCreatePreview(null); if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
                onLostPointerCapture={(event) => finishCreate(event.pointerId)}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
              />
            ))}
            {createPreview?.row === row ? createPreview.gates.map((gate, index) => (
              <div
                className="pattern-grid-gate pattern-grid-create-preview"
                key={`${gate.start}:${index}`}
                style={{ left: `${gate.start / steps * 100}%`, width: `${(gate.end - gate.start) / steps * 100}%` }}
              />
            )) : null}
            {gatesForRow(row).map((gate) => (
              <div
                className="pattern-grid-gate"
                key={gate.slot}
                style={{ top: `${(1 - gate.velocity) * 100}%`, left: `${gate.start / steps * 100}%`, width: `${(gate.end - gate.start) / steps * 100}%` }}
                role="button"
                tabIndex={0}
                aria-label={`${rowLabel(row)} ${mode} from ${gate.start.toFixed(2)} to ${gate.end.toFixed(2)}, velocity ${gate.velocity.toFixed(2)}`}
                onPointerDown={(event) => { if (allowMove && event.target === event.currentTarget) beginDrag(event, row, gate, 'move'); }}
                onPointerMove={moveDrag}
                onPointerUp={endDrag}
                onPointerCancel={(event) => cancelDrag(event.pointerId)}
                onLostPointerCapture={(event) => cancelDrag(event.pointerId)}
                onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
              >
                {allowVelocity ? <span className="pattern-grid-velocity-handle" onPointerDown={(event) => beginDrag(event, row, gate, 'velocity')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={(event) => cancelDrag(event.pointerId)} /> : null}
                {allowResize ? <><span className="pattern-grid-gate-handle pattern-grid-gate-handle-left" onPointerDown={(event) => beginDrag(event, row, gate, 'left')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={(event) => cancelDrag(event.pointerId)} /><span className="pattern-grid-gate-handle pattern-grid-gate-handle-right" onPointerDown={(event) => beginDrag(event, row, gate, 'right')} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={(event) => cancelDrag(event.pointerId)} /></> : null}
              </div>
            ))}
          </div>
          {labelPosition === 'right' ? <div className="pattern-grid-label">{renderRowLabel?.(row) ?? rowLabel(row)}</div> : null}
        </div>
      ))}
    </div>
  );
}

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

const SEQUENCER_TRIGGER_GRAB_FRACTION = 0.35;

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

  const patternGatesForRow = (rowIndex: number): PatternGridGate[] => gateMode
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
    <PatternGrid
      ariaLabel="Sequencer pattern"
      className="pattern-grid-sequencer"
      rows={rows}
      steps={steps}
      beatLength={beatLength}
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
                'shader-handle shader-handle-output shader-handle-output-sequencer',
                selectedLinkOutputs.includes(outputName) ? 'shader-handle-selected-link' : '',
              ].filter(Boolean).join(' ')}
            />
          </div>
        );
      }}
      onRowRef={(rowIndex, element) => setOutputRowRef(sequencerOutputName(rowIndex), element)}
      gatesForRow={patternGatesForRow}
      defaultGateLength={1}
      allowMove
      allowResize={gateMode}
      allowVelocity
      onCreateGate={(rowIndex, start, end) => createGates(rowIndex, [{ start, end }])}
      onCreateGates={createGates}
      onUpdateGate={(rowIndex, slot, update) => {
        const values: Record<string, number> = {};
        if (update.velocity !== undefined) values[sequencerStepVelocityParamName(rowIndex, slot)] = update.velocity;
        if (gateMode) {
          if (update.start !== undefined) values[sequencerGateParamName(rowIndex, slot, 'start')] = update.start;
          if (update.end !== undefined) values[sequencerGateParamName(rowIndex, slot, 'end')] = update.end;
        } else if (update.start !== undefined) {
          values[sequencerTriggerPositionParamName(rowIndex, slot)] = update.start;
        }
        onParamsChange(values);
      }}
      onDeleteGate={(rowIndex, slot) => onParamsChange(gateMode
        ? { [sequencerGateParamName(rowIndex, slot, 'active')]: 0 }
        : { [sequencerCellParamName(rowIndex, slot)]: 0 })}
    />
  );
}

function LegacySequencerGrid({
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
  const activeStep = Number.isFinite(currentStep) ? Math.floor(currentStep ?? -1) : -1;
  const dragRef = useRef<{
    pointerId: number;
    rowIndex: number;
    slot?: number;
    action?: 'move' | 'resize-left' | 'resize-right' | 'velocity';
    anchorX?: number;
    anchorY?: number;
    anchorVelocity?: number;
    anchorStart?: number;
    anchorEnd?: number;
    moved?: boolean;
  } | null>(null);

  const triggerDragRef = useRef<{
    pointerId: number;
    rowIndex: number;
    slot: number;
    anchorX: number;
    anchorPosition: number;
    previewPosition: number;
    moved: boolean;
  } | null>(null);
  const [triggerPreview, setTriggerPreview] = useState<{
    rowIndex: number;
    slot: number;
    position: number;
  } | null>(null);

  useEffect(() => {
    if (!triggerPreview) return;
    const finish = (event: globalThis.PointerEvent) => finishTriggerDrag(event.pointerId);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [triggerPreview]);

  const triggerPaintRef = useRef<{
    pointerId: number;
    rowIndex: number;
    visited: Set<number>;
    lastStep: number;
  } | null>(null);
  const [triggerPaintPreview, setTriggerPaintPreview] = useState<{ rowIndex: number; positions: number[] } | null>(null);

  const gateCreateRef = useRef<{
    pointerId: number;
    rowIndex: number;
    anchorX: number;
    start: number;
    end: number;
    moved: boolean;
  } | null>(null);
  const [gateCreatePreview, setGateCreatePreview] = useState<{
    rowIndex: number;
    start: number;
    end: number;
  } | null>(null);
  const [draftRowLabels, setDraftRowLabels] = useState<string[]>([]);

  useEffect(() => {
    setDraftRowLabels(Array.from({ length: rows }, (_, rowIndex) => rowLabels?.[rowIndex] ?? String(rowIndex + 1)));
  }, [rowLabels, rows]);

  useEffect(() => {
    if (hasSavedLabelColumnWidth) return;
    onRowLabelsChange(Array.from({ length: rows }, (_, rowIndex) => rowLabels?.[rowIndex] ?? String(rowIndex + 1)));
  }, [hasSavedLabelColumnWidth, onRowLabelsChange, rowLabels, rows]);

  function commitRowLabel(rowIndex: number) {
    const label = draftRowLabels[rowIndex]?.trim() || String(rowIndex + 1);
    const labels = Array.from({ length: rows }, (_, index) => (
      index === rowIndex ? label : rowLabels?.[index] ?? String(index + 1)
    ));
    onRowLabelsChange(labels);
  }

  function updateRowLabel(rowIndex: number, value: string) {
    const next = [...draftRowLabels];
    next[rowIndex] = value;
    setDraftRowLabels(next);
    onRowLabelsChange(next);
  }

  useEffect(() => {
    if (!triggerPaintPreview && !gateCreatePreview) return;
    const finish = (event: globalThis.PointerEvent) => {
      finishTriggerPaint(event.pointerId);
      finishGateCreate(event.pointerId);
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
  }, [triggerPaintPreview, gateCreatePreview]);

  function beginTriggerPaint(event: PointerEvent<HTMLButtonElement>, rowIndex: number, stepIndex: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    triggerPaintRef.current = {
      pointerId: event.pointerId,
      rowIndex,
      visited: new Set([stepIndex]),
      lastStep: stepIndex,
    };
    setTriggerPaintPreview({ rowIndex, positions: [stepIndex] });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateTriggerPaint(event: PointerEvent<HTMLButtonElement>) {
    const paint = triggerPaintRef.current;
    if (!paint || paint.pointerId !== event.pointerId) return;
    const row = event.currentTarget.closest('.sequencer-cells')?.getBoundingClientRect();
    if (!row) return;
    const nextStep = Math.max(0, Math.min(steps - 1, Math.floor(((event.clientX - row.left) / Math.max(1, row.width)) * steps)));
    const direction = nextStep >= paint.lastStep ? 1 : -1;
    for (let stepIndex = paint.lastStep; stepIndex !== nextStep + direction; stepIndex += direction) {
      paint.visited.add(stepIndex);
    }
    paint.lastStep = nextStep;
    setTriggerPaintPreview({ rowIndex: paint.rowIndex, positions: [...paint.visited] });
  }

  function finishTriggerPaint(pointerId: number) {
    const paint = triggerPaintRef.current;
    if (!paint || paint.pointerId !== pointerId) return;
    const existing = sequencerTriggersForRow(params, paint.rowIndex, steps);
    const usedSlots = new Set(existing.map((trigger) => trigger.slot));
    const existingPositions = new Set(existing.map((trigger) => Math.round(trigger.position * 1000000)));
    const values: Record<string, number> = {};
    for (const position of paint.visited) {
      if (existingPositions.has(Math.round(position * 1000000))) continue;
      const slot = Array.from({ length: steps }, (_, index) => index).find((index) => !usedSlots.has(index));
      if (slot === undefined) break;
      usedSlots.add(slot);
      values[sequencerCellParamName(paint.rowIndex, slot)] = 1;
      values[sequencerTriggerPositionParamName(paint.rowIndex, slot)] = position;
    }
    onParamsChange(values);
    triggerPaintRef.current = null;
    setTriggerPaintPreview(null);
  }

  function positionInSequencerRow(event: PointerEvent<HTMLElement>): number {
    const row = event.currentTarget.closest('.sequencer-cells')?.getBoundingClientRect();
    if (!row) return 0;
    return Math.max(0, Math.min(steps, ((event.clientX - row.left) / Math.max(1, row.width)) * steps));
  }

  function beginGateCreate(event: PointerEvent<HTMLButtonElement>, rowIndex: number, stepIndex: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const start = stepIndex;
    const gates = sequencerGatesForRow(params, rowIndex, steps);
    if (gates.some((gate) => start >= gate.start && start < gate.end)) return;
    const nextStart = gates.find((gate) => gate.start > start)?.start ?? steps;
    const end = Math.min(nextStart, start + 1);
    if (end - start < 0.05) return;
    gateCreateRef.current = {
      pointerId: event.pointerId,
      rowIndex,
      anchorX: event.clientX,
      start,
      end,
      moved: false,
    };
    setGateCreatePreview({ rowIndex, start, end });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateGateCreate(event: PointerEvent<HTMLButtonElement>) {
    const create = gateCreateRef.current;
    if (!create || create.pointerId !== event.pointerId) return;
    if (Math.abs(event.clientX - create.anchorX) >= 3) create.moved = true;
    if (!create.moved) return;
    const nextStart = sequencerGatesForRow(params, create.rowIndex, steps)
      .find((gate) => gate.start > create.start)?.start ?? steps;
    create.end = Math.max(create.start + 0.05, positionInSequencerRow(event));
    create.end = Math.min(nextStart, create.end);
    setGateCreatePreview({ rowIndex: create.rowIndex, start: create.start, end: create.end });
  }

  function finishGateCreate(pointerId: number) {
    const create = gateCreateRef.current;
    if (!create || create.pointerId !== pointerId) return;
    const usedSlots = new Set(sequencerGatesForRow(params, create.rowIndex, steps).map((gate) => gate.slot));
    const slot = Array.from({ length: steps }, (_, index) => index).find((index) => !usedSlots.has(index));
    if (slot !== undefined) {
      onParamsChange({
        [SEQUENCER_GATE_INITIALIZED_PARAM]: 1,
        [sequencerGateParamName(create.rowIndex, slot, 'active')]: 1,
        [sequencerGateParamName(create.rowIndex, slot, 'start')]: create.start,
        [sequencerGateParamName(create.rowIndex, slot, 'end')]: create.end,
      });
    }
    gateCreateRef.current = null;
    setGateCreatePreview(null);
  }

  function beginTriggerDrag(event: PointerEvent<HTMLDivElement>, rowIndex: number, slot: number, position: number) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    triggerDragRef.current = {
      pointerId: event.pointerId,
      rowIndex,
      slot,
      anchorX: event.clientX,
      anchorPosition: position,
      previewPosition: position,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateTriggerDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = triggerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rowWidth = event.currentTarget.closest('.sequencer-cells')?.getBoundingClientRect().width ?? steps * 26;
    const delta = ((event.clientX - drag.anchorX) / Math.max(1, rowWidth)) * steps;
    if (Math.abs(event.clientX - drag.anchorX) >= 3) drag.moved = true;
    if (!drag.moved) return;
    const position = Math.max(0, Math.min(steps - SEQUENCER_TRIGGER_GRAB_FRACTION, drag.anchorPosition + delta));
    drag.previewPosition = position;
    setTriggerPreview({ rowIndex: drag.rowIndex, slot: drag.slot, position });
  }

  function finishTriggerDrag(pointerId: number) {
    const drag = triggerDragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    if (!drag.moved) {
      onParamsChange({ [sequencerCellParamName(drag.rowIndex, drag.slot)]: 0 });
    } else {
      onParamsChange({
        [sequencerTriggerPositionParamName(drag.rowIndex, drag.slot)]: drag.previewPosition,
      });
    }
    triggerDragRef.current = null;
    setTriggerPreview(null);
  }

  function endTriggerDrag(event: PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    finishTriggerDrag(event.pointerId);
  }

  function beginGateDrag(
    event: PointerEvent<HTMLElement>,
    rowIndex: number,
    slot: number,
    start: number,
    end: number,
    action: 'move' | 'resize-left' | 'resize-right' | 'velocity',
  ) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      rowIndex,
      slot,
      action,
      anchorX: event.clientX,
      anchorStart: start,
      anchorEnd: end,
      anchorY: event.clientY,
      anchorVelocity: params[sequencerStepVelocityParamName(rowIndex, slot)] ?? 1,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateGateDrag(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.slot === undefined || !drag.action) return;
    const rowRect = event.currentTarget.closest('.sequencer-cells')?.getBoundingClientRect();
    const rowWidth = rowRect?.width ?? steps * 26;
    const rowHeight = rowRect?.height ?? 26;
    const delta = ((event.clientX - (drag.anchorX ?? event.clientX)) / Math.max(1, rowWidth)) * steps;
    const velocityDelta = ((event.clientY - (drag.anchorY ?? event.clientY)) / Math.max(1, rowHeight));
    if (Math.hypot(event.clientX - (drag.anchorX ?? event.clientX), event.clientY - (drag.anchorY ?? event.clientY)) >= 3) drag.moved = true;
    if (!drag.moved) return;

    if (drag.action === 'velocity') {
      onParamsChange({
        [sequencerStepVelocityParamName(drag.rowIndex, drag.slot)]: Math.max(SEQUENCER_MIN_VELOCITY, Math.min(1, (drag.anchorVelocity ?? 1) - velocityDelta)),
      });
      return;
    }

    const minimumLength = 0.05;
    let start = drag.anchorStart ?? 0;
    let end = drag.anchorEnd ?? start + 1;
    const otherGates = sequencerGatesForRow(params, drag.rowIndex, steps)
      .filter((gate) => gate.slot !== drag.slot);
    const previousEnd = otherGates
      .filter((gate) => gate.start < (drag.anchorStart ?? 0))
      .reduce((boundary, gate) => Math.max(boundary, gate.end), 0);
    const nextStart = otherGates
      .filter((gate) => gate.start >= (drag.anchorEnd ?? 0))
      .reduce((boundary, gate) => Math.min(boundary, gate.start), steps);
    if (drag.action === 'move') {
      const length = end - start;
      start = Math.max(previousEnd, Math.min(nextStart - length, start + delta));
      end = start + length;
    } else if (drag.action === 'resize-left') {
      start = Math.max(previousEnd, Math.min(end - minimumLength, start + delta));
    } else {
      end = Math.max(start + minimumLength, Math.min(nextStart, end + delta));
    }
    onParamsChange({
      [sequencerGateParamName(drag.rowIndex, drag.slot, 'start')]: start,
      [sequencerGateParamName(drag.rowIndex, drag.slot, 'end')]: end,
    });
  }

  function endGateDrag(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || drag.slot === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    if (!drag.moved && drag.action !== 'velocity') {
      onParamsChange({ [sequencerGateParamName(drag.rowIndex, drag.slot, 'active')]: 0 });
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;
  }

  return (
    <div
      className="sequencer-node-panel nodrag nopan"
      style={{ '--sequencer-steps': steps } as CSSProperties}
      aria-label="Sequencer pattern"
    >
      {Array.from({ length: rows }, (_, rowIndex) => {
        const outputName = sequencerOutputName(rowIndex);
        const gates = gateMode ? sequencerGatesForRow(params, rowIndex, steps) : [];
        const triggers = gateMode ? [] : sequencerTriggersForRow(params, rowIndex, steps);
        return (
          <div
            className="sequencer-row"
            key={outputName}
            ref={(element) => setOutputRowRef(outputName, element)}
          >
            <div className="sequencer-cells" role="row">
              {Array.from({ length: steps }, (_, stepIndex) => {
                const highlightedBeat = Math.floor(stepIndex / beatLength) % 2 === 1;
                return (
                  <button
                    className={[
                      'sequencer-cell',
                      highlightedBeat ? 'sequencer-cell-beat-highlight' : '',
                      activeStep === stepIndex ? 'sequencer-cell-current' : '',
                    ].filter(Boolean).join(' ')}
                    key={stepIndex}
                    type="button"
                    role="gridcell"
                    data-sequencer-cell="true"
                    data-row-index={rowIndex}
                    data-step-index={stepIndex}
                    aria-label={`Row ${rowIndex + 1}, step ${stepIndex + 1}`}
                    aria-pressed={false}
                    title={`Row ${rowIndex + 1}, step ${stepIndex + 1}`}
                    onPointerDown={(event) => {
                      if (gateMode) beginGateCreate(event, rowIndex, stepIndex);
                      else beginTriggerPaint(event, rowIndex, stepIndex);
                    }}
                    onPointerMove={(event) => {
                      if (gateMode) updateGateCreate(event);
                      else updateTriggerPaint(event);
                    }}
                    onPointerUp={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                        event.currentTarget.releasePointerCapture(event.pointerId);
                      }
                      if (gateMode) finishGateCreate(event.pointerId);
                      else finishTriggerPaint(event.pointerId);
                    }}
                    onPointerCancel={(event) => {
                      if (gateMode) finishGateCreate(event.pointerId);
                      else finishTriggerPaint(event.pointerId);
                    }}
                    onLostPointerCapture={(event) => {
                      if (gateMode) finishGateCreate(event.pointerId);
                      else finishTriggerPaint(event.pointerId);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                  />
                );
              })}
              {!gateMode && triggerPaintPreview?.rowIndex === rowIndex
                ? triggerPaintPreview.positions.map((position) => (
                    <div
                      key={`paint-${position}`}
                      className="sequencer-trigger sequencer-step-create-preview"
                      style={{ left: `${(position / steps) * 100}%`, width: `${(1 / steps) * 100}%` }}
                    />
                  ))
                : null}
              {gateMode && gateCreatePreview?.rowIndex === rowIndex ? (
                <div
                  className="sequencer-gate sequencer-step-create-preview"
                  style={{
                    left: `${(gateCreatePreview.start / steps) * 100}%`,
                    width: `${((gateCreatePreview.end - gateCreatePreview.start) / steps) * 100}%`,
                  }}
                />
              ) : null}
              {triggers.map((trigger) => (
                <div
                  key={trigger.slot}
                  className="sequencer-trigger"
                  style={{
                    left: `${(((triggerPreview?.rowIndex === rowIndex && triggerPreview.slot === trigger.slot)
                      ? triggerPreview.position
                      : trigger.position) / steps) * 100}%`,
                    width: `${(1 / steps) * 100}%`,
                    top: `${(1 - trigger.velocity) * 100}%`,
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Row ${rowIndex + 1} trigger at ${trigger.position.toFixed(2)}`}
                  title="Drag to move; drag top edge to set velocity; click to delete"
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) beginTriggerDrag(event, rowIndex, trigger.slot, trigger.position);
                  }}
                  onPointerMove={updateTriggerDrag}
                  onPointerUp={endTriggerDrag}
                  onPointerCancel={endTriggerDrag}
                  onLostPointerCapture={(event) => finishTriggerDrag(event.pointerId)}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                >
                  <span
                    className="sequencer-velocity-handle"
                    onPointerDown={(event) => beginGateDrag(event, rowIndex, trigger.slot, trigger.position, trigger.position + 1, 'velocity')}
                    onPointerMove={updateGateDrag}
                    onPointerUp={endGateDrag}
                    onPointerCancel={endGateDrag}
                  />
                </div>
              ))}
              {gates.map((gate) => (
                <div
                  key={gate.slot}
                  className="sequencer-gate"
                  style={{
                    left: `${(gate.start / steps) * 100}%`,
                    width: `${((gate.end - gate.start) / steps) * 100}%`,
                    top: `${(1 - gate.velocity) * 100}%`,
                  }}
                  role="button"
                  tabIndex={0}
                  aria-label={`Row ${rowIndex + 1} gate from ${gate.start.toFixed(2)} to ${gate.end.toFixed(2)}, velocity ${gate.velocity.toFixed(2)}`}
                  title="Drag to move; drag side edges to resize; drag top edge to set velocity; click to delete"
                  onPointerDown={(event) => {
                    if (event.target === event.currentTarget) {
                      beginGateDrag(event, rowIndex, gate.slot, gate.start, gate.end, 'move');
                    }
                  }}
                  onPointerMove={updateGateDrag}
                  onPointerUp={endGateDrag}
                  onPointerCancel={endGateDrag}
                  onLostPointerCapture={() => { dragRef.current = null; }}
                  onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                >
                  <span
                    className="sequencer-velocity-handle"
                    onPointerDown={(event) => beginGateDrag(event, rowIndex, gate.slot, gate.start, gate.end, 'velocity')}
                    onPointerMove={updateGateDrag}
                    onPointerUp={endGateDrag}
                    onPointerCancel={endGateDrag}
                  />
                  <span
                    className="sequencer-gate-handle sequencer-gate-handle-left"
                    onPointerDown={(event) => beginGateDrag(event, rowIndex, gate.slot, gate.start, gate.end, 'resize-left')}
                  />
                  <span
                    className="sequencer-gate-handle sequencer-gate-handle-right"
                    onPointerDown={(event) => beginGateDrag(event, rowIndex, gate.slot, gate.start, gate.end, 'resize-right')}
                  />
                </div>
              ))}
            </div>
            <div className="sequencer-output-port">
              <input
                className="sequencer-row-label"
                aria-label={`Label for row ${rowIndex + 1}`}
                value={draftRowLabels[rowIndex] ?? String(rowIndex + 1)}
                size={Math.max(3, (draftRowLabels[rowIndex] ?? String(rowIndex + 1)).length)}
                onChange={(event) => updateRowLabel(rowIndex, event.target.value)}
                onBlur={() => commitRowLabel(rowIndex)}
                onPointerDown={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              <Handle
                id={`out:${outputName}`}
                type="source"
                position={Position.Right}
                className={[
                  'shader-handle shader-handle-output shader-handle-output-sequencer',
                  selectedLinkOutputs.includes(outputName) ? 'shader-handle-selected-link' : '',
                ].filter(Boolean).join(' ')}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CustomWaveEditor({
  customWave,
  waves,
  selectedWaveIndex,
  onWaveSelect,
  subdivisions,
  subgroups,
  baseLevel,
  rangeMin,
  rangeMax,
  frequency,
  hasLivePlayheads,
  playheads,
  compact,
  displaySize,
  graphZoomScale,
  graphScreenEmphasis,
  activePointIndex,
  editorRef,
  onPointerDown,
  onDoubleClick,
  onSustainStartChange,
  onSustainEndChange,
}: CustomWaveEditorProps) {
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(null);
  const width = 300;
  const height = 128;
  const padding = 12;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  const points = customWaveWithBaseLevel(customWave, baseLevel, rangeMin, rangeMax).points;
  const path = customWavePath(points, width, height, padding);
  const graphDetailSize = {
    width: displaySize.width * graphZoomScale,
    height: displaySize.height * graphZoomScale,
  };
  const gridColumns = customWaveGridColumns(subdivisions);
  const subgroupBands = customWaveSubgroupBands(subdivisions, subgroups, width, padding);
  const gridRows = customWaveGridRows(rangeMin, rangeMax, graphDetailSize.height);
  const sustainStartX = padding + customWave.sustainStart * innerWidth;
  const sustainEndX = padding + customWave.sustainEnd * innerWidth;
  const showSustainStart = customWaveUsesSustainStart(customWave.mode);
  const showSustainEnd = customWaveUsesSustainEnd(customWave.mode);
  const showLowFrequencyScan = hasLivePlayheads && Number.isFinite(frequency) && Math.abs(frequency) < 20;
  const hitRadius = screenCircleRadius(15 * graphScreenEmphasis, width, height, graphDetailSize);
  const editPointScreenScale = customWaveEditPointScreenScale(graphZoomScale);
  const endpointRadius = screenCircleRadius(5 * graphScreenEmphasis * editPointScreenScale, width, height, graphDetailSize);
  const handleRadius = screenCircleRadius(6 * graphScreenEmphasis * editPointScreenScale, width, height, graphDetailSize);
  const valueLabelIndex = activePointIndex ?? hoveredPointIndex;
  const valueLabelPoint = valueLabelIndex === null ? null : points[valueLabelIndex] ?? null;
  const valueLabelScreen = valueLabelPoint
    ? customWavePointToScreen(valueLabelPoint, width, height, padding)
    : null;

  return (
    <div className="custom-wave-node-editor nodrag nopan">
      <div className="custom-wave-node-chart">
        {waves.length > 1 ? (
          <div className="custom-wave-tabs" aria-label="Select wave">
            {waves.map((_, index) => <button key={index} type="button" className={`custom-wave-tab wave-color-${index % 8} ${index === selectedWaveIndex ? 'is-selected' : ''} nodrag nopan`} title={`Edit wave ${index + 1} (${index + 1})`} onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onWaveSelect(index); }}>{index + 1}</button>)}
          </div>
        ) : null}
        {subgroupBands.length > 0 ? (
          <svg className="custom-wave-subgroup-bands" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
            {subgroupBands.map((band) => <rect key={band.x} x={band.x} y={padding} width={band.width} height={innerHeight} />)}
          </svg>
        ) : null}
        <ChartGrid
          width={innerWidth}
          height={innerHeight}
          columns={gridColumns}
          rows={gridRows}
          className="custom-wave-node-grid"
          showRowLabels
        />
        <svg
          ref={editorRef}
          className="custom-wave-node-canvas"
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          aria-label="Custom wave editor"
          role="img"
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}
        >
        <g className="custom-wave-chart-chrome">
          {showSustainStart ? (
            <line className="custom-wave-sustain-line" x1={sustainStartX} y1={padding} x2={sustainStartX} y2={height - padding} />
          ) : null}
          {showSustainEnd ? (
            <line className="custom-wave-sustain-line is-end" x1={sustainEndX} y1={padding} x2={sustainEndX} y2={height - padding} />
          ) : null}
          {waves.map((wave, index) => index !== selectedWaveIndex ? <path key={index} className={`custom-wave-path is-background wave-color-${index % 8}`} d={customWavePath(customWaveWithBaseLevel(wave, baseLevel, rangeMin, rangeMax).points, width, height, padding)} /> : null)}
          <path className={`custom-wave-path wave-color-${selectedWaveIndex % 8}`} d={path} />
          {showLowFrequencyScan ? playheads.map((playhead, index) => {
            const playheadX = padding + clamp(playhead, 0, 1) * innerWidth;
            return <line className={`wave-playhead-line wave-playhead-${index % 4} is-low-frequency`} key={`${index}:${playhead}`} x1={playheadX} y1={padding} x2={playheadX} y2={height - padding}><title>Playback {index + 1}</title></line>;
          }) : null}
        </g>
        {points.map((point, index) => {
          const screen = customWavePointToScreen(point, width, height, padding);
          const locked = index === 0 || index === points.length - 1;
          return (
            <g
              key={`${point.x}:${point.y}:${index}`}
              onPointerEnter={() => setHoveredPointIndex(index)}
              onPointerLeave={() => setHoveredPointIndex((current) => current === index ? null : current)}
            >
              <ellipse
                className={[
                  'custom-wave-hit-target',
                  locked ? 'is-locked' : '',
                ].filter(Boolean).join(' ')}
                data-index={index}
                cx={screen.x}
                cy={screen.y}
                rx={hitRadius.rx}
                ry={hitRadius.ry}
              />
              <ellipse
                className={[
                  'custom-wave-handle',
                  locked ? 'custom-wave-endpoint is-locked' : '',
                ].filter(Boolean).join(' ')}
                data-index={index}
                cx={screen.x}
                cy={screen.y}
                rx={locked ? endpointRadius.rx : handleRadius.rx}
                ry={locked ? endpointRadius.ry : handleRadius.ry}
              />
            </g>
          );
        })}
        </svg>
        {valueLabelPoint && valueLabelScreen ? (
          <span
            className={[
              'custom-wave-node-value-label',
              valueLabelPoint.x > 0.72 ? 'is-left' : '',
              valueLabelPoint.y > 0.72 ? 'is-below' : '',
            ].filter(Boolean).join(' ')}
            style={{
              left: `${(valueLabelScreen.x / width) * 100}%`,
              top: `${(valueLabelScreen.y / height) * 100}%`,
            }}
            aria-hidden="true"
          >
            {formatChartValue(customWaveOutputValue(valueLabelPoint.y, rangeMin, rangeMax))}
          </span>
        ) : null}
      </div>
      {!compact && (showSustainStart || showSustainEnd) ? (
      <div className="custom-wave-node-controls">
        {showSustainStart ? (
          <CustomWaveRange
            label="start"
            value={customWave.sustainStart}
            min={0}
            max={Math.max(0, customWave.sustainEnd - 0.001)}
            onChange={onSustainStartChange}
          />
        ) : null}
        {showSustainEnd ? (
          <CustomWaveRange
            label="end"
            value={customWave.sustainEnd}
            min={Math.min(1, customWave.sustainStart + 0.001)}
            max={1}
            onChange={onSustainEndChange}
          />
        ) : null}
      </div>
      ) : null}
    </div>
  );
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

function customWavePath(points: CustomWavePoint[], width: number, height: number, padding: number): string {
  return points.map((point, index) => {
    const screen = customWavePointToScreen(point, width, height, padding);
    return `${index === 0 ? 'M' : 'L'}${roundPathNumber(screen.x)} ${roundPathNumber(screen.y)}`;
  }).join(' ');
}

function customWavePointToScreen(point: CustomWavePoint, width: number, height: number, padding: number): CustomWavePoint {
  return {
    x: padding + point.x * (width - padding * 2),
    y: padding + (1 - ((point.y + 1) / 2)) * (height - padding * 2),
  };
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

function formatSliderReadoutValue(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Object.is(value, -0)) return '0';
  return String(Number(value.toPrecision(6)));
}

function buttonModeFromValue(value: number): ButtonMode {
  const mode = Math.round(value);
  if (mode === 1) return 'trigger';
  if (mode === 2) return 'temporary';
  return 'toggle';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

interface NodeTypePickerProps {
  nodeType: NodeType | null;
  displayLabel?: string;
  closedSuffix?: string;
  isEditingSubpatch: boolean;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  onCancel: () => void;
  onChange: (type: NodeType) => void;
  onConvertToArea: () => void;
  onCustomLabelCommit?: (label: string) => void;
}

interface CollapsedNodeLabelProps {
  nodeType: NodeType | null;
  customLabel?: string;
  displaySuffix?: string;
  onChange: (label: string) => void;
  onSelect: (additive: boolean) => void;
}

function CollapsedNodeLabel({ nodeType, customLabel, displaySuffix, onChange, onSelect }: CollapsedNodeLabelProps) {
  const defaultLabel = nodeType ? getNodeTypeLabel(nodeType) : 'type';
  const displayLabel = customLabel || defaultLabel;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(displayLabel);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectTimeoutRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  useEffect(() => () => {
    if (selectTimeoutRef.current !== null) window.clearTimeout(selectTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!editing) setDraft(displayLabel);
  }, [displayLabel, editing]);

  useEffect(() => {
    if (!editing) return;
    const animationFrame = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(animationFrame);
  }, [editing]);

  function commit() {
    onChange(draft);
    setEditing(false);
  }

  function cancel() {
    setDraft(displayLabel);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="collapsed-node-label-editor nodrag nopan"
        size={Math.max(1, draft.length)}
        value={draft}
        aria-label="Collapsed node label"
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') commit();
          if (event.key === 'Escape') cancel();
        }}
        onMouseDown={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        spellCheck={false}
      />
    );
  }

  return (
    <button
      className={[
        'collapsed-node-label',
        displaySuffix ? 'node-title-with-live-readout' : '',
      ].filter(Boolean).join(' ')}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        if (selectTimeoutRef.current !== null) window.clearTimeout(selectTimeoutRef.current);
        const additive = event.metaKey || event.ctrlKey || event.shiftKey;
        selectTimeoutRef.current = window.setTimeout(() => {
          selectTimeoutRef.current = null;
          onSelect(additive);
        }, 600);
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (selectTimeoutRef.current !== null) {
          window.clearTimeout(selectTimeoutRef.current);
          selectTimeoutRef.current = null;
        }
        setEditing(true);
      }}
    >
      {displayLabel}
      {displaySuffix ? <span className="slider-node-title-readout" aria-hidden="true">{displaySuffix}</span> : null}
    </button>
  );
}

function NewPortPlaceholder({ label, onAdd }: { label: string; onAdd: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function finish() {
    if (draft.trim()) onAdd(draft);
    setDraft('');
    setEditing(false);
  }

  return (
    <div className="shader-port shader-port-placeholder nodrag nopan">
      {editing ? (
        <input
          ref={inputRef}
          className="port-name-editor nodrag nopan"
          aria-label={label}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={finish}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') finish();
            if (event.key === 'Escape') { setDraft(''); setEditing(false); }
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          spellCheck={false}
        />
      ) : (
        <button
          type="button"
          className="port-name-placeholder nodrag nopan"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => { event.stopPropagation(); setEditing(true); }}
          onDoubleClick={(event) => event.stopPropagation()}
        >{label}</button>
      )}
    </div>
  );
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

function NodeTypePicker({
  nodeType,
  displayLabel,
  closedSuffix,
  isEditingSubpatch,
  open,
  onOpen,
  onClose,
  onCancel,
  onChange,
  onConvertToArea,
  onCustomLabelCommit,
}: NodeTypePickerProps) {
  const fm1Mode = useContext(Fm1ModeContext);
  const nodeTypeLabel = nodeType ? getNodeTypeLabel(nodeType) : 'type';
  const pickerLabel = displayLabel ?? nodeTypeLabel;
  const [query, setQuery] = useState<string>(nodeType ? pickerLabel : '');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [dragIntent, setDragIntent] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  const searchQuery = displayLabel && query.trim() === pickerLabel
    ? nodeTypeLabel
    : query;
  const options = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();

    return [...NODE_TYPE_LIST, 'Area' as const]
      .filter((option) => {
        if (fm1Mode && option !== 'Area' && !isFm1NodeImplemented(option)) return false;
        if ((!isEditingSubpatch && (option === 'Ins' || option === 'Outs')) || (isEditingSubpatch && option === 'Params')) return false;
        const label = option === 'Area' ? 'Area' : getNodeTypeLabel(option);
        return (
          option.toLowerCase().includes(normalizedQuery) ||
          label.toLowerCase().includes(normalizedQuery)
        );
      })
      .sort((left, right) => {
        const leftLabel = left === 'Area' ? 'Area' : getNodeTypeLabel(left);
        const rightLabel = right === 'Area' ? 'Area' : getNodeTypeLabel(right);
        const leftStartsWithQuery = (
          left.toLowerCase().startsWith(normalizedQuery) ||
          leftLabel.toLowerCase().startsWith(normalizedQuery)
        );
        const rightStartsWithQuery = (
          right.toLowerCase().startsWith(normalizedQuery) ||
          rightLabel.toLowerCase().startsWith(normalizedQuery)
        );

        return Number(rightStartsWithQuery) - Number(leftStartsWithQuery);
      });
  }, [fm1Mode, isEditingSubpatch, searchQuery]);
  useEffect(() => {
    if (!open) {
      setQuery(nodeType ? pickerLabel : '');
      setHighlightedIndex(0);
    }
  }, [nodeType, open, pickerLabel]);

  useEffect(() => {
    if (open) {
      setQuery(nodeType ? pickerLabel : '');
      setHighlightedIndex(0);
      const focusAndSelect = () => {
        inputRef.current?.focus({ preventScroll: true });
        inputRef.current?.select();
      };
      const animationFrame = requestAnimationFrame(focusAndSelect);
      const firstTimeout = window.setTimeout(focusAndSelect, 0);
      const secondTimeout = window.setTimeout(focusAndSelect, 50);

      return () => {
        cancelAnimationFrame(animationFrame);
        window.clearTimeout(firstTimeout);
        window.clearTimeout(secondTimeout);
      };
    }
  }, [nodeType, open, pickerLabel]);

  useEffect(() => {
    if (!open) return;
    optionRefs.current[highlightedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [highlightedIndex, open]);

  function choose(option: NodeType | 'Area') {
    if (option === 'Area') {
      onConvertToArea();
    } else {
      onChange(option);
    }
    onClose();
  }

  function commitCustomLabel(): boolean {
    const label = query.trim();
    if (!onCustomLabelCommit || label.length === 0) return false;

    onCustomLabelCommit(label);
    onClose();
    return true;
  }

  function closeOrCommitCustomLabel() {
    if (options.length === 0 && commitCustomLabel()) return;
    onClose();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.min(index + 1, Math.max(options.length - 1, 0)));
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightedIndex((index) => Math.max(index - 1, 0));
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const selectedType = options[highlightedIndex] ?? options[0];
      if (selectedType) {
        choose(selectedType);
      } else {
        commitCustomLabel();
      }
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    }
  }

  if (!open) {
    return (
      <button
        className={[
          'node-type-picker-button',
          dragIntent ? 'node-type-picker-button-drag-intent' : '',
          closedSuffix ? 'node-title-with-live-readout' : '',
        ].filter(Boolean).join(' ')}
        type="button"
        onPointerDown={(event) => {
          pointerStartRef.current = { x: event.clientX, y: event.clientY };
          setDragIntent(false);
        }}
        onPointerMove={(event) => {
          const pointerStart = pointerStartRef.current;
          if (!pointerStart) return;

          const moved = Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4;
          if (!moved) return;

          setDragIntent(true);
          event.currentTarget.blur();
        }}
        onPointerUp={() => {
          window.setTimeout(() => setDragIntent(false), 0);
        }}
        onPointerCancel={() => {
          pointerStartRef.current = null;
          setDragIntent(false);
        }}
        onClick={(event) => {
          const pointerStart = pointerStartRef.current;
          pointerStartRef.current = null;
          const moved = pointerStart
            ? Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 4
            : false;
          if (moved) {
            event.currentTarget.blur();
            return;
          }
        }}
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onOpen();
        }}
      >
        {pickerLabel}
        {closedSuffix ? <span className="slider-node-title-readout" aria-hidden="true">{closedSuffix}</span> : null}
      </button>
    );
  }

  return (
    <span className="node-type-picker-open-shell">
      <span className="node-type-picker-placeholder" aria-hidden="true">{pickerLabel}</span>
      <div className="node-type-picker nodrag nopan nowheel" onMouseDown={(event) => event.stopPropagation()}>
        <input
          ref={inputRef}
          className="node-type-picker-input"
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setHighlightedIndex(0);
            if (menuRef.current) {
              menuRef.current.scrollTop = 0;
            }
          }}
          onBlur={closeOrCommitCustomLabel}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleKeyDown}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          spellCheck={false}
        />
        <div
          ref={menuRef}
          className="node-type-picker-menu nowheel"
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onWheel={(event) => event.stopPropagation()}
        >
          {options.map((option, index) => (
            <button
              className={index === highlightedIndex ? 'active' : ''}
              key={option}
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                event.stopPropagation();
                choose(option);
              }}
            >
              {option === 'Area' ? 'Area' : getNodeTypeLabel(option)}
            </button>
          ))}
          {options.length === 0 ? <div className="node-type-picker-empty">no match</div> : null}
        </div>
      </div>
    </span>
  );
}

type MidiCcLearnEvent = NonNullable<NonNullable<ShaderNodeData['midiInput']>['lastControlChange']>;

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
        className="shader-port-select nodrag nopan"
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

function NumericScrubber({
  value,
  min,
  max,
  step: baseStep,
  integer = false,
  replacedBySetLink = false,
  onChange,
  onClear,
  midiLearnEvent,
  onEditStart,
  onMidiLearn,
}: NumericScrubberProps) {
  const dragStep = integer ? (baseStep ?? 0.01) * 3 : baseStep;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(formatNumericValue(value));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const lastMidiLearnIdRef = useRef<number | null>(null);
  const wheelValueRef = useRef(value);
  const lastWheelTimeRef = useRef(-Infinity);
  const wheelTargetRef = useModifiedWheel<HTMLDivElement>((event) => {
    if (event.timeStamp - lastWheelTimeRef.current > 160) {
      wheelValueRef.current = value;
    }
    lastWheelTimeRef.current = event.timeStamp;
    const wheelDelta = wheelAxisDeltaPixels(event, 'vertical');
    if (wheelDelta === 0) return;
    const nextValue = constrainValue(
      roundValue(wheelValueRef.current + wheelDelta * scrubberStep(event, dragStep)),
      min,
      max,
      integer,
    );
    wheelValueRef.current = nextValue;
    onChange(nextValue);
  });
  const dragRef = useRef<{
    pointerId: number;
    anchorY: number;
    anchorValue: number;
    currentValue: number;
    step: number;
    dragging: boolean;
  } | null>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(formatNumericValue(value));
    }
  }, [editing, value]);

  useEffect(() => {
    if (editing) {
      setDraft(formatNumericValue(value));
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [editing, value]);

  useEffect(() => {
    if (!editing || !midiLearnEvent || !onMidiLearn) return;
    if (lastMidiLearnIdRef.current === midiLearnEvent.id) return;

    lastMidiLearnIdRef.current = midiLearnEvent.id;
    const nextValue = constrainValue(midiLearnEvent.cc, min, max, integer);
    setDraft(formatNumericValue(nextValue));
    onMidiLearn(midiLearnEvent);
  }, [editing, integer, max, midiLearnEvent, min, onMidiLearn]);

  function beginEditing() {
    lastMidiLearnIdRef.current = midiLearnEvent?.id ?? null;
    onEditStart?.();
    setEditing(true);
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    event.stopPropagation();
    dragRef.current = {
      pointerId: event.pointerId,
      anchorY: event.clientY,
      anchorValue: value,
      currentValue: value,
      step: scrubberStep(event, dragStep),
      dragging: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const distance = drag.anchorY - event.clientY;
    if (!drag.dragging && Math.abs(distance) < 3) return;

    drag.dragging = true;
    event.preventDefault();
    event.stopPropagation();

    const step = scrubberStep(event, dragStep);
    if (step !== drag.step) {
      drag.anchorY = event.clientY;
      drag.anchorValue = drag.currentValue;
      drag.step = step;
    }

    const nextValue = constrainValue(
      roundValue(drag.anchorValue + (drag.anchorY - event.clientY) * drag.step),
      min,
      max,
      integer,
    );
    drag.currentValue = nextValue;
    onChange(nextValue);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    event.stopPropagation();
    event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = null;

    if (drag.dragging) {
      event.currentTarget.blur();
    } else {
      beginEditing();
    }
  }

  function commitDraft() {
    const trimmedDraft = draft.trim();
    if (trimmedDraft.length === 0 && onClear) {
      onClear();
      setEditing(false);
      return;
    }

    const nextValue = Number(trimmedDraft);
    if (Number.isFinite(nextValue)) {
      onChange(constrainValue(nextValue, min, max, integer));
    } else {
      setDraft(formatNumericValue(value));
    }
    setEditing(false);
  }

  function cancelDraft() {
    setDraft(formatNumericValue(value));
    setEditing(false);
  }

  function handleEditKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    event.stopPropagation();
    if (event.key === 'Enter') {
      commitDraft();
    }
    if (event.key === 'Escape') {
      cancelDraft();
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className={`numeric-scrubber numeric-scrubber-editing${replacedBySetLink ? ' numeric-scrubber-replaced' : ''} nodrag nopan`}
        type="text"
        inputMode={integer ? 'numeric' : 'decimal'}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commitDraft}
        onKeyDown={handleEditKeyDown}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        spellCheck={false}
      />
    );
  }

  return (
    <div
      ref={wheelTargetRef}
      className={`numeric-scrubber${replacedBySetLink ? ' numeric-scrubber-replaced' : ''} nodrag nopan`}
      role="spinbutton"
      tabIndex={-1}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      onPointerDown={startDrag}
      onPointerMove={updateDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.stopPropagation();
          beginEditing();
        }
      }}
    >
      {formatNumericValue(value)}
    </div>
  );
}

function roundValue(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function scrubberStep(event: { metaKey: boolean; shiftKey: boolean }, baseStep = 0.01): number {
  if (event.metaKey && event.shiftKey) return baseStep * 200;
  if (event.metaKey) return baseStep * 20;
  if (event.shiftKey) return baseStep * 0.1;
  return baseStep;
}

function useModifiedWheel<T extends HTMLElement>(
  onWheel: (event: WheelEvent, target: T) => void,
): RefObject<T | null> {
  const targetRef = useRef<T | null>(null);
  const handlerRef = useRef(onWheel);
  handlerRef.current = onWheel;

  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.shiftKey && !event.altKey) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      handlerRef.current(event, target);
    };

    target.addEventListener('wheel', handleWheel, { capture: true, passive: false });
    return () => target.removeEventListener('wheel', handleWheel, { capture: true });
  });

  return targetRef;
}

function wheelAxisDeltaPixels(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode'>,
  direction: 'horizontal' | 'vertical',
): number {
  const delta = direction === 'vertical' ? event.deltaY : event.deltaX;
  if (event.deltaMode === 1) return delta * 16;
  if (event.deltaMode === 2) return delta * window.innerHeight;
  return delta;
}

function constrainValue(value: number, min?: number, max?: number, integer = false): number {
  const rounded = integer ? Math.round(value) : value;
  return Math.min(Math.max(rounded, min ?? -Infinity), max ?? Infinity);
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
