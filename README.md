# Tokenized Bond Lifecycle Prototype

EVM-based prototype of a permissioned tokenized bond.

![Project page](dashboard-preview.png)

- **Lifecycle.** `contracts/TokenizedBond.sol` covers investor whitelisting,
  issuance, transfers, coupon payments and principal redemption.
- **Requirements.** Bond lifecycle requirements are written as user stories with
  acceptance criteria (`docs/USER_STORIES.md`). Each criterion has an ID that maps
  to a contract function and to automated tests named after it
  (`test/TokenizedBond.test.js`, 24 positive and negative tests for permissions,
  payments and lifecycle constraints).
- **Workflow.** A browser-based workflow runs the lifecycle against a local EVM
  ledger, including attempts that violate the acceptance criteria and are rejected
  by the contract. Production gaps such as KYC/AML integration, DvP, custody and
  treasury-system integration are documented in `docs/PRODUCTION_GAPS.md`.

## Run

Requirements: Node.js 20 or 22 and npm.

```bash
npm install
npm test         # all tests (Hardhat)
npm run demo     # browser workflow at http://127.0.0.1:3000
```

## Structure

```text
contracts/TokenizedBond.sol   Bond contract
test/TokenizedBond.test.js    Tests, named by acceptance criterion
docs/USER_STORIES.md          User stories and acceptance criteria
docs/PRODUCTION_GAPS.md       Production gaps
docs/PROCESS_COMPARISON.md    Conventional vs. DLT-based lifecycle
public/bond.*                 Browser workflow
scripts/demo-server.js        Local ledger and API for the browser workflow
```

## Extensions

Follow-up work on the DvP gap, each with its own tests:

- Same-ledger DvP against a tokenised cash token: `contracts/DvPSettlement.sol`.
- DvP and coupon settlement across two ledgers with hash-locked cash and a
  stateless decryption oracle: `contracts/lab/`, `scripts/lab/`; pages `/settlement`
  and `/lab` of the demo server.

## License

MIT. No warranty.
