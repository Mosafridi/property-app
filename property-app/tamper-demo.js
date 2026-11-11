// Tamper demo - changes a listing's price straight in property.db, behind the website's back.
//
//   npm run tamper-demo                 halves the price of the first verified listing
//   npm run tamper-demo -- 3 99000      sets listing 3's price to 99000
//   npm run tamper-demo -- restore      puts every tampered price back
//
// This does exactly what a sneaky person with access to the database file would do: a plain
// SQL UPDATE that never goes through server.js, so no agent password is asked for and the
// listing is not re-stamped. Refresh the homepage afterwards and the green "Verified" badge
// on that listing turns into a red warning, because the stamp no longer matches the price.
//
// The original price is remembered in tamper-demo-backup.json so "restore" can put it back.
// Once the price is back to what the agent stamped, the badge goes green again by itself.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const signing = require('./signing');
const { DB_PATH } = require('./config');

const BACKUP_PATH = path.join(__dirname, "tamper-demo-backup.json");
const db = new Database(DB_PATH);

function loadBackup() {
    return fs.existsSync(BACKUP_PATH) ? JSON.parse(fs.readFileSync(BACKUP_PATH, "utf-8")) : {};
}

function listingWithKey(id) {
    return db.prepare(`
        SELECT l.*, ag.name AS agent_name, ag.public_key
        FROM property_listings l JOIN agents ag ON ag.id = l.agent_id
        WHERE l.id = ?
    `).get(id);
}

function badgeFor(id) {
    const row = listingWithKey(id);
    return signing.verifyListing(row, row.public_key).toUpperCase();
}

function restore() {
    const backup = loadBackup();
    const ids = Object.keys(backup);
    if (ids.length === 0) {
        console.log("Nothing to restore - no tampered prices on record.");
        return;
    }
    ids.forEach(id => {
        db.prepare("UPDATE property_listings SET price = ? WHERE id = ?").run(backup[id], id);
        console.log(`Listing ${id}: price put back to ${backup[id]}  ->  badge is now ${badgeFor(id)}`);
    });
    fs.unlinkSync(BACKUP_PATH);
    console.log("Refresh the homepage to see the Verified badge return.");
}

function tamper(idArg, priceArg) {
    let id = idArg ? Number(idArg) : null;
    if (!id) {
        // No listing chosen, so pick the first one that is currently verified.
        const candidates = db.prepare("SELECT id FROM property_listings WHERE signature IS NOT NULL ORDER BY id").all();
        const firstVerified = candidates.find(c => badgeFor(c.id) === "VERIFIED");
        if (!firstVerified) {
            console.log('No verified listing found. Run "npm run setup-signing" first.');
            return;
        }
        id = firstVerified.id;
    }

    const listing = listingWithKey(id);
    if (!listing) {
        console.log(`Listing ${id} not found.`);
        return;
    }

    const newPrice = priceArg ? Number(priceArg) : Math.round(listing.price / 2);
    if (!Number.isFinite(newPrice) || newPrice <= 0) {
        console.log("The new price must be a positive number.");
        return;
    }

    console.log(`Listing ${id}: "${listing.title}" (agent: ${listing.agent_name})`);
    console.log(`  Before: price ${listing.price}  ->  badge ${badgeFor(id)}`);

    // Remember the original price only the first time, so tampering twice still restores
    // to what the agent actually stamped.
    const backup = loadBackup();
    if (backup[id] === undefined) backup[id] = listing.price;
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2));

    // The tampering itself: a direct database write. No password, no new stamp.
    db.prepare("UPDATE property_listings SET price = ? WHERE id = ?").run(newPrice, id);

    console.log(`  After:  price ${newPrice}  ->  badge ${badgeFor(id)}`);
    console.log("Refresh the homepage to see the warning badge on this listing.");
    console.log('Run "npm run tamper-demo -- restore" to put the price back.');
}

const args = process.argv.slice(2);
if (args[0] === "restore") {
    restore();
} else {
    tamper(args[0], args[1]);
}
db.close();
