# Security baseline

Status: partial baseline; not a compliance claim.

Implemented: strict DTO validation/whitelisting, small JSON body limit, Helmet, no wildcard CORS, stable UUID identifiers, external-response schema validation, parameterized-ORM direction, raw-body HMAC webhook verification, timestamp/replay checks, and secret configuration through environment variables.

Not implemented: Identity/Auth service, JWT/JWKS verification, customer/merchant authorization, service identity/mTLS, rate limiting, audit-log persistence, secret rotation, encryption key management, field-level privacy controls, dependency scanning policy, and gateway/WAF controls. Until those exist, bind services to a trusted local network only.

PCI-DSS remains out of scope. LedgerFlow stores no PAN, CVV, or real payment credentials. A real platform also needs card-data tokenization/segmentation, formal access reviews, vulnerability management, incident response, retention/deletion policies, vendor governance, penetration testing, and legal/compliance review.
