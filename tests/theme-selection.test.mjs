import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../src/renderer.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function applyTheme('), source.indexOf('function currentTheme('));

function harness(unavailableStorage = false) {
  const selected = [], applied = [], events = [];
  const context = vm.createContext({
    localStorage: {setItem(key, value) {
      if (unavailableStorage) throw new Error('Storage unavailable');
      selected.push([key, value]); events.push('save');
    }},
    document: {body: {classList: {add() {}, remove() {}}}},
    setTimeout: fn => fn(),
    _reapplyActiveTheme: name => {applied.push(name); events.push('apply');},
    _syncUiPrefsToSettings() {}, renderThemePage() {},
  });
  vm.runInContext(code, context);
  return {context, selected, applied, events};
}

test('selecting a theme applies that theme immediately and saves it before preference sync', () => {
  const h = harness();
  h.context.setTheme('light');
  assert.deepEqual(h.selected, [['ui-theme', 'light']]);
  assert.deepEqual(h.applied, ['light']);
  assert.deepEqual(h.events, ['save', 'apply']);
});

test('a theme remains usable for the current window if browser preference storage fails', () => {
  const h = harness(true);
  h.context.setTheme('graphite');
  assert.deepEqual(h.applied, ['graphite']);
});
