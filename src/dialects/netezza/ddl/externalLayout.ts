import {
    isNetezzaExternalLayoutZoneCount,
    reconstructNetezzaExternalLayout,
    type NetezzaExternalLayoutZone,
} from '@justybase/designer-core';

export interface ExternalLayoutZoneRow {
    USETYPE?: unknown;
    NAME?: unknown;
    TYPE?: unknown;
    STYLE?: unknown;
    LENGTH?: unknown;
    DELIMITER?: unknown;
    AROUND?: unknown;
    NULLIF?: unknown;
    ENDIAN?: unknown;
    ALIGNMENT?: unknown;
    MODULUS?: unknown;
}

export const isExternalLayoutZoneCount = isNetezzaExternalLayoutZoneCount;

export function reconstructExternalLayout(
    catalogLayout: unknown,
    zones: readonly ExternalLayoutZoneRow[],
): string | null {
    return reconstructNetezzaExternalLayout(catalogLayout, zones.map((zone): NetezzaExternalLayoutZone => ({
        usetype: zone.USETYPE,
        name: zone.NAME,
        type: zone.TYPE,
        style: zone.STYLE,
        length: zone.LENGTH,
        delimiter: zone.DELIMITER,
        around: zone.AROUND,
        nullif: zone.NULLIF,
        endian: zone.ENDIAN,
        alignment: zone.ALIGNMENT,
        modulus: zone.MODULUS,
    })));
}
