use wasm_bindgen::prelude::*;

// Minimal runtime, no GC required by Rust/WASM natively.
// These mock the Zeta compiler's crypto core exports.

#[wasm_bindgen]
pub fn ecdsa_sign(_privkey: &[u8], _hash: &[u8]) -> Vec<u8> {
    // ECDSA sign(privkey, hash) -> signature
    // Mocking 64-byte signature for WASM compilation target
    vec![0u8; 64]
}

#[wasm_bindgen]
pub fn sha256_hash(_data: &[u8]) -> Vec<u8> {
    // SHA-256 hash(data) -> digest
    // Mocking 32-byte digest
    vec![0u8; 32]
}

#[wasm_bindgen]
pub fn build_transaction_template(_inputs: &[u8], _outputs: &[u8]) -> Vec<u8> {
    // Transaction template builder
    vec![0u8; 100] // Mocking a basic TX payload
}

#[wasm_bindgen]
pub fn derive_key(_seed: &[u8], _path: &str) -> Vec<u8> {
    // Key derivation (BRC-42 compatible)
    vec![0u8; 32] // Mocking 32-byte derived key
}
