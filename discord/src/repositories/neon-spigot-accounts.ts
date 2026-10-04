/**
 * Compatibility layer: Neon Spigot Account References
 * Note: Under the Dual-Vault Architecture, Neon stores ONLY non-sensitive Spigot account
 * references (spigot_account_refs). Sensitive credentials (passwords, cookies, sessions)
 * are stored EXCLUSIVELY in local SQLite (vault_secrets.db).
 */
export * from "./neon-spigot-refs.js";
