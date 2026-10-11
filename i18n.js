/* ==========================================================================
   PhysioBook — превод на интерфейса (i18n)
   ==========================================================================
   Работи с речник `window.PB_I18N_DATA` (виж i18n-data.js):
     exact   — { "български низ": { en, de, ru } }
     pattern — { "шаблон с {0}": { en, de, ru } }

   Подходът е НЕинвазивен: не се пипат хилядите низове в кода. Вместо това се
   обхожда готовият DOM и се заменя текстът по речник. Затова работи и за
   съдържание, което се генерира динамично (всички модули рендират с innerHTML)
   — следи се с MutationObserver.

   Оригиналният български текст се пази в WeakMap, за да може смяната на езика
   да преизчисли от оригинала, а не от вече преведения текст.
   ========================================================================== */
(function () {
  'use strict';

  var DATA = window.PB_I18N_DATA || { exact: {}, pattern: {} };
  var LANGS = [
    { code: 'bg', label: 'Български', short: 'BG' },
    { code: 'en', label: 'English', short: 'EN' },
    { code: 'de', label: 'Deutsch', short: 'DE' },
    { code: 'ru', label: 'Русский', short: 'RU' }
  ];
  var STORE_KEY = 'physiobook_lang';
  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt', 'data-tooltip'];
  var SKIP = { SCRIPT: 1, STYLE: 1, CODE: 1, PRE: 1, NOSCRIPT: 1 };
  var CYR = /[\u0400-\u04FF]/;

  var current = 'bg';
  var origText = new WeakMap();
  var origAttr = new WeakMap();
  var patterns = null;

  // ── Компилиране на шаблоните в регулярни изрази ──────────────────────
  function compilePatterns() {
    patterns = [];
    var keys = Object.keys(DATA.pattern || {});
    // По-дългите първи — иначе кратък шаблон би „изял" по-дълъг низ.
    keys.sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      var re = new RegExp('^' + esc.replace(/\\\{(\d+)\\\}/g, '(.+?)') + '$');
      patterns.push({ re: re, tr: DATA.pattern[key] });
    }
  }

  function readLang() {
    try {
      var s = localStorage.getItem(STORE_KEY);
      for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === s) return s;
    } catch (e) { /* приватен режим */ }
    return 'bg';
  }

  // ── Превод на един низ ───────────────────────────────────────────────
  function translateString(src) {
    if (current === 'bg' || !src) return src;
    var e = DATA.exact[src];
    if (e && e[current]) return e[current];
    if (!patterns) compilePatterns();
    for (var i = 0; i < patterns.length; i++) {
      var m = src.match(patterns[i].re);
      if (m) {
        var out = patterns[i].tr[current];
        if (!out) continue;
        for (var k = 1; k < m.length; k++) {
          out = out.split('{' + (k - 1) + '}').join(m[k]);
        }
        return out;
      }
    }
    return src;
  }

  function tr(raw) {
    var core = raw.trim();
    if (!core || !CYR.test(core)) return raw;
    var t = translateString(core);
    if (t === core) return raw;
    var lead = raw.match(/^\s*/)[0];
    var trail = raw.match(/\s*$/)[0];
    return lead + t + trail;
  }

  // ── Текстови възли ───────────────────────────────────────────────────
  function doTextNode(node) {
    var raw = origText.has(node) ? origText.get(node) : node.nodeValue;
    if (!raw || !CYR.test(raw)) return;
    if (!origText.has(node)) origText.set(node, raw);
    var next = tr(raw);
    if (node.nodeValue !== next) node.nodeValue = next;
  }

  // ── Атрибути ─────────────────────────────────────────────────────────
  function doAttrs(el) {
    var store = origAttr.get(el);
    for (var i = 0; i < ATTRS.length; i++) {
      var name = ATTRS[i];
      if (!el.hasAttribute || !el.hasAttribute(name)) continue;
      var raw = store && store[name] !== undefined ? store[name] : el.getAttribute(name);
      if (!raw || !CYR.test(raw)) continue;
      if (!store) { store = {}; origAttr.set(el, store); }
      if (store[name] === undefined) store[name] = raw;
      var next = tr(raw);
      if (el.getAttribute(name) !== next) el.setAttribute(name, next);
    }
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { doTextNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) {
      if (SKIP[root.tagName]) return;
      doAttrs(root);
    }
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (n.nodeType === 3) doTextNode(n);
      else if (n.nodeType === 1 && !SKIP[n.tagName]) doAttrs(n);
    }
  }

  // ── Превключвател ────────────────────────────────────────────────────
  var CSS = [
    '.pb-lang{position:relative;display:inline-block;}',
    '.pb-lang-btn{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.12);',
    'border:1px solid rgba(255,255,255,0.22);color:inherit;border-radius:10px;',
    'padding:6px 10px;font-size:0.82rem;cursor:pointer;font-family:inherit;line-height:1;}',
    '.pb-lang-btn:hover{background:rgba(255,255,255,0.2);}',
    '.pb-lang-menu{position:absolute;top:calc(100% + 6px);right:0;min-width:150px;background:#fff;',
    'border-radius:12px;box-shadow:0 12px 32px rgba(11,43,79,0.22);padding:6px;display:none;z-index:4000;}',
    '.pb-lang-menu.open{display:block;}',
    '.pb-lang-item{display:flex;align-items:center;gap:10px;width:100%;background:none;border:0;',
    'padding:9px 10px;border-radius:8px;cursor:pointer;font-size:0.88rem;color:#0b2b4f;',
    'font-family:inherit;text-align:left;}',
    '.pb-lang-item:hover{background:#eef4fb;}',
    '.pb-lang-item.active{background:#e3edf9;font-weight:600;}',
    '.pb-lang-code{font-size:0.68rem;font-weight:700;color:#7f95b0;min-width:20px;}'
  ].join('');

  function buildSwitcher(mount) {
    var wrap = document.createElement('div');
    wrap.className = 'pb-lang';
    wrap.innerHTML =
      '<button type="button" class="pb-lang-btn" title="Смяна на езика / Language">' +
      '<i class="fas fa-globe"></i><span class="pb-lang-cur"></span>' +
      '<i class="fas fa-chevron-down" style="font-size:0.65rem;opacity:0.7;"></i></button>' +
      '<div class="pb-lang-menu"></div>';
    var menu = wrap.querySelector('.pb-lang-menu');
    LANGS.forEach(function (l) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pb-lang-item';
      b.setAttribute('data-lang', l.code);
      b.innerHTML = '<span class="pb-lang-code">' + l.short + '</span><span>' + l.label + '</span>';
      menu.appendChild(b);
    });
    wrap.querySelector('.pb-lang-btn').addEventListener('click', function (e) {
      e.stopPropagation();
      menu.classList.toggle('open');
    });
    menu.addEventListener('click', function (e) {
      var b = e.target.closest('.pb-lang-item');
      if (!b) return;
      setLang(b.getAttribute('data-lang'));
      menu.classList.remove('open');
    });
    document.addEventListener('click', function () { menu.classList.remove('open'); });
    mount.appendChild(wrap);
    return wrap;
  }

  function paintSwitcher() {
    var cur = null;
    for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code === current) cur = LANGS[i];
    document.querySelectorAll('.pb-lang-cur').forEach(function (el) {
      el.textContent = cur ? cur.short : 'BG';
    });
    document.querySelectorAll('.pb-lang-item').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-lang') === current);
    });
  }

  function setLang(code) {
    if (!code || code === current) return;
    current = code;
    try { localStorage.setItem(STORE_KEY, code); } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('lang', code);
    walk(document.body);
    paintSwitcher();
    try { window.dispatchEvent(new CustomEvent('pb:langchange', { detail: { lang: code } })); } catch (e) {}
  }

  // ── Стартиране ───────────────────────────────────────────────────────
  function start() {
    current = readLang();
    document.documentElement.setAttribute('lang', current);

    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    document.querySelectorAll('[data-lang-switcher]').forEach(function (m) { buildSwitcher(m); });

    walk(document.body);
    paintSwitcher();

    var pending = false;
    var obs = new MutationObserver(function (muts) {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (m.type === 'characterData') doTextNode(m.target);
          else if (m.type === 'childList') {
            for (var k = 0; k < m.addedNodes.length; k++) walk(m.addedNodes[k]);
          }
        }
      });
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  window.PBI18N = { t: translateString, setLang: setLang, getLang: function () { return current; }, walk: walk, LANGS: LANGS };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
