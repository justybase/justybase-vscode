export function buildEscapedLikePattern(term: string): string {
    const escapedTerm = term
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "''")
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_')
        .toUpperCase();

    return `%${escapedTerm}%`;
}
