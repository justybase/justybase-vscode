-- Macro Bank Campaign Dashboard Update: Refresh campaign and funnel raw tabs while preserving the dashboard
%LET dashboard_file = /tmp/campaign-performance.xlsx;
%EXPORT(
  format='xlsx',
  file='/tmp/campaign-performance.xlsx',
  sheet='Raw_Campaigns',
  query=(
    SELECT campaign_id, campaign, channel, product, leads, applications, approved, sold, volume_pln, spend_pln, conversion_rate, roi
    FROM DB.SCHEMA.CAMPAIGN_PERFORMANCE
    WHERE report_year = 2025
    ORDER BY roi DESC
  ),
  update=true
);
%EXPORT(
  format='xlsx',
  file='/tmp/campaign-performance.xlsx',
  sheet='Raw_Funnel',
  query=(SELECT stage, count, conversion_from_previous FROM DB.SCHEMA.CAMPAIGN_FUNNEL ORDER BY stage_order),
  update=true
);
