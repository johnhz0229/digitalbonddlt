// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILockedCash {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
}

/**
 * @title CashLock
 * @notice Payment-ledger model of a hash-locked cash account: a payer locks cash
 *         irrevocably against two hashes.
 *         Presenting the success preimage pays the payee; presenting the failure
 *         preimage returns the cash to the payer. Nothing else can move it.
 * @dev A real payment system would settle in central bank or commercial bank money
 *      and need not run smart contracts; this only models the behaviour.
 */
contract CashLock {
    enum Status { None, Locked, Released, Returned }

    struct Lock {
        address payer;
        address payee;
        uint256 amount;
        bytes32 hashSuccess;
        bytes32 hashFailure;
        Status status;
    }

    ILockedCash public immutable cash;
    mapping(bytes32 => Lock) public locks;

    event CashLocked(bytes32 indexed lockId, address indexed payer, address indexed payee, uint256 amount, bytes32 hashSuccess, bytes32 hashFailure);
    event CashReleased(bytes32 indexed lockId, address payee, uint256 amount);
    event CashReturned(bytes32 indexed lockId, address payer, uint256 amount);

    error LockIdInUse();
    error InvalidLock();
    error NotLocked();
    error InvalidKey();

    constructor(address cash_) {
        cash = ILockedCash(cash_);
    }

    function lock(bytes32 lockId, address payee, uint256 amount, bytes32 hashSuccess, bytes32 hashFailure) external {
        if (locks[lockId].status != Status.None) revert LockIdInUse();
        if (payee == address(0) || amount == 0 || hashSuccess == hashFailure) revert InvalidLock();
        locks[lockId] = Lock(msg.sender, payee, amount, hashSuccess, hashFailure, Status.Locked);
        cash.transferFrom(msg.sender, address(this), amount);
        emit CashLocked(lockId, msg.sender, payee, amount, hashSuccess, hashFailure);
    }

    /// @notice Anyone may present a released key; the key decides where the cash goes.
    function releaseWithKey(bytes32 lockId, bytes calldata key) external {
        Lock storage l = locks[lockId];
        if (l.status != Status.Locked) revert NotLocked();
        bytes32 hashed = keccak256(key);
        if (hashed == l.hashSuccess) {
            l.status = Status.Released;
            cash.transfer(l.payee, l.amount);
            emit CashReleased(lockId, l.payee, l.amount);
        } else if (hashed == l.hashFailure) {
            l.status = Status.Returned;
            cash.transfer(l.payer, l.amount);
            emit CashReturned(lockId, l.payer, l.amount);
        } else {
            revert InvalidKey();
        }
    }
}
