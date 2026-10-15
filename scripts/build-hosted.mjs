// Artifact compilation/packaging only. Does not execute Teia or its conformance tests.
import { build } from 'esbuild';
import { runtimeFingerprint } from './runtime-fingerprint.mjs';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'hosted/dist');
execFileSync(process.execPath, ['scripts/engine-capabilities.mjs', '--check'], { cwd: root, stdio: 'inherit' });
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'hosted/tsconfig.json'], { cwd: root, stdio: 'inherit' });
execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', 'hosted/conformance/tsconfig.json'], { cwd: root, stdio: 'inherit' });
const peers = ['react', 'react-dom', '@xyflow/react', '@xyflow/system'];
const result = await build({
  absWorkingDir: root, entryPoints: { index: 'editor/src/hosted/index.ts', editor: 'editor/src/hosted/HostedNodeEditor.tsx' },
  outdir: output, bundle: true, splitting: true, format: 'esm', platform: 'browser', target: 'es2022',
  external: peers, metafile: true,
  define: { 'import.meta.env': '{"VITE_TEIA_PATCH_STORAGE":"hosted"}' },
  plugins: [{ name: 'hosted-assets', setup(builder) {
    // Standalone backend code is never mounted by HostedNodeEditor. Resolve its
    // build-time IDs without depending on a Vite plugin/dev server.
    builder.onResolve({ filter: /^virtual:audio-engine-assets$/ }, () => ({ path: 'assets', namespace: 'hosted' }));
    builder.onLoad({ filter: /.*/, namespace: 'hosted' }, () => ({ contents: ['AUDIO_WASM_ASSET_VERSION', 'AUDIO_SIMD_WASM_ASSET_VERSION', 'AUDIO_WORKLET_ASSET_VERSION', 'AUDIO_PARALLEL_WASM_ASSET_VERSION', 'AUDIO_PARALLEL_WORKER_ASSET_VERSION'].map(name => `export const ${name} = "host-owned";`).join('\n'), loader: 'js' }));
  } }],
});
await copyFile(join(root, 'docs/hosted.md'), join(output, 'README.md'));
await copyFile(join(root, 'editor/src/styles.css'), join(output, 'styles.css'));
await copyFile(join(root, 'editor/src/themes.css'), join(output, 'themes.css'));
await copyFile(join(root, 'node_modules/@xyflow/react/dist/style.css'), join(output, 'flow.css'));
await mkdir(join(output, 'native/teia-kernel/src'), { recursive: true });
for (const path of ['Cargo.toml', 'src/lib.rs', 'src/native_state.rs', 'src/state_fields.rs', 'src/runtime-capabilities.json', 'src/runtime_preparation.rs', 'src/hosted_resources.rs', 'src/hosted_observation.rs', 'src/bounded_repeats.rs', 'src/hosted.rs', 'src/parallel.rs']) await copyFile(join(root, 'rust/teia-kernel', path), join(output, 'native/teia-kernel', path));
await mkdir(join(output, 'native/teia-kernel/tests/fixtures'), { recursive: true });
for (const name of ['shared.rs', 'shared.json']) await copyFile(join(root, 'rust/teia-kernel/tests/fixtures', name), join(output, 'native/teia-kernel/tests/fixtures', name));
execFileSync(process.execPath, ['scripts/build-hosted-conformance.mjs'], { cwd: root, stdio: 'inherit' });
const files = [];
async function visit(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) await visit(path);
    else if (item.name !== 'compatibility.json') files.push({ path: relative(output, path), bytes: (await readFile(path)).byteLength, sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
}
await visit(output);
let evidence;
try { evidence=JSON.parse(await readFile(join(root,'hosted/verification/shared-runtime.json'),'utf8')); } catch { /* Tests are intentionally separate from builds. */ }
const evidenceMatches = evidence?.fixtureRustSha256 === createHash('sha256').update(await readFile(join(root,'rust/teia-kernel/tests/fixtures/shared.rs'))).digest('hex')
  && evidence?.rustSourceSha256 === await runtimeFingerprint()
  && evidence?.fixtureSha256 === createHash('sha256').update(await readFile(join(root,'rust/teia-kernel/tests/fixtures/shared.json'))).digest('hex')
  && evidence?.wasmSha256 === createHash('sha256').update(await readFile(join(root,'editor/public/audio/teia-kernel.wasm'))).digest('hex');
if(evidenceMatches) {
  const report=JSON.stringify(evidence,null,2)+'\n';
  await writeFile(join(output,'verification.json'),report);
  files.push({path:'verification.json',bytes:new TextEncoder().encode(report).byteLength,sha256:createHash('sha256').update(report).digest('hex')});
}
const manifest = {
  format: 'teia-hosted-compatibility', version: 1,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, encoding: 'utf8' }).length > 0,
  versions: { packages: Object.fromEntries(await Promise.all(['editor', 'runtime', 'kernel', 'hosted'].map(async path => [path, JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8')).version]))), package: JSON.parse(await readFile(join(root, 'hosted/package.json'), 'utf8')).version, document: 1, legacyDocument: 0, program: 1, runtime: 1, bridge: 2, bridgeCompatible: [1, 2], xpManifest: 2, engineApis: [1, 2] },
  nativeProfile: 'native-scalar-v1', nativeFunctionalVerification: evidenceMatches ? 'WASM/native equivalence; see verification.json for scope' : 'no current source-matched equivalence evidence',
  artifacts: files.sort((a, b) => a.path.localeCompare(b.path)),
  sourceChecksums: await Promise.all(Object.keys(result.metafile.inputs).filter(p => !p.startsWith('hosted:') && !p.startsWith('<') && !p.includes('node_modules/')).sort().map(async path => ({ path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex') }))),
};
await writeFile(join(output, 'compatibility.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`Built hosted artifacts in ${output}`);
