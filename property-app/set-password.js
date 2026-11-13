// Member 1 - sets (or resets) an agent's password from the terminal.
// The agents that came from agents-seed.json have no password yet, so this is how
// I give them one. (This is the LOGIN password - separate from the signing password.) Only the scrypt hash is saved - the plain password never touches disk.
// Usage:  node set-password.js siobhan.byrne@dublinhomes.ie MyPassw0rd

const Database = require('better-sqlite3');
const { DB_PATH } = require('./config');
const { hashPassword, isStrongEnough } = require('./crypto/passwords');
const { ensureAuthSchema } = require('./crypto/sessions');

const [email, password] = process.argv.slice(2);
if (!email || !password) {
    console.log("Usage: node set-password.js <agent email> <new password>");
    process.exit(1);
}
if (!isStrongEnough(password)) {
    console.log("Password must be at least 8 characters and include a letter and a number.");
    process.exit(1);
}

const db = new Database(DB_PATH);
ensureAuthSchema(db); // adds the password_hash column if this database doesn't have it yet
const result = db.prepare("UPDATE agents SET password_hash = ? WHERE email = ?").run(hashPassword(password), email.trim());
if (result.changes === 0) {
    console.log(`No agent found with email ${email}`);
} else {
    console.log(`Password set for ${email}`);
}
db.close();
