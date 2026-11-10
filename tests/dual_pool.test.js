'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const report = require(path.join(ROOT, 'report.js'));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const ZERO = '0x0000000000000000000000000000000000000000';

test('configured pool ids match each poolKey', () => {
  const pools = config.uniswap.pools;
  assert.equal(pools.length, 2);
  const byFee = Object.fromEntries(pools.map((pool) => [pool.fee, pool]));
  const one = byFee[10000];
  const three = byFee[3000];
  assert.equal(one.tickSpacing, 200);
  assert.equal(one.poolKey.fee, 10000);
  assert.equal(one.poolKey.tickSpacing, 200);
  assert.equal(one.poolKey.hooks.toLowerCase(), ZERO);
  assert.equal(one.poolId, '0xc96bfd21d36f8e7252f0d80fcb5f3bcacdf47c8b927b20711104713ebeb383ac');
  assert.equal(report.poolIdForKey(one.poolKey).toLowerCase(), one.poolId.toLowerCase());
  assert.equal(three.tickSpacing, 60);
  assert.equal(three.poolKey.fee, 3000);
  assert.equal(three.poolKey.tickSpacing, 60);
  assert.equal(three.poolKey.hooks.toLowerCase(), ZERO);
  assert.equal(three.poolId, '0xf9b8a9101438145d62c9f03156b203c6c573931167e2d36f9061a32575706c8a');
  assert.equal(report.poolIdForKey(three.poolKey).toLowerCase(), three.poolId.toLowerCase());
  assert.equal(config.ui.defaultAddress, '');
  assert.equal(config.ui.hypeReference, 0);
});

test('partial report is refused unless every known position is confirmed', () => {
  assert.deepEqual(report.missingKnownActive(['1', '2'], [{ id: '1' }], new Set(['2'])), []);
  assert.deepEqual(report.missingKnownActive(['1', '2'], [{ id: '1' }], new Set()), ['2']);
});

test('closed-position skip cache resets when the pool set changes', () => {
  const current = report.poolRegistry();
  assert.deepEqual(report.closedMapForRegistry({ poolRegistry: current, closed: { '9': 1 } }, current), { '9': 1 });
  assert.deepEqual(report.closedMapForRegistry({ poolRegistry: 'old-single-pool', closed: { '9': 1 } }, current), {});
});

test('empty and placeholder wallets explain how to configure the report', () => {
  const empty = report.resolveOwnerAddress('');
  assert.equal(empty.error.code, 'CONFIG');
  assert.match(empty.error.message, /DEFAULT_ADDRESS/);
  assert.match(empty.error.message, /ui\.defaultAddress/);
  const placeholder = report.resolveOwnerAddress('0xYOUR_WALLET_ADDRESS');
  assert.equal(placeholder.error.code, 'CONFIG');
  assert.match(placeholder.error.message, /42-character/);
  const ok = report.resolveOwnerAddress('0x' + '11'.repeat(20));
  assert.equal(ok.address, '0x' + '11'.repeat(20));
});

test('report.js is portable and the old entry forwards once', () => {
  const source = fs.readFileSync(path.join(ROOT, 'report.js'), 'utf8');
  assert.equal(source.includes('/opt/elysium-lp'), false);
  const shim = fs.readFileSync(path.join(ROOT, 'scripts', 'hourly_report.js'), 'utf8');
  assert.match(shim, /report\.js/);
  assert.equal(shim.includes('postBark'), false);
  assert.equal(shim.includes('getLogs'), false);
  const env = { ...process.env, DEFAULT_ADDRESS: '', BARK_KEY: '' };
  const direct = spawnSync(process.execPath, ['report.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(direct.status, 0);
  assert.match((direct.stdout || '') + (direct.stderr || ''), /No wallet configured/);
  const wrapped = spawnSync(process.execPath, ['scripts/hourly_report.js'], { cwd: ROOT, env, encoding: 'utf8', timeout: 15000 });
  const wrappedText = (wrapped.stdout || '') + (wrapped.stderr || '');
  assert.notEqual(wrapped.status, 0);
  assert.match(wrappedText, /No wallet configured/);
  assert.equal(wrappedText.split('[report]').length - 1, 1);
});
