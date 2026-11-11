import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.mjs';

test('event receipts survive restart and suppress cross-backend replay without swallowing ordinary repeated messages', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-event-receipts-'));
  let store;
  const event = { actualQQ: '12345678', backend: 'napcat', key: 'group:1', crossKey: 'same-source-message' };
  try {
    store = createStore(directory);
    assert.equal(store.claimEvent(event), true);
    store.close(); store = createStore(directory);
    assert.equal(store.claimEvent(event), false);
    assert.equal(store.claimEvent({ ...event, key: 'different-native-id', backend: 'snowluma' }), false);
    assert.equal(store.claimEvent({ ...event, key: 'ordinary-repeat-new-id' }), true);
    assert.equal(store.claimEvent({ ...event, actualQQ: '87654321' }), true);
  } finally { store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('short replay suppression expires so it cannot permanently suppress a new interaction', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-event-expiry-'));
  const original = Date.now, start = original(); let store;
  try {
    Date.now = () => start;
    store = createStore(directory);
    const event = { actualQQ: '12345678', backend: 'napcat', key: 'first-id', crossKey: 'same-fingerprint' };
    assert.equal(store.claimEvent(event), true);
    Date.now = () => start + 121_000;
    assert.equal(store.claimEvent({ ...event, backend: 'snowluma', key: 'new-id' }), true);
  } finally { Date.now = original; store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
