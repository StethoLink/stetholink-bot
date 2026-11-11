# Persistence

The Core consumes the consultation repository interface. The PostgreSQL adapter uses a restricted backend role with transaction-local verified chart context. Draft RLS and the approval function enforce scope independently of the HTTP layer.

The migrations and SQL authorization tests are under `supabase/`. See the [connection decision](../../docs/decisions/supabase-connection.md) for provisioning and the [staging checks](../../tests/e2e/README.md) for verification.
