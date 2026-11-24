const DB_NAME = 'AuraActivitiesDB';
const DB_VERSION = 1;
const STORE_ACTIVITIES = 'activities';
const STORE_SYNC_QUEUE = 'syncQueue';

let db;
let currentFilter = 'all';

// ==========================================
// 1. INDEXEDDB
// ==========================================
function initDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const database = event.target.result;
      if (!database.objectStoreNames.contains(STORE_ACTIVITIES)) {
        database.createObjectStore(STORE_ACTIVITIES, { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains(STORE_SYNC_QUEUE)) {
        database.createObjectStore(STORE_SYNC_QUEUE, { keyPath: 'queueId', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => {
      db = event.target.result;
      resolve(db);
    };

    request.onerror = (event) => reject(event.target.error);
  });
}

function saveActivityDB(activity) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ACTIVITIES], 'readwrite');
    const req = tx.objectStore(STORE_ACTIVITIES).put(activity);
    req.onsuccess = () => resolve(activity);
    req.onerror = () => reject(req.error);
  });
}

function getAllActivitiesDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ACTIVITIES], 'readonly');
    const req = tx.objectStore(STORE_ACTIVITIES).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteActivityDB(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ACTIVITIES], 'readwrite');
    const req = tx.objectStore(STORE_ACTIVITIES).delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ==========================================
// 2. COLA DE SINCRONIZACIÓN
// ==========================================
async function enqueueSyncAction(action, payload) {
  const tx = db.transaction([STORE_SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORE_SYNC_QUEUE).add({
    action,
    payload,
    timestamp: Date.now()
  });

  updateSyncUI();

  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('sync-activities');
    } catch (err) {
      console.warn('Background Sync no disponible:', err);
    }
  }
}

async function processSyncQueue() {
  if (!navigator.onLine || !db) return;

  const tx = db.transaction([STORE_SYNC_QUEUE], 'readonly');
  const getAllReq = tx.objectStore(STORE_SYNC_QUEUE).getAll();

  getAllReq.onsuccess = async () => {
    const pendingItems = getAllReq.result;
    if (pendingItems.length === 0) {
      updateSyncUI();
      return;
    }

    await new Promise((r) => setTimeout(r, 600));

    const activities = await getAllActivitiesDB();
    for (const act of activities) {
      if (act.pendingSync) {
        act.pendingSync = false;
        await saveActivityDB(act);
      }
    }

    const clearTx = db.transaction([STORE_SYNC_QUEUE], 'readwrite');
    clearTx.objectStore(STORE_SYNC_QUEUE).clear();

    clearTx.oncomplete = () => {
      updateSyncUI();
      renderDashboard();
      showLocalNotification('Sincronización completada', 'Tus cambios offline se han sincronizado.');
    };
  };
}

function updateSyncUI() {
  if (!db) return;
  const tx = db.transaction([STORE_SYNC_QUEUE], 'readonly');
  const countReq = tx.objectStore(STORE_SYNC_QUEUE).count();
  countReq.onsuccess = () => {
    const count = countReq.result;
    document.getElementById('stat-sync').textContent = count;
    const banner = document.getElementById('sync-banner');
    banner.classList.toggle('hidden', count === 0);
  };
}

// ==========================================
// 3. NOTIFICATIONS API & PUSH
// ==========================================
const btnNotify = document.getElementById('btn-notify-perm');

function showLocalNotification(title, body) {
  if (Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then((reg) => {
      reg.showNotification(title, {
        body,
        icon: './icon-192.png',
        badge: './icon-192.png'
      });
    });
  }
}

async function subscribeUserToPush() {
  if (!('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const applicationServerKey = urlBase64ToUint8Array(
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
    );
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    console.log('PushSubscription:', JSON.stringify(subscription));
  } catch (err) {
    console.log('Push pendiente de llaves VAPID reales:', err.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

setInterval(async () => {
  if (!db || Notification.permission !== 'granted') return;
  const activities = await getAllActivitiesDB();
  const now = new Date();
  for (const act of activities) {
    if (!act.completed && !act.notified && new Date(act.datetime) <= now) {
      showLocalNotification(`Recordatorio: ${act.title}`, act.notes || `Categoría: ${act.category}`);
      act.notified = true;
      await saveActivityDB(act);
    }
  }
}, 30000);

// ==========================================
// 4. CRUD, VISTA PREVIA Y RENDERIZADO
// ==========================================
const form = document.getElementById('activity-form');
const tbody = document.getElementById('activities-tbody');

function formPreviewText() {
  const title = document.getElementById('title').value.trim() || 'Tu próxima actividad';
  const body = document.getElementById('notes').value.trim() || 'Agrega una nota o descripción para mostrar en el recordatorio.';
  return { title, body };
}

document.getElementById('btn-preview').addEventListener('click', () => {
  const { title, body } = formPreviewText();
  showLocalNotification(title, body);
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const idInput = document.getElementById('activity-id').value;
  const isEditing = Boolean(idInput);
  const isOffline = !navigator.onLine;
  const existing = isEditing
    ? (await getAllActivitiesDB()).find((a) => a.id === idInput)
    : null;

  const activity = {
    id: isEditing ? idInput : crypto.randomUUID(),
    title: document.getElementById('title').value.trim(),
    datetime: document.getElementById('datetime').value,
    category: document.getElementById('category').value,
    notes: document.getElementById('notes').value.trim(),
    completed: existing ? existing.completed : false,
    notified: existing ? existing.notified : false,
    pendingSync: Boolean(isOffline || (existing && existing.pendingSync)),
    updatedAt: new Date().toISOString()
  };

  await saveActivityDB(activity);
  if (isOffline) {
    await enqueueSyncAction(isEditing ? 'UPDATE' : 'CREATE', activity);
  }

  resetForm();
  renderDashboard();
});

function resetForm() {
  form.reset();
  document.getElementById('activity-id').value = '';
  document.getElementById('form-title').textContent = 'Nueva actividad';
  document.getElementById('btn-submit').textContent = 'Guardar actividad';
  document.getElementById('btn-cancel-edit').classList.add('hidden');
}

document.getElementById('btn-cancel-edit').addEventListener('click', resetForm);

async function renderDashboard() {
  const all = await getAllActivitiesDB();
  activitiesCache = all;
  renderActivityCalendar();
  all.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  const completedCount = all.filter((a) => a.completed).length;
  const pendingCount = all.filter((a) => !a.completed).length;

  document.getElementById('stat-completed').textContent = completedCount;
  document.getElementById('stat-pending').textContent = pendingCount;
  document.getElementById('stat-total').textContent = all.length;

  document.getElementById('badge-all').textContent = all.length;
  document.getElementById('badge-pending').textContent = pendingCount;
  document.getElementById('badge-completed').textContent = completedCount;

  updateSyncUI();

  const filtered = all.filter((act) => {
    if (currentFilter === 'pending') return !act.completed;
    if (currentFilter === 'completed') return act.completed;
    return true;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-row">No hay actividades en este filtro. ¡Agrega una desde el formulario!</td>
      </tr>`;
    return;
  }

  tbody.innerHTML = filtered
    .map((act, idx) => {
      const dtFmt = new Date(act.datetime).toLocaleString('es-MX', {
        dateStyle: 'short',
        timeStyle: 'short'
      });
      const statusBadge = act.completed
        ? '<span class="badge status-done">Completada</span>'
        : act.pendingSync
        ? '<span class="badge status-pending">Pendiente sync</span>'
        : '<span class="badge status-pending">Pendiente</span>';

      return `
      <tr class="${act.completed ? 'row-completed' : ''}">
        <td>${idx + 1}</td>
        <td>${dtFmt}</td>
        <td><strong>${escapeHTML(act.title)}</strong></td>
        <td><span class="tag-pill">${escapeHTML(act.category)}</span></td>
        <td>${escapeHTML(act.notes || '—')}</td>
        <td>${statusBadge}</td>
        <td class="td-right">
          <div class="action-btns">
            <button class="btn-icon btn-icon-check" onclick="toggleComplete('${act.id}')" title="Completar">
              ${act.completed ? '↩' : '✓'}
            </button>
            <button class="btn-icon btn-icon-edit" onclick="editActivity('${act.id}')" title="Editar">✎</button>
            <button class="btn-icon btn-icon-del" onclick="removeActivity('${act.id}')" title="Eliminar">🗑</button>
          </div>
        </td>
      </tr>`;
    })
    .join('');
}

window.toggleComplete = async (id) => {
  const all = await getAllActivitiesDB();
  const act = all.find((x) => x.id === id);
  if (!act) return;
  act.completed = !act.completed;
  act.pendingSync = !navigator.onLine;
  await saveActivityDB(act);
  if (!navigator.onLine) await enqueueSyncAction('UPDATE', act);
  renderDashboard();
};

window.editActivity = async (id) => {
  const all = await getAllActivitiesDB();
  const act = all.find((x) => x.id === id);
  if (!act) return;

  document.getElementById('activity-id').value = act.id;
  document.getElementById('title').value = act.title;
  document.getElementById('datetime').value = act.datetime;
  document.getElementById('category').value = act.category;
  document.getElementById('notes').value = act.notes;

  document.getElementById('form-title').textContent = 'Editar actividad';
  document.getElementById('btn-submit').textContent = 'Actualizar';
  document.getElementById('btn-cancel-edit').classList.remove('hidden');
  window.scrollTo({ top: document.querySelector('.bottom-grid').offsetTop - 20, behavior: 'smooth' });
};

window.removeActivity = async (id) => {
  await deleteActivityDB(id);
  if (!navigator.onLine) await enqueueSyncAction('DELETE', { id });
  renderDashboard();
};

document.getElementById('btn-clear-completed').addEventListener('click', async () => {
  const all = await getAllActivitiesDB();
  for (const act of all) {
    if (act.completed) {
      await deleteActivityDB(act.id);
      if (!navigator.onLine) await enqueueSyncAction('DELETE', { id: act.id });
    }
  }
  renderDashboard();
});

// Mensajes del Service Worker (p. ej. Background Sync)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'run-sync') processSyncQueue();
  });
}

// ==========================================
// 5. CALENDARIO DE ACTIVIDADES
// ==========================================
const calGrid = document.getElementById('cal-grid');
const calMonthLabel = document.getElementById('cal-month-label');
const dayList = document.getElementById('day-activities');
const calState = { year: new Date().getFullYear(), month: new Date().getMonth() };
let selectedDayKey = toDateKey(new Date());
let activitiesCache = [];

const MONTHS_ES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const DOW_ES = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];

function toDateKey(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function renderActivityCalendar() {
  const { year, month } = calState;
  calMonthLabel.textContent = `${MONTHS_ES[month]} ${year}`;

  const catsByDay = {};
  for (const act of activitiesCache) {
    const key = (act.datetime || '').slice(0, 10);
    if (key) (catsByDay[key] = catsByDay[key] || []).push(act.category || 'Personal');
  }

  const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // lunes = 0
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const todayKey = toDateKey(new Date());

  const catSlug = (cat) => String(cat).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  let html = DOW_ES.map((d) => `<span class="cal-dow">${d}</span>`).join('');
  for (let i = 0; i < firstWeekday; i++) html += '<span></span>';

  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const cats = catsByDay[key] || [];
    const classes = ['cal-day'];
    if (key === todayKey) classes.push('today');
    if (key === selectedDayKey) classes.push('selected');
    if (cats.length > 0) classes.push('has-activities');

    const dots = cats.slice(0, 3)
      .map((cat) => `<i class="cal-dot dot-${catSlug(cat)}"></i>`)
      .join('');
    const extra = cats.length > 3 ? `<span class="cal-dot-more">+${cats.length - 3}</span>` : '';

    html += `<button type="button" class="${classes.join(' ')}" data-date="${key}"><span>${day}</span><span class="cal-dots">${dots}${extra}</span></button>`;
  }

  calGrid.innerHTML = html;
  renderDayList();
}

function renderDayList() {
  const dayActs = activitiesCache
    .filter((a) => (a.datetime || '').slice(0, 10) === selectedDayKey)
    .sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  if (dayActs.length === 0) {
    dayList.innerHTML = '<p class="day-empty">No hay actividades programadas para este día.</p>';
    return;
  }

  dayList.innerHTML = dayActs
    .map((act) => {
      const time = act.datetime ? new Date(act.datetime).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' }) : '—';
      return `
      <div class="day-item ${act.completed ? 'day-item-done' : ''}">
        <span class="day-item-time">${time}</span>
        <div class="day-item-body">
          <span class="day-item-title">${escapeHTML(act.title)}</span>
          <span class="tag-pill">${escapeHTML(act.category)}</span>
        </div>
        ${act.completed ? '<span class="badge status-done">✓</span>' : ''}
      </div>`;
    })
    .join('');
}

calGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.cal-day');
  if (!btn) return;
  selectedDayKey = btn.dataset.date;
  renderActivityCalendar();
});

document.getElementById('btn-cal-prev').addEventListener('click', () => {
  calState.month -= 1;
  if (calState.month < 0) { calState.month = 11; calState.year -= 1; }
  renderActivityCalendar();
});

document.getElementById('btn-cal-next').addEventListener('click', () => {
  calState.month += 1;
  if (calState.month > 11) { calState.month = 0; calState.year += 1; }
  renderActivityCalendar();
});

renderActivityCalendar();

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderDashboard();
  });
});

function updateOnlineStatus() {
  const badge = document.getElementById('connection-badge');
  const dot = document.getElementById('connection-dot');

  if (navigator.onLine) {
    badge.textContent = 'En línea';
    dot.className = 'status-dot dot-online';
    processSyncQueue();
  } else {
    badge.textContent = 'Sin conexión';
    dot.className = 'status-dot dot-offline';
  }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
document.getElementById('btn-force-sync').addEventListener('click', processSyncQueue);

function escapeHTML(str) {
  return String(str).replace(/[&<>'"]/g, (tag) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag]));
}

window.addEventListener('DOMContentLoaded', async () => {
  document.getElementById('current-date-label').textContent = new Date().toLocaleDateString('es-MX', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  await initDB();
  updateOnlineStatus();
  renderDashboard();

  if (Notification.permission === 'granted') {
  syncBellState();
}

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
    } catch (err) {
      console.error('Error al registrar Service Worker:', err);
    }
  }
});

function syncBellState() {
  if (!('Notification' in window)) {
    btnNotify.classList.add('is-denied');
    btnNotify.title = 'Notificaciones no soportadas';
    return;
  }

  btnNotify.classList.remove('is-active', 'is-denied');

  if (Notification.permission === 'granted') {
    btnNotify.classList.add('is-active');
    btnNotify.textContent = '🔔';
    btnNotify.title = 'Notificaciones activas (clic para probar)';
  } else if (Notification.permission === 'denied') {
    btnNotify.classList.add('is-denied');
    btnNotify.textContent = '🔕';
    btnNotify.title = 'Notificaciones bloqueadas en el navegador';
  } else {
    btnNotify.textContent = '🔔';
    btnNotify.title = 'Activar notificaciones';
  }
}

btnNotify.addEventListener('click', async () => {
  if (!('Notification' in window)) return;

  if (Notification.permission === 'granted') {
    showLocalNotification('Recordatorios activos', 'Las notificaciones están funcionando correctamente.');
    return;
  }

  const permission = await Notification.requestPermission();
  syncBellState();

  if (permission === 'granted') {
    showLocalNotification('¡Avisos activados!', 'Recibirás recordatorios cuando llegue la hora.');
    subscribeUserToPush();
  }
});