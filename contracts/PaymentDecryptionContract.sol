// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPaymentToken {
    function balanceOf(address holder) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title PaymentDecryptionContract
 * @notice Payment-chain side of a cross-chain transfer, simplified from ERC-7573.
 * @dev Holds two encrypted keys per payment. The outcome of the payment decides
 *      which one the decryption oracle is asked to decrypt:
 *      - payment succeeded            -> keyEncryptedSuccess
 *      - payment failed or cancelled  -> keyEncryptedFailure
 *      Only one key is ever requested per payment.
 *
 *      Payments are identified by (id, payee), so nobody can occupy someone
 *      else's transfer id. Every key request carries the payee and amount; the
 *      oracle releases a key only if they match the terms written inside the
 *      key document. Without that binding, a buyer could "pay" one cent to his
 *      own second address and obtain the success key.
 */
contract PaymentDecryptionContract {
    enum Status { None, Incepted, Confirmed, Paid, Failed, Cancelled }

    struct Payment {
        uint256 id;
        address payer;
        address payee;
        uint256 amount;
        bytes keyEncryptedSuccess;
        bytes keyEncryptedFailure;
        Status status;
        bool keyReleased;
    }

    IPaymentToken public immutable cash;
    address public immutable decryptionOracle;
    mapping(bytes32 => Payment) public payments;

    event TransferIncepted(uint256 indexed id, address indexed payee, address payer, uint256 amount, bytes keyEncryptedSuccess, bytes keyEncryptedFailure);
    event TransferConfirmed(uint256 indexed id, address indexed payee);
    event TransferRejected(uint256 indexed id, address indexed payee);
    event PaymentExecuted(uint256 indexed id, address indexed payee, uint256 amount);
    event PaymentFailed(uint256 indexed id, address indexed payee, string reason);
    event TransferCancelled(uint256 indexed id, address indexed payee);
    event TransferKeyRequested(uint256 indexed id, address indexed payee, uint256 amount, bool success, bytes encryptedKey);
    event TransferKeyReleased(uint256 indexed id, address indexed payee, bool success, bytes key);

    error InvalidTerms();
    error IdInUse();
    error NotCounterparty();
    error OnlyOracle();
    error WrongStatus(Status current);
    error TermsMismatch();
    error KeyAlreadyReleased();

    constructor(address cash_, address decryptionOracle_) {
        cash = IPaymentToken(cash_);
        decryptionOracle = decryptionOracle_;
    }

    function paymentKey(uint256 id, address payee) public pure returns (bytes32) {
        return keccak256(abi.encode(id, payee));
    }

    /// @notice The payer starts with the terms and both encrypted keys.
    function inceptTransfer(
        uint256 id,
        uint256 amount,
        address payee,
        bytes calldata keyEncryptedSuccess,
        bytes calldata keyEncryptedFailure
    ) external {
        Payment storage p = payments[paymentKey(id, payee)];
        if (p.status != Status.None) revert IdInUse();
        if (amount == 0 || payee == address(0) || payee == msg.sender) revert InvalidTerms();
        if (keyEncryptedSuccess.length == 0 || keyEncryptedFailure.length == 0) revert InvalidTerms();
        payments[paymentKey(id, payee)] = Payment(id, msg.sender, payee, amount, keyEncryptedSuccess, keyEncryptedFailure, Status.Incepted, false);
        emit TransferIncepted(id, payee, msg.sender, amount, keyEncryptedSuccess, keyEncryptedFailure);
    }

    /**
     * @notice The payee repeats every term, including both encrypted keys, and so
     *         accepts this payer and this payment as the one for transfer `id`.
     */
    function confirmTransfer(
        uint256 id,
        uint256 amount,
        address payer,
        bytes calldata keyEncryptedSuccess,
        bytes calldata keyEncryptedFailure
    ) external {
        Payment storage p = payments[paymentKey(id, msg.sender)];
        if (p.status != Status.Incepted) revert WrongStatus(p.status);
        if (
            amount != p.amount ||
            payer != p.payer ||
            keccak256(keyEncryptedSuccess) != keccak256(p.keyEncryptedSuccess) ||
            keccak256(keyEncryptedFailure) != keccak256(p.keyEncryptedFailure)
        ) revert TermsMismatch();
        p.status = Status.Confirmed;
        emit TransferConfirmed(id, msg.sender);
    }

    /// @notice The payee discards a payment it does not recognise, freeing the id.
    function rejectTransfer(uint256 id) external {
        bytes32 key = paymentKey(id, msg.sender);
        if (payments[key].status != Status.Incepted) revert WrongStatus(payments[key].status);
        delete payments[key];
        emit TransferRejected(id, msg.sender);
    }

    /**
     * @notice Attempts the confirmed payment and requests exactly one key.
     * @dev A failed payment is recorded rather than reverted, because the failure
     *      itself must trigger the failure key.
     */
    function transferAndDecrypt(uint256 id, address payee) external {
        Payment storage p = payments[paymentKey(id, payee)];
        if (p.status != Status.Confirmed) revert WrongStatus(p.status);
        if (msg.sender != p.payer && msg.sender != p.payee) revert NotCounterparty();

        if (cash.balanceOf(p.payer) < p.amount) {
            _fail(p, "Payer has insufficient cash");
            return;
        }
        if (cash.allowance(p.payer, address(this)) < p.amount) {
            _fail(p, "Payer has not authorised the cash");
            return;
        }

        p.status = Status.Paid;
        cash.transferFrom(p.payer, p.payee, p.amount);
        emit PaymentExecuted(id, payee, p.amount);
        emit TransferKeyRequested(id, payee, p.amount, true, p.keyEncryptedSuccess);
    }

    /**
     * @notice Cancels before payment and requests the failure key. The payee may
     *         cancel at any time; the payer only after the payee confirmed, so a
     *         stranger cannot abort someone else's transfer.
     */
    function cancelAndDecrypt(uint256 id, address payee) external {
        Payment storage p = payments[paymentKey(id, payee)];
        bool byPayee = msg.sender == p.payee && (p.status == Status.Incepted || p.status == Status.Confirmed);
        bool byPayer = msg.sender == p.payer && p.status == Status.Confirmed;
        if (!byPayee && !byPayer) {
            if (p.status != Status.Incepted && p.status != Status.Confirmed) revert WrongStatus(p.status);
            revert NotCounterparty();
        }
        p.status = Status.Cancelled;
        emit TransferCancelled(id, payee);
        emit TransferKeyRequested(id, payee, p.amount, false, p.keyEncryptedFailure);
    }

    /// @notice Called by the decryption oracle with the plaintext of the requested key.
    function releaseKey(uint256 id, address payee, bytes calldata key) external {
        if (msg.sender != decryptionOracle) revert OnlyOracle();
        Payment storage p = payments[paymentKey(id, payee)];
        if (p.status != Status.Paid && p.status != Status.Failed && p.status != Status.Cancelled) {
            revert WrongStatus(p.status);
        }
        if (p.keyReleased) revert KeyAlreadyReleased();
        p.keyReleased = true;
        emit TransferKeyReleased(id, payee, p.status == Status.Paid, key);
    }

    function _fail(Payment storage p, string memory reason) private {
        p.status = Status.Failed;
        emit PaymentFailed(p.id, p.payee, reason);
        emit TransferKeyRequested(p.id, p.payee, p.amount, false, p.keyEncryptedFailure);
    }
}
