import { useEffect } from 'react'
import { createPortal } from 'react-dom'
import { ScenePhone } from './onboarding/scenes'
import { IOS_APP_STORE_URL } from '@renderer/lib/links'
// The seen-flag helpers live in lib/mobileLaunch: Canvas reads them on every launch, and importing
// them from here would defeat this component's (and the onboarding scenes') code splitting.
export { markMobileLaunchSeen, shouldShowMobileLaunch } from '@renderer/lib/mobileLaunch'

/**
 * One-time launch announcement for Termscape for iOS (App Store release): a centered card over
 * the canvas in the promo style — dark, purple glow, the floating phone mockup from the setup
 * tour. Closes for good via the button, Esc, or the backdrop; every path persists the flag.
 */
export function MobileLaunchCard({ onClose }: { onClose: () => void }): React.JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div className="mlaunch__backdrop" onClick={onClose}>
      <div
        className="mlaunch"
        role="dialog"
        aria-label="Termscape for iOS is on the App Store"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mlaunch__title">
          Your terminal, <span>everywhere</span>
        </h2>
        <p className="mlaunch__sub">Termscape for iOS is now on the App Store 🎉</p>
        <div className="mlaunch__scene">
          <ScenePhone />
        </div>
        <p className="mlaunch__body">
          Attach to these same live sessions from your phone — watch an agent work, answer a
          &ldquo;needs you&rdquo;, type into any terminal from anywhere. This desktop build is a
          personal fork of{' '}
          <a href="https://github.com/eneskirca/nodeterm" target="_blank" rel="noreferrer">
            nodeterm
          </a>{' '}
          by Enes Kirca, kept for personal use and testing — please support the upstream project. ❤️
        </p>
        <div className="mlaunch__actions">
          <button
            className="onb-btn onb-btn--primary"
            autoFocus
            onClick={() => window.nodeTerminal.shell.openExternal(IOS_APP_STORE_URL)}
          >
            Get the iOS app
          </button>
          <button className="onb-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
