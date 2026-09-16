const BUSINESS_SEARCH_URL = "https://fxg.jinritemai.com/ffa/bu/NewBusinessCenter/search";

export function buildBusinessSearchUrl(term) {
  const url = new URL(BUSINESS_SEARCH_URL);
  url.searchParams.set("clueChannel", "bu_all");
  url.searchParams.set("clueId", String(term || "").trim());
  url.searchParams.set("source", "business_center");
  return url.href;
}

export async function runBusinessSearchAttempts(operation, { attempts = 3, onRetry = async () => {} } = {}) {
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
