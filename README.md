# Teia Editor

Teia Editor is an audio node editor built from two earlier projects:

- `visual-visual` is the UI blueprint. The canvas, node styling, simple cable controls, selection, panning, grouping/subpatching, expression node, and save/load/import workflow are meant to feel like that app.
- `visual-fm` is the audio lineage. Its Rust/WASM engine is the sound source: oscillators, modulation, filtering, distortion, envelopes, metering, smoothing, and click-free playback all come from that work.

The important design change is that this project is node-first. In `visual-fm`, cables were rich objects that could contain effects and processors. In Teia Editor, audio processing lives in nodes and cables connect node ports; a cable can also receive modulation of its strength, which the compiler lowers through a multiply stage.

The Teia packages are `@pauloricca/teia-editor` (`editor/`), `@pauloricca/teia-kernel` (`kernel/`, built from `rust/teia-kernel/`), and `@pauloricca/teia-runtime` (`runtime/`). `player/` is the separate Teia Player test app, kept in this repository; run `player/start` to build, open, and keep it attached until Ctrl-C. The root `teia` package holds the build scripts and workspaces. Build the kernel with `npm run build:wasm` and the browser runtime with `npm run build:runtime`; the Player vendors a packed Runtime tarball for offline Docker builds.

The editor directory and Docker Compose service were previously named `web`. After updating an existing checkout, stop the old app, run `docker compose down --remove-orphans`, then use `./start --rebuild` (with your usual `--theme` option, if any) to build the image with the new directory path.

XP ZIPs use the `teia-patch` format and `@pauloricca/teia-runtime` identifier. Browser editor state, viewport, and Buffer snapshots use Teia storage names, and new video proxies use the `.teia-proxy.mp4` suffix.

## Patch Model

The current app has one patch at a time. Subpatches can be created and imported, but the runtime compiles a single expanded patch for audio playback.

All signals are mono inside the graph. `Audio Out` has `both`, `left`, and `right` inputs:

- `both` sends the incoming mono signal to both output channels.
- `left` sends it to the left channel.
- `right` sends it to the right channel.

Nodes own the audio behavior. Oscillators generate signals. Filters filter signals. Distortion nodes distort signals. Delay, multiply, meter, scope, and other processors are explicit nodes in the graph.

## Nodes

Most node types are available from the node picker. `Params` appears in the root patch; `Ins` and `Outs` appear while editing subpatches.
When changing an existing node's type, local input values carry over only to inputs with the same name; other inputs use the new node type's defaults.

- `Expression`: evaluates a typed expression and outputs the result as a signal/control value. It supports arithmetic (`+`, `-`, `*`, `/`), comparisons (`<`, `<=`, `>`, `>=`, `==`, `!=`), logical operators (`&&`, `||`, `!`), and numeric booleans: `true` and successful conditions output `1`, while `false` and failed conditions output `0`. Any nonzero signal is truthy in a logical expression.
- `Group`: wraps a subpatch so a reusable patch can live inside a single node. An Area inside the subpatch named `UI` or `Controls` (case-insensitive) exposes its contained nodes as a control panel above the Group's unchanged input/output ports. Projected control values are local to each Group instance while subpatch structure and defaults remain shared between clones.
- `Spread`: repeats the nodes placed inside its resizable area at runtime.
- `Spawn`: creates a new, independent runtime copy of the nodes inside its resizable area on each trigger.
- `Ins`: exposes subpatch input ports while editing a subpatch.
- `Params`: exposes named external parameters in the root patch. Drag a connection from a destination input to its temporary output to add a parameter; rename and reorder it like an `Ins` output, and set its default, min, and max in three aligned columns (initially 0, 0, and 1). You can disable `Params` while editing to mute its links; package export enables it in the exported patch and compiled program. Exported packages list each parameter's node ID, port name, default, min, max, and compiled value index.
- `Outs`: exposes subpatch output ports while editing a subpatch.

Click the grey `new input`, `new param`, or `new output` label beneath an `Ins`, `Params`, or `Outs` node's ports and enter a name to add a port. Leaving the name blank adds nothing. Dragging a new link or reconnecting an existing link endpoint onto the temporary port also creates the corresponding input, external parameter, or output.

- `Audio Out`: sends mono graph signals to the stereo hardware output via `both`, `left`, or `right`, with a final `level` control.
- `Sine Osc`: generates a sine oscillator signal with frequency, phase, phase-reset, and output-range controls.
- `Triangle Osc`: generates a triangle oscillator signal with frequency, phase, phase-reset, and output-range controls.
- `Saw Osc`: generates a saw oscillator signal with frequency, phase, phase-reset, and output-range controls.
- `Ramp Osc`: generates a ramp oscillator signal with frequency, phase, phase-reset, and output-range controls.
- `Square Osc`: generates a square oscillator signal with frequency, phase, phase-reset, pulse-width, and output-range controls. `pulse width` sets the fraction of each cycle spent at the high level, from `0` to `1`, and defaults to `0.5`.
- `Kink Osc`: generates a direct-formula oscillator with `frequency`, `phase`, `phase reset`, `shape`, `squareness`, `range min`, and `range max` inputs and a `signal` output. `shape` ranges from `-1` to `1` and defaults to `0`, giving a triangle; `-1` and `1` produce rising and falling ramps. `squareness` ranges from `-1` to `1` and defaults to `0`, where the slopes are straight; positive and negative values bend and sharpen them in opposite directions. `shape` keeps the turning point fixed throughout the squareness sweep. At either squareness extreme the output becomes a pulse wave whose duty follows `shape`: `shape` at `0` gives a 50% square wave, while `shape` at `-1` or `1` gives a constant level. The signs of `squareness` reverse polarity. A graph at the top of the node previews the waveform from its current `shape` and `squareness` values.
- `Sample Hold`: samples an incoming signal when triggered and holds that value.
- `Perlin Noise`: generates smooth noise at a controllable speed.
- `Noise`: generates raw noise.
- `Random`: generates and holds an independent random value when playback starts, then generates a new value on each rising edge at `trigger`. Each node has its own random sequence, and playback restarts reseed all Random nodes. `rangeMin` and `rangeMax` map the held value to the requested range.
- `Audio Input`: brings a microphone or input device into the patch with gain/level controls. `signal` preserves the legacy stereo average; `left` and `right` expose separate channels (a mono device feeds both). In hosted mode, the host supplies audio and owns devices.
- `Custom Wave`: generates editable breakpoint waveforms with loop, one-shot, ping-pong, and sustain modes. Its non-connectable `mode` input uses the shared input-control layout and selects that playback mode. Its `count` input (1–8) creates independent waves in one node: numbered, color-coded buttons select the curve to edit, with a unique colour for each of the eight possible waves; inactive curves remain as faded colored outlines. At counts above one, the node exposes `signal 1` through `signal N` outputs instead of the single header `signal` output. Select a curve with its numbered button, or—when the Custom Wave node is selected and no editable field is focused—press `1` through `8`. `subdivisions` (1–64, default `8`) sets the exact number of visible graph-grid columns. `subgroups` (1–64, default `4`) alternates each group of that many columns between normal and grey backgrounds, like a sequencer grid. Its `end trigger` output emits a one-sample pulse when playback completes: at each wrap in loop modes, after the return trip in ping-pong modes, at the hold point in sustain mode, and at the endpoint in one-shot mode. Retriggering resets playback without producing an end pulse. Its `baseLevel` input (default `0`) sets the locked start/end points and the value held while a one-shot is idle or complete, clamping to the configured output range when necessary. When its local `frequency` is below 20 Hz, the editor shows a faint one-pixel vertical playback line, making the slow cycle easier to follow. Its scope-style grid shows that range; zooming into the canvas reveals denser grid divisions and more scale labels while the grid stays screen-thin, and both waveform strokes and labels stay screen-relative with a small capped size increase at high zoom for legibility. Edit points retain their screen-relative size down to 70% canvas zoom, then progressively shrink to avoid overwhelming the waveform when zoomed farther out. Hovering or dragging an edit point shows its value in the configured Y-axis range. Saved curve points remain normalized and range-independent. Point drags update the live DSP at a limited rate, morph smoothly between curve revisions without rebuilding the graph, and always commit the final position after release.
- `Sample`: plays a selected, uploaded, or microphone-recorded sample with frequency/original-frequency pitch tracking, trigger, polyphony, region, envelope, stretch, granular-style mode, and level controls. `frequency` defaults to `440` Hz. The picker accepts audio files and MP4 video files up to 1 GB. MP4 uploads retain the original file in `samples/` and use `ffmpeg` to create a maximum 640×480 H.264/AAC editor proxy beside it. Every proxy frame is a keyframe for fast arbitrary-frame seeking, and its MP4 metadata is placed at the front for quick loading. The Sample node selects the proxy, decodes and plays its audio track, and shows its video above the waveform; the original filename and URL remain in the saved asset metadata for full-quality video work. Existing MP4 files without a proxy continue to load directly and require browser support for their embedded audio and video codecs. While idle, the preview follows the sample's `start` position, including while its boundary is dragged. A warm decoder pre-seeks that position and keeps a small cache of recently decoded start frames so repeated sequencer jumps can display immediately. During playback it follows the DSP playhead exactly, including reverse or stretched playback; when voices overlap, it follows the most recently triggered voice. Positive frequency plays from `start` to `end`; negative frequency swaps the effective boundaries and plays from `end` to `start`; zero pauses the playhead. Active voices appear as playheads on the sample waveform, and stopping audio clears them. Structural DSP edits preserve active playback for unchanged Sample nodes, including their voice positions, envelopes, and stretch state. With `voices` set to `1`, playback follows live parameter changes; with more than one voice, each voice keeps the parameter values captured by its trigger. The sample picker can record from the microphone; stopping converts the capture to PCM WAV, prompts for a name, saves the `.wav` file in `samples/`, and selects it for the node.
- `Image`: samples brightness, RGB, hue, and saturation from an uploaded image at an `x`/`y` position.
- `Buffer`: records and plays a rolling audio buffer from signal, playhead, record-head, speed, and length controls. `playhead speed` and `record head speed` are independent rates where `1` is real time, `0` pauses, and negative values run backward. An incoming connection to `playhead` or `record head` overrides that head's speed and follows the connected position instead; without a connection, the corresponding position value is the starting point after reset. Its resizable waveform shows the current playhead and red record head; the `CLEAR` button in its lower-right corner empties the recording immediately. Each sample is recorded before the main `signal` output is read, so coincident playhead and record-head positions return the newly written sample. `record head out` still reads the existing sample at the record head before the new sample is written, enabling overdub and feedback patches. `on reset` can clear the recording on each transport reset or preserve it between plays. Cloning a Buffer with Alt-drag or copy/paste copies its current recording into independent buffer memory, so subsequent recording changes do not affect the source. Preserved contents on ordinary and Group-contained Buffer nodes are checkpointed to IndexedDB every five seconds while audio runs, when audio stops, and when the page becomes hidden, then restored after a refresh. Per-item Spread and per-instance Spawn Buffer contents remain runtime-only because those dynamic copies do not have stable patch identities. Changing a non-silent Buffer node's type to Sample asks whether to use its content and lets you name the WAV: `Yes` saves it in `samples/` and preselects it, while `No` converts without creating an asset. An empty all-zero buffer converts directly.
- `Playhead`: outputs a wrapping playback position from `0` to `1`. `length` sets the cycle duration in seconds, `speed` is a playback-rate multiplier (`1` is real time, `2` is double speed, and negative values run backward), and `start` offsets the normalized starting position. A rising edge at `reset trigger` returns the playhead to `start`.
- `Time`: outputs elapsed time in seconds.
- `freq2length`: converts a frequency in hertz to the duration in seconds of one full cycle (`1 / frequency`).
- `length2freq`: converts the duration in seconds of one full cycle back to frequency in hertz (`1 / length`).
- `Constant`: outputs a fixed numeric value.
- `Pass`: passes a signal through unchanged.
- `Send` and `Receive`: route an audio or control signal without drawing a cable between the two nodes. Set both nodes to the same non-connectable integer `number` from 1–10. Routing is local to the current patch. Each Group, including a nested Group, has its own routing scope: its Sends and Receives cannot reach matching numbers in a parent patch or another Group. One Send can feed any number of Receives in its patch; Sends that share a number are summed. FM-1 supports these routes through the same graph compiler: a single source reuses its signal register, multiple sources use existing addition instructions, and an unmatched Receive outputs zero. No firmware update is needed specifically for Send/Receive; normal FM-1 node restrictions and resource limits still apply. When deselected, Send appears as a filled equilateral triangle pointing right, with a vertical left edge, and Receive as a filled circle. Both show a slightly enlarged channel number centered inside in contrasting black text, and each number has a consistent unique color. Route glows and link highlighting follow signal direction: selecting a Send highlights that Send's own incoming link and the matching Receives with their outgoing links, but not parallel Sends; selecting a Receive highlights that Receive's own outgoing link and matching Sends with their incoming links, but not parallel Receives. Selecting an ordinary node or link connected to either side extends the same directional highlighting through that route, including chained Send/Receive routes.
- `Slider`: provides a playable UI control, optionally driven by MIDI CC, that outputs a mapped signal and its `inverse`. Its bipolar `curve` input shapes the normalized slider value before mapping: `0` is linear, negative values start slower, and positive values start faster; each whole step squares or square-roots the response. MIDI CC changes become the slider's saved value, so they survive unrelated graph edits and recompilation. Its optional `signal` and `inverse signal` inputs crossfade in opposite directions: with only `signal` connected, the main output rises from `0` to that signal while `inverse` falls to `0`; with `inverse signal` connected, it instead feeds the main output at `0` and `inverse` at `1`. With neither input connected, the two outputs mirror the selected range. Hold Cmd/Ctrl at any point during a drag for five-times-finer movement; releasing it preserves the current value and continues from a cursor-relative offset instead of snapping to the pointer. Hovering the node shows its live mapped output followed by its normalized `0`–`1` value in parentheses, including updates from the slider, MIDI, or a connected `value` input. On FM-1, the saved value is used when unconnected; `value`, `curve`, `min`, `max`, `signal`, and `inverse signal` connections remain dynamic. Manual UI and MIDI CC interaction are unavailable, and curves use approximate fixed-point power.
- `Joystick`: provides a resizable two-dimensional UI control whose draggable square outputs independently mapped `x` and `y` positions plus `x inverse` and `y inverse`. Each inverse mirrors its corresponding axis range. Each axis has its own min/max range and optional MIDI channel/CC mapping; MIDI changes become the saved position for that axis. The square's normalized position runs from `0` at left/bottom to `1` at right/top. `elasticity` defaults to `0`, which leaves the square where it is released; positive values return it to the centre at that normalized-unit-per-second speed, with larger values returning faster.
- `Button`: provides a playable UI button, optionally driven by MIDI CC, for gate/toggle/trigger-style control. MIDI changes update its saved gate, toggle, or trigger count, so they survive unrelated graph edits and recompilation. Its optional `signal` and `inverse signal` inputs crossfade in opposite directions: with only `signal` connected, the main output is that signal while on and `inverse` is that signal while off; `inverse signal` instead feeds the main output while off and `inverse` while on. Its saved state is applied immediately when playback starts, so it does not suppress an initial incoming trigger; later changes retain the short crossfade. With neither input connected, `signal` and `inverse` are complementary `0`/`1` gates. On FM-1, gate/toggle modes retain the saved on/off state and trigger mode stays idle; connected signals and complementary routing remain live, but UI and MIDI CC interaction are unavailable.
- `Keys`: provides an on-canvas keyboard with configurable size and starting MIDI note, outputting MIDI note and frequency. `mode` defaults to `gate`, which outputs the note only while its key is pressed; `hold` keeps the selected note visibly pressed after release until another key is pressed or the same key is pressed again to clear it. `glide` sets the seconds to transition between two pressed-note frequencies; it defaults to `0`, leaves `midi note` immediate, and does not glide note-on or note-off.
- `Sequencer`: offers Trigger mode for the original clickable pulse grid and Gate mode for freely positioned, edge-resizable intervals. Each row has a compact editable label beside its output pin, initially numbered `1`, `2`, `3`…; click a label to rename it. The shared label column and the node expand only as far as the widest label requires, leaving the square pattern cells unchanged. Clicking to create a gate snaps its start to the leading edge of the selected grid square. Gates in a row never overlap: creating, moving, and resizing stops at neighboring gates, creation uses the available gap when it is shorter than a full step, and mode conversion resolves overlaps by shortening the earlier gate's end. Drag a step's top edge down to lower its velocity from `1` to a minimum of `0.1`, so the row output emits that smaller value when the step triggers or gates; `signal` advances the sequence, `reset` restarts it, each row has its own output, and `trigger index` emits the 1-based index of the first active row. Pattern, timing, velocity, length, and Trigger/Gate mode edits update the running sequencer in place without resetting its playhead or recompiling the DSP graph; changing the row count still recompiles because it changes the node's output ports.
- `Roll`: is a scale-aware piano roll centred on a selectable `middle note` (full octave notation). `range down` and `range up` choose the number of scale rows below and above it. Gates are saved by signed row index relative to that middle row, so changing the middle note transposes the complete pattern and changing the scale remaps it without deleting or shifting steps. Click a grid cell to add a gate-length note; drag its body sideways to move it, or drag either edge to resize it. `steps` sets the grid width, `beat length` controls alternating beat subdivisions, and `step length` is the initial length of newly created notes. It is advanced by `signal`, restarted by `reset`, and exposes live `note` and `gate` outputs plus an event bundle: `note on` (identical to `trigger`), `frequency`, and `velocity` are queued, sample-aligned note-on values; `note off` is a queued matching-note event. Every event is followed by a zero frame, so chords can create separate Spawn instances. Connect `note on` to a Spawn `trigger`, `note off` to `release trigger`, and use `note on`/`trigger` to sample-and-hold the aligned frequency and velocity within the Spawn.
- `Tempo`: outputs clock triggers and matching frequency values from 4-bar divisions down to thirty-seconds, with BPM, swing, internal/MIDI source, and MIDI-source selection.
- `MIDI Note`: tracks the most recently pressed held note as a monophonic note, frequency, velocity, gate, and note-on trigger source.
- `MIDI Note On`: emits queued one-sample note, frequency, and velocity values for MIDI note-on events, with zero-valued separator samples between events.
- `MIDI Note Off`: emits queued one-sample note and frequency values for MIDI note-off events, with zero-valued separator samples between events.
- `MIDI Note On Send`: sends a MIDI note-on message to every output selected in MIDI settings when its connection-only `trigger` input rises. `note`, `velocity`, and `channel` set the outgoing message.
- `MIDI Note Off Send`: sends a MIDI note-off message to every output selected in MIDI settings when its connection-only `trigger` input rises. `note`, `velocity`, and `channel` set the outgoing message.
- `MIDI CC Send`: sends a MIDI control-change message to every output selected in MIDI settings. `signal` is clamped to `0`–`1` and mapped to the MIDI value range. With `trigger` connected it sends only on rising triggers; otherwise it sends whenever the quantized signal value changes. `throttle` sets the minimum interval between messages in seconds and defaults to `0.1`; untriggered changes during that interval are coalesced to the latest value.
- `MIDI CC`: outputs the current value of a selected MIDI CC.
- `Selector`: selects one of several input values and can glide between selections.
- `Accumulator`: steps through a min/max range by a configurable, floating-point increment, either on trigger edges or continuously for every audio sample.
- `Quantise`: snaps incoming frequency values in Hz to the nearest note in a selected scale and root, preserving the sign for reverse-playback frequency signals. Scale choices include chromatic, major, minor, modal, pentatonic, blues, whole-tone, and diminished scales; roots use note-and-octave labels such as `C1` and `F#3`.
- `Abs`: outputs the absolute value of the input signal.
- `Map`: remaps a signal from one numeric range to another.
- `Clamp`: limits a signal to a minimum and maximum.
- `Multiply`: multiplies a signal by a factor.
- `pow`: raises the signal to an exponent.
- `Pan`: splits a signal into equal-power `left` and `right` outputs from a `pan` value, where `-1` is left, `0` is center, and `1` is right.
- `Delay`: applies delay with time, feedback, and wet/dry mix controls. Feedback ranges from `0` to `2`; values above `1` make each repeat grow until the delay signal reaches its safety limit. A time of `0` bypasses the delay; positive times resolve to at least one audio sample.
- `Chorus`: applies a modulated delay chorus effect.
- `Reverb`: the `mode` dropdown selects `original` (the existing reverb, default), `dattorro plate`, or `feedback delay network`. All three share `size`, `decay`, and `mix` controls and `left`/`right` outputs. Original preserves the previous sound and identical left/right signal, including for saved patches without a mode. The plate and eight-line FDN produce distinct stereo channels; connect both outputs for stereo. Changing mode resets the tail. In the new modes, size controls the delay lengths, decay controls the nominal low-frequency tail (roughly 0.2–16 seconds across the editor range), and fixed high-frequency damping darkens the tail. Delay lengths scale with sample rate; at high rates the network is shortened to fit the existing effect memory budget. The plate uses an original Rust implementation of [Dattorro’s figure-of-eight design](https://ccrma.stanford.edu/~dattorro/EffectDesignPart1.pdf), with input diffusion and modulated tank allpasses. The FDN uses input diffusion, eight modulated delays, and a normalized Hadamard feedback matrix. Both run inside the shared Rust/WASM engine, including independent Spawn/Spread instances. All Reverb modes remain unsupported on FM-1.
- `Compress`: applies dynamics compression with optional sidechain, threshold, ratio, attack, release, knee, and makeup controls.
- `Limiter`: applies lookahead limiting with input gain, ceiling, release, and lookahead controls.
- `Envelope`: creates an envelope with trigger/gate inputs and delay, attack, decay, sustain, gate-length, and release controls. Its unconnected `signal` input defaults to a constant level of `1`, so the envelope can directly modulate any parameter. It stays closed while both event inputs are idle or unconnected, opens on a trigger or gate, and its `end trigger` output emits a one-sample pulse when the release stage finishes. For a trigger-only envelope, gate length is measured from the trigger edge and includes delay, attack, and decay; a high gate input instead holds the envelope open until the gate falls.
- `Follower`: follows the amplitude contour of a signal with attack/release smoothing.
- `Remove DC`: removes steady DC offset from a signal with a fixed 10 Hz high-pass response.
- `Fold`: folds a signal back on itself for wavefolding.
- `Meter`: measures a signal level for display and downstream control. It uses the shared adaptive chart grid: resizing or canvas zoom changes the grid and legend detail while preserving thin screen-relative chart strokes and legible labels.
- `Scope`: shows an oscilloscope-style view of the signal. Its `reset` selector defaults to `zero-crossing`, aligning each displayed trace to the strongest upward zero crossing for a stable waveform even when a complex wave crosses zero several times per cycle; choose `none` for a continuously rolling window. Canvas zoom increases its grid and scale-label detail while preserving thin screen-relative chart strokes, with a small capped label-size increase at high zoom. The small full screen icon at the top-right of the scope opens a live green trace on a black browser fullscreen background, with no grid, labels, or controls. Fullscreen increases the trace from 160 to 512 displayed points, preserving the selected time window and zero-crossing alignment; press `Esc` to return to the editor and restore the compact resolution. Scope capture pauses while the node is outside the visible canvas, then resumes when it returns; its `signal` output is unaffected.
- `FFT`: analyses an input signal and shows its live frequency spectrum as logarithmically grouped bars in a wide, resizable display. `minFreq` and `maxFreq` set an analysis window from 20 Hz to 20 kHz; drag the two coloured boundaries directly on the chart to adjust them. The full spectrum is still calculated for display while bars outside the window fade. Its frequency grid and legends adapt to node size and canvas zoom through the same shared chart grid as Meter. The `frequency` output reports the strongest spectral frequency inside the selected window in hertz, and `amplitude` reports that frequency's linear amplitude at visualization/control rate. If the window contains no measurable spectral energy, both outputs are `0`. An FFT with neither output connected pauses its visual analysis while off-screen; connected outputs keep analysis running so the patch signal is unchanged.
- `Lowpass Filter`: filters out frequencies above the cutoff.
- `Highpass Filter`: filters out frequencies below the cutoff.
- `Bandpass Filter`: keeps frequencies around the cutoff and attenuates the rest.
- `Allpass Filter`: shifts phase around the cutoff while preserving the level of steady frequencies. `resonance` sets the width of the phase transition (Q); it defaults to `0.7`.
- `Crossover`: splits a signal into frequency bands. Set `points` from 1 to 8, choose the `slope` (12, 24, 36, or 48 dB/octave), and set each crossover frequency. It provides one `band` output below, between, or above the crossover frequencies for each band.
- `Equaliser`: shapes a signal with independent low, mid, and high gain controls (in dB).
- `Formant Filter`: applies a vowel/formant-style filter with morph and intensity controls.
- `Comb Filter`: applies a resonant comb filter tuned by frequency and feedback.
- `Comb Notch`: applies a comb-style notch filter tuned by frequency and feedback.
- `Hard Clip`: clips a signal sharply for hard distortion.
- `Soft Clip`: clips a signal smoothly for warmer distortion.
- `Fuzz`: applies fuzz-style distortion.
- `Saturate`: applies saturation-style distortion.
- `Wavefold`: applies wavefolding distortion.

### Node signatures

The signature notation below is `inputs -> outputs`. Port names are the names used by patch links. On standard nodes, an output named `signal` stays on the header even when the node has additional outputs; those additional outputs remain in the body. `Expression`, `Group`, `Ins`, `Params`, and `Outs` have patch-defined ports; Sequencer row outputs and Selector value inputs also expand dynamically.

| Node | Inputs | Outputs |
| --- | --- | --- |
| Expression | dynamic expression variables | `value` |
| Group | dynamic subpatch inputs | dynamic subpatch outputs |
| Spread | count | item index |
| Spawn | `trigger`, `release trigger`, internal-only `kill trigger` | internal-only `instance gate` |
| Ins | — | dynamic subpatch inputs |
| Params | — | dynamic external parameters |
| Outs | dynamic subpatch outputs | — |
| Audio Out | `both`, `left`, `right`, `level` | — |
| Sine Osc | `frequency`, `phase`, `phaseReset`, `rangeMin`, `rangeMax` | `signal` |
| Triangle Osc | `frequency`, `phase`, `phaseReset`, `rangeMin`, `rangeMax` | `signal` |
| Saw Osc | `frequency`, `phase`, `phaseReset`, `rangeMin`, `rangeMax` | `signal` |
| Ramp Osc | `frequency`, `phase`, `phaseReset`, `rangeMin`, `rangeMax` | `signal` |
| Square Osc | `frequency`, `phase`, `phaseReset`, `pulse width`, `rangeMin`, `rangeMax` | `signal` |
| Sample Hold | `signal`, `trigger` | `signal` |
| Perlin Noise | `speed`, `rangeMin`, `rangeMax` | `signal` |
| Noise | `rangeMin`, `rangeMax` | `signal` |
| Random | `trigger`, `rangeMin`, `rangeMax` | `signal` |
| Audio Input | `gain`, `level` | `signal`, `left`, `right` |
| Custom Wave | `mode`, `frequency`, `phase`, `trigger`, `count`, `subdivisions`, `subgroups`, `baseLevel`, `rangeMin`, `rangeMax` | `signal`, `end trigger` (count 1); `signal 1`…`signal N`, `end trigger` (count >1) |
| Sample | `frequency`, `originalFrequency`, `trigger`, `voices`, `start`, `end`, `attack`, `release`, `stretch`, `cycleLength`, `overlapRatio`, `mode`, `level` | `signal` |
| Image | `x`, `y` | `brightness`, `r`, `g`, `b`, `hue`, `saturation` |
| Buffer | `signal`, `playhead`, `playhead speed`, `record head`, `record head speed`, `length`, `on reset` | `signal`, `record head out` |
| Playhead | `start`, `speed`, `length`, `reset trigger` | `playhead` |
| Time | — | `seconds` |
| freq2length | `frequency` | `length` |
| length2freq | `length` | `frequency` |
| Constant | `value` | `signal` |
| Pass | `signal` | `signal` |
| Send | `signal`, `number` (1–10) | — |
| Receive | `number` (1–10) | `signal` |
| Slider | `signal`, `inverse signal`, `value`, `curve`, `min`, `max`, `direction`, `midiChannel`, `midiCc` | `signal`, `inverse` |
| Joystick | `xMin`, `xMax`, `xMidiChannel`, `xMidiCc`, `yMin`, `yMax`, `yMidiChannel`, `yMidiCc`, `elasticity` | `x`, `x inverse`, `y`, `y inverse` |
| Button | `signal`, `inverse signal`, `mode`, `midiChannel`, `midiCc` | `signal`, `inverse` |
| Keys | `size`, `startNote`, `mode`, `glide` | `midi note`, `frequency` |
| Sequencer | `steps`, `rows`, `beat length`, `mode`, `signal`, `reset` | row outputs `1`…`16` (according to `rows`), `trigger index` |
| Roll | `steps`, `beat length`, `step length`, `scale`, `middle note`, `range down`, `range up`, `signal`, `reset` | `note`, `frequency`, `velocity`, `gate`, `trigger`, `note on`, `note off` |
| Tempo | `bpm`, `swing`, `source`, `midiSource` | `4 bar`, `2 bar`, `bar`, `whole`, `half`, `quarter / beat`, `upbeat`, `eighth`, `sixteenth`, `thirty-second`, plus a matching `… freq` output for each |
| MIDI Note | `channel` | `note`, `frequency`, `velocity`, `gate`, `trigger` |
| MIDI Note On | `channel` | `note`, `frequency`, `velocity` |
| MIDI Note Off | `channel` | `note`, `frequency` |
| MIDI Note On Send | `trigger`, `note`, `velocity`, `channel` | — |
| MIDI Note Off Send | `trigger`, `note`, `velocity`, `channel` | — |
| MIDI CC Send | `signal`, `trigger`, `cc`, `channel`, `throttle` | — |
| MIDI CC | `channel`, `cc` | `signal` |
| Selector | `select`, `slide`, dynamic value inputs `1`… | `signal` |
| Accumulator | `mode`, `trigger`, `reset`, `increment`, `min`, `max` | `signal` |
| Quantise | `signal`, `scale`, `root` (pitch class) | `signal` |
| Abs | `signal` | `signal` |
| Map | `signal`, `srcMin`, `srcMax`, `trgtMin`, `trgtMax` | `signal` |
| Clamp | `signal`, `min`, `max` | `signal` |
| Multiply | `signal`, `factor` | `signal` |
| pow | `signal`, `exponent` | `signal` |
| Pan | `signal`, `pan` | `left`, `right` |
| Delay | `signal`, `time`, `feedback`, `mix` | `signal` |
| Chorus | `signal`, `rate`, `depth`, `mix` | `signal` |
| Reverb | `signal`, `mode`, `size`, `decay`, `mix` | `left`, `right` |
| Compress | `signal`, `sidechain`, `threshold`, `ratio`, `attack`, `release`, `knee`, `makeup` | `signal` |
| Limiter | `signal`, `inputGain`, `ceiling`, `release`, `lookahead` | `signal` |
| Envelope | `signal`, `trigger`, `gate`, `delay`, `attack`, `decay`, `sustain`, `gateLength`, `release` | `signal`, `end trigger` |
| Follower | `signal`, `attack`, `release` | `signal` |
| Remove DC | `signal` | `signal` |
| Fold | `signal`, `amount` | `signal` |
| Meter | `signal`, `range`, `mode` | `signal` |
| Scope | `signal`, `range`, `mode`, `length`, `reset` | `signal` |
| FFT | `signal`, `minFreq`, `maxFreq` | `frequency`, `amplitude` |
| Lowpass Filter | `signal`, `cutoff`, `resonance` | `signal` |
| Highpass Filter | `signal`, `cutoff`, `resonance` | `signal` |
| Bandpass Filter | `signal`, `cutoff`, `resonance` | `signal` |
| Allpass Filter | `signal`, `cutoff`, `resonance` | `signal` |
| Crossover | `signal`, `points`, `slope`, `frequency 1` … `frequency points` | `band 1` … `band points + 1` |
| Equaliser | `signal`, `lows`, `mids`, `highs` | `signal` |
| Formant Filter | `signal`, `morph`, `intensity` | `signal` |
| Comb Filter | `signal`, `frequency`, `feedback` | `signal` |
| Comb Notch | `signal`, `frequency`, `feedback` | `signal` |
| Hard Clip | `signal`, `drive` | `signal` |
| Soft Clip | `signal`, `drive` | `signal` |
| Fuzz | `signal`, `drive` | `signal` |
| Saturate | `signal`, `drive` | `signal` |
| Wavefold | `signal`, `drive` | `signal` |

## Links

While dragging or reconnecting a cable, the entire collapsed Send triangle or Receive circle is an invisible drop target for its signal port. Cable endpoints stay anchored at the edge of the icon; ordinary icon dragging is unchanged.

Highlighted virtual Send/Receive connections show glowing curves in their channel number's color between the participating Send and Receive nodes. These curves follow the directional selection path, disappear when that path is no longer highlighted, and are display-only: they cannot be selected or edited and are not saved as patch links.

Selection highlighting includes strength-modulation connections. Selecting a node traces its outgoing connections through Send/Receive routes, including Receive outputs attached to cables. Selecting a cable highlights both the cables feeding its strength and the cable it modulates, recursively, following upstream and downstream Send/Receive routes in their respective directions. This adds visual emphasis without selecting those related cables or opening their controls; unrelated route branches and other modulators of a downstream cable remain dimmed.

Every link has:

- `weight`: the cable amplitude/control amount.
- `mode`: one of `set`, `add`, `multiply`, or `bend`.

The link value is:

```text
linkValue = sourceOutput * weight
```

When several links connect to the same input, Teia Editor follows the same rule as `visual-visual`:

```text
setBase = average(all set link values), if any set links exist
setBase = the node's local input value, if there are no set links

afterAdd = setBase + sum(all add link values)

afterMultiply = afterAdd * product(all multiply link values)
finalValue = afterMultiply * 2^(sum(all bend link values))
```

This formula describes the combination before numeric bounds. The compiled engine
loads values and bounds each arithmetic result to ±12,000. It applies bends
individually in saved link order, bounding each `2^value` ratio to 12,000 before
multiplication. Consequently, clipping can prevent opposing links from cancelling
and can affect a sum before it is divided to form a set average. FM-1 firmware 913
matches these instruction boundaries; its Q16.16 precision still rounds small
values and can lose very small bend ratios.

So:

- `set` replaces the node's local value. Multiple `set` links are averaged.
- `add` adds to the local value or to the averaged `set` value.
- `multiply` multiplies the result after `set` and `add`.
- `bend` applies reciprocal scaling after `multiply`: a weighted value of `+1` doubles the result, `-1` halves it, and `0` leaves it unchanged. Link weight controls the strength, so the exponent is `source value × link weight`.

When an input has an enabled `set` link whose endpoints are both enabled, its numeric field is greyed out to show that its local value is currently replaced. The field remains editable, so its value is ready if the set link is disabled, removed, or changed to another mode. Hold Shift or Option/Alt while scrolling or making a two-finger trackpad gesture over a numeric field to adjust it vertically with the same sensitivity and modifier keys as vertical dragging; unmodified scrolling continues to pan the canvas. The same modified gesture over a Slider changes it relative to its current value, without jumping toward the pointer position: horizontal sliders follow horizontal movement and vertical sliders follow vertical movement. Cmd/Ctrl is five-times-finer; holding both Shift and Option/Alt is three-times-finer.

While dragging a new link, press `a` to create it in `add` mode, `b` for `bend` mode, `m` for `multiply` mode, or `s` for `set` mode (the default). The live link changes colour to preview the selected mode.

To modulate a link's strength, start dragging from an output pin and drop on the body of an existing link. The target uses the normal selected-link highlight while hovered, even when other links are dimmed. Node pins take priority: hovering or dropping on an input pin connects to that input and does not target an existing cable. The new connection ends at the target link's midpoint and has the usual selection, weight, mode, enable, and deletion controls. Only one connection from a particular output to a particular link is allowed.

Selecting a strength-modulation link shows a small circular input at its attached end. Drag that circle to another link to reconnect it, or to a node input to turn it into an ordinary input connection. Escape or a drop on empty space cancels the move. A link cannot target itself or one of its own strength-modulation descendants.

Both the circle and ordinary node endpoints use the same reconnection controller, including input snapping, connection validation, canvas auto-pan, and the Cmd/Ctrl/Alt duplicate gesture.

You can also drag an existing ordinary link's input endpoint off a node and drop it onto another cable to make it a strength connection. It keeps its mode, strength, and enabled state. Node pins still take priority over nearby cables, and the usual Cmd/Ctrl/Alt reconnect gesture keeps the original and creates a copy.

Strength modulation uses the same `set`, `add`, `multiply`, or `bend` rules as node inputs. The target link's saved weight is the starting value for `add`, `multiply`, and `bend`; a `set` connection replaces it. The compiler inserts a Multiply stage: source to `signal` uses `set` with weight `1`, strength modulation feeds `factor`, and the output retains the target link's original mode with weight `1`. Group boundaries resolve these generated connections like ordinary inputs. Disabling the original source disables its generated stage too. Strength connections are preserved in saved patches, nested groups, copies, and when inserting a node into their target link. Grouping routes unweighted sources through boundary ports and applies each original link's mode and strength once at its destination.

Drag either endpoint of an existing link to reconnect that endpoint. Compact nodes temporarily reveal their ports while the link is dragged over them, just as they do when creating a link. This works directly on all pins, including the internal `instance gate` and `kill trigger` pins in an expanded Spawn; holding Cmd, Ctrl, or Alt retains the original link and creates the reconnected link as a duplicate.

This order matters. A frequency input with a local value of `80`, an `add` link carrying `1`, and no other links resolves to roughly `81`. A `set` link carrying a slow oscillator around `-1..1` sets the input near those values, rather than multiplying the local `80`.

Static values from nodes like `Constant` and static `Expression` outputs are folded by the compiler. Audio-rate values are lowered onto the `visual-fm` WASM modulation lanes, preserving the engine's smoothing and click-free behavior.

Feedback links introduce a one-sample delay so cyclic graphs can retain values. Feedback state and DSP values preserve every finite numeric value without an audio-amplitude limit, making them suitable for control values such as frequency as well as audio. A non-finite result is reset to `0` so the graph can recover. Scope `range` only bounds the visual plot; it does not limit the underlying signal.

## Areas

Create a visual area by Cmd/Ctrl-dragging on the canvas, or choose `Area` from a node's type dropdown to replace that node with an area at the same position and size. This conversion removes the node's links and is one-way because areas do not have node type dropdowns. Drag an area by any empty part of its header or by its title. Alt-drag an Area, Spread, or Spawn to clone the complete container hierarchy and its contained graph; add Cmd, Ctrl, or Shift to retain links between the cloned nodes and nodes outside the container. Click its title without dragging to edit it and select the whole name, ready to replace; double-clicking the title also selects its text without collapsing the area, and leaving an empty title when editing finishes restores `Area`. Expanding, selecting, moving, or interacting with an Area, Spread, or Spawn raises the container and all of its contained nodes above unrelated canvas content while preserving their internal layer order; interacting elsewhere then applies the normal selection and recency layering rules. An area or node belongs inside another area only when its top-left corner is inside it, so touching edges and other partial overlaps do not link their movement. Locking an Area, Spread, or Spawn freezes both its node membership and nested-container membership at that moment: nodes or containers created or moved into its bounds afterward do not move with it. Locked resize handles cannot cross the full visual bounds of the snapshotted member nodes; unlocked containers retain unrestricted resizing and live top-left-corner membership. Drag the lower edge of an expanded area header to make a dashed UI section for user-facing controls such as sliders and sequencers. When the area is collapsed, that UI section remains visible and usable, while the lower functional section is hidden. UI nodes become display-only: their pins, node editing, moving, and resizing are disabled. External cables belonging to actual member nodes are presented at the area header instead; merely overlapping a locked Area, Spread, or Spawn does not reroute a node's cables.

Areas are stored at the patch level, so subpatches keep independent area layouts. Inside a Group subpatch, name an Area exactly `UI` or `Controls` (ignoring case) to expose every member node on the parent Group. A panel matching the Area's content bounds, excluding its header, appears above the Group's normal ports. Projected nodes remain usable as controls and retain live visual feedback, while pins, type editing, movement, and resizing stay disabled. MIDI CC learning works from a projected Slider, Button, Joystick, or MIDI CC control exactly as it does in the subpatch, and MIDI-triggered control states are shown live in the panel. Their headers use the normal background and foreground colours as control labels; clicking one does not select the Group. Values changed through this projected panel are saved as overrides on that Group instance; editing the same nodes inside the subpatch changes the shared defaults instead. A cloned Group initially copies the source instance's overrides and then changes independently. Double-click a projected node's header to clear all overrides for that node and restore the current shared defaults. Double-click the Group itself to edit the layout inside the subpatch; locked Area membership is respected.

## Spreads

Choose `Spread` from a node's type picker to create a functional area. A Spread uses the same header, title editing, lock, collapse, resizing, nesting, membership, and movement interactions as an Area. Its fixed control strip sits immediately below the header: `count` uses a normal boundary input on the left, and the internal-only `item index` output sits after the count editor, with its pin on the right of the label. Links on it leave downward to keep clear of the label. When the Spread is collapsed, the control strip and count input remain visible while the internal-only `item index` pin is hidden.

A node is part of an unlocked Spread when its top-left corner is inside the functional body below the control strip. Locking the Spread preserves the same membership snapshot used by Areas, including after a member is moved outside the visible bounds. Unlike a visual Area, a Spread changes the DSP graph:

- `count` selects how many items are active. It is a non-negative integer with no Spread-specific maximum and may be linked like any other input.
- `item index` produces the user-facing, one-based index of each active item (`1` through `count`). It may only be linked to nodes inside that Spread.
- Links between two contained nodes are copied within each item. Links entering the Spread are copied to every item, and links leaving it contribute one signal per active item using the link's existing `set`, `add`, `multiply`, or `bend` behavior.

The compiler emits the contained graph once as a repeatable DSP template. The WASM engine floors the `count` signal at zero, samples it once at the start of each audio buffer, and runs that template only for the active items. Each item keeps independent scalar DSP state and mutable node resources, including Sample playback voices, effect delay memory, Limiter lookahead, and Buffer recordings. A Group inside the Spread participates in each item's template, including its port wiring and nested Groups; its contained state and resources remain item-local. MIDI output nodes inside the Spread, including inside a Group, emit in item order. Sample and Custom Wave visualizations inside the Spread show every active item's playhead, cycling through four line colors to make overlapping items easier to follow. State is allocated as the runtime count grows; there is no Spread count ceiling, so very large values—especially with memory-heavy nodes—can exhaust CPU or memory. A Group in a Spread cannot contain another Spread or Spawn yet. Directly nested Spread and Spawn nodes remain unsupported.

## Spawns

Choose `Spawn` from a node's type picker to create an event-driven functional area with the same header, resizing, nesting, membership, movement, lock, and collapse interactions as a Spread. Spawn areas have a minimum width of 480 pixels so their lifecycle controls remain distinct. The header shows the current number of live instances after the Spawn title, such as `Spawn (3)`. In its control strip, the external `trigger` and `release trigger` boundary inputs are stacked on the left, while the internal-only `instance gate` output and `kill trigger` input are visible only when the Spawn is expanded; their links leave or arrive downward to keep clear of the labels.

- A value rising to `0.5` or above on `trigger` creates a new runtime instance of every contained node and tags that instance with the numeric trigger value. Existing instances continue independently, so retriggering does not reset or replace them. Return the signal to `0` between events to arm the next rising edge.
- A value rising to `0.5` or above on `release trigger` finds every live instance whose tag matches that numeric value and lowers its `instance gate` from `1` to `0`. For example, triggering with `35` and later release-triggering with `35` releases all live instances tagged `35`. Return this signal to `0` between release events as well.
- `instance gate` is an internal-only signal owned by each instance. It starts at `1`; a matching `release trigger` changes it to `0`. The contained graph decides how to respond—for example, by beginning an envelope release or allowing a Buffer tail to finish.
- `kill trigger` may only be driven by a node inside that Spawn. A rising edge produced by an instance removes that instance and its complete contained-node state without affecting the other live instances.
- Links between contained nodes are copied within each instance. Links entering the Spawn are shared with every live instance, while links leaving it combine one signal from each live instance using the link's existing `set`, `add`, `multiply`, or `bend` behavior.
- A Spawn has no fixed voice limit. Instances remain alive until their own kill trigger fires, so a missing kill path or a very fast trigger can consume increasing CPU and memory.

For MIDI-controlled Spawn voices, connect `MIDI Note On.note` to `Spawn.trigger` and `MIDI Note Off.note` to `Spawn.release trigger`. Inside the Spawn, instance-local Sample & Hold nodes can capture `MIDI Note On.note`, `frequency`, and `velocity` when `instance gate` first rises. Connect `instance gate` to the voice envelope gate and route the envelope's `end trigger` back to `kill trigger`. MIDI note `0` is currently indistinguishable from the event nodes' idle zero output and therefore cannot tag a Spawn instance.

The compiler emits the contained graph once as a reusable DSP template, and the WASM engine allocates a fresh state set for each trigger. Both scalar DSP state and mutable node resources are instance-local, so Sample playback, Delay, Chorus, Reverb, Comb/Notch, Limiter lookahead, and Buffer memory advance independently in overlapping instances. A Group inside the Spawn participates in each instance's template, including its port wiring and nested Groups; its contained state and resources remain instance-local. MIDI output nodes inside the Spawn, including inside a Group, emit in instance order. Sample and Custom Wave visualizations inside the Spawn show every live instance's playhead, cycling through four line colors to make overlapping instances easier to follow. Immutable assets and external sources such as decoded sample data, images, audio input, MIDI, and tempo transport remain intentionally shared. A Group in a Spawn cannot contain another Spread or Spawn yet. Directly nested Spread and Spawn nodes remain unsupported.

Live graph recompilation migrates Spawn instances and Spread items by stable container and node IDs. Unchanged nodes retain their scalar state and mutable Sample/effect/Buffer resources, removed nodes discard only their own state, and newly added nodes start with clean state. This keeps existing voices and repeated items running while a template is edited.

On FM-1 firmware **921**, Spread and Spawn use a fixed pool: at most eight containers and eight instances per container, reduced by the compiler when their combined state needs exceed 32 firmware records. Spread counts clamp to that capacity; a full Spawn drops new triggers. Delay and Tempo must remain outside these containers. Package reloads reset instances. MIDI Note On/Off accept USB/TRS channels 1–16 and physical keys on channel 1, with aligned note/frequency/velocity events and one zero sample between events. Envelope completion can drive Spawn's kill trigger. The device event queue holds 256 events; overflow discards queued events and releases Spawn gates. These firmware paths are source reviewed and statically compiled; hardware timing and audio are not yet verified. Example patches are in `firmware/fm1/patches/midi-spawn.json` and `firmware/fm1/patches/spread-harmonics.json`.

## Editor controls and shortcuts

During an ordinary node drag, directly attached Send/Receive nodes follow at their existing offsets when all their physical cables connect only to that node. Multiple cables to the same node still qualify; a connection to any other node keeps the marker independent. Already-selected markers move normally with the selection, and markers can still be dragged separately. Virtual channel connections do not affect this attachment rule. Alt-drag duplication retains its explicit selection behavior.

Shortcuts are ignored while editing text or numeric fields unless noted otherwise.

| Shortcut or gesture | Action |
| --- | --- |
| `Space` | Start or stop audio playback. |
| `Cmd/Ctrl+Z` | Undo. |
| `Cmd/Ctrl+Shift+Z` or `Cmd/Ctrl+Y` | Redo. |
| `Cmd/Ctrl+C`, `Cmd/Ctrl+V` | Copy and paste selected nodes. |
| `Backspace` or `Delete` | Delete the selected nodes, links, subpatch boundary port, or area. |
| `Cmd/Ctrl+Backspace` or `Cmd/Ctrl+Delete` | Delete selected nodes while bridging compatible incoming and outgoing links. Unrelated links, including strength-modulation chains, are preserved. |
| `A`, `B`, `S`, `M` | Set a new or selected link to add, bend, set, or multiply mode. |
| `X` | Enable or disable the selected nodes, or the selected links when no node is selected. Disabled nodes are semi-transparent with a dashed border and disable every incident link without changing those links' own enabled state. |
| `1`…`9` | Set the selected Selector node to the corresponding input. |
| `Cmd/Ctrl+0` | Reset canvas zoom to 100%. |
| `Shift` or `Cmd` while selecting | Add to the current selection. |
| Select a node or link | Highlight the related links, dim unrelated links, and leave pins unchanged for node-driven highlighting. |
| `Alt`-drag selected nodes | Duplicate the selected graph. Add `Cmd`, `Ctrl`, or `Shift` to preserve links between the duplicates and unselected nodes. |
| `Alt`-drag an Area, Spread, or Spawn | Duplicate the complete container hierarchy and contained graph. Add `Cmd`, `Ctrl`, or `Shift` to preserve links to nodes outside it. |
| `Cmd`, `Ctrl`, or `Alt` while reconnecting a link endpoint | Keep the original link and create the reconnected link as a duplicate. |
| Drag empty canvas | Rectangle-select nodes; their incoming and outgoing links highlight without selecting the links themselves. |
| `Cmd/Ctrl`-drag empty canvas | Create an area. The gesture can switch between area creation and rectangle selection while the modifier is pressed or released. |
| Double-click empty canvas | Create a new untyped node at the pointer. |
| Double-click a link | Insert a new node into that link. |
| Double-click a node title | Change the node type, or rename a compact node. A single click selects the node. |
| Drag a node title | Move the node, whether its ports are expanded or compact. |
| Drag a link over a compact node | Temporarily expand its ports and bring it above the other nodes so every connection target remains visible. |
| Double-click a Group node outside its title | Enter and edit its subpatch. |
| Double-click a projected control node header | Reset every value on that node to the subpatch defaults for this Group instance. |
| Scroll | Pan the canvas. |
| Pinch | Zoom the canvas. |

Resizable visual nodes without a saved size initially fit their visible labels and controls. Dragging a resize corner switches the node to an explicit size that is preserved with the patch. Image, Sequencer, Spread, and Spawn retain their type-specific initial geometry.

Stopping playback suspends the audio context after the short output fade, halting audio processing and metering until playback starts again. Numeric inputs, sliders, and patch editing remain available while stopped; diagnostics run on events rather than permanent idle timers.

The bottom-right controls show `EXIT` while editing a subpatch, followed by `PLAY`, `REC`, `NEW`, `SAVE`, `LOAD`, `UNDO`, `REDO`, and `MORE`. `PLAY` starts or stops audio; `REC` starts or stops recording and shows elapsed time while recording. `NEW` asks for confirmation before replacing the current patch with an empty one. `SAVE` stores the patch and `LOAD` opens a patch from the local library or a JSON file, depending on storage mode. `UNDO` and `REDO` are disabled when unavailable. The `MORE` menu contains MIDI SETTINGS, EXPORT PATCH, SEND TO FM1, SCALE UP SELECTION, SCALE DOWN SELECTION, GROUP TO SUBPATCH, IMPORT SUBPATCH, and LOCK UI. Grouping and scaling are disabled when unavailable. `LOCK UI` prevents graph editing until unlocked. The menu opens on hover or keyboard focus. MIDI settings lists inputs and outputs separately: selected inputs feed MIDI source and learn features, while selected outputs receive send-node messages, clock/transport, and playback cleanup. Stopping playback sends the MIDI All Notes Off controller message on every channel to every selected MIDI output. **Send MIDI clock and transport** sends `Start`/`Stop` and 24-PPQN timing clock to selected MIDI outputs while playback is running and the patch contains a Tempo node. With an internal Tempo it follows that node’s BPM; with a MIDI-sourced Tempo it forwards the selected input’s timing clock. `LOCK UI` is a view-only toggle: it hides links and square pins while retaining the exact node layout, and prevents selecting, moving, deleting, resizing, collapsing, locking, or connecting nodes until unlocked. Playable controls remain available while locked, including Custom Wave curve buttons and Selector index buttons. The current editor state is stored in the browser as it changes, including when `NEW` replaces the graph, and the latest state is restored after a refresh. Canvas position and zoom are persisted separately when a pan or zoom finishes, so live viewport movement does not serialize the full patch. Pressing record while playback is stopped arms recording at `0:00`; capture begins when playback starts. Recordings are saved to `recordings/` with a filename based on the patch name, including patch names that use accented or other non-English characters. When a recording contains at least one triggered MP4 video sample, its saved WAV has a same-stem CSV beside it in `recordings/` (for example, `performance.wav` and `performance.csv`); audio-only recordings save only the WAV. The CSV contains one row for every triggered playback from an MP4 Sample node, sorted by trigger time; audio-only sample events are omitted. Its `node_id` and `sample_name` columns identify the source; the remaining columns record source-region start/end in milliseconds, effective speed ratio (`1` is real time, including pitch and stretch), volume, attack/release in milliseconds, and trigger time relative to the start of the recording. The zoom percentage button resets zoom to 100%. Node and area header titles receive stepped size boosts below 70%, at 50%, and at 30% canvas zoom so they remain readable while zoomed out. The adjacent `CPU` meter fills from left to right while audio is running to show the DSP worklet's share of each audio-block deadline; hover it for the percentage.


`EXPORT PATCH` downloads a plain `.zip` containing editable `patch.json`, compiled `program.json`, `manifest.json`, referenced samples and images (including original video sources), and preserved Buffer data. It does not contain the runtime. The manifest records asset hashes, external Params bindings, and the engine API version. Export stops with an error if DSP compilation or asset collection fails. The editor’s `LOAD` button continues to load ordinary patch JSON rather than ZIP packages.

`SEND TO FM1` in the `MORE` menu, beside `EXPORT PATCH`, compiles the current patch for the FM-1 and opens a dialog showing operations, registers, parameter/constant values, DSP state entries, and package bytes against the firmware limits. A `MIDI Note` node is optional: fixed-frequency and continuously gated drone patches can export without keyboard or MIDI input. The dialog also lists compatibility warnings from the FM-1 support register for enabled nodes, including nodes inside groups. Warnings distinguish unsupported features, partial support and unverified support, show the affected node names and IDs, and explain known limitations. Disabled nodes (and disabled groups’ contents) are excluded. Enabled unsupported or unreviewed nodes block export/upload, including unused nodes and group contents; disable or remove them to continue. Partial nodes must pass the registered port and compiled-operation restrictions. Feedback loops compile to paired, one-sample history instructions when all other support and resource rules pass. The rules identify the registry’s target firmware, not the connected device’s version. Both browser and CLI uploaders preflight encoded instructions against the same JSON before MIDI access; exceeded limits also block upload. The device reports package-format compatibility only and may reject newer operations at commit on older firmware. Connect an FM-1 running Teia firmware `FM-1_909` or newer for feedback patches, enter preset **1** or **2**, and click **Upload**. Use a Web MIDI-capable browser such as Chrome or Edge on HTTPS or localhost, and allow MIDI SysEx access when prompted. Upload replaces and activates the chosen preset; both slots are held in RAM and clear on power-off. The dialog reports transfer progress and device acknowledgement. **Check connection** queries status and package compatibility without replacing or selecting a preset. If a command times out, its error includes the failed stage, received MIDI/SysEx counts, last SysEx reply and port connection states; copy the error when reporting upload problems. Chrome 152 on macOS has a known SysEx framing bug; finish updating and fully relaunch Chrome to run version 153 or newer (refreshing the tab is insufficient). Resource counts measure memory capacity, not audio performance; check late buffers on the device. The editor and command-line exporter share the same FM-1 compiler and package encoder. See [FM-1 upload documentation](firmware/fm1/UPLOAD.md) for supported graphs, controls and the CLI workflow.

FM-1 firmware **904** adds basic arithmetic/mixing, sine/triangle/saw/ramp/square oscillators with phase modulation/reset and pulse width, Noise, linear ADSR with trigger/delay/timed gate, and a resonant low-pass filter. New version-3 packages require the 904 firmware update; 904 continues to accept older packages. [FM-1 node support and units](firmware/fm1/README.md#inputs-and-differences-from-the-browser-engine) documents the fixed-point ranges, timing and differences from the browser engine. Example patches are in `firmware/fm1/patches/` (`subtractive.json`, `phase-fm.json`, `noise.json`).

Firmware **905** adds HighpassFilter, BandpassFilter, AllpassFilter and Crossover. Filters retain the existing `signal`, `cutoff`, `resonance` → `signal` ports; Crossover retains `signal`, `frequency 1` … → `band 1` … and its slope/points controls. These nodes require rebuilding and installing 905; older firmware rejects their new filter instructions. Fixed-point limits and resource budgets apply; audio response and timing await hardware verification.

Firmware **906** adds HardClipDistortion, SaturateDistortion and WavefoldDistortion (`signal`, `drive` → `signal`), Fold (`signal`, `amount` → `signal`), Abs and RemoveDc (both `signal` → `signal`). Distortion drive is live and clamped to 0.1–40; Fold uses gain `1 + 3 × max(amount, 0)`. RemoveDc applies a 10 Hz DC blocker. Install 906 and refresh the rebuilt editor before uploading the new examples in `firmware/fm1/patches/`: `hardclip.json`, `saturate.json`, `wavefold.json`, `fold.json`, `abs.json`, and `remove-dc.json`. Fixed-point quantisation and aliasing apply; device sound and timing remain unverified.

Firmware **907** adds Clamp (`signal`, `min`, `max` → `signal`), Accumulator (`trigger`, `reset`, `increment`, `min`, `max`, with trigger/continuous mode → `signal`), and Random (`trigger`, range minimum/maximum → `signal`). Clamp and Accumulator accept reversed bounds. Accumulator wraps to the opposite endpoint on overshoot; continuous mode increments every sample. Random chooses a value initially and on each rising trigger, with a deterministic per-node sequence reset by patch loading. Expressions additionally support `abs`, `min`, `max`, `clamp`, `floor`, `ceil`, `round`, `sign`, `fract`, comparisons and boolean logic. Install 907 and ordinarily refresh the rebuilt editor; examples are `clamp.json`, `accumulator.json`, `random.json` and `expression-functions.json` in `firmware/fm1/patches/`. Implementation status is source reviewed; host audio and hardware verification remain outstanding.

Firmware **908** adds `bend` mode for links and link-strength modulation: the weighted source becomes an exponent, scaling the target by `2^value` (`+1` doubles, `−1` halves). The ratio is rounded to Q16.16 and saturates at about 32768; very small ratios round to zero, so extreme bends differ from the browser. Build and install 908 and rebuild/refresh the editor to use bend patches. This does not add MIDI pitch-wheel input. Source implementation is reviewed; device build, audio and timing verification remain outstanding.

Firmware **909** adds feedback-loop export and runtime support. Each feedback path becomes a paired read/write instruction with a shared, one-sample Q16.16 history slot that resets when the patch loads or switches. Feedback patches require installing 909 before export/upload; browser and device history both use one-sample ordering, while numeric precision differs. Sine, triangle, saw, ramp and square phase resets now crossfade over roughly 8 ms; their frequency and phase inputs remain audio-rate and square pulse width remains live. Lowpass, highpass, bandpass and allpass filters are already available with live signal/cutoff/resonance modulation. Oscillators are still not band-limited, and hardware sound/timing remains unverified. Rebuild the editor bundle and refresh the page after installing 909.

Firmware **910** adds package/export and runtime support for Delay, Follower, Map, pow, Quantise, Sample Hold, Tempo, Kink Osc and Custom Wave. The hardware implementations use bounded fixed-point resources: one delay line is limited to about 46 ms, Custom Wave does not yet emit `end trigger`, Tempo is internal-only without swing/MIDI-clock following, and several power/log-based shapes are approximations. See the [FM-1 support matrix](firmware/fm1/SUPPORT.md) for precise limits. Rebuild the editor bundle and refresh the page after installing 910.

Firmware **917** extends `Delay` (`signal`, `time`, `feedback`, `mix` → `signal`) to **two independent mono nodes, each up to one second** at 44.1 kHz. Delay memory uses signed 16-bit samples with 12 fractional bits, preserving approximately ±8 signal headroom; the dry path retains Q16.16 precision. Fractional interpolation and a 256-sample one-pole time smoother (about 5.8 ms time constant, about 27 ms to traverse 99% of a step) make time modulation continuous, with tape-style pitch bends. Initial time is immediate; later changes, including returning to zero-time bypass, are smoothed. Below one sample, the wet tap blends current input and previous history, and feedback fades toward zero. Feedback remains 0–2 and mix 0–1. Times above one second clamp; a third enabled Delay, including inside Groups, blocks export. New Delay exports use instruction 53 and require installing 917; older instruction 44 loads on 917 with the upgraded behavior. The browser retains its existing floating-point, 1.5-second delay and immediate time changes, so playback differs. Rebuild the editor and ordinarily refresh after installing the new firmware; sound, modulation and device timing still need functional verification.

Firmware **912** changes the Params screen from a 0–100 range position to the parameter's actual patch-declared value, rounded to up to four decimal places. Build and install 912 to see this on the device; no editor rebuild is required.

Firmware **913** aligns link value loads, averaging arithmetic, add/multiply stages
and bend ratios with WASM's ±12,000 intermediate bounds, including link-strength
modulation. Set → add → multiply → bend order is unchanged, as is knob
interpolation. Build and install 913, then upload your patch again (firmware
installation clears the RAM slots); no editor rebuild or patch-format migration is
required. Fixed-point precision differences remain; hardware audio and timing
have not been verified.

Firmware **914** reduces neutral-operation cost: Pow with exponent 1 returns its
input exactly, zero bend returns unity immediately, and multiplication by zero or
one and division by ±1 or ±2 use exact fast paths. This addresses avoidable work
found while investigating `test-fm-3` device late buffers; desktop comparisons do
not prove that the FM-1 meets its audio deadline. Install 914, re-upload the patch,
and check that **LATE BUFFERS** stops increasing during playback. No editor rebuild
is required; knob interpolation and feedback-delay placement are unchanged.

Firmware **915** separates constant/Params-only work from audio-rate processing.
It prepares those calculations once at an audio-buffer boundary when values have
changed, instead of repeating them for every sample. Oscillators, envelopes, MIDI
triggers, audio-rate modulation and feedback retain their sample-rate ordering.
Envelope ramps also avoid repeated division without changing their values. For
the K3-modulated `test-fm-3`, 46 of 72 instructions move out of the per-sample loop.
Host comparisons against 914 produced identical PCM for 23 patches, including live
control changes. Install 915 and re-upload your patch; no editor rebuild or patch
migration is needed. Hardware timing still needs checking with **MAX RENDER US**
and **LATE BUFFERS**.

FM-1 export also simplifies the fixed-point instruction stream before upload:
immutable constants are folded, redundant bounded identities and duplicate pure
calculations are removed, and unused pure calculations are discarded. Knobs stay
live; intermediate clipping and stateful/feedback order are preserved. The bend
feedback fixture falls from 72 to 30 instructions, with identical host-rendered
PCM and state across 23 regression patches. This compiler update works with
firmware 915: rebuild the editor, refresh it and re-upload the patch. Existing
uploaded patches retain their original instructions until replaced.

Run `npm run fm1:install` to build firmware if its source inputs or cached package changed, then install it on the connected FM-1 and verify its identity after reboot. This immediately installs firmware and clears RAM patches. Use `npm run fm1:install -- --build-only` to prepare the package without device access, `--force-build` to force rebuilding, or `--port 'Teia FM-1'` to select a MIDI port. The existing pinned build and MIDI environments are required; see [firmware installation](firmware/fm1/UPLOAD.md#build-and-install-firmware). The script does not rebuild or restart the editor.

The independent browser player runtime is the installable npm package `@pauloricca/teia-runtime` in `runtime/`. Run `npm run build:runtime` to compile its TypeScript API and create a player-specific worklet alongside the WASM kernel in `runtime/dist/`; this build does not build or start the editor. The separate `player/` project installs a local tarball of that package and loads XP ZIPs without any editor code. The player worklet skips editor visualization frames, DSP meters, per-block CPU reporting, and legacy editor effect buffers. It still computes FFT outputs when the patch uses them, even though the player has no Scope display. The runtime verifies patch asset hashes, decodes samples and images, restores preserved buffers, and exposes parameter, MIDI note, MIDI CC, mute, and reset methods. Parameter updates enter the existing smoothed DSP value path. Event scheduling currently happens when the worklet receives each message; future sample-accurate scheduling is not part of this API.

Saving a patch first checkpoints every preserved ordinary or Group-contained Buffer. Patch JSON stores only each Buffer's SHA-256 hash, sample rate, and sample count. In local/server patch-storage mode, raw Float32 contents are kept as content-addressed `.f32` files in the internal `buffers/` directory; a save asks the server which hashes are missing and uploads only new contents, so unchanged buffers are shared by consecutive patch versions. Loading a version fetches any content not already cached in IndexedDB and restores it into the audio engine. The `buffers/` directory is deliberately not exposed as a user-facing asset library. Clearing the browser's site data removes refresh checkpoints, but server-saved patch versions remain loadable from `buffers/`.

To turn the Sample events in one of those CSV files back into a chopped video, install `ffmpeg`/`ffprobe` and run:

```bash
npm run remix:video -- recordings/performance.csv
```

The output defaults to `recordings/performance-remixed.mp4`. For every `sample_name` in the CSV, the script loads the matching sample from `samples/`, skipping it and its events with a warning when it has no video stream, so older CSVs containing audio-only sample events remain usable. One remix can use events from multiple source videos. The exporter seeks directly to bounded source regions and coalesces overlapping regions, so work scales with the selected footage rather than repeatedly scanning from the beginning of long source files or opening a decoder for every repeated event. The first video source determines the output dimensions, frame rate, and audio sample rate; other video sources are normalized to match. The script preserves reverse playback, pitch-changing speed, volume, attack, release, and source audio. Every mode keeps recording time zero as output time zero: when the first usable video trigger occurs later, the remix begins with black video and silence instead of trimming the recording timeline. Audio triggers retain sample-accurate CSV timing, while video transitions use the nearest output frame. It also warns and skips rows whose source region is empty or entirely outside its video; the export fails only when no usable video rows remain. Pass `--pre 0.25` or `--post 0.5` to add that many seconds of source-video context before or after every clip; fractional seconds are accepted, available source media limits the handles, and the added portions are silent. Add `--faded-extensions` to render only that pre/post footage in grayscale at 50% opacity; overlap modes reveal the underlying composition, while the default montage composites the same appearance over black. In the default cut mode these handles extend the montage and delay each clip's unchanged audio by its available pre-roll. With an overlap mode they extend only the visual voice around its original recording-timeline trigger, leaving every audio trigger unchanged. By default, each new trigger cuts off the preceding clip. Pass `--overlap-opacity` to mix every active voice while using the oldest active video as the full-strength base and layering each newer clip over it at 50% opacity; a clip returns to full opacity when it is the only active one. Pass `--overlap-split` to mix every active voice while dividing the frame into equal vertical source slices in trigger order; the remaining clips dynamically expand into the available slices as voices finish. Pass `--overlap-grid` to place active videos into the smallest near-square grid that currently fits them, using aspect-preserving centered crops rather than stretching; the grid dynamically expands and reflows as voices enter or finish while each video's playback stays on one continuous timeline. The overlap options are mutually exclusive. Overlap render cost scales with the duration of every active voice, not just output duration; the exporter warns when feedback-expanded regions create an unusually large simultaneous or average layer count.

Because the CSV does not contain the recording stop time, the export ends one median trigger interval after the final trigger; override that last duration with `--final-duration-ms 1000` when needed. With a single event, its full source-region duration is used. Use `--samples-dir path` to override the default `samples/` directory, `-o output.mp4` to choose an output path, `--sample-name name.mp4` to restrict a multi-source CSV to one source, and `--overwrite` to replace an existing output.

## Compiler And Engine Boundary

See [optimisations.md](optimisations.md) for proposed engine and editor optimisation tasks, implementation constraints, and validation criteria for separate development threads.

The active compiler is `editor/src/audio/dspProgram.ts`. It expands subpatches, combines input links with the rule above, and emits a `DspProgram` for the worklet. The editor sends that program with `dspProgram` messages, and value-only changes use `dspValues`.

Before upload, the compiler reuses immutable literal loads within each ordinary or repeat region, folds arithmetic whose inputs are immutable literals using the kernel's register clamp and division threshold, and removes unused pure operations outside repeat templates. Mutable node parameters, link weights, analyser values, feedback, events, and stateful operations retain their normal evaluation. The compiled program includes an `optimization` report with operation counts by opcode, register/value/state totals before and after each pass, and removal reasons. Passes can be disabled independently through the optional second argument to `compilePatchToDspProgram` for offline diagnosis. The program version and kernel opcodes are unchanged.

The old link-centric `WasmAudioGraph` TypeScript compiler has been removed. Current playback fixes should target `editor/src/audio/dspProgram.ts` and the `DspProgram` sync path in the worklet.

The worklet in `editor/public/audio/audio-worklet-wasm.js` loads the Teia WASM kernel and syncs the compiled `DspProgram` into it. Vite derives each public audio asset's URL version from its content, preventing browsers from reusing an outdated worklet or WASM kernel after it changes. User-facing patch links target nodes or the audio output; any remaining inherited link-centric WASM API names are implementation details, not the patch philosophy.

During program upload, the kernel traces ordinary pure control chains from DSP values and marks expensive operations (including power, division, and mapping) for input-based caching. The cached result is reused only while its exact current inputs and output register remain unchanged. Smoothed controls therefore recompute on each changing sample, and external Params, MIDI-controlled sliders, and FFT values remain mutable. Stateful and audio-rate sources, Spread/Spawn templates, and per-voice rendering use their existing path. This is an internal kernel optimization; saved patches and exported `program.json` keep the same version and opcodes.

For scheduling analysis, call `compilePatchToDspProgram(patch, { analyzeSchedule: true })` and inspect the optional `schedule` report. It lists dependencies in the expanded graph, feedback boundaries, strongly connected regions in topological order, candidate regions, and scalar fallback reasons. The report is omitted in normal compilation, does not control playback scheduling, and is not required by exported version 1 programs. Run `node scripts/benchmark-dsp-schedule.mjs` for offline graph checks and compile-cost measurements.

The kernel also derives a block plan from uploaded operations. Programs made entirely of value loads, basic arithmetic, simple phase oscillators including KinkOsc, Function operations (including eligible cached controls), standard biquad filters, Delay, DC blockers, and audio outputs can use it. KinkOsc modulation, phase offset, reset, and range mapping use the existing oscillator routine; Function, Delay, and DC blockers use their existing scalar maths inside each operation's sample loop. Delay feedback remains sample ordered within its private effect buffer. Programs with shared delay effect slots, overlapping numeric state, and other unsafe dependencies fall back to scalar. Bounded programs with feedback can use a mixed plan: the feedback SCC runs in its original per-sample instruction order while upstream and downstream operations run in blocks. Small feedback graphs, repeats, other resources, events, and unsupported operations keep the scalar renderer. The block paths advance smoothing once per sample, share value streams, preserve per-filter and oscillator state in their own sample loops, and capture meters/scopes at their original sample positions. They process calls in chunks of at most 256 frames, with at most 128 intermediate-buffer slots and 128 value streams; exceeding these limits falls back to scalar. Scratch is allocated when the program or monitor configuration changes. Existing version 1 programs remain loadable because the plan is derived at upload. The optional graph `schedule` report above is conservative and does not determine the kernel's actual plan; `compileDspBlockPlan()` returns `0` for scalar fallback, `1` for full block, or `2` for mixed feedback. `node scripts/benchmark-dsp-block.mjs` compares exact scalar/block/mixed/SIMD output and offline timings. `BENCHMARK_BLOCK_PLAN=1 npm run benchmark:saved-patches` enables the plan in the saved-patch benchmark and reports scratch bytes; zero means scalar fallback.

The optional SIMD single kernel evaluates independent add, multiply, and subtract samples two at a time with a scalar tail and the same per-sample sanitization. The editor and npm player validate the SIMD WASM module before using it and load the ordinary single kernel if validation or fetching fails. For programs using KinkOsc mode 12 or sign-preserving power, ordinary WASM now selects scalar rendering automatically even when a block plan is available; offline ringing-drone benchmarks showed a small ordinary block regression. This conservative rule is not a general cost model, and explicit `setDspBlockRendering(1)` remains available for offline comparisons. The kernel's `dspBlockRenderingEnabled()` export reports the active choice separately from `compileDspBlockPlan()` eligibility. Other eligible ordinary programs can still use block rendering. Multi-worker mode continues to use the ordinary parallel kernel. The ZIP remains patch-only; no WASM binary is embedded in exported patches.

Audio rendering defaults to `single`. Experimental `multi` mode uses the audio thread plus persistent Web Workers with a shared WASM memory and separate stacks. On each structural program upload, the kernel identifies independent Spread and Spawn templates, including nodes expanded from Groups inside them. Eligible templates use audited operations with instance-local state and resources. Each worker has private registers and updates the state owned by its assigned item or instance; the audio thread combines outputs in original order and applies Spawn release/kill bookkeeping within the same sample. Templates with a cross-instance register dependency or the shared side effects listed below use the serial path. The worker path starts at 8 active instances for templates with an envelope, 16 for simpler oscillator templates, and 96 for arithmetic-only templates; it falls back to serial above 512. Parameter-only edits reuse the eligibility plan.

Spawn instances and Spread items execute a shared compiled template with separate runtime state. Small numeric histories use a packed per-instance state block that the template mutates directly through an active state view. Sample playback receives its instance-owned state by mutable reference, avoiding per-sample restore/capture copies across its voice slots, and its render loop visits only slots up to the highest voice that may still be active. Memory-backed effect and Buffer resources remain per-instance; their storage is moved into the kernel workspace by pointer swap for template execution and moved back afterward without copying buffer contents.

The engine supports up to 64 compiled buffered effects (`Delay`, `Chorus`, `Reverb`, Comb/Notch, and `Limiter`) and 16 compiled `Buffer` nodes. Each compiled node receives an explicit resource slot; exceeding either limit is a compiler error rather than causing two nodes to share memory. Spawn and Spread runtime copies reuse their template's compiled slot while owning separate buffer contents.

The current WASM binary still has the inherited `visual-fm` ABI, where some processor settings are named as link parameters. That naming reflects the original engine, not the user-facing model in this app. The app should keep the audio kernel stable unless there is a clear DSP reason to change it.

## Development

The FM-1 firmware experiments include [the pinned Felucca build spike](docs/spikes/fm1-build.md)
and a [naked Teia runtime](firmware/fm1/README.md). The current firmware starts
silent and accepts compiled patches over USB MIDI into two RAM slots, selected
with PRESETS. A patch uses a MIDI Note node for the keyboard and MIDI source;
the first four Params outputs map to Knobs 1–4. Select browses the remaining
parameters and Algorithm edits the single visible extra parameter. Five rows show
names, declared-unit values and aligned outlined range bars. Firmware 916 and
package v5 remove the six-output limit; parameters share the 128-value patch budget. See the
[export/upload workflow](firmware/fm1/UPLOAD.md). Powering off clears the slots.
The [FM-1 support matrix](firmware/fm1/SUPPORT.md) tracks every editor node and
device feature, separating implementation status from hardware verification.
`firmware/fm1/support.json` is the single editable, schema-validated capability contract
for frontend warnings, editor/CLI export, binary upload preflight and this reference.
Visit `/fm1-support` or `/?view=fm1-support` for a green tick table covering every
feature. The registry includes structured drift, port restrictions, compiler modes/functions, encoded
instructions and limits. `SUPPORT.md` and `limits.json` are generated from it.
Update the contract when web functionality changes or FM-1 gains support, then follow
the matrix’s review workflow. `npm run fm1:support:check` checks node coverage,
source-review freshness and generated documentation; it also runs before the root
typecheck and build. Firmware 907 supports arithmetic and selected Expression functions, five oscillator
waveforms, Noise, ADSR, low/high/band/all-pass filtering, Crossover, three distortions, Fold, Abs, RemoveDc, Clamp, Accumulator and Random, with documented restrictions. Limits are 256
operations/registers, 128 values and 32 state entries per patch; these are
storage limits, not a guarantee that every graph meets its audio deadline. These experiments are separate from the
browser engine; desktop patch editing and playback are unchanged.

Install dependencies:

```sh
npm install
```

Run the app:

```sh
npm run dev
```

Run the app through Docker with the local helper:

```sh
./start
```

`./start` checks the Rust/WASM kernel before launching and rebuilds it when it is missing or older than its Rust sources or build inputs. Docker then runs Vite's development server on port `5174` by default, so TypeScript, React, and CSS edits hot-reload through the bind mount without rebuilding the image or restarting the container. Rust/WASM changes still need `npm run build:wasm` and cause a full browser reload. The helper reuses the existing Docker image by default; pass `--rebuild` after changing the main `Dockerfile`, its base image, or its OS-level packages. It generates a self-signed HTTPS certificate when `openssl` is available, prints LAN URLs for another device or projector, and supports `--port=PORT`, `--patch-storage=local`, and `--patch-storage=browser`. Direct `npm start`, `npm run dev`, and `npm run preview` run the same WASM preflight.

Themes are selected with `--theme=NAME` (or `--theme NAME`). Available presets are `console` (green phosphor), `amber` (warm orange), `ocean` (cool blue), and `vira` (blue-black panels, white unselected node titles, and cyan and orange accents); for example, `./start --theme=amber`. The default theme preserves the original monochrome appearance. Sample waveform boundaries and envelope guides use contrasting colors for visibility; in the ocean theme, the start marker and attack guide are green. Palette and font tokens live in `editor/src/themes.css`; add matching `:root[data-theme='NAME']` and `.teia-themed-editor[data-theme='NAME']` selectors there to create another theme. The embedded editor accepts `<HostedNodeEditor session={session} theme="vira" />` to apply this palette within its panel without setting the host document's theme. The optional `theme` prop also accepts the other preset names; omit it to inherit the document theme. Rebuild the hosted package with `npm run build:hosted` and import its `flow.css`, `themes.css`, and `styles.css` in that order (see [hosted integration](docs/hosted.md)).

Multithreading is **off by default**. Audio starts in `single` mode unless you opt in. To start with multithreading, copy the example settings and change the mode in `editor/.env.local`:

```sh
cp editor/.env.example editor/.env.local
```

```dotenv
VITE_TEIA_DSP_MODE=multi
VITE_TEIA_DSP_WORKERS=2
```

Then run `./start` for Docker or `npm run dev` for local development. If either is already running, restart its server (`docker compose restart editor` for the Docker web service), then refresh the browser tab. Set `VITE_TEIA_DSP_MODE=single` to switch back. The worker setting selects 1–4 helpers in addition to the audio thread; it defaults to 2. These settings are read in `editor/src/audio/config.ts`. Vite loads `editor/.env.local`, including through the Docker bind mount. Production requires rebuilding with the selected environment and restarting its server. Multi mode needs HTTPS or localhost and cross-origin isolation; the supplied Vite and production servers already send the required headers. If shared memory or worker startup is unavailable, playback falls back to single mode and reports the reason in the CPU tooltip and diagnostics.

Hover `CPU` to see the actual mode, helper count, eligible Spread/Spawn templates, peak block load in the latest reporting interval, and cumulative missed callback deadlines since engine creation. Eligibility is determined when the program is uploaded; a template only runs on workers after its workload threshold is reached. The percentage is elapsed callback time divided by its audio deadline, including waits for helpers; it is not total CPU usage across cores and excludes editor rendering. The bar caps at 100%, but its numeric label can exceed 100%. Live node visualizations update at 15 Hz, or 30 Hz while a Scope or FFT display is active; audio rendering still runs at the full sample rate. Compare the same patch, sample rate, and active instance count after warmup in both modes; check missed deadlines and audible stability as well as the average percentage. No speedup is assumed.

Repeated Spread items and Spawn instances use the same DSP operation renderer in both modes. For an eligible repeat in multi mode, each worker supplies an instance-local register bank, scalar state, effect buffers, Buffer memory, audio SamplePlayer voices and effective parameters, and a random generator; the audio thread combines its Group/container outputs in instance order after the workers finish. The repeat runner passes its instance context into each operation. The evaluator reads registers directly from that context, and oscillator and envelope state uses the same view; other node helpers still use the thread-local context where needed. This includes connected oscillator `phase` and `phase reset` inputs, Custom Wave playback state and curve morphing, filters, Delay, Chorus, Reverb, Limiter, Buffer, Sequencer, Roll, read-only MIDI inputs, Noise, Perlin Noise, Random, an unconnected Sample Hold source, and fuzz distortion. Each repeated item or instance advances only its own random sequence in both modes; ordinary nodes outside containers retain their previous random behavior. Audio SamplePlayers do not emit trigger metadata; MP4 SamplePlayers retain it for video recording and keep their enclosing repeat template serial. The graph is inspected once at program upload, not on every sample. The following operations still keep their enclosing repeat template serial because they change shared state or emit ordered events: video SamplePlayers, Tempo's shared clock, MIDI output sends, and Audio Out mixing inside the template. A template also stays serial if one item reads another item's register result, a collector feeds back into its body, or the workload is below the worker threshold. Serial fallback preserves the patch's sample-accurate behavior.

Typecheck:

```sh
npm run typecheck
```

Build:

```sh
npm run build
```

Rebuild the Rust/WASM kernel and copy it into the editor public/dist audio assets:

```sh
npm run build:wasm
```

This builds `teia-kernel.wasm`, `teia-kernel-simd.wasm`, and `teia-kernel-parallel.wasm`. The ordinary single variant keeps its original compiler flags; the optional SIMD variant enables `simd128`. The parallel variant uses the pinned Rust 1.87 builder with `rust-src`, `RUSTC_BOOTSTRAP=1`, `build-std`, and WASM atomics because shared-memory std is not available from that toolchain's ordinary prebuilt target. Its imported memory starts at 32 MiB and can grow to 2 GiB; each helper has a reserved 1 MiB stack. The editor versions all three artifacts by content, and the WASM preflight checks all three files.

Benchmark saved patches without starting the app:

```sh
npm run benchmark:saved-patches
```

Set `BENCHMARK_PATCH_FILES` to comma-separated saved patch paths to select cases; `@simple-block` selects a generated acyclic sine patch, `@group-spread` and `@group-spawn` select generated Group-in-container cases, and `BENCHMARK_GROUP_ENVELOPE=1` adds an envelope to `@group-spread`. For two single-mode WASM builds, set `BENCHMARK_BASELINE_WASM` and `BENCHMARK_COMPARISON_WASM`; `BENCHMARK_SCALAR_BASELINE=1` disables block rendering in the baseline and `BENCHMARK_FORCE_BLOCK_CANDIDATE=1` overrides the candidate's automatic scalar choice for an offline A/B run. `BENCHMARK_BLOCK_PLAN=1` compiles and reports the candidate plan (`0` scalar fallback, `1` full block, `2` mixed feedback) and its automatic rendering choice. `BENCHMARK_EXACT=1` requires exact final-block output, while `BENCHMARK_VERIFY_ALL_BLOCKS=1` checks both channels and numeric state on every block, then checks delay-buffer contents. `BENCHMARK_MONITORS=1` configures saved-patch meters and a `scope_1` scope for comparison. `BENCHMARK_EXERCISE_RINGING_CONTROLS=1` retargets ringing-drone's oscillator and delay controls and resets transport during that comparison; set warmup plus measured blocks to at least 257 to include the reset. `BENCHMARK_PROFILE_VARIANT=kink-sine`, `power-min`, or `both` substitutes cheaper exact operations in an offline timing-only ablation; those variants change the sound and are not correctness references. `node scripts/benchmark-repeat-template.mjs editor/public/audio/teia-kernel.wasm editor/public/audio/teia-kernel-parallel.wasm` measures a stateless Spread; add `--osc` for item-local oscillator state or `--spawn` for oscillator/envelope voices with release and kill verification. These offline measurements do not replace an AudioWorklet callback check.

`node scripts/benchmark-dsp-values.mjs before.wasm after.wasm` compares settled, sparsely smoothing, and fully smoothing DSP values in two single-mode kernels. It checks exact rendered output across value retargeting, immediate writes, settling, reset, and program replacement. The kernel keeps a bounded list of values currently smoothing, so settled parameters no longer require a per-sample scan across initialized value slots. Value state remains shared across a program's Spread items and Spawn instances; clearing a program resets the list, while a transport reset retains current parameter values and targets.

`node scripts/benchmark-control-cache.mjs before.wasm after.wasm` compares stable, smoothed, and immediately changing slider-curve chains offline. It also checks exact output through retargeting, reset, program replacement, and audio-rate oscillator modulation. This does not measure an AudioWorklet callback.

Pass a helper count from 1 through 4 after `--`, for example `npm run benchmark:saved-patches -- 4`. The benchmark compiles representative saved patch versions, renders each through the regular single kernel and the shared-memory kernel, checks their final audio block is equal, and reports median milliseconds per 128-frame block. It does not load external sample or image assets, so the selected patches deliberately avoid those node types. It measures Node worker threads rather than an AudioWorklet, making it a useful mode comparison but not a replacement for the in-app CPU meter.

Set `BENCHMARK_SAMPLE_RATE`, `BENCHMARK_WARMUP_BLOCKS`, `BENCHMARK_MEASURED_BLOCKS`, or `BENCHMARK_TRIALS` to tune an exploratory run. The defaults are 48 kHz, 32 warmup blocks, 64 measured blocks, and three trials; they keep the experimental scheduler below its watchdog limit on slower development machines.

Check compiled DSP port/link behavior:

```sh
npm run smoke:dsp-ports
```

Check overlap-grid remix timing with a generated frame-clock video:

```sh
npm run smoke:video-remix
```

Render a quick WASM startup smoke test:

```sh
node scripts/render-worklet-startup.mjs 1
```

Render the MIDI note path:

```sh
node scripts/render-worklet-startup.mjs 1 --midi-note
```

Manual MIDI check:

1. Add a MIDI Note node, Sine Osc, and Audio Out.
2. Connect `MIDI Note.frequency` to `Sine Osc.frequency`, then `Sine Osc.signal` to `Audio Out.both`.
3. Start audio and allow MIDI access when prompted.
4. Hold a note, then press another. MIDI Note should follow the newest held note; releasing it should restore the most recently pressed note still held, and releasing all notes should lower `gate`.

`MIDI Note On` and `MIDI Note Off` share an ordered event queue. One MIDI event is exposed per audio sample and every event is followed by a zero sample, so simultaneous chord messages become sequences such as `10, 0, 32, 0, 52`. All outputs belonging to an event are aligned on the same sample. The separator makes each non-zero note value a distinct rising event when connected to Spawn.

### FM1 mode

Enable **FM1 MODE** in the editor menu to replace PLAY and REC with **LIVE EDIT** and a preset selector. Select RAM preset 1 or 2, then enable LIVE EDIT to upload the current root patch (including edits inside subpatches). Space toggles LIVE EDIT in this mode. Entering the mode stops browser playback and recording. FM1 mode is saved with the editor state in local storage and restored on reload. Live Edit starts off each session; turning it off leaves the last patch playing on the FM1.

Live editing requires firmware **FM-1_919 or newer** with the current package format (the live-value protocol was introduced in 918), USB MIDI and browser SysEx permission. Edits are coalesced while a transfer is in flight. Value-only edits with the same compiled layout send indexed Q16.16 updates without resetting oscillators, envelopes or delay state. Connections, modes, control metadata or other changes to the compiled layout upload a complete patch and use the usual fade/reset. Live compilation keeps editable values out of constant folding and can use more operations than an ordinary export. Moving nodes does not send another package. Invalid patches show an error and keep the last valid device patch; fixing the graph resumes synchronization. The browser leaves a 10 ms gap after replies and retries an unanswered status or capability probe once; after a patch-data timeout it checks the device’s received-byte count, continues if the chunk arrived, or resends that chunk once if it did not. Unexpected offsets stop the upload. Activation and value updates are not automatically retried. A transport failure turns LIVE EDIT off; reconnect and enable it again to resynchronize with a complete upload. In FM1 mode, SEND TO FM1 appears immediately to the right of LIVE EDIT and is disabled while LIVE EDIT is on or a transfer is running. Outside FM1 mode it remains in MORE. Updates are RAM-only and do not save the editor patch or survive device power-off.

FM-1 920 parameter display: K1–K4 keep their prefixes; the extra parameter has
no ALG prefix. Each name, value and aligned 46-pixel outlined bar share one
row. Names are cropped to leave room for the complete value. Parameter rows redraw only when their label, value or range changes, with
text and bar composed before transfer to avoid blank-bar flashing.
Params names may contain spaces, punctuation and Unicode and have no FM-1 source
length limit. Full names remain in the editor patch; the device preview is cropped
to 31 UTF-8 bytes at a character boundary and to available screen columns.
Latin-1 characters render directly; other Unicode glyphs display as `?`.
Package v6 uses 128 records of 45 bytes (index, 32-byte zero-padded UTF-8 label,
three i32 range/step fields), a 5,797-byte header and a 12,453-byte maximum package.
Firmware 919 still reads versions 1–5. Install the new firmware, refresh the
rebuilt editor and re-export/upload to use longer names. Hardware display behavior
has not been verified by automated testing.

FM1 mode also filters the node selector to supported and partially supported node types from the capability register (Area remains available for organization). Existing unsupported or unverified nodes turn red, including disabled nodes; turn FM1 mode off to restore the full selector and ordinary colors. Partial implementations still enforce their port and compiler restrictions during live compilation.

The MORE menu closes after selecting any action or toggle; hover over MORE or activate it again to reopen. FM1 preset options use uppercase labels. Live Edit shows only transfer progress and errors above the toolbar; its toggle indicates on/off state.


## Reusable hosted APIs and shared Rust runtime

For a new host implementation, start with the [host handover and dependency distribution guide](docs/host-handover.md). Teia supplies local npm artifacts and a Rust source crate; the production IPC/audio adapter belongs to the consuming host.

Hosted sessions track acknowledged installations independently of newer drafts, display host Save failure details while retaining unsaved changes, and normalize retained parameter overrides when replacement metadata changes bounds, integer mode or step.

The shared native/WASM evaluator supports bend links through the existing bounded `2^x` DSP operation. Both the hosted frontend package and native crate must be updated together. Rejected Apply commands preserve compiler diagnostics; a host must treat missing prepared data as a validation failure and retain the running graph.

See [hosted architecture, contracts and milestone handoff](docs/hosted.md). `npm run build:hosted` creates the private `@pauloricca/teia-hosted` artifacts: document/compiler APIs, a `HostedSession`, and `HostedNodeEditor` extending the existing editor. Hosts supply the initial document, capabilities and a transport-neutral bridge. Hosted mode mounts no standalone audio hook, clock or device backend, and skips global document/viewport storage. Media selection/previews and optional Buffer mutations use supplied host adapters; unavailable operations show clear reasons. Hosted media previews do not create offline audio contexts or fetch source URLs. Node eligibility comes from host capabilities; it does not inherit FM1 restrictions.

The hosted editor provides sliders for installed Params outputs, synchronized with host instance values. Adjusting them sends live instance overrides without changing saved patch defaults; the panel stays visible during canvas edits. Hosts must advertise `parameters` feedback. Routine revision/generation and BPM overlays are hidden, while warnings and disconnect messages remain visible.

Live application and explicit Save are independent. Save succeeds only on a matching host acknowledgement; later edits stay dirty. Command/Control+S saves; Command/Control+Shift+S requests Save As when allowed. Space controls host transport only when advertised. Feedback reports the actual host generation. Hosts own close/draft/conflict decisions and call `session.close()`; cancellation retains the editor session. The host must gate installation by the latest announced revision and preserve exposed parameter overrides by persistent ID.

Unversioned patch JSON remains schema 0. Schema 1 is opt-in. Hosted import adds persistent `parameterId` metadata to Params ports without changing their labels; it survives rename and reorder. XP manifest 2/program 1 remain compatible; legacy mono packages retain engine API 1, while separate stereo inputs require engine API 2 (runtime 0.3.0 accepts both): legacy package parameter `id` stays unchanged, with additive `persistentId` and `parameterIdentityVersion: 1` metadata. Compiler/import diagnostics report normalized and discarded content, and lossy import blocks execution pending review.

The native Rust `native-scalar-v1` name is retained for compatibility. Native and WASM now share Rust instruction/program validation, installation and resource/cache preparation, scalar graph scheduling, parameter smoothing machinery, monitoring, reset and node DSP. One state declaration supplies both WASM globals and owned native fields; instance operations always enter their explicit owned scope. The independent opcode whitelists are removed. Native resource preparation supports samples, images, custom waves, sequencers and Buffer snapshots; hosts must map bindings and decoded assets to `Resources`/`Instance::new_with_resources`. FFT still depends on browser-worklet analysis and is explicitly diagnosed for native use.

Spawn/Spread have an optional shared preallocated policy with explicit capacity/memory budgets and exhaustion feedback. Excess Spawn triggers are dropped and Spread counts capped only when that policy is selected. Existing standalone dynamic capacity remains unchanged. Version-1 native controls retain their immediate behavior; `set_control_smoothing(true)` selects the existing standalone smoothing path. See the [shared runtime plan, migration boundary and evidence](docs/shared-runtime-plan.md). Native tests, allocation guards, compiled-graph comparisons and actual WASM/native output comparisons have been executed; macOS deadlines, editor isolation and Vira integration are not claimed. Build artifacts alone do not execute tests.


Hosted execution revision 4 adds the three Reverb modes and separate stereo outputs for plate and FDN. Reverb bytecode uses `e` for the right output and `value2` for the mode register plus one; zero `value2` retains the legacy original algorithm and single-output format. The extended instruction reserves 64 scalar states and one existing effect buffer per node.

Hosted execution revision 3 adds instance-scoped observation plans for signed
meters, bounded scopes, sample playheads and Buffer previews; staged Buffer
capture/clear/copy/restore; and hierarchical bounded Spread/Spawn pools. The
selected bounded repeat policy supports depth 4 and at most 1024 potential item
slots across all parent contexts, subject to the supplied memory budget. Native
and standalone MIDI note delivery now share a bounded ordered FIFO: one note
every two samples, with a blank separator, so simultaneous note bursts reach
pulse/Spawn consumers in order. Mono state changes at delivery; CC, pitch bend
and control offsets retain their immediate scheduling.

Hosts opt in to bridge-v2 gestures with `bridgeVersion: 2, gestures: 1`: Button
and Keys performance gestures then bypass document edits and Apply, and release
on focus loss. Hosts must also fence/release on disconnect, close and graph
replacement. Without that capability, the existing editing behavior remains.
With `bufferCapture: 1`, explicit Save first requests host-owned durable Buffer
captures and then persists the exact resulting snapshot; newer edits stay dirty.
Buffer mutations additionally require `bufferMutation`. Live Apply never saves.
FFT remains unavailable in native mode; its separate implementation plan and all
thread, queue and allocation rules are in [the host handover](docs/host-handover.md).
