// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title BondToken
 * @notice Asset token of one Smart Bond transaction, deployed by the crypto
 *         securities registrar.
 * @dev Units have no decimals; one unit is one denomination of the bond.
 *      Only the registrar mints and keeps the eligibility register. Only the
 *      Smart Bond Contract (the servicer) moves or burns units, using the
 *      holders' allowances. Secondary trading is out of scope for this lab.
 */
contract BondToken {
    string public name;
    string public symbol;
    string public isin;
    uint8 public constant decimals = 0;

    address public immutable registrar;
    address public immutable servicer;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isEligible;

    event Transfer(address indexed from, address indexed to, uint256 units);
    event Approval(address indexed owner, address indexed spender, uint256 units);
    event EligibilitySet(address indexed holder, bool eligible);

    error OnlyRegistrar();
    error OnlyServicer();
    error NotEligible();
    error InsufficientBalance();
    error InsufficientAllowance();
    error TransfersRestricted();

    constructor(string memory name_, string memory symbol_, string memory isin_, address servicer_) {
        name = name_;
        symbol = symbol_;
        isin = isin_;
        registrar = msg.sender;
        servicer = servicer_;
    }

    function setEligible(address holder, bool eligible) external {
        if (msg.sender != registrar) revert OnlyRegistrar();
        isEligible[holder] = eligible;
        emit EligibilitySet(holder, eligible);
    }

    function mint(address to, uint256 units) external {
        if (msg.sender != registrar) revert OnlyRegistrar();
        if (!isEligible[to]) revert NotEligible();
        totalSupply += units;
        balanceOf[to] += units;
        emit Transfer(address(0), to, units);
    }

    function approve(address spender, uint256 units) external returns (bool) {
        allowance[msg.sender][spender] = units;
        emit Approval(msg.sender, spender, units);
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert TransfersRestricted();
    }

    /// @notice Only the servicer settles transfers, between eligible holders or into itself for burning.
    function transferFrom(address from, address to, uint256 units) external returns (bool) {
        if (msg.sender != servicer) revert OnlyServicer();
        if (to != servicer && !isEligible[to]) revert NotEligible();
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < units) revert InsufficientAllowance();
        if (balanceOf[from] < units) revert InsufficientBalance();
        allowance[from][msg.sender] = allowed - units;
        balanceOf[from] -= units;
        balanceOf[to] += units;
        emit Transfer(from, to, units);
        return true;
    }

    /// @notice Redemption: the servicer burns units it has taken back from the holder.
    function burn(uint256 units) external {
        if (msg.sender != servicer) revert OnlyServicer();
        if (balanceOf[servicer] < units) revert InsufficientBalance();
        balanceOf[servicer] -= units;
        totalSupply -= units;
        emit Transfer(servicer, address(0), units);
    }
}
