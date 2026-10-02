// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title TokenisedEuro
 * @notice Minimal ERC-20 cash token for the settlement leg of the demo.
 * @dev Stands in for a tokenised deposit or wholesale CBDC. Amounts use two
 *      decimals, so 100 = EUR 1.00. Only the cash issuer can mint.
 */
contract TokenisedEuro {
    string public constant name = "Tokenised Euro (demo)";
    string public constant symbol = "tEUR";
    uint8 public constant decimals = 2;

    address public immutable cashIssuer;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error OnlyCashIssuer();
    error InvalidAmount();
    error InsufficientBalance();
    error InsufficientAllowance();

    constructor() {
        cashIssuer = msg.sender;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != cashIssuer) revert OnlyCashIssuer();
        if (to == address(0) || amount == 0) revert InvalidAmount();
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    /// @notice Lets `spender` (e.g. the DvP contract) move up to `amount` later.
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) private {
        if (to == address(0) || amount == 0) revert InvalidAmount();
        if (balanceOf[from] < amount) revert InsufficientBalance();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
