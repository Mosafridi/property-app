// Client-side JS for inbox.html - the agent's inbox of viewing requests.
//
// Nothing is unscrambled in the browser. The server holds the secret key, checks the login
// cookie, and sends back only the logged-in agent's own messages. The cookie is HttpOnly, so
// this script cannot read it - the browser just sends it along with each request by itself.

// Small helper for building elements. Everything that came from a buyer goes in through
// textContent, never innerHTML, so a message like `<img src=x onerror=...>` shows up as plain
// text instead of running in the agent's logged-in browser.
function textElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    return element;
}

function showLoginPanel(message) {
    document.getElementById("inboxPanel").style.display = "none";
    document.getElementById("loginPanel").style.display = "block";
    document.getElementById("loginMessage").textContent = message || "";
    document.getElementById("requests-container").innerHTML = "";
}

// The inbox used to have its own login form here (agent + signing password). It now uses the
// site's one agent login (Member 1's login.html), so loadAgentsForLogin() and logIn() were removed.

// One card per viewing request. A request the server could not open (its tamper seal did
// not match) arrives with opened:false and no content, and gets a warning card instead.
function buildRequestCard(request) {
    const card = document.createElement("div");
    card.className = request.opened ? "request-card" : "request-card unopened";
    card.appendChild(textElement("h3", "", request.listingTitle));
    card.appendChild(textElement("p", "received", `Received ${new Date(request.receivedAt).toLocaleString()}`));

    if (!request.opened) {
        card.appendChild(textElement("p", "warning",
            "⚠ This request could not be opened. It was changed after it was saved, or it was encrypted with a different key, so its contents are not shown."));
        return card;
    }

    card.appendChild(textElement("p", "from", `From ${request.name} | ${request.phone}`));
    card.appendChild(textElement("p", "message", request.message));
    return card;
}

// Asks the server for the inbox. A 401 simply means nobody is logged in (or the session
// ran out), so the login form is shown.
async function loadInbox() {
    try {
        const response = await fetch("/api/inbox");
        const data = await response.json();
        if (response.status === 401) {
            return showLoginPanel("");
        }
        if (!response.ok) {
            return showLoginPanel(`Error: ${data.error}`);
        }

        const count = data.requests.length;
        document.getElementById("inboxSummary").textContent =
            `Logged in as ${data.agent.name}. ${count === 0 ? "No viewing requests yet." : `${count} viewing request${count === 1 ? "" : "s"}, newest first.`}`;

        const container = document.getElementById("requests-container");
        container.innerHTML = "";
        data.requests.forEach(request => container.appendChild(buildRequestCard(request)));

        document.getElementById("loginPanel").style.display = "none";
        document.getElementById("inboxPanel").style.display = "block";
    } catch (error) {
        showLoginPanel(`Error: ${error.message}`);
    }
}

async function logOut() {
    try {
        await fetch("/api/logout", { method: "POST" });
    } finally {
        // The messages are removed from the page straight away, not just hidden, and the page
        // reloads so the nav bar shows "Agent login" again.
        showLoginPanel("");
        window.location.reload();
    }
}

loadInbox();
