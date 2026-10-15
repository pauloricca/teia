import type { ParameterMetadata, PreparedPatch } from './compiler';
export function normalizeParameterValue(parameter: ParameterMetadata, value: number): number {
  let bounded = Math.max(parameter.min, Math.min(parameter.max, value));
  if (parameter.integer) bounded = Math.round(bounded);
  else if (parameter.step && parameter.step > 0) bounded = parameter.min + Math.round((bounded - parameter.min) / parameter.step) * parameter.step;
  return Math.max(parameter.min, Math.min(parameter.max, bounded));
}
/** Optional host utility. Overrides belong to the instance, never the patch document. */
export class ParameterOverrides {
  private values = new Map<string, number>();
  set(prepared: PreparedPatch, id: string, value: number): void {
    const parameter = prepared.parameters.find(p => p.id === id);
    if (!parameter || !Number.isFinite(value)) throw new Error('Unknown parameter or invalid value.');
    this.values.set(id, normalizeParameterValue(parameter, value));
  }
  clear(id: string): void { this.values.delete(id); }
  /** Rebind only by persistent ID when a new program is installed. */
  bind(prepared: PreparedPatch): { valueIndex: number; value: number }[] {
    return prepared.parameters.flatMap(p => {
      if (!this.values.has(p.id)) return [];
      const value = normalizeParameterValue(p, this.values.get(p.id)!);
      this.values.set(p.id, value);
      return [{ valueIndex: p.binding.valueIndex, value }];
    });
  }
  filterDefaults(prepared: PreparedPatch, updates: { valueIndex: number; value: number }[]): { valueIndex: number; value: number }[] {
    const overridden = new Set(this.bind(prepared).map(b => b.valueIndex));
    return updates.filter(u => !overridden.has(u.valueIndex));
  }
}
