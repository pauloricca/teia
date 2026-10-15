import { NodeEditor } from '../editor/NodeEditor';
import type { HostedSession } from './session';
/** Create HostedSession from the initial document, capabilities and supplied IPC
 * bridge. Host owns session disposal so React remounts do not destroy drafts. */
export function HostedNodeEditor({ session, theme }: { session: HostedSession; theme?: string }) {
  if (!session?.bridge || !session.capabilities) throw new Error('HostedNodeEditor requires a supplied hosted session and bridge.');
  // Keep theme tokens local to this panel; hosts need not change their document.
  // Omitting the prop retains the existing root-theme and mounting behavior.
  return theme ? (
    <div className="teia-themed-editor" data-theme={theme}>
      <NodeEditor hosted={session} />
    </div>
  ) : <NodeEditor hosted={session} />;
}
