import { attachColumnDragAutoScroll, computeEdgeScrollDelta } from '../grid/dragAutoScroll';
import { getGlobalDragState } from '../state';

jest.mock('../state', () => ({ getGlobalDragState: jest.fn() }));

const dragState = getGlobalDragState as jest.Mock;

describe('computeEdgeScrollDelta', () => {
    const viewport = { left: 100, right: 500 };

    test('does not scroll away from the edges', () => {
        expect(computeEdgeScrollDelta(300, viewport)).toBe(0);
    });

    test('scrolls left inside the left edge zone, speed grows toward the edge and is capped', () => {
        // left zone starts at 140; depth 20 -> 10px
        expect(computeEdgeScrollDelta(120, viewport)).toBe(-10);
        expect(computeEdgeScrollDelta(-1000, viewport)).toBe(-25);
    });

    test('scrolls right inside the right edge zone, speed grows toward the edge and is capped', () => {
        // right zone starts at 460; depth 20 -> 10px
        expect(computeEdgeScrollDelta(480, viewport)).toBe(10);
        expect(computeEdgeScrollDelta(5000, viewport)).toBe(25);
    });

    test('measures the left zone from the visible viewport, so pointer over sticky cells still scrolls', () => {
        expect(computeEdgeScrollDelta(90, viewport)).toBe(-25);
    });
});

describe('attachColumnDragAutoScroll', () => {
    let wrapper: HTMLDivElement;
    let frameQueue: Map<number, FrameRequestCallback>;
    let nextFrameId: number;
    let nowSpy: jest.SpyInstance<number, []>;

    function flushFrames(): void {
        const pending = [...frameQueue.entries()];
        frameQueue.clear();
        pending.forEach(([, callback]) => callback(0));
    }

    function dragOver(clientX: number): void {
        wrapper.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientX }));
    }

    beforeEach(() => {
        frameQueue = new Map();
        nextFrameId = 1;
        dragState.mockReturnValue({ isDragging: true, dragType: 'column', draggedItem: 'col-1' });
        jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            const id = nextFrameId++;
            frameQueue.set(id, callback);
            return id;
        });
        jest.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
            frameQueue.delete(id);
        });
        nowSpy = jest.spyOn(performance, 'now').mockReturnValue(0);

        wrapper = document.createElement('div');
        document.body.appendChild(wrapper);
        Object.defineProperty(wrapper, 'clientWidth', { value: 300, configurable: true });
        wrapper.getBoundingClientRect = () => ({
            left: 0, right: 300, top: 0, bottom: 100, width: 300, height: 100, x: 0, y: 0, toJSON: () => ({}),
        }) as DOMRect;
        wrapper.scrollBy = jest.fn() as unknown as typeof wrapper.scrollBy;
        attachColumnDragAutoScroll(wrapper);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        wrapper.remove();
    });

    test('scrolls the grid right while a column header is dragged near the right edge', () => {
        dragOver(290);
        expect(frameQueue.size).toBe(1);

        flushFrames();

        // right zone starts at 260; depth 30 -> 15px
        expect(wrapper.scrollBy).toHaveBeenCalledWith(15, 0);
        expect(frameQueue.size).toBe(1);
    });

    test('scrolls the grid left while a column header is dragged near the left edge', () => {
        dragOver(10);
        flushFrames();

        // left zone ends at 40; depth 30 -> -15px
        expect(wrapper.scrollBy).toHaveBeenCalledWith(-15, 0);
    });

    test('does not scroll for drags that are not column header drags', () => {
        dragState.mockReturnValue({ isDragging: true, dragType: 'group', draggedItem: null });

        dragOver(290);

        expect(frameQueue.size).toBe(0);
        expect(wrapper.scrollBy).not.toHaveBeenCalled();
    });

    test('does not scroll when the pointer stays in the middle of the grid', () => {
        dragOver(150);

        expect(frameQueue.size).toBe(0);
        expect(wrapper.scrollBy).not.toHaveBeenCalled();
    });

    test('stops scrolling when the drag ends', () => {
        dragOver(290);
        dragState.mockReturnValue({ isDragging: false, dragType: null, draggedItem: null });

        flushFrames();

        expect(wrapper.scrollBy).not.toHaveBeenCalled();
        expect(frameQueue.size).toBe(0);
    });

    test('scrolls when dragover lands on a grouping drop zone that covers the grid', () => {
        const groupingZone = document.createElement('div');
        document.body.appendChild(groupingZone);

        groupingZone.dispatchEvent(new MouseEvent('dragover', { bubbles: true, clientX: 290 }));
        flushFrames();

        expect(wrapper.scrollBy).toHaveBeenCalledWith(15, 0);
        groupingZone.remove();
    });

    test('ignores pointers outside the horizontal extent of the grid', () => {
        dragOver(-50);

        expect(frameQueue.size).toBe(0);
        expect(wrapper.scrollBy).not.toHaveBeenCalled();
    });

    test('keeps scrolling while a resting pointer still produces periodic dragover events', () => {
        dragOver(290);
        flushFrames();
        nowSpy.mockReturnValue(350);
        dragOver(290);
        flushFrames();

        expect(wrapper.scrollBy).toHaveBeenCalledTimes(2);
    });

    test('stops scrolling when dragover events go stale, e.g. the pointer left the grid', () => {
        dragOver(290);
        nowSpy.mockReturnValue(600);

        flushFrames();

        expect(wrapper.scrollBy).not.toHaveBeenCalled();
    });
});
