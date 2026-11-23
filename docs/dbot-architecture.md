# DBot import-and-execution: architecture assessment

Phase A of the DBot overhaul. Every number below was measured against the
official `deriv-com/deriv-app` `bot-skeleton` package (133 `Blockly.Blocks.*`
types) and its 57 shipped example strategies, not estimated.

## 1. What exists today

Three layers already exist and are worth keeping.

**XML layer** — `server/bots/xml.ts` (a dependency-free XML reader) and
`server/bots/tree.ts` (`xmlToTree` / `treeToXml`). The tree models fields,
value inputs, statement inputs, the `<next>` chain, shadows, mutations
(attributes *and* child elements), comments and every passthrough attribute.

**Semantic layer** — `server/bots/interpreter.ts` (~1,600 lines) with
`VALUE_BLOCKS` and `STATEMENT_BLOCKS` handler maps, procedure hoisting, loop
and flow control, variable scoping, and an `UnsupportedBlockError` that
propagates rather than silently skipping.

**Broker layer** — `server/execution/gateway.ts` with the mandatory
`createIntent → submit` path, plus `runService.ts` which drives the
tick → entry → settle → `after_purchase` loop.

**Capability reporting** — `server/bots/blocks.ts` derives `supported` from
`isInterpreted()` in the interpreter, so the server's verdict cannot drift from
what actually executes. This is the correct design and the rest of the system
should follow it.

## 2. Measured XML fidelity (Phase B evidence)

Round-trip over all 57 official example files:

| Check | Result |
|---|---|
| Parse + re-parse stable | 57 / 57 |
| Block types preserved | 57 / 57 |
| Field values preserved | 57 / 57 |
| Mutations preserved | 57 / 57 |
| Variable ids and names preserved | 57 / 57 |
| Shadow count preserved | 57 / 57 |
| `x` / `y` position attributes preserved | yes |

The XML layer is in good shape. It is not the bottleneck.

## 3. Measured block coverage

Classifying all 133 DBot block types through the real server API:

| Class | Count |
|---|---|
| Executed by the interpreter | 59 |
| Consumed structurally as containers (`before_purchase`, `trade_definition_*`, …) | 13 |
| Recognised, deliberately not executed (with a stated reason) | 10 |
| Recognised, no runtime implementation | 50 |
| Not in the catalogue at all | 1 (`text_statement`) |

72 / 133 block types are honoured end to end.

### The 50 recognised-but-unexecuted blocks, grouped

- **Candles / OHLC (13)**: `ohlc`, `ohlc_values`, `ohlc_values_in_list`,
  `get_ohlc`, `read_ohlc`, `read_ohlc_obj`, `is_candle_black`,
  `tick_delay`, `period`, `payout`, `ask_price`, `total_runs`, `epoch`.
  Root cause: `TickContext` carries ticks only. `MarketDataService` fetches
  `style: 'ticks'` and has no candle request, so there is no data source for
  any of these.
- **Indicators (8)**: `rsi_statement`, `rsia_statement`, `macda_statement`,
  `bba_statement`, `bb_statement`, `smaa_statement`, `emaa_statement`,
  `text_statement`. Only `sma_statement` and `ema_statement` execute.
- **Text / lists / math (18)**: `text_print`, `text_append`, `text_charAt`,
  `text_getSubstring`, `text_indexOf`, `text_trim`, `text_changeCase`,
  `lists_sort`, `lists_split`, `math_on_list`, `math_random_float`,
  `math_random_int`, `math_trig`, `math_number_property`, `todatetime`,
  `totimestamp`, … These are stock Blockly semantics and are cheap to add.
- **Legacy generation (11)**: `market`, `rsi`, `sma`, `ema`, `emaa`, `rsia`,
  `macda`, `trade`, `tradeOptions`, … Current DBot no longer defines `market`;
  those fixtures predate `trade_definition_market`. Correctly rejected, but
  they inflate any "unsupported" count computed over the example corpus.

## 4. Correctness defects found

These are not missing features. They are cases where the product currently
reports something that is not true.

### 4.1 `timeout` is reported supported but does nothing

`interpreter.ts` collects `sc.outcome.timeouts`, but `runService.ts` never
reads that field — the only `StackOutcome` field that is never consumed.
`isInterpreted('timeout')` returns true, so `blocks.ts` reports it executable
and the compatibility classifier clears it.

The real DBot semantics (`Binary/Tools/Time/timeout.js`) are
`sleep(seconds); <stack>`, i.e. **execution pauses for N seconds and then the
nested stack runs**. No-touch currently does neither. A strategy whose logic
depends on a delay therefore runs immediately and diverges.

This is the exact failure mode the brief forbids: a block counted as supported
because a handler exists, when the handler's effect is discarded.

### 4.2 Editor and server registries are separate copies

`src/components/bots/editor/definitions.ts` carries a hand-written
`DBOT_DECLS` array that its own comment describes as "mirroring `SUPPORTED` in
`server/bots/blocks.ts`". Nothing enforces the mirror. This is what produced
the original import crash: the server executed a block the editor had never
declared.

Measured drift today: 4 executable DBot blocks are declared by neither the
editor nor stock Blockly — `tick_string`, `ticks_string`,
`total_profit_string`, `trade_definition_tradeoptions_payout`. They survive
only because `blocks.ts` placeholders catch unknown types at load time. The
crash is prevented; the *cause* is not removed.

## 5. Measured strategy-level compatibility

Of the 57 example files, 25 are snippets (indicator helpers, fragments with no
`trade_definition`). Of the 32 that look like complete strategies:

| State | Count |
|---|---|
| Fully compatible | 10 |
| Partial | 15 |
| Unsupported | 7 |

**10 of 32 (31%).** Of the 22 runnable strategies that are not yet full, 6 are
blocked by candle blocks and nothing else (no data source exists — see §6 item
3), 8 by `loader` (fetches remote blocks at run time — genuinely
non-executable), and 4 by `text_print` (trivially implementable). The rest need
one of the unexecuted indicator or list/math blocks.

Before the legacy `market` work in §8 this was 1 fully compatible, 5 partial and
26 unsupported, so reading the oldest generation moved 9 strategies to fully
compatible and 10 more out of "unsupported".

## 6. What must change

Ordered by risk, not by size.

1. **Make `timeout` honest.** Either execute it faithfully (pause, then run the
   stack, cancellable) or stop reporting it as executable. Doing nothing is the
   one unacceptable option.
2. **Single capability source of truth.** One module that both the editor and
   the server import, so a block cannot be executable in one and undeclared in
   the other.
3. **Candle data path.** Without `ticks_history` at `style: 'candles'`, the 13
   candle blocks and most indicator blocks cannot be implemented at all.
4. **Cheap stock-block semantics** (`text_print`, `text_*`, `lists_*`,
   `math_*`) — high fixture coverage per unit of work.
5. **Fixture corpus in-repo.** Only one XML file is committed today; every
   other test builds XML inline.

## 7. What is deliberately out of scope

- `loader` — fetches block definitions from a URL at run time. Honouring it
  means executing remote code. It stays a blocking placeholder.
- Legacy `market` / `trade` / `rsi` generation — superseded upstream.
- Multipliers and Accumulators — gated off platform-wide; the compatibility
  classifier already reports them unsupported rather than pretending.

## 8. What changed in this pass

Three defects were fixed, each verified against DBot's own source and each
covered by a test that fails without the fix.

**`timeout` now pauses the strategy.** DBot compiles the block to
`sleep(n); <TIMEOUTSTACK>; <rest of the chain>`, so *everything* after it waits,
not just the nested stack. The interpreter now emits a `suspend` flow signal
that unwinds loops and procedure calls, and the run service persists the
deferred work (`stackToXml`/`xmlToStack` on the run record) and resumes it once
`dueAt` passes. A deferral is recorded per phase, because a delay in
`before_purchase` and one in `after_purchase` resume into different places.

**`after_purchase` timeouts no longer end the run.** `settleAfterPurchase` used
to read "no `trade_again` yet" as a refusal and stop the run. A strategy that
only asked to wait between contracts — DBot's own `wait 3 mins after 3
loss.xml` is exactly this — was silently terminated. It now returns `waiting`
and resumes into `trade_again`.

**`isDbProgram` searches nested statements.** It only walked the top-level
`<next>` chain, so a decision wrapped in `timeout` or a loop was not recognised
as a program and the strategy was refused at plan time as unexecutable — even
though the interpreter could run it.

**Editor declarations closed.** `tick_string`, `ticks_string`,
`total_profit_string`, `trade_definition_tradeoptions_payout` and
`lists_statement` are now declared, so they render properly instead of relying
on the unknown-block placeholder. `lists_statement` is DBot's own block and was
the one real gap the new drift test found. That test now compares the editor's
declarations against `supportedBlockTypes()` from the server, so this class of
divergence fails in CI rather than on a customer's import.

The measured fixture baseline is unchanged by the `timeout` work at **1 of 32
fully compatible**; the remaining blockers are candle/indicator data (no candle
source exists) and `loader`, not `timeout`. The `timeout` fixes are correctness
fixes — a strategy that used to trade immediately now waits, and one that used
to stop now pauses.

### The legacy `market` generation now parses and executes

The oldest exports carry no `trade_definition*` blocks at all: one `market`
block sits inside `trade`'s `SUBMARKET` statement and holds the market, contract,
candle interval, stake, currency and duration. Four separate bugs hid behind
that shape, and together they took the corpus from **1 to 10 fully compatible**
(partial 5→15, unsupported 26→7, of 57 files; the 25 snippet files stay
`invalid` throughout).

**The parser and planner never looked at the block.** Both read fields only off
`trade`/`trade_definition*`, so a legacy strategy reported no symbol, no
contract type and no stake — and the planner treated `market` as an unsupported
block, refusing the whole file. Both now read it, and `market` is a container in
`PLAN_EXECUTABLE` rather than a blocker.

**Legacy field values were being compared against modern ones.** DBot renamed
`volidx`→`synthetic_index`, `risefall`→`callput`, `callputequal`→`callput` and
`endsinout`/`staysinout`→`inout`. `LEGACY_FIELD_VALUES` in `blocks.ts` is now the
one table both parser and planner normalise through, so they cannot disagree.

**`TYPE_LIST: both` was stored as a contract type.** It is not one: it means
"either direction", and DBot expands it through `config.opposites[tradeType]`
while the author's `purchase` block picks one per entry. 33 of the 35 real
fixtures use `both`, so leaving it unresolved refused the ordinary legacy
configuration. Both parser and planner expand it to the pair, and the parser
warns when the trade type has no pair.

**Declarations in `SUBMARKET` were declared but never run.** DBot's
`naivelyFixLegacyStrategyAfterConversion` moves every non-trade-options block out
of `SUBMARKET` into `INITIALIZATION`, because `SUBMARKET` re-runs before each
trade — a martingale counter kept there would reset every time, turning the
strategy into a flat-stake one. `runInitialization` applies the same rule, gated
on a `market` block being present (only that generation put declarations there),
and copies the blocks instead of re-linking them so the strategy tree is not
rewritten on every tick.

## 9. Palette coverage and the payout block (this pass)

Two defects fixed and one capability gap closed. Numbers below are printed by
executing the real modules, not counted by hand.

| Measure | Before | After |
|---|---|---|
| Server catalogue (DBot types known) | 135 | 135 |
| Supported (`supportedBlockTypes()`) | 75 | **74** |
| Unsupported | 60 | **61** (11 deliberate + 50 no-runtime) |
| `EXECUTABLE` (runtime truth) | 74 | 74 |
| Editor `DBOT_DECLS` | 41 | 41 |
| Blocks the palette offers | 24 | **74** |

`supported` is now exactly `EXECUTABLE`. That equality is the property worth
protecting: before this pass `supported` claimed one block the runtime could not
run.

### 9.1 `trade_definition_tradeoptions_payout` was reported supported

`blocks.ts` listed it in `CONTAINER_BLOCKS`, so `supportedBlockTypes()` returned
it as runnable. Nothing read it — the parser's `switch` had no case for it and
neither engine referenced it — so a payout strategy parsed with `stake.amount`
left at `null`.

The consequence was not a cosmetic miscount. `runService.ts` builds every
execution intent with `basis: 'stake'`, and `stake = plan.stake ?? 1`, so a
payout-based strategy would have opened real contracts sized at the fallback
stake of 1 rather than at the size its author asked for.

DBot aliases the block to the ordinary trade-options definition, so the fields
look identical, but its generator emits `basis: 'payout'` and its `AMOUNT` is a
**payout target**, not a stake. Reading one as the other is a silent sizing
error.

The block is now in `DELIBERATELY_UNEXECUTED` with a reason and removed from
`CONTAINER_BLOCKS`, so the two tables cannot contradict each other. A payout
strategy still parses and is still recognised — it is reported non-runnable with
an explanation instead of being run at the wrong size. Four tests cover it: the
block is listed unsupported, the bot is not runnable, `stake.amount` stays
`null`, and it is no longer advertised as supported.

If payout sizing is wanted later, the gateway already accepts
`basis: 'stake' | 'payout'`; what is missing is carrying a basis through
`BotStakeConfig` and `plan.stake` into the intent, not transport support.

### 9.2 The palette offered 24 of the 74 runnable blocks

Fifty executable blocks were unreachable from the editor: 16 DBot blocks this
build already declares (`timeout`, `sell_at_market`, `sell_price`,
`total_profit`, `notify`, `ticks`, `lastDigitList`, `check_sell`,
`contract_check_result`, `read_details`, `trade_again`, …) and 34 stock Blockly
blocks — every loop, `controls_if`, procedures, and the text/list/math
families.

Stock blocks are registered by the `blockly/blocks` import, so this was purely
a palette omission: the runtime could already run them, and a strategy that
used a loop could be imported but never rebuilt. The palette now offers all 74,
grouped DBot-style: Trade, Market, Trade options, Contract, Entry conditions,
Exit conditions, Indicators, Logic, Loops, Mathematics, Text, Lists, Variables,
Functions, Utility. Five category styles and five icons were added so no
category renders unstyled.

`toolbox.test.ts` now asserts both directions: nothing offered that the runtime
refuses, and nothing runnable that the palette hides. The second test is the one
that would have caught this gap.

### 9.3 The client type under-declared the run payload

`server/bots/runTypes.ts` sends `variables`, `pendingDeferral`,
`afterPurchaseFor`, `sellRefusedFor`, `sellRefusedReason`, `lastTickKey` and
`lastTickAt` on every run view. `BotRun` in `src/lib/bots.ts` declared none of
them, so any panel showing interpreter state would have had to read undeclared
fields. They are now declared, including `BotPendingDeferral` for deferred
`timeout` work.

This is a type-level fix only. The Variables and Execution panels are not built
yet — see §10.

### 9.4 Still not done

Stated plainly, because the gap is the point:

- **50 blocks have no runtime.** Candle/OHLC blocks have no data source at all:
  `MarketDataService` requests `style: 'ticks'` and never `style: 'candles'`, so
  `ohlc`, `get_ohlc`, `is_candle_black` and the indicator statements built on
  them cannot be implemented without a new fetch path. This is the single
  largest blocker and it is a data problem, not a block problem.
- **`rsi_statement`, `bb_statement`, `macda_statement`, `smaa_statement`** and
  the rest of the indicator family still do not execute.
- **No Variables or Execution panel.** The server sends the state and the client
  type now describes it, but no UI renders it.
- **The `console` block has no runtime**, so there is no journal source for it.
- **Compatibility is unchanged**: the palette fix does not make a single new
  strategy runnable. It makes the 74 runnable blocks buildable.
