// This is the shared client-side JS for both index.html (view/filter/delete) and
// add.html (add a new listing), since they both work with the same listing data shape.

let currentListingId = null;
let originalData = {};
let allListings = [];

// I escape anything user-submitted before it goes into innerHTML. Title is free text an agent
// types in, so without this, a title like `<img src=x onerror=...>` would run as real HTML for
// every visitor on the homepage instead of showing as text. textContent-based fields elsewhere
// don't need this since the browser already treats those as plain text.
function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str ?? "";
    return div.innerHTML;
}
// Formating the price 
// e.g. 450000 will be "€450,000", with "/ month" appended for leases so the price reads correctly
// at a glance without the user having to check the listing type separately.
function formatPrice(price, listingType) {
    const formatted = "€" + Number(price).toLocaleString();
    return listingType === "lease" ? formatted + " / month" : formatted;
}

// This has to match STATUS_BY_LISTING_TYPE in server.js exactly - a sale ends in "sold", a
// lease ends in "leased", and neither status means anything on the other type. 
// I use this to build the status dropdown itself (see openListingModal), not just to reject a bad choice
// after the fact - so a person editing a lease never even sees "Sold" as an option to pick.
const STATUS_BY_LISTING_TYPE = {
    sale: ["available", "sale agreed", "sold", "withdrawn"],
    lease: ["available", "leased", "withdrawn"]
};
const STATUS_LABELS = {
    "available": "Available", "sale agreed": "Sale Agreed", "leased": "Leased",
    "sold": "Sold", "withdrawn": "Withdrawn"
};

// The three verdicts the server can give for a listing's digital signature (see signing.js).
// The server does the actual checking every time listings are loaded, this only decides how
// each verdict is shown.
const VERIFICATION_BADGES = {
    verified: { cssClass: "verified", label: "✔ Verified" },
    tampered: { cssClass: "tampered", label: "⚠ Tampered" },
    unsigned: { cssClass: "unsigned", label: "Unsigned" }
};
function verificationBadge(listing) {
    const badge = VERIFICATION_BADGES[listing.verification?.status] || VERIFICATION_BADGES.unsigned;
    return `<div class="verify-badge ${badge.cssClass}">${badge.label}</div>`;
}
function formatSignedAt(isoString) {
    return isoString ? new Date(isoString).toLocaleString() : "an unknown date";
}

// This is the guiding text: as  a user types, it will value against the same rule the
// server will enforce and turn the field green or red immediately, instead of them finding out only after a failed submit. 
// It's still just a UX layer - server.js runs its own checks independently either way, since a client-side check can always be skipped.

const FIELD_GUIDES = {
    eircode: { test: v => /^[A-Z][0-9]{2}\s?[A-Z0-9]{4}$/i.test(v), hint: "Format: D02 AF30"},
    price: { test: v => !isNaN(v) && Number(v) > 0, hint: "Must be a positive number" },
    bedrooms: { test: v => !isNaN(v) && Number(v) > 0, hint: "Must be a positive whole number" },
    bathrooms: { test: v => !isNaN(v) && Number(v) > 0, hint: "Must be a positive whole number" },
    phone: { test: v => /^(\+353|0)(1\d{7}|8[3-9]\d{7})$/.test(v.replace(/[\s-]/g, "")), hint: "Irish mobile (08X XXX XXXX) or Dublin landline (01 XXX XXXX)" },
    email: { test: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), hint: "A valid email address, e.g. name@dublinhomes.ie" },
    signingPassword: { test: v => v.length >= 8, hint: "At least 8 characters. This locks the agent's private signing key and cannot be recovered if forgotten." },
    // Member 1: same rule as isStrongEnough() in crypto/passwords.js
    password: { test: v => v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v), hint: "At least 8 characters, with a letter and a number. Used to log in." }
};
function attachFieldGuide(inputId, hintId, guideKey) {
    const input = document.getElementById(inputId);
    const hint = document.getElementById(hintId);
    const guide = FIELD_GUIDES[guideKey];
    if (!input || !hint || !guide) return;
    hint.textContent = guide.hint;
    input.addEventListener("input", () => {
        const value = input.value.trim();
        input.classList.remove("field-ok", "field-bad");
        hint.classList.remove("ok", "bad");
        if (value === "") return; // nothing typed yet - just show the neutral hint, no verdict
        const isMatch = guide.test(value);
        input.classList.add(isMatch ? "field-ok" : "field-bad");
        hint.classList.add(isMatch ? "ok" : "bad");
    });
}

// Furnished only makes sense on a lease because a sale transfers the property. 
// so I only show the checkbox only when the "For Lease" optionis picked, and I remove it if the user
// switches back to sale so a stray checked box can't sneak into the sale payload.

function toggleFurnishedOption() {
    const isLease = document.getElementById("listingType").value === "lease";
    const label = document.getElementById("furnishedLabel");
    if (!label) return;
    label.style.display = isLease ? "flex" : "none";
    if (!isLease) label.querySelector("input").checked = false;
}

// ADDING THE LISTING PAGE

// This is the first half of the cascading dropdown - areas load on page load, streets only load once an area is actually picked.

async function loadAreasDropdown() {
    const response = await fetch("/api/areas");
    const areas = await response.json();
    const select = document.getElementById("routingKey");
    areas.forEach(a => {
        const option = document.createElement("option");
        option.value = a.routing_key;
        option.textContent = `${a.routing_key} - ${a.area_name}`;
        select.appendChild(option);
    });
}



// Member 1: the old agent dropdown (loadAgentsDropdown) was removed. A listing now always
// belongs to - and is signed by - the logged-in agent. The server takes the agent from the
// session, not from the form.

// Member 1: shows the listing form only to a logged-in agent, and says who they're listing as.
async function setUpAddPageForLogin() {
    const agent = await authReady;
    if (agent) {
        document.getElementById("listingAsName").textContent = agent.name;
        document.getElementById("add-listing-form").style.display = "block";
    } else {
        document.getElementById("loginRequired").style.display = "block";
    }
}

// This is its own submit handler, separate from addListing(), since adding an agent is a
// separate action with its own endpoint (POST /api/agents) the two forms don't share any
// state beyond the fact that a new agent immediately becomes selectable in the listing form.

async function addAgent(event) {
    event.preventDefault();
    const responseMessage = document.getElementById("agentResponseMessage");
    responseMessage.textContent = "";

    const agentData = {
        name: document.getElementById("agentName").value,
        phone: document.getElementById("agentPhone").value,
        email: document.getElementById("agentEmail").value,
        // Member 1: the login password - the server stores only its scrypt hash.
        password: document.getElementById("agentPassword").value,
        // Used once by the server to lock this agent's new private key, then discarded.
        signingPassword: document.getElementById("agentSigningPassword").value
    };

    try {
        const response = await fetch("/api/agents", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(agentData)
        });
        const data = await response.json();
        if (!response.ok) {
            responseMessage.style.color = "#c0392b";
            responseMessage.textContent = `Error: ${data.error}`;
        } else {
            responseMessage.style.color = "#27ae60";
            responseMessage.textContent = `Agent "${data.agent.name}" added with their own signing key (fingerprint ${data.agent.key_fingerprint}). They can now log in.`;
            document.getElementById("add-agent-form").reset();
        }
    } catch (error) {
        responseMessage.style.color = "#c0392b";
        responseMessage.textContent = `Error: ${error.message}`;
    }
}

// Feeding the "Agent" filter on the homepage  a separate dropdown from the one on the add page,
// since this one needs an "All" option and doesn't need to be required.
async function loadAgentsFilterDropdown() {
    const response = await fetch("/api/agents");
    const agents = await response.json();
    const select = document.getElementById("agentFilter");
    if (!select) return;
    agents.forEach(a => {
        const option = document.createElement("option");
        option.value = a.id;
        option.textContent = a.name;
        select.appendChild(option);
    });
}

// I want the user to see a size/type problem immediately, before they even hit submit, so
// this runs a quick client-side check and shows a local preview. This isn't the real
// validation though - server.js checks type and size again independently, since a client-side
// check alone can always be bypassed.
function previewImage() {
    const fileInput = document.getElementById("imageFile");
    const preview = document.getElementById("imagePreview");
    const errorEl = document.getElementById("imageError");
    errorEl.textContent = "";
    const file = fileInput.files[0];
    if (!file) {
        preview.style.display = "none";
        return;
    }
    if (!["image/jpeg", "image/png"].includes(file.type)) {
        errorEl.textContent = "Only JPG or PNG images are allowed.";
        fileInput.value = "";
        preview.style.display = "none";
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        errorEl.textContent = "Image must be smaller than 5MB.";
        fileInput.value = "";
        preview.style.display = "none";
        return;
    }
    preview.src = URL.createObjectURL(file);
    preview.style.display = "block";
}

// I convert the file to base64 so it can travel inside the same JSON body as the rest of the
// form fields - that keeps the server on one simple JSON.parse() instead of needing a
// multipart form parser just for this one field.
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(",")[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}



// This is the actual cascading step: once an area is picked, I fetch only the streets that
// belong to that routing key so the street dropdown never shows a mismatched option.
async function loadStreetsForArea() {
    const routingKey = document.getElementById("routingKey").value;
    const streetSelect = document.getElementById("streetId");
    streetSelect.innerHTML = '<option value="">Loading...</option>';
    if (!routingKey) {
        streetSelect.innerHTML = '<option value="">Select an area first...</option>';
        return;
    }


    const response = await fetch(`/api/areas/${routingKey}/streets`);
    const streets = await response.json();
    streetSelect.innerHTML = '<option value="">Select a street...</option>';
    streets.forEach(s => {
        const option = document.createElement("option");
        option.value = s.id;
        option.textContent = s.street_name;
        streetSelect.appendChild(option);
    });
}


// I collect the form fields and hand them straight to the server - the server does the real
// validation, I just display whatever it sends back rather than duplicating those rules here.
async function addListing(event) {
    event.preventDefault();
    const responseMessage = document.getElementById("responseMessage");
    const recentListing = document.getElementById("recent-listing");
    responseMessage.textContent = "";
    if (recentListing) recentListing.innerHTML = "";

    const features = Array.from(document.querySelectorAll('input[name="feature"]:checked')).map(cb => cb.value);

    // If a photo was chosen, It will be read into base64 here so it rides along in the same request
    // as everything else  and the server decodes it back into bytes and stores it as a BLOB.
    const fileInput = document.getElementById("imageFile");
    const file = fileInput.files[0];
    let imageData = null;
    let imageType = null;
    if (file) {
        imageData = await fileToBase64(file);
        imageType = file.type;
    }


    const listingData = {
        title: document.getElementById("title").value,
        propertyType: document.getElementById("propertyType").value,
        listingType: document.getElementById("listingType").value,
        price: document.getElementById("price").value,
        bedrooms: document.getElementById("bedrooms").value,
        bathrooms: document.getElementById("bathrooms").value,
        routingKey: document.getElementById("routingKey").value,
        streetId: document.getElementById("streetId").value,
        eircode: document.getElementById("eircode").value,
        // Member 1: no agentId here any more - the server uses the logged-in agent.
        features: features,
        imageData: imageData,
        imageType: imageType,
        // The selected agent's signing password - the server uses it to unlock that agent's
        // private key and stamp the listing. A wrong password means nothing gets saved.
        signingPassword: document.getElementById("signingPassword").value
    };


    try {
        const response = await fetch("/api/listings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(listingData)
        });
        const data = await response.json();
        if (response.status === 401) {
            // Member 1: their session expired (2 hours) or they logged out in another tab
            responseMessage.style.color = "#c0392b";
            responseMessage.textContent = "Your login has expired. Please log in again.";
        } else if (!response.ok) {
            responseMessage.style.color = "#c0392b";
            responseMessage.textContent = `Error: ${data.error}`;
        } else {
            responseMessage.style.color = "#27ae60";
            responseMessage.textContent = `Success: Listing "${listingData.title}" added and signed!`;
            // I already have the image bytes from the upload itself, so I build the preview
            // straight from those instead of making a second round trip to ask the server for it.
            const previewImageUrl = imageData ? `data:${imageType};base64,${imageData}` : "/assets/no-image.png";
            document.getElementById("add-listing-form").reset();
            document.getElementById("streetId").innerHTML = '<option value="">Select an area first...</option>';
            document.getElementById("imagePreview").style.display = "none";
            if (recentListing) {
                // Title is user-submitted free text, so I escape it before it goes into innerHTML -
                // same reasoning as the listing cards below.
                const safeTitle = escapeHtml(listingData.title);
                recentListing.innerHTML = `
                    <div class="listing-card">
                        <img src="${previewImageUrl}" alt="${safeTitle}">
                        <h3>${safeTitle}</h3>
                        <p style="color:#27ae60;font-weight:bold;">✔ Signed with the agent's key</p>
                        <p><strong>Price:</strong> ${formatPrice(listingData.price, listingData.listingType)}</p>
                        <p><strong>Bedrooms:</strong> ${listingData.bedrooms} | <strong>Bathrooms:</strong> ${listingData.bathrooms}</p>
                    </div>
                `;
            }
        }
    } catch (error) {
        responseMessage.style.color = "#c0392b";
        responseMessage.textContent = `Error: ${error.message}`;
    }
}

// HOME / LISTINGS PAGE 

async function loadListings() {
    await authReady; // Member 1: know who's logged in first, so "Your listing" badges are right
    const response = await fetch("/api/listings");
    allListings = await response.json();
    applyFilters();
}

// I keep filtering and sorting entirely client-side since I already have the full listing set
// in memory from loadListings().
function applyFilters() {
    const listingTypeFilter = document.getElementById("listingTypeFilter")?.value || "all";
    const propertyTypeFilter = document.getElementById("propertyTypeFilter")?.value || "all";
    const statusFilter = document.getElementById("statusFilter")?.value || "all";
    const agentFilter = document.getElementById("agentFilter")?.value || "all";
    const bedroomsFilter = document.getElementById("bedroomsFilter")?.value || "all";
    const bathroomsFilter = document.getElementById("bathroomsFilter")?.value || "all";
    const sortBy = document.getElementById("sortBy")?.value || "date-desc";

    let filtered = [...allListings];
    if (listingTypeFilter !== "all") {
        filtered = filtered.filter(l => l.listing_type === listingTypeFilter);
    }
    if (propertyTypeFilter !== "all") {
        filtered = filtered.filter(l => l.property_type === propertyTypeFilter);
    }
    if (statusFilter !== "all") {
        filtered = filtered.filter(l => l.status === statusFilter);
    }
    if (agentFilter !== "all") {
        filtered = filtered.filter(l => String(l.agent_id) === agentFilter);
    }



    // Bedrooms/bathrooms are "at least N" rather than exact matches - that's how every real
    // property site filters this, since someone who wants "3 bed" is almost always fine with
    // 4 too, and an exact-match filter would hide listings they'd actually want to see.
    if (bedroomsFilter !== "all") {
        filtered = filtered.filter(l => l.bedrooms >= Number(bedroomsFilter));
    }
    
    if (bathroomsFilter !== "all") {
        filtered = filtered.filter(l => l.bathrooms >= Number(bathroomsFilter));
    }

    filtered.sort((a, b) => {
        if (sortBy === "date-desc") return new Date(b.date_listed) - new Date(a.date_listed);
        if (sortBy === "date-asc") return new Date(a.date_listed) - new Date(b.date_listed);
        if (sortBy === "price-asc") return a.price - b.price;
        if (sortBy === "price-desc") return b.price - a.price;
        return 0;
    });

    const container = document.getElementById("listings-container");
    if (!container) return; // this runs on other pages too, so I bail out if there's nothing to fill
    if (filtered.length === 0) {
        container.innerHTML = "<p>No listings found.</p>";
        return;
    }

    
    container.innerHTML = filtered.map(l => `
        <div class="listing-card${l.verification?.status === "tampered" ? " tampered" : ""}" onclick="openListingModal(${l.id})">
            <div class="listing-card-inner">
                <div class="status-badge">${escapeHtml(l.status)}</div>
                ${verificationBadge(l)}
                ${currentAgent && l.agent_id === currentAgent.id ? '<div class="owner-badge">Your listing</div>' : ''}
                <img src="${l.image_url || '/assets/no-image.png'}" alt="${escapeHtml(l.title)}">
                <div class="listing-overlay"></div>
            </div>
            <h3>${escapeHtml(l.title)}</h3>
            <p class="price-tag">${formatPrice(l.price, l.listing_type)}</p>
            <p>${l.bedrooms} bed | ${l.bathrooms} bath | ${escapeHtml(l.area_name)}</p>
        </div>
    `).join("");
}

// I pre-fill the modal with the listing's current values and snapshot them into originalData,
// so onFieldChange() below has something to compare against to know what actually changed.

function openListingModal(id) {
    currentListingId = id;
    const listing = allListings.find(l => l.id === id);
    if (!listing) {
        alert("Listing not found");
        return;
    }
    document.getElementById("modalTitle").textContent = listing.title;
    document.getElementById("modalImage").src = listing.image_url || "/assets/no-image.png";
    document.getElementById("modalAddress").textContent = `${listing.street_name}, ${listing.area_name}`;
    document.getElementById("modalEircode").textContent = listing.eircode;
    document.getElementById("modalFeatures").textContent = listing.features.length > 0 ? listing.features.join(", ") : "None listed";
    document.getElementById("modalAgent").textContent = `${listing.agent_name} | ${listing.agent_phone} | ${listing.agent_email}`;

    // The signature verdict for this listing, spelled out in full. textContent is used for the
    // message since it includes the agent's name, which is user-entered text.
    const verification = listing.verification || { status: "unsigned" };
    const verificationBox = document.getElementById("modalVerification");
    const verificationText = document.getElementById("modalVerificationText");
    verificationBox.className = `info-field verification-box ${verification.status}`;
    if (verification.status === "verified") {
        verificationText.textContent = `✔ Verified. Signed by ${listing.agent_name} on ${formatSignedAt(verification.signedAt)}, and nothing has been changed since. Key fingerprint: ${verification.keyFingerprint}`;
    } else if (verification.status === "tampered") {
        verificationText.textContent = `⚠ Warning: this listing was changed after ${listing.agent_name} signed it on ${formatSignedAt(verification.signedAt)}. The details shown here are not what the agent approved.`;
    } else {
        verificationText.textContent = "This listing has not been signed by its agent.";
    }
    document.getElementById("modalProofLink").href = `/api/listings/${listing.id}/verify`;
    document.getElementById("modalSigningPasswordLabel").textContent = `Signing password for ${listing.agent_name} (needed to save changes)`;
    document.getElementById("modalSigningPassword").value = "";

    document.getElementById("modalPrice").value = listing.price;
    document.getElementById("modalBedrooms").value = listing.bedrooms;
    document.getElementById("modalBathrooms").value = listing.bathrooms;

    
    // Building the status options from the listing's own type rather than listing them all in
    // HTML - that's what keeps "Sold" from ever appearing as a choice on a lease, and vice versa.
    const statusSelect = document.getElementById("modalStatusSelect");
    const allowedStatuses = STATUS_BY_LISTING_TYPE[listing.listing_type];
    statusSelect.innerHTML = allowedStatuses.map(s => `<option value="${s}">${STATUS_LABELS[s]}</option>`).join("");
    statusSelect.value = listing.status;

    document.getElementById("modalImageFile").value = "";
    document.getElementById("modalRemoveImage").checked = false;

    // Member 1: only the agent who owns this listing gets the edit controls. Everyone else
    // sees it read-only. (The server enforces this too - this just avoids showing buttons
    // that would only be refused.)
    const canEdit = currentAgent && currentAgent.id === listing.agent_id;
    ["modalPrice", "modalBedrooms", "modalBathrooms", "modalStatusSelect"].forEach(id => {
        document.getElementById(id).disabled = !canEdit;
    });
    document.getElementById("modalPhotoControls").style.display = canEdit ? "block" : "none";
    document.getElementById("modalEditControls").style.display = canEdit ? "block" : "none";
    const ownerNote = document.getElementById("modalOwnerNote");
    if (canEdit) {
        ownerNote.style.display = "none";
    } else {
        ownerNote.style.display = "block";
        ownerNote.textContent = currentAgent
            ? `This listing belongs to ${listing.agent_name}. Only they can edit it.`
            : "Agents: log in to edit your own listings.";
    }

    originalData = {
        price: String(listing.price),
        bedrooms: String(listing.bedrooms),
        bathrooms: String(listing.bathrooms),
        status: listing.status
    };

    document.getElementById("updateBtn").disabled = true;
    document.getElementById("listingModal").style.display = "flex";
}

function closeListingModal() {
    document.getElementById("listingModal").style.display = "none";
    currentListingId = null;
    originalData = {};
}

// I only want Save Changes enabled once something has actually changed, so the a user can't
// submit a no-op update. 
function onFieldChange() {
    const priceChanged = document.getElementById("modalPrice").value !== originalData.price;
    const bedroomsChanged = document.getElementById("modalBedrooms").value !== originalData.bedrooms;
    const bathroomsChanged = document.getElementById("modalBathrooms").value !== originalData.bathrooms;
    const statusChanged = document.getElementById("modalStatusSelect").value !== originalData.status;
    const imageChanged = document.getElementById("modalImageFile").files.length > 0;
    const removeImageChecked = document.getElementById("modalRemoveImage").checked;

    const hasChanges = priceChanged || bedroomsChanged || bathroomsChanged || statusChanged || imageChanged || removeImageChecked;
    document.getElementById("updateBtn").disabled = !hasChanges;
}

// I only add a field to the payload if it actually changed from originalData, so the PUT
// request - and the server's partial update - only touches what the agent actually edited.
async function updateListing() {
    if (!currentListingId) return;

    const payload = {};
    const price = document.getElementById("modalPrice").value;
    const bedrooms = document.getElementById("modalBedrooms").value;
    const bathrooms = document.getElementById("modalBathrooms").value;
    const status = document.getElementById("modalStatusSelect").value;
    const removeImage = document.getElementById("modalRemoveImage").checked;
    const imageFile = document.getElementById("modalImageFile").files[0];

    if (price !== originalData.price) payload.price = price;
    if (bedrooms !== originalData.bedrooms) payload.bedrooms = bedrooms;
    if (bathrooms !== originalData.bathrooms) payload.bathrooms = bathrooms;
    if (status !== originalData.status) payload.status = status;
    if (removeImage) payload.removeImage = true;
    if (imageFile && !removeImage) {
        payload.imageData = await fileToBase64(imageFile);
        payload.imageType = imageFile.type;
    }

    // Any change has to be re-stamped by the listing's own agent, so their signing password
    // goes along with the update. Without it the server refuses to save anything.
    const signingPassword = document.getElementById("modalSigningPassword").value;
    if (!signingPassword) {
        alert("Enter the agent's signing password to save and re-sign this listing.");
        return;
    }
    payload.signingPassword = signingPassword;

    const sendUpdate = () => fetch(`/api/listings/${currentListingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    try {
        let response = await sendUpdate();
        let data = await response.json();

        // The server refuses to re-sign a listing that has been tampered with until the agent
        // has been warned, so a genuine stamp never lands on values they did not check.
        if (response.status === 409 && data.tampered) {
            const goAhead = confirm(`${data.error}\n\nSign the listing as it is shown now, with your changes?`);
            if (!goAhead) return;
            payload.acknowledgeTampered = true;
            response = await sendUpdate();
            data = await response.json();
        }

        if (response.ok) {
            closeListingModal();
            loadListings();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

async function confirmDelete() {
    if (!currentListingId) return;
    const title = document.getElementById("modalTitle").textContent;
    if (!confirm(`Are you sure you want to delete "${title}"?`)) {
        return;
    }
    try {
        const response = await fetch(`/api/listings/${currentListingId}`, { method: "DELETE" });
        const data = await response.json();
        if (response.ok) {
            closeListingModal();
            loadListings();
        } else {
            alert(`Error: ${data.error}`);
        }
    } catch (error) {
        alert(`Error: ${error.message}`);
    }
}

// I decide what to load based on which page is currently open,
// so this one shared file can drive both index.html and add.html without extra config.
if (window.location.pathname.includes("index.html") || window.location.pathname === "/") {
    loadListings();
    loadAgentsFilterDropdown();
    attachFieldGuide("modalPrice", "modalPriceHint", "price");
    attachFieldGuide("modalBedrooms", "modalBedroomsHint", "bedrooms");
    attachFieldGuide("modalBathrooms", "modalBathroomsHint", "bathrooms");
}
if (window.location.pathname.includes("add.html")) {
    loadAreasDropdown();
    setUpAddPageForLogin(); // Member 1 (replaces loadAgentsDropdown)
    attachFieldGuide("price", "priceHint", "price");
    attachFieldGuide("bedrooms", "bedroomsHint", "bedrooms");
    attachFieldGuide("bathrooms", "bathroomsHint", "bathrooms");
    attachFieldGuide("eircode", "eircodeHint", "eircode");
    attachFieldGuide("agentPhone", "agentPhoneHint", "phone");
    attachFieldGuide("agentEmail", "agentEmailHint", "email");
    attachFieldGuide("agentSigningPassword", "agentSigningPasswordHint", "signingPassword");
    attachFieldGuide("agentPassword", "agentPasswordHint", "password"); // Member 1
}