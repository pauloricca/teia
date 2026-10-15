# Shared runtime implementation plan

The standalone compiled-graph engine is the behavioral reference. Preserve the
existing DSP formulas and public WASM/hosted entrypoints while converging their
implementation. No Vira checkout or running process is changed by this work.

1. **Establish executable baselines.** Run hosted contract/native tests and build
   fixtures that feed identical instructions/resources into standalone exports
   and an owned native instance. Compare outputs, control smoothing, modulation,
   MIDI/timeline delivery, reset and independent-instance state.
2. **Extract shared execution.** Reuse `render_dsp_ops`, `advance_dsp_values`,
   meter/scope capture and quantum initialization from `renderDspProgram`.
   Hosted sample-offset delivery wraps this same per-frame evaluator; it must
   not maintain another instruction loop. Keep legacy MIDI delivery's pulse
   separators in its adapter; direct host events retain their exact offsets.
3. **Unify state and preparation.** Consolidate WASM global declarations and
   native `KernelState` fields/defaults into one declaration. Reuse
   `addDspOp`/control-cache/effect/Buffer preparation, resource upload and runtime
   reset under the explicit owned-instance scope. Factor shared validation out
   of the exported functions. Keep native `Send` assumptions truthful when
   resources and repeat pointers become available.
4. **Replace independent admission lists.** Use the same instruction validation
   and resource requirements for both adapters. Expose engine capability data
   to the SDK from a single contract; platform adapters declare facilities,
   not independently maintained node/DSP lists. Reject missing resources or
   unprepared safety requirements with concrete diagnostics, before activation.
5. **Prepare dynamic storage off-render.** Audit Spawn creation/removal and
   Spread resize/truncate. Provide opt-in bounded pools with explicit capacity
   exhaustion reporting; preserve legacy dynamic behavior until a caller
   explicitly supplies bounds. Recycle killed instances without destruction in
   render. Reinitialize regrown Spread items exactly as legacy shrink/regrow.
   Share the scheduler in both policies; do not clone its DSP or control flow.
6. **Integrate resources and verify.** Supply owned samples/images, custom-wave
   definitions, sequencers and Buffer snapshots through native preparation
   adapters using existing Rust setters. Cover representative resource-dependent
   graphs and repeats in equivalence/allocation tests. Rebuild WASM and hosted
   artifacts, audit FM-1 parity, and document exact remaining limitations.

Compatibility: retain version-1 hosted calls and their generation/session bridge;
new resource/safety setup must be additive. Do not silently change legacy patch
capacity, control smoothing policy, MIDI pulse delivery, or reset semantics. Any
remaining migration stages must be reported explicitly rather than represented
as completed full-runtime parity.

## Implemented increments and verification

- State fields/defaults are declared once in `state_fields.rs`; native owned
  instances and WASM globals expand the same declaration. Owned calls never
  select the legacy default state.
- `render_shared_frame` uses existing smoothing, `render_dsp_ops` scheduling and
  monitoring. The native instruction loop is removed. Standalone scalar execution
  calls the same function; existing block/SIMD paths remain shared optimizations.
- `valid_engine_op`/`validate_engine_program` serve native preparation and the
  WASM upload check. TS/Rust profile opcode whitelists are removed. Capability
  JSON ships in the crate and is copied to TypeScript with a stale-copy check.
- Native resource descriptions call existing Rust node/sample/image/custom-wave/
  sequencer/Buffer setters and `addDspOp` cache/resource preparation. Missing
  bindings fail off-render. The old no-resource constructor and wire shape stay
  compatible. Resource binding data is opt-in via `nativeProgram`'s third argument.
- Optional context-zero repeat pools preserve legacy dynamic default capacity.
  Explicit budgets cap Spread/drop excess Spawn triggers, count exhaustion, and
  recycle storage. Tests cover grow/shrink, capacity exhaustion, kill/reuse and
  reset with allocation/deallocation counting. There is no blanket RT certification.
- 58 real compiler-generated fixtures compare owned native processing with the
  standalone Rust exports over six blocks, including smoothing changes, reset,
  modulation, effects, media, custom waves, sequencers, Buffer and Spread.
- Actual standalone WASM versus native output is compared separately for 53
  compiled fixtures without external resource bindings. Resource fixtures are
  covered in the Rust comparison; the cross-target harness does not load them.
- Native regressions cover exact controls/MIDI/output offsets, simultaneous held
  notes, pitch bend, transport start/stop/seek/loop, instance isolation and reset.
  Additional reference tests compare legacy MIDI delivery and host positions.
- Builds do not run tests. `hosted/verification/shared-runtime.json` is generated
  by the cross-target harness; packaging includes it only if Rust source and WASM
  hashes still match. Evidence names its scope and is not a hardware claim.

## Remaining migration work

FFT is currently implemented by `dominantSpectrumPeak`/`fftInPlace` in the browser
worklet and writes analyzer output values at its feedback cadence. It is not
just a missing native opcode. Preserve its window, resampling and update timing
with reference fixtures, then move that algorithm and scheduling into shared Rust.
Until then the common capability contract explicitly reports native analysis
unavailable and native preparation reports an actionable diagnostic.

Live graph state migration and output crossfades also have worklet orchestration.
Existing Rust repeat/sample migration helpers are reused by the standalone path;
exposing an owned-instance migration transaction needs a separate tested increment
rather than duplicating their logic in Vira. Native instances currently reset on
replacement as before. Do not claim seamless cross-host hot replacement yet.

macOS-native compilation, audio deadline measurements, full browser editor
isolation and consuming-host migration/verification remain outstanding. Optional
native parallel execution is not enabled; scalar availability is independent of
that optimization. These are explicit next stages, not permanent node exclusions.

Buffer snapshot restoration now also shares Rust's endpoint-aligned interpolation
and length restoration. Reference tests cover sample-rate changes; the native
adapter no longer copies mismatched-rate snapshots without resampling. Standalone
calls the new helper and retains its old loader only for older kernel assets.
Standalone upload preparation still executes in worklet message handling, as
before. Moving that allocation work off the audio thread requires a separate
WASM installation strategy; this refactor does not certify that scheduling.
