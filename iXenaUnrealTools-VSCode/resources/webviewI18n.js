'use strict';
(() => {
  // Only initial extension-owned text/attributes are tracked. User values inserted later are never translated.
  let initial;
  try { initial = JSON.parse(document.body.getAttribute('data-ixena-locale') || '{}'); } catch { initial = {}; }
  let language = initial.language === 'en' ? 'en' : 'zh-CN';
  let messages = initial.messages && typeof initial.messages === 'object' ? initial.messages : {};
  const owned = [];
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const t = (source, ...args) => {
    const template = language === 'en' && own(messages, source) ? messages[source] : source;
    return String(template).replace(/\{(\d+)\}/g, (match, index) => Number(index) < args.length ? String(args[Number(index)]) : match);
  };
  function collect(node) {
    if (node.nodeType === 3) {
      const key = node.nodeValue.trim();
      if (own(messages, key)) {
        const leading = node.nodeValue.match(/^\s*/)[0], trailing = node.nodeValue.match(/\s*$/)[0];
        owned.push(() => { node.nodeValue = leading + t(key) + trailing; });
      }
      return;
    }
    if (node.nodeType === 1 && !['SCRIPT', 'STYLE'].includes(node.tagName)) {
      for (const name of ['title', 'placeholder', 'aria-label']) {
        const source = node.getAttribute(name);
        if (source && own(messages, source)) owned.push(() => node.setAttribute(name, t(source)));
      }
      for (const child of [...node.childNodes]) collect(child);
    }
  }
  collect(document.documentElement);
  function apply() { document.documentElement.lang = language; for (const update of owned) update(); }
  function setLanguage(value) {
    if (!value || !['zh-CN', 'en'].includes(value.language)) return false;
    language = value.language;
    if (value.messages && typeof value.messages === 'object') messages = value.messages;
    apply(); return true;
  }
  function translateMessage(value) {
    if (!value) return value;
    for (const [source, english] of Object.entries(messages)) {
      for (const template of [source, english]) {
        const indices = [];
        const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{(\d+)\\\}/g, (_match, index) => { indices.push(Number(index)); return '([\\s\\S]*?)'; });
        const match = new RegExp('^' + escaped + '$').exec(value);
        if (match) { const args = []; indices.forEach((index, capture) => { args[index] = match[capture + 1]; }); return t(source, ...args); }
      }
    }
    return value;
  }
  window.ixenaLocale = { t, setLanguage, translateMessage, getLanguage: () => language };
  apply();
})();
