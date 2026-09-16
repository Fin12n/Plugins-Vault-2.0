/**
 * Telco and denomination matrix for card2k.
 *
 * Two vocabularies exist and must not be mixed: the charging API takes uppercase
 * names (VIETTEL, MOBIFONE), while card2k's public price API uses lowercase
 * abbreviations that differ (`mobi`, not `mobifone`; `vina`, not `vinaphone`).
 *
 * Source: card2k's own Minecraft plugin config, which ships the allow-list its
 * client validates against. That makes this a strong signal but not the authority
 * — the server decides. So this table is used to fail fast before spending a
 * network call and, more importantly, before consuming a card on a request that
 * was never going to be accepted.
 */

export const TELCOS = ['VIETTEL', 'VINAPHONE', 'MOBIFONE', 'GARENA', 'ZING', 'VCOIN'] as const;
export type Telco = (typeof TELCOS)[number];

/**
 * Accepted denominations per telco, in ĐỒNG.
 *
 * VIETNAMOBILE is deliberately absent: it appears nowhere in card2k's config,
 * docs, or price API. Only VIETTEL accepts 1.000.000, and 300.000 exists only for
 * the three phone carriers.
 */
export const TELCO_DENOMINATIONS: Record<Telco, readonly number[]> = {
  VIETTEL: [10_000, 20_000, 30_000, 50_000, 100_000, 200_000, 300_000, 500_000, 1_000_000],
  VINAPHONE: [10_000, 20_000, 30_000, 50_000, 100_000, 200_000, 300_000, 500_000],
  MOBIFONE: [10_000, 20_000, 30_000, 50_000, 100_000, 200_000, 300_000, 500_000],
  GARENA: [20_000, 50_000, 100_000, 200_000, 500_000],
  ZING: [10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000],
  VCOIN: [10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000],
};

/** Human labels, for menus. */
export const TELCO_LABELS: Record<Telco, string> = {
  VIETTEL: 'Viettel',
  VINAPHONE: 'VinaPhone',
  MOBIFONE: 'MobiFone',
  GARENA: 'Garena',
  ZING: 'Zing',
  VCOIN: 'VCoin',
};

export function isTelco(value: string): value is Telco {
  return (TELCOS as readonly string[]).includes(value);
}

/** True when card2k is expected to accept this pairing. */
export function isValidDenomination(telco: Telco, amount: number): boolean {
  return TELCO_DENOMINATIONS[telco].includes(amount);
}

export function denominationsFor(telco: Telco): readonly number[] {
  return TELCO_DENOMINATIONS[telco];
}
