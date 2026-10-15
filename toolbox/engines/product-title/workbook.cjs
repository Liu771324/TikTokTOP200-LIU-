'use strict';
const XLSX = require('xlsx');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function cellText(value, row) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value.richText) return value.richText.map(part => part.text).join('');
  throw new Error(`第 ${row} 行必须是标题文本，不能是公式或其他类型`);
}

function groupRows(rows) {
  if (rows[0]?.[0] !== '原标题' || rows[0]?.[1] !== '新标题') {
    throw new Error('Sheet1 第一行 A、B 列必须分别为“原标题”和“新标题”');
  }
  const groups = [], skipped = [], byTitle = new Map();
  let current;
  rows.slice(1).forEach(([a, b], index) => {
    const row = index + 2;
    const original = cellText(a, row), title = cellText(b, row);
    if (original.length > 4000 || title.length > 4000) throw new Error(`第 ${row} 行标题超过 4000 字符，请检查表格内容`);
    if (original.trim()) {
      if (/[\r\n]/.test(original)) throw new Error(`第 ${row} 行原标题包含换行，必须每次只查询一个原标题`);
      current = byTitle.get(original);
      if (!current) {
        current = { original, titles: [], rows: [] };
        byTitle.set(original, current);
        groups.push(current);
      }
    }
    if (!title.trim()) {
      skipped.push({ row, original: current?.original || '', reason: '新标题为空' });
      return;
    }
    if (!current) throw new Error(`第 ${row} 行存在新标题，但尚未出现原标题`);
    current.titles.push(title);
    current.rows.push(row);
  });
  return { groups, skipped, titleCount: groups.reduce((n, g) => n + g.titles.length, 0) };
}

async function findWorkbook(directory = __dirname) {
  const files = (await fs.readdir(directory)).filter(name => /^标题\.(xlsx|xls)$/i.test(name));
  if (!files.length) throw new Error('未找到标题表格，请将 标题.xls 或 标题.xlsx 放在工作台目录');
  if (files.length > 1) throw new Error('同时存在 标题.xls 和 标题.xlsx，请只保留本次需要处理的一份标题表格');
  return path.join(directory, files[0]);
}

async function readWorkbook(file) {
  const selected = file || await findWorkbook();
  const fileName = path.basename(selected);
  const data = await fs.readFile(selected);
  if (data.length > 25 * 1024 * 1024) throw new Error('标题表格不能超过 25 MiB');
  let workbook;
  try { workbook = XLSX.read(data, { type: 'buffer', cellFormula: true }); }
  catch (error) { throw new Error(`${fileName} 无法读取，请检查文件是否损坏或加密：${error.message}`); }
  const sheet = workbook.Sheets.Sheet1;
  if (!sheet) throw new Error(`${fileName} 缺少 Sheet1`);
  const rows = [];
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:B1');
  if (range.e.r > 10000) throw new Error('标题表格最多支持 10000 行数据');
  for (let row = 0; row <= range.e.r; row++) {
    rows.push(['A', 'B'].map(column => {
      const cell = sheet[`${column}${row + 1}`];
      if (cell?.f) throw new Error(`第 ${row + 1} 行必须是标题文本，不能是公式`);
      return cell?.v ?? '';
    }));
  }
  const result = groupRows(rows);
  if (result.groups.length > 100 || result.titleCount > 10000) throw new Error('最多支持 100 组原标题和 10000 个新标题');
  return { ...result, fileName, inputSha256: crypto.createHash('sha256').update(data).digest('hex') };
}

module.exports = { groupRows, readWorkbook, findWorkbook };
