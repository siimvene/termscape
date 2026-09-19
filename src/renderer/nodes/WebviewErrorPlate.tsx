import type { WebviewLoadFailure } from './webviewError'

/**
 * What stands in for a page that failed to load, over the guest rather than beside it: Chromium
 * paints its own error page inside the `<webview>`, and leaving that visible puts another
 * product's chrome in the middle of a node with no way back.
 *
 * One component so the canvas web node and the browser surface cannot drift into two wordings for
 * the same failure. The wording itself lives in {@link describeLoadFailure}.
 */
export function WebviewErrorPlate({
  failure,
  onRetry
}: {
  failure: WebviewLoadFailure
  onRetry?: () => void
}): React.JSX.Element {
  return (
    <div className="browser-node__failed" role="alert">
      <span className="browser-node__failed-msg">{failure.message}</span>
      {failure.url && <span className="browser-node__failed-url">{failure.url}</span>}
      {failure.hint && <span className="browser-node__failed-hint">{failure.hint}</span>}
      {/* Chromium's own symbol: the one part of this plate that is searchable and quotable. */}
      <span className="browser-node__failed-code">{failure.raw}</span>
      {failure.retryable && onRetry && (
        <button className="browser-node__failed-retry" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  )
}
