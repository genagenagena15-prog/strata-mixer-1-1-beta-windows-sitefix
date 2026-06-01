// src/engine/effects/textStyles.js
// 9 emissive text styles ported from STRATA_EFFECTS_PACK.md §3 (WebGL1/GLSL ES 1.00)
// → WebGL2 / GLSL ES 3.00, per PARALLEL_WORK.md §4. Effect bodies are the pack's.
// Contract (pack §0): u_text (sampler2D, .a = glyph coverage), u_time, u_intensity,
// u_style int 0..8, u_anim int, u_base/u_acc (vec3), u_texel = 1/texSize.
// Output = emissive RGB → draw ADDITIVELY over video (blendFunc SRC_ALPHA, ONE).
//
// PORT CHANGE vs the pack: glow() was a 9×9 UNIFORM box-blur → square halo (pack §6.1
// flags it must not ship). Replaced here with a 9×9 GAUSSIAN-weighted sample → round
// halo, same tap count. NOTE for integration: at large radius a separable 2-pass
// (compositor FS_GAUSS) or SDF is cheaper+smoother — swap in when wiring the glow as a
// pre-pass texture rather than this in-shader sampler.

// Vertex shader — transform-animations (pack §1: rotate → scale → offset).
export const VS_TEXT = `#version 300 es
in vec2 a_pos; in vec2 a_uv; out vec2 v_uv;
uniform vec2 u_scale; uniform vec2 u_offset; uniform float u_rot;
void main(){ v_uv = a_uv;
  vec2 q = a_pos; float s = sin(u_rot), c = cos(u_rot);
  q = vec2(q.x*c - q.y*s, q.x*s + q.y*c) * u_scale + u_offset;
  gl_Position = vec4(q, 0.0, 1.0); }`;

// Fragment shader — all 9 text styles (pack §3).
export const FS_TEXT = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_uv;
uniform sampler2D u_text;
uniform float u_time, u_intensity;
uniform int u_style, u_anim;
uniform vec3 u_base, u_acc;
uniform vec2 u_texel;
out vec4 fragColor;

float n2(vec2 p){ vec2 i=floor(p),f=fract(p);
  float a=fract(sin(dot(i,vec2(127.1,311.7)))*43758.5453);
  float b=fract(sin(dot(i+vec2(1,0),vec2(127.1,311.7)))*43758.5453);
  float c=fract(sin(dot(i+vec2(0,1),vec2(127.1,311.7)))*43758.5453);
  float d=fract(sin(dot(i+vec2(1,1),vec2(127.1,311.7)))*43758.5453);
  vec2 u=f*f*(3.0-2.0*f); return mix(mix(a,b,u.x),mix(c,d,u.x),u.y); }
float fbm(vec2 p){ float v=0.0,a=0.5; for(int i=0;i<4;i++){ v+=a*n2(p); p*=2.0; a*=0.5; } return v; }
float h2(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }
float A(vec2 uv){ return texture(u_text,uv).a; }
// Smooth glow: 9×9 GAUSSIAN-weighted (round halo). See header note re: 2-pass/SDF.
float glow(vec2 uv,float r){ float s=0.0, wsum=0.0;
  for(int i=-4;i<=4;i++){ for(int j=-4;j<=4;j++){
    float w=exp(-float(i*i+j*j)/8.0);
    s+=A(uv+vec2(float(i),float(j))*u_texel*r)*w; wsum+=w; } }
  return s/wsum; }

void main(){
  vec2 uv=v_uv;
  if(u_anim==3){ uv.y += sin(uv.x*11.0+u_time*4.0)*0.025; }                  // wave
  float a=A(uv);
  if(u_anim==10){ float prog=clamp(mod(u_time,2.0)/0.8,0.0,1.0); a*=step(uv.x,prog); }  // typewriter (timing stub → wire to word window)
  if(u_anim==11){ float bl=(1.0-clamp(mod(u_time,2.0)/0.6,0.0,1.0))*0.03; float s=0.0;  // blur-in
    for(int i=-3;i<=3;i++){ for(int j=-3;j<=3;j++){ s+=A(uv+vec2(float(i),float(j))*bl); } } a=s/49.0; }
  vec3 base=u_base;
  if(u_anim==2){ float fill=fract(u_time*0.45); base = uv.x<fill ? u_acc : u_base*0.55; } // karaoke fill (timing stub → wire to word window)
  vec3 rgb=vec3(0.0); float I=u_intensity;

  if(u_style==0){ rgb=base*a; }                                             // 0 Plain
  else if(u_style==1){ float g=glow(uv,3.0*I); float pl=0.7+0.3*sin(u_time*5.0);
    rgb = base*a + u_acc*g*g*3.2*pl*I; }                                    // 1 Neon
  else if(u_style==2){ float g=glow(uv,4.5*I); rgb = base*a + u_acc*g*1.7*I; } // 2 Glow
  else if(u_style==3){                                                      // 3 🔥 Fire
    float heat=0.0;
    for(int i=0;i<8;i++){ heat+=A(uv-vec2(0.0,float(i)*u_texel.y*7.0)); }
    heat/=8.0;
    float nz=fbm(vec2(uv.x*9.0, uv.y*9.0 + u_time*4.0));
    float fl=clamp(heat*(0.55+nz)*1.7*I,0.0,1.0);
    vec3 fire=mix(vec3(1.0,0.1,0.0), vec3(1.0,0.85,0.2), fl);
    fire=mix(fire, vec3(1.0,1.0,0.9), fl*fl*0.6);
    rgb = base*a + fire*fl*(1.0-a*0.4);
  }
  else if(u_style==4){ float gg=fract(uv.y - u_time*0.25); rgb=mix(u_base,u_acc,gg)*a; } // 4 Gradient
  else if(u_style==5){                                                      // 5 Hologram
    float jit=(h2(vec2(floor(uv.y*44.0),floor(u_time*15.0)))-0.5)*0.02;
    vec2 uo=uv+vec2(jit,0.0); float sp=0.006*I;
    float ar=A(uo+vec2(sp,0.0)), ag=A(uo), ab=A(uo-vec2(sp,0.0));
    float scan=0.55+0.45*sin(uv.y*130.0 - u_time*8.0);
    float flick=0.75+0.25*step(0.5,fract(u_time*7.0));
    rgb=(vec3(ar,ag,ab)*u_acc)*scan*flick*1.6*I + u_acc*glow(uv,2.0*I)*0.5;
  }
  else if(u_style==6){                                                      // 6 Chrome / metal
    float grad=uv.y;
    vec3 metal=mix(vec3(0.18,0.22,0.32), vec3(0.95,0.98,1.0), grad);
    float spec=smoothstep(0.03,0.0, abs(fract(uv.y*2.0 - u_time*0.4)-0.5));
    metal += spec*0.6 + spec*u_acc*0.5;
    rgb=metal*a*I;
  }
  else if(u_style==7){                                                      // 7 Rainbow foil
    float hue=uv.x + uv.y*0.3 + u_time*0.2;
    vec3 rb=0.5+0.5*cos(6.28318*(hue+vec3(0.0,0.33,0.67)));
    float shim=0.7+0.3*sin(uv.x*40.0 + u_time*3.0);
    rgb=rb*shim*a*1.2*I;
  }
  else if(u_style==8){                                                      // 8 Neon flicker
    float r=h2(vec2(floor(u_time*12.0),1.0));
    float buzz=(r<0.12?0.25:1.0)*(0.9+0.1*sin(u_time*55.0));
    float g=glow(uv,3.0*I);
    rgb=(base*a + u_acc*g*g*3.2*I)*buzz;
  }
  else { rgb=base*a; }
  fragColor=vec4(rgb,1.0);
}`;

// UI-picker metadata (pack §3).
export const TEXT_STYLES = [
  { id: 'plain',   style: 0, name: 'Обычный' },
  { id: 'neon',    style: 1, name: 'Неон' },
  { id: 'glow',    style: 2, name: 'Свечение' },
  { id: 'fire',    style: 3, name: 'Огонь' },
  { id: 'grad',    style: 4, name: 'Градиент' },
  { id: 'holo',    style: 5, name: 'Голограмма' },
  { id: 'chrome',  style: 6, name: 'Хром / металл' },
  { id: 'rainbow', style: 7, name: 'Радуга-фольга' },
  { id: 'neonflk', style: 8, name: 'Неон-фликер' },
];
export const TEXT_STYLE_TYPE = Object.fromEntries(TEXT_STYLES.map(s => [s.id, s.style]));
