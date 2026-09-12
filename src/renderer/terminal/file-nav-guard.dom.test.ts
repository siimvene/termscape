// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { fileNavigationGuard } from './file-drop'

// Proves the DOM-phase contract the guard depends on: a window 'drop' listener registered in the
// CAPTURE phase still fires when the element under the cursor handles the drop and calls
// stopPropagation() — which is exactly what a terminal node's own drop handler does. If the reset
// were on the bubble phase, a terminal file-drop would never clear the guard's latch and the next
// text drag would be wrongly prevented (the regression the consort panel caught).

let child: HTMLElement | null = null

afterEach(() => {
  child?.remove()
  child = null
})

describe('fileNavigationGuard DOM wiring', () => {
  it('capture-phase drop fires and clears the latch despite a child stopPropagation', () => {
    const g = fileNavigationGuard()
    const onDragOver = (e: Event): void => g.dragOver(e as unknown as DragEvent)
    const onDrop = (e: Event): void => g.drop(e as unknown as DragEvent)
    const onDragLeave = (e: Event): void => {
      if (!(e as DragEvent).relatedTarget) g.endDrag()
    }
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('drop', onDrop, { capture: true })
    window.addEventListener('dragend', g.endDrag)
    window.addEventListener('dragleave', onDragLeave)

    child = document.createElement('div')
    document.body.appendChild(child)
    // The terminal's own drop handler: it swallows the event from bubble-phase listeners.
    child.addEventListener('drop', (e) => e.stopPropagation())

    // Arm the latch with a file dragover (types populated), like a real Finder drag.
    const dragover = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(dragover, 'dataTransfer', { value: { types: ['Files'] } })
    child.dispatchEvent(dragover)
    expect(dragover.defaultPrevented).toBe(true)

    // The terminal handles + stopPropagation's the drop; the capture listener must still reset.
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: { length: 1 } } })
    child.dispatchEvent(drop)

    // Latch cleared: a following non-file dragover is left alone (native text drop works).
    const textOver = new Event('dragover', { bubbles: true, cancelable: true })
    Object.defineProperty(textOver, 'dataTransfer', { value: { types: ['text/plain'] } })
    child.dispatchEvent(textOver)
    expect(textOver.defaultPrevented).toBe(false)

    window.removeEventListener('dragover', onDragOver)
    window.removeEventListener('drop', onDrop, { capture: true })
    window.removeEventListener('dragend', g.endDrag)
    window.removeEventListener('dragleave', onDragLeave)
  })
})
