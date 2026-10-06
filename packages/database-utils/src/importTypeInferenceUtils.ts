import { transliterateImportHeader } from './importColumnNameUtils';

const TEXT_IMPORT_HEADER_TOKENS = ['NRB', 'IBAN', 'BAN'];

function normalizeHeaderForTypeInference(header: string): string {
    return transliterateImportHeader(String(header || ''))
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

const PESEL_CHECKSUM_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];

/**
 * Decode the birth date encoded in YYMMDDPPPC. PESEL shifts the month by
 * +20 per century relative to 1900: 1800s +80, 1900s +0, 2000s +20,
 * 2100s +40, 2200s +60. Genuine PESELs always carry a real calendar date,
 * so this rejects checksum-valid arbitrary 11-digit IDs that would
 * otherwise lock a numeric column to text.
 */
function hasPlausiblePeselBirthDate(digits: string): boolean {
    const year = Number(digits.slice(0, 2));
    const encodedMonth = Number(digits.slice(2, 4));
    const day = Number(digits.slice(4, 6));
    if (day < 1) {
        return false;
    }

    let century: number;
    let month: number;
    if (encodedMonth >= 1 && encodedMonth <= 12) {
        century = 1900;
        month = encodedMonth;
    } else if (encodedMonth >= 21 && encodedMonth <= 32) {
        century = 2000;
        month = encodedMonth - 20;
    } else if (encodedMonth >= 41 && encodedMonth <= 52) {
        century = 2100;
        month = encodedMonth - 40;
    } else if (encodedMonth >= 61 && encodedMonth <= 72) {
        century = 2200;
        month = encodedMonth - 60;
    } else if (encodedMonth >= 81 && encodedMonth <= 92) {
        century = 1800;
        month = encodedMonth - 80;
    } else {
        return false;
    }

    const daysInMonth = new Date(century + year, month, 0).getDate();
    return day <= daysInMonth;
}

/** True for 11-digit values with a valid PESEL checksum and birth date. */
export function valueLooksLikePesel(value: string): boolean {
    const digits = String(value ?? '').trim();
    if (!/^\d{11}$/.test(digits)) {
        return false;
    }
    if (!hasPlausiblePeselBirthDate(digits)) {
        return false;
    }

    let sum = 0;
    for (let i = 0; i < 10; i++) {
        sum += Number(digits.charAt(i)) * PESEL_CHECKSUM_WEIGHTS[i];
    }
    return (10 - (sum % 10)) % 10 === Number(digits.charAt(10));
}

export function valueForcesTextImportType(value: string): boolean {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
        return false;
    }

    return /^0\d+(?:[.,]\d+)?$/.test(normalizedValue);
}
