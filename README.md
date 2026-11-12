# Dublin Property Listings

A web app for browsing and managing property listings in Dublin, with digitally signed listings so that any change made behind the website's back is detected and flagged, and encrypted viewing requests that only the listing's own agent can read.

Built with plain Node.js (no framework), SQLite, and vanilla HTML, CSS and JavaScript.

## Features

- **Browse listings** with filters for sale or lease, property type, status, agent, bedrooms and bathrooms, plus sorting by date or price.
- **Add listings** with a photo upload and a cascading area and street dropdown loaded from XML data.
- **Edit and delete listings** from a popup on the homepage.
- **Manage agents**, each with validated Irish phone and email details.
- **Analytics page** with charts for average price by area, property types, statuses and listings per agent.
- **Digitally signed listings** with a Verified, Tampered or Unsigned badge on every card.
- **Request a viewing** button on every open listing. The buyer's name, phone number and message are encrypted before they are saved.
- **Agent inbox** where an agent logs in and reads the viewing requests sent to them, and nobody else's.

## Security feature: signed listings

Each estate agent has their own Ed25519 key pair.

- The **private key** is the agent's stamp. It is stored encrypted with the agent's own signing password (scrypt + AES-256-GCM). The password is never stored.
- The **public key** is the checker. Anyone can use it to check a stamp, but it cannot create one.

Every time an agent adds or changes a listing, they enter their signing password and the listing is signed with their private key. The signature covers every field of the listing, including a SHA-256 hash of the photo.

Every time listings are loaded, the server re-checks each signature against what is currently in the database:

| Badge | Meaning |
|---|---|
| ✔ Verified | The listing matches what the agent signed. |
| ⚠ Tampered | The listing was changed after it was signed, outside the website. |
| Unsigned | The listing has never been signed. |

Because only the agent's password can unlock their private key, a verified listing is evidence that the agent posted it.

Anyone can check a signature independently at `/api/listings/<id>/verify`, which returns the signed data, the signature and the agent's public key.

## Security feature: encrypted viewing requests

Think of a letterbox with a lock: anyone can post a letter in, but only the person with the key can take letters out and read them.

Anyone can press **Request a viewing** on a listing and send their name, phone number and a message. Before anything is saved, the server encrypts all three with AES-256-GCM. The database only ever holds the scrambled text, so someone who steals `property.db` cannot read who asked for a viewing or what they wrote.

- **The key is kept outside the code.** It is one random 256-bit key, read when the server starts from the `VIEWING_REQUESTS_KEY` environment variable or from a `.env` file. `.env` is listed in `.gitignore`, sits outside the `public/` folder so the website cannot serve it, and is never stored in the database or printed.
- **Every request is scrambled differently.** Each one gets its own random IV, so two identical messages do not look the same in the database.
- **There is a tamper seal.** AES-GCM produces an authentication tag for each request. If the stored text, the IV or the tag is changed by even one character, the request refuses to open instead of showing altered text.
- **Requests cannot be moved between inboxes.** The listing id, agent id and time received are tied into the seal. Editing the database to point a request at a different agent breaks the seal as well.
- **Only the right agent can read them.** The agent logs in on the Agent Inbox page with their signing password. The server checks it by unlocking their private signing key, then gives the browser a session cookie (`HttpOnly`, `SameSite=Strict`, 30 minutes). The inbox route takes the agent's identity from that session, so one agent cannot ask for another agent's requests.
- **Login guessing is slowed down.** After 5 wrong passwords in a row for an agent, logins for that agent are refused for 5 minutes.

Viewing requests can be sent for listings that are Available or Sale Agreed. Deleting a listing also deletes its viewing requests.

## Requirements

- [Node.js](https://nodejs.org) (LTS version recommended), which includes npm

## Setup

Run these from the project folder (the one containing `package.json`):

```powershell
npm install
npm run setup-signing
npm run setup-encryption
npm start
```

Then open <http://localhost:3000>.

`npm run setup-signing` only needs to be run once. It creates key pairs for the starter agents and signs the starter listings.

`npm run setup-encryption` also only needs to be run once. It creates the secret key for viewing requests and saves it in `.env`. If the server is started without a key, the rest of the site still works but the viewing request form and the inbox are switched off.

Keep `.env` private and never commit it. Each copy of the project creates its own key, and requests saved with one key cannot be opened with another, so teammates who need to read the same database must pass the key on privately. Replacing the key makes every request already saved unreadable.

To rebuild the database from the seed data, delete `property.db` and run `npm run seed`.

## Demo signing passwords

The starter agents' signing passwords are in `data/agents-seed.json` and follow the pattern `Firstname-Stamp-2026`, for example `Siobhan-Stamp-2026`. These are demo credentials for testing only.

The same password logs the agent in to the Agent Inbox.

## Tamper demo

This shows the signature check catching a change made directly in the database.

1. Start the app and open the homepage. Every listing shows a green Verified badge.
2. In a second terminal, run:

   ```powershell
   npm run tamper-demo
   ```

   This halves the price of a listing with a direct SQL update, bypassing the website and the agent's password.
3. Refresh the homepage. That listing now shows a red Tampered badge.
4. Put the price back:

   ```powershell
   npm run tamper-demo -- restore
   ```

   Refresh again and the badge returns to Verified.

To choose the listing and price yourself: `npm run tamper-demo -- 3 99000`.

## Encryption demo

This shows that viewing requests are unreadable in the database, and that the tamper seal catches a change.

1. Start the app, press **Request a viewing** on a listing and send a message.
2. In a second terminal, run:

   ```powershell
   npm run encryption-demo
   ```

   This prints what is actually stored in `property.db` for each request: an IV, a tag and scrambled text. The name, phone number and message are not there.
3. Open **Agent Inbox**, pick the listing's agent and log in with their signing password. The request is readable.
4. Change one character of the stored request, straight in the database:

   ```powershell
   npm run encryption-demo -- tamper
   ```

   Refresh the inbox. That request now refuses to open.
5. Put it back:

   ```powershell
   npm run encryption-demo -- restore
   ```

   Refresh again and the request opens.

To choose the request yourself: `npm run encryption-demo -- tamper 3`.

## npm scripts

| Command | What it does |
|---|---|
| `npm start` | Starts the server on port 3000 |
| `npm run seed` | Creates the tables and loads the starter data |
| `npm run setup-signing` | Creates agent keys and signs unsigned listings |
| `npm run tamper-demo` | Changes a listing's price directly in the database |
| `npm run setup-encryption` | Creates the secret key for viewing requests in `.env` |
| `npm run encryption-demo` | Shows the stored viewing requests as a thief would see them, and tampers with one |

## Project structure

| Path | Purpose |
|---|---|
| `server.js` | HTTP server and API routes |
| `signing.js` | Key generation, key encryption, signing and verification |
| `setup-signing.js` | One-time setup of keys and signatures for starter data |
| `tamper-demo.js` | Tamper demonstration script |
| `encryption.js` | Loading the secret key, encrypting and decrypting viewing requests |
| `setup-encryption.js` | One-time creation of the secret key |
| `encryption-demo.js` | Encryption demonstration script |
| `.env` | The secret key (created by setup, ignored by git) |
| `.env.example` | Shows what `.env` looks like, without a real key |
| `seed.js` | Builds the database from the seed files |
| `config.js` | File paths |
| `data/` | Seed data: agents (JSON), listings (JSON), areas and streets (XML), images |
| `public/` | Front-end pages and scripts, including `inbox.html` and `inbox.js` for the agent inbox |
| `property.db` | SQLite database |

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/listings` | All listings, each with its verification result |
| POST | `/api/listings` | Add a listing (requires the agent's signing password) |
| PUT | `/api/listings/:id` | Update a listing (requires the agent's signing password) |
| DELETE | `/api/listings/:id` | Delete a listing |
| GET | `/api/listings/:id/verify` | Signature proof for one listing |
| POST | `/api/listings/:id/viewing-requests` | Send a viewing request (encrypted before it is saved) |
| POST | `/api/login` | Log an agent in with their signing password |
| POST | `/api/logout` | Log the agent out |
| GET | `/api/inbox` | The logged-in agent's viewing requests, decrypted |
| GET | `/api/agents` | All agents with their key fingerprints |
| POST | `/api/agents` | Add an agent and create their key pair |
| GET | `/api/areas` | Dublin areas |
| GET | `/api/areas/:routingKey/streets` | Streets in an area |
| GET | `/api/stats/by-area`, `/by-type`, `/by-status`, `/by-agent` | Data for the analytics charts |

## Known limitations

- The server holds the encrypted private keys and sees the signing password briefly while signing, so non-repudiation relies on trusting the server.
- Deleting a listing does not require a signing password.
- The app runs over plain HTTP on localhost. A real deployment would need HTTPS so passwords are encrypted in transit.
- There is no limit on signing password attempts on the listing forms. Only the inbox login is limited.
- Viewing requests are encrypted in the database, not in the browser. The server sees the readable text briefly while encrypting and decrypting, and until the site runs over HTTPS the form and the inbox travel across the network unencrypted. For the same reason the session cookie is not marked `Secure`.
- One key protects every agent's requests, and it sits in a file on the same machine as the database. Someone who steals both `property.db` and `.env` can read everything. A real deployment would keep the key in a secrets manager and support replacing it.
- Login sessions are held in memory, so restarting the server logs every agent out.
- Anyone can send viewing requests and there is no limit on how many, so an inbox could be filled with spam.
- The listing id, agent id and time of each request are stored unencrypted so the inbox can be filtered. They show that a request exists, but not who sent it or what it says.
