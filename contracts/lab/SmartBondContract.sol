// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBondToken {
    function servicer() external view returns (address);
    function balanceOf(address holder) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 units) external returns (bool);
    function burn(uint256 units) external;
}

/**
 * @title SmartBondContract
 * @notice One instance per bond transaction, deployed by SmartBondFactory.
 *         A learning re-build of the architecture described in the March 2026
 *         DZ BANK / KfW "Smart Bond Contract" pilot report; not its code.
 * @dev Life cycle (each state gates the next, each step has one role):
 *        IndicationPhase  --inceptTrade (issuer)-->        TradeIncepted
 *        TradeIncepted    --confirmTrade (investor)-->     DistributionPhase   terms now immutable
 *        DistributionPhase--assignIsin (ISIN agent)-->     IsinAssigned
 *        IsinAssigned     --registerToken (registrar)-->   Minted
 *        Minted           --issuance DvP settles-->        Issued
 *        Issued           --coupons, then redemption DvP-> Redeemed
 *        IndicationPhase / TradeIncepted --cancel-->       Cancelled
 *
 *      Every cash movement (issuance price, each coupon, principal) is one
 *      settlement with the same pattern, after the Bundesbank Trigger Solution
 *      model in the pilot: the oracle generates a success and a failure key; the
 *      payer locks cash on the payment ledger against both hashes; the payee's
 *      own connector verifies the lock and attests it here; settlement then
 *      requests exactly one key. The success key releases the cash to the payee
 *      and, for coupons and principal, is what discharges the claim.
 */
contract SmartBondContract {
    enum State { IndicationPhase, TradeIncepted, DistributionPhase, IsinAssigned, Minted, Issued, Redeemed, Cancelled }

    enum SettlementStatus { None, KeysRequested, KeysCommitted, CashLocked, SuccessRequested, FailureRequested, Succeeded, Failed }

    struct Settlement {
        uint256 purpose; // 0 = issuance, 1..couponCount = coupon, couponCount + 1 = redemption
        address payer;
        address payee;
        uint256 amount;
        bytes32 hashSuccess;
        bytes32 hashFailure;
        bytes32 cashLockId;
        SettlementStatus status;
    }

    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant YEAR = 365 days;

    address public immutable factory;
    address public immutable issuer;
    address public immutable investor;
    address public immutable registrar;
    address public immutable isinAgent;
    address public immutable decryptionOracle;
    uint256 public immutable faceValue; // per unit, in cash token units (EUR cents)
    uint256 public immutable units;
    uint256 public immutable tenorYears;
    uint256 public immutable indicativeCouponBps;

    State public state;

    // Final terms, fixed by inceptTrade and immutable after confirmTrade.
    string public terms; // structured issuance terms (BDT-inspired JSON): the single source of truth
    bytes32 public termsHash;
    uint256 public couponBps;
    uint256 public issueDate;
    uint256 public maturityDate;

    string public isin;
    address public token;

    mapping(uint256 => Settlement) public settlements;
    // As in the pilot, the contract stores both encrypted keys and asks for exactly one.
    mapping(uint256 => bytes) public keyEncryptedSuccessOf;
    mapping(uint256 => bytes) public keyEncryptedFailureOf;
    mapping(uint256 => uint256) public attemptCount; // per purpose
    mapping(uint256 => uint256) public openSettlement; // purpose => settlement id, 0 if none
    mapping(uint256 => bool) public discharged; // purpose => obligation fulfilled

    event StateChanged(State indexed newState);
    event TradeIncepted(bytes32 termsHash, uint256 couponBps, uint256 issueDate, uint256 maturityDate, string terms);
    event TradeConfirmed(bytes32 termsHash);
    event IsinAssigned(string isin);
    event TokenRegistered(address token, uint256 units);
    event KeysRequested(uint256 indexed settlementId, uint256 purpose, address payer, address payee, uint256 amount);
    event KeysCommitted(uint256 indexed settlementId, bytes32 hashSuccess, bytes keyEncryptedSuccess, bytes32 hashFailure, bytes keyEncryptedFailure);
    event CashLockAttested(uint256 indexed settlementId, bytes32 cashLockId);
    event DecryptionRequested(uint256 indexed settlementId, bool success, address payee, uint256 amount, bytes encryptedKey);
    event KeyReleased(uint256 indexed settlementId, bool success, bytes key);
    event ObligationDischarged(uint256 indexed purpose, uint256 settlementId, uint256 amount);
    event SettlementFailed(uint256 indexed settlementId, string reason);

    error WrongRole();
    error WrongState(State current);
    error WrongSettlementStatus(SettlementStatus current);
    error TermsMismatch();
    error InvalidPurpose();
    error NotDue();
    error AlreadyDischarged();
    error SettlementOpen();
    error PreviousObligationOpen();
    error InvalidKey();

    modifier only(address role) {
        if (msg.sender != role) revert WrongRole();
        _;
    }

    modifier inState(State required) {
        if (state != required) revert WrongState(state);
        _;
    }

    constructor(
        address issuer_,
        address investor_,
        address registrar_,
        address isinAgent_,
        address decryptionOracle_,
        uint256 faceValue_,
        uint256 units_,
        uint256 tenorYears_,
        uint256 indicativeCouponBps_
    ) {
        factory = msg.sender;
        issuer = issuer_;
        investor = investor_;
        registrar = registrar_;
        isinAgent = isinAgent_;
        decryptionOracle = decryptionOracle_;
        faceValue = faceValue_;
        units = units_;
        tenorYears = tenorYears_;
        indicativeCouponBps = indicativeCouponBps_;
        emit StateChanged(State.IndicationPhase);
    }

    // ---- Trade confirmation (ERC-6123 style: incept, then confirm the same data) ----

    /**
     * @notice The issuer publishes the final terms. `terms_` is the full structured
     *         record; the numeric fields repeat what the contract must enforce, and
     *         the investor's connector checks that both say the same before confirming.
     */
    function inceptTrade(string calldata terms_, uint256 couponBps_, uint256 issueDate_) external only(issuer) inState(State.IndicationPhase) {
        if (issueDate_ + 1 days < block.timestamp || issueDate_ > block.timestamp + 7 days) revert TermsMismatch();
        terms = terms_;
        termsHash = keccak256(bytes(terms_));
        couponBps = couponBps_;
        issueDate = issueDate_;
        maturityDate = issueDate_ + tenorYears * YEAR;
        _setState(State.TradeIncepted);
        emit TradeIncepted(termsHash, couponBps_, issueDate, maturityDate, terms_);
    }

    /// @notice The investor confirms by repeating the hash of exactly these terms.
    function confirmTrade(bytes32 termsHash_) external only(investor) inState(State.TradeIncepted) {
        if (termsHash_ != termsHash) revert TermsMismatch();
        _setState(State.DistributionPhase);
        emit TradeConfirmed(termsHash_);
    }

    /// @notice Either party may walk away before the terms are confirmed.
    function cancel() external {
        if (msg.sender != issuer && msg.sender != investor) revert WrongRole();
        if (state != State.IndicationPhase && state != State.TradeIncepted) revert WrongState(state);
        _setState(State.Cancelled);
    }

    // ---- Distribution: ISIN and minting by the infrastructure participants ----

    function assignIsin(string calldata isin_) external only(isinAgent) inState(State.DistributionPhase) {
        isin = isin_;
        _setState(State.IsinAssigned);
        emit IsinAssigned(isin_);
    }

    /// @notice The registrar reports the token it deployed and minted to the issuer.
    function registerToken(address token_) external only(registrar) inState(State.IsinAssigned) {
        if (IBondToken(token_).servicer() != address(this)) revert TermsMismatch();
        if (IBondToken(token_).balanceOf(issuer) != units) revert TermsMismatch();
        token = token_;
        _setState(State.Minted);
        emit TokenRegistered(token_, units);
        _openSettlement(0, investor, issuer, units * faceValue);
    }

    // ---- Coupons and redemption ----

    function couponCount() public view returns (uint256) {
        return tenorYears; // annual coupons
    }

    function couponDate(uint256 period) public view returns (uint256) {
        if (period == 0 || period > couponCount()) revert InvalidPurpose();
        return issueDate + period * YEAR;
    }

    /// @notice Annual fixed coupon on the whole position: a regular period pays nominal x rate.
    function couponAmount() public view returns (uint256) {
        return (units * faceValue * couponBps) / BASIS_POINTS;
    }

    /// @notice Anyone may open the settlement of a due coupon; coupons are settled in order.
    function openCouponSettlement(uint256 period) external inState(State.Issued) returns (uint256) {
        if (block.timestamp < couponDate(period)) revert NotDue();
        if (period > 1 && !discharged[period - 1]) revert PreviousObligationOpen();
        return _openSettlement(period, issuer, investor, couponAmount());
    }

    /// @notice The investor asks for redemption at maturity, after all coupons are discharged.
    function requestRedemption() external only(investor) inState(State.Issued) returns (uint256) {
        if (block.timestamp < maturityDate) revert NotDue();
        if (!discharged[couponCount()]) revert PreviousObligationOpen();
        return _openSettlement(couponCount() + 1, issuer, investor, units * faceValue);
    }

    // ---- Settlement protocol ----

    /// @notice The oracle commits both keys; nobody else ever sees their plaintexts.
    function commitKeys(
        uint256 settlementId,
        bytes32 hashSuccess,
        bytes calldata keyEncryptedSuccess,
        bytes32 hashFailure,
        bytes calldata keyEncryptedFailure
    ) external only(decryptionOracle) {
        Settlement storage s = _settlement(settlementId, SettlementStatus.KeysRequested);
        s.hashSuccess = hashSuccess;
        s.hashFailure = hashFailure;
        keyEncryptedSuccessOf[settlementId] = keyEncryptedSuccess;
        keyEncryptedFailureOf[settlementId] = keyEncryptedFailure;
        s.status = SettlementStatus.KeysCommitted;
        emit KeysCommitted(settlementId, hashSuccess, keyEncryptedSuccess, hashFailure, keyEncryptedFailure);
    }

    /**
     * @notice The payee's own connector has checked on the payment ledger that the
     *         payer locked the right amount, for the payee, against these hashes.
     *         The party that would lose from a fake lock is the one that verifies it.
     */
    function attestCashLock(uint256 settlementId, bytes32 cashLockId) external {
        Settlement storage s = _settlement(settlementId, SettlementStatus.KeysCommitted);
        if (msg.sender != s.payee) revert WrongRole();
        s.cashLockId = cashLockId;
        s.status = SettlementStatus.CashLocked;
        emit CashLockAttested(settlementId, cashLockId);
    }

    /// @notice Anyone triggers settlement once the cash is locked and attested.
    function settle(uint256 settlementId) external {
        Settlement storage s = _settlement(settlementId, SettlementStatus.CashLocked);
        uint256 redemption = couponCount() + 1;

        if (s.purpose == 0) {
            // Issuance: deliver the units to the investor, or fail without moving anything.
            IBondToken bond = IBondToken(token);
            if (bond.allowance(issuer, address(this)) < units || bond.balanceOf(issuer) < units) {
                _requestKey(settlementId, s, false, "Issuer has not authorised delivery of the units");
                return;
            }
            bond.transferFrom(issuer, investor, units);
            _setState(State.Issued);
        } else if (s.purpose == redemption) {
            // Redemption: take the units back and burn them.
            IBondToken bond = IBondToken(token);
            if (bond.allowance(investor, address(this)) < units || bond.balanceOf(investor) < units) {
                _requestKey(settlementId, s, false, "Investor has not authorised return of the units");
                return;
            }
            bond.transferFrom(investor, address(this), units);
            bond.burn(units);
            _setState(State.Redeemed);
        }
        // Coupons move no units: the locked cash is simply released.
        _requestKey(settlementId, s, true, "");
    }

    /// @notice Payer or payee aborts before settlement; the failure key returns the locked cash.
    function abort(uint256 settlementId) external {
        Settlement storage s = settlements[settlementId];
        if (msg.sender != s.payer && msg.sender != s.payee) revert WrongRole();
        if (s.status != SettlementStatus.KeysCommitted && s.status != SettlementStatus.CashLocked) {
            revert WrongSettlementStatus(s.status);
        }
        _requestKey(settlementId, s, false, "Aborted before settlement");
    }

    /**
     * @notice The oracle publishes the requested key. Accepting the success
     *         preimage is what discharges the obligation (payment versus discharge);
     *         a failure preimage closes this attempt and the obligation stays open.
     */
    function publishKey(uint256 settlementId, bytes calldata key) external only(decryptionOracle) {
        Settlement storage s = settlements[settlementId];
        bytes32 hashed = keccak256(key);
        if (s.status == SettlementStatus.SuccessRequested) {
            if (hashed != s.hashSuccess) revert InvalidKey();
            s.status = SettlementStatus.Succeeded;
            discharged[s.purpose] = true;
            emit ObligationDischarged(s.purpose, settlementId, s.amount);
        } else if (s.status == SettlementStatus.FailureRequested) {
            if (hashed != s.hashFailure) revert InvalidKey();
            s.status = SettlementStatus.Failed;
        } else {
            revert WrongSettlementStatus(s.status);
        }
        openSettlement[s.purpose] = 0;
        emit KeyReleased(settlementId, s.status == SettlementStatus.Succeeded, key);
    }

    /// @notice After a failed attempt (e.g. a wrong cash lock), a new attempt with fresh keys can be opened.
    function retrySettlement(uint256 purpose) external returns (uint256) {
        if (msg.sender != issuer && msg.sender != investor) revert WrongRole();
        if (discharged[purpose]) revert AlreadyDischarged();
        if (openSettlement[purpose] != 0) revert SettlementOpen();
        if (attemptCount[purpose] == 0) revert InvalidPurpose();
        Settlement storage last = settlements[purpose * 100 + attemptCount[purpose]];
        return _openSettlement(purpose, last.payer, last.payee, last.amount);
    }

    // ---- internals ----

    function _openSettlement(uint256 purpose, address payer, address payee, uint256 amount) private returns (uint256 id) {
        if (discharged[purpose]) revert AlreadyDischarged();
        if (openSettlement[purpose] != 0) revert SettlementOpen();
        uint256 attempt = ++attemptCount[purpose];
        id = purpose * 100 + attempt;
        settlements[id] = Settlement(purpose, payer, payee, amount, bytes32(0), bytes32(0), bytes32(0), SettlementStatus.KeysRequested);
        openSettlement[purpose] = id;
        emit KeysRequested(id, purpose, payer, payee, amount);
    }

    function _requestKey(uint256 settlementId, Settlement storage s, bool success, string memory reason) private {
        s.status = success ? SettlementStatus.SuccessRequested : SettlementStatus.FailureRequested;
        if (!success) emit SettlementFailed(settlementId, reason);
        bytes storage encryptedKey = success ? keyEncryptedSuccessOf[settlementId] : keyEncryptedFailureOf[settlementId];
        emit DecryptionRequested(settlementId, success, s.payee, s.amount, encryptedKey);
    }

    function _settlement(uint256 settlementId, SettlementStatus required) private view returns (Settlement storage s) {
        s = settlements[settlementId];
        if (s.status != required) revert WrongSettlementStatus(s.status);
    }

    function _setState(State next) private {
        state = next;
        emit StateChanged(next);
    }
}
