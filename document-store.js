(() => {
  const DB_NAME = "gp-records-files";
  const DB_VERSION = 1;
  const STORE_NAME = "documents";

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Local document storage could not be opened."));
    });
  }

  async function runTransaction(mode, operation) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error || new Error("Local document storage failed."));
      transaction.oncomplete = () => { database.close(); resolve(result); };
      transaction.onerror = () => { database.close(); reject(transaction.error || new Error("Local document storage failed.")); };
      transaction.onabort = () => { database.close(); reject(transaction.error || new Error("Local document storage was interrupted.")); };
    });
  }

  window.DocumentStore = {
    put(id, blob) { return runTransaction("readwrite", store => store.put(blob, id)); },
    get(id) { return runTransaction("readonly", store => store.get(id)); }
  };
})();
