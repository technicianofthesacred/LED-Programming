import { useRef, useState } from 'react';
import { pushLiveHardwareToCard, recoverCardLights } from '../../../lib/cardLiveControl.js';
import { COLOR_ORDERS, normalizeUsbLedColorOrder } from '../../../lib/usbLedColorOrder.js';

const COLOR_TESTS = [
  { id: 'r', label: 'Red', short: 'R', patternId: 'test-red', brightness: 1 },
  { id: 'g', label: 'Green', short: 'G', patternId: 'test-green', brightness: 1 },
  { id: 'b', label: 'Blue', short: 'B', patternId: 'test-blue', brightness: 1 },
  { id: 'w', label: 'White', short: 'W', patternId: 'test-white', brightness: 0.55 },
];

export function StripColorOrderCheck({ cardHost, controller, setController }) {
  const [open, setOpen] = useState(false);
  const [activeTestId, setActiveTestId] = useState('r');
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveTestedOrder, setLiveTestedOrder] = useState('');
  const testRequestRef = useRef(0);
  const colorOrder = normalizeUsbLedColorOrder(controller?.led?.colorOrder || 'RGB');
  const confirmed = Boolean(
    controller?.led?.colorOrderConfirmed
    && normalizeUsbLedColorOrder(controller?.led?.confirmedColorOrder || '') === colorOrder
  );
  const liveTestReady = liveTestedOrder === colorOrder;

  const saveOrder = order => {
    setLiveTestedOrder('');
    return setController(previous => ({
      ...previous,
      led: {
        ...(previous?.led || {}),
        colorOrder: order,
        colorOrderConfirmed: false,
        confirmedColorOrder: '',
      },
    }));
  };

  const confirmOrder = () => {
    if (!liveTestReady) return;
    setController(previous => ({
      ...previous,
      led: {
        ...(previous?.led || {}),
        colorOrder,
        colorOrderConfirmed: true,
        confirmedColorOrder: colorOrder,
      },
    }));
    setStatus(`${colorOrder} color order confirmed.`);
    setStatusKind('ok');
  };

  const playTest = async (testId, order = colorOrder) => {
    const test = COLOR_TESTS.find(item => item.id === testId) || COLOR_TESTS[0];
    const testedOrder = normalizeUsbLedColorOrder(order || colorOrder);
    const requestId = ++testRequestRef.current;
    setActiveTestId(test.id);
    setLiveTestedOrder('');
    setBusy(true);
    setStatus('');
    setStatusKind('');
    try {
      await recoverCardLights(
        { patternId: test.patternId, brightness: test.brightness, syncZones: true },
        { host: cardHost, timeoutMs: 3200 },
      );
      if (testRequestRef.current !== requestId) return;
      setLiveTestedOrder(testedOrder);
      setStatus(`${test.label} test is live.`);
      setStatusKind('ok');
    } catch (error) {
      if (testRequestRef.current !== requestId) return;
      setStatus(error?.message || `${test.label} test could not reach the card.`);
      setStatusKind('err');
    } finally {
      if (testRequestRef.current === requestId) setBusy(false);
    }
  };

  const startCheck = () => {
    setOpen(true);
    void playTest(activeTestId);
  };

  const tryNextOrder = async () => {
    const currentIndex = COLOR_ORDERS.indexOf(colorOrder);
    const nextOrder = COLOR_ORDERS[((currentIndex >= 0 ? currentIndex : 0) + 1) % COLOR_ORDERS.length];
    saveOrder(nextOrder);
    const requestId = ++testRequestRef.current;
    setBusy(true);
    setStatus('');
    setStatusKind('');
    try {
      const response = await pushLiveHardwareToCard({ colorOrder: nextOrder }, { host: cardHost, timeoutMs: 2200 });
      const appliedOrder = normalizeUsbLedColorOrder(response?.colorOrder || nextOrder, nextOrder);
      if (appliedOrder !== nextOrder) saveOrder(appliedOrder);
      await playTest(activeTestId, appliedOrder);
    } catch (error) {
      if (testRequestRef.current !== requestId) return;
      setStatus(error?.message || `${nextOrder} order could not reach the card.`);
      setStatusKind('err');
      setBusy(false);
    }
  };

  return (
    <section className="lw-color-order-check" aria-label="LED color order">
      <div className="lw-color-order-heading">
        <strong>LED color order</strong>
        <span>{confirmed ? 'Confirmed' : 'Current'} <b data-testid="strip-color-order">{colorOrder}</b></span>
        <button className="btn" disabled={busy} onClick={startCheck}>Check colors</button>
      </div>
      {open && <div className="lw-color-order-body">
        <p>{confirmed ? 'The saved color order matches the real LEDs.' : 'If the test color is wrong, try the next order.'}</p>
        {!confirmed && <p>{liveTestReady ? 'The live test succeeded. Confirm the order if the real LEDs match.' : 'Run a successful live test before confirming this order.'}</p>}
        <div className="lw-color-order-actions">
          <div className="lw-color-test-buttons" aria-label="Test color">
            {COLOR_TESTS.map(test => (
              <button
                key={test.id}
                className={`lw-color-test-button${activeTestId === test.id ? ' is-active' : ''}`}
                aria-label={test.label}
                aria-pressed={activeTestId === test.id}
                disabled={busy}
                onClick={() => void playTest(test.id)}
              >{test.short}</button>
            ))}
          </div>
          <button className="btn btn-ghost" disabled={busy} onClick={() => void tryNextOrder()}>Try next order</button>
          <button className="btn primary" disabled={busy || confirmed || !liveTestReady} onClick={confirmOrder}>{confirmed ? 'Colors confirmed' : 'Colors look correct'}</button>
        </div>
        {status && <p className={`lw-color-order-status${statusKind ? ` is-${statusKind}` : ''}`} role={statusKind === 'err' ? 'alert' : 'status'}>{status}</p>}
      </div>}
    </section>
  );
}
