/**
 * Generic auto-import scope check. The adapter supplies the scope set
 * (e.g. Nuxt's composables/, utils/ resolved to absolute dirs); this just
 * tests whether `filePath` falls under any of them.
 */
export function isInsideAutoImportScope(filePath: string, scopes: Set<string>): boolean {
  const normalizedFile = filePath.replace(/\\/g, '/')
  for (const scope of scopes) {
    const normalizedScope = scope.replace(/\\/g, '/')
    if (normalizedFile === normalizedScope || normalizedFile.startsWith(`${normalizedScope}/`))
      return true
  }
  return false
}
