import { resetGrids, getAllGrids, getActiveGridIndex, addGrid } from '../state.js';
import { validateRequiredLibraries } from '../utils.js';
import { getActiveSourceUri, getResultPanelWindow, getResultSets } from '../types.js';
import { beginGridInit } from './sizing.js';
import {
    renderStateCard,
    syncGlobalFilterInput,
    updateControlsVisibility,
    createLogConsole,
    createErrorView,
    createTextContentView,
} from './alternateViews.js';
import { createResultSetGrid } from './tableBuilder.js';

export function renderGrids() {
    const container = document.getElementById('gridContainer');
    if (!container) return;

    // Clear pools of all existing grids before creating new ones
    const existingGrids = getAllGrids();
    existingGrids.forEach(grid => {
        if (grid?.dispose) {
            grid.dispose();
        } else if (grid?.destroyVirtualizer) {
            grid.destroyVirtualizer();
        } else if (grid?.clearPool) {
            grid.clearPool();
        }
    });

    container.innerHTML = '';
    resetGrids();
    beginGridInit();

    if (!getResultSets() || getResultSets().length === 0) {
        renderStateCard(container, getActiveSourceUri()
            ? {
                title: 'No Results Yet',
                description: 'This SQL source is active, but the panel does not have buffered tabular results for it yet.',
                hint: 'Run a query for this tab, wait for streaming to finish, or switch to another source with retained results.'
            }
            : {
                title: 'No Active Results',
                description: 'The result panel is ready, but there is no active SQL source selected.',
                hint: 'Run a query or switch to an open SQL tab to populate this view.'
            });
        syncGlobalFilterInput();
        return;
    }

    const libs = validateRequiredLibraries();
    if (!libs) return;

    const { createTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, getGroupedRowModel, getExpandedRowModel } = libs.TableCore;

    getResultSets().forEach((rs, index) => {
        if (!rs) {
            addGrid(null);
            return;
        }
        try {
            if (rs.isLog) {
                createLogConsole(rs, index, container);
            } else if (rs.isError) {
                createErrorView(rs, index, container);
            } else if (rs.isTextContent) {
                createTextContentView(rs, index, container);
            } else {
                createResultSetGrid(rs, index, container, createTable, getCoreRowModel, getSortedRowModel, getFilteredRowModel, getGroupedRowModel, getExpandedRowModel);
            }
        } catch (e: unknown) {
            console.error(`Error rendering grid ${index}:`, e);
            const wrapper = document.createElement('div');
            wrapper.style.padding = '20px';
            wrapper.style.color = 'red';
            const message = e instanceof Error ? e.message : String(e);
            wrapper.textContent = `Error rendering result set ${index + 1}: ${message}`;
            container.appendChild(wrapper);
            addGrid(null);
        }
    });

    updateControlsVisibility(getActiveGridIndex());
    syncGlobalFilterInput(getActiveGridIndex());

    if (document.body.classList.contains('sidebar-layout')) {
        getResultPanelWindow().renderSidebarSchema?.();
    }
}
