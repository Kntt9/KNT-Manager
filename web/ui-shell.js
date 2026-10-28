/* KNT Manager · shared dialog behavior. No account, network or storage access. */
(() => {
  'use strict';
  const stack = [];
  const previousFocus = new Map();
  const focusable = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]';
  const visible = element => !element.hidden && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  function prepare(overlay) {
    if (typeof workspacePrepareDialog === 'function') workspacePrepareDialog(overlay);
    const dialog = overlay.querySelector('.modal,.enc-shell');
    if (!dialog) return;
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('tabindex', '-1');
    const title = dialog.querySelector('.modal-title,.pm-title,.srv-title,#enc-title');
    if (title) {
      if (!title.id) title.id = overlay.id + '-heading';
      dialog.setAttribute('aria-labelledby', title.id);
    }
  }
  function sync() {
    const active = top();
    for (const overlay of document.querySelectorAll('.overlay')) {
      overlay.setAttribute('aria-hidden', String(!overlay.classList.contains('open')));
      if (overlay.classList.contains('open')) overlay.inert = overlay !== active;
    }
    const layout = document.getElementById('layout');
    if (layout) layout.inert = Boolean(active);
  }
  function top() {
    return stack.map(id => document.getElementById(id)).filter(element => element?.classList.contains('open')).at(-1) || null;
  }
  function open(id) {
    const overlay = document.getElementById(id);
    if (!overlay || overlay.classList.contains('open')) return;
    prepare(overlay);
    previousFocus.set(id, document.activeElement);
    const old = stack.indexOf(id); if (old >= 0) stack.splice(old, 1);
    stack.push(id);
    overlay.style.zIndex = String(100 + stack.length);
    overlay.inert = false;
    overlay.classList.add('open');
    sync();
    requestAnimationFrame(() => {
      if (!overlay.classList.contains('open') || top() !== overlay) return;
      const target = [...overlay.querySelectorAll('[autofocus],input:not(:disabled),textarea:not(:disabled),select:not(:disabled)')].find(visible)
        || [...overlay.querySelectorAll('button:not(:disabled)')].find(visible);
      (target || overlay.querySelector('[role="dialog"]'))?.focus();
    });
  }
  function close(id) {
    const overlay = document.getElementById(id);
    if (!overlay) return;
    overlay.classList.remove('open');
    overlay.inert = false;
    const index = stack.indexOf(id); if (index >= 0) stack.splice(index, 1);
    sync();
    const target = previousFocus.get(id);
    previousFocus.delete(id);
    if (target?.isConnected && !target.closest('[inert]')) target.focus();
    else top()?.querySelector('[role="dialog"]')?.focus();
    overlay.dispatchEvent(new CustomEvent('knt:dialog-closed'));
  }
  let prompting = false;
  function requestText({title, value = '', multiline = false}) {
    if (prompting) return Promise.resolve(null);
    prompting = true;
    const overlay = document.getElementById('m-text-input');
    const input = document.getElementById(multiline ? 'ui-text-area' : 'ui-text-value');
    document.getElementById('ui-text-title').textContent = title;
    document.getElementById('ui-text-area').hidden = !multiline;
    document.getElementById('ui-text-value').hidden = multiline;
    input.value = value;
    return new Promise(resolve => {
      let done = false;
      const finish = result => {
        if (done) return;
        done = true; prompting = false;
        overlay.removeEventListener('knt:dialog-closed', cancelled);
        document.getElementById('ui-text-form').removeEventListener('submit', submitted);
        close('m-text-input');
        resolve(result);
      };
      const submitted = event => { event.preventDefault(); finish(input.value); };
      const cancelled = () => finish(null);
      document.getElementById('ui-text-form').addEventListener('submit', submitted);
      overlay.addEventListener('knt:dialog-closed', cancelled);
      open('m-text-input');
    });
  }
  document.addEventListener('keydown', event => {
    const overlay = top();
    if (event.key !== 'Tab' || !overlay) return;
    const targets = [...overlay.querySelectorAll(focusable)].filter(visible);
    const first = targets[0], last = targets.at(-1);
    if (!first) { event.preventDefault(); return; }
    if (event.shiftKey && (!overlay.contains(document.activeElement) || document.activeElement === first)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (!overlay.contains(document.activeElement) || document.activeElement === last)) {
      event.preventDefault(); first.focus();
    }
  });
  function init() {
    document.querySelectorAll('.overlay').forEach(prepare);
    sync();
    document.querySelectorAll('.material-icons-round').forEach(icon => icon.setAttribute('aria-hidden', 'true'));
  }
  window.KntUi = {open, close, top, requestText};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once: true}); else init();
})();
