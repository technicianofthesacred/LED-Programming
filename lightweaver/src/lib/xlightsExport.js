import { compileFixturePatch } from './madrixPatchExport.js';

const MAX_XLIGHTS_GRID_CELLS = 1_000_000;
const MAX_MODEL_NAME_LENGTH = 200;

function xmlAttribute(value, label) {
  const text = String(value ?? '');
  if (text.length > MAX_MODEL_NAME_LENGTH && label === 'model name') {
    throw new RangeError(`xLights ${label} exceeds ${MAX_MODEL_NAME_LENGTH} characters`);
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
    throw new TypeError(`xLights ${label} contains characters XML 1.0 cannot represent`);
  }
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('\r', '&#13;')
    .replaceAll('\n', '&#10;');
}

function coordinateKey(x, y, z) {
  return `${x}\u0000${y}\u0000${z}`;
}

function compressNodeIds(values) {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let end = start;
  for (const value of sorted.slice(1)) {
    if (value === end + 1) {
      end = value;
    } else {
      ranges.push(start === end ? `${start}` : `${start}-${end}`);
      start = value;
      end = value;
    }
  }
  if (start !== undefined) ranges.push(start === end ? `${start}` : `${start}-${end}`);
  return ranges.join(',');
}

function submodel(name, nodeIds) {
  return `  <subModel name="${xmlAttribute(name, 'submodel name')}" layout="horizontal" type="ranges" line0="${compressNodeIds(nodeIds)}"/>`;
}

function customModelData(fixtures) {
  const exactCoordinates = new Set();
  for (const fixture of fixtures) {
    const key = coordinateKey(fixture.x, fixture.y, fixture.z);
    if (exactCoordinates.has(key)) {
      throw new TypeError('Two physical pixels occupy the same x/y/z coordinate; xLights export would be lossy');
    }
    exactCoordinates.add(key);
  }
  const minX = Math.floor(Math.min(...fixtures.map(fixture => fixture.x)));
  const maxX = Math.ceil(Math.max(...fixtures.map(fixture => fixture.x)));
  const minY = Math.floor(Math.min(...fixtures.map(fixture => fixture.y)));
  const maxY = Math.ceil(Math.max(...fixtures.map(fixture => fixture.y)));
  const minZ = Math.floor(Math.min(...fixtures.map(fixture => fixture.z)));
  const maxZ = Math.ceil(Math.max(...fixtures.map(fixture => fixture.z)));
  let scale = 1;
  for (; scale <= 100; scale += 1) {
    const cells = new Set(fixtures.map(fixture => coordinateKey(
      Math.trunc((fixture.x - minX) * scale),
      Math.trunc((fixture.y - minY) * scale),
      Math.trunc((fixture.z - minZ) * scale),
    )));
    if (cells.size === fixtures.length) break;
  }
  if (scale > 100) {
    throw new RangeError('xLights coordinates cannot be represented without collision at the supported resolution');
  }
  const width = (maxX - minX + 1) * scale;
  const height = (maxY - minY + 1) * scale;
  const depth = (maxZ - minZ + 1) * scale;
  const cellCount = width * height * depth;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_XLIGHTS_GRID_CELLS) {
    throw new RangeError(`xLights coordinate grid exceeds the ${MAX_XLIGHTS_GRID_CELLS}-cell limit`);
  }
  const layers = Array.from({ length: depth }, () => (
    Array.from({ length: height }, () => Array(width).fill(''))
  ));
  fixtures.forEach((fixture, index) => {
    const x = Math.trunc((fixture.x - minX) * scale);
    const y = height - Math.trunc((fixture.y - minY) * scale) - 1;
    const z = Math.trunc((fixture.z - minZ) * scale);
    layers[z][y][x] = String(index + 1);
  });
  return {
    width,
    height,
    depth,
    data: layers.map(layer => layer.map(row => row.join(',')).join(';')).join('|'),
  };
}

function xlightsConnectionMetadata(input, fixtures) {
  const outputEntries = (input.wiring?.outputs || []).map((output, wiringIndex) => {
    const nodes = fixtures
      .map((fixture, index) => ({ fixture, nodeId: index + 1 }))
      .filter(item => item.fixture.outputId === String(output.id));
    return { output, wiringIndex, nodes };
  }).filter(entry => entry.nodes.length > 0);
  if (!outputEntries.length) throw new TypeError('xLights export requires at least one active physical output');
  for (let index = 1; index < outputEntries.length; index += 1) {
    if (outputEntries[index].wiringIndex !== outputEntries[index - 1].wiringIndex + 1) {
      throw new TypeError('xLights cannot preserve non-consecutive active controller output ports in one custom model');
    }
  }
  const configuredFirstPort = Number(input.xlights?.firstPort ?? 1);
  if (!Number.isSafeInteger(configuredFirstPort) || configuredFirstPort < 1) {
    throw new RangeError('xLights first controller port must be a positive integer');
  }
  const firstPort = configuredFirstPort + outputEntries[0].wiringIndex;
  const protocol = String(input.xlights?.protocol || 'ws2811').trim().toLowerCase();
  if (!protocol) throw new TypeError('xLights controller protocol is required');
  return {
    controllerName: String(input.xlights?.controllerName || '').trim(),
    firstPort,
    protocol,
    outputEntries,
  };
}

export function toXlightsXmodel(input = {}) {
  const { fixtures } = compileFixturePatch({ ...input, artnet: undefined });
  const model = customModelData(fixtures);
  const connection = xlightsConnectionMetadata(input, fixtures);
  const stringAttributes = connection.outputEntries
    .map((entry, index) => ` NodeStart${index + 1}="${entry.nodes[0].nodeId}"`)
    .join('');
  const controllerAttribute = connection.controllerName
    ? ` Controller="${xmlAttribute(connection.controllerName, 'controller name')}"`
    : '';
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<custommodel name="${xmlAttribute(input.name || 'Untitled Project', 'model name')}" CustomWidth="${model.width}" CustomHeight="${model.height}" Depth="${model.depth}" StringType="RGB Nodes" Transparency="0" PixelSize="2" ModelBrightness="0" Antialias="1" CustomStrings="${connection.outputEntries.length}"${stringAttributes}${controllerAttribute} CustomModel="${xmlAttribute(model.data, 'custom model data')}" SourceVersion="Lightweaver 1">`,
    `  <ControllerConnection Port="${connection.firstPort}" Protocol="${xmlAttribute(connection.protocol, 'controller protocol')}"/>`,
  ];

  for (const output of input.wiring.outputs) {
    const nodes = fixtures
      .map((fixture, index) => ({ fixture, nodeId: index + 1 }))
      .filter(item => item.fixture.outputId === String(output.id));
    if (!nodes.length) continue;
    const directions = [...new Set(nodes.map(item => item.fixture.direction))];
    lines.push(submodel(
      `Output ${String(output.name || output.id)} · ${directions.length === 1 ? directions[0] : 'mixed'}`,
      nodes.map(item => item.nodeId),
    ));
  }

  const groupOrder = [];
  const nodesByGroup = new Map();
  fixtures.forEach((fixture, index) => {
    if (!nodesByGroup.has(fixture.groupId)) {
      nodesByGroup.set(fixture.groupId, []);
      groupOrder.push({ id: fixture.groupId, label: fixture.groupName });
    }
    nodesByGroup.get(fixture.groupId).push(index + 1);
  });
  for (const group of groupOrder) {
    lines.push(submodel(`Group ${group.label}`, nodesByGroup.get(group.id)));
  }
  lines.push('</custommodel>', '');
  return lines.join('\n');
}
