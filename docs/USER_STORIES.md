# Requirements expressed as user stories

1. As an issuer, I want to approve investor addresses so that only KYC-eligible parties can hold the bond.
   - Acceptance: a non-issuer cannot change the whitelist; transfers to an unapproved address fail.
2. As an issuer, I want to issue a defined number of bond units so that ownership is recorded on the ledger.
   - Acceptance: only the issuer can issue; balances and total supply update; an event is emitted.
3. As an approved investor, I want to transfer units to another approved investor so that permissioned secondary trading can be represented.
   - Acceptance: insufficient balances and non-whitelisted recipients are rejected.
4. As an issuer, I want to pay a scheduled fixed coupon so that current holders receive the amount defined by the bond terms.
   - Acceptance: early and incorrectly funded payments fail; balances determine distribution.
5. As an issuer, I want to fund principal at maturity so that investors can redeem their holdings.
   - Acceptance: early funding fails; each redeemed unit is burned; principal is paid once.

The automated test suite maps directly to these acceptance criteria.
