import { rangeModes } from './lib/mode';
import type { WorkerRequest, WorkerResponse } from './protocol';

// 模块同时被浏览器 Worker 与打包器引用，这里显式声明 Worker 全局上下文，
// 避免同时引入 DOM 与 WebWorker 类型库造成的全局冲突。
interface WorkerGlobalScope {
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
}
const ctx = globalThis as unknown as WorkerGlobalScope;

ctx.onmessage = (ev) => {
  const { values, queries, bimodal = false, robust = null, runId } = ev.data;
  const started =
    typeof performance !== 'undefined' ? performance.now() : Date.now();
  // 普通众数、双峰第二名与单点更正稳健性都在同一次莫队移动、同一张增量
  // 频次表上产生（三种模式互斥），答案与请求参数同属一个输入快照。
  const answers = robust
    ? rangeModes(values, queries, { robust })
    : bimodal
      ? rangeModes(values, queries, { bimodal: true })
      : rangeModes(values, queries);
  const elapsedMs =
    (typeof performance !== 'undefined' ? performance.now() : Date.now()) -
    started;
  ctx.postMessage({ runId, bimodal, robust, answers, elapsedMs });
};
