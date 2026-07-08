export type ObjectTypeCategory = 'table' | 'view' | 'column' | 'other';

export function getObjectTypeCategory(type: string): ObjectTypeCategory {
    const normalized = type.trim().toUpperCase();
    if (
        normalized === 'TABLE'
        || normalized === 'EXTERNAL TABLE'
        || (normalized.includes('TABLE') && !normalized.includes('VIEW'))
    ) {
        return 'table';
    }
    if (normalized === 'VIEW' || normalized.includes('VIEW')) {
        return 'view';
    }
    if (normalized === 'COLUMN') {
        return 'column';
    }
    return 'other';
}

export function getObjectTypeSortPriority(type: string): number {
    switch (getObjectTypeCategory(type)) {
        case 'table':
            return 1;
        case 'view':
            return 2;
        case 'column':
            return 3;
        default:
            return 4;
    }
}

export function compareObjectTypesByPriority(typeA: string, typeB: string): number {
    const priorityCompare = getObjectTypeSortPriority(typeA) - getObjectTypeSortPriority(typeB);
    if (priorityCompare !== 0) {
        return priorityCompare;
    }
    return typeA.localeCompare(typeB);
}

export function compareSearchResultsByObjectPriority(
    a: { TYPE?: string; DATABASE?: string; NAME?: string },
    b: { TYPE?: string; DATABASE?: string; NAME?: string }
): number {
    const typeCompare = compareObjectTypesByPriority(a.TYPE || '', b.TYPE || '');
    if (typeCompare !== 0) {
        return typeCompare;
    }

    const dbCompare = (a.DATABASE || '').localeCompare(b.DATABASE || '');
    if (dbCompare !== 0) {
        return dbCompare;
    }

    return (a.NAME || '').localeCompare(b.NAME || '');
}
