// This as a plain Node http server which will not use any framework such as Express


const http = require('http');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { DB_PATH} = require('./config');
const signing = require('./signing');
console.log("Config loaded");
console.log("  DB_PATH:", DB_PATH);

// SQLite is just a file on disk, so I open it once here and reuse the same connection
// for every request instead of connecting per-request.
// I have chooseb SQLite because of the minimum set up required and the fact that the application 
// will have its database in the same directory as the application and will not require any external database server to be running.
// in production, I would use a more robust database such as PostgreSQL


const db = new Database(DB_PATH);

// Adds the signing columns (agent keys, listing signatures) if this database was created
// before the signing feature existed. It only adds what is missing, existing data is untouched.
signing.ensureSchema(db);

// I need this to serve index.html, add.html, analytics.html and their JS/CSS.
// I resolve the request against the public folder and then check the result is still
// inside public/ before reading it 


const PUBLIC_DIR = path.join(__dirname, "public");
function serveStaticFile(req, res) {
    const requestedPath = req.url === "/" ? "index.html" : req.url.split("?")[0];
    const resolvedPath = path.join(PUBLIC_DIR, requestedPath);

    if (!resolvedPath.startsWith(PUBLIC_DIR + path.sep) && resolvedPath !== PUBLIC_DIR) {
        res.writeHead(403);
        return res.end("403 Forbidden");
    }

    fs.readFile(resolvedPath, (err, data) => {
        if (err) {
            res.writeHead(404);
            return res.end("404 File Not Found");
        }
        const ext = path.extname(resolvedPath);


        // Without an explicit charset, the browser has to guess the encoding of whatever
        // bytes come back and in cases where we are listing the price in euros, the euro sign would be wrongly formated
        
        const contentTypes = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".png": "image/png",
            ".jpg": "image/jpeg"
        };
        res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain; charset=utf-8" });
        res.end(data);
    });
}

// Sale and lease listings don't share the same lifecycle - a sale can end in "sold", a lease
// ends in "leased", and neither makes sense on the other type. 

const STATUS_BY_LISTING_TYPE = {
    sale: ["available", "sale agreed", "sold", "withdrawn"],
    lease: ["available", "leased", "withdrawn"]
};

// The validation for a new agent's contact details below
// Matching Irish mobile (08X-XXXXXXX) or Dublin landline (01-XXXXXXX), with or without +353,


const PHONE_PATTERN = /^(\+353|0)(1\d{7}|8[3-9]\d{7})$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// I want the client to get back a specific list of what's wrong, not one generic error,
// so this returns an array of problem field names instead of throwing on the first bad field.

function validateListingData(data) {
    const problems = [];

    if (!data.title || data.title.trim() === "") {
        problems.push("title");
    }
    if (!["house", "apartment", "bungalow", "duplex"].includes(data.propertyType)) {
        problems.push("propertyType");
    }
    if (!["sale", "lease"].includes(data.listingType)) {
        problems.push("listingType");
    }
    if (!data.price || isNaN(data.price) || Number(data.price) <= 0) {
        problems.push("price");
    }
    if (!data.bedrooms || isNaN(data.bedrooms) || Number(data.bedrooms) <= 0) {
        problems.push("bedrooms");
    }
    if (!data.bathrooms || isNaN(data.bathrooms) || Number(data.bathrooms) <= 0) {
        problems.push("bathrooms");
    }
    if (!data.routingKey) {
        problems.push("routingKey");
    }
    if (!data.streetId) {
        problems.push("streetId");
    }


    // I'm only validating the format here (1 letter + 2 digits + 4 alphanumeric)

    const eircodePattern = /^[A-Z][0-9]{2}\s?[A-Z0-9]{4}$/i;
    if (!data.eircode || !eircodePattern.test(data.eircode.trim())) {
        problems.push("eircode");
    }
    if (!data.agentId) {
        problems.push("agentId");
    }


    // "Furnished" is a lease-market concept - a sale listing transfers the property, not its
    // furniture, so this only makes sense to offer as a feature when listingType is "lease".

    if (Array.isArray(data.features) && data.features.includes("furnished") && data.listingType !== "lease") {
        problems.push("features (furnished only applies to lease listings)");
    }

    // I check the image here too so a bad photo fails alongside every other bad field in one
    // response, rather than the user finding out about it in a separate round trip.
    // Base64 text runs about 4/3 the size of the original bytes, so I scale it back down here
    // to get a real size estimate before comparing to my 5MB cap.
    if (data.imageData) {
        if (!["image/jpeg", "image/png"].includes(data.imageType)) {
            problems.push("imageFile (must be JPG or PNG)");
        }
        const approxBytes = data.imageData.length * 0.75;
        if (approxBytes > 5 * 1024 * 1024) {
            problems.push("imageFile (must be under 5MB)");
        }
    }

    return problems;
}

// I chose to store photos as BLOBs in SQLite instead of files on disk, so when I read a
// listing back out I need to turn those bytes back into something an <img> tag can use.
// A data URI does that without needing a separate image-serving route.
// If there's no uploaded photo, I fall back to the seed placeholder URL  to my own /assets/no-image.jpg -
// so a listing with genuinely no photo of its own always has something real to render


function buildImageUrl(row) {
    if (row.image_data) {
        return `data:${row.image_type};base64,${row.image_data.toString("base64")}`;
    }
    return row.image_url || "/assets/no-image.jpg";
}

// Unlocks an agent's private signing key with the password they typed in. I return an
// { status, error } object for the expected failures (no key, no password, wrong password)
// so each route can send it straight back, instead of every route repeating these checks.
// The password is only ever used here, in memory, to unlock the key - it is never stored
// and never written to the console.
function unlockAgentKey(agentId, password) {
    const agent = db.prepare("SELECT id, name, enc_private_key FROM agents WHERE id = ?").get(agentId);
    if (!agent) {
        return { status: 400, error: "Agent not found." };
    }
    if (!agent.enc_private_key) {
        return { status: 400, error: `${agent.name} has no signing key yet. Run "npm run setup-signing" for the starter agents, or add the agent again with a signing password.` };
    }
    if (typeof password !== "string" || password === "") {
        return { status: 400, error: `Enter ${agent.name}'s signing password to stamp this listing.` };
    }
    try {
        return { privateKey: signing.unlockPrivateKey(agent.enc_private_key, password) };
    } catch (err) {
        if (err.code === "BAD_PASSWORD") {
            return { status: 403, error: `Wrong signing password for ${agent.name}. Nothing was saved.` };
        }
        throw err;
    }
}

// What the client needs to draw the badge: the verdict, who stamped it and when, and a short
// fingerprint of the public key the stamp was checked against.
function buildVerification(row, publicKeyPem) {
    return {
        status: signing.verifyListing(row, publicKeyPem),
        signedAt: row.signed_at || null,
        keyFingerprint: signing.fingerprint(publicKeyPem)
    };
}


const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && !parsed.pathname.startsWith("/api")) { 
        return serveStaticFile(req, res);
    }

    // This feeds the first dropdown on the add page I will only need routing_key and area_name
    // here, streets come later once an area is actually picked.
    if (req.method === "GET" && parsed.pathname === "/api/areas") {
        try {
            const areas = db.prepare("SELECT routing_key, area_name FROM dublin_areas ORDER BY routing_key").all();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(areas));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // This is the actual cascading dropdown logic whereby when I filter dublin_streets down to just the
    // routing key the user picked, the street dropdown only ever shows real matches for
    // that area instead of all 58 streets across Dublin.
    if (req.method === "GET" && parsed.pathname.startsWith("/api/areas/") && parsed.pathname.endsWith("/streets")) {
        try {
            const routingKey = parsed.pathname.split("/")[3];
            const streets = db.prepare("SELECT id, street_name FROM dublin_streets WHERE routing_key = ? ORDER BY street_name").all(routingKey);
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(streets));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // These feeds the agent dropdown on the add page.
    if (req.method === "GET" && parsed.pathname === "/api/agents") {
        try {
            // The public key itself is not needed by the dropdowns, so I only send whether the
            // agent has one and its short fingerprint. The encrypted private key never leaves the server.
            const agents = db.prepare("SELECT id, name, phone, email, public_key FROM agents ORDER BY name").all()
                .map(({ public_key, ...agent }) => ({
                    ...agent,
                    has_signing_key: !!public_key,
                    key_fingerprint: signing.fingerprint(public_key)
                }));
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(agents));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // These are the phone/email format checks for an agent's contact details
    // they get typed in, here, when they're first added.  After that they're
    // only ever picked from a dropdown on the listing form

    if (req.method === "POST" && parsed.pathname === "/api/agents") {
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                const problems = [];

                if (!data.name || data.name.trim() === "") {
                    problems.push("name");
                }
                const phone = (data.phone || "").replace(/[\s-]/g, "");
                if (!phone || !PHONE_PATTERN.test(phone)) {
                    problems.push("phone");
                }
                const email = (data.email || "").trim();
                if (!email || !EMAIL_PATTERN.test(email)) {
                    problems.push("email");
                }
                // Every agent needs a signing password, because it is what locks their private key.
                if (!signing.isValidSigningPassword(data.signingPassword)) {
                    problems.push(`signing password (at least ${signing.MIN_PASSWORD_LENGTH} characters)`);
                }
                if (problems.length > 0) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({
                        error: `Please check the following field(s): ${problems.join(", ")}.`
                    }));
                }

                // Each agent needs their own phone and email so a listing's contact details
                // always point at exactly one person - 
                // this checks for a clash first so if someone tries to add a new agent with the same phone/email as an existing one, 
                // a message will be displayed, rather than letting the UNIQUE constraint
                // fail and just returning a raw SQLite error.


                const clash = db.prepare("SELECT id FROM agents WHERE phone = ? OR email = ?").get(phone, email);
                if (clash) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "An agent with that phone number or email already exists." }));
                }

                // The agent's key pair is made here, at the moment they are created. The private
                // key goes into the database already encrypted with their signing password, and
                // the password itself is thrown away as soon as this request finishes.
                const keys = signing.generateAgentKeys(data.signingPassword);
                const result = db.prepare("INSERT INTO agents (name, phone, email, public_key, enc_private_key, key_created_at) VALUES (?, ?, ?, ?, ?, ?)")
                    .run(data.name.trim(), phone, email, keys.publicKeyPem, keys.encPrivateKey, new Date().toISOString());
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    message: "Agent added successfully.",
                    agent: {
                        id: result.lastInsertRowid, name: data.name.trim(), phone, email,
                        has_signing_key: true, key_fingerprint: signing.fingerprint(keys.publicKeyPem)
                    }
                }));
            } catch (err) {
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Server error", details: err.message }));
            }
        });
        return;
    }





    // This is the "checker anyone can use" part. It hands back everything needed to check a
    // listing's stamp without trusting my server: the exact text that was signed, the
    // signature, and the agent's public key. None of that is secret - the public key can only
    // check stamps, it cannot make them.
    if (req.method === "GET" && /^\/api\/listings\/\d+\/verify$/.test(parsed.pathname)) {
        try {
            const listingId = parsed.pathname.split("/")[3];
            const row = db.prepare(`
                SELECT l.*, ag.name AS agent_name, ag.public_key
                FROM property_listings l
                JOIN agents ag ON l.agent_id = ag.id
                WHERE l.id = ?
            `).get(listingId);
            if (!row) {
                res.writeHead(404, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Listing not found" }));
            }
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({
                id: row.id,
                ...buildVerification(row, row.public_key),
                algorithm: "Ed25519",
                agentName: row.agent_name,
                signedData: row.signature ? signing.canonicalPayload(row, row.signed_at) : null,
                signature: row.signature || null,
                publicKey: row.public_key || null
            }));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // I am creating ajoin across area/street/agent becayse the homepage needs all of that displayed on every card.
    // Filters are built up conditionally so a request with no query params still returns
    // everything.
    if (req.method === "GET" && parsed.pathname === "/api/listings") {
        try {
            let query = `
                SELECT
                    l.id, l.title, l.property_type, l.listing_type, l.price, l.bedrooms, l.bathrooms,
                    l.eircode, l.features, l.status, l.date_listed, l.image_url, l.image_data, l.image_type,
                    a.area_name, l.routing_key, l.street_id, l.signature, l.signed_at,
                    s.street_name,
                    ag.id AS agent_id, ag.name AS agent_name, ag.phone AS agent_phone, ag.email AS agent_email,
                    ag.public_key AS agent_public_key
                FROM property_listings l
                JOIN dublin_areas a ON l.routing_key = a.routing_key
                JOIN dublin_streets s ON l.street_id = s.id
                JOIN agents ag ON l.agent_id = ag.id
                WHERE 1=1
            `;
            const params = [];

            if (parsed.searchParams.get("listingType")) {
                query += " AND l.listing_type = ?";
                params.push(parsed.searchParams.get("listingType"));
            }
            if (parsed.searchParams.get("propertyType")) {
                query += " AND l.property_type = ?";
                params.push(parsed.searchParams.get("propertyType"));
            }
            if (parsed.searchParams.get("status")) {
                query += " AND l.status = ?";
                params.push(parsed.searchParams.get("status"));
            }
            if (parsed.searchParams.get("routingKey")) {
                query += " AND l.routing_key = ?";
                params.push(parsed.searchParams.get("routingKey"));
            }
            if (parsed.searchParams.get("maxPrice")) {
                query += " AND l.price <= ?";
                params.push(Number(parsed.searchParams.get("maxPrice")));
            }
            query += " ORDER BY l.date_listed DESC";

            const rows = db.prepare(query).all(...params);
            // features are stored as a JSON string in the column, so I parse it back into a real
            // array here, and I strip the raw image bytes out (replacing them with the data URI
            // from buildImageUrl) so I'm not sending the same image data twice in the response.
            // Every listing's stamp is re-checked here, on every read, against what is in the
            // database at this moment - that is what makes a change made behind the website's
            // back show up straight away. The raw signature and key are left out of this
            // response (the /verify route above serves them), only the verdict is sent.
            const listings = rows.map(r => {
                const { image_data, image_type, signature, signed_at, agent_public_key, ...rest } = r;
                return {
                    ...rest,
                    features: JSON.parse(r.features || "[]"),
                    image_url: buildImageUrl(r),
                    verification: buildVerification(r, agent_public_key)
                };
            });

            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(listings));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    // I validate everything server-side before this ever touches the database
    if (req.method === "POST" && parsed.pathname === "/api/listings") {
        console.log("POST /api/listings received");
        let body = "";
        let tooLarge = false;
        req.on("data", chunk => {
            // I cap the raw body around 7MB (5MB image plus room for the rest of the form) so a
            // request that bypasses my client-side size check can't grow this string unbounded
            // and exhaust memory. I still let the request finish so I can send a clean error back
            // instead of just dropping the connection.
            if (body.length > 7 * 1024 * 1024) {
                tooLarge = true;
                return;
            }
            body += chunk;
        });
        req.on("end", () => {
            if (tooLarge) {
                res.writeHead(413, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Upload too large." }));
            }
            try {
                const data = JSON.parse(body);
                // The signing password and the photo bytes are kept out of the console log.
                console.log("Listing data:", {
                    ...data,
                    imageData: data.imageData ? "[omitted]" : undefined,
                    signingPassword: data.signingPassword ? "[hidden]" : undefined
                });

                const problems = validateListingData(data);
                if (problems.length > 0) {
                    console.log("Validation failed:", problems.join(", "));
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({
                        error: `Please check the following field(s): ${problems.join(", ")}.`
                    }));
                }

                // The dropdown on the client is supposed to only ever show streets that belong
                // to the picked area, but it is safe to validate is because someone could tamper with the page
                // and submit a mismatched pair directly. This re-checks it against the database
                // so a mismatched area/street combination can't get through either way.
                const street = db.prepare("SELECT id FROM dublin_streets WHERE id = ? AND routing_key = ?")
                    .get(data.streetId, data.routingKey);
                if (!street) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "Selected street does not belong to the selected area." }));
                }

                // The agent has to prove it is really them before anything is saved: their
                // signing password unlocks their private key. A wrong password stops here, so a
                // listing can never be posted under an agent's name without that agent's stamp.
                const unlocked = unlockAgentKey(Number(data.agentId), data.signingPassword);
                if (unlocked.error) {
                    res.writeHead(unlocked.status, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: unlocked.error }));
                }

                // Decoding the base64 photo back into real bytes here, right before the insert,
                // so I only do this conversion once validation has already passed.

                
                const imageBuffer = data.imageData ? Buffer.from(data.imageData, "base64") : null;
                const imageType = data.imageData ? data.imageType : null;


                const insert = db.prepare(`
                    INSERT INTO property_listings
                    (title, property_type, listing_type, price, bedrooms, bathrooms, routing_key, street_id, eircode, agent_id, features, status, date_listed, image_url, image_data, image_type)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);
                // The insert and the stamp happen inside one transaction, so a listing is never
                // left saved-but-unsigned if something fails halfway. The stamp is made from the
                // row as it was actually stored (it needs the new id), not from the request body.
                const saveAndSign = db.transaction(() => {
                    const result = insert.run(
                        data.title.trim(), data.propertyType, data.listingType, Number(data.price),
                        Number(data.bedrooms), Number(data.bathrooms), data.routingKey, Number(data.streetId),
                        data.eircode.trim().toUpperCase(), Number(data.agentId),
                        JSON.stringify(data.features || []), "available", new Date().toISOString().split("T")[0],
                        null, imageBuffer, imageType
                    );
                    signing.signListing(db, result.lastInsertRowid, unlocked.privateKey);
                    return result.lastInsertRowid;
                });
                const newListingId = saveAndSign();

                console.log("Listing saved and signed successfully, id:", newListingId);
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({
                    message: "Listing added and signed successfully.",
                    id: newListingId
                }));
            } catch (err) {
                console.error("ERROR:", err.message);
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Server error", details: err.message }));
            }
        });
        return;
    }

    // I only want to touch the fields that were actually sent, so a person updating just the
    // status doesn't have to resend price/bedrooms/etc, and I don't accidentally overwrite
    // something with a value it never meant to send. 
    if (req.method === "PUT" && parsed.pathname.startsWith("/api/listings/")) {
        const listingId = parsed.pathname.split("/").pop();
        console.log("PUT /api/listings received for ID:", listingId);
        let body = "";
        req.on("data", chunk => (body += chunk));
        req.on("end", () => {
            try {
                const data = JSON.parse(body);
                console.log("Update data:", {
                    ...data,
                    imageData: data.imageData ? "[omitted]" : undefined,
                    signingPassword: data.signingPassword ? "[hidden]" : undefined
                });

                // Status is regulated by listing_type - "sold" only makes sense for a sale,
                // "leased" only for a lease - so I need to know what this listing already is
                // before I can say whether the status they're setting is valid for it.
                // listingType itself isn't editable, so this lookup doubles as my existence
                // check too, rather than only discovering a bad ID after building the update.


                const currentListing = db.prepare(`
                    SELECT l.*, ag.public_key
                    FROM property_listings l
                    JOIN agents ag ON l.agent_id = ag.id
                    WHERE l.id = ?
                `).get(listingId);

                if (!currentListing) {
                    res.writeHead(404, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "Listing not found" }));
                }

                // Only the agent who owns the listing can change it, because the change has to
                // be re-stamped with that agent's private key, and only their password unlocks it.
                const unlocked = unlockAgentKey(currentListing.agent_id, data.signingPassword);
                if (unlocked.error) {
                    res.writeHead(unlocked.status, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: unlocked.error }));
                }

                // If the listing has already been tampered with, re-stamping it now would put the
                // agent's genuine stamp on values they never approved. So I stop and make the
                // agent look at it first - the client asks them to confirm, then sends the
                // request again with acknowledgeTampered set.
                if (signing.verifyListing(currentListing, currentListing.public_key) === "tampered" && data.acknowledgeTampered !== true) {
                    res.writeHead(409, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({
                        tampered: true,
                        error: "This listing was changed outside the website after it was last signed. Check every value before signing it again."
                    }));
                }

                const setClauses = [];
                const values = [];

                if (data.title !== undefined) {
                    if (!data.title.trim()) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        return res.end(JSON.stringify({ error: "Title cannot be empty." }));
                    }
                    setClauses.push("title = ?");
                    values.push(data.title.trim());
                }

                if (data.status !== undefined) {
                    const allowedStatuses = STATUS_BY_LISTING_TYPE[currentListing.listing_type];
                    if (!allowedStatuses.includes(data.status)) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        return res.end(JSON.stringify({
                            error: `"${data.status}" isn't valid for a ${currentListing.listing_type} listing. Allowed: ${allowedStatuses.join(", ")}.`
                        }));
                    }
                    setClauses.push("status = ?");
                    values.push(data.status);
                }

                if (data.price !== undefined) {
                    if (isNaN(data.price) || Number(data.price) <= 0) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        return res.end(JSON.stringify({ error: "Price must be a positive number." }));
                    }
                    setClauses.push("price = ?");
                    values.push(Number(data.price));
                }

                if (data.bedrooms !== undefined) {
                    if (isNaN(data.bedrooms) || Number(data.bedrooms) <= 0) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        return res.end(JSON.stringify({ error: "Bedrooms must be a positive number." }));
                    }
                    setClauses.push("bedrooms = ?");
                    values.push(Number(data.bedrooms));
                }

                if (data.bathrooms !== undefined) {
                    if (isNaN(data.bathrooms) || Number(data.bathrooms) <= 0) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        return res.end(JSON.stringify({ error: "Bathrooms must be a positive number." }));
                    }
                    setClauses.push("bathrooms = ?");
                    values.push(Number(data.bathrooms));
                }
                


                // Replacing an existing photo needs the same checks as uploading one the first
                // time 



                if (data.imageData) {
                    if (!["image/jpeg", "image/png"].includes(data.imageType)) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        return res.end(JSON.stringify({ error: "Image must be JPG or PNG." }));
                    }
                    if (data.imageData.length * 0.75 > 5 * 1024 * 1024) {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        return res.end(JSON.stringify({ error: "Image must be under 5MB." }));
                    }
                    setClauses.push("image_data = ?, image_type = ?");
                    values.push(Buffer.from(data.imageData, "base64"), data.imageType);
                }


                // Covers the case where a person wants the listing to have no photo at all
                // anymore, rather than replacing it with a different one.
                if (data.removeImage === true) {
                    setClauses.push("image_data = NULL, image_type = NULL, image_url = NULL");
                }

                // An agent confirming a tampered listing may be re-signing it exactly as it now
                // stands, so that one case is allowed through with nothing else to update.
                if (setClauses.length === 0 && data.acknowledgeTampered !== true) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "No valid fields provided to update." }));
                }

                // The update and the new stamp go in one transaction, so the listing can never
                // end up changed but still carrying the old stamp (which would look tampered).
                const updateAndSign = db.transaction(() => {
                    if (setClauses.length > 0) {
                        values.push(listingId);
                        db.prepare(`UPDATE property_listings SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
                    }
                    signing.signListing(db, listingId, unlocked.privateKey);
                });
                updateAndSign();

                console.log("Listing updated and re-signed successfully");
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ message: "Listing updated and re-signed successfully" }));


            } catch (err) {
                console.error("ERROR:", err.message);
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Server error", details: err.message }));
            }
        });
        return;
    }



    // deleting a listing


    if (req.method === "DELETE" && parsed.pathname.startsWith("/api/listings/")) {
        const listingId = parsed.pathname.split("/").pop();
        console.log("DELETE /api/listings received for ID:", listingId);

        try {
            const result = db.prepare("DELETE FROM property_listings WHERE id = ?").run(listingId);
            if (result.changes === 0) {
                res.writeHead(404, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: "Listing not found" }));
            }
            console.log("Listing deleted successfully");
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ message: "Listing deleted successfully" }));

        } catch (err) {
            console.error("ERROR:", err.message);
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "Server error", details: err.message }));
        }
    }

    // Averaging price per area aggregation the marking scheme is done in SQL rather than pulled raw and averaged in the browser
    //  the bar chart on the analytics page reads straight from this.
    if (req.method === "GET" && parsed.pathname === "/api/stats/by-area") {


        try {
            const rows = db.prepare(`
                SELECT a.area_name, l.routing_key, AVG(l.price) AS avg_price, COUNT(*) AS listing_count
                FROM property_listings l
                JOIN dublin_areas a ON l.routing_key = a.routing_key
                GROUP BY l.routing_key
                ORDER BY avg_price DESC
            `).all();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(rows));

        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }



    // Feeds the pie chart how the current listings split across house/apartment/bungalow/duplex.
    if (req.method === "GET" && parsed.pathname === "/api/stats/by-type") {
        
        try {
            const rows = db.prepare(`
                SELECT property_type, COUNT(*) AS count
                FROM property_listings
                GROUP BY property_type
            `).all();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(rows));


        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }



    // Feeds the status chart lets a person see at a glance how many listings are still
    // available versus sale agreed/sold/withdrawn.
    if (req.method === "GET" && parsed.pathname === "/api/stats/by-status") {
        
        
        try {
            const rows = db.prepare(`
                SELECT status, COUNT(*) AS count
                FROM property_listings
                GROUP BY status
            `).all();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(rows));

        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }


    // Feeds the "listings per agent" chart one row per agent, with sale and lease counted
    // separately via conditional SUM rather than two queries, so the grouped bar chart on the
    // client can plot both series straight off this one response.

    if (req.method === "GET" && parsed.pathname === "/api/stats/by-agent") {
        
        try {
            const rows = db.prepare(`
                SELECT
                    ag.name AS agent_name,
                    SUM(CASE WHEN l.listing_type = 'sale' THEN 1 ELSE 0 END) AS sale_count,
                    SUM(CASE WHEN l.listing_type = 'lease' THEN 1 ELSE 0 END) AS lease_count
                FROM agents ag
                LEFT JOIN property_listings l ON l.agent_id = ag.id
                GROUP BY ag.id
                ORDER BY ag.name
            `).all();
            res.writeHead(200, { "Content-Type": "application/json" });
            return res.end(JSON.stringify(rows));
        } catch (err) {
            res.writeHead(500, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: err.message }));
        }
    }

    serveStaticFile(req, res);
});

server.listen(3000, () => {
    console.log("Server running at http://localhost:3000");
});