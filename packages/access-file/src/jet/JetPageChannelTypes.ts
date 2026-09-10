import type { JetLayout } from './JetLayout';

/** Minimal page-channel contract shared by usage-map readers and writers. */
export interface JetPageChannelLike {
    readonly layout: JetLayout;
    pageAt(pageNumber: number): Buffer;
    allocateNewPage(markGlobalUsage?: boolean): number;
    deallocatePage(pageNumber: number): void;
}
