'use strict';
/* BroadcastChannel 跨标签页通信：报告广播、清空同步、在线标签页计数 */
const Bus = (() => {
  const CHANNEL = 'reporting-dashboard-bus';
  const HEARTBEAT_MS = 4000;
  const PEER_TTL_MS = 12000;

  const tabId = (() => {
    let id = sessionStorage.getItem('reporting-tab-id');
    if (!id) {
      id = Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem('reporting-tab-id', id);
    }
    return id;
  })();

  const supported = 'BroadcastChannel' in window;
  const channel = supported ? new BroadcastChannel(CHANNEL) : null;
  const peers = new Map(); // tabId -> lastSeen
  const handlers = { report: [], clear: [], peers: [] };

  function emit(name, ...args) {
    for (const fn of handlers[name]) {
      try { fn(...args); } catch (err) { console.error(err); }
    }
  }

  function post(msg) {
    if (channel) channel.postMessage({ ...msg, from: tabId });
  }

  function prunePeers() {
    const now = Date.now();
    for (const [id, seen] of peers) {
      if (now - seen > PEER_TTL_MS) peers.delete(id);
    }
    emit('peers', peers.size + 1);
  }

  if (channel) {
    channel.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.from === tabId) return;
      if (msg.kind === 'report') emit('report', msg.report);
      else if (msg.kind === 'clear') emit('clear');
      else if (msg.kind === 'hello') {
        peers.set(msg.from, Date.now());
        post({ kind: 'here' });
        prunePeers();
      } else if (msg.kind === 'here' || msg.kind === 'heartbeat') {
        peers.set(msg.from, Date.now());
        prunePeers();
      }
    };
    post({ kind: 'hello' });
    setInterval(() => {
      post({ kind: 'heartbeat' });
      prunePeers();
    }, HEARTBEAT_MS);
    setTimeout(prunePeers, 500);
  }

  return {
    tabId,
    supported,
    onReport: (fn) => handlers.report.push(fn),
    onClear: (fn) => handlers.clear.push(fn),
    onPeers: (fn) => handlers.peers.push(fn),
    broadcastReport: (report) => post({ kind: 'report', report }),
    broadcastClear: () => post({ kind: 'clear' }),
    peerCount: () => peers.size + 1,
  };
})();
