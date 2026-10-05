# 夜间列车轴温 · 区间众数巡检

浏览器端离线工具：粘贴一批轴温读数与若干车轴区间查询，按查询原顺序返回每个
**闭区间 `[left, right]` 的众数及频次**；频次并列时取**较小数值**。面向
1～200000 条读数与 1～200000 个查询的长编组复核场景，计算在 Web Worker 中完成，
界面不会失去响应。

可选 **双峰复核**（界面勾选，不改变输入 JSON 契约）：除众数外，额外返回按
**出现次数降序、读数升序**排列的前两个**不同读数**及各自频次；窗口内只有一种
读数时第二名明确为 `null`（界面显示"空"）。第一名与未启用双峰时的众数逐项
一致。第二名与众数在同一次莫队移动维护的增量频次表上产生，不会逐区间重建。

## 输入格式（仅接受普通 JSON）

```json
{
  "values": [-1, 2, -1, 2, 0, 0, -1],
  "queries": [
    { "left": 0, "right": 6 },
    { "left": 1, "right": 3 }
  ]
}
```

- `values`：1～200000 个有符号 32 位整数（`-2147483648`～`2147483647`）。
- `queries`：1～200000 个对象，且**只能**含整数 `left`、`right`，
  满足 `0 ≤ left ≤ right < values.length`。
- 顶层只能含 `values`、`queries` 两个字段。

校验规则（任一不满足即整体拒绝，**定位首个错误**、清空旧结果、不输出部分答案）：
JSON 语法错误、未知字段、非整数（小数/布尔/字符串/`null`/对象等）、
数量越界（0 或 > 200000）、非法区间（`left > right` 或 `right ≥ values.length`）。
错误面板给出形如 `$.queries[3].right` 的字段路径与原始文本字符偏移，
并在输入框中选中首个错误字符。

## 输出

可滚动虚拟表格按查询原顺序逐行显示：**序号、边界 `[left, right]`、众数、频次**。
启用双峰复核后追加 **第二读数、第二频次** 两列（窗口内只有一种读数时两格显示
"空"）；表头、虚拟列表、状态栏末行摘要与 JSON 导出都来自**同一次 Worker 计算
产生的查询快照**，换批或改选项重算时整块替换，不会短暂展示上一批的第二名。
状态栏汇总数据规模与算法耗时，并显示可核对的**末行答案**（最后一个区间的唯一结果），
点击“滚动到末行”可直达。点击"导出结果 JSON"可下载当前快照（普通批次为
`{index,left,right,mode}`，双峰批次为 `{index,left,right,first,second}`，
`second` 为 `null` 表示单一读数）。

## 算法与复杂度

实现见 `src/lib/mode.ts`：

1. 对读数做坐标压缩（升序 rank，保证并列时最小 rank 即最小数值）；
2. **Mo's algorithm + Hilbert 曲线排序**处理全部查询，总指针移动 `O(n√q)`；
3. 值域按 `√m` 分块，每块维护“频次层”计数，加入/删除一个元素为摊还 `O(1)`；
4. 回答一个查询：`O(1)` 取全局最大频次 → `O(√m)` 找到最左命中块 →
   块内 `O(√m)` 升序找首个命中 rank。
5. **双峰复核（可选）**：在同一张随区间移动增量维护的频次表上，额外维护频次轴
   两级位图（32 个非空频次层/底层字 + 汇总字），加入/删除仍是摊还 `O(1)`；
   取次高频次层为位扫描（汇总字约 `n/1024` 个），再在值域块内升序找首个命中
   rank（与第一名同频次时跳过第一名本身）。第二名回答为 `O(n/1024 + √m)`。

**总时间复杂度 `O((n + q)√n)`，空间 `O(n + q)`；未启用双峰时行为与旧契约完全一致。**

## 本地运行

要求 Node.js 20+。

```bash
npm ci
npx playwright install chromium   # 仅跑 e2e 时需要

npm run dev        # 开发服务器（http://localhost:5173）
npm run build      # 类型检查 + 生产构建到 dist/
npm run preview    # 预览生产构建

npm run test:unit  # Vitest 算法与解析器单测（含 20 万对抗批次）
npm run e2e        # Playwright 端到端（粘贴、错误处理、结果浏览）
npm run verify     # 一次性验收：单测 + 构建 + e2e
```

### 端口覆盖

开发/预览/e2e 使用的宿主端口均可由环境变量 **`APP_PORT`** 覆盖：

```bash
APP_PORT=8080 npm run dev
APP_PORT=8080 npm run preview
```

## Docker Compose（一致环境）

提供两个服务（多阶段构建，验收镜像自带 Chromium 及其系统依赖）：

```bash
# 一次性验收服务：Vitest + 构建 + Playwright，全部通过则退出码 0
docker compose up --build verify

# 发布 Web 界面；宿主端口默认 4173，可用 APP_PORT 覆盖
APP_PORT=8080 docker compose up app
# 访问 http://localhost:8080
```

`app` 服务以 `vite preview` 提供 `dist/` 静态产物，容器内/宿主端口均跟随 `APP_PORT`。

## 目录结构

```
src/
  lib/mode.ts          区间众数算法（Mo + Hilbert + 值域分块频次层；可选双峰复核）
  lib/parseInput.ts    严格 JSON 解析/校验与首个错误定位
  protocol.ts          Worker 协议与查询快照类型（Worker/虚拟列表/导出共用）
  worker.ts            Web Worker：长任务计算，保持主线程响应
  App.tsx              界面：粘贴输入、双峰复核选项、错误面板、快照与导出
  VirtualTable.tsx     虚拟滚动结果表（序号/边界/众数/频次[+第二读数/第二频次]）
src/lib/*.test.ts      Vitest 单测（双峰含逐区间计数预言机）
e2e/app.spec.ts        Playwright 端到端（含 20 万读数 × 20 万查询、换批隔离）
Dockerfile             deps → build → verify / runtime 多阶段
docker-compose.yml     verify（一次性）与 app（发布，APP_PORT 覆盖）
```
