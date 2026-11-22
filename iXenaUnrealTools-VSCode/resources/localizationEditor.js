(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 100;
  const words = {
    title: ['本地化工作台', 'Localization workbench'],
    subtitle: ['收集项目文本，管理各语言翻译，生成 UE 本地化资源。', 'Gather project text, edit translations, and generate Unreal localization resources.'],
    ready: ['就绪', 'Ready'], running: ['任务执行中', 'Task running'], waiting: ['等待扫描', 'Waiting for scan'],
    target: ['本地化目标', 'Localization target'], culture: ['翻译语言', 'Translation language'],
    refresh: ['扫描 / 刷新', 'Scan / Refresh'], newTarget: ['新建目标', 'New target'], addCulture: ['添加语言', 'Add language'],
    total: ['文本总数', 'Total entries'], translated: ['已翻译', 'Translated'], untranslated: ['未翻译', 'Untranslated'], review: ['需复核', 'Needs review'],
    gatherExport: ['采集并导出', 'Gather and export'], importCompile: ['导入并编译', 'Import and compile'], stop: ['停止任务', 'Stop task'],
    importTranslations: ['导入翻译文件', 'Import translations'], exportFormat: ['导出格式', 'Export format'], export: ['导出', 'Export'],
    allLanguages: ['所有语言', 'All languages'], autoExport: ['保存后自动导出 PO / CSV / JSON', 'Export PO / CSV / JSON automatically after saving'],
    openFile: ['打开原始 PO 文件', 'Open source PO file'], advanced: ['单独执行步骤 / 打开配置', 'Individual steps / Configuration files'],
    runStep: ['执行步骤', 'Run step'], gather: ['采集', 'Gather'], exportPo: ['导出 PO', 'Export PO'], importPo: ['导入 PO', 'Import PO'], compile: ['编译资源', 'Compile resources'],
    openConfig: ['打开配置', 'Open config'], restoreDraft: ['恢复草稿', 'Restore draft'], discard: ['放弃修改', 'Discard changes'], save: ['保存翻译', 'Save translations'],
    search: ['搜索原文、翻译、标识或引用', 'Search source, translation, identity, or reference'], filter: ['筛选', 'Filter'], all: ['全部文本', 'All entries'], modified: ['本次修改', 'Modified'],
    identity: ['命名空间 / 标识', 'Namespace / Identity'], source: ['源文本', 'Source text'], translation: ['译文', 'Translation'], previous: ['上一页', 'Previous'], next: ['下一页', 'Next'],
    workflowHint: ['保存写入 PO；“导入并编译”后 UE 才能使用更新后的本地化资源。资源加载与打包语言仍由项目设置决定。', 'Saving updates the PO file. Run “Import and compile” to generate resources for Unreal. Loading and packaged languages remain project settings.'],
    noTarget: ['尚未发现目标', 'No target found'], noCulture: ['尚未配置语言', 'No languages configured'],
    noEntries: ['尚无可编辑翻译', 'No translations to edit yet'], noEntriesDetail: ['选择或新建目标后执行“采集并导出”。C++、蓝图、UMG 与字符串表的文本由 UE 采集流程读取。', 'Select or create a target, then run “Gather and export”. Unreal gathers text from C++, Blueprints, UMG, and string tables.'],
    noResults: ['没有符合筛选条件的文本', 'No matching entries'], noResultsDetail: ['尝试其他关键词，或将筛选切换为“全部文本”。', 'Try another search, or switch the filter to “All entries”.'],
    results: ['{0} 条文本', '{0} entries'], page: ['{0}–{1} / {2} · 每页 100 条', '{0}–{1} of {2} · 100 per page'],
    modifiedCount: ['有 {0} 条尚未保存的翻译', '{0} unsaved translations'], draftHint: ['保存后再切换目标、语言或运行 UE 流程。Ctrl / ⌘ + S 可保存。', 'Save before switching targets, languages, or running a pipeline. Ctrl / ⌘ + S saves.'],
    conflictTitle: ['文件已变化，草稿已保留', 'File changed; your draft is preserved'], conflictHint: ['磁盘版本与编辑时不同。请先复制需要保留的译文，再放弃草稿并重新载入，避免覆盖他人修改。', 'The file changed since editing began. Copy any translations you need, then discard the draft and reload to avoid overwriting other changes.'],
    recoveredTitle: ['找到上次未保存的草稿', 'An unsaved draft was found'], recoveredHint: ['恢复原目标和语言继续编辑，或明确放弃该草稿。', 'Restore its target and language to continue editing, or discard the draft.'],
    saveFirst: ['请先保存或放弃当前修改，再执行此操作。', 'Save or discard your changes before continuing.'],
    saved: ['翻译已保存。可继续导入并编译 UE 本地化资源。', 'Translations saved. You can now import and compile Unreal localization resources.'],
    saving: ['正在保存翻译…', 'Saving translations…'], obsolete: ['已过时', 'Obsolete'],
    unnamed: ['（无上下文标识）', '(No context identity)'], plural: ['复数源文本', 'Plural source'], pluralForm: ['复数形式 {0}', 'Plural form {0}'],
    reviewed: ['已检查译文，移除 fuzzy 标记', 'Reviewed translation; remove the fuzzy flag'],
    reference: ['引用', 'References'], readonly: ['此格式当前只读，请在原始 PO 文件中编辑。', 'This format is read-only here. Edit the original PO file.'],
    exportHint: ['导出当前语言的全部文本，不受搜索和筛选影响。', 'Exports every entry in the language, regardless of search and filters.'],
    autoExportHint: ['自动导出到项目 Saved/iXenaUnrealTools/LocalizationExports，不会自动执行 UE 编译。', 'Exports to the project Saved/iXenaUnrealTools/LocalizationExports folder; it does not run Unreal compilation.']
  };
  let language = document.documentElement.lang === 'en' ? 'en' : 'zh-CN';
  const t = (key, ...args) => (words[key]?.[language === 'en' ? 1 : 0] || key).replace(/\{(\d+)\}/g, (match, number) => Number(number) < args.length ? String(args[Number(number)]) : match);
  let current, deferredState, conflict = false, savePending = false, restoring = false;
  const saved = api.getState?.();
  const changes = new Map();
  let draftFile, draftRevision, draftTarget, draftCulture, page = 0;
  $('search').value = '';
  $('filter').value = 'all';

  // 关闭面板后，草稿由扩展的 workspaceState 恢复；已有本地草稿优先，不接受迟到消息覆盖。
  function restoreDraft(raw) {
    if (changes.size || !raw || raw.version !== 1 || typeof raw.filePath !== 'string' || !Array.isArray(raw.changes)
      || raw.changes.length > 100000 || raw.changes.some(change => !change || typeof change.id !== 'string'
        || !Array.isArray(change.translations) || change.translations.some(value => typeof value !== 'string'))
      || new Set(raw.changes.map(change => change.id)).size !== raw.changes.length) return false;
    if (raw.changes.length && (!raw.filePath || typeof raw.revision !== 'string' || typeof raw.targetId !== 'string' || typeof raw.culture !== 'string')) return false;
    for (const change of raw.changes) changes.set(change.id, { id: change.id, translations: change.translations.slice(), ...(change.reviewed === true ? { reviewed: true } : {}) });
    draftFile = changes.size ? raw.filePath : undefined;
    draftRevision = changes.size ? raw.revision : undefined;
    draftTarget = changes.size ? raw.targetId : undefined;
    draftCulture = changes.size ? raw.culture : undefined;
    page = Number.isSafeInteger(raw.page) && raw.page >= 0 ? raw.page : 0;
    $('search').value = typeof raw.query === 'string' ? raw.query : '';
    $('filter').value = ['all', 'untranslated', 'review', 'modified'].includes(raw.filter) ? raw.filter : 'all';
    return true;
  }
  restoreDraft(saved);

  function persist() {
    const draft = { version: 1, filePath: draftFile || current?.filePath || '', revision: draftRevision || current?.revision,
      targetId: draftTarget || current?.targetId, culture: draftCulture || current?.culture,
      changes: [...changes.values()], query: $('search').value, filter: $('filter').value, page };
    api.setState?.(draft);
    // 不延迟同步，用户关闭 Webview 时最后一次输入也已发送给扩展宿主。
    send('storeDraft', { draft });
  }
  function send(type, values) { api.postMessage({ type, ...(values || {}) }); }
  function node(tag, className, value) {
    const result = document.createElement(tag);
    if (className) result.className = className;
    if (value !== undefined) result.textContent = String(value);
    return result;
  }
  function note(value, error = false) {
    $('message').textContent = value;
    $('message').hidden = !value;
    $('message').className = error ? 'message error' : 'message';
  }
  function dirtyHere() { return changes.size > 0 && draftFile === current?.filePath; }
  function mayNavigate() {
    if (changes.size) { note(t('saveFirst'), true); return false; }
    return !current?.busy && !savePending;
  }
  function selectedTarget() { return current?.targets?.find(target => target.id === current.targetId); }
  function selectOptions(element, values, selected, emptyText) {
    element.replaceChildren();
    if (!values.length) {
      const option = node('option', '', emptyText); option.value = ''; element.append(option);
    } else for (const value of values) {
      const option = node('option', '', value.label); option.value = value.value;
      if (value.value === selected) option.selected = true;
      element.append(option);
    }
    element.value = values.some(value => value.value === selected) ? selected : values[0]?.value || '';
  }
  function localize() {
    document.documentElement.lang = language;
    document.title = `iXena · ${t('title')}`;
    for (const element of document.querySelectorAll('[data-i18n]')) element.textContent = t(element.getAttribute('data-i18n'));
    for (const element of document.querySelectorAll('[data-placeholder]')) element.setAttribute('placeholder', t(element.getAttribute('data-placeholder')));
    $('translation-progress').setAttribute('aria-label', t('translated'));
    $('target-select').setAttribute('aria-label', t('target'));
    $('culture-select').setAttribute('aria-label', t('culture'));
    $('filter').setAttribute('aria-label', t('filter'));
    $('auto-export').parentElement.title = t('autoExportHint');
    $('export').title = t('exportHint');
  }
  function effective(entry) {
    const change = dirtyHere() ? changes.get(entry.id) : undefined;
    return change ? { ...entry, translations: change.translations, flags: change.reviewed ? entry.flags.filter(flag => flag !== 'fuzzy') : entry.flags } : entry;
  }
  function entryState(entry) {
    if (entry.flags?.includes('fuzzy') || current?.issues?.[entry.id]?.length) return 'review';
    return entry.translations.length && entry.translations.every(value => value.trim().length > 0) ? 'translated' : 'untranslated';
  }
  function updateDraftUi() {
    $('draft-banner').hidden = !changes.size;
    $('draft-banner').className = `draft-banner${conflict ? ' conflict' : ''}`;
    const orphan = changes.size > 0 && draftFile !== current?.filePath;
    $('draft-title').textContent = orphan ? t('recoveredTitle') : conflict ? t('conflictTitle') : t('modifiedCount', changes.size);
    $('draft-detail').textContent = orphan ? t('recoveredHint') : conflict ? t('conflictHint') : t('draftHint');
    $('restore-draft').hidden = !orphan;
    $('restore-draft').disabled = Boolean(current?.busy || savePending || restoring);
    $('save').hidden = Boolean(orphan);
    $('save').disabled = !changes.size || conflict || Boolean(current?.busy || current?.readOnly || savePending);
    $('discard').disabled = Boolean(current?.busy || savePending);
  }
  function setChanged(entry, index, value, reviewed) {
    if (current?.readOnly || current?.busy || savePending || conflict) return;
    const previous = changes.get(entry.id);
    const translations = previous ? previous.translations.slice() : entry.translations.slice();
    if (typeof index === 'number') translations[index] = value;
    const checked = reviewed === undefined ? previous?.reviewed : reviewed;
    const same = translations.length === entry.translations.length && translations.every((item, position) => item === entry.translations[position]);
    if (same && !checked) changes.delete(entry.id);
    else changes.set(entry.id, { id: entry.id, translations, ...(checked ? { reviewed: true } : {}) });
    if (changes.size) {
      draftFile = current.filePath; draftRevision = current.revision; draftTarget = current.targetId; draftCulture = current.culture;
    } else { draftFile = draftRevision = draftTarget = draftCulture = undefined; }
    const row = document.querySelector(`[data-entry-index="${current.entries.indexOf(entry)}"]`);
    row?.classList.toggle('modified', changes.has(entry.id));
    updateControls(); persist();
  }
  function updateControls() {
    const busy = Boolean(current?.busy || savePending);
    const target = selectedTarget(), configs = target?.configs || {};
    const hasFile = Boolean(current?.filePath), hasTarget = Boolean(target);
    for (const id of ['target-select', 'culture-select', 'refresh', 'new-target']) $(id).disabled = busy;
    $('target-select').disabled = busy || !current?.targets?.length;
    $('culture-select').disabled = busy || !target?.cultures?.length;
    $('add-culture').disabled = busy || !hasTarget;
    $('gather-export').disabled = busy || !hasTarget || !configs.gather || !configs.export;
    $('import-compile').disabled = busy || !hasTarget || !configs.import || !configs.compile;
    $('import-translations').disabled = busy || !hasFile || Boolean(current?.readOnly);
    $('export').disabled = busy || !hasFile || (current?.readOnly && $('export-format').value !== 'po');
    $('open-file').disabled = !hasFile;
    $('export-format').disabled = busy || !hasFile;
    $('export-all').disabled = busy || !hasTarget;
    $('auto-export').disabled = busy;
    $('stop').hidden = !current?.busy;
    $('connection-state').className = current?.busy ? 'status-chip busy' : 'status-chip';
    $('connection-state').textContent = current?.busy ? t('running') : current ? t('ready') : t('waiting');
    for (const action of ['gather', 'export', 'import', 'compile']) {
      $(`run-${action}`).disabled = busy || !configs[action];
      $(`config-${action}`).disabled = !configs[action];
    }
    for (const input of document.querySelectorAll('.translation-input,.review-checkbox')) input.disabled = busy || conflict || Boolean(current?.readOnly);
    updateDraftUi();
  }
  function visibleEntries() {
    const query = $('search').value.trim().toLocaleLowerCase(), filter = $('filter').value;
    return (current?.entries || []).filter(entry => !entry.header && !entry.obsolete).filter(entry => {
      const value = effective(entry), status = entryState(value);
      if (filter === 'modified' && !(dirtyHere() && changes.has(entry.id))) return false;
      if (filter === 'untranslated' && value.translations.length && value.translations.every(text => text.trim().length > 0)) return false;
      if (filter === 'review' && status !== 'review') return false;
      return !query || [value.context, value.source, value.pluralSource || '', ...value.translations, ...(value.references || [])].join('\n').toLocaleLowerCase().includes(query);
    });
  }
  function renderEntries() {
    const entries = visibleEntries();
    const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    if (current) page = Math.min(Math.max(0, page), pages - 1);
    $('entries').replaceChildren();
    for (const entry of entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
      const value = effective(entry), row = node('tr', dirtyHere() && changes.has(entry.id) ? 'modified' : '');
      row.setAttribute('data-entry-index', String(current.entries.indexOf(entry)));
      const identity = node('td'), source = node('td'), translation = node('td');
      identity.append(node('div', 'entry-context', entry.context || t('unnamed')), node('span', 'entry-status', t(entryState(value))));
      if (entry.references?.length) identity.append(node('div', 'entry-reference', entry.references.join('\n')));
      if (entry.comments?.length) {
        const comments = node('details', 'entry-comments'); comments.append(node('summary', '', t('reference')), node('div', '', entry.comments.join('\n'))); identity.append(comments);
      }
      source.append(node('div', 'source-text', entry.source));
      if (entry.pluralSource !== undefined) {
        const plural = node('div', 'source-plural'); plural.append(node('div', 'form-label', t('plural')), node('div', 'source-text', entry.pluralSource)); source.append(plural);
      }
      const formCount = Math.max(1, value.translations.length);
      for (let index = 0; index < formCount; index++) {
        const block = node('div', 'translation-block');
        if (entry.pluralSource !== undefined) block.append(node('div', 'form-label', t('pluralForm', index)));
        const area = node('textarea', 'translation-input'); area.value = value.translations[index] || ''; area.rows = 3;
        area.setAttribute('aria-label', `${t('translation')} · ${entry.context || entry.source} · ${index}`);
        area.setAttribute('spellcheck', 'true'); if (current.culture) area.setAttribute('lang', current.culture);
        area.addEventListener('input', () => setChanged(entry, index, area.value));
        block.append(area); translation.append(block);
      }
      if (entry.flags?.includes('fuzzy')) {
        const label = node('label', 'review-check'), check = node('input', 'review-checkbox'); check.type = 'checkbox'; check.checked = Boolean(changes.get(entry.id)?.reviewed && dirtyHere());
        check.addEventListener('change', () => setChanged(entry, undefined, undefined, check.checked));
        label.append(check, node('span', '', t('reviewed'))); translation.append(label);
      }
      const issues = current.issues?.[entry.id] || [];
      if (issues.length) { const list = node('ul', 'entry-issues'); for (const issue of issues) list.append(node('li', '', issue)); translation.append(list); }
      row.append(identity, source, translation); $('entries').append(row);
    }
    $('result-count').textContent = t('results', entries.length);
    $('page-label').textContent = t('page', entries.length ? page * PAGE_SIZE + 1 : 0, Math.min((page + 1) * PAGE_SIZE, entries.length), entries.length);
    $('prev-page').disabled = !current || page <= 0; $('next-page').disabled = !current || page >= pages - 1;
    $('empty-state').hidden = entries.length > 0;
    const anyEntries = current?.entries?.some(entry => !entry.header && !entry.obsolete);
    $('empty-title').textContent = t(anyEntries ? 'noResults' : 'noEntries'); $('empty-detail').textContent = t(anyEntries ? 'noResultsDetail' : 'noEntriesDetail');
    updateControls();
  }
  function render() {
    localize();
    const targets = current?.targets || [], target = selectedTarget();
    selectOptions($('target-select'), targets.map(item => ({ label: `${item.scopeName} / ${item.name}`, value: item.id })), current?.targetId, t('noTarget'));
    selectOptions($('culture-select'), (target?.cultures || []).map(value => ({ value, label: value })), current?.culture, t('noCulture'));
    $('project-path').textContent = target?.projectPath || '';
    $('file-path').textContent = current?.filePath || '';
    for (const key of ['total', 'translated', 'untranslated', 'review']) $(`stat-${key}`).textContent = String(current?.stats?.[key] || 0);
    const percentage = current?.stats?.total ? Math.round(100 * current.stats.translated / current.stats.total) : 0;
    $('translation-progress').value = percentage; $('progress-label').textContent = `${percentage}%`;
    $('auto-export').checked = Boolean(current?.autoExport);
    const warnings = [...(current?.warnings || [])];
    if (current?.readOnly) warnings.push(t('readonly'));
    $('warnings').replaceChildren(); $('warnings').hidden = !warnings.length;
    if (warnings.length) { const list = node('ul'); for (const warning of new Set(warnings)) list.append(node('li', '', warning)); $('warnings').append(list); }
    renderEntries();
  }
  function clearDraft() {
    changes.clear(); draftFile = draftRevision = draftTarget = draftCulture = undefined; conflict = false; savePending = false;
  }
  function save() {
    if (!dirtyHere() || conflict || current?.busy || current?.readOnly || savePending) return;
    savePending = true; note(t('saving')); updateControls();
    send('save', { filePath: current.filePath, revision: draftRevision || current.revision, changes: [...changes.values()] });
  }

  // 原始文本、目标名和路径均以文本节点显示，不允许注入网页标记。
  $('target-select').addEventListener('change', () => {
    const targetId = $('target-select').value;
    if (mayNavigate()) { page = 0; send('selectTarget', { targetId }); } else render();
  });
  $('culture-select').addEventListener('change', () => {
    const culture = $('culture-select').value;
    if (mayNavigate()) { page = 0; send('selectCulture', { culture }); } else render();
  });
  for (const [id, type] of [['refresh', 'refresh'], ['new-target', 'newTarget'], ['add-culture', 'addCulture']]) $(id).addEventListener('click', () => { if (mayNavigate()) send(type); });
  for (const [id, action] of [['gather-export', 'gatherExport'], ['import-compile', 'importCompile'], ...['gather', 'export', 'import', 'compile'].map(action => [`run-${action}`, action])]) $(id).addEventListener('click', () => { if (mayNavigate()) send('pipeline', { action }); });
  for (const action of ['gather', 'export', 'import', 'compile']) $(`config-${action}`).addEventListener('click', () => send('openConfig', { action }));
  $('save').addEventListener('click', save);
  $('discard').addEventListener('click', () => {
    clearDraft(); restoring = false;
    if (deferredState) { current = deferredState; deferredState = undefined; }
    note(''); persist(); render(); send('discard');
  });
  $('restore-draft').addEventListener('click', () => {
    if (!draftTarget || current?.busy) return;
    restoring = true; updateControls();
    if (current?.targetId === draftTarget) send('selectCulture', { culture: draftCulture }); else send('selectTarget', { targetId: draftTarget });
  });
  $('stop').addEventListener('click', () => send('stop'));
  $('open-file').addEventListener('click', () => send('openFile'));
  $('import-translations').addEventListener('click', () => { if (mayNavigate() && !current?.readOnly) send('import', { filePath: current.filePath, revision: current.revision }); });
  $('export').addEventListener('click', () => {
    if (mayNavigate()) send('export', { format: $('export-format').value, filePath: current?.filePath, all: $('export-all').checked });
  });
  $('export-format').addEventListener('change', updateControls);
  $('auto-export').addEventListener('change', () => send('setAutoExport', { enabled: $('auto-export').checked }));
  for (const [id, event] of [['search', 'input'], ['filter', 'change']]) $(id).addEventListener(event, () => { page = 0; renderEntries(); persist(); });
  $('prev-page').addEventListener('click', () => { if (page > 0) page--; renderEntries(); persist(); });
  $('next-page').addEventListener('click', () => { page++; renderEntries(); persist(); });
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key?.toLowerCase() === 's') { event.preventDefault(); save(); }
  });
  window.addEventListener('message', event => {
    const incoming = event.data;
    if (!incoming || typeof incoming !== 'object') return;
    if (incoming.type === 'restoreDraft') {
      if (restoreDraft(incoming.draft)) {
        api.setState?.(incoming.draft);
        if (current) render();
      }
      return;
    }
    if (incoming.type === 'error') { savePending = false; restoring = false; note(String(incoming.message || ''), true); updateControls(); return; }
    if (incoming.type === 'status') {
      if (current && typeof incoming.busy === 'boolean') current.busy = incoming.busy;
      if (incoming.message) note(String(incoming.message)); updateControls(); return;
    }
    if (incoming.type === 'language') { language = incoming.language === 'en' ? 'en' : 'zh-CN'; render(); return; }
    if (incoming.type !== 'state') return;
    language = incoming.language === 'en' ? 'en' : 'zh-CN';
    if (incoming.reason === 'saved' && changes.size && incoming.filePath === draftFile) {
      clearDraft(); deferredState = undefined; current = incoming;
      if (!$('message').classList.contains('error')) note(t('saved'));
    } else if (changes.size && current && draftFile === current.filePath && (incoming.filePath !== draftFile || incoming.revision !== draftRevision)) {
      conflict = true; deferredState = incoming;
      current = { ...current, language: incoming.language, busy: incoming.busy, autoExport: incoming.autoExport, targets: incoming.targets };
    } else {
      current = incoming;
      if (changes.size && incoming.filePath === draftFile) {
        conflict = incoming.revision !== draftRevision;
        restoring = false;
      } else if (restoring && incoming.targetId === draftTarget && incoming.culture !== draftCulture) {
        send('selectCulture', { culture: draftCulture });
      }
      if (incoming.status && incoming.reason !== 'error') note(incoming.status);
    }
    render(); persist();
  });
  render();
  send('ready', { ...(draftTarget ? { targetId: draftTarget, culture: draftCulture } : {}) });
})();
