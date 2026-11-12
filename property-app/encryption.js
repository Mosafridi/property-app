// Encryption for viewing requests ("the locked letterbox").
//
// Anyone can post a viewing request for a listing, but what they typed (their name, phone
// number and message) is scrambled with AES-256-GCM before it is saved. Someone who steals
// property.db only gets unreadable text - the key is not in the database and not in the code.
//
//   - The KEY is one secret 256-bit value. It lives outside the code, in an environment
//     variable or in a .env file that git ignores (see setup-encryption.js). The server reads
//     it once when it starts.
//   - Every request gets its own random 96-bit IV, so two identical messages never produce
//     the same scrambled text.
//   - GCM adds a 128-bit authentication tag: the tamper seal. If even one character of the
//     scrambled text, the IV or the tag is changed, decryption fails instead of returning
//     altered text.
//   - The listing id, the agent id and the time received are tied into the seal as
//     "additional authenticated data". They are stored in the clear so the inbox can be
//     filtered, but changing any of them (for example pointing a request at a different
//     agent's inbox) breaks the seal too.
//
// Only Node's built-in crypto module is used here, the same as signing.js.

const crypto = require('crypto');
const fs = require('fs');
const { ENV_PATH } = require('./config');

const KEY_ENV_NAME = "VIEWING_REQUESTS_KEY";
const KEY_BYTES = 32;   // AES-256
const IV_BYTES = 12;    // the IV size GCM is designed for

// Creates the table the scrambled requests are stored in. Safe to call every time the server
// starts. Deleting a listing also deletes its viewing requests (ON DELETE CASCADE), so buyers'
// details are not kept for a listing that no longer exists.
function ensureSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS viewing_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            listing_id INTEGER NOT NULL,
            agent_id INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            iv TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            FOREIGN KEY (listing_id) REFERENCES property_listings(id) ON DELETE CASCADE,
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        );
    `);
}

// A very small .env reader (NAME=value lines), so there is no extra package to install.
function readEnvFile() {
    if (!fs.existsSync(ENV_PATH)) return {};
    const values = {};
    fs.readFileSync(ENV_PATH, "utf-8").split(/\r?\n/).forEach(line => {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
        if (match && !line.trim().startsWith("#")) values[match[1]] = match[2];
    });
    return values;
}

function generateKey() {
    return crypto.randomBytes(KEY_BYTES).toString("base64");
}

// Finds the secret key. A real environment variable wins over the .env file, so a proper
// deployment can hand the key to the server without any file at all.
// Returns null when no key has been set up yet, and throws if one is set but is not a valid
// 256-bit key - a wrong-sized key should stop the server, not be quietly accepted.
function loadKey() {
    const encoded = process.env[KEY_ENV_NAME] || readEnvFile()[KEY_ENV_NAME];
    if (!encoded) return null;
    const key = Buffer.from(encoded, "base64");
    if (key.length !== KEY_BYTES) {
        throw new Error(`${KEY_ENV_NAME} must be ${KEY_BYTES} random bytes in base64. Run "npm run setup-encryption" to create a valid one.`);
    }
    return key;
}

// The details that are sealed together with the message but not hidden.
function sealedContext(listingId, agentId, createdAt) {
    return Buffer.from(`viewing-request|v1|listing:${listingId}|agent:${agentId}|at:${createdAt}`);
}

// Scrambles one viewing request. Returns the three values that get stored in the database.
function encryptRequest(key, details, context) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(sealedContext(context.listingId, context.agentId, context.createdAt));
    const plaintext = JSON.stringify({ name: details.name, phone: details.phone, message: details.message });
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
    };
}

// Unscrambles one row from viewing_requests. If the seal does not match - the row was
// changed, or it was scrambled with a different key - this throws an error with the code
// "SEAL_BROKEN" and returns nothing at all, so altered text is never shown as if it were real.
function decryptRequest(key, row) {
    try {
        const authTag = Buffer.from(row.auth_tag, "base64");
        if (authTag.length !== 16) throw new Error("bad tag length");
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(row.iv, "base64"));
        decipher.setAAD(sealedContext(row.listing_id, row.agent_id, row.created_at));
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
            decipher.update(Buffer.from(row.ciphertext, "base64")),
            decipher.final()
        ]).toString("utf8");
        return JSON.parse(plaintext);
    } catch (err) {
        const sealBroken = new Error("This viewing request could not be opened.");
        sealBroken.code = "SEAL_BROKEN";
        throw sealBroken;
    }
}

module.exports = {
    KEY_ENV_NAME,
    ensureSchema,
    readEnvFile,
    generateKey,
    loadKey,
    encryptRequest,
    decryptRequest
};
