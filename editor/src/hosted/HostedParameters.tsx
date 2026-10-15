import { useRef, useState, useSyncExternalStore } from 'react';
import type { ParameterMetadata } from './compiler';
import type { HostedSession } from './session';

/** Instance controls live outside transient observation frames and canvas nodes. */
export function HostedParameters({ session }: { session: HostedSession }) {
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  if (!session.capabilities.feedback?.includes('parameters') || !state.parameters.length) return null;
  return <section className="hosted-parameters nodrag nopan nowheel" aria-label="Host parameters"
    onPointerDown={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
    {state.parameters.map(parameter => <ParameterSlider key={parameter.id} session={session} parameter={parameter}
      value={state.parameterValues[parameter.id] ?? parameter.defaultValue}
      disabled={!state.connected || state.generation === null} />)}
  </section>;
}

function ParameterSlider({ session, parameter, value, disabled }: {
  session: HostedSession; parameter: ParameterMetadata; value: number; disabled: boolean;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);
  const displayed = draft ?? value;
  const change = async (next: number) => {
    const request = ++sequence.current;
    const generation = session.getSnapshot().generation;
    setDraft(next);
    setFailed(false);
    const accepted = await session.setParameter(parameter.id, next);
    if (request !== sequence.current) return;
    setDraft(null);
    // Graph replacement may retire a request while a newer host value arrives.
    setFailed(!accepted && generation === session.getSnapshot().generation && session.getSnapshot().connected);
  };
  return <label className="hosted-parameter-control">
    <span className="hosted-parameter-heading"><span>{parameter.name}</span><output>{Number(displayed.toPrecision(6))}</output></span>
    <input type="range" min={parameter.min} max={parameter.max} step={parameter.integer ? 1 : parameter.step && parameter.step > 0 ? parameter.step : 'any'}
      value={displayed} disabled={disabled || parameter.min === parameter.max} aria-label={parameter.name}
      aria-valuetext={String(displayed)} onChange={event => void change(Number(event.target.value))} />
    {failed && <span className="hosted-parameter-error" role="status">Host did not accept this value.</span>}
  </label>;
}
