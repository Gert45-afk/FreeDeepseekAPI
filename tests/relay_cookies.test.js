const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCookies } = require('../lib/relay_cookies');
test('converts host-only and domain cookies for Playwright', () => {
  assert.deepEqual(normalizeCookies([
    { name: 'a', value: 'x', domain: 'chat.deepseek.com', hostOnly: true, path: '/', session: true, httpOnly: true, secure: true, sameSite: 'strict' },
    { name: 'b', value: 'y', domain: '.deepseek.com', hostOnly: false, path: '/', expirationDate: 1800000000, sameSite: 'lax' },
  ]), [
    { name: 'a', value: 'x', url: 'https://chat.deepseek.com/', httpOnly: true, secure: true, sameSite: 'Strict' },
    { name: 'b', value: 'y', domain: '.deepseek.com', path: '/', expires: 1800000000, httpOnly: false, secure: false, sameSite: 'Lax' },
  ]);
});
test('rejects unrelated or malformed cookie exports without printing values', () => {
  assert.throws(() => normalizeCookies([{ domain: 'evil.deepseek.com.example.com', name: 'a', value: 'secret' }]), e => !e.message.includes('secret'));
  assert.throws(() => normalizeCookies([]));
  assert.throws(() => normalizeCookies([{ domain: 'deepseek.com', name: 'a', value: 'secret', expirationDate: 'oops' }]), e => !e.message.includes('secret'));
});
