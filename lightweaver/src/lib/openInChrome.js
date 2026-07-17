export const CHROME_OPEN_FALLBACK_MESSAGE = 'Link copied — paste it into Chrome.';
export const CHROME_OPEN_FALLBACK_DELAY_MS = 1400;

export function buildChromeLaunchUrl(currentUrl) {
  return `google-chrome://${currentUrl}`;
}

export function openInChrome({
  currentUrl,
  copyText,
  launch,
  scheduleFallback = (callback) => setTimeout(callback, CHROME_OPEN_FALLBACK_DELAY_MS),
  isPageVisible,
  onFallback,
}) {
  const exactUrl = String(currentUrl);
  let copyResult;

  try {
    copyResult = Promise.resolve(copyText(exactUrl)).catch(() => false);
  } catch {
    copyResult = Promise.resolve(false);
  }

  launch(buildChromeLaunchUrl(exactUrl));

  scheduleFallback(async () => {
    if (!isPageVisible()) return;
    await copyResult;
    onFallback(CHROME_OPEN_FALLBACK_MESSAGE);
  }, CHROME_OPEN_FALLBACK_DELAY_MS);
}
