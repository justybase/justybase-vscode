-- Macro Bank Sales Dashboard Update: Refresh two raw tabs in the generated bank sales dashboard
%LET dashboard_file = /tmp/bank-sales-overview.xlsx;
%EXPORT(
  format='xlsx',
  file='/tmp/bank-sales-overview.xlsx',
  sheet='Raw_Monthly',
  query=(
    SELECT month,
           COUNT(*) AS new_ror_accounts,
           COUNT(*) AS credit_applications,
           COUNT(*) AS credit_sales,
           COUNT(*) * 100000 AS credit_volume_pln,
           1 AS active_campaigns,
           0.50 AS conversion_rate
    FROM DB.SCHEMA.SALES_EVENTS
    WHERE report_date >= CURRENT_DATE - 30
    GROUP BY month
  ),
  update=true
);
%EXPORT(
  format='xlsx',
  file='/tmp/bank-sales-overview.xlsx',
  sheet='Raw_Products',
  query=(SELECT product, category, applications, approved, sold, volume_pln, share_of_sales FROM DB.SCHEMA.PRODUCT_SALES),
  update=true
);
