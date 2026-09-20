CREATE DATABASE payments;
CREATE DATABASE wallets;
CREATE DATABASE ledger;
CREATE DATABASE psp;
CREATE DATABASE reconciliation;
\connect payments
\i /migrations/payment.sql
\connect wallets
\i /migrations/wallet.sql
\connect ledger
\i /migrations/ledger.sql
\connect psp
\i /migrations/psp.sql
\connect reconciliation
\i /migrations/reconciliation.sql
