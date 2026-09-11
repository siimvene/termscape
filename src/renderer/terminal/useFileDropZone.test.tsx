// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { useFileDropZone } from './useFileDropZone'

// Standalone harness — react-dom + the hook, no testing-library (same shape as
// useDiscardWhenHidden.test.tsx). The body wires all four drop handlers exactly as the
// terminal node does, so dispatching native drag events drives the real synthetic path.

function Harness({ onFiles }: { onFiles: (files: File[]) => void }) {
  const drop = useFileDropZone(onFiles)
  return (
    <div
      data-testid="body"
      className={drop.dropping ? 'dropping' : ''}
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
    />
  )
}

let root: Root | null = null
let host: HTMLDivElement | null = null

function mount(onFiles: (files: File[]) => void): HTMLElement {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root!.render(<Harness onFiles={onFiles} />))
  return host.querySelector('[data-testid="body"]') as HTMLElement
}

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
})

/** A drag event carrying `types` and (for drop) `files`, with a spy-able dataTransfer. */
function dragEvent(type: string, types: string[], files: File[] = []): Event {
  const e = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(e, 'dataTransfer', {
    value: { types, files, dropEffect: 'none' }
  })
  return e
}

describe('useFileDropZone', () => {
  it('arms the overlay on dragenter and accepts a following empty-types dragover', () => {
    const body = mount(() => {})

    // Enter carries the file signal; the very next dragover reports nothing (the macOS flake).
    act(() => void body.dispatchEvent(dragEvent('dragenter', ['Files'])))
    expect(body.classList.contains('dropping')).toBe(true)

    const over = dragEvent('dragover', [])
    act(() => void body.dispatchEvent(over))
    // Latched active by the dragenter, so the blind tick is still accepted (preventDefault'd) —
    // without the dragenter wiring this first signal would be the empty dragover and get rejected,
    // leaving the drop area inert where the drag entered.
    expect(over.defaultPrevented).toBe(true)
    expect((over as unknown as { dataTransfer: DataTransfer }).dataTransfer.dropEffect).toBe('copy')
  })

  it('ignores a drag that never advertises files', () => {
    const body = mount(() => {})
    const enter = dragEvent('dragenter', ['text/plain'])
    act(() => void body.dispatchEvent(enter))
    expect(body.classList.contains('dropping')).toBe(false)
    expect(enter.defaultPrevented).toBe(false)
  })

  it('delivers the dropped files and clears the overlay', () => {
    const onFiles = vi.fn()
    const body = mount(onFiles)
    act(() => void body.dispatchEvent(dragEvent('dragenter', ['Files'])))

    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    act(() => void body.dispatchEvent(dragEvent('drop', ['Files'], [file])))
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect(onFiles.mock.calls[0][0]).toEqual([file])
    expect(body.classList.contains('dropping')).toBe(false)
  })
})
