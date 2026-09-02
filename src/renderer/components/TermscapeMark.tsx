import { useId } from 'react'

/**
 * The Termscape mark — the same badge the iOS companion uses for its home header
 * (nodeterm-mobile design/LogoMark.svg; the app icon in resources/brand/termscape-appicon.svg is
 * the full-bleed sibling). One component for every in-app placement (title bar, welcome screen,
 * onboarding), so the brand cannot drift per surface again. Upstream nodeterm's node-graph mark
 * must not be drawn anywhere in this fork: BUSL-1.1 grants no rights in the Licensor's logo, and
 * `brand-mark.guard.test.ts` fails on its path data. Gradient ids come from `useId` so several
 * instances on one page do not share (and clobber) each other's <defs>.
 */
export function TermscapeMark({ size = 26, className }: { size?: number; className?: string }) {
  const uid = useId().replace(/:/g, '')
  const bg = `tsm-bg-${uid}`
  const sheen = `tsm-sheen-${uid}`
  return (
    <svg className={className} viewBox="0 0 132 132" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={bg} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#2A2736" />
          <stop offset="1" stopColor="#131119" />
        </linearGradient>
        <linearGradient id={sheen} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.14" />
          <stop offset="0.22" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="126" height="126" rx="30" fill={`url(#${bg})`} />
      <rect x="3" y="3" width="126" height="126" rx="30" fill={`url(#${sheen})`} />
      <rect x="4" y="4" width="124" height="124" rx="29" fill="none" stroke="#A78BFA" strokeOpacity="0.28" strokeWidth="2" />
      <polyline points="43,41 71,66 43,91" fill="none" stroke="#A78BFA" strokeWidth="12" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="74" y="80" width="36" height="12" rx="6" fill="#A78BFA" />
    </svg>
  )
}
