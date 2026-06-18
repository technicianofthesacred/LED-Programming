import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadTextFile } from './downloadFile.js';

function fakeDocument() {
  const calls = [];
  const body = {
    appendChild(node) {
      calls.push(['append', node.download]);
      node.isConnected = true;
    },
    removeChild(node) {
      calls.push(['remove', node.download]);
      node.isConnected = false;
    },
  };
  return {
    calls,
    body,
    createElement(tag) {
      assert.equal(tag, 'a');
      return {
        style: {},
        click() {
          calls.push(['click', this.download, this.href]);
        },
      };
    },
  };
}

test('downloadTextFile appends the download link before clicking it', async () => {
  const doc = fakeDocument();
  const urlApi = {
    createObjectURL(blob) {
      assert.equal(blob.type, 'application/json');
      return 'blob:project';
    },
    revokeObjectURL(url) {
      doc.calls.push(['revoke', url]);
    },
  };

  const ok = await downloadTextFile('project.lwproj.json', '{"ok":true}', {
    document: doc,
    URL: urlApi,
    type: 'application/json',
  });

  assert.equal(ok, true);
  assert.deepEqual(doc.calls, [
    ['append', 'project.lwproj.json'],
    ['click', 'project.lwproj.json', 'blob:project'],
    ['remove', 'project.lwproj.json'],
    ['revoke', 'blob:project'],
  ]);
});

test('downloadTextFile uses the save file picker when available', async () => {
  const calls = [];
  const writable = {
    async write(blob) {
      calls.push(['write', blob.type]);
    },
    async close() {
      calls.push(['close']);
    },
  };

  const ok = await downloadTextFile('project.lwproj.json', '{"ok":true}', {
    type: 'application/json',
    showSaveFilePicker: async options => {
      calls.push(['picker', options.suggestedName]);
      return {
        async createWritable() {
          calls.push(['createWritable']);
          return writable;
        },
      };
    },
  });

  assert.equal(ok, true);
  assert.deepEqual(calls, [
    ['picker', 'project.lwproj.json'],
    ['createWritable'],
    ['write', 'application/json'],
    ['close'],
  ]);
});
