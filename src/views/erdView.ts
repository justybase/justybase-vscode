/**
 * ERD (Entity Relationship Diagram) View
 * Webview panel for displaying table relationships
 */

import * as vscode from 'vscode';
import { ERDData, TableNode, RelationshipEdge } from '../schema/erdProvider';

export class ERDView {
    public static currentPanel: ERDView | undefined;
    public static readonly viewType = 'netezza.erdView';

    private readonly _panel: vscode.WebviewPanel;
    private _disposables: vscode.Disposable[] = [];

    public static createOrShow(extensionUri: vscode.Uri, erdData: ERDData) {
        const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined;

        // If we already have a panel, show it
        if (ERDView.currentPanel) {
            ERDView.currentPanel._panel.reveal(column);
            ERDView.currentPanel._update(erdData);
            return;
        }

        // Otherwise, create a new panel
        const panel = vscode.window.createWebviewPanel(
            ERDView.viewType,
            `ERD: ${erdData.database}.${erdData.schema}`,
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')]
            }
        );

        ERDView.currentPanel = new ERDView(panel, extensionUri, erdData);
    }

    private constructor(panel: vscode.WebviewPanel, _extensionUri: vscode.Uri, erdData: ERDData) {
        this._panel = panel;

        // Set the webview's initial html content
        this._update(erdData);

        // Listen for when the panel is disposed
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
    }

    public dispose() {
        ERDView.currentPanel = undefined;

        // Clean up our resources
        this._panel.dispose();

        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }

    private _update(erdData: ERDData) {
        this._panel.title = `ERD: ${erdData.database}.${erdData.schema}`;
        this._panel.webview.html = this._getHtml(erdData);
    }

    private _getHtml(erdData: ERDData): string {
        const tableHtml = this._generateTableBoxes(erdData.tables, erdData.relationships);
        const relationshipCount = erdData.relationships.length;
        const tableCount = erdData.tables.length;

        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Entity Relationship Diagram</title>
                <style>
                    ${this._getStyles()}
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>Entity Relationship Diagram</h1>
                    <div class="header-info">
                        <span class="badge">${erdData.database}.${erdData.schema}</span>
                        <span class="stat">${tableCount} tables</span>
                        <span class="stat">${relationshipCount} relationships</span>
                    </div>
                </div>

                <div class="legend">
                    <span class="legend-item"><span class="pk-indicator">🔑</span> Primary Key</span>
                    <span class="legend-item"><span class="fk-indicator">🔗</span> Foreign Key</span>
                </div>

                ${relationshipCount === 0
                ? `
                    <div class="no-relationships">
                        <p>⚠️ No foreign key relationships found in this schema.</p>
                        <p>Tables are displayed but no relationship lines can be drawn.</p>
                    </div>
                `
                : ''
            }

                <div class="erd-container" id="erdContainer">
                    <div class="erd-canvas" id="erdCanvas">
                        ${tableHtml}
                        <svg class="relationships-svg" id="relationshipsSvg"></svg>
                    </div>
                </div>

                <div class="relationships-table">
                    <h2>Foreign Key Relationships</h2>
                    ${relationshipCount > 0
                ? `
                        <table>
                            <thead>
                                <tr>
                                    <th>Constraint Name</th>
                                    <th>From Table</th>
                                    <th>Column(s)</th>
                                    <th>→</th>
                                    <th>To Table</th>
                                    <th>Column(s)</th>
                                    <th>On Delete</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${erdData.relationships
                    .map(
                        rel => `
                                    <tr>
                                        <td><code>${rel.constraintName}</code></td>
                                        <td><strong>${rel.fromTable}</strong></td>
                                        <td>${rel.fromColumns.join(', ')}</td>
                                        <td>→</td>
                                        <td><strong>${rel.toTable}</strong></td>
                                        <td>${rel.toColumns.join(', ')}</td>
                                        <td>${rel.onDelete}</td>
                                    </tr>
                                `
                    )
                    .join('')}
                            </tbody>
                        </table>
                    `
                : '<p>No foreign key relationships defined.</p>'
            }
                </div>

                <script>
                    ${this._getScript(erdData)}
                </script>
            </body>
            </html>
        `;
    }

    private _generateTableBoxes(tables: TableNode[], relationships: RelationshipEdge[]): string {
        // Build relationship graph for intelligent layout
        const tableConnections: Map<string, Set<string>> = new Map();
        const outgoingFKCount: Map<string, number> = new Map();
        const incomingFKCount: Map<string, number> = new Map();

        // Initialize all tables
        tables.forEach(t => {
            const shortName = t.tableName;
            tableConnections.set(shortName, new Set());
            outgoingFKCount.set(shortName, 0);
            incomingFKCount.set(shortName, 0);
        });

        // Build connections from relationships
        relationships.forEach(rel => {
            const fromShort = rel.fromTable.includes('.') ? rel.fromTable.split('.').pop()! : rel.fromTable;
            const toShort = rel.toTable.includes('.') ? rel.toTable.split('.').pop()! : rel.toTable;

            if (tableConnections.has(fromShort)) {
                tableConnections.get(fromShort)!.add(toShort);
                outgoingFKCount.set(fromShort, (outgoingFKCount.get(fromShort) || 0) + 1);
            }
            if (tableConnections.has(toShort)) {
                tableConnections.get(toShort)!.add(fromShort);
                incomingFKCount.set(toShort, (incomingFKCount.get(toShort) || 0) + 1);
            }
        });

        // Categorize tables: FACT tables have outgoing FKs, DIMENSION tables have incoming FKs
        const factTables: TableNode[] = [];
        const dimensionTables: TableNode[] = [];
        const orphanTables: TableNode[] = [];

        tables.forEach(t => {
            const outgoing = outgoingFKCount.get(t.tableName) || 0;
            const connections = tableConnections.get(t.tableName)?.size || 0;

            if (connections === 0) {
                orphanTables.push(t);
            } else if (outgoing > 0) {
                factTables.push(t);
            } else {
                dimensionTables.push(t);
            }
        });

        // Sort fact tables by number of connections (most connected first)
        factTables.sort((a, b) => {
            const connA = outgoingFKCount.get(a.tableName) || 0;
            const connB = outgoingFKCount.get(b.tableName) || 0;
            return connB - connA;
        });

        // Position calculation - Star Schema Layout
        const positions: Map<string, { x: number; y: number }> = new Map();
        const occupiedCells: Set<string> = new Set(); // Track occupied grid cells

        const TableWidth = 260;
        const TableHeight = 240;
        const HGap = 50;
        const VGap = 40;
        const ColWidth = TableWidth + HGap;
        const RowHeight = TableHeight + VGap;

        // Helper to track cell occupancy
        const cellKey = (col: number, row: number) => `${col},${row}`;
        const occupyCell = (col: number, row: number) => occupiedCells.add(cellKey(col, row));
        const isCellOccupied = (col: number, row: number) => occupiedCells.has(cellKey(col, row));

        // Find first available cell in a column
        const findFreeRowInColumn = (col: number, startRow: number = 0): number => {
            let row = startRow;
            while (isCellOccupied(col, row)) {
                row++;
            }
            return row;
        };

        // Layout: 3-column structure
        // Column 0: Left dimensions
        // Column 1: Fact tables (center)
        // Column 2: Right dimensions

        const LEFT_COL = 0;
        const CENTER_COL = 1;
        const RIGHT_COL = 2;

        const colX = (col: number) => 20 + col * ColWidth;
        const rowY = (row: number) => 20 + row * RowHeight;

        // 1. Place fact tables in center column
        factTables.forEach((table) => {
            const row = findFreeRowInColumn(CENTER_COL);
            occupyCell(CENTER_COL, row);
            positions.set(table.tableName, { x: colX(CENTER_COL), y: rowY(row) });
        });

        // 2. Place dimensions around their connected facts
        // Group dimensions by which fact they connect to
        const factConnectedDims: Map<string, TableNode[]> = new Map();
        const unconnectedDims: TableNode[] = [];

        dimensionTables.forEach(dim => {
            const connections = tableConnections.get(dim.tableName) || new Set();
            let connectedFact: string | null = null;

            for (const conn of connections) {
                if (factTables.some(f => f.tableName === conn)) {
                    connectedFact = conn;
                    break;
                }
            }

            if (connectedFact) {
                if (!factConnectedDims.has(connectedFact)) {
                    factConnectedDims.set(connectedFact, []);
                }
                factConnectedDims.get(connectedFact)!.push(dim);
            } else {
                unconnectedDims.push(dim);
            }
        });

        // Place dimensions alternating left/right near their fact tables
        factConnectedDims.forEach((dims, factName) => {
            const factPos = positions.get(factName);
            if (!factPos) return;

            // Find which row the fact is in
            const factRow = Math.round((factPos.y - 20) / RowHeight);

            dims.forEach((dim, idx) => {
                // Alternate between left and right columns
                const targetCol = idx % 2 === 0 ? LEFT_COL : RIGHT_COL;

                // Try to place near the fact's row first
                let targetRow = factRow + Math.floor(idx / 2);

                // Find first available cell starting from target row
                while (isCellOccupied(targetCol, targetRow)) {
                    targetRow++;
                }

                occupyCell(targetCol, targetRow);
                positions.set(dim.tableName, { x: colX(targetCol), y: rowY(targetRow) });
            });
        });

        // 3. Place unconnected dimensions in available spots
        unconnectedDims.forEach(dim => {
            // Try left column first, then right
            let placed = false;
            for (const col of [LEFT_COL, RIGHT_COL]) {
                const row = findFreeRowInColumn(col);
                if (!placed) {
                    occupyCell(col, row);
                    positions.set(dim.tableName, { x: colX(col), y: rowY(row) });
                    placed = true;
                }
            }
        });

        // 4. Place orphan tables in a fourth column or below
        if (orphanTables.length > 0) {
            const ORPHAN_COL = 3; // Far right column for orphans
            orphanTables.forEach((table, idx) => {
                const row = idx;
                positions.set(table.tableName, { x: colX(ORPHAN_COL), y: rowY(row) });
            });
        }

        // Generate HTML with calculated positions
        return tables
            .map((table) => {
                const pos = positions.get(table.tableName) || { x: 20, y: 20 };

                const columnsHtml = table.columns
                    .slice(0, 10)
                    .map(column => {
                        const icons = [];
                        if (column.isPrimaryKey) icons.push('🔑');
                        if (column.isForeignKey) icons.push('🔗');
                        const iconStr = icons.length > 0 ? `<span class="col-icons">${icons.join('')}</span>` : '';

                        const classes = ['table-column'];
                        if (column.isPrimaryKey) classes.push('pk');
                        if (column.isForeignKey) classes.push('fk');

                        return `
                    <div class="${classes.join(' ')}" data-col="${column.name}">
                        ${iconStr}
                        <span class="col-name">${column.name}</span>
                        <span class="col-type">${column.dataType}</span>
                    </div>
                `;
                    })
                    .join('');

                const moreColumns =
                    table.columns.length > 10
                        ? `<div class="more-columns">... and ${table.columns.length - 10} more</div>`
                        : '';

                return `
                <div class="table-box" id="table-${table.tableName}" 
                     data-table="${table.fullName}"
                     style="left: ${pos.x}px; top: ${pos.y}px;">
                    <div class="table-header">${table.tableName}</div>
                    <div class="table-columns">
                        ${columnsHtml}
                        ${moreColumns}
                    </div>
                </div>
            `;
            })
            .join('');
    }

    private _getScript(erdData: ERDData): string {
        return `
            (function() {
                const relationships = ${JSON.stringify(erdData.relationships)};
                const canvas = document.getElementById('erdCanvas');
                const svg = document.getElementById('relationshipsSvg');
                
                function getTableBox(el) {
                    const left = parseInt(el.style.left) || 0;
                    const top = parseInt(el.style.top) || 0;
                    const width = el.offsetWidth;
                    const height = el.offsetHeight;
                    return {
                        left: left,
                        top: top,
                        right: left + width,
                        bottom: top + height,
                        centerX: left + width / 2,
                        centerY: top + height / 2
                    };
                }

                function getColumnPosition(tableEl, columnName) {
                    // Try to find exact column
                    let colEl = tableEl.querySelector('.table-column[data-col="' + columnName + '"]');
                    
                    // If not found (hidden by "more columns"), try to estimate or return center
                    if (!colEl) return null;

                    // Calculate position relative to the table box
                    const tableRect = tableEl.getBoundingClientRect();
                    const colRect = colEl.getBoundingClientRect();
                    const canvasRect = canvas.getBoundingClientRect();

                    // Relative Y from canvas top
                    // We can't just subtract rects if the canvas is scrolled, but here we want SVG coords (absolute in canvas)
                    // The table.style.top is relative to canvas.
                    // The column offset within table is colRect.top - tableRect.top
                    // So Y = table.style.top + (colRect.top - tableRect.top) + colHeight/2
                    
                    const relativeTop = colRect.top - tableRect.top;
                    const centerY = relativeTop + colRect.height / 2;
                    
                    // We need to account for table scroll position if any?
                    // getBoundingClientRect takes visual position, so it accounts for scroll.
                    
                    const tableStyleTop = parseInt(tableEl.style.top) || 0;
                    
                    return tableStyleTop + centerY;
                }
                
                function drawRelationships() {
                    svg.innerHTML = '';
                    
                    // Update SVG size
                    let maxX = 1200, maxY = 600;
                    document.querySelectorAll('.table-box').forEach(el => {
                        const box = getTableBox(el);
                        maxX = Math.max(maxX, box.right + 50);
                        maxY = Math.max(maxY, box.bottom + 50);
                    });
                    
                    svg.setAttribute('width', maxX);
                    svg.setAttribute('height', maxY);
                    svg.style.width = maxX + 'px';
                    svg.style.height = maxY + 'px';
                    
                    // Defs
                    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
                    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
                    marker.setAttribute('id', 'arrowhead');
                    marker.setAttribute('markerWidth', '10');
                    marker.setAttribute('markerHeight', '7');
                    marker.setAttribute('refX', '10');
                    marker.setAttribute('refY', '3.5');
                    marker.setAttribute('orient', 'auto');
                    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
                    polygon.setAttribute('points', '0 0, 10 3.5, 0 7');
                    polygon.setAttribute('fill', '#3794ff');
                    marker.appendChild(polygon);
                    defs.appendChild(marker);
                    svg.appendChild(defs);
                    
                    relationships.forEach((rel, index) => {
                        const childTableName = rel.fromTable.split('.')[1];
                        const parentTableName = rel.toTable.split('.')[1];
                        
                        const childEl = document.getElementById('table-' + childTableName);
                        const parentEl = document.getElementById('table-' + parentTableName);
                        
                        if (!childEl || !parentEl) return;
                        
                        const childBox = getTableBox(childEl);
                        const parentBox = getTableBox(parentEl);
                        
                        // Determine L/R relationship
                        // If Parent is to the right of Child: Child Right -> Parent Left
                        const parentIsRight = parentBox.centerX > childBox.centerX;
                        
                        let fromX, fromY, toX, toY;
                        let fromControlX, toControlX;
                        
                        // Default Y to center if col not found
                        fromY = childBox.centerY;
                        toY = parentBox.centerY;
                        
                        // Try get specific column Y
                        const colY1 = getColumnPosition(childEl, rel.fromColumns[0]);
                        const colY2 = getColumnPosition(parentEl, rel.toColumns[0]);
                        
                        if (colY1 !== null) fromY = colY1;
                        if (colY2 !== null) toY = colY2;
                        
                        if (parentIsRight) {
                            fromX = childBox.right;
                            toX = parentBox.left;
                            fromControlX = fromX + 50;
                            toControlX = toX - 50;
                        } else {
                            fromX = childBox.left;
                            toX = parentBox.right;
                            fromControlX = fromX - 50;
                            toControlX = toX + 50;
                        }
                        
                        // Calculate Bezier curve
                        // M start C c1 c2 end
                        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                        
                        // Adjust constraints for multiple lines?
                        // Simple cubic bezier is best for side-to-side
                        const d = \`M \${fromX} \${fromY} C \${fromControlX} \${fromY}, \${toControlX} \${toY}, \${toX} \${toY}\`;
                        
                        path.setAttribute('d', d);
                        path.setAttribute('stroke', '#3794ff');
                        path.setAttribute('stroke-width', '2');
                        path.setAttribute('fill', 'none');
                        path.setAttribute('marker-end', 'url(#arrowhead)');
                        path.setAttribute('class', 'relationship-line');
                        
                        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
                        title.textContent = rel.constraintName + ': ' + 
                            childTableName + '.' + rel.fromColumns.join(',') + ' -> ' + 
                            parentTableName + '.' + rel.toColumns.join(',');
                        path.appendChild(title);
                        
                        svg.appendChild(path);
                    });
                }
                
                // Dragging Logic
                let dragging = null;
                let dragStartX = 0, dragStartY = 0;
                let elemStartLeft = 0, elemStartTop = 0;
                
                document.querySelectorAll('.table-box').forEach(table => {
                    const header = table.querySelector('.table-header');
                    if (header) {
                        header.addEventListener('mousedown', function(e) {
                            e.preventDefault();
                            dragging = table;
                            dragStartX = e.pageX;
                            dragStartY = e.pageY;
                            elemStartLeft = parseInt(table.style.left) || 0;
                            elemStartTop = parseInt(table.style.top) || 0;
                            table.style.zIndex = '1000';
                            document.body.style.cursor = 'grabbing';
                        });
                    }
                });
                
                document.addEventListener('mousemove', function(e) {
                    if (!dragging) return;
                    const dx = e.pageX - dragStartX;
                    const dy = e.pageY - dragStartY;
                    dragging.style.left = Math.max(0, elemStartLeft + dx) + 'px';
                    dragging.style.top = Math.max(0, elemStartTop + dy) + 'px';
                    drawRelationships();
                });
                
                document.addEventListener('mouseup', function() {
                    if (dragging) {
                        dragging.style.zIndex = '';
                        document.body.style.cursor = '';
                        dragging = null;
                    }
                });
                
                requestAnimationFrame(() => setTimeout(drawRelationships, 50));
                window.addEventListener('resize', drawRelationships);
            })();
        `;
    }

    private _getStyles(): string {
        return `
            :root {
                --bg-color: var(--vscode-editor-background);
                --fg-color: var(--vscode-editor-foreground);
                --border-color: var(--vscode-widget-border);
                --header-bg: var(--vscode-sideBarSectionHeader-background);
                --table-bg: var(--vscode-editorWidget-background);
                --pk-color: #f1c40f;
                --fk-color: #3498db;
            }

            body {
                font-family: var(--vscode-font-family);
                font-size: var(--vscode-font-size);
                color: var(--fg-color);
                background-color: var(--bg-color);
                margin: 0;
                padding: 20px;
            }

            .header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 15px;
                padding-bottom: 10px;
                border-bottom: 1px solid var(--border-color);
            }

            .header h1 {
                margin: 0;
                font-size: 1.4em;
            }

            .header-info {
                display: flex;
                gap: 15px;
                align-items: center;
            }

            .badge {
                background-color: var(--vscode-badge-background);
                color: var(--vscode-badge-foreground);
                padding: 4px 10px;
                border-radius: 12px;
                font-size: 0.9em;
            }

            .stat {
                color: var(--vscode-descriptionForeground);
                font-size: 0.9em;
            }

            .legend {
                display: flex;
                gap: 20px;
                margin-bottom: 15px;
                font-size: 0.9em;
            }

            .legend-item {
                display: flex;
                align-items: center;
                gap: 5px;
            }

            .no-relationships {
                background-color: rgba(255, 193, 7, 0.2);
                padding: 15px;
                border-radius: 6px;
                margin-bottom: 15px;
            }

            .no-relationships p {
                margin: 5px 0;
            }

            .erd-container {
                background-color: var(--header-bg);
                border: 1px solid var(--border-color);
                border-radius: 6px;
                overflow: auto;
                margin-bottom: 20px;
                min-height: 400px;
            }

            .erd-canvas {
                position: relative;
                min-width: 1200px;
                min-height: 600px;
            }

            .relationships-svg {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
            }

            .relationship-line {
                pointer-events: stroke;
            }

            .relationship-line:hover {
                stroke-width: 3;
            }

            .table-box {
                position: absolute;
                width: 250px;
                background-color: var(--table-bg);
                border: 2px solid var(--border-color);
                border-radius: 6px;
                overflow: hidden;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
            }

            .table-header {
                background-color: var(--vscode-textLink-foreground);
                color: white;
                padding: 8px 12px;
                font-weight: bold;
                cursor: move;
                font-size: 0.95em;
            }

            .table-columns {
                max-height: 200px;
                overflow-y: auto;
            }

            .table-column {
                display: flex;
                align-items: center;
                padding: 4px 10px;
                border-bottom: 1px solid var(--border-color);
                font-size: 0.85em;
                gap: 6px;
            }

            .table-column:last-child {
                border-bottom: none;
            }

            .table-column.pk {
                background-color: rgba(241, 196, 15, 0.1);
            }

            .table-column.fk {
                background-color: rgba(52, 152, 219, 0.1);
            }

            .col-icons {
                font-size: 0.8em;
            }

            .col-name {
                flex: 1;
                font-weight: 500;
            }

            .col-type {
                color: var(--vscode-descriptionForeground);
                font-size: 0.85em;
            }

            .more-columns {
                padding: 6px 10px;
                color: var(--vscode-descriptionForeground);
                font-style: italic;
                font-size: 0.85em;
            }

            .relationships-table {
                margin-top: 20px;
            }

            .relationships-table h2 {
                font-size: 1.1em;
                margin-bottom: 10px;
            }

            table {
                width: 100%;
                border-collapse: collapse;
            }

            th, td {
                padding: 10px;
                text-align: left;
                border: 1px solid var(--border-color);
            }

            th {
                background-color: var(--header-bg);
                font-weight: 600;
            }

            code {
                font-family: var(--vscode-editor-font-family);
                background-color: var(--vscode-textCodeBlock-background);
                padding: 2px 6px;
                border-radius: 3px;
            }
        `;
    }
}
