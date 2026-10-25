-- Verea: field_tests keeps only what the app uses. Supabase's default privileges also grant
-- truncate / references / trigger on new tables; truncate would skip row level security.
revoke truncate, references, trigger on public.field_tests from authenticated;
