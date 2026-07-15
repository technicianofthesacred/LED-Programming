function normalizePlatform({ userAgent, platform, maxTouchPoints }) {
  const browserIdentity = `${platform} ${userAgent}`;
  const isIpad = maxTouchPoints > 1 && /Mac(?:Intel|intosh)/i.test(browserIdentity);

  if (/Android/i.test(userAgent)) return 'android';
  if (isIpad || /iPhone|iPad|iPod/i.test(browserIdentity)) return 'ios';
  if (/Windows|Win32|Win64|WinCE/i.test(browserIdentity)) return 'windows';
  if (/CrOS|Linux|X11/i.test(browserIdentity)) return 'linux';
  if (/Macintosh|MacIntel|MacPPC|Mac68K/i.test(browserIdentity)) return 'macos';
  return 'unknown';
}

export function detectPlatformCapabilities({
  secureContext = false,
  topLevel = false,
  serial = null,
  userAgent = '',
  platform = '',
  maxTouchPoints = 0,
} = {}) {
  const normalizedUserAgent = String(userAgent || '');
  const normalizedPlatform = normalizePlatform({
    userAgent: normalizedUserAgent,
    platform: String(platform || ''),
    maxTouchPoints: Number(maxTouchPoints) || 0,
  });
  const isMobile = normalizedPlatform === 'android'
    || normalizedPlatform === 'ios'
    || /Mobile/i.test(normalizedUserAgent);
  const observedSecureContext = secureContext === true;
  const observedTopLevel = topLevel === true;

  return {
    topLevel: observedTopLevel,
    embedded: !observedTopLevel,
    secureContext: observedSecureContext,
    canWebSerialInstall: observedSecureContext && observedTopLevel && Boolean(serial),
    mustEscapeToSecureInstaller: !observedSecureContext || !observedTopLevel,
    canControlInstalledCard: true,
    isMobile,
    platform: normalizedPlatform,
    handoffKind: isMobile || normalizedPlatform === 'unknown'
      ? 'supported-device-handoff'
      : 'supported-browser-handoff',
  };
}
