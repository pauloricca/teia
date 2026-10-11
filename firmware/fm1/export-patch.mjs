// Compile an actual Teia graph, then lower only the explicitly supported spike subset.
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.resolve(process.argv[2] ?? path.join(root, '.cache/fm1-spike/naked/gen'));
await fs.mkdir(out, { recursive: true });
// A failed export must never leave an older uploadable package at this path.
await fs.rm(path.join(out, 'patch.tgp'), { force: true });
await build({ stdin: { contents: 'export {compileFm1Patch, fm1Limits, q16} from "./editor/src/audio/fm1Package.ts";', resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', outfile: path.join(out, 'compiler.mjs') });
const { compileFm1Patch, fm1Limits: limits, q16 } = await import(pathToFileURL(path.join(out, 'compiler.mjs')));
await fs.writeFile(path.join(out, 'teia_limits.h'), Object.entries({
  TEIA_MAX_OPS: limits.operations, TEIA_MAX_REGS: limits.registers,
  TEIA_MAX_VALUES: limits.values, TEIA_MAX_STATES: limits.states,
  TEIA_PACKAGE_VERSION: limits.packageVersion, TEIA_OP_BYTES: limits.operationBytes,
}).map(([name, value]) => `#define ${name} ${value}u\n`).join(''));
const patchPath = path.resolve(process.argv[3] ?? path.join(root, 'firmware/fm1/patches/sine.json'));
const patch = JSON.parse(await fs.readFile(patchPath, 'utf8'));
const { program, ops, parameters, bytes } = compileFm1Patch(patch);
const sine = Array.from({ length: 1025 }, (_, i) => Math.round(Math.sin(i * Math.PI * 2 / 1024) * 32767));
// Use the nominal rate of the existing Teia/Felucca graph model, as Felucca does.
const filterSine = Array.from({ length: 1025 }, (_, i) => Math.round(Math.sin(i * Math.PI * 2 / 1024) * 1073741824));
const bendRatios = Array.from({ length: 257 }, (_, i) => Math.round(2 ** (i / 256) * 1073741824));
const pitches = Array.from({ length: 128 }, (_, i) => q16(440 * 2 ** ((i - 69) / 12)));
const header = `/* Generated from patches/sine.json by the Teia compiler. */\n`
  + Object.entries(parameters).map(([k,v]) => `#define PARAM_${k.toUpperCase()} ${v}u\n`).join('')
  + `static const int32_t sine_table[1025] = {${sine.join(',')}};\n`
  + `static const int32_t filter_sine[1025] = {${filterSine.join(',')}};\n`
  + `static const uint32_t bend_ratio_table[257] = {${bendRatios.map(value => `${value}u`).join(',')}};\n`
  + `static const int32_t note_frequency[128] = {${pitches.join(',')}};\n`
  + `static const teia_program_t demo_program = {\n${ops.length}, ${program.registerCount}, ${program.values.length},\n`
  + `{${ops.map(o => `{${o.join(',')}}`).join(',\n')}},\n{${program.values.map(q16).join(',')}}\n};\n`;
await fs.writeFile(path.join(out, 'patch.h'), header);
await fs.writeFile(path.join(out, 'program.json'), JSON.stringify(program, null, 2) + '\n');
await fs.writeFile(path.join(out, 'lowered.json'), JSON.stringify({ name: patch.name, ops, parameters, values: program.values, registerCount: program.registerCount }, null, 2) + '\n');
console.log(`FM-1 program: ${ops.length} operations, ${program.registerCount} registers, ${program.values.length} values`);

await fs.writeFile(path.join(out, 'patch.tgp.tmp'), bytes);
await fs.rename(path.join(out, 'patch.tgp.tmp'), path.join(out, 'patch.tgp'));
console.log(`Upload package: ${bytes.length} bytes (${patch.name ?? 'untitled'})`);
