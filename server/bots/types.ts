/**
 * Normalized bot model.
 *
 * This is the internal representation that imported Deriv DBot strategies are
 * translated into. It is deliberately independent of both the DBot XML schema
 * and the execution layer: the parser produces it, the UI renders it, and any
 * future execution work would consume it through the existing gateway.
 *
 * Every field that cannot be established from the source document is left
 * empty rather than guessed. An empty array means "not present in the file",
 * never "none configured".
 */

/** How much of an imported bot No-touch can currently interpret. */
export type CompatibilityLevel = 'full' | 'partial' | 'unsupported' | 'invalid';

export interface BotIndicator {
  /** Normalized name, e.g. `sma`, `rsi`, `ema`, `bb`, `macd`. */
  kind: string;
  /** Parameters exactly as written in the source, when present. */
  params: Record<string, number | string>;
  /** Human-readable one-line summary for the preview. */
  summary: string;
}

export interface BotCondition {
  /** Short machine key, e.g. `check_direction`, `logic_compare`. */
  kind: string;
  /** Plain description assembled from the source fields. */
  description: string;
  /** True when No-touch understands and could honour this condition. */
  supported: boolean;
}

export interface BotMarketConfig {
  /** DBot market category, e.g. `synthetic_index`. */
  market: string | null;
  /** DBot submarket, e.g. `random_index`. */
  submarket: string | null;
  /** Deriv symbol, e.g. `R_100`. */
  symbol: string | null;
  /** Candle interval in seconds as written, e.g. `60`. */
  candleInterval: string | null;
}

export interface BotContractConfig {
  /** DBot trade type category, e.g. `callput`, `digits`. */
  tradeTypeCategory: string | null;
  /** DBot trade type, e.g. `callput`, `overunder`. */
  tradeType: string | null;
  /** Contract types as written, e.g. `CALL`, `PUT`, `DIGITOVER`. */
  contractTypes: string[];
}

export interface BotStakeConfig {
  /** Stake amount as a number when it parses cleanly, otherwise null. */
  amount: number | null;
  /** Currency code as written, e.g. `USD`. */
  currency: string | null;
  /** Duration value as a number when it parses cleanly. */
  duration: number | null;
  /** Duration unit as written: `t`, `s`, `m`, `h`, `d`. */
  durationUnit: string | null;
}

/** A block we could not interpret, reported verbatim rather than dropped. */
export interface UnsupportedBlock {
  /** Block type exactly as it appeared in the file. */
  type: string;
  /** How many times it appears. */
  count: number;
  /** Why it cannot be interpreted. */
  reason: string;
}

export interface BotWarning {
  code: string;
  message: string;
}

export interface NormalizedBot {
  /** Bot name derived from the source file or embedded name. */
  name: string;
  /** Always `deriv-dbot-xml` for this phase. */
  sourceFormat: 'deriv-dbot-xml';
  /** Contract/market/stake configuration extracted from trade_definition. */
  market: BotMarketConfig;
  contract: BotContractConfig;
  stake: BotStakeConfig;
  /** Indicators detected anywhere in the strategy. */
  indicators: BotIndicator[];
  /** Entry conditions (inside before_purchase / tick_analysis). */
  entryConditions: BotCondition[];
  /** Exit conditions (during_purchase sell rules, after_purchase). */
  exitConditions: BotCondition[];
  /** Block types present in the document, with counts. */
  blockInventory: { type: string; count: number }[];
  /** Blocks we recognised as DBot blocks but cannot interpret. */
  unsupportedBlocks: UnsupportedBlock[];
  /** Block types that are not DBot blocks at all. */
  unknownBlocks: { type: string; count: number }[];
  /** Non-fatal problems worth surfacing to the user. */
  warnings: BotWarning[];
  /** True when the document carried the DBot marker attribute. */
  isDbot: boolean;
}

export interface BotAnalysis {
  /** The normalized representation, present whenever parsing produced one. */
  bot: NormalizedBot | null;
  compatibility: CompatibilityLevel;
  /** One-line explanation of the compatibility verdict. */
  compatibilityReason: string;
  /** Structural problems that prevented a full parse. */
  errors: BotWarning[];
  /** Size of the original document in bytes. */
  sourceBytes: number;
  /** SHA-256 of the original document, used for duplicate detection. */
  sourceHash: string;
}

/** A persisted imported bot. Nothing here implies execution authority. */
export interface ImportedBotRecord {
  id: string;
  userId: string;
  name: string;
  sourceFormat: 'deriv-dbot-xml';
  /** Original filename as chosen by the user. */
  originalFilename: string;
  /** SHA-256 of the original file content. */
  sourceHash: string;
  /** The original XML, preserved verbatim so it can always be re-downloaded. */
  sourceXml: string;
  compatibility: CompatibilityLevel;
  compatibilityReason: string;
  status: 'imported' | 'paused' | 'archived';
  createdAt: number;
  updatedAt: number;
  /** Normalized representation produced at import time. */
  bot: NormalizedBot;
  warnings: BotWarning[];
  /** Provenance note; imported bots are never executed in this phase. */
  executionNote: string;
}
