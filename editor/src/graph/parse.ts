// Shared legacy parser. No browser, storage, device or editor dependencies.
import { normalizeCustomWave } from './customWave';
import { extractExpressionInputs } from './expression';
import { getDefinition } from './nodeTypes';
import { normalizePatchCompatibility } from './patchCompatibility';
import type { BufferAsset, CustomWaveSettings, ImageAsset, NodeType, Patch, PatchArea as EditorArea, PatchLink, PatchNode, PortDefinition, SampleAsset } from './types';
type ScopeNodeSize = { width: number; height: number };
const DEFAULT_EXPRESSION = 'a';
function clampScopeNodeSize(size: ScopeNodeSize): ScopeNodeSize {
  const dimension = (value: number) => Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
  return { width: dimension(size.width), height: dimension(size.height) };
}
const clampCustomWaveNodeSize = clampScopeNodeSize;
const clampControlNodeSize = clampScopeNodeSize;
function clampImageNodeSize(size: ScopeNodeSize, aspect: number): ScopeNodeSize {
  const width = clampScopeNodeSize(size).width;
  return clampScopeNodeSize({ width, height: width / (Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9) });
}
export function parsePatchJson(json: string): Patch {
  const parsed = JSON.parse(json) as unknown;
  return parsePatchObject(parsed, 'Patch JSON');
}

export function parsePatchObject(value: unknown, label: string): Patch {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error(`${label} has an unsupported schema version.`);
  if (!Array.isArray(value.nodes)) {
    throw new Error(`${label} must contain a nodes array.`);
  }
  if (!Array.isArray(value.links)) {
    throw new Error(`${label} must contain a links array.`);
  }

  return normalizePatchCompatibility({
    ...(value.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
    ...(typeof value.name === 'string' ? { name: value.name } : {}),
    ...parseBufferAssets(value.buffers, label),
    ...parseMidiInputPreferences(value.midiInput),
    ...parsePatchAreas(value.areas, label),
    nodes: value.nodes.flatMap((node, index) => {
      const parsedNode = parsePatchNode(node, index);
      return parsedNode ? [parsedNode] : [];
    }),
    links: value.links.map((link, index) => parsePatchLink(link, index)),
  });
}

function parseBufferAssets(value: unknown, label: string): Pick<Patch, 'buffers'> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} buffers must be an object.`);
  const buffers: Record<string, BufferAsset> = {};
  for (const [nodeId, entry] of Object.entries(value)) {
    if (
      !nodeId
      || !isRecord(entry)
      || typeof entry.hash !== 'string'
      || !/^[a-f0-9]{64}$/.test(entry.hash)
      || typeof entry.sampleRate !== 'number'
      || !Number.isFinite(entry.sampleRate)
      || entry.sampleRate <= 0
      || typeof entry.sampleCount !== 'number'
      || !Number.isSafeInteger(entry.sampleCount)
      || entry.sampleCount < 2
      || entry.sampleCount > 960_000
    ) {
      throw new Error(`${label} has an invalid Buffer reference for "${nodeId}".`);
    }
    buffers[nodeId] = {
      hash: entry.hash,
      sampleRate: entry.sampleRate,
      sampleCount: entry.sampleCount,
    };
  }
  return Object.keys(buffers).length > 0 ? { buffers } : {};
}

function parsePatchAreas(value: unknown, label: string): Pick<Patch, 'areas'> {
  if (value === undefined) return {};
  if (!Array.isArray(value)) throw new Error(`${label} areas must be an array.`);
  const areas = value.map((area, index): EditorArea => {
    if (!isRecord(area) || typeof area.id !== 'string' || typeof area.title !== 'string') {
      throw new Error(`${label} area ${index} needs string id and title values.`);
    }
    if (!isRecord(area.position) || !isRecord(area.size)
      || typeof area.position.x !== 'number' || typeof area.position.y !== 'number'
      || typeof area.size.width !== 'number' || typeof area.size.height !== 'number') {
      throw new Error(`${label} area ${index} needs numeric position and size values.`);
    }
    return {
      id: area.id,
      title: area.title,
      position: { x: area.position.x, y: area.position.y },
      size: { width: area.size.width, height: area.size.height },
      ...(area.kind === 'spread' ? { kind: 'spread' as const } : {}),
      ...(typeof area.spreadNodeId === 'string' ? { spreadNodeId: area.spreadNodeId } : {}),
      ...(typeof area.uiHeight === 'number' ? { uiHeight: area.uiHeight } : {}),
      ...(typeof area.collapsed === 'boolean' ? { collapsed: area.collapsed } : {}),
      ...(typeof area.locked === 'boolean' ? { locked: area.locked } : {}),
      ...(Array.isArray(area.nodeIds) && area.nodeIds.every((entry) => typeof entry === 'string')
        ? { nodeIds: area.nodeIds as string[] }
        : {}),
      ...(Array.isArray(area.areaIds) && area.areaIds.every((entry) => typeof entry === 'string')
        ? { areaIds: area.areaIds as string[] }
        : {}),
    };
  });
  return areas.length > 0 ? { areas } : {};
}

function parseMidiInputPreferences(value: unknown): Pick<Patch, 'midiInput'> {
  if (!isRecord(value)) return {};
  const selectedDeviceIds = normalizeSelectedMidiDeviceIds(value.selectedDeviceIds);
  const selectedOutputDeviceIds = normalizeSelectedMidiDeviceIds(value.selectedOutputDeviceIds);
  const sendClock = value.sendClock === true;
  return selectedDeviceIds.length > 0 || selectedOutputDeviceIds.length > 0 || sendClock
    ? { midiInput: {
      selectedDeviceIds,
      ...(selectedOutputDeviceIds.length > 0 ? { selectedOutputDeviceIds } : {}),
      ...(sendClock ? { sendClock: true } : {}),
    } }
    : {};
}

function parsePatchNode(value: unknown, index: number): PatchNode | null {
  if (!isRecord(value)) {
    throw new Error(`Node ${index} must be an object.`);
  }
  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new Error(`Node ${index} needs a string id.`);
  }
  if (!isNodeType(value.type)) {
    return null;
  }
  if (!isNumberRecord(value.params)) {
    throw new Error(`Node "${value.id}" needs numeric params.`);
  }
  if (value.expression !== undefined && typeof value.expression !== 'string') {
    throw new Error(`Node "${value.id}" expression must be a string.`);
  }
  if (value.subpatchName !== undefined && typeof value.subpatchName !== 'string') {
    throw new Error(`Node "${value.id}" subpatchName must be a string.`);
  }
  if (value.customLabel !== undefined && typeof value.customLabel !== 'string') {
    throw new Error(`Node "${value.id}" customLabel must be a string.`);
  }
  if (value.subpatchCloneId !== undefined && typeof value.subpatchCloneId !== 'string') {
    throw new Error(`Node "${value.id}" subpatchCloneId must be a string.`);
  }
  if (value.sequencerRowLabels !== undefined && (!Array.isArray(value.sequencerRowLabels) || !value.sequencerRowLabels.every(entry => typeof entry === 'string'))) throw new Error(`Node "${value.id}" sequencerRowLabels must be strings.`);
  if (value.sequencerRowLabelColumnWidth !== undefined && (typeof value.sequencerRowLabelColumnWidth !== 'number' || !Number.isFinite(value.sequencerRowLabelColumnWidth) || value.sequencerRowLabelColumnWidth < 0)) throw new Error(`Node "${value.id}" has invalid row-label width.`);
  const subpatchUiOverrides = parseSubpatchUiOverrides(value.subpatchUiOverrides, value.id);
  if (value.sample !== undefined && !isSampleAsset(value.sample)) {
    throw new Error(`Node "${value.id}" sample must include a string name and url.`);
  }
  if (value.image !== undefined && !isImageAsset(value.image)) {
    throw new Error(`Node "${value.id}" image must include a string name and url.`);
  }
  if (value.compactPorts !== undefined && typeof value.compactPorts !== 'boolean') {
    throw new Error(`Node "${value.id}" compactPorts must be a boolean.`);
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error(`Node "${value.id}" enabled must be a boolean.`);
  }
  if (value.spreadNodeIds !== undefined && (
    !Array.isArray(value.spreadNodeIds)
    || !value.spreadNodeIds.every((entry) => typeof entry === 'string')
  )) {
    throw new Error(`Node "${value.id}" spreadNodeIds must be an array of strings.`);
  }
  if (value.scale !== undefined && (typeof value.scale !== 'number' || !Number.isFinite(value.scale) || value.scale <= 0)) {
    throw new Error(`Node "${value.id}" scale must be a positive finite number.`);
  }

  const position = value.position === undefined ? undefined : parsePosition(value.position, value.id);
  const scopeSize = value.scopeSize === undefined ? undefined : parseNodeDisplaySize(value.scopeSize, value.id, value.type);
  const parsedInputs = value.inputs === undefined ? undefined : parsePortDefinitions(value.inputs, `Node "${value.id}" inputs`);
  const outputs = value.outputs === undefined ? undefined : parsePortDefinitions(value.outputs, `Node "${value.id}" outputs`);
  const subpatch = value.subpatch === undefined ? undefined : parsePatchObject(value.subpatch, `Node "${value.id}" subpatch`);
  const expression = value.type === 'Expression'
    ? (value.expression ?? DEFAULT_EXPRESSION)
    : value.expression;
  const inputs = value.type === 'Expression' && expression !== undefined
    ? (parsedInputs ?? expressionInputDefinitions(expression))
    : normalizeLegacyInputDefinitions(value.type, parsedInputs);
  const params = value.type === 'Expression' && inputs
    ? syncParamsToInputs(value.params, inputs)
    : normalizeLegacyNodeParams(value.type, value.params);
  const customWave = value.type === 'CustomWave'
    ? normalizeCustomWave(parseCustomWaveLike(value.customWave, value.id), params)
    : undefined;

  return {
    id: value.id,
    type: value.type,
    ...(typeof value.customLabel === 'string' && value.customLabel.trim() ? { customLabel: value.customLabel.trim() } : {}),
    ...(Array.isArray(value.sequencerRowLabels) ? { sequencerRowLabels: [...value.sequencerRowLabels] as string[] } : {}),
    ...(typeof value.sequencerRowLabelColumnWidth === 'number' ? { sequencerRowLabelColumnWidth: value.sequencerRowLabelColumnWidth } : {}),
    ...(value.subpatchName ? { subpatchName: value.subpatchName } : {}),
    ...(value.subpatchCloneId ? { subpatchCloneId: value.subpatchCloneId } : {}),
    ...(subpatchUiOverrides ? { subpatchUiOverrides } : {}),
    ...(expression !== undefined ? { expression } : {}),
    ...(isSampleAsset(value.sample) ? { sample: value.sample } : {}),
    ...(isImageAsset(value.image) ? { image: value.image } : {}),
    ...(customWave ? { customWave } : {}),
    params,
    ...(position ? { position } : {}),
    ...(typeof value.scale === 'number' ? { scale: value.scale } : {}),
    ...(scopeSize ? { scopeSize } : {}),
    ...(inputs ? { inputs } : {}),
    ...(outputs ? { outputs } : {}),
    ...(subpatch ? { subpatch } : {}),
    ...(typeof value.compactPorts === 'boolean' ? { compactPorts: value.compactPorts } : {}),
    ...(value.enabled === false ? { enabled: false } : {}),
    ...(Array.isArray(value.spreadNodeIds) ? { spreadNodeIds: value.spreadNodeIds as string[] } : {}),
  };
}

function normalizeLegacyNodeParams(type: NodeType, params: Record<string, number>): Record<string, number> {
  if (type !== 'SamplePlayer' || params.originalFrequency !== undefined || params.originalPitch === undefined) {
    return params;
  }

  const { originalPitch, ...nextParams } = params;
  return {
    ...nextParams,
    originalFrequency: midiNoteFrequency(originalPitch),
  };
}

function normalizeLegacyInputDefinitions(type: NodeType, inputs: PortDefinition[] | undefined): PortDefinition[] | undefined {
  if (type === 'Playhead') {
    if (!inputs || inputs.some((input) => input.name === 'length')) return inputs;
    return [...inputs, { name: 'length', defaultValue: 1, min: 0.001 }];
  }

  if (type !== 'SamplePlayer') return inputs;
  return inputs?.map((input) => (
    input.name === 'originalPitch'
      ? { ...input, name: 'originalFrequency', defaultValue: input.defaultValue === 60 ? 440 : input.defaultValue }
      : input
  ));
}

function midiNoteFrequency(note: number): number {
  return 440 * (2 ** ((note - 69) / 12));
}

function parseCustomWaveLike(value: unknown, nodeId: string): Partial<CustomWaveSettings> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Node "${nodeId}" customWave must be an object.`);
  }
  if (value.points !== undefined && !Array.isArray(value.points)) {
    throw new Error(`Node "${nodeId}" customWave.points must be an array.`);
  }
  return value as Partial<CustomWaveSettings>;
}

export function isSampleAsset(value: unknown): value is SampleAsset {
  return isRecord(value) && typeof value.name === 'string' && typeof value.url === 'string';
}

export function isImageAsset(value: unknown): value is ImageAsset {
  return isRecord(value) && typeof value.name === 'string' && typeof value.url === 'string';
}

function parsePosition(value: unknown, nodeId: string): { x: number; y: number } {
  if (!isRecord(value) || typeof value.x !== 'number' || typeof value.y !== 'number') {
    throw new Error(`Node "${nodeId}" position must have numeric x and y.`);
  }
  return { x: value.x, y: value.y };
}

function parseNodeDisplaySize(value: unknown, nodeId: string, type: NodeType): ScopeNodeSize {
  if (!isRecord(value) || typeof value.width !== 'number' || typeof value.height !== 'number') {
    throw new Error(`Node "${nodeId}" scopeSize must have numeric width and height.`);
  }

  const size = { width: value.width, height: value.height };
  if (type === 'Image') return clampImageNodeSize(size, size.width / Math.max(1, size.height));
  if (type === 'CustomWave' || type === 'SamplePlayer' || type === 'Buffer') return clampCustomWaveNodeSize(size);
  if (type === 'Slider' || type === 'Joystick' || type === 'Button') return clampControlNodeSize(size);
  return clampScopeNodeSize(size);
}

function parsePortDefinitions(value: unknown, label: string): PortDefinition[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value.map((entry, index) => {
    if (!isRecord(entry) || typeof entry.name !== 'string' || entry.name.trim() === '') {
      throw new Error(`${label} entry ${index} needs a string name.`);
    }
    return {
      name: entry.name,
      ...(typeof entry.parameterId === 'string' && entry.parameterId.length ? { parameterId: entry.parameterId } : {}),
      ...(typeof entry.step === 'number' ? { step: entry.step } : {}),
      ...(typeof entry.defaultValue === 'number' ? { defaultValue: entry.defaultValue } : {}),
      ...(typeof entry.connectable === 'boolean' ? { connectable: entry.connectable } : {}),
      ...(typeof entry.valueEditor === 'boolean' ? { valueEditor: entry.valueEditor } : {}),
      ...(typeof entry.min === 'number' ? { min: entry.min } : {}),
      ...(typeof entry.max === 'number' ? { max: entry.max } : {}),
      ...(typeof entry.integer === 'boolean' ? { integer: entry.integer } : {}),
    };
  });
}

function parsePatchLink(value: unknown, index: number): PatchLink {
  if (!isRecord(value)) {
    throw new Error(`Link ${index} must be an object.`);
  }
  return {
    from: parseEndpoint(value.from, `Link ${index} source`),
    to: parseEndpoint(value.to, `Link ${index} target`),
    ...(typeof value.weight === 'number' ? { weight: value.weight } : {}),
    ...(value.mode === 'set' || value.mode === 'add' || value.mode === 'multiply' || value.mode === 'bend' ? { mode: value.mode } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(Array.isArray(value.weightModulations) ? {
      weightModulations: value.weightModulations.map((entry, modulationIndex) => (
        parseLinkWeightModulation(entry, `Link ${index} strength modulation ${modulationIndex}`)
      )),
    } : {}),
  };
}

function parseLinkWeightModulation(
  value: unknown,
  label: string,
): NonNullable<PatchLink['weightModulations']>[number] {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return {
    from: parseEndpoint(value.from, `${label} source`),
    ...(typeof value.weight === 'number' ? { weight: value.weight } : {}),
    ...(value.mode === 'set' || value.mode === 'add' || value.mode === 'multiply' || value.mode === 'bend' ? { mode: value.mode } : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(Array.isArray(value.weightModulations) ? {
      weightModulations: value.weightModulations.map((entry, index) => parseLinkWeightModulation(entry, `${label}.${index}`)),
    } : {}),
  };
}

function parseEndpoint(value: unknown, label: string): PatchLink['from'] {
  if (!isRecord(value) || typeof value.node !== 'string' || typeof value.port !== 'string') {
    throw new Error(`${label} must have string node and port.`);
  }
  return { node: value.node, port: value.port };
}

export function isNodeType(value: unknown): value is NodeType {
  if (typeof value !== 'string') return false;
  const definition = getDefinition(value as NodeType) as ReturnType<typeof getDefinition> | undefined;
  return definition?.type === value;
}

export function isNumberRecord(value: unknown): value is Record<string, number> {
  if (!isRecord(value)) return false;
  return Object.values(value).every((entry) => typeof entry === 'number' && Number.isFinite(entry));
}

function parseSubpatchUiOverrides(
  value: unknown,
  groupNodeId: string,
): PatchNode['subpatchUiOverrides'] | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`Node "${groupNodeId}" subpatchUiOverrides must be an object.`);
  }

  return Object.fromEntries(Object.entries(value).map(([innerNodeId, rawOverride]) => {
    if (!isRecord(rawOverride)) {
      throw new Error(`Node "${groupNodeId}" UI override for "${innerNodeId}" must be an object.`);
    }
    if (rawOverride.params !== undefined && !isNumberRecord(rawOverride.params)) {
      throw new Error(`Node "${groupNodeId}" UI override params for "${innerNodeId}" must be numeric.`);
    }
    const params = rawOverride.params as Record<string, number> | undefined;
    const customWave = parseCustomWaveLike(rawOverride.customWave, `${groupNodeId}:${innerNodeId}`);
    return [innerNodeId, {
      ...(params ? { params } : {}),
      ...(customWave ? { customWave: normalizeCustomWave(customWave, params) } : {}),
    }];
  }));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSelectedMidiDeviceIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0))];
}

export function expressionInputDefinitions(expression: string): PortDefinition[] {
  return extractExpressionInputs(expression).map((name) => ({
    name,
    defaultValue: 0,
  }));
}

export function syncParamsToInputs(
  params: Record<string, number>,
  inputs: PortDefinition[],
): Record<string, number> {
  return Object.fromEntries(inputs.map((input) => [
    input.name,
    params[input.name] ?? input.defaultValue ?? 0,
  ]));
}
