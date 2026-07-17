import { useState, useEffect, useRef, useCallback } from "react";

// ── Dual-mode environment detection ──
// This one file runs in two places:
//  - As a claude.ai ARTIFACT: window.storage persists cards, and the Anthropic API
//    is called directly (the artifact sandbox injects auth — no API key needed).
//  - LOCALLY / on Vercel: localStorage persists cards, and AI calls go through the
//    /api/anthropic proxy (Vite dev middleware or the serverless function).
const IS_ARTIFACT = typeof window !== "undefined" && window.location.hostname.includes("claude");
const UA = typeof navigator !== "undefined" ? navigator.userAgent : "";
const IS_MOBILE = /Android|iPhone|iPad|iPod/i.test(UA) || (typeof navigator!=="undefined"&&navigator.maxTouchPoints>1&&/Mac/.test(UA));
const IS_MAC = !IS_MOBILE && /Mac/i.test(UA);
const API_URL = IS_ARTIFACT ? "https://api.anthropic.com/v1/messages" : "/api/anthropic";
const API_HEADERS = IS_ARTIFACT
  ? { "Content-Type": "application/json", "anthropic-version": "2023-06-01" }
  : { "Content-Type": "application/json" };

// Watchdog: no AI call may hang forever. The timeout covers the FULL round trip —
// including reading the response body, which is where the claude.ai proxy actually
// stalls (headers arrive fast, the body dribbles). Also exposes a manual cancel.
let ACTIVE_CTL=null;
const cancelActiveCall=()=>{try{ACTIVE_CTL&&ACTIVE_CTL.abort();}catch{}};
const fetchT=(opts,ms=90000)=>{
  const ctl=new AbortController();
  ACTIVE_CTL=ctl;
  const t=setTimeout(()=>ctl.abort(),ms);
  return fetch(API_URL,{...opts,signal:ctl.signal}).then(
    r=>({
      ok:r.ok,
      status:r.status,
      text:async()=>{try{return await r.text();}finally{clearTimeout(t);if(ACTIVE_CTL===ctl)ACTIVE_CTL=null;}},
    }),
    err=>{clearTimeout(t);if(ACTIVE_CTL===ctl)ACTIVE_CTL=null;throw err;}
  );
};
// Turns a prose paragraph into bullet lines (used for report sections written
// before the bullet format existed). Text that already has newlines passes through.
const bulletize=t=>{
  const s=String(t||"").trim();
  if(!s)return s;
  if(/\n/.test(s))return s;
  const parts=s.split(/(?<=[.!?])\s+(?=[A-Z"'(])/).map(p=>p.trim()).filter(Boolean);
  return parts.length>1?parts.map(p=>"- "+p).join("\n"):s;
};
// Mean + standard deviation over recorded scan times (needs ≥3 samples).
const mstats=arr=>{if(!arr||arr.length<3)return null;const m=arr.reduce((a,b)=>a+b,0)/arr.length;const sd=Math.sqrt(arr.reduce((a,b)=>a+(b-m)**2,0)/arr.length);return {m,sd};};

const storage = (typeof window !== "undefined" && window.storage && window.storage.get)
  ? window.storage
  : {
      async get(key){ try{ const v = localStorage.getItem(key); return v ? { value: v } : null; } catch { return null; } },
      async set(key, value){ try{ localStorage.setItem(key, value); return { value }; } catch { return null; } },
    };


const EXTRACT_PROMPT = `You are looking at what should be a LinkedIn profile screenshot. Return ONLY valid JSON, no markdown, no backticks.

FIRST — VALIDITY CHECK: if the image(s) do NOT contain readable career or education information (a meme, a random photo, abstract shapes, a non-profile webpage), return ONLY {"not_profile":true,"why":"one short plain-English sentence saying what the image appears to be"} and stop.

Otherwise extract:
- name: full name (string)
- uni: university name (string, or "Unknown" if not visible)
- uni_years: attendance years as shown, e.g. "2019 - 2022" (string, or "Not visible")
- year: graduation year or cohort e.g. "2024" (string, estimate from dates if possible)
- age: age as a number if determinable from graduation year or career timeline — estimate if needed (number)
- company: current or most recent company (string)
- role: current or most recent role title (string). If a current student with no active employment, do NOT force a role: use "Student" (with their university as company), or "Incoming <role> @ <firm> (<year>)" only when a future seat is clearly secured on the profile
- how: how they likely secured it — "internship" if they interned there first, "direct" if applied directly, "founder" if they founded or co-founded it, "lateral" if moved from similar role, "other" otherwise
- prev: estimated prior internships/roles as string — one of "0","1","2","3","4","5+"
- acts: activities, societies, awards, competitions, academic achievements mentioned — comma separated string, or "None"
- grades: visible academic results (A-levels, GCSEs, degree class, GPA, scholarships) as a string, or "Not visible"
- timeline: chronological list of roles with dates, e.g. "Jun 2023 spring week at X; Jul 2024 SWE intern at Y (10 wks); Sep 2024 co-founded Z" — keep dates, or "Not visible"
- evidence: concrete, near-verbatim artifacts and numbers from role/project descriptions (what was built, with what tech, for whom, any users/revenue/results/awards) — semicolon separated, or "None visible". Copy specifics, do not summarise into adjectives.
- notes: anything notable — non-target school, unusual background, startup traction signals, first from uni, context (military service, country switch), etc. Be specific.
- profile_type: classify as "finance", "technical", "founder", or "technical_founder" based on the dominant signal

Return ONLY: {"name":"...","uni":"...","uni_years":"...","year":"...","age":21,"company":"...","role":"...","how":"internship","prev":"1","acts":"...","grades":"...","timeline":"...","evidence":"...","notes":"...","profile_type":"finance"}`;

const SCORE_PROMPT = `You are a rigorous, skeptical career scout. You score the VISIBLE early-career signal in a profile summary. You are rating signal, not human worth. Follow every rule exactly.

═══ THE MEASUREMENT CONTRACT ═══
Reference population: career-focused university students and recent graduates who are active on LinkedIn.
- 50 is the MEDIAN of that population — typical, not bad.
- Use the FULL 1-99 range on every stat. Most real profiles should land between 30 and 75 on most stats. If all six of your scores sit between 55 and 85, you are compressing the scale — recheck against the anchors.
- Score each stat INDEPENDENTLY, as if the other five did not exist. One impressive fact must not raise all six scores (halo error). A single fact may feed several stats, but only through the property each stat measures — "Jane Street internship in first year" moves PRES (selectivity) and PACE (earliness), and moves DEPTH only if output is shown.
- Evidence beats vibes: institutions, dates, artifacts, numbers and conversions are evidence. Adjectives, buzzwords and self-descriptions are not.

═══ EVIDENCE DISCIPLINE ═══
1. Before scoring, list the concrete evidence: institutions, roles with dates, artifacts, numbers, awards.
2. Score each stat only from evidence relevant to THAT stat. If a stat has no relevant evidence, score it 40-55 (unknown is not bad and not good) and say so in its reason.
3. Never guess upward. A thin profile with one famous name = high PRES, low DEPTH — not high everything.

═══ SINGLE-HOME RULES (anti-double-counting) ═══
Each property of the evidence is scored in exactly one place:
- Selectivity of seats → PRES only
- Earliness vs stage → PACE only (age lives inside PACE; there is no separate age bonus anywhere)
- Starting context / background → REACH only
- Coherence of the pieces → STACK only
- Scarcity of the combination → RARE only
- Verified output → DEPTH only

═══ FIXED CALIBRATION ANCHORS (2K-style — the scale never moves) ═══
Like NBA 2K, every rating is ABSOLUTE against fixed reference standards — never relative to other profiles this user has scanned, and never affected by scan order. These three synthetic anchor profiles ARE the scale; place every real profile against them:
- ANCHOR ≈40 (developing): second-year business student, mid-ranked university, two society memberships, part-time retail work, nothing built or converted → PRES 35, PACE 45, REACH 45, STACK 38, RARE 30, DEPTH 40.
- ANCHOR ≈52 (standard/median): Russell Group economics, penultimate-year Big 4 summer internship secured on schedule, one elected society exec role, no artifacts or numbers described → PRES 55, PACE 50, REACH 50, STACK 55, RARE 40, DEPTH 50.
- ANCHOR ≈80 (rare tier): semi-target CS student, Y1 spring week converted to a BB summer, shipped app named on profile with ~2,000 users, coherent builder-meets-finance thesis → PRES 86, PACE 75, REACH 70, STACK 82, RARE 70, DEPTH 86.
SCAN INDEPENDENCE IS MANDATORY: identical evidence must produce the same six stats whether it is the first profile ever scanned or the hundredth. You have no knowledge of any other card in this user's pool — pool comparisons happen in the app, never in your scoring.

═══ INDUSTRY FAIRNESS ═══
Every industry has its own selectivity ladder, and the TOP of any ladder can score 90+. Finance and tech are two ladders among many — never treat them as the only elite paths:
- LAW: vacation schemes, magic/silver circle training contracts, competitive pupillages.
- MEDICINE & LIFE SCIENCES: competitive programmes, academic foundation posts, funded research schemes, publications.
- RESEARCH/ACADEMIA: funded summer research (UROP-type), first-author output, national olympiads and prizes.
- POLICY/GOV: Civil Service Fast Stream, competitive think-tank internships, parliamentary schemes.
- CREATIVE/MEDIA: commissioned work, competitive residencies/agencies, audiences and bodies of published work with numbers.
- SPORT, MILITARY, TRADES, NONPROFIT: selection rates, national-level competition, scale of responsibility.
Measure PRES by how selective the seat is WITHIN its own industry's ladder. Measure DEPTH by that industry's native artifacts (a case win, a publication, a portfolio, a funded grant — not just shipped software). A person is never marked down for being in a "less prestigious" industry; they are measured on how far up THEIR ladder they've climbed and what they've proven on it.

═══ STAT DEFINITIONS & ANCHORS ═══

PRES — Seat Selectivity (weight 20%)
"How hard is it to be admitted to the seats on this profile?" Judged by offer/admission rates and competition for the seat — not fame, not background. A selective degree course is a seat too.
Lens by profile type: FINANCE — firm + desk halo dominates (GS IBD ≠ GS ops; Goldman is Goldman whether from Cambridge or Coventry). TECHNICAL — course selectivity + employer hiring bar. FOUNDER — selectivity of BACKING (YC batch, funded round, selective accelerator). A self-created founder title carries NO selectivity by itself: anyone can print the title. An unbacked founder's credit lives in DEPTH (what they built) and PACE (how early), not here. EVERY OTHER INDUSTRY — use the INDUSTRY FAIRNESS ladders above: selectivity is measured within the person's own industry, and the top of any ladder can hit 90+.
- 90-99: multiple of the most selective seats in the market (sub-2% offer rates: Jane Street/Citadel/GS IBD/MBB, DeepMind, YC batch, IMO-level programmes)
- 70-89: one clearly elite seat, or several strongly selective ones (top EB M&A, FAANG SWE intern, Oxbridge/ETH/MIT on a competitive course)
- 50-69: solid selective seats — strong university + recognised scheme or mid-tier internships
- 30-49: mostly open-entry roles (societies, ambassador schemes, unselective internships)
- 1-29: no selective seat visible

PACE — Stage-Adjusted Earliness (weight 15%)
"How far ahead of the standard timeline is each milestone?" Standard timeline: spring week in Y1-Y2, penultimate-year summer internship, return offer at graduation. Age lives HERE — never add separate age credit.
- 90-99: operating 2+ years ahead (elite exposure before university; first year doing penultimate-level work)
- 70-89: about 1 year ahead (Y1 spring week or paid technical work; elite summer secured early)
- 50-69: on schedule
- 30-49: about a year behind, no visible context
- 1-29: several years behind, no context
Never punish military service, illness, founding a company, or switching countries — treat as on-schedule unless the evidence itself shows drift.

REACH — Contextual Overperformance (weight 15%)
"Given the visible starting context, how far above expectation did they land?" The ONLY stat where background, school type and access count.
- 90-99: non-target or adverse context → elite destination
- 70-89: clear overperformance (semi-target → BB front office; non-target → top tech)
- 50-69: destination in line with the platform (Oxbridge → GS is on-script: hard, not shocking)
- 30-49: mild underperformance versus the platform
- 1-29: elite platform → visibly weak destination, no context
If starting context is not visible, score 45-55 and say so in the reason.
OPPORTUNITY CAPTURE: REACH also measures how much of what was actually AVAILABLE in their context they took. Someone from a low-resource school, region or industry who visibly captured every opportunity open to them (every scheme, competition, society, funded programme their context offered) scores HIGH on REACH even when the absolute destination is modest — taking 90% of a small pond beats coasting on 20% of an ocean.

STACK — Compounding Narrative (weight 20%)
"Do the assets reinforce one thesis, or is it a LinkedIn buffet?" Judge coherence and thematic depth, not fame — an unknown startup with real technical work can compound a builder narrative better than a random famous badge.
- 90-99: 3+ assets where each builds on the last; one legible thesis
- 70-89: a clear 2-3 asset thread
- 50-69: partial coherence — a direction is guessable
- 30-49: accumulation without direction (internship + society + ambassador + podcast + crypto club)
- 1-29: contradictory pieces, or a single thin item (nothing to stack)

RARE — Configuration Scarcity (weight 5%)
"Out of 1,000 random profiles from the reference population, how many look like this one?" About 1 → 90s; about 10 → 70s; about 50 → 50s; about 200 → 30s; interchangeable → 1-29.
Lowest weight by design: scarcity is the hardest property to estimate from one screenshot, so it must season the OVR, not swing it. Do not re-reward difficulty (that is REACH) or brand (that is PRES) here.

DEPTH — Verified Output (weight 25%)
"What does the evidence prove they can DO?" Highest weight by design: output is the only signal that cannot be bought with a brand name or inflated language.
- 90-99: independently verifiable results — shipped product with usage or revenue numbers, publication, national competition win
- 70-89: concrete artifacts described with real technical or professional specifics (what was built, with what, for whom), or a performance conversion (spring → summer, return offer)
- 50-69: output plausible from a serious seat, but nothing described
- 30-49: titles only
- 1-29: buzzwords and inflated language only

═══ CONSISTENCY CHECKS (run after scoring) ═══
- If DEPTH ≥ 80 and STACK ≥ 80, PRES and RARE below 30 need an explicit reason in stat_reasons.
- If confidence is LOW, no stat may exceed 70 unless that specific stat's evidence is directly visible.
- Spiky profiles are normal and honest. Do not average stats toward each other, and do not push everything toward 65.
- SELF-CONSISTENCY IS MANDATORY: before writing ANY narrative field, compute the approximate weighted OVR from your six stats (PRES×0.20 + PACE×0.15 + REACH×0.15 + STACK×0.20 + RARE×0.05 + DEPTH×0.25) and calibrate every narrative field to the tier that OVR lands in (88+ elite, 78-87 rare, 65-77 uncommon, 50-64 standard, under 50 developing). NEVER tell a profile to "break into" a tier at or below its own OVR — if the OVR is already elite, tier_path is about defending and extending elite status. floor_ovr must be ≤ the approximate OVR, ceiling_ovr ≥ it, base_ovr between them.
- Advice must BUILD ON assets already held, never re-recommend them: if a bank seat is already secured, the next move is converting or extending that seat, not winning another entry-level seat.

═══ UK RECRUITING TIMELINE FACTS ═══
Use these mechanics exactly — getting them wrong destroys credibility:
- A spring week (Y1/Y2 insight programme) converts into a SUMMER INTERNSHIP THE FOLLOWING RECRUITING YEAR. A 2026 spring week feeds the 2027 summer internship — never the same summer.
- A penultimate-year summer internship converts into a GRADUATE return offer.
- Law: a vacation scheme converts into a training contract.
- First-years are not "behind" for lacking a summer internship — the standard first-year win is a spring week or insight programme.
Do NOT output an overall score. The app computes OVR = PRES×0.20 + PACE×0.15 + REACH×0.15 + STACK×0.20 + RARE×0.05 + DEPTH×0.25 from your six numbers. Your job is six honest, independent stats.

═══ ANTI-HALLUCINATION RULES ═══
Non-negotiable. Only describe what is VISIBLE in the evidence.
- Label every inference: "this suggests", "the visible evidence implies" — never state motivations, choices, or character as fact.
BAD: "He walked away from Goldman." GOOD: "The visible profile does not show a traditional elite internship route, so the path currently reads as self-directed rather than institutionally validated."
BAD: "A deliberate builder who avoids the corporate grind." GOOD: "No corporate internship is visible — which could indicate a deliberate founder path, or simply evidence not yet on the profile."
- Never claim a firm is elite unless you recognise it; if unknown, call it "an early-stage company with no publicly visible traction".
- If a section (e.g. education) is missing, acknowledge the gap rather than assume.

═══ LARP & SMURF AUDIT ═══
You audit evidence quality in BOTH directions. You audit CLAIMS, never character — do not accuse any person of lying; assess what the evidence can and cannot support.
- larp_check: three labelled parts in one string. VERIFIED: claims backed by independently checkable evidence (named institutions with dates, conversions, public artifacts, concrete numbers). UNVERIFIED: plausible claims resting only on self-description. SKEPTICISM WARRANTED: claims whose shape resembles inflation (grand titles with no described output, buzzword-dense descriptions, a timeline that does not add up) — for each, state exactly what evidence would settle it. Coherence matters: a stack that reads too clean with nothing verifiable underneath is itself a flag.
- smurf_check: the reverse audit. Strong operators often UNDERSELL — especially in IB and quant, profiles frequently show only the current seat with the history stripped and terse descriptions. Markers: elite current seat + near-empty history, one-line descriptions at serious firms, missing education on an otherwise senior profile. If markers are present, say so plainly, keep DEPTH conservative (unproven is unproven) but state that the true level likely EXCEEDS the visible score, and reflect this in confidence and confidence_reason rather than punishing PACE or REACH for missing history.

═══ CLASSIFICATION ═══
profile_type — the scoring lens for PRES. Choose the most accurate: "Finance / Consulting", "Technical Builder", "Founder", "Technical Founder", "Creator / Media", "Research / Academic", "Policy / Social Impact", "Law", "Healthcare / Life Sciences", "Generalist Operator", "Early Path", "Hybrid".
archetype — the narrative build: "Technical Founder Prospect", "Non-Target Breakout", "Prestige Stacker", "Platform Builder", "Applied AI Builder", "Creator-Operator Hybrid", "Research-Led Operator", "Finance Track Climber", "Academic Weapon", "High-Agency Generalist", "Founder Bet", "Foundation Builder".
CLASSIFICATION DISCIPLINE: labels must be EARNED by evidence, never defaulted. If the profile shows no selective seats, no professional artifacts and no clear directional thread yet (e.g. part-time service work plus a general degree), the correct read is profile_type "Early Path" + archetype "Foundation Builder" — an honest, respectful label for someone at the start. NEVER hand "Finance / Consulting" to a profile with no finance evidence, and "High-Agency Generalist" requires demonstrated agency (things they created or initiated), not its absence. Weak and strong profiles must not receive identical labels.
archetype_mix — when the profile genuinely straddles builds, up to 3 entries {"build":"...","weight":X} with integer percentage weights summing to 100, primary first (e.g. 60 Technical Founder Prospect / 40 Academic Weapon); a clean single-build profile gets one entry at 100.
type_reason — one sentence: why this profile_type and archetype (and mix weights, if split) were chosen over the nearest alternatives.
confidence — evidence quality: "HIGH" (education + experience + detailed descriptions all visible), "MEDIUM" (some detail, key sections missing), "LOW" (titles without context, or major sections absent).
confidence_reason — one sentence: what evidence was present and what was missing.

═══ SCOUTING REPORT ═══
Every sentence must do one of four jobs: cite visible evidence, interpret it (labelled as inference), state what it does not prove, or calibrate against the right peer group. Formula: EVIDENCE → INFERENCE → CAVEAT.
- moniker: 2-4 word punchy nickname grounded in what the profile actually shows. NEVER mock a person's job, employer, background or circumstances — the moniker is neutral-to-respectful; jokes live ONLY in the roast field. For modest or early profiles use grounded monikers ("The Groundwork Year", "Early Foundations"), never puns at the person's expense.
- thesis: one paragraph — the core read in one sentence using evidence, what makes it coherent or incoherent, and the central tension.
- best_signal: "Best signal: [specific visible evidence]. That suggests [labelled inference]. [Caveat]."
- weak_signal: the deeper missing category of validation, not just the surface gap.
- traits: what the path signals about agency and direction — every inference labelled.
- not_proven: specific capabilities not yet evidenced, calibrated to the exact peer group.
- peer_calibration: a LADDER of 4 named reference groups, one bullet each, ordered narrowest to widest: (1) exact peer group (e.g. "Warwick CS second-years chasing tech roles"), (2) their industry's student population overall, (3) all career-focused students on LinkedIn, (4) the general student/graduate population. For each: an honest standing statement. The wider the group, the stronger most profiles look — state that plainly and let modest profiles see the bigger-pond frames where they genuinely rank well. Honest, never inflated: if a profile is behind even the widest group, say so with the fastest fix.
- opportunity_capture: 2-4 bullets: what was actually AVAILABLE in this person's visible context (schemes, competitions, programmes, resources their school/industry/stage offers) vs what they TOOK. End with an honest capture read, e.g. "took most of what the context offered" or "clear available opportunities not yet taken: <named>". This is the done-vs-could-have-done section — generous to constrained contexts, honest about untaken chances.
- floor / base_case: realistic minimum and most likely outcome — name specific roles and company types.
- ceiling: the genuinely MAXED-OUT potential — the step-function best case if every lever from here hits, not a timid increment. Paint the future state concretely: what they are doing, at what firm tier or scale, with what artifacts and numbers, and roughly when. Young profiles with real signal normally carry ceilings in the 85-95 range; a ceiling_ovr within ~5 points of the current OVR requires explicit justification (late career stage or hard structural constraints).
- upgrade: the single most concrete thing that would improve this profile fastest.
- improvement_plan: 3-5 concrete moves ranked by expected OVR impact. Each move must name the stat it raises, the evidence gap it closes, and be verifiable once done (a shipped artifact with numbers, a named class of programme, a conversion). No platitudes.
- tier_path: what breaking into the next tier band up would require, and separately what the 88+ elite band demands - calibrated against real reference profiles, with no inflation of feasibility.
- floor_ovr / base_ovr / ceiling_ovr: hypothetical integer OVRs for the floor, base case and ceiling outcomes. Projections, not measurements - keep them consistent with the tier anchors and the current stats.
- projected_roles: 2-4 SPECIFIC, time-bound placement predictions, like a football scout naming the league and division — role + firm tier/scheme type + timeframe + likelihood word (likely / possible / stretch). Required shape: "Likely: growth hire at a seed/Series-A UK startup within 12 months. Stretch: APM-style rotational programme at a large tech firm at graduation." Vague phrasing like "good roles in business" is banned. These are projections — write them as projections.
- SPECIFICITY MANDATE (applies to every narrative field): name concrete things — scheme types, firm tiers, artifact shapes, numbers, terms and deadlines. "Build more projects" is banned; "ship <artifact type> with <number> users by <term>" is the required shape. If you cannot be specific, state exactly what information is missing instead of going vague.

Output ALL fields, in exactly the template order below. Write best_signal, weak_signal, traits, not_proven, larp_check, smurf_check, peer_calibration, opportunity_capture, projected_roles, floor, base_case, ceiling, upgrade, improvement_plan and tier_path as 2-5 newline-separated bullet lines, each starting with "- " (use \\n between bullets inside the JSON string). thesis, moniker, type_reason and confidence_reason stay as prose. Keep each narrative field under 60 words (thesis, larp_check, smurf_check, improvement_plan and tier_path may run to 120). An omitted field is a failure.
Return ONLY valid JSON, no markdown, no backticks:
{"PRES":X,"PACE":X,"REACH":X,"STACK":X,"RARE":X,"DEPTH":X,"stat_reasons":{"PRES":"one sentence citing the evidence used","PACE":"...","REACH":"...","STACK":"...","RARE":"...","DEPTH":"..."},"profile_type":"...","archetype":"...","archetype_mix":[{"build":"...","weight":100}],"confidence":"HIGH|MEDIUM|LOW","confidence_reason":"...","moniker":"...","thesis":"...","best_signal":"...","weak_signal":"...","traits":"...","not_proven":"...","peer_calibration":"...","opportunity_capture":"...","floor":"...","floor_ovr":X,"base_case":"...","base_ovr":X,"ceiling":"...","ceiling_ovr":X,"upgrade":"...","improvement_plan":"...","tier_path":"...","larp_check":"...","smurf_check":"...","projected_roles":"...","type_reason":"..."}`;

function erf(x){const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;const s=x<0?-1:1;x=Math.abs(x);const t=1/(1+p*x);return s*(1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));}
function getPct(cards,ovr){if(cards.length<5){const z=(ovr-58)/13;return Math.min(99,Math.max(1,Math.round(50*(1+erf(z/Math.sqrt(2))))));}return Math.min(99,Math.max(1,Math.round((cards.filter(c=>c.OVR<ovr).length/cards.length)*100)));}
function T(ovr){if(ovr>=88)return{bg:"#0b0700",strip:"#FFD700",stripD:"#8a5c00",acc:"#FFD700",glow:"#FFD70044",label:"ELITE",dot:"0.07"};if(ovr>=78)return{bg:"#060610",strip:"#8fa8ff",stripD:"#3348bb",acc:"#99b0ff",glow:"#8fa8ff44",label:"RARE",dot:"0.07"};if(ovr>=65)return{bg:"#090909",strip:"#c0c0c0",stripD:"#555",acc:"#d0d0d0",glow:"#cccccc33",label:"UNCOMMON",dot:"0.05"};return{bg:"#080600",strip:"#dd8800",stripD:"#6a3d00",acc:"#ee9900",glow:"#dd880033",label:"STANDARD",dot:"0.05"};}
function S(ovr){return ovr>=90?5:ovr>=80?4:ovr>=70?3:ovr>=60?2:1;}
const A=(c,p)=>`color-mix(in srgb, ${c} ${p}%, transparent)`;
const STATS=["PRES","PACE","REACH","STACK","RARE","DEPTH"];
const PROFILE_TYPES=["Finance / Consulting","Technical Builder","Founder","Technical Founder","Creator / Media","Research / Academic","Policy / Social Impact","Law","Healthcare / Life Sciences","Generalist Operator","Early Path","Hybrid"];
const ARCHETYPES=["Technical Founder Prospect","Non-Target Breakout","Prestige Stacker","Platform Builder","Applied AI Builder","Creator-Operator Hybrid","Research-Led Operator","Finance Track Climber","Academic Weapon","High-Agency Generalist","Founder Bet","Foundation Builder"];

// Rotating status lines so the wait shows how the card is actually being built.
const STAGES_EXTRACT=["Reading the screenshots…","Pulling out roles, dates & companies…","Copying concrete evidence & numbers…","Building the career timeline…"];
const STAGES_SCORE=["Weighing seat selectivity — PRES…","Timing milestones vs the standard path — PACE…","Judging contextual overperformance — REACH…","Testing narrative coherence — STACK…","Estimating configuration scarcity — RARE…","Verifying real output — DEPTH…","Locking six stats & computing the OVR…","Writing the scouting report…"];

// Turn raw claude.ai limit payloads into a human message with the reset time.
const friendlyErr=msg=>{
  if(/No JSON found|Response malformed/i.test(msg))return "The scout's reply came back garbled — usually a cut-off response, not a problem with what you pasted. Hit the button again; if it keeps happening, the screenshots may not contain enough readable profile text.";
  if(/abort/i.test(msg))return "Timed out waiting for the scout — the claude.ai proxy is congested right now, not a problem with your screenshots. Hit the button again (retries often go straight through); tighter/fewer screenshots read faster, off-peak hours are quicker, and the permanent fix is the local/Vercel build on your own API key, which skips the shared queue entirely.";
  if(/exceeded_limit/i.test(msg)){
    const m=msg.match(/"resets?_?at"\s*:\s*(\d{10})/i);
    const when=m?new Date(Number(m[1])*1000).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):null;
    return `Claude usage limit reached${when?` — it resets at ${when}`:""}. Come back then, or run the app locally with your own API key to skip session limits.`;
  }
  return `Error: ${msg}`;
};

// One model, no options: fast extraction + fast scoring with thinking disabled.
// Change these two lines if you ever want to experiment with a different model.
const EXTRACT_MODEL="claude-sonnet-5";
const SCORE_MODEL="claude-sonnet-5";

// Bumped whenever the scoring rubric changes meaningfully. Cards remember the
// version they were scored under; older cards get flagged as outdated.
const RUBRIC_VERSION=3; // v1.9: 2K anchors + industry fairness + opportunity capture

// Prompt for the hypothetical 90-OVR upgraded card.
const NINETY_PROMPT=`You are the same rigorous, skeptical career scout. You are given a real profile's current card. Produce the HYPOTHETICAL 90-OVR version of the SAME person - the upgraded future card, like a 69-rated player's 90-rated future edition. This answers: if this person MAXXED OUT their potential from here, what does that specifically look like? Rules:
- Stay in the same lane: same profile type and thesis. Upgrade the path, do not swap careers.
- summary must paint the maxed-out FUTURE STATE concretely: what they are doing day to day, at what firm tier or scale, with what named artifacts and numbers to their name, and roughly what year it is when this card exists. A step-function leap, not a timid increment — bounded only by evidence-based plausibility for this person's lane and stage.
- Every upgrade must be concrete and verifiable once done: named seat tiers, shipped artifacts with numbers, conversions, competition results. Do not invent specific facts about the person.
- This is a projection, not a measurement. Write "would require" / "would look like" throughout.
- No flattery, no overfitting: be brutal about the gap between the current card and 90.
- stat_moves must be SPECIFIC TO THIS PERSON: for each stat, one line naming what changes from their CURRENT number to the max number and the concrete thing that closes that exact gap (their industry, their assets, their stage — not generic advice).
- milestones are the catch-up route WITH DATES: 3-5 milestones in chronological order, each a verifiable achievement with an estimated time of arrival ("eta") derived from today's date, their current stage, and real recruiting/industry cycles (e.g. "Summer 2027", "by graduation 2028"). The LAST milestone's eta is the estimated arrival date of the full max projection.
Return ONLY valid JSON, no markdown, no backticks:
{"PRES":X,"PACE":X,"REACH":X,"STACK":X,"RARE":X,"DEPTH":X,"summary":"one paragraph: what this 90-OVR version of the same profile looks like","moves":"the 3-5 concrete jumps from the current card to this one, ranked by impact","stat_moves":{"PRES":"current→max: what specifically closes this gap for THIS person","PACE":"...","REACH":"...","STACK":"...","RARE":"...","DEPTH":"..."},"milestones":[{"m":"specific verifiable milestone","eta":"e.g. Summer 2027"}]}
Choose the six stats so the weighted OVR (PRES 20%, PACE 15%, REACH 15%, STACK 20%, RARE 5%, DEPTH 25%) lands between 88 and 92, with a shape consistent with the profile type.`;

// Dynamic, deadline-aware improvement checklist.
const PLAN_PROMPT=`You are the rigorous career scout acting as a coach for the app owner's own card. Produce a dynamic, time-aware improvement checklist. Rules:
- Respect today's date strictly: never propose actions whose window has passed. A spring week that already happened is not "convertible" if its conversion window is gone; recruiting cycles have deadlines — name them.
- Build on assets already held. Be hyper-specific: scheme types, artifact shapes, numbers, terms. Generic advice is banned.
- Tie every item to the single stat it raises and to the user's stated goals when given.
- Items previously marked DONE: propose the natural next step on top of them. Items marked NOT ELIGIBLE: never re-propose them or close variants.
Return ONLY valid JSON, no markdown: {"items":[{"t":"short imperative title","d":"2-3 sentences of specific execution detail including any real deadline","stat":"PRES|PACE|REACH|STACK|RARE|DEPTH"}]} with 4-7 items ranked by expected OVR impact.`;

// Standalone achievement rater for the HOW GOOD IS THIS? tab — no card required.
const HOWGOOD_PROMPT=`You are the rigorous, evidence-based career scout behind Career Signal. You are given ONE LinkedIn post (text and/or screenshot) announcing something: a job change, an offer, an academic result, a launch, an award, an opportunity. It may be the poster's own achievement, someone else's they're celebrating, or an opportunity listing — rate THE THING ITSELF, in its context.

RULES:
- Absolute scale, fixed anchors: 50 = the median achievement a career-focused student posts about (a standard internship offer at a recognisable firm, a solid grade, an elected society role). 80+ = genuinely rare (sub-5% selectivity seats, national-level wins, shipped things with real numbers). 95+ = exceptional at national scale. Use the FULL 1-99 range.
- INDUSTRY FAIRNESS: every industry has its own ladder — law, medicine, research, policy, creative, sport, trades, nonprofit. Measure how selective/rare this achievement is WITHIN its own industry and stage. Never mark something down for not being finance or tech.
- CONTEXT IS THE MULTIPLIER: the same achievement means different things from different starting points. A first-gen student from a non-target landing a BB spring week is a bigger signal than the same spring week from a target school. If context is visible or provided, weigh it. If not, say what context would change the read.
- OPPORTUNITY CAPTURE: include an honest read of what this achievement suggests about the person taking what was available to them — relative to what they could have done from their visible position. Someone maxing a constrained context reads HIGH.
- Never punitive: celebrate what is real about the win, be honest about its scale, and always name what would make it stronger. Audit claims, never character. Label every inference.
- The grade maps to the score: S=90+, A=80-89, B=65-79, C=50-64, D=under 50. The score uses the same 1-99 scale as Career Signal cards.

Return ONLY valid JSON, no markdown, no backticks:
{"headline":"one punchy sentence: the verdict","grade":"S|A|B|C|D","score":X,"what_it_is":"one sentence: what the post is announcing, neutrally","how_good":"3-5 bullet lines (\\n-separated, each starting '- '): how good this is and why — selectivity within its industry, earliness for the stage, rarity, what it proves","context_read":"2-3 bullets: how the visible/provided context changes the read, and what unknown context would move it most","vs_available":"2-3 bullets: the done-vs-could-have-done read — what this suggests about capturing available opportunities from their position","makes_it_stronger":"2-3 bullets: the specific follow-ups that would upgrade this achievement's signal","caveats":"1-2 bullets: what cannot be known from a post"}`;

const CHANGELOG=[
  {tag:"v1.9.1",date:"16 Jul 2026",items:["SECURITY: the API proxy is locked down — origin allowlist, single-model whitelist, server-side token cap and per-IP rate limiting; outside scripts can no longer ride the app's credentials","Non-profile images get a plain-English message ('that looks like a meme…') instead of a raw JSON error, and garbled scout replies get a human retry message","Classification discipline: thin profiles now read as EARLY PATH · FOUNDATION BUILDER instead of inheriting finance labels they haven't earned; monikers are banned from mocking anyone's job — jokes live in the roast only","MAX PROJECTION fixed (responses were getting cut off) and re-aimed: it now paints the fully maxxed-out future — what you're doing, where, with what numbers, and when","Ceilings un-nerfed: a ceiling within ~5 OVR of current now needs explicit justification; young profiles with real signal normally ceiling 85-95","GOT AN UPDATE? — updating a card now shows everything already on record so you only screenshot what's new, and established info is merged forward automatically","Outdated-rubric flags: cards scored under an older rating system get a * on the leaderboard and a re-score banner on their profile; every OVR change now says WHY (system update vs profile change)","Re-scores that come back HIGHER re-run the pack-opening reveal","Screenshot viewer rebuilt: plain click to enlarge (no magnifier cursor), ‹ › arrows and swipe to browse, an explicit red ✕ DELETE, and 'click anywhere to dismiss' in words","MY CARD: pick your aspirational type and build and see the gap between how you see yourself and how the scout reads you — one tap asks the scout what closes it","Profiles that straddle builds now show percentage archetype mixes (60% Technical Founder · 40% Academic Weapon)","Dark mode text lifted to white across the board","DEEP DIVE ANALYSIS: the full scouting rationale now lives in one collapsed section under the stats — your rating first, the reasoning when you want it","HOW GOOD IS THIS? restyled to match the create flow — paste a screenshot anywhere on the page, drop zone included","Mobile: OS-aware screenshot instructions (no more Windows keys on iPhones) and an 8px grace margin around every button","LinkedIn link previews: proper og: tags + a share image instead of a bare grey card"]},
  {tag:"v1.9",date:"16 Jul 2026",items:["HOW GOOD IS THIS? — new tab: paste any LinkedIn post (text or screenshot) announcing an achievement and get a graded, context-aware breakdown on the same 1-99 scale — with a done-vs-could-have-done read and an optional follow-up chat","2K-style fixed calibration anchors: three synthetic reference profiles are now baked into every scan so identical evidence scores identically regardless of scan order — scans never calibrate against your pool","Industry fairness taught to the scout: law, medicine, research, policy, creative, sport and more each have their own selectivity ladder — the top of ANY ladder can hit 90+, and nobody is marked down for not being in finance or tech","Peer calibration is now a 4-rung ladder from your exact peer group out to the general population — modest cards get the honest bigger-pond frames where they genuinely rank well","OPPORTUNITY CAPTURE on every new scan: what was available in their context vs what they took","MAX PROJECTION now shows the per-stat current→max breakdown specific to the person, plus a dated milestone timeline with an estimated arrival for the full projection","Team of the Year now requires 80+ OVR — top-5 cards below 80 show as PENDING MORE CARDS","Stat rationale is click-to-expand per stat — clean numbers by default","Every button gives pressed feedback (shadow + press-down) and is clickable across its whole surface","Click any pasted screenshot to inspect it full-size before analysing","Versus verdicts name the actual people — no more Card A vs Card B","Card reveal cleaned up: copy removed, tier glow massively strengthened","Scan timing telemetry moved behind a settings toggle (⚙, default off)"]},
  {tag:"v1.8.2",date:"4 Jul 2026",items:["Watchdog blind spot fixed: the timeout only covered the connection handshake, not reading the response body — which is exactly where the claude.ai proxy stalls (your 556s scan proved it). The abort now covers the full round trip and actually fires","CANCEL button on every progress bar — kill a stuck request instantly and retry, no waiting for any timer","Scoring abort ceiling raised to 150s to fit the larger 5K-token reports on a congested proxy; extraction stays at 90s"]},
  {tag:"v1.8.1",date:"4 Jul 2026",items:["Report sections (Best Signal through Breaking Into The Higher Tiers) now render as bullet points — new scans write bullets natively, and older prose cards are auto-bulleted client-side","VS THE POOL on every profile: each stat and the OVR against the pool average with delta and rank (#3 of 12), fully deterministic","Natural segue into Versus: FULL MATCHUP VS THE FIELD and a vs-a-card picker jump straight into the head-to-head with both slots pre-filled"]},
  {tag:"v1.8",date:"4 Jul 2026",items:["Truncation bug fixed: the report had outgrown its token budget, silently cutting best/weak signal and confidence rationale off NEW cards — budget raised to 5K with a hard every-field-in-order, word-capped rule","Sanity Check panel: after every scan the app itself audits the OVR against its own rationale — flags elite-OVR-on-LOW-confidence, prestige-carried ratings with thin DEPTH, rare-but-incoherent reads, and suspiciously flat stat lines","Dense AI text now renders structured: headers, bold leads and bullets instead of a wall — applied to verdicts, max projection, ceiling-reference notes, post reads and chat","Analysis sections are click-to-expand — scan the labels, open only what you want; missing ones say 'needs re-score' right in the header","RE-SCORE now shows the full progress bar with stages, % and elapsed seconds","Gap verdicts gained EVIDENCE TO WATCH: exactly what would have to appear for the gap to close","Roast is always generated — the toggle now only controls instant reveal; every card has a REVEAL button","Type/archetype rationale shown under the chips; Evidence Confidence explains itself or says re-score","Full first + last name on the card side strip and the share card"]},
  {tag:"v1.7.2",date:"4 Jul 2026",items:["Report sections never silently disappear: cards scored by older versions now show every section (floor, ceiling, best/weak signal, LARP, smurf, projected placements…) with a RE-SCORE hint where the data doesn't exist yet","Stat hover cards follow the mouse — positioned at your cursor, clamped to the viewport","Ceiling References expand in place: WHY THIS REFERENCE? generates a verdict (good / partial / bad reference), what separates their stat shape, and the one thing to copy — cached on the card; OPEN THEIR CARD is now a separate button","POST SIGNAL accepts screenshots — paste an image straight into the box or use + SCREENSHOT; text, image, or both"]},
  {tag:"v1.7.1",date:"4 Jul 2026",items:["Watchdog on every AI call: nothing can hang forever any more — extraction aborts at 90s, scoring at 110s, with a clear retry message instead of a frozen bar","Scan-time telemetry: the app records your last 30 extraction and scoring durations and shows your typical time (±σ) under the progress bar","2σ overrun warning: if a scan runs past two standard deviations of your own baseline, an amber warning names the likely cause (proxy congestion) and the abort time","Timeouts produce an actionable message: retry, tighter screenshots, off-peak, or the Vercel build on your own key which skips the shared queue"]},
  {tag:"v1.7",date:"4 Jul 2026",items:["Rebrand: CAREER SIGNAL — matter-of-fact philosophy stays, name now says what it measures","The scout now knows TODAY'S DATE in every scan, chat, plan and projection — no more advising conversions on windows that already closed","SIGNAL PLAN on your card: state your goals, generate a deadline-aware checklist, tick ✓ done or ✕ not-eligible, refresh builds on progress and never re-proposes dead items","PROJECTED PLACEMENTS on every scan: specific, time-bound role predictions with likelihood — the scout names the league, not just the rating","SPECIFICITY MANDATE baked into the rubric: scheme types, firm tiers, numbers and deadlines required; vague advice is banned phrasing","POST SIGNAL: paste someone's LinkedIn post and the scout reads it as a directional telegraph against their thesis","MAX PROJECTION (renamed from 90 OVR Projection)","Photo UPDATE no longer wipes a card's chat, plan, posts or max projection","Progress bar: ceiling raised to 99, 'estimated' small print removed, live elapsed-seconds counter added","One-click ⬇ backup in the nav — and the permanent no-export home for your collection is the Vercel build, where localStorage survives every code update"]},
  {tag:"v1.6.1",date:"4 Jul 2026",items:["Leaderboard columns fixed: header now aligns with rows (the grids were mismatched), and shows University + Archetype/Type instead of company","Pool % gated: below 30 profiles the leaderboard shows tier, not percentile — small pools make percentiles jump 10+ points per card, which read as broken","RESTORE BACKUP on the empty home screen — recovery path if a version update started you fresh (old artifact still holds your cards: open it → leaderboard → EXPORT, then restore here)"]},
  {tag:"v1.6",date:"4 Jul 2026",items:["Consistency fix: the scout now computes its own approximate OVR before writing tier paths, floors and ceilings — no more 'break into 80-87' on a 92 card; the app also hard-clamps floor ≤ OVR ≤ ceiling","UK recruiting mechanics taught to the scout: spring weeks convert to NEXT year's summer, summers to grad offers, vac schemes to training contracts — and advice must build on seats already held","RE-SCORE button on every profile: re-runs the scout on stored data — old cards get all new report sections, no screenshots needed","Card faces now lead with the archetype (the build), profile type underneath, firm in the badge","Scout Chat FAQ chips: one-tap questions like 'Why is this profile not rated higher?'","ANALYSE GAP on each pinned benchmark: an evidence-argued verdict on your gap, inline under My Card","Leaderboard cohort filter + like-for-like disclaimer — compare first-years to first-years","Extraction no longer forces a current role onto students: 'Student' or 'Incoming X @ Y' instead","Card Generated / Last Rescan dates in Profile Details","Ceiling-reference and benchmark clicks now jump to the top of the selected card"]},
  {tag:"v1.5",date:"4 Jul 2026",items:["LARP Check on every new scan: claims sorted into VERIFIED / UNVERIFIED / SKEPTICISM WARRANTED, with what evidence would settle each — audits claims, never accuses people","Smurf Check: detects the stripped-history pattern (common in IB/quant) and marks the score as likely UNDERSTATING the person instead of punishing missing history","Versus now explains itself: WHAT SEPARATES THEM shows each stat's exact contribution to the OVR gap (difference × weight)","GENERATE SCOUT VERDICT in Versus: an evidence-argued read on why one card is higher, where the other is underrated, and what would flip it","CRACKED RUBRIC in the Guide: your evolving taste document, injected into every scan, chat and verdict — evidence discipline still wins"]},
  {tag:"v1.4",date:"4 Jul 2026",items:["Hexagon stat radar on every profile, plus an overlay radar in Versus","THE FIELD in Versus: benchmark any card against the pool average — the pool sharpens as you add profiles","Claim your card with THIS IS ME? (one card only) — starred on the leaderboard, ★ MY CARD shortcut in the nav","Benchmark Index on your card: pin reference profiles, see per-stat gaps, and whether each gap is closing or widening across rescans","Ceiling References: real cards from your pool shown next to each profile's hypothetical ceiling","OVR-over-time graph on any rescanned card","Scout Knowledge: teach the scout context about programmes and achievements — injected into every scan and chat","Removed the duplicated rationale from the stat hover (kept inline under each bar)"]},
  {tag:"v1.3",date:"3 Jul 2026",items:["Per-stat rationale now visible under every stat bar, and inside the hover cards","Hover cards repositioned beside the stat so they never clip off-screen","Gold borders + glow on the stat breakdown, overall rating, thesis and detail panels - in light mode too","Improvement Plan (ranked by OVR impact) and Breaking Into The Higher Tiers added to every new scan","Floor / Base Case / Ceiling now carry hypothetical OVR numbers, labelled as projections","90 OVR Projection: generate the hypothetical elite version of any card - same lane, evidence-based jumps only","Scout Chat on every profile - discuss the rating, ceiling and next moves, grounded in the card's evidence","University years added to extraction and Profile Details","'1 PROFILES' grammar fixed; singular/plural handled everywhere","This changelog tab"]},
  {tag:"v1.2",date:"3 Jul 2026",items:["Scoring latency fixed - extended thinking disabled and token budget right-sized (minutes to seconds)","Estimated progress bar with staged build messages replaces the spinner","Dark-mode text contrast lifted across the whole app","Usage-limit errors now show a clean message with the reset time instead of raw JSON"]},
  {tag:"v1.0",date:"2 Jul 2026",items:["Core scan flow: screenshot, extraction, six-stat scoring, card reveal","Leaderboard, Versus mode, share cards, roast mode, light/dark themes","Export / import so collections survive version updates"]},
];

const STAT_INFO={
  PRES:{full:"Prestige — Seat Selectivity · 20%",color:"var(--gold)",desc:"How hard is it to be ADMITTED to the seats on this profile — measured within the person's OWN industry's ladder. Law, medicine, research, policy, creative and sport all have elite seats that score 90+; nobody is marked down for not being in finance or tech. A selective degree course counts as a seat. A self-created founder title doesn't: anyone can print one — unbacked founders earn credit in Depth and Pace instead.",examples:["Jane Street/GS IBD/MBB/DeepMind/YC/magic circle TC → 90-99","Top EB, FAANG intern, competitive pupillage/residency → 70-89","Strong uni + recognised scheme in any industry → 50-69","Open-entry roles only (societies, ambassador) → 30-49"]},
  PACE:{full:"Pace — Stage-Adjusted Earliness · 15%",color:"var(--c-pace)",desc:"How far ahead of the standard recruitment timeline is each milestone? Age lives here — there is no separate age bonus anywhere in the system. Military service, illness, founding, or switching countries never count as 'behind'.",examples:["2+ years ahead (pre-uni elite exposure) → 90-99","~1 year ahead (Y1 spring / early elite summer) → 70-89","On schedule → 50-69","Behind with no visible context → 1-49"]},
  REACH:{full:"Reach — Contextual Overperformance · 15%",color:"var(--c-reach)",desc:"Given the visible starting context, how far above expectation did they land — AND how much of what was actually available did they capture? Someone who took every opportunity their context offered scores high here even if the absolute destination is modest. The ONLY stat where background, school type and access count. If the starting context isn't visible, this sits near 50.",examples:["Non-target / adverse context → elite destination → 90-99","Captured nearly everything their context offered → 70-89","On-script for the platform (Oxbridge → GS) → 50-69","Elite platform → weak destination, no context → 1-49"]},
  STACK:{full:"Stack — Compounding Narrative · 20%",color:"var(--c-stack)",desc:"Do the assets reinforce one thesis, or is it a LinkedIn buffet? Judged on coherence, not fame — an unknown startup with real technical work can compound a builder narrative better than a random famous badge.",examples:["3+ assets, each building on the last → 90-99","Clear 2-3 asset thread → 70-89","A direction is guessable → 50-69","Accumulation without direction → 30-49"]},
  RARE:{full:"Rarity — Configuration Scarcity · 5%",color:"var(--c-rare)",desc:"Of 1,000 random career-focused profiles, how many look like this one? Deliberately the lowest weight: scarcity is the hardest thing to estimate from a screenshot, so it seasons the OVR rather than swinging it.",examples:["~1 in 1,000 → 90-99","~10 in 1,000 → 70-89","~50 in 1,000 → 50-69","Interchangeable with peers → 1-49"]},
  DEPTH:{full:"Depth — Verified Output · 25%",color:"var(--c-depth)",desc:"What does the evidence prove they can actually DO? Deliberately the highest weight: output is the only signal that can't be bought with a brand name or inflated language. Prestige gets you noticed — Depth is whether there's a person behind the logo.",examples:["Verifiable results: users, revenue, publication, national win → 90-99","Concrete artifacts described, or spring→summer conversion → 70-89","Serious seat, nothing described → 50-69","Titles or buzzwords only → 1-49"]},
};

function StatTooltip({stat,reason,children}){
  const [show,setShow]=useState(false);
  const [pos,setPos]=useState({x:0,y:0});
  const info=STAT_INFO[stat];
  const move=e=>setPos({x:e.clientX,y:e.clientY});
  const W=280;
  const vw=typeof window!=="undefined"?window.innerWidth:1200;
  const vh=typeof window!=="undefined"?window.innerHeight:800;
  const left=Math.min(Math.max(pos.x+18,8),vw-W-12);
  const top=Math.min(pos.y+16,vh-280);
  return(
    <div style={{position:"relative",display:"inline-flex",alignItems:"center"}} onMouseEnter={e=>{setShow(true);move(e);}} onMouseMove={move} onMouseLeave={()=>setShow(false)}>
      {children}
      {show&&info&&(
        <div style={{position:"fixed",left,top,width:W,background:"var(--s11)",border:`1px solid ${A(info.color,33)}`,borderRadius:8,padding:"12px 14px",zIndex:200,pointerEvents:"none",boxShadow:`0 0 18px ${A(info.color,13)}`}}>
          <div style={{color:info.color,fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1,marginBottom:4}}>{info.full}</div>
          <div style={{color:"var(--v888)",fontSize:9,lineHeight:1.6,marginBottom:6}}>{info.desc}</div>
          <div style={{display:"flex",flexDirection:"column",gap:2}}>
            {info.examples.map((ex,i)=><div key={i} style={{color:"var(--v555)",fontSize:8,letterSpacing:0.5}}>· {ex}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}

function Star({sz}){return <div style={{width:sz,height:sz,background:"rgba(0,0,0,0.55)",clipPath:"polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)",flexShrink:0}}/>;}

function CardBack({glow,sz=1.05}){
  const w=Math.round(220*sz),h=Math.round(310*sz);
  return(
    <div style={{width:w,height:h,borderRadius:8,background:"#0b0b0b",border:"1px solid #333",boxShadow:`0 0 50px 12px ${glow},0 0 120px 36px ${glow},0 0 220px 60px ${glow},0 6px 18px #00000099`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:12,position:"relative",overflow:"hidden",animation:"pulseGlow 1.6s ease-in-out infinite",fontFamily:"'Bebas Neue',sans-serif",userSelect:"none"}}>
      <div style={{position:"absolute",inset:0,backgroundImage:"repeating-linear-gradient(45deg,transparent 0 14px,rgba(255,255,255,0.025) 14px 28px)"}}/>
      <div style={{width:76,height:76,borderRadius:"50%",border:"2px solid #FFD70055",display:"flex",alignItems:"center",justifyContent:"center",fontSize:30,color:"#FFD700",letterSpacing:2}}>CS</div>
      <div style={{color:"#ffffff44",fontSize:12,letterSpacing:4}}>CAREER SIGNAL</div>
      <div style={{color:"#ffffff22",fontSize:8,letterSpacing:2,fontFamily:"'Space Mono',monospace"}}>TAP TO REVEAL</div>
    </div>
  );
}

function ShareCard({card,onClose}){
  const t=T(card.OVR);
  const thesis1=card.thesis?card.thesis.split(".")[0]+".":"";
  const confColor=card.confidence==="HIGH"?"#88cc00":card.confidence==="LOW"?"#cc4400":"#cc8800";
  const [saving,setSaving]=useState(false);
  const [saveErr,setSaveErr]=useState("");
  const download=async()=>{
    setSaving(true);setSaveErr("");
    const withTimeout=(p,ms)=>Promise.race([p,new Promise((_,rej)=>setTimeout(()=>rej(new Error("render timed out")),ms))]);
    try{
      // Dynamic import: available locally via Vite; unavailable in the artifact
      // sandbox, where this throws and the catch shows the screenshot hint.
      const { toPng } = await import("html-to-image");
      const node=document.getElementById("share-card-inner");
      let url;
      try{url=await withTimeout(toPng(node,{pixelRatio:2}),8000);}
      catch{url=await withTimeout(toPng(node,{pixelRatio:2,skipFonts:true}),8000);}
      const a=document.createElement("a");
      a.download=`${(card.name&&card.name!=="Unknown"?card.name:card.moniker||"card").replace(/\s+/g,"-").toLowerCase()}-career-attack.png`;
      a.href=url;a.click();
    }catch(e){console.error("PNG export failed",e);setSaveErr("Export failed — take a screenshot instead");}
    finally{setSaving(false);}
  };
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:24}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{maxWidth:420,width:"100%"}}>
        <div id="share-card-inner" style={{background:t.bg,border:`1px solid ${t.acc}44`,borderRadius:12,padding:"28px 24px",fontFamily:"'Bebas Neue',sans-serif",boxShadow:`0 0 40px ${t.glow}`}}>
          {/* Header */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
            <div>
              <div style={{color:t.acc,fontSize:32,letterSpacing:2,lineHeight:1}}>{card.name!=="Unknown"?card.name.toUpperCase():"UNKNOWN"}</div>
              <div style={{color:"#ffffff55",fontSize:11,letterSpacing:1,marginTop:2,fontFamily:"'Space Mono',monospace"}}>{card.uni}</div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:56,color:t.acc,lineHeight:1,textShadow:`0 0 20px ${t.acc}66`}}>{card.OVR}</div>
              <div style={{color:t.acc,fontSize:8,letterSpacing:3,opacity:0.6}}>OVR</div>
            </div>
          </div>
          {/* Type + Archetype */}
          <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
            {card.profile_type&&<div style={{background:`${t.acc}14`,border:`1px solid ${t.acc}33`,borderRadius:3,padding:"3px 8px",color:t.acc,fontSize:7,letterSpacing:1,textTransform:"uppercase",opacity:0.8,fontFamily:"'Space Mono',monospace"}}>{card.profile_type}</div>}
            {card.archetype&&<div style={{background:`${t.acc}14`,border:`1px solid ${t.acc}33`,borderRadius:3,padding:"3px 8px",color:t.acc,fontSize:7,letterSpacing:1,textTransform:"uppercase",opacity:0.8,fontFamily:"'Space Mono',monospace"}}>{card.archetype}</div>}
          </div>
          {/* Stat bars */}
          <div style={{display:"flex",flexDirection:"column",gap:5,marginBottom:16}}>
            {STATS.map(st=>{
              const v=card.stats[st];
              const info=STAT_INFO[st];
              return(
                <div key={st} style={{display:"flex",alignItems:"center",gap:8}}>
                  <span style={{color:"#ffffff33",fontSize:8,minWidth:34,letterSpacing:0.5,fontFamily:"'Space Mono',monospace"}}>{st}</span>
                  <div style={{flex:1,height:3,background:"#ffffff0a",borderRadius:2,overflow:"hidden"}}>
                    <div style={{width:`${v}%`,height:"100%",background:t.acc,opacity:0.7}}/>
                  </div>
                  <span style={{color:"#ffffff77",fontSize:10,minWidth:20,textAlign:"right"}}>{v}</span>
                </div>
              );
            })}
          </div>
          {/* Thesis one-liner */}
          {thesis1&&<div style={{color:"#ffffff44",fontSize:9,lineHeight:1.6,marginBottom:14,fontFamily:"'Space Mono',monospace",fontStyle:"italic",borderLeft:`2px solid ${t.acc}33`,paddingLeft:10}}>{thesis1}</div>}
          {/* Footer */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",borderTop:`1px solid ${t.acc}22`,paddingTop:12}}>
            <div style={{color:"#ffffff22",fontSize:7,letterSpacing:1,fontFamily:"'Space Mono',monospace"}}>based on visible profile evidence only</div>
            <div style={{color:t.acc,fontSize:9,letterSpacing:2,opacity:0.5}}>CAREER SIGNAL</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:14,justifyContent:"center"}}>
          <button onClick={download} disabled={saving} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"9px 22px",borderRadius:5,cursor:saving?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase",opacity:saving?0.6:1}}>{saving?"RENDERING…":"⬇ DOWNLOAD PNG"}</button>
        </div>
        <div style={{color:saveErr?"#ff4444":"var(--v333)",fontSize:8,letterSpacing:1,fontFamily:"'Space Mono',monospace",textAlign:"center",marginTop:8}}>{saveErr||"saves a 2× image ready for stories & group chats"}</div>
        <button onClick={onClose} style={{display:"block",margin:"8px auto 0",background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>CLOSE</button>
      </div>
    </div>
  );
}function Card({card,onClick,sz=1}){
  const t=T(card.OVR),s=S(card.OVR),w=Math.round(220*sz),h=Math.round(310*sz);
  const displayName=card.name&&card.name!=="Unknown"?card.name:(card.moniker||"Unknown");
  const ln=displayName.toUpperCase();
  const ini=card.moniker?card.moniker.split(" ").map(n=>n[0]).join("").slice(0,2).toUpperCase():(displayName.split(" ").map(n=>n[0]).join("").slice(0,2).toUpperCase());
  return(
    <div onClick={onClick} style={{width:w,height:h,position:"relative",cursor:onClick?"pointer":"default",borderRadius:Math.round(8*sz),overflow:"hidden",flexShrink:0,background:t.bg,border:`1px solid ${t.acc}33`,boxShadow:`0 0 ${Math.round(20*sz)}px ${t.glow},0 ${Math.round(4*sz)}px ${Math.round(14*sz)}px #00000099`,fontFamily:"'Bebas Neue',sans-serif",transition:"transform 0.15s,box-shadow 0.15s",userSelect:"none"}}
    onMouseEnter={e=>{if(onClick){e.currentTarget.style.transform="translateY(-3px) scale(1.02)";e.currentTarget.style.boxShadow=`0 0 ${Math.round(32*sz)}px ${t.glow},0 ${Math.round(10*sz)}px ${Math.round(24*sz)}px #000000bb`;}}}
    onMouseLeave={e=>{if(onClick){e.currentTarget.style.transform="";e.currentTarget.style.boxShadow=`0 0 ${Math.round(20*sz)}px ${t.glow},0 ${Math.round(4*sz)}px ${Math.round(14*sz)}px #00000099`;}}}>
      <div style={{position:"absolute",inset:0,backgroundImage:`radial-gradient(circle,rgba(255,255,255,${t.dot}) 1px,transparent 1px)`,backgroundSize:`${8*sz}px ${8*sz}px`,zIndex:0}}/>
      <div style={{position:"absolute",inset:0,background:`linear-gradient(115deg,transparent 25%,${t.glow} 50%,transparent 75%)`,backgroundSize:"200% 200%",animation:"shimmer 3.5s ease-in-out infinite",zIndex:1,pointerEvents:"none"}}/>
      <div style={{position:"absolute",left:0,top:0,bottom:Math.round(72*sz),width:Math.round(30*sz),zIndex:2,background:`linear-gradient(180deg,${t.strip},${t.stripD},${t.strip})`,display:"flex",flexDirection:"column",alignItems:"center",padding:`${Math.round(6*sz)}px ${Math.round(2*sz)}px`,gap:Math.round(3*sz)}}>
        {[...Array(s)].map((_,i)=><Star key={i} sz={Math.round(8*sz)}/>)}
        <div style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",writingMode:"vertical-rl",textOrientation:"mixed",transform:"rotate(180deg)",color:"rgba(0,0,0,0.55)",fontSize:Math.round(11*sz),fontWeight:700,letterSpacing:1,textTransform:"uppercase",lineHeight:1,overflow:"hidden",maxHeight:"65%"}}>{ln}</div>
      </div>
      <div style={{position:"absolute",left:Math.round(30*sz),right:0,top:0,bottom:Math.round(72*sz),zIndex:2,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:Math.round(10*sz)}}>
        <div style={{width:Math.round(62*sz),height:Math.round(62*sz),borderRadius:"50%",background:`radial-gradient(circle at 30% 30%,${t.acc}33,${t.acc}0a)`,border:`${Math.round(1.5*sz)}px solid ${t.acc}55`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:Math.round(22*sz),color:t.acc,fontWeight:900,boxShadow:`0 0 ${Math.round(14*sz)}px ${t.glow}`,marginBottom:Math.round(6*sz)}}>{ini}</div>
        <div style={{color:t.acc,fontSize:Math.round(9*sz),textAlign:"center",letterSpacing:1,textTransform:"uppercase",fontWeight:700,maxWidth:Math.round(150*sz),overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{card.archetype||card.company}</div>
        <div style={{color:"#ffffff66",fontSize:Math.round(7*sz),textAlign:"center",textTransform:"uppercase",marginTop:Math.round(2*sz),maxWidth:Math.round(150*sz),overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{card.archetype?(card.profile_type||card.role):card.role}</div>
        {card.archetype&&<div style={{marginTop:Math.round(6*sz),background:`${t.acc}18`,border:`1px solid ${t.acc}44`,borderRadius:Math.round(3*sz),padding:`${Math.round(2*sz)}px ${Math.round(8*sz)}px`,color:t.acc,fontSize:Math.round(6*sz),letterSpacing:1,textTransform:"uppercase",textAlign:"center",maxWidth:Math.round(150*sz),overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{card.company}</div>}
      </div>
      <div style={{position:"absolute",left:0,right:0,bottom:0,height:Math.round(72*sz),zIndex:3,background:"rgba(0,0,0,0.88)",borderTop:`1px solid ${t.acc}33`,display:"grid",gridTemplateColumns:"1fr 1fr",padding:`${Math.round(5*sz)}px ${Math.round(8*sz)}px`,gap:`${Math.round(1*sz)}px ${Math.round(8*sz)}px`,alignContent:"center"}}>
        {STATS.map(st=>(
          <div key={st} style={{display:"flex",alignItems:"center",gap:Math.round(3*sz)}}>
            <span style={{color:"#ffffff44",fontSize:Math.round(7*sz),minWidth:Math.round(28*sz),letterSpacing:0.5}}>{st}</span>
            <span style={{color:"#fff",fontSize:Math.round(9*sz),fontWeight:700,minWidth:Math.round(16*sz)}}>{card.stats[st]}</span>
            <div style={{flex:1,height:Math.round(2*sz),background:"#ffffff11",borderRadius:1,overflow:"hidden"}}><div style={{width:`${card.stats[st]}%`,height:"100%",background:t.acc,opacity:0.65}}/></div>
          </div>
        ))}
      </div>
      <div style={{position:"absolute",right:Math.round(8*sz),bottom:Math.round(76*sz),zIndex:4,textAlign:"right"}}>
        <div style={{fontSize:Math.round(30*sz),color:t.acc,lineHeight:1,textShadow:`0 0 ${Math.round(12*sz)}px ${t.acc}`}}>{card.OVR}</div>
        <div style={{fontSize:Math.round(6*sz),color:t.acc,letterSpacing:2,textTransform:"uppercase",opacity:0.7}}>OVR</div>
      </div>
      <div style={{position:"absolute",left:Math.round(36*sz),bottom:Math.round(76*sz),zIndex:4}}>
        <div style={{color:"#ffffff44",fontSize:Math.round(6*sz),letterSpacing:0.5,textTransform:"uppercase"}}>{card._totalCards>=30?"BETA PCT":"TIER"}</div>
        <div style={{color:"#fff",fontSize:Math.round(15*sz),lineHeight:1}}>{card._totalCards>=30?`T${100-(card.percentile||50)}%`:T(card.OVR).label}</div>
      </div>
    </div>
  );
}

function Bell({cards,targetOvr,acc="var(--gold)"}){
  const mean=cards.length>=5?cards.reduce((s,c)=>s+c.OVR,0)/cards.length:65;
  const variance=cards.length>=5?cards.reduce((s,c)=>s+(c.OVR-mean)**2,0)/cards.length:144;
  const std=Math.sqrt(variance)||12,W=260,H=72,pad=16;
  const xMin=Math.max(0,mean-4*std),xMax=Math.min(99,mean+4*std);
  const toX=v=>pad+(v-xMin)/(xMax-xMin)*(W-2*pad);
  const pdf=x=>(1/(std*Math.sqrt(2*Math.PI)))*Math.exp(-0.5*((x-mean)/std)**2);
  const pts=[];for(let x=xMin;x<=xMax;x+=0.5)pts.push({x,y:pdf(x)});
  const maxY=Math.max(...pts.map(p=>p.y))||1,toY=v=>H-8-(v/maxY)*(H-18);
  const path=pts.map((p,i)=>`${i===0?"M":"L"}${toX(p.x).toFixed(1)},${toY(p.y).toFixed(1)}`).join(" ");
  const fill=path+` L${toX(xMax).toFixed(1)},${H-8} L${toX(xMin).toFixed(1)},${H-8} Z`;
  const lpts=pts.filter(p=>p.x<=targetOvr);
  const shade=lpts.length?lpts.map((p,i)=>`${i===0?"M":"L"}${toX(p.x).toFixed(1)},${toY(p.y).toFixed(1)}`).join(" ")+` L${toX(Math.min(targetOvr,xMax)).toFixed(1)},${H-8} L${toX(xMin).toFixed(1)},${H-8} Z`:"";
  const tx=toX(Math.min(Math.max(targetOvr,xMin+0.1),xMax-0.1));
  return(
    <svg width={W} height={H} style={{display:"block",overflow:"visible"}}>
      <defs>
        <linearGradient id="bg3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={acc} stopOpacity="0.12"/><stop offset="100%" stopColor={acc} stopOpacity="0.01"/></linearGradient>
        <linearGradient id="sh3" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={acc} stopOpacity="0.38"/><stop offset="100%" stopColor={acc} stopOpacity="0.08"/></linearGradient>
      </defs>
      <path d={fill} fill="url(#bg3)"/>{shade&&<path d={shade} fill="url(#sh3)"/>}
      <path d={path} fill="none" stroke={acc} strokeWidth="1.5" opacity="0.55"/>
      <line x1={tx} y1={H-8} x2={tx} y2={8} stroke={acc} strokeWidth="1.5" strokeDasharray="3,2" opacity="0.8"/>
      <circle cx={tx} cy={toY(pdf(targetOvr))} r="3" fill={acc}/>
      <text x={tx} y={6} textAnchor="middle" fill={acc} fontSize="9" fontFamily="Bebas Neue">{targetOvr}</text>
      <line x1={pad} y1={H-8} x2={W-pad} y2={H-8} stroke="var(--axis)" strokeWidth="0.5"/>
    </svg>
  );
}

function Radar({sets,size=220}){
  const max=99,cx=size/2,cy=size/2,r=size/2-30;
  const ang=i=>(-90+i*60)*Math.PI/180;
  const px=(i,v)=>cx+r*(v/max)*Math.cos(ang(i));
  const py=(i,v)=>cy+r*(v/max)*Math.sin(ang(i));
  const ring=f=>STATS.map((_,i)=>`${px(i,max*f).toFixed(1)},${py(i,max*f).toFixed(1)}`).join(" ");
  const poly=st=>STATS.map((s,i)=>`${px(i,st[s]||1).toFixed(1)},${py(i,st[s]||1).toFixed(1)}`).join(" ");
  return(
    <svg width={size} height={size} style={{display:"block",overflow:"visible"}}>
      {[0.25,0.5,0.75,1].map(f=><polygon key={f} points={ring(f)} fill="none" stroke="var(--axis)" strokeWidth="1"/>)}
      {STATS.map((s,i)=><line key={s} x1={cx} y1={cy} x2={px(i,max)} y2={py(i,max)} stroke="var(--axis)" strokeWidth="0.5"/>)}
      {sets.map((st,j)=><polygon key={j} points={poly(st.stats)} fill={st.color} fillOpacity={st.fillOpacity??0.16} stroke={st.color} strokeWidth="1.6" strokeLinejoin="round"/>)}
      {STATS.map((s,i)=>{
        const lx=cx+(r+16)*Math.cos(ang(i)),ly=cy+(r+16)*Math.sin(ang(i));
        return <text key={s} x={lx} y={ly+3} textAnchor="middle" fill="var(--v555)" fontSize="9" fontFamily="'Space Mono',monospace">{s}</text>;
      })}
    </svg>
  );
}

function Trend({card,acc}){
  const pts=[...(card.history||[]).map(h=>({d:h.date,o:h.OVR})),{d:card.updatedAt||card.createdAt,o:card.OVR}];
  if(pts.length<2)return null;
  const W=250,H=88,pad=22;
  const os=pts.map(p=>p.o),mn=Math.min(...os)-2,mx=Math.max(...os)+2;
  const X=i=>pad+i*(W-2*pad)/(pts.length-1);
  const Y=o=>H-20-((o-mn)/((mx-mn)||1))*(H-38);
  const path=pts.map((p,i)=>`${i===0?"M":"L"}${X(i).toFixed(1)},${Y(p.o).toFixed(1)}`).join(" ");
  return(
    <svg width={W} height={H} style={{display:"block",overflow:"visible"}}>
      <text x={W/2} y={8} textAnchor="middle" fill="var(--v444)" fontSize="7" fontFamily="'Space Mono',monospace" letterSpacing="1">OVR OVER SCANS</text>
      <path d={path} fill="none" stroke={acc} strokeWidth="1.6"/>
      {pts.map((p,i)=>(
        <g key={i}>
          <circle cx={X(i)} cy={Y(p.o)} r="3" fill={acc}/>
          <text x={X(i)} y={Y(p.o)-7} textAnchor="middle" fill={acc} fontSize="9" fontFamily="Bebas Neue">{p.o}</text>
          <text x={X(i)} y={H-4} textAnchor="middle" fill="var(--v444)" fontSize="7" fontFamily="'Space Mono',monospace">{p.d?new Date(p.d).toLocaleDateString(undefined,{month:"short",day:"numeric"}):""}</text>
        </g>
      ))}
    </svg>
  );
}

function Rich({text}){
  if(!text)return null;
  const inline=t=>t.split(/\*\*(.+?)\*\*/g).map((p,j)=>j%2===1?<span key={j} style={{color:"var(--vaaa)",fontWeight:700}}>{p}</span>:p);
  const blocks=String(text).split(/\n{2,}/).map(b=>b.trim()).filter(Boolean);
  return(
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {blocks.map((b,i)=>{
        if(/^#{1,4}\s/.test(b))return <div key={i} style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1.5,marginTop:i?4:0}}>{b.replace(/^#{1,4}\s*/,"")}</div>;
        const lines=b.split(/\n/).map(l=>l.trim()).filter(Boolean);
        if(lines.length>1&&lines.every(l=>/^[-•*]\s/.test(l)))return(
          <div key={i} style={{display:"flex",flexDirection:"column",gap:4}}>
            {lines.map((l,k)=><div key={k} style={{display:"flex",gap:8}}><span style={{color:"var(--gold)",flexShrink:0}}>·</span><span style={{color:"var(--v777)",fontSize:11,lineHeight:1.7}}>{inline(l.replace(/^[-•*]\s*/,""))}</span></div>)}
          </div>
        );
        return <div key={i} style={{color:"var(--v777)",fontSize:11,lineHeight:1.8}}>{inline(b)}</div>;
      })}
    </div>
  );
}

function Key({label,sub,wide,pressed}){
  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minWidth:wide?76:46,height:46,background:pressed?"var(--gold)":"var(--s16)",border:`1px solid ${pressed?"var(--gold)":"var(--v2a)"}`,borderBottom:`${pressed?"1px":"3px"} solid ${pressed?"var(--gold-deep)":"var(--v333)"}`,borderRadius:5,padding:"4px 8px",transform:pressed?"translateY(2px)":"none",transition:"all 0.12s",boxShadow:pressed?"none":"0 2px 0 var(--gold-ink)",cursor:"default"}}>
      <span style={{fontFamily:"'Space Mono',monospace",fontSize:10,fontWeight:700,color:pressed?"var(--gold-ink)":"var(--vaaa)",letterSpacing:0.5,textAlign:"center",lineHeight:1.2}}>{label}</span>
      {sub&&<span style={{fontFamily:"'Space Mono',monospace",fontSize:7,color:pressed?"#00000077":"var(--v444)",letterSpacing:0.5,marginTop:2}}>{sub}</span>}
    </div>
  );
}

function Steps({cur}){
  const steps=["Go to LinkedIn","Take screenshot","Drop & analyse"];
  return(
    <div style={{display:"flex",alignItems:"center",gap:0,marginBottom:40}}>
      {steps.map((s,i)=>(
        <div key={i} style={{display:"flex",alignItems:"center",flex:i<steps.length-1?1:"auto"}}>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:6}}>
            <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background:i<=cur?"var(--gold)":"var(--s11)",border:i<=cur?"none":"1px solid var(--v1e)",fontFamily:"'Bebas Neue'",fontSize:13,color:i<=cur?"var(--gold-ink)":"var(--v333)",flexShrink:0,transition:"all 0.3s"}}>{i<cur?"✓":i+1}</div>
            <span style={{color:i===cur?"var(--gold)":i<cur?"var(--v555)":"var(--v2a)",fontSize:8,letterSpacing:1.5,textTransform:"uppercase",whiteSpace:"nowrap"}}>{s}</span>
          </div>
          {i<steps.length-1&&<div style={{flex:1,height:1,background:i<cur?"color-mix(in srgb, var(--gold) 20%, transparent)":"var(--b14)",margin:"0 10px",marginBottom:20,transition:"background 0.3s"}}/>}
        </div>
      ))}
    </div>
  );
}

export default function App(){
  const [view,setView]=useState("home");
  const [cards,setCards]=useState([]);
  const [sel,setSel]=useState(null);
  const [step,setStep]=useState(0);
  const [imgs,setImgs]=useState([]);
  const [extracted,setExtracted]=useState(null);
  const [extracting,setExtracting]=useState(false);
  const [scoring,setScoring]=useState(false);
  const [stageIdx,setStageIdx]=useState(0);
  const [done,setDone]=useState(null);
  const [err,setErr]=useState("");
  const [drag,setDrag]=useState(false);
  const [pk,setPk]=useState({});
  const [dupWarn,setDupWarn]=useState(null);
  const [updating,setUpdating]=useState(null);
  const [showShare,setShowShare]=useState(false);
  const [revealed,setRevealed]=useState(false);
  const [flipping,setFlipping]=useState(false);
  const [roastMode,setRoastMode]=useState(()=>{try{return localStorage.getItem("ca_roast")==="1";}catch{return false;}});
  const [prog,setProg]=useState(0);
  const [chatIn,setChatIn]=useState("");
  const [chatBusy,setChatBusy]=useState(false);
  const [ninetyBusy,setNinetyBusy]=useState(false);
  const [ninetyErr,setNinetyErr]=useState("");
  const [myId,setMyId]=useState(null);
  const [benchIds,setBenchIds]=useState([]);
  const [knowledge,setKnowledge]=useState("");
  const [kMsg,setKMsg]=useState("");
  const [rubric,setRubric]=useState("");
  const [rMsg,setRMsg]=useState("");
  const [vsVerdicts,setVsVerdicts]=useState({});
  const [vsBusy,setVsBusy]=useState(false);
  const [rescoring,setRescoring]=useState(false);
  const [rsErr,setRsErr]=useState("");
  const [lbCohort,setLbCohort]=useState("all");
  const [elapsed,setElapsed]=useState(0);
  const [planBusy,setPlanBusy]=useState(false);
  const [planErr,setPlanErr]=useState("");
  const [postIn,setPostIn]=useState("");
  const [postBusy,setPostBusy]=useState(false);
  const [postErr,setPostErr]=useState("");
  const goalsRef=useRef();
  const [scanStats,setScanStats]=useState({extract:[],score:[]});
  const [refOpen,setRefOpen]=useState(null);
  const [refBusy,setRefBusy]=useState(false);
  const [refErr,setRefErr]=useState("");
  const [postImg,setPostImg]=useState(null);
  const postFileRef=useRef();
  const [openSecs,setOpenSecs]=useState({});
  const [roastOpen,setRoastOpen]=useState(false);
  const [debugTiming,setDebugTiming]=useState(()=>{try{return localStorage.getItem("ca_debug_timing")==="1";}catch{return false;}});
  const toggleDebugTiming=()=>{setDebugTiming(v=>{try{localStorage.setItem("ca_debug_timing",v?"0":"1");}catch{}return !v;});};
  const [lightbox,setLightbox]=useState(null);
  const [openStats,setOpenStats]=useState({});
  const [hgText,setHgText]=useState("");
  const [hgImg,setHgImg]=useState(null);
  const [hgCtx,setHgCtx]=useState("");
  const [hgBusy,setHgBusy]=useState(false);
  const [hgErr,setHgErr]=useState("");
  const [hgResult,setHgResult]=useState(null);
  const [hgChat,setHgChat]=useState([]);
  const [hgChatIn,setHgChatIn]=useState("");
  const [hgChatBusy,setHgChatBusy]=useState(false);
  const [hgChatOpen,setHgChatOpen]=useState(false);
  const hgFileRef=useRef();
  const [rsReveal,setRsReveal]=useState(null);
  const [rsFlipping,setRsFlipping]=useState(false);
  const [deepDive,setDeepDive]=useState(false);
  const recordTime=(phase,secs)=>{setScanStats(prev=>{const next={...prev,[phase]:[...(prev[phase]||[]),secs].slice(-30)};try{storage.set("ca_times",JSON.stringify(next));}catch{}return next;});};
  const [vsA,setVsA]=useState("");
  const [vsB,setVsB]=useState("");
  const importRef=useRef();
  const toggleRoast=()=>{setRoastMode(r=>{try{localStorage.setItem("ca_roast",r?"0":"1");}catch{}return !r;});};
  const fileRef=useRef();
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem("ca_theme")||"dark";}catch{return "dark";}});

  useEffect(()=>{
    const root=document.documentElement;
    root.classList.remove("theme-dark","theme-light");
    root.classList.add(theme==="light"?"theme-light":"theme-dark");
    document.body.style.background=theme==="light"?"#f4f2ec":"#080808";
    try{localStorage.setItem("ca_theme",theme);}catch{}
  },[theme]);

  useEffect(()=>{(async()=>{
    try{const r=await storage.get("ca_v2");if(r?.value)setCards(JSON.parse(r.value));}catch{}
    try{const m=await storage.get("ca_me");if(m?.value)setMyId(m.value);}catch{}
    try{const b=await storage.get("ca_bench");if(b?.value)setBenchIds(JSON.parse(b.value));}catch{}
    try{const k=await storage.get("ca_knowledge");if(k?.value)setKnowledge(k.value);}catch{}
    try{const rb=await storage.get("ca_rubric");if(rb?.value)setRubric(rb.value);}catch{}
    try{const tm=await storage.get("ca_times");if(tm?.value)setScanStats(JSON.parse(tm.value));}catch{}
  })();},[]);

  // Advance the build-stage message every 2.4s while a phase is running, and pace an
  // estimated progress bar. The API doesn't stream generation progress, so the bar is
  // eased toward a phase target (extraction ≈ 40%, scoring ≈ 96%) at a typical scan pace.
  useEffect(()=>{
    if(!extracting&&!scoring){setProg(0);return;}
    setStageIdx(0);
    const len=(extracting?STAGES_EXTRACT:STAGES_SCORE).length;
    const target=extracting?40:99;
    if(extracting)setProg(2);
    const iv=setInterval(()=>setStageIdx(i=>Math.min(i+1,len-1)),2400);
    const pv=setInterval(()=>setProg(p=>p+(target-p)*0.045),160);
    return()=>{clearInterval(iv);clearInterval(pv);};
  },[extracting,scoring]);

  // Elapsed-seconds counter so long waits never read as frozen.
  useEffect(()=>{
    if(!(extracting||scoring||hgBusy)){setElapsed(0);return;}
    const t0=Date.now();
    const ev=setInterval(()=>setElapsed(Math.round((Date.now()-t0)/1000)),500);
    return()=>clearInterval(ev);
  },[extracting,scoring,hgBusy]);

  useEffect(()=>{setRoastOpen(false);setOpenStats({});setDeepDive(false);setRsReveal(null);setRsFlipping(false);},[sel?.id]);

  // HOW GOOD view: paste a screenshot anywhere on the page, like the create flow.
  useEffect(()=>{
    if(view!=="howgood")return;
    const onPaste=e=>{const items=e.clipboardData?.items;if(!items)return;for(const it of items){if(it.type.startsWith("image/")){const f=it.getAsFile();const rd=new FileReader();rd.onload=ev=>setHgImg({b64:ev.target.result.split(",")[1],type:f.type||"image/png",preview:ev.target.result});rd.readAsDataURL(f);break;}}};
    window.addEventListener("paste",onPaste);
    return()=>window.removeEventListener("paste",onPaste);
  },[view]);

  const openLB=(list,idx=0,del=null)=>setLightbox({list,idx,del});
  const saveAsp=async(k,v)=>{if(!sel)return;const upd=cards.map(c=>c.id===sel.id?{...c,[k]:v||null}:c);await persist(upd);setSel(s=>({...s,[k]:v||null}));};
  const persist=async u=>{setCards(u);try{await storage.set("ca_v2",JSON.stringify(u));}catch{}};

  useEffect(()=>{
    if(view!=="create"||step!==0)return;
    const d=e=>{const k=e.key.toLowerCase();if(k==="meta"||k==="win"||e.metaKey)setPk(p=>({...p,win:true}));if(k==="shift")setPk(p=>({...p,shift:true}));if(k==="s")setPk(p=>({...p,s:true}));if(k==="4")setPk(p=>({...p,s4:true}));};
    const u=e=>{const k=e.key.toLowerCase();if(k==="meta"||k==="win"||e.metaKey)setPk(p=>({...p,win:false}));if(k==="shift")setPk(p=>({...p,shift:false}));if(k==="s")setPk(p=>({...p,s:false}));if(k==="4")setPk(p=>({...p,s4:false}));};
    window.addEventListener("keydown",d);window.addEventListener("keyup",u);
    return()=>{window.removeEventListener("keydown",d);window.removeEventListener("keyup",u);};
  },[view,step]);

  const addFile=useCallback(file=>{
    if(!file||!file.type.startsWith("image/"))return;
    const type=file.type||"image/png";
    const r=new FileReader();
    r.onload=e=>{
      const b64=e.target.result.split(",")[1];
      setImgs(prev=>[...prev,{b64,type,preview:e.target.result}]);
      setStep(s=>Math.max(s,1));setErr("");
    };
    r.readAsDataURL(file);
  },[]);

  const repairJSON=raw=>{
    try{return JSON.parse(raw);}catch{}
    const start=raw.indexOf("{"),end=raw.lastIndexOf("}");
    if(start===-1)throw new Error("No JSON found in response");
    let candidate=raw.slice(start,end+1);
    try{return JSON.parse(candidate);}catch{}
    let depth=0,inStr=false,escaped=false;
    for(const ch of candidate){
      if(escaped){escaped=false;continue;}
      if(ch==="\\"&&inStr){escaped=true;continue;}
      if(ch==='"'){inStr=!inStr;continue;}
      if(!inStr){if(ch==="{"||ch==="[")depth++;else if(ch==="}"||ch==="]")depth--;}
    }
    if(inStr)candidate+='"';
    while(depth>0){candidate+="}";depth--;}
    try{return JSON.parse(candidate);}catch(e){throw new Error("Response malformed — please try again");}
  };

  const checkDup=name=>{
    if(!name||name==="Unknown")return null;
    const n=name.toLowerCase().trim();
    return cards.find(c=>c.name&&c.name.toLowerCase().trim()===n)||null;
  };

  useEffect(()=>{
    if(view!=="create"||step>1)return;
    const onPaste=e=>{
      const items=e.clipboardData?.items;
      if(!items)return;
      for(const item of items){if(item.type.startsWith("image/")){addFile(item.getAsFile());break;}}
    };
    window.addEventListener("paste",onPaste);
    return()=>window.removeEventListener("paste",onPaste);
  },[view,step,addFile]);

  // Builds the scoring message from a card's stored extraction — shared by analyse() and rescore().
  const buildScoreMsg=ex=>`Today's date: ${new Date().toDateString()} — all timeline advice must respect windows already closed; never advise converting or applying to anything whose window has passed.\nProfile type: ${ex.profile_type||"finance"}\nName: ${ex.name}\nUniversity: ${ex.uni}\nAge: ${ex.age}\nCompany: ${ex.company}\nRole: ${ex.role}\nHow secured: ${ex.how}\nPrior internships/roles: ${ex.prev}\nGrades / academic record: ${ex.grades||"Not visible"}\nTimeline (roles with dates): ${ex.timeline||"Not visible"}\nConcrete evidence quotes: ${ex.evidence||"None visible"}\nActivities: ${ex.acts||"None"}\nNotes (background, traction signals, context): ${ex.notes||"None"}${knowledge.trim()?`\nSCOUT KNOWLEDGE (trusted user-provided calibration about programmes, firms and achievements): ${knowledge.trim()}`:""}${rubric.trim()?`\nOWNER RUBRIC (the owner's evolving calibration of what is genuinely cracked vs LinkedIn theatre — informs judgment, but evidence discipline still wins over taste): ${rubric.trim()}`:""}${1?`\n\nADDITIONALLY: include one extra JSON field "roast" — 3-5 sentences of brutally funny roasting of this profile. Every jab must be grounded in the visible evidence above (no invented facts). Punch at the signalling, the buzzwords and the LinkedIn theatre — never at protected characteristics or the person's worth. Dry UK banter energy, PG-13.`:""}`;

  const analyse=async(forceUpdate=false)=>{
    if(imgs.length===0)return;
    setExtracting(true);setErr("");setDupWarn(null);
    try{
      // Read the body as text first: if the /api route isn't running (plain vite
      // without the dev proxy, or a missing serverless function), the response is
      // empty or HTML — surface a useful error instead of "Unexpected end of JSON input".
      const readJson=async r=>{
        const text=await r.text();
        if(!text)throw new Error(`the /api/anthropic endpoint returned ${r.status} with an empty body — the API proxy isn't running. Restart the dev server (npm run dev now includes a built-in proxy) and make sure your ANTHROPIC_API_KEY is in .env.`);
        try{return JSON.parse(text);}catch{throw new Error(`the /api/anthropic endpoint returned something that isn't JSON (${r.status}): ${text.slice(0,120)}`);}
      };
      const imgBlocks=imgs.map(i=>({type:"image",source:{type:"base64",media_type:i.type,data:i.b64}}));
      const t1=Date.now();
      // Extraction is mechanical vision→JSON: thinking off keeps it fast and cheap.
      const r1=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:EXTRACT_MODEL,max_tokens:2000,thinking:{type:"disabled"},messages:[{role:"user",content:[...imgBlocks,{type:"text",text:EXTRACT_PROMPT}]}]})});
      const d1=await readJson(r1);
      if(d1.error)throw new Error(`API error: ${d1.error.message}`);
      recordTime("extract",Math.round((Date.now()-t1)/1000));
      const ex=repairJSON(d1.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      if(ex&&ex.not_profile){
        setErr(`That doesn't look like a LinkedIn profile screenshot${ex.why?` — ${String(ex.why).replace(/\.\s*$/,"").toLowerCase()}`:""}. Paste the profile's Experience and Education sections and try again.`);
        setExtracting(false);setScoring(false);return;
      }
      // UPDATE MERGE: when updating an existing card, new screenshots only need the
      // NEW information — established data is carried forward, never lost.
      const prevForMerge=updating?cards.find(c=>c.id===updating):null;
      if(prevForMerge){
        const bad=v=>!v||/^(unknown|not visible|none|none visible|—|-)$/i.test(String(v).trim());
        const keep=(nv,ov)=>bad(nv)?(bad(ov)?nv:ov):nv;
        const joinU=(ov,nv)=>{if(bad(nv))return bad(ov)?nv:ov;if(bad(ov))return nv;return String(ov).includes(String(nv).slice(0,40))?ov:`${ov}; ${nv}`;};
        ex.name=keep(ex.name,prevForMerge.name);ex.uni=keep(ex.uni,prevForMerge.uni);ex.uni_years=keep(ex.uni_years,prevForMerge.uni_years);ex.year=keep(ex.year,prevForMerge.year);ex.age=keep(ex.age,prevForMerge.age);ex.grades=keep(ex.grades,prevForMerge.grades);
        ex.company=keep(ex.company,prevForMerge.company);ex.role=keep(ex.role,prevForMerge.role);ex.how=keep(ex.how,prevForMerge.how);ex.prev=keep(ex.prev,prevForMerge.prev);
        ex.timeline=joinU(prevForMerge.timeline,ex.timeline);ex.evidence=joinU(prevForMerge.evidence,ex.evidence);ex.acts=joinU(prevForMerge.acts,ex.acts);ex.notes=joinU(prevForMerge.notes,ex.notes);
      }
      setExtracted(ex);
      if(!forceUpdate&&!updating){
        const dup=checkDup(ex.name);
        if(dup){setDupWarn(dup);setExtracting(false);return;}
      }
      setExtracting(false);setScoring(true);
      const t2=Date.now();
      const msg=buildScoreMsg(ex);
      // Thinking is deliberately OFF here: adaptive reasoning + an 8K budget made
      // scoring take minutes per card. SCORE_PROMPT is prescriptive enough that direct
      // generation holds quality, and 3K tokens comfortably covers the full JSON report.
      const r2=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:5000,thinking:{type:"disabled"},system:SCORE_PROMPT,messages:[{role:"user",content:msg}]})},150000);
      const d2=await readJson(r2);
      if(d2.error)throw new Error(`Scoring error: ${d2.error.message}`);
      recordTime("score",Math.round((Date.now()-t2)/1000));
      const sc=repairJSON(d2.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      // The model returns six independent stats; the app owns the OVR arithmetic so the
      // formula is always applied exactly (LLMs are unreliable at weighted sums).
      const cl=v=>Math.min(99,Math.max(1,Math.round(Number(v)||50)));
      const stats={PRES:cl(sc.PRES),PACE:cl(sc.PACE),REACH:cl(sc.REACH),STACK:cl(sc.STACK),RARE:cl(sc.RARE),DEPTH:cl(sc.DEPTH)};
      const OVR=cl(stats.PRES*0.20+stats.PACE*0.15+stats.REACH*0.15+stats.STACK*0.20+stats.RARE*0.05+stats.DEPTH*0.25);
      // Hard clamps: hypothetical outcome OVRs can never contradict the computed OVR.
      const fovr=v=>{const n=Math.round(Number(v));return Number.isFinite(n)&&n>0?Math.min(99,Math.max(1,n)):null;};
      const fl0=fovr(sc.floor_ovr),ce0=fovr(sc.ceiling_ovr),ba0=fovr(sc.base_ovr);
      const fl=fl0!==null?Math.min(fl0,OVR):null;
      const ce=ce0!==null?Math.max(ce0,OVR):null;
      const ba=ba0!==null?Math.min(Math.max(ba0,fl??1),ce??99):null;
      // Post-generation sanity pass: flag OVRs that don't square with their own rationale.
      const sanity=(()=>{const out=[];const vals=Object.values(stats);
        if(OVR>=88&&sc.confidence==="LOW")out.push("Elite OVR sitting on LOW evidence confidence — treat as provisional until the evidence firms up.");
        if(OVR>=85&&stats.DEPTH<55)out.push(`High OVR carried by prestige while verified output is thin (DEPTH ${stats.DEPTH}) — read the LARP check before trusting this rating.`);
        if(stats.RARE>=90&&stats.STACK<50)out.push("Scored as a near-unique configuration but with an incoherent stack — one of those two reads is off.");
        if(Math.max(...vals)-Math.min(...vals)<12)out.push("Stat line unusually flat — possible scale compression; genuinely spiky profiles are the honest norm.");
        return out.length?out:null;})();
      const all=[...cards];
      const uid=updating||Date.now().toString();
      // Re-scan history: keep the last 10 snapshots so the profile can show stat deltas
      const prevCard=updating?all.find(c=>c.id===uid):null;
      const history=prevCard?[...(prevCard.history||[]),{date:prevCard.updatedAt||prevCard.createdAt,OVR:prevCard.OVR,stats:prevCard.stats,rubricV:prevCard.rubricV||0}].slice(-10):[];
      const mix=Array.isArray(sc.archetype_mix)?sc.archetype_mix.filter(m=>m&&m.build).map(m=>({build:String(m.build),weight:Math.max(1,Math.min(100,Math.round(Number(m.weight)||0)))})).slice(0,3):null;
      const lastDeltaCause=prevCard?((prevCard.rubricV||0)!==RUBRIC_VERSION?"rating system updated since the last scan":"profile updated with new screenshots"):null;
      const newCard={id:uid,...(prevCard?{chat:prevCard.chat,ninety:prevCard.ninety,plan:prevCard.plan,posts:prevCard.posts,goals:prevCard.goals,asp_type:prevCard.asp_type,asp_build:prevCard.asp_build}:{}),...ex,stats,OVR,history,rubricV:RUBRIC_VERSION,lastDeltaCause,archetype_mix:mix,roast:sc.roast||null,stat_reasons:sc.stat_reasons||null,profile_type:sc.profile_type||ex.profile_type||"Finance / Consulting",archetype:sc.archetype||null,confidence:sc.confidence||"MEDIUM",confidence_reason:sc.confidence_reason||null,moniker:sc.moniker||null,thesis:sc.thesis||null,best_signal:sc.best_signal||null,weak_signal:sc.weak_signal||null,traits:sc.traits||null,not_proven:sc.not_proven||null,peer_calibration:sc.peer_calibration||null,opportunity_capture:sc.opportunity_capture||null,floor:sc.floor||null,base_case:sc.base_case||null,ceiling:sc.ceiling||null,upgrade:sc.upgrade||null,improvement_plan:sc.improvement_plan||null,tier_path:sc.tier_path||null,larp_check:sc.larp_check||null,smurf_check:sc.smurf_check||null,projected_roles:sc.projected_roles||null,type_reason:sc.type_reason||null,floor_ovr:fl,base_ovr:ba,ceiling_ovr:ce,sanity,percentile:0,createdAt:updating?(all.find(c=>c.id===uid)?.createdAt||new Date().toISOString()):new Date().toISOString(),updatedAt:updating?new Date().toISOString():undefined};
      const base=updating?all.filter(c=>c.id!==uid):all;
      const updated=[...base,newCard].map(c=>({...c,percentile:getPct([...base,newCard].filter(x=>x.id!==c.id),c.OVR)}));
      await persist(updated);setDone(newCard);setRevealed(false);setFlipping(false);setRoastOpen(false);setStep(3);setUpdating(null);
    }catch(e){setErr(friendlyErr(e.message));console.error(e);}
    setExtracting(false);setScoring(false);
  };

  const deleteCard=async id=>{
    const updated=cards.filter(c=>c.id!==id).map(c=>({...c,percentile:getPct(cards.filter(x=>x.id!==id&&x.id!==c.id),c.OVR)}));
    await persist(updated);
    if(sel?.id===id){setSel(null);setView("leaderboard");}
  };

  const reset=()=>{setStep(0);setImgs([]);setExtracted(null);setDone(null);setErr("");setDupWarn(null);setUpdating(null);setRevealed(false);setFlipping(false);setRoastOpen(false);};

  // Hypothetical upgraded card: same person, elite-tier version, evidence-based jumps only.
  const genNinety=async()=>{
    if(!sel||ninetyBusy)return;
    setNinetyBusy(true);setNinetyErr("");
    try{
      const payload=`Today's date: ${new Date().toDateString()}
Name: ${sel.name}
Profile type: ${sel.profile_type||"-"}
Current stats: ${JSON.stringify(sel.stats)} - current OVR ${sel.OVR}
Stat reasons: ${JSON.stringify(sel.stat_reasons||{})}
Thesis: ${sel.thesis||"-"}
Timeline: ${sel.timeline||"-"}
Evidence: ${sel.evidence||"-"}
Weakest signal: ${sel.weak_signal||"-"}
Fastest upgrade: ${sel.upgrade||"-"}`;
      const r=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:3200,thinking:{type:"disabled"},system:NINETY_PROMPT,messages:[{role:"user",content:payload}]})});
      const text=await r.text();
      if(!text)throw new Error("empty response from API");
      const d=JSON.parse(text);
      if(d.error)throw new Error(d.error.message);
      const sc=repairJSON(d.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      const cl=v=>Math.min(99,Math.max(1,Math.round(Number(v)||90)));
      const stats={PRES:cl(sc.PRES),PACE:cl(sc.PACE),REACH:cl(sc.REACH),STACK:cl(sc.STACK),RARE:cl(sc.RARE),DEPTH:cl(sc.DEPTH)};
      const OVR=cl(stats.PRES*0.20+stats.PACE*0.15+stats.REACH*0.15+stats.STACK*0.20+stats.RARE*0.05+stats.DEPTH*0.25);
      const ninety={stats,OVR,summary:sc.summary||"",moves:sc.moves||"",stat_moves:sc.stat_moves||null,milestones:Array.isArray(sc.milestones)?sc.milestones.filter(m=>m&&m.m).map(m=>({m:String(m.m),eta:String(m.eta||"")})).slice(0,6):null,at:new Date().toISOString()};
      const upd=cards.map(c=>c.id===sel.id?{...c,ninety}:c);
      await persist(upd);
      setSel(s=>({...s,ninety}));
    }catch(e){setNinetyErr(friendlyErr(e.message));}
    setNinetyBusy(false);
  };

  // Scout chat: grounded strictly in this card's extracted evidence and report.
  const sendChat=async(preset)=>{
    const q=(typeof preset==="string"?preset:chatIn).trim();
    if(!q||chatBusy||!sel)return;
    setChatIn("");setChatBusy(true);
    const history=[...(sel.chat||[]),{role:"user",content:q}];
    setSel(s=>({...s,chat:history}));
    try{
      const sys=`You are the rigorous, evidence-based career scout behind this Career Signal card. Today is ${new Date().toDateString()} — timeline advice must respect windows already closed. Discuss ONLY this profile. Rules: cite the visible evidence, label every inference ("this suggests") and every hypothetical, never inflate or flatter, calibrate against the right peer group, and keep answers under 180 words unless asked for depth. You rate signal, not human worth.

PROFILE DATA:
${JSON.stringify({name:sel.name,uni:sel.uni,uni_years:sel.uni_years,cohort:sel.year,company:sel.company,role:sel.role,how:sel.how,prior_roles:sel.prev,grades:sel.grades,timeline:sel.timeline,evidence:sel.evidence,notes:sel.notes,stats:sel.stats,OVR:sel.OVR,stat_reasons:sel.stat_reasons,confidence:sel.confidence,thesis:sel.thesis,best_signal:sel.best_signal,weak_signal:sel.weak_signal,not_proven:sel.not_proven,peer_calibration:sel.peer_calibration,floor:sel.floor,base_case:sel.base_case,ceiling:sel.ceiling,upgrade:sel.upgrade,improvement_plan:sel.improvement_plan,tier_path:sel.tier_path,ninety:sel.ninety?{OVR:sel.ninety.OVR,summary:sel.ninety.summary}:null})}${knowledge.trim()?`\n\nSCOUT KNOWLEDGE (trusted user calibration context): ${knowledge.trim()}`:""}${rubric.trim()?`\n\nOWNER RUBRIC (owner taste calibration — informs judgment, evidence still wins): ${rubric.trim()}`:""}`;
      const r=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:900,thinking:{type:"disabled"},system:sys,messages:history.map(m=>({role:m.role,content:m.content}))})});
      const text=await r.text();
      if(!text)throw new Error("empty response from API");
      const d=JSON.parse(text);
      if(d.error)throw new Error(d.error.message);
      const reply=d.content.map(b=>b.text||"").join("").trim()||"(no reply)";
      const finalChat=[...history,{role:"assistant",content:reply}];
      const upd=cards.map(c=>c.id===sel.id?{...c,chat:finalChat}:c);
      await persist(upd);
      setSel(s=>({...s,chat:finalChat}));
    }catch(e){
      const finalChat=[...history,{role:"assistant",content:friendlyErr(e.message)}];
      setSel(s=>({...s,chat:finalChat}));
      try{await persist(cards.map(c=>c.id===sel.id?{...c,chat:finalChat}:c));}catch{}
    }
    setChatBusy(false);
  };

  // Claim exactly one card as yours; click again to unclaim.
  const toggleMine=async()=>{
    if(!sel)return;
    const nv=myId===sel.id?"":sel.id;
    setMyId(nv||null);
    try{await storage.set("ca_me",nv);}catch{}
  };
  const setBenchList=async list=>{
    setBenchIds(list);
    try{await storage.set("ca_bench",JSON.stringify(list));}catch{}
  };
  const saveKnowledge=async()=>{
    try{await storage.set("ca_knowledge",knowledge);setKMsg("Saved — applied to every future scan and chat");setTimeout(()=>setKMsg(""),4000);}catch{setKMsg("Save failed");}
  };
  const saveRubric=async()=>{
    try{await storage.set("ca_rubric",rubric);setRMsg("Saved — the scout now calibrates against your taste");setTimeout(()=>setRMsg(""),4000);}catch{setRMsg("Save failed");}
  };

  // Head-to-head verdict: why one OVR is genuinely higher, argued from the evidence.
  const genVerdict=async(a,b)=>{
    if(vsBusy)return;
    setVsBusy(true);
    const key=`${a.id}|${b.id}`;
    try{
      const pack=c=>JSON.stringify({name:c.name,stats:c.stats,OVR:c.OVR,stat_reasons:c.stat_reasons,thesis:c.thesis,evidence:c.evidence,timeline:c.timeline,confidence:c.confidence,larp_check:c.larp_check,smurf_check:c.smurf_check});
      const nameOf=c=>c.name&&c.name!=="Unknown"?c.name:(c.moniker||"the unnamed card");
      const sys=`You are the rigorous, evidence-based career scout. Compare exactly two profiles: ${nameOf(a)} and ${nameOf(b)}. ALWAYS refer to them by name — never as "Card A", "Card B", "A", "B", "the first card" or "the higher card". Write a tight verdict (under 220 words) in four parts: (1) why the higher OVR is genuinely higher — name the specific evidence and stats driving it, not vibes; (2) where the lower-rated person actually wins or may be underrated — including verifiability and possible understatement; (3) the single change that would flip the matchup; (4) EVIDENCE TO WATCH — the specific observable items that would have to appear on the lower-rated person's profile for the gap to actually close: named artifact types, conversions, numbers, dates. Label every inference. You rank visible signal, never human worth, and you never accuse anyone of lying — you assess what the evidence supports.${knowledge.trim()?`\nSCOUT KNOWLEDGE (trusted calibration): ${knowledge.trim()}`:""}${rubric.trim()?`\nOWNER RUBRIC (owner taste calibration — informs judgment, evidence discipline still wins): ${rubric.trim()}`:""}`;
      const r=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:700,thinking:{type:"disabled"},system:sys,messages:[{role:"user",content:`${nameOf(a).toUpperCase()}: ${pack(a)}\n\n${nameOf(b).toUpperCase()}: ${pack(b)}`}]})});
      const text=await r.text();
      if(!text)throw new Error("empty response from API");
      const d=JSON.parse(text);
      if(d.error)throw new Error(d.error.message);
      const v=d.content.map(x=>x.text||"").join("").trim();
      setVsVerdicts(p=>({...p,[key]:v}));
    }catch(e){setVsVerdicts(p=>({...p,[key]:friendlyErr(e.message)}));}
    setVsBusy(false);
  };

  // Re-run the scout on this card's STORED extraction — no new screenshots needed.
  // Pulls old cards forward onto the latest prompt so new report sections appear.
  const rescore=async()=>{
    if(!sel||rescoring)return;
    setRescoring(true);setRsErr("");
    setScoring(true);
    try{
      const msg=buildScoreMsg(sel);
      const tR=Date.now();
      const r2=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:5000,thinking:{type:"disabled"},system:SCORE_PROMPT,messages:[{role:"user",content:msg}]})},150000);
      const text=await r2.text();
      if(!text)throw new Error("empty response from API");
      let d2;try{d2=JSON.parse(text);}catch{throw new Error(`non-JSON response: ${text.slice(0,120)}`);}
      if(d2.error)throw new Error(d2.error.message);
      recordTime("score",Math.round((Date.now()-tR)/1000));
      const sc=repairJSON(d2.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      const cl=v=>Math.min(99,Math.max(1,Math.round(Number(v)||50)));
      const stats={PRES:cl(sc.PRES),PACE:cl(sc.PACE),REACH:cl(sc.REACH),STACK:cl(sc.STACK),RARE:cl(sc.RARE),DEPTH:cl(sc.DEPTH)};
      const OVR=cl(stats.PRES*0.20+stats.PACE*0.15+stats.REACH*0.15+stats.STACK*0.20+stats.RARE*0.05+stats.DEPTH*0.25);
      const fovr=v=>{const n=Math.round(Number(v));return Number.isFinite(n)&&n>0?Math.min(99,Math.max(1,n)):null;};
      const fl0=fovr(sc.floor_ovr),ce0=fovr(sc.ceiling_ovr),ba0=fovr(sc.base_ovr);
      const fl=fl0!==null?Math.min(fl0,OVR):null;
      const ce=ce0!==null?Math.max(ce0,OVR):null;
      const ba=ba0!==null?Math.min(Math.max(ba0,fl??1),ce??99):null;
      // Post-generation sanity pass: flag OVRs that don't square with their own rationale.
      const sanity=(()=>{const out=[];const vals=Object.values(stats);
        if(OVR>=88&&sc.confidence==="LOW")out.push("Elite OVR sitting on LOW evidence confidence — treat as provisional until the evidence firms up.");
        if(OVR>=85&&stats.DEPTH<55)out.push(`High OVR carried by prestige while verified output is thin (DEPTH ${stats.DEPTH}) — read the LARP check before trusting this rating.`);
        if(stats.RARE>=90&&stats.STACK<50)out.push("Scored as a near-unique configuration but with an incoherent stack — one of those two reads is off.");
        if(Math.max(...vals)-Math.min(...vals)<12)out.push("Stat line unusually flat — possible scale compression; genuinely spiky profiles are the honest norm.");
        return out.length?out:null;})();
      const history=[...(sel.history||[]),{date:sel.updatedAt||sel.createdAt,OVR:sel.OVR,stats:sel.stats,rubricV:sel.rubricV||0}].slice(-10);
      const mix=Array.isArray(sc.archetype_mix)?sc.archetype_mix.filter(m=>m&&m.build).map(m=>({build:String(m.build),weight:Math.max(1,Math.min(100,Math.round(Number(m.weight)||0)))})).slice(0,3):null;
      const lastDeltaCause=(sel.rubricV||0)!==RUBRIC_VERSION?"rating system updated — re-measured under the current rubric":"re-measured under the same rubric (small variance is model noise)";
      const newCard={...sel,stats,OVR,history,rubricV:RUBRIC_VERSION,lastDeltaCause,archetype_mix:mix||sel.archetype_mix||null,roast:sc.roast||sel.roast||null,stat_reasons:sc.stat_reasons||null,profile_type:sc.profile_type||sel.profile_type||null,archetype:sc.archetype||sel.archetype||null,confidence:sc.confidence||"MEDIUM",confidence_reason:sc.confidence_reason||null,moniker:sc.moniker||sel.moniker||null,thesis:sc.thesis||null,best_signal:sc.best_signal||null,weak_signal:sc.weak_signal||null,traits:sc.traits||null,not_proven:sc.not_proven||null,peer_calibration:sc.peer_calibration||null,opportunity_capture:sc.opportunity_capture||sel.opportunity_capture||null,floor:sc.floor||null,base_case:sc.base_case||null,ceiling:sc.ceiling||null,upgrade:sc.upgrade||null,improvement_plan:sc.improvement_plan||null,tier_path:sc.tier_path||null,larp_check:sc.larp_check||null,smurf_check:sc.smurf_check||null,projected_roles:sc.projected_roles||null,type_reason:sc.type_reason||null,floor_ovr:fl,base_ovr:ba,ceiling_ovr:ce,sanity,updatedAt:new Date().toISOString()};
      const base=cards.filter(c=>c.id!==sel.id);
      const updated=[...base,newCard].map(c=>({...c,percentile:getPct([...base,newCard].filter(x=>x.id!==c.id),c.OVR)}));
      await persist(updated);
      setSel(newCard);
      // Upgrade? Run the pack-opening again — earned reveals only.
      if(newCard.OVR>sel.OVR){setRsReveal({prev:sel.OVR,open:false});setRsFlipping(false);}
    }catch(e){setRsErr(friendlyErr(e.message));}
    setScoring(false);
    setRescoring(false);
  };

  // Dynamic, deadline-aware improvement checklist for the claimed card.
  const genPlan=async()=>{
    if(!sel||planBusy)return;
    setPlanBusy(true);setPlanErr("");
    try{
      const kept=(sel.plan?.items||[]).filter(i=>i.status==="done"||i.status==="na");
      const goalsTxt=(goalsRef.current?.value||sel.goals||"").trim();
      const payload=`Today's date: ${new Date().toDateString()}
User goals: ${goalsTxt||"not stated"}
Card: ${JSON.stringify({name:sel.name,uni:sel.uni,uni_years:sel.uni_years,cohort:sel.year,company:sel.company,role:sel.role,timeline:sel.timeline,evidence:sel.evidence,stats:sel.stats,OVR:sel.OVR,stat_reasons:sel.stat_reasons,weak_signal:sel.weak_signal,upgrade:sel.upgrade,tier_path:sel.tier_path,projected_roles:sel.projected_roles})}
Previously DONE (build on these): ${JSON.stringify(kept.filter(i=>i.status==="done").map(i=>i.t))}
Marked NOT ELIGIBLE (never re-propose these or variants): ${JSON.stringify(kept.filter(i=>i.status==="na").map(i=>i.t))}`;
      const r=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:1500,thinking:{type:"disabled"},system:PLAN_PROMPT+(knowledge.trim()?`\nSCOUT KNOWLEDGE: ${knowledge.trim()}`:"")+(rubric.trim()?`\nOWNER RUBRIC: ${rubric.trim()}`:""),messages:[{role:"user",content:payload}]})});
      const text=await r.text();
      if(!text)throw new Error("empty response from API");
      const d=JSON.parse(text);
      if(d.error)throw new Error(d.error.message);
      const scp=repairJSON(d.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      const items=(scp.items||[]).map(i=>({t:String(i.t||""),d:String(i.d||""),stat:STATS.includes(i.stat)?i.stat:"DEPTH",status:"open"})).filter(i=>i.t);
      if(!items.length)throw new Error("no plan items returned — try again");
      const plan={items:[...kept,...items],at:new Date().toISOString()};
      const upd=cards.map(c=>c.id===sel.id?{...c,plan,goals:goalsTxt}:c);
      await persist(upd);
      setSel(s=>({...s,plan,goals:goalsTxt}));
    }catch(e){setPlanErr(friendlyErr(e.message));}
    setPlanBusy(false);
  };
  const setPlanStatus=async(idx,status)=>{
    if(!sel?.plan)return;
    const items=sel.plan.items.map((it,i)=>i===idx?{...it,status:it.status===status?"open":status}:it);
    const plan={...sel.plan,items};
    const upd=cards.map(c=>c.id===sel.id?{...c,plan}:c);
    await persist(upd);
    setSel(s=>({...s,plan}));
  };

  // One LinkedIn post as a directional telegraph.
  const analysePost=async()=>{
    const post=postIn.trim();
    if((!post&&!postImg)||postBusy||!sel)return;
    setPostBusy(true);setPostErr("");
    try{
      const sys=`You are the rigorous career scout. You are given ONE LinkedIn post written by the person on this card. Read it as a directional telegraph. In under 120 words: (1) what the post signals about direction and aspiration — label every inference; (2) whether it is consistent with the card's thesis or telegraphs a pivot; (3) any NEW concrete evidence in the post worth noting. No flattery, no character claims. Card: ${JSON.stringify({name:sel.name,thesis:sel.thesis,profile_type:sel.profile_type,archetype:sel.archetype,evidence:sel.evidence})}`;
      const r=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:500,thinking:{type:"disabled"},system:sys,messages:[{role:"user",content:postImg?[{type:"image",source:{type:"base64",media_type:postImg.type,data:postImg.b64}},{type:"text",text:post?`THE POST (screenshot attached; pasted text alongside):\n${post}`:"THE POST is in the attached screenshot — read it fully, including any visible numbers, dates and engagement."}]:`THE POST:\n${post}`}]})});
      const text=await r.text();
      if(!text)throw new Error("empty response from API");
      const d=JSON.parse(text);
      if(d.error)throw new Error(d.error.message);
      const insight=d.content.map(b=>b.text||"").join("").trim();
      const posts=[{snippet:post?post.slice(0,160):"[screenshot post]",insight,at:new Date().toISOString()},...(sel.posts||[])].slice(0,5);
      const upd=cards.map(c=>c.id===sel.id?{...c,posts}:c);
      await persist(upd);
      setSel(s=>({...s,posts}));
      setPostIn("");setPostImg(null);
    }catch(e){setPostErr(friendlyErr(e.message));}
    setPostBusy(false);
  };

  // Why is this pool card a good (or bad) ceiling reference for the open profile?
  const genRefWhy=async ref=>{
    if(refBusy||!sel)return;
    setRefBusy(true);setRefErr("");
    try{
      const sys=`You are the rigorous career scout. Assess whether CARD B is a GOOD, PARTIAL or BAD ceiling reference for CARD A. In under 150 words: (1) open with the verdict word and the reason — same lane and thesis, or a different game entirely?; (2) what exactly separates B's stat shape and evidence from A's — name the stats and the artifacts; (3) the ONE thing from B's path A should actually copy, specific and time-bound. Label every inference; projections are projections. No flattery.`;
      const pack=c=>JSON.stringify({name:c.name,archetype:c.archetype,profile_type:c.profile_type,stats:c.stats,OVR:c.OVR,thesis:c.thesis,evidence:c.evidence,timeline:c.timeline});
      const r=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:500,thinking:{type:"disabled"},system:sys,messages:[{role:"user",content:`CARD A (the open profile): ${pack(sel)}\n\nCARD B (candidate ceiling reference): ${pack(ref)}`}]})});
      const text=await r.text();
      if(!text)throw new Error("empty response from API");
      const d=JSON.parse(text);
      if(d.error)throw new Error(d.error.message);
      const note={text:d.content.map(b=>b.text||"").join("").trim(),at:new Date().toISOString()};
      const ref_notes={...(sel.ref_notes||{}),[ref.id]:note};
      const upd=cards.map(c=>c.id===sel.id?{...c,ref_notes}:c);
      await persist(upd);
      setSel(s=>({...s,ref_notes}));
    }catch(e){setRefErr(friendlyErr(e.message));}
    setRefBusy(false);
  };

  // HOW GOOD IS THIS? — standalone achievement rating, no card required.
  const rateHowGood=async()=>{
    const post=hgText.trim();
    if((!post&&!hgImg)||hgBusy)return;
    setHgBusy(true);setHgErr("");setHgResult(null);setHgChat([]);setHgChatOpen(false);
    try{
      const userContent=[
        ...(hgImg?[{type:"image",source:{type:"base64",media_type:hgImg.type,data:hgImg.b64}}]:[]),
        {type:"text",text:`Today's date: ${new Date().toDateString()}\n${hgCtx.trim()?`CONTEXT PROVIDED BY THE USER (about the person/situation): ${hgCtx.trim()}\n`:""}${post?`THE POST:\n${post}`:"THE POST is in the attached screenshot — read it fully, including numbers, dates and visible context."}`}
      ];
      const r=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:1600,thinking:{type:"disabled"},system:HOWGOOD_PROMPT+(knowledge.trim()?`\nSCOUT KNOWLEDGE (trusted calibration): ${knowledge.trim()}`:""),messages:[{role:"user",content:userContent}]})});
      const text=await r.text();
      if(!text)throw new Error("empty response from API");
      const d=JSON.parse(text);
      if(d.error)throw new Error(d.error.message);
      const sc=repairJSON(d.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      const cl=v=>Math.min(99,Math.max(1,Math.round(Number(v)||50)));
      setHgResult({...sc,score:cl(sc.score),grade:["S","A","B","C","D"].includes(sc.grade)?sc.grade:"C",at:new Date().toISOString(),snippet:post?post.slice(0,140):"[screenshot]"});
    }catch(e){setHgErr(friendlyErr(e.message));}
    setHgBusy(false);
  };
  const sendHgChat=async(preset)=>{
    const q=(typeof preset==="string"?preset:hgChatIn).trim();
    if(!q||hgChatBusy||!hgResult)return;
    setHgChatIn("");setHgChatBusy(true);
    const history=[...hgChat,{role:"user",content:q}];
    setHgChat(history);
    try{
      const sys=`You are the rigorous, evidence-based career scout. The user asked "how good is this?" about a LinkedIn post and you produced this analysis: ${JSON.stringify(hgResult)}. Answer follow-up questions about THIS achievement only — grounded, honest, never punitive, every inference labelled, under 150 words unless asked for depth.`;
      const r=await fetchT({method:"POST",headers:API_HEADERS,body:JSON.stringify({model:SCORE_MODEL,max_tokens:700,thinking:{type:"disabled"},system:sys,messages:history.map(m=>({role:m.role,content:m.content}))})});
      const text=await r.text();
      if(!text)throw new Error("empty response from API");
      const d=JSON.parse(text);
      if(d.error)throw new Error(d.error.message);
      setHgChat([...history,{role:"assistant",content:d.content.map(b=>b.text||"").join("").trim()||"(no reply)"}]);
    }catch(e){setHgChat([...history,{role:"assistant",content:friendlyErr(e.message)}]);}
    setHgChatBusy(false);
  };

  // window.confirm/alert are blocked inside the artifact sandbox — use an
  // arm-then-confirm click pattern and an inline status message instead.
  const [confirmDel,setConfirmDel]=useState(null);
  const armDelete=id=>{setConfirmDel(id);setTimeout(()=>setConfirmDel(c=>c===id?null:c),3000);};
  const [ioMsg,setIoMsg]=useState("");
  const flashIo=m=>{setIoMsg(m);setTimeout(()=>setIoMsg(""),5000);};

  const exportCards=()=>{
    const blob=new Blob([JSON.stringify({app:"career-signal",exported:new Date().toISOString(),cards},null,2)],{type:"application/json"});
    const a=document.createElement("a");
    a.download=`career-signal-collection-${new Date().toISOString().slice(0,10)}.json`;
    a.href=URL.createObjectURL(blob);a.click();URL.revokeObjectURL(a.href);
  };
  const importCards=async file=>{
    if(!file)return;
    try{
      const data=JSON.parse(await file.text());
      const incoming=Array.isArray(data)?data:data.cards;
      if(!Array.isArray(incoming))throw new Error("no cards found in file");
      const merged=[...cards];
      let added=0,replaced=0;
      for(const c of incoming){
        if(!c||!c.stats||typeof c.OVR!=="number")continue;
        const i=merged.findIndex(m=>m.id===c.id||(c.name&&c.name!=="Unknown"&&m.name&&m.name.toLowerCase().trim()===c.name.toLowerCase().trim()));
        if(i===-1){merged.push(c);added++;}
        else if((c.updatedAt||c.createdAt||"")>(merged[i].updatedAt||merged[i].createdAt||"")){merged[i]=c;replaced++;}
      }
      const rescored=merged.map(c=>({...c,percentile:getPct(merged.filter(x=>x.id!==c.id),c.OVR)}));
      await persist(rescored);
      flashIo(`Imported: ${added} new, ${replaced} updated, ${incoming.length-added-replaced} skipped`);
    }catch(e){flashIo(`Import failed: ${e.message}`);}
    if(importRef.current)importRef.current.value="";
  };

  const sorted=[...cards].sort((a,b)=>b.OVR-a.OVR);
  const cohorts=[...new Set(cards.map(c=>c.year).filter(Boolean))].sort();
  const lbRows=sorted.filter(c=>lbCohort==="all"||c.year===lbCohort);
  const avg=cards.length?Math.round(cards.reduce((s,c)=>s+c.OVR,0)/cards.length):0;
  const ct=sel?T(sel.OVR):{acc:"var(--gold)"};
  const withMeta=c=>({...c,_totalCards:cards.length});

  return(
    <div style={{minHeight:"100vh",background:"var(--bg)",color:"var(--veee)",fontFamily:"'Space Mono',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:wght@400;700&display=swap');
        html.theme-dark{
          --bg:#080808;--s0a:#0a0a0a;--s0c:#0c0c0c;--s0f:#0f0f0f;--s11:#111;--s16:#161616;
          --b14:#1c1c1c;--b15:#1e1e1e;
          --v1a:#2e2e2e;--v1e:#3a3a3a;--v222:#8c8c8c;--v2a:#a8a8a8;--v2e:#b4b4b4;--v333:#c2c2c2;--v444:#cecece;--v555:#dadada;--v666:#e4e4e4;--v777:#ebebeb;--v888:#f1f1f1;--vaaa:#f6f6f6;--vddd:#fbfbfb;--veee:#fff;
          --gold:#FFD700;--gold2:#FF8800;--gold-deep:#aa8800;--gold-ink:#000;
          --c-pace:#00E5FF;--c-reach:#FF6B35;--c-stack:#A855F7;--c-rare:#10B981;--c-depth:#F43F5E;
          --warn-bg:#1a0a00;--conf-bg:#141200;--conf-dim:#a89a55;--conf-label:#cbbd6a;--axis:#ffffff30;
        }
        html.theme-light{
          --bg:#f4f2ec;--s0a:#edeae1;--s0c:#f9f8f3;--s0f:#fdfcf9;--s11:#eae7dd;--s16:#e6e3d9;
          --b14:#e6e2d6;--b15:#e4e0d4;
          --v1a:#dbd7cb;--v1e:#d3cfc2;--v222:#b0ac9c;--v2a:#a19d8d;--v2e:#98947f;--v333:#8b8778;--v444:#827e6f;--v555:#757263;--v666:#6a675a;--v777:#615e52;--v888:#57544a;--vaaa:#454338;--vddd:#26251f;--veee:#1c1b18;
          --gold:#8a6b00;--gold2:#a34d00;--gold-deep:#5f4a00;--gold-ink:#fff;
          --c-pace:#00707e;--c-reach:#c2410c;--c-stack:#7c3aed;--c-rare:#047857;--c-depth:#be123c;
          --warn-bg:#faeadd;--conf-bg:#f5efd8;--conf-dim:#857a3f;--conf-label:#6b6125;--axis:#00000022;
        }
        @keyframes shimmer{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        @keyframes flipIn{from{transform:rotateY(-90deg)}to{transform:rotateY(0deg)}}
        @keyframes pulseGlow{0%,100%{transform:scale(1)}50%{transform:scale(1.025)}}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--s0a)}::-webkit-scrollbar-thumb{background:var(--v222)}
        .row:hover{background:var(--s11)!important;border-color:color-mix(in srgb, var(--gold) 13%, transparent)!important}
        .ghost:hover{color:var(--gold)!important}
        .delbtn{opacity:0;transition:opacity 0.15s}.row:hover .delbtn{opacity:1}
        /* Every button: full-surface hit area above siblings, visible hover lift,
           and a pressed state (shadow ring + press-down) so clickability never
           relies on the cursor alone. */
        button{position:relative;z-index:2;-webkit-tap-highlight-color:transparent;touch-action:manipulation}
        /* Generous hit area: anything within 8px of a button counts as the button */
        button::after{content:"";position:absolute;inset:-8px;border-radius:inherit}
        button:not(:disabled):hover{filter:brightness(1.09)}
        button:not(:disabled):active{transform:translateY(1px) scale(0.98);filter:brightness(1.18);box-shadow:0 0 0 3px color-mix(in srgb, var(--gold) 30%, transparent)!important;transition:transform 0.04s,box-shadow 0.04s}
      `}</style>

      <div style={{display:"flex",alignItems:"center",borderBottom:"1px solid var(--s11)",background:"var(--bg)",padding:"0 28px",position:"sticky",top:0,zIndex:100}}>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:20,letterSpacing:3,color:"var(--gold)",marginRight:36,padding:"15px 0",textShadow:"0 0 18px color-mix(in srgb, var(--gold) 27%, transparent)",cursor:"pointer"}} onClick={()=>{setView("home");reset();setSel(null);}}>CAREER SIGNAL</div>
        {[["home","home"],["create","create"],["howgood","how good?"],["versus","versus"],["leaderboard","leaderboard"],["guide","guide"],["changelog","changelog"]].map(([v,label])=>(
          <button key={v} className="ghost" onClick={()=>{setView(v);reset();setSel(null);}} style={{background:"none",border:"none",borderBottom:view===v?"2px solid var(--gold)":"2px solid transparent",cursor:"pointer",padding:"15px 14px",color:view===v?"var(--gold)":"var(--v444)",fontFamily:"'Space Mono'",fontSize:10,letterSpacing:2,textTransform:"uppercase",transition:"color 0.15s",whiteSpace:"nowrap"}}>{label}</button>
        ))}
        {myId&&cards.some(c=>c.id===myId)&&(
          <button className="ghost" onClick={()=>{const me=cards.find(c=>c.id===myId);if(me){setSel(me);setView("profile");reset();}}} style={{background:"none",border:"none",borderBottom:"2px solid transparent",cursor:"pointer",padding:"15px 14px",color:"var(--gold)",fontFamily:"'Space Mono'",fontSize:10,letterSpacing:2,textTransform:"uppercase"}}>★ MY CARD</button>
        )}
        <div style={{flex:1}}/>
        <button onClick={exportCards} disabled={!cards.length} title="One-click backup — downloads your whole collection as JSON" style={{background:"none",border:"1px solid var(--v1e)",color:cards.length?"var(--gold)":"var(--v1e)",borderRadius:5,padding:"4px 11px",cursor:cards.length?"pointer":"not-allowed",fontFamily:"'Space Mono',monospace",fontSize:11,lineHeight:1.4,marginRight:8}}>⬇</button>
        <button onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} title={theme==="dark"?"Switch to light mode":"Switch to dark mode"} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v444)",borderRadius:5,padding:"4px 11px",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:11,lineHeight:1.4,marginRight:8,transition:"color 0.15s,border-color 0.15s"}} onMouseEnter={e=>{e.target.style.color="var(--gold)";e.target.style.borderColor="var(--gold)";}} onMouseLeave={e=>{e.target.style.color="var(--v444)";e.target.style.borderColor="var(--v1e)";}}>{theme==="dark"?"☀":"☾"}</button>
        <button onClick={()=>{setView("settings");reset();setSel(null);}} title="Settings" style={{background:"none",border:"1px solid var(--v1e)",color:view==="settings"?"var(--gold)":"var(--v444)",borderRadius:5,padding:"4px 11px",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:11,lineHeight:1.4,marginRight:14,transition:"color 0.15s,border-color 0.15s"}} onMouseEnter={e=>{e.target.style.color="var(--gold)";e.target.style.borderColor="var(--gold)";}} onMouseLeave={e=>{e.target.style.color=view==="settings"?"var(--gold)":"var(--v444)";e.target.style.borderColor="var(--v1e)";}}>⚙</button>
        <span style={{color:"var(--v222)",fontSize:9,letterSpacing:1}}>{cards.length} PROFILE{cards.length===1?"":"S"}</span>
      </div>

      <div style={{maxWidth:880,margin:"0 auto",padding:"36px 24px"}}>
        <input ref={importRef} type="file" accept="application/json,.json" style={{display:"none"}} onChange={e=>importCards(e.target.files?.[0])}/>

        {lightbox&&(()=>{
          const L=lightbox;
          const cur=L.list[L.idx];
          if(!cur){setLightbox(null);return null;}
          const go=d=>setLightbox({...L,idx:(L.idx+d+L.list.length)%L.list.length});
          let touchX=null;
          return(
          <div onClick={()=>setLightbox(null)} onTouchStart={e=>{touchX=e.touches[0].clientX;}} onTouchEnd={e=>{if(touchX===null||L.list.length<2)return;const dx=e.changedTouches[0].clientX-touchX;if(Math.abs(dx)>48){go(dx<0?1:-1);}touchX=null;}} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.93)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:"20px 56px"}}>
            <img src={cur} alt="" onClick={e=>e.stopPropagation()} style={{maxWidth:"88vw",maxHeight:"84vh",objectFit:"contain",borderRadius:6,boxShadow:"0 0 60px rgba(0,0,0,0.8)"}}/>
            {L.list.length>1&&<button onClick={e=>{e.stopPropagation();go(-1);}} style={{position:"fixed",left:12,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",color:"#fff",width:42,height:64,borderRadius:8,cursor:"pointer",fontSize:26,lineHeight:1}}>‹</button>}
            {L.list.length>1&&<button onClick={e=>{e.stopPropagation();go(1);}} style={{position:"fixed",right:12,top:"50%",transform:"translateY(-50%)",background:"rgba(255,255,255,0.08)",border:"1px solid rgba(255,255,255,0.2)",color:"#fff",width:42,height:64,borderRadius:8,cursor:"pointer",fontSize:26,lineHeight:1}}>›</button>}
            {L.del&&<button onClick={e=>{e.stopPropagation();L.del(L.idx);const nl=L.list.filter((_,i)=>i!==L.idx);nl.length?setLightbox({...L,list:nl,idx:Math.min(L.idx,nl.length-1)}):setLightbox(null);}} style={{position:"fixed",top:14,right:14,background:"#dc2626",border:"none",color:"#fff",padding:"9px 16px",borderRadius:6,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:1.5,textTransform:"uppercase",boxShadow:"0 2px 12px rgba(220,38,38,0.5)"}}>✕ DELETE THIS SCREENSHOT</button>}
            <div style={{position:"fixed",bottom:14,left:0,right:0,textAlign:"center",color:"#ffffffaa",fontSize:9,letterSpacing:2,fontFamily:"'Space Mono',monospace",textTransform:"uppercase"}}>
              {L.list.length>1&&<span style={{marginRight:16}}>{L.idx+1} / {L.list.length} · ‹ › or swipe to browse</span>}
              <span style={{background:"rgba(255,255,255,0.1)",padding:"4px 12px",borderRadius:12}}>CLICK ANYWHERE TO DISMISS</span>
            </div>
          </div>
          );
        })()}

        {view==="home"&&(
          <div style={{animation:"fadeUp 0.4s ease"}}>
            <div style={{textAlign:"center",marginBottom:52}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:60,letterSpacing:4,lineHeight:1,background:"linear-gradient(135deg,var(--gold),var(--gold2))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>CAREER SIGNAL</div>
              <div style={{color:"var(--v333)",fontSize:10,letterSpacing:4,marginTop:8,textTransform:"uppercase"}}>who's most cracked — rated, ranked, no debate</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:52}}>
              {[{l:"Total Profiles",v:cards.length},{l:"Firms Represented",v:[...new Set(cards.map(c=>c.company))].length},{l:"Avg OVR",v:cards.length?avg:"—"}].map(s=>(
                <div key={s.l} style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"22px 16px",textAlign:"center"}}>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:38,color:"var(--gold)",lineHeight:1,textShadow:"0 0 12px color-mix(in srgb, var(--gold) 20%, transparent)"}}>{s.v}</div>
                  <div style={{color:"var(--v333)",fontSize:8,letterSpacing:2,marginTop:4,textTransform:"uppercase"}}>{s.l}</div>
                </div>
              ))}
            </div>
            {sorted.length>0&&(
              <>
                <div style={{color:"var(--v2a)",fontSize:9,letterSpacing:3,textTransform:"uppercase",marginBottom:6}}>TEAM OF THE YEAR</div>
                <div style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5,marginBottom:20}}>80+ OVR required for a full TOTY spot — top-5 cards below 80 hold the slot as pending until real competition arrives</div>
                <div style={{display:"flex",gap:16,flexWrap:"wrap",justifyContent:"center",alignItems:"flex-start",marginBottom:40}}>
                  {sorted.slice(0,Math.min(3,sorted.length)).map(c=>(
                    <div key={c.id} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:8}}>
                      <div style={{opacity:c.OVR>=80?1:0.75}}><Card card={withMeta(c)} sz={0.85} onClick={()=>{setSel(c);setView("profile");}}/></div>
                      {c.OVR<80&&<div style={{background:"var(--s0c)",border:"1px dashed var(--v1e)",borderRadius:4,padding:"4px 10px",color:"var(--v444)",fontSize:8,letterSpacing:1.5,textTransform:"uppercase",fontFamily:"'Space Mono',monospace"}}>⏳ PENDING MORE CARDS · below 80 OVR</div>}
                    </div>
                  ))}
                </div>
                <div style={{background:"var(--s0c)",border:"1px solid var(--b14)",borderRadius:8,padding:"20px 24px"}}>
                  <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:3,textTransform:"uppercase",marginBottom:14}}>OVR DISTRIBUTION</div>
                  <Bell cards={cards} targetOvr={avg}/>
                </div>
              </>
            )}
            {cards.length===0&&(
              <div style={{textAlign:"center",padding:"60px 0"}}>
                <div style={{color:"var(--v1a)",fontFamily:"'Bebas Neue'",fontSize:28,letterSpacing:2}}>NO PROFILES YET</div>
                <div style={{color:"var(--v2a)",fontSize:9,marginTop:8,letterSpacing:1}}>screenshot a linkedin, we score it instantly</div>
                <div style={{display:"flex",gap:10,justifyContent:"center",marginTop:20,flexWrap:"wrap"}}>
                  <button onClick={()=>setView("create")} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"11px 28px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:10,fontWeight:700,letterSpacing:3,textTransform:"uppercase"}}>CREATE FIRST CARD</button>
                  <button onClick={()=>importRef.current?.click()} style={{background:"none",border:"1px solid color-mix(in srgb, var(--gold) 27%, transparent)",color:"var(--gold)",padding:"11px 24px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:10,letterSpacing:3,textTransform:"uppercase"}}>⬆ RESTORE BACKUP</button>
                </div>
                <div style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5,marginTop:10}}>coming from an older version? open the old artifact → leaderboard → EXPORT, then restore the file here</div>
              </div>
            )}
          </div>
        )}

        {view==="create"&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:540,margin:"0 auto"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:28,letterSpacing:3,color:"var(--gold)",marginBottom:2}}>{updating?"GOT AN UPDATE?":"NEW CARD"}</div>
            <div style={{color:"var(--v333)",fontSize:9,letterSpacing:2,marginBottom:updating?18:32,textTransform:"uppercase"}}>{updating?"only screenshot what's NEW — everything below is already on the card":"Find a LinkedIn profile, screenshot it, and we'll rate it"}</div>
            {updating&&step<3&&(()=>{
              const uc=cards.find(c=>c.id===updating);
              if(!uc)return null;
              const bad=v=>!v||/^(unknown|not visible|none|none visible|—|-)$/i.test(String(v).trim());
              return(
                <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 27%, transparent)",borderRadius:10,padding:"16px 18px",marginBottom:20}}>
                  <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:14,letterSpacing:2,marginBottom:4}}>ESTABLISHED INFORMATION</div>
                  <div style={{color:"var(--v555)",fontSize:9,lineHeight:1.7,marginBottom:10}}>This is what built {uc.name}'s current {uc.OVR} OVR — it's carried forward automatically, so don't re-screenshot any of it. Capture just the new role, award, result or section.</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px 14px"}}>
                    {[["University",uc.uni],["Cohort",uc.year],["Company",uc.company],["Role",uc.role],["Grades",uc.grades],["Prior roles",uc.prev]].filter(([,v])=>!bad(v)).map(([l,v])=>(
                      <div key={l}><span style={{color:"var(--v2a)",fontSize:8,letterSpacing:1}}>{l}: </span><span style={{color:"var(--v777)",fontSize:9}}>{String(v)}</span></div>
                    ))}
                  </div>
                  {!bad(uc.timeline)&&<div style={{marginTop:8}}><span style={{color:"var(--v2a)",fontSize:8,letterSpacing:1}}>TIMELINE ON RECORD: </span><span style={{color:"var(--v666)",fontSize:9,lineHeight:1.6}}>{uc.timeline}</span></div>}
                  {!bad(uc.evidence)&&<div style={{marginTop:6}}><span style={{color:"var(--v2a)",fontSize:8,letterSpacing:1}}>EVIDENCE ON RECORD: </span><span style={{color:"var(--v666)",fontSize:9,lineHeight:1.6}}>{uc.evidence}</span></div>}
                </div>
              );
            })()}
            {step<3&&<Steps cur={step}/>}

            {step===0&&(
              <div style={{animation:"fadeUp 0.3s ease"}}>
                <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:10,padding:"26px 24px",marginBottom:14}}>
                  <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:15,letterSpacing:2,marginBottom:14}}>1 — FIND THEIR LINKEDIN PROFILE</div>
                  <div style={{color:"var(--v666)",fontSize:11,lineHeight:1.9,marginBottom:10}}>Go to their LinkedIn. You want to capture the sections that tell the story — the more you include, the sharper the analysis.</div>
                  <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:18}}>
                    {[{s:"Experience",d:"job titles, companies, dates, role descriptions",req:true},{s:"Education",d:"university, degree, grades if visible",req:true},{s:"Awards / Honours",d:"prizes, competitions, academic distinctions",req:false},{s:"Metrics / About",d:"traction numbers, audience size, anything concrete",req:false}].map(x=>(
                      <div key={x.s} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:x.req?"var(--gold)":"var(--v333)",marginTop:4,flexShrink:0}}/>
                        <div><span style={{color:x.req?"var(--vaaa)":"var(--v444)",fontSize:10,letterSpacing:0.5}}>{x.s}</span><span style={{color:"var(--v2a)",fontSize:9,marginLeft:8}}>{x.d}</span>{x.req&&<span style={{color:"color-mix(in srgb, var(--gold) 33%, transparent)",fontSize:8,marginLeft:6}}>essential</span>}</div>
                      </div>
                    ))}
                  </div>
                  <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer" style={{display:"inline-flex",alignItems:"center",gap:8,background:"#0a66c2",color:"#fff",textDecoration:"none",padding:"9px 18px",borderRadius:5,fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>OPEN LINKEDIN ↗</a>
                </div>
                <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:10,padding:"26px 24px",marginBottom:20}}>
                  <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:15,letterSpacing:2,marginBottom:14}}>2 — SCREENSHOT IT</div>
                  {IS_MOBILE?(
                    <>
                      <div style={{color:"var(--v666)",fontSize:11,lineHeight:1.9,marginBottom:14}}>Open their profile in the LinkedIn app and take a screenshot of the <span style={{color:"var(--vaaa)"}}>Experience section</span>, then another of the <span style={{color:"var(--vaaa)"}}>Education section</span> (press <span style={{color:"var(--vaaa)"}}>Power + Volume Up</span> on most phones). Then come back here and upload both on the next page.</div>
                      <div style={{color:"var(--v2a)",fontSize:9,letterSpacing:1}}>Long profiles: scroll and take a couple of screenshots per section — multiple screenshots are fine.</div>
                    </>
                  ):(
                    <>
                      <div style={{color:"var(--v666)",fontSize:11,lineHeight:1.9,marginBottom:24}}>Hold these keys at the same time. A crosshair appears — drag a box around just their <span style={{color:"var(--vaaa)"}}>Experience section</span>. Screenshot copies to clipboard, no saving needed. Once you've done that, repeat for their <span style={{color:"var(--vaaa)"}}>Education section</span>. You can paste both on the next page — multiple screenshots are fine.</div>
                      <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:8,marginBottom:18,flexWrap:"wrap"}}>
                        {IS_MAC?(
                          <>
                            <Key label="⌘ CMD" wide pressed={pk.win}/>
                            <span style={{color:"var(--v333)",fontSize:18,fontFamily:"'Bebas Neue'"}}>+</span>
                            <Key label="SHIFT" pressed={pk.shift}/>
                            <span style={{color:"var(--v333)",fontSize:18,fontFamily:"'Bebas Neue'"}}>+</span>
                            <Key label="4" pressed={pk.s4}/>
                          </>
                        ):(
                          <>
                            <Key label="⊞ WIN" sub="windows key" wide pressed={pk.win}/>
                            <span style={{color:"var(--v333)",fontSize:18,fontFamily:"'Bebas Neue'"}}>+</span>
                            <Key label="SHIFT" pressed={pk.shift}/>
                            <span style={{color:"var(--v333)",fontSize:18,fontFamily:"'Bebas Neue'"}}>+</span>
                            <Key label="S" pressed={pk.s}/>
                          </>
                        )}
                      </div>
                      <div style={{color:"var(--v2a)",fontSize:9,textAlign:"center",letterSpacing:1}}>{IS_MAC?"The area screenshot — add CTRL to copy straight to clipboard, or drag the saved file in":"What's it called? Snip & Sketch — press these keys to try, they'll light up"}</div>
                    </>
                  )}
                </div>
                <button onClick={()=>setStep(1)} style={{width:"100%",background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"13px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:11,fontWeight:700,letterSpacing:3,textTransform:"uppercase"}}>GOT MY SCREENSHOTS →</button>
              </div>
            )}

            {step===1&&(
              <div style={{animation:"fadeUp 0.3s ease"}}>
                {imgs.length>0&&(
                  <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                    {imgs.map((im,i)=>(
                      <div key={i} style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,display:"flex",alignItems:"center",gap:10,padding:"8px 12px"}}>
                        <img src={im.preview} alt="" onClick={()=>openLB(imgs.map(x=>x.preview),i,di=>setImgs(p=>p.filter((_,j)=>j!==di)))} title="Click to inspect full size" style={{width:56,height:36,objectFit:"cover",borderRadius:3,flexShrink:0,cursor:"pointer"}}/>
                        <span onClick={()=>openLB(imgs.map(x=>x.preview),i,di=>setImgs(p=>p.filter((_,j)=>j!==di)))} style={{color:"var(--v444)",fontSize:9,flex:1,letterSpacing:0.5,cursor:"pointer"}}>Screenshot {i+1} <span style={{color:"var(--v2a)",fontSize:8}}>· click to inspect</span></span>
                        <button onClick={()=>setImgs(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,padding:0}}>remove</button>
                      </div>
                    ))}
                  </div>
                )}
                <div
                  onDragOver={e=>{e.preventDefault();setDrag(true);}}
                  onDragLeave={()=>setDrag(false)}
                  onDrop={e=>{e.preventDefault();setDrag(false);Array.from(e.dataTransfer.files).forEach(addFile);}}
                  onClick={()=>fileRef.current?.click()}
                  style={{border:`2px dashed ${drag?"var(--gold)":"var(--v1e)"}`,borderRadius:10,padding:"44px 24px",textAlign:"center",cursor:"pointer",background:drag?"color-mix(in srgb, var(--gold) 3%, transparent)":"var(--s0a)",transition:"all 0.2s",marginBottom:12}}>
                  <div style={{fontSize:28,marginBottom:12,opacity:0.3}}>⬆</div>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:20,letterSpacing:2,color:drag?"var(--gold)":"var(--v2e)",marginBottom:6}}>{imgs.length>0?"ADD ANOTHER SCREENSHOT":"PASTE OR DROP HERE"}</div>
                  <div style={{color:"color-mix(in srgb, var(--gold) 40%, transparent)",fontSize:11,letterSpacing:1,marginBottom:4,fontFamily:"'Space Mono'"}}>Ctrl + V to paste from clipboard</div>
                  <div style={{color:"var(--v1e)",fontSize:9,letterSpacing:1}}>paste multiple if you have both Experience and Education screenshots</div>
                  <input ref={fileRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={e=>Array.from(e.target.files).forEach(addFile)}/>
                </div>
                {err&&<div style={{color:"#ff4444",fontSize:9,letterSpacing:1,marginBottom:12}}>{err}</div>}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <button className="ghost" onClick={()=>setStep(0)} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase",padding:0,transition:"color 0.15s"}}>↠BACK</button>
                  {imgs.length>0&&<button onClick={()=>setStep(2)} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"10px 20px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>ANALYSE {imgs.length} SCREENSHOT{imgs.length>1?"S":""} →</button>}
                </div>
              </div>
            )}

            {step===2&&imgs.length>0&&(
              <div style={{animation:"fadeUp 0.3s ease"}}>
                <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                  {imgs.map((im,i)=>(
                    <div key={i} onClick={()=>openLB(imgs.map(x=>x.preview),i,di=>setImgs(p=>p.filter((_,j)=>j!==di)))} title="Click to inspect full size" style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,overflow:"hidden",cursor:"pointer",position:"relative"}}>
                      <img src={im.preview} alt="" style={{width:"100%",display:"block",maxHeight:140,objectFit:"cover",objectPosition:"top"}}/>
                      <div style={{position:"absolute",right:8,bottom:6,background:"rgba(0,0,0,0.55)",color:"#fff",fontSize:8,letterSpacing:1,padding:"3px 8px",borderRadius:3,fontFamily:"'Space Mono',monospace"}}>🔍 CLICK TO INSPECT</div>
                    </div>
                  ))}
                  <button onClick={()=>setStep(1)} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,padding:0,textDecoration:"underline",alignSelf:"flex-end"}}>edit screenshots</button>
                </div>
                {dupWarn&&(
                  <div style={{background:"var(--warn-bg)",border:"1px solid color-mix(in srgb, var(--c-reach) 20%, transparent)",borderRadius:8,padding:"14px 18px",marginBottom:14}}>
                    <div style={{color:"var(--c-reach)",fontSize:9,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Profile already in database</div>
                    <div style={{color:"var(--v666)",fontSize:10,lineHeight:1.6,marginBottom:10}}><span style={{color:"var(--v888)"}}>{dupWarn.name}</span> ({dupWarn.company}) was already analysed. Update their card or skip?</div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>{setUpdating(dupWarn.id);setDupWarn(null);analyse(true);}} style={{background:"var(--c-reach)",color:"var(--gold-ink)",border:"none",padding:"8px 16px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>UPDATE CARD</button>
                      <button onClick={()=>{setDupWarn(null);reset();}} style={{background:"none",border:"1px solid var(--v333)",color:"var(--v555)",padding:"8px 16px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:1,textTransform:"uppercase"}}>SKIP</button>
                    </div>
                  </div>
                )}
                {(extracting||scoring)&&(
                  <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"16px 18px",marginBottom:14}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <span style={{color:"var(--v777)",fontSize:10,letterSpacing:1}}>{(extracting?STAGES_EXTRACT:STAGES_SCORE)[Math.min(stageIdx,(extracting?STAGES_EXTRACT:STAGES_SCORE).length-1)]}</span>
                      <span style={{display:"flex",alignItems:"center",gap:10}}><span style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:18,lineHeight:1}}>{Math.round(prog)}%</span><span style={{color:"var(--v444)",fontSize:8,fontFamily:"'Space Mono',monospace"}}>{elapsed}s</span><button onClick={cancelActiveCall} title="Kill the in-flight request now — you can retry immediately" style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:1,textTransform:"uppercase"}}>CANCEL</button></span>
                    </div>
                    <div style={{height:6,background:"var(--v1a)",borderRadius:3,overflow:"hidden"}}>
                      <div style={{width:`${prog}%`,height:"100%",background:"linear-gradient(90deg,var(--gold),var(--gold2))",borderRadius:3,transition:"width 0.18s linear"}}/>
                    </div>
                    {debugTiming&&(()=>{
                      const st=mstats(scanStats[extracting?"extract":"score"]);
                      const limit=extracting?90:150;
                      const warnAt=st?Math.max(40,Math.round(st.m+2*st.sd)):60;
                      return(
                        <div style={{display:"flex",justifyContent:"space-between",gap:10,marginTop:8,flexWrap:"wrap"}}>
                          <span style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5}}>{st?`typical ${extracting?"read":"score"}: ${Math.round(st.m)}s (±${Math.round(st.sd)}s over last ${scanStats[extracting?"extract":"score"].length} runs)`:"first scans are building your timing baseline"}</span>
                          {elapsed>warnAt&&<span style={{color:"var(--c-reach)",fontSize:8,letterSpacing:0.5}}>⚠ running long — {elapsed}s{st?`, past 2σ of your typical`:""} · usually claude.ai proxy congestion · auto-aborts with a retry message at {limit}s</span>}
                        </div>
                      );
                    })()}
                  </div>
                )}
                {err&&<div style={{color:"#ff4444",fontSize:9,letterSpacing:1,marginBottom:12}}>{err}</div>}
                {!dupWarn&&(
                  <div onClick={toggleRoast} style={{display:"flex",alignItems:"center",gap:10,background:"var(--s0f)",border:`1px solid ${roastMode?"var(--c-reach)":"var(--b15)"}`,borderRadius:8,padding:"10px 14px",marginBottom:12,cursor:"pointer",transition:"border-color 0.15s"}}>
                    <div style={{width:30,height:16,borderRadius:9,background:roastMode?"var(--c-reach)":"var(--v1e)",position:"relative",transition:"background 0.15s",flexShrink:0}}>
                      <div style={{position:"absolute",top:2,left:roastMode?16:2,width:12,height:12,borderRadius:"50%",background:"#fff",transition:"left 0.15s"}}/>
                    </div>
                    <div>
                      <span style={{color:roastMode?"var(--c-reach)":"var(--v555)",fontSize:10,letterSpacing:1}}>🔥 ROAST MODE</span>
                      <span style={{color:"var(--v2a)",fontSize:9,marginLeft:8}}>show the roast immediately — it's always generated now, and revealable later on any card</span>
                    </div>
                  </div>
                )}
                {!dupWarn&&<button onClick={()=>analyse(false)} disabled={extracting||scoring} style={{width:"100%",background:extracting||scoring?"var(--s11)":"var(--gold)",color:extracting||scoring?"var(--v333)":"var(--gold-ink)",border:"none",padding:"13px",borderRadius:5,cursor:extracting||scoring?"not-allowed":"pointer",fontFamily:"'Space Mono'",fontSize:11,fontWeight:700,letterSpacing:3,textTransform:"uppercase",transition:"background 0.15s"}}>
                  {extracting?"READING PROFILE…":scoring?"BUILDING THE CARD…":"ANALYSE & GENERATE CARD"}
                </button>}
              </div>
            )}

            {step===3&&done&&!revealed&&(
              <div style={{textAlign:"center",animation:"fadeUp 0.5s ease",padding:"40px 0"}}>
                <div style={{display:"flex",justifyContent:"center",perspective:900}}>
                  <div onClick={()=>{if(flipping)return;setFlipping(true);setTimeout(()=>setRevealed(true),260);}} style={{cursor:"pointer",transform:flipping?"rotateY(90deg)":"rotateY(0deg)",transition:"transform 0.26s ease-in"}}>
                    <CardBack glow={T(done.OVR).glow}/>
                  </div>
                </div>
              </div>
            )}

            {step===3&&done&&revealed&&(
              <div style={{textAlign:"center",animation:"fadeUp 0.5s ease"}}>
                {extracted&&(
                  <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"14px 18px",marginBottom:16,textAlign:"left"}}>
                    <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:10,textTransform:"uppercase"}}>Extracted from screenshots</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 16px"}}>
                      {[["Name",extracted.name],["University",extracted.uni],["Company",extracted.company],["Role",extracted.role],["Age",extracted.age],["Cohort",extracted.year]].map(([l,v])=>(
                        <div key={l}><span style={{color:"var(--v2a)",fontSize:8,letterSpacing:1}}>{l}: </span><span style={{color:"var(--v777)",fontSize:9}}>{v||"—"}</span></div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{display:"flex",justifyContent:"center",marginBottom:20,perspective:900}}><div style={{animation:"flipIn 0.26s ease-out"}}><Card card={withMeta(done)} sz={1.05} onClick={()=>{setSel(done);setView("profile");}}/></div></div>
                {done.history?.length>0&&(()=>{const ps=done.history[done.history.length-1];const d=done.OVR-ps.OVR;return(
                  <div style={{fontSize:10,marginBottom:14,letterSpacing:1,fontFamily:"'Space Mono',monospace",color:d>0?"#16a34a":d<0?"#dc2626":"var(--v444)"}}>{d===0?"OVR unchanged":(d>0?`▲ OVR +${d}`:`▼ OVR ${d}`)} since last scan ({new Date(ps.date).toLocaleDateString()}){done.lastDeltaCause&&d!==0&&<span style={{display:"block",color:"var(--v444)",fontSize:8,marginTop:3,letterSpacing:0.5}}>why: {done.lastDeltaCause}</span>}</div>
                );})()}
                {done.thesis&&<div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:18,marginBottom:14,textAlign:"left"}}>
                  <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:8,textTransform:"uppercase"}}>Profile Thesis</div>
                  <div style={{color:"var(--v888)",fontSize:11,lineHeight:1.7}}>{done.thesis}</div>
                </div>}
                {done.roast&&<div style={{background:"var(--warn-bg)",border:"1px solid color-mix(in srgb, var(--c-reach) 33%, transparent)",borderRadius:8,padding:18,marginBottom:14,textAlign:"left"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{color:"var(--c-reach)",fontSize:8,letterSpacing:2,textTransform:"uppercase"}}>🔥 The Roast</div>
                    {!(roastOpen||roastMode)&&<button onClick={()=>setRoastOpen(true)} style={{background:"var(--c-reach)",color:"#fff",border:"none",padding:"6px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>REVEAL</button>}
                  </div>
                  {(roastOpen||roastMode)&&<div style={{color:"var(--v777)",fontSize:11,lineHeight:1.8,marginTop:8}}>{done.roast}</div>}
                </div>}
                <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"16px 20px",marginBottom:20}}>
                  <Bell cards={cards.filter(c=>c.id!==done.id)} targetOvr={done.OVR} acc={T(done.OVR).acc}/>
                  <div style={{color:"var(--v333)",fontSize:9,textAlign:"center",marginTop:6,letterSpacing:1}}>TOP {100-(done.percentile||50)}% · OVR {done.OVR}</div>
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"center"}}>
                  <button onClick={reset} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"10px 20px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>ADD ANOTHER</button>
                  <button onClick={()=>{setSel(done);setView("profile");}} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"10px 22px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>VIEW PROFILE →</button>
                </div>
              </div>
            )}
          </div>
        )}

        {view==="leaderboard"&&(
          <div style={{animation:"fadeUp 0.4s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:32}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:30,letterSpacing:3,color:"var(--gold)"}}>LEADERBOARD</div>
                <div style={{color:"var(--v333)",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>{lbCohort==="all"?cards.length:lbRows.length} profile{(lbCohort==="all"?cards.length:lbRows.length)===1?"":"s"} ranked by OVR{lbCohort!=="all"?` · class of ${lbCohort}`:""}</div>
                <div style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5,marginTop:4,maxWidth:440,lineHeight:1.5}}>Raw OVR ranks absolute visible signal — a first-year vs a graduate isn't like-for-like. Filter by cohort to compare within the same stage.</div>
              </div>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                {ioMsg&&<span style={{color:"var(--v555)",fontSize:9,letterSpacing:1,fontFamily:"'Space Mono',monospace",marginRight:6}}>{ioMsg}</span>}
                <select value={lbCohort} onChange={e=>setLbCohort(e.target.value)} style={{background:"var(--s0f)",border:"1px solid var(--v1e)",borderRadius:5,padding:"8px 10px",color:"var(--v555)",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:1,cursor:"pointer",outline:"none"}}>
                  <option value="all">ALL COHORTS</option>
                  {cohorts.map(y=><option key={y} value={y}>CLASS OF {y}</option>)}
                </select>
                <button onClick={exportCards} disabled={!cards.length} style={{background:"none",border:"1px solid var(--v1e)",color:cards.length?"var(--v555)":"var(--v1e)",padding:"8px 14px",borderRadius:5,cursor:cards.length?"pointer":"not-allowed",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>⬇ EXPORT</button>
                <button onClick={()=>importRef.current?.click()} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"8px 14px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>⬆ IMPORT</button>
                <button onClick={()=>setView("create")} style={{background:"none",border:"1px solid color-mix(in srgb, var(--gold) 20%, transparent)",color:"var(--gold)",padding:"8px 16px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase"}} onMouseEnter={e=>e.target.style.borderColor="color-mix(in srgb, var(--gold) 40%, transparent)"} onMouseLeave={e=>e.target.style.borderColor="color-mix(in srgb, var(--gold) 20%, transparent)"}>+ ADD PROFILE</button>
              </div>
            </div>
            {sorted.length===0?(
              <div style={{textAlign:"center",padding:"64px 0",color:"var(--v1a)",fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:2}}>NO PROFILES YET</div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                <div style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr 52px 60px 28px",padding:"8px 12px",gap:8,color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",borderBottom:"1px solid var(--s11)",marginBottom:4}}>
                  <span>#</span><span>Name</span><span>University</span><span>Archetype</span><span>OVR</span><span title="Relative to the profiles in YOUR pool — not the general population. Unlocks at 30 profiles; tier shown until then.">{cards.length>=30?"Pool %":"Tier"}</span><span/>
                </div>
                {lbRows.map((c,i)=>{
                  const ct2=T(c.OVR);
                  return(
                    <div key={c.id} className="row" onClick={()=>{setSel(c);setView("profile");}} style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr 52px 60px 28px",padding:"12px 12px",gap:8,alignItems:"center",background:i%2===0?"var(--s0a)":"var(--s0c)",borderRadius:5,cursor:"pointer",border:"1px solid transparent",transition:"background 0.12s,border-color 0.12s"}}>
                      <span style={{fontFamily:"'Bebas Neue'",fontSize:18,color:i===0?"var(--gold)":i===1?"#B0B0B0":i===2?"#CD7F32":"var(--v2a)"}}>{i+1}</span>
                      <div>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:15,letterSpacing:1,color:"var(--vddd)"}}>{myId===c.id&&<span style={{color:"var(--gold)",marginRight:6}}>★</span>}{c.name}{(c.rubricV||0)<RUBRIC_VERSION&&<span title="Scored under an older rating system — open the card and RE-SCORE to bring it up to date" style={{color:"var(--c-reach)",marginLeft:5,cursor:"help"}}>*</span>}</div>
                        <div style={{fontSize:8,color:"var(--v2e)",letterSpacing:1,marginTop:1}}>CLASS OF {c.year||"—"}</div>
                      </div>
                      <div style={{fontSize:10,color:"var(--v444)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.uni}</div>
                      <div>
                        <div style={{fontSize:10,color:ct2.acc,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",textTransform:"uppercase",letterSpacing:0.5}}>{c.archetype||c.company}</div>
                        <div style={{fontSize:8,color:"var(--v333)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.profile_type||c.role}</div>
                      </div>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:ct2.acc}}>{c.OVR}</div>
                      <div style={{fontSize:9,color:"var(--v444)"}}>{cards.length>=30?`TOP ${100-(c.percentile||50)}%`:ct2.label}</div>
                      <button className="delbtn" onClick={e=>{e.stopPropagation();if(confirmDel===c.id){deleteCard(c.id);setConfirmDel(null);}else{armDelete(c.id);}}} title={confirmDel===c.id?"Click again to delete":"Delete card"} style={{background:"none",border:"none",color:"#ff4444",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:10,padding:0,lineHeight:1}}>{confirmDel===c.id?"SURE?":"✕"}</button>
                    </div>
                  );
                })}
                {lbRows.some(c=>(c.rubricV||0)<RUBRIC_VERSION)&&<div style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5,marginTop:8,paddingLeft:12}}><span style={{color:"var(--c-reach)"}}>*</span> scored under an older rating system — open the card and RE-SCORE to make it comparable</div>}
              </div>
            )}
          </div>
        )}

        {view==="versus"&&(
          <div style={{animation:"fadeUp 0.4s ease"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:30,letterSpacing:3,color:"var(--gold)"}}>VERSUS</div>
            <div style={{color:"var(--v333)",fontSize:9,letterSpacing:2,textTransform:"uppercase",marginBottom:28}}>pick two cards — or benchmark anyone against THE FIELD. every profile you add sharpens the pool as a benchmark</div>
            {cards.length<2?(
              <div style={{textAlign:"center",padding:"64px 0"}}>
                <div style={{color:"var(--v1a)",fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:2,marginBottom:14}}>NEED AT LEAST 2 CARDS</div>
                <button onClick={()=>setView("create")} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"10px 22px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>+ ADD PROFILES</button>
              </div>
            ):(
              <>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:28}}>
                  {[["A",vsA,setVsA,vsB],["B",vsB,setVsB,vsA]].map(([label,val,setVal,other])=>(
                    <select key={label} value={val} onChange={e=>setVal(e.target.value)} style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:6,padding:"11px 12px",color:val?"var(--vddd)":"var(--v444)",fontFamily:"'Space Mono',monospace",fontSize:10,letterSpacing:0.5,cursor:"pointer",outline:"none"}}>
                      <option value="">— Select card {label} —</option>
                      {other!=="__field"&&<option value="__field">THE FIELD · pool average · OVR {avg}</option>}
                      {sorted.filter(c=>c.id!==other).map(c=><option key={c.id} value={c.id}>{c.name!=="Unknown"?c.name:(c.moniker||"Unknown")} · OVR {c.OVR}</option>)}
                    </select>
                  ))}
                </div>
                {(()=>{
                  const mkField=()=>({id:"__field",name:"The Field",moniker:"The Field",uni:`Average of ${cards.length} scanned profiles`,year:"",company:"Pool Average",role:"The benchmark of everyone scanned",archetype:"THE FIELD",stats:Object.fromEntries(STATS.map(s=>[s,Math.round(cards.reduce((t,c)=>t+c.stats[s],0)/cards.length)])),OVR:avg});
                  const a=vsA==="__field"?mkField():cards.find(c=>c.id===vsA),b=vsB==="__field"?mkField():cards.find(c=>c.id===vsB);
                  if(!a||!b)return <div style={{textAlign:"center",color:"var(--v2a)",fontSize:10,letterSpacing:2,textTransform:"uppercase",padding:"40px 0"}}>select two cards above to run the matchup</div>;
                  const aWins=STATS.filter(s=>a.stats[s]>b.stats[s]).length;
                  const bWins=STATS.filter(s=>b.stats[s]>a.stats[s]).length;
                  const ta=T(a.OVR),tb=T(b.OVR);
                  const winner=a.OVR>b.OVR?a:b.OVR>a.OVR?b:null;
                  return(
                    <div style={{animation:"fadeUp 0.3s ease"}}>
                      <div style={{display:"flex",gap:20,justifyContent:"center",alignItems:"center",flexWrap:"wrap",marginBottom:28}}>
                        <Card card={withMeta(a)} sz={0.85} onClick={a.id==="__field"?undefined:()=>{setSel(a);setView("profile");}}/>
                        <div style={{textAlign:"center",minWidth:130}}>
                          <div style={{fontFamily:"'Bebas Neue'",fontSize:44,lineHeight:1}}>
                            <span style={{color:ta.acc}}>{a.OVR}</span>
                            <span style={{color:"var(--v333)",margin:"0 8px",fontSize:26}}>:</span>
                            <span style={{color:tb.acc}}>{b.OVR}</span>
                          </div>
                          <div style={{color:"var(--v444)",fontSize:10,letterSpacing:1,marginTop:6,fontFamily:"'Space Mono',monospace"}}>{aWins} – {bWins} on stats</div>
                          <div style={{marginTop:12,fontFamily:"'Bebas Neue'",fontSize:15,letterSpacing:2,color:winner?T(winner.OVR).acc:"var(--v555)"}}>
                            {winner?`${(winner.name!=="Unknown"?winner.name:winner.moniker||"?").split(" ").pop().toUpperCase()} WINS`:"DEAD HEAT"}
                          </div>
                        </div>
                        <Card card={withMeta(b)} sz={0.85} onClick={b.id==="__field"?undefined:()=>{setSel(b);setView("profile");}}/>
                      </div>
                      <div style={{display:"flex",justifyContent:"center",marginBottom:20}}><Radar size={250} sets={[{stats:a.stats,color:ta.acc,fillOpacity:0.13},{stats:b.stats,color:ta.acc===tb.acc?"var(--c-stack)":tb.acc,fillOpacity:0.13}]}/></div>
                      <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"18px 22px",maxWidth:560,margin:"0 auto"}}>
                        {[...STATS.map(st=>({label:st,av:a.stats[st],bv:b.stats[st],color:STAT_INFO[st].color})),{label:"OVR",av:a.OVR,bv:b.OVR,color:"var(--gold)"}].map(r=>(
                          <div key={r.label} style={{display:"grid",gridTemplateColumns:"1fr 52px 1fr",gap:12,alignItems:"center",marginBottom:8,borderTop:r.label==="OVR"?"1px solid var(--b15)":"none",paddingTop:r.label==="OVR"?10:0}}>
                            <div style={{display:"flex",alignItems:"center",gap:8,flexDirection:"row-reverse"}}>
                              <span style={{fontFamily:"'Bebas Neue'",fontSize:15,minWidth:24,textAlign:"left",color:r.av>=r.bv?r.color:"var(--v444)"}}>{r.av}</span>
                              <div style={{flex:1,height:4,background:"var(--v1a)",borderRadius:2,overflow:"hidden",transform:"scaleX(-1)"}}><div style={{width:`${r.av}%`,height:"100%",background:r.color,opacity:r.av>=r.bv?0.9:0.3}}/></div>
                            </div>
                            <span style={{color:"var(--v555)",fontSize:8,letterSpacing:1,textAlign:"center"}}>{r.label}</span>
                            <div style={{display:"flex",alignItems:"center",gap:8}}>
                              <div style={{flex:1,height:4,background:"var(--v1a)",borderRadius:2,overflow:"hidden"}}><div style={{width:`${r.bv}%`,height:"100%",background:r.color,opacity:r.bv>=r.av?0.9:0.3}}/></div>
                              <span style={{fontFamily:"'Bebas Neue'",fontSize:15,minWidth:24,textAlign:"right",color:r.bv>=r.av?r.color:"var(--v444)"}}>{r.bv}</span>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Why the OVR differs — deterministic, straight from the weights */}
                      <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 27%, transparent)",boxShadow:"0 0 16px color-mix(in srgb, var(--gold) 8%, transparent)",borderRadius:8,padding:"18px 22px",maxWidth:560,margin:"14px auto 0"}}>
                        <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:14,letterSpacing:2,marginBottom:8}}>WHAT SEPARATES THEM</div>
                        {(()=>{
                          const WGT={PRES:0.20,PACE:0.15,REACH:0.15,STACK:0.20,RARE:0.05,DEPTH:0.25};
                          const rows=STATS.map(s=>({s,d:a.stats[s]-b.stats[s],c:(a.stats[s]-b.stats[s])*WGT[s]})).filter(r=>r.d!==0).sort((x,y)=>Math.abs(y.c)-Math.abs(x.c));
                          const an=(a.name!=="Unknown"?a.name:a.moniker||"A").split(" ").pop();
                          const bn=(b.name!=="Unknown"?b.name:b.moniker||"B").split(" ").pop();
                          return(
                            <>
                              {rows.length===0&&<div style={{color:"var(--v555)",fontSize:10}}>Identical stat lines — a genuine dead heat.</div>}
                              {rows.map(r=>(
                                <div key={r.s} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 0",borderBottom:"1px solid var(--b14)"}}>
                                  <span style={{color:"var(--v666)",fontSize:9,fontFamily:"'Space Mono',monospace"}}>{r.s} · {r.d>0?an:bn} leads by {Math.abs(r.d)}</span>
                                  <span style={{color:r.c>0?ta.acc:tb.acc,fontFamily:"'Bebas Neue'",fontSize:13}}>{r.c>0?"+":""}{r.c.toFixed(1)} OVR</span>
                                </div>
                              ))}
                              <div style={{color:"var(--v444)",fontSize:8,marginTop:8,lineHeight:1.6}}>Each line is that stat's exact contribution to the OVR gap (stat difference × weight). DEPTH and STACK move the needle most by design; RARE barely can. No hidden modifiers.</div>
                            </>
                          );
                        })()}
                        {a.id!=="__field"&&b.id!=="__field"&&(
                          <div style={{marginTop:12}}>
                            {!vsVerdicts[`${a.id}|${b.id}`]&&<button onClick={()=>genVerdict(a,b)} disabled={vsBusy} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"9px 18px",borderRadius:5,cursor:vsBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase",opacity:vsBusy?0.6:1}}>{vsBusy?"JUDGING…":"GENERATE SCOUT VERDICT"}</button>}
                            {vsVerdicts[`${a.id}|${b.id}`]&&<div>
                              <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Scout Verdict</div>
                              <Rich text={vsVerdicts[`${a.id}|${b.id}`]}/>
                            </div>}
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {view==="settings"&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:560,margin:"0 auto"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:30,letterSpacing:3,color:"var(--gold)",marginBottom:4}}>SETTINGS</div>
            <div style={{color:"var(--v333)",fontSize:9,letterSpacing:2,marginBottom:28,textTransform:"uppercase"}}>defaults are tuned for everyday use — these are the extras</div>
            <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"18px 20px",marginBottom:12}}>
              <div onClick={toggleDebugTiming} style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
                <div style={{width:34,height:18,borderRadius:10,background:debugTiming?"var(--gold)":"var(--v1e)",position:"relative",transition:"background 0.15s",flexShrink:0}}>
                  <div style={{position:"absolute",top:2,left:debugTiming?18:2,width:14,height:14,borderRadius:"50%",background:"#fff",transition:"left 0.15s"}}/>
                </div>
                <div>
                  <div style={{color:debugTiming?"var(--gold)":"var(--v888)",fontSize:11,letterSpacing:1}}>SCAN TIMING TELEMETRY</div>
                  <div style={{color:"var(--v444)",fontSize:9,lineHeight:1.6,marginTop:3}}>Shows your typical scan durations (±σ over your last 30 runs) and slow-run warnings under the progress bar. Debug information — most people only need the progress bar and the seconds counter.</div>
                </div>
              </div>
            </div>
            <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"18px 20px",marginBottom:12}}>
              <div onClick={toggleRoast} style={{display:"flex",alignItems:"center",gap:12,cursor:"pointer"}}>
                <div style={{width:34,height:18,borderRadius:10,background:roastMode?"var(--c-reach)":"var(--v1e)",position:"relative",transition:"background 0.15s",flexShrink:0}}>
                  <div style={{position:"absolute",top:2,left:roastMode?18:2,width:14,height:14,borderRadius:"50%",background:"#fff",transition:"left 0.15s"}}/>
                </div>
                <div>
                  <div style={{color:roastMode?"var(--c-reach)":"var(--v888)",fontSize:11,letterSpacing:1}}>🔥 ROAST MODE DEFAULT</div>
                  <div style={{color:"var(--v444)",fontSize:9,lineHeight:1.6,marginTop:3}}>Roasts are always generated — this controls whether they reveal instantly on new cards or wait behind the REVEAL button.</div>
                </div>
              </div>
            </div>
            <div style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5,lineHeight:1.7}}>Theme lives on the ☀/☾ button in the nav · your collection backup is the ⬇ button · settings are saved on this device.</div>
          </div>
        )}

        {view==="howgood"&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:640,margin:"0 auto"}}>
            <div style={{textAlign:"center",marginBottom:34}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:54,letterSpacing:4,lineHeight:1,background:"linear-gradient(135deg,var(--gold),var(--gold2))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>HOW GOOD IS THIS?</div>
              <div style={{color:"var(--v333)",fontSize:10,letterSpacing:3,marginTop:8,textTransform:"uppercase"}}>paste any linkedin achievement post — get the honest, context-aware read</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:26}}>
              {[{t:"PASTE THE POST",d:"a job announcement, an offer, a result, a launch — text or screenshot, yours or anyone's"},{t:"CONTEXT-AWARE",d:"judged within its own industry's ladder and the person's starting point — never penalised for the field"},{t:"GRADED HONESTLY",d:"S to D grade on the same 1-99 scale as the cards, plus what would make it stronger"}].map(x=>(
                <div key={x.t} style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"14px 14px"}}>
                  <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1.5,marginBottom:5}}>{x.t}</div>
                  <div style={{color:"var(--v555)",fontSize:9,lineHeight:1.6}}>{x.d}</div>
                </div>
              ))}
            </div>
            <div onDragOver={e=>{e.preventDefault();setDrag(true);}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);const f=e.dataTransfer.files?.[0];if(f&&f.type.startsWith("image/")){const rd=new FileReader();rd.onload=ev=>setHgImg({b64:ev.target.result.split(",")[1],type:f.type||"image/png",preview:ev.target.result});rd.readAsDataURL(f);}}} style={{background:drag?"color-mix(in srgb, var(--gold) 3%, transparent)":"var(--s0f)",border:`2px dashed ${drag?"var(--gold)":"color-mix(in srgb, var(--gold) 27%, transparent)"}`,boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 8%, transparent)",borderRadius:10,padding:"20px 22px",marginBottom:14,transition:"all 0.2s"}}>
              <div style={{textAlign:"center",marginBottom:12}}>
                <div style={{color:"color-mix(in srgb, var(--gold) 60%, transparent)",fontSize:11,letterSpacing:1,fontFamily:"'Space Mono',monospace"}}>Ctrl + V anywhere to paste a screenshot of the post</div>
                <div style={{color:"var(--v333)",fontSize:9,letterSpacing:1,marginTop:2}}>or drop an image here · or type / paste the text below</div>
              </div>
              <textarea value={hgText} onChange={e=>setHgText(e.target.value)} onPaste={e=>{const items=e.clipboardData?.items;if(!items)return;for(const it of items){if(it.type.startsWith("image/")){const f=it.getAsFile();const rd=new FileReader();rd.onload=ev=>setHgImg({b64:ev.target.result.split(",")[1],type:f.type||"image/png",preview:ev.target.result});rd.readAsDataURL(f);e.preventDefault();break;}}}} placeholder={"Paste the post text — or paste / upload a screenshot of it…\ne.g. \"Thrilled to announce I'll be joining X as a Y this summer…\""} style={{width:"100%",minHeight:96,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"12px 14px",color:"var(--veee)",fontFamily:"'Space Mono',monospace",fontSize:10,lineHeight:1.7,outline:"none",resize:"vertical",boxSizing:"border-box",marginBottom:10}}/>
              {hgImg&&(
                <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
                  <img src={hgImg.preview} alt="" onClick={()=>openLB([hgImg.preview],0,()=>setHgImg(null))} title="Click to inspect full size" style={{width:64,height:40,objectFit:"cover",borderRadius:3,flexShrink:0,cursor:"pointer"}}/>
                  <span style={{color:"var(--v555)",fontSize:9,flex:1}}>Screenshot attached · click it to inspect</span>
                  <button onClick={()=>setHgImg(null)} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,padding:0}}>remove</button>
                </div>
              )}
              <input value={hgCtx} onChange={e=>setHgCtx(e.target.value)} placeholder="Optional context — who is this person? e.g. first-year at a non-target, career switcher, first in family at uni…" style={{width:"100%",background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"10px 12px",color:"var(--veee)",fontFamily:"'Space Mono',monospace",fontSize:10,outline:"none",boxSizing:"border-box",marginBottom:12}}/>
              <input ref={hgFileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f||!f.type.startsWith("image/"))return;const rd=new FileReader();rd.onload=ev=>setHgImg({b64:ev.target.result.split(",")[1],type:f.type||"image/png",preview:ev.target.result});rd.readAsDataURL(f);e.target.value="";}}/>
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <button onClick={()=>hgFileRef.current?.click()} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"10px 16px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:1,textTransform:"uppercase"}}>+ SCREENSHOT</button>
                <button onClick={rateHowGood} disabled={hgBusy||(!hgText.trim()&&!hgImg)} style={{flex:1,minWidth:160,background:hgBusy||(!hgText.trim()&&!hgImg)?"var(--s11)":"var(--gold)",color:hgBusy||(!hgText.trim()&&!hgImg)?"var(--v444)":"var(--gold-ink)",border:"none",padding:"12px 20px",borderRadius:5,cursor:hgBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:10,fontWeight:700,letterSpacing:3,textTransform:"uppercase"}}>{hgBusy?`RATING… ${elapsed||""}${elapsed?"s":""}`:"HOW GOOD IS IT?"}</button>
                {hgBusy&&<button onClick={cancelActiveCall} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"10px 14px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:1,textTransform:"uppercase"}}>CANCEL</button>}
              </div>
              {hgErr&&<div style={{color:"#ff4444",fontSize:9,letterSpacing:0.5,marginTop:10}}>{hgErr}</div>}
            </div>
            {hgResult&&(()=>{
              const gradeColor={S:"var(--gold)",A:"#99b0ff",B:"#16a34a",C:"var(--v666)",D:"var(--c-reach)"}[hgResult.grade]||"var(--v666)";
              return(
              <div style={{animation:"fadeUp 0.4s ease"}}>
                <div style={{background:"var(--s0f)",border:`1px solid ${A(gradeColor,40)}`,boxShadow:`0 0 24px ${A(gradeColor,13)}`,borderRadius:10,padding:"22px 24px",marginBottom:10}}>
                  <div style={{display:"flex",gap:18,alignItems:"center",flexWrap:"wrap"}}>
                    <div style={{width:74,height:74,borderRadius:12,background:A(gradeColor,13),border:`2px solid ${A(gradeColor,53)}`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:34,color:gradeColor,lineHeight:1}}>{hgResult.grade}</div>
                      <div style={{color:"var(--v444)",fontSize:8,letterSpacing:1,fontFamily:"'Space Mono',monospace"}}>{hgResult.score}/99</div>
                    </div>
                    <div style={{flex:1,minWidth:200}}>
                      <div style={{color:"var(--v888)",lineHeight:1.6,fontFamily:"'Bebas Neue'",letterSpacing:0.5,fontSize:16}}>{hgResult.headline}</div>
                      {hgResult.what_it_is&&<div style={{color:"var(--v555)",fontSize:9,lineHeight:1.6,marginTop:4}}>{hgResult.what_it_is}</div>}
                    </div>
                  </div>
                </div>
                {[
                  {k:"how_good",label:"How good is it, actually"},
                  {k:"context_read",label:"The context read"},
                  {k:"vs_available",label:"Vs what they could have done"},
                  {k:"makes_it_stronger",label:"What would make it stronger"},
                  {k:"caveats",label:"What a post can't tell us"},
                ].filter(s=>hgResult[s.k]).map(s=>(
                  <div key={s.k} style={{background:"var(--s0c)",border:"1px solid var(--b14)",borderRadius:8,padding:"14px 18px",marginBottom:8}}>
                    <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>{s.label}</div>
                    <Rich text={bulletize(hgResult[s.k])}/>
                  </div>
                ))}
                <div style={{background:"var(--s0c)",border:"1px solid var(--b14)",borderRadius:8,padding:"12px 18px",marginBottom:8}}>
                  <div onClick={()=>setHgChatOpen(o=>!o)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer",userSelect:"none"}}>
                    <span style={{color:"var(--v666)",fontSize:8,letterSpacing:2,textTransform:"uppercase"}}>💬 Ask about this achievement</span>
                    <span style={{color:"var(--v444)",fontSize:9}}>{hgChatOpen?"▾":"▸"}</span>
                  </div>
                  {hgChatOpen&&(
                    <div style={{marginTop:12}}>
                      {(hgChat.length>0||hgChatBusy)&&(
                        <div style={{maxHeight:280,overflowY:"auto",marginBottom:10,display:"flex",flexDirection:"column",gap:8}}>
                          {hgChat.map((m,i)=>(
                            <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                              <div style={{maxWidth:"84%",background:m.role==="user"?"color-mix(in srgb, var(--gold) 13%, transparent)":"var(--s11)",border:`1px solid ${m.role==="user"?"color-mix(in srgb, var(--gold) 27%, transparent)":"var(--b15)"}`,borderRadius:10,padding:"9px 13px",color:"var(--v888)",fontSize:10,lineHeight:1.7,textAlign:"left"}}>{m.role==="assistant"?<Rich text={m.content}/>:m.content}</div>
                            </div>
                          ))}
                          {hgChatBusy&&<div style={{color:"var(--v555)",fontSize:9,letterSpacing:1}}>Scout is thinking…</div>}
                        </div>
                      )}
                      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
                        {["Is this actually rare or does it just sound rare?","What would the S-tier version of this be?","How should they leverage this next?"].map(q=>(
                          <button key={q} onClick={()=>sendHgChat(q)} disabled={hgChatBusy} style={{background:"none",border:"1px solid color-mix(in srgb, var(--gold) 22%, transparent)",color:"var(--v666)",padding:"5px 10px",borderRadius:12,cursor:hgChatBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:0.5}}>{q}</button>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:8}}>
                        <input value={hgChatIn} onChange={e=>setHgChatIn(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")sendHgChat();}} placeholder="Ask a follow-up about this achievement…" style={{flex:1,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"10px 12px",color:"var(--veee)",fontFamily:"'Space Mono',monospace",fontSize:10,outline:"none"}}/>
                        <button onClick={()=>sendHgChat()} disabled={hgChatBusy||!hgChatIn.trim()} style={{background:hgChatBusy||!hgChatIn.trim()?"var(--s11)":"var(--gold)",color:hgChatBusy||!hgChatIn.trim()?"var(--v444)":"var(--gold-ink)",border:"none",padding:"10px 18px",borderRadius:6,cursor:hgChatBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>SEND</button>
                      </div>
                    </div>
                  )}
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"center",marginTop:6}}>
                  <button onClick={()=>{setHgResult(null);setHgText("");setHgImg(null);setHgCtx("");setHgChat([]);setHgChatOpen(false);}} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"9px 18px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>RATE ANOTHER</button>
                </div>
              </div>
              );
            })()}
          </div>
        )}

        {view==="profile"&&sel&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:640,margin:"0 auto"}}>
            {showShare&&<ShareCard card={sel} onClose={()=>setShowShare(false)}/>}
            {rsReveal&&(
              <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.9)",zIndex:250,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:24}}>
                <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:20,letterSpacing:3,marginBottom:18}}>RE-SCORE CAME BACK HIGHER</div>
                {!rsReveal.open?(
                  <>
                    <div style={{perspective:900}}>
                      <div onClick={()=>{if(rsFlipping)return;setRsFlipping(true);setTimeout(()=>setRsReveal(r=>r?{...r,open:true}:r),260);}} style={{cursor:"pointer",transform:rsFlipping?"rotateY(90deg)":"rotateY(0deg)",transition:"transform 0.26s ease-in"}}>
                        <CardBack glow={T(sel.OVR).glow}/>
                      </div>
                    </div>
                    <div style={{color:"#bbbbbb",fontSize:9,letterSpacing:2,marginTop:16,textTransform:"uppercase",fontFamily:"'Space Mono',monospace"}}>tap to reveal the upgraded card</div>
                  </>
                ):(
                  <div style={{textAlign:"center"}}>
                    <div style={{perspective:900,display:"flex",justifyContent:"center"}}><div style={{animation:"flipIn 0.26s ease-out"}}><Card card={withMeta(sel)} sz={1}/></div></div>
                    <div style={{marginTop:14,fontFamily:"'Bebas Neue'",fontSize:24,color:"#16a34a",letterSpacing:1}}>▲ {rsReveal.prev} → {sel.OVR}</div>
                    {sel.lastDeltaCause&&<div style={{color:"#cccccc",fontSize:9,marginTop:6,letterSpacing:0.5,fontFamily:"'Space Mono',monospace"}}>{sel.lastDeltaCause}</div>}
                    <button onClick={()=>{setRsReveal(null);setRsFlipping(false);}} style={{marginTop:16,background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"10px 24px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>NICE — CONTINUE</button>
                  </div>
                )}
              </div>
            )}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:28}}>
              <button className="ghost" onClick={()=>{setView("leaderboard");setSel(null);}} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase",padding:0,transition:"color 0.15s"}}>↠BACK</button>
              <div style={{display:"flex",gap:8}}>
                {(myId===sel.id||!myId)&&<button onClick={toggleMine} title={myId===sel.id?"Click to unclaim":"Claim this card as yours — only one card can be yours"} style={{background:myId===sel.id?"var(--gold)":"none",color:myId===sel.id?"var(--gold-ink)":"var(--v444)",border:myId===sel.id?"none":"1px solid var(--v1e)",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>{myId===sel.id?"★ MY CARD":"THIS IS ME?"}</button>}
                <button onClick={()=>setShowShare(true)} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>SHARE CARD</button>
                <button title="Profile changed? Look at it again" onClick={()=>{setUpdating(sel.id);setView("create");reset();setUpdating(sel.id);}} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v444)",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,letterSpacing:1,textTransform:"uppercase",transition:"border-color 0.15s,color 0.15s"}} onMouseEnter={e=>{e.target.style.borderColor="color-mix(in srgb, var(--gold) 33%, transparent)";e.target.style.color="var(--gold)";}} onMouseLeave={e=>{e.target.style.borderColor="var(--v1e)";e.target.style.color="var(--v444)";}}>UPDATE</button>
                <button title="Re-run the scout on this card's stored data — brings new report sections to old cards, no screenshots needed" onClick={rescore} disabled={rescoring} style={{background:"none",border:"1px solid color-mix(in srgb, var(--gold) 27%, transparent)",color:"var(--gold)",padding:"7px 14px",borderRadius:4,cursor:rescoring?"wait":"pointer",fontFamily:"'Space Mono'",fontSize:8,letterSpacing:1,textTransform:"uppercase",opacity:rescoring?0.6:1}}>{rescoring?"RE-SCORING…":"RE-SCORE"}</button>
                <button onClick={()=>{if(confirmDel===sel.id){deleteCard(sel.id);setConfirmDel(null);}else{armDelete(sel.id);}}} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v333)",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,letterSpacing:1,textTransform:"uppercase",transition:"border-color 0.15s,color 0.15s"}} onMouseEnter={e=>{e.target.style.borderColor="#ff444455";e.target.style.color="#ff4444";}} onMouseLeave={e=>{e.target.style.borderColor="var(--v1e)";e.target.style.color="var(--v333)";}}>{confirmDel===sel.id?"CLICK AGAIN TO CONFIRM":"DELETE"}</button>
              </div>
            </div>
            {rsErr&&<div style={{color:"#ff4444",fontSize:9,letterSpacing:0.5,textAlign:"center",marginBottom:8}}>{rsErr}</div>}
            {(sel.rubricV||0)<RUBRIC_VERSION&&!rescoring&&(
              <div style={{background:"var(--warn-bg)",border:"1px solid color-mix(in srgb, var(--c-reach) 33%, transparent)",borderRadius:8,padding:"10px 14px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                <span style={{color:"var(--v777)",fontSize:9,lineHeight:1.6,flex:1,minWidth:220}}>⚠ Scored under an <span style={{color:"var(--c-reach)"}}>older rating system</span> — this OVR isn't directly comparable with freshly scanned cards until it's re-measured.</span>
                <button onClick={rescore} disabled={rescoring} style={{background:"var(--c-reach)",color:"#fff",border:"none",padding:"8px 16px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>RE-SCORE NOW</button>
              </div>
            )}
            {rescoring&&(
              <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"14px 18px",marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                  <span style={{color:"var(--v777)",fontSize:10,letterSpacing:1}}>{STAGES_SCORE[Math.min(stageIdx,STAGES_SCORE.length-1)]}</span>
                  <span style={{display:"flex",alignItems:"center",gap:10}}><span style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:18,lineHeight:1}}>{Math.round(prog)}%</span><span style={{color:"var(--v444)",fontSize:8,fontFamily:"'Space Mono',monospace"}}>{elapsed}s</span><button onClick={cancelActiveCall} title="Kill the in-flight request now — you can retry immediately" style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:1,textTransform:"uppercase"}}>CANCEL</button></span>
                </div>
                <div style={{height:6,background:"var(--v1a)",borderRadius:3,overflow:"hidden"}}><div style={{width:`${prog}%`,height:"100%",background:"linear-gradient(90deg,var(--gold),var(--gold2))",borderRadius:3,transition:"width 0.18s linear"}}/></div>
              </div>
            )}
            {sel.moniker&&<div style={{fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:2,color:ct.acc,marginBottom:4,textAlign:"center",textShadow:`0 0 20px ${ct.acc}44`}}>{sel.moniker}</div>}
            <div style={{display:"flex",gap:24,flexWrap:"wrap",justifyContent:"center",marginBottom:28}}>
              <Card card={withMeta(sel)} sz={1}/>
              <div style={{flex:1,minWidth:200,display:"flex",flexDirection:"column",gap:14}}>
                <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"16px 18px"}}>
                  <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:12,textTransform:"uppercase"}}>Stat Breakdown <span style={{color:"var(--v333)",fontSize:7}}>— hover for definitions · click a stat for its rationale</span></div>
                  <div style={{display:"flex",justifyContent:"center",margin:"4px 0 16px"}}><Radar sets={[{stats:sel.stats,color:ct.acc,fillOpacity:0.16}]} size={200}/></div>
                  {STATS.map(st=>{
                    const v=sel.stats[st];
                    const info=STAT_INFO[st];
                    const hasReason=!!sel.stat_reasons?.[st];
                    const open=!!openStats[st];
                    return(
                      <div key={st} style={{marginBottom:10}}>
                      <div onClick={()=>{if(hasReason)setOpenStats(o=>({...o,[st]:!o[st]}));}} style={{display:"flex",alignItems:"center",gap:8,cursor:hasReason?"pointer":"default"}}>
                        <StatTooltip stat={st} reason={sel.stat_reasons?.[st]}>
                          <span style={{color:"var(--v555)",fontSize:9,minWidth:38,letterSpacing:1,cursor:"help",borderBottom:"1px dotted var(--v333)"}}>{st}</span>
                        </StatTooltip>
                        <div style={{flex:1,height:4,background:"var(--v1a)",borderRadius:2,overflow:"hidden"}}><div style={{width:`${v}%`,height:"100%",background:`linear-gradient(90deg,${A(info?.color||ct.acc,53)},${info?.color||ct.acc})`,borderRadius:2}}/></div>
                        <span style={{color:"var(--vddd)",fontSize:12,fontFamily:"'Bebas Neue'",minWidth:26,textAlign:"right"}}>{v}</span>
                        {(()=>{const ps=sel.history?.[sel.history.length-1];if(!ps?.stats)return null;const d=v-(ps.stats[st]??v);if(!d)return null;return <span style={{color:d>0?"#16a34a":"#dc2626",fontSize:8,minWidth:22,fontFamily:"'Space Mono',monospace"}}>{d>0?`+${d}`:d}</span>;})()}
                        {hasReason&&<span style={{color:open?info.color:"var(--v333)",fontSize:9,width:12,textAlign:"center",flexShrink:0}}>{open?"▾":"▸"}</span>}
                      </div>
                      {hasReason&&open&&<div style={{color:"var(--v555)",fontSize:9,lineHeight:1.55,marginTop:4,marginLeft:46,borderLeft:`2px solid ${A(info.color,33)}`,paddingLeft:8,animation:"fadeUp 0.15s ease"}}>{sel.stat_reasons[st]}</div>}
                      </div>
                    );
                  })}
                </div>
                <div style={{background:"var(--s0f)",border:`1px solid ${ct.acc}55`,boxShadow:`0 0 20px ${ct.acc}22`,borderRadius:8,padding:"16px 18px",textAlign:"center"}}>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:58,color:ct.acc,lineHeight:1,textShadow:`0 0 18px ${ct.acc}55`}}>{sel.OVR}</div>
                  <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:3,textTransform:"uppercase",marginBottom:6}}>OVERALL RATING</div>
                  {sel.archetype&&<div style={{color:ct.acc,fontSize:8,letterSpacing:1,marginBottom:12,opacity:0.7}}>{sel.archetype}</div>}
                  <Bell cards={cards.filter(c=>c.id!==sel.id)} targetOvr={sel.OVR} acc={ct.acc}/>
                  <div style={{color:"var(--v333)",fontSize:9,marginTop:6,letterSpacing:1}}>
                    {cards.length>=30
                      ?`Beta top ${100-(sel.percentile||50)}% · #${sorted.findIndex(c=>c.id===sel.id)+1} of ${cards.length}`
                      :`${T(sel.OVR).label} tier · #${sorted.findIndex(c=>c.id===sel.id)+1} of ${cards.length} analysed`
                    }
                  </div>
                  {cards.length<30&&<div style={{color:"var(--v1e)",fontSize:8,marginTop:4,letterSpacing:0.5}}>percentile unlocks at 30 profiles</div>}
                  {sel.history?.length>0&&(()=>{const ps=sel.history[sel.history.length-1];const d=sel.OVR-ps.OVR;return(
                    <div style={{fontSize:9,marginTop:8,letterSpacing:1,fontFamily:"'Space Mono',monospace",color:d>0?"#16a34a":d<0?"#dc2626":"var(--v444)"}}>{d===0?"unchanged":(d>0?`▲ +${d}`:`▼ ${d}`)} since last scan · {new Date(ps.date).toLocaleDateString()}{sel.lastDeltaCause&&d!==0&&<span style={{display:"block",color:"var(--v444)",fontSize:8,marginTop:3,letterSpacing:0.5}}>why: {sel.lastDeltaCause}</span>}</div>
                  );})()}
                  {(sel.history?.length||0)>0&&<div style={{marginTop:14,display:"flex",justifyContent:"center"}}><Trend card={sel} acc={ct.acc}/></div>}
                </div>

                {/* Confidence score — internal/operational */}
                <div style={{background:"var(--conf-bg)",border:"1px solid var(--conf-dim)",borderRadius:8,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <span style={{color:"var(--conf-label)",fontSize:8,letterSpacing:2,textTransform:"uppercase"}}>Evidence Confidence</span>
                    <span style={{fontFamily:"'Bebas Neue'",fontSize:14,letterSpacing:1,color:sel.confidence==="HIGH"?"#88cc00":sel.confidence==="LOW"?"#cc4400":"#cc8800"}}>{sel.confidence||"MEDIUM"}</span>
                  </div>
                  {sel.confidence_reason?<div style={{color:"var(--conf-dim)",fontSize:9,lineHeight:1.5}}>{sel.confidence_reason}</div>:<div style={{color:"var(--conf-dim)",fontSize:9,lineHeight:1.5,fontStyle:"italic"}}>rationale not on this card — hit RE-SCORE to generate it</div>}
                  <div style={{color:"var(--conf-dim)",fontSize:8,marginTop:4,letterSpacing:0.5}}>⚠ internal — not shown publicly</div>
                </div>

                {sel.sanity&&sel.sanity.length>0&&(
                  <div style={{background:"var(--warn-bg)",border:"1px solid color-mix(in srgb, var(--c-reach) 33%, transparent)",borderRadius:8,padding:"12px 14px"}}>
                    <div style={{color:"var(--c-reach)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>⚠ Sanity Check</div>
                    {sel.sanity.map((s,i)=><div key={i} style={{color:"var(--v666)",fontSize:9,lineHeight:1.6,marginBottom:4}}>· {s}</div>)}
                  </div>
                )}
              </div>
            </div>

            {/* Vs the pool — deterministic comparison against everyone scanned */}
            {cards.length>1&&(()=>{
              const others=cards.filter(c=>c.id!==sel.id);
              const avgS=Object.fromEntries(STATS.map(s=>[s,others.reduce((t,c)=>t+c.stats[s],0)/others.length]));
              const avgO=others.reduce((t,c)=>t+c.OVR,0)/others.length;
              const rankOf=(key,val)=>1+cards.filter(c=>c.id!==sel.id&&(key==="OVR"?c.OVR:c.stats[key])>val).length;
              return(
                <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"18px 20px",marginBottom:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10,marginBottom:12}}>
                    <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>VS THE POOL <span style={{color:"var(--v555)",fontSize:9,fontFamily:"'Space Mono',monospace",letterSpacing:1}}>· ranked against {cards.length-1} other card{cards.length===2?"":"s"}</span></div>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <button onClick={()=>{setVsA(sel.id);setVsB("__field");setView("versus");}} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>FULL MATCHUP VS THE FIELD →</button>
                      <select defaultValue="" onChange={e=>{if(e.target.value){setVsA(sel.id);setVsB(e.target.value);setView("versus");}}} style={{background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:4,padding:"7px 10px",color:"var(--v555)",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:1,cursor:"pointer",outline:"none",textTransform:"uppercase"}}>
                        <option value="">VS A CARD…</option>
                        {sorted.filter(c=>c.id!==sel.id).map(c=><option key={c.id} value={c.id}>{c.name!=="Unknown"?c.name:(c.moniker||"Unknown")} · {c.OVR}</option>)}
                      </select>
                    </div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(118px,1fr))",gap:8}}>
                    {[...STATS.map(st=>({k:st,v:sel.stats[st],a:avgS[st],color:STAT_INFO[st].color})),{k:"OVR",v:sel.OVR,a:avgO,color:"var(--gold)"}].map(r=>{
                      const d=r.v-r.a;
                      const rk=rankOf(r.k,r.v);
                      return(
                        <div key={r.k} style={{background:"var(--s0c)",border:"1px solid var(--b14)",borderRadius:6,padding:"9px 11px"}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline"}}>
                            <span style={{color:r.color,fontSize:8,letterSpacing:1,fontFamily:"'Space Mono',monospace"}}>{r.k}</span>
                            <span style={{fontFamily:"'Bebas Neue'",fontSize:16,color:"var(--vddd)"}}>{r.v}</span>
                          </div>
                          <div style={{display:"flex",justifyContent:"space-between",marginTop:3}}>
                            <span style={{fontSize:8,color:"var(--v444)",fontFamily:"'Space Mono',monospace"}}>pool {r.a.toFixed(0)}</span>
                            <span style={{fontSize:9,fontFamily:"'Space Mono',monospace",color:d>0?"#16a34a":d<0?"#dc2626":"var(--v444)"}}>{d>0?`+${d.toFixed(0)}`:d.toFixed(0)}</span>
                          </div>
                          <div style={{fontSize:8,color:"var(--v444)",marginTop:2,fontFamily:"'Space Mono',monospace"}}>#{rk} of {cards.length}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5,marginTop:10,lineHeight:1.5}}>Green = above pool average, red = below. For the evidence-argued read on any single gap, run the full matchup — the verdict and EVIDENCE TO WATCH live there.</div>
                </div>
              );
            })()}

            {/* Profile type + archetype row */}
            {(sel.profile_type||sel.archetype)&&(
              <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                {sel.profile_type&&<div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:5,padding:"6px 12px",fontSize:9,letterSpacing:1,textTransform:"uppercase",color:"var(--v555)"}}><span style={{color:"var(--v2a)",marginRight:6}}>TYPE</span>{sel.profile_type}</div>}
                {sel.archetype&&<div style={{background:"var(--s0f)",border:`1px solid ${ct.acc}22`,borderRadius:5,padding:"6px 12px",fontSize:9,letterSpacing:1,textTransform:"uppercase",color:ct.acc,opacity:0.7}}><span style={{color:"var(--v2a)",marginRight:6}}>BUILD</span>{sel.archetype}</div>}
                {sel.archetype_mix&&sel.archetype_mix.length>1&&(
                  <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:5,padding:"6px 12px",fontSize:9,letterSpacing:1,textTransform:"uppercase",color:"var(--v555)"}}>
                    <span style={{color:"var(--v2a)",marginRight:6}}>MIX</span>
                    {sel.archetype_mix.map((m,i)=><span key={i}>{i>0&&" · "}<span style={{color:"var(--gold)"}}>{m.weight}%</span> {m.build}</span>)}
                  </div>
                )}
              </div>
            )}

            {sel.type_reason&&<div style={{color:"var(--v555)",fontSize:9,lineHeight:1.6,margin:"-2px 0 10px",paddingLeft:2}}>{sel.type_reason}</div>}

            {/* Aspiration vs the mirror — claimed card only */}
            {myId===sel.id&&(
              <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"14px 18px",marginBottom:10}}>
                <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Aspiration vs the mirror <span style={{color:"var(--v333)",textTransform:"none",letterSpacing:0.5}}>— how you want to be seen vs how the scout reads you</span></div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  <select value={sel.asp_type||""} onChange={e=>saveAsp("asp_type",e.target.value)} style={{background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:5,padding:"8px 10px",color:sel.asp_type?"var(--vddd)":"var(--v444)",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:0.5,cursor:"pointer",outline:"none"}}>
                    <option value="">— aspirational type —</option>
                    {PROFILE_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
                  </select>
                  <select value={sel.asp_build||""} onChange={e=>saveAsp("asp_build",e.target.value)} style={{background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:5,padding:"8px 10px",color:sel.asp_build?"var(--vddd)":"var(--v444)",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:0.5,cursor:"pointer",outline:"none"}}>
                    <option value="">— aspirational build —</option>
                    {ARCHETYPES.map(t=><option key={t} value={t}>{t}</option>)}
                  </select>
                </div>
                {(sel.asp_type||sel.asp_build)&&(()=>{
                  const typeMatch=!sel.asp_type||sel.asp_type===sel.profile_type;
                  const buildMatch=!sel.asp_build||sel.asp_build===sel.archetype||(sel.archetype_mix||[]).some(m=>m.build===sel.asp_build);
                  return(
                    <div style={{marginTop:10,color:"var(--v555)",fontSize:9,lineHeight:1.75}}>
                      {typeMatch&&buildMatch
                        ?<span style={{color:"#16a34a"}}>The mirror agrees — the scout already reads you as what you're aiming to be. Now it's about climbing within the build.</span>
                        :<>
                          You aim to read as <span style={{color:"var(--gold)"}}>{[sel.asp_type,sel.asp_build].filter(Boolean).join(" · ")}</span>; the scout currently reads <span style={{color:ct.acc}}>{[sel.profile_type,sel.archetype].filter(Boolean).join(" · ")}</span>.
                          <button onClick={()=>sendChat(`My aspirational identity is ${[sel.asp_type,sel.asp_build].filter(Boolean).join(" / ")} but you read me as ${[sel.profile_type,sel.archetype].filter(Boolean).join(" / ")}. What specific evidence would make my profile read as my aspiration — and what's the fastest first move?`)} disabled={chatBusy} style={{display:"block",marginTop:8,background:"none",border:"1px solid color-mix(in srgb, var(--gold) 27%, transparent)",color:"var(--gold)",padding:"6px 12px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:1,textTransform:"uppercase"}}>ASK THE SCOUT WHAT CLOSES THE GAP ↓</button>
                        </>}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Profile thesis */}
            {sel.thesis&&(
              <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"18px 20px",marginBottom:10}}>
                <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:10,textTransform:"uppercase"}}>Profile Thesis</div>
                <div style={{color:"var(--v888)",fontSize:12,lineHeight:1.85}}>{sel.thesis}</div>
              </div>
            )}

            {/* Roast */}
            {sel.roast&&(
              <div style={{background:"var(--warn-bg)",border:"1px solid color-mix(in srgb, var(--c-reach) 33%, transparent)",borderRadius:8,padding:"18px 20px",marginBottom:10}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{color:"var(--c-reach)",fontSize:8,letterSpacing:2,textTransform:"uppercase"}}>🔥 The Roast</div>
                  {!(roastOpen||roastMode)&&<button onClick={()=>setRoastOpen(true)} style={{background:"var(--c-reach)",color:"#fff",border:"none",padding:"6px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>REVEAL</button>}
                </div>
                {(roastOpen||roastMode)&&<div style={{color:"var(--v777)",fontSize:12,lineHeight:1.85,marginTop:10}}>{sel.roast}</div>}
              </div>
            )}

            {/* Deep dive — the full scouting rationale, collapsed by default */}
            <div style={{background:"var(--s0f)",border:`1px solid ${deepDive?"color-mix(in srgb, var(--gold) 33%, transparent)":"var(--b15)"}`,boxShadow:deepDive?"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)":"none",borderRadius:8,marginBottom:10}}>
              <div onClick={()=>setDeepDive(d=>!d)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"15px 18px",cursor:"pointer",userSelect:"none"}}>
                <div><span style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>DEEP DIVE ANALYSIS</span><span style={{color:"var(--v555)",fontSize:9,marginLeft:10,fontFamily:"'Space Mono',monospace",letterSpacing:0.5}}>· the full rationale behind the numbers</span></div>
                <span style={{color:"var(--v444)",fontSize:11}}>{deepDive?"▾":"▸"}</span>
              </div>
            {deepDive&&(
              <div style={{padding:"0 10px 12px"}}>
              <div style={{display:"grid",gridTemplateColumns:"1fr",gap:8,marginBottom:10}}>
                {[
                  {k:"best_signal",label:"Best Signal",icon:"◈",v:sel.best_signal},
                  {k:"weak_signal",label:"Weakest Signal",icon:"◇",v:sel.weak_signal},
                  {k:"traits",label:"What This Signals",icon:"◉",v:sel.traits},
                  {k:"not_proven",label:"What It Does Not Prove",icon:"✕",v:sel.not_proven},
                  {k:"larp_check",label:"LARP Check — verified vs claimed",icon:"⚖",v:sel.larp_check},
                  {k:"smurf_check",label:"Smurf Check — signs of understatement",icon:"◒",v:sel.smurf_check},
                  {k:"peer_calibration",label:"Peer Calibration — your standing, from your exact peers out to everyone",icon:"⊕",v:sel.peer_calibration},
                  {k:"opportunity_capture",label:"Opportunity Capture — what they took vs what was available",icon:"◎",v:sel.opportunity_capture},
                  {k:"projected_roles",label:"Projected Placements — where the scout sees them landing",icon:"➤",v:sel.projected_roles},
                  {k:"floor",label:sel.floor_ovr?`Floor · ≈ OVR ${sel.floor_ovr} (hypothetical)`:"Floor",icon:"▼",v:sel.floor},
                  {k:"base_case",label:sel.base_ovr?`Base Case · ≈ OVR ${sel.base_ovr} (hypothetical)`:"Base Case",icon:"◆",v:sel.base_case},
                  {k:"ceiling",label:sel.ceiling_ovr?`Ceiling · ≈ OVR ${sel.ceiling_ovr} (hypothetical)`:"Ceiling",icon:"▲",v:sel.ceiling},
                  {k:"upgrade",label:"Fastest Upgrade",icon:"↑",v:sel.upgrade},
                  {k:"improvement_plan",label:"Improvement Plan — ranked by OVR impact",icon:"⇧",v:sel.improvement_plan},
                  {k:"tier_path",label:"Breaking Into The Higher Tiers",icon:"⌁",v:sel.tier_path},
                ].map(s=>{
                  const open=!!openSecs[s.k];
                  return(
                  <div key={s.k} style={{background:"var(--s0c)",border:`1px solid ${open?"color-mix(in srgb, var(--gold) 22%, transparent)":"var(--b14)"}`,borderRadius:8,padding:"12px 18px"}}>
                    <div onClick={()=>setOpenSecs(o=>({...o,[s.k]:!o[s.k]}))} style={{display:"flex",gap:10,alignItems:"center",cursor:"pointer",userSelect:"none"}}>
                      <span style={{color:ct.acc,fontSize:10,flexShrink:0,width:12}}>{s.icon}</span>
                      <div style={{color:s.v?"var(--v666)":"var(--v333)",fontSize:8,letterSpacing:2,textTransform:"uppercase",flex:1}}>{s.label}{!s.v&&<span style={{marginLeft:6,color:"var(--v2a)",textTransform:"none",letterSpacing:0.5}}>· needs re-score</span>}</div>
                      <span style={{color:"var(--v444)",fontSize:9}}>{open?"▾":"▸"}</span>
                    </div>
                    {open&&(
                      <div style={{marginTop:10,marginLeft:22}}>
                        {s.v?<Rich text={bulletize(s.v)}/>:<div style={{color:"var(--v333)",fontSize:10,lineHeight:1.6,fontStyle:"italic"}}>Not on this card yet — this card was scored by an older scout. Hit RE-SCORE (top right) and it generates from the stored data, no screenshots needed.</div>}
                      </div>
                    )}
                  </div>
                );})}
              </div>

            {/* Ceiling references — real pool cards near the hypothetical ceiling */}
            {(()=>{
              const target=sel.ceiling_ovr||Math.min(99,sel.OVR+12);
              const refs=sorted.filter(c=>c.id!==sel.id&&c.OVR>sel.OVR&&c.OVR>=target-4).slice(0,3);
              const jump=r=>{setSel(r);try{window.scrollTo({top:0,behavior:"smooth"});}catch{}};
              return(
                <div style={{background:"var(--s0c)",border:"1px solid var(--b14)",borderRadius:8,padding:"14px 18px",marginBottom:10}}>
                  <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:8}}>Ceiling References · real cards from your pool near ≈ OVR {target}</div>
                  {refs.length===0
                    ?<div style={{color:"var(--v555)",fontSize:10,lineHeight:1.7}}>No pool profiles near this ceiling yet — scan stronger profiles to build a real ceiling library. The pool IS the benchmark: every card you add turns floors and ceilings from theory into named examples.</div>
                    :refs.map(r=>{
                      const note=sel.ref_notes?.[r.id];
                      const open=refOpen===r.id;
                      return(
                      <div key={r.id} style={{borderTop:"1px solid var(--b14)"}}>
                        <div onClick={()=>setRefOpen(open?null:r.id)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",cursor:"pointer"}}>
                          <span style={{color:"var(--v888)",fontSize:10}}><span style={{color:"var(--v444)",marginRight:6}}>{open?"▾":"▸"}</span>{r.name!=="Unknown"?r.name:(r.moniker||"Unknown")} <span style={{color:"var(--v444)",fontSize:9}}>· {r.company} · {r.archetype||r.profile_type||""}</span></span>
                          <span style={{fontFamily:"'Bebas Neue'",fontSize:16,color:T(r.OVR).acc}}>{r.OVR}</span>
                        </div>
                        {open&&(
                          <div style={{padding:"0 0 12px 16px"}}>
                            {note
                              ?<div style={{color:"var(--v777)",fontSize:10,lineHeight:1.75,marginBottom:8,borderLeft:"2px solid color-mix(in srgb, var(--gold) 33%, transparent)",paddingLeft:10}}><Rich text={note.text}/></div>
                              :<button onClick={()=>genRefWhy(r)} disabled={refBusy} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"8px 14px",borderRadius:4,cursor:refBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase",marginBottom:8,opacity:refBusy?0.6:1}}>{refBusy?"ANALYSING…":"WHY THIS REFERENCE?"}</button>}
                            {refErr&&<div style={{color:"#ff4444",fontSize:9,marginBottom:8}}>{refErr}</div>}
                            <button onClick={()=>jump(r)} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"7px 12px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:1,textTransform:"uppercase"}}>OPEN THEIR CARD →</button>
                          </div>
                        )}
                      </div>
                    );})}
                  {refs.length>0&&<div style={{color:"var(--v444)",fontSize:8,marginTop:8,lineHeight:1.5}}>Real scanned cards near this profile's hypothetical ceiling — study their evidence, timeline and stat shape to see what separates them from this card.</div>}
                </div>
              );
            })()}
              </div>
            )}
            </div>

            {/* Profile details */}
            <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"18px 20px"}}>
              <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:14,textTransform:"uppercase"}}>Profile Details</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[{l:"University",v:sel.uni},{l:"University Years",v:sel.uni_years&&sel.uni_years!=="Not visible"?sel.uni_years:"—"},{l:"Company",v:sel.company},{l:"Role",v:sel.role},{l:"Age",v:sel.age},{l:"Cohort",v:sel.year||"—"},{l:"How Secured",v:sel.how},{l:"Prior Internships",v:sel.prev},{l:"Card Generated",v:sel.createdAt?new Date(sel.createdAt).toLocaleDateString():"—"},{l:"Last Rescan",v:sel.updatedAt?new Date(sel.updatedAt).toLocaleDateString():"—"}].map(d=>(
                  <div key={d.l}><div style={{color:"var(--v2a)",fontSize:8,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>{d.l}</div><div style={{color:"var(--v888)",fontSize:11}}>{d.v}</div></div>
                ))}
              </div>
              {sel.acts&&sel.acts!=="None"&&<div style={{marginTop:12,borderTop:"1px solid var(--b14)",paddingTop:12}}><div style={{color:"var(--v2a)",fontSize:8,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Activities</div><div style={{color:"var(--v555)",fontSize:10,lineHeight:1.6}}>{sel.acts}</div></div>}
            </div>

            {/* Benchmark index — only on the claimed card */}
            {myId===sel.id&&(
              <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"18px 20px",marginTop:10}}>
                <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:4}}>BENCHMARK INDEX</div>
                <div style={{color:"var(--v555)",fontSize:9,letterSpacing:0.5,marginBottom:12}}>Pin reference profiles and track each gap over time. Rescan cards and the index shows whether every gap is closing or widening.</div>
                <select defaultValue="" onChange={e=>{if(e.target.value){setBenchList([...benchIds,e.target.value]);e.target.value="";}}} style={{width:"100%",background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"9px 12px",color:"var(--vddd)",fontFamily:"'Space Mono',monospace",fontSize:10,outline:"none",marginBottom:10,cursor:"pointer"}}>
                  <option value="">— pin a benchmark profile —</option>
                  {sorted.filter(c=>c.id!==sel.id&&!benchIds.includes(c.id)).map(c=><option key={c.id} value={c.id}>{c.name!=="Unknown"?c.name:(c.moniker||"Unknown")} · OVR {c.OVR}</option>)}
                </select>
                {benchIds.length===0&&<div style={{color:"var(--v444)",fontSize:9}}>No benchmarks pinned yet — pin the profiles you measure yourself against.</div>}
                {benchIds.map(id=>{
                  const b=cards.find(c=>c.id===id);
                  if(!b)return null;
                  const gap=b.OVR-sel.OVR;
                  const pm=sel.history?.length?sel.history[sel.history.length-1].OVR:null;
                  const pb=b.history?.length?b.history[b.history.length-1].OVR:null;
                  const move=(pm!==null&&pb!==null)?gap-(pb-pm):null;
                  return(
                    <div key={id} style={{borderTop:"1px solid var(--b14)",padding:"10px 0"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:6}}>
                        <div style={{cursor:"pointer"}} onClick={()=>{setSel(b);try{window.scrollTo({top:0,behavior:"smooth"});}catch{}}}>
                          <span style={{color:"var(--vddd)",fontFamily:"'Bebas Neue'",fontSize:14,letterSpacing:1}}>{b.name!=="Unknown"?b.name:(b.moniker||"Unknown")}</span>
                          <span style={{color:"var(--v444)",fontSize:9,marginLeft:8}}>{b.company} · OVR {b.OVR}</span>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <span style={{fontFamily:"'Bebas Neue'",fontSize:16,color:gap>0?"var(--c-reach)":gap<0?"#16a34a":"var(--v555)"}}>{gap>0?`-${gap}`:gap<0?`+${-gap}`:"LEVEL"}</span>
                          {move!==null&&move!==0&&<span style={{fontSize:8,color:move>0?"#dc2626":"#16a34a",fontFamily:"'Space Mono',monospace"}}>{move>0?`gap widened +${move}`:`gap closed ${-move}`}</span>}
                          <button onClick={()=>genVerdict(sel,b)} disabled={vsBusy} style={{background:"none",border:"1px solid color-mix(in srgb, var(--gold) 27%, transparent)",color:"var(--gold)",padding:"4px 10px",borderRadius:4,cursor:vsBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:1,textTransform:"uppercase"}}>{vsBusy?"…":"ANALYSE GAP"}</button>
                          <button onClick={()=>setBenchList(benchIds.filter(x=>x!==id))} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,padding:0}}>✕</button>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:10,flexWrap:"wrap",marginTop:6}}>
                        {STATS.map(s=>{const d=b.stats[s]-sel.stats[s];return <span key={s} style={{fontSize:8,color:"var(--v555)",fontFamily:"'Space Mono',monospace"}}>{s} <span style={{color:d>0?"var(--c-reach)":d<0?"#16a34a":"var(--v444)"}}>{d>0?`-${d}`:d<0?`+${-d}`:"="}</span></span>;})}
                      </div>
                      {vsVerdicts[`${sel.id}|${b.id}`]&&<div style={{marginTop:8,color:"var(--v666)",fontSize:10,lineHeight:1.75,whiteSpace:"pre-wrap",borderLeft:"2px solid color-mix(in srgb, var(--gold) 33%, transparent)",paddingLeft:10}}><Rich text={vsVerdicts[`${sel.id}|${b.id}`]}/></div>}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Signal plan — dynamic, deadline-aware checklist (claimed card only) */}
            {myId===sel.id&&(
              <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"18px 20px",marginTop:10}}>
                <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:4}}>SIGNAL PLAN <span style={{color:"var(--v555)",fontSize:9,fontFamily:"'Space Mono',monospace",letterSpacing:1}}>· time-aware · checkable</span></div>
                <div style={{color:"var(--v555)",fontSize:9,letterSpacing:0.5,marginBottom:10,lineHeight:1.6}}>Tell the scout where you're aiming, generate a plan, then tick items ✓ done or ✕ not eligible. Refresh builds on what's done and never re-proposes dead windows — the plan knows today's date.</div>
                <textarea key={sel.id} ref={goalsRef} defaultValue={sel.goals||""} placeholder="Your goals — e.g. growth role at a high-traction startup by summer 2027; build j5studies to 100K…" style={{width:"100%",minHeight:56,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"10px 12px",color:"var(--veee)",fontFamily:"'Space Mono',monospace",fontSize:10,lineHeight:1.6,outline:"none",resize:"vertical",boxSizing:"border-box",marginBottom:10}}/>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                  <button onClick={genPlan} disabled={planBusy} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"9px 18px",borderRadius:5,cursor:planBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase",opacity:planBusy?0.6:1}}>{planBusy?"PLANNING…":(sel.plan?"REFRESH PLAN":"GENERATE PLAN")}</button>
                  {planErr&&<span style={{color:"#ff4444",fontSize:9,letterSpacing:0.5}}>{planErr}</span>}
                </div>
                {(sel.plan?.items||[]).map((it,i)=>(
                  <div key={i} style={{borderTop:"1px solid var(--b14)",padding:"10px 0",opacity:it.status==="na"?0.45:1}}>
                    <div style={{display:"flex",justifyContent:"space-between",gap:10,alignItems:"flex-start"}}>
                      <div>
                        <div style={{color:it.status==="done"?"#16a34a":"var(--vaaa)",fontSize:11,textDecoration:it.status==="na"?"line-through":"none"}}>{it.status==="done"?"✓ ":""}{it.t} <span style={{color:STAT_INFO[it.stat]?.color||"var(--v555)",fontSize:8,marginLeft:6,letterSpacing:1}}>{it.stat}</span></div>
                        <div style={{color:"var(--v555)",fontSize:10,lineHeight:1.65,marginTop:3,textDecoration:it.status==="na"?"line-through":"none"}}>{it.d}</div>
                      </div>
                      <div style={{display:"flex",gap:6,flexShrink:0}}>
                        <button onClick={()=>setPlanStatus(i,"done")} title="Mark done (click again to undo)" style={{background:it.status==="done"?"#16a34a":"none",color:it.status==="done"?"#fff":"var(--v444)",border:"1px solid "+(it.status==="done"?"#16a34a":"var(--v1e)"),borderRadius:4,padding:"4px 9px",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9}}>✓</button>
                        <button onClick={()=>setPlanStatus(i,"na")} title="Not eligible / window passed (click again to undo)" style={{background:it.status==="na"?"var(--v333)":"none",color:it.status==="na"?"var(--bg)":"var(--v444)",border:"1px solid var(--v1e)",borderRadius:4,padding:"4px 9px",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9}}>✕</button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* 90 OVR projection — hypothetical upgraded card */}
            <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"18px 20px",marginTop:10}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:10}}>
                <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2}}>MAX PROJECTION <span style={{color:"var(--v555)",fontSize:9,fontFamily:"'Space Mono',monospace",letterSpacing:1}}>· HYPOTHETICAL</span></div>
                <button onClick={genNinety} disabled={ninetyBusy} style={{background:sel.ninety?"none":"var(--gold)",color:sel.ninety?"var(--v555)":"var(--gold-ink)",border:sel.ninety?"1px solid var(--v1e)":"none",padding:"8px 16px",borderRadius:4,cursor:ninetyBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase",opacity:ninetyBusy?0.6:1}}>{ninetyBusy?"PROJECTING…":sel.ninety?"REGENERATE":"GENERATE MAX VERSION"}</button>
              </div>
              {ninetyErr&&<div style={{color:"#ff4444",fontSize:9,letterSpacing:0.5,marginTop:8}}>{ninetyErr}</div>}
              {!sel.ninety&&!ninetyBusy&&<div style={{color:"var(--v555)",fontSize:10,lineHeight:1.7,marginTop:10}}>See the elite-tier version of this exact profile — same lane, same thesis, upgraded through concrete verifiable jumps only. Like a 69-rated player's 90-rated future card, and clearly labelled as a projection, not a measurement.</div>}
              {sel.ninety&&(
                <div style={{marginTop:16}}>
                <div style={{display:"flex",gap:20,flexWrap:"wrap"}}>
                  <Card card={withMeta({...sel,stats:sel.ninety.stats,OVR:sel.ninety.OVR,archetype:"HYPOTHETICAL · MAX CLASS"})} sz={0.8}/>
                  <div style={{flex:1,minWidth:220}}>
                    <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>What the max looks like</div>
                    <div style={{marginBottom:12}}><Rich text={sel.ninety.summary}/></div>
                    <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>The jumps required</div>
                    <div style={{marginBottom:10}}><Rich text={sel.ninety.moves}/></div>
                    <div style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5}}>Hypothetical projection generated {new Date(sel.ninety.at).toLocaleDateString()} — evidence-based jumps, not a promise.</div>
                  </div>
                </div>
                {/* Per-stat current → max breakdown, specific to this person */}
                <div style={{marginTop:16,background:"var(--s0c)",border:"1px solid var(--b14)",borderRadius:8,padding:"14px 16px"}}>
                  <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:10}}>Stat by stat — current → max{!sel.ninety.stat_moves&&<span style={{marginLeft:8,color:"var(--v333)",textTransform:"none",letterSpacing:0.5}}>· hit REGENERATE for the per-stat route</span>}</div>
                  {STATS.map(st=>{
                    const cur=sel.stats[st],mx=sel.ninety.stats[st],d=mx-cur;
                    const info=STAT_INFO[st];
                    return(
                      <div key={st} style={{borderBottom:"1px solid var(--b14)",padding:"7px 0"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          <span style={{color:info.color,fontSize:8,letterSpacing:1,minWidth:40,fontFamily:"'Space Mono',monospace"}}>{st}</span>
                          <span style={{fontFamily:"'Bebas Neue'",fontSize:14,color:"var(--v666)"}}>{cur}</span>
                          <span style={{color:"var(--v333)",fontSize:10}}>→</span>
                          <span style={{fontFamily:"'Bebas Neue'",fontSize:14,color:info.color}}>{mx}</span>
                          <span style={{fontSize:9,fontFamily:"'Space Mono',monospace",color:d>0?"#16a34a":"var(--v444)"}}>{d>0?`+${d}`:d===0?"held":d}</span>
                        </div>
                        {sel.ninety.stat_moves?.[st]&&<div style={{color:"var(--v555)",fontSize:9,lineHeight:1.55,marginTop:3,marginLeft:50}}>{sel.ninety.stat_moves[st]}</div>}
                      </div>
                    );
                  })}
                </div>
                {/* Milestone timeline with ETAs */}
                {sel.ninety.milestones&&sel.ninety.milestones.length>0&&(
                  <div style={{marginTop:12,background:"var(--s0c)",border:"1px solid var(--b14)",borderRadius:8,padding:"14px 16px"}}>
                    <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:10}}>The catch-up route — milestones & estimated arrival</div>
                    {sel.ninety.milestones.map((m,i)=>(
                      <div key={i} style={{display:"flex",gap:12,alignItems:"flex-start",padding:"7px 0",borderBottom:i<sel.ninety.milestones.length-1?"1px solid var(--b14)":"none"}}>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center",flexShrink:0}}>
                          <div style={{width:22,height:22,borderRadius:"50%",background:A("var(--gold)",13),border:"1px solid "+A("var(--gold)",33),display:"flex",alignItems:"center",justifyContent:"center",color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:11}}>{i+1}</div>
                        </div>
                        <div style={{flex:1}}>
                          <div style={{color:"var(--v888)",fontSize:10,lineHeight:1.6}}>{m.m}</div>
                        </div>
                        {m.eta&&<div style={{flexShrink:0,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:4,padding:"3px 9px",color:"var(--gold)",fontSize:8,letterSpacing:1,fontFamily:"'Space Mono',monospace",textTransform:"uppercase"}}>ETA {m.eta}</div>}
                      </div>
                    ))}
                    {sel.ninety.milestones[sel.ninety.milestones.length-1]?.eta&&<div style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5,marginTop:8}}>Estimated arrival at the full max projection: <span style={{color:"var(--gold)"}}>{sel.ninety.milestones[sel.ninety.milestones.length-1].eta}</span> — if every milestone lands on time. Projection, not promise.</div>}
                  </div>
                )}
                </div>
              )}
            </div>

            {/* Scout chat */}
            <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"18px 20px",marginTop:10}}>
              <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:4}}>SCOUT CHAT</div>
              <div style={{color:"var(--v555)",fontSize:9,letterSpacing:0.5,marginBottom:12}}>Ask about the rating, the ceiling, or what to do next — answers stay evidence-based and hypotheticals are labelled.</div>
              {((sel.chat||[]).length>0||chatBusy)&&(
                <div style={{maxHeight:340,overflowY:"auto",marginBottom:12,display:"flex",flexDirection:"column",gap:8}}>
                  {(sel.chat||[]).map((m,i)=>(
                    <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start"}}>
                      <div style={{maxWidth:"84%",background:m.role==="user"?"color-mix(in srgb, var(--gold) 13%, transparent)":"var(--s11)",border:`1px solid ${m.role==="user"?"color-mix(in srgb, var(--gold) 27%, transparent)":"var(--b15)"}`,borderRadius:10,padding:"10px 14px",color:"var(--v888)",fontSize:11,lineHeight:1.7,textAlign:"left",whiteSpace:"pre-wrap"}}>{m.role==="assistant"?<Rich text={m.content}/>:m.content}</div>
                    </div>
                  ))}
                  {chatBusy&&<div style={{color:"var(--v555)",fontSize:9,letterSpacing:1}}>Scout is thinking…</div>}
                </div>
              )}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
                {["Why is this profile not rated higher?","What's the strongest case against this rating?","What's the fastest realistic +5 OVR?","Is anything here likely overstated — or understated?"].map(q=>(
                  <button key={q} onClick={()=>sendChat(q)} disabled={chatBusy} style={{background:"none",border:"1px solid color-mix(in srgb, var(--gold) 22%, transparent)",color:"var(--v666)",padding:"6px 10px",borderRadius:12,cursor:chatBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:8,letterSpacing:0.5}}>{q}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:8}}>
                <input value={chatIn} onChange={e=>setChatIn(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")sendChat();}} placeholder="e.g. What's realistically holding the OVR back?" style={{flex:1,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"11px 14px",color:"var(--veee)",fontFamily:"'Space Mono',monospace",fontSize:10,outline:"none"}}/>
                <button onClick={()=>sendChat()} disabled={chatBusy||!chatIn.trim()} style={{background:chatBusy||!chatIn.trim()?"var(--s11)":"var(--gold)",color:chatBusy||!chatIn.trim()?"var(--v444)":"var(--gold-ink)",border:"none",padding:"11px 20px",borderRadius:6,cursor:chatBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>SEND</button>
              </div>
            </div>

            {/* Post signal — a LinkedIn post as a directional telegraph */}
            <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"18px 20px",marginTop:10}}>
              <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:4}}>POST SIGNAL</div>
              <div style={{color:"var(--v555)",fontSize:9,letterSpacing:0.5,marginBottom:10,lineHeight:1.6}}>Paste one of this person's LinkedIn posts — the scout reads it as a telegraph of direction and checks it against the card's thesis.</div>
              <textarea value={postIn} onChange={e=>setPostIn(e.target.value)} onPaste={e=>{const items=e.clipboardData?.items;if(!items)return;for(const it of items){if(it.type.startsWith("image/")){const f=it.getAsFile();const rd=new FileReader();rd.onload=ev=>setPostImg({b64:ev.target.result.split(",")[1],type:f.type||"image/png",preview:ev.target.result});rd.readAsDataURL(f);e.preventDefault();break;}}}} placeholder="Paste the post text — or paste / upload a screenshot of it…" style={{width:"100%",minHeight:64,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"10px 12px",color:"var(--veee)",fontFamily:"'Space Mono',monospace",fontSize:10,lineHeight:1.6,outline:"none",resize:"vertical",boxSizing:"border-box",marginBottom:10}}/>
              {postImg&&(
                <div style={{display:"flex",alignItems:"center",gap:10,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"8px 12px",marginBottom:10}}>
                  <img src={postImg.preview} alt="" onClick={()=>openLB([postImg.preview],0,()=>setPostImg(null))} title="Click to inspect full size" style={{width:64,height:40,objectFit:"cover",borderRadius:3,flexShrink:0,cursor:"pointer"}}/>
                  <span style={{color:"var(--v555)",fontSize:9,flex:1}}>Screenshot attached</span>
                  <button onClick={()=>setPostImg(null)} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,padding:0}}>remove</button>
                </div>
              )}
              <input ref={postFileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>{const f=e.target.files?.[0];if(!f||!f.type.startsWith("image/"))return;const rd=new FileReader();rd.onload=ev=>setPostImg({b64:ev.target.result.split(",")[1],type:f.type||"image/png",preview:ev.target.result});rd.readAsDataURL(f);e.target.value="";}}/>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <button onClick={()=>postFileRef.current?.click()} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v555)",padding:"9px 14px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:1,textTransform:"uppercase"}}>+ SCREENSHOT</button>
                <button onClick={analysePost} disabled={postBusy||(!postIn.trim()&&!postImg)} style={{background:postBusy||(!postIn.trim()&&!postImg)?"var(--s11)":"var(--gold)",color:postBusy||(!postIn.trim()&&!postImg)?"var(--v444)":"var(--gold-ink)",border:"none",padding:"9px 18px",borderRadius:5,cursor:postBusy?"wait":"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>{postBusy?"READING…":"ANALYSE POST"}</button>
                {postErr&&<span style={{color:"#ff4444",fontSize:9,letterSpacing:0.5}}>{postErr}</span>}
              </div>
              {(sel.posts||[]).map((p,i)=>(
                <div key={i} style={{borderTop:"1px solid var(--b14)",padding:"10px 0",marginTop:i===0?12:0}}>
                  <div style={{color:"var(--v444)",fontSize:9,fontStyle:"italic",lineHeight:1.5,marginBottom:5}}>"{p.snippet}…" · {new Date(p.at).toLocaleDateString()}</div>
                  <Rich text={p.insight}/>
                </div>
              ))}
            </div>
          </div>
        )}

        {view==="changelog"&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:660,margin:"0 auto"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:30,letterSpacing:3,color:"var(--gold)",marginBottom:4}}>CHANGELOG</div>
            <div style={{color:"var(--v333)",fontSize:9,letterSpacing:2,marginBottom:14,textTransform:"uppercase"}}>every change shipped to career signal</div>
            <div style={{background:"var(--warn-bg)",border:"1px solid color-mix(in srgb, var(--c-reach) 27%, transparent)",borderRadius:8,padding:"12px 16px",marginBottom:20}}>
              <div style={{color:"var(--v666)",fontSize:9,lineHeight:1.7}}>Your cards live in this artifact's storage. Before pasting a new version of the app, hit <span style={{color:"var(--c-reach)"}}>EXPORT</span> on the leaderboard — then <span style={{color:"var(--c-reach)"}}>IMPORT</span> the file in the new version and nothing is lost.</div>
            </div>
            {CHANGELOG.map(v=>(
              <div key={v.tag} style={{background:"var(--s0c)",border:"1px solid color-mix(in srgb, var(--gold) 20%, transparent)",borderRadius:8,padding:"18px 20px",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"baseline",gap:10,marginBottom:10}}>
                  <span style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2}}>{v.tag}</span>
                  <span style={{color:"var(--v444)",fontSize:9,letterSpacing:1}}>{v.date}</span>
                </div>
                {v.items.map((it,i)=>(
                  <div key={i} style={{display:"flex",gap:8,marginBottom:6}}>
                    <span style={{color:"var(--gold)",fontSize:9,flexShrink:0,marginTop:1}}>+</span>
                    <span style={{color:"var(--v666)",fontSize:10,lineHeight:1.6}}>{it}</span>
                  </div>
                ))}
              </div>
            ))}
            <div style={{textAlign:"center",color:"var(--v333)",fontSize:8,letterSpacing:2,textTransform:"uppercase",padding:"16px 0"}}>CAREER SIGNAL · made by Jammal &amp; Claude</div>
          </div>
        )}

        {view==="guide"&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:660,margin:"0 auto"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:30,letterSpacing:3,color:"var(--gold)",marginBottom:4}}>HOW IT WORKS</div>
            <div style={{color:"var(--v333)",fontSize:9,letterSpacing:2,marginBottom:32,textTransform:"uppercase"}}>the scoring system, the stats, and what we're actually measuring</div>

            {/* Philosophy */}
            <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 13%, transparent)",borderRadius:8,padding:"20px 22px",marginBottom:14}}>
              <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:10}}>THE PHILOSOPHY</div>
              <div style={{color:"var(--v555)",fontSize:11,lineHeight:1.8}}>We are not ranking human worth. We are ranking <span style={{color:"var(--v888)"}}>visible early-career signal</span> — how strong, rare, fast, coherent, and substantiated someone's profile appears from the outside. LinkedIn is fake as hell sometimes. It captures signalling, not soul. It can suggest traits, but it cannot prove character, integrity, humility, work ethic, or depth. This system is a FIFA OVR for public career signal, plus a scouting report explaining what the score actually means. The scale is anchored: <span style={{color:"var(--v888)"}}>50 is the median career-focused student on LinkedIn</span> — every point above it has to be earned by evidence, not adjectives.</div>
            </div>

            {/* OVR formula */}
            <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"20px 22px",marginBottom:14}}>
              <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:10}}>WHAT DRIVES THE OVR</div>
              <div style={{color:"var(--v555)",fontSize:11,lineHeight:1.9,marginBottom:14}}>Six categories feed the OVR. Each measures one distinct property of the evidence, and each property is scored in exactly one place. The AI produces the six stats; the app computes the OVR itself so the formula is always applied exactly: <span style={{color:"var(--v888)"}}>OVR = 25% Depth + 20% Prestige + 20% Stack + 15% Reach + 15% Pace + 5% Rarity</span>. Depth carries the most weight because verified output is the only signal that can't be bought; Rarity carries the least because it's the hardest to estimate reliably from a screenshot.</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {[{s:"DEPTH",c:"var(--c-depth)",l:"Depth · 25%",d:"Verified output"},{s:"PRES",c:"var(--gold)",l:"Prestige · 20%",d:"Seat selectivity"},{s:"STACK",c:"var(--c-stack)",l:"Stack · 20%",d:"How it compounds"},{s:"REACH",c:"var(--c-reach)",l:"Reach · 15%",d:"Above expectation"},{s:"PACE",c:"var(--c-pace)",l:"Pace · 15%",d:"Ahead of timeline"},{s:"RARE",c:"var(--c-rare)",l:"Rarity · 5%",d:"Scarcity of the combo"}].map(x=>(
                  <div key={x.s} style={{display:"flex",alignItems:"center",gap:8,background:"var(--s0c)",borderRadius:5,padding:"8px 10px"}}>
                    <div style={{width:28,height:28,borderRadius:3,background:`${A(x.c,8)}`,border:`1px solid ${A(x.c,20)}`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:11,color:x.c,flexShrink:0}}>{x.s}</div>
                    <div><div style={{color:x.c,fontSize:9,letterSpacing:0.5}}>{x.l}</div><div style={{color:"var(--v2a)",fontSize:8}}>{x.d}</div></div>
                  </div>
                ))}
              </div>
              <div style={{color:"var(--v2a)",fontSize:8,marginTop:12,lineHeight:1.6}}>There are no hidden modifiers. Every stat uses the full 1–99 range with 50 anchored to the median career-focused student, so a profile of all 50s scores an OVR of 50.</div>
            </div>

            {/* Scoring consistency — 2K-style fixed anchors */}
            <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"20px 22px",marginBottom:14}}>
              <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:10}}>SCORING CONSISTENCY — HOW NBA 2K DOES IT</div>
              <div style={{color:"var(--v555)",fontSize:11,lineHeight:1.9}}>2K rates every player against <span style={{color:"var(--v888)"}}>fixed, absolute standards</span> — LeBron's rating doesn't change because of who else is in your MyTeam. Career Signal works the same way: three fixed calibration anchor profiles (a ≈40, a ≈52 and a ≈80) are baked into every single scan, and the scout is explicitly told it has no knowledge of your other cards. <span style={{color:"var(--v888)"}}>Scan order cannot move a rating</span> — the same screenshots produce the same read whether they're your first card or your fiftieth. Pool percentiles, VS THE POOL and the leaderboard are computed deterministically by the app afterwards. Small run-to-run wobble (±2–3 on a stat) is model noise, not drift — RE-SCORE any card to re-measure it against the same fixed anchors.</div>
              <div style={{color:"var(--v2a)",fontSize:8,marginTop:10,lineHeight:1.6}}>Every industry is scored on its own selectivity ladder — law, medicine, research, policy, creative, sport and more. The top of ANY ladder can hit 90+; nobody is marked down for not being in finance or tech.</div>
            </div>

            {/* Percentile note */}
            <div style={{background:"var(--s0c)",border:"1px solid var(--v1a)",borderRadius:8,padding:"16px 20px",marginBottom:14}}>
              <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:14,letterSpacing:2,marginBottom:8}}>ABOUT THE PERCENTILE</div>
              <div style={{color:"var(--v444)",fontSize:10,lineHeight:1.8}}>Percentiles are based on the current analysed profile pool and will shift as more profiles are added. Early beta percentiles are <span style={{color:"var(--v888)"}}>directional, not population-wide claims</span> — they compare you against profiles that have been run through the system, not against all students or all LinkedIn users.</div>
              <div style={{color:"var(--v2a)",fontSize:9,marginTop:8}}>The percentile unlocks once the pool reaches 30 profiles. Before that, profiles show their tier band instead.</div>
            </div>

            {/* Stat cards */}
            {STATS.map(st=>{
              const info=STAT_INFO[st];
              return(
                <div key={st} style={{background:"var(--s0c)",border:`1px solid ${A(info.color,9)}`,borderRadius:8,padding:"20px 22px",marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <div style={{width:36,height:36,borderRadius:4,background:`${A(info.color,8)}`,border:`1px solid ${A(info.color,20)}`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:14,color:info.color,letterSpacing:1}}>{st}</div>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:info.color}}>{info.full}</div>
                  </div>
                  <div style={{color:"var(--v666)",fontSize:11,lineHeight:1.75,marginBottom:12}}>{info.desc}</div>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {info.examples.map((ex,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{width:3,height:3,borderRadius:"50%",background:info.color,opacity:0.5,flexShrink:0}}/>
                        <span style={{color:"var(--v333)",fontSize:9,letterSpacing:0.5}}>{ex}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Age modifier */}
            <div style={{background:"var(--s0c)",border:"1px solid #ffffff0a",borderRadius:8,padding:"20px 22px",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                <div style={{width:36,height:36,borderRadius:4,background:"#ffffff0a",border:"1px solid #ffffff14",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:11,color:"var(--v888)",letterSpacing:1}}>AGE</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:"var(--v888)"}}>Age — Why It Isn't a Stat</div>
              </div>
              <div style={{color:"var(--v555)",fontSize:11,lineHeight:1.75}}>Earlier versions applied a separate age bonus on top of Pace. That double-counted the same property — earliness — twice, so it's gone. Age now lives entirely inside <span style={{color:"var(--c-pace)"}}>Pace</span>, which is stage-adjusted: what matters is how far ahead of the standard recruitment timeline each milestone landed, not the birthday attached to it. A 24-year-old who founded a company, served in the military, or switched countries is on-schedule, not behind. Pace rewards compressed progress — not youth worship.</div>
            </div>

            {/* Score bands */}
            <div style={{background:"var(--s0c)",border:"1px solid var(--v1a)",borderRadius:8,padding:"20px 22px",marginBottom:10}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:"var(--vddd)",marginBottom:14}}>SCORE BANDS</div>
              {[
                {range:"88–99",label:"Elite Tier",color:"var(--gold)",desc:"Several stats at the top of their anchors at once — hyper-selective seats AND verified output AND a coherent thesis. By construction this should almost never be handed out."},
                {range:"78–87",label:"Rare Tier",color:"var(--vaaa)",desc:"One genuinely elite dimension plus an evidenced, coherent stack. Serious enough to interest elite recruiters, founders, or investors."},
                {range:"65–77",label:"Uncommon Tier",color:"var(--v666)",desc:"Clearly above the median career-focused student, but missing either the proof or the coherence to go higher."},
                {range:"50–64",label:"Standard Tier",color:"var(--v666)",desc:"The median zone — 50 IS the typical career-focused student on LinkedIn. Not an insult; the anchor of the whole scale."},
                {range:"Under 50",label:"Developing",color:"var(--v555)",desc:"Thin evidence, open-entry seats, or accumulation without direction. The fastest way up is one concrete, verifiable output."},
              ].map(b=>(
                <div key={b.range} style={{display:"flex",gap:14,alignItems:"flex-start",marginBottom:12,paddingBottom:12,borderBottom:"1px solid var(--s11)"}}>
                  <div style={{minWidth:56,textAlign:"right",fontFamily:"'Bebas Neue'",fontSize:20,color:b.color,lineHeight:1}}>{b.range}</div>
                  <div>
                    <div style={{color:"var(--vaaa)",fontSize:10,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>{b.label}</div>
                    <div style={{color:"var(--v444)",fontSize:10,lineHeight:1.6}}>{b.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Anti-double-counting */}
            <div style={{background:"var(--s0c)",border:"1px solid var(--v1a)",borderRadius:8,padding:"20px 22px",marginBottom:10}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:"var(--vddd)",marginBottom:14}}>SINGLE-HOME RULES</div>
              <div style={{color:"var(--v444)",fontSize:10,lineHeight:1.7,marginBottom:14}}>Every property of the evidence is scored in exactly one stat. One fact can feed several stats — but only through the property each one measures. "Jane Street in first year" moves Prestige (selectivity) and Pace (earliness); it moves Depth only if output is shown.</div>
              {[
                {n:"1",t:"Selectivity lives in Prestige","d":"Goldman is Goldman whether from Cambridge or Coventry — and a self-printed founder title is not a selective seat. Only admission difficulty counts here."},
                {n:"2",t:"Background lives in Reach","d":"Only Reach rewards non-target school, unusual degree, low access, or socioeconomic context. If the starting context isn't visible, Reach sits near 50."},
                {n:"3",t:"Earliness lives in Pace","d":"Age is inside Pace — there is no separate age bonus anywhere. Stage vs timeline is what matters, not the birthday."},
                {n:"4",t:"Scarcity lives in Rarity","d":"Rarity asks 'how common is this exact combination?' — not 'how hard was the path?' (that's Reach). It's weighted 5% because it's the hardest to estimate."},
                {n:"5",t:"Coherence lives in Stack","d":"Random achievements don't compound. They clutter. Dilettantism is penalised."},
                {n:"6",t:"Proof lives in Depth","d":"No real output = no monster score, whatever the logos say. Weighted 25% because proof is the only signal that can't be bought."},
              ].map(r=>(
                <div key={r.n} style={{display:"flex",gap:12,marginBottom:10}}>
                  <span style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:14,flexShrink:0,width:14}}>{r.n}</span>
                  <div>
                    <span style={{color:"var(--v888)",fontSize:10,letterSpacing:0.5}}>{r.t} — </span>
                    <span style={{color:"var(--v444)",fontSize:10,lineHeight:1.6}}>{r.d}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Scouting report */}
            <div style={{background:"var(--s0c)",border:"1px solid var(--v1a)",borderRadius:8,padding:"20px 22px"}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:"var(--vddd)",marginBottom:6}}>SCOUTING REPORT BREAKDOWN</div>
              <div style={{color:"var(--v444)",fontSize:10,lineHeight:1.75,marginBottom:16}}>Every sentence must do one of four jobs: <span style={{color:"var(--v888)"}}>cite visible evidence, interpret what it means, explain what it does not prove, or calibrate against the right peer group.</span> The formula is Evidence → Inference → Caveat. Aesthetic language without evidence behind it is a calibration error.</div>
              {[
                {icon:"◈",l:"Profile Thesis","d":"The core read of the profile in one paragraph. Has an actual thesis. Identifies the central tension. Names the accurate archetype — not the inflated one. Feels like a scout who thought about the profile, not a summary bot."},
                {icon:"◈",l:"Best Signal","d":"The single strongest element, cited with specific evidence. Names actual companies, roles, skills. Uses the formula: 'Best signal: [specific evidence]. That suggests [inference]. [Caveat].' Not 'strong stack' — but 'MyMarkingMachine mentions React, NodeJS, LLMs, image processing, and SSO — that is actual product infrastructure.'"},
                {icon:"◇",l:"Weakest Signal","d":"The deeper weakness, not just the surface gap. Distinguishes between 'elite prospect' and 'elite proven operator.' Names the specific category of validation that is missing and what would change the assessment."},
                {icon:"◉",l:"What This Signals","d":"What the path signals about character, agency, and work ethic. Notes directionality (does the profile point consistently in one direction?). Notes agency level (creating opportunities vs waiting for structured programmes)."},
                {icon:"✕",l:"What It Does Not Prove","d":"The key honesty check. Separates elite credentials from elite execution. Names specific capabilities not yet evidenced. Also notes what it does not prove relative to the exact peer group — not just general population."},
                {icon:"⊕",l:"Peer Calibration","d":"Calibrates against three reference groups. General student population, exact peer group (e.g. Cambridge CS students specifically), and the elite tier above (what would be needed to reach it). This is the whole ranking system in human language."},
                {icon:"▼",l:"Floor","d":"Realistic minimum outcome. For elite academic + real technical work, the floor is not 'average graduate' — it is specific roles and company types that represent the realistic worst case."},
                {icon:"◆",l:"Base Case","d":"Most likely outcome if they stay the course. Two branches if relevant (if startup gains traction X, if not Y)."},
                {icon:"▲",l:"Ceiling","d":"Highest realistic outcome if everything compounds. States specifically what would need to happen. Honest — not everyone has a sky-high ceiling."},
                {icon:"↑",l:"Fastest Upgrade","d":"The one specific thing that would most improve this profile. Not vague — concrete. 'Attach numbers to the startup: users, revenue, pilots, API calls. One credible number transforms the founder signal from open-ended to high-conviction.'"},
              ].map(s=>(
                <div key={s.l} style={{display:"flex",gap:10,marginBottom:10}}>
                  <span style={{color:"var(--gold)",fontSize:10,flexShrink:0,marginTop:2,width:12}}>{s.icon}</span>
                  <div>
                    <span style={{color:"var(--vaaa)",fontSize:10,letterSpacing:0.5}}>{s.l} — </span>
                    <span style={{color:"var(--v444)",fontSize:10,lineHeight:1.6}}>{s.d}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Scout knowledge — user calibration context */}
            <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"20px 22px",marginTop:14}}>
              <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:6}}>SCOUT KNOWLEDGE</div>
              <div style={{color:"var(--v555)",fontSize:10,lineHeight:1.8,marginBottom:12}}>Teach the scout context it can't see from a screenshot — how selective a programme really is, what a society title actually involves, which firms are serious. Saved text is injected into every scan and every Scout Chat as trusted calibration. This is the first brick of the "second brain": paste hard facts about programmes and achievements, not opinions about people.</div>
              <textarea value={knowledge} onChange={e=>setKnowledge(e.target.value)} placeholder={"e.g. URSS is a competitive funded research scheme at Warwick. A UK 'spring week' is a selective first-year insight programme at a bank. WFS exec roles are elected, not appointed."} style={{width:"100%",minHeight:120,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"12px 14px",color:"var(--veee)",fontFamily:"'Space Mono',monospace",fontSize:10,lineHeight:1.7,outline:"none",resize:"vertical",boxSizing:"border-box"}}/>
              <div style={{display:"flex",alignItems:"center",gap:10,marginTop:10}}>
                <button onClick={saveKnowledge} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"9px 18px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>SAVE</button>
                {kMsg&&<span style={{color:"#16a34a",fontSize:9,letterSpacing:1}}>{kMsg}</span>}
              </div>
            </div>

            {/* Cracked rubric — the owner's evolving taste document */}
            <div style={{background:"var(--s0f)",border:"1px solid color-mix(in srgb, var(--gold) 33%, transparent)",boxShadow:"0 0 18px color-mix(in srgb, var(--gold) 10%, transparent)",borderRadius:8,padding:"20px 22px",marginTop:14}}>
              <div style={{color:"var(--gold)",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:6}}>CRACKED RUBRIC</div>
              <div style={{color:"var(--v555)",fontSize:10,lineHeight:1.8,marginBottom:12}}>Your evolving document of what you actually rate as cracked and what's LinkedIn theatre. Every time a score lands wrong, write down WHY it was wrong here — over time this becomes the taste layer the model is missing. It's injected into every scan, chat and verdict, but the scout is told: your taste calibrates judgment, evidence discipline still wins. That protects the system's best property — it doesn't overrate.</div>
              <textarea value={rubric} onChange={e=>setRubric(e.target.value)} placeholder={"e.g. Shipped products with real users beat any society title. A spring week is table stakes, not impressive. 'Founder' of a landing page is theatre; 'founder' with revenue is cracked. Conversions (spring to summer, return offers) are the strongest quiet signal."} style={{width:"100%",minHeight:120,background:"var(--s11)",border:"1px solid var(--v1e)",borderRadius:6,padding:"12px 14px",color:"var(--veee)",fontFamily:"'Space Mono',monospace",fontSize:10,lineHeight:1.7,outline:"none",resize:"vertical",boxSizing:"border-box"}}/>
              <div style={{display:"flex",alignItems:"center",gap:10,marginTop:10}}>
                <button onClick={saveRubric} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"9px 18px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>SAVE</button>
                {rMsg&&<span style={{color:"#16a34a",fontSize:9,letterSpacing:1}}>{rMsg}</span>}
              </div>
            </div>
          </div>
        )}

      </div>

    </div>
  );
}
