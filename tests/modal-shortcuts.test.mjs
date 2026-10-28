import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Git checkouts may use CRLF on Windows; source extraction is newline-independent.
const source = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf("document.addEventListener('keydown', e => {\n  // Ctrl/Cmd+F");
assert.notEqual(start, -1);
const code = source.slice(start, source.indexOf('\nlet chartTab =', start));

function harness(id, dismissible = true) {
  const actions = [];
  const modal = {id, dataset: {backdropClose: String(dismissible)}};
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {id, style: {display:'none'}, classList: {contains: () => true}});
    return elements.get(id);
  };
  let handler;
  const context = vm.createContext({
    document: {activeElement: {}, getElementById: element, addEventListener(_, fn) {handler = fn;}},
    KntUi: {top: () => modal},
    closeAllCdd() {}, closeModal: id => actions.push(['close',id]),
    cancelLogin: () => actions.push(['cancelLogin']), cancelLaunchOrClose: () => actions.push(['cancelLaunch']),
    saveEdit: () => actions.push(['saveEdit']), openLogin: () => actions.push(['openLogin']),
    openLogFind: () => actions.push(['openFind']), closeLogFind() {}, logFind() {},
  });
  vm.runInContext(code, context);
  return {actions, press(key, ctrlKey = false) {
    let prevented = false;
    handler({key,ctrlKey,preventDefault() {prevented = true;},target:{}});
    return prevented;
  }};
}

test('Ctrl+S still saves the top account editor despite the background shortcut guard', () => {
  const h = harness('m-edit');
  assert.equal(h.press('s',true),true);
  assert.deepEqual(h.actions,[['saveEdit']]);
});

test('Escape affects only the top dismissible dialog and preserves locked dialogs', () => {
  const h = harness('m-text-input');
  h.press('Escape');
  assert.deepEqual(h.actions,[['close','m-text-input']]);
  const locked = harness('m-key-change',false);
  locked.press('Escape');
  assert.deepEqual(locked.actions,[]);
});

test('background shortcuts stay blocked, and Escape uses login cancellation', () => {
  const h = harness('m-key-change',false);
  h.press('n',true); h.press('f',true); h.press('s',true);
  assert.deepEqual(h.actions,[]);
  const login = harness('m-login');
  login.press('Escape');
  assert.deepEqual(login.actions,[['cancelLogin']]);
});
