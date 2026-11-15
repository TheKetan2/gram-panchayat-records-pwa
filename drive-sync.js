(() => {
  const CLIENT_ID = "456943432378-k2htoe0h1psiep1d3rdljueihts20k1o.apps.googleusercontent.com";
  const SYNC_STATE_KEY = "gp-drive-sync-state";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const FOLDER_NAME = "Gram Panchayat Records PWA";
  const BACKUP_NAME = "gram-panchayat-records-sync.json";

  function readState() {
    try { return JSON.parse(localStorage.getItem(SYNC_STATE_KEY) || "null"); }
    catch { return null; }
  }

  function setStatus(message) {
    const status = document.querySelector("#driveStatus");
    if (status) status.textContent = message;
  }

  function markSynced() {
    localStorage.setItem("gp-drive-pending-count", "0");
    if (typeof renderDashboard === "function") renderDashboard();
  }

  async function getAccessToken(clientId) {
    if (!window.google?.accounts?.oauth2) {
      throw new Error("Google sign-in library लोड झालेले नाही. इंटरनेट तपासून पुन्हा प्रयत्न करा.");
    }
    return new Promise((resolve, reject) => {
      const tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: DRIVE_SCOPE,
        callback: response => response.error ? reject(new Error(response.error_description || response.error)) : resolve(response.access_token)
      });
      tokenClient.requestAccessToken({ prompt: "" });
    });
  }

  async function apiRequest(path, token, options = {}) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/${path}`, {
      ...options,
      headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
    });
    if (!response.ok) {
      let detail = "";
      try { detail = (await response.json()).error?.message || ""; } catch { /* response may not be JSON */ }
      throw new Error(detail || `Google Drive विनंती अयशस्वी झाली (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  }

  async function findFolder(token, previousId) {
    if (previousId) {
      try {
        const known = await apiRequest(`files/${encodeURIComponent(previousId)}?fields=id,name,mimeType,trashed`, token);
        if (!known.trashed && known.mimeType === "application/vnd.google-apps.folder") return known.id;
      } catch { /* Re-discover the folder if this browser's saved ID is stale. */ }
    }
    const q = encodeURIComponent(`name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`);
    const result = await apiRequest(`files?q=${q}&pageSize=100&fields=files(id,name,mimeType)`, token);
    return result.files?.[0]?.id || null;
  }

  async function findOrCreateFolder(token, previousId) {
    const existingId = await findFolder(token, previousId);
    if (existingId) return existingId;
    const folder = await apiRequest("files?fields=id,name", token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" })
    });
    return folder.id;
  }

  async function findBackup(token, folderId) {
    const q = encodeURIComponent(`'${folderId}' in parents and name='${BACKUP_NAME}' and trashed=false`);
    const result = await apiRequest(`files?q=${q}&pageSize=1&orderBy=modifiedTime desc&fields=files(id,name,modifiedTime)`, token);
    return result.files?.[0] || null;
  }

  async function findRemoteDocument(token, folderId, documentId) {
    const q = encodeURIComponent(`'${folderId}' in parents and appProperties has { key='gpDocumentId' and value='${documentId}' } and trashed=false`);
    const result = await apiRequest(`files?q=${q}&pageSize=1&fields=files(id,name,mimeType)`, token);
    return result.files?.[0] || null;
  }

  async function uploadDocument(token, folderId, record, document, blob) {
    const boundary = `gp-doc-${crypto.randomUUID()}`;
    const mimeType = document.mimeType || blob.type || "application/octet-stream";
    const metadata = JSON.stringify({
      name: document.name,
      mimeType,
      parents: [folderId],
      appProperties: { gpDocumentId: document.id, gpRecordId: record.id }
    });
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      metadata,
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      blob,
      `\r\n--${boundary}--`
    ], { type: `multipart/related; boundary=${boundary}` });
    const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
      body
    });
    if (!response.ok) throw new Error(`कागदपत्र Drive वर अपलोड झाले नाही (${response.status})`);
    return response.json();
  }

  async function uploadDocuments(token, folderId) {
    const pending = records.flatMap(record => (record.documents || []).filter(document => !document.driveFileId).map(document => ({ record, document })));
    let uploaded = 0, reused = 0, unavailable = 0, checked = 0;
    for (const { record, document } of pending) {
      checked++;
      if (!document.id) { unavailable++; continue; }
      setStatus(`कागदपत्रे Drive वर अपलोड होत आहेत (${checked}/${pending.length})…`);
      const existingFile = await findRemoteDocument(token, folderId, document.id);
      const blob = existingFile ? null : await DocumentStore.get(document.id);
      if (!existingFile && !blob) { unavailable++; continue; }
      const remoteFile = existingFile || await uploadDocument(token, folderId, record, document, blob);
      document.driveFileId = remoteFile.id;
      document.mimeType = document.mimeType || remoteFile.mimeType || blob?.type || "application/octet-stream";
      save();
      if (existingFile) reused++;
      else uploaded++;
    }
    return { uploaded, reused, unavailable };
  }

  async function downloadDocuments(token, items) {
    let downloaded = 0, unavailable = 0;
    for (const record of items) {
      for (const document of record.documents || []) {
        if (!document.driveFileId || !document.id) { unavailable++; continue; }
        try {
          if (await DocumentStore.get(document.id)) continue;
          const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(document.driveFileId)}?alt=media`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (!response.ok) throw new Error(`Drive document download failed (${response.status})`);
          const blob = await response.blob();
          await DocumentStore.put(document.id, blob);
          document.mimeType = document.mimeType || blob.type || "application/octet-stream";
          downloaded++;
        } catch (error) {
          console.error("Could not download a Drive document", error);
          unavailable++;
        }
      }
    }
    return { downloaded, unavailable };
  }

  function documentSyncText(summary) {
    const parts = [];
    if (summary.uploaded) parts.push(`${summary.uploaded} कागदपत्रे अपलोड केली`);
    if (summary.reused) parts.push(`${summary.reused} आधीच्या फाइल्स पुन्हा वापरल्या`);
    if (summary.downloaded) parts.push(`${summary.downloaded} कागदपत्रे डाउनलोड केली`);
    if (summary.unavailable) parts.push(`${summary.unavailable} फाइल पुन्हा जोडणे किंवा उपलब्ध करून देणे आवश्यक`);
    if (!parts.length) parts.push("नवीन फाइल्स नाहीत; आधीच्या फाइल्स पुन्हा अपलोड नाहीत");
    return parts.length ? ` ${parts.join(" · ")}.` : "";
  }

  async function readBackup(token, fileId) {
    const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error(`Drive बॅकअप वाचता आला नाही (${response.status})`);
    const payload = await response.json();
    if (payload.app !== "gram-panchayat-records-pwa" || !Array.isArray(payload.records)) {
      throw new Error("Drive वरील फाइल या अॅपचा वैध बॅकअप नाही.");
    }
    return payload;
  }

  async function hashRecords(items) {
    const encoded = new TextEncoder().encode(JSON.stringify(items));
    const digest = await crypto.subtle.digest("SHA-256", encoded);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function writeBackup(token, fileId, folderId) {
    const documentSummary = await uploadDocuments(token, folderId);
    const payload = JSON.stringify({ app: "gram-panchayat-records-pwa", schemaVersion: 1, updatedAt: new Date().toISOString(), records }, null, 2);
    let result;
    if (fileId) {
      const response = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${encodeURIComponent(fileId)}?uploadType=media&fields=id,modifiedTime`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: payload
      });
      if (!response.ok) throw new Error(`Drive बॅकअप अद्ययावत करता आला नाही (${response.status})`);
      result = await response.json();
    } else {
      const boundary = `gp-sync-${crypto.randomUUID()}`;
      const metadata = JSON.stringify({ name: BACKUP_NAME, mimeType: "application/json", parents: [folderId] });
      const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${payload}\r\n--${boundary}--`;
      const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
        body
      });
      if (!response.ok) throw new Error(`Drive बॅकअप तयार करता आला नाही (${response.status})`);
      result = await response.json();
    }
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ folderId, fileId: result.id || fileId, remoteModifiedTime: result.modifiedTime || new Date().toISOString(), localHash: await hashRecords(records) }));
    markSynced();
    return documentSummary;
  }

  async function downloadBackup(token, file, folderId) {
    const payload = await readBackup(token, file.id);
    records = payload.records;
    save();
    const documentSummary = await downloadDocuments(token, records);
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ folderId, fileId: file.id, remoteModifiedTime: file.modifiedTime, localHash: await hashRecords(records) }));
    markSynced();
    return documentSummary;
  }

  async function runSync(token) {
    const previousState = readState();
    const folderId = await findOrCreateFolder(token, previousState?.folderId);
    const file = await findBackup(token, folderId);
    const localHash = await hashRecords(records);

    if (!file) {
      const summary = await writeBackup(token, null, folderId);
      setStatus("Drive बॅकअप तयार केला आणि या डिव्हाइसशी सिंक केले." + documentSyncText(summary));
      return;
    }

    const remotePayload = await readBackup(token, file.id);
    const remoteModifiedTime = file.modifiedTime;
    if (!previousState) {
      if (!records.length) {
        records = remotePayload.records;
        save();
        const summary = await downloadDocuments(token, records);
        localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ folderId, fileId: file.id, remoteModifiedTime, localHash: await hashRecords(records) }));
        markSynced();
        setStatus("Drive मधील नोंदी या डिव्हाइसवर आणल्या." + documentSyncText(summary));
      } else if (confirm(`Drive मध्ये ${remotePayload.records.length} नोंदी आहेत आणि या डिव्हाइसवर ${records.length} नोंदी आहेत. OK = या डिव्हाइसवरील नोंदी Drive वर अपलोड करा. Cancel = Drive मधील नोंदी या डिव्हाइसवर आणा.`)) {
        const summary = await writeBackup(token, file.id, folderId);
        setStatus("या डिव्हाइसवरील नोंदी Drive वर जतन केल्या." + documentSyncText(summary));
      } else {
        const summary = await downloadBackup(token, file, folderId);
        setStatus("Drive मधील नोंदी या डिव्हाइसवर आणल्या." + documentSyncText(summary));
      }
      return;
    }

    const localChanged = localHash !== previousState.localHash;
    const remoteChanged = remoteModifiedTime !== previousState.remoteModifiedTime;
    if (localChanged && remoteChanged) {
      if (confirm("या डिव्हाइसवरील आणि Drive वरील नोंदी दोन्ही बदलल्या आहेत. OK = Drive प्रत या डिव्हाइसवर आणून स्थानिक बदल बदला. Cancel = स्थानिक प्रत Drive वर अपलोड करून Drive वरील बदल बदला.")) {
        const summary = await downloadBackup(token, file, folderId);
        setStatus("Drive मधील नवीन प्रत या डिव्हाइसवर आणली." + documentSyncText(summary));
      } else {
        const summary = await writeBackup(token, file.id, folderId);
        setStatus("या डिव्हाइसवरील प्रत Drive वर जतन केली." + documentSyncText(summary));
      }
    } else if (localChanged) {
      const summary = await writeBackup(token, file.id, folderId);
      setStatus("स्थानिक बदल Drive वर जतन केले." + documentSyncText(summary));
    } else if (remoteChanged) {
      const summary = await downloadBackup(token, file, folderId);
      setStatus("Drive मधील बदल या डिव्हाइसवर आणले." + documentSyncText(summary));
    } else {
      const summary = await downloadDocuments(token, records);
      setStatus(summary.downloaded || summary.unavailable ? "नोंदी आधीच सिंक आहेत." + documentSyncText(summary) : "Drive आणि या डिव्हाइसवरील नोंदी आधीच सिंक आहेत.");
    }
  }

  async function restoreFromDrive(token) {
    const previousState = readState();
    const folderId = await findFolder(token, previousState?.folderId);
    if (!folderId) throw new Error("Google Drive मध्ये अॅपचा बॅकअप फोल्डर सापडला नाही.");
    const file = await findBackup(token, folderId);
    if (!file) throw new Error("Google Drive मध्ये पुनर्स्थापित करण्यासाठी बॅकअप सापडला नाही.");
    const payload = await readBackup(token, file.id);
    if (!confirm(`Drive बॅकअपमध्ये ${payload.records.length} नोंदी आहेत. त्या या डिव्हाइसवरील ${records.length} नोंदींची जागा घेतील. पुनर्स्थापित करायचे?`)) {
      setStatus("पुनर्स्थापना रद्द केली.");
      return;
    }
    records = payload.records;
    save();
    const documentSummary = await downloadDocuments(token, records);
    localStorage.setItem(SYNC_STATE_KEY, JSON.stringify({ folderId, fileId: file.id, remoteModifiedTime: file.modifiedTime, localHash: await hashRecords(records) }));
    markSynced();
    setStatus(`Drive बॅकअपमधील ${records.length} नोंदी पुनर्स्थापित केल्या.` + documentSyncText(documentSummary));
  }

  window.initializeDriveSync = function initializeDriveSync() {
    const button = document.querySelector("#driveSyncBtn");
    const restoreButton = document.querySelector("#driveRestoreBtn");
    if (!button || !restoreButton) return;
    localStorage.removeItem("gp-drive-client-id");
    const previousState = readState();
    if (previousState) setStatus("Drive बॅकअप आढळला · सिंकसाठी Google खात्यात पुन्हा कनेक्ट करा.");

    button.addEventListener("click", async () => {
      button.disabled = true;
      restoreButton.disabled = true;
      setStatus("Google Drive शी कनेक्ट होत आहे…");
      try {
        const token = await getAccessToken(CLIENT_ID);
        setStatus("Drive तपासत आहे…");
        await runSync(token);
      } catch (error) {
        console.error("Google Drive sync failed", error);
        setStatus(error.message || "Google Drive सिंक अयशस्वी झाले.");
      } finally {
        button.disabled = false;
        restoreButton.disabled = false;
      }
    });

    restoreButton.addEventListener("click", async () => {
      button.disabled = true;
      restoreButton.disabled = true;
      setStatus("Google Drive मधील बॅकअप शोधत आहे…");
      try {
        const token = await getAccessToken(CLIENT_ID);
        await restoreFromDrive(token);
      } catch (error) {
        console.error("Google Drive restore failed", error);
        setStatus(error.message || "Drive बॅकअप पुनर्स्थापित करता आला नाही.");
      } finally {
        button.disabled = false;
        restoreButton.disabled = false;
      }
    });
  };
})();
