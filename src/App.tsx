import { useMemo, useRef, useState } from 'react';
import { parseInput, type InputError } from './lib/parseInput';
import { VirtualTable } from './VirtualTable';
import { CorrectionTable } from './CorrectionTable';
import type {
  BimodalResult,
  CorrectionSnapshot,
  ModeResult,
  RunSnapshot,
  WorkerResponse,
} from './protocol';

const EXAMPLE = `{
  "values": [-1, 2, -1, 2, 0, 0, -1],
  "queries": [
    { "left": 0, "right": 6 },
    { "left": 1, "right": 3 },
    { "left": 4, "right": 5 }
  ]
}`;

export default function App() {
  const [text, setText] = useState('');
  const [error, setError] = useState<InputError | null>(null);
  // 查询与答案只通过"同一次 Worker 计算"产生的快照呈现；换批时整块置 null，
  // 新答案到达时整块替换，绝不让新文件/新一轮短暂展示上一批的第二名。
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [bimodal, setBimodal] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef(0);

  // ---- 单点更正稳健性分析：独立 Worker 实例与独立 runId 序列 ----
  // 参数（可疑索引、更正范围）以文本形式暂存，点击"开始分析"时才校验并
  // 与当前输入 JSON 一起构成本轮快照；取消或重新分析都会递增 runId 并
  // 终止旧 Worker，迟到回包据此被丢弃，绝不会覆盖新快照。
  const [corrIndexText, setCorrIndexText] = useState('');
  const [corrLoText, setCorrLoText] = useState('');
  const [corrHiText, setCorrHiText] = useState('');
  const [corrSnapshot, setCorrSnapshot] = useState<CorrectionSnapshot | null>(null);
  const [corrRunning, setCorrRunning] = useState(false);
  const [corrError, setCorrError] = useState<string | null>(null);
  const corrWorkerRef = useRef<Worker | null>(null);
  const corrRunIdRef = useRef(0);

  const corrUnstableCount = useMemo(() => {
    if (!corrSnapshot) return 0;
    let c = 0;
    for (const a of corrSnapshot.answers) if (!a.stable) c++;
    return c;
  }, [corrSnapshot]);

  const lastRow = useMemo(() => {
    if (!snapshot || snapshot.answers.length === 0) return null;
    const i = snapshot.answers.length - 1;
    const query = snapshot.queries[i];
    if (snapshot.bimodal) {
      const a = snapshot.answers[i];
      return { index: i + 1, query, first: a.first, second: a.second };
    }
    return { index: i + 1, query, first: snapshot.answers[i], second: null };
  }, [snapshot]);

  function locateError(err: InputError) {
    setError(err);
    const ta = textareaRef.current;
    if (ta && err.offset >= 0) {
      ta.focus();
      try {
        ta.setSelectionRange(err.offset, err.offset + 1);
      } catch {
        /* 部分浏览器对越界偏移抛错，忽略 */
      }
    }
  }

  async function handleRun() {
    // 每次重新计算先清空旧快照，失败时也绝不会残留或输出部分答案。
    runIdRef.current += 1;
    const runId = runIdRef.current;
    setSnapshot(null);
    setError(null);

    const parsed = parseInput(text);
    if ('message' in parsed) {
      locateError(parsed);
      return;
    }

    setRunning(true);

    // 选项与查询同属本轮快照；计算期间再勾选复选框不会污染已提交的结果。
    const wantBimodal = bimodal;
    // values 的 ArrayBuffer 会随 postMessage 转移给 Worker，主线程侧的
    // Int32Array 随即被 neuter（length 变为 0）；规模必须在转移之前记下，
    // 否则状态栏会把读数数量错误显示为 0。
    const valueCount = parsed.values.length;
    const queryCount = parsed.queries.length;
    const parsedQueries = parsed.queries;

    const worker =
      workerRef.current ??
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      // 主巡检通道只处理众数响应；稳健性分析走独立 Worker 实例。
      if (msg.kind === 'correction') return;
      // 过期批次（用户已发起新一轮计算/新文件）的迟到响应直接丢弃。
      if (msg.runId !== runId) return;
      // 协议、结果类型、虚拟列表与导出共用这一个快照对象。
      const { elapsedMs, answers, bimodal: answeredBimodal } = msg;
      setSnapshot(
        answeredBimodal
          ? {
              bimodal: true,
              queries: parsedQueries,
              answers: answers as BimodalResult[],
              n: valueCount,
              q: queryCount,
              elapsedMs,
            }
          : {
              bimodal: false,
              queries: parsedQueries,
              answers: answers as ModeResult[],
              n: valueCount,
              q: queryCount,
              elapsedMs,
            },
      );
      setRunning(false);
    };
    worker.onerror = (e) => {
      setRunning(false);
      locateError({ message: `计算失败：${e.message}`, offset: -1, path: '$' });
    };
    worker.onmessageerror = () => {
      setRunning(false);
      locateError({ message: '计算失败：Worker 消息反序列化错误', offset: -1, path: '$' });
    };
    worker.postMessage(
      { values: parsed.values, queries: parsed.queries, bimodal: wantBimodal, runId },
      [parsed.values.buffer],
    );
  }

  function handlePasteExample() {
    setText(EXAMPLE);
    setError(null);
  }

  function scrollToLast() {
    const el = document.querySelector('.table-scroll');
    if (el) el.scrollTop = el.scrollHeight;
  }

  function handleExport() {
    if (!snapshot) return;
    // 导出来自当前快照：重算或切换双峰选项后旧导出链接不会混入上一批答案。
    const makeResults = () => {
      if (snapshot.bimodal) {
        return snapshot.queries.map((query, i) => {
          const a = snapshot.answers[i];
          return {
            index: i + 1,
            left: query.left,
            right: query.right,
            first: a.first,
            second: a.second,
          };
        });
      }
      return snapshot.queries.map((query, i) => ({
        index: i + 1,
        left: query.left,
        right: query.right,
        mode: snapshot.answers[i],
      }));
    };
    const payload = {
      bimodal: snapshot.bimodal,
      n: snapshot.n,
      q: snapshot.q,
      elapsedMs: snapshot.elapsedMs,
      results: makeResults(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `axle-mode-results${snapshot.bimodal ? '-bimodal' : ''}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /** 解析有符号 32 位整数文本参数；返回数值或中文错误说明。 */
  function parseInt32Param(raw: string, label: string): number | string {
    const t = raw.trim();
    if (!/^-?\d+$/.test(t)) return `${label}必须是整数（当前："${raw}"）`;
    const v = Number(t);
    if (v < -2147483648 || v > 2147483647) {
      return `${label}必须落在有符号 32 位整数范围 [-2147483648, 2147483647]：${t}`;
    }
    return v;
  }

  function handleCorrectionRun() {
    // 与主巡检一致：每次发起先递增编号并清空旧快照，失败时不残留部分答案。
    corrRunIdRef.current += 1;
    const runId = corrRunIdRef.current;
    setCorrSnapshot(null);
    setCorrError(null);

    const parsed = parseInput(text);
    if ('message' in parsed) {
      // 输入 JSON 本身的错误沿用主错误面板（定位首个错误、选中错误字符）。
      locateError(parsed);
      return;
    }

    const index = parseInt32Param(corrIndexText, '可疑索引');
    if (typeof index === 'string') {
      setCorrError(index);
      return;
    }
    if (index < 0 || index >= parsed.values.length) {
      setCorrError(`可疑索引越界：${index}，要求 0 ≤ index < ${parsed.values.length}`);
      return;
    }
    const lo = parseInt32Param(corrLoText, '更正范围最小值');
    if (typeof lo === 'string') {
      setCorrError(lo);
      return;
    }
    const hi = parseInt32Param(corrHiText, '更正范围最大值');
    if (typeof hi === 'string') {
      setCorrError(hi);
      return;
    }
    if (lo > hi) {
      setCorrError(`更正范围非法：最小值 ${lo} 大于最大值 ${hi}`);
      return;
    }

    setCorrRunning(true);

    // 参数、查询与规模同属本轮快照；values 的 buffer 转移给 Worker 后
    // 主线程侧即被 neuter，规模必须在转移之前记下。
    const valueCount = parsed.values.length;
    const queryCount = parsed.queries.length;
    const parsedQueries = parsed.queries;
    const correction = { index, lo, hi };

    const worker =
      corrWorkerRef.current ??
      new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    corrWorkerRef.current = worker;

    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      if (msg.kind !== 'correction') return;
      // 取消或新一轮分析后的迟到回包直接丢弃，绝不覆盖当前快照。
      if (msg.runId !== corrRunIdRef.current) return;
      setCorrSnapshot({
        correction: msg.correction,
        queries: parsedQueries,
        answers: msg.answers,
        n: valueCount,
        q: queryCount,
        elapsedMs: msg.elapsedMs,
      });
      setCorrRunning(false);
    };
    worker.onerror = (e) => {
      if (runId !== corrRunIdRef.current) return;
      setCorrRunning(false);
      setCorrError(`分析失败：${e.message}`);
    };
    worker.onmessageerror = () => {
      if (runId !== corrRunIdRef.current) return;
      setCorrRunning(false);
      setCorrError('分析失败：Worker 消息反序列化错误');
    };
    worker.postMessage(
      { kind: 'correction', values: parsed.values, queries: parsed.queries, correction, runId },
      [parsed.values.buffer],
    );
  }

  function handleCorrectionCancel() {
    // 递增编号使任何迟到回包失效，并直接终止 Worker 本体（而非仅忽略结果），
    // 下一次分析会创建全新 Worker，旧计算不会再占用 CPU。
    corrRunIdRef.current += 1;
    corrWorkerRef.current?.terminate();
    corrWorkerRef.current = null;
    setCorrRunning(false);
  }

  function handleCorrectionExport() {
    if (!corrSnapshot) return;
    // 导出来自当前分析快照：重新分析或取消后旧导出不会混入上一批结论。
    const s = corrSnapshot;
    const payload = {
      kind: 'correction',
      index: s.correction.index,
      lo: s.correction.lo,
      hi: s.correction.hi,
      n: s.n,
      q: s.q,
      elapsedMs: s.elapsedMs,
      results: s.queries.map((query, i) => {
        const a = s.answers[i];
        return {
          index: i + 1,
          left: query.left,
          right: query.right,
          mode: a.original,
          affected: a.affected,
          stable: a.stable,
          minReplacement: a.minReplacement,
          changed: a.changed,
        };
      }),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'axle-correction-results.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="app">
      <header className="app-header">
        <h1>夜间列车轴温 · 区间众数巡检</h1>
        <p className="subtitle">
          粘贴普通 JSON：values 为 1～200000 个有符号 32 位整数，queries 为 1～200000 个
          {' '}<code>left</code>/<code>right</code> 闭区间。返回按原顺序排列的众数（并列取较小值）与频次。
        </p>
      </header>

      <section className="panel">
        <div className="panel-toolbar">
          <button type="button" className="btn primary" onClick={handleRun} disabled={running} data-testid="run-button">
            {running ? '巡检计算中…' : '解析并巡检'}
          </button>
          <button type="button" className="btn" onClick={handlePasteExample} disabled={running} data-testid="example-button">
            填入示例
          </button>
          <label className="option-toggle" data-testid="bimodal-toggle">
            <input
              type="checkbox"
              checked={bimodal}
              onChange={(e) => setBimodal(e.target.checked)}
              disabled={running}
              data-testid="bimodal-checkbox"
            />
            双峰复核（返回前两个不同读数及频次，频次降序、读数升序）
          </label>
          {error && (
            <span className="error-summary" data-testid="error-summary">
              ✗ {error.path}（偏移 {error.offset}）
            </span>
          )}
        </div>
        <textarea
          ref={textareaRef}
          className="json-input"
          spellCheck={false}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"values": [1, 2, 2, -3], "queries": [{"left": 0, "right": 3}]}'
          data-testid="json-input"
        />
        {error && (
          <div className="error-box" role="alert" data-testid="error-box">
            <div className="error-line">
              <strong>首个错误：</strong>
              {error.message}
            </div>
            <div className="error-meta">
              定位路径：<code>{error.path}</code>　字符偏移：<code>{error.offset}</code>
            </div>
          </div>
        )}
      </section>

      {snapshot && (
        <section className="panel status-panel" data-testid="status-panel">
          <span>
            读数 <strong>{snapshot.n}</strong> 条 · 查询 <strong>{snapshot.q}</strong> 个 ·
            算法耗时 <strong>{snapshot.elapsedMs.toFixed(1)}</strong> ms
            {snapshot.bimodal && <span className="snapshot-tag" data-testid="bimodal-badge">· 双峰复核</span>}
          </span>
          <span className="status-actions">
            <button type="button" className="btn small" onClick={handleExport} data-testid="export-button">
              导出结果 JSON
            </button>
            {lastRow && (
              <span className="last-row" data-testid="last-row">
                末行（第 {lastRow.index} 个）：[{lastRow.query.left}, {lastRow.query.right}] →
                众数 <strong>{lastRow.first.value}</strong>，频次 <strong>{lastRow.first.count}</strong>
                {snapshot.bimodal && (
                  <>
                    {' '}· 第二读数{' '}
                    {lastRow.second ? (
                      <>
                        <strong data-testid="last-row-second-value">{lastRow.second.value}</strong>，
                        频次 <strong data-testid="last-row-second-count">{lastRow.second.count}</strong>
                      </>
                    ) : (
                      <strong data-testid="last-row-second-empty">空</strong>
                    )}
                  </>
                )}
                <button type="button" className="btn small" onClick={scrollToLast}>
                  滚动到末行
                </button>
              </span>
            )}
          </span>
        </section>
      )}

      {snapshot && (
        <section className="panel table-panel" data-testid="result-panel">
          <VirtualTable snapshot={snapshot} />
        </section>
      )}

      <section className="panel" data-testid="correction-panel">
        <div className="panel-toolbar">
          <span className="panel-title">单点更正稳健性</span>
          <label className="field">
            可疑索引
            <input
              type="text"
              inputMode="numeric"
              spellCheck={false}
              value={corrIndexText}
              onChange={(e) => setCorrIndexText(e.target.value)}
              disabled={corrRunning}
              placeholder="0"
              data-testid="correction-index"
            />
          </label>
          <label className="field">
            更正范围
            <input
              type="text"
              inputMode="numeric"
              spellCheck={false}
              value={corrLoText}
              onChange={(e) => setCorrLoText(e.target.value)}
              disabled={corrRunning}
              placeholder="-2147483648"
              data-testid="correction-lo"
            />
          </label>
          <span className="range-sep">~</span>
          <label className="field">
            <span className="sr-only">更正范围最大值</span>
            <input
              type="text"
              inputMode="numeric"
              spellCheck={false}
              value={corrHiText}
              onChange={(e) => setCorrHiText(e.target.value)}
              disabled={corrRunning}
              placeholder="2147483647"
              data-testid="correction-hi"
            />
          </label>
          <button
            type="button"
            className="btn primary"
            onClick={handleCorrectionRun}
            disabled={corrRunning}
            data-testid="correction-run"
          >
            {corrRunning ? '稳健性分析中…' : '开始稳健性分析'}
          </button>
          {corrRunning && (
            <button type="button" className="btn" onClick={handleCorrectionCancel} data-testid="correction-cancel">
              取消
            </button>
          )}
        </div>
        <p className="panel-hint">
          怀疑 <code>values[可疑索引]</code> 录错但复测值未回：把该读数替换为更正范围内任意值时，
          各区间众数是否可能改变？逐查询给出原众数、是否稳健，以及（不稳时）使众数变化的
          最小替换值与替换后的新众数、频次。不改变上方输入 JSON 契约。
        </p>
        {corrError && (
          <div className="error-box" role="alert" data-testid="correction-error">
            <div className="error-line">
              <strong>参数错误：</strong>
              {corrError}
            </div>
          </div>
        )}
      </section>

      {corrSnapshot && (
        <section className="panel status-panel" data-testid="correction-status">
          <span>
            可疑索引 <strong>{corrSnapshot.correction.index}</strong> · 更正范围{' '}
            <strong>
              [{corrSnapshot.correction.lo}, {corrSnapshot.correction.hi}]
            </strong>{' '}
            · 读数 <strong>{corrSnapshot.n}</strong> 条 · 查询 <strong>{corrSnapshot.q}</strong> 个 ·
            算法耗时 <strong>{corrSnapshot.elapsedMs.toFixed(1)}</strong> ms · 可能改变众数的查询{' '}
            <strong data-testid="correction-unstable-count">{corrUnstableCount}</strong> 个
          </span>
          <span className="status-actions">
            <button type="button" className="btn small" onClick={handleCorrectionExport} data-testid="correction-export">
              导出分析 JSON
            </button>
          </span>
        </section>
      )}

      {corrSnapshot && (
        <section className="panel table-panel" data-testid="correction-result-panel">
          <CorrectionTable snapshot={corrSnapshot} />
        </section>
      )}
    </div>
  );
}
