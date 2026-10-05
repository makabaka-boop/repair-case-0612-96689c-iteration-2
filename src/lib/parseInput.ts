/**
 * 输入 JSON 的严格解析与校验。
 *
 * 接受形如 {"values": [..int32..], "queries": [{"left": int, "right": int}, ...]}
 * 的普通 JSON。任何不满足之处都返回"首个"错误的位置信息；调用方据此清空旧结果，
 * 且不得输出部分答案。
 */

export interface ParsedInput {
  values: Int32Array;
  queries: { left: number; right: number }[];
}

export interface InputError {
  /** 人类可读的中文错误说明。 */
  message: string;
  /** JSON 字节/字符偏移（无法定位时为 -1）。 */
  offset: number;
  /** 形如 $.queries[3].right 的字段路径。 */
  path: string;
}

const MIN_COUNT = 1;
const MAX_COUNT = 200_000;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** 解析失败：既可能是 JSON 语法错误，也可能是结构/取值错误。 */
export function parseInput(text: string): ParsedInput | InputError {
  const syntaxError = checkJsonSyntax(text);
  if (syntaxError) return syntaxError;

  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (err) {
    // 语法预校验通过后理论上不会到达这里。
    const e = err as Error;
    return { message: `JSON 解析失败：${e.message}`, offset: -1, path: '$' };
  }

  const located = buildLocator(text);

  const at = (path: string, fallback = 0): number => {
    const pos = located.paths.get(path);
    return pos === undefined ? fallback : pos;
  };
  const fail = (message: string, path: string, offset?: number): InputError => ({
    message,
    path,
    offset: offset ?? at(path),
  });

  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return fail('顶层必须是对象，且仅含 values、queries 两个字段', '$');
  }

  const rootObj = root as Record<string, unknown>;
  const rootKeys = Object.keys(rootObj);
  const allowedRoot = new Set(['values', 'queries']);
  for (const key of rootKeys) {
    if (!allowedRoot.has(key)) {
      return fail(`存在未知字段 "${key}"，仅允许 values 与 queries`, `$.${key}`, locateKey(text, located, key));
    }
  }
  if (!('values' in rootObj)) return fail('缺少必填字段 values', '$.values');
  if (!('queries' in rootObj)) return fail('缺少必填字段 queries', '$.queries');

  // ---- values ----
  const valuesRaw = rootObj.values;
  if (!Array.isArray(valuesRaw)) {
    return fail('values 必须是数组', '$.values');
  }
  const n = valuesRaw.length;
  if (n < MIN_COUNT || n > MAX_COUNT) {
    return fail(
      `values 数量越界：${n}，要求 ${MIN_COUNT}～${MAX_COUNT} 个有符号 32 位整数`,
      '$.values',
    );
  }
  const values = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const path = `$.values[${i}]`;
    const v = valuesRaw[i];
    if (!isExactInt32(v)) {
      return fail(describeBadInt(v), path);
    }
    values[i] = v as number;
  }

  // ---- queries ----
  const queriesRaw = rootObj.queries;
  if (!Array.isArray(queriesRaw)) {
    return fail('queries 必须是数组', '$.queries');
  }
  const q = queriesRaw.length;
  if (q < MIN_COUNT || q > MAX_COUNT) {
    return fail(
      `queries 数量越界：${q}，要求 ${MIN_COUNT}～${MAX_COUNT} 个查询`,
      '$.queries',
    );
  }
  const queries: { left: number; right: number }[] = new Array(q);
  for (let i = 0; i < q; i++) {
    const item = queriesRaw[i];
    const base = `$.queries[${i}]`;
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return fail('每个查询必须是仅含 left、right 的对象', base);
    }
    const obj = item as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      if (key !== 'left' && key !== 'right') {
        return fail(`查询存在未知字段 "${key}"，仅允许 left 与 right`, `${base}.${key}`);
      }
    }
    if (!('left' in obj)) return fail('查询缺少必填字段 left', `${base}.left`);
    if (!('right' in obj)) return fail('查询缺少必填字段 right', `${base}.right`);

    const { left, right } = obj;
    if (!isSafeNonNegInt(left)) {
      return fail('left 必须是非负整数', `${base}.left`);
    }
    if (!isSafeNonNegInt(right)) {
      return fail('right 必须是非负整数', `${base}.right`);
    }
    if (left > right) {
      return fail(`非法区间：left(${left}) 大于 right(${right})，要求 0 ≤ left ≤ right`, `${base}.left`);
    }
    if (right >= n) {
      return fail(
        `非法区间：right(${right}) 超出 values 下标范围 [0, ${n - 1}]`,
        `${base}.right`,
      );
    }
    queries[i] = { left: left as number, right: right as number };
  }

  return { values, queries };
}

/** 判定是否为精确的有符号 32 位整数（拒绝 1.0 以外的浮点、布尔、字符串等）。 */
function isExactInt32(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= INT32_MIN &&
    v <= INT32_MAX
  );
}

/** 判定非负"安全整数"下标（数组长度上限 200000，安全整数范围足够）。 */
function isSafeNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;
}

function describeBadInt(v: unknown): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 'values 元素必须是有符号 32 位整数，不能为 Infinity/NaN';
    if (!Number.isInteger(v)) return `values 元素必须是整数，不能为小数 ${v}`;
    return `values 元素超出有符号 32 位整数范围 [${INT32_MIN}, ${INT32_MAX}]：${v}`;
  }
  if (typeof v === 'string') return `values 元素必须是整数，不能为字符串`;
  if (typeof v === 'boolean') return 'values 元素必须是整数，不能为布尔值';
  if (v === null) return 'values 元素必须是整数，不能为 null';
  if (Array.isArray(v)) return 'values 元素必须是整数，不能为数组';
  return 'values 元素必须是整数，不能为对象';
}

/**
 * JSON 语法预校验：JSON.parse 的错误消息（位置随引擎变化）不可靠，这里用一个
 * 最小递归下降解析器在不构造对象的前提下定位首个语法错误的字符偏移。
 */
function checkJsonSyntax(text: string): InputError | null {
  let i = 0;
  const len = text.length;

  const skipWs = (): void => {
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };

  const error = (msg: string): InputError => ({
    message: `JSON 语法错误（位置 ${i}）：${msg}`,
    offset: i,
    path: '$',
  });

  function parseValue(): InputError | null {
    skipWs();
    if (i >= len) return error('意外结束，缺少值');
    const c = text[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') {
      const e = parseString();
      return e;
    }
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    if (text.startsWith('true', i)) {
      i += 4;
      return null;
    }
    if (text.startsWith('false', i)) {
      i += 5;
      return null;
    }
    if (text.startsWith('null', i)) {
      i += 4;
      return null;
    }
    return error('无法识别的记号');
  }

  function parseString(): InputError | null {
    i++; // 开引号
    while (i < len) {
      const c = text[i];
      if (c === '"') {
        i++;
        return null;
      }
      if (c === '\\') {
        i++;
        if (i >= len) return error('意外结束，转义字符不完整');
        const esc = text[i];
        if ('"\\/bfnrtu'.includes(esc)) {
          if (esc === 'u') {
            for (let k = 1; k <= 4; k++) {
              const h = text[i + k];
              if (h === undefined || !/[0-9a-fA-F]/.test(h)) {
                return error('\\u 转义后必须是 4 位十六进制数字');
              }
            }
            i += 4;
          }
          i++;
        } else {
          return error(`非法转义字符 \\${esc}`);
        }
      } else if (c.charCodeAt(0) < 0x20) {
        return error('字符串中存在未转义的控制字符');
      } else {
        i++;
      }
    }
    return error('意外结束，字符串缺少闭合引号');
  }

  function parseNumber(): InputError | null {
    if (text[i] === '-') i++;
    if (text[i] === '0') {
      i++;
    } else if (text[i] >= '1' && text[i] <= '9') {
      while (text[i] >= '0' && text[i] <= '9') i++;
    } else {
      return error('数字格式非法');
    }
    if (text[i] === '.') {
      i++;
      if (!(text[i] >= '0' && text[i] <= '9')) return error('小数点后必须有数字');
      while (text[i] >= '0' && text[i] <= '9') i++;
    }
    if (text[i] === 'e' || text[i] === 'E') {
      i++;
      if (text[i] === '+' || text[i] === '-') i++;
      if (!(text[i] >= '0' && text[i] <= '9')) return error('指数部分必须有数字');
      while (text[i] >= '0' && text[i] <= '9') i++;
    }
    return null;
  }

  function parseObject(): InputError | null {
    i++; // {
    skipWs();
    if (text[i] === '}') {
      i++;
      return null;
    }
    for (;;) {
      skipWs();
      if (text[i] !== '"') return error('对象键必须是双引号字符串');
      const e1 = parseString();
      if (e1) return e1;
      skipWs();
      if (text[i] !== ':') return error('对象键后缺少冒号');
      i++;
      const e2 = parseValue();
      if (e2) return e2;
      skipWs();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === '}') {
        i++;
        return null;
      }
      return error('对象成员后必须是逗号或右花括号');
    }
  }

  function parseArray(): InputError | null {
    i++; // [
    skipWs();
    if (text[i] === ']') {
      i++;
      return null;
    }
    for (;;) {
      const e = parseValue();
      if (e) return e;
      skipWs();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] === ']') {
        i++;
        return null;
      }
      return error('数组元素后必须是逗号或右方括号');
    }
  }

  const firstError = parseValue();
  if (firstError) return firstError;
  skipWs();
  if (i < len) {
    return { message: `JSON 语法错误（位置 ${i}）：文档结束后仍有多余内容`, offset: i, path: '$' };
  }
  return null;
}

interface LocatorInfo {
  /** 字段值路径 -> 值首个字符的偏移。 */
  paths: Map<string, number>;
  /** 顶层键 -> 键名字符串起始偏移。 */
  rootKeyOffsets: Map<string, number>;
}

/**
 * 第二次扫描原始 JSON 文本，为结构化错误建立路径到偏移的定位表。
 * 语法已经预校验通过，这里可以放心地按 token 推进。
 */
function buildLocator(text: string): LocatorInfo {
  const paths = new Map<string, number>();
  const rootKeyOffsets = new Map<string, number>();
  let i = 0;
  const len = text.length;

  const ws = (): void => {
    while (i < len) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else return;
    }
  };

  function stringLit(): string {
    // 进入时 text[i] === '"'
    let raw = '';
    i++;
    while (i < len) {
      const c = text[i++];
      if (c === '"') return raw;
      if (c === '\\') {
        const esc = text[i++];
        if (esc === 'u') {
          raw += String.fromCharCode(parseInt(text.slice(i, i + 4), 16));
          i += 4;
        } else {
          const simple: Record<string, string> = {
            b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
            '"': '"', '\\': '\\', '/': '/',
          };
          raw += simple[esc] ?? '';
        }
      } else {
        raw += c;
      }
    }
    return raw;
  }

  function skipValue(): void {
    ws();
    const c = text[i];
    if (c === '"') {
      stringLit();
      return;
    }
    if (c === '{') {
      i++;
      ws();
      if (text[i] === '}') {
        i++;
        return;
      }
      for (;;) {
        ws();
        stringLit();
        ws();
        i++; // :
        skipValue();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        i++; // }
        return;
      }
    }
    if (c === '[') {
      i++;
      ws();
      if (text[i] === ']') {
        i++;
        return;
      }
      for (;;) {
        skipValue();
        ws();
        if (text[i] === ',') {
          i++;
          continue;
        }
        i++; // ]
        return;
      }
    }
    // number / true / false / null：跳到首个结构性字符
    while (i < len && !',]} \t\n\r'.includes(text[i])) i++;
  }

  ws();
  i++; // 根对象 {
  ws();
  if (text[i] === '}') return { paths, rootKeyOffsets };
  for (;;) {
    ws();
    const keyStart = i + 1; // 跳过开引号，定位到键名首字符
    const key = stringLit();
    rootKeyOffsets.set(key, keyStart);
    ws();
    i++; // :
    if (key === 'values') {
      locateArray('$.values');
    } else if (key === 'queries') {
      locateQueries();
    } else {
      const valStart = i;
      skipValue();
      paths.set(`$.${key}`, valStart);
    }
    ws();
    if (text[i] === ',') {
      i++;
      continue;
    }
    break;
  }

  function locateArray(path: string): void {
    ws();
    paths.set(path, i);
    i++; // [
    ws();
    if (text[i] === ']') {
      i++;
      return;
    }
    let idx = 0;
    for (;;) {
      ws();
      paths.set(`${path}[${idx}]`, i);
      skipValue();
      idx++;
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      i++; // ]
      return;
    }
  }

  function locateQueries(): void {
    ws();
    paths.set('$.queries', i);
    i++; // [
    ws();
    if (text[i] === ']') {
      i++;
      return;
    }
    let idx = 0;
    for (;;) {
      ws();
      const base = `$.queries[${idx}]`;
      paths.set(base, i);
      i++; // {
      ws();
      if (text[i] === '}') {
        i++;
      } else {
        for (;;) {
          ws();
          const k = stringLit();
          ws();
          i++; // :
          ws();
          paths.set(`${base}.${k}`, i);
          skipValue();
          ws();
          if (text[i] === ',') {
            i++;
            continue;
          }
          i++; // }
          break;
        }
      }
      idx++;
      ws();
      if (text[i] === ',') {
        i++;
        continue;
      }
      i++; // ]
      return;
    }
  }

  return { paths, rootKeyOffsets };
}

function locateKey(text: string, info: LocatorInfo, key: string): number {
  const off = info.rootKeyOffsets.get(key);
  return off ?? text.indexOf(`"${key}"`);
}
