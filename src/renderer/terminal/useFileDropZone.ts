import { useCallback, useEffect, useRef, useState } from 'react'
import { acceptsFileDrag } from './file-drop'

export interface FileDropZone {
  /** True while a file drag is over the zone — drive the "Drop to insert path" overlay off this. */
  dropping: boolean
  onDragEnter: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDragLeave: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
}

/**
 * A terminal file-drop zone that a Finder drag can't wedge.
 *
 * The naive version re-decides "is this a file drag?" from `dataTransfer.types` on every `dragover`
 * tick, but macOS/Electron report that list intermittently mid-drag (see `acceptsFileDrag`): one
 * empty tick on the final dragover rejects the drop, which fails the paste AND leaves the overlay
 * stuck — the rejected drop fires neither `drop` nor a resetting `dragleave`. So once a drag is
 * recognized as carrying files we keep accepting it (`activeRef`) until it ends, and a
 * document-level `dragend`/`drop` clears the overlay as a belt-and-suspenders reset for a
 * cancelled OS drag that never delivers a terminating event to this element at all.
 */
export function useFileDropZone(onFiles: (files: File[]) => void): FileDropZone {
  const [dropping, setDropping] = useState(false)
  const activeRef = useRef(false)

  const clear = useCallback(() => {
    activeRef.current = false
    setDropping(false)
  }, [])

  // Arm (preventDefault) as soon as a file drag is over us and latch it active for the rest of the
  // drag. `dragenter` fires the instant the pointer crosses ANY edge into the zone, one tick before
  // the first `dragover`, so latching here makes the whole body a real drop target from the moment
  // of entry — a drop released over the top of the terminal is accepted the same as one over the
  // input line, instead of relying on the first `dragover` tick surviving the intermittent-`types`
  // flake (see acceptsFileDrag). Both events share this handler.
  const accept = useCallback((e: React.DragEvent) => {
    if (!acceptsFileDrag(Array.from(e.dataTransfer.types), activeRef.current)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    activeRef.current = true
    setDropping(true)
  }, [])

  const onDragLeave = useCallback(
    (e: React.DragEvent) => {
      const rt = e.relatedTarget as Node | null
      if (!rt || !(e.currentTarget as HTMLElement).contains(rt)) clear()
    },
    [clear]
  )

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files)
      // preventDefault unconditionally: a file drag we accepted is ours, so never let Chromium's
      // default (navigate the window to the dropped file) fire, even when `files` comes back empty.
      e.preventDefault()
      e.stopPropagation()
      clear()
      if (files.length) onFiles(files)
    },
    [clear, onFiles]
  )

  // A cancelled/rejected OS drag can end without delivering `drop` or a resetting `dragleave` to
  // this element. While the overlay is up, clear it on any document-level drag end.
  useEffect(() => {
    if (!dropping) return
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    return () => {
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
    }
  }, [dropping, clear])

  return { dropping, onDragEnter: accept, onDragOver: accept, onDragLeave, onDrop }
}
