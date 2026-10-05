import { rangeModes } from './lib/mode';
import { correctionRobustness } from './lib/correction';
import type { WorkerRequest, WorkerResponse } from './protocol';

// 模块同时被浏览器 Worker 与打包器引用，这里显式声明 Worker 全局上下文，
// 避免同时引入 DOM 与 WebWorker 类型库造成的全局冲突。
interface WorkerGlobalScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}
const ctx = globalThis as unknown as WorkerGlobalScope;

ctx.onmessage = (ev) => {
  const req = ev.data;
  const started =
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (req.kind === 'correction') {
    // 单点更正稳健性分析：原众数与基准窗口评估在同一次计算内完成，
    // 参数原样回传，主线程凭 runId 丢弃取消/过期轮次的回包。
    const answers = correctionRobustness(
      req.values,
      req.queries,
      req.correction.index,
      req.correction.lo,
      req.correction.hi,
    );
    const elapsedMs =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
      started;
    ctx.postMessage({
      kind: 'correction',
      runId: req.runId,
      correction: req.correction,
      answers,
      elapsedMs,
    });
    return;
  }
  const { values, queries, bimodal = false, runId } = req;
  // 众数与（可选的）第二名在同一次莫队移动、同一张增量频次表上产生。
  const answers = bimodal
    ? rangeModes(values, queries, { bimodal: true })
    : rangeModes(values, queries);
  const elapsedMs =
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
    started;
  ctx.postMessage({ runId, bimodal, answers, elapsedMs });
};
