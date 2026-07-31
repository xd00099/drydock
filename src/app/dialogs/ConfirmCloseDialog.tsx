import { Button } from '@/components/ui'
import { clip, sessionLabel, type SessionView, type Tab } from '@/lib/types'
import Modal, { MODAL_Z, ModalActions, ModalBody, ModalTitle } from './Modal'

/** ⌘W / chip ✕ on a session that's mid-turn. Setting-gated by the caller;
 *  shells and idle sessions close without asking. */
export default function ConfirmCloseDialog({
  tab,
  session,
  onCancel,
  onConfirm,
}: {
  tab: Tab | undefined
  session: SessionView | undefined
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    // grabFocus: the confirming ⏎ must not also land in xterm and get typed
    // into the very session being closed.
    <Modal z={MODAL_Z.confirmClose} grabFocus width={380}>
      <ModalTitle>Close a session mid-turn?</ModalTitle>
      <ModalBody>
        {clip(session ? sessionLabel(session) : tab?.title ?? 'This session', 60)} is working right
        now — closing the tab interrupts that turn. The session itself stays resumable from the
        sidebar.
      </ModalBody>
      <ModalActions>
        <Button variant="ghost" onClick={onCancel}>
          Cancel (Esc)
        </Button>
        <Button variant="danger" onClick={onConfirm}>
          Close (⏎)
        </Button>
      </ModalActions>
    </Modal>
  )
}
