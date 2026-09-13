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

async function getBusinessTableState(page) {
  const tables = await page.evaluate(() => Array.from(document.querySelectorAll('table')).map((table, index) => {
    const headerElements = Array.from(table.querySelectorAll('th'));
    const headers = headerElements.map((header) => header.innerText?.trim() || '');
    const salesColumnIndex = headers.findIndex((header) => header.replace(/\s+/g, '').includes('成交金额'));
    const salesHeader = salesColumnIndex >= 0 ? headerElements[salesColumnIndex] : null;
    const tbody = table.querySelector('tbody');
    const dataRows = Array.from(tbody?.querySelectorAll('tr') || []).filter((row) => {
      const cells = row.querySelectorAll('td');
      return cells.length > 0 && !cells[0].querySelector('.aurora-table-title-text');
    });
    const rows = dataRows.map((row) => {
      const cells = row.querySelectorAll('td');
      const name = cells[0]?.querySelector('.__bu_card_title__, .name-PRUTXd');
      return {
        keyword: name?.innerText?.trim() || '',
        salesAmount: salesColumnIndex >= 0 ? cells[salesColumnIndex]?.innerText?.trim() || '' : '',
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
      rawRowCount: dataRows.length,
      rows,
      sortDirection,
      loading: !!tableRoot?.querySelector('.aurora-spin-spinning, [aria-busy="true"], [class*=loading][class*=active]'),
    };
  }));

  const table = findBusinessTable(tables);
  return table || {
    index: -1,
    headers: [],
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
  clickBusinessKeyword,
  clickSalesSorter,
  findBusinessTable,
  getBusinessTableState,
};
