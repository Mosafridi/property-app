// Member 1 - Authentication: login sessions
// After a correct password, the browser gets a random "session token" in a cookie
// so the agent doesn't have to send their password with every request.
// Defences from Week 2, slide 27 (Session Hijacking & Token Theft):
//   - HttpOnly cookie: JavaScript can't read it, so an XSS attack can't steal it
//   - A brand-new token on every login: stops "session fixation"
//   - I only store a SHA-256 HASH of the token, so a stolen database can't be
//     used to log in as anyone
//   - Tokens expire after 2 hours

const crypto = require('crypto');

const SESSION_HOURS = 2;
const COOKIE_NAME = 'session';

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Makes a new random 256-bit token, saves its hash, and returns the cookie header.
function createSession(db, agentId) {
    // Clear out this agent's old and expired sessions first
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(Date.now());

    const token = crypto.randomBytes(32).toString('hex'); // 32 random bytes = unguessable
    const expiresAt = Date.now() + SESSION_HOURS * 60 * 60 * 1000;
    db.prepare("INSERT INTO sessions (token_hash, agent_id, expires_at) VALUES (?, ?, ?)")
        .run(hashToken(token), agentId, expiresAt);

    // HttpOnly = hidden from JavaScript. SameSite=Strict = not sent with requests
    // from other websites (helps stop cross-site request forgery).
    // NOTE: in production this would also need "Secure" so it's only sent over
    // HTTPS/TLS (Week 6). I leave it off because the app runs on http://localhost.
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}`;
}

// Reads the session cookie from a request.
function getTokenFromRequest(req) {
    const cookieHeader = req.headers.cookie || '';
    for (const part of cookieHeader.split(';')) {
        const [name, ...rest] = part.trim().split('=');
        if (name === COOKIE_NAME) return rest.join('=');
    }
    return null;
}

// Returns the logged-in agent { id, name, email } or null if not logged in.
function getLoggedInAgent(db, req) {
    const token = getTokenFromRequest(req);
    if (!token) return null;
    return db.prepare(`
        SELECT ag.id, ag.name, ag.email
        FROM sessions s JOIN agents ag ON s.agent_id = ag.id
        WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(hashToken(token), Date.now()) || null;
}

// Deletes the session from the database and returns a cookie that clears the browser's copy.
function destroySession(db, req) {
    const token = getTokenFromRequest(req);
    if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

module.exports = { createSession, getLoggedInAgent, destroySession };
