// netlify/functions/enrich.js
//
// THE ENRICHMENT ENGINE.
// Takes a raw intake and turns it into an assessed opportunity: researched,
// scored against Terry's rubric, cross-checked, and matched to the network —
// so the file is worked before Terry opens it.
//
// DESIGN RULES, all load-bearing:
//
// 1. THE WEIGHTS NEVER LEAVE THIS FILE. The model scores each criterion 0-10
//    and never sees how they are weighted. The weighted total is computed here.
//    A founder who learned the weights could shape an intake to game them.
//
// 2. FIGURE DISCIPLINE. Same three-tier rule as the Insights bulletin: real
//    sourced facts or nothing. Never an invented comparable or market size —
//    Terry may quote these to capital.
//
// 3. THE ENGINE PREPARES; TERRY DECIDES. Output always lands in vetting_fit,
//    marked machine-assessed. Nothing is auto-promoted into a live lane.
//
// 4. AUTHENTICATED CALLERS ONLY. This writes to the database, so the caller's
//    Supabase session is verified before anything happens.

const MODEL = 'claude-haiku-4-5-20251001';   // fast tier: comfortably inside the function budget
const MAX_TOKENS = 2000;
const RESEARCH_BUDGET_MS = 5000;
const MODEL_BUDGET_MS = 22000;

// ---------------------------------------------------------------------------
// THE RUBRIC — Terry's, from the walkthrough. Sum must be 100.
// Verify against the locked set before this runs unattended.
// ---------------------------------------------------------------------------
const RUBRIC = [
  { key: 'lane_fit',   weight: 14, label: 'Lane fit',
    asks: 'Is this in his sectors, and how close to the centre of them? Can he genuinely help?' },
  { key: 'people',     weight: 22, label: 'The people',
    asks: 'Do they listen as closely as they pitch? Have they done it before? Do they want a partner rather than an audience?' },
  { key: 'whats_real', weight: 18, label: "What's real",
    asks: 'Is there something on the ground — revenue, paying pilots, real customers — rather than an idea?' },
  { key: 'market',     weight: 10, label: 'Market',
    asks: 'Is it big enough, is the timing right, is there room to win?' },
  { key: 'economics',  weight: 10, label: 'Model & economics',
    asks: 'Do the unit economics work? Is there a path to capital, and room to scale?' },
  { key: 'structure',  weight:  8, label: 'Deal & structure',
    asks: 'Realistic valuation, clean to structure, room for a principal stake?' },
  { key: 'edge',       weight: 14, label: 'Edge & alignment',
    asks: 'Does his involvement move the needle? Do the interests sit beside theirs?' },
  { key: 'risk',       weight:  4, label: 'Risk & flags',
    asks: 'Do the claims check out? Is the runway sane? Is it over-concentrated?' }
];

// End it on their own, whatever the score.
const KNOCKOUTS = [
  { key: 'off_lane',    label: 'Outside his lanes entirely' },
  { key: 'wont_share',  label: 'Will not share the wheel — would sooner run it alone than take a partner' },
  { key: 'integrity',   label: 'Claims that cannot be verified, or an integrity problem' }
];

const BANDS = [
  { min: 8.0, verdict: 'Worth a look' },
  { min: 6.5, verdict: 'Promising, with questions' },
  { min: 0,   verdict: 'Early / not a fit right now' }
];

const SYSTEM = `You assess inbound opportunities for AgNtech Connect, a capital-advisory practice in Canadian agriculture run by Terry Cholka — forty years as a farmer and operator, and earlier a agricultural lender. He brings capital and buyers to Canadian companies and advises founders, lenders and operators.

Your job is to prepare a file so that a decision can be made on it. You do not make the decision.

SCORE EACH CRITERION 0-10, where 0 is absent or disqualifying, 5 is unremarkable, 8 is strong, 10 is exceptional. Score honestly. Most inbound enquiries are 4-6 on most criteria; reserve 8+ for genuine evidence. If the intake gives you nothing on a criterion, score it 3 and say the evidence is absent — do not assume the best.

ON FIGURES — this matters more than anything else you do:
- Use a number ONLY if it appears in the enquiry itself or in the research provided to you.
- NEVER invent or estimate a market size, growth rate, valuation, or comparable. If you do not have a real one, write that it is not established.
- Terry may repeat these figures to investors. A plausible-sounding invented number is the worst thing you can produce.

WRITE IN YOUR OWN WORDS. Never quote or closely paraphrase the research headlines.

CROSS-CHECK. If the enquiry contradicts itself, or a claim does not square with the research, flag it explicitly. This is one of the most valuable things you do — for example, a claimed revenue figure that does not reconcile with the stated stage or customer count.

TONE: plain, measured, specific. A colleague briefing a principal. No hype, no filler, no hedging language.

Respond with a single raw JSON object and nothing else:
{
 "scores": {"lane_fit":0-10,"people":0-10,"whats_real":0-10,"market":0-10,"economics":0-10,"structure":0-10,"edge":0-10,"risk":0-10},
 "knockouts": {"off_lane":true|false,"wont_share":true|false,"integrity":true|false},
 "summary": "<2-3 sentences: what this is, and what stands out>",
 "strengths": ["<short, specific>", "..."],
 "risks": [{"text":"<short, specific>","is_flag":true|false}],
 "market_stat": "<a real, sourced figure from the research, or empty string>",
 "market_note": "<one sentence of context, or empty string>",
 "comparables": "<only if the research supports it, otherwise empty string>",
 "best_fit_description": "<the kind of capital or help this needs>",
 "ask": "<what to ask them next — the single most useful question>"
}
Set is_flag true on a risk only when it is a contradiction or an integrity concern, not merely a normal early-stage risk.`;

// ---------------------------------------------------------------------------

function j(code, obj) {
  return { statusCode: code, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

function decode(s) {
  return String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/<[^>]+>/g, '').trim();
}

/** Public reporting on the company and its category. Same approach as the bulletin. */
async function research(intake) {
  const terms = [];
  if (intake.company) terms.push(`"${intake.company}"`);
  const sector = intake.sector || 'Canadian agriculture';
  terms.push(`${sector} Canada agriculture`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RESEARCH_BUDGET_MS);
  try {
    const out = await Promise.all(terms.map(async (q) => {
      const url = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:1y') +
                  '&hl=en-CA&gl=CA&ceid=CA:en';
      try {
        const r = await fetch(url, { signal: ctrl.signal,
          headers: { 'user-agent': 'Mozilla/5.0 (compatible; AgNtechConnect/1.0)' } });
        if (!r.ok) return { q, items: [] };
        const xml = await r.text();
        const items = [];
        const re = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = re.exec(xml)) !== null && items.length < 6) {
          const t = /<title>([\s\S]*?)<\/title>/.exec(m[1]);
          if (t) items.push(decode(t[1]));
        }
        return { q, items };
      } catch (e) { return { q, items: [] }; }
    }));
    return out;
  } catch (e) {
    return [];
  } finally { clearTimeout(timer); }
}

function extractJson(text) {
  let depth = 0, start = -1, inStr = false, esc = false;
  const found = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { found.push(text.slice(start, i + 1)); start = -1; } }
  }
  for (let i = found.length - 1; i >= 0; i--) {
    try { const o = JSON.parse(found[i]); if (o && o.scores) return o; } catch (e) {}
  }
  return null;
}

function slugify(s, id) {
  const base = String(s || 'opportunity').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  return (base || 'opportunity') + '-' + String(id).slice(0, 6);
}

/** Match against the network on thesis tags, then sector words. */
function matchContact(contacts, opp) {
  const hay = ((opp.best_fit_description || '') + ' ' + (opp.sector || '') + ' ' +
               (opp.summary || '')).toLowerCase();
  let best = null, bestScore = 0;
  contacts.forEach((c) => {
    let score = 0;
    (c.thesis_tags || []).forEach((tag) => {
      if (tag && hay.indexOf(String(tag).toLowerCase()) > -1) score += 2;
    });
    const type = String(c.contact_type || '').toLowerCase();
    type.split(/[^a-z]+/).forEach((w) => {
      if (w.length > 4 && hay.indexOf(w) > -1) score += 1;
    });
    if (score > bestScore) { bestScore = score; best = c; }
  });
  return bestScore > 0 ? best : null;
}

// ---------------------------------------------------------------------------

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return j(405, { error: 'POST only' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!url || !key || !anthropicKey) return j(500, { error: 'Server not configured' });

  const base = url.replace(/\/+$/, '');
  const sbHeaders = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };

  // --- caller must hold a valid session -------------------------------------
  const auth = (event.headers.authorization || event.headers.Authorization || '').replace(/^Bearer\s+/i, '');
  if (!auth) return j(401, { error: 'Not signed in' });
  try {
    const who = await fetch(base + '/auth/v1/user', {
      headers: { apikey: key, Authorization: 'Bearer ' + auth }
    });
    if (!who.ok) return j(401, { error: 'Session not valid' });
  } catch (e) {
    return j(401, { error: 'Could not verify session' });
  }

  let intakeId;
  try { intakeId = JSON.parse(event.body || '{}').intake_id; } catch (e) {}
  if (!intakeId) return j(400, { error: 'intake_id required' });

  // --- load the intake ------------------------------------------------------
  let intake;
  try {
    const r = await fetch(base + '/rest/v1/intakes?id=eq.' + encodeURIComponent(intakeId) + '&select=*',
                          { headers: sbHeaders });
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return j(404, { error: 'Intake not found' });
    intake = rows[0];
  } catch (e) {
    return j(500, { error: 'Could not load intake: ' + (e.message || e) });
  }

  // --- research + network in parallel ---------------------------------------
  const [found, contacts] = await Promise.all([
    research(intake),
    fetch(base + '/rest/v1/capital_contacts?select=*', { headers: sbHeaders })
      .then((r) => r.json()).catch(() => [])
  ]);

  const raw = (typeof intake.raw === 'string') ? (() => { try { return JSON.parse(intake.raw); } catch (e) { return {}; } })() : (intake.raw || {});
  const screening = (raw.screening || []).map((s) => `  ${s.q} \u2014 ${s.a}`).join('\n');
  const researchText = found.filter((f) => f.items.length)
    .map((f) => `[${f.q}]\n` + f.items.map((i) => '  - ' + i).join('\n')).join('\n\n');

  const userMsg = [
    `Assess this inbound enquiry.`,
    `DOOR: ${intake.door}`,
    `Name: ${intake.name || '\u2014'}`,
    `Company: ${intake.company || '\u2014'}`,
    `Sector: ${intake.sector || '\u2014'}   Stage: ${intake.stage || '\u2014'}   Need: ${intake.need || '\u2014'}`,
    `Geography: ${intake.geography || '\u2014'}   Timeline: ${intake.timeline || '\u2014'}   Exposure: ${intake.exposure || '\u2014'}`,
    intake.one_liner ? `In their words: ${intake.one_liner}` : '',
    intake.note ? `Note: ${intake.note}` : '',
    screening ? `\nSCREENING ANSWERS:\n${screening}` : '',
    researchText ? `\nPUBLIC REPORTING (may or may not be about this company \u2014 judge relevance):\n${researchText}`
                 : `\nNo public reporting was retrievable. Score on the enquiry alone and leave market figures empty.`,
    `\nScore each criterion on the evidence actually present. Output only the JSON object.`
  ].filter(Boolean).join('\n');

  // --- assess ---------------------------------------------------------------
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MODEL_BUDGET_MS);
  let assessed = null, modelErr = null;
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: SYSTEM,
                             messages: [{ role: 'user', content: userMsg }] })
    });
    const text = await resp.text();
    if (!resp.ok) { modelErr = 'http ' + resp.status + ' ' + text.slice(0, 300); }
    else {
      const data = JSON.parse(text);
      const out = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      assessed = extractJson(out);
      if (!assessed) modelErr = 'could not parse assessment';
    }
  } catch (e) {
    modelErr = 'aborted or failed: ' + (e.message || e);
  } finally { clearTimeout(timer); }

  if (!assessed) {
    console.log('[enrich] assessment failed:', modelErr);
    return j(502, { error: 'Assessment failed', detail: modelErr });
  }

  // --- weights applied HERE, never by the model -----------------------------
  let total = 0, weightUsed = 0;
  const breakdown = RUBRIC.map((c) => {
    const raw10 = Math.max(0, Math.min(10, Number(assessed.scores[c.key])));
    const s = isNaN(raw10) ? 0 : raw10;
    total += s * c.weight; weightUsed += c.weight;
    return { label: c.label, score: s };
  });
  let fit = weightUsed ? Math.round((total / weightUsed) * 10) / 10 : null;

  // --- knock-outs end it, whatever the score --------------------------------
  const tripped = KNOCKOUTS.filter((k) => assessed.knockouts && assessed.knockouts[k.key] === true);
  if (tripped.length) fit = 0;

  const band = BANDS.find((b) => fit >= b.min) || BANDS[BANDS.length - 1];

  // --- shape the record -----------------------------------------------------
  const risks = Array.isArray(assessed.risks) ? assessed.risks.map((r) =>
    (typeof r === 'string') ? { text: r, is_flag: false }
                            : { text: String(r.text || ''), is_flag: !!r.is_flag }) : [];
  tripped.forEach((k) => risks.unshift({ text: 'Knock-out: ' + k.label, is_flag: true }));
  if (assessed.ask) risks.push({ text: 'Ask them: ' + assessed.ask, is_flag: false });

  const opp = {
    slug: slugify(intake.company || intake.name, intake.id),
    name: intake.company || intake.name || 'New opportunity',
    sector: intake.sector || null,
    stage: intake.stage || null,
    deal_type: intake.door === 'lender' ? 'Advisory' : (intake.need || null),
    fit_score: fit,
    summary: assessed.summary || null,
    strengths: JSON.stringify(Array.isArray(assessed.strengths) ? assessed.strengths : []),
    risks: JSON.stringify(risks),
    market_stat: assessed.market_stat || null,
    market_note: assessed.market_note || null,
    comparables: assessed.comparables || null,
    best_fit_description: assessed.best_fit_description || null,
    pipeline_status: 'vetting_fit',
    pipeline_note: band.verdict + ' \u2014 machine-assessed',
    in_library: false,
    intake_id: intake.id
  };

  const contact = matchContact(Array.isArray(contacts) ? contacts : [], {
    best_fit_description: opp.best_fit_description, sector: opp.sector, summary: opp.summary
  });
  if (contact) opp.best_fit_contact_id = contact.id;

  // --- write ----------------------------------------------------------------
  try {
    const ins = await fetch(base + '/rest/v1/opportunities', {
      method: 'POST',
      headers: Object.assign({}, sbHeaders, { Prefer: 'return=representation' }),
      body: JSON.stringify(opp)
    });
    const body = await ins.text();
    if (!ins.ok) {
      console.log('[enrich] insert rejected:', ins.status, body);
      return j(502, { error: 'Could not save assessment', detail: body.slice(0, 300) });
    }
    await fetch(base + '/rest/v1/intakes?id=eq.' + encodeURIComponent(intake.id), {
      method: 'PATCH', headers: sbHeaders, body: JSON.stringify({ status: 'promoted' })
    });
    console.log('[enrich] assessed', opp.name, 'fit', fit, tripped.length ? '(knock-out)' : '');
    return j(200, { ok: true, fit_score: fit, verdict: band.verdict,
                    knockouts: tripped.map((k) => k.label), breakdown, slug: opp.slug });
  } catch (e) {
    return j(500, { error: 'Save failed: ' + (e.message || e) });
  }
};
