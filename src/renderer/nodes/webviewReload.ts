/** The slice of Electron's `WebviewTag` a reload needs. */
export type ReloadableWebview = {
  reload(): void
  reloadIgnoringCache(): void
}

/**
 * Reload the guest; `force` (Shift+click) bypasses the HTTP cache.
 *
 * A forced reload never falls back to a plain one. The gesture means "I do not trust what is on
 * screen", and a silent downgrade to a cached re-fetch is indistinguishable from a page that
 * genuinely did not change — so on a guest that can only `reload()` we do nothing instead.
 *
 * Both methods throw before the guest attaches, exactly like `isCurrentlyAudible` (see
 * `webviewAudible`). A guest that does not exist yet has nothing to reload, so swallowing that is
 * the correct answer rather than merely a safe one.
 */
export function reloadWebview(el: Partial<ReloadableWebview> | null | undefined, force: boolean): void {
  try {
    if (force) el?.reloadIgnoringCache?.()
    else el?.reload?.()
  } catch {
    // Not attached yet.
  }
}
