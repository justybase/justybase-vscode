import type { ChangeEvent, ReactNode, ReactElement } from 'react';

export interface DiagramToolbarProps {
    searchValue?: string;
    searchPlaceholder?: string;
    onSearchChange?: (value: string) => void;
    onAutoArrange?: () => void;
    onFitView?: () => void;
    onZoomIn?: () => void;
    onZoomOut?: () => void;
    onResetView?: () => void;
    onToggleGrid?: () => void;
    gridEnabled?: boolean;
    onExportSvg?: () => void;
    onExportPng?: () => void;
    leading?: ReactNode;
    trailing?: ReactNode;
}

function buttonLabel(label: string, symbol: string): ReactElement {
    return <><span className="diagram-button-symbol" aria-hidden="true">{symbol}</span>{label}</>;
}

export function DiagramToolbar({
    searchValue = '',
    searchPlaceholder = 'Search tables, columns or tasks',
    onSearchChange,
    onAutoArrange,
    onFitView,
    onZoomIn,
    onZoomOut,
    onResetView,
    onToggleGrid,
    gridEnabled = true,
    onExportSvg,
    onExportPng,
    leading,
    trailing,
}: DiagramToolbarProps): ReactElement {
    const handleSearch = (event: ChangeEvent<HTMLInputElement>): void => {
        onSearchChange?.(event.target.value);
    };

    return (
        <div className="diagram-toolbar" role="toolbar" aria-label="Diagram controls">
            {leading}
            <label className="diagram-search">
                <span aria-hidden="true">⌕</span>
                <input value={searchValue} onChange={handleSearch} placeholder={searchPlaceholder} type="search" />
            </label>
            <div className="diagram-toolbar-divider" aria-hidden="true" />
            {onAutoArrange && <button className="diagram-button" type="button" onClick={onAutoArrange}>{buttonLabel('Auto arrange', '⌘')}</button>}
            {onFitView && <button className="diagram-button" type="button" onClick={onFitView}>{buttonLabel('Fit view', '□')}</button>}
            {onZoomOut && <button className="diagram-icon-button" type="button" onClick={onZoomOut} aria-label="Zoom out">−</button>}
            {onZoomIn && <button className="diagram-icon-button" type="button" onClick={onZoomIn} aria-label="Zoom in">+</button>}
            {onResetView && <button className="diagram-button" type="button" onClick={onResetView}>Reset</button>}
            {onToggleGrid && <button className="diagram-button" type="button" onClick={onToggleGrid} aria-pressed={gridEnabled}>{buttonLabel(gridEnabled ? 'Grid on' : 'Grid off', '·')}</button>}
            <div className="diagram-toolbar-spacer" />
            {onExportSvg && <button className="diagram-button" type="button" onClick={onExportSvg}>Export SVG</button>}
            {onExportPng && <button className="diagram-button" type="button" onClick={onExportPng}>Export PNG</button>}
            {trailing}
        </div>
    );
}
