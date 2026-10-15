import { NodeEditor } from '../editor/NodeEditor';
import type { HostedSession } from './session';
/** Create HostedSession from the initial document, capabilities and supplied IPC
 * bridge. Host owns session disposal so React remounts do not destroy drafts. */
export function HostedNodeEditor({ session }: { session: HostedSession }) {
  if (!session?.bridge || !session.capabilities) throw new Error('HostedNodeEditor requires a supplied hosted session and bridge.');
  return <NodeEditor hosted={session} />;
}
