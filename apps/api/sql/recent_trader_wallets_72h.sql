-- Wallet addresses with at least one recorded swap in the last 72 hours.
-- Run this in the Supabase SQL editor.

SELECT DISTINCT swap_transactions.address
FROM swap_transactions
WHERE swap_transactions.occurred_at >= timezone('utc', now()) - INTERVAL '72 hours'
ORDER BY swap_transactions.address;
