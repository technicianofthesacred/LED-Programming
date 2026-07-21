import { normalizeCardHost } from './cardConnection.js';

function cardId(value = {}) {
  return String(value?.id || value?.cardId || '').trim().toLowerCase();
}

function fail(reason) {
  return { ok: false, reason };
}

export function productionCardAuthority(link = {}, expectedCardId = '', {
  mutation = 'runtime', expectedFirmwareVersion = '', expectedBuildId = '',
} = {}) {
  const expected = String(expectedCardId || '').trim().toLowerCase();
  const actual = cardId(link.card);
  const expectedByLink = cardId(link.expectedCard);
  if (mutation === 'readback') {
    const correlation = link.handoffCorrelation || {};
    const correlatedId = String(correlation.expectedCardId || '').trim().toLowerCase();
    const exactHandoff = link.transport === 'bridge'
      && ['connecting', 'revalidating', 'connected-bridge'].includes(link.state)
      && expected && correlatedId === expected
      && (!expectedByLink || expectedByLink === expected)
      && normalizeCardHost(link.host) === normalizeCardHost(correlation.host)
      && String(link.validatedBootId || '') === String(correlation.expectedBootId || '')
      && Number.isSafeInteger(link.operationGeneration)
      && Number.isSafeInteger(link.bridgeLifecycle)
      && link.bridgeLifecycle === link.handoffBridgeLifecycle
      && /^[A-Za-z0-9_-]{16,96}$/.test(link.handoffFlowId || '');
    return exactHandoff ? { ok: true, readback: true } : fail('The exact post-config card handoff is not ready for read-back.');
  }
  const connectedTransport = link.state === 'connected-bridge' || link.state === 'connected-direct';
  if (mutation === 'observed-identity') {
    if (!connectedTransport || !actual) return fail('No verified Lightweaver card identity is available to inspect.');
    if (!normalizeCardHost(link.host) || !String(link.validatedBootId || '')) {
      return fail('The observed card link is missing a verified host or boot.');
    }
    if (!Number.isSafeInteger(link.operationGeneration) || link.operationGeneration < 0) {
      return fail('The observed card link operation generation is not verified.');
    }
    if (link.state === 'connected-bridge' && !Number.isSafeInteger(link.bridgeLifecycle)) {
      return fail('The observed card page lifecycle is not verified.');
    }
    const observedReadiness = link.readiness || {};
    const observedIsSelfConsistent = observedReadiness.app === 'Lightweaver'
      && String(observedReadiness.cardId || observedReadiness.id || '').trim().toLowerCase() === actual
      && String(observedReadiness.bootId || '') === String(link.validatedBootId || '');
    return observedIsSelfConsistent
      ? { ok: true, readOnly: true, observedCardId: actual }
      : fail('The observed card identity status is not internally consistent.');
  }
  if (!expected || !connectedTransport) return fail('The exact card link is not ready.');
  if (!actual || actual !== expected || (expectedByLink && expectedByLink !== expected)) {
    return fail('The exact USB-inspected card is not on this card link.');
  }
  if (!normalizeCardHost(link.host) || !String(link.validatedBootId || '')) {
    return fail('The card link is missing a verified host or boot.');
  }
  if (!Number.isSafeInteger(link.operationGeneration) || link.operationGeneration < 0) {
    return fail('The card link operation generation is not verified.');
  }
  if (link.state === 'connected-bridge' && !Number.isSafeInteger(link.bridgeLifecycle)) {
    return fail('The card page lifecycle is not verified.');
  }
  const readiness = link.readiness || {};
  const exactReadiness = readiness.app === 'Lightweaver'
    && String(readiness.cardId || readiness.id || '').trim().toLowerCase() === expected
    && String(readiness.bootId || '') === String(link.validatedBootId || '');
  if (mutation === 'identity') {
    return exactReadiness
      ? { ok: true, readOnly: true, blank: link.cardBlank === true }
      : fail('The exact card identity status is not ready for read-only evidence.');
  }
  if (mutation === 'config' || mutation === 'runtime') {
    const targetVersion = String(expectedFirmwareVersion || '').trim();
    const targetBuild = String(expectedBuildId || '').trim();
    if (!targetVersion || !targetBuild
      || String(readiness.firmwareVersion || '') !== targetVersion
      || String(readiness.buildId || '') !== targetBuild) {
      return fail(`The exact card does not have the verified signed firmware required for ${mutation === 'config' ? 'configuration' : 'runtime commands'}.`);
    }
  }
  if (mutation === 'config' && link.cardBlank === true) {
    if (link.state === 'connected-bridge' && !/^[A-Za-z0-9_-]{16,96}$/.test(link.handoffFlowId || '')) {
      return fail('The blank card is missing its verified WiFi handoff flow.');
    }
    if (!exactReadiness || readiness.runtimePhase !== 'factory'
      || readiness.knownGoodProject !== false || readiness.commandReady !== false) {
      return fail('The blank card readiness envelope is not exact.');
    }
    return { ok: true, blank: true };
  }
  if (!exactReadiness || link.cardBlank === true || readiness.commandReady !== true
    || readiness.outputReady !== true || readiness.knownGoodProject !== true
    || readiness.runtimePhase !== 'ready') {
    return fail('The exact card is present but not ready for runtime commands.');
  }
  return { ok: true, blank: false };
}

export function captureProductionCardLease(link, expectedCardId, options = {}) {
  const authority = productionCardAuthority(link, expectedCardId, options);
  if (!authority.ok) throw new Error(authority.reason);
  return Object.freeze({
    expectedCardId: String(expectedCardId).trim().toLowerCase(),
    host: normalizeCardHost(link.host),
    transport: link.transport === 'bridge' || link.state === 'connected-bridge' ? 'bridge' : 'direct',
    bridgeLifecycle: link.transport === 'bridge' || link.state === 'connected-bridge' ? link.bridgeLifecycle : null,
    operationGeneration: link.operationGeneration,
    validatedBootId: String(link.validatedBootId),
    commissioningFlowId: String(link.handoffFlowId || ''),
    expectedFirmwareVersion: ['config', 'runtime'].includes(options.mutation) ? String(options.expectedFirmwareVersion || '') : '',
    expectedBuildId: ['config', 'runtime'].includes(options.mutation) ? String(options.expectedBuildId || '') : '',
  });
}

export function assertProductionCardLease(lease, link, options = {}) {
  if (!lease) throw new Error('The production card lease is missing.');
  const authorityOptions = ['config', 'runtime'].includes(options.mutation)
    ? {
        ...options,
        expectedFirmwareVersion: options.expectedFirmwareVersion || lease.expectedFirmwareVersion,
        expectedBuildId: options.expectedBuildId || lease.expectedBuildId,
      }
    : options;
  const authority = productionCardAuthority(link, lease.expectedCardId, authorityOptions);
  if (!authority.ok) throw new Error(`The card link is not ready: ${authority.reason}`);
  const current = {
    expectedCardId: options.mutation === 'readback'
      ? String(link.handoffCorrelation?.expectedCardId || '').trim().toLowerCase()
      : cardId(link.card),
    host: normalizeCardHost(link.host),
    transport: link.transport === 'bridge' || link.state === 'connected-bridge' ? 'bridge' : 'direct',
    bridgeLifecycle: link.transport === 'bridge' || link.state === 'connected-bridge' ? link.bridgeLifecycle : null,
    operationGeneration: link.operationGeneration,
    validatedBootId: String(link.validatedBootId || ''),
    commissioningFlowId: String(link.handoffFlowId || ''),
    expectedFirmwareVersion: ['config', 'runtime'].includes(options.mutation) ? String(authorityOptions.expectedFirmwareVersion || '') : '',
    expectedBuildId: ['config', 'runtime'].includes(options.mutation) ? String(authorityOptions.expectedBuildId || '') : '',
  };
  if (Object.keys(current).some(key => current[key] !== lease[key])) {
    throw new Error('The exact card link changed during this operation. Nothing else was authorized.');
  }
  return link;
}
