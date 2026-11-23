// ==========================================
// 1. CONFIGURACIÓN DE INDEXEDDB
// ==========================================
const DB_NAME = 'AuraActivitiesDB';
const DB_VERSION = 1;
const STORE_ACTIVITIES = 'activities';
const STORE_SYNC_QUEUE = 'syncQueue';

let db;
let currentFilter = 'all';

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

// ==========================================
// 2. OPERACIONES CRUD EN INDEXEDDB
// ==========================================
function saveActivityDB(activity) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ACTIVITIES], 'readwrite');
    const store = tx.objectStore(STORE_ACTIVITIES);
    const req = store.put(activity);
    req.onsuccess = () => resolve(activity);
    req.onerror = () => reject(req.error);
  });
}

function getAllActivitiesDB() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ACTIVITIES], 'readonly');
    const store = tx.objectStore(STORE_ACTIVITIES);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteActivityDB(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_ACTIVITIES], 'readwrite');
    const store = tx.objectStore(STORE_ACTIVITIES);
    const req = store.delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ==========================================
// 3. COLA DE SINCRONIZACIÓN (OFFLINE -> ONLINE)
// ==========================================
async function enqueueSyncAction(action, payload) {
  const tx = db.transaction([STORE_SYNC_QUEUE], 'readwrite');
  tx.objectStore(STORE_SYNC_QUEUE).add({
    action,
    payload,
    timestamp: Date.now()
  });

  updateSyncBanner();

  // Registrar Background Sync si el navegador lo soporta
  if ('serviceWorker' in navigator && 'SyncManager' in window) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.sync.register('sync-activities');
    } catch (err) {
      console.warn('Background Sync no disponible, se usará respaldo online:', err);
    }
  }
}

async function processSyncQueue() {
  if (!navigator.onLine) return;

  const tx = db.transaction([STORE_SYNC_QUEUE], 'readonly');
  const queueStore = tx.objectStore(STORE_SYNC_QUEUE);
  const getAllReq = queueStore.getAll();

  getAllReq.onsuccess = async () => {
    const pendingItems = getAllReq.result;
    if (pendingItems.length === 0) {
      updateSyncBanner();
      return;
    }

    // Simulación de envío a API REST / Backend
    console.log('Sincronizando cambios locales con el servidor...', pendingItems);
    await new Promise((r) => setTimeout(r, 800));

    // Marcar actividades como sincronizadas en IndexedDB
    const activities = await getAllActivitiesDB();
    for (const act of activities) {
      if (act.pendingSync) {
        act.pendingSync = false;
        await saveActivityDB(act);
      }
    }

    // Vaciar cola de sincronización
    const clearTx = db.transaction([STORE_SYNC_QUEUE], 'readwrite');
    clearTx.objectStore(STORE_SYNC_QUEUE).clear();

    clearTx.oncomplete = () => {
      updateSyncBanner();
      renderActivities();
      showLocalNotification('Sincronización completa', 'Tus actividades offline ya están respaldadas.');
    };
  };
}

function updateSyncBanner() {
  const tx = db.transaction([STORE_SYNC_QUEUE], 'readonly');
  const countReq = tx.objectStore(STORE_SYNC_QUEUE).count();
  countReq.onsuccess = () => {
    const banner = document.getElementById('sync-banner');
    if (countReq.result > 0) {
      banner.classList.remove('hidden');
    } else {
      banner.classList.add('hidden');
    }
  };
}

// ==========================================
// 4. NOTIFICATIONS API & PUSH SUBSCRIPTION
// ==========================================
const btnNotify = document.getElementById('btn-notify-perm');

btnNotify.addEventListener('click', async () => {
  if (!('Notification' in window)) {
    alert('Tu navegador no soporta notificaciones.');
    return;
  }

  const permission = await Notification.requestPermission();
  if (permission === 'granted') {
    btnNotify.textContent = '🔔 Avisos activos';
    showLocalNotification('¡Recordatorios listos!', 'Te avisaremos cuando llegue la hora de tus actividades.');
    subscribeUserToPush();
  } else {
    alert('Permiso de notificaciones denegado.');
  }
});

function showLocalNotification(title, body) {
  if (Notification.permission === 'granted') {
    navigator.serviceWorker.ready.then((reg) => {
      reg.showNotification(title, {
        body,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        vibrate: [150, 50, 150]
      });
    });
  }
}

// Ampliación: Suscripción a Push API para backend
async function subscribeUserToPush() {
  if (!('PushManager' in window)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    // Reemplazar con tu llave pública VAPID generada en el backend (web-push)
    const applicationServerKey = urlBase64ToUint8Array(
      'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'
    );
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey
    });
    console.log('Objeto PushSubscription listo para enviar al backend:', JSON.stringify(subscription));
    // Aquí harías: fetch('/api/subscribe', { method: 'POST', body: JSON.stringify(subscription) })
  } catch (err) {
    console.log('Suscripción Push omitida (requiere llaves VAPID reales en producción):', err.message);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}

// Revisar cada 30 segundos si alguna actividad venció para lanzar notificación
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
// 5. INTERFAZ DE USUARIO Y EVENTOS
// ==========================================
const form = document.getElementById('activity-form');
const listContainer = document.getElementById('activities-list');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const idInput = document.getElementById('activity-id').value;
  const isEditing = Boolean(idInput);
  const isOffline = !navigator.onLine;

  const activity = {
    id: isEditing ? idInput : crypto.randomUUID(),
    title: document.getElementById('title').value.trim(),
    datetime: document.getElementById('datetime').value,
    category: document.getElementById('category').value,
    notes: document.getElementById('notes').value.trim(),
    completed: false,
    notified: false,
    pendingSync: isOffline,
    updatedAt: new Date().toISOString()
  };

  await saveActivityDB(activity);

  if (isOffline) {
    await enqueueSyncAction(isEditing ? 'UPDATE' : 'CREATE', activity);
  }

  resetForm();
  renderActivities();
});

function resetForm() {
  form.reset();
  document.getElementById('activity-id').value = '';
  document.getElementById('form-title').textContent = 'Nueva actividad';
  document.getElementById('btn-submit').textContent = 'Guardar actividad';
  document.getElementById('btn-cancel-edit').classList.add('hidden');
}

document.getElementById('btn-cancel-edit').addEventListener('click', resetForm);

async function renderActivities() {
  const activities = await getAllActivitiesDB();
  activities.sort((a, b) => new Date(a.datetime) - new Date(b.datetime));

  const filtered = activities.filter((act) => {
    if (currentFilter === 'pending') return !act.completed;
    if (currentFilter === 'completed') return act.completed;
    return true;
  });

  if (filtered.length === 0) {
    listContainer.innerHTML = `
      <div class="empty-state">
        <p>No hay actividades en esta vista. ¡Disfruta tu tranquilidad o agrega una arriba!</p>
      </div>`;
    return;
  }

  listContainer.innerHTML = filtered
    .map((act) => {
      const dateFormatted = new Date(act.datetime).toLocaleString('es-MX', {
        dateStyle: 'medium',
        timeStyle: 'short'
      });

      return `
      <article class="activity-item ${act.completed ? 'completed' : ''}">
        <div>
          <div class="activity-meta">
            <span class="tag-cat">${act.category}</span>
            ${act.pendingSync ? '<span class="tag-sync">⏳ Pendiente de sincronizar</span>' : ''}
          </div>
          <h3 class="activity-title">${escapeHTML(act.title)}</h3>
          ${act.notes ? `<p class="activity-notes">${escapeHTML(act.notes)}</p>` : ''}
          <span class="activity-time">🕒 ${dateFormatted}</span>
        </div>
        <div class="item-actions">
          <button class="icon-btn" onclick="toggleComplete('${act.id}')" title="Completar">
            ${act.completed ? '↩️' : '✅'}
          </button>
          <button class="icon-btn" onclick="editActivity('${act.id}')" title="Editar">✏️</button>
          <button class="icon-btn delete" onclick="removeActivity('${act.id}')" title="Eliminar">🗑️</button>
        </div>
      </article>`;
    })
    .join('');
}

window.toggleComplete = async (id) => {
  const activities = await getAllActivitiesDB();
  const act = activities.find((item) => item.id === id);
  if (!act) return;

  act.completed = !act.completed;
  act.pendingSync = !navigator.onLine;
  await saveActivityDB(act);

  if (!navigator.onLine) await enqueueSyncAction('UPDATE', act);
  renderActivities();
};

window.editActivity = async (id) => {
  const activities = await getAllActivitiesDB();
  const act = activities.find((item) => item.id === id);
  if (!act) return;

  document.getElementById('activity-id').value = act.id;
  document.getElementById('title').value = act.title;
  document.getElementById('datetime').value = act.datetime;
  document.getElementById('category').value = act.category;
  document.getElementById('notes').value = act.notes;

  document.getElementById('form-title').textContent = 'Editar actividad';
  document.getElementById('btn-submit').textContent = 'Actualizar cambios';
  document.getElementById('btn-cancel-edit').classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.removeActivity = async (id) => {
  await deleteActivityDB(id);
  if (!navigator.onLine) await enqueueSyncAction('DELETE', { id });
  renderActivities();
};

// Filtros
document.querySelectorAll('.filter-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderActivities();
  });
});

// Estado de red (Online / Offline)
function updateOnlineStatus() {
  const badge = document.getElementById('connection-badge');
  if (navigator.onLine) {
    badge.textContent = 'En línea';
    badge.className = 'badge badge-online';
    processSyncQueue();
  } else {
    badge.textContent = 'Sin conexión';
    badge.className = 'badge badge-offline';
  }
}

window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);
document.getElementById('btn-force-sync').addEventListener('click', processSyncQueue);

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, (tag) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[tag]));
}

// ==========================================
// 6. REGISTRO DEL SERVICE WORKER E INICIO
// ==========================================
window.addEventListener('DOMContentLoaded', async () => {
  await initDB();
  updateOnlineStatus();
  updateSyncBanner();
  renderActivities();

  if (Notification.permission === 'granted') {
    btnNotify.textContent = '🔔 Avisos activos';
  }

  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('./sw.js');
      console.log('Service Worker registrado con éxito');
    } catch (err) {
      console.error('Error al registrar Service Worker:', err);
    }
  }
});