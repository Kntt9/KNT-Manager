// Builds the web/ site from the src/ app: copies index.html (lightly
// transformed for the browser), styles.css (+ web overrides), renderer.js and
// the i18n dictionaries. bridge.js and server.mjs are authored directly in
// web/ and are not regenerated.
//
//   node web/build-web.mjs
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const WEB = join(ROOT, 'web');

const read = (p) => readFileSync(p, 'utf8');
const write = (p, c) => { writeFileSync(p, c, 'utf8'); };

mkdirSync(join(WEB, 'i18n'), { recursive: true });

// ── index.html ──────────────────────────────────────────────────────────────
let html = read(join(SRC, 'index.html'));

// Browser-friendly CSP: keep Google Fonts + rbxcdn images, allow the Roblox
// APIs and the local relay (same origin, so 'self' already covers /proxy).
html = html.replace(
  /<meta http-equiv="Content-Security-Policy"[^>]*\/>/,
  '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\'; style-src \'self\' \'unsafe-inline\' https://fonts.googleapis.com; font-src \'self\' https://fonts.gstatic.com; img-src \'self\' data: https://*.rbxcdn.com https://*.roblox.com; connect-src \'self\' https://*.roblox.com https://core.bloxgen.net https://api.altgen.me https://discord.com; object-src \'none\'; base-uri \'self\'; frame-src \'none\'"/>'
);

// Swap the Tauri bridge for the browser bridge.
html = html.replace('<script src="tauri-bridge.js"></script>', '<script src="bridge.js"></script>');

// Web banner injected between the titlebar and the layout.
const banner = `
<!-- web build: informational banner (browser demo) -->
<div class="web-banner" id="web-banner" role="note">
  <span class="material-icons-round web-banner-ic">public</span>
  <div class="web-banner-text">
    <b>KNT Manager Web</b> — versão de demonstração no navegador: os dados ficam salvos aqui no seu navegador (localStorage) e o launch do Roblox é simulado.
    As APIs da Roblox (Charts, validação de cookie, Altgen) funcionam 100% com o servidor local: <code>node web/server.mjs</code>
  </div>
  <button class="web-banner-x" onclick="this.closest('#web-banner').remove()" aria-label="Dismiss">&times;</button>
</div>
`;
html = html.replace('<div id="layout">', banner + '\n<div id="layout">');

write(join(WEB, 'index.html'), html);

// ── styles.css (+ web overrides) ────────────────────────────────────────────
const WEB_CSS = `
/* ════════════════════════════════════════════════════════════════════════
   Web build overrides — appended on top of the app's own design system.
   ════════════════════════════════════════════════════════════════════════ */
#titlebar{-webkit-app-region:no-drag;cursor:default}
.tb-drag{cursor:default}
.tb-controls{display:none}
body{height:100dvh;display:flex;flex-direction:column}
#layout{height:auto;flex:1;min-height:0}
.web-banner{
  flex-shrink:0;display:flex;align-items:center;gap:10px;padding:8px 16px;
  background:var(--ac2);border-bottom:1px solid var(--ac3);color:var(--t1);
  font-size:12px;line-height:1.5;
}
.web-banner-ic{font-size:16px;color:var(--ac-h);flex-shrink:0}
.web-banner-text{flex:1;min-width:0}
.web-banner-text b{color:var(--t1);font-weight:700}
.web-banner-text code{
  font-family:var(--mono);font-size:11px;background:var(--s3);
  border:1px solid var(--bd);border-radius:4px;padding:1px 5px;color:var(--t1);
}
.web-banner-x{
  flex-shrink:0;width:24px;height:24px;display:flex;align-items:center;justify-content:center;
  border:none;border-radius:6px;background:transparent;color:var(--t2);font-size:16px;line-height:1;cursor:pointer;
  transition:background var(--dur) var(--smooth),color var(--dur) var(--smooth);
}
.web-banner-x:hover{background:var(--s3);color:var(--t1)}
@media (max-width:640px){.web-banner{font-size:11px;align-items:flex-start}}
`;
write(join(WEB, 'styles.css'), read(join(SRC, 'styles.css')) + WEB_CSS);

// ── renderer + i18n (plain copies) ─────────────────────────────────────────
copyFileSync(join(SRC, 'renderer.js'), join(WEB, 'renderer.js'));
copyFileSync(join(SRC, 'i18n', 'en.js'), join(WEB, 'i18n', 'en.js'));
copyFileSync(join(SRC, 'i18n', 'pt.js'), join(WEB, 'i18n', 'pt.js'));

const total = ['index.html', 'styles.css', 'renderer.js', 'bridge.js', 'i18n/en.js', 'i18n/pt.js']
  .reduce((s, f) => s + readFileSync(join(WEB, f)).length, 0);
console.log('web/ site written (' + (total / 1024).toFixed(0) + ' KB)');
console.log('  open  web/index.html        → demo mode (localStorage, simulated Roblox)');
console.log('  serve node web/server.mjs   → full mode (live Roblox APIs via relay)');
