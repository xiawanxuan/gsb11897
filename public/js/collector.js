'use strict';
/**
 * 采集与入库管线
 * - 统一 normalize：ReportingObserver / 服务器端点 / 手动降级 / 模拟器 → 标准记录
 * - 乱序处理：eventTime 早于该来源已见最大事件时间 → 标记 late，仍按事件时间正确归位，不误判为丢失
 * - 丢失检测：按标签页 seq 缺口跟踪，超时未补齐才计为丢失
 * - 截断：总量超 MAX_REPORTS 时丢弃最旧记录并计数
 */
const Collector = (() => {
  const MAX_REPORTS = 500;
  const LOST_TIMEOUT_MS = 15000;
  const POLL_MS = 3000;

  const KNOWN_TYPES = ['csp-violation', 'deprecation', 'intervention', 'crash', 'network-error'];

  let seq = 0;
  let observer = null;
  let pollTimer = null;
  let serverSince = 0;
  let endpointOk = false;

  /* tabId -> { maxSeq, maxEventTime, gaps: Map<seq, deadline> } */
  const tabStates = new Map();
  const counters = {
    truncated: Number(localStorage.getItem('rpt-truncated') || 0),
    lost: Number(localStorage.getItem('rpt-lost') || 0),
  };

  const listeners = { change: [], endpoint: [], lost: [], truncated: [] };
  function on(name, fn) { listeners[name].push(fn); }
  function emit(name, ...args) { for (const fn of listeners[name]) fn(...args); }

  function tabState(tabId) {
    let s = tabStates.get(tabId);
    if (!s) {
      s = { maxSeq: 0, maxEventTime: 0, gaps: new Map() };
      tabStates.set(tabId, s);
    }
    return s;
  }

  function nextSeq() { return ++seq; }

  function normalize({ type, url, body }, source, opts = {}) {
    const now = Date.now();
    return {
      id: opts.id || `${Bus.tabId}-${nextSeq()}-${Math.random().toString(36).slice(2, 8)}`,
      tabId: opts.tabId || Bus.tabId,
      seq: opts.seq != null ? opts.seq : seq,
      type: KNOWN_TYPES.includes(type) ? type : (type || 'unknown'),
      source,
      url: url || (body && (body.documentURL || body.document_uri || body.sourceFile)) || location.href,
      body: body || {},
      eventTime: opts.eventTime || now,
      receivedAt: opts.receivedAt || now,
      late: false,
    };
  }

  /* 乱序与缺口分析（仅本地产生的序列；远端记录已由产生方标记） */
  function analyzeOrder(record) {
    const s = tabState(record.tabId);
    if (record.eventTime < s.maxEventTime) record.late = true;
    s.maxEventTime = Math.max(s.maxEventTime, record.eventTime);

    if (typeof record.seq === 'number' && record.seq > 0) {
      if (record.seq > s.maxSeq + 1 && s.maxSeq > 0) {
        for (let missing = s.maxSeq + 1; missing < record.seq; missing++) {
          s.gaps.set(missing, Date.now() + LOST_TIMEOUT_MS);
        }
      }
      if (s.gaps.delete(record.seq)) {
        /* 缺口被迟到的报告补齐：属于乱序而非丢失 */
        record.late = true;
      }
      s.maxSeq = Math.max(s.maxSeq, record.seq);
    }
  }

  function checkLostGaps() {
    const now = Date.now();
    let newlyLost = 0;
    for (const [tabId, s] of tabStates) {
      for (const [missing, deadline] of s.gaps) {
        if (now >= deadline) {
          s.gaps.delete(missing);
          newlyLost++;
        }
      }
    }
    if (newlyLost > 0) {
      counters.lost += newlyLost;
      localStorage.setItem('rpt-lost', String(counters.lost));
      emit('lost', newlyLost, counters.lost);
    }
  }

  async function persist(record) {
    if (await ReportDB.has(record.id)) return false;
    await ReportDB.put(record);
    const removed = await ReportDB.trimToMax(MAX_REPORTS);
    if (removed > 0) {
      counters.truncated += removed;
      localStorage.setItem('rpt-truncated', String(counters.truncated));
      emit('truncated', removed, counters.truncated);
    }
    return true;
  }

  /* 本地产生的报告：分析顺序 → 入库 → 广播 */
  async function ingestLocal(raw, source, opts = {}) {
    const record = normalize(raw, source, opts);
    analyzeOrder(record);
    if (await persist(record)) {
      Bus.broadcastReport(record);
      emit('change');
    }
    return record;
  }

  /* 来自其他标签页 / 服务器拉取的报告：已带完整元数据，仅做缺口补齐与入库 */
  async function ingestRemote(record) {
    const s = tabState(record.tabId);
    if (typeof record.seq === 'number' && record.seq > 0) {
      s.gaps.delete(record.seq);
      s.maxSeq = Math.max(s.maxSeq, record.seq);
    }
    s.maxEventTime = Math.max(s.maxEventTime, record.eventTime);
    if (await persist(record)) emit('change');
  }

  /* ---- 采集源 1：ReportingObserver（浏览器原生，无需端点可用） ---- */
  function startObserver() {
    if (!('ReportingObserver' in window)) return false;
    try {
      observer = new ReportingObserver((reports) => {
        for (const r of reports) {
          ingestLocal({ type: r.type, url: r.url, body: r.body }, 'observer');
        }
      }, { types: [...KNOWN_TYPES], buffered: true });
      observer.observe();
      return true;
    } catch (err) {
      console.warn('ReportingObserver 启动失败', err);
      return false;
    }
  }

  /* ---- 采集源 2：降级手动采集（不支持 Reporting API 时） ---- */
  function startManualFallback() {
    window.addEventListener('error', (e) => {
      ingestLocal({
        type: 'intervention',
        url: e.filename || location.href,
        body: { id: 'ManualWindowError', message: e.message, lineNumber: e.lineno, columnNumber: e.colno },
      }, 'manual');
    });
    window.addEventListener('unhandledrejection', (e) => {
      ingestLocal({
        type: 'intervention',
        body: { id: 'ManualUnhandledRejection', message: String(e.reason) },
      }, 'manual');
    });
  }

  /* ---- 采集源 3：轮询服务器端点（浏览器 report-to 实际投递的报告） ---- */
  async function checkEndpoint() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      const body = await res.json().catch(() => ({}));
      endpointOk = res.ok && body.ok === true;
    } catch (err) {
      endpointOk = false;
    }
    emit('endpoint', endpointOk);
    return endpointOk;
  }

  async function pollServer() {
    if (!endpointOk) return;
    try {
      const res = await fetch(`/api/reports?since=${serverSince}`, { cache: 'no-store' });
      if (!res.ok) {
        endpointOk = false;
        emit('endpoint', false);
        return;
      }
      const data = await res.json();
      for (const env of data.envelopes || []) {
        serverSince = Math.max(serverSince, env.receivedAt);
        const reports = env.reports || [];
        for (let idx = 0; idx < reports.length; idx++) {
          const r = reports[idx];
          await ingestRemote({
            id: `${env.id}-${idx}`,
            tabId: 'server',
            seq: env.seq,
            type: KNOWN_TYPES.includes(r.type) ? r.type : (r.type || 'unknown'),
            source: 'reporting-api',
            url: r.url || (r.body && r.body.documentURL) || '',
            body: r.body || r,
            eventTime: env.receivedAt,
            receivedAt: env.receivedAt,
            late: false,
          });
        }
      }
    } catch (err) {
      endpointOk = false;
      emit('endpoint', false);
    }
  }

  function start() {
    const observerStarted = startObserver();
    startManualFallback(); /* 手动监听作为补充来源；API 不可用时即降级主通道 */
    checkEndpoint().then(() => {
      pollTimer = setInterval(async () => {
        if (!endpointOk) await checkEndpoint();
        await pollServer();
      }, POLL_MS);
    });
    setInterval(checkLostGaps, 2000);
    return observerStarted;
  }

  async function clearAll() {
    await ReportDB.clear();
    counters.truncated = 0;
    counters.lost = 0;
    localStorage.removeItem('rpt-truncated');
    localStorage.removeItem('rpt-lost');
    tabStates.clear();
    serverSince = 0;
    try { await fetch('/api/reports', { method: 'DELETE' }); } catch (err) { /* 端点不可用时忽略 */ }
    Bus.broadcastClear();
    emit('change');
  }

  return {
    MAX_REPORTS,
    KNOWN_TYPES,
    counters,
    on,
    start,
    ingestLocal,
    ingestRemote,
    checkEndpoint,
    clearAll,
    nextSeq,
    /* 供模拟器制造“丢失”：跳过一个 seq 且永不投递 */
    skipSeq() { seq += 1; },
    isEndpointOk: () => endpointOk,
  };
})();
