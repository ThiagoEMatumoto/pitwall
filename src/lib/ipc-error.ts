// "Error invoking remote method 'sessions:resume': Error: <msg>" → "<msg>".
export function ipcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:\w*Error:\s*)?/, '')
}
