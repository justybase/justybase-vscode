import { getGlobalDragState, setGlobalDragState } from '../state.js';
import '../export.js';

function dispatch(target: EventTarget, type: string): void {
    target.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
}

/** The reveal runs on a later tick because a synchronous layout change cancels the drag. */
function flushRevealTimer(): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
}

function idleDragState(): void {
    setGlobalDragState({ isDragging: false, dragType: null, draggedItem: null });
}

function startColumnDrag(): void {
    setGlobalDragState({ isDragging: true, dragType: 'column', draggedItem: '0' });
    dispatch(document.body, 'dragstart');
}

describe('grouping reveal during a column drag', () => {
    beforeEach(() => {
        document.body.className = '';
        document.body.innerHTML = ''
            + '<div id="groupingPanel" class="grouping-panel">'
            + '<div class="group-chip" data-col-id="0"><span class="remove-group">×</span></div>'
            + '</div>'
            + '<div id="sidebarGroupDropZone"></div>';
        idleDragState();
    });

    test('reveals the grouping panel for a column drag', async () => {
        startColumnDrag();
        await flushRevealTimer();

        expect(document.body.classList.contains('group-dragging')).toBe(true);
    });

    test('does not reveal the panel for drags that cannot be grouped', async () => {
        setGlobalDragState({ isDragging: true, dragType: 'text', draggedItem: null });
        dispatch(document.body, 'dragstart');
        await flushRevealTimer();

        expect(document.body.classList.contains('group-dragging')).toBe(false);
    });

    test('a drag that ends before the deferred reveal does not leave a stuck panel', async () => {
        startColumnDrag();
        dispatch(document.body, 'dragend');
        await flushRevealTimer();

        expect(document.body.classList.contains('group-dragging')).toBe(false);
        expect(getGlobalDragState().isDragging).toBe(false);
    });

    test('a drop that stops propagation still hides the reveal', async () => {
        startColumnDrag();
        await flushRevealTimer();
        expect(document.body.classList.contains('group-dragging')).toBe(true);

        const chip = document.querySelector('.group-chip') as HTMLElement;
        chip.addEventListener('drop', (event) => event.stopPropagation());
        dispatch(chip, 'drop');

        expect(document.body.classList.contains('group-dragging')).toBe(false);
    });

    test('a new press reaps a reveal left behind by a missed dragend', () => {
        // A drag source re-rendered mid-drag never fires dragend, so both the body class and
        // the drag state can survive after the grouping columns are gone.
        setGlobalDragState({ isDragging: true, dragType: 'groupChip', draggedItem: '0' });
        document.body.classList.add('group-dragging');
        expect(document.body.classList.contains('group-dragging')).toBe(true);

        dispatch(document.body, 'pointerdown');

        expect(document.body.classList.contains('group-dragging')).toBe(false);
        expect(getGlobalDragState().isDragging).toBe(false);
    });
});
