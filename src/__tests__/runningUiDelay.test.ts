import {
    RUNNING_UI_DELAY_MS,
    markRunningUiPending,
    resetRunningUiDelay,
    scheduleRunningUiRefresh,
    shouldDeferRunningUi,
    subscribeRunningUiRefresh,
} from '../../media/resultPanel/runningUiDelay.js';

describe('runningUiDelay', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        resetRunningUiDelay();
    });

    afterEach(() => {
        jest.useRealTimers();
        resetRunningUiDelay();
    });

    it('defers running banner until the delay elapses', () => {
        const source = 'file:///query.sql';
        markRunningUiPending(source);
        expect(shouldDeferRunningUi()).toBe(true);

        jest.advanceTimersByTime(RUNNING_UI_DELAY_MS);
        expect(shouldDeferRunningUi()).toBe(false);
    });

    it('notifies subscribers after the delay', () => {
        const listener = jest.fn();
        subscribeRunningUiRefresh(listener);

        markRunningUiPending('file:///query.sql');
        scheduleRunningUiRefresh();

        expect(listener).not.toHaveBeenCalled();
        jest.advanceTimersByTime(RUNNING_UI_DELAY_MS);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('clears pending state on reset', () => {
        markRunningUiPending('file:///query.sql');
        resetRunningUiDelay();
        expect(shouldDeferRunningUi()).toBe(false);
    });
});

export {};
