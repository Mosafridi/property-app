// One-time setup for the signing feature:  npm run setup-signing
//
// The starter agents and listings were created before signing existed, so they have no keys
// and no stamps. This script:
//   1. adds the signing columns to the database if they are missing,
//   2. gives every starter agent a key pair, locked with the demo signing password listed
//      for them in data/agents-seed.json,
//   3. stamps every listing that has no stamp yet with its own agent's key.
//
// It is safe to run more than once - agents that already have a key and listings that are
// already stamped are left alone. It never re-stamps a listing that has a stamp, so it cannot
// be used to "fix" a listing that was tampered with.

const fs = require('fs');
const Database = require('better-sqlite3');
const signing = require('./signing');
const { DB_PATH, AGENTS_SEED_PATH } = require('./config');

function setupSigning(db) {
    signing.ensureSchema(db);

    const seedAgents = JSON.parse(fs.readFileSync(AGENTS_SEED_PATH, "utf-8"));
    const passwordByEmail = new Map(
        seedAgents.filter(a => a.signingPassword).map(a => [a.email, a.signingPassword])
    );

    // Step 1: keys for agents that do not have one yet.
    const agents = db.prepare("SELECT id, name, email, enc_private_key FROM agents ORDER BY id").all();
    const saveKeys = db.prepare("UPDATE agents SET public_key = ?, enc_private_key = ?, key_created_at = ? WHERE id = ?");
    let keysCreated = 0;
    agents.forEach(agent => {
        if (agent.enc_private_key) return;
        const password = passwordByEmail.get(agent.email);
        if (!signing.isValidSigningPassword(password)) {
            console.log(`  Skipping ${agent.name} - no signingPassword for them in agents-seed.json`);
            return;
        }
        const keys = signing.generateAgentKeys(password);
        saveKeys.run(keys.publicKeyPem, keys.encPrivateKey, new Date().toISOString(), agent.id);
        agent.enc_private_key = keys.encPrivateKey;
        keysCreated++;
        console.log(`  Key pair created for ${agent.name}`);
    });

    // Step 2: stamp listings that have never been stamped. Each agent's key is unlocked once
    // and reused for all of their listings, since unlocking is deliberately slow.
    const unsigned = db.prepare("SELECT id, title, agent_id FROM property_listings WHERE signature IS NULL ORDER BY id").all();
    const unlockedKeys = new Map();
    let listingsSigned = 0;
    unsigned.forEach(listing => {
        if (!unlockedKeys.has(listing.agent_id)) {
            const agent = agents.find(a => a.id === listing.agent_id);
            const password = agent ? passwordByEmail.get(agent.email) : null;
            let privateKey = null;
            if (agent && agent.enc_private_key && password) {
                try {
                    privateKey = signing.unlockPrivateKey(agent.enc_private_key, password);
                } catch (err) {
                    console.log(`  Could not unlock ${agent.name}'s key with the password in agents-seed.json`);
                }
            }
            unlockedKeys.set(listing.agent_id, privateKey);
        }
        const privateKey = unlockedKeys.get(listing.agent_id);
        if (!privateKey) {
            console.log(`  Leaving "${listing.title}" unsigned - its agent's key is not available`);
            return;
        }
        signing.signListing(db, listing.id, privateKey);
        listingsSigned++;
    });

    console.log(`Signing setup complete: ${keysCreated} key pair(s) created, ${listingsSigned} listing(s) stamped`);
}

module.exports = { setupSigning };

// Only run straight away when this file is started directly (npm run setup-signing),
// not when seed.js pulls it in.
if (require.main === module) {
    console.log("Setting up listing signatures...");
    const db = new Database(DB_PATH);
    setupSigning(db);
    db.close();
}
