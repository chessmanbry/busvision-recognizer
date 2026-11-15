import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecognitionStore } from '../src/services/recognitionStorage.js';

function fixture(initial = '[]') {
  let contents = initial;
  let writes = 0;
  let failWrite = false;
  const store = createRecognitionStore({
    readFile: async () => ({ data: contents }),
    writeFile: async ({ data }) => {
      if (failWrite) throw new Error('disk full');
      contents = data;
      writes += 1;
    },
  });
  return { store, writes: () => writes, fail: (value) => { failWrite = value; } };
}

test('concurrent append and correction retain all records and legacy fields', async () => {
  const { store } = fixture('[{"id":"old","legacy":true}]');
  await Promise.all([
    store.appendLog({ id: 'new', routeNumber: '307' }),
    store.updateLog('old', { correctedRouteNumber: '932', isConfirmed: true }),
  ]);
  assert.deepEqual(await store.readLogs(), [
    { id: 'old', legacy: true, correctedRouteNumber: '932', isConfirmed: true },
    { id: 'new', routeNumber: '307' },
  ]);
});
test('corrupt JSON and invalid records cannot be overwritten', async () => {
  for (const text of ['{', '{}', '[null]']) {
    const { store, writes } = fixture(text);
    await assert.rejects(store.appendLog({ id: 'new' }));
    assert.equal(writes(), 0);
  }
});
test('a write failure does not poison the queue', async () => {
  const f = fixture();
  f.fail(true);
  await assert.rejects(f.store.appendLog({ id: 'fail' }), /disk full/);
  f.fail(false);
  await f.store.appendLog({ id: 'ok' });
  assert.deepEqual(await f.store.readLogs(), [{ id: 'ok' }]);
});
test('missing file is empty while permission failure propagates', async () => {
  const missing = createRecognitionStore({ readFile: async () => { throw { code: 'OS-PLUG-FILE-0008' }; } });
  assert.deepEqual(await missing.readLogs(), []);
  const denied = createRecognitionStore({ readFile: async () => { throw new Error('permission denied'); } });
  await assert.rejects(denied.readLogs(), /permission denied/);
});
test('clear is serialized and stale edits cannot restore cleared records', async () => {
  const { store } = fixture('[{"id":"old"}]');
  await store.clearLogs();
  await assert.rejects(store.updateLog('old', { routeNumber: '932' }), /已移除/);
  assert.deepEqual(await store.readLogs(), []);
});
