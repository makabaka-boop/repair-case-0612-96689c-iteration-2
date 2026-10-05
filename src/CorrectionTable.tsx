import { useEffect, useRef, useState } from 'react';
import type { CorrectionSnapshot } from './protocol';

interface CorrectionTableProps {
  snapshot: CorrectionSnapshot;
}

const ROW_HEIGHT = 30;
const OVERSCAN = 12;

/**
 * 单点更正稳健性结果表：仅渲染可视区行。每行绑定同一快照中的查询与结论，
 * 换批/重新分析时整块替换，绝不展示上一批的替换值与新众数。
 */
export function CorrectionTable({ snapshot }: CorrectionTableProps) {
  const { answers, queries } = snapshot;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(480);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setViewportHeight(entries[0].contentRect.height);
    });
    observer.observe(el);
    setViewportHeight(el.clientHeight);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
    setScrollTop(0);
    // 跟随快照：重新分析后重置到顶部，绝不展示上一批的残留行。
  }, [snapshot]);

  const total = answers.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    total,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  // 与主结果表相同：上下占位行撑开未渲染区域，保证滚动总高度等于全部行高。
  const topPad = startIndex * ROW_HEIGHT;
  const bottomPad = (total - endIndex) * ROW_HEIGHT;
  const colSpan = 9;

  const rows: JSX.Element[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const q = queries[i];
    const a = answers[i];
    rows.push(
      <tr
        key={i}
        className={i % 2 === 0 ? 'row-even' : 'row-odd'}
        style={{ height: ROW_HEIGHT }}
      >
        <td className="col-index" data-label="序号">
          {i + 1}
        </td>
        <td className="col-range" data-label="边界">
          [{q.left}, {q.right}]
        </td>
        <td className="col-mode" data-label="原众数" data-testid={`corr-original-value-${i}`}>
          {a.original.value}
        </td>
        <td className="col-count" data-label="原频次" data-testid={`corr-original-count-${i}`}>
          {a.original.count}
        </td>
        <td className="col-affected" data-label="含可疑点" data-testid={`corr-affected-${i}`}>
          {a.affected ? '是' : '否'}
        </td>
        <td
          className={a.stable ? 'col-stable' : 'col-stable unstable'}
          data-label="稳健"
          data-testid={`corr-stable-${i}`}
        >
          {a.stable ? '是' : '否'}
        </td>
        <td className="col-replacement" data-label="最小替换值" data-testid={`corr-replacement-${i}`}>
          {a.minReplacement ?? <span className="empty-mark">—</span>}
        </td>
        <td className="col-new-mode" data-label="新众数" data-testid={`corr-new-value-${i}`}>
          {a.changed ? a.changed.value : <span className="empty-mark">—</span>}
        </td>
        <td className="col-new-count" data-label="新频次" data-testid={`corr-new-count-${i}`}>
          {a.changed ? a.changed.count : <span className="empty-mark">—</span>}
        </td>
      </tr>,
    );
  }

  return (
    <div className="table-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <table className="result-table correction-table">
        <thead className="result-head">
          <tr style={{ height: ROW_HEIGHT }}>
            <th className="col-index">序号</th>
            <th className="col-range">边界 [left, right]</th>
            <th className="col-mode">原众数</th>
            <th className="col-count">原频次</th>
            <th className="col-affected">含可疑点</th>
            <th className="col-stable">稳健</th>
            <th className="col-replacement">最小替换值</th>
            <th className="col-new-mode">新众数</th>
            <th className="col-new-count">新频次</th>
          </tr>
        </thead>
        <tbody>
          {topPad > 0 && (
            <tr aria-hidden="true" style={{ height: topPad }}>
              <td colSpan={colSpan} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
          {rows}
          {bottomPad > 0 && (
            <tr aria-hidden="true" style={{ height: bottomPad }}>
              <td colSpan={colSpan} style={{ padding: 0, border: 'none' }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
