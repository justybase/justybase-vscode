import { unquoteIdentifier } from '../../../utils/identifierUtils'

export const SYSTEM_CATALOG_SOURCE_DATABASE = 'SYSTEM'

export function normalizeSystemCatalogObjectName(name: string | undefined): string | undefined {
    if (!name) {
        return undefined
    }

    const normalized = unquoteIdentifier(name).trim()
    if (!normalized) {
        return undefined
    }

    return normalized.toUpperCase()
}

export function isMirroredSystemCatalogObjectName(name: string | undefined): boolean {
    const normalized = normalizeSystemCatalogObjectName(name)
    return normalized !== undefined && normalized.startsWith('_V_')
}
