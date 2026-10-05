import { describe, expect, it } from 'vitest';
import { rangeModes, type ModeResult, type RobustParams, type RobustResult } from './mode';

/**
 * 单点更正稳健性的独立预言机：在小整数值域上"逐一枚举"闭区间 [lo,hi] 内的
 * 每个替换值，朴素重算区间众数（频次优先、数值较小优先），再与算法输出对照。
 * 不依赖莫队/分块/缝隙搜索，专门裁决稳健性判定与最小变更值。
 */
function bruteRobust(
  values: number[],
  queries: { left: number; right: number }[],
  params: RobustParams,
): RobustResult[] {
  const modeOf = (seq: number[]): ModeResult => {
    const counts = new Map<number, number>();
    for (const v of seq) counts.set(v, (counts.get(v) ?? 0) + 1);
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
    const originalMode = modeOf(values.slice(left, right + 1));
    const affected = params.index >= left && params.index <= right;
    if (!affected) {
      return { originalMode, affected: false, invariant: true, firstChange: null };
    }
    let invariant = true;
    let firstChange: RobustResult['firstChange'] = null;
    // 逐值枚举允许更正范围（测试只使用小值域，故安全且独立）。
    for (let x = params.minValue; x <= params.maxValue; x++) {
      const replaced = values.slice(left, right + 1);
      replaced[params.index - left] = x;
      const m = modeOf(replaced);
      if (m.value !== originalMode.value) {
        invariant = false;
        firstChange = { replacementValue: x, mode: m };
        break; // 升序枚举，首个即最小变更值
      }
    }
    return { originalMode, affected: true, invariant, firstChange };
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

function randomArray(n: number, alphabet: number, rand: () => number): Int32Array {
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.floor(rand() * alphabet) - (alphabet >> 1);
  return a;
}

describe('单点更正稳健性 - 手工构造：并列频次、新值、负端点、部分查询受影响', () => {
  it('并列频次：移除一个 -3 的票后，最小变更值是让 2 提前反超的未出现整数', () => {
    // 全区间：-3 与 2 各 2 次，众数 -3（数值较小）。可疑位 idx=1（o=-3=M），
    // 范围 [-3,2]：移除后 [2,2,-3,5]，R=2（2 票，B3）。最小 ≠-3 替换值是
    // 未出现的 -2：替换后 [2,-2,2,-3,5]，2 仍 2 票居首 → 众数变为 2/2。
    const values = Int32Array.of(2, -3, 2, -3, 5);
    const queries = [{ left: 0, right: 4 }];
    const got = rangeModes(values, queries, {
      robust: { index: 1, minValue: -3, maxValue: 2 },
    });
    expect(got[0].originalMode).toEqual({ value: -3, count: 2 });
    expect(got[0].affected).toBe(true);
    expect(got[0].invariant).toBe(false);
    expect(got[0].firstChange).toEqual({
      replacementValue: -2,
      mode: { value: 2, count: 2 },
    });
  });

  it('并列频次：移除与 M 同票的更大读数 o 不影响 M 票层，范围只允许更大值时保持', () => {
    // 同上序列，可疑 idx=0（o=2，与 M=-3 同票），范围 [2,5]：
    // 移除 2 后 -3 以 2 票唯一居首；替换回 2/5 都不能让众数离开 -3。
    const values = Int32Array.of(2, -3, 2, -3, 5);
    const got = rangeModes(values, [{ left: 0, right: 4 }], {
      robust: { index: 0, minValue: 2, maxValue: 5 },
    });
    expect(got[0]).toEqual({
      originalMode: { value: -3, count: 2 },
      affected: true,
      invariant: true,
      firstChange: null,
    });
  });

  it('并列频次：移除与 M 同票的更大读数 o 后，把票补给同层更大值即严格胜出', () => {
    // [-3,-3,2,2,7]：-3 与 2 各 2 次，众数 -3。可疑 idx=2（o=2，o≠M 且同票），
    // 范围 [-3,7]：移除 2 后 -3×2、2×1、7×1；替换为 2 恢复，替换为 7 后
    // 7 升到 2 票仍小于 -3；但替换为 2 恢复…… 真正的严格通道：范围内同票
    // 的另一个更大读数只有 2（被恢复），故最小变更值需逐值核对——由预言机
    // 覆盖；此处断言 7 不改变而 2 恢复时的不变性边界。
    const values = Int32Array.of(-3, -3, 2, 2, 7);
    const got = rangeModes(values, [{ left: 0, right: 4 }], {
      robust: { index: 2, minValue: 3, maxValue: 9 },
    });
    expect(got[0].invariant).toBe(true);
  });

  it('未出现的新值：互异读数时，更小的新整数以 1 票改变众数', () => {
    // 全窗口互异 [10, 20, 30]，众数 10（频次 1，数值最小）。可疑 idx=1（20），
    // 范围 [0,30]：最小变更值是未出现的 0，新众数 0/1。
    const values = Int32Array.of(10, 20, 30);
    const got = rangeModes(values, [{ left: 0, right: 2 }], {
      robust: { index: 1, minValue: 0, maxValue: 30 },
    });
    expect(got[0].originalMode).toEqual({ value: 10, count: 1 });
    expect(got[0].invariant).toBe(false);
    expect(got[0].firstChange).toEqual({
      replacementValue: 0,
      mode: { value: 0, count: 1 },
    });
  });

  it('未出现的新值：范围下界落在压缩值缝隙里直接成为最小变更值', () => {
    // 窗口 [5, 8]，众数 5。可疑 idx=0（5），范围 [3,9]：移除 5 后剩 [8]，
    // 众数 8；替换为 ≠5 的最小值 3，新众数 3（未出现）。
    const values = Int32Array.of(5, 8);
    const got = rangeModes(values, [{ left: 0, right: 1 }], {
      robust: { index: 0, minValue: 3, maxValue: 9 },
    });
    expect(got[0].firstChange).toEqual({
      replacementValue: 3,
      mode: { value: 3, count: 1 },
    });
  });

  it('负数端点：范围下界即原众数时取 lo+1；INT32 边界安全', () => {
    // 窗口 [-5,-5,2]，众数 -5（2 票）。可疑 idx=2（2），范围 [-5,-1]：
    // 移除 2 后 [-5,-5]，R=-5 仍居首（B1），c=2，缝隙/新值频次只有 1 达不到，
    // 现有读数中也没有频次 c=2 且 < -5 者 → 全部保持。
    const values = Int32Array.of(-5, -5, 2);
    const got1 = rangeModes(values, [{ left: 0, right: 2 }], {
      robust: { index: 2, minValue: -5, maxValue: -1 },
    });
    expect(got1[0].invariant).toBe(true);

    // 单点查询 [-2147483648]，范围 [-2147483648,-2147483647]：
    // lo 即原值，最小变更值必须是 lo+1 = -2147483647（验证负端点算术）。
    const edge = Int32Array.of(-2147483648);
    const got2 = rangeModes(edge, [{ left: 0, right: 0 }], {
      robust: { index: 0, minValue: -2147483648, maxValue: -2147483647 },
    });
    expect(got2[0].firstChange).toEqual({
      replacementValue: -2147483647,
      mode: { value: -2147483647, count: 1 },
    });

    // 正端点：单点 [2147483647]，范围只有它自己 → 保持（lo+1 溢出判定）。
    const edge2 = Int32Array.of(2147483647);
    const got3 = rangeModes(edge2, [{ left: 0, right: 0 }], {
      robust: { index: 0, minValue: 2147483647, maxValue: 2147483647 },
    });
    expect(got3[0].invariant).toBe(true);
  });

  it('仅部分查询受影响：不含可疑下标的区间沿用原众数且 invariant', () => {
    const values = Int32Array.of(1, 1, 2, 2, 1);
    const queries = [
      { left: 0, right: 1 }, // 不含 idx=3
      { left: 2, right: 4 }, // 含 idx=3（原值 2）
      { left: 0, right: 4 }, // 含 idx=3
    ];
    const got = rangeModes(values, queries, {
      robust: { index: 3, minValue: 0, maxValue: 5 },
    });
    expect(got[0]).toEqual({
      originalMode: { value: 1, count: 2 },
      affected: false,
      invariant: true,
      firstChange: null,
    });
    expect(got[1].affected).toBe(true);
    expect(got[2].affected).toBe(true);
  });

  it('B2：原值即唯一众数，移除后次小读数居首，任何 ≠M 替换都改变', () => {
    // [7,7,3]：众数 7（2 票）。可疑 idx=0（7），范围 [1,9]。移除后剩 [7,3]，
    // 众数 3（T=1）。最小 ≠7 替换值为 1（未出现）→ 新众数 1。
    const values = Int32Array.of(7, 7, 3);
    const got = rangeModes(values, [{ left: 0, right: 2 }], {
      robust: { index: 0, minValue: 1, maxValue: 9 },
    });
    expect(got[0].originalMode).toEqual({ value: 7, count: 2 });
    expect(got[0].firstChange).toEqual({
      replacementValue: 1,
      mode: { value: 1, count: 1 },
    });

    // 范围 [7,9]：7 在范围内可恢复，最小变更值为 8；替换为 8 后 [8,7,3]
    // 各一票，最小为 3（R），故新众数是 3 而非替换值 8——这正是"替换值
    // 本身不一定是新众数"的关键裁决。
    const got2 = rangeModes(values, [{ left: 0, right: 2 }], {
      robust: { index: 0, minValue: 7, maxValue: 9 },
    });
    expect(got2[0].invariant).toBe(false);
    expect(got2[0].firstChange).toEqual({
      replacementValue: 8,
      mode: { value: 3, count: 1 },
    });
  });
});

describe('单点更正稳健性 - 小值域逐值枚举预言机', () => {
  const cases = [
    { seed: 101, n: 1, q: 1, alphabet: 1, lo: -1, hi: 1 },
    { seed: 102, n: 6, q: 40, alphabet: 2, lo: -2, hi: 2 }, // 高并列
    { seed: 103, n: 12, q: 80, alphabet: 3, lo: -3, hi: 3 },
    { seed: 104, n: 20, q: 120, alphabet: 6, lo: -4, hi: 4 }, // 含未出现整数
    { seed: 105, n: 30, q: 200, alphabet: 2, lo: -1, hi: 1 }, // 双峰式并列
    { seed: 106, n: 40, q: 300, alphabet: 30, lo: -15, hi: 15 },
    { seed: 107, n: 15, q: 60, alphabet: 5, lo: -5, hi: -1 }, // 范围全负
  ];

  for (const tc of cases) {
    it(`seed=${tc.seed} n=${tc.n} q=${tc.q} 字母表=${tc.alphabet} 范围=[${tc.lo},${tc.hi}]`, () => {
      const rand = rng(tc.seed);
      const arr = randomArray(tc.n, tc.alphabet, rand);
      const plain = Array.from(arr);
      const queries = new Array(tc.q);
      for (let i = 0; i < tc.q; i++) {
        const l = Math.floor(rand() * tc.n);
        queries[i] = { left: l, right: l + Math.floor(rand() * (tc.n - l)) };
      }
      // 多个可疑下标轮换，确保命中受影响/不受影响两类查询。
      const indices = [0, tc.n >> 1, tc.n - 1];
      for (const index of indices) {
        const params: RobustParams = { index, minValue: tc.lo, maxValue: tc.hi };
        const expected = bruteRobust(plain, queries, params);
        const actual = rangeModes(arr, queries, { robust: params });
        expect(actual).toEqual(expected);
      }
    });
  }

  it('允许更正范围只含单个值时：该值等于原读数则全区间保持，否则按裁决改变', () => {
    const rand = rng(31337);
    const arr = randomArray(18, 5, rand);
    const plain = Array.from(arr);
    const queries: { left: number; right: number }[] = [];
    for (let l = 0; l < 18; l++) {
      for (let r = l; r < 18; r++) queries.push({ left: l, right: r });
    }
    for (const x of [-3, -2, -1, 0, 1, 2, 3]) {
      const params: RobustParams = { index: 7, minValue: x, maxValue: x };
      expect(rangeModes(arr, queries, { robust: params })).toEqual(
        bruteRobust(plain, queries, params),
      );
    }
  });

  it('穷举小数组的每一个闭区间 × 多个可疑位 × 多个更正范围', () => {
    const sequences = [
      [-1],
      [0, 0],
      [1, -1],
      [-1, 1, -1, 1],
      [3, 1, 2, 3, 2, 1],
      [-7, -7, 5, 5, 0],
      [2, 2, 2, 1, 1, 0],
      [-2, -1, 0, 1, 2],
    ];
    for (const seq of sequences) {
      const arr = Int32Array.from(seq);
      const queries: { left: number; right: number }[] = [];
      for (let l = 0; l < seq.length; l++) {
        for (let r = l; r < seq.length; r++) queries.push({ left: l, right: r });
      }
      const ranges: [number, number][] = [
        [-3, 3],
        [-2, 0],
        [0, 2],
        [-5, -1],
        [1, 5],
        [-8, 8],
      ];
      for (let index = 0; index < seq.length; index++) {
        for (const [lo, hi] of ranges) {
          const params: RobustParams = { index, minValue: lo, maxValue: hi };
          expect(rangeModes(arr, queries, { robust: params })).toEqual(
            bruteRobust(seq, queries, params),
          );
        }
      }
    }
  });

  it('INT32 边界参与的替换范围逐值枚举（极小值域）', () => {
    const seq = [-2147483648, 0, 2147483647, 0];
    const arr = Int32Array.from(seq);
    const queries = [{ left: 0, right: 3 }, { left: 1, right: 3 }, { left: 0, right: 0 }];
    const ranges: [number, number][] = [
      [-2147483648, -2147483646],
      [2147483646, 2147483647],
      [-1, 1],
    ];
    for (const index of [0, 1, 2, 3]) {
      for (const [lo, hi] of ranges) {
        const params: RobustParams = { index, minValue: lo, maxValue: hi };
        expect(rangeModes(arr, queries, { robust: params })).toEqual(
          bruteRobust(seq, queries, params),
        );
      }
    }
  });

  it('结果按查询原顺序返回，与莫队处理顺序无关', () => {
    const rand = rng(8888);
    const arr = randomArray(40, 4, rand);
    const q1 = new Array(120);
    for (let i = 0; i < 120; i++) {
      const l = Math.floor(rand() * 40);
      q1[i] = { left: l, right: l + Math.floor(rand() * (40 - l)) };
    }
    const q2 = [...q1].reverse();
    const params: RobustParams = { index: 10, minValue: -3, maxValue: 3 };
    const a1 = rangeModes(arr, q1, { robust: params });
    const a2 = rangeModes(arr, q2, { robust: params });
    for (let i = 0; i < q1.length; i++) {
      expect(a2[q2.length - 1 - i]).toEqual(a1[i]);
    }
  });
});

describe('单点更正稳健性 - 与普通/双峰模式互不干扰', () => {
  it('不启用稳健性时返回旧形态 ModeResult', () => {
    const values = Int32Array.of(2, -3, 2, -3, 5);
    const got = rangeModes(values, [{ left: 0, right: 4 }]);
    expect(got[0]).toEqual({ value: -3, count: 2 });
    expect('originalMode' in got[0]).toBe(false);
  });

  it('originalMode 与同批次普通众数逐项一致', () => {
    const rand = rng(4242);
    const values = randomArray(120, 7, rand);
    const queries = new Array(200);
    for (let i = 0; i < 200; i++) {
      const l = Math.floor(rand() * 120);
      queries[i] = { left: l, right: l + Math.floor(rand() * (120 - l)) };
    }
    const classic = rangeModes(values, queries);
    const robust = rangeModes(values, queries, {
      robust: { index: 50, minValue: -4, maxValue: 4 },
    });
    for (let i = 0; i < queries.length; i++) {
      expect(robust[i].originalMode).toEqual(classic[i]);
    }
  });

  it('稳健性判定不依赖双峰：同输入下与是否启用双峰无关（稳健结果即唯一众数裁决）', () => {
    const values = Int32Array.of(5, -5, 5, -5, 0, -5);
    const queries = [{ left: 0, right: 5 }, { left: 0, right: 3 }];
    const params: RobustParams = { index: 0, minValue: -6, maxValue: 6 };
    const got = rangeModes(values, queries, { robust: params });
    const plain = rangeModes(values, queries);
    for (let i = 0; i < queries.length; i++) {
      expect(got[i].originalMode).toEqual(plain[i]);
    }
  });

  it('较大规模性能：稳健分析不改变 O((n+q)√n) 量级', () => {
    const n = 50_000;
    const q = 50_000;
    const rand = rng(20261005);
    const values = randomArray(n, 9_000, rand);
    const queries = new Array(q);
    for (let i = 0; i < q; i++) {
      const l = Math.floor(rand() * n);
      queries[i] = { left: l, right: l + Math.floor(rand() * (n - l)) };
    }
    const started = performance.now();
    const got = rangeModes(values, queries, {
      robust: { index: n >> 1, minValue: -100, maxValue: 100 },
    });
    const elapsed = performance.now() - started;
    expect(got.length).toBe(q);
    expect(elapsed).toBeLessThan(15_000);
  });
});
