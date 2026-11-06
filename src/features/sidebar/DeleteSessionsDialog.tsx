import { useState } from 'react'
import type { SessionView } from '@/lib/types'
import { sessionLabel } from '@/lib/types'
import { Button } from '@/components/ui'
import Modal, { ModalActions, ModalBody, ModalTitle } from '@/app/dialogs/Modal'
import css from './DeleteSessionsDialog.module.css'

type Props = {
  label: string
  sessions: SessionView[]
  onDelete: (id: string) => Promise<void>
  onClose: () => void
  onComplete?: () => Promise<void>
}

/** Keep the confirmed selection fixed while index refreshes remove completed
 *  sessions. Stop on failure and retry only the remaining conversations. */
export default function DeleteSessionsDialog({ label, sessions, onDelete, onClose, onComplete }: Props) {
  const [remaining, setRemaining] = useState(sessions)
  const [total] = useState(sessions.length)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const removed = total - remaining.length

  const remove = async () => {
    if (pending) return
    setPending(true)
    setError(null)
    let current: SessionView | null = null
    try {
      for (const session of remaining) {
        current = session
        await onDelete(session.session_id)
        setRemaining((prev) => prev.filter((s) => s.session_id !== session.session_id))
      }
      current = null
      await onComplete?.()
      onClose()
    } catch (failure) {
      setError(`${current ? `Could not delete “${sessionLabel(current)}”` : 'Could not remove the folder'}: ${String(failure)}`)
    } finally {
      setPending(false)
    }
  }

  return (
    <Modal z={70} width={420} grabFocus>
      <ModalTitle>Delete sessions in “{label}”?</ModalTitle>
      <ModalBody>
        {remaining.length > 0 ? <>
          <strong>{remaining.length} conversation{remaining.length === 1 ? '' : 's'}</strong> will be permanently deleted,
          including hidden and starred conversations in this group. Codex also deletes their spawned subagent sessions.
          This cannot be undone.
        </> : <>The conversations have been deleted. Retry to finish removing the sidebar folder.</>}
        <p className={css.files}>Project files and directories will be kept.</p>
      </ModalBody>
      {removed > 0 && <div className={css.progress} role="status">{removed} of {total} conversations deleted.</div>}
      {error && <div className={css.error} role="alert">{error}</div>}
      <ModalActions>
        <Button variant="ghost" disabled={pending} onClick={onClose}>Cancel</Button>
        <Button variant="danger" disabled={pending} onClick={remove}>
          {pending ? 'Deleting…' : remaining.length ? `Delete ${remaining.length} session${remaining.length === 1 ? '' : 's'}` : 'Remove folder'}
        </Button>
      </ModalActions>
    </Modal>
  )
}
