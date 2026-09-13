import type * as Monaco from 'monaco-editor';
import type { SqlProblem } from '@justybase/ui-core';

function markerSeverity(severity: Monaco.MarkerSeverity): SqlProblem['severity'] {
  if (severity === 8) return 'error';
  if (severity === 4) return 'warning';
  if (severity === 2) return 'info';
  return 'hint';
}

function markerCode(code: Monaco.editor.IMarker['code']): string | undefined {
  if (typeof code === 'string') return code;
  return code && typeof code.value === 'string' ? code.value : undefined;
}

/** Converts Monaco diagnostics to the portable UI-core Problems contract. */
export function sqlProblemsFromMarkers(markers: readonly Monaco.editor.IMarker[]): readonly SqlProblem[] {
  return markers.map(marker => ({
    message: marker.message,
    severity: markerSeverity(marker.severity),
    code: markerCode(marker.code),
    startLineNumber: marker.startLineNumber,
    startColumn: marker.startColumn,
    endLineNumber: marker.endLineNumber,
    endColumn: marker.endColumn,
  }));
}
