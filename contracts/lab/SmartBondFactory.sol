// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./SmartBondContract.sol";

/**
 * @title SmartBondFactory
 * @notice The issuer's on-chain programme: the issuer publishes indicative
 *         funding levels per tenor; an eligible investor picks one and requests a
 *         trade; the factory deploys a dedicated Smart Bond Contract for it.
 * @dev The funding level is expressed directly as
 *      the indicative fixed coupon for that tenor.
 */
contract SmartBondFactory {
    struct FundingLevel {
        uint256 couponBps;
        uint256 maxUnits;
        bool active;
    }

    address public immutable issuer;
    address public immutable registrar;
    address public immutable isinAgent;
    address public immutable decryptionOracle;
    uint256 public immutable faceValue; // per unit, in cash token units (EUR cents)
    string public programme;

    mapping(uint256 => FundingLevel) public fundingLevels; // tenor in years => level
    uint256[] public tenors;
    mapping(address => bool) public isEligibleInvestor;
    address[] public instances;

    event FundingLevelPublished(uint256 indexed tenorYears, uint256 couponBps, uint256 maxUnits);
    event FundingLevelWithdrawn(uint256 indexed tenorYears);
    event InvestorEligibilitySet(address indexed investor, bool eligible);
    event TradeRequested(address indexed instance, address indexed investor, uint256 tenorYears, uint256 units, uint256 indicativeCouponBps);

    error OnlyIssuer();
    error NotEligible();
    error NoFundingLevel();
    error InvalidUnits();

    constructor(
        string memory programme_,
        address registrar_,
        address isinAgent_,
        address decryptionOracle_,
        uint256 faceValue_
    ) {
        issuer = msg.sender;
        programme = programme_;
        registrar = registrar_;
        isinAgent = isinAgent_;
        decryptionOracle = decryptionOracle_;
        faceValue = faceValue_;
    }

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert OnlyIssuer();
        _;
    }

    function publishFundingLevel(uint256 tenorYears, uint256 couponBps, uint256 maxUnits) external onlyIssuer {
        if (tenorYears == 0 || tenorYears > 30 || maxUnits == 0) revert InvalidUnits();
        if (fundingLevels[tenorYears].maxUnits == 0) tenors.push(tenorYears);
        fundingLevels[tenorYears] = FundingLevel(couponBps, maxUnits, true);
        emit FundingLevelPublished(tenorYears, couponBps, maxUnits);
    }

    function withdrawFundingLevel(uint256 tenorYears) external onlyIssuer {
        fundingLevels[tenorYears].active = false;
        emit FundingLevelWithdrawn(tenorYears);
    }

    function setEligibleInvestor(address investor, bool eligible) external onlyIssuer {
        isEligibleInvestor[investor] = eligible;
        emit InvestorEligibilitySet(investor, eligible);
    }

    /// @notice An eligible investor requests a trade at the currently published level.
    function requestTrade(uint256 tenorYears, uint256 units) external returns (address instance) {
        if (!isEligibleInvestor[msg.sender]) revert NotEligible();
        FundingLevel memory level = fundingLevels[tenorYears];
        if (!level.active) revert NoFundingLevel();
        if (units == 0 || units > level.maxUnits) revert InvalidUnits();

        instance = address(new SmartBondContract(
            issuer, msg.sender, registrar, isinAgent, decryptionOracle, faceValue, units, tenorYears, level.couponBps
        ));
        instances.push(instance);
        emit TradeRequested(instance, msg.sender, tenorYears, units, level.couponBps);
    }

    function instanceCount() external view returns (uint256) {
        return instances.length;
    }

    function tenorCount() external view returns (uint256) {
        return tenors.length;
    }
}
