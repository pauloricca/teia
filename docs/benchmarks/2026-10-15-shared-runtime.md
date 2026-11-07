# Standalone performance comparison — 15 October 2026

Compared `9cdf8ac0bb7316c1f9c3fe2387ddf0cc055b891d` against its parent `7d54233c58ad5424f7ae5c0242cd6443fa33c84c`. These are standalone WASM measurements, independent of Vira.

**Conclusion: the refactor is not performance-neutral.** The saved-patch DSP regressions persisted when rerun after the user reported background activity. Graph preparation also costs substantially more; raw compiler timings are much closer. No implementation was changed during this investigation.

## DSP timings with compilation controlled

Values are median milliseconds per 128-frame block at 48 kHz. Positive change means slower. This final pass used Node flags `--no-liftoff --no-wasm-lazy-compilation` to compile optimized WASM upfront, removing dynamic WASM tier transitions from the comparison. Module positions were reversed relative to the first suite. Each row uses 256 warmup blocks, 256 measured blocks and 11 alternating-order trials. Both kernels compile block plans and select rendering automatically.

| Patch | Ordinary before | After | Change | SIMD before | After | Change |
|---|---:|---:|---:|---:|---:|---:|
| dirty-saw | 1.5975 | 1.6912 | +5.9% | 1.5765 | 1.6497 | +4.6% |
| ear-confusion | 1.1712 | 1.2468 | +6.5% | 1.1509 | 1.2082 | +5.0% |
| lyra-esque | 2.9217 | 3.1804 | +8.9% | 2.8679 | 2.9143 | +1.6% |
| karplus-strong | 0.9509 | 0.9933 | +4.5% | 0.9274 | 0.9610 | +3.6% |
| beats-sequencer | 0.3510 | 0.3835 | +9.3% | 0.3474 | 0.3634 | +4.6% |
| ringing-drone | 0.2416 | 0.2530 | +4.7% | 0.2712 | 0.2805 | +3.5% |
| Simple compiled sine | 0.0173 | 0.0169 | -2.1% | 0.0148 | 0.0149 | +0.5% |

### Default Node tiering confirmation

These fresh reruns retained Node’s default WASM tiering and also reversed module positions. Settings were the same 256 warmup / 256 measured / 11 trials. They explain why a single percentage from the initial suite would overstate precision.

| Patch | Ordinary change | SIMD change |
|---|---:|---:|
| dirty-saw | +4.6% | +12.1% |
| ear-confusion | +7.7% | +15.4% |
| lyra-esque | +3.7% | +16.4% |
| karplus-strong | +5.1% | +11.4% |
| beats-sequencer | +6.7% | +16.3% |
| ringing-drone | +5.4% | +1.4% |
| Simple compiled sine | -1.7% | -0.8% |

The nominal 128-frame callback budget is 2.667 ms. Lyra-esque exceeds it in these single-kernel measurements both before and after. Offline timings do not prove actual browser deadline behaviour.

## Stress cases (first suite)

These nine-trial results used 128 warmup and 512 measured blocks. Differences around 1% should be treated as timing variation; these cases were not included in the targeted confirmation suite.

| Case | Ordinary before → after | Change | SIMD before → after | Change |
|---|---:|---:|---:|---:|
| Group inside Spread (128 sine oscillators) | 3.235 → 3.239 | +0.1% | 3.241 → 3.208 | -1.0% |
| Group inside Spawn (128 sine/envelope voices) | 9.912 → 10.042 | +1.3% | 9.969 → 9.996 | +0.3% |

Both stress cases already exceed the nominal single-kernel callback budget before this commit. This is not a new regression caused by this refactor.

## Editor graph preparation

The previous standalone editor called `compilePatchToDspProgram` directly. The new editor calls `preparePatch`, which additionally parses/validates the document, assigns parameter identities and derives layout/requirements/metadata. Inputs were parsed and stripped with the actual current editor helpers outside the timed region; all three functions received the same input. Results below are the second run: 60 warmups per function and 15 rotating-order trials of 30 calls each. Milliseconds per call.

| Patch | Before compiler | After compiler alone | After full preparation | Full path ratio |
|---|---:|---:|---:|---:|
| dirty-saw | 1.066 | 1.215 | 2.634 | 2.47× |
| ear-confusion | 1.153 | 1.176 | 2.927 | 2.54× |
| lyra-esque | 2.943 | 3.129 | 7.868 | 2.67× |
| karplus-strong | 0.859 | 0.866 | 2.065 | 2.40× |
| beats-sequencer | 0.436 | 0.439 | 0.829 | 1.90× |
| ringing-drone | 0.152 | 0.149 | 0.336 | 2.21× |

This measures the synchronous graph preparation step, not React rendering, canvas interaction, frame rate or complete input-to-audio latency. Layout-only moves still use the existing memoization boundary. The preparation increase is attributable to the additional wrapper work as a whole; individual validation functions have not been profiled.

## Smoothing microbenchmark

The existing `benchmark-dsp-values.mjs` was run on SIMD builds with 2,048 measured blocks and 15 trials, then rerun with arguments reversed. Each line gives median milliseconds per block. The first group is before / after; the second is after / before. This synthetic two-op test stresses 2,048 initialized value slots, with different numbers actively changing.

```text
128 frames at 48 kHz; 2048 measured blocks, 15 trials per case; ms/block median
settled high index: 0.004068 / 0.004447
one moving value: 0.004144 / 0.004594
64 moving values: 0.020295 / 0.017988
all moving values: 0.512309 / 0.450720
Exact output match: first assignment, repeated target, retarget, immediate, settled, reset, program replacement.
128 frames at 48 kHz; 2048 measured blocks, 15 trials per case; ms/block median
settled high index: 0.004420 / 0.004045
one moving value: 0.004630 / 0.004161
64 moving values: 0.018009 / 0.020277
all moving values: 0.454796 / 0.513792
Exact output match: first assignment, repeated target, retarget, immediate, settled, reset, program replacement.
```

## Correctness and limits

- All timed A/B runs completed their existing output-equality assertions. The saved-patch harness also compared every stereo sample and bound scalar state across the verification blocks, plus delay buffers/write indices. Active Spawn was timed with 128 voices; it compared final timed blocks and exercised release/kill checks, rather than checking every active-voice block.
- Compiler ops, values, register count and state count matched between parent compilation, target compilation and target preparation for all six saved fixtures, in both preparation runs. Smoothing tests also checked repeated targets, retargeting, immediate assignment, settling and reset behaviour.
- This is the existing **kernel-only** saved-patch harness. It does not run the complete AudioWorklet, JS FFT, external MIDI, media acquisition or editor visualization. It does not upload full worklet-side sequencer/custom-wave/media configuration. Lyra-esque and beats-sequencer were silent with this setup; their figures describe DSP graph execution in that state. Resource preparation, graph-swap latency, allocations, native Vira and multi-worker performance are not established here.
- Runs were sequential, with no agent builds running alongside timed measurements. The desktop was not a dedicated benchmark machine; thermal, OS and other application activity remain possible sources of variation. Small percentage changes are not proof of a regression.

## Reproduction and provenance

- Clean source snapshots were extracted with `git archive` for each ref into `/tmp/teia-perf-9cdf8ac/{before,after}`. The running editor bundle and Docker application configuration were untouched.
- Both snapshots were built using Docker image `teia-rust-wasm:1.87`, `cargo build --release --target wasm32-unknown-unknown`, with the repository release settings (`opt-level="z"`, LTO, one codegen unit). SIMD builds additionally used `RUSTFLAGS="-C target-feature=+simd128"` and `CARGO_TARGET_DIR=target/simd`.
- Timings used Node v24.14.1 on arm64 macOS. Both source snapshots used the same installed TypeScript/esbuild dependencies. Ignored local patch fixtures were copied once into the benchmark snapshot; their hashes and rebuilt WASM hashes are recorded in the adjacent JSON.
- Runtime harness: target `scripts/benchmark-saved-patches.mjs`, changed only in the temporary snapshot to emit raw results/trial arrays and keep Node alive while eager asynchronous WASM compilation completes. Environment: `BENCHMARK_BASELINE_WASM`, `BENCHMARK_COMPARISON_WASM`, `BENCHMARK_BLOCK_PLAN=1`, `BENCHMARK_VERIFY_ALL_BLOCKS=1`, `BENCHMARK_PATCH_FILES` (the six JSON paths recorded in the results, plus `@simple-block`; first suite also included `@group-spread,@group-spawn`). Initial settings: warmup 128, measured 512, trials 9. Confirmation settings: warmup 256, measured 256, trials 11, **module paths swapped**. The final controlled-compilation pass uses those settings plus `node --no-liftoff --no-wasm-lazy-compilation`.
- Local replay scripts and complete logs remain in `/tmp/teia-perf-9cdf8ac`. Durable raw measurements: [results JSON](2026-10-15-shared-runtime-results.json).

## Recommended follow-up

Profile the scalar execution changes and the document preparation wrapper before optimizing. The data supports a modest DSP regression and extra editor preparation cost; it does not identify one Rust function as the cause. Preserve the single-engine architecture while removing unnecessary hot-path overhead.

Only benchmark reports were added to this repository. No refresh, rebuild or restart is required. README impact was reviewed; public setup and behaviour are unchanged. No engine source changed, so there is no FM-1 parity change.
