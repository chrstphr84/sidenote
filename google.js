// Google export: OAuth (via chrome.identity.launchWebAuthFlow) + Drive upload.
//
// Design notes:
//   * Uses launchWebAuthFlow with the implicit flow so no client secret and no
//     backend are needed. The user supplies their own OAuth *client ID* in
//     Settings (a client ID isn't a secret), which is why nothing is hardcoded.
//   * Only the drive.file scope is requested — SideNote can create and open the
//     files it makes, and nothing else.
//   * Rather than build Docs/Sheets via their APIs, we upload our existing
//     export HTML/CSV and let Drive convert it (HTML → Doc, CSV → Sheet).
//
// The pure helpers (parseTokenFromRedirect, buildDriveMultipart) have no chrome
// or network dependency so they can be unit-tested directly.

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/drive.file";
let googleToken = null; // { token, expiresAt } cached for this page session

// Pull the access token out of the OAuth redirect fragment.
function parseTokenFromRedirect(redirectUrl) {
  if (!redirectUrl) return null;
  const tokenMatch = redirectUrl.match(/[#&]access_token=([^&]+)/);
  if (!tokenMatch) return null;
  const expiresMatch = redirectUrl.match(/[#&]expires_in=([^&]+)/);
  const expiresIn = expiresMatch ? Number(expiresMatch[1]) : 3600;
  return {
    token: decodeURIComponent(tokenMatch[1]),
    // Refresh a minute early to avoid using an about-to-expire token.
    expiresAt: Date.now() + (Math.max(60, expiresIn) - 60) * 1000
  };
}

function getGoogleToken(clientId, interactive) {
  return new Promise((resolve, reject) => {
    if (!clientId) {
      reject(new Error("no-client-id"));
      return;
    }
    if (googleToken && googleToken.expiresAt > Date.now()) {
      resolve(googleToken.token);
      return;
    }
    const redirect = chrome.identity.getRedirectURL();
    const authUrl =
      "https://accounts.google.com/o/oauth2/v2/auth" +
      "?client_id=" +
      encodeURIComponent(clientId) +
      "&response_type=token" +
      "&redirect_uri=" +
      encodeURIComponent(redirect) +
      "&scope=" +
      encodeURIComponent(GOOGLE_SCOPE) +
      "&include_granted_scopes=true";
    chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: interactive !== false }, (responseUrl) => {
      if (chrome.runtime.lastError || !responseUrl) {
        reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : "auth-cancelled"));
        return;
      }
      const parsed = parseTokenFromRedirect(responseUrl);
      if (!parsed) {
        reject(new Error("no-token"));
        return;
      }
      googleToken = parsed;
      resolve(parsed.token);
    });
  });
}

function clearGoogleToken() {
  googleToken = null;
}

// Build a multipart/related body: JSON metadata + media, for Drive's
// uploadType=multipart endpoint.
function buildDriveMultipart(metadata, mediaType, mediaBody, boundary) {
  return (
    `--${boundary}\r\n` +
    "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: ${mediaType}\r\n\r\n` +
    `${mediaBody}\r\n` +
    `--${boundary}--`
  );
}

async function driveCreate(token, metadata, mediaType, mediaBody) {
  const boundary = "sidenote-" + Math.random().toString(36).slice(2);
  const body = buildDriveMultipart(metadata, mediaType, mediaBody, boundary);
  const res = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink,mimeType",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`
      },
      body
    }
  );
  if (!res.ok) {
    if (res.status === 401) clearGoogleToken();
    const text = await res.text().catch(() => "");
    throw new Error(`drive-${res.status}: ${text.slice(0, 160)}`);
  }
  return res.json();
}

function createGoogleDoc(token, name, html) {
  return driveCreate(token, { name, mimeType: "application/vnd.google-apps.document" }, "text/html", html);
}

function createGoogleSheet(token, name, csv) {
  return driveCreate(token, { name, mimeType: "application/vnd.google-apps.spreadsheet" }, "text/csv", csv);
}

function googleFileLink(file, kind) {
  if (file && file.webViewLink) return file.webViewLink;
  const id = file && file.id;
  if (!id) return "https://drive.google.com";
  return kind === "gsheet"
    ? `https://docs.google.com/spreadsheets/d/${id}/edit`
    : `https://docs.google.com/document/d/${id}/edit`;
}
