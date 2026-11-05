-- Run once in Supabase > SQL Editor
create table if not exists api_budget (
  provider text primary key,
  day text,
  used integer default 0
);
