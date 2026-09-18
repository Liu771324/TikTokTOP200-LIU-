const { parseRangeStrict } = require('./collect_utils');

function findBusinessTable(tables) {
  return tables.find((table) => {
    const headers = table.headers.map((header) => String(header).replace(/\s+/g, ''));
    return headers.some((header) => header.includes('搜索词'))
      && headers.some((header) => header.includes('成交金额'));
  }) || null;
}

function areSalesValuesDescending(values) {
  const ranges = values.map(parseRangeStrict);
  if (ranges.length < 3 || ranges.some((range) => !range)) return false;
  return ranges.every((range, index) => index === 0 || range.min <= ranges[index - 1].min);
}

function classifyGrowthTrend(descriptor = {}) {
  const fills = new Set((descriptor.arrowFills || []).map((value) => String(value).toLowerCase()));
  const hasRedUp = fills.has('#ff3b52') || fills.has('rgb(255, 59, 82)');
  const hasGreenDown = fills.has('#00c87f') || fills.has('rgb(0, 200, 127)');
  if (hasRedUp !== hasGreenDown) return hasRedUp ? 'up' : 'down';
  const signal = `${descriptor.classNames || ''} ${descriptor.labels || ''}`.toLowerCase();
  const isUp = /trendarrowup|trendvaluepositive|(?:^|[\s_-])(arrow)?up(?:$|[\s_-])|increase|positive|向上|上涨/.test(signal);
  const isDown = /trendarrowdown|trendvaluenegative|(?:^|[\s_-])(arrow)?down(?:$|[\s_-])|decrease|negative|向下|下降/.test(signal);
  if (isUp === isDown) {
    return /trendflat|trendvalueflat|(?:^|[\s_-])(flat|stable)(?:$|[\s_-])|持平/.test(signal)
      ? 'flat'
      : 'unknown';
  }
  return isUp ? 'up' : 'down';
}

async function getBusinessTableState(page) {
  const tables = await page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table, index) => {
    const headerElements = Array.from(table.querySelectorAll('th'));
    const headers = headerElements.map((header) => header.innerText?.trim() || '');
    const salesColumnIndex = headers.findIndex((header) => header.replace(/\s+/g, '').includes('成交金额'));
    const growthColumnIndex = headers.findIndex((header) => header.replace(/\s+/g, '').includes('成交增速'));
    const salesHeader = salesColumnIndex >= 0 ? headerElements[salesColumnIndex] : null;
    const tbody = table.querySelector('tbody');
    const dataRows = Array.from(tbody?.querySelectorAll('tr') || []).filter((row) => {
      const cells = row.querySelectorAll('td');
      return cells.length > 0 && !cells[0].querySelector('.aurora-table-title-text');
    });
    const rows = dataRows.map((row) => {
      const cells = row.querySelectorAll('td');
      const name = cells[0]?.querySelector('.__bu_card_title__, .name-PRUTXd');
      const growthCell = growthColumnIndex >= 0 ? cells[growthColumnIndex] : null;
      const growthElements = growthCell ? [growthCell, ...growthCell.querySelectorAll('*')] : [];
      return {
        keyword: name?.innerText?.trim() || '',
        salesAmount: salesColumnIndex >= 0 ? cells[salesColumnIndex]?.innerText?.trim() || '' : '',
        growthDescriptor: {
          classNames: growthElements.map((element) => element.getAttribute?.('class') || '').join(' '),
          labels: growthElements.flatMap((element) => [
            element.getAttribute?.('aria-label'),
            element.getAttribute?.('title'),
            element.getAttribute?.('data-trend'),
            element.getAttribute?.('data-direction'),
          ]).filter(Boolean).join(' '),
          arrowFills: Array.from(growthCell?.querySelectorAll('svg path') || [])
            .map((path) => path.getAttribute('fill'))
            .filter(Boolean),
          text: growthCell?.innerText?.trim() || '',
        },
      };
    }).filter((row) => row.keyword && row.salesAmount);
    const tableRoot = table.closest('.aurora-table-wrapper') || table.parentElement;
    const activeDown = salesHeader?.querySelector('.aurora-table-column-sorter-down.active');
    const activeUp = salesHeader?.querySelector('.aurora-table-column-sorter-up.active');
    const ariaSort = salesHeader?.getAttribute('aria-sort');
    const sortDirection = ariaSort === 'descending' || activeDown
      ? 'descending'
      : (ariaSort === 'ascending' || activeUp ? 'ascending' : 'none');
    return {
      index,
      headers,
      growthColumnIndex,
      rawRowCount: dataRows.length,
      rows,
      sortDirection,
      loading: !!tableRoot?.querySelector('.aurora-spin-spinning, [aria-busy="true"], [class*=loading][class*=active]'),
    };
  }));

  const table = findBusinessTable(tables);
  if (table) {
    table.rows = table.rows.map((row) => ({
      keyword: row.keyword,
      salesAmount: row.salesAmount,
      growthTrend: classifyGrowthTrend(row.growthDescriptor),
    }));
    return table;
  }
  return {
    index: -1,
    headers: [],
    growthColumnIndex: -1,
    rawRowCount: 0,
    rows: [],
    sortDirection: 'none',
    loading: false,
  };
}

async function clickSalesSorter(page, tableIndex) {
  return page.evaluate((index) => {
    const table = document.querySelectorAll('table')[index];
    const header = Array.from(table?.querySelectorAll('th') || [])
      .find((item) => item.textContent?.includes('成交金额'));
    const sorter = header?.querySelector('.aurora-table-column-sorter-inner');
    if (!sorter) return false;
    sorter.click();
    return true;
  }, tableIndex);
}

async function clickBusinessKeyword(page, tableIndex, keyword) {
  return page.evaluate(({ index, target }) => {
    const table = document.querySelectorAll('table')[index];
    const name = Array.from(table?.querySelectorAll('.__bu_card_title__, .name-PRUTXd') || [])
      .find((candidate) => candidate.innerText?.trim() === target);
    if (!name) return false;
    name.click();
    return true;
  }, { index: tableIndex, target: keyword });
}

module.exports = {
  areSalesValuesDescending,
  classifyGrowthTrend,
  clickBusinessKeyword,
  clickSalesSorter,
  findBusinessTable,
  getBusinessTableState,
};
