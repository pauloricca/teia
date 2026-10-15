# Standalone performance after hosted facilities — 15 October 2026

Compared previous shared runtime `9cdf8ac0bb7316c1f9c3fe2387ddf0cc055b891d` with current `ecd5e17b8a8ca21d65958ecfb067d8ee2993253b`. The Rust engine and compiler at the previous ref are identical to pre-follow-up `3e5ba9f`; that intermediate commit only adds the Vira theme. This comparison isolates the latest hosted-facilities work from the earlier shared-runtime refactor.

**Conclusion: the latest changes introduce another measurable standalone DSP slowdown on most saved patches.** Across the six saved fixtures and both module orders, the geometric-mean increase is **4.3% ordinary WASM** and **5.4% SIMD**. This is additional to the earlier report's regression, not a new measurement against the pre-refactor engine. Graph preparation shows no clear additional regression; its existing preparation-wrapper cost remains.

## Matching earlier evidence

The earlier [report](2026-10-15-shared-runtime.md) and [raw JSON](2026-10-15-shared-runtime-results.json) compare `7d54233` → `9cdf8ac`. They found roughly 5–9% ordinary-WASM regressions on the saved patches and full editor preparation around 1.9–2.7× the old raw compiler cost. Those files have been preserved unchanged. The older WASM binaries and all six patch files were checked against their recorded SHA-256 hashes before reuse.

## Saved-patch DSP results

Each cell gives **forward / reversed-module-position** percentage changes; positive means current is slower. These are ratios of the per-version trial medians. Modules were measured in alternating order within each pass.

| Patch | Ordinary change | SIMD change |
| --- | ---: | ---: |
| dirty-saw | +4.9% / +4.6% | +4.7% / +11.5% |
| ear-confusion | +6.8% / +4.8% | +3.9% / +7.3% |
| lyra-esque | +4.4% / +6.1% | +3.1% / +3.3% |
| karplus-strong | +1.5% / +4.2% | +6.9% / +8.1% |
| beats-sequencer | +7.3% / +5.5% | +4.2% / +1.3% |
| ringing-drone | -2.7% / +4.8% | +0.4% / +11.0% |
| Simple compiled sine | +18.1% / +1.5% | +0.6% / -2.1% |

| Six saved patches, geometric mean | Ordinary | SIMD |
| --- | ---: | ---: |
| Forward positions | +3.7% | +3.8% |
| Reverse positions | +5.0% | +7.0% |
| Both passes combined | +4.3% | +5.4% |

The five non-ringing saved patches slow down in both passes for both builds. Ringing-drone has greater variation and an ordinary-WASM sign reversal, so its individual result is less conclusive. The tiny sine case also varies: its first ordinary pass changes 0.01781 → 0.02104 ms (+3.23 microseconds), while the reversed pass changes 0.01690 → 0.01714 ms. Its large first-pass percentage should not be generalized to large graphs.

Lyra-esque remains above the nominal 2.667 ms / 128-frame budget in both versions. That was already true before these changes; these offline numbers are not live browser deadline acceptance.

## Editor graph preparation

Milliseconds per call, using the same parsed/stripped patch for every function. Each function has 60 warmup calls, then 15 rotating-order trials of 30 calls. Both raw compilation and full preparation are retained in the JSON.

| Patch | Previous full preparation | Current full preparation | Change | Current preparation / pre-shared raw compiler |
| --- | ---: | ---: | ---: | ---: |
| dirty-saw | 3.340 | 3.234 | -3.2% | 2.27× |
| ear-confusion | 3.036 | 3.044 | +0.2% | 2.78× |
| lyra-esque | 8.675 | 8.952 | +3.2% | 2.70× |
| karplus-strong | 2.144 | 2.190 | +2.1% | 2.60× |
| beats-sequencer | 0.845 | 0.827 | -2.1% | 2.03× |
| ringing-drone | 0.362 | 0.369 | +1.8% | 2.14× |

The latest preparation differences range from −3.2% to +3.2%, without a consistent slowdown across patches. The much larger difference from the pre-shared raw compiler is still present (about 2.0–2.8× in this rerun). This measures synchronous graph preparation, not React rendering, canvas interaction or complete input latency. Compiler operations, values, register count and state count matched across all five paths.

## Smoothing microbenchmark

Same SIMD microbenchmark as before: 128 frames / 48 kHz, 2,048 measured blocks, 15 trials; default Node tiering, then a rerun with module positions reversed. Values are previous → current milliseconds per block.

| Case | Forward positions | Reversed positions |
| --- | ---: | ---: |
| settled high index | 0.004448 → 0.004572 (+2.8%) | 0.004447 → 0.004517 (+1.6%) |
| one moving value | 0.004676 → 0.004768 (+2.0%) | 0.004622 → 0.004769 (+3.2%) |
| 64 moving values | 0.018142 → 0.018307 (+0.9%) | 0.018173 → 0.018316 (+0.8%) |
| all moving values | 0.452634 → 0.448869 (-0.8%) | 0.444873 → 0.446746 (+0.4%) |

These microbenchmarks show small changes rather than a broad smoothing regression. Exact output checks passed for targets, retargeting, immediate values, settling, reset and replacement.

## Method, correctness and limits

- Node v24.14.1 on arm64 macOS / Apple M1 Pro, matching the earlier measurement environment. Saved-patch timings use `--no-liftoff --no-wasm-lazy-compilation`, 256 warmup blocks, 256 measured blocks, 11 trials, 128 frames at 48 kHz. Both kernels compile block plans and choose rendering automatically; the new bounded repeat policy is not enabled.
- Four saved-patch suites ran sequentially, with positions reversed for confirmation. No builds or other agent benchmarks ran alongside timed suites. Other desktop/OS activity was not controlled; the raw trial arrays show the variability.
- Every saved-patch verification block matched both stereo channels and bound numeric state; delay contents/write indices were also checked. Timed final blocks matched. All smoothing assertions passed. This is correctness within the measured fixtures, not complete runtime certification.
- The existing harness measures kernel DSP only. It does not run the complete browser AudioWorklet, JS FFT, UI feedback, media acquisition or external MIDI. Worklet-side sequencer/custom-wave/media configuration is not fully uploaded: Lyra-esque and beats-sequencer are silent here, as in the previous report. Their numbers measure execution in that state.
- The previous report's 128-voice Spread/Spawn stress cases were not rerun in this focused confirmation. Native Rust, multi-worker throughput, browser FPS and actual device dropouts were not measured.
- The result identifies an aggregate regression; it does not prove which Rust check, code-generation change or function caused it. Further profiling is needed before attributing or fixing the cost.

## Artifacts and reproduction

- [Raw measurements, trial arrays, fixture/module hashes and source refs](2026-10-15-hosted-facilities-performance-results.json).
- Isolated source/harness snapshot: `/private/tmp/teia-perf-ecd5e17/current`. Replay scripts: `/private/tmp/teia-perf-ecd5e17/run.sh`, `finish.py`, `preparation.mjs`; raw logs are under its `results/` directory. Earlier hash-verified modules remain under `/private/tmp/teia-perf-9cdf8ac/after/rust/teia-kernel/target/`.
- `sh /private/tmp/teia-perf-ecd5e17/run.sh ordinary forward` (also `ordinary reverse`, `simd forward`, `simd reverse`) reproduces the saved-patch passes. The copied repository runner has only raw-result/trial-array output and the existing eager-compilation keepalive adjustment. Timing paths are unchanged.
- No kernel assets were rebuilt during this task. Existing current committed assets were compared with the earlier recorded builds; all hashes are in the JSON.

Only these new benchmark reports were added to the project. The prior reports and running app were left untouched. No refresh, rebuild or restart is required. README impact was checked: setup and public behavior are unchanged. No engine source changed, so no FM-1 parity/status update was needed.
