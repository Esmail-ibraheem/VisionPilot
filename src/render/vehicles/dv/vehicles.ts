/**
 * Vehicle models taken verbatim (apart from the type import and the removal of the pedestrian)
 * from the sibling project `driving-visualization/lib/driving/vehicles.ts`, so its car visuals can be
 * used in this app. Conventions of the original: forward is -Z, yaw in radians, metres.
 * `dvTemplate.ts` adapts the output to this app's +Z-forward vehicle frame and merges the meshes.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { BodyKind as VehicleType } from '../specs';

type Section={z:number,w:number,y:number};
type Spec={length:number;width:number;belt:number;roof:number;wheel:number;axles:[number,number];cabin:Section[]};
const specs:Record<VehicleType,Spec>={
 sedan:{length:4.65,width:1.84,belt:.91,roof:1.43,wheel:.325,axles:[-1.43,1.38],cabin:[{z:-1.04,w:.83,y:.94},{z:-.81,w:.79,y:1.10},{z:-.35,w:.69,y:1.39},{z:-.12,w:.68,y:1.43},{z:.61,w:.68,y:1.41},{z:1.17,w:.76,y:1.08},{z:1.47,w:.81,y:.94}]},
 crossover:{length:4.62,width:1.91,belt:1.00,roof:1.67,wheel:.36,axles:[-1.40,1.36],cabin:[{z:-1.03,w:.87,y:1.04},{z:-.79,w:.81,y:1.30},{z:-.35,w:.73,y:1.62},{z:-.11,w:.73,y:1.67},{z:.89,w:.73,y:1.64},{z:1.42,w:.80,y:1.32},{z:1.72,w:.84,y:1.06}]},
 ego:{length:4.72,width:1.95,belt:.98,roof:1.61,wheel:.36,axles:[-1.46,1.41],cabin:[{z:-1.05,w:.89,y:1.02},{z:-.83,w:.84,y:1.24},{z:-.31,w:.73,y:1.57},{z:-.04,w:.72,y:1.61},{z:.75,w:.73,y:1.55},{z:1.27,w:.81,y:1.21},{z:1.62,w:.85,y:1.01}]},
 van:{length:4.72,width:1.95,belt:1.00,roof:1.89,wheel:.34,axles:[-1.47,1.41],cabin:[{z:-1.56,w:.85,y:1.06},{z:-1.35,w:.81,y:1.43},{z:-.90,w:.77,y:1.82},{z:-.64,w:.78,y:1.89},{z:1.67,w:.80,y:1.89},{z:2.03,w:.81,y:1.76},{z:2.19,w:.86,y:1.06}]}
};
const bodyProfile=[[-1,.62,.64],[-.987,.79,.73],[-.958,.91,.79],[-.90,.97,.84],[-.72,1,.91],[-.44,1,.96],[-.10,.99,.97],[.32,1,.97],[.62,1,.96],[.86,.96,.90],[.94,.94,.87],[.98,.84,.82],[1,.64,.73]];
const cache=new Map<VehicleType,THREE.Group>();
const mat=(color:THREE.ColorRepresentation,roughness=1,metalness=0)=>new THREE.MeshStandardMaterial({color,roughness,metalness});
function mesh(g:THREE.BufferGeometry,m:THREE.Material){const o=new THREE.Mesh(g,m);o.castShadow=true;o.receiveShadow=true;return o;}
function surface(rows:THREE.Vector3[][],material:THREE.Material,closed=false){
 const positions:number[]=[],indices:number[]=[];const cols=rows[0].length;
 for(const row of rows) for(const p of row) positions.push(p.x,p.y,p.z);
 for(let i=0;i<rows.length-1;i++) for(let j=0;j<cols-(closed?0:1);j++) {const k=(j+1)%cols,a=i*cols+j,b=i*cols+k,c=(i+1)*cols+j,d=(i+1)*cols+k;indices.push(a,c,b,b,c,d);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setIndex(indices);g.computeVertexNormals();return mesh(g,material);
}
function lerpSection(z:number,s:Section[]){
 let i=0;while(i<s.length-2 && z>s[i+1].z)i++;
 const a=s[i],b=s[i+1],t=THREE.MathUtils.clamp((z-a.z)/(b.z-a.z),0,1),span=b.z-a.z;
 const smooth=(key:'w'|'y')=>{const prev=s[Math.max(0,i-1)],next=s[Math.min(s.length-1,i+2)];const slope=(b[key]-a[key])/span;
 let m0=(b[key]-prev[key])/(b.z-prev.z),m1=(next[key]-a[key])/(next.z-a.z);
 if(slope===0){m0=0;m1=0;}else{if(m0*slope<0)m0=0;if(m1*slope<0)m1=0;}
 return (2*t*t*t-3*t*t+1)*a[key]+(t*t*t-2*t*t+t)*span*m0+(-2*t*t*t+3*t*t)*b[key]+(t*t*t-t*t)*span*m1;};
 return {w:smooth('w'),y:smooth('y')};
}
function tube(points:THREE.Vector3[],radius:number,material:THREE.Material,closed=false){return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points,closed,'centripetal'),Math.max(12,points.length*4),radius,5,closed),material);}
function round(w:number,h:number,l:number,r:number,m:THREE.Material){return mesh(new RoundedBoxGeometry(w,h,l,1,r),m);}
function makeVehicle(type:VehicleType){
 const s=specs[type],ego=type==='ego',van=type==='van';
 const group=new THREE.Group();group.name=type;
 const paint=mat(ego?'#11171b':van?'#a7a8a4':'#adaeaa',ego?.3:.88,ego?.33:.035);
 const glass=mat(ego?'#192327':'#7c817e',ego?.19:.56,ego?.38:.04);
 glass.side=THREE.DoubleSide;
 const rubber=mat(ego?'#171a1c':'#494d4b');
 const trim=mat(ego?'#b5bfbc':'#9b9e9a',ego?.31:.8,ego?.66:.08);
 const rim=mat(ego?'#666e71':'#8a8e8a',.55,.22);
 const recess=mat(ego?'#080e12':'#707773');
 const headlight=mat(ego?'#dde3db':'#c5c7bf',.5,.05);
 const tail=mat(ego?'#612525':'#a36061',.55);
 const belt=s.belt/.97,half=s.length/2;
 const profiles:Section[]=bodyProfile.map(p=>({z:p[0]*half,w:p[1]*s.width/2,y:p[2]*belt}));
 // Dense longitudinal cross sections form shoulders, tapered bumpers, and actual wheel openings.
 const rows:THREE.Vector3[][]=[];
 for(let i=0;i<=80;i++){
  const z=-half+s.length*i/80,top=lerpSection(z,profiles);let bottom=.24;
  for(const a of s.axles){const dz=z-a,r=s.wheel+.045;if(Math.abs(dz)<r)bottom=Math.max(bottom,s.wheel+Math.sqrt(r*r-dz*dz));}
  const low=Math.min(bottom,top.y-.035),w=top.w,y=top.y;
  const points=[new THREE.Vector3(0,y+.02,z),new THREE.Vector3(w*.77,y-.005,z),new THREE.Vector3(w*.96,y-.065,z),new THREE.Vector3(w,y-.155,z),new THREE.Vector3(w*.985,low+.04,z),new THREE.Vector3(w*.87,low,z),new THREE.Vector3(0,low,z),new THREE.Vector3(-w*.87,low,z),new THREE.Vector3(-w*.985,low+.04,z),new THREE.Vector3(-w,y-.155,z),new THREE.Vector3(-w*.96,y-.065,z),new THREE.Vector3(-w*.77,y-.005,z)];
  const curve=new THREE.CatmullRomCurve3(points,true,'centripetal');rows.push(curve.getPoints(28).slice(0,-1));
 }
 const body=surface(rows,paint,true);group.add(body);
 // End caps follow the same shaped cross section (not rectangular bumpers).
 for(const row of [rows[0],rows[rows.length-1]]){
  const center=new THREE.Vector3(0,(row[0].y+.24)/2,row[0].z),p:number[]=[];
  row.forEach((v,i)=>{const next=row[(i+1)%row.length],a=row[0].z>0?next:v,b=row[0].z>0?v:next;p.push(center.x,center.y,center.z,a.x,a.y,a.z,b.x,b.y,b.z);});
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));g.computeVertexNormals();group.add(mesh(g,paint));
 }
 // Canopy loft: a separate compound surface for the windshield, roof, and rear glass.
 const z0=s.cabin[0].z,z1=s.cabin[s.cabin.length-1].z;
 const crown=(z:number,u:number)=>{const c=lerpSection(z,s.cabin);return new THREE.Vector3(c.w*u,c.y-.11*Math.pow(Math.abs(u),2.6),z);};
 const canopyRows:THREE.Vector3[][]=[];
 for(let i=0;i<=48;i++){const z=THREE.MathUtils.lerp(z0,z1,i/48);canopyRows.push(Array.from({length:19},(_,j)=>crown(z,(j/18-.5)*2)));}
 group.add(surface(canopyRows,paint));
 const pane=(a:number,b:number)=>{const r:THREE.Vector3[][]=[];for(let i=0;i<=24;i++){const t=i/24,z=THREE.MathUtils.lerp(a,b,t),edge=.90+.05*Math.sin(Math.PI*t);r.push(Array.from({length:21},(_,j)=>{const p=crown(z,(j/20-.5)*2*edge);p.y+=.013;return p;}));}group.add(surface(r,glass));};
 pane(z0+.10,s.cabin[2].z-.035);
 if(ego) pane(s.cabin[2].z+.04,s.cabin[5].z-.10);
 else if(!van) {pane(s.cabin[4].z+.09,z1-.09);if(type==='sedan')pane(s.cabin[2].z+.04,s.cabin[4].z-.04);}
 // Side windows inset in a painted structural surround. Pillars split the front/rear panes.
 for(const side of [-1,1]){
  const sideRows:THREE.Vector3[][]=[];
  for(let i=0;i<=48;i++){const z=THREE.MathUtils.lerp(z0,z1,i/48),c=lerpSection(z,s.cabin),base=lerpSection(z,profiles);sideRows.push([new THREE.Vector3(side*c.w,c.y-.11,z),new THREE.Vector3(side*base.w*.98,base.y-.012,z)]);}
  group.add(surface(side<0?sideRows.map(r=>r.reverse()):sideRows,paint));
  const addWindow=(a:number,b:number)=>{const r:THREE.Vector3[][]=[];for(let i=0;i<=30;i++){const z=THREE.MathUtils.lerp(a,b,i/30),c=lerpSection(z,s.cabin),base=lerpSection(z,profiles),hi=c.y-.13,lo=base.y+.043; if(hi<lo+.01)continue;const xTop=c.w+(base.w*.98-c.w)*.09; r.push([new THREE.Vector3(side*(xTop+.009),hi,z),new THREE.Vector3(side*(base.w*.962+.012),lo,z)]);}if(r.length>1)group.add(surface(r,glass));};
  addWindow(z0+.15,van?-.48:.28);
  if(!van)addWindow(.34,z1-.20);
  // Bright but restrained window surrounds on the ego car.
  if(ego){const outline:THREE.Vector3[]=[];for(let i=0;i<=30;i++){const z=THREE.MathUtils.lerp(z0+.10,z1-.12,i/30),c=lerpSection(z,s.cabin);outline.push(new THREE.Vector3(side*(c.w+.016),c.y-.108,z));}group.add(tube(outline,.027,trim));}
  // Door seams / flush handles / rocker panel.
  for(const z of (van?[-.12,1.72]:[.30,1.30])){
   const w=lerpSection(z,profiles).w;
   group.add(tube([new THREE.Vector3(side*(w+.005),s.belt-.07,z),new THREE.Vector3(side*(w+.009),.67,z+.02),new THREE.Vector3(side*(w*.987),.34,z+.02)],.006,trim));
   const handle=round(.022,.027,.17,.009,ego?trim:rim);handle.position.set(side*(w+.01),s.belt-.10,z-.23);group.add(handle);
  }
  const rocker=round(.06,.065,2.1,.025,recess);rocker.position.set(side*(s.width*.49),.27,0);group.add(rocker);
  const mirror=round(.22,.115,.31,.055,paint);mirror.position.set(side*(s.width*.5+.09),s.belt+.04,-.72);mirror.rotation.y=side*-.15;group.add(mirror);
  // Visible wheel wells: curved fender lips follow the open body boundary.
  for(const axle of s.axles){const points:THREE.Vector3[]=[];for(let j=0;j<=28;j++){const a=Math.PI*j/28;points.push(new THREE.Vector3(side*s.width*.496,s.wheel+Math.sin(a)*(s.wheel+.044),axle+Math.cos(a)*(s.wheel+.044)));}group.add(tube(points,ego?.022:.016,paint));}
 }
 // Four correctly grounded wheels with tire sidewalls, rims, and five sculpted spokes.
 for(const side of [-1,1])for(const axle of s.axles){
  const wheel=new THREE.Group();wheel.position.set(side*(s.width/2-.045),s.wheel,axle);wheel.name='wheel';
  const tire=mesh(new THREE.CylinderGeometry(s.wheel,s.wheel,.205,40,1),rubber);tire.rotation.z=Math.PI/2;wheel.add(tire);
  const ring=mesh(new THREE.TorusGeometry(s.wheel*.71,.027,8,32),rim);ring.rotation.y=Math.PI/2;ring.position.x=side*.108;wheel.add(ring);
  const disc=mesh(new THREE.CylinderGeometry(s.wheel*.68,s.wheel*.68,.018,32),recess);disc.rotation.z=Math.PI/2;disc.position.x=side*.112;wheel.add(disc);
  for(let i=0;i<5;i++){const spoke=round(.018,s.wheel*.19,s.wheel*1.13,.015,rim);spoke.position.x=side*.125;spoke.rotation.x=i*Math.PI*2/5;wheel.add(spoke);}
  const hub=mesh(new THREE.SphereGeometry(.060,12,8),rim);hub.scale.x=.23;hub.position.x=side*.14;wheel.add(hub);group.add(wheel);
 }
 for(const side of [-1,1]) {
  const crease=[new THREE.Vector3(side*s.width*.31,.755*belt,-half+.14),new THREE.Vector3(side*s.width*.33,.865*belt,-1.72),new THREE.Vector3(side*s.width*.36,.945*belt,-1.05)];
  if(!van)group.add(tube(crease,ego?.012:.006,ego?trim:paint));
 }
 // Narrow lamps curve toward the fenders, with a recessed lower intake and rear plate.
 for(const side of [-1,1]){
  const front=round(.49,.075,.065,.031,headlight);front.position.set(side*s.width*.29,.69* belt,-half+.005);front.rotation.y=side*-.22;group.add(front);
  const rear=round(.46,.065,.063,.025,tail);rear.position.set(side*s.width*.32,.79*belt,half+.016);rear.rotation.y=side*.20;rear.name='tail';group.add(rear);
 }
 const intake=round(s.width*.58,.09,.041,.035,recess);intake.position.set(0,.37,-half-.012);group.add(intake);
 const rearBumper=round(s.width*.72,.075,.052,.03,recess);rearBumper.position.set(0,.33,half-.016);group.add(rearBumper);
 const plate=round(.37,.093,.022,.012,ego?rim:trim);plate.position.set(0,.59,half+.009);group.add(plate);
 if(ego){
  for(const z of [-.32,1.18]){const points=Array.from({length:17},(_,i)=>{const p=crown(z,(i/16-.5)*1.94);p.y+=.02;return p;});group.add(tube(points,.018,trim));}
  const spoiler=round(1.49,.035,.14,.025,paint);spoiler.position.set(0,.94,half-.23);group.add(spoiler);}
 if(van){const seam=round(.008,.74,.01,.003,trim);seam.position.set(0,1.30,half-.021);group.add(seam);}
 group.userData={type,dimensions:{length:s.length,width:s.width,height:s.roof}};
 return group;
}
export function createVehicle(type:VehicleType):THREE.Group {
 if(!cache.has(type))cache.set(type,makeVehicle(type));
 return cache.get(type)!.clone(true);
}
export function disposeVehicleCache(){const geometries=new Set<THREE.BufferGeometry>(),materials=new Set<THREE.Material>();for(const t of cache.values())t.traverse(o=>{if(o instanceof THREE.Mesh){geometries.add(o.geometry);const m=Array.isArray(o.material)?o.material:[o.material];m.forEach(v=>materials.add(v));}});geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());cache.clear();}
