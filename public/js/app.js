'use strict';
/* UI 主控：状态徽章、告警、统计、过滤、导出、清空、渲染 */
(() => {
  const TYPE_LABELS = {
    'csp-violation': 'CSP 违规',
    'deprecation': '弃用警告',
    'intervention': '干预报告',
    'crash': '崩溃报告',
    'network-error': '网络错误',
    'manual-error': '手动错误',
    unknown: '其他',
  };
  const SOURCE_LABELS = {
    'reporting-api': '浏览器端点 (report-to)',
    'observer': 'ReportingObserver',
    'manual': '手动降级采集',
    'simulated': '模拟生成',
  };

  const state = {
    reports: [],
    filters: { type: 'all', source: 'all', q: '' },
  };

  const el = (id) => document.getElementById(id);
  const fmtTime = (ts) => new Date(ts).toLocaleString('zh-CN', { hour12: false });
  const supported = 'ReportingObserver' in window;

  /* ---------- 告警条 ---------- */
  const shownAlerts = new Set();
  function alert(id, level, message, actionText, onAction) {
    if (shownAlerts.has(id)) return;
    shownAlerts.add(id);
    const box = document.createElement('div');
    box.className = `alert ${level}`;
    box.id = `alert-${id}`;
    box.innerHTML = `<span>${message}</span>`;
    if (actionText) {
      const btn = document.createElement('button');
      btn.textContent = actionText;
      btn.onclick = () => { onAction && onAction(); dismissAlert(id); };
      box.appendChild(btn);
    } else {
      const btn = document.createElement('button');
      btn.textContent = '知道了';
      btn.onclick = () => dismissAlert(id);
      box.appendChild(btn);
    }
    el('alerts').appendChild(box);
    /* 自动消失，便于同类事件再次提示 */
    setTimeout(() => dismissAlert(id), 8000);
  }
  function dismissAlert(id) {
    shownAlerts.delete(id);
    const node = el(`alert-${id}`);
    if (node) node.remove();
  }

  function updateBadges() {
    const api = el('badgeApi');
    api.textContent = `API: ${supported ? 'ReportingObserver 可用' : '不支持'}`;
    api.className = `badge ${supported ? 'ok' : 'err'}`;

    const ep = el('badgeEndpoint');
    ep.textContent = `端点: ${Collector.isEndpointOk() ? '已注册 / 健康' : '不可达'}`;
    ep.className = `badge ${Collector.isEndpointOk() ? 'ok' : 'err'}`;

    const mode = el('badgeMode');
    if (!supported) {
      mode.textContent = '模式: 降级（手动采集）';
      mode.className = 'badge err';
    } else if (!Collector.isEndpointOk()) {
      mode.textContent = '模式: 端点降级（Observer + 手动）';
      mode.className = 'badge warn';
    } else {
      mode.textContent = '模式: 完整（端点 + Observer）';
      mode.className = 'badge ok';
    }
    el('badgeTabs').textContent = `标签页: ${Bus.peerCount()}`;
  }

  /* ---------- 过滤 ---------- */
  function filtered() {
    const { type, source, q } = state.filters;
    const kw = q.trim().toLowerCase();
    return state.reports.filter((r) => {
      if (type !== 'all' && r.type !== type) return false;
      if (source !== 'all' && r.source !== source) return false;
      if (kw) {
        const hay = `${r.url} ${JSON.stringify(r.body)}`.toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    });
  }

  /* ---------- 统计 ---------- */
  function renderStats() {
    const list = filtered();
    const byType = {};
    const bySource = {};
    let late = 0;
    for (const r of list) {
      byType[r.type] = (byType[r.type] || 0) + 1;
      bySource[r.source] = (bySource[r.source] || 0) + 1;
      if (r.late) late++;
    }
    const cards = [
      { num: list.length, label: '报告总数（当前过滤）' },
      ...Object.keys(TYPE_LABELS)
        .filter((t) => byType[t])
        .map((t) => ({ num: byType[t], label: TYPE_LABELS[t] })),
      { num: late, label: '乱序到达（已正确归位）', cls: late ? 'accent' : '' },
      { num: Collector.counters.lost, label: '丢失（缺口超时）', cls: Collector.counters.lost ? 'bad' : '' },
      { num: Collector.counters.truncated, label: '因过多截断（旧）', cls: Collector.counters.truncated ? 'bad' : '' },
      { num: `${state.reports.length}/${Collector.MAX_REPORTS}`, label: '当前存储 / 容量上限' },
    ];
    el('stats').innerHTML = cards.map((c) =>
      `<div class="stat ${c.cls || ''}"><div class="num">${c.num}</div><div class="label">${c.label}</div></div>`
    ).join('');
  }

  /* ---------- 表格 ---------- */
  const MAX_RENDER_ROWS = 200;
  function renderTable() {
    const list = filtered().slice(-MAX_RENDER_ROWS).reverse();
    const tbody = el('reportRows');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="empty">暂无符合条件的报告</td></tr>';
    } else {
      tbody.innerHTML = list.map((r) => `
        <tr>
          <td>${fmtTime(r.eventTime)}</td>
          <td>${fmtTime(r.receivedAt)}</td>
          <td><span class="tag ${typeClass(r.type)}">${escapeHtml(TYPE_LABELS[r.type] || r.type)}</span></td>
          <td title="${SOURCE_LABELS[r.source] || r.source}">${SOURCE_LABELS[r.source] || r.source}</td>
          <td>${r.late ? '<span class="tag late">乱序到达</span>' : '<span class="tag ok">正常</span>'}</td>
          <td>${r.tabId}</td>
          <td>${r.seq}</td>
          <td><details><summary>详情</summary><pre>${escapeHtml(JSON.stringify({ url: r.url, body: r.body }, null, 2))}</pre></details></td>
        </tr>`).join('');
    }
    const total = filtered().length;
    el('tableNote').textContent = total > MAX_RENDER_ROWS
      ? `命中 ${total} 条，仅渲染最新 ${MAX_RENDER_ROWS} 条（导出包含全部命中结果）。`
      : `共 ${total} 条。`;
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function typeClass(t) {
    return 'type-' + String(t).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  }

  /* ---------- 图表 ---------- */
  function renderChart() {
    TimelineChart.draw(filtered(), Object.keys(TYPE_LABELS));
  }
  function renderLegend() {
    el('legend').innerHTML = Object.keys(TYPE_LABELS).map((t) =>
      `<span class="item"><span class="swatch type-${t}"></span>${TYPE_LABELS[t]}</span>`
    ).join('');
  }

  /* ---------- 导出 / 清空 ---------- */
  function download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    download(`reports-${Date.now()}.json`, JSON.stringify(filtered(), null, 2), 'application/json');
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function exportCsv() {
    const rows = [['id', 'eventTime', 'eventTimeISO', 'receivedAt', 'type', 'source', 'late', 'tabId', 'seq', 'url', 'body']];
    for (const r of filtered()) {
      rows.push([
        r.id, r.eventTime, new Date(r.eventTime).toISOString(), r.receivedAt,
        r.type, r.source, r.late ? 1 : 0, r.tabId, r.seq, r.url, JSON.stringify(r.body),
      ].map(csvCell).join(','));
    }
    download(`reports-${Date.now()}.csv`, '﻿' + rows.join('\n'), 'text/csv;charset=utf-8');
  }

  async function clearReports() {
    if (!confirm('确定清空本地与服务器端的全部报告？')) return;
    await Collector.clearAll();
    await reload();
  }

  /* ---------- 渲染入口 ---------- */
  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(async () => {
      renderQueued = false;
      await reload();
    });
  }

  async function reload() {
    state.reports = await ReportDB.getAll();
    renderStats();
    renderTable();
    renderChart();
    updateBadges();
  }

  /* ---------- 过滤器选项 ---------- */
  function initFilterOptions() {
    const typeSel = el('filterType');
    for (const t of Collector.KNOWN_TYPES) {
      typeSel.insertAdjacentHTML('beforeend', `<option value="${t}">${TYPE_LABELS[t]}</option>`);
    }
    typeSel.insertAdjacentHTML('beforeend', '<option value="unknown">其他</option>');
    const srcSel = el('filterSource');
    for (const [v, label] of Object.entries(SOURCE_LABELS)) {
      srcSel.insertAdjacentHTML('beforeend', `<option value="${v}">${label}</option>`);
    }
  }

  /* ---------- 端点故障模拟 ---------- */
  async function setEndpoint(enabled) {
    try {
      await fetch('/api/admin/endpoint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
    } catch (err) { /* ignore */ }
    await Collector.checkEndpoint();
    el('btnEndpointOutage').disabled = enabled === false;
    el('btnEndpointRecover').disabled = enabled === true;
    updateBadges();
  }

  /* ---------- 启动 ---------- */
  async function init() {
    TimelineChart.init(el('timeline'), el('tooltip'), TYPE_LABELS);
    renderLegend();
    initFilterOptions();

    if (!supported) {
      alert('unsupported', 'err',
        '当前浏览器不支持 Reporting API / ReportingObserver，已自动降级为手动采集（window error / unhandledrejection 与模拟报告）。',
        '了解');
    }

    await ReportDB.open();

    Collector.on('change', scheduleRender);
    Collector.on('endpoint', (ok) => {
      updateBadges();
      if (!ok) {
        alert('endpoint', 'err',
          'Report-To 端点注册失败或不可达（健康检查失败）。浏览器直接投递将无法到达服务器，当前继续通过 ReportingObserver 与手动采集工作，端点恢复后自动重新拉取。',
          '立即重试', () => Collector.checkEndpoint());
      } else {
        dismissAlert('endpoint');
      }
    });
    Collector.on('lost', (n, total) => {
      alert('lost', 'warn', `检测到 ${n} 条报告在 ${15} 秒内未送达（已按缺口计为丢失，共 ${total} 条）。乱序迟到的报告不会计为丢失。`, '知道了');
    });
    Collector.on('truncated', (n, total) => {
      alert('truncated', 'warn', `报告量超过容量上限（${Collector.MAX_REPORTS} 条），已自动截断最旧的 ${n} 条，累计截断 ${total} 条。`, '知道了');
    });

    Bus.onReport((record) => Collector.ingestRemote(record));
    Bus.onClear(() => reload());
    Bus.onPeers(updateBadges);

    Collector.start();
    await reload();

    /* 控件绑定 */
    el('filterType').addEventListener('change', (e) => { state.filters.type = e.target.value; reload(); });
    el('filterSource').addEventListener('change', (e) => { state.filters.source = e.target.value; reload(); });
    el('filterText').addEventListener('input', (e) => { state.filters.q = e.target.value; reload(); });
    el('btnExportJson').addEventListener('click', exportJson);
    el('btnExportCsv').addEventListener('click', exportCsv);
    el('btnClear').addEventListener('click', clearReports);
    el('btnEndpointOutage').addEventListener('click', () => setEndpoint(false));
    el('btnEndpointRecover').addEventListener('click', () => setEndpoint(true));

    document.querySelectorAll('button[data-sim]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.sim;
        if (kind === 'out-of-order') Simulator.outOfOrder();
        else if (kind === 'loss') Simulator.loss();
        else if (kind === 'burst') Simulator.burst();
        else Simulator.one(kind);
      });
    });
    document.querySelectorAll('button[data-real]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const kind = btn.dataset.real;
        if (kind === 'csp') Simulator.realCspViolation();
        else if (kind === 'deprecation') Simulator.realDeprecation();
      });
    });

    window.addEventListener('resize', renderChart);
    setInterval(renderChart, 5000); /* 自动刷新当前时间桶与时间轴 */
  }

  init().catch((err) => {
    console.error(err);
    alert('fatal', 'err', `初始化失败: ${err.message}`, '知道了');
  });
})();
