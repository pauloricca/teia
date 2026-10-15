// Static documentation audit only: never compiles patches or runs firmware/the app.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import ts from 'typescript';
import { validateSchema } from './fm1-support-schema.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const registryPath = 'firmware/fm1/support.json';
const outputPath = 'firmware/fm1/SUPPORT.md';
const registry = JSON.parse(read(registryPath));
const mode = process.argv[2] ?? '--check';
if (!['--check', '--write', '--record-review'].includes(mode) || process.argv.length > 3) {
  throw new Error('Usage: node scripts/fm1-support.mjs [--check|--write|--record-review]');
}
const watched = [
  'editor/src/graph/types.ts', 'editor/src/graph/nodeTypes.ts',
  'editor/src/graph/subpatch.ts', 'editor/src/graph/spread.ts', 'editor/src/graph/expression.ts',
  'editor/src/audio/dspProgram.ts', 'editor/src/audio/dspOpcodes.ts',
  'editor/src/audio/fm1Package.ts', 'editor/src/audio/fm1Optimizer.ts', 'editor/src/audio/fm1Upload.ts',
  'editor/src/audio/useFm1LiveEdit.ts',
  'editor/src/editor/NodeEditor.tsx',
  'editor/src/editor/ShaderNode.tsx',
  'editor/src/editor/Fm1ModeContext.ts', 'editor/src/audio/fm1Support.ts', 'editor/src/audio/fm1Capabilities.ts',
  'editor/src/editor/Fm1SupportPage.tsx', 'editor/src/App.tsx', 'editor/src/styles.css',
  'firmware/fm1/runtime.h', 'firmware/fm1/app.c', 'firmware/fm1/upload.h',
  'firmware/fm1/export-patch.mjs',
  'scripts/fm1-runtime-spike.py', 'scripts/fm1-send-patch.py', 'scripts/fm1-install.py',
  'editor/src/diagnostics.ts', 'runtime/src/index.ts',
  'editor/src/graph/parse.ts', 'editor/src/graph/serialize.ts',
  'editor/src/audio/dspEdit.ts', 'editor/src/audio/patchPackage.ts',
  'editor/src/hosted/document.ts', 'editor/src/hosted/compiler.ts', 'editor/src/hosted/native.ts',
  'editor/src/hosted/bridge.ts', 'editor/src/hosted/session.ts', 'editor/src/hosted/assets.ts',
  'editor/src/hosted/parameters.ts', 'editor/src/hosted/useHostedAudio.ts',
  'editor/src/hosted/HostedNodeEditor.tsx', 'editor/src/hosted/HostedModeContext.ts',
  'editor/src/hosted/mockBridge.ts', 'editor/src/hosted/package.ts',
  'hosted/package.json', 'runtime/package.json', 'rust/teia-kernel/Cargo.toml',
  'scripts/build-hosted.mjs', 'scripts/build-hosted-conformance.mjs',
  'rust/teia-kernel/src/state_fields.rs', 'rust/teia-kernel/src/runtime_preparation.rs',
  'rust/teia-kernel/src/hosted_resources.rs', 'rust/teia-kernel/src/runtime-capabilities.json',
  'editor/src/hosted/engineCapabilities.json', 'scripts/engine-capabilities.mjs',
  'rust/teia-kernel/src/lib.rs', 'rust/teia-kernel/src/native_state.rs', 'rust/teia-kernel/src/hosted.rs',
  'editor/public/audio/audio-worklet-wasm.js',
];
const errors = validateSchema(registry, JSON.parse(read('firmware/fm1/support.schema.json')));
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }
const require = (condition, message) => { if (!condition) errors.push(message); };
const source = ts.createSourceFile('types.ts', read(watched[0]), ts.ScriptTarget.Latest, true);
const alias = source.statements.find(n => ts.isTypeAliasDeclaration(n) && n.name.text === 'NodeType');
if (!alias || !ts.isUnionTypeNode(alias.type)) throw new Error('Cannot read NodeType union; update the audit.');
const nodes = alias.type.types.map(n => {
  if (!ts.isLiteralTypeNode(n) || !ts.isStringLiteral(n.literal)) throw new Error('Unexpected NodeType member');
  return n.literal.text;
});
require(registry.schemaVersion === 2, 'Unsupported registry schema');
require(/^FM-1_\d+$/.test(registry.firmware), 'Invalid firmware identity');
require(/^\d{4}-\d{2}-\d{2}$/.test(registry.reviewedOn), 'Missing review date');
const identities = ['scripts/fm1-runtime-spike.py', 'firmware/fm1/app.c']
  .flatMap(path => [...read(path).matchAll(/FM-1_\d+/g)].map(m => m[0]));
require(identities.length && identities.every(v => v === registry.firmware), 'Firmware build identity differs from the support register');
const statuses = ['supported', 'partial', 'unsupported', 'unknown'];
const instructionCodes = new Set(registry.protocol.instructions.map(op => op.code));
require(instructionCodes.size === registry.protocol.instructions.length, 'Duplicate firmware instruction');
require(new Set(registry.compiler.functions.map(fn => fn.id)).size === registry.compiler.functions.length, 'Duplicate expression function');
require(new Set(registry.protocol.packages.map(p => p.version)).size === registry.protocol.packages.length, 'Duplicate package version');
const currentPackage = registry.protocol.packages.find(p => p.version === registry.limits.packageVersion);
require(currentPackage?.operationBytes === registry.limits.operationBytes, 'Current package instruction size differs from limits');
for (const key of ['operations', 'registers', 'values']) require(currentPackage?.[key] === registry.limits[key], `Current package ${key} differs from limits`);
for (const op of registry.protocol.instructions) {
  require(op.since <= Number(registry.firmware.split('_')[1]), `Instruction ${op.code} needs a future firmware`);
  require(registry.protocol.packages.some(p => p.version === op.minimumPackageVersion), `Instruction ${op.code} has an unknown package version`);
}
const delay = registry.compiler.delay;
require(delay.maxNodes <= registry.limits.states, 'Delay count exceeds available DSP states');
require(delay.instruction !== delay.legacyInstruction, 'New delay instruction must reject older firmware');
require(registry.protocol.instructions.some(op => op.code === delay.instruction && op.since === delay.since), 'Delay instruction/version differs from resource contract');
require(instructionCodes.has(delay.legacyInstruction), 'Legacy delay instruction missing');
for (const code of [...Object.values(registry.compiler.filterModes), ...Object.values(registry.compiler.distortionModes)]) {
  require(instructionCodes.has(code), `Lowered instruction ${code} is absent from protocol`);
}
const compilerAst = ts.createSourceFile('fm1Package.ts', read('editor/src/audio/fm1Package.ts'), ts.ScriptTarget.Latest, true);
const lowering = compilerAst.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'lowerFm1Patch');
const implemented = new Set();
function visit(node) {
  if (ts.isSwitchStatement(node) && node.expression.getText(compilerAst) === 'o.opcode') {
    for (const clause of node.caseBlock.clauses) if (ts.isCaseClause(clause) && ts.isNumericLiteral(clause.expression)) implemented.add(Number(clause.expression.text));
  }
  ts.forEachChild(node, visit);
}
if (lowering) visit(lowering);
require(implemented.size > 0 && registry.compiler.opcodes.every(code => implemented.has(code))
  && [...implemented].every(code => registry.compiler.opcodes.includes(code)), 'Compiler handlers and registered opcodes differ; review both');
const ids = new Set();
for (const f of registry.features) {
  const key = `${f.category}:${f.id}`;
  require(!ids.has(key), `Duplicate feature ${key}`); ids.add(key);
  require(typeof f.id === 'string' && f.id.length > 0 && typeof f.category === 'string' && f.category.length > 0, `Invalid feature identity ${key}`);
  require(statuses.includes(f.status), `Invalid status: ${key}`);
  require(['source reviewed', 'host verified', 'hardware verified', 'unverified'].includes(f.verification), `Invalid verification: ${key}`);
  require(typeof f.notes === 'string' && f.notes.trim().length > 0, `Missing scope/limitations: ${key}`);
  require(f.since === null || (Number.isInteger(f.since) && f.since > 0 && f.since <= Number(registry.firmware.split('_')[1])), `Invalid since version: ${key}`);
  require(Array.isArray(f.evidence) && f.evidence.length > 0, `Missing evidence: ${key}`);
  for (const path of f.evidence ?? []) require(existsSync(resolve(root, path)), `Missing evidence file: ${path}`);
  if (['host verified', 'hardware verified'].includes(f.verification)) {
    require(registry.evidenceLog.some(e => e.firmware === registry.firmware && e.features?.includes(f.id) && e.verification === f.verification), `No matching current-firmware verification evidence: ${key}`);
  }
  if (f.category === 'node') {
    require(nodes.includes(f.id), `Stale node: ${f.id}`);
    require(Array.isArray(f.blockedInputs) && Array.isArray(f.blockedOutputs), `Missing port policy: ${f.id}`);
    require(f.status !== 'supported' || !(f.blockedInputs.length || f.blockedOutputs.length || f.drift), `Supported node has restrictions/drift: ${f.id}`);
  }
  require(!f.drift || ['partial', 'unsupported', 'unknown'].includes(f.status), `Drift must affect support status: ${key}`);
}
for (const node of nodes) require(ids.has(`node:${node}`), `New node needs an explicit support decision: ${node}`);
for (const e of registry.evidenceLog) {
  require(/^\d{4}-\d{2}-\d{2}$/.test(e.date) && /^FM-1_\d+$/.test(e.firmware) && typeof e.scope === 'string' && e.scope.length > 0 && existsSync(resolve(root, e.source)), 'Invalid evidence log entry');
}
const hashes = Object.fromEntries(watched.map(path => [path, createHash('sha256').update(read(path)).digest('hex')]));
if (mode !== '--record-review') {
  for (const path of watched) require(registry.reviewedSources[path] === hashes[path], `Source changed since support review: ${path}`);
}
if (errors.length) {
  console.error(errors.join('\n'));
  console.error('\nReview support.json and its evidence, then use --record-review and --write. No support is inferred from a hash.');
  process.exit(1);
}
if (mode === '--record-review') {
  registry.reviewedSources = hashes;
  writeFileSync(resolve(root, registryPath), JSON.stringify(registry, null, 2) + '\n');
  console.log('Recorded source review acknowledgement. Run npm run fm1:support:write.');
  process.exit(0);
}
const cell = text => String(text).replaceAll('|', '\\|').replaceAll('\n', ' ');
const link = path => `[${path}](../../${path})`;
const counts = statuses.map(s => `${registry.features.filter(f => f.status === s).length} ${s}`).join(' · ');
const lines = [
  '# FM-1 feature support', '',
  '<!-- Generated by npm run fm1:support:write from support.json. Do not edit manually. -->', '',
  `Target: **${registry.firmware}**. Source review: **${registry.reviewedOn}**.`, '',
  counts, '',
  '**Supported** means implemented within the stated scope; **partial** means restrictions or missing behavior; **unsupported** means unavailable; **unknown** means not audited. These are implementation claims, not proof of hardware behavior.', '',
  'Verification is separate. Source reviewed means code/document inspection only. Host verified and hardware verified require evidence naming the current firmware and feature. Earlier firmware evidence never automatically carries forward. “Since” is the first documented implementation version; — means not established, not unavailable.', '',
  'This JSON contract drives frontend warnings, editor/CLI export eligibility, binary upload preflight and this reference. Enabled unsupported or unknown nodes block export, including unused nodes and group contents. Partial nodes are allowed only within registered ports, operations and modes. Disabled nodes are ignored. The device still validates operands/state and audio correctness/timing require bench checks.', '',
  '## Nodes', '',
];
function table(features) {
  lines.push('| Feature | Support | Since | Verification | Scope and limitations | Evidence |', '| --- | --- | --- | --- | --- | --- |');
  for (const f of features) lines.push(`| ${cell(f.id)} | ${f.status} | ${f.since ?? '—'} | ${f.verification} | ${cell(f.notes)}${f.drift ? ` Web: ${cell(f.drift.webBehavior)} Firmware: ${cell(f.drift.firmwareBehavior)} Catch-up: ${cell(f.drift.requiredWork)}` : ''}${f.blockedInputs?.length ? ` Blocked inputs: ${f.blockedInputs.join(', ')}.` : ''}${f.blockedOutputs?.length ? ` Blocked outputs: ${f.blockedOutputs.join(', ')}.` : ''} | ${f.evidence.map(link).join(', ')} |`);
  lines.push('');
}
table(registry.features.filter(f => f.category === 'node'));
lines.push('## Device and cross-cutting features', '');
table(registry.features.filter(f => f.category !== 'node'));
lines.push('## Machine-readable contract', '',
  '`support.json` (schema version 2) is the editable source. `support.schema.json` defines its shape. `limits.json` is a generated compatibility mirror; do not edit it.', '',
  '- `features`: stable category/id, status, evidence and notes; node entries also declare blockedInputs/blockedOutputs. Unknown or unsupported nodes block export. A partial status is not a blanket prohibition: compiler and port rules define the available subset.',
  '- `drift`: optional webBehavior, firmwareBehavior and requiredWork on any feature. Record newly introduced differences here and lower the status; frontend warnings and this reference display the gap.',
  '- `compiler`: accepted browser opcodes, oscillator modes, filter/distortion lowering maps and expression function IDs/arities. Backend code implements the operations; adding a JSON entry alone cannot implement firmware support.',
  '- `compiler.delay`: node count, duration, sample rate, storage precision, time smoothing and instruction/version policy. Export generates the firmware constants; editor/CLI lowering and both upload preflights use this same resource contract.',
  '- `protocol`: accepted package layouts and firmware instruction codes, minimum package version and first firmware version. Both uploaders preflight these rules before MIDI access. Binary packages contain no original node inventory, so node eligibility is enforced during export.',
  '- `limits`: resource ceilings and the current encoder format. The exporter uses these to generate firmware limit headers.', '',
  'The device currently advertises package-format compatibility, not a feature set or exact firmware build. A successful connection check does not establish support for every instruction in this registry; an older device can still reject a graph at commit without activating it.', '',
  '### Encoded instructions', '', '| Code | Instruction | First firmware | Minimum package version |', '| --- | --- | --- | --- |');
for (const op of registry.protocol.instructions) lines.push(`| ${op.code} | ${op.name} | ${op.since} | ${op.minimumPackageVersion} |`);
lines.push('', '## Recorded evidence', '');
for (const e of registry.evidenceLog) lines.push(`- ${e.date}, **${e.firmware}**: ${e.scope} See ${link(e.source)}.`);
lines.push('', '## Keeping this current', '',
  '1. Add or update a feature in `firmware/fm1/support.json` in the same change as its implementation. Update structured compiler/protocol rules, blocked ports, limits, drift, evidence paths and the first supported firmware when known; do not maintain independent allowlists in consumers. Use unknown until audited; do not mark planned work as supported.',
  '2. For every new editor node, add an explicit node entry, even when unsupported on FM-1. Existing node and compiler changes also require review. Add device/protocol/workflow features manually: code cannot discover their meaning.',
  '3. Review changes to the watched sources against the previous Git revision. Update statuses, notes, target firmware and reviewedOn. Run `node scripts/fm1-support.mjs --record-review` only after that review; it acknowledges source hashes and does not test or infer support.',
  '4. Run `npm run fm1:support:write`, then `npm run fm1:support:check`. Commit the register and generated matrix together. The check also runs before the root typecheck and build; it rejects missing/new nodes, stale source reviews and stale generated documentation.',
  '5. Open `/fm1-support` (also `/?view=fm1-support`) for the live green-tick table backed by this registry.',
  '6. After authorized host/hardware testing, append evidence with date, exact firmware, scope and source file. To set a feature to host verified or hardware verified, the evidence entry must also contain the matching verification value and a features array listing its id. Record failures and limitations; retain older-version evidence. Never turn source review or a successful flash into an audio verification claim.', '',
  'Source fingerprints are deliberately conservative: even a nonfunctional edit prompts review. Add new capability-bearing files to the watched list in `scripts/fm1-support.mjs`. No automatic check can establish that a manually entered support claim is correct.', '');
const rendered = lines.join('\n');
if (mode === '--write') {
  writeFileSync(resolve(root, 'firmware/fm1/limits.json'), JSON.stringify(registry.limits, null, 2) + '\n');
  writeFileSync(resolve(root, outputPath), rendered);
  console.log(`Generated ${outputPath}`);
} else {
  if (read('firmware/fm1/limits.json') !== JSON.stringify(registry.limits, null, 2) + '\n') { console.error('Generated limits mirror is stale. Run npm run fm1:support:write.'); process.exit(1); }
  if (!existsSync(resolve(root, outputPath)) || read(outputPath) !== rendered) {
    console.error('Support matrix is stale. Run npm run fm1:support:write.'); process.exit(1);
  }
  console.log(`FM-1 support audit passed: ${nodes.length} nodes, ${registry.features.length - nodes.length} other features; source review and matrix current.`);
}
