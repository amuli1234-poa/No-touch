import { DBOT_DECLS } from './editor/definitions';
import type { BotTree, BotTreeNode } from '../../lib/bots';

export interface UnsupportedBlockDetail {
  category: string;
  name: string;
  type: string;
  count: number;
}

const DECLARATIONS = new Map(DBOT_DECLS.map((decl) => [decl.type, decl]));

const ROLE_CATEGORY: Record<string, string> = {
  'trade-definition': 'Trade',
  market: 'Market',
  stake: 'Trade options',
  contract: 'Contract',
  entry: 'Entry conditions',
  exit: 'Exit conditions',
  indicator: 'Indicators',
  logic: 'Logic',
  variable: 'Variables',
  purchase: 'Entry conditions',
  flow: 'Logic'
};

function categoryFor(type: string): string {
  const role = DECLARATIONS.get(type)?.role;
  if (role && ROLE_CATEGORY[role]) return ROLE_CATEGORY[role];
  if (type.startsWith('logic_') || type.startsWith('controls_')) return 'Logic';
  if (type.startsWith('math_')) return 'Mathematics';
  if (type.startsWith('variables_')) return 'Variables';
  if (type.startsWith('text_')) return 'Text';
  if (type.startsWith('lists_')) return 'Lists';
  if (type.startsWith('procedures_')) return 'Procedures';
  if (type === 'lastDigitList' || type === 'last_digit') return 'Entry conditions';
  if (type === 'text') return 'Text';
  if (type === 'read_details' || type === 'contract_check_result') return 'Contract';
  if (type === 'timeout') return 'Timing';
  if (type === 'notify') return 'Notifications';
  if (type === 'tradeOptions') return 'Trade options';
  if (type === 'trade') return 'Trade';
  return 'Other';
}

function nameFor(type: string): string {
  return DECLARATIONS.get(type)?.label ?? type.replace(/_/g, ' ');
}

export function unsupportedBlockDetails(
  tree: BotTree,
  unsupportedTypes: readonly string[]
): UnsupportedBlockDetail[] {
  const types = new Set(unsupportedTypes);
  const counts = new Map<string, number>();
  const visit = (node: BotTreeNode | null) => {
    if (!node) return;
    if (types.has(node.type)) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    if (node.next) visit(node.next);
    for (const input of node.inputs) {
      if (input.block) {
        visit(input.block);
      } else if (input.shadow && types.has(input.shadow.type)) {
        counts.set(input.shadow.type, (counts.get(input.shadow.type) ?? 0) + 1);
      }
    }
  };
  for (const block of tree.blocks) visit(block);

  return [...types]
    .map((type) => ({
      category: categoryFor(type),
      name: nameFor(type),
      type,
      count: counts.get(type) ?? 0
    }))
    .sort((a, b) => a.category.localeCompare(b.category) || a.type.localeCompare(b.type));
}
