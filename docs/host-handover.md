# Implementing a Teia host

Teia supplies the editor, document/compiler APIs and a bounded native DSP runtime.
Teia does not supply a production host adapter. Vira integration is maintained
in its own repository. `MockHostBridge` is a contract test double; it does not connect an editor to audio processing. The host must
provide that connection, audio ownership and persistence.

See [the full contracts and current limitations](hosted.md) for API details.

## How to consume the shared code

Use two dependencies from the same Teia source revision:

| Dependency | Purpose | Initial distribution |
| --- | --- | --- |
| `@pauloricca/teia-hosted` | TypeScript compiler/session/bridge contracts, React editor and CSS | Local npm tarball |
| `teia-kernel` | Native Rust DSP instances | Cargo path dependency on `rust/teia-kernel`, or the complete source crate copied into `hosted/dist/native/teia-kernel` |

From the Teia checkout:

```sh
npm run build:hosted
npm pack ./hosted --pack-destination /tmp
```

This produces `/tmp/pauloricca-teia-hosted-0.1.0.tgz`. In the host's frontend
project, install that file with `npm install /tmp/pauloricca-teia-hosted-0.1.0.tgz`.
Install the peer dependencies declared in `hosted/package.json` as needed. For
the native host, use a Cargo dependency pointing to the matching crate directory:

```toml
[dependencies]
teia-kernel = { path = "../teia/rust/teia-kernel" }
```

Adjust the path for the host checkout. For reproducible handoffs, retain the
tarball, `compatibility.json`, and the matching Rust source snapshot together;
record the source commit and keep any dirty-source snapshot too. A commit alone
does not identify uncommitted changes. The manifest records source state,
protocol versions and artifact checksums.

For Vira's Docker build, vendor the matching crate snapshot inside the Docker
build context (for example `vendor/teia-kernel`) and point Cargo at that directory.
Do not depend on an unmounted sibling checkout on the developer's machine. Use
the crate shipped in the same hosted artifact set and verify its manifest hashes
before copying; keep the source snapshot pinned alongside the frontend tarball.

**npm is appropriate for the frontend SDK, but publication is optional.** Today
the package is `private: true`, `UNLICENSED`, and unpublished. `npm pack` creates
a local archive without publishing. After the first host integration, a private
registry could replace tarball handoffs; that requires an explicit access,
licensing and release-policy decision and changing the publication configuration.
The Rust dependency still goes through Cargo/source distribution. No crates.io
release is required. The separate `@pauloricca/teia-runtime` browser player is
not the native host backend.

## What the host needs to implement

1. **Own the runtime.** Create one native `Instance` per hosted patch. Prepare
   and allocate off the audio thread, process host-provided stereo buffers through
   `process_host`, and retire replaced instances off the audio thread. Adapt the
   host's MIDI and timeline into the ordered, sample-offset event/segment types.
   Respect the bounded `native-scalar-v1` profile (including bend links); unsupported graphs must produce
   diagnostics and leave the last valid graph installed.

2. **Mount the editor.** Import `HostedNodeEditor`, the three exported CSS files
   and `HostedSession`; supply an initial document, unique session ID, current
   runtime generation, capabilities and a real `HostBridge`. Give the editor a
   sized container. The editor owns no audio device or clock. Closing its window
   must not implicitly destroy a host-owned runtime. The full guide contains a
   mounting example.

3. **Implement the IPC adapter.** Implement `request` and `subscribe`, routing
   each session to its runtime. Agree on bridge version 1 before connecting;
   Teia exports the version but does not implement a transport handshake. Echo
   request/session/revision/generation context in replies and correlated events.
   Settle pending requests on disconnect, emit connection state, and support
   `resync` with the current installed generation.

4. **Make installation transactional.** Handle `revision` immediately, before
   expensive work. For `apply`, validate/prepare the native program off-render
   and atomically recheck the latest revision at the actual installation boundary.
   Keep the old instance on failure or supersession. `queued` only acknowledges
   receipt; send `installed` after installation. Use generation checks for controls
   so stale messages cannot mutate a replacement instance. Values and specialized
   updates must respect layout compatibility; advertise specialized controls only
   when implemented.

   Invalid Apply commands omit `prepared`: return a diagnostic without attempting
   to decode a missing/null native program, and keep the installed instance.

5. **Preserve live controls.** Key host automation/overrides by persistent
   parameter ID, rebind them to each new program's value indices, and retain
   overrides across graph replacement without rewriting document defaults.
   `ParameterOverrides` supplies frontend utilities; the host must carry the
   policy through its native control queue and actual installation.

6. **Implement Save and close policy.** Persist the exact requested document
   snapshot and required assets before replying `saved`. Saving an editable
   document whose graph cannot execute is allowed by default. Decide file names,
   conflicts, drafts and Save As behavior. For `close`, save/preserve/discard or
   return `cancelled`; recheck for newer edits before replying `closed`.

7. **Publish actual feedback and capabilities.** Send bounded, throttled
   feedback from the installed runtime, honor scope subscriptions, and report
   actual parameter values and host transport position. Enable transport, Buffer
   mutations, media adapters and node eligibility only as supported. Media
   selection, decoded waveform bins and preview Blobs are host-supplied; there
   is no standalone storage/device fallback in the hosted editor.

## First integration milestone

Start with one native stereo effect, one numeric parameter, a hosted editor
window, transactional Apply and acknowledged Save. Then add MIDI/host transport
and optional capabilities. Rust now uses shared graph validation/preparation/scheduling. Enable additional
nodes by wiring resources and explicit repeat budgets, rather than adding opcode
allowlists. FFT analysis remains a named pending facility. Use the full contract
when choosing fixtures.

Before claiming host support, verify stale-Apply rejection, failed-Apply rollback,
parameter identity across rename/reorder, Save during later edits, disconnect/
resync and cancelled close. Tested native allocation guards now pass; audio-deadline measurements and editor
isolation checks remain outstanding. Existing conformance harnesses are
listed in the full guide; compilation alone is not functional verification.

For the shared-runtime migration, rebuild the host frontend and native binary
against matching artifacts. Existing version-1 stereo integration stays valid.
Resource graphs additionally require `Instance::new_with_resources`; select
standalone smoothing with `set_control_smoothing(true)` when desired. Do not
advertise those host facilities before wiring them. Recreate the editor session
and exercise the integration checks above.
