// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISecurityToken {
    function isWhitelisted(address investor) external view returns (bool);
    function balanceOf(address holder) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 units) external returns (bool);
}

interface ICashToken {
    function balanceOf(address holder) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title DvPSettlement
 * @notice Delivery-versus-payment for one bond and one cash token on the same ledger.
 * @dev Lifecycle: Proposed -> Confirmed -> Settled | Failed, or Proposed -> Cancelled.
 *      A failed settlement is recorded with a reason instead of reverting, so
 *      operations can see every attempt (acceptance criteria AC1-AC5 in
 *      docs/learn/01-dvp.md). Neither leg moves unless both can.
 */
contract DvPSettlement {
    enum Status { None, Proposed, Confirmed, Settled, Failed, Cancelled }

    enum FailureReason {
        None,
        SellerNotWhitelisted,
        BuyerNotWhitelisted,
        InsufficientBonds,
        InsufficientBondAllowance,
        InsufficientCash,
        InsufficientCashAllowance
    }

    struct Trade {
        address seller;
        address buyer;
        uint256 units;
        uint256 cashAmount;
        Status status;
        FailureReason failureReason;
    }

    ISecurityToken public immutable bond;
    ICashToken public immutable cash;

    uint256 public tradeCount;
    mapping(uint256 => Trade) public trades;

    event TradeProposed(uint256 indexed tradeId, address indexed seller, address indexed buyer, uint256 units, uint256 cashAmount);
    event TradeConfirmed(uint256 indexed tradeId);
    event TradeCancelled(uint256 indexed tradeId);
    event TradeSettled(uint256 indexed tradeId, uint256 units, uint256 cashAmount);
    event SettlementFailed(uint256 indexed tradeId, FailureReason reason);

    error InvalidTerms();
    error UnknownTrade();
    error NotCounterparty();
    error WrongStatus(Status current);
    error TermsMismatch();

    constructor(address bond_, address cash_) {
        bond = ISecurityToken(bond_);
        cash = ICashToken(cash_);
    }

    /// @notice The seller proposes the economic terms of the trade.
    function proposeTrade(address buyer, uint256 units, uint256 cashAmount) external returns (uint256 tradeId) {
        if (buyer == address(0) || buyer == msg.sender || units == 0 || cashAmount == 0) {
            revert InvalidTerms();
        }
        tradeId = ++tradeCount;
        trades[tradeId] = Trade(msg.sender, buyer, units, cashAmount, Status.Proposed, FailureReason.None);
        emit TradeProposed(tradeId, msg.sender, buyer, units, cashAmount);
    }

    /// @notice AC5: the buyer repeats the terms, so both sides agree on the same trade.
    function confirmTrade(uint256 tradeId, uint256 units, uint256 cashAmount) external {
        Trade storage trade = _trade(tradeId);
        if (msg.sender != trade.buyer) revert NotCounterparty();
        if (trade.status != Status.Proposed) revert WrongStatus(trade.status);
        if (units != trade.units || cashAmount != trade.cashAmount) revert TermsMismatch();
        trade.status = Status.Confirmed;
        emit TradeConfirmed(tradeId);
    }

    /// @notice Either party may withdraw before the trade is confirmed.
    function cancelTrade(uint256 tradeId) external {
        Trade storage trade = _trade(tradeId);
        if (msg.sender != trade.seller && msg.sender != trade.buyer) revert NotCounterparty();
        if (trade.status != Status.Proposed) revert WrongStatus(trade.status);
        trade.status = Status.Cancelled;
        emit TradeCancelled(tradeId);
    }

    /**
     * @notice Settles both legs atomically, or records why it could not.
     * @return settled True when bonds and cash were exchanged.
     */
    function settle(uint256 tradeId) external returns (bool settled) {
        Trade storage trade = _trade(tradeId);
        if (msg.sender != trade.seller && msg.sender != trade.buyer) revert NotCounterparty();
        if (trade.status != Status.Confirmed) revert WrongStatus(trade.status);

        // AC2-AC4: check every precondition first and record the failure (option B).
        FailureReason reason = checkSettlement(tradeId);
        if (reason != FailureReason.None) {
            trade.status = Status.Failed;
            trade.failureReason = reason;
            emit SettlementFailed(tradeId, reason);
            return false;
        }

        // AC1: both legs in one transaction. If either transfer still reverts,
        // the whole transaction, including the status change, is undone.
        trade.status = Status.Settled;
        cash.transferFrom(trade.buyer, trade.seller, trade.cashAmount);
        bond.transferFrom(trade.seller, trade.buyer, trade.units);
        emit TradeSettled(tradeId, trade.units, trade.cashAmount);
        return true;
    }

    /// @notice Pre-settlement check; also lets operations see problems before settling.
    function checkSettlement(uint256 tradeId) public view returns (FailureReason) {
        Trade storage trade = _trade(tradeId);
        if (!bond.isWhitelisted(trade.seller)) return FailureReason.SellerNotWhitelisted;
        if (!bond.isWhitelisted(trade.buyer)) return FailureReason.BuyerNotWhitelisted;
        if (bond.balanceOf(trade.seller) < trade.units) return FailureReason.InsufficientBonds;
        if (bond.allowance(trade.seller, address(this)) < trade.units) return FailureReason.InsufficientBondAllowance;
        if (cash.balanceOf(trade.buyer) < trade.cashAmount) return FailureReason.InsufficientCash;
        if (cash.allowance(trade.buyer, address(this)) < trade.cashAmount) return FailureReason.InsufficientCashAllowance;
        return FailureReason.None;
    }

    function _trade(uint256 tradeId) private view returns (Trade storage trade) {
        trade = trades[tradeId];
        if (trade.status == Status.None) revert UnknownTrade();
    }
}
