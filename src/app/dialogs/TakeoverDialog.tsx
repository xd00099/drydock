import { Button } from '@/components/ui'
import { clip, type TakeoverInfo } from '@/lib/types'
import Modal, { MODAL_Z, ModalActions, ModalBody, ModalTitle } from './Modal'

export type TakeoverState = {
  info: TakeoverInfo | null
  located: boolean
  err: string | null
  killing: boolean
}

/** "Take over here": names exactly what will be signalled before anything is,
 *  which is the whole point of the dialog — pid, owning app, tty, cwd. */
export default function TakeoverDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: TakeoverState
  onCancel: () => void
  onConfirm: () => void
}) {
  const { info, located, err, killing } = state
  return (
    <Modal z={MODAL_Z.takeover} width={440}>
      <ModalTitle>Take over this session?</ModalTitle>
      {!located ? (
        <ModalBody>locating the process…</ModalBody>
      ) : info ? (
        <ModalBody>
          <div style={{ color: 'var(--dd-text)' }}>
            Stops <span style={{ fontFamily: 'Menlo, monospace', fontSize: 12 }}>claude</span> (pid{' '}
            {info.pid}) in <b>{info.app ?? 'another terminal'}</b>
            {info.tty ? <span> · {info.tty}</span> : null}
            {info.cwd ? <span> — {clip(info.cwd, 44)}</span> : null}, then resumes the session here.
          </div>
          {info.status === 'busy' && (
            <div style={{ color: 'var(--dd-warn)', marginTop: 6 }}>
              Mid-task right now — the in-flight turn will be lost. Everything already in the
              transcript survives.
            </div>
          )}
        </ModalBody>
      ) : (
        <ModalBody>
          The process is already gone — the session just hasn't settled to “ended” yet. Resume it
          directly.
        </ModalBody>
      )}
      {err && <div style={{ color: 'var(--dd-err)', marginBottom: 10, fontSize: 12 }}>{err}</div>}
      <ModalActions>
        <Button variant="ghost" disabled={killing} onClick={onCancel}>
          Cancel
        </Button>
        <Button
          variant={info ? 'danger' : 'primary'}
          disabled={!located || killing}
          onClick={onConfirm}
        >
          {killing ? 'Taking over…' : info ? 'Take over' : 'Resume here'}
        </Button>
      </ModalActions>
    </Modal>
  )
}
