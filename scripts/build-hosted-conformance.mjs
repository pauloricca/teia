import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('hosted/dist/conformance', { recursive: true });
await build({ entryPoints: ['hosted/conformance/contracts.test.ts'], outfile: 'hosted/dist/conformance/contracts.test.mjs', bundle: true, platform: 'node', format: 'esm', target: 'es2022' });
await build({ entryPoints: ['hosted/conformance/editor.tsx'], outfile: 'hosted/dist/conformance/editor.js', bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', define: { 'import.meta.env': '{}' }, plugins: [{ name: 'assets', setup(b) {
  b.onResolve({ filter: /^virtual:audio-engine-assets$/ }, () => ({ path: 'assets', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: ['AUDIO_WASM_ASSET_VERSION', 'AUDIO_SIMD_WASM_ASSET_VERSION', 'AUDIO_WORKLET_ASSET_VERSION', 'AUDIO_PARALLEL_WASM_ASSET_VERSION', 'AUDIO_PARALLEL_WORKER_ASSET_VERSION'].map(n => `export const ${n} = "hosted-test";`).join('\n'), loader: 'js' }));
} }] });
await writeFile('hosted/dist/conformance/editor.html', '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../flow.css"><link rel="stylesheet" href="../themes.css"><link rel="stylesheet" href="../styles.css"><title>Hosted editor isolation harness</title></head><body><div id="root"></div><script type="module" src="./editor.js"></script></body></html>\n');
console.log('Compiled hosted conformance harnesses; no tests were executed.');
