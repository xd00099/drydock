import { Button } from '@/components/ui'
import Modal, { MODAL_Z, ModalActions, ModalBody, ModalTitle } from './Modal'

/** ⌘Q with a turn in flight. `busyCount` is recomputed by the caller at render:
 *  the guard only opens because something WAS mid-turn, but a turn can finish
 *  while the dialog sits there — hence the past-tense fallback wording. */
export default function QuitGuardDialog({
  busyCount,
  onCancel,
  onQuitAnyway,
}: {
  busyCount: number
  onCancel: () => void
  onQuitAnyway: () => void
}) {
  const what =
    busyCount > 1
      ? `${busyCount} sessions are mid-turn`
      : busyCount === 1
        ? 'A session is mid-turn'
        : 'A session was mid-turn'
  return (
    <Modal z={MODAL_Z.quitGuard} width={400}>
      <ModalTitle>{what} — quitting interrupts it.</ModalTitle>
      <ModalBody>Idle sessions are unaffected: they resume when Drydock reopens.</ModalBody>
      <ModalActions>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onQuitAnyway}>
          Quit anyway
        </Button>
      </ModalActions>
    </Modal>
  )
}
