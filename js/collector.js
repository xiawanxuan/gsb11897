/* 采集层：优先 ReportingObserver；不支持时降级为手动事件采集 */
window.ReportHub = window.ReportHub || {};
ReportHub.collector = (() => {
  const OBSERVE_TYPES = ['csp-violation', 'deprecation', 'intervention', 'crash'];
  const supported = typeof ReportingObserver !== 'undefined';
  let observer = null;

  function uuid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function baseReport(type, source, body) {
    return {
      id: uuid(),
      tabId: ReportHub.store.tabId,
      seqKey: ReportHub.store.seqKey,
      type,
      source,
      ts: Date.now(),
      url: location.href,
      body: body || {},
    };
  }

  function bodyOf(report) {
    if (report.body && typeof report.body.toJSON === 'function') return report.body.toJSON();
    return report.body || {};
  }

  function start(onReport) {
    if (supported) {
      const types = OBSERVE_TYPES.filter((t) => {
        if (!ReportingObserver.supportedTypes) return true;
        return ReportingObserver.supportedTypes().includes(t);
      });
      observer = new ReportingObserver((list) => {
        list.forEach((r) => onReport(baseReport(r.type, 'live-observer', bodyOf(r))));
      }, { types, buffered: true });
      try {
        observer.observe();
      } catch (err) {
        console.warn('ReportingObserver.observe 失败，降级手动采集', err);
        startManual(onReport);
        return { supported: false, degraded: true };
      }
      return { supported: true, degraded: false, types };
    }
    startManual(onReport);
    return { supported: false, degraded: true };
  }

  /* 降级路径：securitypolicyviolation / error / unhandledrejection 手动采集 */
  function startManual(onReport) {
    document.addEventListener('securitypolicyviolation', (e) => {
      onReport(baseReport('csp-violation', 'manual-event', {
        blockedURI: e.blockedURI,
        effectiveDirective: e.effectiveDirective,
        violatedDirective: e.violatedDirective,
        originalPolicy: e.originalPolicy,
        disposition: e.disposition,
        lineNumber: e.lineNumber,
        sourceFile: e.sourceFile,
      }));
    });
    window.addEventListener('error', (e) => {
      onReport(baseReport('error', 'manual-event', {
        message: e.message,
        sourceFile: e.filename,
        lineNumber: e.lineno,
        columnNumber: e.colno,
      }));
    });
    window.addEventListener('unhandledrejection', (e) => {
      onReport(baseReport('error', 'manual-event', {
        message: 'unhandledrejection: ' + String(e.reason),
      }));
    });
  }

  return { supported, start, baseReport };
})();
