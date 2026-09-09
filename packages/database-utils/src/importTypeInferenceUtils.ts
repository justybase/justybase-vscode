const TEXT_IMPORT_HEADER_TOKENS = ['PESEL', 'NRB', 'IBAN', 'BAN'];

function normalizeHeaderForTypeInference(header: string): string {
    return String(header || '')
        .trim()
        .toUpperCase()
        .replace(/[^0-9A-Z]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}

export function headerForcesTextImportType(header: string): boolean {
    const normalizedHeader = normalizeHeaderForTypeInference(header);
    if (!normalizedHeader) {
        return false;
    }

    return TEXT_IMPORT_HEADER_TOKENS.some(token =>
        normalizedHeader === token ||
        normalizedHeader.startsWith(`${token}_`) ||
        normalizedHeader.endsWith(`_${token}`)
    );
}

export function valueForcesTextImportType(value: string): boolean {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
        return false;
    }

    return /^0\d+(?:[.,]\d+)?$/.test(normalizedValue);
}
