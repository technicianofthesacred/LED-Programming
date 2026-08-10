let activeInspection = null;
let nextInspectionId = 1;

function cleanCardId(value) {
  return String(value || '').trim().slice(0, 64);
}

export function registerActiveUsbInspection({ cardId, release } = {}) {
  const id = cleanCardId(cardId);
  if (!id) throw new TypeError('An exact USB-inspected card id is required.');
  if (typeof release !== 'function') throw new TypeError('A USB inspection release function is required.');
  const token = Object.freeze({ inspectionId: nextInspectionId++, cardId: id });
  activeInspection = { token, release, releasePromise: null };
  return token;
}

export function getActiveUsbInspection() {
  return activeInspection?.token || null;
}

export function clearActiveUsbInspection(token) {
  if (!activeInspection || (token && activeInspection.token !== token)) return false;
  activeInspection = null;
  return true;
}

export async function releaseActiveUsbInspection() {
  const inspection = activeInspection;
  if (!inspection) return Object.freeze({ released: true, cardId: '' });
  if (inspection.releasePromise) return inspection.releasePromise;
  inspection.releasePromise = (async () => {
    const released = await inspection.release();
    if (released === false) return Object.freeze({ released: false, cardId: inspection.token.cardId });
    if (activeInspection === inspection) activeInspection = null;
    return Object.freeze({ released: true, cardId: inspection.token.cardId });
  })();
  try { return await inspection.releasePromise; }
  finally { inspection.releasePromise = null; }
}
