# User stories and acceptance criteria

Contract: `contracts/TokenizedBond.sol`. Tests: `test/TokenizedBond.test.js`; each test name starts with the criterion it checks.

## US0 Bond terms

As the issuer, I want invalid bond terms to be rejected at deployment, so that no bond can exist with terms that cannot be serviced.

| ID | Acceptance criterion | Function |
|---|---|---|
| AC0.1 | Deployment fails for zero face value, a coupon rate above 100 %, a zero coupon interval, or a maturity before the first coupon date. | `constructor` |

## US1 Investor eligibility

As the issuer, I want to maintain a whitelist of investors who passed KYC, so that only eligible parties can hold the bond.

| ID | Acceptance criterion | Function |
|---|---|---|
| AC1.1 | Only the issuer can add or remove an address. | `setWhitelisted` |
| AC1.2 | The zero address cannot be whitelisted. | `setWhitelisted` |
| AC1.3 | Every change emits `InvestorWhitelisted`. | `setWhitelisted` |

## US2 Issuance

As the issuer, I want to issue units to an eligible investor, so that ownership is recorded on the ledger.

| ID | Acceptance criterion | Function |
|---|---|---|
| AC2.1 | Only the issuer can issue. | `issue` |
| AC2.2 | Units can only be issued to whitelisted investors. | `issue` |
| AC2.3 | Issuing zero units is rejected. | `issue` |
| AC2.4 | The investor's balance and the total supply increase by the issued units; `BondIssued` and `Transfer` are emitted. | `issue` |
| AC2.5 | No issuance at or after maturity. | `issue` |

## US3 Transfers

As an investor, I want to transfer units to another eligible investor, so that transfers stay within the permissioned group.

| ID | Acceptance criterion | Function |
|---|---|---|
| AC3.1 | A transfer between whitelisted investors updates both balances. | `transfer` |
| AC3.2 | A transfer to a non-whitelisted address is rejected. | `transfer` |
| AC3.3 | An investor removed from the whitelist can no longer transfer. | `transfer` |
| AC3.4 | Transfers above the balance or of zero units are rejected. | `transfer` |
| AC3.5 | A third party can move units only within an allowance granted by the holder. | `approve`, `transferFrom` |

## US4 Coupon payments

As the issuer, I want to pay each scheduled coupon to the current holders, so that investors receive the cash flows defined in the terms.

| ID | Acceptance criterion | Function |
|---|---|---|
| AC4.1 | Coupon per unit = face value × annual rate × coupon interval / 365 days. | `couponPerUnit` |
| AC4.2 | No payment before the coupon date. | `payCoupon` |
| AC4.3 | The payment must equal coupon per unit × total supply. | `payCoupon` |
| AC4.4 | Each holder receives coupon per unit × holding, and the schedule moves to the next coupon date. | `payCoupon` |
| AC4.5 | Only the issuer can pay a coupon. | `payCoupon` |

## US5 Principal redemption

As an investor, I want to redeem my units for principal at maturity, so that the bond is repaid and closed.

| ID | Acceptance criterion | Function |
|---|---|---|
| AC5.1 | Principal can be funded only at or after maturity, and only once. | `fundRedemption` |
| AC5.2 | The funding must equal face value × total supply. | `fundRedemption` |
| AC5.3 | Redemption before funding is rejected. | `redeem` |
| AC5.4 | Redemption pays units × face value and burns the units. | `redeem` |
| AC5.5 | A holder without units cannot redeem. | `redeem` |
