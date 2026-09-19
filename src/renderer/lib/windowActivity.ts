/**
 * Is anybody looking at this window right now?
 *
 * The one consumer is the CSS animation gate (`--nt-anim-state` / `[data-nt-window]` near the top
 * of styles.css): every `infinite` animation the app draws — pulsing status dots, node glows,
 * spinners, the walking mascots — is held still while the answer is no. See that block for the
 * measurements; the short version is that one running animation obliges the compositor to produce
 * a frame every vsync for as long as it runs, and a canvas full of agent nodes does that forever.
 *
 * "Looking at it" is deliberately the STRICTER of two facts, and each covers a case the other
 * misses:
 *
 *   - `document.hidden` is the browser's own answer, and it is the weaker one. It goes true for a
 *     background tab or a minimised/fully-occluded window — Chromium then stops producing frames
 *     by itself, so on its own it would gate nothing we are not already getting for free.
 *   - Window FOCUS is the case that actually costs: a nodeterm window sitting visible on a second
 *     monitor, or behind a half-width editor, while its owner works in another app. It is not
 *     hidden by any definition Chromium uses, it composites at full display rate, and nobody is
 *     watching a dot pulse. That is the state this module exists to name.
 *
 * The fail-safe direction is `active`. Everything here is decoration, so being wrong costs a
 * needlessly running animation, never a hidden one — an environment with no `hasFocus` (a test
 * DOM, an exotic embedder) therefore reads as active and the app animates exactly as it did
 * before this file existed.
 */

/** What the gate reports. `idle` is "no one is looking", not "the machine is idle". */
export type WindowActivity = 'active' | 'idle'

/** The attribute `installWindowActivity` writes on the document element. */
export const WINDOW_ACTIVITY_ATTR = 'data-nt-window'

/**
 * The whole decision, as a pure function of the two facts above.
 *
 * Note `focused` is asked for as a value rather than read here: the caller reads it from the
 * event that woke it (a `blur` means unfocused even in the tick before `document.hasFocus()`
 * agrees), which is what keeps the attribute in step with what the user just did.
 */
export function resolveWindowActivity(focused: boolean, hidden: boolean): WindowActivity {
  return focused && !hidden ? 'active' : 'idle'
}

export interface WindowActivityDeps {
  /** The element carrying the attribute. Defaults to `document.documentElement`. */
  root: { setAttribute(name: string, value: string): void; removeAttribute(name: string): void }
  /** Focus/visibility sources, injected so the unit test can drive them without a real window. */
  hasFocus(): boolean
  isHidden(): boolean
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/**
 * Start reflecting window activity onto the document element, and return the teardown.
 *
 * The attribute is only written when the value CHANGES, and `active` removes it rather than
 * writing `active`: the default state should leave no trace in the DOM, so a page that never
 * loses focus is byte-identical to one from before this module existed.
 */
export function installWindowActivity(deps: WindowActivityDeps): () => void {
  let current: WindowActivity | null = null

  const apply = (): void => {
    // `hasFocus` is read fresh each time rather than inferred from which event fired: a window can
    // lose focus and be hidden in the same tick (⌘H), and two listeners racing to write opposite
    // values would leave whichever landed second in charge.
    let next: WindowActivity
    try {
      next = resolveWindowActivity(deps.hasFocus(), deps.isHidden())
    } catch {
      next = 'active'
    }
    if (next === current) return
    current = next
    if (next === 'active') deps.root.removeAttribute(WINDOW_ACTIVITY_ATTR)
    else deps.root.setAttribute(WINDOW_ACTIVITY_ATTR, next)
  }

  const events = ['focus', 'blur', 'visibilitychange', 'pageshow']
  for (const e of events) deps.addEventListener(e, apply)
  apply()

  return () => {
    for (const e of events) deps.removeEventListener(e, apply)
  }
}

/** The browser wiring, kept apart from the logic above so the logic stays testable. */
export function installWindowActivityOnDocument(): () => void {
  if (typeof document === 'undefined' || typeof window === 'undefined') return () => {}
  return installWindowActivity({
    root: document.documentElement,
    // A document that cannot answer (no `hasFocus`) reads as focused — see the fail-safe note above.
    hasFocus: () => (typeof document.hasFocus === 'function' ? document.hasFocus() : true),
    isHidden: () => document.visibilityState === 'hidden',
    addEventListener: (type, listener) => {
      // `visibilitychange` is a document event; focus/blur are read off the window, because a
      // window `blur` is the event Electron forwards when the user switches apps.
      const target: EventTarget = type === 'visibilitychange' ? document : window
      target.addEventListener(type, listener)
    },
    removeEventListener: (type, listener) => {
      const target: EventTarget = type === 'visibilitychange' ? document : window
      target.removeEventListener(type, listener)
    }
  })
}
