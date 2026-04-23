// ── CONFIG ────────────────────────────────────────────────────────────────────
// These values get replaced by CI/CD after terraform apply
// The GitHub Actions workflow reads from SSM Parameter Store and injects them

const CONFIG = {
  API_URL:                window.API_URL                || 'https://api.opencourt.fourallthedogs.com',
  COGNITO_USER_POOL_ID:   window.COGNITO_USER_POOL_ID   || 'REPLACE_AFTER_APPLY',
  COGNITO_CLIENT_ID:      window.COGNITO_CLIENT_ID      || 'REPLACE_AFTER_APPLY',
  COGNITO_IDENTITY_POOL:  window.COGNITO_IDENTITY_POOL  || 'REPLACE_AFTER_APPLY',
};

// ── AUTH ──────────────────────────────────────────────────────────────────────

const userPool = new AmazonCognitoIdentity.CognitoUserPool({
  UserPoolId: CONFIG.COGNITO_USER_POOL_ID,
  ClientId:   CONFIG.COGNITO_CLIENT_ID,
});

let currentUser = null;
let idToken = null;
let activeCheckin = null;
let selectedCourt = null;
let activeSport = '';

function getSession() {
  return new Promise((resolve) => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) return resolve(null);

    cognitoUser.getSession((err, session) => {
      if (err || !session.isValid()) return resolve(null);
      idToken = session.getAccessToken().getJwtToken();
      resolve(session);
    });
  });
}

function signOut() {
  const user = userPool.getCurrentUser();
  if (user) user.signOut();
  currentUser = null;
  idToken = null;
  location.reload();
}

// ── MAP SETUP ─────────────────────────────────────────────────────────────────

const map = L.map('map', {
  center: [29.7604, -95.3698], // Houston
  zoom: 13,
  zoomControl: true,
});

// OpenStreetMap tiles — free, no API key
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '© <a href="https://openstreetmap.org">OpenStreetMap</a> contributors',
  maxZoom: 19,
}).addTo(map);

const markers = {};

// ── SPORT ICONS ───────────────────────────────────────────────────────────────

const SPORT_ICONS = {
  tennis:     '🎾',
  basketball: '🏀',
  pickleball: '🏓',
  volleyball: '🏐',
  default:    '🏟️',
};

// ── CREATE CUSTOM MARKER ──────────────────────────────────────────────────────

function createMarker(court) {
  const status = court.status || 'unknown';
  const icon = SPORT_ICONS[court.sport] || SPORT_ICONS.default;

  const markerHtml = `
    <div class="court-marker ${status}">
      <span>${icon}</span>
    </div>
  `;

  const leafletIcon = L.divIcon({
    html: markerHtml,
    className: '',
    iconSize: [32, 32],
    iconAnchor: [16, 32],
    popupAnchor: [0, -32],
  });

  const marker = L.marker([court.lat, court.lng], { icon: leafletIcon });

  marker.on('click', () => openCourtPanel(court));

  return marker;
}

// ── LOAD COURTS ───────────────────────────────────────────────────────────────

async function loadCourts() {
  const center = map.getCenter();
  const zoom = map.getZoom();

  // Only load if zoomed in enough to show meaningful results
  if (zoom < 12) return;

  // Calculate radius from zoom level
  const radius = Math.min(zoom < 13 ? 10000 : zoom < 14 ? 5000 : 3000, 10000);

  try {
    const params = new URLSearchParams({
      lat: center.lat.toFixed(6),
      lng: center.lng.toFixed(6),
      radius,
    });

    if (activeSport) params.append('sport', activeSport);

    const response = await fetch(`${CONFIG.API_URL}/courts?${params}`);
    if (!response.ok) throw new Error(`API error ${response.status}`);

    const { courts } = await response.json();

    // Remove markers no longer in view
    const currentIds = new Set(courts.map(c => c.court_id));
    for (const [id, marker] of Object.entries(markers)) {
      if (!currentIds.has(id)) {
        map.removeLayer(marker);
        delete markers[id];
      }
    }

    // Add or update markers
    for (const court of courts) {
      if (markers[court.court_id]) {
        map.removeLayer(markers[court.court_id]);
      }
      const marker = createMarker(court);
      marker.courtData = court;
      marker.addTo(map);
      markers[court.court_id] = marker;
    }

  } catch (err) {
    console.error('Failed to load courts:', err.message);
  }
}

// Debounce map moves to avoid hammering the API
let loadTimeout;
map.on('moveend', () => {
  clearTimeout(loadTimeout);
  loadTimeout = setTimeout(loadCourts, 400);
});

// ── COURT PANEL ───────────────────────────────────────────────────────────────

function openCourtPanel(court) {
  selectedCourt = court;
  const status = court.status || 'unknown';

  document.getElementById('panelSport').textContent = court.sport?.toUpperCase() || 'COURT';
  document.getElementById('panelName').textContent = court.name || 'Unnamed Court';
  document.getElementById('panelAddress').textContent = court.address || 'Houston, TX';
  document.getElementById('detailSurface').textContent = court.surface || '—';
  document.getElementById('detailCourts').textContent = court.num_courts || 1;
  document.getElementById('detailLights').textContent = court.lighted ? '✓ Yes' : '✗ No';
  document.getElementById('detailReservable').textContent = court.reservable ? '✓ Yes' : 'No — walk-up';
  document.getElementById('detailUpdated').textContent = court.status_updated_at
    ? new Date(court.status_updated_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : 'Never reported';

  // Status badge
  const statusEl = document.getElementById('panelStatus');
  statusEl.className = `status-badge ${status}`;
  const labels = { available: 'Available', in_use: 'In use', unknown: 'Status unknown' };
  statusEl.innerHTML = `<span class="status-dot"></span>${labels[status] || status}`;

  // Action buttons
  renderPanelActions(court, status);

  document.getElementById('courtPanel').classList.add('open');
  document.getElementById('profilePanel').classList.remove('open');
}

function closePanel() {
  document.getElementById('courtPanel').classList.remove('open');
  selectedCourt = null;
}

function renderPanelActions(court, status) {
  const container = document.getElementById('panelActions');

  if (currentUser && activeCheckin?.court_id === court.court_id) {
    // User is checked into THIS court
    container.innerHTML = `
      <button class="action-btn danger" onclick="checkout()">Check out</button>
    `;
  } else if (currentUser && activeCheckin) {
    // User is checked into a different court
    container.innerHTML = `
      <button class="action-btn secondary" disabled>Checked in elsewhere</button>
    `;
  } else if (currentUser) {
    // Logged in, no active checkin
    container.innerHTML = `
      <button class="action-btn primary" onclick="checkin()">Check in here</button>
      <button class="action-btn secondary" onclick="markStatus('available')">Mark available</button>
      <button class="action-btn secondary" onclick="markStatus('in_use')">Mark in use</button>
    `;
  } else {
    // Guest
    container.innerHTML = `
      <button class="action-btn secondary" onclick="markStatus('available')">Mark available</button>
      <button class="action-btn secondary" onclick="markStatus('in_use')">Mark in use</button>
      <a href="login.html" class="action-btn primary" style="text-align:center;display:block;text-decoration:none;padding:12px;">
        Sign in to track sessions
      </a>
    `;
  }
}

// ── CHECK IN / OUT ────────────────────────────────────────────────────────────

async function checkin() {
  if (!idToken || !selectedCourt) return;

  try {
    const response = await fetch(`${CONFIG.API_URL}/checkins`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ court_id: selectedCourt.court_id })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Check-in failed');
    }

    const { checkin } = await response.json();
    activeCheckin = checkin;
    showToast('Checked in! Have a great game 🎾', 'success');
    renderPanelActions(selectedCourt, 'in_use');
    loadCourts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function checkout() {
  if (!idToken || !activeCheckin) return;

  try {
    const response = await fetch(`${CONFIG.API_URL}/checkins/${activeCheckin.checkin_id}/checkout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${idToken}` }
    });

    if (!response.ok) throw new Error('Checkout failed');

    activeCheckin = null;
    showToast('Checked out. Good game!', 'success');
    if (selectedCourt) renderPanelActions(selectedCourt, 'available');
    loadCourts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function markStatus(status) {
  if (!selectedCourt) return;

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (idToken) headers['Authorization'] = `Bearer ${idToken}`;

    const response = await fetch(`${CONFIG.API_URL}/courts/${selectedCourt.court_id}/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ status })
    });

    if (!response.ok) throw new Error('Status update failed');

    const labels = { available: 'Marked as available', in_use: 'Marked as in use' };
    showToast(labels[status] || 'Status updated', 'success');

    // Update the panel
    selectedCourt.status = status;
    openCourtPanel(selectedCourt);
    loadCourts();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// ── PROFILE PANEL ─────────────────────────────────────────────────────────────

async function openProfile() {
  if (!idToken) return;

  document.getElementById('profilePanel').classList.add('open');
  document.getElementById('courtPanel').classList.remove('open');

  try {
    const response = await fetch(`${CONFIG.API_URL}/users/me`, {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (!response.ok) throw new Error('Failed to load profile');

    const { user, stats, badges } = await response.json();

    const initial = (user.username || '?').charAt(0).toUpperCase();
    document.getElementById('profileAvatar').textContent = initial;
    document.getElementById('profileUsername').textContent = user.username;
    document.getElementById('profileSince').textContent =
      'Joined ' + new Date(user.created_at).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    document.getElementById('statCourts').textContent = stats.courts_visited || 0;
    document.getElementById('statHours').textContent = parseFloat(stats.total_hours || 0).toFixed(1);
    document.getElementById('statStreak').textContent = stats.current_streak || 0;
    document.getElementById('statCheckins').textContent = stats.total_checkins || 0;

    const badgesGrid = document.getElementById('badgesGrid');
    if (badges.length) {
      badgesGrid.innerHTML = badges.map(b =>
        `<div class="badge-chip">${b.icon} ${b.name}</div>`
      ).join('');
    } else {
      badgesGrid.innerHTML = '<span style="font-size:13px;color:var(--text3)">No badges yet — get out and play!</span>';
    }

  } catch (err) {
    console.error('Profile load error:', err.message);
  }
}

function closeProfile() {
  document.getElementById('profilePanel').classList.remove('open');
}

// ── SPORT FILTER ──────────────────────────────────────────────────────────────

document.querySelectorAll('.sport-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sport-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    activeSport = btn.dataset.sport;
    // Clear markers and reload
    Object.values(markers).forEach(m => map.removeLayer(m));
    Object.keys(markers).forEach(k => delete markers[k]);
    loadCourts();
  });
});

// ── LOCATE USER ───────────────────────────────────────────────────────────────

function locateUser() {
  if (!navigator.geolocation) {
    showToast('Geolocation not supported', 'error');
    return;
  }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      map.setView([pos.coords.latitude, pos.coords.longitude], 15);
      loadCourts();
    },
    () => showToast('Could not get location', 'error')
  );
}

// ── TOAST ─────────────────────────────────────────────────────────────────────

let toastTimeout;
function showToast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show ${type}`;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => el.classList.remove('show'), 3000);
}

// ── INIT ──────────────────────────────────────────────────────────────────────

async function init() {
  const session = await getSession();

  if (session) {
    // Get user info from token
    const payload = session.getAccessToken().decodePayload();
    currentUser = { username: payload['cognito:username'] || payload.email };

    // Update auth area to show user pill
    document.getElementById('authArea').innerHTML = `
      <div class="user-pill" onclick="openProfile()">
        <div class="user-avatar">${currentUser.username.charAt(0).toUpperCase()}</div>
        <span class="user-name">${currentUser.username}</span>
      </div>
    `;

    // Check for active checkin
    try {
      const response = await fetch(`${CONFIG.API_URL}/checkins/active`, {
        headers: { 'Authorization': `Bearer ${idToken}` }
      });
      if (response.ok) {
        const { checkin } = await response.json();
        activeCheckin = checkin;
      }
    } catch (err) {
      console.error('Failed to load active checkin:', err.message);
    }
  }

  // Load initial courts (Houston center)
  loadCourts();

  // Try to locate user automatically
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        map.setView([pos.coords.latitude, pos.coords.longitude], 14);
        loadCourts();
      },
      () => {} // Silent fail — stay on Houston center
    );
  }
}

init();
