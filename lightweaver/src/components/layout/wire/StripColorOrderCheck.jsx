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

  // Quiz answer: seeing the color the card was told to show means the saved
  // order matches (confirm it); seeing a different color means the order is
  // wrong, so cycle to the next candidate — both via the existing handlers.
  const answerColor = answerId => {
    if (busy) return;
    if (answerId === activeTestId) {
      if (liveTestReady) confirmOrder();
      else void playTest(activeTestId);
    } else {
      void tryNextOrder();
    }
  };

  const activeTest = COLOR_TESTS.find(item => item.id === activeTestId) || COLOR_TESTS[0];
  const answers = activeTestId === 'w'
    ? COLOR_TESTS
    : COLOR_TESTS.filter(test => test.id !== 'w');

  return (
    <section className="lw-color-order-check lwb-quiz" aria-label="LED color order">
      <div className="lwb-quiz-head">
        <div className="lwb-quiz-head-text">
          <strong>Do the colors look right?</strong>
          {/* Plain-language status only — the machine color-order token stays
              behind the opened check (redesign change 11: "GRB" never shows
              in primary copy). */}
          <span className="lwb-detail">{confirmed ? 'Colors confirmed' : 'Colors not checked yet'}</span>
        </div>
        <button type="button" className="btn lwb-quiz-open" disabled={busy} onClick={startCheck}>Check colors</button>
      </div>
      {open && (
        <div className="lwb-quiz-body">
          <p className="lwb-quiz-q">What color do you see?</p>
          <div
            className={`lwb-swatch is-${activeTest.id}`}
            role="img"
            aria-label={`The strip should now be lit ${activeTest.label.toLowerCase()}`}
          />
          <p className="lwb-quiz-hint">
            {confirmed
              ? 'The saved order already matches the real LEDs. Tap the color you see to double-check.'
              : 'The whole strip just lit up. Tap the color you actually see.'}
          </p>
          <div className="lwb-quiz-answers" role="group" aria-label="What color do you see?" style={{ gridTemplateColumns: `repeat(${answers.length}, 1fr)` }}>
            {answers.map(test => (
              <button
                key={test.id}
                type="button"
                className={`lwb-quiz-answer is-${test.id}`}
                disabled={busy}
                onClick={() => answerColor(test.id)}
              >{test.label}</button>
            ))}
          </div>
          <div className="lwb-quiz-more">
            <div className="lwb-quiz-minis" role="group" aria-label="Send a different test color">
              {COLOR_TESTS.map(test => (
                <button
                  key={test.id}
                  type="button"
                  className={`lwb-quiz-mini${activeTestId === test.id ? ' is-active' : ''}`}
                  aria-label={`Send ${test.label} test`}
                  aria-pressed={activeTestId === test.id}
                  disabled={busy}
                  onClick={() => void playTest(test.id)}
                >{test.short}</button>
              ))}
            </div>
            <button type="button" className="btn btn-ghost lwb-quiz-cycle" disabled={busy} onClick={() => void tryNextOrder()}>Try next order</button>
          </div>
          {status && <p className={`lwb-quiz-status${statusKind ? ` is-${statusKind}` : ''}`} role={statusKind === 'err' ? 'alert' : 'status'}>{status}</p>}
          <p className="lwb-detail lwb-quiz-order">
            Wire color order: <b data-testid="strip-color-order">{colorOrder}</b>{confirmed ? ' · confirmed' : ''}
          </p>
        </div>
      )}
    </section>
  );
}
