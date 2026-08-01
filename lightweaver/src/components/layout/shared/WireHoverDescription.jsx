import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const GAP = 6;
const MARGIN = 8;

export function WireHoverDescription({ children, ...props }) {
  const rootRef = useRef(null);
  const targetRef = useRef(null);
  const nativeTitleRef = useRef(null);
  const tooltipRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);
  const [position, setPosition] = useState(null);

  const restoreNativeTitle = useCallback(() => {
    const saved = nativeTitleRef.current;
    if (!saved) return;
    if (saved.hadTitle) saved.target.setAttribute('title', saved.title);
    else saved.target.removeAttribute('title');
    nativeTitleRef.current = null;
  }, []);

  const hide = useCallback(() => {
    restoreNativeTitle();
    targetRef.current = null;
    setTooltip(null);
    setPosition(null);
  }, [restoreNativeTitle]);

  const show = useCallback((target) => {
    const text = target.dataset.tooltip;
    if (!text) return;
    if (targetRef.current === target) return;
    if (targetRef.current !== target) restoreNativeTitle();
    const hadTitle = target.hasAttribute('title');
    nativeTitleRef.current = { target, hadTitle, title: target.getAttribute('title') };
    target.removeAttribute('title');
    targetRef.current = target;
    setPosition(null);
    setTooltip(text);
  }, [restoreNativeTitle]);

  const placeTooltip = useCallback(() => {
    const target = targetRef.current;
    const element = tooltipRef.current;
    if (!target || !element || !document.contains(target)) return hide();
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = element.getBoundingClientRect();
    const maxLeft = Math.max(MARGIN, window.innerWidth - tooltipRect.width - MARGIN);
    const maxTop = Math.max(MARGIN, window.innerHeight - tooltipRect.height - MARGIN);
    const left = Math.min(maxLeft, Math.max(MARGIN, targetRect.left + (targetRect.width - tooltipRect.width) / 2));
    const above = targetRect.top - GAP - tooltipRect.height;
    const top = above >= MARGIN
      ? above
      : Math.min(maxTop, Math.max(MARGIN, targetRect.bottom + GAP));
    setPosition({ left, top });
  }, [hide]);

  useLayoutEffect(() => {
    if (!tooltip) return undefined;
    placeTooltip();
    const update = () => placeTooltip();
    window.addEventListener('resize', update);
    document.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [placeTooltip, tooltip]);

  useLayoutEffect(() => () => restoreNativeTitle(), [restoreNativeTitle]);

  const targetFor = (node) => node instanceof Element ? node.closest('[data-tooltip]') : null;
  const isInScope = (target) => Boolean(target && rootRef.current?.contains(target));
  const handleMouseOver = (event) => {
    const target = targetFor(event.target);
    if (!isInScope(target) || target.contains(event.relatedTarget)) return;
    show(target);
  };
  const handleMouseOut = (event) => {
    const target = targetFor(event.target);
    if (!isInScope(target) || target.contains(event.relatedTarget)) return;
    if (targetRef.current === target) hide();
  };

  return (
    <>
      <div ref={rootRef} {...props} onMouseOver={handleMouseOver} onMouseOut={handleMouseOut}>{children}</div>
      {tooltip && createPortal(
        <div ref={tooltipRef} className="lw-wire-hover-tooltip" role="tooltip" style={position ? { left: `${position.left}px`, top: `${position.top}px` } : { left: '-9999px', top: '-9999px', visibility: 'hidden' }}>{tooltip}</div>,
        document.body,
      )}
    </>
  );
}
