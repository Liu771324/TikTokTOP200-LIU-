"use strict";

importScripts("core.js");

const API_BASE = "http://127.0.0.1:8765";
const STORAGE_KEY = "skuMappings";
const FXG_ORIGIN = "https://fxg.jinritemai.com";
const core = globalThis.CostAccountingCore;
const MAX_MESSAGE_ITEMS = 2000;
let mappingWriteQueue = Promise.resolve();
let lastSuccessfulConnectionAt = null;
const SERVICE_BINDING_KEY = "costServiceBinding";
let healthCache = null;
let healthPromise = null;
let healthGeneration = 0;
let healthSignature = null;

function connectionError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.retryable = false;
  return error;
}

async function getHealth(force = false) {
  if (!force && healthCache && Date.now() - healthCache.checkedAt < 2000) return healthCache.value;
  if (healthPromise) return healthPromise;
  healthPromise = (async () => {
    try {
      const health = await fetchJson("/health");
      if (!health || typeof health !== "object") throw connectionError("protocol_error", "健康接口返回无效");
      const signature = JSON.stringify([health.service_id, health.boot_id, health.data_revision, health.status]);
      if (signature !== healthSignature) { healthGeneration += 1; healthSignature = signature; }
      healthCache = { checkedAt: Date.now(), value: health };
      lastSuccessfulConnectionAt = new Date().toISOString();
      return health;
    } catch (error) {
      healthCache = null;
      healthSignature = null;
      healthGeneration += 1;
      throw error;
    } finally { healthPromise = null; }
  })();
  return healthPromise;
}

async function serviceState(force = false) {
  const health = await getHealth(force);
  const stored = await chrome.storage.local.get(SERVICE_BINDING_KEY);
  const binding = stored[SERVICE_BINDING_KEY];
  const identityAvailable = typeof health.service_id === "string" && health.service_id.length > 0 &&
    typeof health.boot_id === "string" && health.boot_id.length > 0 &&
    typeof health.data_revision === "string" && health.data_revision.length > 0 &&
    health.capabilities?.includes("service_identity_v1");
  const pairing = identityAvailable ? { service_id: health.service_id, label: String(health.catalog_label || "本机成本目录"), environment: health.environment } : null;
  let serviceStatus = "ok";
  let serviceError = null;
  if (!identityAvailable) {
    serviceStatus = "protocol_error";
    serviceError = "当前服务缺少目录及启动身份，请同步更新成本助手和扩展";
  } else if (binding?.service_id && (binding.service_id !== health.service_id || binding.environment !== health.environment)) {
    serviceStatus = "identity_mismatch";
    serviceError = "当前服务不是已连接的成本目录，请核对管理台后再更换连接";
  } else if (identityAvailable && !binding?.service_id) {
    serviceStatus = "unpaired";
    serviceError = "首次使用，请核对成本助手后连接当前成本目录";
  } else if (health.ready === false || (health.status && health.status !== "ok")) {
    serviceStatus = "reconnecting";
    serviceError = "服务已连接，成本资料正在更新或等待恢复";
  }
  return { health, serviceStatus, serviceError, pairing, generation: healthGeneration, lastSuccessfulConnectionAt };
}

function assertCurrentResponse(payload, health, generation) {
  if (generation !== healthGeneration) throw connectionError("stale_result", "服务或数据已变化，正在重新查询");
  if (health.capabilities?.includes("service_identity_v1")) {
    const actual = payload?.service;
    if (!actual || actual.service_id !== health.service_id || actual.boot_id !== health.boot_id || actual.data_revision !== health.data_revision || actual.ready !== true) {
      healthCache = null;
      healthGeneration += 1;
      throw connectionError("stale_result", "服务重启或成本更新，旧结果已丢弃");
    }
  }
}

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
        error.code = response.status === 403 ? "origin_rejected" : "query_failed";
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
  let connection = null;
  const trueCosts = [];
  const products = [];
  try {
    connection = await serviceState();
    health = connection.health;
    if (connection.serviceStatus !== "ok") {
      return { ...core.buildTrueCostDisplayState(records, [], health, connection.serviceError), ...connection, health: undefined };
    }
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
          assertCurrentResponse(payload, health, connection.generation);
          trueCosts.push(...payload.true_costs);
        } catch (error) {
          if (["stale_result", "origin_rejected"].includes(error.code)) throw error;
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
        failedBatchCount,
        generation: connection.generation
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
      assertCurrentResponse(payload, health, connection.generation);
      if (!Array.isArray(payload?.mappings)) throw new TypeError("映射接口返回格式无效");
      databaseMappings.push(...payload.mappings);
    }
    mappings = core.mergeMappingSources(localMappings, databaseMappings);
    const plan = core.buildLookupPlan(records, mappings, 100);
    for (const batch of plan.batches) {
      const query = repeatedQuery("sku_id", batch);
      const payload = await fetchJson(`/api/v1/products?${query.toString()}`);
      assertCurrentResponse(payload, health, connection.generation);
      if (Array.isArray(payload?.products)) products.push(...payload.products);
    }
  } catch (error) {
    serviceError = error?.name === "AbortError" ? "连接本机成本服务超时，正在重连" : error?.message || "本机成本服务暂不可用";
    connection = { ...(connection || {}), serviceStatus: error.code === "stale_result" ? "reconnecting" : error.code === "origin_rejected" ? "origin_rejected" : "unavailable", serviceError };
  }
  if (useTrueCost) {
    return {
      ...core.buildTrueCostDisplayState(records, [], health, serviceError),
      lastSuccessfulConnectionAt,
      retriedBatchCount,
      failedBatchCount,
      serviceStatus: connection?.serviceStatus || "unavailable", generation: healthGeneration
    };
  }
  return {
    ...core.buildDisplayState(records, mappings, products, health, serviceError),
    lastSuccessfulConnectionAt,
    retriedBatchCount,
    failedBatchCount,
    ...(serviceError ? { serviceStatus: connection?.serviceStatus || "unavailable" } : {}), generation: healthGeneration
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

  if (message?.type === "GET_SERVICE_HEALTH" && core.isActivityPath(path)) {
    serviceState(message.force === true)
      .then(({ health, ...state }) => sendResponse({ ok: true, state: { ...state, environment: health.environment, boot_id: health.boot_id, data_revision: health.data_revision } }))
      .catch((error) => sendResponse({ ok: true, state: { serviceStatus: error.code === "origin_rejected" ? "origin_rejected" : "unavailable", serviceError: error?.name === "AbortError" ? "健康检查超时，正在重连" : "成本服务暂未连接，正在重试", lastSuccessfulConnectionAt, generation: healthGeneration } }));
    return true;
  }

  if (message?.type === "PAIR_COST_SERVICE" && core.isActivityPath(path)) {
    (async () => {
      const health = await getHealth(true);
      if (!health.capabilities?.includes("service_identity_v1") || !health.boot_id || !health.data_revision || health.service_id !== message.service_id || health.ready !== true) throw connectionError("identity_mismatch", "待连接的服务已变化或版本不匹配，请重新核对");
      await chrome.storage.local.set({ [SERVICE_BINDING_KEY]: { service_id: health.service_id, environment: health.environment, paired_at: new Date().toISOString() } });
      healthGeneration += 1;
      sendResponse({ ok: true });
    })().catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  sendResponse({ ok: false, error: "不支持的只读操作" });
  return false;
});
