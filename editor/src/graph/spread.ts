import type { Patch, PatchLink, PatchNode } from './types';

export const DEFAULT_SPREAD_SIZE = { width: 320, height: 220 } as const;
export const DEFAULT_SPAWN_SIZE = { width: 480, height: 220 } as const;
export const MIN_RUNTIME_CONTAINER_WIDTH = 240;
export const MIN_SPAWN_WIDTH = 480;
export const SPREAD_HEADER_HEIGHT = 32;
export const SPREAD_PORTS_HEIGHT = 44;
export const SPAWN_PORTS_HEIGHT = 72;

export interface SpreadExpansion {
  patch: Patch;
  errors: string[];
}

export function expandSpreads(patch: Patch): SpreadExpansion {
  const errors: string[] = [];
  patch = { ...patch, nodes: patch.nodes.map(node => {
    if (node.type !== 'Group' || !node.subpatch) return node;
    const inner = expandSpreads(node.subpatch);
    errors.push(...inner.errors.map(error => `Group "${node.id}": ${error}`));
    return { ...node, subpatch: inner.patch };
  }) };
  let expanded = patch;
  const spreads = patch.nodes.filter(isRuntimeContainer);
  const memberships = new Map<string, string[]>();

  for (const spread of spreads) {
    for (const node of patch.nodes) {
      if (!nodeIsInsideSpread(spread, node)) continue;
      memberships.set(node.id, [...(memberships.get(node.id) ?? []), spread.id]);
    }
  }
  for (const [nodeId, spreadIds] of memberships) {
    if (spreadIds.length > 1) {
      errors.push(`Node "${nodeId}" is inside multiple execution containers (${spreadIds.join(', ')}). Move it into exactly one container.`);
    }
  }
  if (errors.length > 0) return { patch, errors };

  for (const spread of spreads) {
    const result = expandOneSpread(expanded, spread.id);
    expanded = result.patch;
    errors.push(...result.errors);
  }

  return { patch: expanded, errors };
}

export function nodeIsInsideSpread(spread: PatchNode, node: PatchNode): boolean {
  if (!isRuntimeContainer(spread) || node.id === spread.id) return false;
  if (spread.spreadNodeIds) return spread.spreadNodeIds.includes(node.id);
  if (!spread.position || !node.position) return false;
  const size = runtimeContainerSize(spread);
  const portsHeight = runtimeContainerPortsHeight(spread);
  return (
    node.position.x >= spread.position.x
    && node.position.x < spread.position.x + size.width
    && node.position.y >= spread.position.y + SPREAD_HEADER_HEIGHT + portsHeight
    && node.position.y < spread.position.y + SPREAD_HEADER_HEIGHT + size.height
  );
}

export function runtimeContainerSize(node: {
  type: PatchNode['type'] | null;
  scopeSize?: PatchNode['scopeSize'];
}): { width: number; height: number } {
  const fallback = node.type === 'Spawn' ? DEFAULT_SPAWN_SIZE : DEFAULT_SPREAD_SIZE;
  const size = node.scopeSize ?? fallback;
  return {
    width: Math.max(node.type === 'Spawn' ? MIN_SPAWN_WIDTH : MIN_RUNTIME_CONTAINER_WIDTH, size.width),
    height: Math.max(140, size.height),
  };
}

export function runtimeContainerPortsHeight(node: { type: PatchNode['type'] | null }): number {
  return node.type === 'Spawn' ? SPAWN_PORTS_HEIGHT : SPREAD_PORTS_HEIGHT;
}

function expandOneSpread(patch: Patch, spreadId: string): SpreadExpansion {
  const spread = patch.nodes.find((node) => node.id === spreadId && isRuntimeContainer(node));
  if (!spread) return { patch, errors: [] };

  const internalNodes = patch.nodes.filter((node) => nodeIsInsideSpread(spread, node));
  const internalIds = new Set(internalNodes.map((node) => node.id));
  const errors: string[] = [];

  for (const node of internalNodes) {
    if (isRuntimeContainer(node)) {
      errors.push(`${spread.type} "${spread.id}" cannot contain ${node.type} "${node.id}".`);
    } else if (node.type === 'Group' && node.subpatch) {
      const unsupported = nestedRuntimeContainer(node.subpatch);
      if (unsupported) {
        errors.push(`${spread.type} "${spread.id}" cannot contain Group "${node.id}" with ${unsupported} inside it.`);
      }
    }
  }

  const clonedNodes: PatchNode[] = [];
  for (const node of internalNodes) {
    if (isRuntimeContainer(node)) continue;
    clonedNodes.push(cloneSpreadNode(spread.type === 'ConditionalExecution' && spread.enabled === false ? { ...node, enabled: false } : node, spread.id, 0, spread.type === 'ConditionalExecution'));
  }
  if (spread.type === 'Spread') {
    clonedNodes.push({
      id: spreadIndexNodeId(spread.id, 0),
      type: 'Constant',
      params: { value: 1 },
      runtimeSpread: { spreadId: spread.id, itemIndex: 0, originalNodeId: '__item_index__' },
    });
  } else if (spread.type === 'Spawn') {
    clonedNodes.push({
      id: spawnInstanceGateNodeId(spread.id, 0),
      type: 'Constant',
      params: { value: 1 },
      runtimeSpread: { spreadId: spread.id, itemIndex: 0, originalNodeId: '__instance_gate__' },
    });
  }

  const links: PatchLink[] = [];
  for (const link of patch.links) {
    const sourceInternal = internalIds.has(link.from.node);
    const targetInternal = internalIds.has(link.to.node);
    const isIndexLink = spread.type === 'Spread' && link.from.node === spread.id && link.from.port === 'item index';
    const isInstanceGateLink = spread.type === 'Spawn' && link.from.node === spread.id && link.from.port === 'instance gate';
    const isInternalControlLink = sourceInternal
      && link.to.node === spread.id
      && (
        link.to.port === (spread.type === 'Spread' ? 'count' : spread.type === 'ConditionalExecution' ? 'gate' : 'trigger')
        || (spread.type === 'Spawn' && link.to.port === 'release trigger')
      );
    const isKillLink = spread.type === 'Spawn' && link.to.node === spread.id && link.to.port === 'kill trigger';

    if (isIndexLink && !targetInternal) {
      errors.push(`Spread "${spread.id}" item index can only link to nodes inside that Spread.`);
      continue;
    }
    if (isInstanceGateLink && !targetInternal) {
      errors.push(`Spawn "${spread.id}" instance gate can only link to nodes inside that Spawn.`);
      continue;
    }
    if (isInternalControlLink) {
      errors.push(`${spread.type} "${spread.id}" ${link.to.port} cannot be driven by a node inside the same ${spread.type}.`);
      continue;
    }
    if (isKillLink && !sourceInternal) {
      errors.push(`Spawn "${spread.id}" kill trigger can only be driven by a node inside that Spawn.`);
      continue;
    }

    if (isIndexLink) {
      links.push({
        ...cloneLink(link, spread.id, internalIds),
        from: { node: spreadIndexNodeId(spread.id, 0), port: 'signal' },
        to: { ...link.to, node: spreadCloneNodeId(spread.id, 0, link.to.node) },
      });
      continue;
    }
    if (isInstanceGateLink) {
      links.push({
        ...cloneLink(link, spread.id, internalIds),
        from: { node: spawnInstanceGateNodeId(spread.id, 0), port: 'signal' },
        to: { ...link.to, node: spreadCloneNodeId(spread.id, 0, link.to.node) },
      });
      continue;
    }

    if (!sourceInternal && !targetInternal) {
      links.push(cloneLink(link, spread.id, internalIds));
      continue;
    }

    links.push({
      ...cloneLink(link, spread.id, internalIds),
      from: sourceInternal
        ? { ...link.from, node: spreadCloneNodeId(spread.id, 0, link.from.node) }
        : { ...link.from },
      to: targetInternal
        ? { ...link.to, node: spreadCloneNodeId(spread.id, 0, link.to.node) }
        : { ...link.to },
    });
  }

  return {
    patch: {
      ...patch,
      nodes: [
        ...patch.nodes.filter((node) => !internalIds.has(node.id)),
        ...clonedNodes,
      ],
      links,
    },
    errors,
  };
}

function nestedRuntimeContainer(patch: Patch): string | null {
  for (const node of patch.nodes) {
    if (isRuntimeContainer(node)) return node.type;
    if (node.type === 'Group' && node.subpatch) {
      const nested = nestedRuntimeContainer(node.subpatch);
      if (nested) return nested;
    }
  }
  return null;
}

function isRuntimeContainer(node: PatchNode): boolean {
  return node.type === 'Spread' || node.type === 'Spawn' || node.type === 'ConditionalExecution';
}

function cloneSpreadNode(node: PatchNode, spreadId: string, itemIndex: number, conditional = false): PatchNode {
  return {
    ...node,
    id: spreadCloneNodeId(spreadId, itemIndex, node.id),
    params: { ...node.params },
    ...(node.inputs ? { inputs: node.inputs.map((port) => ({ ...port })) } : {}),
    ...(node.outputs ? { outputs: node.outputs.map((port) => ({ ...port })) } : {}),
    ...(node.subpatchUiOverrides ? { subpatchUiOverrides: structuredClone(node.subpatchUiOverrides) } : {}),
    ...(node.subpatch ? { subpatch: structuredClone(node.subpatch) } : {}),
    runtimeSpread: { spreadId, itemIndex, originalNodeId: node.id, ...(conditional ? { conditional: true } : {}) },
  };
}

function cloneLink(link: PatchLink, spreadId: string, internalIds: Set<string>): PatchLink {
  const cloneModulation = (modulation: NonNullable<PatchLink['weightModulations']>[number]): typeof modulation => ({
    ...modulation,
    from: {
      ...modulation.from,
      port: modulation.from.node === spreadId && ['item index', 'instance gate'].includes(modulation.from.port)
        ? 'signal'
        : modulation.from.port,
      node: modulation.from.node === spreadId && modulation.from.port === 'item index'
        ? spreadIndexNodeId(spreadId, 0)
        : modulation.from.node === spreadId && modulation.from.port === 'instance gate'
          ? spawnInstanceGateNodeId(spreadId, 0)
          : internalIds.has(modulation.from.node)
            ? spreadCloneNodeId(spreadId, 0, modulation.from.node)
            : modulation.from.node,
    },
    weightModulations: modulation.weightModulations?.map(cloneModulation),
  });
  return {
    from: { ...link.from },
    to: { ...link.to },
    ...(link.weight !== undefined ? { weight: link.weight } : {}),
    ...(link.mode !== undefined ? { mode: link.mode } : {}),
    ...(link.enabled === false ? { enabled: false } : {}),
    ...(link.weightModulations?.length ? { weightModulations: link.weightModulations.map(cloneModulation) } : {}),
  };
}

export function spreadCloneNodeId(spreadId: string, itemIndex: number, nodeId: string): string {
  return `${spreadId}__item_${itemIndex}__${nodeId}`;
}

function spreadIndexNodeId(spreadId: string, itemIndex: number): string {
  return `${spreadId}__item_${itemIndex}__index`;
}

function spawnInstanceGateNodeId(spreadId: string, itemIndex: number): string {
  return `${spreadId}__item_${itemIndex}__instance_gate`;
}
