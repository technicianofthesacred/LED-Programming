export const MAPPER_PROJECT_FORMAT = 'lightweaver.mapper-project';
export const MAPPER_PROJECT_SCHEMA_VERSION = 3;

export function validateMapperProject(project) {
  if (!project || typeof project !== 'object' || Array.isArray(project)) {
    return { ok: false, reason: 'This file does not contain an LED Mapper project.' };
  }

  if (project.format === MAPPER_PROJECT_FORMAT) {
    if (project.schemaVersion !== MAPPER_PROJECT_SCHEMA_VERSION) {
      return {
        ok: false,
        reason: `This LED Mapper project uses unsupported schema version ${String(project.schemaVersion)}.`,
      };
    }
    if (!Array.isArray(project.strips)) {
      return { ok: false, reason: 'This LED Mapper project has no valid section list.' };
    }
    return { ok: true, legacy: false };
  }

  if (project.format) {
    return { ok: false, reason: `This file belongs to another tool (${project.format}).` };
  }

  if (project.physicalLayout || project.looks || project.standaloneController) {
    return {
      ok: false,
      reason: 'This is a Lightweaver Studio project, not an LED Mapper project.',
    };
  }

  const looksLikeLegacyMapper =
    project.version === 3 &&
    Array.isArray(project.strips) &&
    Object.hasOwn(project, 'svgSource') &&
    (Object.hasOwn(project, 'activePatternId') || Array.isArray(project.palette));

  if (looksLikeLegacyMapper) return { ok: true, legacy: true };

  return { ok: false, reason: 'This file is not a recognized LED Mapper project.' };
}

export function describeMapperProject(project) {
  const strips = Array.isArray(project?.strips) ? project.strips : [];
  const patterns = Array.isArray(project?.patterns)
    ? project.patterns
    : Array.isArray(project?.customPatterns) ? project.customPatterns : [];
  const pixels = strips.reduce((total, strip) => (
    total + Math.max(0, Number(strip?.pixelCount) || 0)
  ), 0);

  return [
    `${strips.length} section${strips.length === 1 ? '' : 's'}`,
    `${pixels} LED${pixels === 1 ? '' : 's'}`,
    `${patterns.length} pattern${patterns.length === 1 ? '' : 's'}`,
  ].join(' · ');
}
