/**
 * 一次性"单点更正稳健性"分析参数的解析与校验。
 *
 * 参数完全来自界面控件（不改变输入 JSON 契约）：原数组下标 index 与有符号
 * 32 位整数闭区间 [minValue, maxValue]。任一不满足都返回中文错误说明，
 * 调用方据此中止本轮分析、保留上一份快照不清空（输入 JSON 未变）。
 */
import type { RobustParams } from './mode';

export interface RobustInput {
  /** 控件原始文本（允许前后空白）。 */
  indexText: string;
  minText: string;
  maxText: string;
}

export type RobustParseResult =
  | { ok: true; params: RobustParams }
  | { ok: false; message: string };

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** 解析十进制有符号 32 位整数文本；空白、非整数、越界一律拒绝（返回 null）。 */
function parseInt32Field(text: string, label: string): number | string {
  const t = text.trim();
  if (t === '') return `${label}不能为空`;
  // 严格十进制：可选负号 + 至少一位数字，拒绝 1.0 / 0x10 / 1e3 等写法。
  if (!/^-?\d+$/.test(t)) return `${label}必须是十进制整数`;
  // Number 对超长数字串会得 Infinity/精度丢失；先按长度粗筛再比较范围。
  if (t.replace('-', '').length > 11) return `${label}超出有符号 32 位整数范围`;
  const v = Number(t);
  if (!Number.isInteger(v) || v < INT32_MIN || v > INT32_MAX) {
    return `${label}超出有符号 32 位整数范围 [${INT32_MIN}, ${INT32_MAX}]`;
  }
  return v;
}

/**
 * 校验并构造稳健性参数。
 *
 * @param input 三个控件的原始文本
 * @param n 已解析通过的 values 长度（用于下标范围判定）
 */
export function parseRobustParams(input: RobustInput, n: number): RobustParseResult {
  const indexRaw = parseInt32Field(input.indexText, '可疑下标');
  if (typeof indexRaw === 'string') return { ok: false, message: indexRaw };
  const minRaw = parseInt32Field(input.minText, '替换最小值');
  if (typeof minRaw === 'string') return { ok: false, message: minRaw };
  const maxRaw = parseInt32Field(input.maxText, '替换最大值');
  if (typeof maxRaw === 'string') return { ok: false, message: maxRaw };

  if (indexRaw < 0 || indexRaw >= n) {
    return { ok: false, message: `可疑下标越界：${indexRaw}，要求 0～${n - 1}` };
  }
  if (minRaw > maxRaw) {
    return { ok: false, message: `非法更正范围：最小值 ${minRaw} 大于最大值 ${maxRaw}` };
  }
  return { ok: true, params: { index: indexRaw, minValue: minRaw, maxValue: maxRaw } };
}
