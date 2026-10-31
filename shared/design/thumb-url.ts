// Shared so the renderer builds the same URL the main-process protocol routes.
// The version (?v=) only busts the cache: pitwall-design://thumb always serves
// the current thumbnail, so each URL can be cached as immutable.
export function thumbUrl(docId: string, version: string): string {
  return `pitwall-design://thumb/${encodeURIComponent(docId)}?v=${encodeURIComponent(version)}`
}
