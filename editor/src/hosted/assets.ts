import type { PreparedPatch } from './compiler';
export interface AssetRequest { kind: 'sample' | 'image' | 'buffer'; nodeId: string; reference: string }
export type PreparedAsset =
  | { kind: 'sample' | 'buffer'; sampleRate: number; channels: readonly Float32Array[] }
  | { kind: 'image'; width: number; height: number; rgba: Uint8Array };
export type AssetResolver = (request: AssetRequest, signal?: AbortSignal) => Promise<PreparedAsset>;
/** Runs only during preparation. Resolver owns decoding, locations and integrity.
 * No implicit fetch, filesystem or browser Buffer storage fallback exists. */
export async function prepareAssets(prepared: PreparedPatch, resolve: AssetResolver, signal?: AbortSignal): Promise<ReadonlyMap<string, PreparedAsset>> {
  const requests: AssetRequest[] = [
    ...prepared.requirements.samples.map(b => ({ kind: 'sample' as const, nodeId: b.nodeId, reference: b.sample.url })),
    ...prepared.requirements.images.map(b => ({ kind: 'image' as const, nodeId: b.nodeId, reference: b.image.url })),
    ...Object.entries(prepared.requirements.buffers ?? {}).map(([nodeId, b]) => ({ kind: 'buffer' as const, nodeId, reference: b.hash })),
  ];
  const assets = new Map<string, PreparedAsset>();
  let bytes = 0;
  for (const request of requests) {
    signal?.throwIfAborted();
    const asset = await resolve(request, signal);
    signal?.throwIfAborted();
    if (asset.kind !== request.kind) throw new Error(`Asset kind mismatch for ${request.nodeId}.`);
    if (asset.kind === 'image') {
      if (!Number.isSafeInteger(asset.width) || !Number.isSafeInteger(asset.height) || asset.width < 1 || asset.height < 1 || asset.width > 1024 || asset.height > 1024 || asset.rgba.byteLength !== asset.width * asset.height * 4) throw new Error('Invalid prepared image.');
      bytes += asset.rgba.byteLength;
    } else {
      if (!Number.isFinite(asset.sampleRate) || asset.sampleRate <= 0 || asset.channels.length !== 1 || asset.channels[0].length < 1 || asset.channels[0].length > (asset.kind === 'buffer' ? 960000 : 32 * 1024 * 1024) || asset.channels[0].some(v => !Number.isFinite(v))) throw new Error('Invalid prepared mono media.');
      bytes += asset.channels[0].byteLength;
    }
    if (bytes > 512 * 1024 * 1024) throw new Error('Prepared assets exceed the 512 MiB preparation budget.');
    assets.set(`${request.kind}:${request.nodeId}`, asset);
  }
  return assets;
}
