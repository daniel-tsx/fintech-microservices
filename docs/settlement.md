# Settlement

Status: designed, not yet executable.

Authorization reserves processor capacity; capture creates a payable; ledger posting records accounting; settlement moves net funds between processor cash and merchant payable; reconciliation proves records agree. They are not synonyms or one status.

A simplified settlement batch groups captured, unsettled payments by merchant and currency, subtracts refunds/fees, posts one balanced settlement journal, and emits `settlement.created.v1`. The batch requires a unique `(merchant, currency, window)` key and item uniqueness so retry cannot pay twice.

Settlement execution remains intentionally deferred. The durable Payment-to-Ledger slice is now wired, but this iteration deliberately stops at Ledger persistence rather than expanding into settlement.
