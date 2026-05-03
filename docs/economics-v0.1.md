# Economics v0.1

SnarkRoute v0.1 adds economics as protocol metadata and local run accounting.

It does not execute payments. It does not add marketplace behavior, checkout, billing APIs, settlement, blockchain, user accounts, or share payouts.

## Philosophy

Open Route Protocol should preserve authorship, attribution, provider cost hints, and intended revenue splits from the beginning. That metadata belongs in the route document because the route/workflow is the portable unit of value.

## Metadata vs Payment Execution

Route economics metadata can describe:

- route author
- contributors
- intended revenue splits
- provider cost hints
- currency
- notes
- wallet or DID identifiers as metadata

Run accounting can describe:

- provider usage
- prediction ids or task ids
- run status
- estimated and actual provider costs when known
- local ledger entries

`paymentExecuted` is always `false` in v0.1.

## Local Ledger

Each completed run appends one local JSONL entry to:

```text
data/ledger/runs.jsonl
```

The ledger is local-only and ignored by git. It must not contain API tokens or secret values. The ledger is not exported with routes.

## Current Limitations

- Real payments are not implemented.
- Provider actual costs may be `null`.
- Marketplace features are not implemented.
- Share calculation is not executed.
- Economics metadata is not a legal contract.

## Roadmap

- v0.1: attribution, economics metadata, local run accounting
- v0.2: cost ledger
- v0.3: share calculation
- v0.4: optional settlement/payment layer

---

This document is licensed under CC BY-SA 4.0.
