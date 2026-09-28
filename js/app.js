/* 应用装配：状态栏、横幅、过滤器、表格、统计、导出 */
window.ReportHub = window.ReportHub || {};
(() => {
  const $ = (sel) => document.querySelector(sel);
  const store = ReportHub.store;
  const SOURCE_LABELS = {
    'live-observer': 'ReportingObserver',
    'manual-event': '手动事件采集',
    simulated: '模拟生成',
  };
  const TABLE_DISPLAY_LIMIT = 200;

  const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-CN', { hour12: false }) +
    '.' + String(ts % 1000).padStart(3, '0');

  /* ---------- 横幅 ---------- */
  const banners = new Map();
  function setBanner(key, kind, html) {
    const area = $('#banner-area');
    if (!html) {
      if (banners.has(key)) { banners.get(key).remove(); banners.delete(key); }
      return;
    }
    let el = banners.get(key);
    if (!el) {
      el = document.createElement('div');
      banners.set(key, el);
      area.appendChild(el);
    }
    el.className = 'banner banner-' + kind;
    el.innerHTML = html;
  }

  /* ---------- 状态栏 ---------- */
  function renderStatusBar(cap) {
    const bar = $('#status-bar');
    bar.innerHTML = '';
    const chips = [];
    chips.push(cap.supported
      ? ['chip-green', 'Reporting API 受支持']
      : ['chip-yellow', '不支持 Reporting API · 已降级手动采集']);
    chips.push(ReportHub.bus.supported
      ? ['chip-green', 'BroadcastChannel 跨标签页同步']
      : ['chip-yellow', '无 BroadcastChannel · 仅本标签页']);
    chips.push(['chip-blue', '标签页 ' + store.tabId]);
    chips.push(['chip-gray', '容量上限 ' + store.MAX_REPORTS]);
    chips.forEach(([cls, text]) => {
      const c = document.createElement('span');
      c.className = 'chip ' + cls;
      c.textContent = text;
      bar.appendChild(c);
    });
  }

  /* ---------- 端点 ---------- */
  function renderEndpoint(st) {
    const el = $('#endpoint-status');
    const map = {
      unregistered: ['chip-gray', '未注册'],
      registering: ['chip-blue', '注册中…'],
      registered: ['chip-green', '已注册 ' + st.url],
      failed: ['chip-red', '注册失败'],
    };
    const [cls, text] = map[st.status];
    el.className = 'chip ' + cls;
    el.textContent = text + (st.queued ? `（待投递 ${st.queued}）` : '');
    if (st.status === 'failed') {
      setBanner('endpoint', 'error',
        `端点注册失败：${st.url}（${st.lastError || '未知错误'}）。报告仍在本地聚合，修复后可重试。` +
        ` <button id="btn-retry-endpoint">重试注册</button>`);
      const btn = $('#btn-retry-endpoint');
      if (btn) btn.addEventListener('click', registerEndpoint);
    } else {
      setBanner('endpoint', null, null);
    }
  }

  function registerEndpoint() {
    ReportHub.endpoint.register($('#endpoint-url').value.trim(), {
      failMode: $('#simulate-endpoint-failure').checked,
    });
  }

  /* ---------- 过滤器 ---------- */
  function currentFilters() {
    return {
      type: $('#filter-type').value,
      source: $('#filter-source').value,
      tab: $('#filter-tab').value,
      text: $('#filter-text').value,
    };
  }

  function refreshFilterOptions() {
    const all = store.all();
    const fill = (sel, values, labelFn) => {
      const el = $(sel);
      const cur = el.value;
      el.innerHTML = '<option value="">全部</option>';
      [...values].sort().forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = labelFn ? labelFn(v) : v;
        el.appendChild(opt);
      });
      el.value = cur;
    };
    fill('#filter-type', new Set(all.map((r) => r.type)),
      (t) => ReportHub.timeline.labelOf(t));
    fill('#filter-source', new Set(all.map((r) => r.source)),
      (s) => SOURCE_LABELS[s] || s);
    fill('#filter-tab', new Set(all.map((r) => r.tabId)));
  }

  /* ---------- 统计 ---------- */
  function renderStats() {
    const all = store.all();
    const byType = {};
    all.forEach((r) => { byType[r.type] = (byType[r.type] || 0) + 1; });
    const tabs = new Set(all.map((r) => r.tabId));
    const cards = [
      [all.length, '报告总数（跨 ' + tabs.size + ' 个标签页）'],
      ...Object.entries(byType).map(([t, n]) => [n, ReportHub.timeline.labelOf(t)]),
      [store.stats.reordered, '乱序到达（已容忍）'],
      [store.stats.lost, '判定丢失（超容忍窗口）'],
      [store.pendingGapCount(), '待确认缺口'],
      [store.stats.truncated, '已截断丢弃'],
      [store.stats.duplicates, '重复去重'],
    ];
    $('#stats-cards').innerHTML = cards.map(([num, label]) =>
      `<div class="stat-card"><div class="num">${num}</div><div class="label">${label}</div></div>`
    ).join('');
  }

  /* ---------- 表格 ---------- */
  function summarize(r) {
    const b = r.body || {};
    if (b.effectiveDirective) return `${b.effectiveDirective} 拦截 ${b.blockedURI || '(inline)'}`;
    if (b.message) return String(b.message).slice(0, 120);
    if (b.id) return b.id;
    if (b.reason) return 'reason: ' + b.reason;
    return JSON.stringify(b).slice(0, 120);
  }

  function renderTable(rows) {
    const tbody = $('#report-table tbody');
    const shown = rows.slice(-TABLE_DISPLAY_LIMIT);
    tbody.innerHTML = shown.map((r) => `
      <tr class="${r.late ? 'row-late' : ''}">
        <td class="mono">${r.arrivalIdx}</td>
        <td class="mono">${fmtTime(r.ts)}</td>
        <td class="mono">${fmtTime(r.receivedAt)}</td>
        <td><span class="tag" style="background:${ReportHub.timeline.colorOf(r.type)}">${ReportHub.timeline.labelOf(r.type)}</span></td>
        <td>${SOURCE_LABELS[r.source] || r.source}</td>
        <td class="mono">${r.tabId} #${r.seq != null ? r.seq : '-'}</td>
        <td class="summary-cell">${escapeHtml(summarize(r))}${r.late ? ' ⚠乱序到达' : ''}</td>
      </tr>`).join('');
    $('#table-summary').textContent =
      `筛选结果 ${rows.length} 条，显示最近 ${shown.length} 条` +
      (rows.length > TABLE_DISPLAY_LIMIT ? '（表格展示截断，导出包含全部）' : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /* ---------- 导出 ---------- */
  function download(name, content, mime) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([content], { type: mime }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function exportJson() {
    download('reports.json', JSON.stringify(store.query(currentFilters()), null, 2),
      'application/json');
  }

  function exportCsv() {
    const rows = store.query(currentFilters());
    const head = ['id', 'ts', 'receivedAt', 'type', 'source', 'tabId', 'seq', 'url', 'body'];
    const esc = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
    const csv = [head.join(',')]
      .concat(rows.map((r) => head.map((h) =>
        esc(h === 'body' ? JSON.stringify(r.body) : r[h])).join(',')))
      .join('\n');
    download('reports.csv', '﻿' + csv, 'text/csv');
  }

  /* ---------- 渲染调度 ---------- */
  let renderQueued = false;
  function rerender(extra = {}) {
    if (extra.truncatedNow) {
      setBanner('truncate', 'warn',
        `报告数量超过容量上限（${store.MAX_REPORTS}），已截断丢弃最旧的 ${extra.truncatedNow} 条。`);
      setTimeout(() => setBanner('truncate', null, null), 6000);
    }
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const rows = store.query(currentFilters());
      refreshFilterOptions();
      renderStats();
      renderTable(rows);
      ReportHub.timeline.update(rows);
      const types = [...new Set(store.all().map((r) => r.type))];
      ReportHub.timeline.renderLegend($('#timeline-legend'), types);
    });
  }

  /* ---------- 启动 ---------- */
  async function main() {
    ReportHub.timeline.init($('#timeline'), $('#timeline-tooltip'));

    const cap = ReportHub.collector.start((report) => {
      store.add(report);
      ReportHub.endpoint.deliver(report);
    });
    renderStatusBar(cap);
    if (!cap.supported) {
      setBanner('degrade', 'warn',
        '当前浏览器不支持 Reporting API（ReportingObserver），已降级为手动采集：' +
        'CSP 违规经 securitypolicyviolation 事件、脚本错误经 error/unhandledrejection 事件收集；' +
        '弃用/干预/崩溃报告仅能通过模拟生成。');
    }
    if (!ReportHub.bus.supported) {
      setBanner('bus', 'warn', '当前环境不支持 BroadcastChannel，跨标签页聚合不可用。');
    }

    await store.loadFromDb();
    store.onChange(rerender);
    ReportHub.endpoint.onChange(renderEndpoint);
    ReportHub.endpoint.onLog((line) => {
      const log = $('#delivery-log');
      log.textContent = (log.textContent + '\n' + line).split('\n').slice(-8).join('\n');
      log.scrollTop = log.scrollHeight;
    });

    $('#btn-register').addEventListener('click', registerEndpoint);
    document.querySelectorAll('[data-sim]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const msg = ReportHub.simulator.run(btn.dataset.sim);
        if (msg) $('#sim-hint').textContent = msg;
      });
    });
    ['#filter-type', '#filter-source', '#filter-tab'].forEach((sel) =>
      $(sel).addEventListener('change', () => rerender()));
    $('#filter-text').addEventListener('input', () => rerender());
    $('#bucket-size').addEventListener('change', (e) => {
      ReportHub.timeline.setBucketMs(Number(e.target.value));
      rerender();
    });
    $('#btn-export-json').addEventListener('click', exportJson);
    $('#btn-export-csv').addEventListener('click', exportCsv);
    $('#btn-clear').addEventListener('click', () => {
      if (confirm('清空所有标签页共享的报告数据？')) store.clear();
    });

    registerEndpoint();
    rerender();
  }

  main().catch((err) => {
    setBanner('fatal', 'error', '初始化失败：' + err.message);
    console.error(err);
  });
})();
