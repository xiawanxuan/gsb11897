/* 报告模拟生成：真实 CSP 触发 + 各类模拟报告 + 乱序/丢失/突发场景 */
window.ReportHub = window.ReportHub || {};
ReportHub.simulator = (() => {
  const store = () => ReportHub.store;

  function sim(type, body) {
    const report = ReportHub.collector.baseReport(type, 'simulated', body);
    store().add(report);
    ReportHub.endpoint.deliver(report);
    return report;
  }

  /* 真实触发：eval 被 CSP script-src 'self' 拦截 */
  function cspEval() {
    try {
      eval('window.__csp_eval_probe = 1'); // eslint-disable-line no-eval
    } catch (err) {
      // 违规报告由 ReportingObserver / securitypolicyviolation 事件异步送达
      return 'eval 已被 CSP 拦截（' + err.message + '），报告异步生成中…';
    }
    return 'eval 未生效？请确认通过 HTTP 服务访问页面';
  }

  /* 真实触发：加载外链脚本被 script-src 'self' 拦截 */
  function cspResource() {
    const s = document.createElement('script');
    s.src = 'https://blocked.example.com/probe.js?_=' + Date.now();
    document.head.appendChild(s);
    s.remove();
    return '已请求外链脚本并被 CSP 拦截，报告异步生成中…';
  }

  function deprecation() {
    return sim('deprecation', {
      id: 'NavigatorUserAgentReduction',
      message: 'A deprecated API was used on this page. See https://chromestatus.com/ for details.',
      sourceFile: location.href,
      lineNumber: Math.floor(Math.random() * 200) + 1,
      columnNumber: Math.floor(Math.random() * 80) + 1,
      anticipatedRemoval: '2027-01-01T00:00:00Z',
    });
  }

  function intervention() {
    const ids = ['HeavyAdIntervention', 'LayoutShift', 'PermissionsPolicyViolation'];
    const id = ids[Math.floor(Math.random() * ids.length)];
    return sim('intervention', {
      id,
      message: 'Intervention: ' + id + ' was enforced on this page.',
      sourceFile: location.href,
      lineNumber: Math.floor(Math.random() * 200) + 1,
    });
  }

  function crash() {
    return sim('crash', {
      reason: Math.random() > 0.5 ? 'oom' : 'unresponsive',
      processType: 'renderer',
    });
  }

  /* 乱序：seq 1..6 打乱顺序、事件时间倒挂地到达；窗口内应全部归位，不判丢失 */
  function outOfOrder() {
    const now = Date.now();
    const reports = [];
    for (let i = 0; i < 6; i++) {
      const r = ReportHub.collector.baseReport('deprecation', 'simulated', {
        id: 'OutOfOrderProbe',
        message: '乱序探针 seq 到达测试',
      });
      r.seq = store().allocateSeq();
      r.ts = now - (6 - i) * 400; // 事件时间早于当前，且与到达顺序不一致
      reports.push(r);
    }
    reports.sort(() => Math.random() - 0.5); // 打乱到达顺序
    reports.forEach((r, idx) => {
      setTimeout(() => { store().add(r); ReportHub.endpoint.deliver(r); }, idx * 150);
    });
    return '已按乱序注入 6 条报告（seq 打乱 + 时间倒挂），观察是否误判丢失';
  }

  /* 丢失：消耗 seq 但不投递部分报告，超过容忍窗口后应判为丢失 */
  function loss() {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      const seq = store().allocateSeq();
      if (i === 2 || i === 3) continue; // 这两条永远不到达
      const r = ReportHub.collector.baseReport('intervention', 'simulated', {
        id: 'LossProbe',
        message: '丢失探针（seq=' + seq + '）',
      });
      r.seq = seq;
      r.ts = now + i;
      store().add(r);
      ReportHub.endpoint.deliver(r);
    }
    return '已注入 5 个 seq、跳过其中 2 个；约 3 秒后应判定 2 条丢失';
  }

  /* 突发：600 条，超出容量上限触发截断 */
  function burst() {
    const now = Date.now();
    const types = ['csp-violation', 'deprecation', 'intervention'];
    for (let i = 0; i < 600; i++) {
      const r = ReportHub.collector.baseReport(types[i % types.length], 'simulated', {
        id: 'BurstProbe',
        message: '突发压力测试 #' + i,
      });
      r.ts = now - (600 - i) * 20; // 铺满过去 12 秒
      store().add(r);
    }
    return '已注入 600 条突发报告，超出容量部分应被截断并提示';
  }

  const handlers = {
    'csp-eval': cspEval,
    'csp-resource': cspResource,
    deprecation, intervention, crash,
    'out-of-order': outOfOrder,
    loss, burst,
  };

  return {
    run(name) {
      const fn = handlers[name];
      return fn ? fn() : '未知模拟类型';
    },
  };
})();
