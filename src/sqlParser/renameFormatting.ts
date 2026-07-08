export function formatSqlRenameReplacement(
    originalText: string,
    newName: string
): string {
    const trimmedName = newName.trim()
    const unquotedNewName =
        trimmedName.length >= 2 && trimmedName.startsWith('"') && trimmedName.endsWith('"')
            ? trimmedName.slice(1, -1)
            : trimmedName

    if (originalText.length >= 2 && originalText.startsWith('"') && originalText.endsWith('"')) {
        return `"${unquotedNewName.replace(/"/g, '""')}"`
    }

    return unquotedNewName
}