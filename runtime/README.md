# @pauloricca/teia-runtime

Browser runtime for Teia patch ZIPs exported with XP. The npm package contains the Rust/WASM kernel and AudioWorklet; patch ZIPs contain only the editable patch, compiled DSP program, parameter metadata, and referenced assets.

```js
import { PatchPlayer } from '@pauloricca/teia-runtime';

const context = new AudioContext();
const player = await PatchPlayer.load(context, patchZipFile);
player.connect(context.destination);
await context.resume();
player.setParameter(player.parameters[0].id, 0.5);
player.noteOn(60, 0.8);
player.noteOff(60);
player.dispose();
```

Serve the package's `dist/audio-worklet-wasm.js`, `dist/teia-kernel.wasm`, and `dist/teia-kernel-simd.wasm` alongside `dist/index.js`. The module resolves those files relative to its own URL and selects the SIMD kernel only when the host validates it; the ordinary kernel is the fallback. On ordinary WASM hosts, programs with KinkOsc or sign-preserving power automatically use scalar rendering pending broader block-cost benchmarks. A bundler must copy these assets into its output, or a static server can serve the installed package files directly. `PatchPlayer.load` verifies the patch's asset hashes and checks the patch format and engine API versions.

Build this package from the editor repository with `npm run build:runtime`. Its worklet skips editor visualization, metering, CPU reporting, and legacy effect allocations while retaining DSP FFT outputs. The package is installable from a local tarball; it has not been published to a registry. Before the first public release, review `npm pack --dry-run ./runtime`, then publish from `runtime/` with `npm publish --access public` after signing in to npm and enabling 2FA.

Editor exports use the `teia-patch` manifest format and name `@pauloricca/teia-runtime`.


Runtime 0.3.0 accepts engine APIs 1 and 2. Exports using Audio Input's separate
`left`/`right` channels require API 2 so older players reject them instead of
silently averaging. Existing mono `signal` packages remain API 1. Manifest 2 and
program 1 are retained. Params may include additive `persistentId`, step and
integer metadata; legacy ID lookup is retained, and setParameter/getParameter also accept the
persistent identity. Preserved Buffer snapshots nested inside subpatchs
are resolved using the compiled group scope. The private hosted editor/native
surface is packaged separately; see [hosted contracts](../docs/hosted.md).
