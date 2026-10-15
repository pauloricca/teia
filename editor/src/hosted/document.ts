import { parsePatchObject } from '../graph/parse';
import { patchToJson } from '../graph/serialize';
import type { Patch } from '../graph/types';

export const DOCUMENT_VERSION = 1 as const;
export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
  nodeId?: string;
  port?: string;
}
export interface DocumentResult {
  /** Original input is retained for hosts that need lossless import review. */
  source: unknown;
  patch?: Patch;
  sourceVersion: number;
  diagnostics: Diagnostic[];
}

/** Unversioned Teia JSON is legacy version 0. Import never stamps a version. */
export function readDocument(input: string | unknown): DocumentResult {
  let source: unknown = input;
  const diagnostics: Diagnostic[] = [];
  let sourceVersion = 0;
  try {
    if (typeof input === 'string') source = JSON.parse(input);
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Patch must be an object.');
    const version = (source as Record<string, unknown>).schemaVersion;
    sourceVersion = version === undefined ? 0 : Number(version);
    if (version !== undefined && version !== DOCUMENT_VERSION) throw new Error(`Unsupported document schema version ${String(version)}.`);
    const patch = parsePatchObject(source, 'Patch JSON');
    reportChanges(source, patch, '$', diagnostics);
    validateIds(patch, diagnostics);
    validateNumbers(patch, diagnostics, '$');
    return { source, patch, sourceVersion, diagnostics };
  } catch (error) {
    diagnostics.push({ severity: 'error', code: 'invalid-document', message: String(error instanceof Error ? error.message : error) });
    return { source, sourceVersion, diagnostics };
  }
}

function reportChanges(before: unknown, after: unknown, path: string, diagnostics: Diagnostic[]): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  if (before && after && typeof before === 'object' && typeof after === 'object') {
    for (const [key, value] of Object.entries(before)) {
      const next = (after as Record<string, unknown>)[key];
      if (next === undefined) {
        const aliases: Record<string, string> = { originalPitch: 'originalFrequency', recordHead: 'record head', phaseReset: 'trigger' };
        const canonical = (key === 'enabled' && value === true)
          || (path.endsWith('.params') && aliases[key] !== undefined && aliases[key] in after)
          || ((key === 'areas' || key === 'buffers' || path.endsWith('.midiInput')) && ((Array.isArray(value) && value.length === 0) || value === false || (value && typeof value === 'object' && Object.keys(value).length === 0)))
          || (key === 'midiInput' && isEmptyMidiPreference(value))
          || (key === 'outputs' && (before as Record<string, unknown>).type === 'Reverb')
          || (key === 'customLabel' && typeof value === 'string' && value.trim() === '');
        diagnostics.push({ severity: canonical ? 'info' : 'warning', code: canonical ? 'migration' : 'discarded-content', path: `${path}.${key}`, message: canonical ? `Compatibility import canonicalized ${path}.${key}.` : `Compatibility import discarded ${path}.${key}. Original input remains available in source.` });
      }
      else reportChanges(value, next, `${path}.${key}`, diagnostics);
    }
    for (const key of Object.keys(after)) {
      if (!(key in before)) diagnostics.push({ severity: 'info', code: 'migration', path: `${path}.${key}`, message: `Compatibility import supplied ${path}.${key}.` });
    }
  } else diagnostics.push({ severity: 'info', code: 'migration', path, message: `Compatibility import normalized ${path}.` });
}

function validateIds(patch: Patch, diagnostics: Diagnostic[]): void {
  const ids = new Set<string>();
  for (const node of patch.nodes) {
    if (ids.has(node.id)) diagnostics.push({ severity: 'error', code: 'duplicate-node', nodeId: node.id, message: `Duplicate node id ${node.id}.` });
    ids.add(node.id);
    for (const side of [node.inputs, node.outputs]) {
      const names = side?.map(port => port.name) ?? [];
      if (new Set(names).size !== names.length) diagnostics.push({ severity: 'error', code: 'duplicate-port', nodeId: node.id, message: `Duplicate port name on ${node.id}.` });
    }
    if (node.subpatch) validateIds(node.subpatch, diagnostics);
  }
}

/** Opt-in hosted migration. IDs are persisted on ports, never derived again after rename. */
export function withParameterIds(source: Patch, scope: string[] = []): Patch {
  const patch = structuredClone(source);
  for (const node of patch.nodes) {
    if (node.type === 'Params') for (const port of node.outputs ?? []) {
      port.parameterId ??= `teia:${JSON.stringify([...scope, node.id, port.name])}`;
    }
    if (node.subpatch) node.subpatch = withParameterIds(node.subpatch, [...scope, node.id]);
  }
  return patch;
}
export { patchToJson as writeDocument };

function validateNumbers(value: unknown, diagnostics: Diagnostic[], path: string): void {
  if (typeof value === 'number' && !Number.isFinite(value)) diagnostics.push({ severity: 'error', code: 'invalid-number', path, message: `Non-finite number at ${path}.` });
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) validateNumbers(entry, diagnostics, `${path}.${key}`);
}

/** Resolve nested Buffer references using the compiler's group node scope. */
export function bufferReferences(patch: Patch, prefix = ''): NonNullable<Patch['buffers']> {
  const references: NonNullable<Patch['buffers']> = {};
  for (const [nodeId, asset] of Object.entries(patch.buffers ?? {})) references[`${prefix}${nodeId}`] = { ...asset };
  for (const node of patch.nodes) if (node.type === 'Group' && node.subpatch) Object.assign(references, bufferReferences(node.subpatch, `${prefix}${node.id}__`));
  return references;
}

function isEmptyMidiPreference(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, entry]) =>
    (key === 'sendClock' && entry === false) ||
    ((key === 'selectedDeviceIds' || key === 'selectedOutputDeviceIds') && Array.isArray(entry) && entry.length === 0));
}

/** A duplicate is a new exposed identity; ordinary snapshots/undo keep IDs. */
export function cloneParameterIds<T extends { id: string; type: string | null; outputs?: import('../graph/types').PortDefinition[]; subpatch?: Patch }>(source: T, nextId: string): T {
  const node = structuredClone(source);
  node.id = nextId;
  if (node.type === 'Params') node.outputs = node.outputs?.map(port => ({ ...port, parameterId: `teia:${JSON.stringify([nextId, port.name])}` }));
  if (node.subpatch) {
    const clear = (patch: Patch) => {
      for (const inner of patch.nodes) {
        if (inner.type === 'Params') for (const port of inner.outputs ?? []) delete port.parameterId;
        if (inner.subpatch) clear(inner.subpatch);
      }
    };
    clear(node.subpatch);
    node.subpatch = withParameterIds(node.subpatch, [nextId]);
  }
  return node;
}

/** Keep host-owned nested durable references when rebuilding editor graph
 * presentations. Root Buffer references are supplied by the editor asset map. */
export function retainNestedBufferReferences(source: Patch, authoritative: Patch): Patch {
  const copy = structuredClone(source);
  for (const node of copy.nodes) if (node.subpatch) {
    const saved = authoritative.nodes.find(n => n.id === node.id)?.subpatch;
    if (!saved) continue;
    node.subpatch = retainNestedBufferReferences(node.subpatch, saved);
    if (saved.buffers) node.subpatch.buffers = structuredClone(saved.buffers); else delete node.subpatch.buffers;
  }
  return copy;
}
