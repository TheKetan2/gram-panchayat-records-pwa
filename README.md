# Gram Panchayat Birth & Death Records PWA

A mobile-first Android-style PWA MVP for local demonstration.

## Run locally

This project uses plain HTML, CSS and JavaScript so you can run it immediately without installing Node packages.

```bash
python -m http.server 8080
```

Open http://localhost:8080 in Chrome or Edge. Service workers and PWA installation require localhost or HTTPS.

## Included in this MVP

- Android-inspired mobile interface with bottom navigation and Material-like cards
- Marathi-first interface and basic English toggle
- Dashboard, Birth register, Death register, Monthly register, Search, Reports, Documents and Settings
- Multi-step birth/death entry forms
- Separate event date, reporting date and registration date
- Date validation and reporting-delay calculation
- Local browser persistence using localStorage
- Month-wise summary with Event Date / Registration Date basis
- CSV export, JSON backup, individual record PDF/print export, and uploaded document preview
- Manual Google Drive sync for the records JSON backup
- PWA manifest and service-worker app-shell caching

## Google Drive sync setup

1. In Google Cloud Console, create a project, enable the Google Drive API, and configure the OAuth consent screen.
2. Create an OAuth client ID for a Web application. Add the app origin under Authorized JavaScript origins (for local use: `http://localhost:8080`). The public client ID is configured once in `drive-sync.js`; users do not need to enter it.
3. Open **More → Settings** and choose **Google Drive शी कनेक्ट करून सिंक करा**.
4. Sign in to Google and approve the app-specific Drive file access. The app creates a `Gram Panchayat Records PWA` folder, keeps one `gram-panchayat-records-sync.json` snapshot, and stores uploaded documents as separate Drive files.

Sync is manual. Access tokens stay in memory and you reconnect when syncing again. Each document is uploaded once and referenced by its Drive file ID on later syncs; the records JSON snapshot is updated when records change. If both the device copy and Drive copy changed since the previous sync, the app asks which copy to keep; the chosen copy replaces the other. A fork or deployment with a different Google Cloud project must replace the public client ID in `drive-sync.js` and add its origin to that OAuth client.

Use **Drive बॅकअप पुनर्स्थापित करा** to replace this device's records with the saved Drive snapshot. The app shows a confirmation and the number of cloud records before replacing local data.

## Important limitations

This is a local MVP, not a production government registration system.

- Data stays in the current browser profile on the current device.
- Drive sync stores the complete records snapshot as a regular JSON file and is not an encrypted, role-based production database.
- New document bytes are stored in this browser's IndexedDB and uploaded to the connected Drive account on sync. App-level client-side encryption, server-side access control, and secure file sharing are not implemented. Older records created before this feature stored names and sizes only; reattach those files from the record detail page before syncing them.
- Do not enter real personal data, Aadhaar numbers or sensitive documents into this demo.
- No CRS integration, official registration number assignment or legally valid certificate issuance is implemented.
- The interface uses demo/local status labels and must not be treated as official records.

## Next production steps

1. Connect Firebase Authentication, Firestore and private Firebase Storage.
2. Add Firestore Security Rules and Storage Rules, with server-side role checks.
3. Replace localStorage with IndexedDB and an explicit conflict-aware sync queue.
4. Add audit logs, correction approvals and tested backup/restore.
5. Validate Maharashtra's current prescribed forms, legal timelines and authorized workflows before operational use.
