(function initShippingFilters(target) {
  "use strict";

  function filterShippingProducts(products, options = {}) {
    const shop = String(options.shop ?? "");
    const status = ["all", "bound", "unbound"].includes(options.status)
      ? options.status
      : "unbound";
    const query = String(options.query ?? "").trim().toLocaleLowerCase("zh-CN");
    return (Array.isArray(products) ? products : []).filter((item) => {
      if (item?.shop_name !== shop) return false;
      const bound = Boolean(item.template_id);
      if (status === "bound" && !bound) return false;
      if (status === "unbound" && bound) return false;
      if (!query) return true;
      const searchable = `${item.product_name ?? ""} ${item.douyin_product_id ?? ""}`
        .toLocaleLowerCase("zh-CN");
      return searchable.includes(query);
    });
  }

  const api = { filterShippingProducts };
  target.CostAssistantShippingFilters = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
