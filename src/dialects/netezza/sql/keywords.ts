import {
    BASE_SQL_COMPLETION_KEYWORDS,
    BASE_SQL_FORMATTER_PROFILE,
    extendFormatterProfile,
    mergeUniqueStrings
} from '../../../sql/authoring/baseProfiles';

export const NETEZZA_COMPLETION_KEYWORD_OVERLAYS = [
    'VIEWS',
    'BEGIN_PROC',
    'END_PROC',
    'NOTICE',
    'DEBUG',
    'ERROR',
    'DISTRIBUTE',
    'RANDOM',
    'ORGANIZE',
    'GROOM',
    'GENERATE',
    'NEXT',
    'STATISTICS',
    'VALUE',
    'FOR',
    'SESSION',
    // Netezza system views (_V_*)
    '_V_SESSION',
    '_V_TABLE_STORAGE_STAT',
    '_V_OBJECT_DATA',
    '_V_TABLE',
    '_V_VIEW',
    '_V_PROCEDURE',
    '_V_SYNONYM',
    '_V_RELATION_COLUMN',
    '_V_RELATION_KEYDATA',
    '_V_TABLE_DIST_MAP',
    '_V_TABLE_ORGANIZE_COLUMN',
    '_V_EXTERNAL',
    '_V_EXTOBJECT',
    '_V_DATABASE',
    '_V_SCHEMA'
] as const;

export const NETEZZA_COMPLETION_KEYWORDS = mergeUniqueStrings(
    BASE_SQL_COMPLETION_KEYWORDS,
    NETEZZA_COMPLETION_KEYWORD_OVERLAYS
);

export const netezzaFormatterProfile = extendFormatterProfile(BASE_SQL_FORMATTER_PROFILE, {
    keywords: [
        'VIEWS',
        'BEGIN_PROC',
        'END_PROC',
        'NOTICE',
        'DEBUG',
        'ERROR',
        'DISTRIBUTE',
        'RANDOM',
        'ORGANIZE',
        'GROOM',
        'GENERATE',
        'NEXT',
        'STATISTICS',
        'VALUE',
        'FOR',
        'SESSION',
        '_V_SESSION',
        '_V_TABLE_STORAGE_STAT',
        '_V_OBJECT_DATA',
        '_V_TABLE',
        '_V_VIEW',
        '_V_PROCEDURE',
        '_V_SYNONYM',
        '_V_RELATION_COLUMN',
        '_V_RELATION_KEYDATA',
        '_V_TABLE_DIST_MAP',
        '_V_TABLE_ORGANIZE_COLUMN',
        '_V_EXTERNAL',
        '_V_EXTOBJECT',
        '_V_DATABASE',
        '_V_SCHEMA'
    ]
});
