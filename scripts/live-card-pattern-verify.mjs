import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const DEFAULT_HOST = '192.168.18.70';
const DEFAULT_PATTERNS = Object.freeze(['fire', 'plasma', 'fire']);
const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_GAP_MS = 40;
const MAX_RESPONSE_BYTES = 64 * 1024;
const UINT32_MAX = 0xffffffff;

export class LiveCardVerificationError extends Error {
  constructor(message, report, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LiveCardVerificationError';
    this.report = report;
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeHost(rawHost = DEFAULT_HOST) {
  const value = String(rawHost || DEFAULT_HOST).trim();
  let host = value;
  try {
    host = new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    throw new TypeError(`Invalid card host: ${value}`);
  }
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number);
  const localIpv4 = ipv4?.every(part => part >= 0 && part <= 255)
    && (ipv4[0] === 10
      || ipv4[0] === 127
      || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168));
  if (!localIpv4 && host !== 'localhost' && !host.toLowerCase().endsWith('.local')) {
    throw new TypeError(`Refusing non-local card host: ${host}`);
  }
  return host;
}

function addFailure(report, code, message, details = {}) {
  report.failures.push({ code, message, ...details });
}

function addWarning(report, code, message, details = {}) {
  report.warnings.push({ code, message, ...details });
}

async function requestJson(fetchImpl, baseUrl, path, {
  method = 'GET',
  body = undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  optional = false,
} = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${method} ${path} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        signal: controller.signal,
        ...(method === 'GET' ? { cache: 'no-store' } : {}),
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`${method} ${path} timed out after ${timeoutMs}ms`, { cause: error });
      throw new Error(`${method} ${path} failed: ${error?.message || error}`, { cause: error });
    }
    if (optional && response.status === 404) return null;
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error(`${method} ${path} response exceeded ${MAX_RESPONSE_BYTES} bytes`);
    let payload;
    try {
      payload = JSON.parse(text);
    } catch (error) {
      throw new Error(`${method} ${path} returned invalid JSON`, { cause: error });
    }
    if (!response.ok) {
      throw new Error(`${method} ${path} returned HTTP ${response.status}: ${payload?.error || 'request failed'}`);
    }
    if (!isRecord(payload)) throw new Error(`${method} ${path} returned a non-object JSON payload`);
    return payload;
  })();
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizedOutputs(outputs) {
  return Array.isArray(outputs) ? outputs.map(output => ({
    id: String(output?.id || ''),
    pin: Number(output?.pin ?? output?.gpio),
    pixels: Number(output?.pixels ?? output?.count),
    segments: Array.isArray(output?.segments) ? output.segments.map(segment => ({
      id: String(segment?.id || ''),
      count: Number(segment?.count),
      direction: String(segment?.direction || ''),
    })) : [],
  })) : [];
}

function captureInvariants(status, firmwareInfo) {
  const wifi = status?.wifi || {};
  return {
    identity: {
      cardId: String(status?.cardId || firmwareInfo?.cardId || ''),
      firmwareVersion: String(status?.firmwareVersion || firmwareInfo?.firmwareVersion || ''),
      buildId: String(status?.buildId || firmwareInfo?.buildId || ''),
      bootId: String(status?.bootId || firmwareInfo?.bootId || ''),
    },
    wiring: {
      revision: status?.wiringRevision ?? firmwareInfo?.wiringRevision ?? null,
      digest: String(status?.wiringDigest || firmwareInfo?.wiringDigest || ''),
      outputs: normalizedOutputs(status?.outputs?.length ? status.outputs : firmwareInfo?.outputs),
    },
    led: {
      type: String(status?.led?.type || firmwareInfo?.ledType || ''),
      pixels: Number(status?.led?.pixels ?? firmwareInfo?.pixels ?? 0),
      colorOrder: String(status?.led?.colorOrder || ''),
      maxMilliamps: Number(status?.led?.maxMilliamps ?? firmwareInfo?.maxMilliamps ?? 0),
    },
    wifi: {
      transport: String(wifi.transport || firmwareInfo?.wifi?.transport || ''),
      hostname: String(wifi.hostname || firmwareInfo?.wifi?.hostname || ''),
      ip: String(wifi.ip || firmwareInfo?.wifi?.ip || ''),
      configured: Boolean(wifi.configured ?? firmwareInfo?.wifi?.configured),
    },
  };
}

function requireBaselineTruth(report, firmwareInfo, status) {
  if (!status?.cardId || !firmwareInfo?.cardId || status.cardId !== firmwareInfo.cardId) {
    addFailure(report, 'identity-mismatch', 'Status and firmware-info did not identify the same card.', {
      statusCardId: status?.cardId || '', firmwareInfoCardId: firmwareInfo?.cardId || '',
    });
  }
  if (status?.runtimePhase !== 'ready' || status?.commandReady !== true || status?.outputReady !== true) {
    addFailure(report, 'runtime-not-ready', 'The card is not ready for bounded pattern control.', {
      runtimePhase: status?.runtimePhase, commandReady: status?.commandReady, outputReady: status?.outputReady,
    });
  }
  if (status?.ok === false || status?.configValid === false || status?.knownGoodProject === false) {
    addFailure(report, 'runtime-unhealthy', 'The card did not report a healthy known-good runtime.', {
      ok: status?.ok, configValid: status?.configValid, knownGoodProject: status?.knownGoodProject,
    });
  }
}

function validateAcknowledgement(report, response, request, expectedCardId, previousStateRevision, outputIds) {
  const fail = (code, message, details = {}) => {
    addFailure(report, code, message, { patternId: request.patternId, revision: request.revision, ...details });
    throw new LiveCardVerificationError(message, report);
  };
  if (response.ok !== true) fail('ack-rejected', 'The card did not positively accept the control command.');
  if (response.cardId !== expectedCardId) {
    fail('ack-identity-mismatch', 'The control acknowledgement came from a different or unidentified card.', {
      expectedCardId, actualCardId: response.cardId || '',
    });
  }
  if (response.patternId !== request.patternId) {
    fail('ack-pattern-mismatch', 'The control acknowledgement echoed a different pattern.', {
      expected: request.patternId, actual: response.patternId,
    });
  }
  if (response.revision !== request.revision || response.confirmedRevision !== request.revision) {
    fail('ack-revision-mismatch', 'The control acknowledgement did not echo the exact request revision.', {
      expected: request.revision, revision: response.revision, confirmedRevision: response.confirmedRevision,
    });
  }
  if (response.appliedPatternId !== undefined && response.appliedPatternId !== request.patternId) {
    fail('ack-applied-pattern-mismatch', 'The card-owned applied-pattern acknowledgement disagreed with the request.', {
      expected: request.patternId, actual: response.appliedPatternId,
    });
  }
  if (response.appliedPatternId === undefined) {
    addWarning(report, 'ack-applied-pattern-unavailable', 'The card did not expose appliedPatternId in its acknowledgement.', {
      patternId: request.patternId, revision: request.revision,
    });
  }
  if (!Number.isSafeInteger(response.stateRevision)
      || response.stateRevision < 1
      || (previousStateRevision !== null && response.stateRevision <= previousStateRevision)) {
    fail('ack-state-revision-invalid', 'The card-owned state revision was absent or did not advance.', {
      previousStateRevision, stateRevision: response.stateRevision,
    });
  }
  if (!Number.isSafeInteger(response.affectedOutputCount) || response.affectedOutputCount < 1
      || !Array.isArray(response.affectedOutputs)
      || response.affectedOutputs.length !== response.affectedOutputCount
      || response.affectedOutputs.some(id => typeof id !== 'string' || !id
        || (outputIds.size && !outputIds.has(id)))) {
    fail('ack-output-scope-invalid', 'The acknowledgement did not identify a valid non-empty output scope.', {
      affectedOutputCount: response.affectedOutputCount,
      affectedOutputs: response.affectedOutputs,
    });
  }
  return {
    patternId: response.patternId,
    revision: response.revision,
    stateRevision: response.stateRevision,
    appliedPatternId: response.appliedPatternId ?? null,
    affectedOutputCount: response.affectedOutputCount,
    affectedOutputs: response.affectedOutputs,
  };
}

function statusTruth(status) {
  return String(status?.currentPatternId || status?.currentLookId || '');
}

function validateFinalTruth(report, finalPattern, status, patterns, zones) {
  const statusFields = [
    ['currentPatternId', status?.currentPatternId],
    ['currentLookId', status?.currentLookId],
  ].filter(([, value]) => typeof value === 'string' && value.length);
  if (!statusFields.length) {
    addWarning(report, 'status-pattern-truth-unavailable', '/api/status exposed no current pattern field.');
  } else if (statusFields.some(([, value]) => value !== finalPattern)) {
    addFailure(report, 'state-truth-mismatch', '/api/status did not report the final acknowledged pattern.', {
      source: 'status', expected: finalPattern,
      actual: Object.fromEntries(statusFields),
    });
  }

  if (patterns === null) {
    addWarning(report, 'patterns-unavailable', '/api/patterns is unavailable on this card.');
  } else if (typeof patterns.currentId !== 'string' || !patterns.currentId) {
    addWarning(report, 'patterns-truth-unavailable', '/api/patterns exposed no currentId field.');
  } else if (patterns.currentId !== finalPattern) {
    addFailure(report, 'state-truth-mismatch', '/api/patterns did not report the final acknowledged pattern.', {
      source: 'patterns', expected: finalPattern, actual: patterns.currentId,
    });
  }

  const zonePatternIds = Array.isArray(zones?.zones)
    ? zones.zones.map(zone => String(zone?.patternId || ''))
    : [];
  if (!zonePatternIds.length || zonePatternIds.some(patternId => patternId !== finalPattern)) {
    addFailure(report, 'zone-truth-mismatch', '/api/zones did not report the final pattern on every active zone.', {
      source: 'zones', expected: finalPattern, actual: zonePatternIds,
    });
  }
  return {
    status: statusTruth(status) || null,
    patterns: patterns?.currentId || null,
    zones: zonePatternIds,
  };
}

function throwIfFailed(report, message = 'Live card pattern verification failed.') {
  if (report.failures.length) throw new LiveCardVerificationError(message, report);
}

export async function runLiveCardPatternVerification({
  host: rawHost = DEFAULT_HOST,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  gapMs = DEFAULT_GAP_MS,
  patternSequence = DEFAULT_PATTERNS,
  revisionBase = Math.floor(Date.now() / 1000) % (UINT32_MAX - 1000),
  sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is unavailable');
  const host = normalizeHost(rawHost);
  const baseUrl = `http://${host}`;
  const patternsToSend = [...patternSequence].map(value => String(value));
  if (!patternsToSend.length || patternsToSend.length > 8
      || patternsToSend.some(pattern => !['fire', 'plasma'].includes(pattern))) {
    throw new TypeError('patternSequence must contain 1-8 bounded built-in fire/plasma controls');
  }
  if (!Number.isSafeInteger(revisionBase) || revisionBase < 0
      || revisionBase + patternsToSend.length > UINT32_MAX) {
    throw new TypeError('revisionBase is outside the uint32 control range');
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 15000) {
    throw new TypeError('timeoutMs must be between 100 and 15000');
  }
  if (!Number.isFinite(gapMs) || gapMs < 0 || gapMs > 1000) {
    throw new TypeError('gapMs must be between 0 and 1000');
  }

  const report = {
    ok: false,
    host,
    baseUrl,
    cardId: '',
    patternSequence: patternsToSend,
    physicalVisibilityVerified: false,
    physicalVisibilityNote: 'This harness verifies card-owned software state only; it does not prove that LEDs are physically visible.',
    baseline: null,
    acknowledgements: [],
    final: null,
    warnings: [],
    failures: [],
  };

  try {
    const firmwareInfo = await requestJson(fetchImpl, baseUrl, '/api/firmware-info', { timeoutMs });
    const baselineStatus = await requestJson(fetchImpl, baseUrl, '/api/status', { timeoutMs });
    const baselinePatterns = await requestJson(fetchImpl, baseUrl, '/api/patterns', { timeoutMs, optional: true });
    const baselineZones = await requestJson(fetchImpl, baseUrl, '/api/zones', { timeoutMs });
    const invariants = captureInvariants(baselineStatus, firmwareInfo);
    report.cardId = invariants.identity.cardId;
    report.baseline = {
      invariants,
      readiness: {
        runtimePhase: baselineStatus.runtimePhase,
        commandReady: baselineStatus.commandReady,
        outputReady: baselineStatus.outputReady,
      },
      truth: {
        status: statusTruth(baselineStatus) || null,
        patterns: baselinePatterns?.currentId || null,
        zones: Array.isArray(baselineZones?.zones)
          ? baselineZones.zones.map(zone => String(zone?.patternId || '')) : [],
      },
    };
    requireBaselineTruth(report, firmwareInfo, baselineStatus);
    throwIfFailed(report, 'The card was not safe to exercise.');

    const outputIds = new Set(invariants.wiring.outputs.map(output => output.id).filter(Boolean));
    let previousStateRevision = null;
    for (let index = 0; index < patternsToSend.length; index += 1) {
      const request = {
        cancelStream: true,
        syncZones: true,
        patternId: patternsToSend[index],
        revision: revisionBase + index + 1,
      };
      const response = await requestJson(fetchImpl, baseUrl, '/api/control', {
        method: 'POST', body: request, timeoutMs,
      });
      const acknowledgement = validateAcknowledgement(
        report, response, request, report.cardId, previousStateRevision, outputIds,
      );
      previousStateRevision = acknowledgement.stateRevision;
      report.acknowledgements.push(acknowledgement);
      if (index + 1 < patternsToSend.length && gapMs > 0) await sleep(gapMs);
    }

    const finalStatus = await requestJson(fetchImpl, baseUrl, '/api/status', { timeoutMs });
    const finalPatterns = await requestJson(fetchImpl, baseUrl, '/api/patterns', { timeoutMs, optional: true });
    const finalZones = await requestJson(fetchImpl, baseUrl, '/api/zones', { timeoutMs });
    const finalInvariants = captureInvariants(finalStatus, firmwareInfo);
    const finalPattern = patternsToSend.at(-1);
    report.final = {
      invariants: finalInvariants,
      readiness: {
        runtimePhase: finalStatus.runtimePhase,
        commandReady: finalStatus.commandReady,
        outputReady: finalStatus.outputReady,
        streaming: finalStatus.streaming,
        frameSource: finalStatus.frameSource,
      },
      truth: validateFinalTruth(report, finalPattern, finalStatus, finalPatterns, finalZones),
    };
    if (finalStatus.runtimePhase !== 'ready' || finalStatus.commandReady !== true || finalStatus.outputReady !== true) {
      addFailure(report, 'runtime-not-ready-after-control', 'The runtime was not ready after the pattern sequence.', {
        runtimePhase: finalStatus.runtimePhase,
        commandReady: finalStatus.commandReady,
        outputReady: finalStatus.outputReady,
      });
    }
    if (stableJson(invariants) !== stableJson(finalInvariants)) {
      addFailure(report, 'invariant-drift', 'Identity, wiring, LED, or WiFi invariants changed during pattern control.', {
        before: invariants, after: finalInvariants,
      });
    }
    throwIfFailed(report);
    report.ok = true;
    return report;
  } catch (error) {
    if (error instanceof LiveCardVerificationError) throw error;
    addFailure(report, 'request-failed', error?.message || String(error));
    throw new LiveCardVerificationError('Live card pattern verification could not complete.', report, error);
  }
}

function usage() {
  return [
    'Usage: node scripts/live-card-pattern-verify.mjs [--host HOST] [--timeout-ms N] [--gap-ms N]',
    '',
    `Default host: ${DEFAULT_HOST} (or LW_CARD_HOST).`,
    'Writes: POST /api/control only, using fire/plasma built-in pattern selections.',
    'No config, reboot, reset, recovery, or wiring endpoint is called.',
  ].join('\n');
}

function parseCli(argv) {
  const options = { host: process.env.LW_CARD_HOST || DEFAULT_HOST };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    const value = argv[index + 1];
    if (argument === '--host' && value) {
      options.host = value;
      index += 1;
    } else if (argument === '--timeout-ms' && value) {
      options.timeoutMs = Number(value);
      index += 1;
    } else if (argument === '--gap-ms' && value) {
      options.gapMs = Number(value);
      index += 1;
    } else {
      throw new TypeError(`Unknown or incomplete argument: ${argument}`);
    }
  }
  return options;
}

async function main() {
  let options;
  try {
    options = parseCli(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const report = await runLiveCardPatternVerification(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (error instanceof LiveCardVerificationError) {
      process.stderr.write(`${JSON.stringify(error.report, null, 2)}\n`);
    } else {
      process.stderr.write(`${error?.message || error}\n\n${usage()}\n`);
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) await main();
