# Production gaps

What `contracts/TokenizedBond.sol` does, and what a production implementation would need.

| Area | Prototype | Production |
|---|---|---|
| KYC/AML | Issuer sets a boolean whitelist flag per address. | Integration with onboarding and identity systems, sanctions screening, periodic re-checks; eligibility kept in a shared identity registry rather than in each bond contract. |
| DvP and cash leg | Transfers move units without payment. Coupons and principal are paid in the ledger's native test currency. | A regulated settlement asset (tokenised deposits or central bank money) and delivery versus payment, possibly across two ledgers. |
| Custody and key management | Local test accounts. | Custody wallets, HSM or MPC key management, key recovery, segregation of client assets. |
| Treasury-system integration | None. | Issuance from the funding plan, cash and liquidity management, accounting, regulatory reporting, reconciliation with internal books. |
| Legal register | None. | A register that is legally recognised (e.g. under eWpG), with terms and conditions consistent with the contract. |
| Servicing | Coupons pushed to all holders in one loop; simplified day count. | Record-date snapshots, claim-based payments that scale and isolate failing recipients, day-count and business-day conventions, paying agent role. |
| Controls and governance | A single issuer key. | Role separation, multi-signature approval, pause, forced transfer for court orders, recovery, upgrade governance. |
| Privacy | Balances and transfers are visible to every participant. | Confidentiality of positions and investor data. |
| Assurance | Automated tests. | Security audit, monitoring, incident processes. |
