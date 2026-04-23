import { useState, useEffect, useCallback, useRef } from 'react';

export function useMidi({ onCC, onNoteOn, onNoteOff } = {}) {
  const [devices, setDevices]   = useState([]);
  const [enabled, setEnabled]   = useState(false);
  const [error,   setError]     = useState(null);
  const accessRef = useRef(null);
  const cbRef     = useRef({ onCC, onNoteOn, onNoteOff });
  cbRef.current   = { onCC, onNoteOn, onNoteOff };

  const handleMidiMessage = useCallback((event) => {
    const [status, data1, data2] = event.data;
    const type    = status & 0xf0;
    const channel = status & 0x0f;
    if (type === 0xb0) {
      const val = data2 / 127;
      cbRef.current.onCC?.(channel, data1, val);
      window.__lwMidiCC?.(channel, data1, val);
    }
    if (type === 0x90 && data2 > 0) cbRef.current.onNoteOn?.(channel, data1, data2 / 127);
    if (type === 0x80 || (type === 0x90 && data2 === 0)) cbRef.current.onNoteOff?.(channel, data1);
  }, []);

  const refreshDevices = useCallback((access) => {
    const list = [];
    access.inputs.forEach(input => list.push({ id: input.id, name: input.name, manufacturer: input.manufacturer }));
    setDevices(list);
  }, []);

  const enable = useCallback(async () => {
    if (!navigator.requestMIDIAccess) { setError('Web MIDI not supported'); return; }
    try {
      const access = await navigator.requestMIDIAccess({ sysex: false });
      accessRef.current = access;
      access.inputs.forEach(input => { input.onmidimessage = handleMidiMessage; });
      access.onstatechange = () => {
        access.inputs.forEach(input => { input.onmidimessage = handleMidiMessage; });
        refreshDevices(access);
      };
      refreshDevices(access);
      setEnabled(true);
      setError(null);
    } catch (e) {
      setError(e.message || 'MIDI access denied');
    }
  }, [handleMidiMessage, refreshDevices]);

  const disable = useCallback(() => {
    accessRef.current?.inputs.forEach(input => { input.onmidimessage = null; });
    setEnabled(false);
    setDevices([]);
  }, []);

  useEffect(() => () => disable(), [disable]);

  return { devices, enabled, error, enable, disable, toggle: enabled ? disable : enable };
}
