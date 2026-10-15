import { useMemo, useSyncExternalStore, useCallback } from 'react';
import type { AudioEngineState } from '../audio/useAudioEngine';
import type { HostedSession } from './session';
const noop = () => undefined;
const asyncNoop = async () => undefined;
/** Presentation adapter only: never mounts useAudioEngine, a clock or devices. */
export function useHostedAudio(session: HostedSession): AudioEngineState {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const setLinkScopes = useCallback<AudioEngineState['setLinkScopes']>(requests => session.requestFeedback(requests), [session]);
  const clearBuffer = useCallback<AudioEngineState['clearBuffer']>(nodeId => { void session.mutateBuffer('clear', nodeId); }, [session]);
  const copyBuffers = useCallback<AudioEngineState['copyBuffers']>(copies => { for (const copy of copies) void session.mutateBuffer('copy', copy.sourceNodeId, copy.targetNodeId); }, [session]);
  return useMemo(() => ({
    status: state.connected && state.generation !== null ? 'running' : 'idle', message: state.connected ? 'Audio is owned by the host.' : 'Host disconnected.',
    cpuLoad: 0, cpuPeakLoad: 0, cpuDeadlineMisses: 0,
    rendering: { mode: 'hosted', workers: 0, parallelRepeats: 0, reason: 'Host instance' },
    peak: state.feedback?.peak ?? 0, linkMeters: state.feedback?.meters ?? {}, linkScopes: state.feedback?.scopes ?? {},
    playheads: state.feedback?.playheads ?? {}, buffers: state.feedback?.buffers ?? {},
    recording: { status: 'idle', message: 'Recording is owned by the host.', fileName: null, elapsedSeconds: 0 },
    audioInput: { status: 'unsupported', message: 'Audio routing and devices are owned by the host.', devices: [], selectedDeviceId: '', canSelectDevice: false },
    midiInput: { status: 'unsupported', message: 'MIDI routing and devices are owned by the host.', devices: [], outputDevices: [], canRequestAccess: false, lastControlChange: undefined },
    start: () => session.toggleTransport(), stop: () => { void session.toggleTransport(); }, startRecording: noop, stopRecording: noop,
    captureBuffer: async () => null, clearBuffer, copyBuffers, restoreBuffers: noop, syncGraph: noop,
    setLinkScopes, setAudioInputDeviceId: noop,
    refreshAudioInputDevices: asyncNoop, refreshMidiInputDevices: asyncNoop,
  }), [session, state, setLinkScopes, clearBuffer, copyBuffers]);
}
