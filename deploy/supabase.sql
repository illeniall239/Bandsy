-- Bandsy on Supabase: paste into the SQL Editor once and run.
-- Each person sees only their own attempts, words and settings (Row Level Security); explanations are a shared cache.

create table if not exists attempts (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  test text not null, module text not null, mode text not null,
  started_at text not null, finished_at text not null,
  answers jsonb not null, marks jsonb not null, score int not null, band real);

create table if not exists vocab (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  word text not null, sentence text, definition text, source text, created_at text,
  interval int default 0, due text, reviews int default 0,
  unique (user_id, word));

create table if not exists settings (
  user_id uuid primary key default auth.uid() references auth.users on delete cascade,
  value jsonb not null);

create table if not exists explanations (
  test text, module text, n int, answer text, body jsonb, created_at timestamptz default now(),
  primary key (test, module, n, answer));

alter table attempts enable row level security;
alter table vocab enable row level security;
alter table settings enable row level security;
alter table explanations enable row level security;

create policy "own attempts" on attempts for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own vocab" on vocab for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own settings" on settings for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "shared explanations" on explanations for all to authenticated using (true) with check (true);

-- Listening audio: a public bucket, filled by deploy/upload-audio.mjs
insert into storage.buckets (id, name, public) values ('audio', 'audio', true) on conflict (id) do nothing;
