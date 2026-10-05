import { useMemo, useRef, useState } from 'react';
import { parseInput, type InputError } from './lib/parseInput';
import { VirtualTable } from './VirtualTable';
import type { BimodalResult, ModeResult, RunSnapshot, WorkerResponse } from './protocol';

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
      // 过期批次（用户已发起新一轮计算/新文件）的迟到响应直接丢弃。
      if (ev.data.runId !== runId) return;
      // 协议、结果类型、虚拟列表与导出共用这一个快照对象。
      const { elapsedMs, answers, bimodal: answeredBimodal } = ev.data;
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
    </div>
  );
}
