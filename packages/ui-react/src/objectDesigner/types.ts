import type {
  DesignerCapabilitiesRequest,
  DesignerCapabilitiesResponse,
  DesignerSnapshotResponse,
  MetadataColumn,
  MetadataObject,
  QueryEvent,
  QueryPreviewResponse,
  QueryStartRequest,
  QueryStartResponse,
} from '@justybase/contracts';

/** Minimal event subscription required by the shared guarded designer. */
export interface ObjectDesignerQueryEventSubscription {
  close(): void;
}

/** Platform-neutral API surface used by the shared Object Designer. */
export interface ObjectDesignerApi {
  designerCapabilities(input: DesignerCapabilitiesRequest): Promise<DesignerCapabilitiesResponse>;
  designerSnapshot(input: DesignerCapabilitiesRequest): Promise<DesignerSnapshotResponse>;
  columns(connectionId: string, database: string, schema: string, table: string): Promise<readonly MetadataColumn[]>;
  objects(connectionId: string, database: string, schema?: string): Promise<readonly MetadataObject[]>;
  previewQuery(input: QueryStartRequest): Promise<QueryPreviewResponse>;
  startQuery(input: QueryStartRequest): Promise<QueryStartResponse>;
  connectToQueryEvents(queryId: string, onEvent: (event: QueryEvent) => void, onError?: (error: Error) => void): ObjectDesignerQueryEventSubscription;
}
