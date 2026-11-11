// Digital signatures for listings ("the wax seal").
//
// Every agent gets an Ed25519 key pair:
//   - the PRIVATE key is the stamp. It is stored encrypted with the agent's own signing
//     password (scrypt + AES-256-GCM), so the server can only use it while the agent is
//     typing that password in. The password itself is never stored anywhere.
//   - the PUBLIC key is the checker. It is stored in plain text and anyone can use it to
//     check a stamp, but it cannot be used to make one.
//
// Every time a listing is added or changed, the listing's fields are stamped with the agent's
// private key. Whenever listings are read back, the stamp is checked against what is in the
// database right now. If anything was changed behind the website's back (for example
// straight in property.db), the stamp no longer matches and the listing is flagged.
//
// Only Node's built-in crypto module is used here, so there is nothing extra to install.

const crypto = require('crypto');

const MIN_PASSWORD_LENGTH = 8;

// scrypt is deliberately slow and memory-hungry, which is what makes guessing the password
// expensive for someone who steals the database file. N=32768 needs about 33MB, which is just
// over Node's default limit, so maxmem is raised to allow it.
const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

// Adds the signing columns to an existing database without touching the data already in it.
// Safe to call every time the server starts - it only adds a column if it is missing.
function ensureSchema(db) {
    const addColumnIfMissing = (table, column, type) => {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
        if (columns.length === 0) return; // table not created yet (seed.js has not been run)
        if (!columns.includes(column)) {
            db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
        }
    };
    addColumnIfMissing("agents", "public_key", "TEXT");
    addColumnIfMissing("agents", "enc_private_key", "TEXT");
    addColumnIfMissing("agents", "key_created_at", "TEXT");
    addColumnIfMissing("property_listings", "signature", "TEXT");
    addColumnIfMissing("property_listings", "signed_at", "TEXT");
}

function isValidSigningPassword(password) {
    return typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;
}

// Makes a brand new stamp for an agent and locks the private half with their password.
// Returns the two values that get stored in the agents table.
function generateAgentKeys(password) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
    const privateKeyDer = privateKey.export({ type: "pkcs8", format: "der" });

    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const lockKey = crypto.scryptSync(password, salt, 32, SCRYPT_PARAMS);
    const cipher = crypto.createCipheriv("aes-256-gcm", lockKey, iv);
    const ciphertext = Buffer.concat([cipher.update(privateKeyDer), cipher.final()]);

    const encPrivateKey = JSON.stringify({
        kdf: "scrypt", N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
        cipher: "aes-256-gcm",
        salt: salt.toString("base64"),
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64")
    });
    return { publicKeyPem, encPrivateKey };
}

// Unlocks an agent's private key with their password. AES-GCM checks its own integrity tag,
// so a wrong password fails loudly here instead of producing a garbage key.
function unlockPrivateKey(encPrivateKey, password) {
    const box = JSON.parse(encPrivateKey);
    try {
        const lockKey = crypto.scryptSync(password, Buffer.from(box.salt, "base64"), 32,
            { N: box.N, r: box.r, p: box.p, maxmem: SCRYPT_PARAMS.maxmem });
        const decipher = crypto.createDecipheriv("aes-256-gcm", lockKey, Buffer.from(box.iv, "base64"));
        decipher.setAuthTag(Buffer.from(box.tag, "base64"));
        const privateKeyDer = Buffer.concat([
            decipher.update(Buffer.from(box.ciphertext, "base64")),
            decipher.final()
        ]);
        return crypto.createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
    } catch (err) {
        const wrongPassword = new Error("Wrong signing password.");
        wrongPassword.code = "BAD_PASSWORD";
        throw wrongPassword;
    }
}

// The exact text that gets stamped. It has to come out identical every time for the same
// listing, so the fields are always written in this fixed order. The photo is included as a
// SHA-256 hash, so swapping the picture breaks the stamp too, without signing megabytes.
function canonicalPayload(row, signedAt) {
    return JSON.stringify({
        v: 1,
        id: row.id,
        title: row.title,
        propertyType: row.property_type,
        listingType: row.listing_type,
        price: row.price,
        bedrooms: row.bedrooms,
        bathrooms: row.bathrooms,
        routingKey: row.routing_key,
        streetId: row.street_id,
        eircode: row.eircode,
        agentId: row.agent_id,
        features: row.features || "[]",
        status: row.status,
        dateListed: row.date_listed,
        imageUrl: row.image_url || null,
        imageType: row.image_type || null,
        imageSha256: row.image_data ? crypto.createHash("sha256").update(row.image_data).digest("hex") : null,
        signedAt: signedAt
    });
}

// Stamps the listing as it currently sits in the database and saves the stamp beside it.
function signListing(db, listingId, privateKey) {
    const row = db.prepare("SELECT * FROM property_listings WHERE id = ?").get(listingId);
    if (!row) throw new Error("Listing not found");
    const signedAt = new Date().toISOString();
    const signature = crypto.sign(null, Buffer.from(canonicalPayload(row, signedAt)), privateKey).toString("base64");
    db.prepare("UPDATE property_listings SET signature = ?, signed_at = ? WHERE id = ?").run(signature, signedAt, listingId);
    return { signature, signedAt };
}

// Checks a listing row against its agent's public key.
//   "verified" - the stamp matches what is in the database right now
//   "tampered" - there is a stamp, but the listing no longer matches it
//   "unsigned" - the listing was never stamped
function verifyListing(row, publicKeyPem) {
    if (!row.signature) return "unsigned";
    if (!publicKeyPem || !row.signed_at) return "tampered";
    try {
        const ok = crypto.verify(null, Buffer.from(canonicalPayload(row, row.signed_at)),
            crypto.createPublicKey(publicKeyPem), Buffer.from(row.signature, "base64"));
        return ok ? "verified" : "tampered";
    } catch (err) {
        return "tampered";
    }
}

// A short ID for a public key, so people can compare keys without reading the whole thing.
function fingerprint(publicKeyPem) {
    if (!publicKeyPem) return null;
    const der = crypto.createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
    return crypto.createHash("sha256").update(der).digest("hex").slice(0, 16);
}

module.exports = {
    MIN_PASSWORD_LENGTH,
    ensureSchema,
    isValidSigningPassword,
    generateAgentKeys,
    unlockPrivateKey,
    canonicalPayload,
    signListing,
    verifyListing,
    fingerprint
};
