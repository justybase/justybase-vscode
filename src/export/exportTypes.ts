import type { ResultFormattingPayload, ResultFormattingSettings } from '../results/resultFormattingTypes';

/** Formatting options shared by the VS Code export coordinator and writers. */
export interface ExportFormattingMetadata {
  useFormattedValues?: boolean;
  payload?: ResultFormattingPayload;
  resultOverride?: Partial<ResultFormattingSettings>;
}
