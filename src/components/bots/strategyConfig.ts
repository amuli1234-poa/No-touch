import type { BotEditorPayload, BotTreeNode } from '../../lib/bots';

/**
 * Reads a strategy's trading configuration out of its parsed block tree.
 *
 * The tree is the server's own interpretation of the saved XML, so these values
 * are what the bot will actually trade — not a form the UI invented. Everything
 * is nullable because a valid DBot export may omit any of these blocks.
 */
export interface StrategyConfig {
  symbol: string | null;
  market: string | null;
  submarket: string | null;
  contractType: string | null;
  tradeType: string | null;
  stake: string | null;
  duration: string | null;
  currency: string | null;
  candleInterval: string | null;
  restartOnError: string | null;
  prediction: string | null;
}

function fieldOf(node: BotTreeNode | null | undefined, name: string): string | null {
  if (!node) return null;
  const hit = node.fields.find((f) => f.name === name);
  return hit && hit.value !== '' ? hit.value : null;
}

function findByType(blocks: BotTreeNode[], type: string): BotTreeNode | null {
  const stack = [...blocks];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === type) return node;
    if (node.next) stack.push(node.next);
    for (const input of node.inputs) if (input.block) stack.push(input.block);
  }
  return null;
}

/** Reads a numeric literal from a value input, following the shadow fallback. */
function valueOfInput(node: BotTreeNode | null, inputName: string): string | null {
  if (!node) return null;
  const input = node.inputs.find((i) => i.name === inputName);
  if (!input) return null;
  const literal = input.block?.fields.find((f) => f.name === 'NUM')?.value;
  if (literal) return literal;
  const shadow = input.shadow?.fields.find((f) => f.name === 'NUM')?.value;
  return shadow ?? null;
}

export function readStrategyConfig(tree: BotEditorPayload['tree']): StrategyConfig {
  const legacyTradeBlock = findByType(tree.blocks, 'trade');
  const marketBlock = findByType(tree.blocks, 'trade_definition_market') ?? legacyTradeBlock;
  const tradeTypeBlock =
    findByType(tree.blocks, 'trade_definition_tradetype') ?? legacyTradeBlock;
  const contractBlock =
    findByType(tree.blocks, 'trade_definition_contracttype') ?? legacyTradeBlock;
  const optionsBlock =
    findByType(tree.blocks, 'trade_definition_tradeoptions') ??
    findByType(tree.blocks, 'tradeOptions');
  const candleBlock =
    findByType(tree.blocks, 'trade_definition_candleinterval') ?? legacyTradeBlock;
  const restartBlock =
    findByType(tree.blocks, 'trade_definition_restartonerror') ?? legacyTradeBlock;

  const durationValue = valueOfInput(optionsBlock, 'DURATION');
  const durationUnit = fieldOf(optionsBlock, 'DURATIONTYPE_LIST');

  return {
    symbol: fieldOf(marketBlock, 'SYMBOL_LIST'),
    market: fieldOf(marketBlock, 'MARKET_LIST'),
    submarket: fieldOf(marketBlock, 'SUBMARKET_LIST'),
    contractType: fieldOf(contractBlock, 'TYPE_LIST'),
    tradeType: fieldOf(tradeTypeBlock, 'TRADETYPE_LIST'),
    stake: valueOfInput(optionsBlock, 'AMOUNT'),
    duration:
      durationValue && durationUnit
        ? `${durationValue}${durationUnit === 't' ? ' ticks' : durationUnit}`
        : durationValue,
    currency: fieldOf(optionsBlock, 'CURRENCY_LIST'),
    candleInterval: fieldOf(candleBlock, 'CANDLEINTERVAL_LIST'),
    restartOnError: fieldOf(restartBlock, 'RESTARTONERROR'),
    prediction: valueOfInput(optionsBlock, 'PREDICTION')
  };
}
