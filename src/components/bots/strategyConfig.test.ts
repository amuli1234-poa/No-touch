import test from 'node:test';
import assert from 'node:assert/strict';

import type { BotTree, BotTreeNode } from '../../lib/bots';
import { readStrategyConfig } from './strategyConfig';

function block(
  type: string,
  fields: Record<string, string> = {},
  inputs: BotTreeNode['inputs'] = []
): BotTreeNode {
  return {
    type,
    fields: Object.entries(fields).map(([name, value]) => ({ name, value })),
    inputs,
    shadows: [],
    next: null
  };
}

function tree(blocks: BotTreeNode[]): BotTree {
  return { attrs: {}, variables: [], blocks };
}

function valueInput(name: string, value: string): BotTreeNode['inputs'][number] {
  return {
    name,
    kind: 'value',
    block: block('math_number', { NUM: value })
  };
}

test('reads market and contract settings from a legacy trade block', () => {
  const legacyTrade = block(
    'trade',
    {
      MARKET_LIST: 'synthetic_index',
      SUBMARKET_LIST: 'continuous_indices',
      SYMBOL_LIST: 'R_100',
      TRADETYPE_LIST: 'digits',
      TYPE_LIST: 'DIGITDIFF',
      CANDLEINTERVAL_LIST: '300',
      RESTARTONERROR: 'TRUE'
    },
    [
      {
        name: 'INITIALIZATION',
        kind: 'statement',
        block: block(
          'tradeOptions',
          { DURATIONTYPE_LIST: 't', CURRENCY_LIST: 'USD' },
          [
            valueInput('DURATION', '1'),
            valueInput('AMOUNT', '2'),
            valueInput('PREDICTION', '5')
          ]
        )
      }
    ]
  );

  assert.deepEqual(readStrategyConfig(tree([legacyTrade])), {
    symbol: 'R_100',
    market: 'synthetic_index',
    submarket: 'continuous_indices',
    contractType: 'DIGITDIFF',
    tradeType: 'digits',
    stake: '2',
    duration: '1 ticks',
    currency: 'USD',
    candleInterval: '300',
    restartOnError: 'TRUE',
    prediction: '5'
  });
});

test('continues reading modern trade-definition blocks', () => {
  const modernTree = tree([
    block('trade_definition_market', {
      MARKET_LIST: 'synthetic_index',
      SUBMARKET_LIST: 'random_index',
      SYMBOL_LIST: 'R_75'
    }),
    block('trade_definition_tradetype', { TRADETYPE_LIST: 'callput' }),
    block('trade_definition_contracttype', { TYPE_LIST: 'CALL' }),
    block(
      'trade_definition_tradeoptions',
      { DURATIONTYPE_LIST: 'm', CURRENCY_LIST: 'USD' },
      [valueInput('DURATION', '5'), valueInput('AMOUNT', '1')]
    ),
    block('trade_definition_candleinterval', { CANDLEINTERVAL_LIST: '60' }),
    block('trade_definition_restartonerror', { RESTARTONERROR: 'FALSE' })
  ]);

  assert.deepEqual(readStrategyConfig(modernTree), {
    symbol: 'R_75',
    market: 'synthetic_index',
    submarket: 'random_index',
    contractType: 'CALL',
    tradeType: 'callput',
    stake: '1',
    duration: '5m',
    currency: 'USD',
    candleInterval: '60',
    restartOnError: 'FALSE',
    prediction: null
  });
});
