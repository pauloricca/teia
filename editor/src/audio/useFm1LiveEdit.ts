import { useEffect, useRef, useState } from 'react';
import type { Patch } from '../graph/types';
import { analyzeFm1Patch } from './fm1Package';
import { updateFm1Values, uploadFm1Patch, type Fm1ValueUpdate } from './fm1Upload';

/** Compare the actual lowered layout, including controls and assets, before using indices. */
function valueChanges(previous: Uint8Array, next: Uint8Array): Fm1ValueUpdate[] | null {
  if (previous.length !== next.length) return null;
  const view = new DataView(next.buffer, next.byteOffset, next.byteLength);
  const old = new DataView(previous.buffer, previous.byteOffset, previous.byteLength);
  const count = view.getUint16(10, true), start = next.length - count * 4;
  for (let i = 0; i < start; i++) if (previous[i] !== next[i]) return null;
  const changes: Fm1ValueUpdate[] = [];
  for (let index = 0; index < count; index++) {
    const value = view.getInt32(start + index * 4, true);
    if (value !== old.getInt32(start + index * 4, true)) changes.push({ index, value });
  }
  return changes;
}

export function useFm1LiveEdit(patch: Patch, enabled: boolean, preset: number, stop: () => void) {
  const latest = useRef(patch);
  latest.current = patch;
  const stopRef = useRef(stop);
  stopRef.current = stop;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let timer: number;
    let processed: Patch | null = null;
    let previous: Uint8Array | null = null;
    let identity: Uint8Array | null = null;
    const tick = async () => {
      if (controller.signal.aborted) return;
      const current = latest.current;
      if (current !== processed) {
        processed = current;
        const analysis = analyzeFm1Patch(current, true);
        if (!analysis.compiled) {
          setMessage(`Not sent: ${analysis.errors.join(' ')}`);
        } else {
          const next = analysis.compiled.bytes;
          const changes = previous ? valueChanges(previous, next) : null;
          if (changes === null || changes.length > 0) {
            setBusy(true);
            try {
              if (changes && identity) {
                setMessage('Sending values…');
                await updateFm1Values(identity, preset, changes, controller.signal);
              } else {
                await uploadFm1Patch(next, preset, (_, status) => {
                  if (!controller.signal.aborted) setMessage(status);
                }, controller.signal, true);
                identity = next;
              }
              previous = next;
              if (!controller.signal.aborted) setMessage('');
            } catch (error) {
              if (!controller.signal.aborted) {
                setMessage(error instanceof Error ? error.message : String(error));
                stopRef.current();
              }
              return;
            } finally {
              if (controller.signal.aborted) setMessage('');
              setBusy(false);
            }
          } else setMessage('');
        }
      }
      timer = window.setTimeout(() => void tick(), 120);
    };
    void tick();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [enabled, preset]);
  return { message, busy };
}
