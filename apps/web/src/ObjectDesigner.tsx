import type { ReactElement } from 'react';
import type { DatabaseKind, SchemaTreeNode } from '@justybase/contracts';
import {
  ObjectDesigner as SharedObjectDesigner,
  type ObjectDesignerProps as SharedObjectDesignerProps,
} from '@justybase/ui-react';
import { useApiClient } from './api';

/** Web compatibility facade; the rendered surface and controller live in ui-react. */
export type ObjectDesignerProps = Omit<SharedObjectDesignerProps, 'api'>;

export function ObjectDesigner({ connectionId, database, databaseKind, target, onClose, onApplied }: ObjectDesignerProps): ReactElement {
  const api = useApiClient();
  return <SharedObjectDesigner api={api} connectionId={connectionId} database={database} databaseKind={databaseKind} target={target} onClose={onClose} onApplied={onApplied} />;
}

export type { DatabaseKind, SchemaTreeNode };
