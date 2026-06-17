export const ESP_CONNECT_RESET_SEQUENCE = ['default_reset', 'usb_reset', 'no_reset'];

export function makeEspConnectTerminal(onLog) {
  let logLines = [];
  return {
    clean: () => { logLines = []; },
    writeLine: line => {
      logLines.push(line);
      onLog?.(line);
    },
    write: chunk => {
      if (logLines.length === 0) logLines.push('');
      logLines[logLines.length - 1] += chunk;
      onLog?.(chunk);
    },
    getLines: () => logLines.slice(),
  };
}

export async function connectEspWithResetSequence({
  port,
  createTransport,
  createLoader,
  resetModes = ESP_CONNECT_RESET_SEQUENCE,
  onAttempt,
}) {
  let lastError = null;

  for (const mode of resetModes) {
    const attempt = { mode };
    onAttempt?.(attempt);
    const transport = createTransport(port, attempt);
    const loader = createLoader({ transport, attempt });

    try {
      const chip = await loader.main(mode);
      return { loader, transport, chip, resetMode: mode };
    } catch (error) {
      lastError = error;
      await transport?.disconnect?.().catch(() => {});
    }
  }

  const detail = lastError?.message ? `: ${lastError.message}` : '';
  throw new Error(`Failed to connect with the device${detail}`);
}
