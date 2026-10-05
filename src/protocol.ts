import type { ModeResult, BimodalResult, RobustParams, RobustResult } from './lib/mode';

export type { ModeResult, BimodalResult, RobustParams, RobustResult } from './lib/mode';

/**
 * Worker 协议、界面快照与导出共用同一组类型：一次巡检的查询参数（queries、
 * 分析模式、稳健性参数）与答案属于同一个"输入快照"，换批、改选项或发起新
 * 分析时整块替换，任何中间渲染都不会出现上一批的答案搭配本批参数的状态；
 * 过期 Worker 回包按 runId 丢弃，绝不覆盖更新一次分析的结果。
 */

export interface WorkerRequest {
  /** values 为可转移的 Int32Array。 */
  values: Int32Array;
  queries: { left: number; right: number }[];
  /** 是否启用双峰复核；不传等同 false（旧协议）。与 robust 互斥。 */
  bimodal?: boolean;
  /** 一次性单点更正稳健性分析参数；提供时 bimodal 必须为 false。 */
  robust?: RobustParams;
  /** 主线程为本轮计算分配的编号，响应原样返回，过期编号的响应被丢弃。 */
  runId: number;
}

export interface WorkerResponse {
  runId: number;
  bimodal: boolean;
  robust: RobustParams | null;
  answers: ModeResult[] | BimodalResult[] | RobustResult[];
  elapsedMs: number;
}

/** 一次完成的巡检快照：查询、选项、答案、统计来自同一次 Worker 计算。 */
export type RunSnapshot =
  | {
      kind: 'normal';
      bimodal: false;
      queries: { left: number; right: number }[];
      answers: ModeResult[];
      n: number;
      q: number;
      elapsedMs: number;
    }
  | {
      kind: 'bimodal';
      bimodal: true;
      queries: { left: number; right: number }[];
      answers: BimodalResult[];
      n: number;
      q: number;
      elapsedMs: number;
    }
  | {
      kind: 'robust';
      bimodal: false;
      /** 本轮快照绑定的稳健性参数（原数组下标与替换闭区间）。 */
      robust: RobustParams;
      queries: { left: number; right: number }[];
      answers: RobustResult[];
      n: number;
      q: number;
      elapsedMs: number;
    };
