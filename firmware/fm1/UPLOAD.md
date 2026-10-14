# Uploading Teia patches to the FM-1

## Upload directly from the editor

Click **FM** immediately to the right of **XP**. The modal compiles a snapshot of
the current patch and shows resource usage against the shared firmware limits.
Unsupported operations, invalid controls and exceeded limits disable upload.
With firmware `FM-1_912` or newer connected by USB, enter preset **1** or **2** and
click **Upload**. Allow MIDI SysEx access when the browser asks. Chrome or Edge
on HTTPS or localhost supports this workflow. The uploader finds the
`Teia FM-1 spike` MIDI input/output pair; connect only one matching device.

Use **FM-1_913** for the corrected WASM-compatible link arithmetic bounds. Older
firmware accepts the same patch format but retains the previous arithmetic.
After installing firmware, upload the patch again; no editor rebuild is needed.

Firmware **914** additionally avoids costly neutral Pow/bend/arithmetic operations.
For patches that distorted while LATE BUFFERS increased, install 914 and re-upload,
then check the counter during playback. Host validation is not a hardware timing
guarantee.

Firmware **915** additionally prepares constant/knob-only expressions outside the
sample loop and uses exact incremental envelope ramps. This includes K3 modulation
of a link's weight. Install 915 and re-upload the existing patch; the editor and
package format do not need changing. Check the device's render time and late-buffer
counter after installation; desktop tests cannot establish device timing margin.

Uploading replaces and activates the selected RAM slot. It does not install
firmware or persist patches through power-off. Success appears only after the
device acknowledges activation. If acknowledgement is lost at the final step,
check the device: the patch may already be active. The editor uses the same
compiler and binary encoder as `export-patch.mjs`, including the default
level/attack/release knob bindings described below.


Firmware `FM-1_904` provides two volatile program slots. It boots silent with both
slots empty; every sound comes from an uploaded Teia graph. Firmware updates
still use `fm1_install.py` and `.fwsc`; ordinary patch uploads use the separate
sender below and do not write flash or restart the device.

## Build and install firmware

Connect one FM-1 with a USB data cable, then run from the repository root:

```sh
npm run fm1:install
```

This command installs firmware immediately, rebooting the device and clearing
its RAM patch slots. Keep the device connected until the installer reports the
verified firmware identity. It does not build or restart the editor.

The script audits the support register and checks the pinned upstream repositories
and compiler. It rebuilds when firmware, graph/compiler, build-script or package
configuration contents have changed, when files were added/deleted, or when the
cached package is missing or its SHA-256 differs. Existing builds without the
script's input record are rebuilt once. A successful build stores its input hashes
and package checksum in `.cache/fm1-spike/naked/build/install-build.json`.
Build failures or source changes during compilation prevent installation. A lock
prevents concurrent invocations of this wrapper. Avoid running the underlying
builder or installer separately while it is active.

```sh
npm run fm1:install -- --build-only       # prepare firmware without device access
npm run fm1:install -- --force-build      # rebuild and install
npm run fm1:install -- --port 'Teia FM-1' # choose a MIDI port by name/substring
```

The wrapper uses `.cache/fm1-spike/python/bin/python` for the builder and
`.cache/fm1-spike/install-env/bin/python` for the pinned upstream installer.
The installer validates the package/model, uploads, reboots, and checks the
reported firmware identity. It receives `--yes`: invoking this command authorizes
installation without a second prompt. Installation errors are returned without
automatically retrying the flash.

The installer environment needs `mido` and `python-rtmidi`. The source, toolchain,
SDK, Docker compiler environment and build Python are the same as
[spike 1](../../docs/spikes/fm1-build.md). The wrapper uses the existing environments;
it does not install dependencies. For the separate MIDI environment:

```sh
python3 -m venv .cache/fm1-spike/install-env
.cache/fm1-spike/install-env/bin/python -m pip install mido python-rtmidi
```

The previously proven `FM-1_901` and `FM-1_902` packages are preserved in
`.cache/fm1-spike/known-good-901/` and `.cache/fm1-spike/known-good-902/` on this Mac.

## Upload and play

```sh
.cache/fm1-spike/install-env/bin/python scripts/fm1-send-patch.py --status
.cache/fm1-spike/install-env/bin/python scripts/fm1-send-patch.py --slot 1 \
  .cache/fm1-spike/naked/patches/sine/patch.tgp
.cache/fm1-spike/install-env/bin/python scripts/fm1-send-patch.py --slot 2 \
  .cache/fm1-spike/naked/patches/octave/patch.tgp
```

Every successful upload activates its slot. Slot 1 plays **Sine**; slot 2 plays
**Octave sine**, whose frequency link has weight 2, so the same key is an octave
higher. The second graph also starts with a slower attack. These are ordinary
Teia graphs compiled by `compilePatchToDspProgram`, with the same bounded lowering
as the first spike. Each version-3 package is 1,300 bytes; neither graph is linked into the
firmware application.

Turn **PRESETS** left for slot 1 and right for slot 2 (encoder 6). The display
shows the selected patch number and name on one line (for example, `1 Sine`), an
empty line, then each control reference (`K1`–`K4` or `ALG`), label and
actual value in its patch-declared units, rounded to up to four decimal places.
Both examples bind Knobs 1/2/3 to
level/attack/release.
Keyboard and channel 1 MIDI control the selected graph. Selecting an empty slot
produces silence. Knob changes stay in that RAM slot when switching away and
back, but replacing the slot restores the new graph's defaults.

Selection can also be requested from the sender:

```sh
.cache/fm1-spike/install-env/bin/python scripts/fm1-send-patch.py --select 1
```

Powering off or reinstalling firmware clears both slots. USB reconnection alone
does not clear them, but cancels an incomplete transfer. No editor restart or
refresh is involved. Firmware changes require a rebuild and installation;
patch changes require only export and upload.

## Export another supported graph

```sh
node firmware/fm1/export-patch.mjs .cache/fm1-spike/my-patch path/to/patch.json
.cache/fm1-spike/install-env/bin/python scripts/fm1-send-patch.py --slot 1 \
  .cache/fm1-spike/my-patch/patch.tgp
```

The backend supports arithmetic/mixing, sine/triangle/saw/ramp/square with live
range/phase/reset/PWM, one-sample feedback loops, noise, ADSR with delay/trigger/timed gate, low/high/band/all-pass filtering,
Crossover (the new filters and Crossover require firmware 905),
Hard Clip/Saturate/Wavefold distortion, Fold, Abs and Remove DC (require 906),
Clamp, Accumulator, Random and expanded Expression functions (require 907),
Delay, Follower, Map, pow, Quantise, Sample Hold, internal Tempo, Kink Osc and
Custom Wave (require 910, with the limits documented in the runtime notes), and
stereo output. See [node support and units](README.md#inputs-and-differences-from-the-browser-engine). Unsupported
nodes/modes fail export. Limits: 256 operations, 256 registers, 128 values, 32 state
entries (defined in `support.json`; `limits.json` is generated). This is not general Teia patch compatibility or a measured CPU budget.

An FM-1 patch may include a `MIDI Note` node to use the board's physical keys or
USB/TRS MIDI channel 1. Connect its `frequency`, `gate`, velocity, note or trigger
outputs just as in the editor. It is optional, so fixed-frequency and continuously
gated drone patches can export without it. When present, its `channel` control must
remain at `all` or `1` and cannot be linked on FM-1.

One enabled Params node may expose outputs within the shared 128-value patch budget. There are no reserved
parameter names or `fm1.controlsNode`/`fm1.knobs` metadata. Params outputs map in
their saved order to **Knob 1**–**Knob 4** for the first four. **Select** browses
extras, stopping at either end; **Algorithm** edits the single visible extra.
Browsing preserves values. Aligned outlined bars display each visible value
as a proportion of its min/max range. The output name is shown on the screen, its default becomes the
uploaded value, and its min/max become the encoder range. Labels accept spaces, punctuation and Unicode; see the firmware 919 display and UTF-8 rules below. Firmware steps each
encoder by one percent of the declared range. Patch names are 1–23 printable
ASCII characters. Values are delivered at the start of each audio buffer;
envelope durations are captured at gate edges.

Older editable patches that still wire Params outputs named `frequency` and
`gate` are converted to an internal MIDI Note source during FM-1 compilation so
existing patch libraries remain exportable. New patches should add MIDI Note
explicitly; that makes pitch, gate, velocity and trigger wiring visible.

## Transfer and activation

The experimental non-commercial SysEx prefix is `F0 7D 54 45 01`, followed by a
command byte, a 7-bit request token, an LSB-first packed 8-to-7 payload and `F7`.
Use one sender at a time; it waits for each acknowledgment. Commands:

| Command | Decoded payload |
| --- | --- |
| 0 status | empty |
| 1 begin | slot u8 (0/1), total u16, CRC-32/IEEE u32 |
| 2 data | offset u16, 1–96 bytes |
| 3 commit | empty |
| 4 select | slot u8 (0/1) |
| 5 capabilities | empty; reply adds the maximum package version before F7 |

Multibyte fields are little-endian. Replies use the same prefix, `command OR
0x40`, token, status, received-count low/high 7-bit bytes, active slot and loaded
slot bitmask, then `F7`. Status codes: 0 success, 1 bad command/length, 2 missing
or out-of-order transfer, 3 CRC mismatch, 4 invalid graph, 5 switch busy.
Commit/select replies are sent only after the audio thread has applied them.
A lost acknowledgment is ambiguous: use `--status` before retrying an upload.
The sender does not blindly repeat a commit. The browser waits 10 ms after a matched reply before sending the next request, allowing existing firmware to release its receive mailbox. It retries a timed-out status, package-capability or live-edit-capability probe once with a fresh token; device errors are not retried. After a patch-data timeout, the browser queries status: the chunk’s end offset confirms acceptance, its start offset permits one resend, and any other offset stops the upload. A second data timeout stops the upload. Begin, commit, selection and value updates are never automatically retried. This uses the existing status offset and ordered-data protocol; no firmware update is needed. Hardware verification of recovery remains pending. A new begin replaces an incomplete
transfer; a 10-second idle timeout or USB reset cancels it.

Package `TGP1`, version u16=6: counts (operations/registers/values, three u16),
24-byte zero-padded name, a u8 Params-control count and 128 reserved control records
(value index u8, zero-padded UTF-8 label[32], min/max/step i32), followed by operations
(twelve i16 each) and values (i32 each). The version-6 header is 5,797 bytes;
maximum total size is 12,453 bytes. Firmware 919 reads versions 1–6; version 4
retains its 187-byte header and six records. Version 5 retains its 3,237-byte header. Older firmware rejects v6 packages. No native C structures are sent over USB.

Version 4 adds ordered Params controls and the MIDI Note instruction. Version 3 adds native arithmetic, oscillators/phase/PWM, noise, ADSR and low-pass
instructions. Each record has fields `code,out,a,b,c,state,d,e,f,g,h,i`, all i16.
Value/register references are checked for bounds and use-before-definition;
stateful instructions must use distinct state slots. Operand layouts:

| Code | Meaning | Operands |
| --- | --- | --- |
| 0, 1, 2, 3, 5, 19, 20 | Legacy value/copy/multiply/sine/output/AR/ranged sine | Original first six fields; additional fields unused |
| 21, 22, 23 | Add, subtract, divide | a, b: input registers |
| 24 | Negate | a: input register |
| 25 | Oscillator | a: frequency, b/c: range, d/e: phase/reset (−1 = absent), f: pulse width (−1 except square), g: waveform 0–4 |
| 26 | Envelope | a: gate, b: attack, c: decay, d: sustain, e: release, f: trigger, g: delay, h: gate length |
| 27 | Low-pass | a: signal, b: cutoff, c: resonance Q |
| 28 | Noise | a/b: range minimum/maximum |
| 29 | High-pass (905+) | a: signal, b: cutoff, c: resonance Q |
| 30 | Band-pass, unity peak (905+) | a: signal, b: cutoff, c: resonance Q |
| 31 | All-pass (905+) | a: signal, b: cutoff, c: resonance Q |
| 32 | Absolute value (906+) | a: signal |
| 33 | Fold (906+) | a: signal, b: amount |
| 34 | Hard Clip distortion (906+) | a: signal, b: drive |
| 35 | Saturate distortion (906+) | a: signal, b: drive |
| 36 | Wavefold distortion (906+) | a: signal, b: drive |
| 37 | Remove DC (906+) | a: signal; state: unique history slot |
| 38 | Expression function (907+) | a/b/c: arguments as needed; d: function id (1, 6–8, 13–17, 19–27); no state |
| 39 | Accumulator (907+) | a: trigger, b/c: bounds, d: increment, e: reset, f: mode (0 trigger / 1 continuous); unique state |
| 40 | Random (907+) | a/b: range endpoints, c: trigger register (−1 if absent); unique state |
| 41 | Bend scaling (908+) | a: exponent register; out: Q16.16 ratio `2^a`, rounded and saturated; no state |
| 42 | Feedback read (909+) | out: previous Q16.16 value; state: shared feedback history slot |
| 43 | Feedback write (909+) | a: completed Q16.16 value; state: matching feedback history slot |
| 44 | Legacy Delay (910+) | a: signal, b: time, c: feedback, d: mix; unique state. Before 917: one 2,048-sample line. On 917: upgraded to the smoothed delay behavior below |
| 53 | Smoothed Delay (917+) | Same operands as 44; up to two independent one-second 16-bit lines, fractional interpolation and 256-sample time smoothing. Both delay instructions count toward the shared two-node ceiling |
| 45 | Follower (910+) | a: signal, b: attack, c: release; unique state |
| 46 | Map (910+) | a: signal, b/c: source minimum/maximum, d/e: target minimum/maximum |
| 47 | Power (910+) | a: signal, b: exponent |
| 48 | Quantise (910+) | a: frequency signal, b: scale, c: root |
| 49 | Tempo (910+) | a: BPM, b: output kind 0–19, c: swing (currently ignored); unique state |
| 50 | Sample hold (910+) | a: signal, b: trigger; unique state |
| 51 | Custom wave (910+) | a: frequency, b: phase, c: trigger, d: normalized base level, e/f: range, g: value-asset start, h: point count; unique state |

Opcodes 29–31 retain the version-3 layout but require firmware 905;
opcodes 32–37 require firmware 906; opcodes 38–40 require firmware 907; opcode 41 requires firmware 908; opcodes 42–43 require firmware 909; opcodes 44–51 require firmware 910. Firmware 904
rejects them during graph validation, before replacing a preset.

Unused trailing fields are zero. New exports always use version 3. Firmware 904
also accepts version 2 with 12-byte instructions and version 1 with its original
64-element limits. Old packages retain their original DSP behavior. Uploaders
check command 5 before transferring newer packages, so firmware 903 rejects a
version-3 package before any preset is replaced. Install 904 once, then
export/upload as usual. Failed exports remove any prior `patch.tgp` at the output
path so an old file cannot be mistaken for the new patch.

Range mapping uses widened integer intermediates and supports live, equal or
inverted endpoints. See [DSP inputs and limitations](README.md#inputs-and-differences-from-the-browser-engine)
for units, clamps, waveform aliasing and envelope/filter behavior.

The capacity limit bounds storage and validation, not audio processing time.
Every active instruction runs for every sample. The chip must finish each
128-frame buffer in about 2.9 ms. Register/value arrays and three patch banks
consume RAM; longer programs consume CPU depending on the operations used.
The larger arrays alone do not make small patches execute 256 instructions.
There is no automatic workload admission test yet; use measured render time and
late-buffer counts when testing more demanding patches.

Data goes into a separate staging buffer. Commit checks exact size/version,
CRC, bounds, opcodes, initialized register dependencies, unique state ownership,
parameter indices, labels and knob ranges. Failed transfers leave both stored
slots and the running graph intact. Three program banks allow two slots plus a
spare: the audio thread swaps pointers between buffers, resets DSP state, then
acknowledges. A 128-sample fade-out and fade-in avoids an abrupt switch; held notes
retrigger the selected graph. This is not a crossfade or preservation of voices.

## Validation

On 2026-10-09, the agent installed `FM-1_902` from the running `FM-1_901`;
the installer completed and verified the new identity. The new protocol reported
two empty slots. Both 748-byte patches were then uploaded over USB MIDI, each
commit was acknowledged, and selecting slot 1 was acknowledged with both slots
still loaded. No firmware update occurred between these patch uploads.
Paulo subsequently confirmed playback/switching worked well, with no late
buffers. The device was initially left on slot 1.

Firmware SHA-256:
`91604123416b790d81995312dc72fe5179d06471c1a2c80037abf5a20cc8aed2`.
The [static build manifest](../../docs/spikes/fm1-results/upload-runtime.json)
records the build before this hardware session: app image 26,424 bytes,
RAM data/BSS 12,016 bytes and pool reservation 23,720 bytes. Those data regions
exclude separate RAM-text, stack and loader reservations.

Later in the same session, `FM-1_903` was installed from `902` and verified by
the updater. It accepted the v2 Sine package into slot 1 and Paulo's unchanged
`test.json` into slot 2; both commits were acknowledged, leaving slot 2 active.
The latter compiles to 68 operations, 66 registers and a 1,040-byte package;
its 0–1 oscillator range is preserved. Sound/controls and render timing for
this new version await the user's check.

Firmware SHA-256:
`7b24bd701b99943c55cbe8b1633b3b043f8197ea46acf7f2c21ad80652f472d5`.
User patch package SHA-256:
`2dd951ec905a6e1c444058007d3490e9ee216a2aed24365c9bf691a664a58bbb`.
The [ranged-runtime build manifest](../../docs/spikes/fm1-results/ranged-runtime.json)
records an app image of 26,908 bytes, RAM data/BSS of 12,016 bytes and pool
reservation of 33,960 bytes. Pool usage grew by 10,240 bytes versus `902`.
Range/capacity tests passed with ASan and UBSan. Sender checks also confirmed
that a v2 package is refused before BEGIN when the device lacks v2 support,
and a failed export removes the previous output package.

The host upload test covers incomplete and out-of-order transfers, CRC failures,
invalid opcodes/metadata, every truncated package length, separate 220/440 Hz
compiled graphs, slot selection, replacement at the apply boundary, and empty
slots after reset. Both C tests run with AddressSanitizer and UBSan:

```sh
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I .cache/fm1-spike/naked/build/gen firmware/fm1/test-upload.c \
  -lm -o .cache/fm1-spike/test-upload
.cache/fm1-spike/test-upload .cache/fm1-spike/naked/patches/sine/patch.tgp \
  .cache/fm1-spike/naked/patches/octave/patch.tgp \
  firmware/fm1/fixtures/sine-v1.tgp .cache/fm1-spike/naked/patches/tremolo/patch.tgp
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
  -I .cache/fm1-spike/naked/build/gen firmware/fm1/test-ranges.c \
  -lm -o .cache/fm1-spike/test-ranges
.cache/fm1-spike/test-ranges
```

The checked-in v1 fixture is the original 748-byte Sine package used by `902`.
Additional tests cover live/equal/inverted range endpoints, signed numeric
extremes, the larger array bounds, v1 compatibility, and analytic comparison of
the two-oscillator Tremolo patch (maximum error approximately 0.0000702).

On hardware, check initial silence, both uploads, the octave difference on the
same key, PRESETS, all three knobs and MIDI. Watch for increases in late-buffer
and MIDI-overflow counters during uploads and switching. Numerical pitch/audio
measurements, sustained load, flash persistence and failed-update recovery are
separate work.

On 2026-10-10, the agent installed `FM-1_904` from the running `FM-1_903` at
Paulo's request. The installer completed with exit code 0 and verified the
rebooted device identity as `FM-1_904`. Installed package SHA-256:
`2d0ed3c8e17169725ea923cf40e783e178759158b0eef885410b44a157d21a74`.
No patches were uploaded as part of installation; new-node audio performance
still requires bench validation.


## Shared capability contract

`support.json`, validated by `support.schema.json`, drives the editor warnings,
editor/CLI exporter, browser/CLI binary preflight and generated `SUPPORT.md`.
Enabled unsupported or unreviewed nodes (including unused nodes and group contents)
block export; disable or remove them first. Partial nodes must pass the declared
port restrictions and compiled operation/mode checks. Existing binary packages
have no node inventory, so upload preflight checks their format, resource counts,
instructions and function/waveform selectors; the device still validates operands,
state and metadata before activation.

The existing capability reply reports only package format. It cannot establish
that an older installed build implements every operation in the registry's target
firmware. A successful connection check is not full feature negotiation; the device
can still reject a graph at commit. The CLI reports the package's minimum firmware
from the instruction registry. No firmware protocol or DSP changes are made by
updating the tracking system itself.

## Live values (FM-1_918)

Command 7 with an empty body probes live-edit support using the ordinary status reply. Command 6 carries a zero-based preset byte, the original uploaded package CRC32 (little endian), a count byte (1–18), and count records of one value-index byte plus a signed little-endian Q16.16 int32. The preset must be active, its original CRC must match, and the package must be version 4 or later. All indices and exposed-control ranges are validated before publication. The audio ISR applies the batch at a buffer boundary and the normal acknowledgement follows application. DSP state and fade gain are preserved. More than 18 changes use successive acknowledged batches; the entire edit is not atomic across batches. Replacing a patch changes its identity; editing values retains it. Old firmware rejects the probe, so the editor requires an update before starting a live upload. Neither command writes flash. Source implementation only; hardware verification remains pending.

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


FM-1 921 adds instructions 54–63 for Envelope completion, MIDI Note On/Off and bounded Spread/Spawn templates. Existing package formats are retained; uploaders derive the required firmware from the support contract, and older firmware rejects unknown instructions at commit. Re-export patches after installing 921. The new MIDI Spawn and Spread harmonics examples live in `firmware/fm1/patches/`; consult the firmware README for voice capacity and bench checks.
