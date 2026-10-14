import { fm1Capabilities as support } from './fm1Capabilities';
import { getNodeTypeLabel } from '../graph/nodeTypes';
import type { Patch } from '../graph/types';

export const fm1SupportFirmware = support.firmware;

export interface Fm1SupportWarning {
  feature: string;
  status: 'unsupported' | 'partial' | 'unknown';
  notes: string;
  nodes: string[];
}

function describeFeature(feature: { notes: string; drift?: { webBehavior: string; firmwareBehavior: string; requiredWork: string } }): string {
  const drift = feature.drift;
  return feature.notes + (drift ? ` Web: ${drift.webBehavior} Firmware: ${drift.firmwareBehavior} Catch-up: ${drift.requiredWork}` : '');
}

/** Frontend inventory and export policy share the same feature statuses. */
export function getFm1SupportWarnings(patch: Patch): Fm1SupportWarning[] {
  const features = new Map(support.features.filter(feature => feature.category === 'node')
    .map(feature => [feature.id, feature]));
  const warnings = new Map<string, Fm1SupportWarning>();
  const visit = (current: Patch, parents: string[]) => {
    for (const node of current.nodes) {
      if (node.enabled === false) continue;
      const label = node.customLabel || node.subpatchName || getNodeTypeLabel(node.type);
      const path = [...parents, `${label} (${node.id})`];
      const feature = features.get(node.type);
      if (feature?.status !== 'supported') {
        const status = feature?.status;
        let warning = warnings.get(node.type);
        if (!warning) {
          warning = {
            feature: getNodeTypeLabel(node.type),
            status: status === 'unsupported' || status === 'partial' ? status : 'unknown',
            notes: feature ? describeFeature(feature) : 'FM-1 support has not been reviewed for this node.',
            nodes: [],
          };
          warnings.set(node.type, warning);
        }
        warning.nodes.push(path.join(' → '));
      }
      if (node.type === 'Group' && node.subpatch) visit(node.subpatch, path);
    }
  };
  visit(patch, []);
  const order = { unsupported: 0, partial: 1, unknown: 2 };
  return [...warnings.values()].sort((a, b) => order[a.status] - order[b.status]
    || a.feature.localeCompare(b.feature));
}

/** Fail closed for enabled nodes, including unused nodes and group contents. */
export function getFm1SupportErrors(patch: Patch): string[] {
  const errors = getFm1SupportWarnings(patch)
    .filter(warning => warning.status === 'unsupported' || warning.status === 'unknown')
    .map(warning => `${warning.nodes.join('; ')}: ${warning.status === 'unknown' ? 'FM-1 support needs review' : 'not supported on FM-1'}. ${warning.notes}`);
  const features = new Map(support.features.filter(feature => feature.category === 'node').map(feature => [feature.id, feature]));
  let delays = 0;
  const visit = (current: Patch, parent: string) => {
    const enabled = new Map(current.nodes.filter(node => node.enabled !== false).map(node => [node.id, node]));
    const checkOutput = (endpoint: { node: string; port: string }) => {
      const node = enabled.get(endpoint.node);
      const feature = node && features.get(node.type);
      if (feature && 'blockedOutputs' in feature && feature.blockedOutputs?.some(port => port === endpoint.port)) {
        errors.push(`${parent}${endpoint.node}: output "${endpoint.port}" is not supported on FM-1. ${feature.notes}`);
      }
    };
    const checkModulations = (links: NonNullable<Patch['links'][number]['weightModulations']>) => {
      for (const link of links) {
        if (link.enabled === false) continue;
        checkOutput(link.from);
        if (link.weightModulations) checkModulations(link.weightModulations);
      }
    };
    for (const link of current.links) {
      if (link.enabled === false || !enabled.has(link.from.node) || !enabled.has(link.to.node)) continue;
      checkOutput(link.from);
      const node = enabled.get(link.to.node)!;
      const feature = features.get(node.type);
      if (feature && 'blockedInputs' in feature && feature.blockedInputs?.some(port => port === link.to.port)) {
        errors.push(`${parent}${node.id}: input "${link.to.port}" is not supported on FM-1. ${feature.notes}`);
      }
      if (link.weightModulations) checkModulations(link.weightModulations);
    }
    for (const node of enabled.values()) {
      if (node.type === 'Delay' && ++delays > support.compiler.delay.maxNodes) {
        errors.push(`FM-1 supports at most ${support.compiler.delay.maxNodes} Delay nodes per patch, including group contents.`);
      }
      if (node.type === 'Group' && node.subpatch) visit(node.subpatch, `${parent}${node.id} → `);
    }
  };
  visit(patch, '');
  return [...new Set(errors)];
}

/** Node availability for FM1 mode; partial implementations retain compiler restrictions. */
export function isFm1NodeImplemented(type: string): boolean {
  const feature = support.features.find(feature => feature.category === 'node' && feature.id === type);
  return feature?.status === 'supported' || feature?.status === 'partial';
}
