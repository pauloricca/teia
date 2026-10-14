import { fm1Delay, fm1FunctionArity } from './fm1Capabilities';

const Q = 65536;
const BOUND = 12000 * Q;
const pure = new Set([0, 1, 2, 21, 22, 23, 24, 32, 33, 34, 35, 36, 38, 41, 46, 47, 48]);
const hasOutput = (op: number[]) => op[0] !== 5 && op[0] !== 43;

// These are register operands, not value indices, state slots or mode literals.
function inputs(op: number[]): number[] {
  switch (op[0]) {
    case 0: case 42: case 54: return [];
    case 1: case 3: case 5: case 24: case 32: case 37: case 41: case 43: return [2];
    case 2: case 21: case 22: case 23: case 28: case 33: case 34: case 35: case 36: case 47: case 50: return [2, 3];
    case 19: case 20: case 27: case 29: case 30: case 31: case 45: case 48: return [2, 3, 4];
    case 25: return [2, 3, 4, ...[6, 7, 8].filter(i => op[i] >= 0), ...(op[9] === 12 ? [10] : [])];
    case 26: return [2, 3, 4, 6, 7, 8, 9, 10];
    case 38: return [2, ...(fm1FunctionArity(op[6])! >= 2 ? [3] : []), ...(fm1FunctionArity(op[6]) === 3 ? [4] : [])];
    case 39: case 46: return [2, 3, 4, 6, 7];
    case 40: return [2, 3, ...(op[4] >= 0 ? [4] : [])];
    case fm1Delay.legacyInstruction: case fm1Delay.instruction: return [2, 3, 4, 6];
    case 49: return [2, 4];
    case 51: return [2, 3, 4, 6, 7, 8];
    case 52: case 55: return [3];
    default: throw new Error(`Missing FM-1 optimizer operand description: ${op[0]}`);
  }
}

/** Optimize quantized instructions only. Never reassociate arithmetic or move stateful work. */
export function optimizeFm1Ops(source: number[][], values: number[], mutableValues: Set<number>, maximumValues: number) {
  const assigned = new Set<number>();
  for (const op of source) {
    inputs(op); // Fail closed when a new instruction needs review.
    if (hasOutput(op)) {
      if (assigned.has(op[1])) return source; // Aliasing/CSE requires single assignment.
      assigned.add(op[1]);
    }
  }
  const bound = (n: bigint) => Number(n < -BigInt(BOUND) ? -BigInt(BOUND) : n > BigInt(BOUND) ? BigInt(BOUND) : n);
  const known = new Map<number, number>();
  const bounded = new Set<number>();
  const aliases = new Map<number, number>();
  const expressions = new Map<string, number>();
  const constants = new Map<number, number>();
  values.forEach((v, i) => { if (!mutableValues.has(i)) constants.set(Math.max(-BOUND, Math.min(BOUND, v)), i); });
  const result: number[][] = [];
  for (const original of source) {
    let op = [...original];
    for (const i of inputs(op)) op[i] = aliases.get(op[i]) ?? op[i];
    const out = op[1], code = op[0], a = known.get(op[2]), b = known.get(op[3]);
    let folded: number | undefined;
    if (code === 0 && !mutableValues.has(op[2])) folded = Math.max(-BOUND, Math.min(BOUND, values[op[2]]));
    if (a !== undefined) {
      if (code === 1) folded = bound(BigInt(a));
      if (code === 41 && a === 0) folded = Q;
      if (code === 24) folded = Math.min(2147483647, -a);
      if (code === 32) folded = Math.min(2147483647, Math.abs(a));
      if (b !== undefined) {
        if (code === 2) folded = bound((BigInt(a) * BigInt(b)) >> 16n);
        if (code === 21) folded = bound(BigInt(a) + BigInt(b));
        if (code === 22) folded = bound(BigInt(a) - BigInt(b));
        if (code === 23) folded = b === 0 ? 0 : bound((BigInt(a) << 16n) / BigInt(b));
      }
    }
    if (code === 2 && (a === 0 || b === 0)) folded = 0;
    if (folded !== undefined) {
      known.set(out, folded);
      // Value loads clip: never materialize an out-of-bound raw node result.
      if (Math.abs(folded) <= BOUND) {
        let index = constants.get(folded);
        if (index === undefined && values.length < maximumValues) {
          index = values.length; values.push(folded); constants.set(folded, index);
        }
        if (index !== undefined) op = [0, out, index, 0, 0, 0];
      }
    }
    let identity: number | undefined;
    if (code === 1 || ((code === 21 || code === 22) && b === 0) || ((code === 2 || code === 23) && b === Q)) identity = op[2];
    if ((code === 21 && a === 0) || (code === 2 && a === Q)) identity = op[3];
    // Keep the arithmetic boundary when its input might exceed +/-12000.
    if (op[0] !== 0 && identity !== undefined && bounded.has(identity)) {
      aliases.set(out, identity); continue;
    }
    if ([0, 1, 2, 21, 22, 23, 41].includes(op[0]) || (folded !== undefined && Math.abs(folded) <= BOUND)) bounded.add(out);
    if (pure.has(op[0])) {
      const key = [op[0], ...op.slice(2), ...Array(Math.max(0, 12 - op.length)).fill(0)].join(',');
      const existing = expressions.get(key);
      if (existing !== undefined) { aliases.set(out, existing); continue; }
      expressions.set(key, out);
    }
    result.push(op);
  }
  // Preserve even unused stateful producers: their state and execution order are observable.
  const needed = new Set<number>();
  return [...result].reverse().filter(op => {
    if (pure.has(op[0]) && !needed.has(op[1])) return false;
    for (const i of inputs(op)) needed.add(op[i]);
    return true;
  }).reverse();
}
