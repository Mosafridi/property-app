// Member 1 - Authentication: password hashing
// I never store an agent's real password. I store a salted scrypt hash instead.
// Why scrypt and not SHA-256? (Week 3, "Password Hashing: Slow is Better")
// SHA-256 is designed to be FAST, so a GPU can try billions of guesses per second.
// scrypt is deliberately SLOW and memory-hard, so brute-forcing a stolen hash is
// expensive. It's one of the three algorithms the lecture recommends (Argon2, bcrypt, scrypt)
// and it's built into Node's crypto module, so no extra packages are needed.

const crypto = require('crypto');

// N = CPU/memory cost, r = block size, p = parallelism. These are Node's
// recommended defaults: about 16MB of memory per hash.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64; // 64-byte (512-bit) output

// Turns a plain password into "scrypt$<salt>$<hash>" for the database.
// A NEW random 16-byte salt is made for every password, so two agents with the
// same password still get completely different hashes. This defeats
// precomputed "rainbow table" attacks.
function hashPassword(password) {
    const salt = crypto.randomBytes(16); // cryptographically secure randomness (Week 4, PRNGs)
    const hash = crypto.scryptSync(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Checks a login attempt: re-hash what was typed using the SAME salt, then
// compare with the stored hash. Hashing is one-way (Week 3), so I can never
// "decrypt" the stored hash - I can only hash the guess and compare.
function verifyPassword(password, stored) {
    if (!stored) return false;
    const [scheme, saltHex, hashHex] = stored.split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_PARAMS);

    // timingSafeEqual takes the same time whether the first byte or the last byte
    // is wrong, so an attacker can't learn anything by timing the response.
    return crypto.timingSafeEqual(actual, expected);
}

// Basic password rule for new agents: at least 8 characters, with a letter and a number.
function isStrongEnough(password) {
    return typeof password === 'string' && password.length >= 8 &&
        /[A-Za-z]/.test(password) && /\d/.test(password);
}

module.exports = { hashPassword, verifyPassword, isStrongEnough };
