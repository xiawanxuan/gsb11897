# Reporting API 报告聚合中心

一个纯静态的 Reporting API 演示 / 调试台：注册 `Report-To` 端点，收集 CSP 违规、弃用警告、干预、崩溃报告，在本地跨标签页聚合，提供类型/来源统计、Canvas 时间线、过滤、导出与清空。

## 运行

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000 （建议 Chrome / Edge）
```

建议通过 HTTP 访问而非 `file://`：`BroadcastChannel` 与 `IndexedDB` 在部分浏览器的 `file://` 源下不可用。

## 功能与技术对照

| 能力 | 实现 |
| --- | --- |
| 报告采集 | `ReportingObserver`（buffered），类型：csp-violation / deprecation / intervention / crash |
| 端点注册 | `js/endpoint.js` 模拟 `Report-To` / `Reporting-Endpoints` 注册与投递，失败有横幅提示与重试 |
| 降级 | 无 `ReportingObserver` 时降级为 `securitypolicyviolation` / `error` / `unhandledrejection` 手动采集 |
| 跨标签页聚合 | `BroadcastChannel` 广播 + `IndexedDB` 共享存储，按报告 id 去重 |
| 乱序容忍 | 事件时间排序展示；seq 缺口进入 3s 容忍窗口，窗口内补齐不判丢失 |
| 丢失检测 | 超过容忍窗口仍未到达的 seq 判定丢失并计数 |
| 过多截断 | 容量上限 500 条，超出丢弃最旧并提示 |
| 时间线 | Canvas 堆叠柱状图（按类型着色、悬停明细、可调桶粒度） |
| 过滤 / 导出 / 清空 | 类型、来源、标签页、关键词过滤；JSON / CSV 导出；一键清空（全标签页同步） |

## 模拟场景按钮

- **CSP 违规（真实）**：`eval()` / 外链脚本被页面 CSP（`script-src 'self'`）真实拦截，产生真实报告。
- **弃用 / 干预 / 崩溃（模拟）**：生成符合 Chrome 报告体格式的模拟报告。
- **乱序 ×6**：seq 打乱 + 时间倒挂注入，验证不误判丢失。
- **丢失序列**：跳过部分 seq，约 3 秒后判定丢失。
- **突发 ×600**：超过容量上限，验证截断与提示。

## 验收标准映射

- 报告收集正确 → ReportingObserver + 降级手动采集双路径
- 类型和来源展示准确 → 类型着色标签 + 来源列（observer / 手动事件 / 模拟）
- 时间线正确 → 按事件时间分桶，乱序报告归位到正确时间桶
- 过滤和导出正确 → 四条件过滤，导出作用于过滤结果
- 不支持时有降级 → 黄色横幅说明降级路径
- 端点注册失败有提示 → 红色横幅 + 状态芯片 + 重试按钮
- 报告乱序不误判 → 容忍窗口 + “乱序到达（已容忍）”计数
- 报告过多有截断 → 500 条上限 + 截断横幅与计数
- 跨标签页聚合正确 → BroadcastChannel + IndexedDB，统计卡显示标签页数
- 可视化准确 → Canvas 堆叠柱与表格数据同源（同一过滤结果）
