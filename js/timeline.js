/* Canvas 时间线：按类型堆叠的柱状图，含坐标轴、悬停提示、图例 */
window.ReportHub = window.ReportHub || {};
ReportHub.timeline = (() => {
  const TYPE_COLORS = {
    'csp-violation': '#ff7d90',
    deprecation: '#f0c75e',
    intervention: '#6fb3ff',
    crash: '#c792ea',
    error: '#ff9e64',
    other: '#8fa0c0',
  };
  const TYPE_LABELS = {
    'csp-violation': 'CSP 违规',
    deprecation: '弃用警告',
    intervention: '干预',
    crash: '崩溃',
    error: '脚本错误',
    other: '其他',
  };
  const PADDING = { left: 36, right: 12, top: 14, bottom: 26 };

  let canvas, ctx, tooltip;
  let buckets = [];
  let bucketMs = 5000;
  let geometry = { plotW: 0, plotH: 0, maxCount: 1, startTs: 0 };

  function colorOf(type) { return TYPE_COLORS[type] || TYPE_COLORS.other; }
  function labelOf(type) { return TYPE_LABELS[type] || type; }

  function init(canvasEl, tooltipEl) {
    canvas = canvasEl;
    tooltip = tooltipEl;
    ctx = canvas.getContext('2d');
    canvas.addEventListener('mousemove', onHover);
    canvas.addEventListener('mouseleave', () => tooltip.classList.add('hidden'));
    window.addEventListener('resize', () => draw());
  }

  function setBucketMs(ms) { bucketMs = ms; }

  function update(reports) {
    // 按事件时间分桶，每桶内按类型计数
    const map = new Map();
    let min = Infinity, max = -Infinity;
    reports.forEach((r) => {
      const b = Math.floor(r.ts / bucketMs) * bucketMs;
      if (!map.has(b)) map.set(b, {});
      const bucket = map.get(b);
      bucket[r.type] = (bucket[r.type] || 0) + 1;
      if (b < min) min = b;
      if (b > max) max = b;
    });
    buckets = [];
    if (isFinite(min)) {
      for (let t = min; t <= max; t += bucketMs) {
        buckets.push({ ts: t, counts: map.get(t) || {} });
      }
    }
    draw();
  }

  function resizeCanvas() {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return rect;
  }

  function draw() {
    if (!ctx) return;
    const rect = resizeCanvas();
    const W = rect.width, H = rect.height;
    ctx.clearRect(0, 0, W, H);
    const plotW = W - PADDING.left - PADDING.right;
    const plotH = H - PADDING.top - PADDING.bottom;
    const maxCount = Math.max(1, ...buckets.map((b) =>
      Object.values(b.counts).reduce((a, c) => a + c, 0)));
    geometry = { plotW, plotH, maxCount, startTs: buckets.length ? buckets[0].ts : 0 };

    // 网格与 Y 轴刻度
    ctx.strokeStyle = '#232c42';
    ctx.fillStyle = '#7c8db0';
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const y = PADDING.top + plotH - (plotH * i) / ticks;
      const val = Math.round((maxCount * i) / ticks);
      ctx.beginPath();
      ctx.moveTo(PADDING.left, y);
      ctx.lineTo(W - PADDING.right, y);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(val), PADDING.left - 6, y + 3);
    }

    if (!buckets.length) {
      ctx.fillStyle = '#7c8db0';
      ctx.textAlign = 'center';
      ctx.font = '13px sans-serif';
      ctx.fillText('暂无报告 — 使用上方按钮生成', W / 2, H / 2);
      return;
    }

    // 堆叠柱
    const slot = plotW / buckets.length;
    const barW = Math.max(2, Math.min(40, slot * 0.7));
    buckets.forEach((b, i) => {
      const x = PADDING.left + i * slot + (slot - barW) / 2;
      let y = PADDING.top + plotH;
      Object.keys(TYPE_COLORS).concat('other').forEach((type) => {
        const count = b.counts[type];
        if (!count) return;
        const h = (plotH * count) / maxCount;
        y -= h;
        ctx.fillStyle = colorOf(type);
        ctx.fillRect(x, y, barW, h);
      });
    });

    // X 轴时间刻度（最多 8 个标签）
    ctx.fillStyle = '#7c8db0';
    ctx.textAlign = 'center';
    ctx.font = '10px ui-monospace, monospace';
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 8));
    buckets.forEach((b, i) => {
      if (i % labelEvery !== 0) return;
      const x = PADDING.left + i * slot + slot / 2;
      const d = new Date(b.ts);
      const label = d.toLocaleTimeString('zh-CN', { hour12: false });
      ctx.fillText(label, x, PADDING.top + plotH + 16);
    });
  }

  function onHover(e) {
    if (!buckets.length) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left - PADDING.left;
    const idx = Math.floor(x / (geometry.plotW / buckets.length));
    if (idx < 0 || idx >= buckets.length) {
      tooltip.classList.add('hidden');
      return;
    }
    const b = buckets[idx];
    const lines = [new Date(b.ts).toLocaleTimeString('zh-CN', { hour12: false })];
    let total = 0;
    Object.entries(b.counts).forEach(([type, count]) => {
      lines.push(`${labelOf(type)}: ${count}`);
      total += count;
    });
    lines.push(`合计: ${total}`);
    tooltip.textContent = lines.join('\n');
    tooltip.style.left = Math.min(e.clientX - rect.left + 12, rect.width - 140) + 'px';
    tooltip.style.top = (e.clientY - rect.top + 12) + 'px';
    tooltip.classList.remove('hidden');
  }

  function renderLegend(el, types) {
    el.innerHTML = '';
    types.forEach((type) => {
      const item = document.createElement('span');
      const sw = document.createElement('span');
      sw.className = 'swatch';
      sw.style.background = colorOf(type);
      item.appendChild(sw);
      item.appendChild(document.createTextNode(labelOf(type)));
      el.appendChild(item);
    });
  }

  return { init, update, setBucketMs, renderLegend, colorOf, labelOf, TYPE_COLORS, TYPE_LABELS };
})();
