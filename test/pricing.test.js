const test = require('node:test');
const assert = require('node:assert');
const { priceOrder } = require('../server/pricing');
const SN = { essentiel: 7500, famille: 10000, prestige: 18000, numerique: 5000,
  print_8x10: 3500, print_5x7: 2500, print_4x6: 1500, wallet: 1500, digital: 5000 };
const t = (items) => priceOrder('SN', items, SN).total;
const q = (item, qty = 1) => ({ item, qty });

test('single package never discounted', () => assert.equal(t([q('famille')]), 10000));
test('second identical package 20% off', () => assert.equal(t([q('essentiel', 2)]), 7500 + 6000));
test('mixed: only lower-priced discounted', () => assert.equal(t([q('essentiel'), q('prestige')]), 18000 + 6000));
test('3 packages: highest full, rest 20% off', () =>
  assert.equal(t([q('essentiel'), q('prestige'), q('famille')]), 18000 + 8000 + 6000));
test('extra 8x10 of an included size is 20% off', () => assert.equal(t([q('famille'), q('print_8x10')]), 10000 + 2800));
test('size not in package is full price', () => assert.equal(t([q('essentiel'), q('print_8x10')]), 7500 + 3500));
test('extra digital never discounted', () => assert.equal(t([q('famille'), q('digital')]), 10000 + 5000));
test('a la carte only pays full price', () => assert.equal(t([q('print_8x10')]), 3500));
test('numerique includes no print sizes', () => assert.equal(t([q('numerique'), q('print_5x7')]), 5000 + 2500));
test('unknown item throws', () => assert.throws(() => t([q('nope')])));
