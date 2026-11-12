// Member 1 - Authentication: shared login status for every page.
// The session cookie is HttpOnly, so this script can't read it (that's the point -
// an XSS attack can't steal it either). Instead I ask the server "who am I?" via
// /api/me, and the browser sends the cookie along automatically.
//
// IMPORTANT: this only changes what the page SHOWS. The real protection is in
// server.js, which checks the session on every add/edit/delete. Someone could
// edit this file in their browser and un-hide the buttons, and the server would
// still refuse them with a 401/403.

let currentAgent = null;

// Other scripts (app.js) wait on this so they know who's logged in before drawing anything.
const authReady = (async () => {
    try {
        const response = await fetch("/api/me");
        const data = await response.json();
        currentAgent = data.agent;
    } catch (error) {
        currentAgent = null;
    }
    renderAuthNav();
    return currentAgent;
})();

// Adds "Logged in as X | Log out" or "Agent login" to the right of the nav bar.
function renderAuthNav() {
    const nav = document.querySelector("nav");
    if (!nav) return;
    const area = document.createElement("span");
    area.className = "auth-status";

    if (currentAgent) {
        const who = document.createElement("span");
        who.textContent = `Logged in as ${currentAgent.name}`; // textContent = safe from XSS
        const logoutLink = document.createElement("a");
        logoutLink.href = "#";
        logoutLink.textContent = "Log out";
        logoutLink.addEventListener("click", logout);
        area.append(who, logoutLink);
    } else {
        // ?next= remembers which page they were on, so login can send them back to it
        const page = window.location.pathname.split("/").pop() || "index.html";
        const loginLink = document.createElement("a");
        loginLink.href = `login.html?next=${encodeURIComponent(page)}`;
        loginLink.textContent = "Agent login";
        area.append(loginLink);
    }
    nav.appendChild(area);
}

// Tells the server to delete the session, then reloads so the page redraws as logged out.
async function logout(event) {
    if (event) event.preventDefault();
    await fetch("/api/logout", { method: "POST" });
    window.location.reload();
}
