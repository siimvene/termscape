/**
 * The indeterminate bar across the top of a `<webview>` while a navigation is in flight.
 *
 * Indeterminate rather than a progress percentage: a guest reports `did-start-loading` and
 * `did-stop-loading` and nothing in between, so any number here would be invented.
 *
 * One component for both surfaces, for the same reason as {@link DiscardedPlate}.
 */
export function WebviewLoadingBar(): React.JSX.Element {
  return <div className="webview-progress" role="progressbar" aria-label="Loading" aria-busy="true" />
}
