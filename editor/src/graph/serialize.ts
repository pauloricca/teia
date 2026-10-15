import type { Patch } from './types';
import { normalizeCustomWave } from './customWave';

export function normalizePatch(patch: Patch): Patch {
  return {
    ...(patch.schemaVersion ? { schemaVersion: patch.schemaVersion } : {}),
    ...(patch.name ? { name: patch.name } : {}),
    ...(patch.buffers ? { buffers: normalizeBufferAssets(patch.buffers) } : {}),
    ...(patch.midiInput ? { midiInput: {
      selectedDeviceIds: [...patch.midiInput.selectedDeviceIds].sort(),
      ...(patch.midiInput.selectedOutputDeviceIds?.length ? {
        selectedOutputDeviceIds: [...patch.midiInput.selectedOutputDeviceIds].sort(),
      } : {}),
      ...(patch.midiInput.sendClock ? { sendClock: true } : {}),
    } } : {}),
    ...(patch.areas ? { areas: patch.areas.map((area) => ({
      ...area,
      position: { ...area.position },
      size: { ...area.size },
      ...(area.nodeIds ? { nodeIds: [...area.nodeIds].sort() } : {}),
      ...(area.areaIds ? { areaIds: [...area.areaIds].sort() } : {}),
    })) } : {}),
    nodes: [...patch.nodes]
      .map((node) => ({
        id: node.id,
        type: node.type,
        ...(node.customLabel ? { customLabel: node.customLabel } : {}),
        ...(node.sequencerRowLabels ? { sequencerRowLabels: [...node.sequencerRowLabels] } : {}),
        ...(node.sequencerRowLabelColumnWidth !== undefined ? { sequencerRowLabelColumnWidth: node.sequencerRowLabelColumnWidth } : {}),
        ...(node.subpatchName ? { subpatchName: node.subpatchName } : {}),
        ...(node.subpatchCloneId ? { subpatchCloneId: node.subpatchCloneId } : {}),
        ...(node.subpatchUiOverrides ? { subpatchUiOverrides: normalizeSubpatchUiOverrides(node.subpatchUiOverrides) } : {}),
        ...(node.expression !== undefined ? { expression: node.expression } : {}),
        ...(node.sample ? { sample: { ...node.sample } } : {}),
        ...(node.image ? { image: { ...node.image } } : {}),
        ...(node.customWave ? { customWave: normalizeCustomWave(node.customWave, node.params) } : {}),
        params: sortRecord(node.params),
        ...(node.position ? { position: node.position } : {}),
        ...(node.scale !== undefined ? { scale: node.scale } : {}),
        ...(node.scopeSize ? { scopeSize: { ...node.scopeSize } } : {}),
        ...(node.inputs ? { inputs: node.inputs.map((input) => ({ ...input })) } : {}),
        ...(node.outputs ? { outputs: node.outputs.map((output) => ({ ...output })) } : {}),
        ...(node.subpatch ? { subpatch: normalizePatch(node.subpatch) } : {}),
        ...(node.compactPorts !== undefined ? { compactPorts: node.compactPorts } : {}),
        ...(node.enabled === false ? { enabled: false } : {}),
        ...(node.spreadNodeIds ? { spreadNodeIds: [...node.spreadNodeIds].sort() } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    links: [...patch.links]
      .map((link) => ({
        from: { ...link.from },
        to: { ...link.to },
        ...(link.weight !== undefined ? { weight: link.weight } : {}),
        ...(link.mode !== undefined ? { mode: link.mode } : {}),
        ...(link.enabled === false ? { enabled: false } : {}),
        ...(link.weightModulations?.length ? { weightModulations: structuredClone(link.weightModulations) } : {}),
      }))
      .sort(compareLinks),
  };
}

function normalizeBufferAssets(buffers: NonNullable<Patch['buffers']>): NonNullable<Patch['buffers']> {
  return Object.fromEntries(Object.entries(buffers)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, buffer]) => [nodeId, { ...buffer }]));
}

export function patchToJson(patch: Patch): string {
  return `${JSON.stringify(normalizePatch(patch), null, 2)}\n`;
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function normalizeSubpatchUiOverrides(
  overrides: NonNullable<Patch['nodes'][number]['subpatchUiOverrides']>,
): NonNullable<Patch['nodes'][number]['subpatchUiOverrides']> {
  return Object.fromEntries(Object.entries(overrides)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([nodeId, override]) => [nodeId, {
      ...(override.params ? { params: sortRecord(override.params) } : {}),
      ...(override.customWave ? { customWave: normalizeCustomWave(override.customWave, override.params) } : {}),
    }]));
}

function compareLinks(a: Patch['links'][number], b: Patch['links'][number]): number {
  return (
    a.to.node.localeCompare(b.to.node) ||
    a.to.port.localeCompare(b.to.port) ||
    a.from.node.localeCompare(b.from.node) ||
    a.from.port.localeCompare(b.from.port)
  );
}
