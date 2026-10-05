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
 *
 * 一次性"单点更正稳健性"分析（{ index, minValue, maxValue }）：对每条查询
 * 判定其众数是否在闭区间 [minValue, maxValue] 内的"所有"替换值下保持不变。
 * 分析绑定与普通/双峰批次相同的一次莫队移动：含可疑下标的查询先在增量频次
 * 表上模拟"移除原值"，再以纯算术判定各候选替换值，绝不枚举整数值域（搜索
 * 只在 m 个压缩排名与相邻排名的"整数值缝隙"上进行，每查询 O(√m + log m)），
 * 也不把双峰结果当作稳健性证据（稳健性不依赖双峰位图）。
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

/** 一次性单点更正稳健性分析参数：把 values[index] 替换为 [minValue,maxValue] 闭区间内的任一整数。 */
export interface RobustParams {
  /** 可疑读数在原数组中的下标，0 <= index < values.length。 */
  index: number;
  /** 替换值闭区间下界（有符号 32 位整数）。 */
  minValue: number;
  /** 替换值闭区间上界（有符号 32 位整数，minValue <= maxValue）。 */
  maxValue: number;
}

/** 使众数发生变化的最小替换值及该值下的新众数与频次。 */
export interface RobustChange {
  /** 范围内使众数改变的最小替换值（有符号 32 位整数）。 */
  replacementValue: number;
  /** 以 replacementValue 替换后的新区间众数（频次优先、数值较小优先）。 */
  mode: ModeResult;
}

/**
 * 单条查询的单点更正稳健性结果。
 *
 * 区间不含可疑下标时 affected=false，原众数原样返回，invariant=true。
 * 含可疑下标时：原众数为"先移除原值"之前的区间众数；invariant 表示范围内
 * 是否对所有替换值都保持该众数不变（仅数值不变，频次允许变化）；为 false 时
 * firstChange 给出使众数变化的最小替换值及该值下的新众数、频次。
 */
export interface RobustResult {
  /** 原区间（未做任何替换）众数及频次。 */
  originalMode: ModeResult;
  /** 该查询的闭区间是否包含可疑下标。 */
  affected: boolean;
  /** 为 true 时范围内所有替换值下众数（数值）都与 originalMode 相同。 */
  invariant: boolean;
  /** invariant=false 时存在，给出最小变更替换值与该值下的新众数。 */
  firstChange: RobustChange | null;
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
 * 计算全部查询的区间众数（可选双峰复核 / 单点更正稳健性）。
 *
 * 三种模式由 options 决定，互斥；普通模式与旧契约完全一致：
 *   - 默认：ModeResult[]
 *   - { bimodal: true }：BimodalResult[]
 *   - { robust: RobustParams }：RobustResult[]
 *
 * @param values 长度 n（1..200000）的有符号 32 位整数序列
 * @param queries 长度 q（1..200000）的闭区间查询，0 <= left <= right < n
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
  options: { robust: RobustParams },
): RobustResult[];
export function rangeModes(
  values: Int32Array,
  queries: ReadonlyArray<{ left: number; right: number }>,
  options?: RangeModeOptions | { robust: RobustParams },
): ModeResult[] | BimodalResult[] | RobustResult[] {
  const n = values.length;
  const q = queries.length;
  if (n === 0 || q === 0) return [];
  const robust = options && 'robust' in options ? options.robust : null;
  const bimodal = !robust && (options as RangeModeOptions | undefined)?.bimodal === true;

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

  /** 当前窗口（频次表已处于该窗口）的众数排名：最小的 maxFreq 层排名。 */
  function modeRankAtCurrentWindow(): number {
    let chosenBlock = 0;
    while (blockMax[chosenBlock] !== maxFreq) chosenBlock++;
    const start = chosenBlock * blockSize;
    const end = Math.min(start + blockSize, m);
    let chosenRank = start;
    while (chosenRank < end && freq[chosenRank] !== maxFreq) chosenRank++;
    return chosenRank;
  }

  // ---- 单点更正稳健性专用：模拟"移除原值"窗口上的候选搜索 ----

  /**
   * 坐标压缩"连续整数值段"静态预处理：chainEnd[r] 给出从排名 r 起、沿
   * sorted 逐个 +1 连续的最后一个排名（sorted[chainEnd[r]] === sorted[r]+len-1）。
   * 段内若所有排名在当前窗口频次都 >0，则它们覆盖了一整段连续整数；
   * 首个频次为 0 的排名前一个值 +1（= 该 0 频排名自身的值）就是缺口答案。
   * 该信息只取决于压缩后的值域，与莫队窗口无关，计算一次。
   */
  const chainEnd = new Int32Array(m);
  chainEnd[m - 1] = m - 1;
  for (let r = m - 2; r >= 0; r--) {
    chainEnd[r] = sorted[r + 1] === sorted[r] + 1 ? chainEnd[r + 1] : r;
  }

  /** 在升序 sorted[0..m-1] 中找首个 >= value 的排名；全部 < value 时返回 m。 */
  function lowerBoundRank(value: number): number {
    let lo = 0;
    let hi = m;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < value) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * 在"已模拟移除原值"的当前窗口频次表上，于 rank 区间 [rLo,rHi] 中升序找
   * 首个频次"恰为" target 的排名（skipRanks 中的排名强制跳过）。内部完整块
   * 用块频次层计数 lv[target]===0 整块剪枝，两端截块线性扫描。单次 O(√m)。
   */
  function findRankExactFreq(
    rLo: number,
    rHi: number,
    target: number,
    ...skipRanks: number[]
  ): number {
    if (rLo > rHi || target < 0) return -1;
    const bLo = (rLo / blockSize) | 0;
    const bHi = (rHi / blockSize) | 0;
    for (let b = bLo; b <= bHi; b++) {
      const blkStart = b * blockSize;
      const blkEnd = Math.min(blkStart + blockSize, m);
      const segStart = Math.max(blkStart, rLo);
      const segEnd = Math.min(blkEnd, rHi + 1);
      const full = segStart === blkStart && segEnd === blkEnd;
      if (full) {
        const lv = blockLevels[b];
        if (target >= lv.length || lv[target] === 0) continue;
        // 完整块内命中者可能恰好全是被跳过的排名：块级剪枝只说明该层非空，
        // 跳过与否在下面线性扫描中统一裁决，命中数至多 √m，不影响复杂度。
      }
      for (let r = segStart; r < segEnd; r++) {
        if (freq[r] === target && !skipRanks.includes(r)) return r;
      }
    }
    return -1;
  }

  /**
   * 在 rank 区间 [rLo,rHi] 中升序找首个频次为 0 的排名（skipRank 视为非 0，
   * 因为它是被模拟移除的原值；真实"替换为另一个值"时原值不会作为新读数加入）。
   * 借助 chainEnd 与块频次层：当前连续整数段完整覆盖某个值块、且该块内没有
   * 频次 0 的排名（lv[0]===0；唯一 0 频是 skipRank 也算无可用缺口）时整块跳过。
   * 单次 O(√m)：无缺口时每块 O(1) 判跳；有缺口时在所在块内 O(√m) 命中。
   */
  function firstZeroFreqRank(rLo: number, rHi: number, skipRank: number): number {
    if (rLo > rHi) return -1;
    let r = rLo;
    while (r <= rHi) {
      const b = (r / blockSize) | 0;
      const blkStart = b * blockSize;
      const blkEnd = Math.min(blkStart + blockSize, m);
      const segEnd = Math.min(chainEnd[r], rHi, blkEnd - 1);
      if (r === blkStart && segEnd === blkEnd - 1) {
        const lv = blockLevels[b];
        const skipInBlock = skipRank >= blkStart && skipRank < blkEnd && freq[skipRank] === 0;
        if (lv[0] === 0 || (lv[0] === 1 && skipInBlock)) {
          r = blkEnd;
          continue;
        }
      }
      if (r !== skipRank && freq[r] === 0) return r;
      r++;
    }
    return -1;
  }

  /**
   * 在值闭区间 [lo,hi] 内找最小的、在"已移除原值"窗口中频次为 0 的整数 x，
   * 且 x <= bound（bound < lo 时返回 null）。skipRank 视为频次非 0。
   *
   * 不枚举整数值域，沿坐标压缩的连续整数段推进：
   *   1. lo 不与任何压缩值重合（落在缝隙/值域外侧）时，窗口中必然没有 lo，
   *      lo 即为答案；
   *   2. 否则沿 lo 所在连续段找第一个 0 频排名，其压缩值就是缺口（段内前驱
   *      都出现，故该值未出现）；
   *   3. 整段都在窗口中时，段末值 +1 是下一个候选（必为缝隙整数），继续。
   * 单次 O(log m + √m)。
   */
  function smallestAbsentInteger(
    lo: number,
    hi: number,
    bound: number,
    skipRank: number,
  ): number | null {
    const upper = Math.min(hi, bound);
    if (upper < lo) return null;
    // upper+1 可能等于 2^31，不能直接加；用两级判定求 <= upper 的末个排名。
    const rankUpper =
      upper >= 2147483647 ? m - 1 : lowerBoundRank(upper + 1) - 1;
    const r0 = lowerBoundRank(lo);
    if (r0 > rankUpper || sorted[r0] !== lo) {
      // lo 落在压缩值缝隙或值域外侧：它在任何窗口中都不存在。
      return lo;
    }
    let r = r0;
    while (r <= rankUpper) {
      const end = Math.min(chainEnd[r], rankUpper);
      const z = firstZeroFreqRank(r, end, skipRank);
      if (z >= 0) return sorted[z];
      // [r..end] 全部出现。若连续段被 upper 截断，则 upper === sorted[end]，
      // 其后没有更大的合规整数；否则段末 +1 是缝隙，必然未出现。
      if (end < chainEnd[r] || sorted[end] >= 2147483647) return null;
      const gap = sorted[end] + 1;
      if (gap > upper) return null;
      r = end + 1;
      // end 是其连续段末位 ⇒ sorted[end+1]（若存在）与 gap 不连续；
      // gap 本身不在压缩值域内，窗口频次恒为 0，直接返回。
      return gap;
    }
    return null;
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

  const answers = new Array<ModeResult | BimodalResult | RobustResult>(q);
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
    const chosenRank = modeRankAtCurrentWindow();
    const first: ModeResult = { value: sorted[chosenRank], count: maxFreq };

    if (robust) {
      answers[qi] = answerRobust(left, right, chosenRank, first);
      continue;
    }
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
  // ------------------------------------------------------------------
  // 单点更正稳健性：在当前莫队窗口已就位为 [left,right] 时回答查询 qi。
  //
  // 设原窗口 W 众数为 M（频次 c）。含可疑下标 p 时先在增量频次表上模拟
  // "移除原值 o" 得到 W'（g(v) 为 W' 中频次；回答完必须把 o 加回）：
  //
  // A. W' 为空（原窗口只有可疑位一个元素）：替换为 x 后众数恒为 x（频次 1）。
  //
  // B. W' 非空，记其众数 R、频次 T（由当前 maxFreq 给出）。把替换值 x
  //    加入 W'，新读数频次为 g(x)+1，与众数层按"频次优先、数值较小优先"
  //    当场裁决。分叉只取决于被移除的 o 是否就是 M：
  //      · o ≠ M（无论 o 是否与 M 同票）：M 的票原封不动，g(M)=c；o 曾
  //        与 M 同票时移除后 M 成为 c 票层唯一者（T=c、R=M）；
  //      · o = M：M 少一票 g(M)=c-1。
  //    B1（o ≠ M，R=M，g(M)=c=T）：x=o 恢复、x=M 再加票，均不变；其它 x
  //        经三条通道改变众数：
  //          · 原与 M 同票且 v>M 的其它读数（移除 o 后仍有 c 票）：加入后
  //            c+1 严格胜出，v 大小不限；
  //          · g(v)=c-1 且 v<M：加入后 c 票并列、更小者胜；
  //          · 未出现整数（g=0）：仅 c=1 时加入后 1 票并列，还需 x<M。
  //    B2（o = M 且 R = M，T=c-1）：x=M 恢复；其它 x 改变众数当且仅当
  //        加入后严格压过或同频次小于 M：
  //          · g(x)=T：加入后 T+1 严格胜出，x 大小不限；
  //          · g(x)=T-1 且 x<M：加入后 T 票并列、更小者胜；
  //          · 未出现整数 g=0：仅 T=1 时加入后 1 票并列，需 x<M。
  //    B3（o = M 且 R ≠ M）：M 已跌出众数层，只有 x=M 恢复；任何 x≠M
  //        的新众数都是 x 与 R 的当场裁决，最小变更值即 [lo,hi] 内 ≠M
  //        的最小整数（算术可得）。
  //
  // "双峰"不参与以上判定：稳健性只裁决唯一众数（频次优先、数值较小优先），
  // 频次层并列结构本身不是众数改变的证据。所有搜索只走 m 个压缩排名与
  // 相邻排名间的整数缝隙，每查询 O(√m)，绝不枚举 [lo,hi] 整数值域。
  // ------------------------------------------------------------------
  function answerRobust(
    left: number,
    right: number,
    modeRank: number,
    original: ModeResult,
  ): RobustResult {
    const { index, minValue: lo, maxValue: hi } = robust!;
    if (index < left || index > right) {
      // 区间不含可疑下标：替换完全不触及该窗口，直接沿用原众数。
      return { originalMode: original, affected: false, invariant: true, firstChange: null };
    }

    const oldRank = ranks[index];
    const mValue = sorted[modeRank];

    // 模拟移除可疑原值（回答后必须加回，使莫队窗口恢复 [left,right]）。
    remove(oldRank);

    let change: RobustChange | null = null;

    if (left === right) {
      // 情形 A：移除后窗口为空。最小变更值为 [lo,hi] 内 ≠M 的最小整数。
      const x = smallestIntExcept(lo, hi, mValue);
      if (x !== null) change = { replacementValue: x, mode: { value: x, count: 1 } };
    } else {
      // 情形 B：W' 非空，取其众数 R、频次 T（maxFreq 已随 remove 回降）。
      const rRank = modeRankAtCurrentWindow();
      const rValue = sorted[rRank];
      const tFreq = maxFreq;
      const rLo = lowerBoundRank(lo);
      const rHiAll = hi >= 2147483647 ? m - 1 : lowerBoundRank(hi + 1) - 1;
      // 值严格小于 M 的排名上界（modeRank 即 M 的排名，更小排名都在其左侧）。
      const rHiBelowM = Math.min(rHiAll, modeRank - 1);

      // 在候选 (值, 加入后频次) 中取数值最小者。
      let bestX: number | null = null;
      let bestCount = 0;
      const offer = (x: number | null, countAfter: number): void => {
        if (x !== null && (bestX === null || x < bestX)) {
          bestX = x;
          bestCount = countAfter;
        }
      };

      if (rValue !== mValue) {
        // ---- B3：R≠M（只在 o===M 时发生）。[lo,hi] 内最小的 ≠M 整数 ----
        // 必改变众数；新众数由 x（加入后频次）与 R（T 票）当场裁决。
        const x = smallestIntExcept(lo, hi, mValue);
        if (x !== null) {
          const xRank = lowerBoundRank(x);
          const xPresent = xRank < m && sorted[xRank] === x;
          const xf = xPresent ? freq[xRank] + 1 : 1;
          const newValue = xf > tFreq || (xf === tFreq && x < rValue) ? x : rValue;
          change = { replacementValue: x, mode: { value: newValue, count: Math.max(xf, tFreq) } };
        }
      } else if (oldRank !== modeRank) {
        // ---- B1：移除的不是 M。M 的票原封不动（g(M)=c=T，R=M）：若 o 曾
        // 与 M 同票，移除后 M 成为该层唯一者。x=o 恢复、x=M 再加票，均不变；
        // 其余 x 分两条严格/并列通道。----
        // (1) 原窗口中与 M 同票、但比 M 大的其它读数 v（o 移除后仍有 c 票）：
        // 加入后 c+1 严格胜出，x 大小不限（跳过 M；o 此时已降到 c-1）。
        const strict = findRankExactFreq(rLo, rHiAll, tFreq, modeRank);
        if (strict >= 0) offer(sorted[strict], tFreq + 1);
        // (2) g=c-1（=T-1）、值 < M 的现有排名：加入后 c 票并列、更小者胜。
        const hit = findRankExactFreq(rLo, rHiBelowM, tFreq - 1, oldRank, modeRank);
        if (hit >= 0) offer(sorted[hit], tFreq);
        // (3) 未出现整数通道：c=1 时加入后 1 票与 M 并列（仍需 x<M）。
        if (original.count === 1) {
          offer(smallestAbsentInteger(lo, hi, mValue - 1, oldRank), 1);
        }
      } else {
        // ---- B2：移除的就是 M（g(M)=c-1=T，R=M）。----
        // (1) g(x)=T 的现有排名（跳过 M 自身）：加入后 T+1 严格胜，x 大小不限。
        const strict = findRankExactFreq(rLo, rHiAll, tFreq, modeRank);
        if (strict >= 0) offer(sorted[strict], tFreq + 1);
        // (2) g(x)=T-1 且 x<M 的现有排名：加入后 T 票并列、更小者胜。
        if (tFreq - 1 >= 1) {
          const tied = findRankExactFreq(rLo, rHiBelowM, tFreq - 1, modeRank);
          if (tied >= 0) offer(sorted[tied], tFreq);
        }
        // (3) 未出现整数：T=1 时加入后 1 票并列，需 x<M。
        if (tFreq === 1) {
          offer(smallestAbsentInteger(lo, hi, mValue - 1, oldRank), 1);
        }
      }

      if (bestX !== null) {
        change = { replacementValue: bestX, mode: { value: bestX, count: bestCount } };
      }
    }

    // 恢复莫队窗口：把模拟移除的原值加回。
    add(oldRank);

    return {
      originalMode: original,
      affected: true,
      invariant: change === null,
      firstChange: change,
    };
  }

  return answers as ModeResult[] | BimodalResult[] | RobustResult[];
}

/**
 * 闭区间 [lo, hi] 内不等于 except 的最小有符号 32 位整数；不存在时返回 null。
 * 直接算术判定，不枚举值域；小心 INT32_MAX + 1 溢出。
 */
function smallestIntExcept(lo: number, hi: number, except: number): number | null {
  if (lo > hi) return null;
  if (lo !== except) return lo;
  if (lo >= 2147483647) return null;
  const next = lo + 1;
  return next <= hi ? next : null;
}

/** 将升序数组就地去重，返回去重后长度。 */
function deduplicateInPlace(arr: number[]): number {
  let w = 0;
  for (let r = 1; r < arr.length; r++) {
    if (arr[r] !== arr[w]) arr[++w] = arr[r];
  }
  return w + 1;
}
