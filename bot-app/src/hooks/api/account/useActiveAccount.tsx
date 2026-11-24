import { useMemo } from 'react';
/* [AI] - Analytics removed - utility functions moved to @/utils/account-helpers */
import { isVirtualAccount } from '@/utils/account-helpers';
/* [/AI] */
import { CurrencyIcon } from '@/components/currency/currency-icon';
import { addComma, getDecimalPlaces } from '@/components/shared';
import { useApiBase } from '@/hooks/useApiBase';
import { Balance } from '@deriv/api-types';

/** A custom hook that returns the account object for the current active account. */
const useActiveAccount = ({
    allBalanceData,
    directBalance,
    directBalanceLoginid,
}: {
    allBalanceData: Balance | null;
    directBalance?: string;
    /** Account the direct balance belongs to; it is only used for that account. */
    directBalanceLoginid?: string;
}) => {
    const { accountList, activeLoginid } = useApiBase();

    const activeAccount = useMemo(
        () => accountList?.find(account => account.loginid === activeLoginid),
        [activeLoginid, accountList]
    );

    const currentBalanceData = allBalanceData?.accounts?.[activeAccount?.loginid ?? ''];

    const modifiedAccount = useMemo(() => {
        if (!activeAccount) return undefined;

        // Use centralized utility to determine if demo account
        const isVirtual = isVirtualAccount(activeAccount.loginid);

        // The direct balance comes from the live socket, which stays bound to the
        // previously selected account until re-authorisation completes. Showing it
        // during that window would label the old account's money with the new
        // account's currency, so it only counts for the account it belongs to.
        const directBalanceApplies =
            directBalanceLoginid !== undefined && directBalanceLoginid === activeAccount.loginid;

        // A balance is only shown when one is actually known. Falling back to
        // zero would display a real account as empty, which is indistinguishable
        // from a genuine zero balance and misleads the trader.
        const candidates = [
            currentBalanceData?.balance,
            directBalanceApplies && typeof directBalance === 'string' && directBalance.trim() !== ''
                ? Number(directBalance)
                : undefined,
            typeof activeAccount.balance === 'number' ? activeAccount.balance : undefined,
        ];
        const knownBalance = candidates.find(
            value => typeof value === 'number' && Number.isFinite(value)
        ) as number | undefined;

        return {
            ...activeAccount,
            balance:
                knownBalance === undefined
                    ? null
                    : addComma(knownBalance.toFixed(getDecimalPlaces(activeAccount.currency))),
            currencyLabel: isVirtual ? 'Demo' : activeAccount?.currency,
            icon: <CurrencyIcon currency={activeAccount?.currency?.toLowerCase()} isVirtual={isVirtual} />,
            isVirtual: isVirtual,
            isActive: activeAccount?.loginid === activeLoginid,
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeAccount, activeLoginid, allBalanceData, directBalance, directBalanceLoginid]);

    return {
        /** User's current active account. */
        data: modifiedAccount,
    };
};

export default useActiveAccount;
