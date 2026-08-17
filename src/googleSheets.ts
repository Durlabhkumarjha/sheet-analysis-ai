// Google Sheets import.
//
// Lets a user pick a spreadsheet straight from their Google Drive instead of
// exporting a CSV by hand. Deliberately uses the NON-SENSITIVE `drive.file`
// scope: it grants access only to the specific file the user picks in the
// Google Picker, never their whole Drive. That keeps us out of Google's
// sensitive-scope verification process and matches our privacy promise —
// the sheet is fetched into the browser and analysed locally, exactly like an
// uploaded file.
//
// Requires two build-time env vars (see .env.example):
//   VITE_GOOGLE_CLIENT_ID  — OAuth 2.0 Web client ID
//   VITE_GOOGLE_API_KEY    — API key used by the Picker

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;
const SCOPE = "https://www.googleapis.com/auth/drive.file";

/** True only when this deployment has Google credentials configured. */
export function isGoogleSheetsConfigured(): boolean {
  return Boolean(CLIENT_ID && API_KEY);
}

function loadScript(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.getElementById(id)) return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.id = id;
    el.async = true;
    el.defer = true;
    el.onload = () => resolve();
    el.onerror = () => reject(new Error("Couldn't reach Google. Check your connection and try again."));
    document.head.appendChild(el);
  });
}

// Both Google libraries are loaded on demand — nothing is fetched unless the
// user actually clicks the button.
async function ensureLibraries(): Promise<void> {
  await loadScript("https://accounts.google.com/gsi/client", "gsi-client");
  await loadScript("https://apis.google.com/js/api.js", "gapi-client");
  await new Promise<void>((resolve, reject) => {
    const gapi = (window as unknown as { gapi?: { load: (n: string, o: unknown) => void } }).gapi;
    if (!gapi) return reject(new Error("Google API failed to load."));
    gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("Google Picker failed to load.")) });
  });
}

function requestAccessToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    const google = (window as unknown as { google?: Record<string, any> }).google;
    if (!google?.accounts?.oauth2) return reject(new Error("Google sign-in is unavailable."));
    const client = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: (response: { access_token?: string; error_description?: string }) => {
        if (response?.access_token) resolve(response.access_token);
        else reject(new Error(response?.error_description || "Google sign-in was cancelled."));
      },
    });
    client.requestAccessToken();
  });
}

function pickSpreadsheet(token: string): Promise<{ id: string; name: string } | null> {
  return new Promise((resolve, reject) => {
    const google = (window as unknown as { google?: Record<string, any> }).google;
    if (!google?.picker) return reject(new Error("Google Picker is unavailable."));
    const picker = google.picker;
    const view = new picker.DocsView(picker.ViewId.SPREADSHEETS).setIncludeFolders(true);
    new picker.PickerBuilder()
      .setOAuthToken(token)
      .setDeveloperKey(API_KEY)
      .addView(view)
      .setCallback((data: { action: string; docs?: Array<{ id: string; name: string }> }) => {
        if (data.action === picker.Action.PICKED) {
          const doc = data.docs?.[0];
          resolve(doc ? { id: doc.id, name: doc.name } : null);
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
}

// Google Sheets export returns the FIRST tab as CSV, which is what we then feed
// through the normal CSV pipeline.
async function exportAsCsv(fileId: string, token: string): Promise<string> {
  const url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text%2Fcsv`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    if (response.status === 403 || response.status === 404) {
      throw new Error("Couldn't open that sheet. Make sure it's a Google Sheet you can access.");
    }
    throw new Error(`Couldn't read that sheet (error ${response.status}).`);
  }
  return await response.text();
}

/**
 * Full flow: sign in → pick a sheet → return its contents as CSV text.
 * Resolves to null if the user closes the picker without choosing.
 */
export async function importFromGoogleSheets(): Promise<{ csv: string; fileName: string } | null> {
  if (!isGoogleSheetsConfigured()) {
    throw new Error("Google Sheets import isn't configured for this deployment.");
  }
  await ensureLibraries();
  const token = await requestAccessToken();
  const picked = await pickSpreadsheet(token);
  if (!picked) return null;
  const csv = await exportAsCsv(picked.id, token);
  return { csv, fileName: `${picked.name}.csv` };
}
