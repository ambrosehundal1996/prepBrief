/**
 * Persist the user's resume in IndexedDB so they do not need to re-upload
 * for each brief (same browser / profile).
 */

const DB_NAME = 'prepbrief'
const DB_VERSION = 1
const STORE = 'savedResume'
const RECORD_KEY = 'current'

function openDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('indexedDB unavailable'))
      return
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onerror = () => reject(req.error || new Error('indexedDB open failed'))
    req.onsuccess = () => resolve(req.result)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
  })
}

/**
 * @returns {Promise<File | null>}
 */
export async function loadStoredResumeFile() {
  try {
    const db = await openDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly')
      const getReq = tx.objectStore(STORE).get(RECORD_KEY)
      getReq.onerror = () => reject(getReq.error)
      getReq.onsuccess = () => {
        const row = getReq.result
        if (!row?.buffer || !row.name) {
          resolve(null)
          return
        }
        const blob = new Blob([row.buffer], {
          type: row.type || 'application/octet-stream',
        })
        try {
          const file = new File([blob], row.name, {
            type: row.type || blob.type,
            lastModified: Number.isFinite(row.lastModified)
              ? row.lastModified
              : Date.now(),
          })
          resolve(file)
        } catch {
          resolve(null)
        }
      }
    })
  } catch {
    return null
  }
}

/**
 * @param {File} file
 * @returns {Promise<void>}
 */
export async function saveStoredResume(file) {
  if (!(file instanceof File)) return
  const buffer = await file.arrayBuffer()
  const db = await openDb()
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error || new Error('aborted'))
    tx.objectStore(STORE).put(
      {
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        buffer,
      },
      RECORD_KEY,
    )
  })
}

export async function clearStoredResume() {
  try {
    const db = await openDb()
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.objectStore(STORE).delete(RECORD_KEY)
    })
  } catch {
    /* ignore */
  }
}
