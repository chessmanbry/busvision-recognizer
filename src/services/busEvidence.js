// Overlapping detections can exchange identities when vehicles cross. Drop their evidence.
function overlap(a,b) {
  const w=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]));
  const h=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
  return w*h/(a[2]*a[3]+b[2]*b[3]-w*h || 1);
}
export function associate(previous, boxes, now) {
  const fresh=previous.filter(t=>now-t.at<2400);
  return boxes.map((box,i)=>{
    const matches=fresh.filter(t=>overlap(t.box,box)>.4);
    const crowded=boxes.some((other,j)=>j!==i && overlap(other,box)>.12);
    const prior=matches.length===1 && boxes.filter(b=>overlap(b,matches[0].box)>.4).length===1 ? matches[0] : null;
    return {box,at:now,crowded,history:!crowded && prior && !prior.crowded ? prior.history : []};
  });
}
export function observe(track, token, target, context, now, weak=false) {
  track.history=track.history.filter(h=>now-h.at<3500);
  if(!track.crowded && !token) return 'unreadable';
  if(track.crowded || !target.includes(token)){
    track.history=[]; return 'conflict';
  }
  const previous=track.history.filter(h=>!h.weak).map(h=>h.token);
  track.history.push({token,at:now,weak});
  // A whole OCR line may include the destination. Three independent literal reads
  // at the top of the same vehicle can corroborate a low-confidence full number.
  if(token===target && track.history.filter(h=>h.token===target).length>=3) return 'visual-match';
  if(weak) return 'weak-full-read';
  if(token===target && previous.includes(target)) return 'visual-match';
  if(!context || now>context.expires || !context.due.includes(target)) return 'visual-only';
  const parts=[...new Set([...previous,token])];
  const possible=context.routes.filter(r=>parts.every(p=>r.includes(p)));
  if(possible.length!==1 || possible[0]!==target) return 'ambiguous';
  // Only infer simple numeric routes. Complementary fragments must cover the full sign.
  if(/^\d{3,4}$/.test(target) && parts.some(p=>p.length>=2 && target.startsWith(p)) &&
     parts.some(p=>p.length>=2 && target.endsWith(p)) && previous.length &&
     (parts.includes(target) || parts.some(a=>parts.some(b=>a!==b && target.startsWith(a) && target.endsWith(b) && a.length+b.length>=target.length))))
    return 'corroborated';
  return 'candidate';
}
