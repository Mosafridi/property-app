// This drives all the charts on the analytics page. 

let areaChartInstance = null;
let typeChartInstance = null;
let statusChartInstance = null;
let bedroomsChartInstance = null;
let agentChartInstance = null;

// I fire all five data requests here and hand each result to its own display function, so
// one slow endpoint doesn't block the others from rendering.

async function loadAnalytics() {
    try {
        const listingsResponse = await fetch("/api/listings");
        const listings = await listingsResponse.json();
        displayCounts(listings);
        displayBedroomsChart(listings);

        const areaResponse = await fetch("/api/stats/by-area");
        const areaStats = await areaResponse.json();
        displayAreaChart(areaStats);

        const typeResponse = await fetch("/api/stats/by-type");
        const typeStats = await typeResponse.json();
        displayTypeChart(typeStats);

        const statusResponse = await fetch("/api/stats/by-status");
        const statusStats = await statusResponse.json();
        displayStatusChart(statusStats);

        const agentResponse = await fetch("/api/stats/by-agent");
        const agentStats = await agentResponse.json();
        displayAgentChart(agentStats);
    } catch (error) {
        console.error("Error loading analytics:", error);
    }
}


// These four numbers at the top give a person a glance of the inventory before they even look at
// a chart. They show the total units listed, how many are still available, and the sale/lease split.
function displayCounts(listings) {
    const total = listings.length;
    const available = listings.filter(l => l.status === "available").length;
    const forSale = listings.filter(l => l.listing_type === "sale").length;
    const forLease = listings.filter(l => l.listing_type === "lease").length;

    document.getElementById("totalCount").textContent = total;
    document.getElementById("availableCount").textContent = available;
    document.getElementById("saleCount").textContent = forSale;
    document.getElementById("leaseCount").textContent = forLease;
}



// I let /api/stats/by-area do the averaging in SQL rather than pulling every listing and
// averaging here - that keeps the aggregation logic on the server side


function displayAreaChart(areaStats) {
    const ctx = document.getElementById("areaChart").getContext("2d");
    if (areaChartInstance) {
        areaChartInstance.destroy();
    }
    if (areaStats.length === 0) {
        ctx.canvas.parentElement.innerHTML = '<div class="empty">No listings yet</div>';
        return;
    }
    areaChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: areaStats.map(a => a.routing_key),
            datasets: [{
                label: "Average Price (EUR)",
                data: areaStats.map(a => Math.round(a.avg_price)),
                backgroundColor: "#2c3e50",
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } }
        }
    });
}


// this shows how the current inventory splits across house/apartment/bungalow/duplex.
function displayTypeChart(typeStats) {
    const colors = ["#2c3e50", "#34495e", "#7f8c8d", "#95a5a6"];
    const ctx = document.getElementById("typeChart").getContext("2d");
    if (typeChartInstance) {
        typeChartInstance.destroy();
    }
    if (typeStats.length === 0) {
        ctx.canvas.parentElement.innerHTML = '<div class="empty">No listings yet</div>';
        return;
    }
    typeChartInstance = new Chart(ctx, {
        type: "pie",
        data: {
            labels: typeStats.map(t => t.property_type),
            datasets: [{
                data: typeStats.map(t => t.count),
                backgroundColor: colors.slice(0, typeStats.length),
                borderWidth: 1,
                borderColor: "#fff"
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: "bottom" } }
        }
    });
}

// Shows how many listings sit in each status, so an agent can see at a glance how much is
// still active versus sold/withdrawn.
function displayStatusChart(statusStats) {
    const ctx = document.getElementById("statusChart").getContext("2d");
    if (statusChartInstance) {
        statusChartInstance.destroy();
    }
    if (statusStats.length === 0) {
        ctx.canvas.parentElement.innerHTML = '<div class="empty">No listings yet</div>';
        return;
    }
    statusChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: statusStats.map(s => s.status),
            datasets: [{
                label: "Listings",
                data: statusStats.map(s => s.count),
                backgroundColor: ["#2c3e50", "#34495e", "#7f8c8d", "#95a5a6", "#bdc3c7"],
                borderWidth: 0
            }]
        },
        options: {
            indexAxis: "y",
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, ticks: { stepSize: 1 } } }
        }
    });
}



// I already have the full listing set in memory from loadAnalytics(), so I group and average
// it right here rather than adding a fifth endpoint
//  This  chart deliberately shows manipulation of already-retrieved JSON happening in the browser, not SQL.
function displayBedroomsChart(listings) {
    const groups = {};
    listings.forEach(l => {
        if (!groups[l.bedrooms]) groups[l.bedrooms] = [];
        groups[l.bedrooms].push(l.price);
    });
    const bedroomCounts = Object.keys(groups).sort((a, b) => a - b);
    const averages = bedroomCounts.map(b => {
        const prices = groups[b];
        return Math.round(prices.reduce((sum, p) => sum + p, 0) / prices.length);
    });

    const ctx = document.getElementById("bedroomsChart").getContext("2d");
    if (bedroomsChartInstance) {
        bedroomsChartInstance.destroy();
    }
    if (bedroomCounts.length === 0) {
        ctx.canvas.parentElement.innerHTML = '<div class="empty">No listings yet</div>';
        return;
    }
    bedroomsChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: bedroomCounts.map(b => `${b} bed`),
            datasets: [{
                label: "Average Price (EUR)",
                data: averages,
                backgroundColor: "#7f8c8d",
                borderWidth: 0
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { y: { beginAtZero: true } }
        }
    });
}

// This is a grouped bar rather than one chart per agent, so it's easy to see at a glance
// whether an agent's book leans toward sales or leases, not just their total listing count.
// /api/stats/by-agent already does the per-type counting in SQL, so this is just plotting it.

function displayAgentChart(agentStats) {
    const ctx = document.getElementById("agentChart").getContext("2d");
    if (agentChartInstance) {
        agentChartInstance.destroy();
    }
    if (agentStats.length === 0) {
        ctx.canvas.parentElement.innerHTML = '<div class="empty">No agents yet</div>';
        return;
    }
    agentChartInstance = new Chart(ctx, {
        type: "bar",
        data: {
            labels: agentStats.map(a => a.agent_name),
            datasets: [
                { label: "For Sale", data: agentStats.map(a => a.sale_count), backgroundColor: "#2c3e50", borderWidth: 0 },
                { label: "For Lease", data: agentStats.map(a => a.lease_count), backgroundColor: "#95a5a6", borderWidth: 0 }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { position: "bottom" } },
            scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } }
        }
    });
}

loadAnalytics(); 