// Pushes a periodic snapshot of the overdue-customers data to a private
// GitHub Gist, so the phone can show "last synced data" even when this PC
// (and therefore the live server) is off. The GitHub token stays on the
// backend only - the frontend only ever needs the gist ID to read it back,
// never the token, since a secret gist's content is readable via its ID
// without authentication (just not listed/searchable).

const GIST_FILENAME = "overdue-snapshot.json";

async function githubRequest(token, method, url, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `token ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "overdue-reminder-app",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`GitHub API ${method} ${url} failed: ${res.status} ${json.message || ""}`);
  }
  return json;
}

async function createGist(token, content) {
  const result = await githubRequest(token, "POST", "https://api.github.com/gists", {
    description: "Overdue Reminders - last synced snapshot (auto-updated, do not edit by hand)",
    public: false,
    files: { [GIST_FILENAME]: { content } },
  });
  return result.id;
}

async function updateGist(token, gistId, content) {
  await githubRequest(token, "PATCH", `https://api.github.com/gists/${gistId}`, {
    files: { [GIST_FILENAME]: { content } },
  });
}

module.exports = { createGist, updateGist, GIST_FILENAME };
