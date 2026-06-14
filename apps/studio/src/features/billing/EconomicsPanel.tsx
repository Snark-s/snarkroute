import React from "react";
import { RefreshCw } from "lucide-react";
import {
  creditTransactionDetails,
  creditTransactionLine,
  formatCredits,
  formatDateTime,
  formatSignedCredits,
  sumNumbers,
  userFacingCostActuals,
  userFacingCostEstimates
} from "../../shared/costFormatting";
import type { CreditTransaction, CurrentUser, LedgerSummary, RouteDoc, RunCostSummary, RunDisplayResult } from "../../studioTypes";

export function CreditTransactionMiniList({ transactions }: { transactions: CreditTransaction[] }) {
  return (
    <div className="creditMiniList">
      <strong>Last transactions</strong>
      {transactions.length > 0 ? transactions.map((transaction) => (
        <span key={transaction.id}>{creditTransactionLine(transaction)}</span>
      )) : <span>No credit transactions yet.</span>}
    </div>
  );
}

export function CreditHistoryPanel({ transactions, onRefresh }: { transactions: CreditTransaction[]; onRefresh?: () => void }) {
  return (
    <div className="creditHistoryPanel">
      <div className="creditHistoryHeader">
        <strong>Credit history</strong>
        {onRefresh ? <button className="nodeSmallButton" type="button" onClick={onRefresh}><RefreshCw size={13} /> Refresh</button> : null}
      </div>
      {transactions.length > 0 ? (
        <div className="creditHistoryRows">
          {transactions.map((transaction) => (
            <div className="creditHistoryRow" key={transaction.id}>
              <span>{formatDateTime(transaction.createdAt)}</span>
              <strong>{transaction.type}</strong>
              <span>{formatSignedCredits(transaction.amount)}</span>
              <span>{transaction.balanceAfter === null || transaction.balanceAfter === undefined ? "-" : `balance ${formatCredits(transaction.balanceAfter)}`}</span>
              <span>{creditTransactionDetails(transaction)}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No credit transactions yet.</p>
      )}
    </div>
  );
}

export function EconomicsPanel({
  route,
  runResult,
  ledgerSummary,
  runCostEstimate,
  creditBalance,
  creditTransactions,
  showDeveloperDiagnostics,
  isCloudMode,
  currentUser
}: {
  route: RouteDoc;
  runResult: RunDisplayResult | null;
  ledgerSummary: LedgerSummary | null;
  runCostEstimate: RunCostSummary | null;
  creditBalance: { balance: number; currency: string } | null;
  creditTransactions: CreditTransaction[];
  showDeveloperDiagnostics: boolean;
  isCloudMode: boolean;
  currentUser: CurrentUser | null;
}) {
  const economics = route.economics ?? { enabled: false, mode: "disabled" };
  const runEconomics = runResult?.economics && typeof runResult.economics === "object" ? (runResult.economics as Record<string, unknown>) : null;
  const providersUsed = Array.isArray(runEconomics?.providersUsed) ? runEconomics.providersUsed : [];
  const estimateEntries = userFacingCostEstimates(route, runCostEstimate);
  const actualEntries = userFacingCostActuals(route, runResult?.costSummary);
  const estimatedTotal = sumNumbers(estimateEntries.map((entry) => entry.estimatedCredits));
  const spentTotal = runResult?.costSummary ? sumNumbers(actualEntries.map((entry) => entry.actualCredits)) : null;
  const refunded = runResult?.costSummary ? Math.max(0, Number((estimatedTotal - (spentTotal ?? 0)).toFixed(6))) : 0;
  const hasEnoughCredits = !creditBalance || creditBalance.balance >= estimatedTotal;
  const details = actualEntries.length > 0
    ? actualEntries.map((entry) => ({ label: entry.label, credits: entry.actualCredits }))
    : estimateEntries.map((entry) => ({ label: entry.label, credits: entry.estimatedCredits }));
  return (
    <div className="economicsPanel">
      <h3>Credits</h3>
      <div className="creditSummary">
        <span>Estimated</span>
        <strong>{formatCredits(estimatedTotal)}</strong>
        <span>Spent</span>
        <strong>{spentTotal === null ? "-" : formatCredits(spentTotal)}</strong>
        <span>Refunded</span>
        <strong>{formatCredits(refunded)}</strong>
        {creditBalance ? (
          <>
            <span>Balance</span>
            <strong>{formatCredits(creditBalance.balance)}</strong>
          </>
        ) : null}
      </div>
      {creditBalance && !hasEnoughCredits ? <p className="errorText">Not enough credits for this run.</p> : null}
      {isCloudMode && !currentUser ? <p className="muted">Sign in to save routes and keep generated results.</p> : null}
      {isCloudMode && currentUser ? (
        <details className="creditHistoryDetails">
          <summary>Credit history</summary>
          <CreditHistoryPanel transactions={creditTransactions} />
        </details>
      ) : null}
      <h3>Details</h3>
      {details.length > 0 ? (
        <div className="costDetails">
          {details.map((entry) => (
            <React.Fragment key={entry.label}>
              <span>{entry.label}</span>
              <strong>{formatCredits(entry.credits)}</strong>
            </React.Fragment>
          ))}
        </div>
      ) : (
        <p className="muted">No paid provider calls in this route.</p>
      )}
      {showDeveloperDiagnostics ? (
        <details className="developerDiagnostics">
          <summary>Developer diagnostics</summary>
          <div className="economicsGrid">
            <span>enabled</span>
            <strong>{String(economics.enabled ?? false)}</strong>
            <span>mode</span>
            <strong>{String(economics.mode ?? (economics.enabled ? "metadata-only" : "disabled"))}</strong>
            <span>payment</span>
            <strong>false</strong>
          </div>
          <pre className="miniPre">
            {JSON.stringify(
              {
                author: economics.author ?? route.route.author,
                contributors: economics.contributors ?? [],
                revenueSplits: economics.revenueSplits ?? []
              },
              null,
              2
            )}
          </pre>
          <h3>Last Run</h3>
          {runEconomics ? (
            <pre className="miniPre">
              {JSON.stringify(
                {
                  providersUsed,
                  costSummary: runEconomics.costSummary,
                  paymentExecuted: false
                },
                null,
                2
              )}
            </pre>
          ) : (
            <p className="muted">No run accounting yet.</p>
          )}
          <h3>Ledger</h3>
          {ledgerSummary ? (
            <pre className="miniPre">
              {JSON.stringify(
                {
                  totalRuns: ledgerSummary.totalRuns,
                  runsByProvider: ledgerSummary.runsByProvider,
                  runsByStatus: ledgerSummary.runsByStatus,
                  estimatedProviderCostTotal: ledgerSummary.estimatedProviderCostTotal,
                  actualProviderCostTotal: ledgerSummary.actualProviderCostTotal,
                  recentRuns: ledgerSummary.recentRuns.slice(0, 3)
                },
                null,
                2
              )}
            </pre>
          ) : (
            <p className="muted">Ledger unavailable.</p>
          )}
        </details>
      ) : null}
    </div>
  );
}