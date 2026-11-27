import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { SharedColumnStatistics } from './columnStatistics.js';
import { MenuIcon } from '@justybase/ui-react';

export interface ColumnStatisticsDialogProps {
    readonly columnName: string;
    readonly columnType?: string;
    readonly loading: boolean;
    readonly error?: string;
    readonly statistics?: SharedColumnStatistics;
    readonly onClose: () => void;
    readonly onCopy: (statistics: SharedColumnStatistics) => void;
}

function formatNumber(value: number | undefined): string {
    if (value === undefined || !Number.isFinite(value)) return '—';
    return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}

function formatCount(value: number): string {
    return value.toLocaleString('en-US');
}

/** Compact whole-column summary opened from the grid header context menu. */
export function ColumnStatisticsDialog({
    columnName,
    columnType,
    loading,
    error,
    statistics,
    onClose,
    onCopy,
}: ColumnStatisticsDialogProps): ReactNode {
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
    }, [onClose]);

    const nullRate = statistics && statistics.rowCount > 0
        ? (statistics.nullCount / statistics.rowCount) * 100
        : 0;
    const filtered = statistics?.totalRowCount !== undefined && statistics.totalRowCount !== statistics.rowCount;
    const scope = statistics?.scope === 'database'
        ? (filtered ? `SQLite · filtered rows ${formatCount(statistics.rowCount)} of ${formatCount(statistics.totalRowCount!)}` : 'SQLite · all rows')
        : (filtered ? `Loaded rows · filtered ${formatCount(statistics?.rowCount ?? 0)}` : 'Loaded rows');

    return <div className="ui-column-stats-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
        <div className="ui-column-stats-dialog" role="dialog" aria-modal="true" aria-labelledby="ui-column-stats-title">
            <header className="ui-column-stats-header">
                <div>
                    <h2 id="ui-column-stats-title">Column statistics</h2>
                    <span title={columnName}>{columnName}{columnType ? ` · ${columnType}` : ''}</span>
                </div>
                <button type="button" className="ui-column-stats-close" aria-label="Close column statistics" title="Close" onClick={onClose}>
                    <MenuIcon name="x" />
                </button>
            </header>
            {loading
                ? <div className="ui-column-stats-status" role="status">Computing column statistics…</div>
                : error
                    ? <div className="ui-column-stats-error" role="alert">{error}</div>
                    : statistics && <>
                        <div className="ui-column-stats-scope">{scope}</div>
                        <table className="ui-column-stats-table">
                            <tbody>
                                <tr><th>Rows</th><td>{formatCount(statistics.rowCount)}</td></tr>
                                <tr><th>Non-null</th><td>{formatCount(statistics.count)}</td></tr>
                                <tr><th>Nulls</th><td>{formatCount(statistics.nullCount)}{statistics.rowCount > 0 ? ` (${nullRate.toFixed(1)}%)` : ''}</td></tr>
                                <tr><th>Distinct</th><td>{formatCount(statistics.distinctCount)}</td></tr>
                                {statistics.avg !== undefined && <>
                                    <tr><th>Sum</th><td>{formatNumber(statistics.sum)}</td></tr>
                                    <tr><th>Average</th><td>{formatNumber(statistics.avg)}</td></tr>
                                    <tr><th>Minimum</th><td>{formatNumber(statistics.min)}</td></tr>
                                    <tr><th>Maximum</th><td>{formatNumber(statistics.max)}</td></tr>
                                    <tr><th>Std deviation</th><td>{formatNumber(statistics.stdev)}</td></tr>
                                </>}
                            </tbody>
                        </table>
                        {statistics.numericCount > 0 && statistics.numericCount < statistics.count && <p className="ui-column-stats-note">
                            Numeric statistics cover {formatCount(statistics.numericCount)} of {formatCount(statistics.count)} non-null values.
                        </p>}
                        <footer className="ui-column-stats-footer">
                            <button type="button" onClick={() => onCopy(statistics)}><MenuIcon name="copy" /> Copy</button>
                            <button type="button" onClick={onClose}>Close</button>
                        </footer>
                    </>}
        </div>
    </div>;
}
