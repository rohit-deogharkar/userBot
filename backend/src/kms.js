// A viem account whose private key lives in AWS KMS.
//
// The key is created inside KMS and can never be exported, so nobody sees it: not developers,
// not the server. The server only asks KMS to sign. Create the key with key spec ECC_SECG_P256K1
// and usage SIGN_VERIFY, and give the server's IAM role only kms:Sign and kms:GetPublicKey on it.
import { GetPublicKeyCommand, KMSClient, SignCommand } from "@aws-sdk/client-kms";
import {
  bytesToHex,
  hashMessage,
  hashTypedData,
  hexToBytes,
  isAddressEqual,
  keccak256,
  recoverAddress,
  serializeSignature,
  serializeTransaction,
  toHex,
} from "viem";
import { publicKeyToAddress, toAccount } from "viem/accounts";

// Order of the secp256k1 curve. Ethereum only accepts signatures with s in the lower half.
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/** KMS returns a DER SubjectPublicKeyInfo. Its last 65 bytes are the uncompressed key, starting with 0x04. */
export function publicKeyFromSpki(der) {
  const bytes = Uint8Array.from(der);
  const key = bytes.slice(bytes.length - 65);
  if (key[0] !== 0x04) throw new Error("Unexpected KMS public key format.");
  return bytesToHex(key);
}

/** Parses a DER ECDSA signature: SEQUENCE { INTEGER r, INTEGER s }. */
export function parseDerSignature(der) {
  const b = Uint8Array.from(der);
  let i = 0;
  if (b[i++] !== 0x30) throw new Error("KMS signature is not a DER sequence.");
  let length = b[i++];
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    length = 0;
    for (let k = 0; k < lengthBytes; k++) length = (length << 8) | b[i++];
  }
  const readInteger = () => {
    if (b[i++] !== 0x02) throw new Error("KMS signature is missing an integer.");
    const size = b[i++];
    const value = b.slice(i, i + size);
    i += size;
    return BigInt(bytesToHex(value));
  };
  return { r: readInteger(), s: readInteger() };
}

/**
 * Builds a viem account backed by a KMS key.
 * `client` can be replaced in tests with any object that has the same `send` method.
 */
export async function createKmsAccount({ keyId, client = new KMSClient({}) }) {
  const { PublicKey } = await client.send(new GetPublicKeyCommand({ KeyId: keyId }));
  const address = publicKeyToAddress(publicKeyFromSpki(PublicKey));

  async function signHash(hash) {
    const { Signature } = await client.send(
      new SignCommand({ KeyId: keyId, Message: hexToBytes(hash), MessageType: "DIGEST", SigningAlgorithm: "ECDSA_SHA_256" }),
    );
    let { r, s } = parseDerSignature(Signature);
    if (s > SECP256K1_N / 2n) s = SECP256K1_N - s;
    const signature = { r: toHex(r, { size: 32 }), s: toHex(s, { size: 32 }) };
    // KMS doesn't say which of the two possible public keys matches, so try both.
    for (const yParity of [0, 1]) {
      // v is only used by legacy transactions; newer types use yParity.
      const candidate = { ...signature, yParity, v: 27n + BigInt(yParity) };
      if (isAddressEqual(await recoverAddress({ hash, signature: serializeSignature(candidate) }), address)) return candidate;
    }
    throw new Error("Could not match the KMS signature to the key's address.");
  }

  return toAccount({
    address,
    async signMessage({ message }) {
      return serializeSignature(await signHash(hashMessage(message)));
    },
    async signTypedData(typedData) {
      return serializeSignature(await signHash(hashTypedData(typedData)));
    },
    async signTransaction(transaction, { serializer = serializeTransaction } = {}) {
      const signature = await signHash(keccak256(serializer(transaction)));
      return serializer(transaction, signature);
    },
  });
}
