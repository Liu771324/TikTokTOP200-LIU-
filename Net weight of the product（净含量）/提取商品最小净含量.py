# -*- coding: utf-8 -*-
"""
商品最小净含量提取（锁定口径，可复用）
用法: python 提取商品最小净含量.py <输入xls/xlsx绝对路径> <输出xlsx绝对路径>
产出: 一个工作簿，含两张子表 —— 净含量汇总(商品ID|净含量)、无克重(商品ID|商品标题|情况说明)
规则要点见同目录《商品最小净含量提取-复用说明.md》。
"""
import re
import sys
import pandas as pd
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side

# —— 正则（锁定，勿轻易改）——
RE_G   = re.compile(r'(\d+(?:\.\d+)?)\s*[gG](?![a-zA-Z])')                 # 数字+g，g后可直接跟中文
RE_KE  = re.compile(r'(\d+(?:\.\d+)?)\s*克')                              # 数字+中文克（自动排除“千克”）
RE_KG  = re.compile(r'(\d+(?:\.\d+)?)\s*[kK][gG]')                        # 数字+kg
RE_ML  = re.compile(r'(\d+(?:\.\d+)?)\s*[mM][lL]')                        # 数字+ml
RE_JIN = re.compile(r'\d+(?:\.\d+)?\s*斤|[一二两半]\s*斤')                 # 斤/半斤（不换算）
RE_REV = re.compile(r'(?<![\d.a-zA-Z])[gG]\s*[*xX×]\s*\d')                # g*数字写反
# 离散“个数”单位（按个/块卖，区别于 罐/袋/瓶/盒/件 等包装单位）
RE_PIECE = re.compile(r'\d+(?:\.\d+)?\s*(?:块|枚|个|只|粒|片|根|条|朵|支|颗|坨|饼|颗装)')
# 包赔/补偿克数条款（如“赠50克抵扣坏果”）：补偿克数不是规格、导致存疑 -> 整商品入无克重
RE_COMP = re.compile(r'\d+(?:\.\d+)?\s*(?:g|G|克)[^|】\]\n]{0,10}?(?:抵扣|坏果|包赔|缺重|缺克|补偿|赔付)')


def find_col(columns, *keywords):
    """按列名包含关键字找列（大小写不敏感），找不到返回 None"""
    for c in columns:
        cl = str(c).strip().lower()
        if any(k.lower() in cl for k in keywords):
            return c
    return None


def fmt(x):
    return str(int(x)) if float(x) == int(x) else str(x)


def classify(txt):
    # 最高优先：含“赠X克抵扣坏果/包赔/缺重补偿”等补偿克数条款，规格存疑 -> 无克重，不强行取值
    if RE_COMP.search(txt):
        return 'unk', '含“赠/送X克抵扣坏果（包赔/缺重补偿）”等补偿克数，规格存疑，按要求入无克重'
    # g / 中文克（排除 1g/1克 错标签）；kg 单独取出，便于按“是否按个数卖”决定是否换算
    gw = [float(x) for x in RE_G.findall(txt)] + [float(x) for x in RE_KE.findall(txt)]
    gw = [x for x in gw if x != 1.0]
    kgv = [float(x) * 1000 for x in RE_KG.findall(txt)]
    piece = bool(RE_PIECE.search(txt))             # 是否按块/枚/个等个数卖
    if gw:                                         # 有正常 g/克：与 kg 一起取最小
        return 'g', min(gw + kgv)
    if kgv and not piece:                          # 纯重量（如1kg*1罐）才换算 kg
        return 'g', min(kgv)
    # 无 g/克；若按个数卖，夹带的 kg/斤整箱装不换算 -> 无克重
    ml = [float(x) for x in RE_ML.findall(txt)]
    if ml and not piece:
        return 'ml', min(ml)
    if piece:
        return 'unk', '按块/枚/个等个数售卖、无单份克重（整箱kg/斤装不换算）'
    if RE_JIN.search(txt):
        return 'unk', '仅按“斤/半斤”等计重、按要求不换算克重'
    if RE_REV.search(txt):
        return 'unk', '克重写成“g*数字”（g与数字颠倒），按要求不修复'
    return 'unk', '未标注克重（按个/包/片/块/件或配料组合等计）'


def load_source(src):
    # 整表按文本读，避免19位ID被数值化/科学计数法丢精度；取第一个工作表
    df = pd.read_excel(src, engine='openpyxl', dtype=str).fillna('')
    cols = list(df.columns)
    c_id = find_col(cols, '商品id', '商品编号', 'id')
    # 精确优先匹配 SKU名称；裸 'sku' 子串会误中排在前面的“SKU编码”列，故单独兜底并排除编码列
    c_sku = find_col(cols, 'sku名称', 'sku名', '规格名称')
    if c_sku is None:
        for c in cols:
            cl = str(c).strip().lower()
            if 'sku' in cl and '编码' not in cl and 'code' not in cl:
                c_sku = c
                break
    c_title = find_col(cols, '商品标题', '标题', '商品名称')
    if c_id is None or c_sku is None:
        raise RuntimeError(f'未找到必需列（商品ID / SKU名称），实际列名：{cols}')
    out = pd.DataFrame()
    out['商品ID'] = df[c_id].astype(str).str.strip()
    out['SKU名称'] = df[c_sku].astype(str)
    out['商品标题'] = df[c_title].astype(str) if c_title is not None else ''
    return out


HEADER_FILL = PatternFill('solid', fgColor='D9E1F2')
HEADER_FONT = Font(bold=True)
THIN = Side(style='thin', color='BFBFBF')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)


def _style_header(ws, ncol):
    for c in range(1, ncol + 1):
        cell = ws.cell(row=1, column=c)
        cell.fill = HEADER_FILL
        cell.font = HEADER_FONT
        cell.alignment = Alignment(horizontal='center', vertical='center')
        cell.border = BORDER
    ws.freeze_panes = 'A2'


def build(df, out_path):
    mains, unks = [], []
    for pid, g in df.groupby('商品ID'):
        txt = '\n'.join(g['SKU名称'].astype(str))
        kind, val = classify(txt)
        title = str(g['商品标题'].iloc[0]) if '商品标题' in g.columns else ''
        if kind in ('g', 'ml'):
            mains.append((str(pid), float(val), kind))
        else:
            unks.append((str(pid), title, str(val)))
    # 总表排序：先 g 升序，再 ml 升序（ml 块排在 g 之后）
    mains.sort(key=lambda t: (0 if t[2] == 'g' else 1, t[1]))
    unks.sort(key=lambda t: t[0])

    wb = Workbook()
    ws = wb.active
    ws.title = '净含量汇总'
    ws.append(['商品ID', '净含量'])
    for pid, v, k in mains:
        ws.append([pid, fmt(v) + ('ml' if k == 'ml' else 'g')])
    _style_header(ws, 2)
    ws.column_dimensions['A'].width = 24
    ws.column_dimensions['B'].width = 12
    for r in range(2, ws.max_row + 1):
        ws.cell(row=r, column=1).number_format = '@'   # ID 文本格式

    ws2 = wb.create_sheet('无克重')
    ws2.append(['商品ID', '商品标题', '情况说明'])
    for row in unks:
        ws2.append(list(row))
    _style_header(ws2, 3)
    ws2.column_dimensions['A'].width = 24
    ws2.column_dimensions['B'].width = 40
    ws2.column_dimensions['C'].width = 46
    for r in range(2, ws2.max_row + 1):
        ws2.cell(row=r, column=1).number_format = '@'
        ws2.cell(row=r, column=3).alignment = Alignment(vertical='center', wrap_text=True)

    wb.save(out_path)
    ng = sum(1 for _, _, k in mains if k == 'g')
    nml = sum(1 for _, _, k in mains if k == 'ml')
    return len(mains), ng, nml, len(unks)


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('用法: python 提取商品最小净含量.py <输入路径> <输出路径>')
        sys.exit(1)
    src, outp = sys.argv[1], sys.argv[2]
    data = load_source(src)
    total = data['商品ID'].nunique()
    nm, ng, nml, nu = build(data, outp)
    print(f'{src}: 商品{total} | 总表{nm}(g {ng}+ml {nml}) 无克重{nu} -> {outp}')
    assert nm + nu == total, f'守恒失败: {nm}+{nu}!={total}'
