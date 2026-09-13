// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TokenizedBond
 * @notice Educational prototype of a permissioned, fixed-rate tokenized bond.
 * @dev Native test-network currency represents cash. This is deliberately not
 *      production-ready and is not an investment product.
 */
contract TokenizedBond {
    uint256 public constant BASIS_POINTS = 10_000;
    uint256 public constant YEAR = 365 days;

    string public name;
    string public symbol;
    address public immutable issuer;
    uint256 public immutable faceValue;
    uint256 public immutable annualCouponRateBps;
    uint256 public immutable couponInterval;
    uint256 public immutable maturityDate;

    uint256 public totalSupply;
    uint256 public nextCouponDate;
    uint256 public couponsPaid;
    bool public redemptionFunded;

    mapping(address => bool) public isWhitelisted;
    mapping(address => uint256) public balanceOf;

    address[] private holders;
    mapping(address => bool) private hasBeenHolder;

    event InvestorWhitelisted(address indexed investor, bool approved);
    event BondIssued(address indexed investor, uint256 units);
    event Transfer(address indexed from, address indexed to, uint256 units);
    event CouponPaid(uint256 indexed couponNumber, uint256 paymentDate, uint256 totalAmount);
    event RedemptionFunded(uint256 totalAmount);
    event Redeemed(address indexed investor, uint256 units, uint256 principalAmount);

    error OnlyIssuer();
    error InvalidTerms();
    error InvestorNotWhitelisted();
    error IssuanceClosed();
    error InvalidAmount();
    error InsufficientBalance();
    error CouponNotDue();
    error IncorrectPayment(uint256 expected, uint256 received);
    error BondNotMatured();
    error RedemptionAlreadyFunded();
    error RedemptionNotFunded();
    error CashTransferFailed();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert OnlyIssuer();
        _;
    }

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 faceValue_,
        uint256 annualCouponRateBps_,
        uint256 couponInterval_,
        uint256 maturityDate_
    ) {
        if (
            faceValue_ == 0 ||
            annualCouponRateBps_ > BASIS_POINTS ||
            couponInterval_ == 0 ||
            maturityDate_ <= block.timestamp + couponInterval_
        ) revert InvalidTerms();

        name = name_;
        symbol = symbol_;
        issuer = msg.sender;
        faceValue = faceValue_;
        annualCouponRateBps = annualCouponRateBps_;
        couponInterval = couponInterval_;
        maturityDate = maturityDate_;
        nextCouponDate = block.timestamp + couponInterval_;
    }

    function setWhitelisted(address investor, bool approved) external onlyIssuer {
        if (investor == address(0)) revert InvalidAmount();
        isWhitelisted[investor] = approved;
        emit InvestorWhitelisted(investor, approved);
    }

    function issue(address investor, uint256 units) external onlyIssuer {
        if (block.timestamp >= maturityDate || redemptionFunded) revert IssuanceClosed();
        if (!isWhitelisted[investor]) revert InvestorNotWhitelisted();
        if (units == 0) revert InvalidAmount();

        _registerHolder(investor);
        balanceOf[investor] += units;
        totalSupply += units;

        emit BondIssued(investor, units);
        emit Transfer(address(0), investor, units);
    }

    /**
     * @notice Transfers units only between approved investors.
     * @dev The holder register is intentionally simple for demonstration.
     */
    function transfer(address to, uint256 units) external returns (bool) {
        if (!isWhitelisted[msg.sender] || !isWhitelisted[to]) {
            revert InvestorNotWhitelisted();
        }
        if (to == address(0) || units == 0) revert InvalidAmount();
        if (balanceOf[msg.sender] < units) revert InsufficientBalance();

        _registerHolder(to);
        balanceOf[msg.sender] -= units;
        balanceOf[to] += units;

        emit Transfer(msg.sender, to, units);
        return true;
    }

    function couponPerUnit() public view returns (uint256) {
        return (faceValue * annualCouponRateBps * couponInterval) / (BASIS_POINTS * YEAR);
    }

    /**
     * @notice Pays one scheduled coupon to holders recorded at execution time.
     * @dev A production design would use snapshots and claim-based distribution.
     */
    function payCoupon() external payable onlyIssuer {
        if (block.timestamp < nextCouponDate || block.timestamp >= maturityDate) {
            revert CouponNotDue();
        }

        uint256 requiredPayment = couponPerUnit() * totalSupply;
        if (msg.value != requiredPayment) {
            revert IncorrectPayment(requiredPayment, msg.value);
        }

        uint256 couponNumber = ++couponsPaid;
        nextCouponDate += couponInterval;

        for (uint256 i = 0; i < holders.length; i++) {
            address holder = holders[i];
            uint256 amount = couponPerUnit() * balanceOf[holder];
            if (amount > 0) _sendCash(holder, amount);
        }

        emit CouponPaid(couponNumber, block.timestamp, requiredPayment);
    }

    function fundRedemption() external payable onlyIssuer {
        if (block.timestamp < maturityDate) revert BondNotMatured();
        if (redemptionFunded) revert RedemptionAlreadyFunded();

        uint256 requiredPayment = faceValue * totalSupply;
        if (msg.value != requiredPayment) {
            revert IncorrectPayment(requiredPayment, msg.value);
        }

        redemptionFunded = true;
        emit RedemptionFunded(requiredPayment);
    }

    function redeem() external {
        if (!redemptionFunded) revert RedemptionNotFunded();

        uint256 units = balanceOf[msg.sender];
        if (units == 0) revert InvalidAmount();

        uint256 principalAmount = units * faceValue;
        balanceOf[msg.sender] = 0;
        totalSupply -= units;
        _sendCash(msg.sender, principalAmount);

        emit Redeemed(msg.sender, units, principalAmount);
        emit Transfer(msg.sender, address(0), units);
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    function _registerHolder(address investor) private {
        if (!hasBeenHolder[investor]) {
            hasBeenHolder[investor] = true;
            holders.push(investor);
        }
    }

    function _sendCash(address recipient, uint256 amount) private {
        (bool success, ) = payable(recipient).call{value: amount}("");
        if (!success) revert CashTransferFailed();
    }
}
