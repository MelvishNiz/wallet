import { ValidationUtils } from '@nimiq/utils';
import { useConfig } from '../composables/useConfig';
import Time from './Time';
import { i18n } from '../i18n/i18n-setup';

export type GoCryptoRequestIdentifier = { merchantId: string } | { paymentId: string };

export enum GoCryptoPaymentStatus {
    Opened,
    InPayment, // This is the standard case when a request link is scanned.
    Paid,
    Processing,
    AutoClosed, // Payment expired
    Failed,
    NotValid,
    Refund, // Refunded after successful payment
    Cancelled, // Payment request cancelled on POS
}

export interface GoCryptoPaymentDetails {
    id: string; // payment id
    status: GoCryptoPaymentStatus;
    expiry: number; // timestamp in ms
    storeName: string;
    recipient: string;
    amount: number;
}

export interface GoCryptoPaymentApiError {
    // paymentNotFound is surprisingly returned for expired requests, instead of payment info status AutoClosed.
    errorCode: 'paymentNotFound' | string;
    errorMessage: string;
    request: GoCryptoRequestIdentifier;
}

export function parseGoCryptoRequestLink(requestLink: string | URL): GoCryptoRequestIdentifier | null {
    const { config } = useConfig();
    if (!config.goCrypto.enabled) return null;

    const url = toUrl(requestLink);
    // Note that we don't use the rather vague Regexs provided in GoCrypto's documentation but manually implement a
    // little stricter parsing.
    if (!url || !(
        /(?:^|\.)gocrypto\.com$/i.test(url.hostname)
        || /^gocrypto:$/i.test(url.protocol) // for scanning GoCrypto deep-links
    )) return null;

    // Note: searchParams.get also url decodes the parameters already
    const paymentId = url.searchParams.get('gocrypto_id');
    if (paymentId && !/\w+/.test(paymentId)) return null;
    const merchantId = url.searchParams.get('merchant_id');
    if (merchantId && !/\w+/.test(merchantId)) return null;

    // paymentId is more specific, therefore prioritize paymentId over merchantId, in case both are specified.
    if (paymentId) {
        return { paymentId };
    }
    if (merchantId) {
        return { merchantId };
    }

    return null;
}

export async function fetchGoCryptoPaymentDetails(requestIdentifier: GoCryptoRequestIdentifier)
: Promise<GoCryptoPaymentDetails | GoCryptoPaymentApiError | null> {
    const { config } = useConfig();
    if (!config.goCrypto.enabled) return null;

    // Note: for querying data by merchant id for fixed QR code stickers in the shop, the documentation claims that
    // <apiEndpoint>/v3/custodial/payment?merchant_id=<merchantId> should be queried, and chapter 4 suggests that v2 is
    // to be used. However, all those URLs are invalid or at least not CORS enabled. Experimentation showed, that the
    // same url path as querying for payment ids has to be used instead: /publicapi/payment.
    const url = `${config.goCrypto.apiEndpoint}publicapi/payment?${'merchantId' in requestIdentifier
        ? `merchant_id=${requestIdentifier.merchantId}`
        : `payment_id=${requestIdentifier.paymentId}`}`;
    const headers = {
        // Note: As of August 2023, setting a custom user agent is possible in Firefox and Safari, but not in Chrome
        // yet, see https://bugs.chromium.org/p/chromium/issues/detail?id=571722. However, the Chrome uer agent is good
        // enough for now, according to GoCrypto.
        'User-Agent': 'Nimiq Wallet',
        Authorization: `publicauth ${config.goCrypto.apiKey}`,
        'Content-Type': 'application/json',
    };

    try {
        const [response, timeOffset] = await Promise.all([
            fetch(url, {
                headers,
                cache: 'no-cache',
                referrerPolicy: 'no-referrer',
            }),
            Time.now().then((serverTime) => serverTime - Date.now()),
        ]);
        const data = await response.json(); // Try to read body which is set on valid requests and expected errors.

        if (!response.ok) {
            if (typeof data.code !== 'string' || typeof data.message !== 'string') return null; // unexpected error
            return {
                errorCode: data.code,
                errorMessage: data.message,
                request: requestIdentifier,
            };
        }

        const id: string = data.id; // eslint-disable-line prefer-destructuring
        if (typeof id !== 'string' || !/\w+/.test(id)
            || ('paymentId' in requestIdentifier && id !== requestIdentifier.paymentId)) return null;

        const status: GoCryptoPaymentStatus = data.status; // eslint-disable-line prefer-destructuring
        if (typeof status !== 'number' || !Object.values(GoCryptoPaymentStatus).includes(status)) return null;

        const expiry = Date.parse(data.expires_at) - timeOffset; // convert expiry to user's clock
        if (Number.isNaN(expiry)) return null;

        const storeName: string = data.store_full_name; // eslint-disable-line prefer-destructuring
        if (typeof storeName !== 'string' || !storeName) return null;

        // Only support Nimiq because GoCrypto doesn't support USDC and BTC is only supported as Lightning on Terminals.
        const nimiqPaymentOptions = Array.isArray(data.payment_options)
            && data.payment_options.find((option: any) => !!option && option.currency_name === 'NIM');
        if (!nimiqPaymentOptions || nimiqPaymentOptions.currency !== /* GoCrypto id for Nimiq */ 207) return null;

        const recipient: string = nimiqPaymentOptions.wallet_address
            .toUpperCase() // format as uppercase
            .replace(/\s/g, '') // strip spaces and dashes
            .replace(/(.)(?=(.{4})+$)/g, '$1 '); // reformat with spaces, forming blocks of 4 chars
        if (!ValidationUtils.isValidAddress(nimiqPaymentOptions.wallet_address)) return null;

        const amount = Math.round(Number.parseFloat(nimiqPaymentOptions.amount) * 1e5);
        if (Number.isNaN(amount) || !Number.isFinite(amount)) return null;

        return {
            id,
            status,
            expiry,
            storeName,
            recipient,
            amount,
        };
    } catch (e) {
        console.error('Failed to fetch GoCrypto payment info:', e); // eslint-disable-line no-console
        return null;
    }
}

export function goCryptoStatusToUserFriendlyMessage(paymentDetails: GoCryptoPaymentDetails | GoCryptoPaymentApiError)
: { paymentStatus: 'pending' }
    | { paymentStatus: 'accepted', title: string }
    | { paymentStatus: 'failed', title: string, message: string } {
    const successDefaults = {
        paymentStatus: 'accepted' as const,
    };
    const errorDefaults = {
        paymentStatus: 'failed' as const,
        // Concatenate sentences to re-use individual translations.
        // eslint-disable-next-line prefer-template
        message: i18n.t('Please ask the merchant to create a new payment request.') + ' '
            + i18n.t('If you already made a payment, please contact GoCrypto for a refund.'),
    };

    if ('errorCode' in paymentDetails) {
        switch (paymentDetails.errorCode) {
            case 'paymentNotFound': return {
                // No payment request found for the given identifier. While this could occur because the identifier is
                // simply invalid/unknown, this surprisingly also occurs more typically for expired requests, which do
                // not actually seem to return payment details with status AutoClosed.
                ...errorDefaults,
                title: 'paymentId' in paymentDetails.request
                    // We assume the more likely case of an expired request here.
                    ? i18n.t('The payment request expired') as string
                    // Likely, the merchant's previous payment request expired, which might have been for another
                    // customer, and he did not set up a new request yet for the new customer.
                    : i18n.t('No payment request found') as string,
                message: 'paymentId' in paymentDetails.request
                    ? errorDefaults.message
                    : i18n.t('Please ask the merchant to create a new payment request.') as string,
            };
            default: return {
                ...errorDefaults,
                title: i18n.t('Unexpected GoCrypto error') as string,
                message: i18n.t('Error {errorCode}: {errorMessage}', paymentDetails) as string,
            };
        }
    }

    switch (paymentDetails.status) {
        case GoCryptoPaymentStatus.Paid: return {
            ...successDefaults,
            title: i18n.t('Payment request has already been paid') as string,
        };
        case GoCryptoPaymentStatus.Processing: return {
            ...successDefaults,
            title: i18n.t('Your payment is being processed') as string,
        };
        case GoCryptoPaymentStatus.Failed: return {
            ...errorDefaults,
            title: i18n.t('Your payment failed') as string,
        };
        case GoCryptoPaymentStatus.NotValid: return {
            ...errorDefaults,
            title: i18n.t('Your payment is invalid') as string,
        };
        case GoCryptoPaymentStatus.Refund: return {
            ...errorDefaults,
            title: i18n.t('Your payment was refunded') as string,
            message: i18n.t('Please ask the merchant to create a new payment request.') as string,
        };
        case GoCryptoPaymentStatus.Cancelled: return {
            ...errorDefaults,
            title: i18n.t('Your payment was cancelled') as string,
        };
        default: // do nothing and continue with checks below
    }
    if (paymentDetails.status === GoCryptoPaymentStatus.AutoClosed || paymentDetails.expiry < Date.now()) {
        return {
            ...errorDefaults,
            title: i18n.t('The payment request expired') as string,
        };
    }
    // Unpaid request without any errors.
    return {
        paymentStatus: 'pending',
    };
}

function toUrl(link: string | URL): null | URL {
    if (link instanceof URL) return link;

    if (!link.includes(':')) {
        // If the link does not include a protocol, include a protocol to be parseable as URL. We assume https by
        // default, but it could be any dummy protocol. The // after the : can be omitted.
        link = `https:${link}`;
    }

    try {
        return new URL(link);
    } catch (e) {
        return null;
    }
}
