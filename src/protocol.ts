import type { ModeResult, BimodalResult } from './lib/mode';
import type { CorrectionAnswer } from './lib/correction';

export type { ModeResult, BimodalResult } from './lib/mode';
export type { CorrectionAnswer } from './lib/correction';

/**
 * Worker 协议、界面快照与导出共用同一组类型：一次巡检的查询参数（queries、
 * bimodal）与答案属于同一个"查询快照"，换批或改选项重算时整块替换，任何
 * 中间渲染都不会出现上一批的第二名搭配本批第一名的状态。
 *
 * 单点更正稳健性分析是独立通道（kind: 'correction'）：请求携带可疑下标与
 * 允许更正闭区间，响应按查询原顺序返回每条查询的稳健性结论。主线程为该
 * 通道使用独立的 Worker 实例与独立的 runId 序列，取消或再次发起分析时，
 * 旧 Worker 的迟到回包会因 runId 不匹配被丢弃，绝不会覆盖新快照。
 */

/** 单点更正稳健性分析的参数：可疑读数下标 + 允许更正闭区间 [lo, hi]。 */
export interface CorrectionParams {
  /** 可疑读数在 values 中的下标，0 <= index < values.length。 */
  index: number;
  /** 允许更正的最小值（有符号 32 位整数）。 */
  lo: number;
  /** 允许更正的最大值（有符号 32 位整数），需 lo <= hi。 */
  hi: number;
}

export interface ModeRunRequest {
  /** 缺省即普通众数巡检（旧协议）。 */
  kind?: 'modes';
  /** values 为可转移的 Int32Array。 */
  values: Int32Array;
  queries: { left: number; right: number }[];
  /** 是否启用双峰复核；不传等同 false（旧协议）。 */
  bimodal?: boolean;
  /** 主线程为本轮计算分配的编号，响应原样返回，过期编号的响应被丢弃。 */
  runId: number;
}

export interface CorrectionRunRequest {
  kind: 'correction';
  /** values 为可转移的 Int32Array。 */
  values: Int32Array;
  queries: { left: number; right: number }[];
  /** 单点更正稳健性分析参数。 */
  correction: CorrectionParams;
  /** 本通道独立编号，响应原样返回，过期编号的响应被丢弃。 */
  runId: number;
}

export type WorkerRequest = ModeRunRequest | CorrectionRunRequest;

export interface ModeRunResponse {
  kind?: 'modes';
  runId: number;
  bimodal: boolean;
  answers: ModeResult[] | BimodalResult[];
  elapsedMs: number;
}

export interface CorrectionRunResponse {
  kind: 'correction';
  runId: number;
  /** 请求参数原样返回，便于主线程校验快照一致性。 */
  correction: CorrectionParams;
  answers: CorrectionAnswer[];
  elapsedMs: number;
}

export type WorkerResponse = ModeRunResponse | CorrectionRunResponse;

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

/**
 * 一次完成的单点更正稳健性快照：分析参数、查询、答案、统计来自同一次
 * Worker 计算；结果表与导出只读取该快照，重新分析或取消时整块替换。
 */
export interface CorrectionSnapshot {
  correction: CorrectionParams;
  queries: { left: number; right: number }[];
  answers: CorrectionAnswer[];
  n: number;
  q: number;
  elapsedMs: number;
}
