/** How far an engine runs on full stores, mm under power. Tunable, chosen so a lap or few of a play-table layout uses a good part of them. */
export const SUPPLIES = {
  waterMm: 15000,
  coalMm: 12000,
  /** A tender carries far more coal than the engine's own bunker. */
  tenderCoalMm: 40000,
  chargeMm: 40000,
  /** A water tank car tops the boiler up by this much a load, once it falls below `topUpBelow`. */
  tankTopUp: 0.3,
  topUpBelow: 0.7,
  /** Warn once a store falls below this. */
  low: 0.2,
  /** A job train run dry crawls on at this share of its speed, to a place to fill up. */
  limp: 0.3,
};

