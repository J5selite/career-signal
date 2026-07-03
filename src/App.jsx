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
- grades: visible academic results (A-levels, GCSEs, degree class, GPA, scholarships) as a string, or "Not visible"
- timeline: chronological list of roles with dates, e.g. "Jun 2023 spring week at X; Jul 2024 SWE intern at Y (10 wks); Sep 2024 co-founded Z" — keep dates, or "Not visible"
- evidence: concrete, near-verbatim artifacts and numbers from role/project descriptions (what was built, with what tech, for whom, any users/revenue/results/awards) — semicolon separated, or "None visible". Copy specifics, do not summarise into adjectives.
- notes: anything notable — non-target school, unusual background, startup traction signals, first from uni, context (military service, country switch), etc. Be specific.
- profile_type: classify as "finance", "technical", "founder", or "technical_founder" based on the dominant signal

Return ONLY: {"name":"...","uni":"...","year":"...","age":21,"company":"...","role":"...","how":"internship","prev":"1","acts":"...","grades":"...","timeline":"...","evidence":"...","notes":"...","profile_type":"finance"}`;

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

═══ STAT DEFINITIONS & ANCHORS ═══

PRES — Seat Selectivity (weight 20%)
"How hard is it to be admitted to the seats on this profile?" Judged by offer/admission rates and competition for the seat — not fame, not background. A selective degree course is a seat too.
Lens by profile type: FINANCE — firm + desk halo dominates (GS IBD ≠ GS ops; Goldman is Goldman whether from Cambridge or Coventry). TECHNICAL — course selectivity + employer hiring bar. FOUNDER — selectivity of BACKING (YC batch, funded round, selective accelerator). A self-created founder title carries NO selectivity by itself: anyone can print the title. An unbacked founder's credit lives in DEPTH (what they built) and PACE (how early), not here.
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
Do NOT output an overall score. The app computes OVR = PRES×0.20 + PACE×0.15 + REACH×0.15 + STACK×0.20 + RARE×0.05 + DEPTH×0.25 from your six numbers. Your job is six honest, independent stats.

═══ ANTI-HALLUCINATION RULES ═══
Non-negotiable. Only describe what is VISIBLE in the evidence.
- Label every inference: "this suggests", "the visible evidence implies" — never state motivations, choices, or character as fact.
BAD: "He walked away from Goldman." GOOD: "The visible profile does not show a traditional elite internship route, so the path currently reads as self-directed rather than institutionally validated."
BAD: "A deliberate builder who avoids the corporate grind." GOOD: "No corporate internship is visible — which could indicate a deliberate founder path, or simply evidence not yet on the profile."
- Never claim a firm is elite unless you recognise it; if unknown, call it "an early-stage company with no publicly visible traction".
- If a section (e.g. education) is missing, acknowledge the gap rather than assume.

═══ CLASSIFICATION ═══
profile_type — the scoring lens for PRES. Choose the most accurate: "Finance / Consulting", "Technical Builder", "Founder", "Technical Founder", "Creator / Media", "Research / Academic", "Policy / Social Impact", "Generalist Operator", "Hybrid".
archetype — the narrative build: "Technical Founder Prospect", "Non-Target Breakout", "Prestige Stacker", "Platform Builder", "Applied AI Builder", "Creator-Operator Hybrid", "Research-Led Operator", "Finance Track Climber", "Academic Weapon", "High-Agency Generalist", "Founder Bet".
confidence — evidence quality: "HIGH" (education + experience + detailed descriptions all visible), "MEDIUM" (some detail, key sections missing), "LOW" (titles without context, or major sections absent).
confidence_reason — one sentence: what evidence was present and what was missing.

═══ SCOUTING REPORT ═══
Every sentence must do one of four jobs: cite visible evidence, interpret it (labelled as inference), state what it does not prove, or calibrate against the right peer group. Formula: EVIDENCE → INFERENCE → CAVEAT.
- moniker: 2-4 word punchy nickname grounded in what the profile actually shows.
- thesis: one paragraph — the core read in one sentence using evidence, what makes it coherent or incoherent, and the central tension.
- best_signal: "Best signal: [specific visible evidence]. That suggests [labelled inference]. [Caveat]."
- weak_signal: the deeper missing category of validation, not just the surface gap.
- traits: what the path signals about agency and direction — every inference labelled.
- not_proven: specific capabilities not yet evidenced, calibrated to the exact peer group.
- peer_calibration: three named reference groups — general student population, exact peer group, and the elite tier above — with what each step up would require.
- floor / base_case / ceiling: realistic minimum, most likely, and best outcome — name specific roles and company types, and what would unlock the ceiling.
- upgrade: the single most concrete thing that would improve this profile fastest.

Return ONLY valid JSON, no markdown, no backticks:
{"PRES":X,"PACE":X,"REACH":X,"STACK":X,"RARE":X,"DEPTH":X,"stat_reasons":{"PRES":"one sentence citing the evidence used","PACE":"...","REACH":"...","STACK":"...","RARE":"...","DEPTH":"..."},"profile_type":"...","archetype":"...","confidence":"HIGH|MEDIUM|LOW","confidence_reason":"...","moniker":"...","thesis":"...","best_signal":"...","weak_signal":"...","traits":"...","not_proven":"...","peer_calibration":"...","floor":"...","base_case":"...","ceiling":"...","upgrade":"..."}`;

function erf(x){const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;const s=x<0?-1:1;x=Math.abs(x);const t=1/(1+p*x);return s*(1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));}
function getPct(cards,ovr){if(cards.length<5){const z=(ovr-58)/13;return Math.min(99,Math.max(1,Math.round(50*(1+erf(z/Math.sqrt(2))))));}return Math.min(99,Math.max(1,Math.round((cards.filter(c=>c.OVR<ovr).length/cards.length)*100)));}
function T(ovr){if(ovr>=88)return{bg:"#0b0700",strip:"#FFD700",stripD:"#8a5c00",acc:"#FFD700",glow:"#FFD70044",label:"ELITE",dot:"0.07"};if(ovr>=78)return{bg:"#060610",strip:"#8fa8ff",stripD:"#3348bb",acc:"#99b0ff",glow:"#8fa8ff44",label:"RARE",dot:"0.07"};if(ovr>=65)return{bg:"#090909",strip:"#c0c0c0",stripD:"#555",acc:"#d0d0d0",glow:"#cccccc33",label:"UNCOMMON",dot:"0.05"};return{bg:"#080600",strip:"#dd8800",stripD:"#6a3d00",acc:"#ee9900",glow:"#dd880033",label:"STANDARD",dot:"0.05"};}
function S(ovr){return ovr>=90?5:ovr>=80?4:ovr>=70?3:ovr>=60?2:1;}
const A=(c,p)=>`color-mix(in srgb, ${c} ${p}%, transparent)`;
const STATS=["PRES","PACE","REACH","STACK","RARE","DEPTH"];

const STAT_INFO={
  PRES:{full:"Prestige — Seat Selectivity · 20%",color:"var(--gold)",desc:"How hard is it to be ADMITTED to the seats on this profile? Judged on offer rates and competition — not fame, not background. A selective degree course counts as a seat. A self-created founder title doesn't: anyone can print one — unbacked founders earn credit in Depth and Pace instead.",examples:["Jane Street/GS IBD/MBB/DeepMind/YC batch → 90-99","Top EB, FAANG intern, Oxbridge competitive course → 70-89","Strong uni + recognised scheme → 50-69","Open-entry roles only (societies, ambassador) → 30-49"]},
  PACE:{full:"Pace — Stage-Adjusted Earliness · 15%",color:"var(--c-pace)",desc:"How far ahead of the standard recruitment timeline is each milestone? Age lives here — there is no separate age bonus anywhere in the system. Military service, illness, founding, or switching countries never count as 'behind'.",examples:["2+ years ahead (pre-uni elite exposure) → 90-99","~1 year ahead (Y1 spring / early elite summer) → 70-89","On schedule → 50-69","Behind with no visible context → 1-49"]},
  REACH:{full:"Reach — Contextual Overperformance · 15%",color:"var(--c-reach)",desc:"Given the visible starting context, how far above expectation did they land? The ONLY stat where background, school type and access count. If the starting context isn't visible, this sits near 50 — unknown is neither good nor bad.",examples:["Non-target / adverse context → elite destination → 90-99","Semi-target → BB front office → 70-89","On-script for the platform (Oxbridge → GS) → 50-69","Elite platform → weak destination, no context → 1-49"]},
  STACK:{full:"Stack — Compounding Narrative · 20%",color:"var(--c-stack)",desc:"Do the assets reinforce one thesis, or is it a LinkedIn buffet? Judged on coherence, not fame — an unknown startup with real technical work can compound a builder narrative better than a random famous badge.",examples:["3+ assets, each building on the last → 90-99","Clear 2-3 asset thread → 70-89","A direction is guessable → 50-69","Accumulation without direction → 30-49"]},
  RARE:{full:"Rarity — Configuration Scarcity · 5%",color:"var(--c-rare)",desc:"Of 1,000 random career-focused profiles, how many look like this one? Deliberately the lowest weight: scarcity is the hardest thing to estimate from a screenshot, so it seasons the OVR rather than swinging it.",examples:["~1 in 1,000 → 90-99","~10 in 1,000 → 70-89","~50 in 1,000 → 50-69","Interchangeable with peers → 1-49"]},
  DEPTH:{full:"Depth — Verified Output · 25%",color:"var(--c-depth)",desc:"What does the evidence prove they can actually DO? Deliberately the highest weight: output is the only signal that can't be bought with a brand name or inflated language. Prestige gets you noticed — Depth is whether there's a person behind the logo.",examples:["Verifiable results: users, revenue, publication, national win → 90-99","Concrete artifacts described, or spring→summer conversion → 70-89","Serious seat, nothing described → 50-69","Titles or buzzwords only → 1-49"]},
};

function StatTooltip({stat,children}){
  const [show,setShow]=useState(false);
  const info=STAT_INFO[stat];
  return(
    <div style={{position:"relative",display:"inline-flex",alignItems:"center"}} onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
      {children}
      {show&&info&&(
        <div style={{position:"absolute",bottom:"calc(100% + 8px)",left:"50%",transform:"translateX(-50%)",width:220,background:"var(--s11)",border:`1px solid ${A(info.color,20)}`,borderRadius:6,padding:"10px 12px",zIndex:50,pointerEvents:"none"}}>
          <div style={{color:info.color,fontFamily:"'Bebas Neue'",fontSize:13,letterSpacing:1,marginBottom:4}}>{info.full}</div>
          <div style={{color:"var(--v888)",fontSize:9,lineHeight:1.6,marginBottom:6}}>{info.desc}</div>
          <div style={{display:"flex",flexDirection:"column",gap:2}}>
            {info.examples.map((ex,i)=><div key={i} style={{color:"var(--v444)",fontSize:8,letterSpacing:0.5}}>· {ex}</div>)}
          </div>
          <div style={{position:"absolute",bottom:-5,left:"50%",width:8,height:8,background:"var(--s11)",border:`1px solid ${A(info.color,20)}`,borderRight:"none",borderTop:"none",transform:"translateX(-50%) rotate(-45deg)"}}/>
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
            <div style={{color:t.acc,fontSize:9,letterSpacing:2,opacity:0.5}}>CAREER ATTACK</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:12,justifyContent:"center"}}>
          <div style={{color:"var(--v333)",fontSize:9,letterSpacing:1,fontFamily:"'Space Mono',monospace",textAlign:"center"}}>take a screenshot to share · press esc to close</div>
        </div>
        <button onClick={onClose} style={{display:"block",margin:"8px auto 0",background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>CLOSE</button>
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
  const [done,setDone]=useState(null);
  const [err,setErr]=useState("");
  const [drag,setDrag]=useState(false);
  const [pk,setPk]=useState({});
  const [dupWarn,setDupWarn]=useState(null);
  const [updating,setUpdating]=useState(null);
  const [showShare,setShowShare]=useState(false);
  const fileRef=useRef();
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem("ca_theme")||"dark";}catch{return "dark";}});

  useEffect(()=>{
    const root=document.documentElement;
    root.classList.remove("theme-dark","theme-light");
    root.classList.add(theme==="light"?"theme-light":"theme-dark");
    document.body.style.background=theme==="light"?"#f4f2ec":"#080808";
    try{localStorage.setItem("ca_theme",theme);}catch{}
  },[theme]);

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
      const r1=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1600,messages:[{role:"user",content:[...imgBlocks,{type:"text",text:EXTRACT_PROMPT}]}]})});
      const d1=await r1.json();
      if(d1.error)throw new Error(`API error: ${d1.error.message}`);
      const ex=repairJSON(d1.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      setExtracted(ex);
      if(!forceUpdate&&!updating){
        const dup=checkDup(ex.name);
        if(dup){setDupWarn(dup);setExtracting(false);return;}
      }
      setExtracting(false);setScoring(true);
      const msg=`Profile type: ${ex.profile_type||"finance"}\nName: ${ex.name}\nUniversity: ${ex.uni}\nAge: ${ex.age}\nCompany: ${ex.company}\nRole: ${ex.role}\nHow secured: ${ex.how}\nPrior internships/roles: ${ex.prev}\nGrades / academic record: ${ex.grades||"Not visible"}\nTimeline (roles with dates): ${ex.timeline||"Not visible"}\nConcrete evidence quotes: ${ex.evidence||"None visible"}\nActivities: ${ex.acts||"None"}\nNotes (background, traction signals, context): ${ex.notes||"None"}`;
      const r2=await fetch("/api/anthropic",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:3500,system:SCORE_PROMPT,messages:[{role:"user",content:msg}]})});
      const d2=await r2.json();
      if(d2.error)throw new Error(`Scoring error: ${d2.error.message}`);
      const sc=repairJSON(d2.content.map(b=>b.text||"").join("").replace(/```json|```/g,"").trim());
      // The model returns six independent stats; the app owns the OVR arithmetic so the
      // formula is always applied exactly (LLMs are unreliable at weighted sums).
      const cl=v=>Math.min(99,Math.max(1,Math.round(Number(v)||50)));
      const stats={PRES:cl(sc.PRES),PACE:cl(sc.PACE),REACH:cl(sc.REACH),STACK:cl(sc.STACK),RARE:cl(sc.RARE),DEPTH:cl(sc.DEPTH)};
      const OVR=cl(stats.PRES*0.20+stats.PACE*0.15+stats.REACH*0.15+stats.STACK*0.20+stats.RARE*0.05+stats.DEPTH*0.25);
      const all=[...cards];
      const uid=updating||Date.now().toString();
      const newCard={id:uid,...ex,stats,OVR,stat_reasons:sc.stat_reasons||null,profile_type:sc.profile_type||ex.profile_type||"Finance / Consulting",archetype:sc.archetype||null,confidence:sc.confidence||"MEDIUM",confidence_reason:sc.confidence_reason||null,moniker:sc.moniker||null,thesis:sc.thesis||null,best_signal:sc.best_signal||null,weak_signal:sc.weak_signal||null,traits:sc.traits||null,not_proven:sc.not_proven||null,peer_calibration:sc.peer_calibration||null,floor:sc.floor||null,base_case:sc.base_case||null,ceiling:sc.ceiling||null,upgrade:sc.upgrade||null,percentile:0,createdAt:updating?(all.find(c=>c.id===uid)?.createdAt||new Date().toISOString()):new Date().toISOString(),updatedAt:updating?new Date().toISOString():undefined};
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
  const ct=sel?T(sel.OVR):{acc:"var(--gold)"};
  const withMeta=c=>({...c,_totalCards:cards.length});

  return(
    <div style={{minHeight:"100vh",background:"var(--bg)",color:"var(--veee)",fontFamily:"'Space Mono',monospace"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Space+Mono:wght@400;700&display=swap');
        html.theme-dark{
          --bg:#080808;--s0a:#0a0a0a;--s0c:#0c0c0c;--s0f:#0f0f0f;--s11:#111;--s16:#161616;
          --b14:#141414;--b15:#151515;
          --v1a:#1a1a1a;--v1e:#1e1e1e;--v222:#222;--v2a:#2a2a2a;--v2e:#2e2e2e;--v333:#333;--v444:#444;--v555:#555;--v666:#666;--v777:#777;--v888:#888;--vaaa:#aaa;--vddd:#ddd;--veee:#eee;
          --gold:#FFD700;--gold2:#FF8800;--gold-deep:#aa8800;--gold-ink:#000;
          --c-pace:#00E5FF;--c-reach:#FF6B35;--c-stack:#A855F7;--c-rare:#10B981;--c-depth:#F43F5E;
          --warn-bg:#1a0a00;--conf-bg:#0a0a00;--conf-dim:#2a2200;--conf-label:#3a3200;--axis:#ffffff18;
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
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:var(--s0a)}::-webkit-scrollbar-thumb{background:var(--v222)}
        .row:hover{background:var(--s11)!important;border-color:color-mix(in srgb, var(--gold) 13%, transparent)!important}
        .ghost:hover{color:var(--gold)!important}
        .delbtn{opacity:0;transition:opacity 0.15s}.row:hover .delbtn{opacity:1}
      `}</style>

      <div style={{display:"flex",alignItems:"center",borderBottom:"1px solid var(--s11)",background:"var(--bg)",padding:"0 28px",position:"sticky",top:0,zIndex:100}}>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:20,letterSpacing:3,color:"var(--gold)",marginRight:36,padding:"15px 0",textShadow:"0 0 18px color-mix(in srgb, var(--gold) 27%, transparent)",cursor:"pointer"}} onClick={()=>{setView("home");reset();setSel(null);}}>CAREER ATTACK</div>
        {["home","create","leaderboard","guide"].map(v=>(
          <button key={v} className="ghost" onClick={()=>{setView(v);reset();setSel(null);}} style={{background:"none",border:"none",borderBottom:view===v?"2px solid var(--gold)":"2px solid transparent",cursor:"pointer",padding:"15px 14px",color:view===v?"var(--gold)":"var(--v444)",fontFamily:"'Space Mono'",fontSize:10,letterSpacing:2,textTransform:"uppercase",transition:"color 0.15s"}}>{v}</button>
        ))}
        <div style={{flex:1}}/>
        <button onClick={()=>setTheme(t=>t==="dark"?"light":"dark")} title={theme==="dark"?"Switch to light mode":"Switch to dark mode"} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v444)",borderRadius:5,padding:"4px 11px",cursor:"pointer",fontFamily:"'Space Mono',monospace",fontSize:11,lineHeight:1.4,marginRight:14,transition:"color 0.15s,border-color 0.15s"}} onMouseEnter={e=>{e.target.style.color="var(--gold)";e.target.style.borderColor="var(--gold)";}} onMouseLeave={e=>{e.target.style.color="var(--v444)";e.target.style.borderColor="var(--v1e)";}}>{theme==="dark"?"☀":"☾"}</button>
        <span style={{color:"var(--v222)",fontSize:9,letterSpacing:1}}>{cards.length} PROFILES</span>
      </div>

      <div style={{maxWidth:880,margin:"0 auto",padding:"36px 24px"}}>

        {view==="home"&&(
          <div style={{animation:"fadeUp 0.4s ease"}}>
            <div style={{textAlign:"center",marginBottom:52}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:60,letterSpacing:4,lineHeight:1,background:"linear-gradient(135deg,var(--gold),var(--gold2))",WebkitBackgroundClip:"text",WebkitTextFillColor:"transparent"}}>CAREER ATTACK</div>
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
                <div style={{color:"var(--v2a)",fontSize:9,letterSpacing:3,textTransform:"uppercase",marginBottom:20}}>TEAM OF THE YEAR</div>
                <div style={{display:"flex",gap:16,flexWrap:"wrap",justifyContent:"center",marginBottom:40}}>
                  {sorted.slice(0,Math.min(3,sorted.length)).map(c=><Card key={c.id} card={withMeta(c)} sz={0.85} onClick={()=>{setSel(c);setView("profile");}}/>)}
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
                <button onClick={()=>setView("create")} style={{marginTop:20,background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"11px 28px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:10,fontWeight:700,letterSpacing:3,textTransform:"uppercase"}}>CREATE FIRST CARD</button>
              </div>
            )}
          </div>
        )}

        {view==="create"&&(
          <div style={{animation:"fadeUp 0.4s ease",maxWidth:540,margin:"0 auto"}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:28,letterSpacing:3,color:"var(--gold)",marginBottom:2}}>{updating?"UPDATE CARD":"NEW CARD"}</div>
            <div style={{color:"var(--v333)",fontSize:9,letterSpacing:2,marginBottom:32,textTransform:"uppercase"}}>Find a LinkedIn profile, screenshot it, and we'll rate it</div>
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
                  <div style={{color:"var(--v666)",fontSize:11,lineHeight:1.9,marginBottom:24}}>Hold these three keys at the same time. A crosshair appears — drag a box around just their <span style={{color:"var(--vaaa)"}}>Experience section</span>. Screenshot copies to clipboard, no saving needed. Once you've done that, repeat for their <span style={{color:"var(--vaaa)"}}>Education section</span>. You can paste both on the next page — multiple screenshots are fine.</div>
                  <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:8,marginBottom:18}}>
                    <Key label="⊞ WIN" sub="windows key" wide pressed={pk.win}/>
                    <span style={{color:"var(--v333)",fontSize:18,fontFamily:"'Bebas Neue'"}}>+</span>
                    <Key label="SHIFT" pressed={pk.shift}/>
                    <span style={{color:"var(--v333)",fontSize:18,fontFamily:"'Bebas Neue'"}}>+</span>
                    <Key label="S" pressed={pk.s}/>
                  </div>
                  <div style={{color:"var(--v2a)",fontSize:9,textAlign:"center",letterSpacing:1}}>What's it called? Snip & Sketch — press these keys to try, they'll light up</div>
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
                        <img src={im.preview} alt="" style={{width:56,height:36,objectFit:"cover",borderRadius:3,flexShrink:0}}/>
                        <span style={{color:"var(--v444)",fontSize:9,flex:1,letterSpacing:0.5}}>Screenshot {i+1}</span>
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
                  <button className="ghost" onClick={()=>setStep(0)} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase",padding:0,transition:"color 0.15s"}}>← BACK</button>
                  {imgs.length>0&&<button onClick={()=>setStep(2)} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"10px 20px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,fontWeight:700,letterSpacing:2,textTransform:"uppercase"}}>ANALYSE {imgs.length} SCREENSHOT{imgs.length>1?"S":""} →</button>}
                </div>
              </div>
            )}

            {step===2&&imgs.length>0&&(
              <div style={{animation:"fadeUp 0.3s ease"}}>
                <div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:12}}>
                  {imgs.map((im,i)=>(
                    <div key={i} style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,overflow:"hidden"}}>
                      <img src={im.preview} alt="" style={{width:"100%",display:"block",maxHeight:140,objectFit:"cover",objectPosition:"top"}}/>
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
                  <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"14px 18px",marginBottom:14,display:"flex",alignItems:"center",gap:12}}>
                    <div style={{width:14,height:14,border:"2px solid color-mix(in srgb, var(--gold) 20%, transparent)",borderTop:"2px solid var(--gold)",borderRadius:"50%",animation:"spin 0.8s linear infinite",flexShrink:0}}/>
                    <span style={{color:"var(--v444)",fontSize:10,letterSpacing:1}}>{extracting?"Reading the profile…":"Calculating OVR…"}</span>
                  </div>
                )}
                {err&&<div style={{color:"#ff4444",fontSize:9,letterSpacing:1,marginBottom:12}}>{err}</div>}
                {!dupWarn&&<button onClick={()=>analyse(false)} disabled={extracting||scoring} style={{width:"100%",background:extracting||scoring?"var(--s11)":"var(--gold)",color:extracting||scoring?"var(--v333)":"var(--gold-ink)",border:"none",padding:"13px",borderRadius:5,cursor:extracting||scoring?"not-allowed":"pointer",fontFamily:"'Space Mono'",fontSize:11,fontWeight:700,letterSpacing:3,textTransform:"uppercase",transition:"background 0.15s"}}>
                  {extracting?"READING PROFILE…":scoring?"CALCULATING OVR…":"ANALYSE & GENERATE CARD"}
                </button>}
              </div>
            )}

            {step===3&&done&&(
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
                <div style={{display:"flex",justifyContent:"center",marginBottom:20}}><Card card={withMeta(done)} sz={1.05} onClick={()=>{setSel(done);setView("profile");}}/></div>
                {done.thesis&&<div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:18,marginBottom:14,textAlign:"left"}}>
                  <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:8,textTransform:"uppercase"}}>Profile Thesis</div>
                  <div style={{color:"var(--v888)",fontSize:11,lineHeight:1.7}}>{done.thesis}</div>
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
                <div style={{color:"var(--v333)",fontSize:9,letterSpacing:2,textTransform:"uppercase"}}>{cards.length} profiles ranked by OVR</div>
              </div>
              <button onClick={()=>setView("create")} style={{background:"none",border:"1px solid color-mix(in srgb, var(--gold) 20%, transparent)",color:"var(--gold)",padding:"8px 16px",borderRadius:5,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase"}} onMouseEnter={e=>e.target.style.borderColor="color-mix(in srgb, var(--gold) 40%, transparent)"} onMouseLeave={e=>e.target.style.borderColor="color-mix(in srgb, var(--gold) 20%, transparent)"}>+ ADD PROFILE</button>
            </div>
            {sorted.length===0?(
              <div style={{textAlign:"center",padding:"64px 0",color:"var(--v1a)",fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:2}}>NO PROFILES YET</div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:2}}>
                <div style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr 52px 60px",padding:"8px 12px",gap:8,color:"var(--v2a)",fontSize:8,letterSpacing:2,textTransform:"uppercase",borderBottom:"1px solid var(--s11)",marginBottom:4}}>
                  <span>#</span><span>Name</span><span>University</span><span>Company / Role</span><span>OVR</span><span>Top %</span>
                </div>
                {sorted.map((c,i)=>{
                  const ct2=T(c.OVR);
                  return(
                    <div key={c.id} className="row" onClick={()=>{setSel(c);setView("profile");}} style={{display:"grid",gridTemplateColumns:"36px 1fr 1fr 1fr 52px 60px 28px",padding:"12px 12px",gap:8,alignItems:"center",background:i%2===0?"var(--s0a)":"var(--s0c)",borderRadius:5,cursor:"pointer",border:"1px solid transparent",transition:"background 0.12s,border-color 0.12s"}}>
                      <span style={{fontFamily:"'Bebas Neue'",fontSize:18,color:i===0?"var(--gold)":i===1?"#B0B0B0":i===2?"#CD7F32":"var(--v2a)"}}>{i+1}</span>
                      <div>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:15,letterSpacing:1,color:"var(--vddd)"}}>{c.name}</div>
                        <div style={{fontSize:8,color:"var(--v2e)",letterSpacing:1,marginTop:1}}>CLASS OF {c.year||"—"}</div>
                      </div>
                      <div style={{fontSize:10,color:"var(--v444)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.uni}</div>
                      <div>
                        <div style={{fontSize:10,color:ct2.acc,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.company}</div>
                        <div style={{fontSize:8,color:"var(--v333)",marginTop:1,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{c.role}</div>
                      </div>
                      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:ct2.acc}}>{c.OVR}</div>
                      <div style={{fontSize:9,color:"var(--v444)"}}>TOP {100-(c.percentile||50)}%</div>
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
              <button className="ghost" onClick={()=>{setView("leaderboard");setSel(null);}} style={{background:"none",border:"none",color:"var(--v333)",cursor:"pointer",fontFamily:"'Space Mono'",fontSize:9,letterSpacing:2,textTransform:"uppercase",padding:0,transition:"color 0.15s"}}>← BACK</button>
              <div style={{display:"flex",gap:8}}>
                <button onClick={()=>setShowShare(true)} style={{background:"var(--gold)",color:"var(--gold-ink)",border:"none",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,fontWeight:700,letterSpacing:1,textTransform:"uppercase"}}>SHARE CARD</button>
                <button title="Profile changed? Look at it again" onClick={()=>{setUpdating(sel.id);setView("create");reset();setUpdating(sel.id);}} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v444)",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,letterSpacing:1,textTransform:"uppercase",transition:"border-color 0.15s,color 0.15s"}} onMouseEnter={e=>{e.target.style.borderColor="color-mix(in srgb, var(--gold) 33%, transparent)";e.target.style.color="var(--gold)";}} onMouseLeave={e=>{e.target.style.borderColor="var(--v1e)";e.target.style.color="var(--v444)";}}>UPDATE</button>
                <button onClick={()=>{if(confirm("Delete this card?"))deleteCard(sel.id);}} style={{background:"none",border:"1px solid var(--v1e)",color:"var(--v333)",padding:"7px 14px",borderRadius:4,cursor:"pointer",fontFamily:"'Space Mono'",fontSize:8,letterSpacing:1,textTransform:"uppercase",transition:"border-color 0.15s,color 0.15s"}} onMouseEnter={e=>{e.target.style.borderColor="#ff444455";e.target.style.color="#ff4444";}} onMouseLeave={e=>{e.target.style.borderColor="var(--v1e)";e.target.style.color="var(--v333)";}}>DELETE</button>
              </div>
            </div>
            {sel.moniker&&<div style={{fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:2,color:ct.acc,marginBottom:4,textAlign:"center",textShadow:`0 0 20px ${ct.acc}44`}}>{sel.moniker}</div>}
            <div style={{display:"flex",gap:24,flexWrap:"wrap",justifyContent:"center",marginBottom:28}}>
              <Card card={withMeta(sel)} sz={1}/>
              <div style={{flex:1,minWidth:200,display:"flex",flexDirection:"column",gap:14}}>
                <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"16px 18px"}}>
                  <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:12,textTransform:"uppercase"}}>Stat Breakdown <span style={{color:"var(--v1e)",fontSize:7}}>— hover for details</span></div>
                  {STATS.map(st=>{
                    const v=sel.stats[st];
                    const info=STAT_INFO[st];
                    return(
                      <div key={st} title={sel.stat_reasons?.[st]||undefined} style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                        <StatTooltip stat={st}>
                          <span style={{color:"var(--v555)",fontSize:9,minWidth:38,letterSpacing:1,cursor:"help",borderBottom:"1px dotted var(--v333)"}}>{st}</span>
                        </StatTooltip>
                        <div style={{flex:1,height:4,background:"var(--v1a)",borderRadius:2,overflow:"hidden"}}><div style={{width:`${v}%`,height:"100%",background:`linear-gradient(90deg,${A(info?.color||ct.acc,53)},${info?.color||ct.acc})`,borderRadius:2}}/></div>
                        <span style={{color:"var(--vddd)",fontSize:12,fontFamily:"'Bebas Neue'",minWidth:26,textAlign:"right"}}>{v}</span>
                      </div>
                    );
                  })}
                </div>
                <div style={{background:"var(--s0f)",border:`1px solid ${ct.acc}1a`,borderRadius:8,padding:"16px 18px",textAlign:"center"}}>
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
                </div>

                {/* Confidence score — internal/operational */}
                <div style={{background:"var(--conf-bg)",border:"1px solid var(--conf-dim)",borderRadius:8,padding:"12px 14px"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                    <span style={{color:"var(--conf-label)",fontSize:8,letterSpacing:2,textTransform:"uppercase"}}>Evidence Confidence</span>
                    <span style={{fontFamily:"'Bebas Neue'",fontSize:14,letterSpacing:1,color:sel.confidence==="HIGH"?"#88cc00":sel.confidence==="LOW"?"#cc4400":"#cc8800"}}>{sel.confidence||"MEDIUM"}</span>
                  </div>
                  {sel.confidence_reason&&<div style={{color:"var(--conf-dim)",fontSize:9,lineHeight:1.5}}>{sel.confidence_reason}</div>}
                  <div style={{color:"var(--conf-dim)",fontSize:8,marginTop:4,letterSpacing:0.5}}>⚠ internal — not shown publicly</div>
                </div>
              </div>
            </div>

            {/* Profile type + archetype row */}
            {(sel.profile_type||sel.archetype)&&(
              <div style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
                {sel.profile_type&&<div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:5,padding:"6px 12px",fontSize:9,letterSpacing:1,textTransform:"uppercase",color:"var(--v555)"}}><span style={{color:"var(--v2a)",marginRight:6}}>TYPE</span>{sel.profile_type}</div>}
                {sel.archetype&&<div style={{background:"var(--s0f)",border:`1px solid ${ct.acc}22`,borderRadius:5,padding:"6px 12px",fontSize:9,letterSpacing:1,textTransform:"uppercase",color:ct.acc,opacity:0.7}}><span style={{color:"var(--v2a)",marginRight:6}}>BUILD</span>{sel.archetype}</div>}
              </div>
            )}

            {/* Profile thesis */}
            {sel.thesis&&(
              <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"18px 20px",marginBottom:10}}>
                <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:10,textTransform:"uppercase"}}>Profile Thesis</div>
                <div style={{color:"var(--v888)",fontSize:12,lineHeight:1.85}}>{sel.thesis}</div>
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
                  <div key={s.k} style={{background:"var(--s0c)",border:"1px solid var(--b14)",borderRadius:8,padding:"12px 18px",display:"flex",gap:10}}>
                    <span style={{color:ct.acc,fontSize:10,flexShrink:0,marginTop:2,width:12}}>{s.icon}</span>
                    <div>
                      <div style={{color:"var(--v2e)",fontSize:8,letterSpacing:2,textTransform:"uppercase",marginBottom:4}}>{s.label}</div>
                      <div style={{color:"var(--v666)",fontSize:11,lineHeight:1.7}}>{s.v}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Profile details */}
            <div style={{background:"var(--s0f)",border:"1px solid var(--b15)",borderRadius:8,padding:"18px 20px"}}>
              <div style={{color:"var(--v2a)",fontSize:8,letterSpacing:2,marginBottom:14,textTransform:"uppercase"}}>Profile Details</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                {[{l:"University",v:sel.uni},{l:"Company",v:sel.company},{l:"Role",v:sel.role},{l:"Age",v:sel.age},{l:"Cohort",v:sel.year||"—"},{l:"How Secured",v:sel.how},{l:"Prior Internships",v:sel.prev}].map(d=>(
                  <div key={d.l}><div style={{color:"var(--v2a)",fontSize:8,letterSpacing:1,textTransform:"uppercase",marginBottom:2}}>{d.l}</div><div style={{color:"var(--v888)",fontSize:11}}>{d.v}</div></div>
                ))}
              </div>
              {sel.acts&&sel.acts!=="None"&&<div style={{marginTop:12,borderTop:"1px solid var(--b14)",paddingTop:12}}><div style={{color:"var(--v2a)",fontSize:8,letterSpacing:1,textTransform:"uppercase",marginBottom:4}}>Activities</div><div style={{color:"var(--v555)",fontSize:10,lineHeight:1.6}}>{sel.acts}</div></div>}
            </div>
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
          </div>
        )}

      </div>
      <div style={{borderTop:"1px solid var(--s0f)",padding:"20px 28px",display:"flex",justifyContent:"center"}}>
        <span style={{color:"var(--v1e)",fontSize:9,letterSpacing:2,textTransform:"uppercase",fontFamily:"'Space Mono',monospace"}}>Made by Jammal &amp; Claude</span>
      </div>
    </div>
  );
}
