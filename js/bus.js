/* BroadcastChannel 跨标签页同步总线 */
window.ReportHub = window.ReportHub || {};
ReportHub.bus = (() => {
  const supported = typeof BroadcastChannel !== 'undefined';
  const listeners = new Set();
  let channel = null;
  if (supported) {
    channel = new BroadcastChannel('report-hub-bus');
    channel.onmessage = (e) => listeners.forEach((fn) => {
      try { fn(e.data); } catch (err) { console.error('bus listener error', err); }
    });
  }
  return {
    supported,
    post(msg) { if (channel) channel.postMessage(msg); },
    on(fn) { listeners.add(fn); },
  };
})();
