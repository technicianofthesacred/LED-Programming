import { normalizePortRoles } from './portRoles.js';

// Where discovery's answer lives until the project can carry it.
//
// The canonical home for this data is the project's own `portRoles` field —
// projectModel.js already serializes, deserializes, and normalizes it. What is
// missing is a React state slot for it in ProjectContext, so a value written
// through replaceProject() would be dropped on the next serializeProject().
// Rather than pretend the round trip works, discovery persists its result here
// and reads it back here, and the panel/WireModePanel both read this store.
//
// When ProjectContext grows a `portRoles` slot, this becomes a one-line
// forwarder (or disappears): the shape stored here is exactly the shape
// normalizePortRoles produces, which is exactly the project field's shape.
export const PORT_ROLES_STORAGE_KEY = 'lw_port_roles_v1';
export const PORT_ROLES_CHANGED_EVENT = 'lightweaver-port-roles-changed';

function storage() {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

export function readDiscoveredPortRoles() {
  try {
    const raw = storage()?.getItem(PORT_ROLES_STORAGE_KEY);
    return normalizePortRoles(raw ? JSON.parse(raw) : null);
  } catch {
    // Corrupt or unreadable storage must never break a screen: normalizing
    // nothing returns the full default (all ports unused) array.
    return normalizePortRoles(null);
  }
}

export function writeDiscoveredPortRoles(portRoles) {
  const normalized = normalizePortRoles(portRoles);
  try {
    storage()?.setItem(PORT_ROLES_STORAGE_KEY, JSON.stringify(normalized));
    window.dispatchEvent(new CustomEvent(PORT_ROLES_CHANGED_EVENT, { detail: normalized }));
  } catch { /* an unwritable store still returns the normalized value */ }
  return normalized;
}

// Merge discovery's answer into a serialized project so an export or a card
// package carries it even while ProjectContext cannot hold it.
export function withDiscoveredPortRoles(project) {
  if (!project || typeof project !== 'object') return project;
  return { ...project, portRoles: readDiscoveredPortRoles() };
}

// ── The interrupted discovery run (ui-repair B2) ─────────────────────────────
//
// A reload mid-discovery used to lose the whole run while the card carried on
// playing the temporary setup across every provisioned pixel. The session is
// deliberately plain serializable data (see stripDiscovery.js), so the
// question phases are persisted verbatim and offered back on the next visit.
// Only phases where real progress exists are stored — the port picker and a
// failed bench install have nothing worth resuming.
export const DISCOVERY_RUN_STORAGE_KEY = 'lw_discovery_run_v1';

const RESUMABLE_PHASES = ['probe', 'decade', 'end-marker', 'record'];

export function readDiscoveryRun() {
  try {
    const raw = storage()?.getItem(DISCOVERY_RUN_STORAGE_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value || value.version !== 1) return null;
    if (!value.session || typeof value.session !== 'object') return null;
    if (!RESUMABLE_PHASES.includes(value.session.phase)) return null;
    if (!Array.isArray(value.session.ports)) return null;
    return value;
  } catch {
    return null;
  }
}

export function writeDiscoveryRun({ host = '', session = null, channelProof = null } = {}) {
  if (!session || !RESUMABLE_PHASES.includes(session.phase)) return;
  try {
    storage()?.setItem(DISCOVERY_RUN_STORAGE_KEY, JSON.stringify({
      version: 1, host, session, channelProof, savedAt: Date.now(),
    }));
  } catch { /* an unwritable store simply loses resumability */ }
}

export function clearDiscoveryRun() {
  try { storage()?.removeItem(DISCOVERY_RUN_STORAGE_KEY); } catch { /* nothing to clear */ }
}
