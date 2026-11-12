// One-time setup for viewing request encryption:  npm run setup-encryption
//
// Creates the secret key that scrambles viewing requests and saves it in a .env file next to
// package.json. The .env file is listed in .gitignore, so the key never ends up in the code
// or on GitHub.
//
// It is safe to run more than once - if a key already exists it is left alone. Replacing the
// key would make every request that is already saved impossible to open, so this script
// never does that.
//
// Everyone who should be able to read the same database needs the same key. Pass it on
// privately (not by email, not in the repository), or let each person create their own key
// and start with an empty inbox.

const fs = require('fs');
const encryption = require('./encryption');
const { ENV_PATH } = require('./config');

function setupEncryption() {
    if (process.env[encryption.KEY_ENV_NAME]) {
        encryption.loadKey(); // throws if the key that is set is not a valid one
        console.log(`${encryption.KEY_ENV_NAME} is already set as an environment variable. Nothing to do.`);
        return;
    }
    if (encryption.readEnvFile()[encryption.KEY_ENV_NAME]) {
        encryption.loadKey();
        console.log("A key already exists in .env, so it was left alone.");
        return;
    }

    // Added to the end of .env rather than replacing the file, in case it holds other settings.
    const existing = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(ENV_PATH, `${existing}${separator}${encryption.KEY_ENV_NAME}=${encryption.generateKey()}\n`);

    console.log("Secret key created and saved in .env");
    console.log("Keep this file private. It is ignored by git and must not be shared in the repository.");
}

console.log("Setting up viewing request encryption...");
setupEncryption();
