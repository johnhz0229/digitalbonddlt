// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPaymentToken {
    function balanceOf(address holder) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title PaymentDecryptionContract
 * @notice Payment-chain side of a cross-chain DvP, simplified from ERC-7573.
 * @dev Holds two encrypted keys per payment. The outcome of the payment decides
 *      which one the decryption oracle is asked to decrypt:
 *      - payment succeeded  -> keyEncryptedSuccess (buyer claims the bond)
 *      - payment failed or cancelled -> keyEncryptedFailure (seller reclaims)
 *      Only one key is ever requested per payment. The oracle is stateless: it
 *      only sees an encrypted key and returns its plaintext via releaseKey.
 */
contract PaymentDecryptionContract {
    enum Status { None, Incepted, Confirmed, Paid, Failed, Cancelled }

    struct Payment {
        address buyer;
        address seller;
        uint256 amount;
        bytes keyEncryptedSuccess;
        bytes keyEncryptedFailure;
        Status status;
        bool keyReleased;
    }

    IPaymentToken public immutable cash;
    address public immutable decryptionOracle;
    mapping(uint256 => Payment) public payments;

    event TransferIncepted(uint256 indexed id, uint256 amount, address from, address to, bytes keyEncryptedSuccess, bytes keyEncryptedFailure);
    event TransferConfirmed(uint256 indexed id);
    event PaymentExecuted(uint256 indexed id, uint256 amount);
    event PaymentFailed(uint256 indexed id, string reason);
    event TransferCancelled(uint256 indexed id);
    event TransferKeyRequested(uint256 indexed id, bool success, bytes encryptedKey);
    event TransferKeyReleased(uint256 indexed id, bool success, bytes key);

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

    /// @notice Buyer (payer) starts with both encrypted keys.
    function inceptTransfer(
        uint256 id,
        uint256 amount,
        address seller,
        bytes calldata keyEncryptedSuccess,
        bytes calldata keyEncryptedFailure
    ) external {
        if (payments[id].status != Status.None) revert IdInUse();
        if (amount == 0 || seller == address(0) || seller == msg.sender) revert InvalidTerms();
        if (keyEncryptedSuccess.length == 0 || keyEncryptedFailure.length == 0) revert InvalidTerms();
        payments[id] = Payment(msg.sender, seller, amount, keyEncryptedSuccess, keyEncryptedFailure, Status.Incepted, false);
        emit TransferIncepted(id, amount, msg.sender, seller, keyEncryptedSuccess, keyEncryptedFailure);
    }

    /**
     * @notice Seller (payee) repeats every term, including both encrypted keys.
     * @dev This is the seller's protection: it proves the failure key stored here
     *      is the one that unlocks the seller's bonds on the asset chain.
     */
    function confirmTransfer(
        uint256 id,
        uint256 amount,
        address buyer,
        bytes calldata keyEncryptedSuccess,
        bytes calldata keyEncryptedFailure
    ) external {
        Payment storage p = payments[id];
        if (p.status != Status.Incepted) revert WrongStatus(p.status);
        if (msg.sender != p.seller) revert NotCounterparty();
        if (
            amount != p.amount ||
            buyer != p.buyer ||
            keccak256(keyEncryptedSuccess) != keccak256(p.keyEncryptedSuccess) ||
            keccak256(keyEncryptedFailure) != keccak256(p.keyEncryptedFailure)
        ) revert TermsMismatch();
        p.status = Status.Confirmed;
        emit TransferConfirmed(id);
    }

    /**
     * @notice Attempts the payment and requests exactly one key.
     * @dev Like DvPSettlement, a failed payment is recorded rather than reverted,
     *      because the failure itself must trigger the seller's key.
     */
    function transferAndDecrypt(uint256 id) external {
        Payment storage p = payments[id];
        if (p.status != Status.Confirmed) revert WrongStatus(p.status);
        if (msg.sender != p.buyer && msg.sender != p.seller) revert NotCounterparty();

        if (cash.balanceOf(p.buyer) < p.amount) {
            _fail(id, p, "Buyer has insufficient cash");
            return;
        }
        if (cash.allowance(p.buyer, address(this)) < p.amount) {
            _fail(id, p, "Buyer has not authorised the cash");
            return;
        }

        p.status = Status.Paid;
        cash.transferFrom(p.buyer, p.seller, p.amount);
        emit PaymentExecuted(id, p.amount);
        emit TransferKeyRequested(id, true, p.keyEncryptedSuccess);
    }

    /// @notice Either party may cancel before payment; the seller then gets the failure key.
    function cancelAndDecrypt(uint256 id) external {
        Payment storage p = payments[id];
        if (p.status != Status.Incepted && p.status != Status.Confirmed) revert WrongStatus(p.status);
        if (msg.sender != p.buyer && msg.sender != p.seller) revert NotCounterparty();
        p.status = Status.Cancelled;
        emit TransferCancelled(id);
        emit TransferKeyRequested(id, false, p.keyEncryptedFailure);
    }

    /// @notice Called by the decryption oracle with the plaintext of the requested key.
    function releaseKey(uint256 id, bytes calldata key) external {
        if (msg.sender != decryptionOracle) revert OnlyOracle();
        Payment storage p = payments[id];
        if (p.status != Status.Paid && p.status != Status.Failed && p.status != Status.Cancelled) {
            revert WrongStatus(p.status);
        }
        if (p.keyReleased) revert KeyAlreadyReleased();
        p.keyReleased = true;
        emit TransferKeyReleased(id, p.status == Status.Paid, key);
    }

    function _fail(uint256 id, Payment storage p, string memory reason) private {
        p.status = Status.Failed;
        emit PaymentFailed(id, reason);
        emit TransferKeyRequested(id, false, p.keyEncryptedFailure);
    }
}
