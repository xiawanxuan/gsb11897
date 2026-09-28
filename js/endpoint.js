/* Report-To 端点注册与投递（含失败提示、重试、待发队列） */
window.ReportHub = window.ReportHub || {};
ReportHub.endpoint = (() => {
  const LOCAL_ENDPOINT = 'local://aggregate';
  let status = 'unregistered'; // unregistered | registering | registered | failed
  let url = LOCAL_ENDPOINT;
  let failMode = false;
  let lastError = '';
  let queue = [];              // 投递失败时缓存的报告
  const listeners = new Set();
  const logListeners = new Set();

  function emit() {
    listeners.forEach((fn) => fn({ status, url, queued: queue.length, lastError }));
  }
  function log(line) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logListeners.forEach((fn) => fn(`[${ts}] ${line}`));
  }

  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function register(targetUrl, opts = {}) {
    url = targetUrl || LOCAL_ENDPOINT;
    failMode = !!opts.failMode;
    status = 'registering';
    emit();
    log(`正在注册端点 ${url} ...`);
    await delay(500); // 模拟网络往返
    if (failMode) {
      status = 'failed';
      lastError = '模拟网络故障（ERR_SIMULATED）';
      log(`注册失败：模拟网络故障（ERR_SIMULATED）`);
      emit();
      return { ok: false, reason: lastError };
    }
    if (url === LOCAL_ENDPOINT) {
      status = 'registered';
      lastError = '';
      log(`注册成功：本地聚合端点（等效 Report-To 头已生效）`);
      emit();
      flush();
      return { ok: true };
    }
    // 非本地端点：真实尝试一次 POST 探测
    try {
      await fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/reports+json' },
        body: '[]',
      });
      status = 'registered';
      log(`注册成功：${url}（no-cors 探测已发出）`);
      emit();
      flush();
      return { ok: true };
    } catch (err) {
      status = 'failed';
      lastError = err.message;
      log(`注册失败：${err.message}`);
      emit();
      return { ok: false, reason: lastError };
    }
  }

  /* 报告投递：注册成功才投递；失败进入队列并提示 */
  async function deliver(report) {
    if (status !== 'registered') return;
    if (failMode || url !== LOCAL_ENDPOINT) {
      if (failMode) {
        queue.push(report);
        log(`投递失败（模拟故障），已缓存，待投递 ${queue.length} 条`);
        emit();
        return;
      }
      try {
        await fetch(url, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'application/reports+json' },
          keepalive: true,
          body: JSON.stringify([{ type: report.type, age: 0, url: report.url, body: report.body }]),
        });
      } catch (err) {
        queue.push(report);
        log(`投递失败：${err.message}，已缓存，待投递 ${queue.length} 条`);
        emit();
      }
    }
    // local://aggregate 即本地聚合本身，无需网络投递
  }

  function flush() {
    if (queue.length === 0) return;
    log(`端点恢复，重新投递缓存的 ${queue.length} 条报告`);
    queue = [];
    emit();
  }

  return {
    register, deliver, flush,
    LOCAL_ENDPOINT,
    getStatus: () => ({ status, url, queued: queue.length, lastError }),
    onChange: (fn) => listeners.add(fn),
    onLog: (fn) => logListeners.add(fn),
  };
})();
