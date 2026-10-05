import { describe, expect, it } from 'vitest';
import { parseRobustParams } from './robustInput';

function ok(indexText: string, minText: string, maxText: string, n = 100) {
  const r = parseRobustParams({ indexText, minText, maxText }, n);
  if (!r.ok) throw new Error(`期望成功，实际：${r.message}`);
  return r.params;
}

function bad(indexText: string, minText: string, maxText: string, n = 100): string {
  const r = parseRobustParams({ indexText, minText, maxText }, n);
  if (r.ok) throw new Error('期望失败，实际成功');
  return r.message;
}

describe('parseRobustParams - 合法参数', () => {
  it('常规正整数与负数端点', () => {
    expect(ok('3', '-10', '10')).toEqual({ index: 3, minValue: -10, maxValue: 10 });
  });

  it('容忍前后空白与 INT32 边界', () => {
    expect(ok(' 0 ', ' -2147483648', '2147483647 ')).toEqual({
      index: 0,
      minValue: -2147483648,
      maxValue: 2147483647,
    });
    const p = ok('99', '-2147483648', '2147483647');
    expect(p.minValue).toBe(-2147483648);
    expect(p.maxValue).toBe(2147483647);
  });

  it('闭区间允许 min === max（单点替换值）', () => {
    expect(ok('5', '42', '42')).toEqual({ index: 5, minValue: 42, maxValue: 42 });
  });
});

describe('parseRobustParams - 拒绝非法输入', () => {
  it('空值 / 非整数 / 其它进制写法', () => {
    expect(bad('', '0', '1')).toContain('可疑下标');
    expect(bad('1', '', '1')).toContain('最小值');
    expect(bad('1', '0', '')).toContain('最大值');
    expect(bad('1.0', '0', '1')).toContain('十进制整数');
    expect(bad('0x1', '0', '1')).toContain('十进制整数');
    expect(bad('1e3', '0', '1')).toContain('十进制整数');
    expect(bad('-', '0', '1')).toContain('十进制整数');
  });

  it('下标越界（含负数与等于 n）', () => {
    expect(bad('-1', '0', '1', 100)).toContain('可疑下标越界');
    expect(bad('100', '0', '1', 100)).toContain('可疑下标越界');
    expect(bad('99999999999999999999', '0', '1', 100)).toContain('32 位');
  });

  it('替换值越过 INT32', () => {
    expect(bad('0', '-2147483649', '1')).toContain('32 位');
    expect(bad('0', '0', '2147483648')).toContain('32 位');
  });

  it('最小值大于最大值', () => {
    expect(bad('0', '9', '8')).toContain('非法更正范围');
  });
});
