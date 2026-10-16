import './register-ts.mjs';
import assert from 'node:assert/strict';

const { addOrder, newJob } = await import('../src/trade/job.ts');
const { formatHandlingDuration, handlingStatus } = await import('../src/trade/handlingStatus.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`); }
}

test('status reports the active good even when a higher-priority unload is pending', () => {
  const job = newJob(0, 0);
  addOrder(job, { wine: 1 }, { wheat: 2 });
  job.active = { good: 'wheat', direction: 'load', workKg: 20 };
  const status = handlingStatus(job, 5, null);
  assert.deepEqual(status, {
    phase: 'load', good: 'wheat', units: 3, hours: 0.255,
    label: 'Loading wheat', detail: '3 left · 16 min',
  });
});

test('status selects the scheduler next good when no unit is active', () => {
  const job = newJob(0, 0);
  addOrder(job, { wine: 1 }, { wheat: 2 });
  const status = handlingStatus(job, 5, null);
  assert.equal(status.phase, 'unload');
  assert.equal(status.good, 'wine');
  assert.equal(status.label, 'Unloading wine');
});

test('disconnected pending handling is paused and keeps the remaining work estimate', () => {
  const job = newJob(7, 14);
  addOrder(job, {}, { honey: 2 });
  job.active = { good: 'honey', direction: 'load', workKg: 5 };
  assert.deepEqual(handlingStatus(job, 5, null, { connected: false, portName: 'Kormakos' }), {
    phase: 'paused', good: 'honey', units: 2, hours: 0.1125,
    label: 'Handling paused', detail: 'Return to Kormakos berth · 2 left',
  });
});

test('an empty completed job and open hatch aftermath are ready to cast off', () => {
  assert.equal(handlingStatus(newJob(0, 0), 5, null).detail, 'Ready to cast off');
  assert.equal(handlingStatus(null, 5, 6).label, 'Cargo handled');
  assert.equal(handlingStatus(null, 6, 6).phase, 'idle');
});

test('idle is empty and duration rounds positive work upward to whole minutes', () => {
  assert.deepEqual(handlingStatus(null, 5, null), { phase: 'idle', good: null, units: 0, hours: 0, label: '', detail: '' });
  assert.equal(formatHandlingDuration(0), '0 min');
  assert.equal(formatHandlingDuration(0.00001), '1 min');
  assert.equal(formatHandlingDuration(1 + 1 / 60), '1 h 1 min');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
