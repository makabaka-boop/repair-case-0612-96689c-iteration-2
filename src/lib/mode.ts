/**
 * 离线区间众数（闭区间）
 *
 * 给定有符号 32 位整数序列 values 与若干查询 [left, right]，按查询原顺序返回
 * 每个闭区间内出现频次最高的数值；频次并列时取较小数值。
 *
 * 算法：Mo's algorithm（按 Hilbert 曲线顺序处理查询）保证总指针移动 O(n√q)，
 * 值域做 √m 分块；块内按"频次层"计数（level counts）。加入/删除一个排名
 * 为 O(1) 摊还；回答查询时只需：
 *   1. 取全局最大频次 maxFreq（O(1) 摊还）；
 *   2. 从 rank 最小的块开始找到块最大频次等于 maxFreq 的块（O(√m)）；
 *   3. 在该块内按 rank 升序找到首个频次等于 maxFreq 的排名（O(√m)）。
 * 总时间复杂度 O((n + q)√n)，空间复杂度 O(n + q)。
 *
 * 可选"双峰复核"（options.bimodal = true）：在同一次莫队移动维护的频次表上
 * 额外回答频次第二名的不同读数。为支持 O(1) 维护"次大非空频次层"，在频次轴
 * 上维护两级位图：32 个一层的占用位 + 汇总字，某频次层在 0↔非空 间翻转时
 * O(1) 更新；取次大频次为位扫描（汇总字数约 n/1024）。第二名的排名仍走值
 * 域 √m 分块升序扫描，与第一名并列时跳过第一名本身。每个区间的两项结果由
 * 同一张随区间移动增量维护的频次表产生，绝不为单个区间重建计数。
 */

/** 单个读数及其出现频次（众数 / 双峰复核的每一项）。 */
export interface ModeResult {
  value: number;
  count: number;
}

/** 双峰复核结果：first 与未启用双峰时的众数逐项一致；second 为频次第二高的不同读数。 */
export interface BimodalResult {
  first: ModeResult;
  /** 窗口内只有一种读数（或没有任何次高读数）时为 null。 */
  second: ModeResult | null;
}

/** rangeModes 可选项：bimodal 启用双峰复核。 */
export interface RangeModeOptions {
  bimodal?: boolean;
}

/** Hilbert 曲线序号（power >= 1，序号范围 [0, 2^(2power))）。 */
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

// ---- 双峰复核：频次轴两级位图（仅在 bimodal 时分配）----

/**
 * 频次轴占用位图：32 个非空频次层组成一个 32 位字，再用一个汇总字 OR 32 个
 * 底层字的"非空"状态。层 f（f >= 1）非空 ⇔ 恰好有频次为 f 的不同读数。
 * 层 0 不纳入位图（移出窗口的空排名不参与复核）。
 */
interface FrequencyBits {
  /** 底层字：位 (f & 31) 表示频次层 (w << 5) + bit 是否非空。 */
  words: Uint32Array;
  /** 汇总字：位 w 表示底层字 words[w] 是否非零。 */
  summary: Uint32Array;
}

function createFrequencyBits(n: number): FrequencyBits {
  const numWords = (n >> 5) + 1;
  const numSummary = (numWords >> 5) + 1;
  return { words: new Uint32Array(numWords), summary: new Uint32Array(numSummary) };
}

/** 标记频次层 f 的占用状态翻转（仅在计数 0→1 / 1→0 时调用，f=0 忽略）。 */
function setFrequencyLevel(bits: FrequencyBits, f: number, on: boolean): void {
  if (f <= 0) return;
  const w = f >> 5;
  // 注意：bit=31 时 1<<31 是负数，~ 后变正数；Uint32Array 按无符号解释，
  // 必须用 >>> 0 把掩码强制回无符号 32 位，否则 words[w] & 0x7fffffff
  // 会错误清掉高位。
  const mask = (1 << (f & 31)) >>> 0;
  const summaryIndex = w >> 5;
  const summaryMask = (1 << (w & 31)) >>> 0;
  // 汇总位完全以"写完后底层字是否为 0"为准（读新值而非旧值）：同 word 内
  // 相邻频次层在一次 add/remove 中连续翻转时，任何更新顺序都不会让汇总位
  // 与底层字的非空状态脱节。
  if (on) {
    bits.words[w] = (bits.words[w] | mask) >>> 0;
    bits.summary[summaryIndex] = (bits.summary[summaryIndex] | summaryMask) >>> 0;
  } else {
    bits.words[w] = (bits.words[w] & ~mask) >>> 0;
    if (bits.words[w] === 0) {
      bits.summary[summaryIndex] = (bits.summary[summaryIndex] & ~summaryMask) >>> 0;
    }
  }
}

/**
 * 返回严格小于 topFreq 的最大非空频次层；不存在（窗口内仅一种读数）时返回 0。
 * 位扫描顺序只取决于当前窗口的频次分布，与查询处理顺序无关。
 */
function secondFrequency(bits: FrequencyBits, topFreq: number): number {
  const top = topFreq - 1;
  if (top < 1) return 0;

  // top 所在的底层字：只看 ≤ top 的位
  const w0 = top >> 5;
  const bit = top & 31;
  const mask = bit === 31 ? 0xffffffff : ((1 << (bit + 1)) >>> 0) - 1;
  let x = bits.words[w0] & mask;
  if (x !== 0) return (w0 << 5) + (31 - Math.clz32(x));

  // 向下扫汇总字：置位的汇总位直接给出一个非空底层字。注意 w0 所在汇总字里
  // 必须先把 ≥ w0 的底层字位屏蔽掉——否则会把"高于或等于 w0"的非空字（例如
  // 第一名所在的更高频次层）误当成次高层。
  for (let s = w0 >> 5; s >= 0; s--) {
    let sw = bits.summary[s];
    if (s === (w0 >> 5)) {
      const wordBitInSummary = w0 & 31;
      const keep = wordBitInSummary === 0 ? 0 : (1 << wordBitInSummary) - 1;
      sw = (sw & keep) >>> 0;
    }
    if (sw !== 0) {
      const w = (s << 5) + (31 - Math.clz32(sw));
      const xw = bits.words[w];
      return (w << 5) + (31 - Math.clz32(xw));
    }
  }
  return 0;
}

/**
 * 计算全部查询的区间众数（可选双峰复核）。
 *
 * @param values 长度 n（1..200000）的有符号 32 位整数序列
 * @param queries 长度 q（1..200000）的闭区间查询，0 <= left <= right < n
 * @param options.bimodal 为 true 时返回 {@link BimodalResult}：第一名与普通众数
 *   逐项一致，第二名为按频次降序、读数升序的下一个不同读数
 * @returns 按 queries 原顺序排列的结果
 */
export function rangeModes(
  values: Int32Array,
  queries: ReadonlyArray<{ left: number; right: number }>,
): ModeResult[];
export function rangeModes(
  values: Int32Array,
  queries: ReadonlyArray<{ left: number; right: number }>,
  options: { bimodal: true },
): BimodalResult[];
export function rangeModes(
  values: Int32Array,
  queries: ReadonlyArray<{ left: number; right: number }>,
  options?: RangeModeOptions,
): ModeResult[] | BimodalResult[] {
  const n = values.length;
  const q = queries.length;
  if (n === 0 || q === 0) return [];
  const bimodal = options?.bimodal === true;

  // ---- 坐标压缩：有符号整数按数值升序映射到 rank（并列时 rank 小即数值小）----
  const sorted = Array.from(values).sort((a, b) => a - b);
  const m = deduplicateInPlace(sorted);
  const rankOf = new Map<number, number>();
  for (let r = 0; r < m; r++) rankOf.set(sorted[r], r);
  const ranks = new Int32Array(n);
  for (let i = 0; i < n; i++) ranks[i] = rankOf.get(values[i])!;

  // ---- 值域分块：块大小取 √m，块数约 √m（回答时两次线性扫描均为 O(√m)）----
  const blockSize = Math.max(1, Math.round(Math.sqrt(m)));
  const numBlocks = Math.ceil(m / blockSize);

  // 全局频次
  const freq = new Int32Array(m);
  // 全局频次层计数：globalLevel[f] = 频次恰为 f 的不同数值个数
  const globalLevel = new Int32Array(n + 1);
  globalLevel[0] = m;
  let maxFreq = 0;

  // 双峰复核专用：频次轴占用位图（初始所有排名都在层 0，位图为空）
  const freqBits = bimodal ? createFrequencyBits(n) : null;

  // 每个值块的最大频次
  const blockMax = new Int32Array(numBlocks);
  // 每个值块各频次层的排名数：懒增长（倍增），容量按各块内排名总出现次数封顶
  const blockLevels: Int32Array[] = new Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) {
    blockLevels[b] = new Int32Array(1);
    blockLevels[b][0] = Math.min(blockSize, m - b * blockSize);
  }

  function add(rank: number): void {
    const b = (rank / blockSize) | 0;
    const f = freq[rank];
    const wasLevelEmpty = globalLevel[f + 1] === 0;
    globalLevel[f]--;
    globalLevel[f + 1]++;
    if (freqBits) {
      // 必须先置新层、后清旧层：置位分支依据"写前 word 是否为 0"决定是否补
      // 汇总位。若先清旧层，同 word 内旧层恰好是最后一个占用位时 word 会瞬时
      // 归零，紧接着置新层会让汇总位被错误补回（旧层已空、word 实际仍为 0），
      // 残留一个永不清掉的幽灵频次层。
      if (wasLevelEmpty) setFrequencyLevel(freqBits, f + 1, true);
      if (f > 0 && globalLevel[f] === 0) setFrequencyLevel(freqBits, f, false);
    }
    // 频次层数组容量不足时先倍增（必须在写入新计数之前完成，否则旧数组上的
    // f 层递减会被 grown.set 覆盖回去）
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
    // 翻转判定必须在 globalLevel 自增/自减之前取值：层 f 是否由 1 变 0 取决于
    // 更新"前"的计数；层 f-1 是否由 0 变非空同理。更新之后再判断会永远看到
    // 0 / 非 0 的新状态，导致该清的频次层位清不掉（出现残留的第二名）。
    const oldLevelBecomesEmpty = f > 0 && globalLevel[f] === 1;
    const lowerLevelBecomesOccupied = f - 1 > 0 && globalLevel[f - 1] === 0;
    globalLevel[f]--;
    globalLevel[f - 1]++;
    if (freqBits) {
      if (oldLevelBecomesEmpty) setFrequencyLevel(freqBits, f, false);
      if (lowerLevelBecomesOccupied) setFrequencyLevel(freqBits, f - 1, true);
    }
    const lv = blockLevels[b];
    lv[f]--;
    lv[f - 1]++;
    freq[rank] = f - 1;
    if (blockMax[b] === f && lv[f] === 0) blockMax[b] = f - 1;
    if (maxFreq === f && globalLevel[f] === 0) maxFreq = f - 1;
  }

  /**
   * 升序找首个频次恰为 target 的排名；excludeRank 用于第一名与第二名频次相同
   * 时跳过第一名本身。块级两层剪枝（块最大频次、块内该层计数）保证总扫描
   * O(√m)，与查询处理顺序无关，结果对频次并列稳定。
   */
  function findRankAtFrequency(target: number, excludeRank: number): number {
    for (let b = 0; b < numBlocks; b++) {
      if (blockMax[b] < target) continue;
      const lv = blockLevels[b];
      if (target >= lv.length || lv[target] === 0) continue;
      const start = b * blockSize;
      const end = Math.min(start + blockSize, m);
      for (let r = start; r < end; r++) {
        if (r !== excludeRank && freq[r] === target) return r;
      }
    }
    return -1;
  }

  // ---- 查询按 Hilbert 顺序排列；answer 数组保持原顺序 ----
  const power = Math.max(1, Math.ceil(Math.log2(Math.max(n, 1))));
  // Hilbert 序号最大可达 4^power - 1：n 上限 200000 时 power=18、序号可达
  // 2^36-1，超出 32 位无符号整数范围。必须用 Float64Array 存放（此范围内的
  // 整数均可被 IEEE-754 双精度精确表示）；若截断到 32 位，排序键的空间局部性
  // 会被彻底打乱，莫队指针将在相距很远的区间间频繁跳转。
  const order = new Float64Array(q);
  for (let i = 0; i < q; i++) {
    order[i] = hilbertOrder(queries[i].left, queries[i].right, power);
  }
  const perm: number[] = new Array(q);
  for (let i = 0; i < q; i++) perm[i] = i;
  perm.sort((a, b) => order[a] - order[b]);

  const answers = new Array<ModeResult | BimodalResult>(q);
  let curL = 0;
  let curR = -1;
  for (let k = 0; k < q; k++) {
    const qi = perm[k];
    const left = queries[qi].left;
    const right = queries[qi].right;
    while (curL > left) add(ranks[--curL]);
    while (curR < right) add(ranks[++curR]);
    while (curL < left) remove(ranks[curL++]);
    while (curR > right) remove(ranks[curR--]);

    // 找到含 maxFreq 层的最左值块
    let chosenBlock = 0;
    while (blockMax[chosenBlock] !== maxFreq) chosenBlock++;

    // 块内升序找首个频次为 maxFreq 的排名（块最大频次保证其一定存在）
    const start = chosenBlock * blockSize;
    const end = Math.min(start + blockSize, m);
    let chosenRank = start;
    while (chosenRank < end && freq[chosenRank] !== maxFreq) chosenRank++;

    const first: ModeResult = { value: sorted[chosenRank], count: maxFreq };
    if (!bimodal) {
      answers[qi] = first;
      continue;
    }

    // 双峰复核第二名：与第一名同频次（globalLevel[maxFreq] >= 2）时取该层
    // 下一个最小读数；否则取严格次高的非空频次层。两种情形都落空意味着窗口内
    // 只有一种读数，second 为 null。
    let second: ModeResult | null = null;
    const tiedAtTop = globalLevel[maxFreq] >= 2;
    const f2 = tiedAtTop ? maxFreq : secondFrequency(freqBits!, maxFreq);
    if (f2 > 0) {
      const r2 = findRankAtFrequency(f2, f2 === maxFreq ? chosenRank : -1);
      second = { value: sorted[r2], count: f2 };
    }
    answers[qi] = { first, second };
  }
  return answers as ModeResult[] | BimodalResult[];
}

/** 将升序数组就地去重，返回去重后长度。 */
function deduplicateInPlace(arr: number[]): number {
  let w = 0;
  for (let r = 1; r < arr.length; r++) {
    if (arr[r] !== arr[w]) arr[++w] = arr[r];
  }
  return w + 1;
}
