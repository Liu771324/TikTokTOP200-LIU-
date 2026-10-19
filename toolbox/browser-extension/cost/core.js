(function initCostAccountingCore(target) {
  "use strict";

  const FXG_ORIGIN = "https://fxg.jinritemai.com";
  const ACTIVITY_PATH = "/ffa/merchant/parent-campaign-detail";
  const ACTIVITY_PATHS = Object.freeze([
    ACTIVITY_PATH,
    "/ffa/merchant/child-campaign-detail"
  ]);
  const ACTIVITY_PATH_SET = new Set(ACTIVITY_PATHS);
  const EDIT_PATH = "/ffa/g/create";
  const LABELS = new Set([
    "SKUID",
    "原价",
    "校验价",
    "普惠到手价",
    "最低到手价",
    "商品SKU信息",
    "商品信息"
  ]);

  function normalizeText(value) {
    return String(value ?? "")
      .replace(/\r/g, "")
      .replace(/[\t\f\v]+/g, " ")
      .replace(/\u00a0/g, " ")
      .replace(/[ ]{2,}/g, " ")
      .trim();
  }

  function isActivityPath(pathname) {
    return ACTIVITY_PATH_SET.has(String(pathname ?? "").replace(/\/+$/, ""));
  }

  function detectPageRoute(origin, pathname) {
    if (origin !== FXG_ORIGIN) return null;
    if (isActivityPath(pathname)) return "activity";
    if (String(pathname ?? "").replace(/\/+$/, "") === EDIT_PATH) return "edit";
    return null;
  }

  function createCoalescedRunner(task) {
    let running = false;
    let pending = false;
    function run() {
      if (running) {
        pending = true;
        return false;
      }
      running = true;
      return (async () => {
        try {
          do {
            pending = false;
            await task();
          } while (pending);
        } finally {
          running = false;
          pending = false;
        }
      })();
    }
    return {
      run,
      status: () => ({ running, pending })
    };
  }

  function textLines(value) {
    return normalizeText(value)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function normalizeCode(value) {
    const code = String(value ?? "").trim();
    if (!code || /[\u0000-\u001f\u007f]/.test(code)) return null;
    return code;
  }

  function isQueryableMerchantCode(value) {
    const code = normalizeCode(value);
    return Boolean(code && code.length <= 200);
  }

  function nodeText(node) {
    return node?.innerText ?? node?.textContent ?? "";
  }

  function hasSemanticLabel(value, label) {
    const lines = textLines(value);
    return lines.some(
      (line) => line === label || line.startsWith(`${label}：`) || line.startsWith(`${label}:`)
    );
  }

  function elementChildren(node) {
    return Array.from(node?.children ?? []);
  }

  function allElements(scope) {
    if (!scope) return [];
    const descendants = scope.querySelectorAll ? Array.from(scope.querySelectorAll("*")) : [];
    return [scope, ...descendants];
  }

  function depthFrom(node, scope) {
    let depth = 0;
    let current = node;
    while (current && current !== scope) {
      depth += 1;
      current = current.parentElement;
    }
    return depth;
  }

  function findSlotContainer(scope, label) {
    let best = null;
    let tied = false;
    for (const node of allElements(scope)) {
      const children = elementChildren(node);
      if (children.length === 0 || children.length > 100) continue;
      const marked = children.filter((child) => hasSemanticLabel(nodeText(child), label));
      if (marked.length === 0) continue;
      const ratio = marked.length / children.length;
      const score = ratio * 1000 + marked.length * 100 + depthFrom(node, scope) - children.length;
      if (!best || score > best.score) {
        best = { node, slots: marked, score };
        tied = false;
      } else if (score === best.score && node !== best.node) {
        tied = true;
      }
    }
    return tied ? null : best;
  }

  function extractPlatformSkuResult(value) {
    const matches = Array.from(
      normalizeText(value).matchAll(/(?:^|\n|\s)SKUID\s*[:：]?\s*([0-9A-Za-z_-]+)/gi)
    );
    return {
      count: matches.length,
      value: matches.length === 1 ? normalizeCode(matches[0][1]) : null
    };
  }

  function extractPlatformSku(value) {
    return extractPlatformSkuResult(value).value;
  }

  function extractSpec(value) {
    const lines = textLines(value);
    const skuIndex = lines.findIndex((line) => /^SKUID\s*[:：]?/i.test(line));
    const candidates = (skuIndex < 0 ? lines : lines.slice(0, skuIndex)).filter((line) => {
      if (LABELS.has(line)) return false;
      if (/^(原价|商品ID|商品SKU信息)\s*[:：]?/i.test(line)) return false;
      if (/^[¥￥]\s*-?\d/.test(line)) return false;
      return true;
    });
    return candidates.at(-1) ?? "未识别规格";
  }

  function extractExactMoneyResult(value, label) {
    const lines = textLines(value);
    const moneyPattern = /^[¥￥]?\s*(-?\d+(?:,\d{3})*(?:\.\d+)?)\s*(?:元)?$/;
    const matches = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === label) {
        const next = lines[index + 1] ?? "";
        const match = next.match(moneyPattern);
        matches.push(match ? match[1].replaceAll(",", "") : null);
        continue;
      }
      const prefix = line.match(new RegExp(`^${label}\\s*[:：]\\s*(.*)$`));
      if (prefix) {
        const match = prefix[1].match(moneyPattern);
        matches.push(match ? match[1].replaceAll(",", "") : null);
      }
    }
    return { count: matches.length, value: matches.length === 1 ? matches[0] : null };
  }

  function extractExactMoney(value, label) {
    return extractExactMoneyResult(value, label).value;
  }

  function productNameFromRow(row) {
    const firstCell = elementChildren(row)[0];
    const lines = textLines(nodeText(firstCell));
    return (
      lines.find((line) => !/^\d{8,}$/.test(line) && !/^商品\s*ID/i.test(line)) ??
      "未识别商品"
    );
  }

  function parseActivityProductRow(row) {
    const productId = normalizeCode(row?.getAttribute?.("data-row-key"));
    const skuContainer = findSlotContainer(row, "SKUID");
    const priceContainer = findSlotContainer(row, "最低到手价");
    if (!productId || !skuContainer || !priceContainer) {
      return {
        records: [],
        warning: "页面结构未识别"
      };
    }
    if (skuContainer.slots.length !== priceContainer.slots.length) {
      return {
        records: [],
        warning: `SKU 与最低到手价槽位数量不一致（${skuContainer.slots.length}/${priceContainer.slots.length}）`
      };
    }

    const productName = productNameFromRow(row);
    const records = [];
    for (let index = 0; index < skuContainer.slots.length; index += 1) {
      const skuSlot = skuContainer.slots[index];
      const priceSlot = priceContainer.slots[index];
      const skuResult = extractPlatformSkuResult(skuSlot.textContent);
      const priceResult = extractExactMoneyResult(nodeText(priceSlot), "最低到手价");
      if (skuResult.count !== 1 || priceResult.count !== 1) {
        return {
          records: [],
          warning: `SKU 或最低到手价槽位存在歧义（第 ${index + 1} 项）`
        };
      }
      const platformSkuId = skuResult.value;
      records.push({
        key: `${productId}::${platformSkuId ?? `slot-${index}`}`,
        productId,
        productName,
        platformSkuId,
        spec: extractSpec(nodeText(skuSlot)),
        lowestPrice: priceResult.value
      });
    }
    return { records, warning: null };
  }

  function mergeParsedRecord(byKey, conflictedKeys, warnings, record) {
    if (conflictedKeys.has(record.key)) return;
    const existing = byKey.get(record.key);
    if (!existing) {
      byKey.set(record.key, record);
      return;
    }
    const agrees = ["productId", "productName", "platformSkuId", "spec", "lowestPrice"].every(
      (field) => existing[field] === record[field]
    );
    if (!agrees) {
      byKey.delete(record.key);
      conflictedKeys.add(record.key);
      warnings.push({ productId: record.productId, message: "重复 SKU 行数据不一致，已停止计算" });
    }
  }

  function parseMainActivityRows(root) {
    const rows = root?.querySelectorAll
      ? Array.from(root.querySelectorAll(".antd-table-row[data-row-key]"))
      : [];
    const byKey = new Map();
    const conflictedKeys = new Set();
    const warnings = [];
    for (const row of rows) {
      const rowText = normalizeText(nodeText(row));
      if (!hasSemanticLabel(rowText, "SKUID") || !hasSemanticLabel(rowText, "最低到手价")) {
        continue;
      }
      const parsed = parseActivityProductRow(row);
      if (parsed.warning) {
        warnings.push({ productId: row.getAttribute?.("data-row-key") ?? null, message: parsed.warning });
      }
      for (const record of parsed.records) mergeParsedRecord(byKey, conflictedKeys, warnings, record);
    }
    return { records: Array.from(byKey.values()), warnings };
  }

  function findAllSkuDrawer(root) {
    const candidates = root?.querySelectorAll
      ? Array.from(root.querySelectorAll('[role="dialog"], [class*="drawer"], [class*="Drawer"]'))
      : [];
    const matching = candidates.filter((node) => {
      const text = nodeText(node);
      return hasSemanticLabel(text, "修改报名信息") &&
        hasSemanticLabel(text, "SKU规格") &&
        hasSemanticLabel(text, "报名价") &&
        hasSemanticLabel(text, "到手价");
    });
    return matching.sort((left, right) => depthFrom(right, root) - depthFrom(left, root))[0] ?? null;
  }

  function extractDrawerSkuResult(value) {
    const matches = textLines(value)
      .map((line) => line.match(/^ID\s*[:：]\s*([0-9A-Za-z_-]+)$/i))
      .filter(Boolean);
    return {
      count: matches.length,
      value: matches.length === 1 ? normalizeCode(matches[0][1]) : null
    };
  }

  function firstDrawerId(value) {
    for (const line of textLines(value)) {
      const match = line.match(/^ID\s*[:：]\s*([0-9A-Za-z_-]+)$/i);
      if (match) return normalizeCode(match[1]);
    }
    return null;
  }

  function drawerProductName(value) {
    const lines = textLines(value);
    const idIndex = lines.findIndex((line) => /^ID\s*[:：]/i.test(line));
    if (idIndex <= 0) return "未识别商品";
    const excluded = new Set(["修改报名信息", "SKU规格", "报名价", "到手价"]);
    return lines.slice(0, idIndex).filter((line) => !excluded.has(line)).at(-1) ?? "未识别商品";
  }

  function drawerCategoryLevels(drawer) {
    const labels = allElements(drawer).filter((node) => {
      const value = normalizeText(nodeText(node)).replace(/[：:]$/, "");
      return elementChildren(node).length === 0 && value === "商品类目";
    });
    for (const label of labels) {
      let container = label.parentElement;
      while (container) {
        const leafValues = allElements(container)
          .filter((node) => elementChildren(node).length === 0)
          .map((node) => normalizeText(nodeText(node)))
          .filter(Boolean);
        const labelIndex = leafValues.findIndex(
          (value) => value.replace(/[：:]$/, "") === "商品类目"
        );
        const levels = leafValues
          .slice(labelIndex + 1)
          .filter((value) => !/^[>›／/]$/.test(value));
        if (labelIndex >= 0 && levels.length === 4) return levels;
        if (container === drawer || levels.length > 4) break;
        container = container.parentElement;
      }
    }
    return null;
  }

  function drawerSpec(value) {
    const lines = textLines(value);
    const idIndex = lines.findIndex((line) => /^ID\s*[:：]/i.test(line));
    if (idIndex <= 0) return "未识别规格";
    const excluded = new Set(["SKU规格", "报名价", "到手价", "最低到手价"]);
    return lines.slice(0, idIndex).filter((line) => !excluded.has(line)).at(-1) ?? "未识别规格";
  }

  function parseAllSkuDrawer(drawer) {
    const productId = firstDrawerId(nodeText(drawer));
    if (!productId) {
      return {
        source: "all_sku_drawer",
        scopeKey: null,
        records: [],
        warnings: [{ productId: null, message: "侧边栏商品 ID 未识别，已停止计算" }]
      };
    }
    const categoryLevels = drawerCategoryLevels(drawer);
    const candidates = allElements(drawer).filter((node) => {
      const text = nodeText(node);
      return hasSemanticLabel(text, "原价") &&
        extractDrawerSkuResult(text).count === 1 &&
        extractExactMoneyResult(text, "最低到手价").count === 1;
    });
    const rows = candidates.filter(
      (candidate) => !candidates.some((other) => other !== candidate && candidate.contains?.(other))
    );
    const byKey = new Map();
    const conflictedKeys = new Set();
    const warnings = [];
    for (const row of rows) {
      const skuResult = extractDrawerSkuResult(nodeText(row));
      const priceResult = extractExactMoneyResult(nodeText(row), "最低到手价");
      const record = {
        key: `${productId}::${skuResult.value}`,
        productId,
        productName: drawerProductName(nodeText(drawer)),
        platformSkuId: skuResult.value,
        spec: drawerSpec(nodeText(row)),
        lowestPrice: priceResult.value,
        priceSource: "查看全部SKU信息侧边栏",
        ...(categoryLevels ? { categoryLevels: [...categoryLevels] } : {})
      };
      mergeParsedRecord(byKey, conflictedKeys, warnings, record);
    }
    if (rows.length === 0) {
      warnings.push({ productId, message: "侧边栏当前挂载区域未识别到 SKU，页面结构可能已更新" });
    }
    return { source: "all_sku_drawer", scopeKey: productId, records: Array.from(byKey.values()), warnings };
  }

  function parseActivityRows(root) {
    const drawer = findAllSkuDrawer(root);
    if (!drawer) {
      return {
        source: "drawer_closed",
        scopeKey: null,
        records: [],
        warnings: [{ productId: null, message: "未找到 SKU 侧边栏；请先展开“查看全部SKU信息”。若已展开，页面结构可能已更新" }]
      };
    }
    return parseAllSkuDrawer(drawer);
  }

  function findHeaderIndexes(table) {
    const headers = table?.querySelectorAll ? Array.from(table.querySelectorAll("thead th")) : [];
    const normalized = headers.map((header) => normalizeText(nodeText(header)));
    return {
      skuIndex: normalized.findIndex((text) => text === "SKUID"),
      merchantIndex: normalized.findIndex((text) => text === "商家编码")
    };
  }

  function exactCellCode(cell, headerLabel) {
    const lines = textLines(nodeText(cell)).filter((line) => line !== headerLabel);
    if (lines.length !== 1) return null;
    return /^[0-9A-Za-z_./+,-]+$/.test(lines[0]) ? normalizeCode(lines[0]) : null;
  }

  function hasClass(element, className) {
    return Boolean(element?.classList?.contains?.(className) || element?.classNames?.has?.(className));
  }

  function findEditRowCells(input, row) {
    const cells = elementChildren(row);
    const table = input.closest?.("table");
    if (table) {
      const { skuIndex, merchantIndex } = findHeaderIndexes(table);
      if (skuIndex >= 0 && merchantIndex >= 0 && cells[skuIndex] && cells[merchantIndex]) {
        return { skuCell: cells[skuIndex], merchantCell: cells[merchantIndex] };
      }
    }
    const skuCells = cells.filter((cell) => hasClass(cell, "attr-column-field_sku_id"));
    const merchantCells = cells.filter((cell) => hasClass(cell, "attr-column-field_code"));
    if (skuCells.length !== 1 || merchantCells.length !== 1) return null;
    return { skuCell: skuCells[0], merchantCell: merchantCells[0] };
  }

  function parseEditMappings(root, sourcePath = EDIT_PATH, sourceProductId = null) {
    const inputs = root?.querySelectorAll
      ? Array.from(root.querySelectorAll('input[placeholder="请输入erp编码"]'))
      : [];
    const observations = [];
    const seen = new Set();
    let skipped = 0;
    for (const input of inputs) {
      const row = input.closest?.("tr");
      if (!row) {
        skipped += 1;
        continue;
      }
      const rowCells = findEditRowCells(input, row);
      if (!rowCells) {
        skipped += 1;
        continue;
      }
      if (!rowCells.merchantCell.contains?.(input)) {
        skipped += 1;
        continue;
      }
      const platformSkuId = exactCellCode(rowCells.skuCell, "SKUID");
      const merchantSkuCode = normalizeCode(input.value);
      if (!platformSkuId || !isQueryableMerchantCode(merchantSkuCode)) {
        skipped += 1;
        continue;
      }
      const dedupeKey = `${platformSkuId}\u0000${merchantSkuCode}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      observations.push({
        platformSkuId,
        merchantSkuCode,
        sourcePath,
        sourceProductId: normalizeCode(sourceProductId)
      });
    }
    return { observations, skipped };
  }

  function mergeMappingObservations(current, observations, observedAt) {
    const next = structuredClone(current ?? {});
    let added = 0;
    let refreshed = 0;
    let conflicts = 0;
    for (const observation of observations ?? []) {
      const platformSkuId = normalizeCode(observation.platformSkuId);
      const merchantSkuCode = normalizeCode(observation.merchantSkuCode);
      if (!platformSkuId || !isQueryableMerchantCode(merchantSkuCode)) continue;
      const existing = next[platformSkuId];
      const newHistoryEntry = {
        merchantSkuCode,
        sourcePath: observation.sourcePath ?? EDIT_PATH,
        sourceProductId: normalizeCode(observation.sourceProductId),
        observedAt
      };
      if (!existing) {
        next[platformSkuId] = {
          status: "observed_exact_row",
          merchantSkuCode,
          candidateMerchantCodes: [merchantSkuCode],
          sourcePath: observation.sourcePath ?? EDIT_PATH,
          sourceProductId: normalizeCode(observation.sourceProductId),
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          observationHistory: [newHistoryEntry]
        };
        added += 1;
        continue;
      }
      const candidates = new Set(existing.candidateMerchantCodes ?? []);
      if (existing.merchantSkuCode) candidates.add(existing.merchantSkuCode);
      candidates.add(merchantSkuCode);
      const priorHistory = Array.isArray(existing.observationHistory)
        ? existing.observationHistory
        : existing.merchantSkuCode
          ? [{
              merchantSkuCode: existing.merchantSkuCode,
              sourcePath: existing.sourcePath ?? EDIT_PATH,
              sourceProductId: normalizeCode(existing.sourceProductId),
              observedAt: existing.lastObservedAt ?? existing.firstObservedAt ?? null
            }]
          : [];
      const observationHistory = [...priorHistory, newHistoryEntry].slice(-20);
      if (candidates.size > 1) {
        next[platformSkuId] = {
          ...existing,
          status: "conflict",
          merchantSkuCode: null,
          candidateMerchantCodes: Array.from(candidates).sort(),
          lastObservedAt: observedAt,
          observationHistory
        };
        conflicts += 1;
      } else {
        next[platformSkuId] = {
          ...existing,
          status: "observed_exact_row",
          merchantSkuCode,
          candidateMerchantCodes: [merchantSkuCode],
          lastObservedAt: observedAt,
          observationHistory
        };
        refreshed += 1;
      }
    }
    return { mappings: next, added, refreshed, conflicts };
  }

  function mergeMappingSources(localMappings, databaseMappings) {
    const merged = structuredClone(localMappings ?? {});
    for (const mapping of databaseMappings ?? []) {
      if (mapping?.status !== "verified") continue;
      const platformSkuId = normalizeCode(mapping.douyin_sku_id);
      const merchantSkuCode = normalizeCode(mapping.jushuitan_sku_id);
      if (!platformSkuId || !isQueryableMerchantCode(merchantSkuCode)) continue;
      merged[platformSkuId] = {
        status: "verified_import",
        merchantSkuCode,
        importBatchId: mapping.import_batch_id ?? null
      };
    }
    return merged;
  }

  function mappingForRecord(record, mappings) {
    if (!record.platformSkuId) return { status: "platform_sku_missing", merchantSkuCode: null };
    const mapping = mappings?.[record.platformSkuId];
    if (!mapping) return { status: "mapping_missing", merchantSkuCode: null };
    if (mapping.status === "conflict" || !isQueryableMerchantCode(mapping.merchantSkuCode)) {
      return { status: "mapping_conflict", merchantSkuCode: null };
    }
    return { status: "mapped", merchantSkuCode: mapping.merchantSkuCode };
  }

  function buildLookupPlan(records, mappings, batchSize = 100) {
    const normalizedBatchSize = Math.max(1, Math.min(100, Number(batchSize) || 100));
    const recordMappings = records.map((record) => ({
      record,
      mapping: mappingForRecord(record, mappings)
    }));
    const codes = Array.from(
      new Set(
        recordMappings
          .filter(({ mapping }) => mapping.status === "mapped")
          .map(({ mapping }) => mapping.merchantSkuCode)
      )
    );
    const batches = [];
    for (let index = 0; index < codes.length; index += normalizedBatchSize) {
      batches.push(codes.slice(index, index + normalizedBatchSize));
    }
    return { recordMappings, batches };
  }

  function parseDecimal(value) {
    if (value === null || value === undefined || normalizeText(value) === "") return null;
    const raw = normalizeText(value).replace(/[¥￥,\s]/g, "").replace(/元$/, "");
    const match = raw.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!match) return null;
    const fraction = match[3] ?? "";
    const sign = match[1] === "-" ? -1n : 1n;
    return {
      units: sign * BigInt(`${match[2]}${fraction}`),
      scale: fraction.length
    };
  }

  function pow10(exponent) {
    return 10n ** BigInt(exponent);
  }

  function unitsAtScale(decimal, scale) {
    return decimal.units * pow10(scale - decimal.scale);
  }

  function roundDivide(numerator, denominator) {
    if (denominator === 0n) throw new RangeError("division by zero");
    const negative = (numerator < 0n) !== (denominator < 0n);
    const absoluteNumerator = numerator < 0n ? -numerator : numerator;
    const absoluteDenominator = denominator < 0n ? -denominator : denominator;
    let quotient = absoluteNumerator / absoluteDenominator;
    const remainder = absoluteNumerator % absoluteDenominator;
    if (remainder * 2n >= absoluteDenominator) quotient += 1n;
    return negative ? -quotient : quotient;
  }

  function roundedUnits(decimal, targetScale) {
    if (decimal.scale === targetScale) return decimal.units;
    if (decimal.scale < targetScale) return decimal.units * pow10(targetScale - decimal.scale);
    return roundDivide(decimal.units, pow10(decimal.scale - targetScale));
  }

  function formatFixedUnits(units, scale, forceSign = false) {
    const negative = units < 0n;
    const absolute = negative ? -units : units;
    const raw = absolute.toString().padStart(scale + 1, "0");
    const integer = scale === 0 ? raw : raw.slice(0, -scale);
    const fraction = scale === 0 ? "" : `.${raw.slice(-scale)}`;
    const sign = negative ? "-" : forceSign ? "+" : "";
    return `${sign}${integer}${fraction}`;
  }

  function formatDecimal(decimal, digits = 2, forceSign = false) {
    return formatFixedUnits(roundedUnits(decimal, digits), digits, forceSign);
  }

  function calculateComparison(lowestPrice, costPrice) {
    const lowest = parseDecimal(lowestPrice);
    if (!lowest) return { status: "lowest_missing" };
    const cost = parseDecimal(costPrice);
    if (!cost) return { status: "cost_missing", lowest: formatDecimal(lowest) };
    if (cost.units < 0n) {
      return {
        status: "invalid_cost",
        lowest: formatDecimal(lowest),
        cost: formatDecimal(cost)
      };
    }
    if (cost.units === 0n) {
      return { status: "zero_cost", lowest: formatDecimal(lowest), cost: formatDecimal(cost) };
    }
    const scale = Math.max(lowest.scale, cost.scale);
    const lowestUnits = unitsAtScale(lowest, scale);
    const costUnits = unitsAtScale(cost, scale);
    const delta = { units: lowestUnits - costUnits, scale };
    const rateHundredths = roundDivide(delta.units * 10000n, costUnits);
    return {
      status: delta.units > 0n ? "above_cost" : delta.units < 0n ? "below_cost" : "at_cost",
      lowest: formatDecimal(lowest),
      cost: formatDecimal(cost),
      delta: formatDecimal(delta, 2, true),
      rate: `${formatFixedUnits(rateHundredths, 2, true)}%`
    };
  }

  function buildDisplayState(records, mappings, products, health, serviceError = null) {
    const productByCode = new Map((products ?? []).map((product) => [String(product.sku_id), product]));
    const items = records.map((record) => {
      const mapping = mappingForRecord(record, mappings);
      if (serviceError) return { ...record, mapping, status: "service_unavailable" };
      if (mapping.status !== "mapped") return { ...record, mapping, status: mapping.status };
      const product = productByCode.get(mapping.merchantSkuCode);
      if (!product) return { ...record, mapping, status: "cost_not_found" };
      const comparison = calculateComparison(record.lowestPrice, product.cost_price);
      return { ...record, mapping, product, comparison, status: comparison.status };
    });
    return {
      serviceStatus: serviceError ? "unavailable" : "ok",
      serviceError,
      environment: health?.environment ?? "unknown",
      lastSuccessfulSync: health?.last_successful_sync ?? null,
      totalCount: health?.total_count ?? null,
      enabledCount: health?.enabled_count ?? null,
      items
    };
  }

  function buildTrueCostDisplayState(records, estimates, health, serviceError = null) {
    const estimateQueues = new Map();
    for (const estimate of estimates ?? []) {
      const platformSkuId = normalizeCode(estimate?.douyin_sku_id);
      if (!platformSkuId) continue;
      if (!estimateQueues.has(platformSkuId)) estimateQueues.set(platformSkuId, []);
      estimateQueues.get(platformSkuId).push(estimate);
    }
    const items = records.map((record) => {
      if (serviceError) return { ...record, status: "service_unavailable" };
      const platformSkuId = normalizeCode(record?.platformSkuId);
      if (!platformSkuId) return { ...record, status: "platform_sku_missing" };
      if (!parseDecimal(record?.lowestPrice)) return { ...record, status: "lowest_missing" };
      const estimate = estimateQueues.get(platformSkuId)?.shift();
      if (!estimate) return { ...record, status: "true_cost_unconfigured", unconfiguredReasons: ["真实成本配置未返回"] };
      const mapping = {
        status: estimate.jushuitan_sku_id ? "mapped" : "mapping_missing",
        merchantSkuCode: normalizeCode(estimate.jushuitan_sku_id)
      };
      if (!estimate.available) {
        const reasons = Array.isArray(estimate.unconfigured_reasons)
          ? [...estimate.unconfigured_reasons]
          : ["真实成本配置不完整"];
        const hasPageCategories = Array.isArray(record.categoryLevels) &&
          record.categoryLevels.length === 4 && record.categoryLevels.every((value) => normalizeText(value));
        const storedCategoryIncomplete = Array.isArray(estimate.category_levels) &&
          estimate.category_levels.length === 4 && estimate.category_levels.some((value) => !normalizeText(value));
        if (!hasPageCategories && estimate.category_source === "mapping" && storedCategoryIncomplete) {
          reasons.unshift("页面商品类目未识别，已使用成本库中的不完整类目");
        }
        return {
          ...record,
          mapping,
          trueCost: estimate,
          status: "true_cost_unconfigured",
          unconfiguredReasons: reasons
        };
      }
      const comparison = calculateComparison(record.lowestPrice, estimate.true_cost);
      return {
        ...record,
        mapping,
        trueCost: estimate,
        comparison,
        status: comparison.status
      };
    });
    return {
      serviceStatus: serviceError ? "unavailable" : "ok",
      serviceError,
      environment: health?.environment ?? "unknown",
      lastSuccessfulSync: health?.last_successful_sync ?? null,
      totalCount: health?.total_count ?? null,
      enabledCount: health?.enabled_count ?? null,
      items
    };
  }

  const api = {
    ACTIVITY_PATH,
    ACTIVITY_PATHS,
    EDIT_PATH,
    isActivityPath,
    detectPageRoute,
    createCoalescedRunner,
    normalizeText,
    normalizeCode,
    isQueryableMerchantCode,
    hasSemanticLabel,
    extractPlatformSku,
    extractSpec,
    extractExactMoney,
    drawerCategoryLevels,
    findSlotContainer,
    parseActivityProductRow,
    parseMainActivityRows,
    parseAllSkuDrawer,
    parseActivityRows,
    parseEditMappings,
    mergeMappingObservations,
    mergeMappingSources,
    mappingForRecord,
    buildLookupPlan,
    parseDecimal,
    calculateComparison,
    buildDisplayState,
    buildTrueCostDisplayState
  };

  target.CostAccountingCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
