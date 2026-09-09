import type { MetadataCompletenessInput, MetadataCompletenessReport } from './types';

export function evaluateCompleteness(input: MetadataCompletenessInput): MetadataCompletenessReport {
  const missingStages: string[] = [];
  if (!input.databaseLoaded) missingStages.push('database');
  if (!input.schemaLoaded) missingStages.push('schema');
  if (!input.objectsLoaded) missingStages.push('objects');
  if (!input.proceduresLoaded) missingStages.push('procedures');
  if (!input.typeGroupsLoaded) missingStages.push('typeGroup');
  const missingColumnKeys = input.expectedColumnKeys.filter(key => !input.loadedColumnKeys.has(key));
  return {
    complete: missingStages.length === 0 && missingColumnKeys.length === 0,
    missingStages,
    missingColumnKeys,
  };
}
