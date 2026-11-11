// // I only need to run this once (or whenever I want to reset back to starter data). It builds
// the SQLite tables and loads the XML + JSON seed data into them, resolving the foreign keys
// as it goes so property_listings ends up properly relational instead of just holding names.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const xml2js = require('xml2js');
const { DB_PATH, AREAS_XML_PATH, AGENTS_SEED_PATH, LISTINGS_SEED_PATH, IMAGES_DIR } = require('./config');
const { setupSigning } = require('./setup-signing');

console.log("Starting database seed...");

const db = new Database(DB_PATH);

// I want a proper relational structure for the marking scheme, not flat tables, so
// dublin_streets points back to dublin_areas, and property_listings points to all three of
// agents/areas/streets. That's what lets me do real joins later in server.js.

function createTables() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS agents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            phone TEXT NOT NULL UNIQUE,
            email TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS dublin_areas (
            routing_key TEXT PRIMARY KEY,
            area_name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS dublin_streets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            routing_key TEXT NOT NULL,
            street_name TEXT NOT NULL,
            FOREIGN KEY (routing_key) REFERENCES dublin_areas(routing_key)
        );

        CREATE TABLE IF NOT EXISTS property_listings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            property_type TEXT NOT NULL,
            listing_type TEXT NOT NULL,
            price REAL NOT NULL,
            bedrooms INTEGER NOT NULL,
            bathrooms INTEGER NOT NULL,
            routing_key TEXT NOT NULL,
            street_id INTEGER NOT NULL,
            eircode TEXT NOT NULL,
            agent_id INTEGER NOT NULL,
            features TEXT,
            status TEXT NOT NULL,
            date_listed TEXT NOT NULL,
            image_url TEXT,
            image_data BLOB,
            image_type TEXT,
            FOREIGN KEY (routing_key) REFERENCES dublin_areas(routing_key),
            FOREIGN KEY (street_id) REFERENCES dublin_streets(id),
            FOREIGN KEY (agent_id) REFERENCES agents(id)
        );
    `);
    console.log("Tables ready");
}


// The street information is stored as an XML file, so I need to retrieve and manipulate it with Node - I parse
// the raw XML into JS objects, then I reshape it from a nested area and streets structure into the
// two flat tables my schema expects (dublin_areas, dublin_streets).


async function seedAreasAndStreets() {
    const existing = db.prepare("SELECT COUNT(*) AS count FROM dublin_areas").get();
    if (existing.count > 0) {
        console.log("Areas/streets already seeded, skipping");
        return;
    }
    console.log("Reading dublin-areas.xml...");
    const xmlData = fs.readFileSync(AREAS_XML_PATH, "utf-8");
    const parsed = await xml2js.parseStringPromise(xmlData);
    const areas = parsed.dublinAreas.area;

    const insertArea = db.prepare("INSERT INTO dublin_areas (routing_key, area_name) VALUES (?, ?)");
    const insertStreet = db.prepare("INSERT INTO dublin_streets (routing_key, street_name) VALUES (?, ?)");

    areas.forEach(area => {
        const routingKey = area.$.routingKey;
        const areaName = area.name[0];
        insertArea.run(routingKey, areaName);

        const streets = area.streets[0].street;
        streets.forEach(streetName => {
            insertStreet.run(routingKey, streetName);
        });
    });
    console.log(`Seeded ${areas.length} areas and their streets`);
}


// Agents are a small, simple lookup table - no login or accounts needed for this project,
// The goal is to provide additional information that one would expect to see on a property listing.
// so I just read the JSON and insert it directly into the agents table. 

function seedAgents() {

    const existing = db.prepare("SELECT COUNT(*) AS count FROM agents").get();

    if (existing.count > 0) {
        console.log("Agents already seeded, skipping");
        return;
    }

    console.log("Reading agents-seed.json...");
    const agents = JSON.parse(fs.readFileSync(AGENTS_SEED_PATH, "utf-8"));
    const insertAgent = db.prepare("INSERT INTO agents (name, phone, email) VALUES (?, ?, ?)");
    agents.forEach(a => insertAgent.run(a.name, a.phone, a.email));
    console.log(`Seeded ${agents.length} agents`);
}



//Another manupulation for a JSON data object
function seedListings() {
    const existing = db.prepare("SELECT COUNT(*) AS count FROM property_listings").get();
    if (existing.count > 0) {
        console.log("Listings already seeded, skipping");
        return;
    }
    console.log("Reading listings-seed.json...");
    const listings = JSON.parse(fs.readFileSync(LISTINGS_SEED_PATH, "utf-8"));

    const findStreet = db.prepare("SELECT id FROM dublin_streets WHERE routing_key = ? AND street_name = ?");
    const findAgent = db.prepare("SELECT id FROM agents WHERE email = ?");
    const insertListing = db.prepare(`
        INSERT INTO property_listings
        (title, property_type, listing_type, price, bedrooms, bathrooms, routing_key, street_id, eircode, agent_id, features, status, date_listed, image_url, image_data, image_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let seededCount = 0;
    listings.forEach(l => {
        const street = findStreet.get(l.routingKey, l.street);
        const agent = findAgent.get(l.agentEmail);
        if (!street || !agent) {
            console.log(`Skipping "${l.title}" - could not resolve street or agent`);
            return;
        }

        // I want to populate the image_data BLOB column with the actual bytes of the image file, so I read it from disk here.
        // The aim of this section is to ensure that when we have some data in the database, 
        // that we can display without having to add the listings one by one though the add-listing form. 

        // the add listing form will allow a user to upload an image, which will be stored in the database as a BLOB.


        let imageBuffer = null;
        let imageType = null;
        if (l.imageFile) {
            const imagePath = path.join(IMAGES_DIR, l.imageFile);
            if (fs.existsSync(imagePath)) {
                imageBuffer = fs.readFileSync(imagePath);
                imageType = "image/jpeg";
            } else {
                console.log(`No image file for "${l.title}" (${l.imageFile}), leaving it unset`);
            }
        }

        insertListing.run(
            l.title, l.propertyType, l.listingType, l.price, l.bedrooms, l.bathrooms,
            l.routingKey, street.id, l.eircode, agent.id,
            JSON.stringify(l.features || []), l.status, l.dateListed, null, imageBuffer, imageType
        );
        seededCount++;
    });
    console.log(`Seeded ${seededCount} listings`);
}

// The goal here is to run these functions in order so that we can create the database and add seed some data and images into it.

async function runSeed() {
    createTables();
    await seedAreasAndStreets();
    seedAgents();
    seedListings();
    // The starter data goes in unsigned, so this gives each starter agent their key pair and
    // stamps the starter listings - otherwise every card would show as "Unsigned".
    setupSigning(db);
    console.log("Database seed complete");
    db.close();
}

runSeed();