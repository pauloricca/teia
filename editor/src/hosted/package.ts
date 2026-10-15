import type { Patch } from '../graph/types';
import { createPatchPackage, type PortableAssetAdapters } from '../audio/patchPackage';
/** Hosted export always requires explicit asset sources. XP v2 legacy IDs are
 * retained; persistentId is additive parameterIdentityVersion 1 metadata. */
export function createHostedPatchPackage(patch: Patch, assets: PortableAssetAdapters): Promise<Blob> {
  if (!assets?.readMedia || !assets?.readBuffer) throw new Error('Hosted packaging requires media and Buffer adapters.');
  return createPatchPackage(patch, undefined, assets);
}
