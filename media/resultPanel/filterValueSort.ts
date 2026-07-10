import { getNumericTypeInfo } from './utils.js';

/** Strip grouping separators so "123 456" / "123,456" match compact search "123456". */
const FILTER_SEARCH_GROUPING_PATTERN = /[\s\u00A0\u202F,]/g;

export function compactFilterSearchText(value: string): string {
    return String(value).toLowerCase().replace(FILTER_SEARCH_GROUPING_PATTERN, '');
}

export function parseFilterNumericValue(value: string): number | null {
    if (value === 'NULL') {
        return null;
    }
    const parsed = Number(String(value).replace(FILTER_SEARCH_GROUPING_PATTERN, ''));
    return Number.isFinite(parsed) ? parsed : null;
}

/** Match filter dropdown search against display text, including compact numeric forms (e.g. 20101228 vs 2010 12 28, 123456 vs 123 456). */
export function matchesFilterValueSearch(displayValue: string, searchTerm: string): boolean {
    const lowerDisplay = String(displayValue).toLowerCase();
    const lowerNeedle = String(searchTerm).toLowerCase();
    if (lowerDisplay.includes(lowerNeedle)) {
        return true;
    }

    const compactNeedle = compactFilterSearchText(searchTerm);
    if (!compactNeedle) {
        return false;
    }

    return compactFilterSearchText(displayValue).includes(compactNeedle);
}

export function startsWithFilterValueSearch(displayValue: string, searchTerm: string): boolean {
    const lowerDisplay = String(displayValue).toLowerCase();
    const lowerNeedle = String(searchTerm).toLowerCase();
    if (lowerDisplay.startsWith(lowerNeedle)) {
        return true;
    }

    const compactNeedle = compactFilterSearchText(searchTerm);
    if (!compactNeedle) {
        return false;
    }

    return compactFilterSearchText(displayValue).startsWith(compactNeedle);
}

export function endsWithFilterValueSearch(displayValue: string, searchTerm: string): boolean {
    const lowerDisplay = String(displayValue).toLowerCase();
    const lowerNeedle = String(searchTerm).toLowerCase();
    if (lowerDisplay.endsWith(lowerNeedle)) {
        return true;
    }

    const compactNeedle = compactFilterSearchText(searchTerm);
    if (!compactNeedle) {
        return false;
    }

    return compactFilterSearchText(displayValue).endsWith(compactNeedle);
}

function shouldSortFilterValuesNumerically(values: string[], dataType: string | undefined): boolean {
    if (getNumericTypeInfo(dataType).isNumeric) {
        return true;
    }

    return values.some((value) => {
        if (value === 'NULL') {
            return false;
        }
        const parsed = parseFilterNumericValue(value);
        return parsed !== null;
    });
}

export function sortFilterValues(values: string[], dataType: string | undefined): string[] {
    if (!shouldSortFilterValuesNumerically(values, dataType)) {
        return values.sort((a, b) => a.localeCompare(b));
    }

    return values.sort((a, b) => {
        const aNum = parseFilterNumericValue(a);
        const bNum = parseFilterNumericValue(b);
        if (aNum === null && bNum === null) {
            return a.localeCompare(b);
        }
        if (aNum === null) {
            return 1;
        }
        if (bNum === null) {
            return -1;
        }
        return aNum - bNum;
    });
}
