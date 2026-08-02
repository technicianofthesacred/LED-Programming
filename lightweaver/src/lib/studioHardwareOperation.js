export const STUDIO_HARDWARE_OPERATION_EVENT = 'lw-hardware-operation-active';

const registries = new WeakMap();

function registryFor(target) {
  let registry = registries.get(target);
  if (!registry) {
    registry = new Set();
    registries.set(target, registry);
  }
  return registry;
}

function operationEvent(target, detail) {
  const CustomEventConstructor = target?.CustomEvent || globalThis.CustomEvent;
  if (CustomEventConstructor) return new CustomEventConstructor(STUDIO_HARDWARE_OPERATION_EVENT, { detail });
  const event = new Event(STUDIO_HARDWARE_OPERATION_EVENT);
  Object.defineProperty(event, 'detail', { value: detail });
  return event;
}

export function beginStudioHardwareOperation(operation, target = window) {
  const registry = registryFor(target);
  const token = Symbol(operation);
  const wasInactive = registry.size === 0;
  registry.add(token);
  if (wasInactive) {
    target.dispatchEvent(operationEvent(target, { active: true, operation }));
  }
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    registry.delete(token);
    if (registry.size === 0) {
      target.dispatchEvent(operationEvent(target, { active: false, operation }));
    }
  };
}

export async function withStudioHardwareOperation(operation, task, target = window) {
  const finish = beginStudioHardwareOperation(operation, target);
  try {
    return await task();
  } finally {
    finish();
  }
}
