const WIRING_ROWS = [
  ['LED output 1', 'GPIO 16', 'first data output'],
  ['LED output 2', 'GPIO 17', 'optional second output'],
  ['LED output 3', 'GPIO 18', 'optional third output'],
  ['LED output 4', 'GPIO 21', 'optional fourth output'],
  ['Dial A', 'GPIO 4', 'rotary encoder A'],
  ['Dial B', 'GPIO 5', 'rotary encoder B'],
  ['Dial press', 'GPIO 6', 'press to change look'],
  ['Previous button', 'GPIO 7', 'optional'],
  ['Next button', 'GPIO 8', 'optional'],
  ['Blackout button', 'GPIO 9', 'optional'],
  ['Brightness pot', 'GPIO 1', '3.3 V to GND, wiper to GPIO'],
  ['Shared ground', 'GND', 'required between card and LED supply'],
];

const INSTALL_STEPS = [
  {
    title: 'Flash the card',
    body: 'Use Chrome or Edge on a laptop. Plug the ESP32-S3 in by USB, enter bootloader mode, then flash the Lightweaver firmware.',
    action: 'Open flash',
    href: '#screen=flash',
  },
  {
    title: 'Wire one output first',
    body: 'Connect LED data to GPIO 16 through the level shifter. Power LEDs from the final supply, not USB. Confirm shared ground before lighting anything.',
  },
  {
    title: 'Join setup WiFi',
    body: 'After flashing, look for Lightweaver-XXXX WiFi. Join it, open 192.168.4.1, then add the shop or customer WiFi and set the hostname.',
  },
  {
    title: 'Load the project',
    body: 'Open the public Studio, choose patterns, layout, and settings. Save the card package through the card page so it survives reboot.',
    action: 'Open settings',
    href: '#screen=settings',
  },
  {
    title: 'Prove it survives',
    body: 'Reboot the card. Confirm the right pattern starts, the dial dims and brightens, dial press changes looks, and the inner and outer zones match the project.',
  },
];

const FAILURE_ROWS = [
  ['No serial port', 'Use desktop Chrome or Edge, a data USB cable, and close any serial monitor.'],
  ['Flash will not connect', 'Hold BOOT, tap RESET, release BOOT, then click Connect again.'],
  ['No LEDs', 'Check LED supply, shared ground, data direction arrow, and GPIO 16.'],
  ['Wrong colors', 'Change Color order in Settings, then save to card.'],
  ['Dial backwards', 'Swap Dial A and Dial B, or change rotation direction before saving.'],
  ['Cannot find card later', 'Join Lightweaver-XXXX again or open 192.168.4.1. Reset WiFi only if the saved network is wrong.'],
];

function InstallerSection({ title, meta, children }) {
  return (
    <section className="lw-installer-section">
      <div className="lw-sec-header">
        <span>{title}</span>
        {meta && <span className="meta">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

export function InstallerScreen() {
  return (
    <div className="lw-installer-screen">
      <div className="lw-installer-shell">
        <header className="lw-installer-hero">
          <div>
            <div className="lw-chip-settings-kicker">Installer</div>
            <h1>Worker install</h1>
            <p>
              Flash the card, wire the piece, load the project, then run the bench checks before it leaves the shop.
            </p>
          </div>
          <div className="lw-installer-actions">
            <a className="btn btn-primary" href="#screen=flash">Flash chip</a>
            <a className="btn" href="#screen=settings">Load project</a>
          </div>
        </header>

        <div className="lw-installer-grid">
          <div className="lw-installer-stack">
            <InstallerSection title="Start here" meta="do not skip">
              <div className="lw-installer-step-list">
                {INSTALL_STEPS.map((step, index) => (
                  <div className="lw-installer-step" key={step.title}>
                    <span className="lw-installer-step-index">{index + 1}</span>
                    <div>
                      <strong>{step.title}</strong>
                      <p>{step.body}</p>
                    </div>
                    {step.href && <a className="btn btn-ghost" href={step.href}>{step.action}</a>}
                  </div>
                ))}
              </div>
            </InstallerSection>

            <InstallerSection title="Wiring map" meta="default card pins">
              <div className="lw-installer-wiring">
                {WIRING_ROWS.map(([name, pin, note]) => (
                  <div className="lw-installer-wire-row" key={`${name}-${pin}`}>
                    <strong>{name}</strong>
                    <code>{pin}</code>
                    <span>{note}</span>
                  </div>
                ))}
              </div>
            </InstallerSection>
          </div>

          <aside className="lw-installer-stack">
            <InstallerSection title="Hard stops" meta="fix before shipping">
              <div className="lw-installer-stop-list">
                <div>
                  <strong>Power</strong>
                  <span>LEDs use the final power supply. USB is only for flashing and debugging.</span>
                </div>
                <div>
                  <strong>Shared ground</strong>
                  <span>Controller ground, LED supply ground, and level shifter ground must be tied together.</span>
                </div>
                <div>
                  <strong>Dial press</strong>
                  <span>Use GPIO 6 for the worker build. Avoid GPIO 0 for the main dial press because it is also BOOT.</span>
                </div>
                <div>
                  <strong>One output at a time</strong>
                  <span>Prove output 1 before adding outputs 2, 3, and 4.</span>
                </div>
              </div>
            </InstallerSection>

            <InstallerSection title="If something fails" meta="recovery">
              <div className="lw-installer-failure-list">
                {FAILURE_ROWS.map(([problem, fix]) => (
                  <div key={problem}>
                    <strong>{problem}</strong>
                    <span>{fix}</span>
                  </div>
                ))}
              </div>
            </InstallerSection>

            <InstallerSection title="Final signoff" meta="bench test">
              <label className="lw-installer-check"><input type="checkbox"/> Firmware flashes from this site.</label>
              <label className="lw-installer-check"><input type="checkbox"/> Output 1 lights correctly.</label>
              <label className="lw-installer-check"><input type="checkbox"/> Inner and outer zones match the project.</label>
              <label className="lw-installer-check"><input type="checkbox"/> Dial turn changes brightness.</label>
              <label className="lw-installer-check"><input type="checkbox"/> Dial press changes looks.</label>
              <label className="lw-installer-check"><input type="checkbox"/> Reboot keeps the saved project.</label>
            </InstallerSection>
          </aside>
        </div>
      </div>
    </div>
  );
}
