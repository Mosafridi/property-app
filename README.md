# Dublin Property Listings

A web app for browsing and managing property listings in Dublin, with digitally signed listings so that any change made behind the website's back is detected and flagged.

Built with plain Node.js (no framework), SQLite, and vanilla HTML, CSS and JavaScript.

## Features

- **Browse listings** with filters for sale or lease, property type, status, agent, bedrooms and bathrooms, plus sorting by date or price.
- **Add listings** with a photo upload and a cascading area and street dropdown loaded from XML data.
- **Edit and delete listings** from a popup on the homepage.
- **Manage agents**, each with validated Irish phone and email details.
- **Analytics page** with charts for average price by area, property types, statuses and listings per agent.
- **Digitally signed listings** with a Verified, Tampered or Unsigned badge on every card.

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

## Requirements

- [Node.js](https://nodejs.org) (LTS version recommended), which includes npm

## Setup

Run these from the project folder (the one containing `package.json`):

```powershell
npm install
npm run setup-signing
npm start
```

Then open <http://localhost:3000>.

`npm run setup-signing` only needs to be run once. It creates key pairs for the starter agents and signs the starter listings.

To rebuild the database from the seed data, delete `property.db` and run `npm run seed`.

## Demo signing passwords

The starter agents' signing passwords are in `data/agents-seed.json` and follow the pattern `Firstname-Stamp-2026`, for example `Siobhan-Stamp-2026`. These are demo credentials for testing only.

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

## npm scripts

| Command | What it does |
|---|---|
| `npm start` | Starts the server on port 3000 |
| `npm run seed` | Creates the tables and loads the starter data |
| `npm run setup-signing` | Creates agent keys and signs unsigned listings |
| `npm run tamper-demo` | Changes a listing's price directly in the database |

## Project structure

| Path | Purpose |
|---|---|
| `server.js` | HTTP server and API routes |
| `signing.js` | Key generation, key encryption, signing and verification |
| `setup-signing.js` | One-time setup of keys and signatures for starter data |
| `tamper-demo.js` | Tamper demonstration script |
| `seed.js` | Builds the database from the seed files |
| `config.js` | File paths |
| `data/` | Seed data: agents (JSON), listings (JSON), areas and streets (XML), images |
| `public/` | Front-end pages and scripts |
| `property.db` | SQLite database |

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/listings` | All listings, each with its verification result |
| POST | `/api/listings` | Add a listing (requires the agent's signing password) |
| PUT | `/api/listings/:id` | Update a listing (requires the agent's signing password) |
| DELETE | `/api/listings/:id` | Delete a listing |
| GET | `/api/listings/:id/verify` | Signature proof for one listing |
| GET | `/api/agents` | All agents with their key fingerprints |
| POST | `/api/agents` | Add an agent and create their key pair |
| GET | `/api/areas` | Dublin areas |
| GET | `/api/areas/:routingKey/streets` | Streets in an area |
| GET | `/api/stats/by-area`, `/by-type`, `/by-status`, `/by-agent` | Data for the analytics charts |

## Known limitations

- The server holds the encrypted private keys and sees the signing password briefly while signing, so non-repudiation relies on trusting the server.
- Deleting a listing does not require a signing password.
- The app runs over plain HTTP on localhost. A real deployment would need HTTPS so passwords are encrypted in transit.
- There is no limit on signing password attempts.
