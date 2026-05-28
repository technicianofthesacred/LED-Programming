export function parseParamsFromCode(code = '') {
  const re = /\/\/ @param\s+(\w+)\s+\w+\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/g;
  const params = [];
  let match;
  while ((match = re.exec(String(code))) !== null) {
    const value = Number.parseFloat(match[2]);
    const min = Number.parseFloat(match[3]);
    const max = Number.parseFloat(match[4]);
    if (![value, min, max].every(Number.isFinite)) continue;
    const range = max - min;
    const step = range <= 1 ? 0.01 : range <= 10 ? 0.1 : 0.5;
    params.push({ name: match[1], value, min, max, step });
  }
  return params;
}
