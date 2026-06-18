import { useCallback, useState } from 'react';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readStoredNumber(key, fallback, min, max) {
  const raw = Number(localStorage.getItem(key));
  if (!Number.isFinite(raw) || raw <= 0) return fallback;
  return clamp(raw, min, max);
}

export function usePersistentPanelSize(key, { defaultValue, min, max }) {
  const [size, setSize] = useState(() => readStoredNumber(key, defaultValue, min, max));

  const setPersistentSize = useCallback((value) => {
    const next = Math.round(clamp(value, min, max));
    setSize(next);
    localStorage.setItem(key, String(next));
    return next;
  }, [key, min, max]);

  const beginResize = useCallback((event, { axis = 'x', invert = false } = {}) => {
    event.preventDefault();
    const startPointer = axis === 'y' ? event.clientY : event.clientX;
    const startSize = size;
    const target = event.currentTarget;
    target?.classList?.add('dragging');
    document.body.classList.add('lw-resizing');

    const onMove = (moveEvent) => {
      const pointer = axis === 'y' ? moveEvent.clientY : moveEvent.clientX;
      const delta = (pointer - startPointer) * (invert ? -1 : 1);
      setPersistentSize(startSize + delta);
    };

    const onUp = () => {
      target?.classList?.remove('dragging');
      document.body.classList.remove('lw-resizing');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [setPersistentSize, size]);

  return [size, setPersistentSize, beginResize];
}
