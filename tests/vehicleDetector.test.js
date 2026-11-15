import assert from 'node:assert/strict';
import test from 'node:test';
import { createVehicleDetector } from '../src/components/vehicleDetector.js';

test('concurrent callers share one model load and failures can be retried', async () => {
  const model = { dispose() {} };
  let attempts = 0;
  const detector = createVehicleDetector(async () => {
    if (++attempts === 1) throw new Error('offline');
    return model;
  });

  const firstLoad = detector.load();
  assert.equal(firstLoad, detector.load());
  await assert.rejects(firstLoad, /offline/);
  assert.equal(await detector.load(), model);
  assert.equal(await detector.load(), model);
  assert.equal(attempts, 2);
  detector.dispose();
});

test('a model that finishes loading after disposal is released', async () => {
  let disposals = 0;
  const detector = createVehicleDetector(async () => ({
    dispose() { disposals += 1; },
  }));

  const loading = detector.load();
  detector.dispose();
  assert.equal(await loading, null);
  assert.equal(await detector.load(), null);
  assert.equal(disposals, 1);
});

test('an active prediction is not duplicated and retains the model until it settles', async () => {
  const { promise, resolve } = Promise.withResolvers();
  let disposals = 0;
  const detector = createVehicleDetector(async () => ({
    detect(input, limit) {
      assert.equal(input, 'image');
      assert.equal(limit, 8);
      return promise;
    },
    dispose() { disposals += 1; },
  }));

  await detector.load();
  const prediction = detector.predict('image', 8);
  assert.equal(detector.predict('image', 8), null);
  detector.dispose();
  assert.equal(disposals, 0);
  resolve(['bus']);
  assert.deepEqual(await prediction, ['bus']);
  assert.equal(disposals, 1);
  assert.equal(detector.predict('image', 8), null);
});
