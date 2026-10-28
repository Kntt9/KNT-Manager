import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');
const block = source.slice(source.indexOf('let _encSubmitting = false;'), source.indexOf('function clearAppData()'));

function harness(unlock, skip = async () => ({ ok: true })) {
  const input = { value: 'test-passphrase', focus() {} };
  const calls = { states: [], errors: [], init: 0, skip: 0 };
  const context = vm.createContext({
    document: { getElementById: id => id === 'enc-input' ? input : id === 'enc-err' ? { classList: { remove() {} } } : null },
    api: { encUnlock: unlock, encSetKey: async () => { calls.skip++; return skip(); } },
    _encMode: 'locked',
    _encErr: message => calls.errors.push(message),
    _encSetBtnState: state => calls.states.push(state),
    _encShake() {}, logEntry() {}, closeModal() {}, hideBootCover() {},
    continueInit: async () => { calls.init++; },
    t: key => key,
    setTimeout: callback => callback(), console,
  });
  vm.runInContext(block + '\nglobalThis.subject = { submitEnc, skipEnc };', context);
  return { subject: context.subject, calls, input };
}

test('repeated Enter/click does not start concurrent key derivations or skip setup', async () => {
  let finish;
  let unlocks = 0;
  const h = harness(() => { unlocks++; return new Promise(resolve => { finish = resolve; }); });
  const pending = h.subject.submitEnc();
  await h.subject.submitEnc();
  await h.subject.skipEnc();
  assert.equal(unlocks, 1);
  assert.equal(h.calls.skip, 0);
  finish({ ok: true });
  await pending;
  assert.equal(h.calls.init, 1);
});

test('worker failure is not displayed as a wrong password and allows retry', async () => {
  let unlocks = 0;
  const h = harness(async () => ++unlocks === 1 ? { ok: false, error: 'Worker failed' } : { ok: true });
  await h.subject.submitEnc();
  assert.deepEqual(h.calls.errors, ['Worker failed']);
  assert.equal(h.input.value, 'test-passphrase');
  assert.equal(h.calls.states.at(-1), 'normal');
  await h.subject.submitEnc();
  assert.equal(h.calls.init, 1);
});

test('wrong password keeps the application locked and allows a later attempt', async () => {
  const h = harness(async () => ({ ok: false }));
  await h.subject.submitEnc();
  assert.deepEqual(h.calls.errors, ['enc.errWrong']);
  assert.equal(h.calls.init, 0);
  assert.equal(h.input.value, '');
  h.input.value = 'another-passphrase';
  await h.subject.submitEnc();
  assert.equal(h.calls.states.at(-1), 'normal');
});

test('skipping setup does not open the application when storage preparation fails', async () => {
  const h = harness(async () => ({ ok: true }), async () => ({ ok: false, error: 'Original data preserved' }));
  await h.subject.skipEnc();
  assert.equal(h.calls.init, 0);
  assert.deepEqual(h.calls.errors, ['Original data preserved']);
  assert.equal(h.calls.states.at(-1), 'normal');
  await h.subject.skipEnc();
  assert.equal(h.calls.skip, 2);
});
