import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeCellValue } from "../lib/output-sanitize.mjs";
import { summarizeProcessError } from "../lib/process-error.mjs";
import { buildBusinessSearchUrl, runBusinessSearchAttempts } from "../lib/business-search-url.mjs";
import { classifyCompassResult, runCompassAttempts } from "../lib/compass-retry.mjs";
import { matchingTitleIndexes } from "../lib/term-match.mjs";

test("Excel 单元格移除 ANSI 和 XML 禁止控制字符", () => {
  assert.equal(sanitizeCellValue("商机中心：\u001b[2m等待输入框\u001b[22m\u0000"), "商机中心：等待输入框");
  assert.equal(sanitizeCellValue(12), 12);
});

test("子进程错误只保留可读摘要，不泄露整段运行时源码", () => {
  const source = `${"var e=\"9.0.19\";".repeat(20000)}\nError: Xml_InvalidCharacter\n    at exportXlsx (artifact_tool.mjs:1:2)`;
  const summary = summarizeProcessError(source, "build_output.mjs");
  assert.match(summary, /Xml_InvalidCharacter/);
  assert.ok(summary.length <= 500);
  assert.doesNotMatch(summary, /var e=/);
});

test("商机中心使用稳定查询 URL，不依赖首页回车事件", () => {
  const url = new URL(buildBusinessSearchUrl("脱油花生米"));
  assert.equal(url.origin + url.pathname, "https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter/search");
  assert.equal(url.searchParams.get("clueChannel"), "bu_all");
  assert.equal(url.searchParams.get("clueId"), "脱油花生米");
  assert.equal(url.searchParams.get("source"), "business_center");
});

test("商机中心结果区域短暂未渲染时会重新加载", async () => {
  let calls = 0;
  const value = await runBusinessSearchAttempts(async () => {
    calls += 1;
    if (calls < 3) throw new Error("结果区域未渲染");
    return "ready";
  }, { attempts: 3 });
  assert.equal(value, "ready");
  assert.equal(calls, 3);
});

test("罗盘类目或结果区域短暂未就绪时会重试", async () => {
  let calls = 0;
  const value = await runCompassAttempts(async () => {
    calls += 1;
    if (calls < 3) throw new Error("结果区域加载超时");
    return "ready";
  }, { attempts: 3 });
  assert.equal(value, "ready");
  assert.equal(calls, 3);
});

test("罗盘只把明确的空状态识别为无数据", () => {
  assert.equal(classifyCompassResult({ headers: ["搜索词信息"], rows: [["核桃仁"]] }, ""), "table");
  assert.equal(classifyCompassResult(null, "筛选条件\n暂无数据\n关联平台"), "empty");
  assert.equal(classifyCompassResult(null, "页面正在加载"), "pending");
});

test("商品类目只从标题匹配核心词的卡片中读取", () => {
  assert.deepEqual(matchingTitleIndexes(["坚果礼盒", "鲜核桃仁", "椒盐核桃仁"], "核桃仁"), [1, 2]);
  assert.deepEqual(matchingTitleIndexes(["花生米", "脱油椒盐花生米", "脱油花生米"], "脱油花生米"), [1, 2]);
});
