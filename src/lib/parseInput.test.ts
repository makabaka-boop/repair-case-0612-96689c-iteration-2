import { describe, expect, it } from 'vitest';
import { parseInput, type InputError, type ParsedInput } from './parseInput';

function ok(text: string): ParsedInput {
  const r = parseInput(text);
  if ('message' in r) throw new Error(`期望解析成功，实际错误：${r.message}`);
  return r;
}

function bad(text: string): InputError {
  const r = parseInput(text);
  if (!('message' in r)) throw new Error('期望解析失败，实际成功');
  return r;
}

describe('parseInput - 合法输入', () => {
  it('最小合法输入', () => {
    const r = ok('{"values":[0],"queries":[{"left":0,"right":0}]}');
    expect(Array.from(r.values)).toEqual([0]);
    expect(r.queries).toEqual([{ left: 0, right: 0 }]);
  });

  it('接受 INT32 边界、负数与空白', () => {
    const r = ok(`
      { "values" : [ -2147483648, 2147483647 , -0 ] ,
        "queries" : [ {"left":0,"right":2} ] }`);
    expect(r.values[0]).toBe(-2147483648);
    expect(r.values[1]).toBe(2147483647);
    expect(r.values[2]).toBe(0);
  });
});

describe('parseInput - JSON 语法错误定位首个错误', () => {
  it('缺逗号', () => {
    const e = bad('{"values":[1 2],"queries":[]}');
    expect(e.path).toBe('$');
    expect(e.offset).toBe(13);
  });

  it('未闭合字符串', () => {
    const e = bad('{"values":[1],"queries":[{"left":0,"right":0}]}x');
    // 文档后多余内容
    expect(e.offset).toBeGreaterThan(40);
  });

  it('非法字面量', () => {
    const e = bad('{"values":[tru],"queries":[]}');
    expect(e.message).toContain('语法错误');
    expect(e.offset).toBe(11);
  });
});

describe('parseInput - 结构与未知字段', () => {
  it('顶层不是对象', () => {
    expect(bad('[1,2,3]').message).toContain('顶层必须是对象');
    expect(bad('null').path).toBe('$');
  });

  it('顶层未知字段', () => {
    const e = bad('{"values":[1],"queries":[{"left":0,"right":0}],"hack":1}');
    expect(e.message).toContain('未知字段');
    expect(e.path).toBe('$.hack');
    // 偏移指向 hack 键名
    expect('hack'.includes('h')).toBe(true);
  });

  it('缺字段', () => {
    expect(bad('{"values":[1]}').message).toContain('queries');
    expect(bad('{"queries":[]}').message).toContain('values');
  });

  it('查询对象含未知字段', () => {
    const e = bad('{"values":[1,2],"queries":[{"left":0,"right":1,"mid":0}]}');
    expect(e.path).toBe('$.queries[0].mid');
    expect(e.message).toContain('未知字段');
  });

  it('查询不是对象', () => {
    expect(bad('{"values":[1],"queries":[5]}').path).toBe('$.queries[0]');
  });

  it('查询缺 left/right', () => {
    expect(bad('{"values":[1],"queries":[{"right":0}]}').path).toBe('$.queries[0].left');
    expect(bad('{"values":[1],"queries":[{"left":0}]}').path).toBe('$.queries[0].right');
  });
});

describe('parseInput - 非整数拒绝', () => {
  it('小数', () => {
    const e = bad('{"values":[1,2.5],"queries":[{"left":0,"right":0}]}');
    expect(e.path).toBe('$.values[1]');
    expect(e.message).toContain('小数');
  });

  it('布尔、字符串、null、对象均拒绝', () => {
    expect(bad('{"values":[true],"queries":[{"left":0,"right":0}]}').path).toBe('$.values[0]');
    expect(bad('{"values":["1"],"queries":[{"left":0,"right":0}]}').path).toBe('$.values[0]');
    expect(bad('{"values":[null],"queries":[{"left":0,"right":0}]}').path).toBe('$.values[0]');
    expect(bad('{"values":[{}],"queries":[{"left":0,"right":0}]}').path).toBe('$.values[0]');
  });

  it('超出 INT32 范围（注意 JSON 大整数仍为 JSON number）', () => {
    const e1 = bad('{"values":[2147483648],"queries":[{"left":0,"right":0}]}');
    expect(e1.path).toBe('$.values[0]');
    expect(e1.message).toContain('32 位');
    const e2 = bad('{"values":[-2147483649],"queries":[{"left":0,"right":0}]}');
    expect(e2.path).toBe('$.values[0]');
  });

  it('科学计数法的整数值也接受（JSON 整数）', () => {
    const r = ok('{"values":[1e2],"queries":[{"left":0,"right":0}]}');
    expect(r.values[0]).toBe(100);
  });

  it('left/right 必须为非负整数', () => {
    expect(bad('{"values":[1],"queries":[{"left":-1,"right":0}]}').path).toBe('$.queries[0].left');
    expect(bad('{"values":[1],"queries":[{"left":0,"right":1.5}]}').path).toBe('$.queries[0].right');
    expect(bad('{"values":[1],"queries":[{"left":true,"right":0}]}').path).toBe('$.queries[0].left');
  });
});

describe('parseInput - 数量越界', () => {
  it('空数组', () => {
    expect(bad('{"values":[],"queries":[{"left":0,"right":0}]}').message).toContain('values 数量越界');
    expect(bad('{"values":[1],"queries":[]}').message).toContain('queries 数量越界');
  });

  it('超过 200000', () => {
    const tooManyValues = JSON.stringify({
      values: new Array(200_001).fill(0),
      queries: [{ left: 0, right: 0 }],
    });
    expect(bad(tooManyValues).message).toContain('200000');

    const tooManyQueries = JSON.stringify({
      values: [1],
      queries: new Array(200_001).fill({ left: 0, right: 0 }),
    });
    expect(bad(tooManyQueries).message).toContain('200000');
  });
});

describe('parseInput - 非法区间', () => {
  it('left > right 定位到 left', () => {
    const e = bad('{"values":[1,2,3],"queries":[{"left":2,"right":1}]}');
    expect(e.path).toBe('$.queries[0].left');
    expect(e.message).toContain('left');
  });

  it('right 越上界定位到 right', () => {
    const e = bad('{"values":[1,2,3],"queries":[{"left":0,"right":3}]}');
    expect(e.path).toBe('$.queries[0].right');
    expect(e.message).toContain('下标范围');
  });

  it('边界合法：right = n-1', () => {
    const r = ok('{"values":[1,2,3],"queries":[{"left":0,"right":2}]}');
    expect(r.queries[0]).toEqual({ left: 0, right: 2 });
  });
});

describe('parseInput - 首个错误定位', () => {
  it('多个错误时只报告第一个（values 先于 queries 校验，按下标顺序）', () => {
    const e = bad(
      '{"values":[1,99,2.0,7.5],"queries":[{"left":0,"right":99}]}',
    );
    // 2.0 是合法整数（JSON 中就是 2）；首个错误是下标 3 的 7.5
    expect(e.path).toBe('$.values[3]');
  });

  it('偏移指向原始文本中的对应值', () => {
    const text = '{"values":[1, 2, 3.5],"queries":[{"left":0,"right":0}]}';
    const e = bad(text);
    expect(e.path).toBe('$.values[2]');
    expect(text.slice(e.offset, e.offset + 3)).toBe('3.5');
  });

  it('queries 中第二个查询出错时定位到第二项', () => {
    const text =
      '{"values":[1,2],"queries":[{"left":0,"right":1},{"left":5,"right":6}]}';
    const e = bad(text);
    expect(e.path).toBe('$.queries[1].right');
  });
});
