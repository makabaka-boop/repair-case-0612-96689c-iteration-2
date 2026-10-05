/**
 * 单点更正稳健性分析（一次性）。
 *
 * 巡检员怀疑 values[index] 录错但尚未拿到复测值：把该读数替换为允许范围
 * [lo, hi]（有符号 32 位整数闭区间）内的任意值时，各查询区间的众数是否可能
 * 改变？对每条查询返回：
 *   - 原众数 original（含可疑读数的原始窗口，与 rangeModes 一致）；
 *   - stable：区间内所有替换值下众数（数值）是否保持不变；
 *   - 若会改变：使众数变化的最小替换值 minReplacement，以及该值下的新众数
 *     与频次 changed。
 *
 * 裁决规则与主流程一致：频次优先、数值较小优先。区间不含可疑索引时替换不影
 * 响窗口，直接沿用原结果（stable = true）。
 *
 * 算法（不枚举整个整数值域）：
 *   1. 含可疑索引 s 的区间 [l, r] 移除 s 后，等价于"删除第 s 个元素后的数组
 *      w"上的连续区间 [l, r-1] —— 对受影响查询在 w 上做一次莫队（Hilbert
 *      排序 + 值域 √m 分块频次层，与 mode.ts 同款骨架）；
 *   2. 回答时窗口的基准计数记为 c(·)，最大频次 M、最小高频值 A。对任意替换
 *      值 v（c(v)=0 表示不在窗口内）：
 *        c(v) = M     → 新众数为 v（频次 M+1）
 *        c(v) = M - 1 → 新众数为 min(v, A)（频次 M）
 *        c(v) ≤ M - 2 → 新众数为 A（频次 M）
 *      因此"改变者"只可能来自窗口内 c ∈ {M, M-1} 的值与 O(1) 个边界候选，
 *      用分块频次层做 O(√m) 升序扫描即可定位最小改变者，与 [lo, hi] 的宽度
 *      无关。新值（未在窗口出现的整数）只在 M = 1 且 v < A 时才能成为众数，
 *      此时最小改变者就是 lo 本身 —— 这正是"双峰"前二名无法覆盖的情形，
 *      不能拿双峰结果当充分证据。
 *   3. 原众数 O 与原频次 C 来自对原数组的一次 rangeModes；基准计数
 *      c(O) = C - (values[s] === O ? 1 : 0)。可以证明 c(O) ∈ {M-1, M}，
 *      且 values[s] ≠ O 时必有 A = O（移除一个非众数读数不会改变窗口众数
 *      的最小高频值），这两条不变量在分支注释中标注。
 *
 * 总时间复杂度 O((n + q)√n)，空间 O(n + q)，与主巡检同阶。
 */

import { rangeModes, type ModeResult } from './mode';

/** 单条查询的单点更正稳健性结论。 */
export interface CorrectionAnswer {
  /** 原众数及频次（含可疑读数的原始窗口）。 */
  original: ModeResult;
  /** 查询区间是否包含可疑索引（不含时替换不影响窗口，直接沿用原结果）。 */
  affected: boolean;
  /** 对 [lo, hi] 内所有替换值，众数（数值）是否保持不变。 */
  stable: boolean;
  /** stable = false 时：使众数变化的最小替换值；否则为 null。 */
  minReplacement: number | null;
  /** stable = false 时：该替换值下的新众数及频次；否则为 null。 */
  changed: ModeResult | null;
}

/** Hilbert 曲线序号（与 mode.ts 保持一致：power >= 1，序号范围 [0, 2^(2power))）。 */
function hilbertOrder(x: number, y: number, power: number): number {
  let order = 0;
  let rx = 0;
  let ry = 0;
  let dist = 0;
  for (let s = 1 << (power - 1); s > 0; s >>>= 1) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    order += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) {
        x = (1 << power) - 1 - x;
        y = (1 << power) - 1 - y;
      }
      dist = x;
      x = y;
      y = dist;
    }
  }
  return order;
}

/** 将升序数组就地去重，返回去重后长度（空数组返回 0）。 */
function deduplicateInPlace(arr: number[]): number {
  if (arr.length === 0) return 0;
  let w = 0;
  for (let r = 1; r < arr.length; r++) {
    if (arr[r] !== arr[w]) arr[++w] = arr[r];
  }
  return w + 1;
}

/** 升序数组中首个 >= x 的下标（下界）。 */
function lowerBound(arr: number[], x: number): number {
  let l = 0;
  let r = arr.length;
  while (l < r) {
    const mid = (l + r) >>> 1;
    if (arr[mid] < x) l = mid + 1;
    else r = mid;
  }
  return l;
}

/**
 * 对每条查询评估单点更正稳健性。
 *
 * @param values 长度 n（1..200000）的有符号 32 位整数序列
 * @param queries 长度 q（1..200000）的闭区间查询
 * @param index 可疑读数下标，0 <= index < n
 * @param lo 允许更正范围下界（有符号 32 位整数）
 * @param hi 允许更正范围上界（有符号 32 位整数），需 lo <= hi
 * @returns 按 queries 原顺序排列的稳健性结论
 */
export function correctionRobustness(
  values: Int32Array,
  queries: ReadonlyArray<{ left: number; right: number }>,
  index: number,
  lo: number,
  hi: number,
): CorrectionAnswer[] {
  const n = values.length;
  const q = queries.length;
  // 原众数：所有查询共用同一次主巡检结果，保证"原众数"列与主流程逐项一致。
  const originals = rangeModes(values, queries);

  const answers = new Array<CorrectionAnswer>(q);
  // 受影响查询（区间含可疑索引）：映射为 w 上的连续区间 [left, right-1]。
  const affected: { qi: number; left: number; right: number }[] = [];
  for (let i = 0; i < q; i++) {
    const { left, right } = queries[i];
    if (left <= index && index <= right) {
      affected.push({ qi: i, left, right: right - 1 });
    } else {
      answers[i] = {
        original: originals[i],
        affected: false,
        stable: true,
        minReplacement: null,
        changed: null,
      };
    }
  }
  if (affected.length === 0) return answers;

  // ---- 删除可疑下标后的序列 w：原 [l, s-1] ∪ [s+1, r] = w[l, r-1] ----
  const nW = n - 1;
  const w = new Int32Array(nW);
  for (let i = 0; i < nW; i++) w[i] = i < index ? values[i] : values[i + 1];

  // ---- 坐标压缩（升序 rank，并列时 rank 小即数值小）----
  const sorted = Array.from(w).sort((a, b) => a - b);
  const m = deduplicateInPlace(sorted);
  sorted.length = m;
  const rankOf = new Map<number, number>();
  for (let r = 0; r < m; r++) rankOf.set(sorted[r], r);
  const ranks = new Int32Array(nW);
  for (let i = 0; i < nW; i++) ranks[i] = rankOf.get(w[i])!;

  // ---- 值域分块频次层（与 mode.ts 同款骨架；本分析不需要双峰位图）----
  const blockSize = Math.max(1, Math.round(Math.sqrt(m)));
  const numBlocks = Math.ceil(m / blockSize);
  const freq = new Int32Array(m);
  const globalLevel = new Int32Array(nW + 1);
  globalLevel[0] = m;
  let maxFreq = 0;
  const blockMax = new Int32Array(numBlocks);
  const blockLevels: Int32Array[] = new Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) {
    blockLevels[b] = new Int32Array(1);
    blockLevels[b][0] = Math.min(blockSize, m - b * blockSize);
  }

  function add(rank: number): void {
    const b = (rank / blockSize) | 0;
    const f = freq[rank];
    globalLevel[f]--;
    globalLevel[f + 1]++;
    if (f + 1 >= blockLevels[b].length) {
      const old = blockLevels[b];
      const grown = new Int32Array(old.length * 2);
      grown.set(old);
      blockLevels[b] = grown;
    }
    const lv = blockLevels[b];
    lv[f]--;
    lv[f + 1]++;
    freq[rank] = f + 1;
    if (f + 1 > blockMax[b]) blockMax[b] = f + 1;
    if (f + 1 > maxFreq) maxFreq = f + 1;
  }

  function remove(rank: number): void {
    const b = (rank / blockSize) | 0;
    const f = freq[rank];
    globalLevel[f]--;
    globalLevel[f - 1]++;
    const lv = blockLevels[b];
    lv[f]--;
    lv[f - 1]++;
    freq[rank] = f - 1;
    if (blockMax[b] === f && lv[f] === 0) blockMax[b] = f - 1;
    if (maxFreq === f && globalLevel[f] === 0) maxFreq = f - 1;
  }

  /**
   * 在值域 [valueLo, valueHi] 内找频次恰为 target 的最小 rank（可跳过一个
   * rank，用于排除 A 本身）；不存在返回 -1。块级两层剪枝（块内该层计数为 0
   * 直接跳过）保证 O(√m)，且与查询处理顺序无关。
   */
  function scanMinRankWithFreq(
    valueLo: number,
    valueHi: number,
    target: number,
    skipRank: number,
  ): number {
    if (valueLo > valueHi || target <= 0) return -1;
    const rankLo = lowerBound(sorted, valueLo);
    // valueHi 为 int32，+1 不会溢出 IEEE-754 精确整数范围
    const rankHi = lowerBound(sorted, valueHi + 1) - 1;
    if (rankLo > rankHi) return -1;
    const b0 = (rankLo / blockSize) | 0;
    const b1 = (rankHi / blockSize) | 0;
    for (let b = b0; b <= b1; b++) {
      const lv = blockLevels[b];
      if (target >= lv.length || lv[target] === 0) continue;
      const start = Math.max(rankLo, b * blockSize);
      const end = Math.min(rankHi, Math.min(m, (b + 1) * blockSize) - 1);
      for (let r = start; r <= end; r++) {
        if (r !== skipRank && freq[r] === target) return r;
      }
    }
    return -1;
  }

  // ---- 受影响查询按 Hilbert 顺序处理；answers 保持原顺序 ----
  // 坐标最大为 n-1（空区间 [s, s-1] 的左端点可达 n-1），与 mode.ts 一样取
  // 2^power > n-1 即可（n 为原数组长度）。
  const power = Math.max(1, Math.ceil(Math.log2(Math.max(n, 1))));
  const aq = affected.length;
  const order = new Float64Array(aq);
  for (let i = 0; i < aq; i++) {
    order[i] = hilbertOrder(affected[i].left, affected[i].right, power);
  }
  const perm: number[] = new Array(aq);
  for (let i = 0; i < aq; i++) perm[i] = i;
  perm.sort((a, b) => order[a] - order[b]);

  let curL = 0;
  let curR = -1;
  for (let k = 0; k < aq; k++) {
    const { qi, left, right } = affected[perm[k]];
    while (curL > left) add(ranks[--curL]);
    while (curR < right) add(ranks[++curR]);
    while (curL < left) remove(ranks[curL++]);
    while (curR > right) remove(ranks[curR--]);

    const O = originals[qi].value;
    const C = originals[qi].count;
    const M = maxFreq;

    let stable = true;
    let minReplacement: number | null = null;
    let changed: ModeResult | null = null;

    if (M === 0) {
      // 基准窗口为空（原查询恰为 [index, index]）：替换后窗口只有 {v}，
      // 众数恒为 v、频次 1；任何 v ≠ O 都是改变者。
      let vStar: number | null = null;
      if (lo !== O) vStar = lo;
      else if (lo + 1 <= hi) vStar = lo + 1;
      if (vStar !== null) {
        stable = false;
        minReplacement = vStar;
        changed = { value: vStar, count: 1 };
      }
    } else {
      // A = 基准窗口的众数（最小高频值）
      let chosenBlock = 0;
      while (blockMax[chosenBlock] !== M) chosenBlock++;
      const start = chosenBlock * blockSize;
      const end = Math.min(start + blockSize, m);
      let chosenRank = start;
      while (chosenRank < end && freq[chosenRank] !== M) chosenRank++;
      const A = sorted[chosenRank];
      // 不变量：cO ∈ {M-1, M}；且 values[index] !== O 时必有 A === O。
      const cO = C - (values[index] === O ? 1 : 0);

      // 注意：vStar 不能用 -1 之类的哨兵值——-1 本身就是合法的替换值。
      let vStar: number | null = null;
      let cStar = 0;
      if (A !== O) {
        // 此时必有 values[index] === O。新众数 ≠ O 当且仅当 v ≠ O（O 自身的
        // 新众数仍为 O：cO = M 时令 O 独占最高频；cO = M-1 时必有 O < A，
        // min(O, A) = O）。故最小改变者就是 lo（或 lo = O 时的 lo+1）。
        if (lo !== O) {
          vStar = lo;
        } else {
          const oStable = cO === M || O < A;
          if (!oStable) vStar = lo;
          else if (lo + 1 <= hi) vStar = lo + 1;
        }
        if (vStar !== null) {
          const r = rankOf.get(vStar);
          cStar = r === undefined ? 0 : freq[r];
        }
      } else {
        // A === O：改变者 = {窗口内 c(v)=M 且 v≠A} ∪ {c(v)=M-1 且 v<A}。
        // 前者恒 > A，后者恒 < A，故先取后者中的最小值，再取前者。
        if (M === 1 && lo < A) {
          // M=1 时 A 是窗口最小值，v < A 必不在窗口内（c(v)=0=M-1），
          // 新众数为 min(v, A) = v —— 未出现的新值也能成为众数。
          vStar = lo;
          cStar = 0;
        } else {
          if (M >= 2) {
            const r2 = scanMinRankWithFreq(lo, Math.min(hi, A - 1), M - 1, -1);
            if (r2 !== -1) {
              vStar = sorted[r2];
              cStar = M - 1;
            }
          }
          if (vStar === null) {
            const r1 = scanMinRankWithFreq(lo, hi, M, chosenRank);
            if (r1 !== -1) {
              vStar = sorted[r1];
              cStar = M;
            }
          }
        }
      }

      if (vStar !== null) {
        stable = false;
        minReplacement = vStar;
        if (cStar === M) changed = { value: vStar, count: M + 1 };
        else if (cStar === M - 1) changed = { value: Math.min(vStar, A), count: M };
        else changed = { value: A, count: M };
      }
    }

    answers[qi] = { original: originals[qi], affected: true, stable, minReplacement, changed };
  }
  return answers;
}
