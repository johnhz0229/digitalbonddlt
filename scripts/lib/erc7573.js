// Off-chain helpers for the ERC-7573-style cross-chain DvP:
// key documents, encryption to the oracle, and a stateless decryption oracle.
const crypto = require("crypto");
const { ethers } = require("ethers");

const OAEP = { padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" };

function createOracleKeyPair() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
}

/**
 * A key is a small document naming the contract and transfer it belongs to and
 * the payment outcome it stands for. For DvP the success key is the buyer's
 * claim key and the failure key is the seller's reclaim key. The random nonce
 * makes it unguessable; its keccak256 hash is what the asset chain stores.
 */
function createKeyDocument({ contract, id, outcome }) {
  if (!["success", "failure"].includes(outcome)) throw new Error("outcome must be success or failure");
  const document = {
    contract: ethers.getAddress(contract),
    id: String(id),
    outcome,
    nonce: crypto.randomBytes(16).toString("hex"),
  };
  return Buffer.from(JSON.stringify(document), "utf8");
}

function hashKey(key) {
  return ethers.keccak256(key);
}

function encryptForOracle(oraclePublicKey, key) {
  return crypto.publicEncrypt({ key: oraclePublicKey, ...OAEP }, key);
}

/**
 * Generates one key (by the counterparty) and returns what may be shared:
 * the hash for the asset chain and the ciphertext for the payment chain.
 * Only the generating party ever sees `plaintext`.
 */
function prepareKey({ oraclePublicKey, contract, id, outcome }) {
  const plaintext = createKeyDocument({ contract, id, outcome });
  return {
    plaintext,
    hash: hashKey(plaintext),
    encrypted: encryptForOracle(oraclePublicKey, plaintext),
  };
}

/**
 * Stateless decryption oracle. It keeps no record of trades: everything it needs
 * arrives with the request. It refuses keys that belong to another contract or
 * transfer, or a key whose outcome does not match the payment outcome.
 */
class DecryptionOracle {
  constructor({ privateKey, publicKey, contracts }) {
    this.privateKey = privateKey;
    this.publicKey = publicKey;
    this.contracts = new Set(contracts.map((address) => ethers.getAddress(address)));
  }

  /**
   * Generates a success and a failure key for one transfer, as in the March 2026
   * pilot. Only hashes and ciphertexts leave this function; the plaintexts are
   * discarded, so no participant (and not the oracle's storage) holds a preimage.
   */
  generateOutcomeKeys({ contract, id }) {
    if (!this.publicKey) throw new Error("Oracle needs its public key to generate keys");
    const make = (outcome) => {
      const { hash, encrypted } = prepareKey({ oraclePublicKey: this.publicKey, contract, id, outcome });
      return { hash, encrypted };
    };
    return { success: make("success"), failure: make("failure") };
  }

  decrypt({ id, success, encryptedKey }) {
    let plaintext;
    try {
      plaintext = crypto.privateDecrypt({ key: this.privateKey, ...OAEP }, Buffer.from(ethers.getBytes(encryptedKey)));
    } catch {
      throw new Error("Oracle refused: key cannot be decrypted");
    }
    let document;
    try {
      document = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("Oracle refused: key is not a valid key document");
    }
    if (!this.contracts.has(document.contract)) throw new Error("Oracle refused: key is for another contract");
    if (document.id !== String(id)) throw new Error("Oracle refused: key is for another transfer");
    const expected = success ? "success" : "failure";
    if (document.outcome !== expected) throw new Error(`Oracle refused: payment ${success ? "succeeded" : "failed"} but this is the ${document.outcome} key`);
    return plaintext;
  }

  /** Reads the key request from a payment-chain receipt and calls releaseKey. */
  async handleReceipt(paymentContract, receipt) {
    const released = [];
    for (const log of receipt.logs) {
      let parsed;
      try {
        parsed = paymentContract.interface.parseLog(log);
      } catch {
        continue;
      }
      if (!parsed || parsed.name !== "TransferKeyRequested") continue;
      const { id, success, encryptedKey } = parsed.args;
      const key = this.decrypt({ id, success, encryptedKey });
      const tx = await paymentContract.releaseKey(id, key);
      await tx.wait();
      released.push({ id, success, key, txHash: tx.hash });
    }
    return released;
  }
}

module.exports = { createOracleKeyPair, createKeyDocument, hashKey, encryptForOracle, prepareKey, DecryptionOracle };
