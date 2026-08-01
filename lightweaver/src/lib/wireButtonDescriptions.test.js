import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const layoutRoot = join(import.meta.dirname, '..', 'components', 'layout');

function openingButtonTags(source) {
  const tags = [];
  let start = -1;
  let quote = null;
  let braces = 0;

  for (let index = 0; index < source.length; index += 1) {
    if (start === -1) {
      if (source.startsWith('<button', index) && /[\s>]/.test(source[index + 7] || '>')) start = index;
      continue;
    }

    const character = source[index];
    if (quote) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === '{') braces += 1;
    else if (character === '}') braces -= 1;
    else if (character === '>' && braces === 0) {
      tags.push(source.slice(start, index + 1));
      start = -1;
    }
  }

  return tags;
}

function attributeValue(tag, name) {
  let index = '<button'.length;

  while (index < tag.length) {
    while (/\s/.test(tag[index])) index += 1;
    const attributeStart = index;
    while (/[\w-]/.test(tag[index])) index += 1;
    if (attributeStart === index) return undefined;
    const attributeName = tag.slice(attributeStart, index);
    while (/\s/.test(tag[index])) index += 1;
    if (tag[index] !== '=') continue;
    index += 1;
    while (/\s/.test(tag[index])) index += 1;
    const valueStart = index;

    if (tag[index] === '"' || tag[index] === "'") {
      const quote = tag[index++];
      while (index < tag.length && tag[index] !== quote) index += tag[index] === '\\' ? 2 : 1;
      index += 1;
    } else if (tag[index] === '{') {
      let braces = 0;
      let quote = null;
      do {
        const character = tag[index++];
        if (quote) {
          if (character === '\\') index += 1;
          else if (character === quote) quote = null;
        } else if (character === '"' || character === "'" || character === '`') quote = character;
        else if (character === '{') braces += 1;
        else if (character === '}') braces -= 1;
      } while (index < tag.length && braces > 0);
    } else {
      while (index < tag.length && !/[\s>]/.test(tag[index])) index += 1;
    }

    if (attributeName === name) return tag.slice(valueStart, index).replace(/\s+/g, ' ');
  }

  return undefined;
}

function assertDescriptionTag(tag, file) {
  assert.match(tag, /\bdata-tooltip\s*=/, `${file}: button needs data-tooltip`);
  assert.match(tag, /\btitle\s*=/, `${file}: button needs title`);
  assert.equal(attributeValue(tag, 'title'), attributeValue(tag, 'data-tooltip'), `${file}: title and data-tooltip must match`);
}

function assertDescriptions(files) {
  for (const file of files) {
    for (const tag of openingButtonTags(readFileSync(file, 'utf8'))) {
      assertDescriptionTag(tag, file);
    }
  }
}

test('rejects mismatched title and data-tooltip values', () => {
  assert.throws(
    () => assertDescriptionTag('<button title="Fallback" data-tooltip="Hover">', 'synthetic.jsx'),
    /title and data-tooltip must match/,
  );
});

test('main Wire buttons provide hover descriptions', () => {
  assertDescriptions([
    join(layoutRoot, 'modes', 'WireModePanel.jsx'),
    join(layoutRoot, 'shared', 'CardPushControl.jsx'),
  ]);
});

test('nested Wire buttons provide hover descriptions', () => {
  const wireRoot = join(layoutRoot, 'wire');
  assertDescriptions(readdirSync(wireRoot, { recursive: true })
    .filter(file => file.endsWith('.jsx'))
    .map(file => join(wireRoot, file)));
});
