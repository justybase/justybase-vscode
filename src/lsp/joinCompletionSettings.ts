import type {
  JoinCompletionSettings,
  JoinRelationSetting,
  JoinTableIdentity,
} from "./protocol";

export const DEFAULT_JOIN_COMPLETION_SETTINGS: JoinCompletionSettings = Object.freeze({
  nameHeuristicsEnabled: true,
  autoAliases: true,
  aliases: Object.freeze([]),
  relations: Object.freeze([]),
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseTableIdentity(value: unknown): JoinTableIdentity | undefined {
  const record = asRecord(value);
  const table = asIdentifier(record?.table);
  if (!record || !table) return undefined;
  const database = asIdentifier(record.database);
  const schema = asIdentifier(record.schema);
  return {
    table,
    ...(database ? { database } : {}),
    ...(schema ? { schema } : {}),
  };
}

function parseRelation(value: unknown): JoinRelationSetting | undefined {
  const record = asRecord(value);
  const left = parseTableIdentity(record?.left);
  const right = parseTableIdentity(record?.right);
  if (!record || !left || !right || !Array.isArray(record.columns)) return undefined;
  const columns = record.columns.flatMap((value) => {
    const pair = asRecord(value);
    const leftColumn = asIdentifier(pair?.left);
    const rightColumn = asIdentifier(pair?.right);
    return leftColumn && rightColumn
      ? [{ left: leftColumn, right: rightColumn }]
      : [];
  });
  return columns.length > 0 ? { left, right, columns } : undefined;
}

export function normalizeJoinCompletionSettings(
  value: unknown,
): JoinCompletionSettings {
  const record = asRecord(value);
  if (!record) return DEFAULT_JOIN_COMPLETION_SETTINGS;
  const aliases = Array.isArray(record.joinAliases)
    ? record.joinAliases.flatMap((value) => {
        const alias = asRecord(value);
        const table = parseTableIdentity(alias?.table);
        const name = asIdentifier(alias?.alias);
        return table && name ? [{ table, alias: name }] : [];
      })
    : [];
  const relations = Array.isArray(record.joinRelations)
    ? record.joinRelations.flatMap((item) => {
        const relation = parseRelation(item);
        return relation ? [relation] : [];
      })
    : [];
  return {
    nameHeuristicsEnabled: record.joinNameHeuristics !== false,
    autoAliases: record.autoJoinAliases !== false,
    aliases,
    relations,
  };
}
