import { fm1Capabilities, fm1Limits, fm1SupportFirmware, inspectFm1Package } from './fm1Capabilities';

const prefix = [0x7d, 0x54, 0x45, 1];
const errors: Record<number, string> = {
  1: 'The device rejected the command or package size.',
  2: 'The transfer expired or a chunk arrived out of order. Upload again.',
  3: 'The patch checksum did not match. Upload again.',
  4: `The device rejected this graph. The capability registry targets ${fm1SupportFirmware}; update the firmware if the installed build lacks this feature.`,
  5: 'The device is switching presets. Wait a moment and upload again.',
};
let uploading = false;
class Fm1TimeoutError extends Error {}
function pack7(bytes: Uint8Array): number[] {
  const result: number[] = [];
  let acc = 0, bits = 0;
  for (const byte of bytes) {
    acc |= byte << bits; bits += 8;
    while (bits >= 7) { result.push(acc & 127); acc >>>= 7; bits -= 7; }
  }
  if (bits) result.push(acc);
  return result;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; ++i) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function fm1BrowserError(): string | null {
  if (!window.isSecureContext) return 'USB MIDI needs HTTPS or localhost. Open the editor on localhost or HTTPS.';
  if (!navigator.requestMIDIAccess) return 'This browser does not support Web MIDI. Open the editor in Chrome or Edge.';
  return null;
}

/** One frame at a time, matching fm1-send-patch.py; never blindly retry COMMIT. */
export function uploadFm1Patch(bytes: Uint8Array, preset: number, progress: (percent: number, message: string) => void, signal: AbortSignal, live = false): Promise<void> {
  return communicateFm1(bytes, preset, progress, signal, undefined, live);
}
export function checkFm1Connection(progress: (percent: number, message: string) => void, signal: AbortSignal): Promise<void> {
  return communicateFm1(null, 1, progress, signal);
}
export interface Fm1ValueUpdate { index: number; value: number }
export function updateFm1Values(identity: Uint8Array, preset: number, updates: Fm1ValueUpdate[], signal: AbortSignal): Promise<void> {
  return communicateFm1(identity, preset, () => {}, signal, updates, true);
}
async function communicateFm1(bytes: Uint8Array | null, preset: number, progress: (percent: number, message: string) => void, signal: AbortSignal, updates?: Fm1ValueUpdate[], live = false): Promise<void> {
  if (uploading) throw new Error('An FM-1 upload is already running.');
  const requirements = bytes ? inspectFm1Package(bytes) : null;
  const browserError = fm1BrowserError();
  if (browserError) throw new Error(browserError);
  if (!Number.isInteger(preset) || preset < 1 || preset > 2) throw new Error('Choose preset 1 or 2.');
  uploading = true;
  let commitSent = false;
  const commandNames = ['status check', 'start transfer', 'patch data', 'activate patch', 'select preset', 'firmware capabilities', 'value update', 'live edit capabilities'];
  let receivedMessages = 0;
  let receivedSysex = 0;
  let lastReply = '';
  // Chromium's macOS SysEx7 framing regression was fixed in Chrome 153.
  const chromeMajor = Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1]);
  const browserHint = /Macintosh|Mac OS X/.test(navigator.userAgent) && chromeMajor === 152
    ? ' Chrome 152 has a known macOS SysEx bug. Finish updating Chrome and fully relaunch it to run version 153 or newer.'
    : '';
  const timeoutError = (command: number, requestToken: number) => new Fm1TimeoutError(
    `FM-1 timed out during ${commandNames[command] ?? `command ${command}`} (token ${requestToken}). `
    + `Received ${receivedMessages} MIDI messages, including ${receivedSysex} SysEx replies. `
    + (lastReply ? `Last SysEx: ${lastReply}. ` : '')
    + `Input: ${input?.state}/${input?.connection}; output: ${output?.state}/${output?.connection}; SysEx enabled: ${access?.sysexEnabled}. `
    + 'Copy this error when reporting the problem.' + browserHint,
  );
  let access: MIDIAccess | undefined, input: MIDIInput | undefined, output: MIDIOutput | undefined;
  let token = crypto.getRandomValues(new Uint8Array(1))[0] % 127;
  let lastReplyAt = -Infinity;
  let waiting: { command: number; token: number; resolve: (data: Uint8Array) => void; reject: (error: Error) => void; timer: number } | null = null;
  const settle = (error?: Error, data?: Uint8Array) => {
    const current = waiting;
    if (!current) return;
    waiting = null; window.clearTimeout(current.timer);
    if (error) current.reject(error); else current.resolve(data!);
  };
  const receive = (event: MIDIMessageEvent) => {
    if (!event.data) return;
    const frame = event.data;
    receivedMessages++;
    if (frame[0] === 0xf0) {
      receivedSysex++;
      lastReply = Array.from(frame.subarray(0, 24), byte => byte.toString(16).padStart(2, '0')).join(' ')
        + (frame.length > 24 ? ` … (${frame.length} bytes)` : '');
    }
    if (!waiting) return;
    if ((frame.length !== 13 && frame.length !== 14) || frame[0] !== 0xf0 || frame[frame.length - 1] !== 0xf7) return;
    if (!prefix.every((v, i) => frame[i + 1] === v) || frame[5] !== (waiting.command | 0x40) || frame[6] !== waiting.token) return;
    lastReplyAt = performance.now();
    if (frame[7]) settle(new Error(waiting.command === 5 ? 'Update the FM-1 to firmware FM-1_904 or newer before uploading.' : errors[frame[7]] ?? `Device error ${frame[7]}.`));
    else settle(undefined, frame);
  };
  const disconnect = () => {
    if (input?.state === 'disconnected' || output?.state === 'disconnected') settle(new Error('FM-1 disconnected. Reconnect it before uploading again.'));
  };
  const abort = () => settle(new Error('Upload cancelled.'));
  const requestOnce = async (command: number, body: Uint8Array): Promise<Uint8Array> => {
    // Existing firmware queues its reply before releasing the receive mailbox.
    // Give it time to release that slot before sending the next frame.
    const pause = 10 - (performance.now() - lastReplyAt);
    if (pause > 0) await new Promise(resolve => window.setTimeout(resolve, pause));
    if (signal.aborted) return Promise.reject(new Error('Upload cancelled.'));
    if (!input || !output || input.state !== 'connected' || output.state !== 'connected') return Promise.reject(new Error('FM-1 is not connected.'));
    token = token % 127 + 1;
    return new Promise((resolve, reject) => {
      waiting = { command, token, resolve, reject, timer: window.setTimeout(() => settle(timeoutError(command, token)), 3000) };
      try { output!.send([0xf0, ...prefix, command, token, ...pack7(body), 0xf7]); }
      catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
    });
  };
  const request = async (command: number, body = new Uint8Array()): Promise<Uint8Array> => {
    try { return await requestOnce(command, body); }
    catch (error) {
      // Only read-only probes are safe to repeat after an ambiguous timeout.
      // Use a fresh token so a late reply cannot satisfy the new request.
      if (!(error instanceof Fm1TimeoutError) || signal.aborted
        || ![0, 5, fm1Capabilities.protocol.liveEdit.probeCommand].includes(command)) throw error;
      return requestOnce(command, body);
    }
  };
  try {
    progress(0, 'Allow MIDI SysEx access when your browser asks.');
    access = await navigator.requestMIDIAccess({ sysex: true });
    if (signal.aborted) throw new Error('Upload cancelled.');
    if (!access.sysexEnabled) throw new Error('MIDI SysEx permission is required to upload patches.');
    const matches = (port: MIDIPort) => port.state === 'connected' && port.name === 'Teia FM-1 spike';
    const inputs = [...access.inputs.values()].filter(matches);
    const outputs = [...access.outputs.values()].filter(matches);
    if (inputs.length !== 1 || outputs.length !== 1) throw new Error(inputs.length > 1 || outputs.length > 1
      ? 'More than one Teia FM-1 is connected. Connect just the device you want to upload to.'
      : 'Teia FM-1 not found. Connect it with a USB data cable and install firmware FM-1_904 or newer.');
    [input] = inputs; [output] = outputs;
    // addEventListener coexists with the editor's regular MIDI input handler.
    input.addEventListener('midimessage', receive);
    access.addEventListener('statechange', disconnect);
    signal.addEventListener('abort', abort);
    await input.open(); await output.open();
    if (!updates) await new Promise(resolve => window.setTimeout(resolve, 300));
    progress(0, 'Checking the FM-1 connection…');
    const status = await request(0);
    progress(0, 'Checking firmware capabilities…');
    const capability = await request(5);
    if (capability.length !== 14 || capability[12] < (requirements?.version ?? fm1Limits.packageVersion)) throw new Error('This patch needs newer firmware (current exports require FM-1_919 or newer).');
    if (live) {
      try { await request(fm1Capabilities.protocol.liveEdit.probeCommand); }
      catch { throw new Error(`Live Edit requires FM-1_${fm1Capabilities.protocol.liveEdit.since} or newer. Install the updated firmware.`); }
    }
    if (updates && bytes) {
      for (let offset = 0; offset < updates.length; offset += fm1Capabilities.protocol.liveEdit.maxUpdates) {
        const batch = updates.slice(offset, offset + fm1Capabilities.protocol.liveEdit.maxUpdates);
        const body = new Uint8Array(6 + batch.length * 5), view = new DataView(body.buffer);
        body[0] = preset - 1; view.setUint32(1, crc32(bytes), true); body[5] = batch.length;
        batch.forEach((update, index) => {
          body[6 + index * 5] = update.index; view.setInt32(7 + index * 5, update.value, true);
        });
        await request(fm1Capabilities.protocol.liveEdit.updateCommand, body);
      }
      return;
    }
    if (!bytes) {
      const loaded = [1, 2].filter(slot => status[11] & (1 << (slot - 1)));
      progress(100, `FM-1 connected. Active preset: ${status[10] + 1}; loaded presets: ${loaded.join(', ') || 'none'}. Package version: ${capability[12]}.`);
      return;
    }
    const begin = new Uint8Array(7), beginView = new DataView(begin.buffer);
    begin[0] = preset - 1; beginView.setUint16(1, bytes.length, true); beginView.setUint32(3, crc32(bytes), true);
    progress(0, `Starting transfer to preset ${preset} (requires FM-1_${requirements!.requiredFirmware})…`);
    await request(1, begin);
    for (let offset = 0; offset < bytes.length; offset += 96) {
      const chunk = bytes.subarray(offset, offset + 96), body = new Uint8Array(chunk.length + 2);
      new DataView(body.buffer).setUint16(0, offset, true); body.set(chunk, 2);
      let reply: Uint8Array;
      try { reply = await request(2, body); }
      catch (error) {
        if (!(error instanceof Fm1TimeoutError) || signal.aborted) throw error;
        progress(Math.min(99, Math.round(offset * 100 / bytes.length)), 'Checking interrupted transfer…');
        // Status reports the next expected offset without changing the transfer.
        // If DATA was accepted but its reply was lost, do not send it twice.
        // Otherwise retry once; firmware rejects stale/out-of-order chunks.
        const status = await request(0);
        const received = status[8] | status[9] << 7;
        if (received === offset + chunk.length) reply = status;
        else if (received === offset) reply = await request(2, body);
        else throw new Error('Unexpected transfer offset while recovering. Upload stopped; try again.');
      }
      if ((reply[8] | reply[9] << 7) !== offset + chunk.length) throw new Error('Unexpected transfer offset. Upload stopped; try again.');
      progress(Math.min(99, Math.round((offset + chunk.length) * 100 / bytes.length)), `Uploading to preset ${preset}…`);
    }
    progress(99, 'Validating and activating the patch…');
    commitSent = true;
    const reply = await request(3);
    if (reply[10] !== preset - 1 || !(reply[11] & (1 << (preset - 1)))) throw new Error('The device did not confirm the selected preset.');
    commitSent = false;
    progress(100, `Uploaded to preset ${preset} and activated.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(commitSent ? `${message} The patch may already be active; check the device before uploading again.` : message);
  } finally {
    input?.removeEventListener('midimessage', receive);
    access?.removeEventListener('statechange', disconnect);
    signal.removeEventListener('abort', abort);
    settle(new Error('Upload ended.'));
    // Ports may be shared with useAudioEngine; do not close them or change its handlers.
    uploading = false;
  }
}
