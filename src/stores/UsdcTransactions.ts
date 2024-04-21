import Vue from 'vue';
import { getHistoricExchangeRates, isHistorySupportedFiatCurrency } from '@nimiq/utils';
import { getContract, SwapAsset } from '@nimiq/fastspot-api';
import { createStore } from 'pinia';
import config from 'config';
import { useFiatStore } from './Fiat';
import { CryptoCurrency, FiatCurrency, FIAT_API_PROVIDER_TX_HISTORY, FIAT_PRICE_UNAVAILABLE } from '../lib/Constants';
import { useSwapsStore } from './Swaps';
// import { getPolygonClient } from '../ethers';
import { getEurPerCrypto, getFiatFees } from '../lib/swap/utils/Functions';

type HtlcOpenEvent = {
    name: 'Open',
    id: string,
    token: string,
    amount: number,
    recipient: string,
    hash: string,
    timeout: number,
};

type HtlcRedeemEvent = {
    name: 'Redeem',
    id: string,
    secret: string,
};

type HtlcRefundEvent = {
    name: 'Refund',
    id: string,
};

export type HtlcEvent = HtlcOpenEvent | HtlcRedeemEvent | HtlcRefundEvent;

/**
 * These events are created from the viewpoint of bridged USDC, to be able to include the
 * (bridged USDC) fee in the resulting Transaction object.
 */
export type UniswapEvent = {
    name: 'Swap',
    amountIn: number,
    amountOut: number,
}

// This is a simplified transaction, only storing the token transfer.
// It is NOT a full Ethereum/Polygon transaction.
// Might be better named `UsdcTokenTransfer`...
export type Transaction = {
    token?: string,
    transactionHash: string,
    logIndex: number,
    sender: string,
    recipient: string,
    value: number,
    fee?: number,
    event?: HtlcEvent | UniswapEvent,
    state: TransactionState,
    blockHeight?: number,
    timestamp?: number,
} & {
    fiatValue?: Partial<Record<FiatCurrency, number | typeof FIAT_PRICE_UNAVAILABLE>>,
};

export enum TransactionState {
    NEW = 'new',
    PENDING = 'pending',
    MINED = 'mined',
    FAILED = 'failed',
    EXPIRED = 'expired',
    CONFIRMED = 'confirmed',
}

const scheduledHistoricFiatAmountUpdates: Partial<Record<FiatCurrency, Set<string>>> = {};

export const useUsdcTransactionsStore = createStore({
    id: 'usdcTransactions',
    state: () => ({
        transactions: {} as {[hash: string]: Transaction},
    }),
    getters: {
        // activeAccount: state => state.accounts[state.activeAccountId],
        pendingTransactionsBySender: (state) => {
            const pendingTxs = Object.values(state.transactions).filter((tx) => tx.state === 'pending');
            const txsBySender: {[address: string]: Transaction[] | undefined} = {};
            for (const tx of pendingTxs) {
                const array = txsBySender[tx.sender] || [];
                array.push(tx);
                txsBySender[tx.sender] = array;
            }
            return txsBySender;
        },
    },
    actions: {
        // Note: this method should not be async to avoid race conditions between parallel calls. Otherwise an older
        // transaction can overwrite its updated version.
        addTransactions(txs: Transaction[]) {
            if (!txs.length) return;

            // re-apply original timestamp and known fiatValue
            for (const tx of txs) {
                const knownTx = this.state.transactions[tx.transactionHash];
                if (!knownTx) continue;
                if (knownTx.timestamp) {
                    // Keep original timestamp and blockHeight instead of values at confirmation after 10 blocks.
                    tx.timestamp = knownTx.timestamp;
                    tx.blockHeight = knownTx.blockHeight;
                }
                if (!tx.fiatValue && knownTx.fiatValue) {
                    tx.fiatValue = knownTx.fiatValue;
                }
            }

            const newTxs: { [hash: string]: Transaction } = {};
            for (const tx of txs) {
                // Detect swaps
                if (!useSwapsStore().state.swapByTransaction[tx.transactionHash]) {
                    const asset = tx.token === config.usdc.nativeUsdcContract
                        ? SwapAsset.USDC_MATIC
                        : SwapAsset.USDC;
                    // HTLC Creation
                    if (tx.event?.name === 'Open') {
                        const hashRoot = tx.event.hash.substring(2);
                        useSwapsStore().addFundingData(hashRoot, {
                            asset,
                            transactionHash: tx.transactionHash,
                            htlc: {
                                address: tx.event.id,
                                refundAddress: tx.sender,
                                redeemAddress: tx.event.recipient,
                                timeoutTimestamp: tx.event.timeout,
                            },
                        });

                        if (!useSwapsStore().state.swaps[hashRoot].out) {
                            // Check this swap with the Fastspot API to detect if this was a EUR swap
                            getContract(asset, tx.event.id.substring(2)).then((contractWithEstimate) => {
                                if (contractWithEstimate.to.asset === SwapAsset.EUR) {
                                    const exchangeRate = {
                                        [CryptoCurrency.USDC]: {
                                            [FiatCurrency.EUR]: getEurPerCrypto(asset, contractWithEstimate),
                                        },
                                    };
                                    const fiatFees = getFiatFees(
                                        contractWithEstimate,
                                        CryptoCurrency.USDC,
                                        exchangeRate,
                                        FiatCurrency.EUR,
                                        null,
                                    );

                                    useSwapsStore().addSettlementData(hashRoot, {
                                        asset: SwapAsset.EUR,
                                        amount: contractWithEstimate.to.amount,
                                        // We cannot get bank info or EUR HTLC details from this.
                                    }, {
                                        fees: {
                                            totalFee: fiatFees.funding.total,
                                            asset: SwapAsset.EUR,
                                        },
                                    });
                                }
                            }).catch(() => undefined);
                        }
                    }
                    // HTLC Refunding
                    if (tx.event?.name === 'Refund') {
                        // async sub call to keep the main method synchronous to avoid race conditions and to avoid
                        // await in loop (slow sequential processing).
                        const swapId = tx.event.id;
                        (async () => {
                            // Find funding transaction
                            const selector = (testedTx: Transaction) =>
                                testedTx.event?.name === 'Open' && testedTx.event.id === swapId;

                            // First search known transactions
                            const fundingTx = [...Object.values(this.state.transactions), ...txs].find(selector);

                            // Then get funding tx from the blockchain
                            if (!fundingTx) {
                                // TODO: Find Open event for tx.event!.id
                                // const client = await getPolygonClient();
                                // const chainTxs = await client.getTransactionsByAddress(tx.sender);
                                // fundingTx = chainTxs.map((tx) => tx.toPlain()).find(selector);
                            }

                            if (fundingTx) {
                                const hashRoot = (fundingTx.event as HtlcOpenEvent).hash.substring(2);
                                useSwapsStore().addSettlementData(hashRoot, {
                                    asset,
                                    transactionHash: tx.transactionHash,
                                });
                            }
                        })();
                    }
                    // HTLC Settlement
                    if (tx.event?.name === 'Redeem') {
                        const secret = tx.event.secret.substring(2);
                        const hashRoot = Nimiq.Hash.sha256(Nimiq.BufferUtils.fromHex(secret)).toHex();
                        useSwapsStore().addSettlementData(hashRoot, {
                            asset,
                            transactionHash: tx.transactionHash,
                        });

                        if (!useSwapsStore().state.swaps[hashRoot].in) {
                            // Check this swap with the Fastspot API to detect if this was a EUR swap
                            getContract(asset, tx.event.id.substring(2)).then((contractWithEstimate) => {
                                if (contractWithEstimate.from.asset === SwapAsset.EUR) {
                                    const exchangeRate = {
                                        [CryptoCurrency.USDC]: {
                                            [FiatCurrency.EUR]: getEurPerCrypto(asset, contractWithEstimate),
                                        },
                                    };
                                    const fiatFees = getFiatFees(
                                        contractWithEstimate,
                                        CryptoCurrency.USDC,
                                        exchangeRate,
                                        FiatCurrency.EUR,
                                        null,
                                    );

                                    useSwapsStore().addFundingData(hashRoot, {
                                        asset: SwapAsset.EUR,
                                        amount: contractWithEstimate.from.amount,
                                        // We cannot get bank info or EUR HTLC details from this.
                                    }, {
                                        fees: {
                                            totalFee: fiatFees.settlement.total,
                                            asset: SwapAsset.EUR,
                                        },
                                    });
                                }
                            }).catch(() => undefined);
                        }
                    }
                }

                newTxs[tx.transactionHash] = tx;
            }

            // Need to re-assign the whole object in Vue 2 for change detection of new transactions.
            // TODO: Simply assign transactions in Vue 3.
            this.state.transactions = {
                ...this.state.transactions,
                ...newTxs,
            };

            // const { promoBoxVisible, setPromoBoxVisible } = useSwapsStore();
            // if (promoBoxVisible.value) {
            //     setPromoBoxVisible(false);
            // }

            this.calculateFiatAmounts(Object.values(newTxs));
        },

        async calculateFiatAmounts(transactions?: Transaction[], fiatCurrency?: FiatCurrency) {
            // fetch fiat amounts for transactions that have a timestamp (are mined) but no fiat amount yet
            const fiatStore = useFiatStore();
            fiatCurrency = fiatCurrency || fiatStore.currency.value;
            const historyFiatCurrency = isHistorySupportedFiatCurrency(fiatCurrency, FIAT_API_PROVIDER_TX_HISTORY)
                ? fiatCurrency
                : FiatCurrency.USD;
            const lastExchangeRateUpdateTime = fiatStore.timestamp.value;
            const currentRate = fiatStore.exchangeRates.value[CryptoCurrency.USDC]?.[fiatCurrency]; // might be pending
            const currentUsdRate = fiatStore.exchangeRates.value[CryptoCurrency.USDC]?.[FiatCurrency.USD];
            const transactionsToUpdate = (transactions || Object.values(this.state.transactions)).filter((tx) =>
                // Only update the fiat amount if it's neither set for the actual fiatCurrency nor historyFiatCurrency.
                // Generally, the amount for the actually requested fiatCurrency is preferred, so if that is already set
                // there is no need to fetch for the historyFiatCurrency. On the other hand, if historyFiatCurrency is
                // different to fiatCurrency, no historic amounts for fiatCurrency can be determined, thus only for new
                // transactions, and if an amount for historyFiatCurrency is already set, it's not a new transaction.
                typeof tx.fiatValue?.[fiatCurrency!] !== 'number'
                    && typeof tx.fiatValue?.[historyFiatCurrency] !== 'number'
                    && !scheduledHistoricFiatAmountUpdates[historyFiatCurrency]?.has(tx.transactionHash)
                    // USDC price is only available starting 2018-10-05T00:00:00Z, and this timestamp
                    // check prevents us from re-querying older transactions again and again.
                    && tx.timestamp && tx.timestamp >= 1538697600,
            ) as Array<Transaction & { timestamp: number }>;

            if (!transactionsToUpdate.length) return;

            scheduledHistoricFiatAmountUpdates[historyFiatCurrency] ||= new Set();
            const historicTransactions: typeof transactionsToUpdate = [];
            const { swapByTransaction } = useSwapsStore().state;

            for (const tx of transactionsToUpdate) {
                tx.fiatValue ||= {};

                // For very recent transactions use current exchange rate without unnecessarily querying historic rates,
                // which also don't get updated minutely and might not include the newest rates yet. If the user time is
                // not set correctly, this will gracefully fall back to fetching rates for new transactions as historic
                // exchange rates; old transactions at the user's system's time might be interpreted as current though.
                const isNewTransaction = Math.abs(tx.timestamp * 1000 - lastExchangeRateUpdateTime) < 2.5 * 60 * 1000;
                if (isNewTransaction && currentRate) {
                    // Set via Vue.set to let vue handle reactivity.
                    // TODO this might be not necessary anymore with Vue3, also for the other Vue.sets in this file.
                    Vue.set(tx.fiatValue, fiatCurrency, currentRate * (tx.value / 1e6));
                } else {
                    historicTransactions.push(tx);
                    scheduledHistoricFiatAmountUpdates[historyFiatCurrency]!.add(tx.transactionHash);
                }
                // For the calculation of swap limits, USD amounts of swap transactions are required. If we have the USD
                // rate already available without having to fetch it, because it's a new transaction, store it.
                if (isNewTransaction && currentUsdRate && swapByTransaction[tx.transactionHash]) {
                    Vue.set(tx.fiatValue, FiatCurrency.USD, currentUsdRate * (tx.value / 1e6));
                }
            }

            if (historicTransactions.length) {
                const historicExchangeRates = await getHistoricExchangeRates(
                    CryptoCurrency.USDC,
                    historyFiatCurrency,
                    historicTransactions.map((tx) => tx.timestamp * 1000),
                    FIAT_API_PROVIDER_TX_HISTORY,
                );

                for (let tx of historicTransactions) {
                    const exchangeRate = historicExchangeRates.get(tx.timestamp * 1000);
                    // Get the newest transaction object from the store in case it changed (which for the USDC
                    // transaction store it doesn't do, but doesn't hurt to make the code more resilient).
                    tx = this.state.transactions[tx.transactionHash] as typeof tx || tx;
                    Vue.set(tx.fiatValue!, historyFiatCurrency, exchangeRate !== undefined
                        ? exchangeRate * (tx.value / 1e6)
                        : FIAT_PRICE_UNAVAILABLE,
                    );

                    scheduledHistoricFiatAmountUpdates[historyFiatCurrency]!.delete(tx.transactionHash);
                }
            }

            // Manually notify the store of the deep changes to trigger subscriptions.
            // TODO this hack is likely not necessary in newer pinia versions.
            this.patch({});
        },

        removeTransactions(txs: Transaction[]) {
            const transactions = { ...this.state.transactions };
            for (const tx of txs) {
                delete transactions[tx.transactionHash];
            }
            // TODO cleanup swap store
            this.state.transactions = transactions;
        },
    },
});
