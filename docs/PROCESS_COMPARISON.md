# Traditional bond vs. DLT-based bond

| Stage | Simplified traditional process | Prototype DLT process | Potential effect |
|---|---|---|---|
| Investor eligibility | KYC records are held in separate systems and checked by intermediaries | Issuer maintains an on-chain whitelist | Transfer restrictions become directly enforceable by code |
| Issuance | Issuer, paying agent, registrar, CSD and banks exchange instructions and reconcile records | Approved investors receive bond units on one shared ledger | A common record may reduce reconciliation effort |
| Ownership transfer | Trading and settlement records pass through multiple ledgers | Tokens transfer between whitelisted addresses | Ownership update and settlement instruction can be atomic |
| Coupon | Paying agent calculates entitlements and distributes cash through banking rails | Contract calculates the coupon and distributes test-network currency | Rules are transparent and execution can be automated |
| Redemption | Paying agent distributes principal and securities are cancelled in connected systems | Issuer funds the contract; investors redeem and their units are burned | Payment and cancellation are linked in one workflow |

## Important reality check

DLT does not remove the need for legal documentation, KYC/AML, custody, cash settlement, governance, privacy controls or regulatory reporting. A production solution would also need an authoritative off-chain identity system, secure roles, a regulated settlement asset, recovery and pause mechanisms, record-date snapshots, scalable payments, audits, and integration with existing capital-markets infrastructure.

This prototype therefore demonstrates a process concept, not a claim that public-blockchain code can replace the full securities lifecycle.
