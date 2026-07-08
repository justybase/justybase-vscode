export const SQL_AUTHORING_LANGUAGE_IDS = ['sql', 'mssql', 'netezza-sql'] as const;

const SQL_AUTHORING_LANGUAGE_ID_SET = new Set<string>(SQL_AUTHORING_LANGUAGE_IDS);

export function isSqlAuthoringLanguageId(languageId: string | undefined): boolean {
    return typeof languageId === 'string' && SQL_AUTHORING_LANGUAGE_ID_SET.has(languageId.toLowerCase());
}
