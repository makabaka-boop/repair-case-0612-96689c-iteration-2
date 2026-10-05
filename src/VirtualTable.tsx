import { useEffect, useRef, useState } from 'react';
import type { RunSnapshot } from './protocol';

interface VirtualTableProps {
  snapshot: RunSnapshot;
}

const ROW_HEIGHT = 30;
const OVERSCAN = 12;

/** 可滚动结果表：仅渲染可视区行，20 万行也能流畅浏览，且保持原顺序。 */
export function VirtualTable({ snapshot }: VirtualTableProps) {
  const { answers, queries } = snapshot;
  const bimodal = snapshot.kind === 'bimodal';
  const robust = snapshot.kind === 'robust';
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
    // 跟随快照：换批或切换分析模式后重置到顶部，绝不展示上一批的残留行。
  }, [snapshot]);

  const total = answers.length;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    total,
    Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN,
  );

  // 虚拟列表必须把未渲染行的高度撑开：上下各放一个 aria-hidden 占位行，
  // 使滚动内容总高度等于全部行的高度。否则 scrollHeight 只覆盖已渲染的
  // 数十行，"滚动到末行"（scrollTop = scrollHeight）永远到不了第 20 万行。
  const topPad = startIndex * ROW_HEIGHT;
  const bottomPad = (total - endIndex) * ROW_HEIGHT;
  const colSpan = bimodal ? 6 : robust ? 8 : 4;

  const rows: JSX.Element[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const q = queries[i];
    let modeValue: number;
    let modeCount: number;
    let cells: JSX.Element | null = null;
    if (bimodal) {
      const a = answers[i] as Extract<RunSnapshot, { kind: 'bimodal' }>['answers'][number];
      modeValue = a.first.value;
      modeCount = a.first.count;
      cells = (
        <>
          <td className="col-second-mode" data-label="第二读数" data-testid={`second-value-${i}`}>
            {a.second ? a.second.value : <span className="empty-mark">空</span>}
          </td>
          <td className="col-second-count" data-label="第二频次" data-testid={`second-count-${i}`}>
            {a.second ? a.second.count : <span className="empty-mark">空</span>}
          </td>
        </>
      );
    } else if (robust) {
      const a = answers[i] as Extract<RunSnapshot, { kind: 'robust' }>['answers'][number];
      modeValue = a.originalMode.value;
      modeCount = a.originalMode.count;
      cells = (
        <>
          <td className="col-affected" data-label="含可疑位" data-testid={`robust-affected-${i}`}>
            {a.affected ? '是' : <span className="empty-mark">否</span>}
          </td>
          <td className="col-invariant" data-label="范围稳健" data-testid={`robust-invariant-${i}`}>
            {a.invariant ? (
              <span className="invariant-yes">保持</span>
            ) : (
              <span className="invariant-no">改变</span>
            )}
          </td>
          <td className="col-change-value" data-label="最小变更值" data-testid={`robust-x-${i}`}>
            {a.firstChange ? a.firstChange.replacementValue : <span className="empty-mark">—</span>}
          </td>
          <td className="col-change-mode" data-label="新众数/频次" data-testid={`robust-newmode-${i}`}>
            {a.firstChange ? (
              <>
                {a.firstChange.mode.value}
                <span className="new-count"> / {a.firstChange.mode.count}</span>
              </>
            ) : (
              <span className="empty-mark">—</span>
            )}
          </td>
        </>
      );
    } else {
      const a = answers[i] as Extract<RunSnapshot, { kind: 'normal' }>['answers'][number];
      modeValue = a.value;
      modeCount = a.count;
      cells = null;
    }
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
        <td className="col-mode" data-label="众数">
          {modeValue}
        </td>
        <td className="col-count" data-label="频次">
          {modeCount}
        </td>
        {cells}
      </tr>,
    );
  }

  return (
    <div className="table-scroll" ref={scrollRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <table className="result-table">
        <thead className="result-head">
          <tr style={{ height: ROW_HEIGHT }}>
            <th className="col-index">序号</th>
            <th className="col-range">边界 [left, right]</th>
            <th className="col-mode">众数</th>
            <th className="col-count">频次</th>
            {bimodal && (
              <>
                <th className="col-second-mode">第二读数（双峰复核）</th>
                <th className="col-second-count">第二频次</th>
              </>
            )}
            {robust && (
              <>
                <th className="col-affected">含可疑下标</th>
                <th className="col-invariant">范围内众数</th>
                <th className="col-change-value">最小变更值</th>
                <th className="col-change-mode">新众数 / 频次</th>
              </>
            )}
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
