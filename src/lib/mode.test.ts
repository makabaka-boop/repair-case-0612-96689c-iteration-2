import { describe, expect, it } from 'vitest';
import { rangeModes, type ModeResult } from './mode';

/** 暴力实现：逐区间用 Map 计数，频次并列取较小值。 */
function bruteModes(values: number[], queries: { left: number; right: number }[]): ModeResult[] {
  return queries.map(({ left, right }) => {
    const counts = new Map<number, number>();
    for (let i = left; i <= right; i++) counts.set(values[i], (counts.get(values[i]) ?? 0) + 1);
    let bestValue = Infinity;
    let bestCount = -1;
    for (const [value, count] of counts) {
      if (count > bestCount || (count === bestCount && value < bestValue)) {
        bestCount = count;
        bestValue = value;
      }
    }
    return { value: bestValue, count: bestCount };
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

function randomQueries(
  q: number,
  n: number,
  rand: () => number,
): { left: number; right: number }[] {
  const out: { left: number; right: number }[] = new Array(q);
  for (let i = 0; i < q; i++) {
    const l = Math.floor(rand() * n);
    const r = l + Math.floor(rand() * (n - l));
    out[i] = { left: l, right: r };
  }
  return out;
}

describe('rangeModes - 基础与并列裁决', () => {
  it('单元素区间', () => {
    const values = Int32Array.of(42);
    expect(rangeModes(values, [{ left: 0, right: 0 }])).toEqual([{ value: 42, count: 1 }]);
  });

  it('全区间唯一众数', () => {
    const values = Int32Array.of(-1, 2, -1, 2, 0, 0, -1);
    expect(rangeModes(values, [{ left: 0, right: 6 }])).toEqual([{ value: -1, count: 3 }]);
  });

  it('频次并列时取较小数值（小样本裁决必须精确）', () => {
    // 2 和 -3 各出现 2 次，-3 < 2
    const values = Int32Array.of(2, -3, 2, -3, 5);
    expect(rangeModes(values, [{ left: 0, right: 4 }])).toEqual([{ value: -3, count: 2 }]);
    // 0 与 1 各 1 次
    expect(rangeModes(values, [{ left: 2, right: 3 }])).toEqual([{ value: -3, count: 1 }]);
    // 2 出现两次
    expect(rangeModes(values, [{ left: 0, right: 2 }])).toEqual([{ value: 2, count: 2 }]);
  });

  it('INT32 边界值参与并列裁决', () => {
    const values = Int32Array.of(-2147483648, 2147483647, -2147483648, 2147483647);
    const got = rangeModes(values, [{ left: 0, right: 3 }]);
    expect(got[0]).toEqual({ value: -2147483648, count: 2 });
    // 单取较大值一侧：两者并列场景之外的正常裁决
    const got2 = rangeModes(values, [{ left: 1, right: 3 }]);
    expect(got2[0]).toEqual({ value: 2147483647, count: 2 });
  });

  it('结果严格按查询原顺序返回', () => {
    const values = Int32Array.of(1, 1, 2, 2, 3, 3, 1);
    const queries = [
      { left: 4, right: 5 }, // 下标 4、5 均为 3 → 3
      { left: 0, right: 6 }, // 1 出现 3 次 → 1
      { left: 2, right: 3 }, // 2 出现 2 次 → 2
      { left: 0, right: 1 }, // 1 出现 2 次 → 1
    ];
    expect(rangeModes(values, queries)).toEqual([
      { value: 3, count: 2 },
      { value: 1, count: 3 },
      { value: 2, count: 2 },
      { value: 1, count: 2 },
    ]);
  });
});

describe('rangeModes - 随机暴力对照', () => {
  const cases = [
    { seed: 1, n: 1, q: 1, alphabet: 1 },
    { seed: 2, n: 7, q: 30, alphabet: 3 },
    { seed: 3, n: 50, q: 200, alphabet: 5 },
    { seed: 4, n: 200, q: 500, alphabet: 20 },
    { seed: 5, n: 777, q: 1000, alphabet: 2 },
    { seed: 6, n: 1000, q: 1000, alphabet: 1000 },
    { seed: 7, n: 3000, q: 3000, alphabet: 50 },
  ];

  for (const tc of cases) {
    it(`n=${tc.n}, q=${tc.q}, 字母表=${tc.alphabet}`, () => {
      const rand = rng(tc.seed);
      const values = randomArray(tc.n, tc.alphabet, rand);
      const queries = randomQueries(tc.q, tc.n, rand);
      const expected = bruteModes(Array.from(values), queries);
      const actual = rangeModes(values, queries);
      expect(actual).toEqual(expected);
    });
  }

  it('交换查询顺序不改变各查询自身答案（与处理顺序无关）', () => {
    const rand = rng(99);
    const values = randomArray(500, 17, rand);
    const q1 = randomQueries(400, 500, rand);
    const q2 = [...q1].reverse();
    const a1 = rangeModes(values, q1);
    const a2 = rangeModes(values, q2);
    for (let i = 0; i < q1.length; i++) {
      expect(a2[q2.length - 1 - i]).toEqual(a1[i]);
    }
  });

  it('频次层数组增长后删除，块最大频次正确回降', () => {
    // 三个不同值 [3,10,20]：rank 0、1 同处一个值块。查询顺序迫使莫队先把
    // 值 10 累到高频（触发该块频次层数组倍增），再切到不含 10 的短区间，
    // 此时块最大频次必须正确回降，众数为 3 而不是残留的高频 10。
    const values = Int32Array.of(
      ...new Array(10).fill(10),
      ...new Array(2).fill(3),
      20,
    );
    const queries = [
      { left: 0, right: 12 }, // 10 ×10 → 10
      { left: 10, right: 12 }, // 3 ×2、20 ×1 → 3
      { left: 0, right: 12 }, // 再回到全区间 → 10
    ];
    expect(rangeModes(values, queries)).toEqual([
      { value: 10, count: 10 },
      { value: 3, count: 2 },
      { value: 10, count: 10 },
    ]);
  });
});

describe('rangeModes - 20 万读数与 20 万查询对抗批次', () => {
  it('在复杂度时限内完成且保持原顺序，末行为可核对的唯一答案', () => {
    const n = 200_000;
    const q = 200_000;
    const rand = rng(20260916);
    const values = randomArray(n, 90_000, rand);
    const queries = new Array<{ left: number; right: number }>(q);

    // 对抗构造：交替出现跨全长的大区间与紧贴单点的小区间，
    // 朴素逐段扫描会反复全量计数；Hilbert 排序必须稳住移动量。
    for (let i = 0; i < q - 1; i++) {
      if ((i & 1) === 0) {
        const l = Math.floor(rand() * 1000);
        queries[i] = { left: l, right: n - 1 - Math.floor(rand() * 1000) };
      } else {
        const p = Math.floor(rand() * n);
        queries[i] = { left: p, right: p };
      }
    }
    // 末区间固定为整个数组，是可独立核对的唯一答案
    queries[q - 1] = { left: 0, right: n - 1 };

    const started = performance.now();
    const answers = rangeModes(values, queries);
    const elapsed = performance.now() - started;

    expect(answers.length).toBe(q);

    // 顺序检查：前 q-1 个与暴力（只核对抽检的小区间，大区间抽样）一致
    const expectCountAt = (idx: number): ModeResult => {
      const { left, right } = queries[idx];
      const counts = new Map<number, number>();
      for (let i = left; i <= right; i++) counts.set(values[i], (counts.get(values[i]) ?? 0) + 1);
      let v = Infinity;
      let c = -1;
      for (const [value, count] of counts) {
        if (count > c || (count === c && value < v)) {
          c = count;
          v = value;
        }
      }
      return { value: v, count: c };
    };

    // 单点查询代价低，全部核对
    for (let i = 1; i < q - 1; i += 2) {
      expect(answers[i]).toEqual({ value: values[queries[i].left], count: 1 });
    }
    // 大区间抽样 5 个
    const sampleIdx = [10, 1234, 56780, 120002, 190000].filter((x) => x < q - 1);
    for (const idx of sampleIdx) {
      expect(answers[idx]).toEqual(expectCountAt(idx));
    }

    // 末行：整个数组的众数（暴力统计一次，唯一可核对答案）
    const whole = expectCountAt(q - 1);
    expect(answers[q - 1]).toEqual(whole);
    expect(queries[q - 1]).toEqual({ left: 0, right: n - 1 });

    // O((n+q)√n) 量级：20 万规模应在数秒内完成（宽松上限，避免抖动）
    expect(elapsed).toBeLessThan(30_000);
  });
});
