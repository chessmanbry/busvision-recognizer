import assert from 'node:assert/strict';
import test from 'node:test';
import { extractLiteralRouteText } from '../src/services/routeText.js';

test('literal OCR routes retain zeros, prefixes and four-digit identity', () => {
  for (const route of ['307', 'F123', '1921', '1932', '4921', '307區間', '紅12']) {
    assert.equal(extractLiteralRouteText(route), route);
  }
  assert.equal(extractLiteralRouteText(' f123\n'), 'F123');
  assert.equal(extractLiteralRouteText('Ｆ123'), 'F123');
});

test('separated LED artifacts preserve the previous 9xx correction', () => {
  assert.equal(extractLiteralRouteText('4 921'), '921');
  assert.equal(extractLiteralRouteText('4\n921'), '921');
  assert.equal(extractLiteralRouteText('4921'), '4921');
});

test('ambiguous OCR and unsupported route forms stay with the existing fallback', () => {
  for (const text of ['', null, undefined, 'Q2H', 'S32', 'QZH', '5', '15', '藍5', '棕9', '小15', '12345', '307 932']) {
    assert.equal(extractLiteralRouteText(text), '');
  }
});
