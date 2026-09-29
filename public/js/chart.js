'use strict';
/* Canvas 时间线：按时间分桶、按类型堆叠的柱状图，悬停显示明细 */
const TimelineChart = (() => {
  const COLORS = {
    'csp-violation': '#e05252',
    'deprecation': '#e0a83c',
    'intervention': '#7c6ce0',
    'crash': '#d0439b',
    'network-error': '#3c9de0',
    'manual-error': '#8b95ab',
    unknown: '#8b95ab',
  };
  const BUCKETS = [
    { ms: 1000, label: '秒' },
    { ms: 5000 }, { ms: 10000 }, { ms: 30000 },
    { ms: 60000, label: '分' },
    { ms: 300000 }, { ms: 600000 }, { ms: 1800000 },
    { ms: 3600000, label: '时' }, { ms: 21600000 }, { ms: 86400000 },
  ];
  const MAX_BUCKET_COUNT = 48;

  let canvas, ctx, tooltipEl, buckets = [], bucketSize = 60000, types = [];
  let rects = [];

  function colorOf(type) { return COLORS[type] || COLORS.unknown; }

  function pad(n) { return String(n).padStart(2, '0'); }

  function bucketLabel(t0, t1, ms) {
    const d = new Date(t0);
    if (ms < 60000) return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    if (ms < 86400000) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function compute(reports) {
    types = [...new Set(reports.map((r) => r.type))];
    if (reports.length === 0) { buckets = []; return; }
    const tMin = reports[0].eventTime;
    const tMax = Math.max(reports[reports.length - 1].eventTime, Date.now());
    const span = Math.max(tMax - tMin, 1000);
    bucketSize = BUCKETS.find((b) => span / b.ms <= MAX_BUCKET_COUNT)?.ms || 86400000;
    const start = Math.floor(tMin / bucketSize) * bucketSize;
    const end = Math.ceil(tMax / bucketSize) * bucketSize;
    const n = Math.min(120, Math.max(1, Math.round((end - start) / bucketSize)));
    buckets = Array.from({ length: n }, (_, i) => {
      const counts = {};
      for (const t of types) counts[t] = 0;
      return { t0: start + i * bucketSize, t1: start + (i + 1) * bucketSize, total: 0, counts };
    });
    for (const r of reports) {
      const idx = Math.min(n - 1, Math.floor((r.eventTime - start) / bucketSize));
      if (buckets[idx]) {
        buckets[idx].counts[r.type] = (buckets[idx].counts[r.type] || 0) + 1;
        buckets[idx].total++;
      }
    }
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 260;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function draw(reports, typeList) {
    compute(reports);
    const { w, h } = resizeCanvas();
    ctx.clearRect(0, 0, w, h);
    rects = [];
    if (buckets.length === 0) {
      ctx.fillStyle = '#5f6d94';
      ctx.font = '13px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无报告数据', w / 2, h / 2);
      return;
    }
    const padL = 38, padR = 12, padT = 12, padB = 26;
    const plotW = w - padL - padR, plotH = h - padT - padB;
    const maxTotal = Math.max(1, ...buckets.map((b) => b.total));
    const drawTypes = (typeList && typeList.length ? typeList : types).filter((t) => COLORS[t] || types.includes(t));

    /* 网格 + Y 轴 */
    ctx.strokeStyle = '#232c46';
    ctx.fillStyle = '#7d8bb3';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.lineWidth = 1;
    const gridN = 4;
    for (let i = 0; i <= gridN; i++) {
      const y = padT + plotH - (plotH * i) / gridN;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      const v = Math.round((maxTotal * i) / gridN);
      ctx.fillText(String(v), padL - 5, y + 3);
    }

    /* 堆叠柱 */
    const slot = plotW / buckets.length;
    const barW = Math.max(2, Math.min(26, slot * 0.7));
    buckets.forEach((b, i) => {
      const x = padL + i * slot + (slot - barW) / 2;
      let yBase = padT + plotH;
      for (const type of drawTypes) {
        const n = b.counts[type] || 0;
        if (!n) continue;
        const segH = (plotH * n) / maxTotal;
        const y = yBase - segH;
        ctx.fillStyle = colorOf(type);
        ctx.fillRect(x, y, barW, segH);
        rects.push({ x, y, w: barW, h: segH, bucketIndex: i, type });
        yBase = y;
      }
      /* X 轴标签：约 6 个 */
      if (buckets.length <= 12 || i % Math.ceil(buckets.length / 6) === 0) {
        ctx.fillStyle = '#7d8bb3';
        ctx.textAlign = 'center';
        ctx.fillText(bucketLabel(b.t0, b.t1, bucketSize), x + barW / 2, h - 8);
      }
    });
  }

  function tooltipAt(evt) {
    if (!rects.length) { tooltipEl.hidden = true; return; }
    const dpr = 1;
    const box = canvas.getBoundingClientRect();
    const mx = evt.clientX - box.left;
    const my = evt.clientY - box.top;
    const hit = rects.find((r) => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h);
    if (!hit) { tooltipEl.hidden = true; return; }
    const b = buckets[hit.bucketIndex];
    const lines = Object.entries(b.counts)
      .filter(([, n]) => n > 0)
      .map(([t, n]) => `<span class="dot type-${String(t).toLowerCase().replace(/[^a-z0-9-]/g, '-')}">●</span> ${TYPE_LABELS[t] || t}: ${n}`);
    tooltipEl.innerHTML =
      `<strong>${new Date(b.t0).toLocaleString()} ~ ${new Date(b.t1).toLocaleTimeString()}</strong><br>` +
      `合计: ${b.total}<br>${lines.join('<br>')}`;
    tooltipEl.hidden = false;
    const wrap = canvas.parentElement.getBoundingClientRect();
    let left = evt.clientX - wrap.left + 14;
    let top = evt.clientY - wrap.top + 14;
    if (left + 220 > wrap.width) left = evt.clientX - wrap.left - 230;
    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  }

  const TYPE_LABELS = {};

  function init(canvasEl, tooltipEl_, labels) {
    canvas = canvasEl;
    ctx = canvas.getContext('2d');
    tooltipEl = tooltipEl_;
    Object.assign(TYPE_LABELS, labels);
    canvas.addEventListener('mousemove', tooltipAt);
    canvas.addEventListener('mouseleave', () => { tooltipEl.hidden = true; });
  }

  return { init, draw, colorOf, COLORS };
})();
