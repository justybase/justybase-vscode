-- Macro External Superstore Dashboard Update: Refresh the raw source of an MIT-licensed PivotTable dashboard
%LET dashboard_file = /tmp/superstore-sales-dashboard.xlsx;
%EXPORT(
  format='xlsx',
  file='/tmp/superstore-sales-dashboard.xlsx',
  sheet='superstore',
  query=(
    SELECT order_date AS "Order Date", order_year AS "Year", order_month AS "Month", customer_name AS "Customer Name", state AS "State", category AS "Category", sub_category AS "Sub-Category", product_name AS "Product Name", sales AS "Sales", quantity AS "Quantity", profit AS "Profit"
    FROM DB.SCHEMA.SALES_ORDERS
    WHERE order_date >= CURRENT_DATE - 365
    ORDER BY order_date
  ),
  update=true
);
%PUT External PivotTable source refreshed; use Excel Data > Refresh All.;
