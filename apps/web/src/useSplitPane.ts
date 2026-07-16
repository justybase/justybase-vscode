import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Hook for draggable split pane resizing.
 * Returns the size (in px for horizontal, ratio 0-1 for vertical) and drag handlers.
 */
export function useSplitPane(
  direction: 'horizontal' | 'vertical',
  initial: number,
  min: number,
  max: number,
): {
  size: number;
  setSize: (v: number) => void;
  onMouseDown: (e: React.MouseEvent) => void;
  containerRef: React.RefObject<HTMLDivElement | null>;
} {
  const [size, setSize] = useState(initial);
  const dragging = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
  }, [direction]);

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      let next: number;
      if (direction === 'horizontal') {
        next = e.clientX - rect.left;
      } else {
        const ratio = (e.clientY - rect.top) / rect.height;
        next = Math.round(ratio * 100);
      }
      setSize(Math.max(min, Math.min(max, next)));
    }

    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      dragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [direction, min, max]);

  return { size, setSize, onMouseDown, containerRef };
}
