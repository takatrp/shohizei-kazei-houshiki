const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../tax-calendar.js');

test('暦月の期間・期限は月末を繰り上げずに計算する', () => {
  assert.equal(C.periodEnd('2026-01-01',1),'2026-01-31');
  assert.equal(C.periodEnd('2026-01-01',3),'2026-03-31');
  assert.equal(C.deadlineAfterPeriod('2026-02-28'),'2026-04-30');
  assert.equal(C.deadlineFromStart('2026-01-01',2),'2026-04-30');
  assert.equal(C.deadlineFromStart('2026-01-01',3),'2026-05-31');
  assert.equal(C.periodEnd('2024-02-01',1),'2024-02-29');
  assert.equal(C.deadlineAfterPeriod('2024-02-29'),'2024-04-30');
  assert.equal(C.priorMonths('2025-07-01','2025-12-31'),6);
  assert.equal(C.priorMonths('2025-07-15','2026-01-14'),6);
  assert.equal(C.priorMonths('2025-08-31','2026-02-28'),null);
});

test('2026年の国税庁公表期限に一致する休日繰延べ', () => {
  assert.deepEqual(C.adjustDueDate('2026-05-31').adjustedDueDate,'2026-06-01');
  assert.equal(C.adjustDueDate('2026-08-31').adjustedDueDate,'2026-08-31');
  assert.equal(C.adjustDueDate('2026-10-31').adjustedDueDate,'2026-11-02');
  assert.equal(C.adjustDueDate('2026-12-31').adjustedDueDate,'2027-01-04');
  assert.equal(C.adjustDueDate('2027-01-31').adjustedDueDate,'2027-02-01');
});

test('公表済み祝日と将来の暫定休日を区別する', () => {
  assert.equal(C.holidayInfo('2026-09-22').closed,true);
  assert.equal(C.holidayInfo('2027-03-22').closed,true);
  assert.equal(C.holidayInfo('2028-03-20').confidence,'provisional');
  assert.equal(C.adjustDueDate('2028-04-29').confidence,'provisional');
  assert.equal(C.adjustDueDate('2026-12-31').confidence,'official');
  assert.equal(C.VERSION.startsWith('cabinet-2026-2027'),true);
});

test('不正な日付をタイムゾーンやDateの自動補正で通さない', () => {
  for(const value of ['2026-02-29','2026-13-01','2026-01-00','','2026/01/01']) assert.equal(C.parseDate(value),null);
  assert.equal(C.adjustDueDate('2026-02-29').status,'unavailable');
  assert.equal(C.adjustDueDate('2100-05-31').status,'unavailable');
  assert.equal(C.shiftMonths('2026-01-31',1),'2026-02-28');
});
