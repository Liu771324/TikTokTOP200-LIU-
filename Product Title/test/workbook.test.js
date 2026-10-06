'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const XLSX = require('xlsx');
const { readWorkbook, findWorkbook } = require('../workbook');

async function temporary(work) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'product-title-format-'));
  try { await work(directory); }
  finally {
    for (const file of await fs.readdir(directory)) await fs.unlink(path.join(directory, file));
    await fs.rmdir(directory);
  }
}

function fixture() {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['原标题', '新标题'], ['原商品', ' 新标题一 '], ['', ''], [], ['', '新标题二'], ['第二商品', '新标题三'],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['不应读取', '其他工作表']]), 'Sheet2');
  return workbook;
}

for (const [extension, bookType] of [['xls', 'biff8'], ['xlsx', 'xlsx']]) {
  test(`读取真实 ${extension.toUpperCase()}，保留空格、空白间隔及行顺序，输入不被改写`, async () => temporary(async directory => {
    const file = path.join(directory, `标题.${extension}`);
    await fs.writeFile(file, XLSX.write(fixture(), { type: 'buffer', bookType }));
    const before = await fs.readFile(file);
    assert.equal(await findWorkbook(directory), file);
    const input = await readWorkbook(file);
    assert.equal(input.fileName, `标题.${extension}`);
    assert.equal(input.groups.length, 2); assert.equal(input.titleCount, 3);
    assert.deepEqual(input.groups[0].titles, [' 新标题一 ', '新标题二']);
    assert.deepEqual(input.groups[0].rows, [2, 5]);
    assert.deepEqual(await fs.readFile(file), before);
  }));
}
test('未找到表格或两种表格同时存在时明确报错，不静默选择文件', async () => temporary(async directory => {
  await assert.rejects(findWorkbook(directory), /未找到标题表格/);
  await fs.writeFile(path.join(directory, '标题.xlsx'), XLSX.write(fixture(), { type: 'buffer', bookType: 'xlsx' }));
  await fs.writeFile(path.join(directory, '标题.xls'), XLSX.write(fixture(), { type: 'buffer', bookType: 'biff8' }));
  await assert.rejects(findWorkbook(directory), /同时存在/);
}));
test('按实际文件内容识别，兼容保存格式与扩展名不一致的 Excel', async () => temporary(async directory => {
  const file = path.join(directory, '标题.xls');
  await fs.writeFile(file, XLSX.write(fixture(), { type: 'buffer', bookType: 'xlsx' }));
  assert.equal((await readWorkbook(file)).titleCount, 3);
}));
test('缺少 Sheet1 或含标题公式时阻止执行', async () => temporary(async directory => {
  const file = path.join(directory, '标题.xlsx'), workbook = fixture();
  workbook.Sheets.Sheet1.B2 = { t: 's', v: '缓存标题', f: '"缓存标题"' };
  await fs.writeFile(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  await assert.rejects(readWorkbook(file), /不能是公式/);
  const missing = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(missing, XLSX.utils.aoa_to_sheet([['原标题', '新标题']]), '其他');
  await fs.writeFile(file, XLSX.write(missing, { type: 'buffer', bookType: 'biff8' }));
  await assert.rejects(readWorkbook(file), /缺少 Sheet1/);
}));
