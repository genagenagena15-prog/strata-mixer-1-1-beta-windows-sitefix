// src/engine/effects/transitions.js
// 8 curated transition effects (WebGL2 / GLSL ES 3.00 compositor).
// Trimmed from the original 24-effect pack: the 16 unused/degenerate branches were
// removed (they were never selectable — not in TRANSITIONS below). The kept branches
// KEEP their original u_type numbers so selection by u_type still matches; gaps in the
// numbering are intentional. Any unknown u_type falls through to the `fade` fallback.
// Contract (STRATA_EFFECTS_PACK.md §0): u_from/u_to (sampler2D), u_progress 0..1,
// u_strength ~0..2, u_time sec, u_type int. Fullscreen quad, v_uv 0..1.

// Vertex shader — simple fullscreen quad (pack §1).
export const VS_TRANSITION = `#version 300 es
in vec2 a_pos; in vec2 a_uv; out vec2 v_uv;
void main(){ v_uv = a_uv; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Fragment shader — the 8 kept transitions, selected by u_type.
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
  if(u_type==4){                                                     // 4 Ripple
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
  else if(u_type==24){                                              // 24 RGB zoom rush — zoom-blur + chroma WHOOSH + 40° CW spin + swirl/ripple deform
    vec2 c=uv-0.5;
    float amp=sin(p*3.14159);                 // peaks hard mid-transition
    float zf=1.0+p*p*7.0*S;                    // FROM rushes INTO the screen (big explosive zoom)
    float zt=1.0+(1.0-p)*(1.0-p)*7.0*S;        // TO rushes OUT, resolving sharp
    float ca=amp*S*0.24;                       // chromatic aberration (R out / B in, radial) — very strong
    // rotation: 40° CLOCKWISE at the peak (resolves to 0), plus a radial SWIRL that twists the
    // edges harder than the centre (deformation), and a sine RIPPLE wobble — all follow amp*S.
    float rad=length(c);
    float ang=radians(40.0)*amp + rad*0.6*amp*S;
    float cs=cos(ang), sn=sin(ang);
    mat2 R=mat2(cs, sn, -sn, cs);              // clockwise spin of the sampling
    vec2 wave=vec2(sin(uv.y*11.0+u_time*4.0), sin(uv.x*11.0+u_time*4.0))*amp*S*0.015;
    vec2 cc=R*c + wave;                        // rotated + swirled + rippled sample centre
    vec2 dir=normalize(cc+vec2(1e-4));
    vec2 sh=dir*amp*S*0.06;                     // push along the radius
    vec4 a=vec4(0.0), b=vec4(0.0);
    for(int i=0;i<18;i++){ float t=float(i)/17.0;
      vec2 sa=cc/mix(1.0,zf,t)+0.5+sh*t;        // radial zoom-blur accumulation (FROM)
      vec2 sb=cc/mix(1.0,zt,t)+0.5+sh*t;        // (TO)
      a.r+=texture(u_from, sa+dir*ca*t).r; a.g+=texture(u_from, sa).g; a.b+=texture(u_from, sa-dir*ca*t).b;
      b.r+=texture(u_to,   sb+dir*ca*t).r; b.g+=texture(u_to,   sb).g; b.b+=texture(u_to,   sb-dir*ca*t).b;
    }
    a/=18.0; b/=18.0; a.a=1.0; b.a=1.0;
    col=mix(a, b, smoothstep(0.47,0.63,p));     // A-explosion holds through the midpoint, B emerges a touch later
    col.rgb += amp*amp*0.22*S;                  // bright flash at the peak of the whoosh
  }
  else { col=fade(uv,p); }
  fragColor=col;
}`;

// UI-picker metadata — the 8 exposed transitions. Types keep their original pack
// numbers so they match the FS_TRANSITIONS branches above.
export const TRANSITIONS = [
  { id: 'rgbrush',      type: 24, name: 'RGB zoom' },
  { id: 'zoomrush',     type: 14, name: 'Zoom rush' },
  { id: 'zoomspin',     type: 13, name: 'Zoom-spin whip' },
  { id: 'datamosh',     type: 10, name: 'Glitch' },
  { id: 'pixelate',     type: 5,  name: 'Pixelate' },
  { id: 'fireburn',     type: 9,  name: 'Fire burn' },
  { id: 'swirl',        type: 6,  name: 'Swirl' },
  { id: 'ripple',       type: 4,  name: 'Ripple' },
];
export const TRANSITION_TYPE = Object.fromEntries(TRANSITIONS.map(t => [t.id, t.type]));
