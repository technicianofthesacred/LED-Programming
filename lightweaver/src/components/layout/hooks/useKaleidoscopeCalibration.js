import { useEffect, useMemo, useRef, useState } from 'react';
import { deriveReflectionPointIndices } from '../../../lib/kaleidoscope.js';
import {
  buildKaleidoscopeCalibrationFrame,
  createKaleidoscopeCalibrationSession,
} from '../../../lib/kaleidoscopeCalibration.js';

export function useKaleidoscopeCalibration({
  editor,
  strips,
  compiledWiring,
  connected,
  host,
  selectedStripId,
  layoutMode,
} = {}) {
  const sessionRef = useRef(null);
  const ownerRef = useRef(null);
  const transitionRef = useRef(Promise.resolve());
  const frameRef = useRef([]);
  const [delivery, setDelivery] = useState({ sessionActive: false, physicalDelivered: false, error: null });
  const strip = strips.find(item => item.id === editor?.stripId);
  const active = Boolean(
    strip?.kaleidoscope
    && strip.id === selectedStripId
    && layoutMode === 'draw'
    && (editor?.mode === 'pick' || editor?.mode === 'fine'),
  );
  const physicalGeometryKey = useMemo(() => JSON.stringify(
    (compiledWiring?.pixels || []).map(pixel => [
      pixel?.outputId ?? null,
      pixel?.stripId ?? null,
      pixel?.sourceLed ?? null,
      Boolean(pixel?.inactive),
    ]),
  ), [compiledWiring]);
  const pointIndices = useMemo(
    () => strip?.kaleidoscope ? deriveReflectionPointIndices(strip.kaleidoscope, strip.pixelCount) : [],
    [strip?.kaleidoscope, strip?.pixelCount],
  );

  useEffect(() => {
    frameRef.current = buildKaleidoscopeCalibrationFrame({
      compiledWiring,
      stripId: strip?.id,
      pointIndices,
      selectedPointIndex: editor?.selectedPointIndex,
      pulse: 0,
    });
    if (sessionRef.current && !sessionRef.current.push(frameRef.current)) {
      setDelivery(current => ({
        ...current,
        physicalDelivered: false,
        error: new Error('Physical calibration frame push was not accepted.'),
      }));
    }
  }, [compiledWiring, strip?.id, pointIndices, editor?.selectedPointIndex]);

  useEffect(() => {
    if (!active || !connected || !host || !compiledWiring?.pixels?.length) {
      setDelivery({
        sessionActive: false,
        physicalDelivered: false,
        error: active ? new Error('Physical preview unavailable') : null,
      });
      return undefined;
    }
    let disposed = false;
    let ownedSession = null;
    transitionRef.current = transitionRef.current.then(async () => {
      if (disposed) return;
      const session = createKaleidoscopeCalibrationSession({
        host,
        fps: 18,
        onStateChange: status => {
          if (!disposed) setDelivery({
            sessionActive: status.active,
            physicalDelivered: status.physicalDelivered === true,
            error: status.error || null,
          });
        },
      });
      ownedSession = session;
      ownerRef.current = session;
      sessionRef.current = session;
      try {
        await session.start(frameRef.current);
      } catch (error) {
        if (!disposed) setDelivery({ sessionActive: false, physicalDelivered: false, error });
      }
    });
    return () => {
      disposed = true;
      transitionRef.current = transitionRef.current.then(async () => {
        if (!ownedSession || ownerRef.current !== ownedSession) return;
        ownerRef.current = null;
        if (sessionRef.current === ownedSession) sessionRef.current = null;
        await ownedSession.stop('layout-exit').catch(() => {});
      });
    };
  }, [active, connected, host, physicalGeometryKey, strip?.id]);

  useEffect(() => {
    if (!active || !delivery.sessionActive) return undefined;
    const startedAt = performance.now();
    const timer = window.setInterval(() => {
      const pulse = (Math.sin((performance.now() - startedAt) / 260) + 1) / 2;
      sessionRef.current?.push(buildKaleidoscopeCalibrationFrame({
        compiledWiring,
        stripId: strip?.id,
        pointIndices,
        selectedPointIndex: editor?.selectedPointIndex,
        pulse,
      }));
    }, 1000 / 18);
    return () => window.clearInterval(timer);
  }, [active, delivery.sessionActive, editor?.mode, editor?.selectedPointIndex, compiledWiring, strip?.id, pointIndices]);

  return {
    active,
    canvasUpdated: Boolean(strip?.kaleidoscope),
    physicalDelivered: delivery.physicalDelivered,
    error: delivery.error,
    message: active
      ? delivery.physicalDelivered
        ? 'Canvas updated · physical preview live'
        : 'Canvas updated · physical preview unavailable'
      : '',
  };
}
