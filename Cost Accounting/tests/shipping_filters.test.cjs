"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { filterShippingProducts } = require("../cost_sync/webview_static/shipping_filters.js");

const PRODUCTS = [
  { shop_name: "铭香馆", douyin_product_id: "P-100", product_name: "桂花糕", template_id: null },
  { shop_name: "铭香馆", douyin_product_id: "P-200", product_name: "茉莉花茶", template_id: 7 },
  { shop_name: "其他店", douyin_product_id: "P-300", product_name: "桂花茶", template_id: null },
];

test("shipping product filter defaults to unbound products in the selected shop", () => {
  assert.deepEqual(
    filterShippingProducts(PRODUCTS, { shop: "铭香馆" }).map((item) => item.douyin_product_id),
    ["P-100"]
  );
});

test("shipping product filter supports binding state and product name or id search", () => {
  assert.deepEqual(
    filterShippingProducts(PRODUCTS, { shop: "铭香馆", status: "bound", query: "茉莉" })
      .map((item) => item.douyin_product_id),
    ["P-200"]
  );
  assert.deepEqual(
    filterShippingProducts(PRODUCTS, { shop: "铭香馆", status: "all", query: "p-100" })
      .map((item) => item.douyin_product_id),
    ["P-100"]
  );
});
