import support from '../../../firmware/fm1/support.json';

/** Shared capability contract. DSP implementations stay in their respective backends. */
export const fm1Capabilities = support;
export const fm1Limits = support.limits;
export const fm1Delay = support.compiler.delay;
export const fm1SupportFirmware = support.firmware;
export const fm1FilterModes: Readonly<Record<number, number>> = support.compiler.filterModes;
export const fm1DistortionModes: Readonly<Record<number, number>> = support.compiler.distortionModes;
export function fm1FunctionArity(id: number): number {
  return support.compiler.functions.find(fn => fn.id === id)?.arity ?? 0;
}

/** Capability preflight, not a replacement for the device's operand/state validator. */
export function inspectFm1Package(bytes: Uint8Array): { version: number; requiredFirmware: number } {
  const invalid = (reason: string): never => { throw new Error(`FM-1 package rejected: ${reason}`); };
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'TGP1') invalid('invalid header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(4, true);
  const format = support.protocol.packages.find(p => p.version === version);
  if (!format) return invalid(`unsupported package version ${version}`);
  if (bytes.length < format.headerBytes) invalid('invalid header');
  const count = view.getUint16(6, true), registers = view.getUint16(8, true), values = view.getUint16(10, true);
  if (!count || count > Math.min(format.operations, fm1Limits.operations) || !registers
    || registers > Math.min(format.registers, fm1Limits.registers) || values > Math.min(format.values, fm1Limits.values)
    || bytes.length !== format.headerBytes + count * format.operationBytes + values * 4) invalid('invalid length or resource counts');
  let requiredFirmware = format.since ?? 902;
  let delays = 0;
  for (let i = 0; i < count; i++) {
    const offset = format.headerBytes + i * format.operationBytes;
    const operand = (index: number) => view.getInt16(offset + index * 2, true);
    const code = operand(0);
    const instruction = support.protocol.instructions.find(op => op.code === code);
    if (!instruction || version < instruction.minimumPackageVersion) return invalid(`unsupported instruction ${code} at operation ${i}`);
    requiredFirmware = Math.max(requiredFirmware, instruction.since);
    if (code === fm1Delay.instruction || code === fm1Delay.legacyInstruction) {
      if (++delays > fm1Delay.maxNodes) invalid(`at most ${fm1Delay.maxNodes} Delay nodes per patch`);
      if (delays > 1) requiredFirmware = Math.max(requiredFirmware, fm1Delay.since);
    }
    if (code === 25 && (!support.compiler.oscillatorModes.includes(operand(9)) || operand(9) === 6)) invalid('unsupported oscillator waveform');
    if (code === 38 && !fm1FunctionArity(operand(6))) invalid('unsupported expression function');
  }
  return { version, requiredFirmware };
}
