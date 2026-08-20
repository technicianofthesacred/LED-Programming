import { useEffect, useRef, useState } from 'react';
import { pushLiveHardwareToCard, recoverCardLights, stopCardLights } from '../../../lib/cardLiveControl.js';
import {
  colorOrderAnswers,
  normalizeUsbLedColorOrder,
  solveColorOrder,
} from '../../../lib/usbLedColorOrder.js';
import '../../../styles/lw-bench.css';

// Two questions solve the color order exactly (see the solver comment in
// usbLedColorOrder.js), so this screen is always red -> green -> done. There is
// no cycling through the six orders and no manual test-color picker.
const COLOR_TESTS = [
  { id: 'r', channel: 'R', label: 'Red', patternId: 'test-red', brightness: 0.35 },
  { id: 'g', channel: 'G', label: 'Green', patternId: 'test-green', brightness: 0.35 },
  { id: 'b', channel: 'B', label: 'Blue', patternId: 'test-blue', brightness: 0.35 },
];

const testForChannel = channel => COLOR_TESTS.find(test => test.channel === channel) || COLOR_TESTS[0];

export function StripColorOrderCheck({ cardHost, controller, setController, autoStart = false, quick = false }) {
  const [open, setOpen] = useState(autoStart || quick);
  // '' before the first question, 'R' during the red question, 'G' during the
  // green one, 'done' once the order is solved.
  const [asking, setAsking] = useState('');
  const [seenForRed, setSeenForRed] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const requestRef = useRef(0);
  const startedRef = useRef(false);
  const colorOrder = normalizeUsbLedColorOrder(controller?.led?.colorOrder || 'RGB');
  // The order the two questions were asked under. Both questions must run under
  // one order or their answers describe different worlds.
  const askedUnderRef = useRef(colorOrder);
  const confirmed = Boolean(
    controller?.led?.colorOrderConfirmed
    && normalizeUsbLedColorOrder(controller?.led?.confirmedColorOrder || '') === colorOrder,
  );

  const saveOrder = (order, isConfirmed) => setController(previous => ({
    ...previous,
    led: {
      ...(previous?.led || {}),
      colorOrder: order,
      colorOrderConfirmed: isConfirmed,
      confirmedColorOrder: isConfirmed ? order : '',
    },
  }));

  const lightChannel = async channel => {
    const test = testForChannel(channel);
    await recoverCardLights(
      { patternId: test.patternId, brightness: test.brightness, syncZones: true },
      { host: cardHost, timeoutMs: 3200 },
    );
  };

  // Applying the saved order first is what makes the questions answerable: the
  // card and Studio have to agree on the order before the answers mean anything.
  const applyOrder = async order => {
    const response = await pushLiveHardwareToCard({ colorOrder: order }, { host: cardHost, timeoutMs: 2200 });
    return normalizeUsbLedColorOrder(response?.colorOrder || order, order);
  };

  const startCheck = async () => {
    const requestId = ++requestRef.current;
    startedRef.current = true;
    setOpen(true);
    setBusy(true);
    setError('');
    setSeenForRed('');
    setAsking('');
    try {
      const applied = await applyOrder(colorOrder);
      if (requestRef.current !== requestId) return;
      askedUnderRef.current = applied;
      if (applied !== colorOrder) saveOrder(applied, false);
      await lightChannel('R');
      if (requestRef.current !== requestId) return;
      setAsking('R');
    } catch (cause) {
      if (requestRef.current !== requestId) return;
      setError(cause?.message || 'The color test could not reach the card.');
    } finally {
      if (requestRef.current === requestId) setBusy(false);
    }
  };

  const answerRed = async channel => {
    const requestId = ++requestRef.current;
    setBusy(true);
    setError('');
    try {
      await lightChannel('G');
      if (requestRef.current !== requestId) return;
      setSeenForRed(channel);
      setAsking('G');
    } catch (cause) {
      if (requestRef.current !== requestId) return;
      setError(cause?.message || 'The color test could not reach the card.');
    } finally {
      if (requestRef.current === requestId) setBusy(false);
    }
  };

  const answerGreen = async channel => {
    const solved = solveColorOrder(askedUnderRef.current, { R: seenForRed, G: channel });
    if (!solved) return;
    const requestId = ++requestRef.current;
    setBusy(true);
    setError('');
    try {
      const applied = await applyOrder(solved);
      if (requestRef.current !== requestId) return;
      // Relight green under the solved order first: the strip turning green is
      // the proof, and confirming can retire this panel on the spot.
      await lightChannel('G');
      if (requestRef.current !== requestId) return;
      setAsking('done');
      saveOrder(applied, applied === solved);
    } catch (cause) {
      if (requestRef.current !== requestId) return;
      setError(cause?.message || 'The corrected color order could not reach the card.');
    } finally {
      if (requestRef.current === requestId) setBusy(false);
    }
  };

  useEffect(() => {
    if (autoStart || quick) void startCheck();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only entry
  }, []);

  // No "Stop lights" button: the test turns itself off when this leaves.
  useEffect(() => () => {
    if (!startedRef.current) return;
    requestRef.current += 1;
    void stopCardLights({ host: cardHost, timeoutMs: 3200 }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount cleanup
  }, []);

  const started = asking === 'R' || asking === 'G';
  const answers = asking === 'R'
    ? colorOrderAnswers(askedUnderRef.current, {}, 'R')
    : colorOrderAnswers(askedUnderRef.current, { R: seenForRed }, 'G');
  const activeTest = testForChannel(asking === 'R' ? 'R' : 'G');
  const step = asking === 'R' ? 1 : 2;

  const unreached = (
    <>
      <p className="lwb-quiz-hint">
        {busy ? 'Lighting the strip…' : 'The strip was never lit, so there is nothing to answer yet.'}
      </p>
      {!busy && (
        <button
          type="button"
          className="btn"
          title="Send the first test color to the strip again."
          data-tooltip="Send the first test color to the strip again."
          onClick={() => void startCheck()}
        >Try again</button>
      )}
    </>
  );

  const question = (
    <>
      <p className="lwb-quiz-step">Step {step} of 2</p>
      <p className="lwb-quiz-q">What color do you see?</p>
      <div
        className={`lwb-swatch is-${activeTest.id}`}
        role="img"
        aria-label={`The strip should now be lit ${activeTest.label.toLowerCase()}`}
      />
      <p className="lwb-quiz-hint">Tap the color the strip actually shows. Brightness is reduced for the test.</p>
      <div
        className="lwb-quiz-answers"
        role="group"
        aria-label="What color do you see?"
        style={{ gridTemplateColumns: `repeat(${answers.length}, 1fr)` }}
      >
        {answers.map(channel => {
          const test = testForChannel(channel);
          return (
            <button
              key={test.id}
              type="button"
              className={`lwb-quiz-answer is-${test.id}`}
              title={`Record that the LEDs appear ${test.label.toLowerCase()}.`}
              data-tooltip={`Record that the LEDs appear ${test.label.toLowerCase()}.`}
              disabled={busy}
              onClick={() => void (asking === 'R' ? answerRed(channel) : answerGreen(channel))}
            >{test.label}</button>
          );
        })}
      </div>
    </>
  );

  const done = (
    <>
      <div className="lwb-swatch is-g" role="img" aria-label="The strip should now be lit green" />
      <p className="lwb-quiz-hint">The strip should now look green. Colors are set.</p>
    </>
  );

  const body = (
    <div className="lwb-quiz-body">
      {asking === 'done' ? done : (started ? question : unreached)}
      {busy && started && <p className="lwb-quiz-status" role="status">Lighting the strip…</p>}
      {!busy && error && <p className="lwb-quiz-status is-err" role="alert">{error}</p>}
      <p className="lwb-detail lwb-quiz-order">
        Wire color order: <b data-testid="strip-color-order">{colorOrder}</b>{confirmed ? ' · confirmed' : ''}
      </p>
    </div>
  );

  if (quick) {
    return (
      <section className="lw-color-order-check lwb-quiz is-quick" aria-label="LED color order">
        <div className="lwb-quiz-head">
          <div className="lwb-quiz-head-text">
            <strong>Shift colors</strong>
            <span className="lwb-detail">{asking === 'done' ? 'Colors confirmed' : 'Two taps and the colors are right'}</span>
          </div>
        </div>
        {body}
      </section>
    );
  }

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
        {!open && (
          <button
            type="button"
            className="btn lwb-quiz-open"
            title="Light the strip with test colors so you can confirm its real color order."
            data-tooltip="Light the strip with test colors so you can confirm its real color order."
            disabled={busy}
            onClick={() => void startCheck()}
          >Check colors</button>
        )}
      </div>
      {open && body}
    </section>
  );
}
