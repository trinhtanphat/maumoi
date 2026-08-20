import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVnPhone,
  maskPhone,
  inventoryAvailable,
  reconciliationVariance,
  parseCsv,
  toCsv,
  validateIdempotencyKey,
  businessDateVn,
} from '../src/shared/core.js';

test('normalizeVnPhone canonicalizes local and +84 mobile numbers', () => {
  assert.equal(normalizeVnPhone('0912 345 678'), '84912345678');
  assert.equal(normalizeVnPhone('+84 912-345-678'), '84912345678');
});

test('normalizeVnPhone rejects malformed Vietnamese phone numbers', () => {
  assert.throws(() => normalizeVnPhone('12345'), /VALIDATION_ERROR/);
});

test('maskPhone hides the middle digits', () => {
  assert.equal(maskPhone('84912345678'), '849****5678');
});

test('inventoryAvailable derives immutable inventory math', () => {
  assert.equal(inventoryAvailable({ allocated: 10, adjustments: -1, distributed: 4 }), 5);
});

test('reconciliationVariance follows assigned - distributed - returned - damaged - closing', () => {
  assert.equal(reconciliationVariance({ assigned: 10, distributed: 4, returned: 1, damaged: 1, closing: 4 }), 0);
  assert.equal(reconciliationVariance({ assigned: 10, distributed: 4, returned: 1, damaged: 0, closing: 4 }), 1);
});

test('parseCsv supports commas, escaped quotes and newlines inside quoted fields', () => {
  const rows = parseCsv('code,name,note\nCTV001,"Nguyen, An","said ""hello"""\n');
  assert.deepEqual(rows, [{ code: 'CTV001', name: 'Nguyen, An', note: 'said "hello"' }]);
});

test('toCsv escapes dangerous spreadsheet formulas and CSV quotes', () => {
  const csv = toCsv([{ code: '=1+1', name: 'A "B"' }], ['code', 'name']);
  assert.match(csv, /^\uFEFFcode,name\r\n'=/);
  assert.match(csv, /"A ""B"""/);
});

test('validateIdempotencyKey accepts safe keys and rejects weak keys', () => {
  assert.equal(validateIdempotencyKey('dist_550e8400-e29b-41d4-a716-446655440000'), 'dist_550e8400-e29b-41d4-a716-446655440000');
  assert.throws(() => validateIdempotencyKey('x'), /VALIDATION_ERROR/);
});

test('businessDateVn uses Asia Ho Chi Minh calendar date', () => {
  assert.equal(businessDateVn(new Date('2026-08-20T18:00:00Z')), '2026-08-21');
});
