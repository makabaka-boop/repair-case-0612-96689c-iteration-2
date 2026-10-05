import type { ModeResult, BimodalResult } from './lib/mode';

export type { ModeResult, BimodalResult } from './lib/mode';

/**
 * Worker 协议、界面快照与导出共用同一组类型：一次巡检的查询参数（queries、
 * bimodal）与答案属于同一个"查询快照"，换批或改选项重算时整块替换，任何
 * 中间渲染都不会出现上一批的第二名搭配本批第一名的状态。
 */

export interface WorkerRequest {
  /** values 为可转移的 Int32Array。 */
  values: Int32Array;
  queries: { left: number; right: number }[];
  /** 是否启用双峰复核；不传等同 false（旧协议）。 */
  bimodal?: boolean;
  /** 主线程为本轮计算分配的编号，响应原样返回，过期编号的响应被丢弃。 */
  runId: number;
}

export interface WorkerResponse {
  runId: number;
  bimodal: boolean;
  answers: ModeResult[] | BimodalResult[];
  elapsedMs: number;
}

/** 一次完成的巡检快照：查询、选项、答案、统计来自同一次 Worker 计算。 */
export type RunSnapshot =
  | {
      bimodal: false;
      queries: { left: number; right: number }[];
      answers: ModeResult[];
      n: number;
      q: number;
      elapsedMs: number;
    }
  | {
      bimodal: true;
      queries: { left: number; right: number }[];
      answers: BimodalResult[];
      n: number;
      q: number;
      elapsedMs: number;
    };
