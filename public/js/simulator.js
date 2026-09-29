'use strict';
/* 报告模拟器：生成各类报告，以及乱序 / 丢失 / 突发等异常场景 */
const Simulator = (() => {
  const SAMPLE_BODIES = {
    'csp-violation': () => ({
      documentURL: location.href,
      referrer: '',
      blockedURL: 'https://tracker.example.com/pixel.gif',
      effectiveDirective: 'img-src',
      violatedDirective: 'img-src',
      originalPolicy: "default-src 'self'; img-src 'self'; report-to default",
      disposition: 'enforce',
      statusCode: 200,
    }),
    deprecation: () => ({
      id: 'XMLHttpRequestSynchronousInNonWorkerOutsideBeforeUnload',
      message: 'Deprecated feature used: synchronous XMLHttpRequest / legacy API.',
      sourceFile: location.href,
      lineNumber: Math.floor(Math.random() * 400) + 1,
      columnNumber: Math.floor(Math.random() * 80) + 1,
      anticipatedRemoval: '2027-01-01T00:00:00.000Z',
    }),
    intervention: () => ({
      id: 'NavigationHeuristic',
      message: 'An intervention was applied: heavy ad / pop-up blocked / slow network throttling.',
      sourceFile: location.href,
      lineNumber: Math.floor(Math.random() * 200) + 1,
      columnNumber: 1,
    }),
    crash: () => ({
      reason: ['oom', 'unresponsive', 'killed'][Math.floor(Math.random() * 3)],
    }),
    'network-error': () => ({
      referrer: location.href,
      sampling_fraction: 1,
      server_ip: '203.0.113.7',
      protocol: 'http/1.1',
      method: 'GET',
      status_code: 0,
      elapsed_time: Math.floor(Math.random() * 3000),
      phase: 'application',
      type: ['tcp.timed_out', 'dns.address_not_found', 'tls.failed'][Math.floor(Math.random() * 3)],
    }),
  };

  function one(type, opts = {}) {
    const bodyFactory = SAMPLE_BODIES[type];
    if (!bodyFactory) return Promise.resolve(null);
    return Collector.ingestLocal({ type, body: bodyFactory() }, 'simulated', opts);
  }

  /* 乱序：5 条报告事件时间递增，但投递顺序打乱并带随机延迟 */
  function outOfOrder() {
    const now = Date.now();
    const items = [];
    for (let i = 0; i < 5; i++) {
      items.push({
        type: 'deprecation',
        body: { ...SAMPLE_BODIES.deprecation(), id: `OutOfOrderDemo-${i}`, message: `乱序演示报告 #${i}（事件时间 ${new Date(now - (5 - i) * 1000).toLocaleTimeString()}）` },
        eventTime: now - (5 - i) * 1000,
      });
    }
    const shuffled = items.slice().sort(() => Math.random() - 0.5);
    shuffled.forEach((item, idx) => {
      setTimeout(() => {
        Collector.ingestLocal(item, 'simulated', { eventTime: item.eventTime });
      }, idx * 400);
    });
  }

  /* 丢失：跳过一个 seq，该“报告”永不投递，超时后应被计为丢失 */
  function loss() {
    Collector.skipSeq();
  }

  /* 突发：快速产生大量报告，触发截断逻辑 */
  async function burst(n = 550) {
    const types = Collector.KNOWN_TYPES;
    for (let i = 0; i < n; i++) {
      const type = types[i % types.length];
      await one(type, { eventTime: Date.now() - Math.floor(Math.random() * 60000) });
    }
  }

  /* 真实 CSP 违规：加载被 img-src 'self' 拒绝的外部图片 */
  function realCspViolation() {
    const img = new Image();
    img.src = `https://reporting-demo.invalid/pixel.png?t=${Date.now()}`;
    img.style.display = 'none';
    document.body.appendChild(img);
    setTimeout(() => img.remove(), 5000);
  }

  /* 真实弃用特性：尽量触发浏览器弃用报告（不同内核表现不同，尽力而为） */
  function realDeprecation() {
    try { document.domain = document.domain; } catch (err) { /* 忽略 */ }
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/health', false); /* 同步 XHR：已弃用 */
      xhr.send();
    } catch (err) { /* 忽略 */ }
  }

  return { one, outOfOrder, loss, burst, realCspViolation, realDeprecation };
})();
