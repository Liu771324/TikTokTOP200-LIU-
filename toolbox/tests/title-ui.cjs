'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');

function mockApi() {
  const tools = [{toolId:'top200',name:'商品 TOP200',available:true},
    {toolId:'product-title',name:'商品标题工作台',available:true}];
  const events = []; let seq = 0, preview = 0;
  const shops = [{id:'11',name:'样本店'}];
  const productStatuses = [{value:'',label:'所有'},{value:'on',label:'在售'}];
  window.calls = [];
  window.pywebview = {api:{invoke:async (action,p) => {
    window.calls.push({action,p});
    let data = {};
    if (action === 'app.get_state') data = {tools,browser:{edgeAvailable:true}};
    if (action === 'tasks.list') data = {items:[],total:0};
    if (action === 'title.choose_input') data = {inputId:'i',fileName:'测试标题.xlsx',groupCount:1,titleCount:1,skippedCount:0,
      groups:[{original:'旧标题',titles:['新标题'],rows:[2]}]};
    if (action === 'tools.discover') {
      data = {operationId:'discover'};
      events.push({seq:++seq,type:'operation.state',data:{operationId:'discover',kind:'discover',state:'completed',result:{shops,productStatuses}}});
    }
    if (action === 'title.preview') {
      data = {operationId:'preview-' + ++preview};
      events.push({seq:++seq,type:'operation.state',data:{operationId:data.operationId,kind:'title_plan',state:'completed',
        result:{token:'token-' + preview,summary:{productCount:51,changeCount:1,unchangedCount:0,unmodifiedCount:50,unusedCount:0}}}});
    }
    if (action === 'title.plan_page') data = {items:[{productId:'商品-' + p.offset,shopName:'样本店',before:'原标题',target:'目标标题',excelRow:2,status:'pending'}],total:51};
    if (action === 'title.create') data = {cancelled:true};
    if (action === 'events.read') data = {events:events.filter(event => event.seq > p.afterSeq),nextSeq:seq};
    return {ok:true,data};
  }}};
  document.addEventListener('DOMContentLoaded', () => window.dispatchEvent(new Event('pywebviewready')));
}

(async () => {
  const [url,executablePath,output] = process.argv.slice(2);
  fs.mkdirSync(output,{recursive:true});
  const browser = await chromium.launch({headless:true,executablePath});
  try {
    const context = await browser.newContext({viewport:{width:1280,height:800}});
    await context.addInitScript(mockApi);
    const page = await context.newPage(), errors = [];
    page.on('pageerror',error => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('button',{name:'商品标题工作台',exact:true}).click();
    await page.getByRole('button',{name:'选择 .xls / .xlsx 表格',exact:true}).click();
    await page.getByText('测试标题.xlsx · 1 组 · 1 个新标题 · 跳过 0 行',{exact:true}).waitFor();
    await page.getByRole('button',{name:'读取店铺和商品状态',exact:true}).click();
    const shop = page.getByRole('checkbox',{name:'样本店',exact:true});
    await shop.waitFor(); assert.equal(await shop.isChecked(),false);
    await page.getByRole('button',{name:'预览商品修改',exact:true}).click();
    await page.locator('#notice').getByText('请至少选择一家店铺。',{exact:true}).waitFor();
    await shop.check();
    await page.getByRole('button',{name:'预览商品修改',exact:true}).click();
    await page.getByText('正在排队或查询所选店铺，尚未修改商品。多组原标题可能需要几分钟。',{exact:true}).waitFor();
    await page.locator('#title-plan').getByText('商品-0',{exact:true}).waitFor();
    await page.locator('#title-plan').getByRole('button',{name:'下一页',exact:true}).click();
    await page.locator('#title-plan').getByText('商品-50',{exact:true}).waitFor();
    await page.getByRole('button',{name:'确认修改商品标题',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'确认修改商品标题',exact:true}).count(),1);
    await page.screenshot({path:path.join(output,'title-preview-1280.png')});
    await page.getByRole('combobox').selectOption('on');
    assert.equal(await page.getByRole('button',{name:'确认修改商品标题',exact:true}).count(),0);
    await page.getByRole('button',{name:'预览商品修改',exact:true}).click();
    await page.locator('#title-plan').getByText('商品-0',{exact:true}).waitFor();
    const submitted = await page.evaluate(() => window.calls.filter(call => call.action === 'title.preview').at(-1).p);
    assert.deepEqual(submitted.shops,[{id:'11',name:'样本店'}]);
    assert.equal(submitted.productStatus.value,'on');
    assert.equal(await page.evaluate(() => window.calls.some(call => call.action === 'tasks.create')),false);
    await page.setViewportSize({width:900,height:720});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
    await page.screenshot({path:path.join(output,'title-preview-900.png')});
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({titleImport:true,shopDefaultEmpty:true,exactProductPreview:true,pagination:true,
      confirmationCancelled:true,scopeInvalidatesPreview:true,directTaskCreate:false,responsive:true,pageErrors:errors}));
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
