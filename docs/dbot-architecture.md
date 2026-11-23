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

Of the 57 example files, 22 are snippets (indicator helpers, fragments with no
`trade_definition`). Of the 35 that look like complete strategies:

| State | Count |
|---|---|
| Fully compatible | 1 |
| Partial | 5 |
| Unsupported | 26 |
| Invalid | 3 |

**1 of 35 (3%).** The dominant blockers are `market` (23 files, legacy),
`loader` (11, fetches remote blocks at run time — genuinely non-executable),
and `text_print` (10, trivially implementable).

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

The measured fixture baseline is unchanged at **1 of 35 fully compatible**: the
remaining blockers are candle/indicator data and legacy `market` generation, not
`timeout`. The `timeout` fixes are correctness fixes — a strategy that used to
trade immediately now waits, and one that used to stop now pauses.
