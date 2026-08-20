// Shared mechanics for importing a Studio project from a picked file: read the
// file's text, parse it as JSON, and hand the document to the caller's
// replaceProject (which owns migration and validation).
//
// MECHANICS ONLY. The four import surfaces (top-bar import in app.jsx,
// Preferences' import, Setup's import, and Layout's project load) each follow
// a DIFFERENT association-cleanup policy after a successful replacement —
// which records/cloud attachments they detach, whether the save block clears —
// and that divergence is deliberate until the cleanup unification phase. Each
// call site keeps its own `.then` / `catch` around this helper, byte-for-byte.
export function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = event => resolve(String(event.target.result));
    reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

/**
 * @param {File} file
 * @param {(data: object) => Promise<object>} replaceProject
 * @returns the replaceProject result. Rejects on unreadable files, invalid
 *   JSON, or a throwing replaceProject — callers keep one catch for all three,
 *   exactly as their inline versions did.
 */
export async function importProjectFromFile(file, replaceProject) {
  const data = JSON.parse(await readFileAsText(file));
  return await replaceProject(data);
}
