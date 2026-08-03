-- 0008 — alert kind for MDP SYSTEM_MESSAGES (staff-only P1: the only warning
-- MDP gives that webhook data is being dropped). Required by mdp-webhook.

alter type alert_kind_t add value if not exists 'mdp_system_messages';
