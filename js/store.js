/* 中央存储：去重、乱序容忍、丢失检测、容量截断、跨标签页聚合 */
window.ReportHub = window.ReportHub || {};
ReportHub.store = (() => {
  const MAX_REPORTS = 500;          // 容量上限，超出截断最旧
  const REORDER_WINDOW_MS = 3000;   // 乱序容忍窗口：窗口内到达的迟到 seq 不判丢失
  const GAP_CHECK_INTERVAL_MS = 1000;

  const tabId = (() => {
    let id = sessionStorage.getItem('report-hub-tab-id');
    if (!id) {
      id = 'tab-' + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('report-hub-tab-id', id);
    }
    return id;
  })();
  const loadId = Math.random().toString(36).slice(2, 6);
  const seqKey = tabId + '/' + loadId;

  const reports = new Map();        // id -> report
  let seqCounter = 0;
  let arrivalCounter = 0;
  let maxTsSeen = 0;

  const stats = {
    truncated: 0,   // 因容量被截断丢弃的条数
    reordered: 0,   // 乱序到达（事件时间早于已见最大时间）的条数
    lost: 0,        // 超过容忍窗口仍未到达、判定丢失的 seq 数
    duplicates: 0,  // 跨标签页/重复投递去重的条数
  };

  // 每个 seqKey 的接收状态：{ received:Set, pendingGaps:Map(seq->deadline) }
  const seqStates = new Map();
  const listeners = new Set();

  function seqStateFor(key) {
    let st = seqStates.get(key);
    if (!st) {
      st = { received: new Set(), pendingGaps: new Map() };
      seqStates.set(key, st);
    }
    return st;
  }

  function trackSeq(key, seq) {
    const st = seqStateFor(key);
    if (st.received.has(seq)) return;
    let max = 0;
    st.received.forEach((s) => { if (s > max) max = s; });
    st.received.add(seq);
    // 迟到报告填补了缺口：取消丢失预判（乱序不误判）
    if (st.pendingGaps.delete(seq)) return;
    // 找出 (maxReceived, seq) 之间的新缺口，挂起观察而非立即判丢失
    if (seq > max + 1) {
      const deadline = Date.now() + REORDER_WINDOW_MS;
      for (let missing = max + 1; missing < seq; missing++) {
        if (!st.received.has(missing)) st.pendingGaps.set(missing, deadline);
      }
    }
  }

  setInterval(() => {
    const now = Date.now();
    let changed = false;
    seqStates.forEach((st) => {
      st.pendingGaps.forEach((deadline, seq) => {
        if (now >= deadline) {
          st.pendingGaps.delete(seq);
          stats.lost += 1;
          changed = true;
        }
      });
    });
    if (changed) emit();
  }, GAP_CHECK_INTERVAL_MS);

  function pendingGapCount() {
    let n = 0;
    seqStates.forEach((st) => { n += st.pendingGaps.size; });
    return n;
  }

  function truncateIfNeeded() {
    if (reports.size <= MAX_REPORTS) return;
    const sorted = [...reports.values()].sort((a, b) => a.ts - b.ts);
    const overflow = reports.size - MAX_REPORTS;
    const dropped = sorted.slice(0, overflow);
    dropped.forEach((r) => reports.delete(r.id));
    stats.truncated += dropped.length;
    ReportHub.db.deleteIds(dropped.map((r) => r.id)).catch(console.error);
    emit({ truncatedNow: dropped.length });
  }

  function add(report, opts = {}) {
    if (reports.has(report.id)) {
      stats.duplicates += 1;
      return false;
    }
    if (report.seq == null && !opts.remote) report.seq = ++seqCounter;
    report.arrivalIdx = ++arrivalCounter;
    report.receivedAt = report.receivedAt || Date.now();
    // 乱序检测：仅记录，不判错、不重排丢失
    if (report.ts < maxTsSeen) {
      report.late = true;
      stats.reordered += 1;
    }
    if (report.ts > maxTsSeen) maxTsSeen = report.ts;
    reports.set(report.id, report);
    if (report.seq != null) trackSeq(report.seqKey || seqKey, report.seq);
    ReportHub.db.put(report).catch(console.error);
    if (!opts.remote) ReportHub.bus.post({ kind: 'report', report });
    truncateIfNeeded();
    emit();
    return true;
  }

  async function loadFromDb() {
    const all = await ReportHub.db.getAll();
    all.sort((a, b) => a.ts - b.ts);
    all.forEach((r) => {
      if (reports.has(r.id)) return;
      reports.set(r.id, r);
      if (r.ts > maxTsSeen) maxTsSeen = r.ts;
      if (r.seq != null) {
        const st = seqStateFor(r.seqKey || 'unknown');
        st.received.add(r.seq);
      }
      arrivalCounter = Math.max(arrivalCounter, r.arrivalIdx || 0);
    });
    truncateIfNeeded();
    emit();
  }

  function clear() {
    reports.clear();
    seqStates.clear();
    ReportHub.db.clear().catch(console.error);
    ReportHub.bus.post({ kind: 'clear' });
    emit();
  }

  function clearLocalOnly() {
    reports.clear();
    seqStates.clear();
    emit();
  }

  function query(filters = {}) {
    const text = (filters.text || '').toLowerCase();
    return [...reports.values()]
      .filter((r) => !filters.type || r.type === filters.type)
      .filter((r) => !filters.source || r.source === filters.source)
      .filter((r) => !filters.tab || r.tabId === filters.tab)
      .filter((r) => !text ||
        JSON.stringify(r.body).toLowerCase().includes(text) ||
        (r.url || '').toLowerCase().includes(text))
      .sort((a, b) => a.ts - b.ts ||
        String(a.seqKey).localeCompare(String(b.seqKey)) ||
        (a.seq || 0) - (b.seq || 0));
  }

  function emit(extra) {
    listeners.forEach((fn) => fn(extra || {}));
  }

  ReportHub.bus.on((msg) => {
    if (!msg) return;
    if (msg.kind === 'report') add(msg.report, { remote: true });
    else if (msg.kind === 'clear') clearLocalOnly();
  });

  return {
    tabId, loadId, seqKey, stats, MAX_REPORTS,
    add, clear, query, loadFromDb, pendingGapCount,
    allocateSeq: () => ++seqCounter,
    onChange: (fn) => listeners.add(fn),
    all: () => [...reports.values()],
  };
})();
