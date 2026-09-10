import type { JetLayout } from './JetLayout';
import type { JetPageChannelLike } from './JetPageChannelTypes';
import type { JetTextSortOrder } from './JetTextSortOrder';

export interface JetColumn {
    readonly name: string;
    readonly type: number;
    readonly columnNumber: number;
    readonly variable: boolean;
    readonly variableIndex: number;
    readonly fixedOffset: number;
    readonly size: number;
    readonly precision: number;
    readonly scale: number;
    readonly autoLong: boolean;
    readonly autoUuid: boolean;
    /** raw sort-order value from the column definition (text columns only) */
    readonly sortOrder?: number;
    /** sort-order version byte (Jet4 stores 4 bytes: value + version at +2/+3) */
    readonly sortOrderVersion?: number;
}

/** Table surface required by index encoding and page-cache persistence. */
export interface JetIndexTableLike {
    readonly columns: readonly JetColumn[];
    readonly layout: JetLayout;
    readonly channel: JetPageChannelLike;
    readonly definitionPage: number;
    columnSortOrder(column: JetColumn): JetTextSortOrder | null;
}
