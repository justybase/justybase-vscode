import type { ReactNode, ReactElement } from 'react';

export interface DiagramInspectorProps {
    title: string;
    eyebrow?: string;
    children?: ReactNode;
    emptyMessage?: string;
    onClose?: () => void;
}

export function DiagramInspector({
    title,
    eyebrow = 'INSPECTOR',
    children,
    emptyMessage = 'Select an item to inspect its details.',
    onClose,
}: DiagramInspectorProps): ReactElement {
    return (
        <aside className="diagram-inspector" aria-label="Diagram inspector">
            <div className="diagram-inspector-heading">
                <div>
                    <div className="diagram-eyebrow">{eyebrow}</div>
                    <h2>{title}</h2>
                </div>
                {onClose && (
                    <button className="diagram-icon-button" type="button" onClick={onClose} aria-label="Close inspector">
                        ×
                    </button>
                )}
            </div>
            <div className="diagram-inspector-content">
                {children || <p className="diagram-muted">{emptyMessage}</p>}
            </div>
        </aside>
    );
}
