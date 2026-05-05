(function () {
  const STORAGE_KEY = "lks-map-client-state-v1";
  const MODES = {
    walk: { label: "Jalan Kaki", speed: 5, cost: 0, color: "#2E86DE" },
    bus: { label: "Bus", speed: 60, cost: 500, color: "#8E44AD" },
    train: { label: "Kereta", speed: 100, cost: 700, color: "#27AE60" }
  };

  const mapEl = document.getElementById("map");
  const locationList = document.getElementById("location-list");
  const locationOptions = document.getElementById("location-options");
  const connectStatus = document.getElementById("connect-status");
  const routeFrom = document.getElementById("route-from");
  const routeTo = document.getElementById("route-to");
  const sortMode = document.getElementById("sort-mode");
  const findRouteBtn = document.getElementById("find-route-btn");
  const routeResults = document.getElementById("route-results");
  const zoomInBtn = document.getElementById("zoom-in-btn");
  const zoomOutBtn = document.getElementById("zoom-out-btn");

  const locationModal = document.getElementById("location-modal");
  const locationNameInput = document.getElementById("location-name-input");
  const locationError = document.getElementById("location-error");
  const locationSaveBtn = document.getElementById("location-save-btn");
  const locationCancelBtn = document.getElementById("location-cancel-btn");

  const connectionModal = document.getElementById("connection-modal");
  const connectionTarget = document.getElementById("connection-target");
  const distanceInput = document.getElementById("distance-input");
  const transportSelect = document.getElementById("transport-select");
  const connectionError = document.getElementById("connection-error");
  const connectionSaveBtn = document.getElementById("connection-save-btn");
  const connectionCancelBtn = document.getElementById("connection-cancel-btn");

  let state = loadState();
  let map = null;
  let markerById = new Map();
  let polylines = [];
  let lineLabels = [];
  let pendingLatLng = null;
  let connectingFromId = null;
  let pendingConnectionPair = null;

  init();

  async function init() {
    state = await hydrateInitialLocations(state);
    initMap();
    bindEvents();
    render();
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { locations: [], connections: [] };
      const parsed = JSON.parse(raw);
      return {
        locations: Array.isArray(parsed.locations) ? parsed.locations : [],
        connections: Array.isArray(parsed.connections) ? parsed.connections : []
      };
    } catch (_error) {
      return { locations: [], connections: [] };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  async function hydrateInitialLocations(currentState) {
    if (currentState.locations.length > 0) {
      return currentState;
    }
    try {
      const response = await fetch("./assets/location-data.json");
      const data = await response.json();
      currentState.locations = data.map(function (item, index) {
        return {
          id: "seed-" + index,
          name: item.title,
          lat: item.latitude,
          lng: item.longitude
        };
      });
      saveState();
    } catch (_error) {
      currentState.locations = [];
    }
    return currentState;
  }

  function initMap() {
    map = L.map(mapEl, {
      zoomControl: false,
      scrollWheelZoom: false
    }).setView([-2.2, 118], 5);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19
    }).addTo(map);

    map.on("dblclick", function (event) {
      pendingLatLng = event.latlng;
      locationError.textContent = "";
      locationNameInput.value = "";
      locationModal.classList.remove("hidden");
      locationNameInput.focus();
    });

    map.on("popupopen", function (event) {
      const node = event.popup.getElement();
      if (!node) return;
      const connectButton = node.querySelector(".connect-action");
      const deleteButton = node.querySelector(".delete-action");
      if (connectButton) {
        connectButton.addEventListener("click", function () {
          startConnectMode(connectButton.dataset.locationId);
        });
      }
      if (deleteButton) {
        deleteButton.addEventListener("click", function () {
          deleteLocation(deleteButton.dataset.locationId);
          map.closePopup();
        });
      }
    });

    map.on("click", function (event) {
      if (!connectingFromId) return;
      const nearest = findMarkerByLatLng(event.latlng);
      if (!nearest || nearest.id === connectingFromId) return;
      tryPickConnectTarget(nearest.id);
    });

    map.getContainer().addEventListener("wheel", function (event) {
      if (event.ctrlKey) {
        event.preventDefault();
        if (event.deltaY < 0) map.zoomIn();
        else map.zoomOut();
      }
    }, { passive: false });
  }

  function bindEvents() {
    zoomInBtn.addEventListener("click", function () {
      map.zoomIn();
    });
    zoomOutBtn.addEventListener("click", function () {
      map.zoomOut();
    });

    locationSaveBtn.addEventListener("click", saveLocationFromModal);
    locationCancelBtn.addEventListener("click", closeLocationModal);
    locationNameInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") saveLocationFromModal();
    });

    connectionSaveBtn.addEventListener("click", saveConnectionFromModal);
    connectionCancelBtn.addEventListener("click", closeConnectionModal);
    distanceInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") saveConnectionFromModal();
    });

    routeFrom.addEventListener("input", validateFindRoute);
    routeTo.addEventListener("input", validateFindRoute);
    sortMode.addEventListener("change", findAndRenderRoutes);
    findRouteBtn.addEventListener("click", findAndRenderRoutes);
  }

  function saveLocationFromModal() {
    const name = locationNameInput.value.trim();
    if (!name) {
      locationError.textContent = "Nama lokasi tidak boleh kosong.";
      return;
    }
    const duplicate = state.locations.some(function (loc) {
      return loc.name === name;
    });
    if (duplicate) {
      locationError.textContent = "Nama lokasi sudah ada.";
      return;
    }
    if (!pendingLatLng) return;

    state.locations.push({
      id: generateId("loc"),
      name: name,
      lat: pendingLatLng.lat,
      lng: pendingLatLng.lng
    });
    saveState();
    closeLocationModal();
    render();
  }

  function closeLocationModal() {
    locationModal.classList.add("hidden");
    pendingLatLng = null;
  }

  function startConnectMode(locationId) {
    connectingFromId = locationId;
    const source = getLocationById(locationId);
    connectStatus.textContent = source
      ? "Mode Hubungkan: pilih tujuan dari " + source.name
      : "Mode Hubungkan: Nonaktif";
  }

  function clearConnectMode() {
    connectingFromId = null;
    connectStatus.textContent = "Mode Hubungkan: Nonaktif";
  }

  function tryPickConnectTarget(targetId) {
    if (!connectingFromId || connectingFromId === targetId) return;
    pendingConnectionPair = { fromId: connectingFromId, toId: targetId };
    const from = getLocationById(connectingFromId);
    const to = getLocationById(targetId);
    const autoDistanceKm = map.distance([from.lat, from.lng], [to.lat, to.lng]) / 1000;
    connectionTarget.textContent = from.name + " -> " + to.name;
    distanceInput.value = autoDistanceKm.toFixed(1);
    transportSelect.value = "walk";
    connectionError.textContent = "";
    connectionModal.classList.remove("hidden");
    // Auto-filled from map distance; users may still adjust manually.
    distanceInput.focus();
    distanceInput.select();
  }

  function closeConnectionModal() {
    connectionModal.classList.add("hidden");
    pendingConnectionPair = null;
    clearConnectMode();
  }

  function saveConnectionFromModal() {
    if (!pendingConnectionPair) return;
    const distance = parseFloat(distanceInput.value);
    const mode = transportSelect.value;
    if (!(distance > 0)) {
      connectionError.textContent = "Jarak harus lebih besar dari 0.";
      return;
    }
    const pair = makePairKey(pendingConnectionPair.fromId, pendingConnectionPair.toId);
    const exists = state.connections.some(function (conn) {
      return conn.pair === pair && conn.mode === mode;
    });
    if (exists) {
      connectionError.textContent = "Moda sama untuk pasangan ini sudah ada.";
      return;
    }

    state.connections.push({
      id: generateId("conn"),
      fromId: pendingConnectionPair.fromId,
      toId: pendingConnectionPair.toId,
      pair: pair,
      distance: distance,
      mode: mode
    });
    saveState();
    closeConnectionModal();
    render();
  }

  function deleteLocation(locationId) {
    state.locations = state.locations.filter(function (loc) {
      return loc.id !== locationId;
    });
    state.connections = state.connections.filter(function (conn) {
      return conn.fromId !== locationId && conn.toId !== locationId;
    });
    saveState();
    clearConnectMode();
    render();
  }

  function render() {
    renderLocationPanel();
    renderMarkers();
    renderConnections();
    validateFindRoute();
    if (routeFrom.value.trim() && routeTo.value.trim()) {
      findAndRenderRoutes();
    } else {
      routeResults.innerHTML = "<p class='route-empty'>Belum ada pencarian rute.</p>";
    }
  }

  function renderLocationPanel() {
    locationList.innerHTML = "";
    locationOptions.innerHTML = "";

    state.locations.forEach(function (loc) {
      const li = document.createElement("li");
      li.textContent = loc.name;
      locationList.appendChild(li);

      const option = document.createElement("option");
      option.value = loc.name;
      locationOptions.appendChild(option);
    });
  }

  function renderMarkers() {
    markerById.forEach(function (marker) {
      map.removeLayer(marker);
    });
    markerById.clear();

    state.locations.forEach(function (loc) {
      const marker = L.marker([loc.lat, loc.lng], {
        icon: createRedPinIcon()
      }).addTo(map);
      marker.bindPopup(
        "<div class='marker-popup'>" +
          "<strong>" + escapeHtml(loc.name) + "</strong>" +
          "<div class='actions'>" +
            "<button class='connect-action' data-location-id='" + loc.id + "'>Hubungkan</button>" +
            "<button class='delete-action' data-location-id='" + loc.id + "'>Hapus</button>" +
          "</div>" +
        "</div>"
      );
      markerById.set(loc.id, marker);
    });
  }

  function renderConnections() {
    polylines.forEach(function (line) { map.removeLayer(line); });
    lineLabels.forEach(function (label) { map.removeLayer(label); });
    polylines = [];
    lineLabels = [];

    state.connections.forEach(function (conn) {
      const from = getLocationById(conn.fromId);
      const to = getLocationById(conn.toId);
      if (!from || !to) return;
      const mode = MODES[conn.mode];
      const line = L.polyline([[from.lat, from.lng], [to.lat, to.lng]], {
        color: mode.color,
        weight: 4,
        opacity: 0.9
      }).addTo(map);
      polylines.push(line);

      const midpoint = [(from.lat + to.lat) / 2, (from.lng + to.lng) / 2];
      const label = L.tooltip({
        permanent: true,
        direction: "center",
        className: "line-label-tooltip"
      })
        .setLatLng(midpoint)
        .setContent("<span class='line-label'>" + conn.distance.toFixed(1) + " km</span>")
        .addTo(map);
      lineLabels.push(label);
    });
  }

  function validateFindRoute() {
    const from = getLocationByName(routeFrom.value.trim());
    const to = getLocationByName(routeTo.value.trim());
    findRouteBtn.disabled = !(from && to && from.id !== to.id);
  }

  function findAndRenderRoutes() {
    const from = getLocationByName(routeFrom.value.trim());
    const to = getLocationByName(routeTo.value.trim());
    if (!from || !to || from.id === to.id) {
      routeResults.innerHTML = "<p class='route-empty'>Input lokasi belum valid.</p>";
      return;
    }
    const routes = calculateRoutes(from.id, to.id);
    if (!routes.length) {
      routeResults.innerHTML = "<p class='route-empty'>Rute tidak ditemukan.</p>";
      return;
    }

    const sortBy = sortMode.value;
    routes.sort(function (a, b) {
      return sortBy === "cheapest" ? a.totalCost - b.totalCost : a.totalTime - b.totalTime;
    });

    routeResults.innerHTML = "";
    routes.slice(0, 5).forEach(function (route, index) {
      const item = document.createElement("div");
      item.className = "route-card";
      item.innerHTML =
        "<strong>Rute " + (index + 1) + "</strong><br>" +
        "Urutan: " + route.path.join(" -> ") + "<br>" +
        "Moda: " + route.modes.join(" + ") + "<br>" +
        "Total Jarak: " + route.totalDistance.toFixed(1) + " km<br>" +
        "Estimasi Waktu: " + route.totalTime.toFixed(2) + " jam<br>" +
        "Total Biaya: Rp" + Math.round(route.totalCost).toLocaleString("id-ID");
      routeResults.appendChild(item);
    });
  }

  function calculateRoutes(fromId, toId) {
    const graph = buildGraph();
    const direct = (graph[fromId] || [])
      .filter(function (edge) { return edge.toId === toId; })
      .map(function (edge) {
        return summarizeRoute([fromId, toId], [edge]);
      });

    const transit = [];
    (graph[fromId] || []).forEach(function (edge1) {
      if (edge1.toId === toId) return;
      (graph[edge1.toId] || []).forEach(function (edge2) {
        if (edge2.toId === toId) {
          transit.push(summarizeRoute([fromId, edge1.toId, toId], [edge1, edge2]));
        }
      });
    });
    return direct.concat(transit);
  }

  function summarizeRoute(pathIds, edges) {
    let totalDistance = 0;
    let totalTime = 0;
    let totalCost = 0;
    const modes = [];

    edges.forEach(function (edge) {
      const mode = MODES[edge.mode];
      totalDistance += edge.distance;
      totalTime += edge.distance / mode.speed;
      totalCost += edge.distance * mode.cost;
      modes.push(mode.label);
    });

    return {
      path: pathIds.map(function (id) { return getLocationById(id).name; }),
      modes: modes,
      totalDistance: totalDistance,
      totalTime: totalTime,
      totalCost: totalCost
    };
  }

  function buildGraph() {
    const graph = {};
    state.connections.forEach(function (conn) {
      if (!graph[conn.fromId]) graph[conn.fromId] = [];
      if (!graph[conn.toId]) graph[conn.toId] = [];
      graph[conn.fromId].push({ toId: conn.toId, distance: conn.distance, mode: conn.mode });
      graph[conn.toId].push({ toId: conn.fromId, distance: conn.distance, mode: conn.mode });
    });
    return graph;
  }

  function getLocationById(id) {
    return state.locations.find(function (loc) { return loc.id === id; }) || null;
  }

  function getLocationByName(name) {
    return state.locations.find(function (loc) { return loc.name === name; }) || null;
  }

  function makePairKey(a, b) {
    return [a, b].sort().join("|");
  }

  function generateId(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function createRedPinIcon() {
    return L.divIcon({
      className: "red-pin-icon",
      html:
        "<svg viewBox='0 0 24 34' xmlns='http://www.w3.org/2000/svg'>" +
          "<path d='M12 0C6.5 0 2 4.5 2 10c0 8.3 10 24 10 24s10-15.7 10-24C22 4.5 17.5 0 12 0z' fill='#E74C3C'/>" +
          "<circle cx='12' cy='10' r='4' fill='#fff'/>" +
        "</svg>",
      iconSize: [22, 30],
      iconAnchor: [11, 30]
    });
  }

  function findMarkerByLatLng(latlng) {
    let nearest = null;
    let bestDistance = Infinity;
    state.locations.forEach(function (loc) {
      const distance = map.distance([loc.lat, loc.lng], latlng);
      if (distance < bestDistance && distance < 60000) {
        bestDistance = distance;
        nearest = loc;
      }
    });
    return nearest;
  }

  function escapeHtml(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
