import { useState, useRef, useCallback, useEffect } from 'react';

const FFT_SIZE = 1024;

// Frequency range → FFT bin indices for a given sample rate
function freqToBin(freq, sampleRate) {
  return Math.round(freq / (sampleRate / FFT_SIZE));
}

export function useAudio() {
  const [enabled,    setEnabled]    = useState(false);
  const [error,      setError]      = useState(null);
  const [bands,      setBands]      = useState({ bass: 0, mid: 0, hi: 0, energy: 0 });
  const ctxRef      = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef   = useRef(null);
  const rafRef      = useRef(null);
  const dataRef     = useRef(null);

  const stop = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    if (sourceRef.current) { try { sourceRef.current.disconnect(); } catch {} }
    if (ctxRef.current)    { try { ctxRef.current.close(); }        catch {} }
    ctxRef.current = null; analyserRef.current = null; sourceRef.current = null;
    setEnabled(false);
    setBands({ bass: 0, mid: 0, hi: 0, energy: 0 });
  }, []);

  const start = useCallback(async () => {
    try {
      setError(null);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const ctx     = new (window.AudioContext || window.webkitAudioContext)();
      const source  = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      ctxRef.current    = ctx;
      analyserRef.current = analyser;
      sourceRef.current = source;
      dataRef.current   = new Uint8Array(analyser.frequencyBinCount);
      setEnabled(true);

      const sampleRate = ctx.sampleRate;
      // Frequency band boundaries
      const bassLo  = freqToBin(20,   sampleRate), bassHi  = freqToBin(300,   sampleRate);
      const midLo   = freqToBin(300,  sampleRate), midHi   = freqToBin(3000,  sampleRate);
      const hiLo    = freqToBin(3000, sampleRate), hiHi    = freqToBin(20000, sampleRate);

      function sumBand(data, lo, hi) {
        let sum = 0, count = hi - lo + 1;
        for (let i = lo; i <= Math.min(hi, data.length - 1); i++) sum += data[i];
        return count > 0 ? sum / count / 255 : 0;
      }

      const tick = () => {
        if (!analyserRef.current) return;
        analyserRef.current.getByteFrequencyData(dataRef.current);
        const data = dataRef.current;
        const bass   = Math.min(1, sumBand(data, bassLo, bassHi) * 1.8);
        const mid    = Math.min(1, sumBand(data, midLo,  midHi)  * 1.4);
        const hi     = Math.min(1, sumBand(data, hiLo,   hiHi)   * 2.0);
        const energy = Math.min(1, (bass * 0.5 + mid * 0.3 + hi * 0.2));
        setBands({ bass, mid, hi, energy });
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    } catch (e) {
      setError(e.message || 'Microphone access denied');
      setEnabled(false);
    }
  }, []);

  const toggle = useCallback(() => {
    if (enabled) stop(); else start();
  }, [enabled, start, stop]);

  useEffect(() => () => stop(), [stop]);

  return { enabled, bands, error, toggle, start, stop };
}
