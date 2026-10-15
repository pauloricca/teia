import { DSP_OP } from './dspOpcodes';
import type { DspOp, DspValueBinding } from './dspProgram';

export interface DspOptimizationOptions {
  deduplicateLoads?: boolean;
  foldConstants?: boolean;
  eliminateDeadPureOps?: boolean;
  analyzeSchedule?: boolean;
}

export interface DspOptimizationSnapshot {
  operations: number;
  registers: number;
  values: number;
  states: number;
  byOpcode: Record<string, number>;
  byTrait: Record<DspOperationTrait, number>;
}

export type DspOperationTrait = 'pure' | 'stateful' | 'event' | 'resource' | 'ordering barrier';

export interface DspOptimizationReport {
  beforeLoadDedup: DspOptimizationSnapshot;
  emitted: DspOptimizationSnapshot;
  afterConstantFolding: DspOptimizationSnapshot;
  final: DspOptimizationSnapshot;
  reasons: { deduplicatedLoads: number; constantArithmetic: number; unusedPure: number };
}

interface OptimizableProgram {
  ops: DspOp[];
  values: number[];
  valueBindings: DspValueBinding[];
  registerCount: number;
  stateCount: number;
  monitorIds: Record<string, number>;
  fftBindings: Array<{ inputRegister: number }>;
  deduplicatedLoads: number;
}

const OPCODE_NAMES = new Map<number, string>(Object.entries(DSP_OP).map(([name, code]) => [code, name]));

const PURE = new Set<number>([
  DSP_OP.Value, DSP_OP.Add, DSP_OP.Mul, DSP_OP.Sub, DSP_OP.Div,
  DSP_OP.Neg, DSP_OP.Abs, DSP_OP.Bend, DSP_OP.Function,
  DSP_OP.Map, DSP_OP.Fold, DSP_OP.HardClip, DSP_OP.SoftClip,
  DSP_OP.Quantise,
]);
const EVENT = new Set<number>([DSP_OP.MidiNoteSend, DSP_OP.MidiCcSend, DSP_OP.RollNoteEvent]);
const RESOURCE = new Set<number>([DSP_OP.Input, DSP_OP.Sample, DSP_OP.SampleParam, DSP_OP.Buffer, DSP_OP.Image]);
const STATEFUL = new Set<number>([
  DSP_OP.Osc, DSP_OP.Filter, DSP_OP.FeedbackRead, DSP_OP.FeedbackWrite,
  DSP_OP.Select, DSP_OP.Delay, DSP_OP.Chorus, DSP_OP.Reverb,
  DSP_OP.Envelope, DSP_OP.Follower, DSP_OP.Distortion,
  DSP_OP.Accumulator, DSP_OP.Button, DSP_OP.Slew, DSP_OP.Tempo,
  DSP_OP.Playhead, DSP_OP.Sequencer, DSP_OP.Time, DSP_OP.Compress,
  DSP_OP.Limiter, DSP_OP.BlockLatch, DSP_OP.Random, DSP_OP.DcBlock,
  DSP_OP.EndTrigger,
]);
const BINARY = new Set<number>([DSP_OP.Add, DSP_OP.Mul, DSP_OP.Sub, DSP_OP.Div, DSP_OP.Fold, DSP_OP.HardClip, DSP_OP.SoftClip]);
const UNARY = new Set<number>([DSP_OP.Neg, DSP_OP.Abs, DSP_OP.Bend]);
const DSP_REGISTER_COUNT = 4096;

function operationTrait(opcode: number): DspOperationTrait {
  if (PURE.has(opcode)) return 'pure';
  if (EVENT.has(opcode)) return 'event';
  if (RESOURCE.has(opcode)) return 'resource';
  if (STATEFUL.has(opcode)) return 'stateful';
  return 'ordering barrier';
}

function snapshot(program: OptimizableProgram): DspOptimizationSnapshot {
  const byOpcode: Record<string, number> = {};
  const byTrait: Record<DspOperationTrait, number> = {
    pure: 0, stateful: 0, event: 0, resource: 0, 'ordering barrier': 0,
  };
  for (const op of program.ops) {
    const name = OPCODE_NAMES.get(op.opcode) ?? `unknown ${op.opcode}`;
    byOpcode[name] = (byOpcode[name] ?? 0) + 1;
    byTrait[operationTrait(op.opcode)] += 1;
  }
  return {
    operations: program.ops.length,
    registers: program.registerCount,
    values: program.values.length,
    states: program.stateCount,
    byOpcode,
    byTrait,
  };
}

function inputs(op: DspOp): number[] {
  if (op.opcode === DSP_OP.Reverb) {
    return [op.a ?? -1, op.b ?? -1, op.c ?? -1, op.d ?? -1, (op.value2 ?? 0) - 1];
  }
  if (op.opcode === DSP_OP.Value) return [];
  if (BINARY.has(op.opcode)) return [op.a ?? -1, op.b ?? -1];
  if (UNARY.has(op.opcode)) return [op.a ?? -1];
  if (op.opcode === DSP_OP.Function) return [op.b ?? -1, op.c ?? -1, op.d ?? -1];
  if (op.opcode === DSP_OP.Map) return [op.a ?? -1, op.b ?? -1, op.c ?? -1, op.d ?? -1, op.e ?? -1];
  if (op.opcode === DSP_OP.Quantise) return [op.a ?? -1, op.b ?? -1, op.c ?? -1];
  if (op.opcode === DSP_OP.Envelope) {
    const packed = Math.round(op.value ?? 0);
    return [
      op.a ?? -1,
      op.b ?? -1,
      op.c ?? -1,
      op.d ?? -1,
      op.e ?? -1,
      packed % DSP_REGISTER_COUNT,
      Math.floor(packed / DSP_REGISTER_COUNT),
      Math.round(op.value2 ?? 0) - 1,
    ];
  }
  // Unknown operations are kept. Their numeric fields are conservatively
  // considered uses, including packed register references in value fields.
  return [op.a, op.b, op.c, op.d, op.e, op.out, op.value, op.value2, op.value3, op.value4]
    .filter((field): field is number => typeof field === 'number' && Number.isInteger(field));
}

function sanitizeRegister(value: number): number {
  return Number.isFinite(value) ? Math.min(12_000, Math.max(-12_000, value)) : 0;
}

export function simplifyDspOperations(
  program: OptimizableProgram,
  options: DspOptimizationOptions = {},
): DspOptimizationReport {
  const emitted = snapshot(program);
  const beforeLoadDedup = {
    ...emitted,
    operations: emitted.operations + program.deduplicatedLoads,
    registers: emitted.registers + program.deduplicatedLoads,
    byOpcode: { ...emitted.byOpcode, Value: (emitted.byOpcode.Value ?? 0) + program.deduplicatedLoads },
    byTrait: { ...emitted.byTrait, pure: emitted.byTrait.pure + program.deduplicatedLoads },
  };
  let constantArithmetic = 0;
  let unusedPure = 0;

  if (options.foldConstants !== false) {
    const constants = new Map<number, number>();
    const indexByValue = new Map<number, number>();
    program.valueBindings.forEach((binding) => {
      if (binding.kind === 'constant') indexByValue.set(program.values[binding.valueIndex], binding.valueIndex);
    });
    let repeatDepth = 0;
    for (const op of program.ops) {
      if (op.opcode === DSP_OP.SpreadBegin || op.opcode === DSP_OP.SpawnBegin) {
        repeatDepth += 1;
        constants.clear();
      }
      if (repeatDepth === 0 && op.opcode === DSP_OP.Value && op.out !== undefined && op.a !== undefined
        && program.valueBindings[op.a]?.kind === 'constant') {
        constants.set(op.out, sanitizeRegister(program.values[op.a]));
      } else if (repeatDepth === 0 && op.out !== undefined && op.a !== undefined && op.b !== undefined
        && (op.opcode === DSP_OP.Add || op.opcode === DSP_OP.Mul
          || op.opcode === DSP_OP.Sub || op.opcode === DSP_OP.Div)
        && constants.has(op.a) && constants.has(op.b)) {
        const left = constants.get(op.a)!;
        const right = constants.get(op.b)!;
        const result = sanitizeRegister(op.opcode === DSP_OP.Add ? left + right
          : op.opcode === DSP_OP.Mul ? left * right
            : op.opcode === DSP_OP.Sub ? left - right
              : Math.abs(right) <= 0.000001 ? 0 : left / right);
        // Preserve signed zero rather than turning it into a shared literal.
        if (!Object.is(result, -0)) {
          let index = indexByValue.get(result);
          if (index === undefined && program.values.length < 2048) {
            index = program.values.length;
            program.values.push(result);
            program.valueBindings.push({ id: `constant.${result}`, valueIndex: index, kind: 'constant' });
            indexByValue.set(result, index);
          }
          if (index !== undefined) {
            op.opcode = DSP_OP.Value;
            op.a = index;
            delete op.b;
            constants.set(op.out, result);
            constantArithmetic += 1;
          }
        }
      }
      if (op.opcode === DSP_OP.SpreadEnd || op.opcode === DSP_OP.SpawnEnd) {
        repeatDepth -= 1;
        constants.clear();
      }
    }
  }
  const afterConstantFolding = snapshot(program);

  if (options.eliminateDeadPureOps !== false) {
    const live = new Set<number>([
      ...Object.values(program.monitorIds),
      ...program.fftBindings.map((binding) => binding.inputRegister),
    ]);
    const keep = new Array<boolean>(program.ops.length).fill(true);
    let repeatDepth = 0;
    for (let index = program.ops.length - 1; index >= 0; index -= 1) {
      const op = program.ops[index];
      if (op.opcode === DSP_OP.SpreadEnd || op.opcode === DSP_OP.SpawnEnd) repeatDepth += 1;
      const pure = operationTrait(op.opcode) === 'pure' && repeatDepth === 0;
      if (pure && op.out !== undefined && !live.has(op.out)) {
        keep[index] = false;
        unusedPure += 1;
      } else {
        if (pure && op.out !== undefined) live.delete(op.out);
        for (const input of inputs(op)) if (input >= 0 && input < program.registerCount) live.add(input);
      }
      if (op.opcode === DSP_OP.SpreadBegin || op.opcode === DSP_OP.SpawnBegin) repeatDepth -= 1;
    }
    program.ops = program.ops.filter((_, index) => keep[index]);
  }

  return {
    beforeLoadDedup,
    emitted,
    afterConstantFolding,
    final: snapshot(program),
    reasons: { deduplicatedLoads: program.deduplicatedLoads, constantArithmetic, unusedPure },
  };
}
