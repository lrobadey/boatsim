import './register-ts.mjs';
import assert from 'node:assert/strict';

const { DEFAULT_EPOCH: E, dateOn, formatDate, moonPhaseOn, nextNewYearDay } = await import('../src/world/calendar.ts');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { failed++; console.log(`FAIL ${name}\n     ${String(e.message).split('\n').join('\n     ')}`); }
}

test('day 0 is 13 Skirophorion and the year turns at 1 Hekatombaion', () => {
  assert.equal(formatDate(dateOn(E, 0)), '13 Skirophorion · Year 1');
  assert.equal(dateOn(E, 0).monthLength, 29);
  assert.equal(formatDate(dateOn(E, 16)), '29 Skirophorion · Year 1');
  assert.equal(formatDate(dateOn(E, 17)), '1 Hekatombaion · Year 2');
  assert.equal(nextNewYearDay(E, 0), 17);
});

test('month starts fall on the expected days', () => {
  const starts = [];
  for (let d = -20; d <= 380; d++) if (dateOn(E, d).day === 1) starts.push(d);
  assert.deepEqual(starts, [-12, 17, 47, 76, 106, 135, 165, 195, 224, 254, 283, 313, 342, 372]);
});

test('each day steps to the next day, the next month, or the next year', () => {
  for (let d = -400; d <= 7300; d++) {
    const a = dateOn(E, d);
    const b = dateOn(E, d + 1);
    const sameMonth = b.year === a.year && b.month === a.month && b.day === a.day + 1;
    const nextMonth = b.year === a.year && b.month === a.month + 1 && b.day === 1;
    const nextYear = b.year === a.year + 1 && b.month === 0 && b.day === 1;
    assert.ok(sameMonth || nextMonth || nextYear, `day ${d + 1}: ${formatDate(a)} then ${formatDate(b)}`);
    assert.ok(a.monthLength === 29 || a.monthLength === 30, `day ${d}: monthLength ${a.monthLength}`);
    assert.equal(a.day === 1, moonPhaseOn(E, d) < moonPhaseOn(E, d - 1), `day ${d}: month start vs moon phase`);
  }
});

test('some year has 13 months and contains Poseideon II', () => {
  let found = false;
  for (let d = -400; d <= 7300 && !found; d++) {
    const x = dateOn(E, d);
    if (x.monthName === 'Poseideon II') {
      assert.equal(x.intercalary, true);
      found = true;
    }
  }
  assert.ok(found, 'no Poseideon II day in range');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
