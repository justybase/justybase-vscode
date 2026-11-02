-- Macro External Finance Dashboard Update: Refresh the Dataset source of an MIT-licensed finance dashboard
%LET dashboard_file = /tmp/personal-finance-dashboard-2026.xlsx;
%EXPORT(
  format='xlsx',
  file='/tmp/personal-finance-dashboard-2026.xlsx',
  sheet='Dataset',
  query=(
    SELECT transaction_id AS "Transaction ID", transaction_date AS "Date", report_year AS "Year", account AS "Account", bank AS "Bank", transaction_type AS "Transaction Type", category AS "Category", sub_category AS "Sub Category", payment_method AS "Payment Method", merchant AS "Merchant", description AS "Description", amount AS "Amount (₹)", budget AS "Budget (₹)", savings_goal AS "Savings Goal", location AS "Location", status AS "Status", recurring AS "Recurring", tax_deductible AS "Tax Deductible", balance_after_transaction AS "Balance After Transaction (₹)", month AS "Month", quarter AS "Quarter", month_no AS "Month No"
    FROM DB.SCHEMA.ACCOUNT_TRANSACTIONS
    WHERE report_year = 2026
    ORDER BY transaction_date
  ),
  update=true
);
