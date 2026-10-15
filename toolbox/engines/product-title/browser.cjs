'use strict';
const { setTimeout: delay } = require('node:timers/promises');
const HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const XZ = 'https://xiaozhu.huanhou.cn/c';
const QUERY = `${XZ}/combainSearch/index`;
function check(signal) { if (signal?.aborted) throw new Error('任务已停止'); }
function uncertain(message) { const error = new Error(message); error.uncertain = true; return error; }
function rejected(message) { const error = new Error(message); error.itemRejected = true; return error; }
function isPage(url, origin, pathname) {
  try { const parsed = new URL(url); return parsed.origin === origin && (!pathname || parsed.pathname === pathname); }
  catch { return false; }
}
class ShopBrowser {
  constructor(browser) {
    this.browser = browser;
    this.context = browser.contexts()[0];
    this.page = null;
    this.home = null;
  }

  async prepare() {
    const pages = this.context.pages();
    this.home = this.home && !this.home.isClosed() ? this.home : pages.find(p => isPage(p.url(), 'https://fxg.jinritemai.com'));
    if (!this.home) {
      this.home = pages.find(p => p.url() === 'about:blank') || await this.context.newPage();
      await this.home.goto(HOME, { waitUntil: 'domcontentloaded' });
    }
    if (!this.home.url().includes('/mshop/homepage/index') && !/login|passport/i.test(this.home.url())) {
      await this.home.goto(HOME, { waitUntil: 'domcontentloaded' });
    }
    const homeText = await this.home.locator('body').innerText({ timeout: 5000 });
    if (!isPage(this.home.url(), 'https://fxg.jinritemai.com', '/ffa/mshop/homepage/index') || !/商品管理/.test(homeText) || !/订单管理/.test(homeText)
      || await this.hasVerification(this.home)) {
      await this.home.bringToFront();
      return { status: 'waiting-login', message: '请在 Edge 完成抖店登录或验证，工作台会自动继续' };
    }
    this.page = this.page && !this.page.isClosed() ? this.page : pages.find(p => isPage(p.url(), 'https://xiaozhu.huanhou.cn'));
    if (!this.page) { this.page = await this.context.newPage(); await this.page.goto(XZ, { waitUntil: 'domcontentloaded' }); }
    if (await this.hasVerification(this.page) || /login|passport/i.test(this.page.url())) {
      await this.page.bringToFront();
      return { status: 'waiting-login', message: '请在 Edge 完成小猪登录或验证' };
    }
    if (!this.page.url().includes('/combainSearch/index')) {
      const association = this.page.getByRole('link', { name: '多店铺关联', exact: true });
      if (!await association.count()) return { status: 'waiting-login', message: '请在 Edge 登录小猪批量修改，工作台会自动继续' };
      await association.first().click();
      await this.page.waitForLoadState('domcontentloaded');
      await this.page.getByRole('link', { name: '多店删除/上下架/修改商品', exact: true }).click();
      await this.page.waitForURL('**/combainSearch/index**');
    }
    if (!await this.page.locator('.selectShop').count()) {
      return { status: 'waiting-login', message: '等待小猪页面完成登录或加载店铺' };
    }
    await this.assertReady();
    return { status: 'ready', message: '已连接 Edge，可以选择店铺和商品状态', shops: await this.shops(), productStatuses: await this.productStatuses() };
  }

  async hasVerification(page) {
    if (await page.locator('input[type="password"]:visible').count()) return true;
    return await page.locator('iframe:visible').evaluateAll(es => es.some(e => /captcha|verifycenter|passport|login/i.test(e.src)));
  }

  async assertReady() {
    if (!this.browser.isConnected() || !this.page || this.page.isClosed() || !this.home || this.home.isClosed()) {
      throw new Error('浏览器或业务标签页已关闭，请重新启动工作台');
    }
    if (!isPage(this.page.url(), 'https://xiaozhu.huanhou.cn', '/c/combainSearch/index') || !isPage(this.home.url(), 'https://fxg.jinritemai.com', '/ffa/mshop/homepage/index')
      || await this.hasVerification(this.page) || await this.hasVerification(this.home)) {
      throw new Error('页面要求登录或验证，任务已停止，请完成登录后重试');
    }
  }

  async shops() {
    return this.page.locator('.selectShop').evaluateAll(es => es.map(e => ({
      id: e.dataset.shopid,
      name: e.closest('.shop-check-item').querySelector('.shop-check-name').textContent.replace(/[（(]当前店铺[）)]/g, '').trim(),
    })));
  }

  async productStatuses() {
    return this.page.locator('#status').evaluate(e => [...e.options]
      .filter(o => !o.disabled).map(o => ({ value: o.value, label: o.textContent.trim() })));
  }

  async query(original, shops, signal, productStatus = '', timeout = 180000) {
    check(signal);
    this.restoreQuery = null;
    await this.assertReady();
    if (await this.page.evaluate(() => window.isSearching !== false)) throw new Error('小猪页面已有查询正在进行，请等待完成');
    const known = await this.shops();
    if (shops.some(s => !known.some(k => k.id === s.id))) throw new Error('店铺列表已变化，请刷新后重新选择');
    if (!(await this.productStatuses()).some(s => s.value === productStatus)) throw new Error('商品状态选项已变化，请刷新后重新选择');
    // 清空实际查询表单，而不点击“清空”（页面清空按钮会立即发起查询）。
    await this.page.locator('.search-table').evaluate((container, { original, ids }) => {
      for (const e of container.querySelectorAll('input,textarea,select')) {
        if (e.type === 'checkbox' || e.type === 'radio') e.checked = false;
        else if (e.tagName === 'SELECT') {
          const empty = [...e.options].find(o => o.value === '');
          e.value = empty ? '' : e.options[0]?.value || '';
        } else e.value = '';
        e.dispatchEvent(new Event('change', { bubbles: true }));
      }
      document.querySelectorAll('.shopCategoryBar').forEach(e => e.remove());
      document.querySelector('#name').value = original;
      document.querySelector('#nameDisplay').value = original;
      for (const cb of document.querySelectorAll('.selectShop')) {
        cb.checked = ids.includes(cb.dataset.shopid);
        cb.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, { original, ids: shops.map(s => s.id) });
    await this.page.locator('#status').selectOption(productStatus);
    if (await this.page.locator('#status').inputValue() !== productStatus) throw new Error('页面商品状态与任务范围不一致');
    const actual = await this.page.locator('.selectShop:checked').evaluateAll(es => es.map(e => e.dataset.shopid));
    if (actual.length !== shops.length || shops.some(s => !actual.includes(s.id))) throw new Error('页面店铺选择与任务范围不一致');
    check(signal);
    const request = this.page.waitForRequest(r => r.url().includes('/c/combainSearch/search') && r.method() === 'POST', { timeout: 10000 });
    await this.page.locator('#searchBtn').click();
    await request;
    const deadline = Date.now() + timeout;
    let complete = false;
    while (Date.now() < deadline) {
      check(signal);
      const state = await this.page.evaluate(() => ({ searching: window.isSearching,
        progress: document.querySelector('.shop-query-progress')?.textContent || '' }));
      const progress = state.progress.match(/已查询店铺：\s*(\d+)\s*\/\s*(\d+)/);
      if (state.searching === false && progress && +progress[1] === shops.length && +progress[2] === shops.length) { complete = true; break; }
      await delay(250);
    }
    if (!complete) throw new Error('店铺查询未全部完成，已停止；未使用不完整结果');
    const errors = await this.page.locator('.combain-error-row,.shop-error-tip').allTextContents();
    if (errors.length) throw new Error(`店铺查询失败：${errors.join('；')}`);
    const products = await this.page.locator('#searchItemResult tr.find-pid-trow').evaluateAll(es => es.map(e => ({
      id: e.dataset.id, shopId: e.dataset.shopid, shopName: e.cells[5].textContent.trim(),
      title: e.querySelector('.title-input').value,
    })));
    const keys = new Set();
    for (const p of products) {
      const key = `${p.shopId}:${p.id}`;
      if (!/^\d{1,32}$/.test(p.id) || !/^\d{1,32}$/.test(p.shopId) || typeof p.title !== 'string' || p.title.length > 4000 || !shops.some(s => s.id === p.shopId) || keys.has(key)) throw new Error('查询结果商品标识重复或不在所选店铺范围，已停止');
      keys.add(key);
    }
    this.lastQuery = { original, shops, productStatus };
    return products;
  }

  row(item) {
    return this.page.locator(`#searchItemResult tr[data-id="${item.id}"][data-shopid="${item.shopId}"]`);
  }

  async rowState(item) {
    const row = this.row(item);
    if (await row.count() !== 1) throw uncertain('无法按商品 ID 唯一定位商品，已停止');
    return row.evaluate(e => {
      const input = e.querySelector('.title-input');
      return { title: input.value, committed: window.jQuery(input).data('oldtitle'),
        saving: !!window.jQuery(e.querySelector('.title-edit-wrap')).data('saving'),
        feedback: e.querySelector('.title-save-result').textContent,
        count: e.querySelector('.title-len-bar').textContent, invalid: input.getAttribute('aria-invalid') };
    });
  }

  async save(item, signal, onAttempt = () => {}) {
    check(signal);
    await this.assertReady();
    if (this.restoreQuery) {
      const { original, shops, productStatus } = this.restoreQuery;
      this.restoreQuery = null;
      await this.query(original, shops, signal, productStatus);
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      check(signal);
      const before = await this.rowState(item);
      if (before.committed === item.target && before.title === item.target) return { title: item.target, already: true, reason: '已为目标标题，无需重复保存' };
      if (before.committed !== item.before || before.saving) throw uncertain('商品当前标题或编辑上下文已变化，无法安全保存');
      const row = this.row(item), input = row.locator('.title-input');
      await input.click();
      await input.fill(item.target);
      const state = await this.rowState(item);
      // 页面会清除换行；严格比较，避免擅自改写 Excel 标题正文。
      if (state.title !== item.target) throw rejected('平台改写了标题正文（可能包含换行），未保存');
      const count = state.count.match(/^(\d+)\s*\/\s*(\d+)$/);
      if (!count || +count[2] !== 60) throw new Error('无法读取平台标题计数，已停止，未保存');
      if (+count[1] > +count[2] || state.invalid === 'true') throw rejected(`标题超过平台限制：${state.count}，未保存`);
      if (!item.target.trim() || !await row.locator('.title-save-btn').isEnabled()) throw rejected(`平台不允许保存：${state.feedback || '保存按钮不可用'}`);
      check(signal);
      await this.assertReady();
      onAttempt(attempt);
      check(signal);
      const responsePromise = this.page.waitForResponse(r => {
        if (!isPage(r.url(), 'https://xiaozhu.huanhou.cn', '/c/batchTitle/modify') || r.request().method() !== 'POST') return false;
        const data = new URLSearchParams(r.request().postData() || '');
        return data.get('iid') === item.id && data.get('sourceShopId') === item.shopId && data.get('newTitle') === item.target;
      }, { timeout: 30000 }).then(async r => r.ok() ? r.json() : null).catch(() => null);
      try { await row.locator('.title-save-btn').click(); }
      catch { throw uncertain('保存点击结果不确定，请核对该商品后再开始新任务'); }
      // Once submitted, stop only prevents another submission; this read-only
      // confirmation has its own bound and cannot be aborted by the stop flag.
      const confirm = async () => {
        const response = await responsePromise;
        const deadline = Date.now() + 10000;
        let observed;
        do {
          observed = await this.rowState(item);
          if (!observed.saving) break;
          await delay(200);
        } while (Date.now() < deadline);
        if (!observed.saving && observed.committed === item.target && observed.title === item.target && /保存成功/.test(observed.feedback)) {
          return { title: item.target };
        }
        const responseStatus = response?.log?.status;
        if (responseStatus === 1 || responseStatus === '1') throw uncertain('平台返回成功，但无法核对同一商品标题，已停止');
        if (!(responseStatus === 0 || responseStatus === '0') || observed.saving) {
          if (observed.saving) throw uncertain('保存请求仍未结束，无法确认结果；已停止，未重复提交');
          // 网络结果未知时重新做平台实时标题查询，仅确认明确已成功的商品。
          const previousQuery = this.lastQuery;
          const products = await this.query(item.target, [{ id: item.shopId, name: item.shopName }], null, previousQuery.productStatus, 12000);
          const match = products.find(p => p.id === item.id && p.shopId === item.shopId);
          if (match?.title === item.target) {
            this.restoreQuery = previousQuery;
            return { title: item.target, reason: '保存响应不确定，重新查询已确认成功' };
          }
          throw uncertain('保存响应不确定，重新查询仍无法确认成功；已停止，未重复提交');
        }
        if (observed.committed !== item.before || observed.title !== item.target) throw uncertain('失败后编辑上下文发生变化，已停止');
        return { rejectedResponse: response, observed };
      };
      let timer;
      let confirmed;
      try {
        confirmed = await Promise.race([confirm(), new Promise((resolve, reject) => {
          timer = setTimeout(() => reject(uncertain('保存核对超时，请人工核对该商品；未重复提交')), 59000);
        })]);
      } finally { clearTimeout(timer); }
      if (!confirmed.rejectedResponse) return confirmed;
      if (signal?.aborted) throw rejected('平台已明确拒绝保存，任务已停止，未重试');
      const response = confirmed.rejectedResponse, observed = confirmed.observed;
      if (attempt === 2) {
        await this.assertReady();
        const reason = response.log?.apiErrorMsg || response.msg || observed.feedback || '平台拒绝保存';
        if (/登录|授权|token|session|账号.*失效/i.test(reason)) throw new Error(`登录或授权异常，已停止：${reason}`);
        throw rejected(`保存失败，已重试一次：${reason}`);
      }
    }
  }
}
module.exports = { ShopBrowser, HOME, QUERY };
