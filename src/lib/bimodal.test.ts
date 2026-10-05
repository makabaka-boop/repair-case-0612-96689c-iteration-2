import { describe, expect, it } from 'vitest';
import { rangeModes, type BimodalResult } from './mode';

/**
 * 预言机：逐区间用 Map 计数，按"出现次数降序、读数升序"取前两个不同读数。
 * 不依赖莫队/分块，纯朴素实现，专门核对双峰复核的裁决。
 */
function bruteBimodal(
  values: number[],
  queries: { left: number; right: number }[],
): BimodalResult[] {
  return queries.map(({ left, right }) => {
    const counts = new Map<number, number>();
    for (let i = left; i <= right; i++) {
      counts.set(values[i], (counts.get(values[i]) ?? 0) + 1);
    }
    // 频次降序、读数升序
    const ranked = [...counts.entries()].sort((a, b) =>
      b[1] - a[1] !== 0 ? b[1] - a[1] : a[0] - b[0],
    );
    const [v0, c0] = ranked[0];
    const first = { value: v0, count: c0 };
    const second = ranked.length >= 2 ? { value: ranked[1][0], count: ranked[1][1] } : null;
    return { first, second };
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

describe('rangeModes 双峰复核 - 小数组逐区间计数预言机', () => {
  it('全相等：第一名正确且第二名明确为空', () => {
    const values = Int32Array.of(7, 7, 7, 7);
    const queries = [
      { left: 0, right: 3 },
      { left: 1, right: 2 },
      { left: 3, right: 3 },
    ];
    expect(rangeModes(values, queries, { bimodal: true })).toEqual([
      { first: { value: 7, count: 4 }, second: null },
      { first: { value: 7, count: 2 }, second: null },
      { first: { value: 7, count: 1 }, second: null },
    ]);
  });

  it('只有一种读数时（不同长度）第二名均为 null', () => {
    for (const n of [1, 2, 5]) {
      const values = new Int32Array(n).fill(-42);
      const got = rangeModes(values, [{ left: 0, right: n - 1 }], { bimodal: true });
      expect(got[0].second).toBeNull();
      expect(got[0].first).toEqual({ value: -42, count: n });
    }
  });

  it('频次并列：按频次降序、读数升序取前二，不随查询处理顺序变化', () => {
    // -3 与 2 各 2 次、5 一次：前二为 -3(2)、2(2)
    const values = Int32Array.of(2, -3, 2, -3, 5);
    expect(rangeModes(values, [{ left: 0, right: 4 }], { bimodal: true })).toEqual([
      { first: { value: -3, count: 2 }, second: { value: 2, count: 2 } },
    ]);
    // 下标 2..4 为 [2,-3,5]，三者各 1 次：按读数升序取 -3、2
    expect(rangeModes(values, [{ left: 2, right: 4 }], { bimodal: true })).toEqual([
      { first: { value: -3, count: 1 }, second: { value: 2, count: 1 } },
    ]);
    // 两个并列
    expect(rangeModes(values, [{ left: 3, right: 4 }], { bimodal: true })).toEqual([
      { first: { value: -3, count: 1 }, second: { value: 5, count: 1 } },
    ]);
  });

  it('三个读数完全并列：第三名不得出现，次序只取决于读数大小', () => {
    const values = Int32Array.of(10, -10, 0);
    expect(rangeModes(values, [{ left: 0, right: 2 }], { bimodal: true })).toEqual([
      { first: { value: -10, count: 1 }, second: { value: 0, count: 1 } },
    ]);
  });

  it('负数参与裁决，INT32 边界值排序正确', () => {
    const values = Int32Array.of(-2147483648, 2147483647, -2147483648, 2147483647, 0);
    expect(rangeModes(values, [{ left: 0, right: 4 }], { bimodal: true })).toEqual([
      {
        first: { value: -2147483648, count: 2 },
        second: { value: 2147483647, count: 2 },
      },
    ]);
  });

  it('端点：单元素、前缀、后缀与全区间', () => {
    const values = Int32Array.of(-5, 1, -5, 1, 9);
    const queries = [
      { left: 0, right: 0 },
      { left: 4, right: 4 },
      { left: 0, right: 1 },
      { left: 3, right: 4 },
      { left: 0, right: 4 },
    ];
    expect(rangeModes(values, queries, { bimodal: true })).toEqual(
      bruteBimodal(Array.from(values), queries),
    );
  });

  it('穷举小数组的每一个闭区间（全相等/并列/负数全覆盖）', () => {
    const sequences = [
      [-1],
      [0, 0],
      [-2, -2, -2],
      [1, -1],
      [-1, 1, -1, 1],
      [3, 1, 2, 3, 2, 1],
      [-7, -7, 5, 5, 0],
      [2, 2, 2, 1, 1, 0],
      [100, -100, 100, -100, 0, 0],
    ];
    for (const seq of sequences) {
      const queries: { left: number; right: number }[] = [];
      for (let l = 0; l < seq.length; l++) {
        for (let r = l; r < seq.length; r++) queries.push({ left: l, right: r });
      }
      expect(rangeModes(Int32Array.from(seq), queries, { bimodal: true })).toEqual(
        bruteBimodal(seq, queries),
      );
    }
  });
});

describe('rangeModes 双峰复核 - 随机暴力对照', () => {
  const cases = [
    { seed: 11, n: 1, q: 1, alphabet: 1 },
    { seed: 12, n: 8, q: 40, alphabet: 2 },
    { seed: 13, n: 60, q: 300, alphabet: 4 },
    { seed: 14, n: 250, q: 600, alphabet: 25 },
    { seed: 15, n: 999, q: 1200, alphabet: 3 }, // 高并列概率
    { seed: 16, n: 1500, q: 1500, alphabet: 1500 }, // 几乎全互异
    { seed: 17, n: 3000, q: 3000, alphabet: 60 },
  ];

  for (const tc of cases) {
    it(`n=${tc.n}, q=${tc.q}, 字母表=${tc.alphabet}`, () => {
      const rand = rng(tc.seed);
      const values = randomArray(tc.n, tc.alphabet, rand);
      const queries = new Array(tc.q);
      for (let i = 0; i < tc.q; i++) {
        const l = Math.floor(rand() * tc.n);
        const r = l + Math.floor(rand() * (tc.n - l));
        queries[i] = { left: l, right: r };
      }
      expect(rangeModes(values, queries, { bimodal: true })).toEqual(
        bruteBimodal(Array.from(values), queries),
      );
    });
  }

  it('频率多次升降后位图不残留：次高频次必须来自当前窗口', () => {
    // 10 高频后窗口切到不含 10 的小区间，再切回，第二名不得残留旧层级。
    const values = Int32Array.of(
      ...new Array(10).fill(10),
      ...new Array(3).fill(3),
      ...new Array(2).fill(20),
    );
    const queries = [
      { left: 0, right: 14 }, // 10×10, 3×3, 20×2
      { left: 10, right: 14 }, // 3×3, 20×2
      { left: 0, right: 14 }, // 回到全区间
      { left: 13, right: 14 }, // 20×2
    ];
    expect(rangeModes(values, queries, { bimodal: true })).toEqual(
      bruteBimodal(Array.from(values), queries),
    );
  });

  it('高频次跨越频次层 32 位字边界（bit 31 有符号陷阱）后第二名仍正确', () => {
    // 三个读数分别累到 40/39/5 次，第二名必须是 39 而不是位图残留的 40；
    // 莫队顺序令高频读数多次进出窗口，覆盖频次层 32、64 附近的位翻转。
    const values = Int32Array.of(
      ...new Array(40).fill(100),
      ...new Array(39).fill(200),
      ...new Array(5).fill(300),
    );
    const queries = [
      { left: 0, right: 83 }, // 100×40, 200×39, 300×5
      { left: 40, right: 83 }, // 200×39, 300×5
      { left: 0, right: 83 }, // 回到全区间
      { left: 79, right: 83 }, // 300×5（单一读数 → null）
      { left: 0, right: 78 }, // 100×40, 200×39
    ];
    expect(rangeModes(values, queries, { bimodal: true })).toEqual([
      { first: { value: 100, count: 40 }, second: { value: 200, count: 39 } },
      { first: { value: 200, count: 39 }, second: { value: 300, count: 5 } },
      { first: { value: 100, count: 40 }, second: { value: 200, count: 39 } },
      { first: { value: 300, count: 5 }, second: null },
      { first: { value: 100, count: 40 }, second: { value: 200, count: 39 } },
    ]);
  });

  it('高频（>64）多读数交替进出：汇总字屏蔽不把更高频误当第二名', () => {
    const values = Int32Array.of(
      ...new Array(70).fill(1),
      ...new Array(68).fill(2),
      ...new Array(30).fill(3),
    );
    const queries = [
      { left: 0, right: 167 }, // 1×70, 2×68, 3×30 → 第二为 2×68
      { left: 70, right: 167 }, // 2×68, 3×30 → 第二为 3×30
      { left: 0, right: 167 },
      { left: 0, right: 137 }, // 1×70, 2×68
      { left: 138, right: 167 }, // 3×30 → null
    ];
    expect(rangeModes(values, queries, { bimodal: true })).toEqual(
      bruteBimodal(Array.from(values), queries),
    );
  });

  it('频次并列时交换查询顺序不改变各查询自身答案', () => {
    const rand = rng(99);
    const values = randomArray(500, 8, rand); // 小字母表 → 大量并列
    const q1 = new Array(400);
    for (let i = 0; i < 400; i++) {
      const l = Math.floor(rand() * 500);
      q1[i] = { left: l, right: l + Math.floor(rand() * (500 - l)) };
    }
    const q2 = [...q1].reverse();
    const a1 = rangeModes(values, q1, { bimodal: true });
    const a2 = rangeModes(values, q2, { bimodal: true });
    for (let i = 0; i < q1.length; i++) {
      expect(a2[q2.length - 1 - i]).toEqual(a1[i]);
    }
    // 同批再跑一次也完全一致（确定性）
    expect(rangeModes(values, q1, { bimodal: true })).toEqual(a1);
  });
});

describe('rangeModes 双峰复核 - 与旧众数逐项一致', () => {
  it('第一名 value/count 与未启用时的众数结果完全相同', () => {
    const rand = rng(777);
    const values = randomArray(800, 13, rand);
    const queries = new Array(700);
    for (let i = 0; i < 700; i++) {
      const l = Math.floor(rand() * 800);
      queries[i] = { left: l, right: l + Math.floor(rand() * (800 - l)) };
    }
    const classic = rangeModes(values, queries);
    const bimodal = rangeModes(values, queries, { bimodal: true });
    expect(bimodal.length).toBe(classic.length);
    for (let i = 0; i < queries.length; i++) {
      expect(bimodal[i].first).toEqual(classic[i]);
    }
  });

  it('未启用双峰时返回类型与契约保持旧形态（无 first/second 包装）', () => {
    const values = Int32Array.of(1, 2, 2);
    const got = rangeModes(values, [{ left: 0, right: 2 }]);
    expect(got[0]).toEqual({ value: 2, count: 2 });
    expect('first' in got[0]).toBe(false);
    expect('second' in got[0]).toBe(false);
  });

  it('中等规模性能：双峰开销不改变 O((n+q)√n) 量级', () => {
    const n = 50_000;
    const q = 50_000;
    const rand = rng(20260930);
    const values = randomArray(n, 9_000, rand);
    const queries = new Array(q);
    for (let i = 0; i < q; i++) {
      const l = Math.floor(rand() * n);
      queries[i] = { left: l, right: l + Math.floor(rand() * (n - l)) };
    }
    const started = performance.now();
    const got = rangeModes(values, queries, { bimodal: true });
    const elapsed = performance.now() - started;
    expect(got.length).toBe(q);
    expect(elapsed).toBeLessThan(15_000);
  });
});
