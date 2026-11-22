/**
 * Deriv DBot XML -> normalized bot translation.
 *
 * The parser walks the element tree produced by `xml.ts`. It never evaluates
 * anything and never fetches a remote resource; it only reads attributes,
 * field text and value blocks that DBot itself writes.
 *
 * Translation rules:
 *   - Block types and field names come from `blocks.ts`, which mirrors the
 *     DBot source. Nothing is guessed.
 *   - A block we recognise but cannot interpret is recorded in
 *     `unsupportedBlocks` with a reason. It is never silently dropped.
 *   - A block type we have never seen is recorded in `unknownBlocks`.
 *   - Missing or non-numeric parameters become `null` plus a warning; they are
 *     never replaced with an invented default.
 */

import { parseXml, childElements, textContent, XmlError } from './xml.js';
import type { XmlElement } from './xml.js';
import { blockSpec, isKnownBlock, DBOT_MAIN_BLOCKS } from './blocks.js';
import type {
  BotAnalysis,
  BotCondition,
  BotIndicator,
  BotMarketConfig,
  BotContractConfig,
  BotStakeConfig,
  BotWarning,
  CompatibilityLevel,
  NormalizedBot,
  UnsupportedBlock
} from './types.js';
import { createHash } from 'node:crypto';

/** Hard ceiling on the raw file size, enforced before any parsing happens. */
export const MAX_BOT_FILE_BYTES = 2 * 1024 * 1024;

/** A DBot field value, trimmed; null when the field is absent or empty. */
function fieldValue(block: XmlElement, name: string): string | null {
  const target = childElements(block, 'field').find((f) => f.attrs.name === name);
  if (!target) return null;
  const text = textContent(target).trim();
  return text.length > 0 ? text : null;
}

/**
 * Reads a nested value input, e.g. `<value name="AMOUNT"><shadow .../></value>`.
 * DBot wraps literal numbers in a `math_number_positive` shadow, so the number
 * lives in that block's NUM field.
 */
function valueNumber(block: XmlElement, name: string): number | null {
  const value = childElements(block, 'value').find((v) => v.attrs.name === name);
  if (!value) return null;
  const inner =
    childElements(value, 'block')[0] ?? childElements(value, 'shadow')[0] ?? null;
  if (!inner) return null;
  const num = fieldValue(inner, 'NUM');
  if (num === null) return null;
  const parsed = Number(num);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Every block element in the document, in document order. */
function allBlocks(root: XmlElement): XmlElement[] {
  const out: XmlElement[] = [];
  const stack: XmlElement[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node !== root && node.name === 'block') out.push(node);
    // `shadow` elements also carry a `type`; they are literal values, not
    // strategy blocks, so they are traversed but not reported as blocks.
    for (let k = node.children.length - 1; k >= 0; k -= 1) {
      const child = node.children[k];
      if (child.type === 'element') stack.push(child);
    }
  }
  return out;
}

function countByType(blocks: XmlElement[]): { type: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const b of blocks) {
    const type = b.attrs.type ?? '(missing type)';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** Reads a `variables` declaration block if present. */
function readVariables(root: XmlElement): string[] {
  const vars = childElements(root, 'variables')[0];
  if (!vars) return [];
  return childElements(vars, 'variable')
    .map((v) => textContent(v).trim())
    .filter((v) => v.length > 0);
}

/* ------------------------------- indicators ------------------------------- */

const INDICATOR_BLOCKS: Record<string, { kind: string; label: string }> = {
  sma_statement: { kind: 'sma', label: 'Simple moving average' },
  ema_statement: { kind: 'ema', label: 'Exponential moving average' },
  rsi_statement: { kind: 'rsi', label: 'Relative strength index' },
  bb_statement: { kind: 'bb', label: 'Bollinger bands' },
  macda_statement: { kind: 'macd', label: 'MACD' }
};

function readIndicators(blocks: XmlElement[], warnings: BotWarning[]): BotIndicator[] {
  const out: BotIndicator[] = [];
  for (const block of blocks) {
    const type = block.attrs.type ?? '';
    const meta = INDICATOR_BLOCKS[type];
    if (!meta) continue;

    const params: Record<string, number | string> = {};
    const variable = fieldValue(block, 'VARIABLE');
    if (variable) params.variable = variable;
    const bbResult = fieldValue(block, 'BBRESULT_LIST');
    if (bbResult) params.band = bbResult;
    const macdField = fieldValue(block, 'MACDFIELDS_LIST');
    if (macdField) params.field = macdField;

    // Indicator parameters live in the nested STATEMENT input (period, etc.).
    const statement = childElements(block, 'statement').find((s) => s.attrs.name === 'STATEMENT');
    const inner = statement ? childElements(statement, 'block')[0] : null;
    if (inner) {
      for (const field of childElements(inner, 'field')) {
        const name = field.attrs.name;
        if (!name) continue;
        const text = textContent(field).trim();
        if (text.length === 0) continue;
        const num = Number(text);
        params[name] = Number.isFinite(num) ? num : text;
      }
    } else {
      warnings.push({
        code: 'indicator_without_params',
        message: `${meta.label} appears without a parameter block; its period is unknown.`
      });
    }

    const paramText = Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    out.push({
      kind: meta.kind,
      params,
      summary: paramText.length > 0 ? `${meta.label} (${paramText})` : meta.label
    });
  }
  return out;
}

/* ------------------------------- conditions ------------------------------- */

const DIRECTION_LABEL: Record<string, string> = {
  rise: 'Rise',
  fall: 'Fall',
  '': 'No change'
};

function readConditions(blocks: XmlElement[]): { entry: BotCondition[]; exit: BotCondition[] } {
  const entry: BotCondition[] = [];
  const exit: BotCondition[] = [];

  for (const block of blocks) {
    const type = block.attrs.type ?? '';
    if (type === 'check_direction') {
      const raw = fieldValue(block, 'CHECK_DIRECTION') ?? '';
      const label = DIRECTION_LABEL[raw] ?? raw;
      entry.push({
        kind: 'check_direction',
        description: `Market direction is ${label}`,
        supported: true
      });
    }
    if (type === 'logic_compare') {
      const op = fieldValue(block, 'OP') ?? '?';
      entry.push({
        kind: 'logic_compare',
        description: `Comparison (${op})`,
        supported: true
      });
    }
    if (type === 'check_sell') {
      exit.push({
        kind: 'check_sell',
        description: 'Sell when the configured sell condition is met',
        supported: true
      });
    }
    if (type === 'trade_again') {
      exit.push({
        kind: 'trade_again',
        description: 'Start a new trade after this one settles',
        supported: true
      });
    }
  }
  return { entry, exit };
}

/* -------------------------- trade definition read -------------------------- */

interface TradeRead {
  market: BotMarketConfig;
  contract: BotContractConfig;
  stake: BotStakeConfig;
}

function readTradeDefinition(blocks: XmlElement[], warnings: BotWarning[]): TradeRead {
  const market: BotMarketConfig = { market: null, submarket: null, symbol: null, candleInterval: null };
  const contract: BotContractConfig = { tradeTypeCategory: null, tradeType: null, contractTypes: [] };
  const stake: BotStakeConfig = { amount: null, currency: null, duration: null, durationUnit: null };

  for (const block of blocks) {
    const type = block.attrs.type ?? '';
    switch (type) {
      case 'trade_definition_market': {
        market.market = fieldValue(block, 'MARKET_LIST');
        market.submarket = fieldValue(block, 'SUBMARKET_LIST');
        market.symbol = fieldValue(block, 'SYMBOL_LIST');
        break;
      }
      case 'trade_definition_candleinterval': {
        market.candleInterval = fieldValue(block, 'CANDLEINTERVAL_LIST');
        break;
      }
      case 'trade_definition_tradetype': {
        contract.tradeTypeCategory = fieldValue(block, 'TRADETYPECAT_LIST');
        contract.tradeType = fieldValue(block, 'TRADETYPE_LIST');
        break;
      }
      case 'trade_definition_contracttype': {
        const value = fieldValue(block, 'TYPE_LIST');
        if (value) contract.contractTypes.push(value);
        break;
      }
      case 'trade_definition_tradeoptions': {
        stake.currency = fieldValue(block, 'CURRENCY_LIST');
        stake.durationUnit = fieldValue(block, 'DURATIONTYPE_LIST');
        stake.amount = valueNumber(block, 'AMOUNT');
        stake.duration = valueNumber(block, 'DURATION');
        if (stake.amount === null) {
          warnings.push({
            code: 'stake_unreadable',
            message: 'The stake amount could not be read from the trade options block.'
          });
        }
        if (stake.duration === null) {
          warnings.push({
            code: 'duration_unreadable',
            message: 'The contract duration could not be read from the trade options block.'
          });
        }
        break;
      }
      default:
        break;
    }
  }

  // The trade definition block itself can carry the market triple directly.
  const definition = blocks.find((b) => b.attrs.type === 'trade_definition');
  if (definition) {
    market.market = market.market ?? fieldValue(definition, 'MARKET_LIST');
    market.submarket = market.submarket ?? fieldValue(definition, 'SUBMARKET_LIST');
    market.symbol = market.symbol ?? fieldValue(definition, 'SYMBOL_LIST');
  }

  if (market.symbol === null) {
    warnings.push({
      code: 'symbol_missing',
      message: 'No trading symbol was found; the market cannot be identified.'
    });
  }
  if (contract.contractTypes.length === 0) {
    warnings.push({
      code: 'contract_type_missing',
      message: 'No contract type was found; the payout direction is unknown.'
    });
  }

  return { market, contract, stake };
}

/* ------------------------------ compatibility ------------------------------ */

/**
 * Classifies how much of an imported bot No-touch can honour.
 *
 *   invalid      the document is not a usable DBot strategy
 *   unsupported  understood, but nothing in it can run here
 *   partial      understood, but at least one part cannot be interpreted
 *   full         every block is understood and the contract type is placeable
 *
 * "Full" still does not mean "executable": nothing in this phase executes an
 * imported bot. The level describes interpretation completeness only.
 */
function classify(
  bot: NormalizedBot,
  missingMandatory: string[]
): { level: CompatibilityLevel; reason: string } {
  if (missingMandatory.length > 0) {
    return {
      level: 'invalid',
      reason: `Not a runnable DBot strategy: missing ${missingMandatory.join(', ')}.`
    };
  }

  const unknownCount = bot.unknownBlocks.reduce((n, b) => n + b.count, 0);
  if (unknownCount > 0) {
    return {
      level: 'unsupported',
      reason: `${unknownCount} block(s) in this file are not DBot blocks No-touch recognises.`
    };
  }

  const unsupportedCount = bot.unsupportedBlocks.reduce((n, b) => n + b.count, 0);
  const contractPlaceable = bot.contract.contractTypes.every((t) =>
    ['CALL', 'PUT', 'MULTUP', 'MULTDOWN'].includes(t)
  );

  if (unsupportedCount > 0) {
    return {
      level: 'partial',
      reason: `${unsupportedCount} block(s) could not be interpreted, so this bot cannot be run as-is.`
    };
  }
  if (!contractPlaceable) {
    return {
      level: 'partial',
      reason: `Contract type ${bot.contract.contractTypes.join(', ') || '(none)'} is not one No-touch can place.`
    };
  }
  if (bot.contract.contractTypes.length === 0) {
    return { level: 'partial', reason: 'The contract type is missing, so the bot cannot be run as-is.' };
  }
  return {
    level: 'full',
    reason: 'Every block in this file is interpreted by No-touch. Importing does not authorise execution.'
  };
}

/* --------------------------------- entry ---------------------------------- */

export interface AnalyzeOptions {
  /** Original filename, used for the default bot name. */
  filename?: string;
}

function deriveName(root: XmlElement, blocks: XmlElement[], filename?: string): string {
  const named = root.attrs.name ?? fieldValue(root, 'NAME');
  if (named && named.trim().length > 0) return named.trim();
  for (const block of blocks) {
    const botName = fieldValue(block, 'BOT_NAME');
    if (botName && botName.trim().length > 0) return botName.trim();
  }
  if (filename) {
    const base = filename.replace(/\.[^./\\]+$/, '').trim();
    if (base.length > 0) return base;
  }
  return 'Imported bot';
}

/**
 * Parses and classifies a DBot XML document.
 *
 * Never throws for bad input: structural failures are returned as `invalid`
 * with an error list, so the caller can show the user exactly what was wrong
 * while still keeping the original file.
 */
export function analyzeDbotXml(source: string, opts: AnalyzeOptions = {}): BotAnalysis {
  const sourceBytes = Buffer.byteLength(source, 'utf8');
  const sourceHash = createHash('sha256').update(source, 'utf8').digest('hex');
  const errors: BotWarning[] = [];

  const invalid = (code: string, message: string): BotAnalysis => ({
    bot: null,
    compatibility: 'invalid',
    compatibilityReason: message,
    errors: [{ code, message }],
    sourceBytes,
    sourceHash
  });

  if (sourceBytes === 0) return invalid('empty_file', 'The selected file is empty.');
  if (sourceBytes > MAX_BOT_FILE_BYTES) {
    return invalid(
      'file_too_large',
      `The file is ${Math.round(sourceBytes / 1024)} KB; the limit is ${MAX_BOT_FILE_BYTES / 1024} KB.`
    );
  }

  let root: XmlElement;
  try {
    root = parseXml(source);
  } catch (e) {
    if (e instanceof XmlError) {
      return invalid(`xml_${e.code}`, `The file is not valid XML: ${e.message}.`);
    }
    return invalid('xml_unreadable', 'The file could not be read as XML.');
  }

  if (root.name !== 'xml') {
    return invalid(
      'not_dbot_document',
      `Expected a DBot export with an <xml> root element, found <${root.name}>.`
    );
  }

  const blocks = allBlocks(root);
  if (blocks.length === 0) {
    return invalid('no_blocks', 'The document contains no strategy blocks.');
  }

  const warnings: BotWarning[] = [];
  const isDbot = root.attrs.is_dbot === 'true';

  if (!isDbot) {
    warnings.push({
      code: 'no_dbot_marker',
      message: 'The file does not carry the DBot marker (is_dbot="true"); it may be a generic Blockly export.'
    });
  }

  const inventory = countByType(blocks);
  const unsupportedBlocks: UnsupportedBlock[] = [];
  const unknownBlocks: { type: string; count: number }[] = [];

  for (const entry of inventory) {
    if (!isKnownBlock(entry.type)) {
      unknownBlocks.push(entry);
      continue;
    }
    const spec = blockSpec(entry.type);
    if (spec && !spec.supported) {
      unsupportedBlocks.push({
        type: entry.type,
        count: entry.count,
        reason: spec.reason ?? 'This block is not interpreted by No-touch.'
      });
    }
  }

  const present = new Set(inventory.map((i) => i.type));
  const missingMandatory = ['trade_definition', 'purchase', 'before_purchase'].filter(
    (t) => !present.has(t)
  );

  const { market, contract, stake } = readTradeDefinition(blocks, warnings);
  const indicators = readIndicators(blocks, warnings);
  const { entry: entryConditions, exit: exitConditions } = readConditions(blocks);

  if (!present.has('trade_definition')) {
    errors.push({
      code: 'missing_trade_definition',
      message: 'No trade_definition block: the market, contract type and stake are undefined.'
    });
  }

  const bot: NormalizedBot = {
    name: deriveName(root, blocks, opts.filename),
    sourceFormat: 'deriv-dbot-xml',
    market,
    contract,
    stake,
    indicators,
    entryConditions,
    exitConditions,
    blockInventory: inventory,
    unsupportedBlocks,
    unknownBlocks,
    warnings,
    isDbot
  };

  const { level, reason } = classify(bot, missingMandatory);

  return {
    bot,
    compatibility: level,
    compatibilityReason: reason,
    errors,
    sourceBytes,
    sourceHash
  };
}

/** Exposed for tests and documentation. */
export const PARSER_MAIN_BLOCKS = DBOT_MAIN_BLOCKS;
