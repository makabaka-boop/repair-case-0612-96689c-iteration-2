import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

/** 构造 20 万读数 + 20 万查询的对抗批次：大区间与单点交替，末区间为全数组。 */
function buildAdversarialBatch(): { json: string; first: { left: number; right: number } } {
  const n = 200_000;
  const q = 200_000;

  let seed = 20260916 >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const values = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    values[i] = (i % 1000 === 0) ? 424242 : Math.floor(rand() * 30000) - 15000;
  }

  const queries = new Array<{ left: number; right: number }>(q);
  for (let i = 0; i < q - 1; i++) {
    if ((i & 1) === 0) {
      const l = Math.floor(rand() * 1000);
      queries[i] = { left: l, right: n - 1 - Math.floor(rand() * 1000) };
    } else {
      const p = Math.floor(rand() * n);
      queries[i] = { left: p, right: p };
    }
  }
  // 全数组区间：哨兵值 424242 出现 200 次，是可核对的唯一末行答案
  queries[q - 1] = { left: 0, right: n - 1 };

  return { json: JSON.stringify({ values, queries }), first: queries[0] };
}

test.describe('区间众数巡检 UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
  });

  test('粘贴小样本并核对并列裁决与结果表', async ({ page }) => {
    const input = page.getByTestId('json-input');
    const payload = JSON.stringify({
      values: [5, -5, 5, -5, 0],
      queries: [
        { left: 0, right: 4 }, // 5 与 -5 各 2 次 → -5
        { left: 0, right: 2 }, // 5 两次 → 5
        { left: 4, right: 4 }, // 0
      ],
    });
    await input.click();
    await page.keyboard.insertText(payload);
    await page.getByTestId('run-button').click();

    await expect(page.getByTestId('status-panel')).toBeVisible();
    const rows = page.locator('.result-table tbody tr:not([aria-hidden="true"])');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('-5');
    await expect(rows.nth(0)).toContainText('2');
    await expect(rows.nth(1)).toContainText('5');
    await expect(rows.nth(2)).toContainText('0');

    // 末行核对
    await expect(page.getByTestId('last-row')).toContainText('众数 0');
    await expect(page.getByTestId('last-row')).toContainText('频次 1');
  });

  test('示例按钮可填入并完成计算', async ({ page }) => {
    await page.getByTestId('example-button').click();
    await expect(page.getByTestId('json-input')).toContainText('"values"');
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('status-panel')).toBeVisible();
    await expect(page.getByTestId('last-row')).toContainText('众数 0');
  });

  test('非法输入：定位首个错误、清空旧结果、不输出部分答案', async ({ page }) => {
    // 先得到一份有效结果
    await page.getByTestId('json-input').click();
    await page.keyboard.insertText(
      JSON.stringify({
        values: [1, 1, 2],
        queries: [{ left: 0, right: 2 }],
      }),
    );
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('result-panel')).toBeVisible();

    // 改为非法输入（非整数）
    const input = page.getByTestId('json-input');
    await input.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(
      JSON.stringify({ values: [1, 2.5, 3], queries: [{ left: 0, right: 2 }] }),
    );
    await page.getByTestId('run-button').click();

    const errorBox = page.getByTestId('error-box');
    await expect(errorBox).toBeVisible();
    await expect(errorBox).toContainText('$.values[1]');
    await expect(errorBox).toContainText('小数');
    // 旧结果已清空
    await expect(page.getByTestId('result-panel')).toHaveCount(0);
    await expect(page.getByTestId('status-panel')).toHaveCount(0);

    // 非法区间也被拒绝
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(
      JSON.stringify({ values: [1, 2], queries: [{ left: 1, right: 0 }] }),
    );
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('error-box')).toContainText('$.queries[0].left');
  });

  test('未知字段与越界区间报错', async ({ page }) => {
    const input = page.getByTestId('json-input');
    await input.click();
    await page.keyboard.insertText(
      JSON.stringify({
        values: [1, 2],
        queries: [{ left: 0, right: 5 }],
      }),
    );
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('error-box')).toContainText('$.queries[0].right');

    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(
      '{"values":[1],"queries":[{"left":0,"right":0}],"extra":true}',
    );
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('error-box')).toContainText('$.extra');
  });

  test('双峰复核：第二名按频次降序、读数升序；唯一读数第二名为空', async ({ page }) => {
    const input = page.getByTestId('json-input');
    const payload = JSON.stringify({
      // -5 ×2、5 ×2、0 ×1；全区间：前二 -5(2)、5(2)
      values: [5, -5, 5, -5, 0],
      queries: [
        { left: 0, right: 4 }, // -5(2), 5(2)
        { left: 4, right: 4 }, // 仅 0：第二名明确为空
        { left: 0, right: 2 }, // 5(2), -5(1)
      ],
    });
    await input.click();
    await page.keyboard.insertText(payload);
    await page.getByTestId('bimodal-checkbox').check();
    await page.getByTestId('run-button').click();

    await expect(page.getByTestId('status-panel')).toBeVisible();
    await expect(page.getByTestId('bimodal-badge')).toBeVisible();

    const rows = page.locator('.result-table tbody tr:not([aria-hidden="true"])');
    await expect(rows).toHaveCount(3);
    // 首行：-5 / 2，第二读数 5 / 2（频次并列取较大读数为第二）
    await expect(rows.nth(0).locator('.col-mode')).toHaveText('-5');
    await expect(rows.nth(0).locator('.col-count')).toHaveText('2');
    await expect(rows.nth(0).locator('.col-second-mode')).toHaveText('5');
    await expect(rows.nth(0).locator('.col-second-count')).toHaveText('2');
    // 第二行：窗口只有一种读数，第二名两格明确为"空"
    await expect(rows.nth(1).locator('.col-mode')).toHaveText('0');
    await expect(rows.nth(1).locator('.col-second-mode')).toHaveText('空');
    await expect(rows.nth(1).locator('.col-second-count')).toHaveText('空');
    // 第三行：5(2) 第一，-5(1) 第二
    await expect(rows.nth(2).locator('.col-mode')).toHaveText('5');
    await expect(rows.nth(2).locator('.col-second-mode')).toHaveText('-5');
    await expect(rows.nth(2).locator('.col-second-count')).toHaveText('1');

    // 末行状态栏同样展示第二名
    await expect(page.getByTestId('last-row')).toContainText('第二读数 -5');
    await expect(page.getByTestId('last-row-second-count')).toHaveText('1');
  });

  test('双峰复核导出的 JSON 来自同一查询快照（含 null 第二名）', async ({ page }) => {
    await page.getByTestId('json-input').click();
    await page.keyboard.insertText(
      JSON.stringify({
        values: [7, 7, 3],
        queries: [{ left: 0, right: 2 }, { left: 0, right: 1 }],
      }),
    );
    await page.getByTestId('bimodal-checkbox').check();
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('status-panel')).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-button').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('bimodal');
    const path = await download.path();
    const text = path ? await readFile(path, 'utf8') : '';
    const data = JSON.parse(text);
    expect(data.bimodal).toBe(true);
    expect(data.results[0].first).toEqual({ value: 7, count: 2 });
    expect(data.results[0].second).toEqual({ value: 3, count: 1 });
    // 单一读数窗口的第二名必须序列化为 null
    expect(data.results[1].second).toBeNull();
  });

  test('换批隔离：双峰/普通批次之间绝不短暂展示上一批的第二名', async ({ page }) => {
    const input = page.getByTestId('json-input');

    // 第一批：双峰，首行有第二名 -5
    await input.click();
    await page.keyboard.insertText(
      JSON.stringify({
        values: [5, -5, 5, -5, 0],
        queries: [{ left: 0, right: 4 }],
      }),
    );
    await page.getByTestId('bimodal-checkbox').check();
    await page.getByTestId('run-button').click();
    await expect(page.locator('tbody .col-second-mode')).toHaveText('5');
    await expect(page.getByTestId('bimodal-badge')).toBeVisible();

    // 第二批：取消双峰重算。结果表只剩 4 列，旧批次的第二名列立即消失，
    // 任何时刻都不会出现"新第一批 + 上一批第二名"。
    await page.getByTestId('bimodal-checkbox').uncheck();
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('bimodal-badge')).toHaveCount(0);
    await expect(page.locator('tbody .col-second-mode')).toHaveCount(0);
    await expect(page.locator('tbody .col-second-count')).toHaveCount(0);
    const rows = page.locator('.result-table tbody tr:not([aria-hidden="true"])');
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('.col-mode')).toHaveText('-5');
    await expect(rows.nth(0).locator('.col-count')).toHaveText('2');

    // 第三批：重新勾选双峰跑一个全相等批次，第二名必须是"空"，
    // 而不是残留第二批上一批窗口的 5。
    await page.getByTestId('json-input').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.insertText(
      JSON.stringify({
        values: [9, 9, 9],
        queries: [{ left: 0, right: 2 }],
      }),
    );
    await page.getByTestId('bimodal-checkbox').check();
    await page.getByTestId('run-button').click();
    await expect(page.getByTestId('bimodal-badge')).toBeVisible();
    const rows3 = page.locator('.result-table tbody tr:not([aria-hidden="true"])');
    await expect(rows3).toHaveCount(1);
    await expect(rows3.nth(0).locator('.col-mode')).toHaveText('9');
    await expect(rows3.nth(0).locator('.col-second-mode')).toHaveText('空');
    await expect(page.getByTestId('last-row-second-empty')).toBeVisible();
  });

  test('20 万读数与 20 万查询：保持顺序、可浏览且末行可核对', async ({ page }) => {
    test.setTimeout(180_000);
    const batch = buildAdversarialBatch();
    await page.getByTestId('json-input').click();
    await page.keyboard.insertText(batch.json);
    await page.getByTestId('run-button').click();

    const status = page.getByTestId('status-panel');
    await status.waitFor({ timeout: 120_000 });
    await expect(status).toContainText('200000 条');
    await expect(status).toContainText('200000 个');

    // 末行：哨兵值 424242 每 1000 个出现一次（i=0,1000,…,199000），共 200 次
    const lastRow = page.getByTestId('last-row');
    await expect(lastRow).toContainText('第 200000 个');
    await expect(lastRow).toContainText('[0, 199999]');
    await expect(lastRow).toContainText('众数 424242');
    await expect(lastRow).toContainText('频次 200');

    // 结果浏览：滚动到末行后能看到第 200000 行
    await page.getByRole('button', { name: '滚动到末行' }).click();
    await expect(page.locator('.result-table tbody tr:not([aria-hidden="true"])', { hasText: '200000' })).toBeVisible();

    // 首行仍可浏览（滚回顶部，验证虚拟表不丢内容）
    const scroller = page.locator('.table-scroll');
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(page.locator('.col-index', { hasText: '1' }).first()).toBeVisible();
    await expect(page.locator('.result-table tbody tr:not([aria-hidden="true"]) .col-range').first()).toContainText(
      `[${batch.first.left}, ${batch.first.right}]`,
    );
  });

  test('20 万长表双峰复核：首末行第二名可见，且不改变第一名与末行答案', async ({ page }) => {
    test.setTimeout(180_000);
    const batch = buildAdversarialBatch();
    await page.getByTestId('json-input').click();
    await page.keyboard.insertText(batch.json);
    await page.getByTestId('bimodal-checkbox').check();
    await page.getByTestId('run-button').click();

    const status = page.getByTestId('status-panel');
    await status.waitFor({ timeout: 120_000 });
    await expect(page.getByTestId('bimodal-badge')).toBeVisible();

    // 末行（全数组）：第一名仍是 424242/200，第二名来自同一快照而非空白/残留。
    // 该批次除哨兵 424242（200 次）外，其余读数分布在约 30000 个值上，
    // 最高频不超过个位数，因此第二名必然不是 424242 且频次严格小于 200。
    const lastRow = page.getByTestId('last-row');
    await expect(lastRow).toContainText('众数 424242');
    await expect(lastRow).toContainText('频次 200');
    await expect(lastRow).toContainText('第二读数');
    const secondValue = await page.getByTestId('last-row-second-value').textContent();
    const secondCount = Number((await page.getByTestId('last-row-second-count').textContent()) ?? '');
    expect(secondValue).toBeTruthy();
    expect(secondValue).not.toBe('424242');
    expect(Number.isInteger(secondCount)).toBe(true);
    expect(secondCount).toBeGreaterThan(0);
    expect(secondCount).toBeLessThan(200);

    // 虚拟表末行渲染出 6 个单元格，第二名两格为数值而非"空"
    await page.getByRole('button', { name: '滚动到末行' }).click();
    const lastTableRow = page.locator('.result-table tbody tr:not([aria-hidden="true"])').last();
    await expect(lastTableRow.locator('.col-second-mode')).not.toHaveText('空');
    await expect(lastTableRow.locator('.col-second-count')).not.toHaveText('空');

    // 首行：第一名与普通批次一致（单点查询第一名即该读数、频次 1；
    // 该批首查询是大区间，这里仅核对第二名列存在且结构完整）。
    const scroller = page.locator('.table-scroll');
    await scroller.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(page.locator('.col-index', { hasText: '1' }).first()).toBeVisible();
    const firstTableRow = page.locator('.result-table tbody tr:not([aria-hidden="true"])').first();
    await expect(firstTableRow.locator('.col-second-mode')).toBeVisible();
    await expect(firstTableRow.locator('.col-second-count')).toBeVisible();
  });
});
