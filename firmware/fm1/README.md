# Teia FM-1 runtime spike

A naked, allocation-free Teia graph interpreter for the M-VAVE FM-1. No Felucca
musical engines, sample bank, sequencer, arpeggiator, mixer or effects are linked.
Felucca supplies the hardware abstraction, boot/interrupt assembly, USB MIDI,
TRS MIDI input, LCD transfers and firmware updater. Derived code is GPL-3.0-only.

**Current source target: FM-1_915**, with two RAM patch slots, USB MIDI SysEx uploads and
PRESETS selection. It boots silent with empty slots. See the
[upload/install guide and protocol](UPLOAD.md) for complete commands and controls.
The editor FM compiler shares the package encoder with the CLI; the Rust/WASM engine is unchanged.

## Feature tracking

The [generated support matrix](SUPPORT.md) is the feature-status register for the
current firmware, covering every editor node plus hardware, MIDI, storage and
maintenance. It separates implementation from verification and preserves evidence
for older firmware without treating it as validation of newer builds. Edit
`support.json` (validated by `support.schema.json`) and follow the matrix’s update
workflow whenever web or firmware capabilities change. It drives frontend warnings,
editor/CLI export gates and binary upload preflight; `limits.json` is a generated
compatibility mirror. Structured drift records the web behavior, firmware behavior
and work needed to catch up. Enabled unsupported/unknown nodes block export even
when unused; partial nodes must satisfy the registered port and operation rules.
The static `npm run fm1:support:check` command detects missing node decisions,
source changes needing review and stale generated documentation.

## What runs

`export-patch.mjs` invokes Teia's actual `compilePatchToDspProgram`, validates the
supported subset, and lowers it to portable binary instructions. The native
firmware interprets those instructions. Graph wiring and parameter bindings are
uploaded data. DSP primitives, hardware drivers and lookup tables are firmware.
There is no embedded demo program in the current application image. A patch may
use an explicit MIDI Note node for keyboard or MIDI-controlled playback, but it is
not required: fixed-frequency or continuously gated drone patches are valid too.
One enabled Params node may expose up to six outputs; their saved order is the
hardware-control order.

Firmware 913 matches the compiled WASM link arithmetic boundaries: value loads,
divide-by-one copies, add/subtract/multiply/divide results and bend ratios are
bounded to ±12,000. The shared compiler still evaluates weighted sources, averages
set links (or uses the local base), then applies add, multiply and individual bend
links. Each stage is bounded before the next, so intermediate clipping can affect
averages and prevent opposing bends from cancelling. This also applies to generated
link-strength Multiply stages. Internal DSP helpers keep their full Q16.16 working
range; the patch format and opcode identities are unchanged. Fixed-point rounding,
small-value underflow and unsmoothed knob updates remain differences from WASM.
Install 913 and re-upload the patch to use the fix; an editor rebuild is unnecessary.
The change is source reviewed; host execution and hardware audio/timing are unverified.

Firmware 914 removes unnecessary work from neutral operations: Pow at exponent
one is an exact identity instead of using fixed-point log2/exp2; bend at zero
returns unity; multiplication by zero/unity and division by ±1/±2 use exact fast
paths. The signed division paths preserve truncation toward zero. Other Pow
exponents still use the existing approximation. This was motivated by increasing
device late buffers with `test-fm-3`, not by a nonzero pitch bend at weight zero.
The offline firmware render keeps its oscillator at 220 Hz with that zero-weight
link. Host comparisons cannot measure the board's deadline: after installing 914
and re-uploading the patch, check MAX RENDER US against the roughly 2.9 ms audio
half-buffer interval and confirm LATE BUFFERS does not continue to grow. Knob
interpolation and feedback-delay placement are unchanged.

Firmware 915 builds two dependency-ordered instruction lists when loading a patch.
Value loads and pure operations depending only on them are prepared after the
hardware controls are copied at a half-buffer boundary. Their registers remain
cached until the values change. Stateful nodes, audio-derived calculations, MIDI
outputs (including one-sample triggers), and feedback reads/writes remain in their
original per-sample order. Non-single-assignment packages conservatively keep all
instructions in original order. The sample-compatible renderer also preserves
legacy packages' per-sample level smoothing. No new instruction or package format
is needed, so existing exported patches benefit from the firmware update.

ADSR progression now advances an exact quotient/remainder ramp for an unchanged
duration; time modulation, retriggers and elapsed-position changes refresh it.
This avoids the repeated 16-step fractional divide and preserves the previous
Q16.16 result. The runtime remains within the existing 16 KiB arena. Knob
interpolation and feedback-delay placement are unchanged.

The `feedback-bend.json` fixture captures the K3-modulated `test-fm-3` graph: 46 of
72 instructions become control work, leaving 26 audio-rate instructions. Host
ASan/UBSan comparisons of this graph and 22 existing examples passed with exact
samples, registers and DSP state across control changes and MIDI triggers. Stereo
PCM was also bit-identical to a separately compiled 914 renderer for all 23 patches.
These results verify the optimisation's tested numerical behavior, not device CPU
margin. Install 915, re-upload the patch and check that late buffers stop increasing.

The original two fixtures compile to a small MIDI-driven oscillator/envelope graph.
Sine connects a sine oscillator through an envelope to output; Octave sine
changes the MIDI Note frequency link weight to 2 and starts with a slower attack.
Both use MIDI Note for pitch/gate and Params for level, attack and release. The additional
Tremolo fixture uses two sines, including a 0–1 modulator, and compiles to 68
operations, 66 registers, 27 values and 1,856 bytes.

## Controls

| Control | Action |
| --- | --- |
| PRESETS | Left: slot 1; right: slot 2, including empty slots |
| Knobs 1–4, SELECT, ALGORITHM | Ordered Params outputs 1–6. Each output supplies its display label, default and range; the firmware uses one percent of that range as an encoder step. |
| Physical note keys | One voice, highest held note wins; F3–G5 at the centred octave using upstream matrix mapping |
| OCT− / OCT+ | Transpose physical keys down/up one octave per press, limited to −3…+3; press both to centre. The lit button steadily points back to centre; neither is lit at zero. MIDI is unchanged. |
| USB or TRS MIDI, channel 1 | Note on/off; velocity zero is note off; CC 120/123 clears that source's held notes |
| MASTER | Physical output level, read before audio starts and smoothed |
| Both OCT buttons held for 5 s | Mute, detach USB and request ROM recovery; still unverified |

PRESETS uses encoder 6; Knobs 1–4 use encoders 2/3/4/5, SELECT uses encoder 0,
and ALGORITHM uses encoder 1. The display's first line is the selected patch number
and name (for example, `1 Sine`), followed by an empty line. Each parameter line
starts with its physical control reference (`K1`–`K4`, `SEL`, or `ALG`), then its
label and actual declared-unit value (up to four decimal places), followed by maximum render time,
late-buffer count and MIDI-overflow count. Calibration storage is not implemented.

Keys held through startup are ignored until all physical keys are released.
MIDI overflow clears held MIDI notes; USB bus reset releases USB-held notes.
USB and TRS ownership are separate; physical keys are independent. Mono note
changes are legato. The MIDI Note node receives note, frequency, velocity, gate
and a one-sample note-on trigger. It accepts its default `all`/channel-1 setting;
channels 2–16 are not implemented. Patch switching fades out/in across two
128-frame buffers, resets DSP state and retriggers held notes. Sustain, pitch bend
and channel routing are not implemented.

## DSP limits

- Supported: Params, Constant, Pass, Multiply; addition/subtraction/division/negation
  in basic Expression arithmetic and compiler-generated mixing; Sine, Triangle,
  Saw, Ramp, Square, Kink Osc and Sample Hold oscillators; Custom Wave; Noise;
  Envelope; LowpassFilter, HighpassFilter, BandpassFilter, AllpassFilter;
  Crossover (compiler-generated low/high-pass cascades); HardClipDistortion,
  SaturateDistortion, WavefoldDistortion, Fold, Abs, RemoveDc, Clamp, Accumulator, Random; AudioOut.
  Expressions also support abs/min/max/clamp/floor/ceil/round/sign/fract,
  comparisons and boolean logic.
  Other operations still fail export and device validation.
- Q16.16 signals/parameters, Q0.32 oscillator phase, 1,024-point interpolated
  sine tables, Q28 biquad coefficients. Saturating arithmetic; divide by zero
  returns zero. No heap, floating-point DSP or WASM interpreter on the device.
- Maximum 256 operations, 256 registers, 128 values and 32 state entries per patch.
  These remain configurable storage limits, not a measured audio CPU budget.
  Version 3 uses 24-byte instructions (maximum package 6,772 bytes); firmware 907
  also decodes older 12-byte version-1/2 instructions. The runtime still fits its
  reserved 16 KiB arena; patch banks and staging storage are additional.

### Inputs and differences from the browser engine

| Node / feature | FM-1 behavior and units |
| --- | --- |
| Oscillator frequency | Hz, clamped to 0–20,000; connect a modulator here for frequency modulation |
| Oscillator phase | Cycles (1 = a full turn); negative and positive offsets wrap; accepts audio-rate modulation |
| Oscillator phase reset | Rising edge at 0.5 resets phase to zero; held high does not repeatedly reset; reset crossfades from the prior waveform value over about 8 ms |
| Oscillator range endpoints | Q16.16 values; live, equal and inverted endpoints supported |
| Square pulse width | Fraction of a cycle, clamped to 0–1; live PWM supported |
| Feedback loops | One-sample Q16.16 history: paired feedback read/write instructions share a state slot, which resets on patch load or switch; hardware stability remains unverified |
| Noise | Independent deterministic xorshift sequence per node, reset on patch load; live range endpoints |
| Envelope signal | Multiplied by the envelope; defaults to unity when unconnected |
| Envelope gate / trigger | Threshold 0.5; rising gate or trigger retriggers from current level; falling gate releases. A MIDI Note `trigger` is a one-rendered-sample pulse independent of its held `gate`, so wiring it only to `trigger` does not hold sustain |
| Envelope delay / attack / decay / release / gate length | Seconds, clamped to 0–60; minimum attack 45 samples (about 1 ms). Linear stages; live time values. Trigger-only envelopes hold sustain for gate length after decay, then release |
| Envelope sustain | Linear level clamped to 0–1; held while gate is high |
| LowpassFilter / HighpassFilter / BandpassFilter / AllpassFilter: signal / cutoff / resonance → signal | RBJ biquad (12 dB/octave low/high-pass, unity-peak band-pass, phase-only all-pass); cutoff Hz clamped to 20–19,845, resonance Q clamped to 0.25–16; live modulation with cached coefficients |
| HardClipDistortion / SaturateDistortion / WavefoldDistortion: signal / drive → signal | Live drive clamped to 0.1–40 (default 2.5). Hard clip bounds the driven signal to ±1; Saturate uses x/(1+abs(x)) after bounding the driven signal to ±32; Wavefold wraps/reflects the unsaturated driven signal into ±1 |
| Fold: signal / amount → signal | Live amount, default 1; gain 1 + 3 × max(amount, 0), triangle folding into ±1; negative amounts behave as zero |
| Abs: signal → signal | Rectification; the minimum negative Q16.16 value saturates to the largest positive value |
| RemoveDc: signal → signal | 10 Hz one-pole DC blocker at 44.1 kHz, input/output bounded to ±4; Q24 history reset on patch load/switch |
| Clamp: signal / min / max → signal | Live bounds (defaults 0/1); reversed bounds are sorted before clamping |
| Accumulator: trigger / reset / increment / min / max → signal | Threshold 0.5, rising edges only; reset wins simultaneous edges and sets the lower endpoint. Trigger mode advances once per edge; continuous mode once per sample. Increment defaults to 1, bounds to 0/1. Overshoot jumps to the opposite endpoint without retaining the remainder; reversed bounds accepted. State starts at zero clamped to the current bounds |
| Random: trigger / range minimum / range maximum → signal | Generates once initially, then on rising trigger edges at 0.5; no trigger holds the initial value. Held trigger does not repeat. Live endpoints remap the held random fraction, including equal/inverted ranges. Deterministic per-node sequence resets on patch load |
| Expression additions | abs/min/max/clamp/floor/ceil/round/sign/fract, comparisons and boolean logic; round ties away from zero; fractional part stays in [0,1), including negative inputs. Boolean results are 0/1; nonzero is true. Results saturate to Q16.16; transcendental functions, pow, sqrt and mix remain unsupported |
| Kink Osc | Live frequency, phase/reset, shape, squareness and range endpoints. Fixed-point power shaping is approximate and not band-limited |
| Sample Hold | Holds the input value initially and on a rising trigger at 0.5; state resets with the patch |
| Custom Wave | Curve points are embedded in package values. Live frequency, phase, trigger, base level and range work; loop/ping-pong/one-shot are available. Sustain progression and `end trigger` differ from the browser |
| Tempo | Internal BPM division pulses and frequency outputs. MIDI clock source selection and swing are not implemented |
| Quantise | Fixed-point nearest-scale frequency quantiser for all editor scales and roots; log/power approximation differs from browser precision |
| Map | Live source/target ranges with saturating Q16.16 arithmetic; an equal source range uses one unit instead of the browser epsilon |
| pow | Sign-preserving power: `sign(signal) × abs(signal)^exponent`; fractional exponents retain bipolar audio. Fixed-point `log2` plus interpolated `2^x` bounds work per sample; results saturate |
| Delay | One delay node per patch, with time/feedback/mix. The fixed 2,048-sample line limits time to about 46 ms at 44.1 kHz and has integer-sample taps |
| Follower | Rectification with live, linear Q16.16 attack/release smoothing; zero time is immediate |

Crossover accepts `signal` and `frequency 1` … `frequency 8` (according to points),
and outputs `band 1` … `band 9`. Its 12/24/36/48 dB/octave slope cascades
Butterworth low/high-pass sections with the same cutoff limits. The compiler reserves
four state entries per section, so the 32-entry budget limits the number of bands
and slope, especially alongside oscillators/envelopes. Recombined bands are not
guaranteed phase-aligned or flat. All new filters require firmware 905 (opcodes
29–31); 904 rejects these instructions without replacing a preset.

Waveforms are not band-limited: saw/square and strong FM/PM can alias. Phase reset
is immediate (no browser reset crossfade). Filter response approximates the
browser biquad with fixed-point coefficients and a narrower resonance range;
large/resonant signals saturate. Audio-rate cutoff/Q changes cost considerably
more than static settings. Legacy version-1/2 AR instructions retain the original
2-second, edge-captured timing. New ADSR stages use live durations quantised to
samples. Envelope `end trigger` remains unsupported. This backend is not
bit-identical to the Rust kernel; see the support matrix for each node's limits.

Examples: `patches/subtractive.json` (saw/low-pass/ADSR), `patches/phase-fm.json`
(two sines, quarter-cycle modulation depth), and `patches/noise.json` (noise
percussion), plus `patches/arithmetic.json` (triangle/square/ramp mixed by an Expression). Load them with **LD**, then use **FM** after updating to firmware 904.
Every example must contain MIDI Note for performance input. Params outputs are
optional, named per patch and map in their saved order to the six hardware encoders.

- Nominal 44.1 kHz; the inherited I2S divider is documented upstream as roughly
  44,117.6 Hz. Pitch and timing still require measurement. DMA halves contain
  128 stereo frames, with a roughly 2.9 ms deadline.
- Output is bounded before conversion to 24-bit with an additional 6 dB of bench
  headroom. The device output bound is not a graph effect.

## Build and host checks

Use the [pinned build environment](../../docs/spikes/fm1-build.md). `npm run fm1:install` builds when inputs or the cached package change, then installs and verifies the connected device. `npm run fm1:install -- --build-only` prepares firmware without device access. See [installation options](UPLOAD.md#build-and-install-firmware).

For the standalone builder and optional host checks, from the root:

```sh
.cache/fm1-spike/python/bin/python scripts/fm1-runtime-spike.py
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I .cache/fm1-spike/naked/build/gen firmware/fm1/test-runtime.c \
  -lm -o .cache/fm1-spike/test-runtime
.cache/fm1-spike/test-runtime
```

Additional offline checks (only run when functional testing is intended):

```sh
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I .cache/fm1-spike/naked/build/gen firmware/fm1/test-nodes.c \
  -lm -o .cache/fm1-spike/test-nodes
.cache/fm1-spike/test-nodes

cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I .cache/fm1-spike/naked/build/gen firmware/fm1/test-links.c \
  -lm -o .cache/fm1-spike/test-links
.cache/fm1-spike/test-links

cc -std=c11 -O2 -Wall -Wextra -Werror -Wno-unused-function \
  -fsanitize=address,undefined -fno-sanitize-recover=all \
  -I .cache/fm1-spike/naked/build/gen firmware/fm1/test-schedule.c \
  -o .cache/fm1-spike/test-schedule
.cache/fm1-spike/test-schedule .cache/fm1-spike/naked/patches/*/patch.tgp
```

`test-links.c` covers signed set-average clipping, weighted mixed link modes,
link-strength stages, order-dependent opposing bends, bend-ratio clipping and
value/arithmetic bounds, including the divide-by-one optimization. Compile without
executing it when only static validation is authorized.

`test-nodes.c` covers arithmetic saturation, waveform landmarks, phase/reset,
noise bounds, ADSR/timed gates, MIDI trigger-versus-gate separation, low-pass response/impulse bounds and invalid
operands. The upload guide gives additional transaction/slot and range tests. Tests use the same
C renderer as firmware, with ASan and UBSan, including analytic sine/envelope
comparison. They do not emulate interrupts, peripherals or target CPU costs.
The builder checks entry/flash-off routines, absence of ROM calls, memory limits,
hardware-register isolation and absence of Felucca musical symbols and the old
embedded demo program. It recreates only `.cache/fm1-spike/naked/` and uses
isolated compiler containers without launching the desktop app.

The `.fwsc`, ELF, hashes, symbol and section reports are under
`.cache/fm1-spike/naked/build/`; exported patches are under `naked/patches/`.
Firmware changes require rebuilding and installation; patch edits need only
export/upload. Refresh the editor after rebuilding its bundle to load the matching compiler.

## Hardware evidence

On 2026-10-09, Paulo installed **FM-1_901**, the first version with one embedded
graph, and confirmed playback, three knobs and MIDI (transport not recorded).
The late-buffer count started at 1 and stayed there; the cause is not established.
The agent then reinstalled the same image through the running Teia firmware.
The device entered the loader, completed writing, rebooted and answered as
`FM-1_901`; the installer exited 0. That package's SHA-256 was
`035ec4f01b3a9904da4126fa3f5bb73da34b4a7e70904296ecad53b89c04186d`.

These results establish basic playback and the normal same-image update path.
Return to stock, interrupted updates, ROM recovery, sustained load and measured
pitch/output quality remain unverified. The USB IDs are upstream experimental
IDs, unsuitable for a release. Current upload-spike evidence is recorded in the
[upload guide](UPLOAD.md); do not treat the original checks as verification of
new features.

## Source provenance

Pinned Felucca commit: `129a4cf4e98e6ef06a4a89e97b65092247d69412`.
Hardware and updater code: Copyright (C) 2026 Leo Kuroshita (@kurogedelic),
Hügelton Instruments, GPL-3.0-only. The build copies only the selected service
files into its generated source tree, preserving their headers. USB device
strings are changed to identify this experiment; loader protocol identity stays
compatible. Inter Tight glyphs are SIL OFL 1.1. SDK packaging inputs keep their
Apache-2.0 license. Notices are copied alongside the generated source; see the
upstream `LICENSING.md`. This repository's local build paths are not a complete
public source distribution: publish corresponding source/build tools and all
required notices together before distributing a release.

## Firmware 904 validation status

The cross-compiled image passes the pinned builder's memory, MMIO, flash-off and
forbidden-symbol checks. New example graphs compile to version-3 packages.
Host DSP tests are supplied and statically compiled, but have not been executed
for this revision. On 2026-10-10, firmware 904 was installed from 903; the installer
completed successfully and verified the rebooted device identity as `FM-1_904`.
Audio behavior and late-buffer performance of the new nodes remain untested.
After installation, try each example with MIDI notes and knobs, watching that
late buffers do not increase. Then exercise PWM, phase reset, trigger-only ADSR,
and static versus modulated filter cutoff. Memory fit does not establish timing
headroom for those combinations. The previous local 903 build was preserved in
`.cache/fm1-spike/known-good-903/` before rebuilding.

## Firmware 905 validation status

High-pass, band-pass, all-pass and Crossover are implemented for firmware 905.
The firmware cross-build passes memory, MMIO, flash-off and forbidden-symbol
checks; the editor typecheck/build and all four example exports pass.
Examples: `patches/highpass.json`, `bandpass.json`, `allpass.json` and
`crossover.json` (upper band, 24 dB/octave).
Host filter-response and operand-validation checks are provided in `test-nodes.c`
and statically compiled, not executed. Build/install 905 before uploading patches
using these nodes; no 905 hardware verification is claimed. Check cutoff/resonance
sweeps, separated Crossover bands and the late-buffer counter on the device.

## Firmware 906 validation status

HardClipDistortion, SaturateDistortion, WavefoldDistortion, Fold, Abs and RemoveDc
require new opcodes 32–37 in the existing version-3 package layout. Older firmware
rejects these operations before replacing a preset. No host audio or device
verification is claimed; the supplied `test-nodes.c` checks are compiled only.
The new examples are `patches/hardclip.json`, `saturate.json`, `wavefold.json`,
`fold.json`, `abs.json` and `remove-dc.json`. After installing 906, try them with
MIDI notes, vary drive/amount, and watch the late-buffer count. To exercise DC
removal, connect a Constant or an offset waveform and check that the steady
component decays. These shapers have no oversampling and can alias; Soft Clip
and Fuzz remain unsupported. The Rust/WASM engine is unchanged.

## Firmware 907 validation status

Clamp, Accumulator, Random and expanded Expression functions use new opcodes
38–40 in version-3 packages. Install 907 before uploading these examples:
`patches/clamp.json`, `accumulator.json`, `random.json`, `expression-functions.json`.
The Accumulator and Random examples change oscillator pitch on gate rising edges:
release all notes before the next note to advance, since mono note changes are legato.
Random is repeatable after patch reload, unlike the browser's seed sequence.
Static C checks cover bounds, rounding, trigger/reset priority, wrapping, random
hold and invalid operands; they are not executed without test authorization.
Audio behavior, sustained load and hardware timing are unverified for 907.

## Firmware 908: bend links

Bend links and nested link-strength modulation compile to instruction 41, which
computes `2^exponent` before multiplication. `+1` doubles, `-1` halves, and `0`
leaves the value unchanged. A 257-entry Q2.30 table with linear interpolation
avoids floating point; interpolation contributes approximately 0.0001% relative
error before Q16.16 rounding. Ratios saturate at 32767.9999847; exponents below
-17 round to zero. Multiplication retains the normal Q16.16 saturation.
This numeric range differs from the web engine's double precision operation
with exponent clamping at ±32. MIDI pitch-wheel input remains unsupported.

The `patches/bend.json` example doubles the base oscillator frequency using both
ordinary bend mode and bend modulation of link strength.
Build/install 908 and rebuild/refresh the editor for bend support. Source reviewed;
firmware cross-build, installation, sound and timing have not been verified.

## Firmware 909: feedback loops and oscillator reset smoothing

Feedback loops now compile into paired instructions 42 and 43. A read returns the
previous sample's Q16.16 value; the corresponding write stores the completed value
for the next sample. Each pair has an exclusive state slot and resets when the
patch loads or switches. This preserves browser ordering while retaining the
firmware's fixed-point limits. The existing low-pass, high-pass, band-pass and
all-pass instructions remain available with live cutoff/resonance modulation.

Sine, triangle, saw, ramp and square phase resets now crossfade from the prior
waveform value for about 8 ms. Frequency and phase inputs remain audio-rate, and
square pulse width remains audio-rate. These oscillators are still not
band-limited, so high pitches or strong modulation can alias. Build/install 909
and rebuild/refresh the editor before exporting feedback patches. Source reviewed;
firmware cross-build, hardware audio and timing remain unverified.

## Firmware 910: bounded utility nodes and waveforms

Firmware 910 adds instructions 44–51 for Delay, Follower, Map, pow, Quantise,
Tempo, Sample Hold and Custom Wave, and extends the oscillator instruction with
Kink Osc. `patches/fm1-910-nodes.json` exercises every new lowering in one
static export fixture. The implementations are deliberately bounded: only one
2,048-sample delay line is available (about 46 ms), Custom Wave has no `end
trigger` and reduced sustain progression, Tempo is internal-only without swing,
and Kink/pow/Quantise use fixed-point approximations. Build/install 910 and
rebuild/refresh the editor before exporting these patches. Source reviewed;
cross-build, hardware audio and timing remain unverified.

### Compiler instruction simplification

The exporter optimizes the lowered Q16.16 stream with exact integer arithmetic,
retaining rounding and every necessary +/-12000 clipping boundary. Immutable
values can be folded; physical controls remain mutable even when their defaults
match. Duplicate pure calculations and unused pure work are removed. Stateful
operations and feedback reads/writes retain their order, state slots, and register
numbering; wave assets and control value indices are unchanged. Register and value
pools are not compacted. No firmware version or protocol change is required:
rebuild/refresh the editor and re-upload to firmware 915 to use this compiler change.

Run `node scripts/test-fm1-optimizer.mjs` for the offline native differential test
(requires a host C compiler and explicit permission for runtime tests). It compiles
the exporter with and without optimization, then compares 700 blocks of PCM, DSP
state, feedback and delay contents for each of 23 regression fixtures, changing
controls and MIDI events. It also checks arithmetic clipping/rounding and mutable
control guards. The bend feedback fixture shrinks from 72 to 30 instructions and
2035 to 1027 package bytes. This measures stream size and equivalence, not device
render time. The broader historical `fm1-910-nodes` fixture is not part of this
suite: its unoptimized package already fails the current native decoder.
