create or replace view public.owner_daily_app_opens as
select
  date_trunc('day', occurred_at)::date as day,
  count(*)::int as app_opens
from public.owner_app_events
where event_name = 'app_open'
group by 1
order by 1 desc;

create or replace view public.owner_monthly_active_installs as
select
  date_trunc('month', occurred_at)::date as month,
  count(distinct install_id)::int as active_installs
from public.owner_app_events
where event_name = 'app_open'
group by 1
order by 1 desc;

create or replace view public.owner_matches_per_day as
select
  date_trunc('day', finished_at)::date as day,
  count(*)::int as matches_played
from public.owner_match_summaries
where mode = 'x01'
group by 1
order by 1 desc;

create or replace view public.owner_darts_per_month as
select
  date_trunc('month', finished_at)::date as month,
  coalesce(sum((player_stat->>'dartsThrown')::int), 0)::int as total_darts
from public.owner_match_summaries
cross join lateral jsonb_array_elements(match_stats) as player_stat
where mode = 'x01'
group by 1
order by 1 desc;

create or replace view public.owner_x01_quality_per_month as
select
  date_trunc('month', finished_at)::date as month,
  round(avg(estimated_accuracy)::numeric, 4)::float8 as avg_estimated_accuracy,
  round(avg(corrections_count)::numeric, 2)::float8 as avg_corrections_per_match,
  count(*)::int as matches_played
from public.owner_match_summaries
where mode = 'x01'
group by 1
order by 1 desc;
