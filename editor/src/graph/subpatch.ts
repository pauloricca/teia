import type { Patch, PatchLink, PatchNode } from './types';
import { normalizeCustomWave } from './customWave';

const GROUP_DEFAULT_NODE_PREFIX = '__group_default';
const GROUP_INPUT_PASS_NODE_PREFIX = '__group_input_pass';
const GROUP_OUTPUT_PASS_NODE_PREFIX = '__group_output_pass';

export function expandGroups(patch: Patch): Patch {
  const expanded = expandGroupNodes(patch, '');
  return {
    nodes: expanded.nodes,
    links: dedupePatchLinks(expanded.links),
  };
}

function expandGroupNodes(patch: Patch, prefix: string): Patch {
  const nodes: PatchNode[] = [];
  const links: PatchLink[] = [];

  for (const node of patch.nodes) {
    if (node.type !== 'Group' || !node.subpatch) {
      nodes.push(prefixNode(node, prefix));
      continue;
    }

    const groupPatch = expandGroupNodes(
      applySubpatchUiOverrides(node.subpatch, node.subpatchUiOverrides),
      `${prefix}${node.id}__`,
    );
    const insNodes = groupPatch.nodes.filter((candidate) => candidate.type === 'Ins');
    const outsNodes = groupPatch.nodes.filter((candidate) => candidate.type === 'Outs');
    const boundaryNodeIds = new Set([...insNodes, ...outsNodes].map((candidate) => candidate.id));
    const inputLinks = patch.links.filter((link) => link.to.node === node.id);
    const outputLinks = patch.links.filter((link) => link.from.node === node.id);
    const innerLinksByInput = groupBy(groupPatch.links, (link) => link.from.node, boundaryNodeIds, insNodes);
    const innerLinksByOutput = groupBy(groupPatch.links, (link) => link.to.node, boundaryNodeIds, outsNodes);
    const prefixedGroupId = `${prefix}${node.id}`;

    // Group nodes are expanded away before DSP compilation. Carry the Group's
    // disabled state onto every generated inner node so it remains a true
    // mute boundary rather than just disabling the now-removed wrapper.
    nodes.push(...groupPatch.nodes
      .filter((candidate) => !boundaryNodeIds.has(candidate.id))
      .map((candidate) => inheritGroupRuntime(node, node.enabled === false ? { ...candidate, enabled: false } : candidate)));
    nodes.push(...defaultNodesForUnconnectedGroupInputs(node, prefixedGroupId, inputLinks, innerLinksByInput, insNodes)
      .map((candidate) => inheritGroupRuntime(node, candidate)));
    nodes.push(...passNodesForGroupBoundary(node, prefixedGroupId, innerLinksByInput, insNodes, 'input')
      .map((candidate) => inheritGroupRuntime(node, candidate)));
    nodes.push(...passNodesForGroupBoundary(node, prefixedGroupId, innerLinksByOutput, outsNodes, 'output')
      .map((candidate) => inheritGroupRuntime(node, candidate)));
    links.push(...groupPatch.links.filter((link) => (
      !boundaryNodeIds.has(link.from.node) &&
      !boundaryNodeIds.has(link.to.node)
    )));

    for (const [port, innerLinks] of innerLinksByInput) {
      const externalLinks = inputLinks.filter((link) => link.to.port === port);
      if (externalLinks.length === 0) {
        const defaultNodeId = defaultNodeIdForGroupInput(prefixedGroupId, port);
        links.push({
          from: { node: defaultNodeId, port: 'signal' },
          to: { node: passNodeIdForGroupBoundary(prefixedGroupId, port, 'input'), port: 'signal' },
          weight: 1,
          mode: 'set',
        });
        links.push(...innerLinks.map((innerLink) => ({
          from: { node: passNodeIdForGroupBoundary(prefixedGroupId, port, 'input'), port: 'signal' },
          to: innerLink.to,
          weight: innerLink.weight,
          mode: innerLink.mode,
          enabled: innerLink.enabled,
          weightModulations: innerLink.weightModulations,
        })));
        continue;
      }

      for (const externalLink of externalLinks) {
        links.push({
          from: prefixEndpoint(externalLink.from, prefix),
          to: { node: passNodeIdForGroupBoundary(prefixedGroupId, port, 'input'), port: 'signal' },
          weight: externalLink.weight,
          mode: externalLink.mode,
          enabled: externalLink.enabled,
          weightModulations: prefixWeightModulations(externalLink, prefix),
        });
      }
      links.push(...innerLinks.map((innerLink) => ({
        from: { node: passNodeIdForGroupBoundary(prefixedGroupId, port, 'input'), port: 'signal' },
        to: innerLink.to,
        weight: innerLink.weight,
        mode: innerLink.mode,
        enabled: innerLink.enabled,
        weightModulations: innerLink.weightModulations,
      })));
    }

    for (const [port, innerLinks] of innerLinksByOutput) {
      const externalLinks = outputLinks.filter((link) => link.from.port === port);
      for (const innerLink of innerLinks) {
        links.push({
          from: innerLink.from,
          to: { node: passNodeIdForGroupBoundary(prefixedGroupId, port, 'output'), port: 'signal' },
          weight: innerLink.weight,
          mode: innerLink.mode,
          enabled: innerLink.enabled,
          weightModulations: innerLink.weightModulations,
        });
      }
      for (const externalLink of externalLinks) {
        links.push({
          from: { node: passNodeIdForGroupBoundary(prefixedGroupId, port, 'output'), port: 'signal' },
          to: prefixEndpoint(externalLink.to, prefix),
          weight: externalLink.weight,
          mode: externalLink.mode,
          enabled: externalLink.enabled,
          weightModulations: prefixWeightModulations(externalLink, prefix),
        });
      }
    }
  }

  for (const link of patch.links) {
    const source = patch.nodes.find((node) => node.id === link.from.node);
    const target = patch.nodes.find((node) => node.id === link.to.node);
    if (source?.type === 'Group' || target?.type === 'Group') continue;

    links.push({
      from: prefixEndpoint(link.from, prefix),
      to: prefixEndpoint(link.to, prefix),
      weight: link.weight,
      mode: link.mode,
      enabled: link.enabled,
      weightModulations: prefixWeightModulations(link, prefix),
    });
  }

  return { nodes, links };
}

function inheritGroupRuntime(group: PatchNode, descendant: PatchNode): PatchNode {
  if (!group.runtimeSpread) return descendant;
  return {
    ...descendant,
    runtimeSpread: {
      ...group.runtimeSpread,
      originalNodeId: descendant.id,
    },
  };
}

function passNodesForGroupBoundary(
  groupNode: PatchNode,
  prefixedGroupId: string,
  innerLinksByPort: Map<string, PatchLink[]>,
  boundaryNodes: PatchNode[],
  side: 'input' | 'output',
): PatchNode[] {
  return [...innerLinksByPort.keys()].map((port) => ({
    id: passNodeIdForGroupBoundary(prefixedGroupId, port, side),
    type: 'Pass',
    params: {
      signal: side === 'input'
        ? groupNode.params[port] ?? boundaryPortDefaultValue(boundaryNodes, port)
        : boundaryPortDefaultValue(boundaryNodes, port),
    },
    position: groupNode.position,
    ...(groupNode.enabled === false ? { enabled: false } : {}),
  }));
}

function boundaryPortDefaultValue(boundaryNodes: PatchNode[], port: string): number {
  for (const node of boundaryNodes) {
    const definition = [...(node.inputs ?? []), ...(node.outputs ?? [])].find((candidate) => candidate.name === port);
    if (definition) return node.params[port] ?? definition.defaultValue ?? 0;
  }
  return 0;
}

function defaultNodesForUnconnectedGroupInputs(
  groupNode: PatchNode,
  prefixedGroupId: string,
  inputLinks: PatchLink[],
  innerLinksByInput: Map<string, PatchLink[]>,
  insNodes: PatchNode[],
): PatchNode[] {
  const defaultValueByPort = new Map<string, number>();
  for (const node of insNodes) {
    for (const port of node.outputs ?? []) {
      defaultValueByPort.set(port.name, node.params[port.name] ?? port.defaultValue ?? 0);
    }
  }

  return [...innerLinksByInput]
    .filter(([port]) => !inputLinks.some((link) => link.to.port === port))
    .map(([port]) => ({
      id: defaultNodeIdForGroupInput(prefixedGroupId, port),
      type: 'Constant',
      params: { value: groupNode.params[port] ?? defaultValueByPort.get(port) ?? 0 },
      position: groupNode.position,
      ...(groupNode.enabled === false ? { enabled: false } : {}),
    }));
}

function groupBy(
  links: PatchLink[],
  boundarySelector: (link: PatchLink) => string,
  boundaryNodeIds: Set<string>,
  boundaryNodes: PatchNode[],
): Map<string, PatchLink[]> {
  const boundaryPorts = new Map<string, Set<string>>();
  for (const node of boundaryNodes) {
    const ports = new Set([...(node.inputs ?? []), ...(node.outputs ?? [])].map((port) => port.name));
    boundaryPorts.set(node.id, ports);
  }

  const grouped = new Map<string, PatchLink[]>();
  for (const link of links) {
    const boundaryNode = boundarySelector(link);
    if (!boundaryNodeIds.has(boundaryNode)) continue;

    const port = link.from.node === boundaryNode ? link.from.port : link.to.port;
    if (!boundaryPorts.get(boundaryNode)?.has(port)) continue;

    grouped.set(port, [...(grouped.get(port) ?? []), link]);
  }

  return grouped;
}

function prefixNode(node: PatchNode, prefix: string): PatchNode {
  const cloned = cloneNode(node);
  if (node.type === 'Send' || node.type === 'Receive') {
    cloned.routingScope = prefix;
  }
  if (!prefix) return cloned;

  return {
    ...cloned,
    id: `${prefix}${node.id}`,
    ...(cloned.spreadNodeIds ? { spreadNodeIds: cloned.spreadNodeIds.map(id => `${prefix}${id}`) } : {}),
    ...(cloned.runtimeSpread ? { runtimeSpread: { ...cloned.runtimeSpread, spreadId: `${prefix}${cloned.runtimeSpread.spreadId}` } } : {}),
  };
}

function cloneNode(node: PatchNode): PatchNode {
  return {
    id: node.id,
    type: node.type,
    ...(node.customLabel ? { customLabel: node.customLabel } : {}),
    ...(node.sequencerRowLabels ? { sequencerRowLabels: [...node.sequencerRowLabels] } : {}),
    ...(node.sequencerRowLabelColumnWidth !== undefined ? { sequencerRowLabelColumnWidth: node.sequencerRowLabelColumnWidth } : {}),
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
    ...(node.spreadNodeIds ? { spreadNodeIds: [...node.spreadNodeIds] } : {}),
    ...(node.runtimeSpread ? { runtimeSpread: { ...node.runtimeSpread } } : {}),
  };
}

function applySubpatchUiOverrides(
  patch: Patch,
  overrides: PatchNode['subpatchUiOverrides'],
): Patch {
  if (!overrides) return patch;

  return {
    ...patch,
    nodes: patch.nodes.map((node) => {
      const override = overrides[node.id];
      if (!override) return node;
      const params = { ...node.params, ...override.params };
      return {
        ...node,
        params,
        ...(override.customWave ? { customWave: normalizeCustomWave(override.customWave, params) } : {}),
      };
    }),
  };
}

function clonePatch(patch: Patch): Patch {
  return {
    ...(patch.areas ? { areas: structuredClone(patch.areas) } : {}),
    nodes: patch.nodes.map(cloneNode),
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

function prefixEndpoint(endpoint: PatchLink['from'], prefix: string): PatchLink['from'] {
  return {
    node: `${prefix}${endpoint.node}`,
    port: endpoint.port,
  };
}

function prefixWeightModulations(link: PatchLink, prefix: string): PatchLink['weightModulations'] {
  const prefixModulation = (modulation: NonNullable<PatchLink['weightModulations']>[number]): typeof modulation => ({
    ...modulation,
    from: prefixEndpoint(modulation.from, prefix),
    weightModulations: modulation.weightModulations?.map(prefixModulation),
  });
  return link.weightModulations?.map(prefixModulation);
}

function defaultNodeIdForGroupInput(groupId: string, port: string): string {
  return `${GROUP_DEFAULT_NODE_PREFIX}_${groupId}_${port}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

function passNodeIdForGroupBoundary(groupId: string, port: string, side: 'input' | 'output'): string {
  const prefix = side === 'input' ? GROUP_INPUT_PASS_NODE_PREFIX : GROUP_OUTPUT_PASS_NODE_PREFIX;
  return `${prefix}_${groupId}_${port}`.replace(/[^A-Za-z0-9_-]/g, '_');
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
