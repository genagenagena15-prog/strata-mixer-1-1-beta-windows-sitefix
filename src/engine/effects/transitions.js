// src/engine/effects/transitions.js
// 24 transition effects ported from STRATA_EFFECTS_PACK.md §2 (WebGL1/GLSL ES 1.00)
// → our WebGL2 / GLSL ES 3.00 compositor, per PARALLEL_WORK.md §4.
// MECHANICAL port only — effect bodies are byte-for-byte the pack's:
//   + `#version 300 es` / `precision highp int;`
//   + `attribute→in`, `varying→in/out`, add `out vec4 fragColor;`
//   + `gl_FragColor→fragColor`, every `texture2D(→texture(`
// Contract (STRATA_EFFECTS_PACK.md §0): u_from/u_to (sampler2D), u_progress 0..1,
// u_strength ~0..2, u_time sec, u_type int 0..23. Fullscreen quad, v_uv 0..1.

// Vertex shader — simple fullscreen quad (pack §1).
export const VS_TRANSITION = `#version 300 es
in vec2 a_pos; in vec2 a_uv; out vec2 v_uv;
void main(){ v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Fragment shader — all 24 transitions (pack §2, texture2D→texture).
export const FS_TRANSITIONS = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform sampler2D u_from, u_to;
uniform float u_progress, u_strength, u_time;
uniform int u_type;
out vec4 fragColor;

float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float n2(vec2 p){ vec2 i=floor(p),f=fract(p);
  float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));
  vec2 u=f*f*(3.0-2.0*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*n2(p); p*=2.0; a*=0.5; } return v; }
vec4 fade(vec2 uv,float p){ return mix(texture(u_from,uv),texture(u_to,uv),p); }

void main(){
  vec2 uv=v_uv; float p=u_progress; float S=u_strength; vec4 col;
  if(u_type==0){ col=fade(uv,p); }                                   // 0 Fade
  else if(u_type==1){                                                // 1 Zoom-blur punch
    vec2 c=uv-0.5; float b=S*0.6*sin(p*3.14159);
    vec4 a=vec4(0.0), d=vec4(0.0);
    for(int i=0;i<8;i++){ float t=float(i)/7.0;
      a += texture(u_from, c*(1.0+(b+p*0.7*S)*t)+0.5);
      d += texture(u_to,   c*(1.0+(b+(1.0-p)*0.7*S)*t)+0.5);
    }
    col=mix(a/8.0, d/8.0, p);
  }
  else if(u_type==2){                                                // 2 RGB glitch
    float k=(1.0-abs(p*2.0-1.0));
    float jit=(hash(vec2(floor(uv.y*22.0),floor(u_time*18.0)))-0.5)*S*0.12*k;
    vec2 uo=uv+vec2(jit,0.0); float sp=S*0.06*k;
    float r=mix(texture(u_from,uo+vec2(sp,0)).r, texture(u_to,uo+vec2(sp,0)).r, p);
    float g=mix(texture(u_from,uo).g, texture(u_to,uo).g, p);
    float bl=mix(texture(u_from,uo-vec2(sp,0)).b, texture(u_to,uo-vec2(sp,0)).b, p);
    col=vec4(r,g,bl,1.0);
  }
  else if(u_type==3){                                                // 3 Luma wipe
    float grad=uv.x*0.5+uv.y*0.5; float e=0.08;
    float m=smoothstep(grad-e, grad+e, p*(1.0+2.0*e)-e);
    col=mix(texture(u_from,uv), texture(u_to,uv), m);
    col.rgb += vec3(0.6,0.8,1.0)*S*exp(-pow((grad-(p*(1.0+2.0*e)-e))/e,2.0));
  }
  else if(u_type==4){                                                // 4 Ripple
    float d=distance(uv,vec2(0.5));
    float w=sin(d*42.0-u_time*6.0)*S*0.03*sin(p*3.14159);
    vec2 ur=uv+(uv-0.5)*w/max(d,0.001);
    col=mix(texture(u_from,ur), texture(u_to,ur), p);
  }
  else if(u_type==5){                                                // 5 Pixelate
    float cells=mix(360.0, 10.0, sin(p*3.14159)*clamp(S,0.0,1.0));
    vec2 q=(floor(uv*cells)+0.5)/cells;
    col=mix(texture(u_from,q), texture(u_to,q), p);
  }
  else if(u_type==6){                                                // 6 Swirl
    vec2 c=uv-0.5; float d=length(c);
    float ang=S*7.0*(0.35-d)*sin(p*3.14159);
    float s=sin(ang),co=cos(ang);
    vec2 us=vec2(c.x*co-c.y*s, c.x*s+c.y*co)+0.5;
    col=mix(texture(u_from,us), texture(u_to,us), p);
  }
  else if(u_type==7){                                                // 7 Flash
    col=mix(texture(u_from,uv), texture(u_to,uv), step(0.5,p));
    col.rgb+=pow(1.0-abs(p*2.0-1.0),3.0)*S;
  }
  else if(u_type==8){                                                // 8 Liquid melt
    float warp=sin(p*3.14159)*S*0.18;
    vec2 d=vec2(fbm(uv*5.0+u_time*0.2), fbm(uv*5.0+7.3-u_time*0.2))-0.5;
    vec2 uw=uv+d*warp;
    float m=smoothstep(0.3,0.7, p+(fbm(uv*3.0+1.7)-0.5)*0.5);
    col=mix(texture(u_from,uw), texture(u_to,uw), m);
  }
  else if(u_type==9){                                                // 9 Fire burn
    float n=fbm(uv*4.0+vec2(0.0,u_time*0.1));
    float burn=p*1.2-0.1; float diff=burn-n;
    col=mix(texture(u_from,uv), texture(u_to,uv), step(0.0,diff));
    float band=smoothstep(0.14,0.0,abs(diff));
    vec3 ember=mix(vec3(0.15,0.0,0.0), vec3(1.0,0.55,0.0), band);
    col.rgb=mix(col.rgb, ember, band*step(-0.14,diff)*clamp(S,0.0,1.5));
    col.rgb+=vec3(1.0,0.8,0.3)*smoothstep(0.04,0.0,abs(diff))*S;
  }
  else if(u_type==10){                                               // 10 Datamosh glitch
    float k=(1.0-abs(p*2.0-1.0));
    vec2 grid=vec2(16.0,26.0); vec2 blk=floor(uv*grid);
    float r1=hash(blk+floor(u_time*12.0)), r2=hash(blk.yx+floor(u_time*9.0));
    vec2 off=vec2(r1-0.5,(r2-0.5)*0.3)*step(0.68,r1)*S*0.25*k;
    vec2 uo=uv+off; float sp=S*0.05*k*step(0.5,r2);
    float scan=0.82+0.18*sin(uv.y*grid.y*7.0);
    float r=mix(texture(u_from,uo+vec2(sp,0)).r, texture(u_to,uo+vec2(sp,0)).r, p);
    float g=mix(texture(u_from,uo).g, texture(u_to,uo).g, p);
    float b=mix(texture(u_from,uo-vec2(sp,0)).b, texture(u_to,uo-vec2(sp,0)).b, p);
    col=vec4(vec3(r,g,b)*scan,1.0);
  }
  else if(u_type==11){                                               // 11 Kaleidoscope
    vec2 c=uv-0.5; float ang=atan(c.y,c.x), rad=length(c);
    float seg=6.28318/6.0;
    ang=abs(mod(ang,seg)-seg*0.5)+u_time*0.2+p*0.8;
    vec2 ku=vec2(cos(ang),sin(ang))*rad+0.5;
    col=mix(texture(u_from,ku), texture(u_to,ku), p);
  }
  else if(u_type==12){                                               // 12 Light sweep
    float band=uv.x*0.6+uv.y*0.4; float pos=p*1.4-0.2;
    float reveal=smoothstep(pos+0.02,pos-0.02,band);
    col=mix(texture(u_from,uv), texture(u_to,uv), reveal);
    col.rgb+=vec3(1.0,0.95,0.8)*exp(-pow((band-pos)/0.06,2.0))*1.7*S;
  }
  else if(u_type==13){                                               // 13 Zoom-spin whip
    vec2 c=uv-0.5; float b=sin(p*3.14159)*S;
    vec4 a=vec4(0.0), d=vec4(0.0);
    for(int i=0;i<10;i++){ float t=float(i)/9.0;
      float ang=b*0.5*t, s=sin(ang), co=cos(ang);
      vec2 ca=vec2(c.x*co-c.y*s, c.x*s+c.y*co);
      a+=texture(u_from, ca*(1.0+(b*0.8+p*0.9)*t)+0.5);
      d+=texture(u_to,   ca*(1.0+(b*0.8+(1.0-p)*0.9)*t)+0.5);
    }
    col=mix(a/10.0, d/10.0, p);
  }
  else if(u_type==14){                                               // 14 ZOOM RUSH (into screen + barrel + blur)
    vec2 c=uv-0.5; float r2=dot(c,c);
    float barrel=1.0 + r2*sin(p*3.14159)*S*1.8;
    float zf=1.0+p*p*4.0*S, zt=1.0+(1.0-p)*(1.0-p)*4.0*S;
    vec4 a=vec4(0.0), b=vec4(0.0);
    for(int i=0;i<12;i++){ float t=float(i)/11.0;
      a+=texture(u_from, c*barrel/mix(1.0,zf,t)+0.5);
      b+=texture(u_to,   c*barrel/mix(1.0,zt,t)+0.5);
    }
    col=mix(a/12.0, b/12.0, smoothstep(0.35,0.65,p));
  }
  else if(u_type==15){                                               // 15 Spin 360 blur
    vec2 c=uv-0.5; float sp=sin(p*3.14159)*S*4.0;
    vec4 a=vec4(0.0), b=vec4(0.0);
    for(int i=0;i<10;i++){ float t=float(i)/9.0;
      float a1=sp*t+p*6.28318, s1=sin(a1), c1=cos(a1);
      a+=texture(u_from, vec2(c.x*c1-c.y*s1, c.x*s1+c.y*c1)+0.5);
      float a2=sp*t-(1.0-p)*6.28318, s2=sin(a2), c2=cos(a2);
      b+=texture(u_to, vec2(c.x*c2-c.y*s2, c.x*s2+c.y*c2)+0.5);
    }
    col=mix(a/10.0, b/10.0, p);
  }
  else if(u_type==16){                                               // 16 Stretch whip
    float k=sin(p*3.14159)*S;
    vec2 uo=vec2(0.5+(uv.x-0.5)/(1.0+k*3.0), 0.5+(uv.y-0.5)*(1.0+k*0.4));
    vec4 a=vec4(0.0), b=vec4(0.0);
    for(int i=0;i<8;i++){ float o=(float(i)/7.0-0.5)*k*0.25;
      a+=texture(u_from,uo+vec2(o,0)); b+=texture(u_to,uo+vec2(o,0)); }
    col=mix(a/8.0, b/8.0, p);
  }
  else if(u_type==17){                                               // 17 Iris (circle)
    float d=distance(uv,vec2(0.5)), rad=p*0.95;
    float m=smoothstep(rad+0.03,rad-0.03,d);
    col=mix(texture(u_from,uv), texture(u_to,uv), m);
    col.rgb+=vec3(1.0)*smoothstep(0.025,0.0,abs(d-rad))*S*0.8;
  }
  else if(u_type==18){                                               // 18 Shutter bands
    float bands=8.0, bi=floor(uv.y*bands), stg=bi/bands*0.4;
    col=mix(texture(u_from,uv), texture(u_to,uv), smoothstep(stg,stg+0.3,p));
  }
  else if(u_type==19){                                               // 19 Wave wipe
    float wob=sin(uv.y*18.0+u_time*2.0)*0.06*S;
    col=mix(texture(u_from,uv), texture(u_to,uv), smoothstep(0.0,0.04,(p*1.12)-(uv.x+wob)));
  }
  else if(u_type==20){                                               // 20 Glitch slice
    float sl=14.0, si=floor(uv.y*sl), k=(1.0-abs(p*2.0-1.0));
    float sh=(hash(vec2(si,floor(u_time*20.0)))-0.5)*S*0.3*k*step(0.5,hash(vec2(si,7.0)));
    vec2 uo=uv+vec2(sh,0.0); float spx=S*0.05*k;
    float r=mix(texture(u_from,uo+vec2(spx,0)).r, texture(u_to,uo+vec2(spx,0)).r, p);
    float g=mix(texture(u_from,uo).g, texture(u_to,uo).g, p);
    float b=mix(texture(u_from,uo-vec2(spx,0)).b, texture(u_to,uo-vec2(spx,0)).b, p);
    col=vec4(r,g,b,1.0);
  }
  else if(u_type==21){                                               // 21 Flash zoom
    vec2 c=uv-0.5; float zf=1.0+p*0.5*S, zt=1.0+(1.0-p)*0.5*S;
    col=mix(texture(u_from,c/zf+0.5), texture(u_to,c/zt+0.5), step(0.5,p));
    col.rgb=mix(col.rgb, vec3(1.0), pow(1.0-abs(p*2.0-1.0),2.0)*S);
  }
  else if(u_type==22){                                               // 22 Chroma melt
    float k=sin(p*3.14159)*S*0.12;
    float r=mix(texture(u_from,uv+vec2(0.0,k)).r, texture(u_to,uv+vec2(0.0,k)).r, p);
    float g=mix(texture(u_from,uv).g, texture(u_to,uv).g, p);
    float b=mix(texture(u_from,uv-vec2(0.0,k)).b, texture(u_to,uv-vec2(0.0,k)).b, p);
    col=vec4(r,g,b,1.0);
  }
  else if(u_type==23){                                               // 23 Mosaic blocks
    float cells=mix(300.0,14.0, sin(p*3.14159)*clamp(S,0.0,1.0));
    vec2 bi=floor(uv*cells), q=(bi+0.5)/cells;
    float pp=clamp(p+(hash(bi+floor(u_time*3.0))-0.5)*0.6*sin(p*3.14159), 0.0,1.0);
    col=mix(texture(u_from,q), texture(u_to,q), step(0.5,pp));
  }
  else { col=fade(uv,p); }
  fragColor=col;
}`;

// UI-picker metadata — CURATED to 12 distinct transitions (the other 12 of the pack's 24 were
// dropped as redundant/degenerate: duplicate glitches rgbglitch/glitchslice (kept datamosh),
// duplicate zooms zoomblur/flashzoom (kept zoomrush/zoomspin/spin360), the pure A→B wipes
// fade/lumawipe/lightsweep/iris/shutter/wavewipe (degenerate in our self-effect mode — need a
// clip-pair feed), chromamelt (≈glitch-chroma) and mosaic (≈pixelate)). The shader (FS_TRANSITIONS)
// still carries all 24 branches by u_type; only these ids are exposed/selectable. Types keep their
// original numbers so the shader branches still match.
export const TRANSITIONS = [
  { id: 'flash',        type: 7,  name: 'Flash' },
  { id: 'zoomrush',     type: 14, name: 'Zoom rush' },
  { id: 'zoomspin',     type: 13, name: 'Zoom-spin whip' },
  { id: 'spin360',      type: 15, name: 'Spin 360 blur' },
  { id: 'datamosh',     type: 10, name: 'Glitch' },
  { id: 'pixelate',     type: 5,  name: 'Pixelate' },
  { id: 'fireburn',     type: 9,  name: 'Fire burn' },
  { id: 'liquidmelt',   type: 8,  name: 'Liquid melt' },
  { id: 'swirl',        type: 6,  name: 'Swirl' },
  { id: 'kaleidoscope', type: 11, name: 'Kaleidoscope' },
  { id: 'stretchwhip',  type: 16, name: 'Stretch whip' },
  { id: 'ripple',       type: 4,  name: 'Ripple' },
];
export const TRANSITION_TYPE = Object.fromEntries(TRANSITIONS.map(t => [t.id, t.type]));
