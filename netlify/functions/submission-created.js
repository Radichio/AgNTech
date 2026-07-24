// netlify/functions/submission-created.js
//
// Fires automatically when a Netlify Form submission is verified. The name of
// this file IS the trigger — nothing in index.html calls it, and nothing needs
// to. Netlify signs each event and verifies the signature before invoking, so
// this cannot be called from outside.
//
// PURPOSE: mirror every intake into Supabase so the dashboard has real data to
// read. This is strictly additive — Terry's notification email and the Netlify
// Forms record happen regardless. If this function fails, nothing he relies on
// breaks; we simply miss a row, and the submission is still recoverable from
// the Netlify Forms UI.
//
// SECURITY: the Supabase secret key bypasses row-level security by design, which
// is how it writes to locked tables. It lives ONLY in the Netlify env var
// SUPABASE_SERVICE_KEY and never reaches a browser — same discipline as the
// Anthropic key.

const FORM_NAME = 'agntech-intake';

// Fields we lift straight out of the intake payload into their own columns.
// Everything else still lands in `raw`, so nothing is ever lost.
const MAP = {
  sector: 'sector',
  stage: 'stage',
  need: 'need',
  geography: 'geography',
  timeline: 'timeline',
  exposure: 'exposure',
  oneLiner: 'one_liner',
  note: 'note',
  deck: 'deck',
  role: 'role',
  link: 'link'
};

const VALID_DOORS = ['capital', 'venture', 'lender', 'talent'];

function clean(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, 2000) : null;
}

exports.handler = async (event) => {
  // Always 200. A non-2xx makes Netlify retry, and a retry storm on a bad
  // payload is worse than a missing row.
  const ok = { statusCode: 200, body: 'ok' };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    console.log('[intake] Supabase env vars missing — skipping write');
    return ok;
  }

  let fields = {};
  try {
    const body = JSON.parse(event.body || '{}');
    const p = body.payload || body;
    // Netlify nests the form fields under `data`; tolerate both shapes.
    fields = p.data || p || {};

    const formName = p.form_name || p.formName || fields['form-name'];
    if (formName && formName !== FORM_NAME) {
      console.log('[intake] ignoring form:', formName);
      return ok;
    }
  } catch (e) {
    console.log('[intake] could not parse event body:', String(e && e.message));
    return ok;
  }

  // The client posts the full intake object as a JSON string in `payload`.
  let detail = {};
  try {
    if (fields.payload) detail = JSON.parse(fields.payload) || {};
  } catch (e) {
    console.log('[intake] payload field was not valid JSON — using flat fields only');
  }

  const door = clean(detail.door || fields.door);
  const row = {
    door: VALID_DOORS.indexOf(door) > -1 ? door : 'capital',
    name: clean(detail.name || fields.name),
    email: clean(detail.email || fields.email),
    company: clean(detail.organization || fields.organization),
    raw: {
      screening: detail.screening || null,
      submitted: detail.submitted || null,
      summary: fields.summary || null,
      detail: detail
    }
  };
  Object.keys(MAP).forEach((k) => { row[MAP[k]] = clean(detail[k]); });

  try {
    const resp = await fetch(url.replace(/\/+$/, '') + '/rest/v1/intakes', {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify(row)
    });
    if (!resp.ok) {
      const t = await resp.text();
      console.log('[intake] Supabase rejected the insert:', resp.status, t.slice(0, 400));
    } else {
      console.log('[intake] stored:', row.door, row.email || '(no email)');
    }
  } catch (e) {
    console.log('[intake] insert failed:', String((e && e.message) || e));
  }

  return ok;
};
