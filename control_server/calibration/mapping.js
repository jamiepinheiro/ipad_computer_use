'use strict';

function displacement(length, curve) {
  const points = [{input:0,output:0}, ...curve];
  for(let i=1;i<points.length;i++) {
    const a=points[i-1], b=points[i];
    if(length<=b.input) return a.output+(b.output-a.output)*(length-a.input)/(b.input-a.input);
  }
  const last=points.at(-1);
  return length*last.output/last.input;
}

// Invert the measured acceleration curve, then account for integer HID counts.
function chooseMove(ex,ey,curve) {
  const distance=Math.hypot(ex,ey);
  if(distance===0)return {dx:0,dy:0,px:0,py:0};
  let low=0,high=80;
  for(let i=0;i<20;i++) {
    const mid=(low+high)/2;
    if(displacement(mid,curve)<distance)low=mid;else high=mid;
  }
  const cx=ex/distance*high,cy=ey/distance*high;
  let best=null;
  for(let dx=Math.floor(cx)-2;dx<=Math.ceil(cx)+2;dx++)for(let dy=Math.floor(cy)-2;dy<=Math.ceil(cy)+2;dy++){
    const length=Math.hypot(dx,dy);
    if(!length||length>81)continue;
    const gain=displacement(length,curve)/length;
    const px=dx*gain,py=dy*gain,error=Math.hypot(ex-px,ey-py);
    if(!best||error<best.error)best={dx,dy,px,py,error};
  }
  return best;
}
module.exports={displacement,chooseMove};
