(() => {
  const { t } = window.ixenaLocale;
  'use strict';
  const api = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  let current;
  const text = (id, value) => { byId(id).textContent = value; };
  const number = (value, digits = 1) => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
  const mib = bytes => typeof bytes === 'number' ? bytes / 1048576 : undefined;
  const style = () => getComputedStyle(document.documentElement);
  function draw(id, field, divisor, minimum, color) {
    const canvas = byId(id), context = canvas.getContext('2d');
    if (!context) return;
    const width = Math.max(250, canvas.clientWidth), height = 170, scale = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale); context.scale(scale, scale);
    const samples = current?.samples || [], values = samples.map(sample => typeof sample[field] === 'number' ? sample[field] / divisor : undefined);
    const ceiling = field === 'cpuTimePct' ? 100 : Math.max(minimum, ...values.filter(value => value !== undefined).map(value => value * 1.15));
    const left = 48, top = 14, bottom = 28, graphWidth = width - left - 12, graphHeight = height - top - bottom;
    const colors = style();
    context.font = '11px system-ui'; context.lineWidth = 1;
    context.fillStyle = colors.getPropertyValue('--vscode-descriptionForeground').trim() || '#949494';
    context.strokeStyle = colors.getPropertyValue('--vscode-panel-border').trim() || '#555';
    for (let i = 0; i < 3; i++) {
      const fraction = i / 2, y = top + graphHeight * fraction;
      context.beginPath(); context.moveTo(left, y); context.lineTo(left + graphWidth, y); context.stroke();
      context.textAlign = 'right'; context.fillText(number(ceiling * (1 - fraction), ceiling < 10 ? 1 : 0), left - 7, y + 4);
    }
    context.textAlign = 'left'; context.fillText(samples.length ? new Date(samples[0].updatedAt).toLocaleTimeString(window.ixenaLocale.getLanguage()) : t("等待采样"), left, height - 7);
    context.textAlign = 'right'; context.fillText(samples.length ? new Date(samples.at(-1).updatedAt).toLocaleTimeString(window.ixenaLocale.getLanguage()) : '', width - 12, height - 7);
    context.strokeStyle = colors.getPropertyValue(color).trim() || '#3794ff'; context.lineWidth = 2; context.beginPath();
    let connected = false;
    values.forEach((value, index) => {
      if (value === undefined) { connected = false; return; }
      // 隐藏或断点暂停形成明显时间空隙时断开曲线，避免画成连续采样。
      if (index && Date.parse(samples[index].updatedAt) - Date.parse(samples[index - 1].updatedAt) > 3000) connected = false;
      const x = left + graphWidth * (values.length > 1 ? index / (values.length - 1) : 0);
      const y = top + graphHeight * (1 - Math.min(value, ceiling) / ceiling);
      if (connected) context.lineTo(x, y); else context.moveTo(x, y); connected = true;
    });
    context.stroke();
  }
  function render() {
    if (!current) return;
    const sample = current.samples?.at(-1), unavailable = !sample;
    const frozen = current.stale || Boolean(current.error);
    text('project', current.projectPath || '');
    text('identity', `PID ${current.processId} · UE ${current.engineVersion || t("版本未知")}`);
    text('state', current.paused ? t("已暂停采样") : frozen ? t("采样冻结 / 等待更新") : t("实时采样中"));
    byId('state').className = current.paused || frozen ? 'status frozen' : 'status live';
    text('notice', (current.error ? window.ixenaLocale.translateMessage(current.error) : '') || (current.paused ? t("已暂停读取；图表与数值保留在最后一次采样。") : frozen
      ? t("超过 3 秒没有新采样。断点暂停、编译占用主线程或进程退出均可能造成冻结；下方是最后一次数据。")
      : t("已连接 UE Editor 的主线程采样。这里显示 UE 进程本身，不包含独立 UBT / 编译器子进程。")));
    text('pause', current.paused ? t("继续采样") : t("暂停采样"));
    text('cpu', sample?.cpuTimePct !== undefined ? `${number(sample.cpuTimePct)}%` : '—');
    text('cpu-relative', t("单核 100%：{0}", sample?.cpuTimePctRelative !== undefined ? number(sample.cpuTimePctRelative) + '%' : '—'));
    text('memory', number(mib(sample?.processMemoryBytes)));
    text('memory-peak', t("峰值：{0} MiB", number(mib(sample?.peakProcessMemoryBytes))));
    text('frame', sample?.frameDeltaMs !== undefined ? `${number(sample.frameDeltaMs, 2)} ms` : '—');
    text('available', number(mib(sample?.availablePhysicalBytes)));
    text('debugger', t("调试器：{0}", sample?.debuggerAttached === true ? t("已附加") : sample?.debuggerAttached === false ? t("未附加") : '—'));
    text('sample-time', unavailable ? t("尚无有效采样") : t("最后采样：{0} · {1} / 120 样本", new Date(sample.updatedAt).toLocaleString(window.ixenaLocale.getLanguage()), current.samples.length));
    draw('cpu-chart', 'cpuTimePct', 1, 100, '--vscode-charts-blue');
    draw('memory-chart', 'processMemoryBytes', 1048576, 1, '--vscode-charts-green');
    draw('frame-chart', 'frameDeltaMs', 1, 16.7, '--vscode-charts-orange');
  }
  for (const type of ['pause', 'refresh', 'insights']) byId(type).addEventListener('click', () => api.postMessage({ type }));
  window.addEventListener('message', event => {
    if (event.data?.type === 'language') {
      window.ixenaLocale.setLanguage(event.data);
      if (current?.error) current.error = window.ixenaLocale.translateMessage(current.error);
      render();
    } else if (event.data?.type === 'state') { if (event.data.locale) window.ixenaLocale.setLanguage(event.data.locale); current = event.data; render(); }
  });
  window.addEventListener('resize', render);
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
  api.postMessage({ type: 'ready' });
})();
