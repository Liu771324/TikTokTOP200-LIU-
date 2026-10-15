'use strict';

function newTask(plan) {
  return { status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
    shops: plan.shops, productStatus: plan.productStatus, saved: 0, failed: 0, unchanged: 0,
    message: '正在核对冻结计划', stopPosition: null,
    items: plan.items.map(item => ({ ...item, after: item.before, attempts: 0, reason: item.target ? '' : '新标题数量不足' })) };
}

async function runTask(task, plan, adapter, signal, checkpoint) {
  const check = () => { if (signal.aborted) throw new Error('任务已停止'); };
  let current;
  try {
    for (const group of plan.groups) {
      current = null;
      const items = task.items.filter(item => item.original === group.original && item.target);
      if (!items.length) continue;
      check();
      let products = await adapter.query(group.original, task.shops, signal, task.productStatus.value);
      let restore = false;
      for (const item of items) {
        current = item;
        check();
        if (restore) {
          products = await adapter.query(group.original, task.shops, signal, task.productStatus.value);
          restore = false;
        }
        let product = products.find(row => row.id === item.id && row.shopId === item.shopId);
        if (!product) {
          const targets = await adapter.query(item.target, [{ id: item.shopId, name: item.shopName }], signal, task.productStatus.value);
          product = targets.find(row => row.id === item.id && row.shopId === item.shopId);
          restore = true;
        }
        check();
        if (!product || ![item.before, item.target].includes(product.title)) throw new Error('预览后商品标题或匹配范围已变化，请重新预览');
        if (product.title === item.target) {
          item.status = 'unchanged'; item.after = item.target; item.reason = '已为目标标题，无需重复保存'; task.unchanged++;
          checkpoint(); continue;
        }
        item.status = 'saving'; task.message = `保存 ${item.shopName} · ${item.id}`;
        checkpoint();
        try {
          const result = await adapter.save(item, signal, attempts => { item.attempts = attempts; checkpoint(); });
          item.after = result.title; item.status = result.already ? 'unchanged' : 'success';
          item.reason = result.reason || '保存成功';
          if (result.already) task.unchanged++; else task.saved++;
        } catch (error) {
          if (!error.itemRejected || error.uncertain) throw error;
          item.status = 'failed'; item.skipped = true; item.reason = error.message; task.failed++;
        }
        checkpoint();
        check();
      }
    }
    check();
    task.status = task.failed ? 'completed_with_errors' : 'completed';
    task.message = `已保存 ${task.saved} 件，失败 ${task.failed} 件，已是目标 ${task.unchanged} 件`;
  } catch (error) {
    task.status = signal.aborted ? 'cancelled' : 'failed'; task.message = error.message;
    task.stopPosition = { productId: current?.id, shopId: current?.shopId, original: current?.original, reason: error.message };
    if (current && ['pending', 'saving'].includes(current.status)) {
      current.status = error.uncertain || current.status === 'saving' && current.attempts ? 'uncertain' : 'unmodified';
      current.reason = error.message;
    }
    for (const item of task.items) {
      if (item.status === 'pending') { item.status = 'unmodified'; item.reason = '任务已停止，未执行'; }
    }
  }
  task.finishedAt = new Date().toISOString(); checkpoint();
  return task;
}

module.exports = { newTask, runTask };
