# Reporting API 监控台

围绕 Reporting API 的报告采集与可视化演示：注册 `report-to` 端点，收集 CSP 违规、弃用警告、崩溃、干预、网络错误报告，本地聚合展示类型 / 来源 / 时间线，支持过滤、导出、清空，并可模拟各类报告与异常场景。

## 运行

```bash
node server.js          # 默认 http://localhost:8080
# 或自定义：HOST=127.0.0.1 PORT=9000 node server.js
```

打开两个标签页即可验证跨标签页聚合（BroadcastChannel + 共享 IndexedDB）。

## 技术栈

- **Reporting API / Report-To / Reporting-Endpoints**：服务器下发响应头注册 `default` 端点组，浏览器将报告 POST 到 `/api/reports`（另兼容 legacy `report-uri` → `/api/csp-report`）
- **CSP**：`default-src 'self'` 等严格策略 + `report-to default`，真实违规可被捕获
- **ReportingObserver**：页面内直接观察报告（不依赖端点）
- **BroadcastChannel**：跨标签页广播新报告 / 清空 / 在线心跳
- **IndexedDB**：共享权威存储，所有标签页聚合读取，按 id 去重
- **Canvas**：按时间分桶、按类型堆叠的时间线图表，悬停查看明细

## 报告来源

| 来源 | 说明 |
| --- | --- |
| 浏览器端点 (report-to) | 浏览器投递到服务器、前端轮询拉取 |
| ReportingObserver | 页面内观察者直接捕获 |
| 手动降级采集 | `window.onerror` / `unhandledrejection` |
| 模拟生成 | 内置模拟器 |

## 异常场景处理

- **浏览器不支持 Reporting API**：检测 `ReportingObserver`，自动降级为手动采集并提示
- **端点注册失败**：定期健康检查 `/api/health`，失败时红色告警 + 自动切换 Observer/手动模式，可一键重试；「模拟端点故障」按钮可演示
- **报告乱序**：按事件时间归位，晚到报告标记「乱序到达」，**不计为丢失**
- **报告丢失**：按标签页 seq 缺口跟踪，15 秒未补齐才计为丢失
- **报告过多**：超过 500 条自动截断最旧记录并计数提示；表格最多渲染 200 行
- **跨标签页聚合**：BroadcastChannel 广播 + IndexedDB 共享 + 按 id 去重，多标签页数据一致

## 文件结构

```
server.js            # 零依赖 Node 服务器：静态托管 + 安全响应头 + 报告接收/拉取 API
public/index.html    # 监控台页面
public/css/style.css
public/js/db.js        # IndexedDB 持久化
public/js/bus.js       # BroadcastChannel 跨标签页通信
public/js/collector.js # 统一入库管线（去重/乱序/丢失/截断）+ 三种采集源
public/js/simulator.js # 报告与异常场景模拟
public/js/chart.js     # Canvas 时间线
public/js/app.js       # UI 主控（过滤/导出/清空/告警）
```
