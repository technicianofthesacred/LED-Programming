# Lightweaver Project Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-pass save/load library for editable Lightweaver Studio projects.

**Architecture:** Keep the existing project serializer and migrator as the source of truth. Add a small browser storage module that stores multiple Studio project snapshots in localStorage, then wire it into the existing Card settings screen beside the file download/import controls.

**Tech Stack:** React 18, Vite, Node test runner, browser localStorage.

---

### Task 1: Project Storage Module

**Files:**
- Create: `lightweaver/src/lib/projectStorage.js`
- Test: `lightweaver/src/lib/projectStorage.test.js`

- [ ] **Step 1: Write failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createProjectLibraryRecord,
  deleteProjectLibraryRecord,
  duplicateProjectLibraryRecord,
  listProjectLibraryRecords,
  saveProjectLibraryRecord,
} from './projectStorage.js';
import { createDefaultProject } from './projectModel.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

test('saves project snapshots and lists them newest first', () => {
  const storage = memoryStorage();
  const first = createProjectLibraryRecord({ ...createDefaultProject(), name: 'First' }, { id: 'a', now: 1000 });
  const second = createProjectLibraryRecord({ ...createDefaultProject(), name: 'Second' }, { id: 'b', now: 2000 });

  saveProjectLibraryRecord(first, { storage });
  saveProjectLibraryRecord(second, { storage });

  assert.deepEqual(listProjectLibraryRecords({ storage }).map(record => record.name), ['Second', 'First']);
});

test('updates an existing saved project without changing createdAt', () => {
  const storage = memoryStorage();
  const first = createProjectLibraryRecord({ ...createDefaultProject(), name: 'Original' }, { id: 'a', now: 1000 });
  saveProjectLibraryRecord(first, { storage });

  saveProjectLibraryRecord({ ...first, name: 'Renamed', project: { ...first.project, name: 'Renamed' } }, { storage, now: 3000 });

  const [record] = listProjectLibraryRecords({ storage });
  assert.equal(record.name, 'Renamed');
  assert.equal(record.createdAt, 1000);
  assert.equal(record.updatedAt, 3000);
});

test('duplicates and deletes saved project records', () => {
  const storage = memoryStorage();
  const first = createProjectLibraryRecord({ ...createDefaultProject(), name: 'Original' }, { id: 'a', now: 1000 });
  saveProjectLibraryRecord(first, { storage });

  const copy = duplicateProjectLibraryRecord('a', { storage, id: 'b', now: 2000 });
  assert.equal(copy.name, 'Original copy');
  assert.deepEqual(listProjectLibraryRecords({ storage }).map(record => record.id), ['b', 'a']);

  deleteProjectLibraryRecord('a', { storage });
  assert.deepEqual(listProjectLibraryRecords({ storage }).map(record => record.id), ['b']);
});
```

- [ ] **Step 2: Run tests and confirm they fail**

Run: `cd lightweaver && node --test src/lib/projectStorage.test.js`

Expected: failure because `projectStorage.js` does not exist yet.

- [ ] **Step 3: Implement minimal storage helpers**

Create synchronous localStorage helpers for list, create, save/update, duplicate, delete, and id generation. Validate project payloads through `migrateProject()`.

- [ ] **Step 4: Run storage tests and confirm they pass**

Run: `cd lightweaver && node --test src/lib/projectStorage.test.js`

Expected: all tests pass.

### Task 2: Card Settings UI

**Files:**
- Modify: `lightweaver/src/components/ChipScreen.jsx`
- Modify: `lightweaver/src/main.css`

- [ ] **Step 1: Add a compact Studio project library section**

Use the existing `Section` and `FieldRow` components. Add save/open/duplicate/delete actions and keep the existing file download/open controls.

- [ ] **Step 2: Style the project list**

Add dense rows consistent with the card settings surface: restrained borders, small metadata, no modal-first interaction.

- [ ] **Step 3: Run build and focused tests**

Run:

```bash
cd lightweaver
npm run test:unit
npm run build
```

Expected: unit tests and production build pass.
