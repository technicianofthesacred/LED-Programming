const encoder = new TextEncoder();

export function productionWiringProjection(led = {}) {
  return {
    version: 1,
    colorOrder: String(led.colorOrder || ''),
    maxMilliamps: Number(led.maxMilliamps),
    outputs: (led.outputs || []).map(output => ({
      id: String(output.id || ''),
      pin: Number(output.pin),
      pixels: Number(output.pixels),
      segments: (output.segments || []).map(segment => ({
        id: String(segment.id || ''),
        count: Number(segment.count),
        direction: String(segment.direction || 'forward'),
      })),
    })),
  };
}

export async function productionWiringDigest(led, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) throw new Error('Secure wiring digest verification is unavailable.');
  const bytes = encoder.encode(JSON.stringify(productionWiringProjection(led)));
  const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function assignProductionWiringIdentity(config, { cryptoImpl = globalThis.crypto, revision } = {}) {
  const nextRevision = revision ?? config?.wiringRevision ?? 1;
  if (!Number.isSafeInteger(nextRevision) || nextRevision < 1 || nextRevision > 0xffffffff) throw new Error('Production wiring revision is invalid.');
  config.wiringRevision = nextRevision;
  config.wiringDigest = await productionWiringDigest(config.led, cryptoImpl);
  return config;
}
