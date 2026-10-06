/**
 * Transliteration of header characters to ASCII before SQL normalization.
 *
 * `ł`/`Ł` do not decompose under NFD, so they are mapped explicitly first;
 * the rest (ą, ć, ę, ń, ó, ś, ź, ż, …) is handled via NFD + combining-mark
 * removal. This also covers other Latin diacritics (é, ü, ñ, …).
 */
export function transliterateImportHeader(value: string): string {
    return String(value ?? '')
        .replace(/ł/g, 'l')
        .replace(/Ł/g, 'L')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]+/g, '');
}
