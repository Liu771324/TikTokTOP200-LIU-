export function classifyCompassResult(tableInfo, bodyText) {
  if (tableInfo?.headers?.length) return "table";
  if (/(?:暂无数据|暂无搜索结果|未查询到相关数据)/.test(String(bodyText || ""))) return "empty";
  return "pending";
}

export async function runCompassAttempts(operation, { attempts = 3, onRetry = async () => {} } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await onRetry(error, attempt);
    }
  }
  throw lastError;
}
