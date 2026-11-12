// Encryption demo - shows what viewing requests look like to someone who steals property.db.
//
//   npm run encryption-demo                 shows the stored requests exactly as a thief sees them
//   npm run encryption-demo -- tamper       changes one character of the newest stored request
//   npm run encryption-demo -- tamper 3     changes one character of request 3
//   npm run encryption-demo -- restore      puts every changed request back
//
// The first command reads the database directly, the same way a thief with a copy of the
// file would. The names, phone numbers and messages are not in there - only scrambled text.
// It then reports whether each request still opens with the key from .env, without printing
// what it says. Reading the contents is only possible through the agent's inbox.
//
// "tamper" does what someone with write access to the database could do: a plain SQL UPDATE
// that swaps a single character of the scrambled text. Refresh the agent's inbox afterwards
// and that request refuses to open, because the tamper seal no longer matches.
//
// The original text is remembered in encryption-demo-backup.json so "restore" can put it back.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const encryption = require('./encryption');
const { DB_PATH } = require('./config');

const BACKUP_PATH = path.join(__dirname, "encryption-demo-backup.json");
const db = new Database(DB_PATH);
encryption.ensureSchema(db);
const key = encryption.loadKey();

function loadBackup() {
    return fs.existsSync(BACKUP_PATH) ? JSON.parse(fs.readFileSync(BACKUP_PATH, "utf-8")) : {};
}

function sealStatus(row) {
    if (!key) return 'NO KEY (run "npm run setup-encryption")';
    try {
        encryption.decryptRequest(key, row);
        return "OPENS (seal intact)";
    } catch (err) {
        return "REFUSES TO OPEN (seal broken)";
    }
}

function thiefView() {
    const rows = db.prepare("SELECT * FROM viewing_requests ORDER BY id").all();
    if (rows.length === 0) {
        console.log('No viewing requests saved yet. Send one from the homepage with "Request a viewing" first.');
        return;
    }
    console.log(`What is stored in property.db for ${rows.length} viewing request(s):\n`);
    rows.forEach(row => {
        console.log(`Request ${row.id}  (listing ${row.listing_id}, agent ${row.agent_id}, saved ${row.created_at})`);
        console.log(`  iv:         ${row.iv}`);
        console.log(`  auth_tag:   ${row.auth_tag}`);
        console.log(`  ciphertext: ${row.ciphertext}`);
        console.log(`  With the key from .env: ${sealStatus(row)}\n`);
    });
    console.log("No name, phone number or message can be read from the database on its own.");
}

function tamper(idArg) {
    const row = idArg
        ? db.prepare("SELECT * FROM viewing_requests WHERE id = ?").get(Number(idArg))
        : db.prepare("SELECT * FROM viewing_requests ORDER BY id DESC LIMIT 1").get();
    if (!row) {
        console.log(idArg ? `Request ${idArg} not found.` : "No viewing requests saved yet.");
        return;
    }

    console.log(`Request ${row.id} (listing ${row.listing_id}, agent ${row.agent_id})`);
    console.log(`  Before: ${sealStatus(row)}`);

    // Remember the original only the first time, so tampering twice still restores properly.
    const backup = loadBackup();
    if (backup[row.id] === undefined) backup[row.id] = row.ciphertext;
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(backup, null, 2));

    // The tampering itself: swap the first character of the scrambled text for a different one.
    const swapped = (row.ciphertext[0] === "A" ? "B" : "A") + row.ciphertext.slice(1);
    db.prepare("UPDATE viewing_requests SET ciphertext = ? WHERE id = ?").run(swapped, row.id);

    console.log(`  After:  ${sealStatus({ ...row, ciphertext: swapped })}`);
    console.log("Refresh the agent's inbox to see this request refuse to open.");
    console.log('Run "npm run encryption-demo -- restore" to put it back.');
}

function restore() {
    const backup = loadBackup();
    const ids = Object.keys(backup);
    if (ids.length === 0) {
        console.log("Nothing to restore - no tampered requests on record.");
        return;
    }
    ids.forEach(id => {
        db.prepare("UPDATE viewing_requests SET ciphertext = ? WHERE id = ?").run(backup[id], id);
        const row = db.prepare("SELECT * FROM viewing_requests WHERE id = ?").get(id);
        console.log(`Request ${id}: put back  ->  ${row ? sealStatus(row) : "no longer in the database"}`);
    });
    fs.unlinkSync(BACKUP_PATH);
    console.log("Refresh the agent's inbox to see the request open again.");
}

const args = process.argv.slice(2);
if (args[0] === "tamper") {
    tamper(args[1]);
} else if (args[0] === "restore") {
    restore();
} else {
    thiefView();
}
db.close();
