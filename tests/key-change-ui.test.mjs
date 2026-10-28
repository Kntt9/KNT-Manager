import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('let _saveKeyTimer;'), source.indexOf('function openModal(id)'));
function harness(change) {
  const input = { value: 'new-password', disabled: false };
  const button = { disabled: false, textContent: 'Save' };
  const confirmation = { value: 'new-password', disabled: false };
  const cancel = { disabled: false };
  const calls = { timers: [], changes: [], toasts: [], reloads: 0 };
  const settings = {};
  const context = vm.createContext({
    document: { getElementById: id => ({'custom-key':input,'custom-key-confirm':confirmation,'key-change-cancel':cancel,'btn-save-key':button}[id] || null) },
    api: {
      encSetKey: pass => { calls.changes.push(pass); return change(pass); },
      loadAccounts: async () => { calls.reloads++; return []; },
    },
    settings, accounts: [], flagInvalidCookies() {}, render() {}, applySettings() {}, closeModal() {},
    toast: (message, type) => calls.toasts.push({ message, type }),
    t: (key, args) => args?.msg || key,
    clearTimeout() {}, setTimeout: callback => { calls.timers.push(callback); return calls.timers.length; },
  });
  vm.runInContext(block + '\nglobalThis.subject = {saveKeySettings, onKeyInput};', context);
  return { input, button, confirmation, cancel, calls, settings, subject: context.subject };
}

test('empty settings password is rejected before invoking a destructive key change', async () => {
  const h = harness(async () => ({ ok: true }));
  h.input.value = '   ';
  await h.subject.saveKeySettings();
  assert.equal(h.calls.changes.length, 0);
  assert.equal(h.calls.timers.length, 0);
  assert.equal(h.calls.toasts[0].type, 'err');
  assert.equal(h.input.disabled, false);
});

test('typing and repeated clicks cannot queue another change while one is pending', async () => {
  let finish;
  const h = harness(() => new Promise(resolve => { finish = resolve; }));
  await h.subject.saveKeySettings();
  const pending = h.calls.timers[0]();
  h.subject.onKeyInput();
  await h.subject.saveKeySettings();
  assert.equal(h.calls.changes.length, 1);
  assert.equal(h.calls.timers.length, 1);
  assert.equal(h.button.disabled, true);
  assert.equal(h.input.disabled, true);
  assert.equal(h.confirmation.disabled, true);
  assert.equal(h.cancel.disabled, true);
  finish({ ok: true }); await pending;
  assert.equal(h.settings.keySet, true);
  assert.equal(h.calls.reloads, 1);
  assert.equal(h.input.value, '');
  assert.equal(h.input.disabled, false);
  assert.equal(h.button.disabled, false);
  assert.equal(h.cancel.disabled, false);
});

test('a confirmation mismatch never invokes key migration', async () => {
  const h = harness(async () => ({ok:true}));
  h.confirmation.value = 'different-password';
  await h.subject.saveKeySettings();
  assert.equal(h.calls.changes.length,0);
  assert.equal(h.calls.timers.length,0);
  assert.equal(h.calls.toasts[0].message,'ui.passwordMismatch');
  assert.equal(h.input.disabled,false);
});

test('failed migration preserves the entered password and allows a retry', async () => {
  let attempts = 0;
  const h = harness(async () => ++attempts === 1 ? { ok: false, error: 'Original data preserved' } : { ok: true });
  await h.subject.saveKeySettings(); await h.calls.timers[0]();
  assert.equal(h.calls.toasts[0].message, 'Original data preserved');
  assert.equal(h.input.value, 'new-password');
  assert.equal(h.input.disabled, false);
  assert.equal(h.calls.reloads, 0);
  assert.equal(h.settings.keySet, undefined);
  await h.subject.saveKeySettings(); await h.calls.timers[1]();
  assert.equal(h.calls.changes.length, 2);
  assert.equal(h.settings.keySet, true);
});
