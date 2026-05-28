import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { normalizeUsbLedColorOrder } from '../src/lib/usbLedColorOrder.js';

export function readUsbLedConfig(configPath) {
  if (!configPath || !existsSync(configPath)) return {};
  try {
    const data = JSON.parse(readFileSync(configPath, 'utf8'));
    return {
      colorOrder: data.colorOrder ? normalizeUsbLedColorOrder(data.colorOrder) : undefined,
    };
  } catch {
    return {};
  }
}

export function writeUsbLedConfig(configPath, config = {}) {
  if (!configPath) return {};
  const next = {
    colorOrder: normalizeUsbLedColorOrder(config.colorOrder),
  };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}
