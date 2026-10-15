function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#0b0d12; --fg:#e8eaf0; --muted:#9aa3b2; --accent:#e5484d; --card:#151922; }
  @media (prefers-color-scheme: light) { :root { --bg:#f6f7f9; --fg:#14171f; --muted:#5b6474; --card:#fff; } }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding:16px; box-sizing:border-box; }
  main { background:var(--card); border-radius:12px; padding:28px; max-width:440px; width:100%;
         box-shadow:0 10px 30px rgba(0,0,0,.25); }
  h1 { font-size:20px; margin:0 0 8px; }
  p { color:var(--muted); margin:8px 0; }
  code { word-break:break-all; }
  ul { padding-left:20px; color:var(--muted); }
  .row { display:flex; gap:12px; margin-top:20px; }
  button { flex:1; font:inherit; padding:10px 14px; border-radius:8px; border:1px solid var(--muted);
           background:transparent; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
`;

export function renderConsentPage(params: {
  pendingId: string;
  clientName: string;
  redirectHost: string;
  actionPath: string;
}): string {
  const clientName = escapeHtml(params.clientName);
  const redirectHost = escapeHtml(params.redirectHost);
  const pendingId = escapeHtml(params.pendingId);
  const action = escapeHtml(params.actionPath);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Rogue Signal</title><style>${STYLE}</style></head>
<body><main>
<h1>Connect to Rogue Signal YouTube</h1>
<p><strong>${clientName}</strong> wants to manage the Rogue Signal YouTube channel on your behalf.</p>
<p>After you approve, you will sign in with Google. The app will be able to:</p>
<ul><li>Upload videos (always as <strong>private</strong>)</li>
<li>Edit titles, descriptions, thumbnails and playlists</li>
<li>Schedule or publish videos, only after you confirm in the chat</li></ul>
<p>Authorization results will be sent to <code>${redirectHost}</code>.</p>
<form method="post" action="${action}">
<input type="hidden" name="pending" value="${pendingId}">
<div class="row">
<button type="submit" name="decision" value="deny">Cancel</button>
<button type="submit" name="decision" value="approve" class="primary">Continue with Google</button>
</div></form>
</main></body></html>`;
}

export function renderMessagePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

export { escapeHtml };
