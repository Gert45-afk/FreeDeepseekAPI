#!/usr/bin/env node
// Interactive Chrome worker for the local relay. Credentials stay in the Chrome profile.
const { chromium } = require('playwright-core');
const { createRelayServer } = require('./relay_server');
const crypto = require('crypto');
const path = require('path');
const readline = require('readline');
const fs = require('fs');
const { normalizeCookies } = require('../lib/relay_cookies');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ask = prompt => new Promise(resolve => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(prompt, () => { rl.close(); resolve(); });
});

async function runJob(page, job, update) {
  try {
    // A new chat per request prevents previous conversations contaminating replies.
    await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    const field = page.locator('textarea[placeholder="Message DeepSeek"]');
    await field.waitFor({ state: 'visible', timeout: 30000 });
    if (await page.locator('.ds-message').count()) throw new Error('Откройте новый пустой чат DeepSeek');
    if (await field.inputValue()) throw new Error('Поле ввода не пустое');
    await field.fill(job.prompt);
    // Locate the circular control relative to the composer, not by hashed class.
    const sent = await page.evaluate(async () => {
      const field = document.querySelector('textarea[placeholder="Message DeepSeek"]');
      let node = field, button = null;
      while (node && node !== document.body && !button) {
        button = node.querySelector('[role="button"].ds-button--circle');
        node = node.parentElement;
      }
      if (!button || !button.querySelector('svg path[d^="M8.3125 0.980206"]')) return false;
      // React may enable the control on its next render.
      for (let i = 0; i < 20 && button.classList.contains('ds-button--disabled'); i++) await new Promise(r => setTimeout(r, 100));
      if (!button.isConnected || button.classList.contains('ds-button--disabled')) return false;
      button.click();
      return true;
    });
    if (!sent) throw new Error('Кнопка отправки DeepSeek не найдена или неактивна');
    let previous = '', sawGeneration = false;
    const deadline = Date.now() + 170000;
    while (Date.now() < deadline) {
      await sleep(500);
      const state = await page.evaluate(() => {
        let node = document.querySelector('textarea[placeholder="Message DeepSeek"]'), button = null;
        while (node && node !== document.body && !button) {
          button = node.querySelector('[role="button"].ds-button--circle');
          node = node.parentElement;
        }
        const list = document.querySelectorAll('.ds-assistant-message-main-content');
        return { button: !!button, arrow: !!button?.querySelector('svg path[d^="M8.3125 0.980206"]'), text: list.length ? list[list.length - 1].innerText : '' };
      });
      if (!state.button) throw new Error('Кнопка DeepSeek исчезла; возможно, интерфейс изменился');
      if (!state.arrow) sawGeneration = true;
      if (state.text !== previous) { await update({ id: job.id, text: state.text }); previous = state.text; }
      if (sawGeneration && state.arrow && state.text) {
        await sleep(500);
        const finalText = await page.locator('.ds-assistant-message-main-content').last().innerText();
        await update({ id: job.id, text: finalText, done: true });
        return;
      }
    }
    throw new Error('Не удалось определить окончание ответа DeepSeek');
  } catch (e) {
    try { await update({ id: job.id, error: e.message }); } catch (_) {}
    console.error('[relay]', e.message);
  }
}

async function main() {
  const key = process.env.RELAY_API_KEY || crypto.randomBytes(32).toString('hex');
  const profile = path.resolve(process.env.RELAY_CHROME_PROFILE || '.chrome-profile-relay');
  console.log('[relay] Открываю Chrome. Войдите в DeepSeek в открывшемся окне.');
  const context = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false });
  try {
  if (process.env.RELAY_COOKIES_PATH) {
    // Never log paths, raw JSON, cookie values, or Playwright errors that may contain them.
    let cookies;
    try { cookies = normalizeCookies(JSON.parse(fs.readFileSync(process.env.RELAY_COOKIES_PATH, 'utf8'))); }
    catch (_) { throw new Error('Не удалось прочитать файл cookies: проверьте путь, JSON и домены DeepSeek'); }
    try { await context.addCookies(cookies); }
    catch (_) { throw new Error('Не удалось импортировать cookies в Chrome; проверьте формат файла'); }
    console.log('[relay] Cookies импортированы в локальный профиль Chrome.');
  }
  const page = context.pages()[0] || await context.newPage();
  let closed = false;
  context.on('close', () => { closed = true; });
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await ask('После входа в DeepSeek нажмите Enter здесь, в терминале... ');
  if (closed) throw new Error('Окно Chrome закрыто');
  if (!await page.locator('textarea[placeholder="Message DeepSeek"]').count()) throw new Error('Поле чата не найдено. Проверьте вход и запустите снова.');
  const server = createRelayServer({ key });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(9656, '127.0.0.1', resolve); });
  console.log(`[relay] API: http://127.0.0.1:9656/v1`);
  console.log(`[relay] Ключ API: ${key}`);
  console.log('[relay] Модель: relay. Не закрывайте окно Chrome и этот терминал.');
  const headers = { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };
  try {
    while (!closed) {
      const response = await fetch('http://127.0.0.1:9656/relay/job', { headers });
      const { job } = await response.json();
      if (job) await runJob(page, job, async body => {
        const response = await fetch('http://127.0.0.1:9656/relay/update', { method: 'POST', headers, body: JSON.stringify(body) });
        const result = await response.json();
        if (!response.ok || result.ok === false) throw new Error('Запрос relay завершился или был отменён');
      });
      else await sleep(500);
    }
  } finally { server.close(); }
  } finally { await context.close(); }
}
main().catch(error => { console.error('[relay]', error.message); process.exitCode = 1; });
