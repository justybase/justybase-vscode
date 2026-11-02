-- Macro Branch Productization Dashboard Update: Refresh branch ranking and productization raw tabs
%LET dashboard_file = /tmp/branch-product-ranking.xlsx;
%EXPORT(
  format='xlsx',
  file='/tmp/branch-product-ranking.xlsx',
  sheet='Raw_Branches',
  query=(
    SELECT branch_id, branch, region, rank, credit_volume_pln, attainment_rate, ror_per_advisor, productization_rate
    FROM DB.SCHEMA.BRANCH_RANKING
    WHERE report_month = 202512
    ORDER BY rank
  ),
  update=true
);
%EXPORT(
  format='xlsx',
  file='/tmp/branch-product-ranking.xlsx',
  sheet='Raw_CrossSell',
  query=(SELECT branch_id, branch, customers, multiproduct_customers, productization_rate, products_per_customer, card_rate, insurance_rate FROM DB.SCHEMA.BRANCH_CROSS_SELL),
  update=true
);
