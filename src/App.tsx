import { useMemo, useRef, useState } from 'react';
import { parseInput, type InputError } from './lib/parseInput';
import { parseRobustParams } from './lib/robustInput';
import { VirtualTable } from './VirtualTable';
import type {
  BimodalResult,
  ModeResult,
  RobustParams,
  RobustResult,
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
  // 新答案到达时整块替换，绝不让新文件/新一轮短暂展示上一批的答案。
  const [snapshot, setSnapshot] = useState<RunSnapshot | null>(null);
  const [running, setRunning] = useState(false);
  const [bimodal, setBimodal] = useState(false);
  // 一次性单点更正稳健性分析开关与三个参数控件（不进入输入 JSON 契约）。
  const [robustOn, setRobustOn] = useState(false);
  const [robustIndex, setRobustIndex] = useState('0');
  const [robustMin, setRobustMin] = useState('-2147483648');
  const [robustMax, setRobustMax] = useState('2147483647');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const runIdRef = useRef(0);

  const lastRow = useMemo(() => {
    if (!snapshot || snapshot.answers.length === 0) return null;
    const i = snapshot.answers.length - 1;
    const query = snapshot.queries[i];
    if (snapshot.kind === 'bimodal') {
      const a = snapshot.answers[i];
      return { kind: 'bimodal' as const, index: i + 1, query, first: a.first, second: a.second };
    }
    if (snapshot.kind === 'robust') {
      const a = snapshot.answers[i];
      return { kind: 'robust' as const, index: i + 1, query, result: a };
    }
    return { kind: 'normal' as const, index: i + 1, query, first: snapshot.answers[i] };
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
    // 每次重新计算先领取新 runId 并清空旧快照：过期 Worker 回包按 runId
    // 丢弃，取消/发起新分析绝不会被旧 Worker 的迟到响应覆盖。
    runIdRef.current += 1;
    const runId = runIdRef.current;
    setSnapshot(null);
    setError(null);

    const parsed = parseInput(text);
    if ('message' in parsed) {
      locateError(parsed);
      return;
    }

    // 稳健性参数与 values/queries 同属本轮输入快照；先于提交校验。
    let robustParams: RobustParams | null = null;
    if (robustOn) {
      const r = parseRobustParams(
        { indexText: robustIndex, minText: robustMin, maxText: robustMax },
        parsed.values.length,
      );
      if (!r.ok) {
        locateError({ message: r.message, offset: -1, path: '$.robust' });
        return;
      }
      robustParams = r.params;
    }
    // 双峰与稳健性互斥：稳健性开启时强制按普通频次表分析。
    const wantBimodal = bimodal && !robustParams;

    setRunning(true);

    // 选项与查询同属本轮快照；计算期间再勾选复选框不会污染已提交的结果。
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
      // 过期批次（用户已发起新一轮计算/新分析）的迟到响应直接丢弃。
      if (ev.data.runId !== runId) return;
      // 协议、结果类型、虚拟列表与导出共用这一个快照对象。
      const { elapsedMs, answers, bimodal: answeredBimodal, robust: answeredRobust } = ev.data;
      if (answeredRobust) {
        setSnapshot({
          kind: 'robust',
          bimodal: false,
          robust: answeredRobust,
          queries: parsedQueries,
          answers: answers as RobustResult[],
          n: valueCount,
          q: queryCount,
          elapsedMs,
        });
      } else if (answeredBimodal) {
        setSnapshot({
          kind: 'bimodal',
          bimodal: true,
          queries: parsedQueries,
          answers: answers as BimodalResult[],
          n: valueCount,
          q: queryCount,
          elapsedMs,
        });
      } else {
        setSnapshot({
          kind: 'normal',
          bimodal: false,
          queries: parsedQueries,
          answers: answers as ModeResult[],
          n: valueCount,
          q: queryCount,
          elapsedMs,
        });
      }
      setRunning(false);
    };
    worker.onerror = (e) => {
      if (runId !== runIdRef.current) return;
      setRunning(false);
      locateError({ message: `计算失败：${e.message}`, offset: -1, path: '$' });
    };
    worker.onmessageerror = () => {
      if (runId !== runIdRef.current) return;
      setRunning(false);
      locateError({ message: '计算失败：Worker 消息反序列化错误', offset: -1, path: '$' });
    };
    worker.postMessage(
      {
        values: parsed.values,
        queries: parsed.queries,
        bimodal: wantBimodal,
        robust: robustParams,
        runId,
      },
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
    // 导出来自当前快照：重算、切换双峰或发起新稳健性分析后旧导出链接不会
    // 混入上一批答案。
    const makeResults = () => {
      if (snapshot.kind === 'bimodal') {
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
      if (snapshot.kind === 'robust') {
        const { index, minValue, maxValue } = snapshot.robust;
        return snapshot.queries.map((query, i) => {
          const a = snapshot.answers[i];
          return {
            index: i + 1,
            left: query.left,
            right: query.right,
            affected: a.affected,
            originalMode: a.originalMode,
            invariant: a.invariant,
            firstChange: a.firstChange,
            // 每条答案与其分析参数来自同一快照，参数随每条结果冗余导出，
            // 便于离线核对"哪个下标、哪段更正范围"。
            robust: { suspectIndex: index, minValue, maxValue },
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
      kind: snapshot.kind,
      bimodal: snapshot.kind === 'bimodal',
      ...(snapshot.kind === 'robust'
        ? { robust: snapshot.robust }
        : {}),
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
    a.download =
      snapshot.kind === 'bimodal'
        ? 'axle-mode-results-bimodal.json'
        : snapshot.kind === 'robust'
          ? 'axle-mode-results-robust.json'
          : 'axle-mode-results.json';
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
              checked={bimodal && !robustOn}
              onChange={(e) => setBimodal(e.target.checked)}
              disabled={running || robustOn}
              data-testid="bimodal-checkbox"
            />
            双峰复核（返回前两个不同读数及频次，频次降序、读数升序）
          </label>
          <label className="option-toggle" data-testid="robust-toggle">
            <input
              type="checkbox"
              checked={robustOn}
              onChange={(e) => setRobustOn(e.target.checked)}
              disabled={running}
              data-testid="robust-checkbox"
            />
            单点更正稳健性（先移除原读数，再判定允许更正闭区间内是否会改变众数）
          </label>
          {error && (
            <span className="error-summary" data-testid="error-summary">
              ✗ {error.path}（偏移 {error.offset}）
            </span>
          )}
        </div>

        {robustOn && (
          <div className="robust-bar" data-testid="robust-bar">
            <label className="robust-field">
              可疑下标
              <input
                type="text"
                className="robust-input"
                inputMode="numeric"
                value={robustIndex}
                onChange={(e) => setRobustIndex(e.target.value)}
                disabled={running}
                data-testid="robust-index"
              />
            </label>
            <label className="robust-field">
              替换最小值
              <input
                type="text"
                className="robust-input"
                inputMode="numeric"
                value={robustMin}
                onChange={(e) => setRobustMin(e.target.value)}
                disabled={running}
                data-testid="robust-min"
              />
            </label>
            <label className="robust-field">
              替换最大值
              <input
                type="text"
                className="robust-input"
                inputMode="numeric"
                value={robustMax}
                onChange={(e) => setRobustMax(e.target.value)}
                disabled={running}
                data-testid="robust-max"
              />
            </label>
            <span className="robust-hint">
              闭区间内为有符号 32 位整数；区间不含可疑下标的查询直接沿用原众数。
            </span>
          </div>
        )}

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
            {snapshot.kind === 'bimodal' && (
              <span className="snapshot-tag" data-testid="bimodal-badge">· 双峰复核</span>
            )}
            {snapshot.kind === 'robust' && (
              <span className="snapshot-tag robust-tag" data-testid="robust-badge">
                · 单点更正稳健性（下标 {snapshot.robust.index}，范围
                [{snapshot.robust.minValue}, {snapshot.robust.maxValue}]）
              </span>
            )}
          </span>
          <span className="status-actions">
            <button type="button" className="btn small" onClick={handleExport} data-testid="export-button">
              导出结果 JSON
            </button>
            {lastRow && (
              <span className="last-row" data-testid="last-row">
                末行（第 {lastRow.index} 个）：[{lastRow.query.left}, {lastRow.query.right}] →
                {lastRow.kind === 'robust' ? (
                  (() => {
                    const a = lastRow.result;
                    return (
                      <>
                        {' '}原众数 <strong>{a.originalMode.value}</strong>，
                        频次 <strong>{a.originalMode.count}</strong>
                        {a.affected ? (
                          a.invariant ? (
                            <span data-testid="last-row-robust-invariant">· 范围内保持不变</span>
                          ) : (
                            <span data-testid="last-row-robust-change">
                              {' '}· 最小变更值 <strong>{a.firstChange!.replacementValue}</strong>
                              {' '}→ 新众数 <strong>{a.firstChange!.mode.value}</strong>，
                              频次 <strong>{a.firstChange!.mode.count}</strong>
                            </span>
                          )
                        ) : (
                          <span data-testid="last-row-robust-unaffected">· 区间不含可疑下标</span>
                        )}
                      </>
                    );
                  })()
                ) : (
                  <>
                    {' '}众数 <strong>{lastRow.first.value}</strong>，
                    频次 <strong>{lastRow.first.count}</strong>
                    {lastRow.kind === 'bimodal' && (
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
    </div>
  );
}
