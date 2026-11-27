import { LogTypes } from '../../../constants/messages';
import { api_base } from '../../api/api-base';
import { contractStatus, info, log } from '../utils/broadcast';
import { doUntilDone, getUUID, recoverFromError, tradeOptionToBuy } from '../utils/helpers';
import { purchaseSuccessful } from './state/actions';
import { BEFORE_PURCHASE } from './state/constants';

let delayIndex = 0;
let purchase_reference;

const PREDICTION_DIRECTIONS = {
    MULTUP: 'RISE',
    MULTDOWN: 'FALL',
    CALL: 'RISE',
    PUT: 'FALL',
};

const contractFamilyFor = type => {
    if (['MULTUP', 'MULTDOWN'].includes(type)) return 'multipliers';
    if (type.startsWith('DIGIT')) return 'digits';
    if (['ONETOUCH', 'NOTOUCH'].includes(type)) return 'touch_no_touch';
    if (type === 'ACCU') return 'accumulators';
    return 'rise_fall';
};

// Best-effort: tell WickSentinel about a buy it did not open so it can mirror the
// trade to connected copy-trading followers. The bot's own trade is unaffected;
// any failure is swallowed so a copy problem can never interrupt the bot.
const reportCopyOnBuy = (contract_type, trade_option, buy, accountId) => {
    try {
        const prediction = trade_option.prediction;
        const payload = {
            accountId,
            symbol: trade_option.symbol,
            contractType: contract_type,
            contractFamily: contractFamilyFor(contract_type),
            direction: PREDICTION_DIRECTIONS[contract_type] || 'NONE',
            duration: trade_option.duration,
            durationUnit: trade_option.duration_unit,
            stake: trade_option.amount,
            basis: trade_option.basis,
            currency: trade_option.currency,
            masterContractId: buy.contract_id,
            ...(trade_option.multiplier !== undefined ? { multiplier: trade_option.multiplier } : {}),
            ...(prediction !== undefined ? { digit: prediction, barrier: String(prediction) } : {}),
        };
        const send = () =>
            fetch('/api/copy-trading/mirror-on-buy', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        send()
            .then(response => {
                // Deriv's portfolio can lag a beat after a buy; retry once.
                if (response.status === 409) {
                    setTimeout(() => {
                        send().catch(() => {});
                    }, 1500);
                }
            })
            .catch(() => {});
    } catch (e) {
        // never let copy reporting break the bot
    }
};

export default Engine =>
    class Purchase extends Engine {
        purchase(contract_type) {
            // Prevent calling purchase twice
            if (this.store.getState().scope !== BEFORE_PURCHASE) {
                return Promise.resolve();
            }

            const onSuccess = response => {
                // Don't unnecessarily send a forget request for a purchased contract.
                const { buy } = response;

                contractStatus({
                    id: 'contract.purchase_received',
                    data: buy.transaction_id,
                    buy,
                });

                this.contractId = buy.contract_id;
                this.store.dispatch(purchaseSuccessful());

                reportCopyOnBuy(contract_type, this.tradeOptions, buy, this.accountInfo.loginid);

                if (this.is_proposal_subscription_required) {
                    this.renewProposalsOnPurchase();
                }

                delayIndex = 0;
                log(LogTypes.PURCHASE, { transaction_id: buy.transaction_id });
                info({
                    accountID: this.accountInfo.loginid,
                    totalRuns: this.updateAndReturnTotalRuns(),
                    transaction_ids: { buy: buy.transaction_id },
                    contract_type,
                    buy_price: buy.buy_price,
                });
            };

            if (this.is_proposal_subscription_required) {
                const { id, askPrice } = this.selectProposal(contract_type);

                const action = () => api_base.api.send({ buy: id, price: askPrice });

                this.isSold = false;

                contractStatus({
                    id: 'contract.purchase_sent',
                    data: askPrice,
                });

                if (!this.options.timeMachineEnabled) {
                    return doUntilDone(action).then(onSuccess);
                }

                return recoverFromError(
                    action,
                    (errorCode, makeDelay) => {
                        // if disconnected no need to resubscription (handled by live-api)
                        if (errorCode !== 'DisconnectError') {
                            this.renewProposalsOnPurchase();
                        } else {
                            this.clearProposals();
                        }

                        const unsubscribe = this.store.subscribe(() => {
                            const { scope, proposalsReady } = this.store.getState();
                            if (scope === BEFORE_PURCHASE && proposalsReady) {
                                makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                                unsubscribe();
                            }
                        });
                    },
                    ['PriceMoved', 'InvalidContractProposal'],
                    delayIndex++
                ).then(onSuccess);
            }
            const trade_option = tradeOptionToBuy(contract_type, this.tradeOptions);
            const action = () => api_base.api.send(trade_option);

            this.isSold = false;

            contractStatus({
                id: 'contract.purchase_sent',
                data: this.tradeOptions.amount,
            });

            if (!this.options.timeMachineEnabled) {
                return doUntilDone(action).then(onSuccess);
            }

            return recoverFromError(
                action,
                (errorCode, makeDelay) => {
                    if (errorCode === 'DisconnectError') {
                        this.clearProposals();
                    }
                    const unsubscribe = this.store.subscribe(() => {
                        const { scope } = this.store.getState();
                        if (scope === BEFORE_PURCHASE) {
                            makeDelay().then(() => this.observer.emit('REVERT', 'before'));
                            unsubscribe();
                        }
                    });
                },
                ['PriceMoved', 'InvalidContractProposal'],
                delayIndex++
            ).then(onSuccess);
        }
        getPurchaseReference = () => purchase_reference;
        regeneratePurchaseReference = () => {
            purchase_reference = getUUID();
        };
    };
