"use strict";

importScripts("core.js");

const API_BASE = "http://127.0.0.1:8765";
const STORAGE_KEY = "skuMappings";
const FXG_ORIGIN = "https://fxg.jinritemai.com";
const core = globalThis.CostAccountingCore;
const MAX_MESSAGE_ITEMS = 2000;
let mappingWriteQueue = Promise.resolve();
let lastSuccessfulConnectionAt = null;

function senderPath(sender) {
  try {
    const url = new URL(sender?.url ?? "");
    return url.origin === FXG_ORIGIN ? url.pathname : null;
  } catch {
    return null;
  }
}

async function fetchJson(path, { attempts = 1, onRetry = null } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method: "GET",
        cache: "no-store",
        credentials: "omit",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status >= 500;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || error?.retryable === false) throw error;
      onRetry?.();
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error("请求失败");
}

async function loadMappings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] ?? {};
}

async function storeMappingObservationsUnlocked(observations) {
  const current = await loadMappings();
  const observedAt = new Date().toISOString();
  const merged = core.mergeMappingObservations(current, observations, observedAt);
  await chrome.storage.local.set({ [STORAGE_KEY]: merged.mappings });
  return {
    observed: observations.length,
    added: merged.added,
    refreshed: merged.refreshed,
    conflicts: merged.conflicts
  };
}

function storeMappingObservations(observations) {
  const task = mappingWriteQueue.then(() => storeMappingObservationsUnlocked(observations));
  mappingWriteQueue = task.catch(() => undefined);
  return task;
}

function boundedItems(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_MESSAGE_ITEMS) throw new RangeError(`页面记录数量超过 ${MAX_MESSAGE_ITEMS} 条安全上限`);
  return value;
}

function messageError(error) {
  const payload = { ok: false, error: error?.message ?? "请求失败" };
  if (error instanceof RangeError) payload.code = "record_limit_exceeded";
  return payload;
}

function repeatedQuery(name, values) {
  const query = new URLSearchParams();
  for (const value of values) query.append(name, value);
  return query;
}

async function activityState(records) {
  const localMappings = await loadMappings();
  let mappings = localMappings;
  let health = null;
  let serviceError = null;
  let useTrueCost = false;
  let retriedBatchCount = 0;
  let failedBatchCount = 0;
  const trueCosts = [];
  const products = [];
  try {
    health = await fetchJson("/health");
    lastSuccessfulConnectionAt = new Date().toISOString();
    useTrueCost = Array.isArray(health?.capabilities) &&
      health.capabilities.includes("true_cost_breakdown_v1");
    const usePageCategories = Array.isArray(health?.capabilities) &&
      health.capabilities.includes("page_category_context_v1");
    if (useTrueCost) {
      const queryable = records.filter((record) =>
        core.normalizeCode(record?.platformSkuId) && core.parseDecimal(record?.lowestPrice)
      );
      for (let index = 0; index < queryable.length; index += 100) {
        const batch = queryable.slice(index, index + 100);
        const query = new URLSearchParams();
        for (const record of batch) {
          query.append("douyin_sku_id", core.normalizeCode(record.platformSkuId));
          query.append("lowest_price", String(record.lowestPrice));
          if (usePageCategories) {
            const levels = Array.isArray(record.categoryLevels) && record.categoryLevels.length === 4
              ? record.categoryLevels.map((value) => String(value ?? "").trim())
              : ["", "", "", ""];
            for (let level = 0; level < 4; level += 1) {
              query.append(`category_level_${level + 1}`, levels[level]);
            }
          }
        }
        try {
          const payload = await fetchJson(
            `/api/v1/true-costs?${query.toString()}`,
            { attempts: 2, onRetry: () => { retriedBatchCount += 1; } }
          );
          if (!Array.isArray(payload?.true_costs)) {
            throw new TypeError("真实成本接口返回格式无效");
          }
          trueCosts.push(...payload.true_costs);
        } catch {
          failedBatchCount += 1;
          trueCosts.push(...batch.map((record) => ({
            douyin_sku_id: core.normalizeCode(record.platformSkuId),
            available: false,
            jushuitan_sku_id: null,
            product_cost: null,
            shipping_fee: null,
            basic_service_fee: null,
            basic_service_fee_rate: null,
            category_levels: [],
            category_source: "none",
            true_cost: null,
            unconfigured_reasons: ["真实成本批次查询失败，请重试"]
          })));
        }
      }
      return {
        ...core.buildTrueCostDisplayState(records, trueCosts, health),
        lastSuccessfulConnectionAt,
        retriedBatchCount,
        failedBatchCount
      };
    }
    const platformSkuIds = Array.from(
      new Set(records.map((record) => core.normalizeCode(record?.platformSkuId)).filter(Boolean))
    );
    const databaseMappings = [];
    for (let index = 0; index < platformSkuIds.length; index += 100) {
      const batch = platformSkuIds.slice(index, index + 100);
      const query = repeatedQuery("douyin_sku_id", batch);
      const payload = await fetchJson(`/api/v1/mappings?${query.toString()}`);
      if (!Array.isArray(payload?.mappings)) throw new TypeError("映射接口返回格式无效");
      databaseMappings.push(...payload.mappings);
    }
    mappings = core.mergeMappingSources(localMappings, databaseMappings);
    const plan = core.buildLookupPlan(records, mappings, 100);
    for (const batch of plan.batches) {
      const query = repeatedQuery("sku_id", batch);
      const payload = await fetchJson(`/api/v1/products?${query.toString()}`);
      if (Array.isArray(payload?.products)) products.push(...payload.products);
    }
  } catch (error) {
    serviceError = error?.name === "AbortError" ? "连接本机成本服务超时" : "本机成本服务不可用";
  }
  if (useTrueCost) {
    return {
      ...core.buildTrueCostDisplayState(records, [], health, serviceError),
      lastSuccessfulConnectionAt,
      retriedBatchCount,
      failedBatchCount
    };
  }
  return {
    ...core.buildDisplayState(records, mappings, products, health, serviceError),
    lastSuccessfulConnectionAt,
    retriedBatchCount,
    failedBatchCount
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const path = senderPath(sender);
  if (sender.id !== chrome.runtime.id || !path) {
    sendResponse({ ok: false, error: "消息来源未获允许" });
    return false;
  }

  if (message?.type === "STORE_MAPPINGS" && path === core.EDIT_PATH) {
    let observations;
    try {
      observations = boundedItems(message.observations);
    } catch (error) {
      sendResponse(messageError(error));
      return false;
    }
    storeMappingObservations(observations)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch(() => sendResponse({ ok: false, error: "映射保存失败" }));
    return true;
  }

  if (message?.type === "GET_ACTIVITY_STATE" && core.isActivityPath(path)) {
    let records;
    try {
      records = boundedItems(message.records);
    } catch (error) {
      sendResponse(messageError(error));
      return false;
    }
    activityState(records)
      .then((state) => sendResponse({ ok: true, state }))
      .catch(() => sendResponse({ ok: false, error: "成本状态读取失败" }));
    return true;
  }

  sendResponse({ ok: false, error: "不支持的只读操作" });
  return false;
});
