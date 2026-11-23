import test from 'node:test';
import assert from 'node:assert/strict';

import { unsupportedBlockDetails } from './unsupportedBlocks';
import type { BotTreeNode } from '../../lib/bots';

function node(type: string, next: BotTreeNode | null = null): BotTreeNode {
  return {
    type,
    fields: [],
    inputs: [],
    shadows: [],
    next
  };
}

test('unsupported blocks show their category, readable name, and tree count', () => {
  const tree = {
    attrs: {},
    variables: [],
    blocks: [node('variables_set', node('logic_boolean', node('logic_boolean')))]
  };

  assert.deepEqual(
    unsupportedBlockDetails(tree, ['variables_set', 'logic_boolean']).map((block) => ({
      category: block.category,
      name: block.name,
      type: block.type,
      count: block.count
    })),
    [
      { category: 'Logic', name: 'logic boolean', type: 'logic_boolean', count: 2 },
      { category: 'Variables', name: 'variables set', type: 'variables_set', count: 1 }
    ]
  );
});
