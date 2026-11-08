# Spagbol canvas migration: original-editor comparison

Date: 8 November 2026. Baseline: Teia commit `7cc9322` before the Spagbol migration. Candidate: the working migration with the performance fixes described below.

The baseline was extracted to an isolated temporary directory and served from a separate Docker container on port 5188. Its only application change was to seed the default document with `patches/dirty-saw/2026-10-07T13-01-07.047Z.json` (108 nodes and 141 top-level links). Temporary, identical frame/long-task instrumentation was added to both versions, then removed from the candidate. No saved patch was overwritten. The migrated app's temporary interaction-test nodes were undone.

Both runs used Chrome, development builds, the same default theme and single rendering mode, and React/React DOM 19.2.7 with React Flow 12.11.0. The ordinary WASM, SIMD WASM and audio worklet were SHA-256 identical. Playback ran separately, with the other app stopped. The full graph was fitted in each app; different frame geometry produced approximately 13% zoom in both. These are short live browser samples on this machine, not a controlled DSP microbenchmark or a hardware acceptance test.

## Full-graph playback samples

Each row is a two-second visible-tab window after the initial startup spike. `Nodes` includes the candidate's cable-target anchors in addition to graph nodes. React Flow may cull offscreen elements.

| Version | Frames per second | 95th-percentile frame interval | Long tasks | Long-task time | Reported audio CPU | Nodes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Original | 14.5 | 217.1 ms | 15 | 1,799 ms | 109% | 108 |
| Original | 17.0 | 109.2 ms | 17 | 1,710 ms | 104% | 108 |
| Original | 20.0 | 217.3 ms | 20 | 1,823 ms | 103% | 108 |
| Fixed Spagbol | 40.0 | 34.8 ms | 2 | 160 ms | 105% | 129 |
| Fixed Spagbol | 39.5 | 41.7 ms | 2 | 151 ms | 105% | 129 |
| Fixed Spagbol | 36.5 | 42.3 ms | 3 | 234 ms | 105% | 129 |

In these samples the fixed canvas delivered about 2.3 times the median frame rate of the original editor, with substantially shorter stalls. A partial-graph view also delivered approximately 46–51 frames per second. Earlier migrated runs produced repeated maximum-update-depth warnings and sometimes unmounted the entire app; the final playback and slider/undo run produced no new warnings or crashes.

Audio CPU and deadline misses remain a separate limitation: dirty-saw exceeded its audio budget in the original editor too, and both versions accumulated missed deadlines. This comparison does **not** establish improved DSP performance or glitch-free playback. The similar CPU readings and identical kernels do not support attributing that audio load to changed DSP code in the migration. Earlier engine/preparation comparisons are recorded in [the October report](2026-10-15-hosted-facilities-performance.md); they measure different changes and must not be treated as results for this UI migration.

## Source audit and fixes

- The old editor reused node presentations and keyed DSP preparation by execution-relevant data. Preserve both boundaries. Unchanged immutable graph branches, selection and navigation now retain identity; repeated numeric values and selections publish nothing.
- Slider and multi-value edits previously passed through full flow/patch conversions. Ordinary controls now call shared numeric commands directly, and multiple values form one edit. Compatibility callbacks convert only changed nodes. Numeric changes that alter Custom Wave, Crossover or Sequencer port counts refresh and prune those domain ports atomically, including undo. Cached immutable document/node conversions and indexed cable relationships avoid repeated whole-graph walks.
- Audio observations previously replaced a context map for the entire canvas. Keyed subscriptions now update only affected node views, at most once per animation frame. The type-change callback stays stable across buffer/meter messages. Meter peak-hold updates also run outside the React commit phase.
- Memoize the shared renderer and feature configuration. Core validation depends on document changes, independently of app diagnostics. Index port connections once per immutable graph instead of scanning all links and source nodes for every port row.
- Restore the original `onlyRenderVisibleElements` setting. Create cable-target anchors for existing strength links and during connection gestures, rather than mounting an anchor for every cable at rest. Group panel projections are cached for immutable groups.
- Keep original scope-capture visibility checks, visual caches, control scrubbing behavior, DSP structure/value update separation and layout-only compilation suppression. Neither compiler nor audio kernel was changed.
- Explicitly enable Docker/Vite polling: stale transformed modules were observed during retesting even though mounted source files had changed.

## Verification

55 shared-library checks cover existing graph behavior plus identity preservation, no-op updates and batched numeric history. All 312 saved patches must still round-trip and compile equivalently through the Teia codec. Standalone, hosted and minimal-client builds accompany the change.

Browser checks: playback remained mounted; a slider changed during playback and undid successfully; Params showed default/min/max headings and values on one row; Pass used its compact frame with the enable circle; corner actions had spacing and no automatic divider. Temporary nodes and parameter edits were undone. Playback was stopped after testing. Grouping, native hosting and FM-1 hardware were not reverified by this performance pass.

## Slider interaction follow-up

The frame-rate measurements above do not establish slider input latency. A later report of slower sliders during playback prompted a separate drag-path audit and comparison, using isolated ports 5188/5189 and leaving the user's `video-seq-engine` patch untouched.

Additional fixes: retain canonical parameter values instead of overwriting them with the preceding visual frame; use one history gesture per drag/wheel burst; show a local requested value during the interaction and a bounded feedback handoff afterward; preserve derived cable records and unaffected node records; cache immutable port definitions; retain equivalent diagnostic context; memoize native cable renderers and target anchors; reuse unchanged native React Flow records. Live observation updates run at transition priority so they yield to input. Compiler, kernel and smoothing algorithms remain unchanged.

Temporary identical DOM instrumentation compared native drags on the unmodulated `slider_2`, with matching approximately 22-pixel tracks and dirty-saw playing separately in each version. Each drag delivered eight pointer-move events, plus the initial press. In three original-editor drags, the displayed fill matched a requested position once per drag; nine to eleven intervening frames did not match. The final updated runs matched all nine requested positions with no intervening mismatch. Two final updated traces reported median matching input-to-fill intervals of 57.2/50.9 ms, and maxima of 140.2/101.3 ms. These short traces demonstrate improved tracking but do not prove instantaneous response or equal latency to the original: its sparse matching samples make a median-to-median latency comparison invalid. Audio remained over budget in this fixture. Input-to-audio latency was not measured.

A complete drag undid with one Undo action during playback. No browser errors were reported in the final isolated run. The source/diagnostic context and native presentation identity regressions have dedicated checks; the library suite now has 59 checks. All temporary profiling code remains outside the project in disposable test copies. Restart the main editor service and refresh its existing tab to install the updated local package.
