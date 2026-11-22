'use strict';
(() => {
  const { t } = window.ixenaLocale;
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  const content = document.getElementById('content');
  const notices = document.getElementById('notices');
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  let state;
  let tab = ['overview', 'modules', 'plugins', 'json'].includes(saved.tab) ? saved.tab : 'overview';
  let filter = typeof saved.filter === 'string' ? saved.filter : '';
  let dialect = saved.dialect === 'legacy' ? 'legacy' : 'modern';
  let dialectExplicit = !!saved.dialect;
  let addOpen = false;
  let addDraft = { Name: '', Type: 'Runtime', LoadingPhase: 'Default', Enabled: true };
  let feedback = '';
  let conflicted = false;
  let pending;
  let sequence = 0;
  let saveRequested = false;
  let sourceRequested = false;
  let deleteIndex = -1;
  let composing = false;
  let renderDeferred = false;
  const drafts = new Map();
  if (Array.isArray(saved.drafts)) {
    for (const item of saved.drafts) {
      if (item && typeof item.key === 'string' && item.operation && Array.isArray(item.operation.path)) {
        drafts.set(item.key, { ...item, sequence: ++sequence });
      }
    }
    conflicted = drafts.size > 0;
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(text, handler, className) {
    const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', handler); return node;
  }
  function keyOf(path) { return JSON.stringify(path); }
  function valueAt(path) {
    let value = state && state.data;
    for (const part of path) value = value && typeof value === 'object' ? value[part] : undefined;
    return value;
  }
  function remember() {
    vscode.setState({ tab, filter, dialect: dialectExplicit ? dialect : undefined,
      drafts: [...drafts.entries()].map(([key, draft]) => ({ ...draft, key })) });
  }
  function invalidDrafts() { return [...drafts.values()].some(draft => draft.error); }
  function structuralBusy() { return pending && !pending.key; }
  function busyControls() { return conflicted || structuralBusy(); }

  function renderNotices() {
    notices.replaceChildren();
    if (conflicted) {
      const block = el('div', 'notice warning');
      block.append(el('strong', '', t("表单需要重新同步")),
        el('p', '', t("文件已被其他编辑器修改，或恢复了尚未应用的输入。你的表单输入仍保留；请核对后重新读取。")));
      block.append(button(t("重新读取（放弃未应用输入）"), () => {
        drafts.clear(); pending = undefined; conflicted = false; feedback = ''; saveRequested = false; sourceRequested = false;
        remember(); vscode.postMessage({ type: 'reload' });
      }));
      notices.append(block);
    }
    if (invalidDrafts()) {
      const block = el('div', 'notice error');
      block.append(el('strong', '', t("有字段尚未写入文件")), el('p', '', t("请修正标红的输入，或用字段旁的“撤回输入”放弃修改。这些输入尚未进入可保存的文档。")));
      notices.append(block);
    }
    if (feedback) notices.append(el('div', 'notice compact', feedback));
    for (const error of state?.errors || []) notices.append(el('div', 'notice error', error));
    if (state?.warnings?.length) {
      const details = el('details', 'notice warning compact');
      details.append(el('summary', '', t("文件提示 · {0} 项", state.warnings.length)));
      const list = el('ul');
      for (const warning of state.warnings) list.append(el('li', '', warning));
      details.append(list); notices.append(details);
    }
    const status = document.getElementById('save-state');
    status.textContent = conflicted ? t("需要同步") : invalidDrafts() ? t("输入未应用") : pending || drafts.size ? t("正在应用…") : state?.dirty ? t("● 未保存") : t("已保存");
    status.classList.toggle('dirty', !!state?.dirty || drafts.size > 0);
    document.getElementById('save').disabled = !state?.valid || conflicted || invalidDrafts();
  }

  function flush() {
    remember(); renderNotices();
    if (!state?.valid || conflicted || pending) return;
    const next = [...drafts.entries()].find(([, draft]) => !draft.error);
    if (next) {
      const [key, draft] = next;
      pending = { key, sequence: draft.sequence, requestId: `edit-${++sequence}` };
      vscode.postMessage({ type: 'edit', requestId: pending.requestId, version: state.version, operation: draft.operation });
      renderNotices(); return;
    }
    if (drafts.size > 0) { saveRequested = false; sourceRequested = false; return; }
    if (sourceRequested) { sourceRequested = false; vscode.postMessage({ type: 'source' }); return; }
    if (saveRequested) { saveRequested = false; vscode.postMessage({ type: 'save', requestId: `save-${++sequence}` }); }
  }

  function parseInput(field, raw) {
    if (field.type === 'boolean') {
      if (raw === 'unset') {
        if (field.required) throw new Error(t("此字段必需，请选择启用或禁用。"));
        return { remove: true };
      }
      return { value: raw === 'true' };
    }
    if (field.type === 'integer') {
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < (field.min || 0)) {
        throw new Error(t("请输入大于或等于 {0} 的整数。", field.min || 0));
      }
      return { value: Number(raw) };
    }
    if (field.type === 'list') {
      const values = raw.split(/[,，\n\r]+/).map(value => value.trim()).filter(Boolean);
      if (new Set(values.map(value => value.toLowerCase())).size !== values.length) throw new Error(t("列表中有重复项。"));
      return { value: values };
    }
    if (field.type === 'choice' && raw === '__unset__') {
      if (field.required) throw new Error(t("此字段不能为空。"));
      return { remove: true };
    }
    if (field.required && !raw.trim()) throw new Error(t("此字段不能为空。"));
    if (field.key === 'Name' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) throw new Error(t("名称应以英文字母或下划线开头，仅包含字母、数字和下划线。"));
    return { value: raw };
  }

  function queueField(field, path, raw, input, errorNode, undoButton) {
    const key = keyOf(path);
    if (drafts.get(key)?.raw === raw && !drafts.get(key)?.error) return;
    let operation, error;
    try {
      const parsed = parseInput(field, raw);
      operation = parsed.remove ? { type: 'delete', path } : { type: 'set', path, value: parsed.value };
    } catch (failure) { error = failure.message; operation = { type: 'set', path, value: raw }; }
    feedback = '';
    drafts.set(key, { sequence: ++sequence, operation, raw, error });
    input.setAttribute('aria-invalid', error ? 'true' : 'false');
    errorNode.textContent = error || '';
    undoButton.hidden = false;
    flush();
  }

  function fieldControl(field, path, compact) {
    const value = valueAt(path), exists = value !== undefined, key = keyOf(path), draft = drafts.get(key);
    const wrap = el('div', `field${field.type === 'text' ? ' wide' : ''}${compact ? ' compact-field' : ''}`);
    const line = el('div', 'field-label');
    const label = el('label', '', field.label);
    const id = `field-${path.map(String).join('-')}`;
    label.htmlFor = id;
    line.append(label, el('code', 'key', field.key));
    const actions = el('span', 'field-actions');
    const undo = button(t("撤回输入"), () => {
      if (pending?.key === key) { feedback = t("正在应用此字段，请稍后再撤回。"); renderNotices(); return; }
      drafts.delete(key); render(); flush();
    }, 'text-button');
    undo.hidden = !draft;
    actions.append(undo);
    if (!field.required) {
      const reset = button(t("移除字段"), () => {
        if (busyControls()) return;
        drafts.set(key, { sequence: ++sequence, operation: { type: 'delete', path }, raw: undefined });
        flush();
      }, 'text-button');
      reset.disabled = !exists || busyControls(); reset.title = t("从 JSON 移除此键，恢复引擎缺省行为"); actions.append(reset);
    }
    line.append(actions); wrap.append(line);
    let input;
    if (field.type === 'boolean' || field.type === 'choice') {
      input = document.createElement('select');
      const options = field.type === 'boolean' ? [['unset', t("未设置（沿用默认）")], ['true', t("启用 / true")], ['false', t("禁用 / false")]]
        : [['__unset__', t("未设置（沿用默认）")], ...(field.choices || []).map(item => [item, item])];
      if (field.type === 'choice' && typeof value === 'string' && !field.choices?.includes(value)) options.push([value, t("{0} · 原有值", value)]);
      for (const [optionValue, name] of options) {
        const option = el('option', '', name); option.value = optionValue;
        if (field.required && ['unset', '__unset__'].includes(optionValue)) option.disabled = true;
        input.append(option);
      }
      input.value = draft ? draft.raw ?? (field.type === 'boolean' ? 'unset' : '__unset__')
        : field.type === 'boolean' ? (typeof value === 'boolean' ? String(value) : 'unset') : (typeof value === 'string' ? value : '__unset__');
    } else {
      input = document.createElement(field.type === 'text' ? 'textarea' : 'input');
      if (field.type === 'text') input.rows = 3;
      else input.type = 'text';
      if (field.type === 'integer') input.inputMode = 'numeric';
      input.value = draft ? draft.raw ?? '' : field.type === 'list' ? (Array.isArray(value) ? value.join(', ') : '')
        : typeof value === 'string' || typeof value === 'number' ? String(value) : '';
      input.placeholder = exists ? '' : t("未设置");
      input.spellcheck = false;
    }
    input.id = id; input.dataset.fieldKey = key; input.disabled = !!busyControls();
    input.setAttribute('aria-invalid', draft?.error ? 'true' : 'false');
    const errorNode = el('span', 'field-error', draft?.error || '');
    input.addEventListener(input.tagName === 'SELECT' ? 'change' : 'input', event => {
      if (event.isComposing || composing) return;
      queueField(field, path, input.value, input, errorNode, undo);
    });
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => {
      composing = false;
      queueField(field, path, input.value, input, errorNode, undo);
      if (renderDeferred) { renderDeferred = false; requestAnimationFrame(() => render()); }
    });
    wrap.append(input, errorNode);
    if (field.help) wrap.append(el('p', 'help', field.help));
    if (exists && ((field.type === 'boolean' && typeof value !== 'boolean') || (field.type === 'list' && !Array.isArray(value)))) {
      wrap.append(el('p', 'field-error', t("原字段类型与预期不同。原值会保留，只有修改此字段时才替换。")));
    }
    return wrap;
  }

  function unknownKeys(object, fields, extra) {
    const known = new Set([...fields.map(field => field.key), ...(extra || [])]);
    return Object.keys(object).filter(key => !known.has(key));
  }
  function preserved(keys) {
    if (!keys.length) return el('span');
    const block = el('div', 'preserved');
    block.append(el('span', '', t("保留其他字段 ")));
    for (const key of keys) block.append(el('code', '', key));
    return block;
  }
  function overview() {
    const heading = el('div', 'section-heading');
    heading.append(el('div', '', ''), el('span', 'pill', state.kind === 'uproject' ? 'UNREAL PROJECT' : 'UNREAL PLUGIN'));
    heading.firstChild.append(el('h2', '', state.kind === 'uproject' ? t("项目描述") : t("插件描述")),
      el('p', 'muted', state.kind === 'uproject' ? t("维护引擎关联、项目信息和默认插件行为。") : t("维护插件信息、发布标记与内容支持。")));
    content.append(heading);
    const primaryFields = state.rootFields.filter(field => !['boolean', 'list'].includes(field.type));
    const options = state.rootFields.filter(field => ['boolean', 'list'].includes(field.type));
    const basic = el('section', 'card'); basic.append(el('h3', '', t("基本信息")));
    const grid = el('div', 'form-grid');
    for (const field of primaryFields) grid.append(fieldControl(field, [field.key]));
    basic.append(grid); content.append(basic);
    const flags = el('section', 'card'); flags.append(el('h3', '', t("行为与平台")));
    const flagGrid = el('div', 'form-grid');
    for (const field of options) flagGrid.append(fieldControl(field, [field.key]));
    flags.append(flagGrid); content.append(flags);
    content.append(preserved(unknownKeys(state.data, state.rootFields, ['Modules', 'Plugins'])));
  }

  function structuralOperation(operation) {
    if (pending || drafts.size || conflicted) {
      feedback = t("请先完成当前字段的应用或修正输入，再增删条目。"); renderNotices(); return;
    }
    pending = { requestId: `structure-${++sequence}` };
    feedback = ''; vscode.postMessage({ type: 'edit', version: state.version, requestId: pending.requestId, operation });
    render();
  }

  function visiblePlatformFields(fields, row) {
    const hasModern = own(row, 'PlatformAllowList') || own(row, 'PlatformDenyList');
    const hasLegacy = own(row, 'WhitelistPlatforms') || own(row, 'BlacklistPlatforms');
    return fields.filter(field => {
      if (!['PlatformAllowList', 'PlatformDenyList', 'WhitelistPlatforms', 'BlacklistPlatforms'].includes(field.key)) return true;
      if (hasModern && hasLegacy) return true;
      return hasLegacy ? !!field.legacy : hasModern ? !field.legacy : (dialect === 'legacy') === !!field.legacy;
    });
  }
  function collectionView(collection) {
    const isModule = collection === 'Modules', rows = state.data[collection] || [], fields = isModule ? state.moduleFields : state.pluginFields;
    const heading = el('div', 'section-heading');
    const title = el('div'); title.append(el('h2', '', isModule ? t("模块声明") : t("插件引用")),
      el('p', 'muted', isModule ? t("设置模块类型与加载时机。C++ 依赖请继续使用 Build.cs 依赖编辑器。") : t("维护此项目或插件引用的插件；开关只修改描述文件。")));
    const add = button(isModule ? t("+ 新增模块") : t("+ 引用插件"), () => { addOpen = !addOpen; deleteIndex = -1; render(); }, 'primary');
    add.disabled = !!busyControls(); heading.append(title, add); content.append(heading);
    const tools = el('div', 'list-toolbar');
    const search = el('input', 'search'); search.type = 'search'; search.value = filter; search.placeholder = isModule ? t("按模块名称筛选…") : t("按插件名称筛选…"); search.dataset.filter = 'true';
    search.setAttribute('aria-label', t("筛选条目")); search.addEventListener('input', () => { filter = search.value; render(true); remember(); });
    const switcher = el('label', 'dialect'); switcher.append(el('span', 'muted', t("新平台字段 ")));
    const select = document.createElement('select');
    for (const [value, label] of [['modern', 'Allow / Deny'], ['legacy', 'Whitelist / Blacklist']]) { const option = el('option', '', label); option.value = value; select.append(option); }
    select.value = dialect; select.title = t("仅影响没有平台字段的条目；已有新旧字段保持原名。");
    select.addEventListener('change', () => { dialect = select.value; dialectExplicit = true; render(); remember(); });
    switcher.append(select); tools.append(search, switcher); content.append(tools);
    if (addOpen) renderAdd(collection);
    const filtered = rows.map((row, index) => ({ row, index })).filter(({ row }) => String(row.Name || '').toLowerCase().includes(filter.toLowerCase()));
    if (!filtered.length) {
      const empty = el('div', 'empty card'); empty.append(el('h3', '', rows.length ? t("没有匹配条目") : isModule ? t("尚未声明 C++ 模块") : t("尚未显式引用插件")),
        el('p', 'muted', rows.length ? t("试试其他名称或清空筛选。") : isModule ? t("纯内容项目或插件可以不包含模块。") : t("新增引用后，可在这里启用、禁用或设置平台限制。")));
      content.append(empty);
    }
    for (const { row, index } of filtered) {
      const card = el('article', 'card row-card');
      const rowHeader = el('div', 'row-header');
      const identity = el('div', 'row-identity'); identity.append(el('span', 'row-icon', isModule ? 'M' : 'P'), el('h3', '', typeof row.Name === 'string' ? row.Name : t("未命名 {0}", index + 1)));
      identity.append(el('span', 'pill', isModule ? String(row.Type || t("未设置")) : row.Enabled === true ? t("启用") : row.Enabled === false ? t("禁用") : t("未设置")));
      rowHeader.append(identity);
      if (deleteIndex === index) {
        const actions = el('div', 'row-actions'); actions.append(el('span', 'muted', t("移除此声明？")),
          button(t("确认移除"), () => structuralOperation({ type: 'remove', collection, index }), 'danger'),
          button(t("取消"), () => { deleteIndex = -1; render(); })); rowHeader.append(actions);
      } else {
        const remove = button(t("移除"), () => { deleteIndex = index; render(); }, 'text-button'); remove.disabled = !!busyControls(); rowHeader.append(remove);
      }
      card.append(rowHeader);
      const grid = el('div', 'form-grid');
      const main = isModule ? ['Name', 'Type', 'LoadingPhase'] : ['Name', 'Enabled', 'Optional'];
      for (const field of fields.filter(item => main.includes(item.key))) grid.append(fieldControl(field, [collection, index, field.key], true));
      card.append(grid);
      const details = el('details', 'row-details');
      const storageKey = `${collection}:${index}`;
      details.open = detailsOpen.has(storageKey);
      details.addEventListener('toggle', () => { if (details.open) detailsOpen.add(storageKey); else detailsOpen.delete(storageKey); });
      details.append(el('summary', '', t("平台限制与其他选项")));
      const more = el('div', 'form-grid');
      for (const field of visiblePlatformFields(fields, row).filter(item => !main.includes(item.key))) more.append(fieldControl(field, [collection, index, field.key], true));
      details.append(more); card.append(details, preserved(unknownKeys(row, fields))); content.append(card);
    }
  }
  const detailsOpen = new Set();

  function renderAdd(collection) {
    const isModule = collection === 'Modules';
    const panel = el('form', 'card add-card'); panel.append(el('h3', '', isModule ? t("新增模块声明") : t("新增插件引用")));
    const grid = el('div', 'form-grid');
    const label = el('label', 'field'); label.append(el('span', '', isModule ? t("模块名称") : t("插件名称")));
    const name = document.createElement('input'); name.type = 'text'; name.value = addDraft.Name; name.placeholder = isModule ? t("例如 PlanetWorldEditor") : t("例如 EnhancedInput"); name.required = true;
    name.pattern = '[A-Za-z_][A-Za-z0-9_]*'; name.dataset.addName = 'true'; name.disabled = !!busyControls();
    name.addEventListener('input', () => { addDraft.Name = name.value; }); label.append(name); grid.append(label);
    if (isModule) {
      for (const key of ['Type', 'LoadingPhase']) {
        const field = state.moduleFields.find(item => item.key === key), group = el('label', 'field'); group.append(el('span', '', field.label));
        const select = document.createElement('select');
        for (const choice of field.choices) { const option = el('option', '', choice); option.value = choice; select.append(option); }
        select.value = addDraft[key]; select.disabled = !!busyControls(); select.addEventListener('change', () => { addDraft[key] = select.value; }); group.append(select); grid.append(group);
      }
    }
    panel.append(grid);
    const actions = el('div', 'row-actions');
    const submit = el('button', 'primary', isModule ? t("添加声明") : t("添加并启用")); submit.type = 'submit'; submit.disabled = !!busyControls();
    actions.append(submit, button(t("取消"), () => { addOpen = false; addDraft.Name = ''; render(); })); panel.append(actions);
    panel.addEventListener('submit', event => {
      event.preventDefault();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(addDraft.Name)) { feedback = t("请填写有效的名称。"); renderNotices(); return; }
      structuralOperation({ type: 'add', collection, value: isModule ? { Name: addDraft.Name, Type: addDraft.Type, LoadingPhase: addDraft.LoadingPhase } : { Name: addDraft.Name, Enabled: true } });
    }); content.append(panel);
  }

  function render(restoreSearch = false) {
    if (!state) return;
    if (composing) { renderDeferred = true; renderNotices(); return; }
    const active = document.activeElement;
    const focused = active && { key: active.dataset.fieldKey, search: active.dataset.filter,
      addName: active.dataset.addName, start: active.selectionStart, end: active.selectionEnd };
    const scroll = window.scrollY;
    document.getElementById('filename').textContent = state.filename;
    document.getElementById('filepath').textContent = state.filePath;
    document.getElementById('module-count').textContent = Array.isArray(state.data.Modules) ? state.data.Modules.length : 0;
    document.getElementById('plugin-count').textContent = Array.isArray(state.data.Plugins) ? state.data.Plugins.length : 0;
    for (const element of document.querySelectorAll('[data-tab]')) {
      element.classList.toggle('active', element.dataset.tab === tab); element.setAttribute('aria-current', element.dataset.tab === tab ? 'page' : 'false');
    }
    content.replaceChildren(); renderNotices();
    if (!state.valid) {
      const empty = el('div', 'empty card'); empty.append(el('h2', '', t("请先修复 JSON")),
        el('p', 'muted', t("文件内容保持不变。重复键、注释、尾随逗号或结构错误需要先在 JSON 源码中修复。")),
        button(t("打开 JSON 源码"), () => vscode.postMessage({ type: 'source' }), 'primary')); content.append(empty);
    } else if (tab === 'overview') overview();
    else if (tab === 'modules') collectionView('Modules');
    else if (tab === 'plugins') collectionView('Plugins');
    else {
      const heading = el('div', 'section-heading'); heading.append(el('div', '', ''), el('span', 'pill', t("只读预览")));
      heading.firstChild.append(el('h2', '', t("当前 JSON")), el('p', 'muted', t("显示编辑器缓冲区的完整内容，包含所有未展示字段。")));
      content.append(heading, el('pre', 'json-preview', state.source));
    }
    let target;
    if (focused?.key) target = [...content.querySelectorAll('[data-field-key]')].find(node => node.dataset.fieldKey === focused.key);
    else if (focused?.search || restoreSearch) target = content.querySelector('[data-filter]');
    else if (focused?.addName) target = content.querySelector('[data-add-name]');
    if (target && !target.disabled) {
      target.focus({ preventScroll: true });
      if (typeof focused?.start === 'number') { try { target.setSelectionRange(focused.start, focused.end); } catch {} }
    }
    window.scrollTo(0, scroll);
  }

  for (const element of document.querySelectorAll('[data-tab]')) element.addEventListener('click', () => {
    tab = element.dataset.tab; filter = ''; addOpen = false; deleteIndex = -1; render(); remember();
  });
  document.getElementById('save').addEventListener('click', () => { saveRequested = true; flush(); });
  document.getElementById('source').addEventListener('click', () => {
    if (invalidDrafts() || conflicted) { feedback = t("尚有未应用输入；请先修正或撤回，再切换源码。"); renderNotices(); return; }
    if (!state?.valid) { vscode.postMessage({ type: 'source' }); return; }
    sourceRequested = true; flush();
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || composing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault(); event.stopPropagation(); saveRequested = true; flush();
    }
  }, true);

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'language') {
      window.ixenaLocale.setLanguage(message);
      if (state) {
        for (const key of ['rootFields', 'moduleFields', 'pluginFields']) if (Array.isArray(message[key])) state[key] = message[key];
        feedback = window.ixenaLocale.translateMessage(feedback);
        state.errors = (state.errors || []).map(window.ixenaLocale.translateMessage);
        state.warnings = (state.warnings || []).map(window.ixenaLocale.translateMessage);
        for (const draft of drafts.values()) if (draft.error) draft.error = window.ixenaLocale.translateMessage(draft.error);
        render(); remember();
      }
      return;
    }
    if (message.type === 'state') {
      if (message.locale) window.ixenaLocale.setLanguage(message.locale);
      const isAck = message.reason === 'applied' && pending?.requestId === message.requestId;
      if (isAck) {
        if (pending.key) {
          const draft = drafts.get(pending.key);
          if (draft?.sequence === pending.sequence) drafts.delete(pending.key);
        } else { addOpen = false; addDraft.Name = ''; deleteIndex = -1; detailsOpen.clear(); }
        pending = undefined;
      } else if (message.reason === 'document' && state && message.version !== state.version && (drafts.size || pending || composing)) {
        conflicted = true; saveRequested = false; sourceRequested = false;
      }
      if (!state || message.version >= state.version || message.reason === 'reload') state = message;
      if (!dialectExplicit) {
        const rows = [...(Array.isArray(state.data.Modules) ? state.data.Modules : []),
          ...(Array.isArray(state.data.Plugins) ? state.data.Plugins : [])].filter(row => row && typeof row === 'object');
        dialect = rows.some(row => own(row, 'WhitelistPlatforms') || own(row, 'BlacklistPlatforms')) ? 'legacy' : 'modern';
      }
      if (message.reason === 'saved') feedback = t("文件已保存。");
      render(); remember(); flush();
    } else if (message.type === 'error') {
      if (pending?.requestId === message.requestId) {
        if (pending.key) {
          const draft = drafts.get(pending.key);
          if (draft?.sequence === pending.sequence) draft.error = message.message;
        }
        pending = undefined;
      }
      feedback = message.message || t("此次修改未应用。");
      if (message.conflict) conflicted = true;
      saveRequested = false; sourceRequested = false; render(); remember();
      if (!conflicted) flush();
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
