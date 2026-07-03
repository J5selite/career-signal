import { useState, useEffect, useRef, useCallback } from "react";

// ── Storage shim: replaces Claude artifact's storage with localStorage ──
const storage = {
  async get(key){ try{ const v = localStorage.getItem(key); return v ? { value: v } : null; } catch { return null; } },
  async set(key, value){ try{ localStorage.setItem(key, value); return { value }; } catch { return null; } },
};


const EXTRACT_PROMPT = `You are looking at a LinkedIn profile screenshot. Extract career information and return ONLY valid JSON, no markdown, no backticks.

Extract:
- name: full name (string)
- uni: university name (string, or "Unknown" if not visible)
- year: graduation year or cohort e.g. "2024" (string, estimate from dates if possible)
- age: age as a number if determinable from graduation year or career timeline — estimate if needed (number)
- company: current or most recent company (string)
- role: current or most recent role title (string)
- how: how they likely secured it — "internship" if they interned there first, "direct" if applied directly, "founder" if they founded or co-founded it, "lateral" if moved from similar role, "other" otherwise
- prev: estimated prior internships/roles as string — one of "0","1","2","3","4","5+"
- acts: activities, societies, awards, competitions, academic achievements mentioned — comma separated string, or "None"
- notes: anything notable — academic record (e.g. AAA* A-levels, near-perfect GCSEs), non-target school, unusual background, technical skills mentioned, startup traction signals (users/revenue/funding), first from uni, etc. Be specific.
- profile_type: classify as "finance", "technical", "founder", or "technical_founder" based on the dominant signal

Return ONLY: {"name":"...","uni":"...","year":"...","age":21,"company":"...","role":"...","how":"internship","prev":"1","acts":"...","notes":"...","profile_type":"finance"}`;

const SCORE_PROMPT = `You are a rigorous career scouting system. Before scoring, you MUST identify the profile type and apply the correct logic. Follow every rule exactly.

═══ STEP 0: IDENTIFY PROFILE TYPE ═══
Read the profile carefully and classify as one of:
- FINANCE: primary signal is firm/role in investment banking, consulting, PE, VC, trading, asset management
- TECHNICAL: primary signal is software engineering, AI/ML, computer science, applied technical work
- FOUNDER: primary signal is starting or co-founding a company — even if early stage

A person can be TECHNICAL + FOUNDER. This matters for how you score PRES.

═══ STEP 1: ANTI-DOUBLE-COUNTING RULES ═══
Read these first. Violating them is the most common calibration error.

1. PRES is absolute for the profile type — include academic platform for TECHNICAL/FOUNDER profiles.
2. REACH is the ONLY place to reward non-target school, unusual background, or low access.
3. PACE is stage-based — first-year vs penultimate matters more than age 19 vs 20.
4. Lack of startup traction → cap DEPTH and note in ceiling. Do NOT also drag down PRES, PACE, STACK, or floor.
5. A founder route secured through self-creation ("how = other") is "high-agency, low-validation" — reduce external validation score, not the whole person.
6. STACK requires coherence — score it on the narrative, not on whether companies are famous.
7. Rarity is configuration-based — do not re-score reach or traction through RARE.

═══ STEP 2: CALIBRATION FLOORS ═══
If someone has elite academic pedigree + real skill evidence, they cannot be scored like a generic unknown founder. Apply these floors before scoring:

- Cambridge/Oxford/Imperial/LSE/ETH CS or equivalent elite STEM + strong grades: PRES floor = 75. Even if every work experience is mid.
- Add real SWE/AI/applied engineering experience (actual technical work, not vague role titles): PRES floor rises to 80–83. DEPTH floor = 70.
- Add coherent founder/project narrative with credible technical background: OVR floor = 83–88.
- Add users/revenue/elite internship (DeepMind/Google/Citadel/Jane Street/YC): OVR floor = 88–93.
- Add exceptional external validation (top research, Olympiad, major open source, top hackathon): 93+.

═══ STEP 3: STAT DEFINITIONS ═══

PRES — Destination Quality (25% weight)
PRES VARIES BY PROFILE TYPE. This is critical.

FOR FINANCE PROFILES: 60% firm halo + 40% seat selectivity.
- GS/MS/JPM/Citi/BAML IBD, MBB, Citadel/Jane Street/DE Shaw/KKR/Blackstone front-office: 88-99
- Other BBs (DB/UBS/Barclays IBD), top EBs (Lazard/Rothschild/Evercore/Moelis): 78-87
- Big4 advisory, Google/Meta/Amazon strategy roles: 65-77
- Generic grad scheme, unrecognised boutique: 35-64
Note: Goldman is Goldman whether from Cambridge or Coventry. Never factor background into PRES for finance.

FOR TECHNICAL PROFILES: Blend university strength + course competitiveness + employer quality + role substance + project/founder proof.
- Cambridge/Oxford/Imperial/ETH/MIT CS + elite grades + top-tier employer or serious project: 85-97
- Cambridge/Oxford/Imperial CS + strong grades + mid-tier employers or early-stage project: 78-86
- Strong target uni (Warwick/UCL/Edinburgh CS) + strong technical employers: 68-78
- Good uni + decent technical experience: 55-67
- Unknown uni + no recognisable employer: 35-54
Key principle: For technical students, academic platform IS part of destination quality. Cambridge CS is not "good uni" — it is S-tier academic selection. A Cambridge CS student with near-perfect grades should have PRES around 78-86 even if work experience is startup-level.

FOR FOUNDER PROFILES: Weight product traction + team signal + funding/backing + technical depth. University still anchors the floor.
- YC/funded startup + credible team + real users: 85-95
- Early-stage founder, Cambridge/Oxford/Imperial anchor, credible technical background, no traction yet: 72-82 (high-agency, low-validation signal)
- Unknown founder, no clear technical background, no traction: 40-60
Critical rule: Founder title + credible technical background + elite academic anchor = good signal, low validation. Score around 75-82 for this combination. Do NOT tank it to 42 because the startup is unproven. Cap ceiling, not floor.

PACE — Pipeline Speed (15% weight)
Stage-adjusted, not age-adjusted. Measures how compressed progress is vs the normal timeline.
Normal timeline: spring week Y1/Y2, penultimate internship Y2, return offer → grad. Anything ahead = points.
- Pre-university landing real elite exposure: 90-99
- First year landing penultimate-level internship or spring at elite firm: 84-91
- First year landing spring week, paid technical role, or contract work: 75-83
- Penultimate year landing expected elite internship: 60-74
- Final year with return offer already secured: 55-65
- Post-grad normal progression: 45-54
- 2+ years behind peers, no explanation: 30-44
Do not punish for military service, founding a company, switching countries, illness. Pace rewards compressed progress, not youth worship. If someone is in first/second year and has already accumulated technical internships AND a co-founder title, this is an early mover profile. Score 80+.

REACH — Contextual Overperformance (15% weight)
"Given where this person started, how far above expectation did they land?"
For elite academic backgrounds (Cambridge CS, AAA* grades, grammar school), the expected baseline is already very high. A Cambridge CS student getting startup SWE roles is impressive but not shocking — do not inflate reach.
- Post-92/non-target → elite front-office or top-tier tech: 90-99
- Non-target → strong EB or top tech: 80-89
- Russell Group → elite front-office: 70-79
- Semi-target → GS/MS/JPM IBD: 62-71
- Target (LSE/Imperial) → GS IBD: 52-61
- Oxbridge → GS IBD: 45-55 (still hard, not shocking)
- Oxbridge/elite academic → expected graduate role in line with their background: 25-44
For technical profiles: Cambridge CS getting SWE roles = expected. Reach should not be inflated. If the roles were secured BEFORE university admission, reach improves significantly because they were operating above their peer stage.

STACK — Compounding Narrative (20% weight)
"Do the pieces reinforce each other into a serious thesis, or are they random shiny badges?"
Judge on coherence and thematic depth, NOT on whether companies are famous. An unknown startup with real technical work compounding into a coherent AI/builder narrative is strong stack.
Strong stack signal: themes connect across experiences. Each role builds on the last. Technical skills compound.
Weak stack signal: random internship + society + ambassador + podcast + crypto club = LinkedIn buffet.
- Coherent elite trajectory, 3+ assets compounding with thematic depth: 85-99
- Strong 2-3 asset narrative with real thematic coherence: 78-86
- 1 strong asset + supporting coherent context: 65-77
- Decent but lacks clear direction: 45-64
- Scattered or thin: 25-44

RARE — Configuration Scarcity (10% weight)
"How many people with this exact combination of assets exist?"
Compare to the reference group carefully. Cambridge CS + startup = rare compared to average UK student. Less rare compared to Cambridge CS peer group specifically.
- Non-target + elite outcome + unusual combination: 88-99
- Elite academic + founder + early technical work + AI focus = rare among general population, moderate among elite CS peers: 72-84
- Standard target path at great firm: 40-55
- Common among exact peer group: 30-50

DEPTH — Evidence of Real Skill (15% weight)
"What have they actually built, written, won, sold, researched, led, created, or improved?"
Actual technical work descriptions = strong signal. Vague role titles = weak signal.
Applied engineering examples (strong depth signals): automating systems with image processing + LLMs + SSO integration, building React/Node backends, web scraping tools with real use cases, shipped products. These are real build evidence.
Missing signals that cap depth: no metrics, no users, no revenue, no scale data, no competition wins, no open-source proof, no published research, no "built X used by Y people."
- Multiple verified outputs with results: 85-99
- One strong verifiable technical output or conversion proof (spring → summer = performance proof): 72-84
- Real applied engineering work described in detail, but no metrics/scale proof: 65-75
- Implied depth from serious role, nothing independently verified: 50-64
- Thin or inflated language only: 15-49
Key calibration: If someone describes actual technical work (React frontend, NodeJS backend, LLM integration, image processing), this is real build evidence. Score 70+. A score of 55 should be reserved for mostly vague project descriptions with no execution proof.

AGE STAGE MODIFIER (applied after weighted OVR)
-5 to +8. Do not punish age if output and depth are serious.
- Sixth form landing real elite signal: +7 to +8
- First year landing penultimate-level opportunity or contract work: +5 to +7
- First year landing spring or niche role: +3 to +5
- Penultimate year, expected elite internship: 0 to +2
- Final year with return offer: 0 to +2
- 22-24, strong trajectory: 0
- 24+, same milestone as peers, no context or depth: -2 to -5

═══ STEP 4: OVR FORMULA ═══
base = round(PRES*0.25 + STACK*0.20 + REACH*0.15 + PACE*0.15 + DEPTH*0.15 + RARE*0.10)
OVR = min(99, max(1, base + age_stage_modifier))

═══ STEP 5: SCORE BANDS ═══
95-99: Generational — multiple elite signals simultaneously, real validated output, young, unique narrative. Rare as hell.
90-94: Nationally elite — top-tier outcome with coherent stack, some rarity, and proof.
85-89: Very elite / high-conviction — serious enough for elite recruiters, founders, investors.
75-84: Strong standout — strong uni, real experience, narrative, some proof.
65-74: Solid ambitious — good but common among career-focused students.
50-64: Normal LinkedIn competence — not bad, just not special.
Under 50: Weak signal.

═══ STEP 6: ANTI-HALLUCINATION RULES ═══
These are non-negotiable. Violating them destroys user trust.

NEVER invent narrative the profile does not explicitly show. Every inference must be labelled as inference.

BAD: "He walked away from Goldman."
GOOD: "The visible profile does not show a traditional elite internship route, so the path currently reads as self-directed rather than institutionally validated."

BAD: "She chose research over finance."
GOOD: "The profile shows a research role rather than a front-office internship — whether this was a deliberate choice or circumstantial is not visible from the evidence."

BAD: "A deliberate builder who avoids the corporate grind."
GOOD: "The profile has no corporate internship in the visible section, which could indicate a deliberate founder path or simply that this evidence is not yet visible."

Rules:
- Only describe what is VISIBLE in the screenshot
- If you are inferring, write "this suggests" or "the visible evidence implies" not "he/she did/chose/decided"
- Never state motivations, choices, or character as fact unless explicitly evidenced
- Never claim a firm is elite unless you recognise it — if unknown, say "an early-stage startup with no publicly visible traction"
- If information is missing (e.g. education not in screenshot), acknowledge the gap rather than assume

═══ STEP 7: CLASSIFICATION OUTPUT ═══

profile_type: The scoring lens. Determines how PRES is weighted. Choose the most accurate:
- "Finance / Consulting" — primary signal is firm/role in IB, consulting, PE, VC, trading
- "Technical Builder" — primary signal is software engineering, CS, applied AI/ML work
- "Founder" — primary signal is founding or co-founding a company
- "Technical Founder" — blend of strong CS/technical background + founding activity
- "Creator / Media" — primary signal is content, audience, distribution
- "Research / Academic" — primary signal is publications, academic output, research roles
- "Policy / Social Impact" — primary signal is public sector, NGO, impact-focused organisations
- "Generalist Operator" — no single dominant signal; strong breadth, unclear specialisation
- "Hybrid" — two equally strong tracks from different categories

archetype: The narrative build. What career pattern does this represent? Choose the most accurate:
- "Technical Founder Prospect" — elite CS/technical background moving toward founding
- "Non-Target Breakout" — outperformed their background massively
- "Prestige Stacker" — systematically collecting institutional validation
- "Platform Builder" — building audience, distribution, or platform alongside credentials
- "Applied AI Builder" — consistent applied AI/ML execution across roles
- "Creator-Operator Hybrid" — content/audience combined with professional credentials
- "Research-Led Operator" — academic depth being converted into career capital
- "Finance Track Climber" — classic institutional finance path, optimising for brand and seat
- "Academic Weapon" — elite academic pedigree as the primary anchor
- "High-Agency Generalist" — creating opportunities rather than waiting for structured routes
- "Founder Bet" — high agency, low external validation, unproven upside

confidence: Evidence quality score. How much visible evidence did you have to work with?
- "HIGH" — education + experience + awards/metrics + detailed role descriptions all visible
- "MEDIUM" — education or experience visible with some detail, but key sections missing
- "LOW" — minimal evidence; primarily job titles without context, or major sections absent

confidence_reason: One sentence explaining what evidence was present and what was missing. E.g. "Experience section shows detailed role descriptions with technical specifics; education section not visible in screenshots."

═══ STEP 8: SCOUTING REPORT RULES ═══

CRITICAL: Every sentence in the scouting report must do one of four jobs:
1. Cite visible evidence (name specific companies, roles, skills, dates from the profile)
2. Interpret what that evidence means (label inferences as inferences)
3. Explain what it does not prove (separate promise from proof)
4. Calibrate against the correct peer group

The formula for every section: EVIDENCE → INFERENCE → CAVEAT.

FIELD DEFINITIONS:

moniker: 2-4 word punchy nickname grounded in what the profile ACTUALLY shows. Match to archetype. Never invent narrative.

thesis: Profile Thesis — one paragraph with (a) core read in one sentence using evidence, (b) what makes it coherent or incoherent, (c) the central tension. Must feel like a scout who thought about it, not a summary bot. All inferences labelled as such.

best_signal: Single strongest element with specific evidence cited. Formula: "Best signal: [specific visible evidence]. That suggests [inference — labelled as inference]. [Caveat]."

weak_signal: Deeper weakness — not just surface gap but category of missing validation. Distinguish prospect from proven operator. All inferences labelled.

traits: What the path signals about character and agency. Label every inference. Note directionality if present. Note agency level.

not_proven: What the visible evidence does NOT yet prove. Specific — name capabilities not yet evidenced. Calibrate to exact peer group.

peer_calibration: Three reference groups explicitly named. General population → exact peer group → elite tier above. What would be needed for each step up.

floor: Realistic minimum outcome. For elite academic + technical work, floor is not "average graduate." Name specific roles and company types.

base_case: Most likely outcome. Two branches if relevant.

ceiling: Highest realistic outcome if everything compounds. State what specifically would unlock it.

upgrade: One specific, concrete thing that would most improve this profile fastest.

Return ONLY valid JSON, no markdown, no backticks:
{"PRES":X,"PACE":X,"REACH":X,"STACK":X,"RARE":X,"DEPTH":X,"OVR":X,"profile_type":"...","archetype":"...","confidence":"HIGH|MEDIUM|LOW","confidence_reason":"...","moniker":"...","thesis":"...","best_signal":"...","weak_signal":"...","traits":"...","not_proven":"...","peer_calibration":"...","floor":"...","base_case":"...","ceiling":"...","upgrade":"..."}`;

function erf(x){const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;const s=x<0?-1:1;x=Math.abs(x);const t=1/(1+p*x);return s*(1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));}
function getPct(cards,ovr){if(cards.length<5){const z=(ovr-65)/12;return Math.min(99,Math.max(1,Math.round(50*(1+erf(z/Math.sqrt(2))))));}return Math.min(99,Math.max(1,Math.round((cards.filter(c=>c.OVR<ovr).length/cards.length)*100)));}
function T(ovr){if(ovr>=88)return{bg:"#0b0700",strip:"#FFD700",stripD:"#8a5c00",acc:"#FFD700",glow:"#FFD70044",label:"ELITE",dot:"0.07"};if(ovr>=78)return{bg:"#060610",strip:"#8fa8ff",stripD:"#3348bb",acc:"#99b0ff",glow:"#8fa8ff44",label:"RARE",dot:"0.07"};if(ovr>=65)return{bg:"#090909",strip:"#c0c0c0",stripD:"#555",acc:"#d0d0d0",glow:"#cccccc33",label:"UNCOMMON",dot:"0.05"};return{bg:"#080600",strip:"#dd8800",stripD:"#6a3d00",acc:"#ee9900",glow:"#dd880033",label:"STANDARD",dot:"0.05"};}
function S(ovr){return ovr>=90?5:ovr>=80?4:ovr>=70?3:ovr>=60?2:1;}
const STATS=["PRES","PACE","REACH","STACK","RARE","DEPTH"];

const STAT_INFO={
  PRES:{full:"Prestige — Destination Quality",color:"#FFD700",desc:"60% firm halo + 40% seat selectivity. Goldman is Goldman whether you're from Cambridge or Coventry — background never enters this score. The seat matters too: Goldman IBD ≠ Goldman ops.",examples:["GS/MS/JPM IBD, MBB, Citadel → 88-99","Lazard/Rothschild/Evercore M&A → 78-87","Big4 advisory, Google/Meta → 65-77","Generic grad scheme → 35-49"]},
  PACE:{full:"Pace — Pipeline Speed",color:"#00E5FF",desc:"How compressed is their progress relative to the normal recruitment timeline? Stage-adjusted, not age-adjusted. A 24-year-old who founded a company and pivoted to finance is not slow — context matters.",examples:["Pre-uni / sixth form landing elite signal → 92-99","First year landing penultimate-level internship → 84-91","Penultimate year, expected elite internship → 60-74","Post-grad, 2+ years behind peers, no context → 30-44"]},
  REACH:{full:"Reach — Contextual Overperformance",color:"#FF6B35",desc:"Given where they started, how far above expectation did they land? This is the ONLY stat that rewards non-target school, unusual background, or lack of network access. Never double-counted in Prestige.",examples:["Post-92 non-target → GS IBD → 90-99","Russell Group → elite EB → 70-79","LSE/Imperial → GS IBD → 52-61","Oxbridge → GS IBD → 45-55 (hard, but not shocking)"]},
  STACK:{full:"Stack — Compounding Narrative",color:"#A855F7",desc:"Do the pieces build on each other into a serious thesis, or are they random shiny badges? Like a great TV show: eight coherent seasons beats one great season. LinkedIn buffets are penalised.",examples:["3+ compounding assets with coherent theme + proof → 85-99","2-asset narrative with depth → 70-84","1 headline role, decent supporting context → 55-69","Scattered: startup + society + ambassador + crypto club → 25-39"]},
  RARE:{full:"Rarity — Configuration Scarcity",color:"#10B981",desc:"How many people with this exact combination exist? Rewards unusual combinations (configuration rarity), not just unusual individual items. Cambridge + GS is prestigious — but common among elite finance profiles.",examples:["Non-target + GS + research + platform → 88-99","Elite athlete + front-office + strong academics → 85-95","Coventry + GS (route rarity) → 75-85","Standard target path, even at great firm → 35-50"]},
  DEPTH:{full:"Depth — Evidence of Real Skill",color:"#F43F5E",desc:"What have they actually built, written, won, sold, researched, led, or improved? This protects the system from LinkedIn slop. Prestige gets you noticed. Depth tells us if there's a person behind the logo.",examples:["Published research / competition wins / product with users → 85-99","Spring → summer conversion (performance proof) / real output → 70-84","Implied depth from serious role — nothing independently verified → 50-69","Job titles only, no evidence of independent output → 15-49"]},
};

function StatTooltip({stat,children}){
  const [show,setShow]=useState(false);
  const info=STAT_INFO[stat];
  return(
    <div style={{position:"relative",display:"inline-flex",alignItems:"center"}} onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
      {children}
      {show&&info&&(
        <div style={{position:"absolute",bottom:"calc(100% + 8px)",left:"50%",transform:"translateX(-50%)",width:220,background:"#111",border:`1px solid ${info.color}33`,borderRadius:6,padding:"10px 12px",zIndex:50,pointerEvents:"none"}}>
          <div style={{color:info.color,fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1,marginBottom:4}}>{info.full}</div>
          <div style={{color:"#888",fontSize:9,lineHeight:1.6,marginBottom:6}}>{info.desc}</div>
          <div style={{display:"flex",flexDirection:"column",gap:2}}>
            {info.examples.map((ex,i)=><div key={i} style={{color:"#444",fontSize:8,letterSpacing:0.5}}>· {ex}</div>)}
          </div>
          <div style={{position:"absolute",bottom:-5,left:"50%",width:8,height:8,background:"#111",border:`1px solid ${info.color}33`,borderRight:"none",borderTop:"none",transform:"translateX(-50%) rotate(-45deg)"}}/>
        </div>
      )}
    </div>
  );
}

function Star({sz}){return <div style={{width:sz,height:sz,background:"rgba(0,0,0,0.55)",clipPath:"polygon(50% 0%,61% 35%,98% 35%,68% 57%,79% 91%,50% 70%,21% 91%,32% 57%,2% 35%,39% 35%)",flexShrink:0}}/>;}

function ShareCard({card,onClose}){
  const t=T(card.OVR);
  const thesis1=card.thesis?card.thesis.split(".")[0]+".":"";
  const confColor=card.confidence==="HIGH"?"#88cc00":card.confidence==="LOW"?"#cc4400":"#cc8800";
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:24}} onClick={onClose}>
      <div onClick={e=>e.stopPropagation()} style={{maxWidth:420,width:"100%"}}>
        <div id="share-card-inner" style={{background:t.bg,border:`1px solid ${t.acc}44`,borderRadius:12,padding:"28px 24px",fontFamily:"'Bebas Neue',sans-serif",boxShadow:`0 0 40px ${t.glow}`}}>
          {/* Header */}
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:20}}>
            <div>
              <div style={{color:t.acc,fontSize:32,letterSpacing:2,lineHeight:1}}>{card.name!=="Unknown"?card.name.split(" ").pop().toUpperCase():"UNKNOWN"}</div>
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
                    <div style={{width:`${v}%`,height:"100%",background:info?.color||t.acc,opacity:0.7}}/>
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
            <div style={{color:t.acc,fontSize:9,letterSpacing:2,opacity:0.5}}>CAREER ATTACK</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:12,justifyContent:"center"}}>
          <div style={{color:"#333",fontSize:9,letterSpacing:1,fontFamily:"'Space Mono',monospace",textAlign:"center"}}>take a screenshot to share · press esc to close</div>
        </div>
        <button onClick={onClose} style={{display:"block",margin:"8px auto 0",background:"none",border:"none",color:"#333",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>CLOSE</button>
      </div>
    </div>
  );
}function Card({card,onClick,sz=1}){
  const t=T(card.OVR),s=S(card.OVR),w=Math.round(220*sz),h=Math.round(310*sz);
  const displayName=card.name&&card.name!=="Unknown"?card.name:(card.moniker||"Unknown");
  const ln=displayName.split(" ").pop().toUpperCase();
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
        <div style={{color:t.acc,fontSize:Math.round(9*sz),textAlign:"center",letterSpacing:1,textTransform:"uppercase",fontWeight:700,maxWidth:Math.round(150*sz),overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{card.company}</div>
        <div style={{color:"#ffffff66",fontSize:Math.round(7*sz),textAlign:"center",textTransform:"uppercase",marginTop:Math.round(2*sz),maxWidth:Math.round(150*sz),overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{card.role}</div>
        {card.archetype&&<div style={{marginTop:Math.round(6*sz),background:`${t.acc}18`,border:`1px solid ${t.acc}44`,borderRadius:Math.round(3*sz),padding:`${Math.round(2*sz)}px ${Math.round(8*sz)}px`,color:t.acc,fontSize:Math.round(6*sz),letterSpacing:1,textTransform:"uppercase",textAlign:"center",maxWidth:Math.round(150*sz),overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{card.archetype}</div>}
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

function Bell({cards,targetOvr,acc="#FFD700"}){
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
      <line x1={pad} y1={H-8} x2={W-pad} y2={H-8} stroke="#ffffff18" strokeWidth="0.5"/>
    </svg>
  );
}

function Key({label,sub,wide,pressed}){
  return(
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minWidth:wide?76:46,height:46,background:pressed?"#FFD700":"#161616",border:`1px solid ${pressed?"#FFD700":"#2a2a2a"}`,borderBottom:`${pressed?"1px":"3px"} solid ${pressed?"#aa8800":"#333"}`,borderRadius:5,padding:"4px 8px",transform:pressed?"translateY(2px)":"none",transition:"all 0.12s",boxShadow:pressed?"none":"0 2px 0 #000",cursor:"default"}}>
      <span style={{fontFamily:"'Space Mono',monospace",fontSize:10,fontWeight:700,color:pressed?"#000":"#aaa",letterSpacing:0.5,textAlign:"center",lineHeight:1.2}}>{label}</span>
      {sub&&<span style={{fontFamily:"'Space Mono',monospace",fontSize:7,color:pressed?"#00000077":"#444",letterSpacing:0.5,marginTop:2}}>{sub}</span>}
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
            <div style={{width:28,height:28,borderRadius:"50%",display:"flex",alignItems:"center",justifyContent:"center",background:i<=cur?"#FFD700":"#111",border:i<=cur?"none":"1px solid #1e1e1e",fontFamily:"'Bebas Neue'",fontSize:13,color:i<=cur?"#000":"#333",flexShrink:0,transition:"all 0.3s"}}>{i<cur?"✓":i+1}</div>
            <span style={{color:i===cur?"#FFD700":i<cur?"#555":"#2a2a2a",fontSize:8,letterSpacing:1.5,textTransform:"uppercase",whiteSpace:"nowrap"}}>{s}</span>
          </div>
          {i<steps.length-1&&<div style={{flex:1,height:1,background:i<cur?"#FFD70033":"#141414",margin:"0 10px",marginBottom:20,transition:"background 0.3s"}}/>}
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
  const [done,setDone]=useState(null);
  const [err,setErr]=useState("");
  const [drag,setDrag]=useState(false);
  const [pk,setPk]=useState({});
  const [dupWarn,setDupWarn]=useState(null);
  const [updating,setUpdating]=useState(null);
  const [showShare,setShowShare]=useState(false);
  const fileRef=useRef();

  useEffect(()=>{(async()=>{try{const r=await storage.get("ca_v2");if(r?.value)setCards(JSON.parse(r.value));}catch{}})();},[]);
  const persist=async u=>{setCards(u);try{await storage.set("ca_v2",JSON.stringify(u));}catch{}};

  useEffect(()=>{
    if(view!=="create"||step!==0)return;
    const d=e=>{const k=e.key.toLowerCase();if(k==="meta"||k==="win"||e.metaKey)setPk(p=>({...p,win:true}));if(k==="shift")setPk(p=>({...p,shift:true}));if(k==="s")setPk(p=>({...p,s:true}));};
    const u=e=>{const k=e.key.toLowerCase();if(k==="meta"||k==="win"||e.metaKey)setPk(p=>({...p,win:false}));if(k==="shift")setPk(p=>({...p,shift:false}));if(k==="s")setPk(p=>({...p,s:false}));};
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

  const analyse=async(forceUpdate=false)=>{
    if(imgs.length===0)return;
    setExtracting(true);setErr("");setDupWarn(null);
    try{
      const imgBlocks=imgs.map(i=>({type:"image",source:{type:"base64",media_type:i.type,data:i.b64}}));
      const r1=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1200,messages:[{role:"user",content:[...imgBlocks,{type:"text",text:EXTRACT_PROMPT}]}]})});
      const d1=await r1.json();
      if(d1.error)throw new Error(`API error: ${d1.error.message}`);
      const ex=repairJSON(d1.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      setExtracted(ex);
      if(!forceUpdate&&!updating){
        const dup=checkDup(ex.name);
        if(dup){setDupWarn(dup);setExtracting(false);return;}
      }
      setExtracting(false);setScoring(true);
      const msg=`Profile type: ${ex.profile_type||"finance"}\nName: ${ex.name}\nUniversity: ${ex.uni}\nAge: ${ex.age}\nCompany: ${ex.company}\nRole: ${ex.role}\nHow secured: ${ex.how}\nPrior internships/roles: ${ex.prev}\nActivities & academic record: ${ex.acts||"None"}\nNotes (academic record, traction signals, context): ${ex.notes||"None"}`;
      const r2=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:3000,system:SCORE_PROMPT,messages:[{role:"user",content:msg}]})});
      const d2=await r2.json();
      if(d2.error)throw new Error(`Scoring error: ${d2.error.message}`);
      const sc=repairJSON(d2.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      const all=[...cards];
      const uid=updating||Date.now().toString();
      const newCard={id:uid,...ex,stats:{PRES:sc.PRES,PACE:sc.PACE,REACH:sc.REACH,STACK:sc.STACK,RARE:sc.RARE,DEPTH:sc.DEPTH},OVR:sc.OVR,profile_type:sc.profile_type||ex.profile_type||"Finance / Consulting",archetype:sc.archetype||null,confidence:sc.confidence||"MEDIUM",confidence_reason:sc.confidence_reason||null,moniker:sc.moniker||null,thesis:sc.thesis||null,best_signal:sc.best_signal||null,weak_signal:sc.weak_signal||null,traits:sc.traits||null,not_proven:sc.not_proven||null,peer_calibration:sc.peer_calibration||null,floor:sc.floor||null,base_case:sc.base_case||null,ceiling:sc.ceiling||null,upgrade:sc.upgrade||null,percentile:0,createdAt:updating?(all.find(c=>c.id===uid)?.createdAt||new Date().toISOString()):new Date().toISOString(),updatedAt:updating?new Date().toISOString():undefined};
      const base=updating?all.filter(c=>c.id!==uid):all;
      const updated=[...base,newCard].map(c=>({...c,percentile:getPct([...base,newCard].filter(x=>x.id!==c.id),c.OVR)}));
      await persist(updated);setDone(newCard);setStep(3);setUpdating(null);
    }catch(e){setErr(`Error: ${e.message}`);console.error(e);}
    setExtracting(false);setScoring(false);
  };

  const deleteCard=async id=>{
    const updated=cards.filter(c=>c.id!==id).map(c=>({...c,percentile:getPct(cards.filter(x=>x.id!==id&&x.id!==c.id),c.OVR)}));
    await persist(updated);
    if(sel?.id===id){setSel(null);setView("leaderboard");}
  };

  const reset=()=>{setStep(0);setImgs([]);setExtracted(null);setDone(null);setErr("");setDupWarn(null);setUpdating(null);};

  const sorted=[...cards].sort((a,b)=>b.OVR-a.OVR);
  const avg=cards.length?Math.round(cards.reduce((s,c)=>s+c.OVR,0)/cards.length):0;
  const ct=sel?T(sel.OVR):{acc:"#FFD700"};
  const withMeta=c=>({...c,_totalCards:cards.length});

  return(
    <div style={{minHeight:"100vh",background:"#080808",color:"#eee",fontFamily:"'Space Mono',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:wght@400;700&display=swap');
        @keyframes shimmer{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
        @keyframes fadeUp{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
        @keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#0a0a0a}::-webkit-scrollbar-thumb{background:#222}
        .row:hover{background:#111!important;border-color:#FFD70022!important}
        .ghost:hover{color:#FFD700!important}
        .delbtn{opacity:0;transition:opacity 0.15s}.row:hover .delbtn{opacity:1}
      `}</style>

      <div style={{display:"flex",alignItems:"center",borderBottom:"1px solid #111",background:"#080808",padding:"0 28px",position:"sticky",top:0,zIndex:100}}>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:20,letterSpacing:3,color:"#FFD700",marginRight:36,padding:"15px 0",textShadow:"0 0 18px #FFD70044",cursor:"pointer"}} onClick={()=>{setView("home");reset();setSel(null);}}>CAREER ATTACK</div>
        {["home","create","leaderboard","guide"].map(v=>(
          <button key={v} className="ghost" onClick={()=>{setView(v);reset();setSel(null);}} style={{background:"none",border:"none",borderBottom:view===v?"2px solid #FFD700":"2px solid transparent",cursor:"pointer",padding:"15px 14px",color:view===v?"#FFD700":"#444",fontFamily:"'Space Mono'",fontSize:10,letterSpacing:2,textTransform:"uppercase",transition:"color 0.15s"}}>{v}</button>
        ))}
        <div style={{flex:1}}/>
        <span style={{color:"#222",fontSize:9,letterSpacing:1}}>{cards.length} PROFILES</span>
      </div>

      <div style={{maxWidth:880,margin:"0 auto",padding:"36px 24px"}}>

        {view==="home"&&(
          <div style={{animation:"fadeUp 0.4s ease"}}>
            <div style={{textAlign:"center",marginBottom:52}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:60,letterSpacing:4,lineHeight:1,background:"linear-gradient(135deg,#FFD700,#FF8800)",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>CAREER ATTACK</div>
              <div style={{color:"#333",fontSize:10,letterSpacing:4,marginTop:8,textTransform:"uppercase"}}>who's most cracked — rated, ranked, no debate</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,marginBottom:52}}>
              {[{l:"Total Profiles",v:cards.length},{l:"Firms Represented",v:[...new Set(cards.map(c=>c.company))].length},{l:"Avg OVR",v:cards.length?avg:"—"}].map(s=>(
                <div key={s.l} style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:"22px 16px",textAlign:"center"}}>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:38,color:"#FFD700",lineHeight:1,textShadow:"0 0 12px #FFD70033"}}>{s.v}</div>
                  <div style={{color:"#333",fontSize:8,letterSpacing:2,marginTop:4,textTransform:"uppercase"}}>{s.l}</div>
                </div>
              ))}
            </div>
            {sorted.length>0&&(
              <>
                <div style={{color:"#2a2a2a",fontSize:9,letterSpacing:3,textTransform:"uppercase",marginBottom:20}}>TEAM OF THE YEAR</div>
                <div style={{display:"flex",gap:16,flexWrap:"wrap",justifyContent:"center",marginBottom:40}}>
                  {sorted.slice(0,Math.min(3,sorted.length)).map(c=><Card key={c.id} card={withMeta(c)} sz={0.85} onClick={()=>{setSel(c);setView("profile");}}/>)}
                </div>
                <div style={{background:"#0c0c0c",border:"1px solid #141414",borderRadius:8,padding:"20px 24px"}}>
                  <div style={{color:"#2a2a2a",fontSize:8,letterSpacing:3,textTransform:"uppercase",marginBottom:14}}>OVR DISTRIBUTION</div>
                  <Bell cards={cards} targetOvr={avg}/>
                </div>
              </>
            )}
            {cards.length===0&&(
              <div style={{textAlign:"center",padding:"60px 0"}}>
                <div style={{color:"#1a1a1a",fontFamily:"'Bebas Neue'",fontSize:28,letterSpacing:2}}>NO PROFILES YET</div>
                <div style={{color:"#2a2a2a",fontSize:9,marginTop:8,letterSpacing:1}}>screenshot a linkedin, we score it instantly</div>
                <button onClick={()=>setView("create")} style={{marginTop:20,background:"#FFD700",color:"#000",border:"none",padding:"11px 28px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:10,fontWeight:700,letterSpacing:3,textTransform:"uppercase"}}>CREATE FIRST CARD</button>
              </div>
            )}
          </div>
        )}

        {view==="create"&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:540,margin:"0 auto"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:28,letterSpacing:3,color:"#FFD700",marginBottom:2}}>{updating?"UPDATE CARD":"NEW CARD"}</div>
            <div style={{color:"#333",fontSize:9,letterSpacing:2,marginBottom:32,textTransform:"uppercase"}}>Find a LinkedIn profile, screenshot it, and we'll rate it</div>
            {step<3&&<Steps cur={step}/>}

            {step===0&&(
              <div style={{animation:"fadeUp 0.3s ease"}}>
                <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:10,padding:"26px 24px",marginBottom:14}}>
                  <div style={{color:"#FFD700",fontFamily:"'Bebas Neue'",fontSize:15,letterSpacing:2,marginBottom:14}}>1 — FIND THEIR LINKEDIN PROFILE</div>
                  <div style={{color:"#666",fontSize:11,lineHeight:1.9,marginBottom:10}}>Go to their LinkedIn. You want to capture the sections that tell the story — the more you include, the sharper the analysis.</div>
                  <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:18}}>
                    {[{s:"Experience",d:"job titles, companies, dates, role descriptions",req:true},{s:"Education",d:"university, degree, grades if visible",req:true},{s:"Awards / Honours",d:"prizes, competitions, academic distinctions",req:false},{s:"Metrics / About",d:"traction numbers, audience size, anything concrete",req:false}].map(x=>(
                      <div key={x.s} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:x.req?"#FFD700":"#333",marginTop:4,flexShrink:0}}/>
                        <div><span style={{color:x.req?"#aaa":"#444",fontSize:10,letterSpacing:0.5}}>{x.s}</span><span style={{color:"#2a2a2a",fontSize:9,marginLeft:8}}>{x.d}</span>{x.req&&<span style={{color:"#FFD70055",fontSize:8,marginLeft:6}}>essential</span>}</div>
                      </div>
                    ))}
                  </div>
                  <a href="https://linkedin.com" target="_blank" rel="noopener noreferrer" style={{display:"inline-flex",alignItems:"center",gap:8,background:"#0a66c2",color:"#fff",textDecoration:"none",padding:"9px 18px",borderRadius:5,fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>OPEN LINKEDIN ↗</a>
                </div>
                <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:10,padding:"26px 24px",marginBottom:20}}>
                  <div style={{color:"#FFD700",fontFamily:"'Bebas Neue'",fontSize:15,letterSpacing:2,marginBottom:14}}>2 — SCREENSHOT IT</div>
                  <div style={{color:"#666",fontSize:11,lineHeight:1.9,marginBottom:24}}>Hold these three keys at the same time. A crosshair appears — drag a box around just their <span style={{color:"#aaa"}}>Experience section</span>. Screenshot copies to clipboard, no saving needed. Once you've done that, repeat for their <span style={{color:"#aaa"}}>Education section</span>. You can paste both on the next page — multiple screenshots are fine.</div>
                  <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:8,marginBottom:18}}>
                    <Key label="⊞ WIN" sub="windows key" wide pressed={pk.win}/>
                    <span style={{color:"#333",fontSize:18,fontFamily:"'Bebas Neue'"}}>+</span>
                    <Key label="SHIFT" pressed={pk.shift}/>
                    <span style={{color:"#333",fontSize:18,fontFamily:"'Bebas Neue'"}}>+</span>
                    <Key label="S" pressed={pk.s}/>
                  </div>
                  <div style={{color:"#2a2a2a",fontSize:9,textAlign:"center",letterSpacing:1}}>What's it called? Snip & Sketch — press these keys to try, they'll light up</div>
                </div>
                <button onClick={()=>setStep(1)} style={{width:"100%",background:"#FFD700",color:"#000",border:"none",padding:"13px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:11,fontWeight:700,letterSpacing:3,textTransform:"uppercase"}}>GOT MY SCREENSHOTS →</button>
              </div>
            )}

            {step===1&&(
              <div style={{animation:"fadeUp 0.3s ease"}}>
                {imgs.length>0&&(
                  <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                    {imgs.map((im,i)=>(
                      <div key={i} style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,display:"flex",alignItems:"center",gap:10,padding:"8px 12px"}}>
                        <img src={im.preview} alt="" style={{width:56,height:36,objectFit:"cover",borderRadius:3,flexShrink:0}}/>
                        <span style={{color:"#444",fontSize:9,flex:1,letterSpacing:0.5}}>Screenshot {i+1}</span>
                        <button onClick={()=>setImgs(p=>p.filter((_,j)=>j!==i))} style={{background:"none",border:"none",color:"#333",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,padding:0}}>remove</button>
                      </div>
                    ))}
                  </div>
                )}
                <div
                  onDragOver={e=>{e.preventDefault();setDrag(true);}}
                  onDragLeave={()=>setDrag(false)}
                  onDrop={e=>{e.preventDefault();setDrag(false);Array.from(e.dataTransfer.files).forEach(addFile);}}
                  onClick={()=>fileRef.current?.click()}
                  style={{border:`2px dashed ${drag?"#FFD700":"#1e1e1e"}`,borderRadius:10,padding:"44px 24px",textAlign:"center",cursor:"pointer",background:drag?"#FFD70008":"#0a0a0a",transition:"all 0.2s",marginBottom:12}}>
                  <div style={{fontSize:28,marginBottom:12,opacity:0.3}}>⬆</div>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:20,letterSpacing:2,color:drag?"#FFD700":"#2e2e2e",marginBottom:6}}>{imgs.length>0?"ADD ANOTHER SCREENSHOT":"PASTE OR DROP HERE"}</div>
                  <div style={{color:"#FFD70066",fontSize:11,letterSpacing:1,marginBottom:4,fontFamily:"'Space Mono'"}}>Ctrl + V to paste from clipboard</div>
                  <div style={{color:"#1e1e1e",fontSize:9,letterSpacing:1}}>paste multiple if you have both Experience and Education screenshots</div>
                  <input ref={fileRef} type="file" accept="image/*" multiple style={{display:"none"}} onChange={e=>Array.from(e.target.files).forEach(addFile)}/>
                </div>
                {err&&<div style={{color:"#ff4444",fontSize:9,letterSpacing:1,marginBottom:12}}>{err}</div>}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <button className="ghost" onClick={()=>setStep(0)} style={{background:"none",border:"none",color:"#333",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase",padding:0,transition:"color 0.15s"}}>← BACK</button>
                  {imgs.length>0&&<button onClick={()=>setStep(2)} style={{background:"#FFD700",color:"#000",border:"none",padding:"10px 20px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>ANALYSE {imgs.length} SCREENSHOT{imgs.length>1?"S":""} →</button>}
                </div>
              </div>
            )}

            {step===2&&imgs.length>0&&(
              <div style={{animation:"fadeUp 0.3s ease"}}>
                <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                  {imgs.map((im,i)=>(
                    <div key={i} style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,overflow:"hidden"}}>
                      <img src={im.preview} alt="" style={{width:"100%",display:"block",maxHeight:140,objectFit:"cover",objectPosition:"top"}}/>
                    </div>
                  ))}
                  <button onClick={()=>setStep(1)} style={{background:"none",border:"none",color:"#333",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,padding:0,textDecoration:"underline",alignSelf:"flex-end"}}>edit screenshots</button>
                </div>
                {dupWarn&&(
                  <div style={{background:"#1a0a00",border:"1px solid #FF6B3533",borderRadius:8,padding:"14px 18px",marginBottom:14}}>
                    <div style={{color:"#FF6B35",fontSize:9,letterSpacing:2,textTransform:"uppercase",marginBottom:6}}>Profile already in database</div>
                    <div style={{color:"#666",fontSize:10,lineHeight:1.6,marginBottom:10}}><span style={{color:"#888"}}>{dupWarn.name}</span> ({dupWarn.company}) was already analysed. Update their card or skip?</div>
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>{setUpdating(dupWarn.id);setDupWarn(null);analyse(true);}} style={{background:"#FF6B35",color:"#000",border:"none",padding:"8px 16px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>UPDATE CARD</button>
                      <button onClick={()=>{setDupWarn(null);reset();}} style={{background:"none",border:"1px solid #333",color:"#555",padding:"8px 16px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:1,textTransform:"uppercase"}}>SKIP</button>
                    </div>
                  </div>
                )}
                {(extracting||scoring)&&(
                  <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:"14px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:12}}>
                    <div style={{width:14,height:14,border:"2px solid #FFD70033",borderTop:"2px solid #FFD700",borderRadius:"50%",animation:"spin 0.8s linear infinite",flexShrink:0}}/>
                    <span style={{color:"#444",fontSize:10,letterSpacing:1}}>{extracting?"Reading the profile…":"Calculating OVR…"}</span>
                  </div>
                )}
                {err&&<div style={{color:"#ff4444",fontSize:9,letterSpacing:1,marginBottom:12}}>{err}</div>}
                {!dupWarn&&<button onClick={()=>analyse(false)} disabled={extracting||scoring} style={{width:"100%",background:extracting||scoring?"#111":"#FFD700",color:extracting||scoring?"#333":"#000",border:"none",padding:"13px",borderRadius:5,cursor:extracting||scoring?"not-allowed":"pointer",fontFamily:"'Space Mono'",fontSize:11,fontWeight:700,letterSpacing:3,textTransform:"uppercase",transition:"background 0.15s"}}>
                  {extracting?"READING PROFILE…":scoring?"CALCULATING OVR…":"ANALYSE & GENERATE CARD"}
                </button>}
              </div>
            )}

            {step===3&&done&&(
              <div style={{textAlign:"center",animation:"fadeUp 0.5s ease"}}>
                {extracted&&(
                  <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:"14px 18px",marginBottom:16,textAlign:"left"}}>
                    <div style={{color:"#2a2a2a",fontSize:8,letterSpacing:2,marginBottom:10,textTransform:"uppercase"}}>Extracted from screenshots</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"6px 16px"}}>
                      {[["Name",extracted.name],["University",extracted.uni],["Company",extracted.company],["Role",extracted.role],["Age",extracted.age],["Cohort",extracted.year]].map(([l,v])=>(
                        <div key={l}><span style={{color:"#2a2a2a",fontSize:8,letterSpacing:1}}>{l}: </span><span style={{color:"#777",fontSize:9}}>{v||"—"}</span></div>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{display:"flex",justifyContent:"center",marginBottom:20}}><Card card={withMeta(done)} sz={1.05} onClick={()=>{setSel(done);setView("profile");}}/></div>
                {done.thesis&&<div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:18,marginBottom:14,textAlign:"left"}}>
                  <div style={{color:"#2a2a2a",fontSize:8,letterSpacing:2,marginBottom:8,textTransform:"uppercase"}}>Profile Thesis</div>
                  <div style={{color:"#888",fontSize:11,lineHeight:1.7}}>{done.thesis}</div>
                </div>}
                <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:"16px 20px",marginBottom:20}}>
                  <Bell cards={cards.filter(c=>c.id!==done.id)} targetOvr={done.OVR} acc={T(done.OVR).acc}/>
                  <div style={{color:"#333",fontSize:9,textAlign:"center",marginTop:6,letterSpacing:1}}>TOP {100-(done.percentile||50)}% · OVR {done.OVR}</div>
                </div>
                <div style={{display:"flex",gap:8,justifyContent:"center"}}>
                  <button onClick={reset} style={{background:"none",border:"1px solid #1e1e1e",color:"#555",padding:"10px 20px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>ADD ANOTHER</button>
                  <button onClick={()=>{setSel(done);setView("profile");}} style={{background:"#FFD700",color:"#000",border:"none",padding:"10px 22px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>VIEW PROFILE →</button>
                </div>
              </div>
            )}
          </div>
        )}

        {view==="leaderboard"&&(
          <div style={{animation:"fadeUp 0.4s ease"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-end",marginBottom:32}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:30,letterSpacing:3,color:"#FFD700"}}>LEADERBOARD</div>
                <div style={{color:"#333",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>{cards.length} profiles ranked by OVR</div>
              </div>
              <button onClick={()=>setView("create")} style={{background:"none",border:"1px solid #FFD70033",color:"#FFD700",padding:"8px 16px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase"}} onMouseEnter={e=>e.target.style.borderColor="#FFD70066"} onMouseLeave={e=>e.target.style.borderColor="#FFD70033"}>+ ADD PROFILE</button>
            </div>
            {sorted.length===0?(
              <div style={{textAlign:"center",padding:"64px 0",color:"#1a1a1a",fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:2}}>NO PROFILES YET</div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                <div style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr 52px 60px",padding:"8px 12px",gap:8,color:"#2a2a2a",fontSize:8,letterSpacing:2,textTransform:"uppercase",borderBottom:"1px solid #111",marginBottom:4}}>
                  <span>#</span><span>Name</span><span>University</span><span>Company / Role</span><span>OVR</span><span>Top %</span>
                </div>
                {sorted.map((c,i)=>{
                  const ct2=T(c.OVR);
                  return(
                    <div key={c.id} className="row" onClick={()=>{setSel(c);setView("profile");}} style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr 52px 60px 28px",padding:"12px 12px",gap:8,alignItems:"center",background:i%2===0?"#0a0a0a":"#0c0c0c",borderRadius:5,cursor:"pointer",border:"1px solid transparent",transition:"background 0.12s,border-color 0.12s"}}>
                      <span style={{fontFamily:"'Bebas Neue'",fontSize:18,color:i===0?"#FFD700":i===1?"#B0B0B0":i===2?"#CD7F32":"#282828"}}>{i+1}</span>
                      <div>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:15,letterSpacing:1,color:"#ddd"}}>{c.name}</div>
                        <div style={{fontSize:8,color:"#2e2e2e",letterSpacing:1,marginTop:1}}>CLASS OF {c.year||"—"}</div>
                      </div>
                      <div style={{fontSize:10,color:"#444",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.uni}</div>
                      <div>
                        <div style={{fontSize:10,color:ct2.acc,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.company}</div>
                        <div style={{fontSize:8,color:"#333",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.role}</div>
                      </div>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:ct2.acc}}>{c.OVR}</div>
                      <div style={{fontSize:9,color:"#444"}}>TOP {100-(c.percentile||50)}%</div>
                      <button className="delbtn" onClick={e=>{e.stopPropagation();if(confirm("Delete this card?"))deleteCard(c.id);}} style={{background:"none",border:"none",color:"#ff4444",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:10,padding:0,lineHeight:1}}>✕</button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {view==="profile"&&sel&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:640,margin:"0 auto"}}>
            {showShare&&<ShareCard card={sel} onClose={()=>setShowShare(false)}/>}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:28}}>
              <button className="ghost" onClick={()=>{setView("leaderboard");setSel(null);}} style={{background:"none",border:"none",color:"#333",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase",padding:0,transition:"color 0.15s"}}>← BACK</button>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>setShowShare(true)} style={{background:"#FFD700",color:"#000",border:"none",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>SHARE CARD</button>
                <button title="Profile changed? Look at it again" onClick={()=>{setUpdating(sel.id);setView("create");reset();setUpdating(sel.id);}} style={{background:"none",border:"1px solid #1e1e1e",color:"#444",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,letterSpacing:1,textTransform:"uppercase",transition:"border-color 0.15s,color 0.15s"}} onMouseEnter={e=>{e.target.style.borderColor="#FFD70055";e.target.style.color="#FFD700";}} onMouseLeave={e=>{e.target.style.borderColor="#1e1e1e";e.target.style.color="#444";}}>UPDATE</button>
                <button onClick={()=>{if(confirm("Delete this card?"))deleteCard(sel.id);}} style={{background:"none",border:"1px solid #1e1e1e",color:"#333",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,letterSpacing:1,textTransform:"uppercase",transition:"border-color 0.15s,color 0.15s"}} onMouseEnter={e=>{e.target.style.borderColor="#ff444455";e.target.style.color="#ff4444";}} onMouseLeave={e=>{e.target.style.borderColor="#1e1e1e";e.target.style.color="#333";}}>DELETE</button>
              </div>
            </div>
            {sel.moniker&&<div style={{fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:2,color:ct.acc,marginBottom:4,textAlign:"center",textShadow:`0 0 20px ${ct.acc}44`}}>{sel.moniker}</div>}
            <div style={{display:"flex",gap:24,flexWrap:"wrap",justifyContent:"center",marginBottom:28}}>
              <Card card={withMeta(sel)} sz={1}/>
              <div style={{flex:1,minWidth:200,display:"flex",flexDirection:"column",gap:14}}>
                <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:"16px 18px"}}>
                  <div style={{color:"#2a2a2a",fontSize:8,letterSpacing:2,marginBottom:12,textTransform:"uppercase"}}>Stat Breakdown <span style={{color:"#1e1e1e",fontSize:7}}>— hover for details</span></div>
                  {STATS.map(st=>{
                    const v=sel.stats[st];
                    const info=STAT_INFO[st];
                    return(
                      <div key={st} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <StatTooltip stat={st}>
                          <span style={{color:"#555",fontSize:9,minWidth:38,letterSpacing:1,cursor:"help",borderBottom:"1px dotted #333"}}>{st}</span>
                        </StatTooltip>
                        <div style={{flex:1,height:4,background:"#1a1a1a",borderRadius:2,overflow:"hidden"}}><div style={{width:`${v}%`,height:"100%",background:`linear-gradient(90deg,${info?.color||ct.acc}88,${info?.color||ct.acc})`,borderRadius:2}}/></div>
                        <span style={{color:"#ddd",fontSize:12,fontFamily:"'Bebas Neue'",minWidth:26,textAlign:"right"}}>{v}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{background:"#0f0f0f",border:`1px solid ${ct.acc}1a`,borderRadius:8,padding:"16px 18px",textAlign:"center"}}>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:58,color:ct.acc,lineHeight:1,textShadow:`0 0 18px ${ct.acc}55`}}>{sel.OVR}</div>
                  <div style={{color:"#2a2a2a",fontSize:8,letterSpacing:3,textTransform:"uppercase",marginBottom:6}}>OVERALL RATING</div>
                  {sel.archetype&&<div style={{color:ct.acc,fontSize:8,letterSpacing:1,marginBottom:12,opacity:0.7}}>{sel.archetype}</div>}
                  <Bell cards={cards.filter(c=>c.id!==sel.id)} targetOvr={sel.OVR} acc={ct.acc}/>
                  <div style={{color:"#333",fontSize:9,marginTop:6,letterSpacing:1}}>
                    {cards.length>=30
                      ?`Beta top ${100-(sel.percentile||50)}% · #${sorted.findIndex(c=>c.id===sel.id)+1} of ${cards.length}`
                      :`${T(sel.OVR).label} tier · #${sorted.findIndex(c=>c.id===sel.id)+1} of ${cards.length} analysed`
                    }
                  </div>
                  {cards.length<30&&<div style={{color:"#1e1e1e",fontSize:8,marginTop:4,letterSpacing:0.5}}>percentile unlocks at 30 profiles</div>}
                </div>

                {/* Confidence score — internal/operational */}
                <div style={{background:"#0a0a00",border:"1px solid #2a2200",borderRadius:8,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <span style={{color:"#3a3200",fontSize:8,letterSpacing:2,textTransform:"uppercase"}}>Evidence Confidence</span>
                    <span style={{fontFamily:"'Bebas Neue'",fontSize:14,letterSpacing:1,color:sel.confidence==="HIGH"?"#88cc00":sel.confidence==="LOW"?"#cc4400":"#cc8800"}}>{sel.confidence||"MEDIUM"}</span>
                  </div>
                  {sel.confidence_reason&&<div style={{color:"#2a2200",fontSize:9,lineHeight:1.5}}>{sel.confidence_reason}</div>}
                  <div style={{color:"#2a1a00",fontSize:8,marginTop:4,letterSpacing:0.5}}>⚠ internal — not shown publicly</div>
                </div>
              </div>
            </div>

            {/* Profile type + archetype row */}
            {(sel.profile_type||sel.archetype)&&(
              <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                {sel.profile_type&&<div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:5,padding:"6px 12px",fontSize:9,letterSpacing:1,textTransform:"uppercase",color:"#555"}}><span style={{color:"#2a2a2a",marginRight:6}}>TYPE</span>{sel.profile_type}</div>}
                {sel.archetype&&<div style={{background:"#0f0f0f",border:`1px solid ${ct.acc}22`,borderRadius:5,padding:"6px 12px",fontSize:9,letterSpacing:1,textTransform:"uppercase",color:ct.acc,opacity:0.7}}><span style={{color:"#2a2a2a",marginRight:6}}>BUILD</span>{sel.archetype}</div>}
              </div>
            )}

            {/* Profile thesis */}
            {sel.thesis&&(
              <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:"18px 20px",marginBottom:10}}>
                <div style={{color:"#2a2a2a",fontSize:8,letterSpacing:2,marginBottom:10,textTransform:"uppercase"}}>Profile Thesis</div>
                <div style={{color:"#888",fontSize:12,lineHeight:1.85}}>{sel.thesis}</div>
              </div>
            )}

            {/* Expanded analysis */}
            {(sel.best_signal||sel.traits||sel.floor)&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr",gap:8,marginBottom:10}}>
                {[
                  {k:"best_signal",label:"Best Signal",icon:"◈",v:sel.best_signal},
                  {k:"weak_signal",label:"Weakest Signal",icon:"◇",v:sel.weak_signal},
                  {k:"traits",label:"What This Signals",icon:"◉",v:sel.traits},
                  {k:"not_proven",label:"What It Does Not Prove",icon:"✕",v:sel.not_proven},
                  {k:"peer_calibration",label:"Peer Calibration",icon:"⊕",v:sel.peer_calibration},
                  {k:"floor",label:"Floor",icon:"▼",v:sel.floor},
                  {k:"base_case",label:"Base Case",icon:"◆",v:sel.base_case},
                  {k:"ceiling",label:"Ceiling",icon:"▲",v:sel.ceiling},
                  {k:"upgrade",label:"Fastest Upgrade",icon:"↑",v:sel.upgrade},
                ].filter(s=>s.v).map(s=>(
                  <div key={s.k} style={{background:"#0c0c0c",border:"1px solid #141414",borderRadius:8,padding:"12px 18px",display:"flex",gap:10}}>
                    <span style={{color:ct.acc,fontSize:10,flexShrink:0,marginTop:2,width:12}}>{s.icon}</span>
                    <div>
                      <div style={{color:"#2e2e2e",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>{s.label}</div>
                      <div style={{color:"#666",fontSize:11,lineHeight:1.7}}>{s.v}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Profile details */}
            <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:"18px 20px"}}>
              <div style={{color:"#2a2a2a",fontSize:8,letterSpacing:2,marginBottom:14,textTransform:"uppercase"}}>Profile Details</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[{l:"University",v:sel.uni},{l:"Company",v:sel.company},{l:"Role",v:sel.role},{l:"Age",v:sel.age},{l:"Cohort",v:sel.year||"—"},{l:"How Secured",v:sel.how},{l:"Prior Internships",v:sel.prev}].map(d=>(
                  <div key={d.l}><div style={{color:"#2a2a2a",fontSize:8,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>{d.l}</div><div style={{color:"#888",fontSize:11}}>{d.v}</div></div>
                ))}
              </div>
              {sel.acts&&sel.acts!=="None"&&<div style={{marginTop:12,borderTop:"1px solid #141414",paddingTop:12}}><div style={{color:"#2a2a2a",fontSize:8,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Activities</div><div style={{color:"#555",fontSize:10,lineHeight:1.6}}>{sel.acts}</div></div>}
            </div>
          </div>
        )}

        {view==="guide"&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:660,margin:"0 auto"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:30,letterSpacing:3,color:"#FFD700",marginBottom:4}}>HOW IT WORKS</div>
            <div style={{color:"#333",fontSize:9,letterSpacing:2,marginBottom:32,textTransform:"uppercase"}}>the scoring system, the stats, and what we're actually measuring</div>

            {/* Philosophy */}
            <div style={{background:"#0f0f0f",border:"1px solid #FFD70022",borderRadius:8,padding:"20px 22px",marginBottom:14}}>
              <div style={{color:"#FFD700",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:10}}>THE PHILOSOPHY</div>
              <div style={{color:"#555",fontSize:11,lineHeight:1.8}}>We are not ranking human worth. We are ranking <span style={{color:"#888"}}>visible early-career signal</span> — how strong, rare, fast, coherent, and substantiated someone's profile appears from the outside. LinkedIn is fake as hell sometimes. It captures signalling, not soul. It can suggest traits, but it cannot prove character, integrity, humility, work ethic, or depth. This system is a FIFA OVR for public career signal, plus a scouting report explaining what the score actually means.</div>
            </div>

            {/* OVR formula */}
            <div style={{background:"#0f0f0f",border:"1px solid #151515",borderRadius:8,padding:"20px 22px",marginBottom:14}}>
              <div style={{color:"#FFD700",fontFamily:"'Bebas Neue'",fontSize:16,letterSpacing:2,marginBottom:10}}>WHAT DRIVES THE OVR</div>
              <div style={{color:"#555",fontSize:11,lineHeight:1.9,marginBottom:14}}>Six categories feed the OVR. Each measures a distinct dimension — they are designed to not overlap. The weighting is internal and will be tuned as more profiles are added.</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
                {[{s:"PRES",c:"#FFD700",l:"Prestige",d:"Where you landed"},{s:"STACK",c:"#A855F7",l:"Stack",d:"How it compounds"},{s:"REACH",c:"#FF6B35",l:"Reach",d:"How far above expected"},{s:"PACE",c:"#00E5FF",l:"Pace",d:"How compressed"},{s:"DEPTH",c:"#F43F5E",l:"Depth",d:"Real proof of skill"},{s:"RARE",c:"#10B981",l:"Rarity",d:"How unusual the combo"}].map(x=>(
                  <div key={x.s} style={{display:"flex",alignItems:"center",gap:8,background:"#0c0c0c",borderRadius:5,padding:"8px 10px"}}>
                    <div style={{width:28,height:28,borderRadius:3,background:`${x.c}14`,border:`1px solid ${x.c}33`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:11,color:x.c,flexShrink:0}}>{x.s}</div>
                    <div><div style={{color:x.c,fontSize:9,letterSpacing:0.5}}>{x.l}</div><div style={{color:"#2a2a2a",fontSize:8}}>{x.d}</div></div>
                  </div>
                ))}
              </div>
              <div style={{color:"#2a2a2a",fontSize:8,marginTop:12,lineHeight:1.6}}>A stage modifier (−5 to +8) adjusts the final score based on how early in the career timeline the achievement was reached. This is separate from the six categories and is not a full stat.</div>
            </div>

            {/* Percentile note */}
            <div style={{background:"#0c0c0c",border:"1px solid #1a1a1a",borderRadius:8,padding:"16px 20px",marginBottom:14}}>
              <div style={{color:"#FFD700",fontFamily:"'Bebas Neue'",fontSize:14,letterSpacing:2,marginBottom:8}}>ABOUT THE PERCENTILE</div>
              <div style={{color:"#444",fontSize:10,lineHeight:1.8}}>Percentiles are based on the current analysed profile pool and will shift as more profiles are added. Early beta percentiles are <span style={{color:"#888"}}>directional, not population-wide claims</span> — they compare you against profiles that have been run through the system, not against all students or all LinkedIn users.</div>
              <div style={{color:"#2a2a2a",fontSize:9,marginTop:8}}>The percentile unlocks once the pool reaches 30 profiles. Before that, profiles show their tier band instead.</div>
            </div>

            {/* Stat cards */}
            {STATS.map(st=>{
              const info=STAT_INFO[st];
              return(
                <div key={st} style={{background:"#0c0c0c",border:`1px solid ${info.color}18`,borderRadius:8,padding:"20px 22px",marginBottom:10}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <div style={{width:36,height:36,borderRadius:4,background:`${info.color}14`,border:`1px solid ${info.color}33`,display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:14,color:info.color,letterSpacing:1}}>{st}</div>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:info.color}}>{info.full}</div>
                  </div>
                  <div style={{color:"#666",fontSize:11,lineHeight:1.75,marginBottom:12}}>{info.desc}</div>
                  <div style={{display:"flex",flexDirection:"column",gap:4}}>
                    {info.examples.map((ex,i)=>(
                      <div key={i} style={{display:"flex",alignItems:"center",gap:8}}>
                        <div style={{width:3,height:3,borderRadius:"50%",background:info.color,opacity:0.5,flexShrink:0}}/>
                        <span style={{color:"#333",fontSize:9,letterSpacing:0.5}}>{ex}</span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}

            {/* Age modifier */}
            <div style={{background:"#0c0c0c",border:"1px solid #ffffff0a",borderRadius:8,padding:"20px 22px",marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                <div style={{width:36,height:36,borderRadius:4,background:"#ffffff0a",border:"1px solid #ffffff14",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:11,color:"#888",letterSpacing:1}}>AGE</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:"#888"}}>Age — Stage Compression Modifier</div>
              </div>
              <div style={{color:"#555",fontSize:11,lineHeight:1.75,marginBottom:12}}>Age is a modifier, not a full stat, because it would double-count with Pace. Instead it applies a small adjustment based on academic stage. A 24-year-old who founded a company, served in the military, or switched countries is not penalised. Context matters. Pace rewards compressed progress — not youth worship.</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr auto",gap:"4px 16px",color:"#2a2a2a",fontSize:9,letterSpacing:0.5}}>
                {[["Sixth form landing real elite signal","+7 to +8"],["First year, penultimate-level opportunity","+5 to +7"],["First year, spring or niche role","+3 to +5"],["Penultimate year, expected elite internship","0 to +2"],["Final year with return offer","0 to +2"],["22–24, strong trajectory","0"],["24+, same milestone as peers, no context","−2 to −5"]].map(([s,v])=>(
                  <>
                  <span key={s+1}>{s}</span>
                  <span key={s+2} style={{textAlign:"right",color:"#444"}}>{v}</span>
                  </>
                ))}
              </div>
            </div>

            {/* Score bands */}
            <div style={{background:"#0c0c0c",border:"1px solid #1a1a1a",borderRadius:8,padding:"20px 22px",marginBottom:10}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:"#ddd",marginBottom:14}}>SCORE BANDS</div>
              {[
                {range:"95–99",label:"Generational",color:"#FFD700",desc:"Multiple elite signals simultaneously. Real output. Young. Unique narrative. Rare as hell — do not hand this out casually."},
                {range:"90–94",label:"Nationally Elite",color:"#FFD700",desc:"Top-tier among ambitious students. GS/MBB-level outcome with coherent stack and some rarity."},
                {range:"85–89",label:"Very Elite",color:"#99b0ff",desc:"High-conviction profile. Serious enough to attract elite recruiters, founders, or investors."},
                {range:"75–84",label:"Strong Standout",color:"#99b0ff",desc:"Very good, not yet nationally elite. Good uni, strong internships, leadership, some narrative."},
                {range:"65–74",label:"Solid Ambitious",color:"#d0d0d0",desc:"Good but common among career-focused students."},
                {range:"50–64",label:"Normal LinkedIn Competence",color:"#d0d0d0",desc:"Not bad. Just not special."},
                {range:"Under 50",label:"Weak Signal",color:"#ee9900",desc:"Little evidence, generic roles, no direction, or mostly inflated language."},
              ].map(b=>(
                <div key={b.range} style={{display:"flex",gap:14,alignItems:"flex-start",marginBottom:12,paddingBottom:12,borderBottom:"1px solid #111"}}>
                  <div style={{minWidth:56,textAlign:"right",fontFamily:"'Bebas Neue'",fontSize:20,color:b.color,lineHeight:1}}>{b.range}</div>
                  <div>
                    <div style={{color:"#aaa",fontSize:10,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>{b.label}</div>
                    <div style={{color:"#444",fontSize:10,lineHeight:1.6}}>{b.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* Anti-double-counting */}
            <div style={{background:"#0c0c0c",border:"1px solid #1a1a1a",borderRadius:8,padding:"20px 22px",marginBottom:10}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:"#ddd",marginBottom:14}}>ANTI-DOUBLE-COUNTING RULES</div>
              {[
                {n:"1",t:"Prestige is absolute","d":"Goldman is Goldman whether from Cambridge or Coventry. Never include background in PRES."},
                {n:"2",t:"Reach is contextual","d":"Only Reach rewards non-target school, unusual degree, low access, or socioeconomic context."},
                {n:"3",t:"Pace is stage-based","d":"First-year vs penultimate matters more than age 19 vs 20. Don't let raw age dominate."},
                {n:"4",t:"Rarity is configuration-based","d":"Rarity asks 'how common is this exact combination?' — not 'how hard was their path?' (that's Reach)."},
                {n:"5",t:"Stack requires coherence","d":"Random achievements don't compound. They clutter. Dilettantism is penalised."},
                {n:"6",t:"Depth protects against LinkedIn fraudulence","d":"No real proof = no monster score. Prestige gets you noticed. Depth tells us if there's a person behind the logo."},
              ].map(r=>(
                <div key={r.n} style={{display:"flex",gap:12,marginBottom:10}}>
                  <span style={{color:"#FFD700",fontFamily:"'Bebas Neue'",fontSize:14,flexShrink:0,width:14}}>{r.n}</span>
                  <div>
                    <span style={{color:"#888",fontSize:10,letterSpacing:0.5}}>{r.t} — </span>
                    <span style={{color:"#444",fontSize:10,lineHeight:1.6}}>{r.d}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Scouting report */}
            <div style={{background:"#0c0c0c",border:"1px solid #1a1a1a",borderRadius:8,padding:"20px 22px"}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:18,letterSpacing:2,color:"#ddd",marginBottom:6}}>SCOUTING REPORT BREAKDOWN</div>
              <div style={{color:"#444",fontSize:10,lineHeight:1.75,marginBottom:16}}>Every sentence must do one of four jobs: <span style={{color:"#888"}}>cite visible evidence, interpret what it means, explain what it does not prove, or calibrate against the right peer group.</span> The formula is Evidence → Inference → Caveat. Aesthetic language without evidence behind it is a calibration error.</div>
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
                  <span style={{color:"#FFD700",fontSize:10,flexShrink:0,marginTop:2,width:12}}>{s.icon}</span>
                  <div>
                    <span style={{color:"#aaa",fontSize:10,letterSpacing:0.5}}>{s.l} — </span>
                    <span style={{color:"#444",fontSize:10,lineHeight:1.6}}>{s.d}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>
      <div style={{borderTop:"1px solid #0f0f0f",padding:"20px 28px",display:"flex",justifyContent:"center"}}>
        <span style={{color:"#1e1e1e",fontSize:9,letterSpacing:2,textTransform:"uppercase",fontFamily:"'Space Mono',monospace"}}>Made by Jammal &amp; Claude</span>
      </div>
    </div>
  );
}
