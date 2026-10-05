import { describe, expect, it } from 'vitest';
import { correctionRobustness, type CorrectionAnswer } from './correction';
import type { ModeResult } from './mode';

/**
 * 独立预言机：对每个含可疑索引的查询，在（小）更正范围内逐值枚举替换，
 * 用朴素 Map 计数重算众数（频次优先、数值较小优先），找到首个使众数
 * （数值）变化的替换值。不依赖莫队/分块/扫描，纯暴力。
 */
function oracleCorrection(
  values: number[],
  queries: { left: number; right: number }[],
  index: number,
  lo: number,
  hi: number,
): CorrectionAnswer[] {
  const modeOf = (arr: number[], l: number, r: number): ModeResult => {
    const counts = new Map<number, number>();
    for (let i = l; i <= r; i++) counts.set(arr[i], (counts.get(arr[i]) ?? 0) + 1);
    let bestValue = Infinity;
    let bestCount = -1;
    for (const [value, count] of counts) {
      if (count > bestCount || (count === bestCount && value < bestValue)) {
        bestCount = count;
        bestValue = value;
      }
    }
    return { value: bestValue, count: bestCount };
  };

  return queries.map(({ left, right }) => {
    const original = modeOf(values, left, right);
    if (left > index || index > right) {
      return { original, affected: false, stable: true, minReplacement: null, changed: null };
    }
    let minReplacement: number | null = null;
    let changed: ModeResult | null = null;
    for (let v = lo; v <= hi; v++) {
      const copy = values.slice();
      copy[index] = v;
      const m = modeOf(copy, left, right);
      if (m.value !== original.value) {
        minReplacement = v;
        changed = m;
        break;
      }
    }
    return {
      original,
      affected: true,
      stable: minReplacement === null,
      minReplacement,
      changed,
    };
  });
}

/** 简易确定性 PRNG（mulberry32）。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('correctionRobustness - 手工构造的关键形态', () => {
  it('区间不含可疑索引时直接沿用原结果', () => {
    const values = Int32Array.of(5, -5, 5, -5, 0);
    const queries = [
      { left: 0, right: 1 }, // 不含 index=4
      { left: 2, right: 3 }, // 不含 index=4
    ];
    const got = correctionRobustness(values, queries, 4, -100, 100);
    expect(got).toEqual([
      { original: { value: -5, count: 1 }, affected: false, stable: true, minReplacement: null, changed: null },
      { original: { value: -5, count: 1 }, affected: false, stable: true, minReplacement: null, changed: null },
    ]);
  });

  it('并列频次：替换可打破并列，最小替换值与新众数精确', () => {
    // 窗口 [0,4]：5×2、-5×2、0×1 → 并列裁决众数 -5。可疑下标 4（值 0）。
    // 替换为 -5 → -5×3 众数仍是 -5（不是改变者）；替换为 5 → 5×3 反超，
    // 范围内比 5 小的值要么恢复并列、要么保持 -5 → 最小改变者是 5。
    const values = Int32Array.of(5, -5, 5, -5, 0);
    const got = correctionRobustness(values, [{ left: 0, right: 4 }], 4, -10, 10);
    expect(got[0].original).toEqual({ value: -5, count: 2 });
    expect(got[0].stable).toBe(false);
    expect(got[0].minReplacement).toBe(5);
    expect(got[0].changed).toEqual({ value: 5, count: 3 });
  });

  it('未出现的新值也能成为众数（M=1 时 v < A），双峰前二名无法发现', () => {
    // 窗口全互异：1、2、3，众数为最小值 1。把 values[1] 替换为范围内任意
    // 未出现的新值 v < 1 时，新窗口全互异、众数变为 v。
    const values = Int32Array.of(1, 2, 3);
    const got = correctionRobustness(values, [{ left: 0, right: 2 }], 1, -50, 50);
    expect(got[0].original).toEqual({ value: 1, count: 1 });
    expect(got[0].stable).toBe(false);
    expect(got[0].minReplacement).toBe(-50);
    expect(got[0].changed).toEqual({ value: -50, count: 1 });
  });

  it('负数端点：整个更正范围都在负数区间', () => {
    // 窗口 {7,7,3}：众数 7(2)。可疑下标 2（值 3）。替换为 -4 → 3 消失，
    // 窗口 {7,7,-4} 众数仍是 7；替换为 3 不变。负数范围内无改变者 → 稳定。
    const values = Int32Array.of(7, 7, 3);
    const got = correctionRobustness(values, [{ left: 0, right: 2 }], 2, -9, -2);
    expect(got[0]).toEqual({
      original: { value: 7, count: 2 },
      affected: true,
      stable: true,
      minReplacement: null,
      changed: null,
    });
  });

  it('仅部分查询受影响：含索引的才评估，不含的原样返回', () => {
    const values = Int32Array.of(2, -3, 2, -3, 5);
    const queries = [
      { left: 0, right: 1 }, // 不含 index=2
      { left: 0, right: 4 }, // 含 index=2
      { left: 3, right: 4 }, // 不含 index=2
      { left: 2, right: 2 }, // 仅可疑点本身
    ];
    const got = correctionRobustness(values, queries, 2, -4, 4);
    const expected = oracleCorrection(Array.from(values), queries, 2, -4, 4);
    expect(got).toEqual(expected);
    expect(got[0].affected).toBe(false);
    expect(got[1].affected).toBe(true);
    expect(got[2].affected).toBe(false);
    expect(got[3].affected).toBe(true);
  });

  it('可疑下标即窗口唯一元素（基准窗口为空）：任何不同值都改变众数', () => {
    const values = Int32Array.of(7, 8, 9);
    const queries = [{ left: 1, right: 1 }];
    // 范围含原值 8：最小改变者是 lo（lo ≠ 8）
    const got = correctionRobustness(values, queries, 1, 5, 9);
    expect(got[0]).toEqual({
      original: { value: 8, count: 1 },
      affected: true,
      stable: false,
      minReplacement: 5,
      changed: { value: 5, count: 1 },
    });
    // 范围恰为 {8}：稳定
    const only = correctionRobustness(values, queries, 1, 8, 8);
    expect(only[0].stable).toBe(true);
    // lo == 原值：改变者为 lo+1
    const shifted = correctionRobustness(values, queries, 1, 8, 10);
    expect(shifted[0].minReplacement).toBe(9);
    expect(shifted[0].changed).toEqual({ value: 9, count: 1 });
  });

  it('单元素数组：n=1 时基准窗口必为空', () => {
    const values = Int32Array.of(-2147483648);
    const got = correctionRobustness(values, [{ left: 0, right: 0 }], 0, -3, 2);
    expect(got[0].original).toEqual({ value: -2147483648, count: 1 });
    expect(got[0].stable).toBe(false);
    expect(got[0].minReplacement).toBe(-3);
    expect(got[0].changed).toEqual({ value: -3, count: 1 });
  });

  it('超宽更正范围（整个 int32 域）无需枚举即可回答', () => {
    // 窗口 {1,2,3} 全互异，众数 1；范围内最小值 -2147483648 < 1 即为改变者。
    const values = Int32Array.of(1, 2, 3);
    const got = correctionRobustness(
      values,
      [{ left: 0, right: 2 }],
      1,
      -2147483648,
      2147483647,
    );
    expect(got[0].stable).toBe(false);
    expect(got[0].minReplacement).toBe(-2147483648);
    expect(got[0].changed).toEqual({ value: -2147483648, count: 1 });

    // 窗口 {5,5,3}：众数 5(2)。任何替换都无法让别的值频次超过 2 且更小
    // （3 只剩 1 次）→ 整个 int32 域内稳定。
    const values2 = Int32Array.of(5, 5, 3);
    const got2 = correctionRobustness(
      values2,
      [{ left: 0, right: 2 }],
      2,
      -2147483648,
      2147483647,
    );
    expect(got2[0]).toEqual({
      original: { value: 5, count: 2 },
      affected: true,
      stable: true,
      minReplacement: null,
      changed: null,
    });
  });

  it('替换为原值本身永远不是改变者', () => {
    // values[2] = 2 在范围内且小于任何其他候选：若实现把"替换为原值"误当
    // 改变者，会错误返回 2。
    const values = Int32Array.of(9, 9, 2);
    const queries = [{ left: 0, right: 2 }];
    const got = correctionRobustness(values, queries, 2, 2, 5);
    // 窗口 {9,9,2}：众数 9(2)。v=2 → 不变；v∈{3,4,5} → 9 仍 2 次 → 稳定。
    expect(got[0].stable).toBe(true);
  });

  it('lo 等于原众数 O 时，最小改变者是 lo+1（O 自身不是改变者）', () => {
    // 窗口 {5,5,3,3}：并列 → 众数 3。可疑下标 2（值 3）。
    // 基准窗口 {5,5,3}：M=2，A=5 ≠ O=3。v=3 恢复并列（众数仍是 3）；
    // v=4 → 5×2 独占 → 众数变 5。
    const values = Int32Array.of(5, 5, 3, 3);
    const got = correctionRobustness(values, [{ left: 0, right: 3 }], 2, 3, 9);
    expect(got[0].original).toEqual({ value: 3, count: 2 });
    expect(got[0].stable).toBe(false);
    expect(got[0].minReplacement).toBe(4);
    expect(got[0].changed).toEqual({ value: 5, count: 2 });
  });

  it('c(v)=M-1 且 v < A 的窗口内值成为新众数（频次不变仍为 M）', () => {
    // 窗口 {5,5,5,3}：众数 5(3)。可疑下标 0（值 5）。
    // 基准窗口 {5,5,3}：M=2，A=5=O。改变者：c(3)=1=M-1 且 3<5 → v*=3，
    // 新窗口 {3,5,5,3} → 3×2、5×2 并列 → 众数 3，频次 2。
    const values = Int32Array.of(5, 5, 5, 3);
    const got = correctionRobustness(values, [{ left: 0, right: 3 }], 0, 0, 10);
    expect(got[0].stable).toBe(false);
    expect(got[0].minReplacement).toBe(3);
    expect(got[0].changed).toEqual({ value: 3, count: 2 });
  });
});

describe('correctionRobustness - 小值域逐值枚举预言机对照', () => {
  it('穷举小数组的每个下标、每个闭区间、每个小范围', () => {
    const sequences = [
      [-1],
      [0, 0],
      [1, -1],
      [2, -3, 2, -3, 5],
      [3, 1, 2, 3, 2, 1],
      [-7, -7, 5, 5, 0],
      [4, 4, 4, 1, 1, 0],
    ];
    for (const seq of sequences) {
      const n = seq.length;
      const queries: { left: number; right: number }[] = [];
      for (let l = 0; l < n; l++) {
        for (let r = l; r < n; r++) queries.push({ left: l, right: r });
      }
      for (let index = 0; index < n; index++) {
        for (const [lo, hi] of [
          [-3, 3],
          [-8, -2],
          [0, 0],
          [2, 9],
          [-9, 9],
        ]) {
          const got = correctionRobustness(Int32Array.from(seq), queries, index, lo, hi);
          expect(got).toEqual(oracleCorrection(seq, queries, index, lo, hi));
        }
      }
    }
  });

  it('随机小数组 × 随机查询 × 随机下标 × 随机小范围', () => {
    const cases = [
      { seed: 1, n: 6, q: 20, alphabet: 3, span: 4 },
      { seed: 2, n: 12, q: 60, alphabet: 4, span: 6 },
      { seed: 3, n: 30, q: 120, alphabet: 5, span: 8 },
      { seed: 4, n: 60, q: 200, alphabet: 2, span: 5 }, // 高并列概率
      { seed: 5, n: 80, q: 200, alphabet: 40, span: 10 }, // 大量未出现新值
      { seed: 6, n: 120, q: 300, alphabet: 6, span: 12 },
    ];
    for (const tc of cases) {
      const rand = rng(tc.seed);
      const values: number[] = new Array(tc.n);
      for (let i = 0; i < tc.n; i++) {
        values[i] = Math.floor(rand() * tc.alphabet) - (tc.alphabet >> 1);
      }
      const queries: { left: number; right: number }[] = new Array(tc.q);
      for (let i = 0; i < tc.q; i++) {
        const l = Math.floor(rand() * tc.n);
        queries[i] = { left: l, right: l + Math.floor(rand() * (tc.n - l)) };
      }
      for (let t = 0; t < 8; t++) {
        const index = Math.floor(rand() * tc.n);
        const lo = Math.floor(rand() * (2 * tc.span + 1)) - tc.span;
        const hi = lo + Math.floor(rand() * (2 * tc.span + 1));
        const got = correctionRobustness(Int32Array.from(values), queries, index, lo, hi);
        expect(got).toEqual(oracleCorrection(values, queries, index, lo, hi));
      }
    }
  });

  it('结果严格按查询原顺序返回，且与处理顺序无关', () => {
    const rand = rng(99);
    const n = 50;
    const values: number[] = new Array(n);
    for (let i = 0; i < n; i++) values[i] = Math.floor(rand() * 7) - 3;
    const q1: { left: number; right: number }[] = new Array(120);
    for (let i = 0; i < 120; i++) {
      const l = Math.floor(rand() * n);
      q1[i] = { left: l, right: l + Math.floor(rand() * (n - l)) };
    }
    const q2 = [...q1].reverse();
    const a1 = correctionRobustness(Int32Array.from(values), q1, 25, -5, 5);
    const a2 = correctionRobustness(Int32Array.from(values), q2, 25, -5, 5);
    for (let i = 0; i < q1.length; i++) {
      expect(a2[q2.length - 1 - i]).toEqual(a1[i]);
    }
  });
});

describe('correctionRobustness - 规模与复杂度守护', () => {
  it('5 万读数 × 5 万查询（含超宽范围）在同阶复杂度内完成', () => {
    const n = 50_000;
    const q = 50_000;
    const rand = rng(20261005);
    const values = new Int32Array(n);
    for (let i = 0; i < n; i++) values[i] = Math.floor(rand() * 9000) - 4500;
    const queries: { left: number; right: number }[] = new Array(q);
    for (let i = 0; i < q; i++) {
      const l = Math.floor(rand() * n);
      queries[i] = { left: l, right: l + Math.floor(rand() * (n - l)) };
    }
    const started = performance.now();
    // 整个 int32 域：若实现按值域枚举将永远无法完成
    const got = correctionRobustness(values, queries, n >> 1, -2147483648, 2147483647);
    const elapsed = performance.now() - started;
    expect(got.length).toBe(q);
    expect(elapsed).toBeLessThan(15_000);
  });
});
