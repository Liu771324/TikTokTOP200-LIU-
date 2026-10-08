'use strict';

function newTask(shops, input, productStatus = { value: '', label: '所有' }) {
  return { status: 'running', startedAt: new Date().toISOString(), shops, productStatus: { ...productStatus },
    skipped: input.skipped, groups: [], items: [], saved: 0, failed: 0, unchanged: 0, message: '准备查询', stopPosition: null };
}

async function runTask(task, input, adapter, signal, update = () => {}) {
  const check = () => { if (signal.aborted) throw new Error('任务已停止'); };
  let currentGroup, currentItem;
  try {
    for (const group of input.groups) {
      check();
      currentItem = null;
      currentGroup = { original: group.original, titleCount: group.titles.length,
        productCount: null, saved: 0, failed: 0, unchanged: 0, unmodified: null, unused: group.titles.length, status: 'querying' };
      task.groups.push(currentGroup);
      task.message = `查询：${group.original}`;
      update();
      if (!group.titles.length) {
        currentGroup.status = 'skipped';
        update();
        continue;
      }
      const products = await adapter.query(group.original, task.shops, signal, task.productStatus.value);
      check();
      currentGroup.productCount = products.length;
      currentGroup.unmodified = products.length;
      const count = Math.min(products.length, group.titles.length);
      const records = products.map((product, index) => ({ ...product, order: index + 1,
        original: group.original, before: product.title, after: product.title,
        target: index < count ? group.titles[index] : '', excelRow: index < count ? group.rows[index] : null,
        attempts: 0, status: index < count ? 'pending' : 'unmodified', reason: index < count ? '' : '新标题数量不足' }));
      task.items.push(...records);
      currentGroup.status = products.length ? 'saving' : 'no-match';
      update();
      for (const item of records.slice(0, count)) {
        currentItem = item;
        check();
        task.message = `保存 ${item.order}/${count} · ${item.shopName} · ${item.id}`;
        item.status = 'saving';
        update();
        // 重试与不确定结果核对由适配器完成，最多两次保存点击。
        try {
          const result = await adapter.save(item, signal, attempts => { item.attempts = attempts; update(); });
          item.after = result.title;
          item.status = result.already ? 'unchanged' : 'success';
          item.reason = result.reason || '保存成功';
          if (result.already) { currentGroup.unchanged++; task.unchanged++; }
          else { currentGroup.saved++; currentGroup.unmodified--; task.saved++; }
        } catch (error) {
          if (!error.itemRejected || error.uncertain || signal.aborted) throw error;
          item.status = 'failed'; item.skipped = true; item.reason = error.message;
          currentGroup.failed++; task.failed++;
        }
        currentGroup.unused--;
        update();
      }
      currentGroup.status = products.length ? 'complete' : 'no-match';
      update();
    }
    check();
    task.status = 'complete';
    task.message = `任务完成，成功保存 ${task.saved} 件商品，失败跳过 ${task.failed} 件`;
  } catch (error) {
    task.status = signal.aborted ? 'stopped' : 'failed';
    task.message = error.message;
    task.stopPosition = { original: currentGroup?.original, shopName: currentItem?.shopName,
      shopId: currentItem?.shopId, productId: currentItem?.id, target: currentItem?.target,
      reason: error.message };
    if (currentGroup) currentGroup.status = task.status;
    if (currentItem && !['success', 'unchanged'].includes(currentItem.status)) {
      currentItem.status = error.uncertain ? 'uncertain' : task.status;
      currentItem.reason = error.message;
    }
    for (const item of task.items) {
      if (item.status === 'pending') { item.status = 'unmodified'; item.reason = '任务已停止，未执行'; }
    }
  }
  task.finishedAt = new Date().toISOString();
  update();
  return task;
}

module.exports = { newTask, runTask };
