import { describe, it, expect, afterEach, vi } from 'vitest'
import {
  acceptsFileDrag,
  canvasImageFiles,
  canvasImageSink,
  clipboardImages,
  escapeDroppedPath,
  fileNavigationGuard,
  localPathsForFiles,
  pasteHasText,
  pastedFiles,
  uploadNameFor
} from './file-drop'

describe('acceptsFileDrag', () => {
  it('accepts a dragover that advertises files', () => {
    expect(acceptsFileDrag(['Files'], false)).toBe(true)
  })

  it('ignores a non-file dragover that was never a file drag', () => {
    expect(acceptsFileDrag(['text/plain', 'text/uri-list'], false)).toBe(false)
  })

  it('keeps accepting once a file drag is recognized, even on an empty-types tick', () => {
    // The macOS/Electron flake: a mid-drag dragover reports no types. Re-deciding from types
    // alone would reject the drop here and wedge the overlay; the active latch keeps it accepted.
    expect(acceptsFileDrag([], true)).toBe(true)
  })
})

describe('fileNavigationGuard', () => {
  const over = (types: string[]) => {
    const prevented = { v: false }
    return { preventDefault: () => (prevented.v = true), dataTransfer: { types }, prevented }
  }
  const drop = (fileCount: number) => {
    const prevented = { v: false }
    return {
      preventDefault: () => (prevented.v = true),
      dataTransfer: { files: { length: fileCount } },
      prevented
    }
  }

  it('does not touch a drag that never advertises files', () => {
    const g = fileNavigationGuard()
    const o = over(['text/plain'])
    g.dragOver(o)
    const d = drop(0)
    g.drop(d)
    expect(o.prevented.v).toBe(false)
    expect(d.prevented.v).toBe(false)
  })

  it('keeps preventing dragover after a types tick flakes empty, once armed', () => {
    // The dangerous case: a file dragover armed the guard, then a tick reports no types. Dropping
    // the guard here would let the browser navigate the window to the file:// and unload the
    // workspace, since dragover-preventDefault is what suppresses that navigation.
    const g = fileNavigationGuard()
    g.dragOver(over(['Files'])) // arming tick
    const blind = over([])
    g.dragOver(blind)
    expect(blind.prevented.v).toBe(true)
  })

  it('prevents a file drop from its own files, needing no latch', () => {
    const g = fileNavigationGuard()
    const d = drop(1)
    g.drop(d)
    expect(d.prevented.v).toBe(true)
  })

  it('clears the latch on drop so a later non-file drag is left alone (the leak regression)', () => {
    // Without the clear, the latch armed by the file drag stays true and the next text drag's
    // dragover is wrongly prevented, canceling native text drops into inputs/editors.
    const g = fileNavigationGuard()
    g.dragOver(over(['Files']))
    g.drop(drop(1))
    const next = over(['text/plain'])
    g.dragOver(next)
    expect(next.prevented.v).toBe(false)
  })

  it('clears the latch on endDrag (dragend / window-leaving dragleave)', () => {
    const g = fileNavigationGuard()
    g.dragOver(over(['Files']))
    g.endDrag()
    const next = over(['text/plain'])
    g.dragOver(next)
    expect(next.prevented.v).toBe(false)
  })
})

describe('escapeDroppedPath', () => {
  it('escapes what a shell would otherwise interpret', () => {
    expect(escapeDroppedPath('/tmp/Bishop Drew order.xlsx')).toBe('/tmp/Bishop\\ Drew\\ order.xlsx')
    expect(escapeDroppedPath("/tmp/a'b$c")).toBe("/tmp/a\\'b\\$c")
  })
})

describe('uploadNameFor', () => {
  it('keeps the file s own name when it has one', () => {
    expect(uploadNameFor(new File(['x'], 'report.pdf', { type: 'application/pdf' }))).toBe(
      'report.pdf'
    )
  })

  it('names clipboard bytes by their type — an agent should not have to guess', () => {
    // A screenshot arrives as image/png with an EMPTY name; a suffix-less `pasted-<ts>` tells
    // whatever reads the prompt nothing about what it is holding.
    const name = uploadNameFor(new File(['x'], '', { type: 'image/png' }))
    expect(name).toMatch(/^pasted-\d{8}-\d{6}\.png$/)
    expect(uploadNameFor(new File(['x'], '', { type: 'image/jpeg' }))).toMatch(/\.jpg$/)
  })

  it('falls back to the subtype, then to .bin, for a type it has no table entry for', () => {
    expect(uploadNameFor(new File(['x'], '', { type: 'audio/ogg' }))).toMatch(/\.ogg$/)
    expect(uploadNameFor(new File(['x'], '', { type: '' }))).toMatch(/\.bin$/)
  })
})

/** Minimal stand-in for the shapes Chromium actually hands a paste. */
const clipboard = (opts: { files?: File[]; items?: File[]; text?: string }): DataTransfer =>
  ({
    files: (opts.files ?? []) as unknown as FileList,
    items: (opts.items ?? []).map((f) => ({ kind: 'file', getAsFile: () => f })) as unknown as
      DataTransferItemList,
    getData: (type: string) => (type === 'text/plain' ? (opts.text ?? '') : '')
  }) as DataTransfer

describe('pastedFiles', () => {
  const png = new File(['x'], 'a.png', { type: 'image/png' })

  it('reads an OS file-manager copy off `files`', () => {
    expect(pastedFiles(clipboard({ files: [png] }))).toEqual([png])
  })

  it('reads raw clipboard bytes off `items` — a screenshot never reaches `files`', () => {
    expect(pastedFiles(clipboard({ items: [png] }))).toEqual([png])
  })

  it('answers empty for a text paste, which is xterm s to handle', () => {
    expect(pastedFiles(clipboard({}))).toEqual([])
    expect(pastedFiles(null)).toEqual([])
  })
})

describe('canvasImageFiles', () => {
  it('keeps MIME images and known image extensions only', () => {
    const png = new File(['png'], 'shot.png', { type: 'image/png' })
    const avif = new File(['avif'], 'photo.AVIF')
    const text = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    expect(canvasImageFiles([png, avif, text])).toEqual([png, avif])
  })
})

describe('localPathsForFiles', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('routes pathless canvas bytes to the project image store, not the uploads staging area', async () => {
    const saveUpload = vi.fn()
    const saveCanvasImage = vi.fn().mockResolvedValue('/proj/.nodeterm/images/pasted.png')
    // The suite runs on the node environment, which has no FileReader; only the base64 handoff
    // matters here, so the read is the smallest stand-in that produces one.
    vi.stubGlobal(
      'FileReader',
      class {
        onload: (() => void) | null = null
        onerror: (() => void) | null = null
        result: string | null = null
        readAsDataURL(): void {
          this.result = 'data:image/png;base64,cG5n'
          this.onload?.()
        }
      }
    )
    vi.stubGlobal('window', {
      nodeTerminal: {
        // A clipboard screenshot: no OS path, so the sink is the only thing that decides where it
        // lands — and a canvas node outlives the 7-day uploads sweep.
        getPathForFile: () => null,
        files: { saveUpload, saveCanvasImage }
      }
    })
    const file = new File(['png'], 'pasted.png', { type: 'image/png' })
    expect(await localPathsForFiles([file], canvasImageSink('project-a'))).toEqual([
      '/proj/.nodeterm/images/pasted.png'
    ])
    expect(saveCanvasImage).toHaveBeenCalledWith('project-a', 'pasted.png', expect.any(String))
    expect(saveUpload).not.toHaveBeenCalled()
  })

  it('reuses an Electron file path without shell escaping it, and never calls the sink', async () => {
    const saveCanvasImage = vi.fn()
    vi.stubGlobal('window', {
      nodeTerminal: {
        getPathForFile: () => '/tmp/My image.png',
        files: { saveUpload: vi.fn(), saveCanvasImage }
      }
    })
    const file = new File(['png'], 'My image.png', { type: 'image/png' })
    // A Finder drop already IS a file on this disk, so nothing is copied anywhere.
    expect(await localPathsForFiles([file], canvasImageSink('project-a'))).toEqual([
      '/tmp/My image.png'
    ])
    expect(saveCanvasImage).not.toHaveBeenCalled()
  })
})

describe('pasteHasText', () => {
  it('separates an ordinary text paste from one that carried nothing at all', () => {
    expect(pasteHasText(clipboard({ text: 'hello' }))).toBe(true)
    // The filtered image-only clipboard: Chromium hands over no files AND no text.
    expect(pasteHasText(clipboard({}))).toBe(false)
    expect(pasteHasText(null)).toBe(false)
  })
})

describe('clipboardImages', () => {
  afterEach(() => vi.unstubAllGlobals())

  /** Stand-in for the async Clipboard API — `read()` is the only member touched. */
  const stubClipboard = (read: () => Promise<unknown[]>): void => {
    vi.stubGlobal('navigator', { clipboard: { read } })
  }

  const item = (types: string[]): unknown => ({
    types,
    getType: (t: string) => Promise.resolve(new Blob(['bytes'], { type: t }))
  })

  it('reads the screenshot the paste event filtered out, and names it', async () => {
    stubClipboard(async () => [item(['image/png'])])
    const [file] = await clipboardImages()
    expect(file.type).toBe('image/png')
    // A bare Blob has no name; without one the upload overlay and the agent both see nothing.
    expect(file.name).toMatch(/^pasted-\d{8}-\d{6}\.png$/)
  })

  it('ignores clipboard entries that hold no image', async () => {
    stubClipboard(async () => [item(['text/html', 'text/plain'])])
    expect(await clipboardImages()).toEqual([])
  })

  it('answers empty where the API is absent — an insecure context, or an older browser', async () => {
    vi.stubGlobal('navigator', {})
    expect(await clipboardImages()).toEqual([])
  })

  it('answers empty when the read is refused, leaving the paste the no-op it already was', async () => {
    stubClipboard(() => Promise.reject(new DOMException('denied', 'NotAllowedError')))
    expect(await clipboardImages()).toEqual([])
  })
})
