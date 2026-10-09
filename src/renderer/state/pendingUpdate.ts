import { create } from 'zustand'

// The update the user still owes, as seen by the title-bar "Update" button (Figma-style: a
// prominent pill beside the traffic lights that cannot be dismissed). UpdateCard owns the updater
// subscriptions and writes here; the card's own ✕ only hides the CARD, never this, so a dismissed
// card still leaves a way to install. Transient: a relaunch re-derives it from the updater.
//
//   downloaded → staged, click restarts into it
//   manual     → a .deb/.rpm Linux install can't self-install, click opens the download page
//   required   → below the channel minimum, click triggers a check (which downloads it)
export type PendingUpdate =
  | { kind: 'downloaded'; version: string }
  | { kind: 'manual'; version: string }
  | { kind: 'required'; minSupported: string | null }

interface PendingUpdateState {
  pending: PendingUpdate | null
  setPending: (p: PendingUpdate | null) => void
}

export const usePendingUpdate = create<PendingUpdateState>((set) => ({
  pending: null,
  setPending: (pending) => set({ pending })
}))

// Termscape fork: our releases, not upstream's download page (whose DMG is a different app).
export const RELEASES_URL = 'https://github.com/siimvene/termscape/releases'

/** What clicking the title-bar button does for each pending kind. */
export function runPendingUpdate(p: PendingUpdate): void {
  if (p.kind === 'downloaded') window.nodeTerminal.updates.restart()
  else if (p.kind === 'manual') window.open(RELEASES_URL, '_blank', 'noopener')
  else window.nodeTerminal.updates.check()
}
