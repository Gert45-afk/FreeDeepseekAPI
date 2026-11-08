// Experimental DOM relay: only claim work from a clean, empty chat.
(() => {
  if (window.top !== window) return;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const call = (path, body) => chrome.runtime.sendMessage({ action: 'relayFetch', path, body });
  const input = () => document.querySelector('textarea[placeholder="Message DeepSeek"]');
  const answers = () => [...document.querySelectorAll('.ds-assistant-message-main-content')];
  // The arrow path was supplied from the current DeepSeek UI. Fail closed if it changes.
  function sendButton(field) {
    let container = field;
    while (container && container !== document.body) {
      const button = container.querySelector('[role="button"].ds-button--circle');
      if (button) return button;
      container = container.parentElement;
    }
    return null;
  }
  function isSendArrow(button) {
    return !!button?.querySelector('svg path[d^="M8.3125 0.980206"]');
  }
  async function update(id, text, done = false, error = undefined) {
    const r = await call('/relay/update', { id, text, done, error });
    if (!r || r.error || r.status !== 200 || r.data?.ok === false) throw new Error('Relay job is no longer available');
  }
  async function run(job) {
    try {
      const field = input();
      if (!field || field.value || document.querySelector('.ds-message')) throw new Error('Open a new empty DeepSeek chat before using relay');
      const button = sendButton(field);
      if (!isSendArrow(button)) throw new Error('DeepSeek send button not recognized');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(field, job.prompt);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      await delay(300);
      if (!isSendArrow(button) || button.classList.contains('ds-button--disabled')) throw new Error('DeepSeek send button did not become available');
      button.click();
      let previous = '', sawGeneration = false;
      const deadline = Date.now() + 170000;
      while (Date.now() < deadline) {
        await delay(500);
        if (!field.isConnected) throw new Error('DeepSeek page changed during generation');
        const currentButton = sendButton(field);
        if (!currentButton) throw new Error('DeepSeek control disappeared');
        if (!isSendArrow(currentButton)) sawGeneration = true;
        const text = answers().at(-1)?.innerText || '';
        if (text !== previous) { await update(job.id, text); previous = text; }
        // Require a control transition, not a silence timeout: reasoning/search
        // may take a long time before producing visible text.
        if (sawGeneration && isSendArrow(currentButton) && text) { await delay(500); const finalText = answers().at(-1)?.innerText || ''; await update(job.id, finalText, true); return; }
      }
      throw new Error('Could not confirm generation completion; DeepSeek UI may have changed');
    } catch (e) { try { await update(job.id, '', false, e.message); } catch (_) {} }
  }
  let busy = false;
  async function poll() {
    if (busy || !input() || input().value || document.querySelector('.ds-message')) return;
    busy = true;
    try { const r = await call('/relay/job'); if (r?.data?.job) await run(r.data.job); } catch (_) {} finally { busy = false; }
  }
  setInterval(poll, 2000);
})();
