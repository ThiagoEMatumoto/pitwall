// The static motion sheet: one selector per preset, every parameter through a
// --pw-* variable written by motionAttrs (motion.ts). Injected as
// <style id="pw-motion"> by html-render.ts in the artboard document and in
// the standalone export.
//
// Entrance state machine (classes toggled by the runtime / MOTION_EXPORT_JS):
//   pending: [data-pw-m-in] alone — paused at the keyframe's `from` pose
//   playing: .pw-m-play — running
//   done:    .pw-m-done — animation removed, the node sits in its own style
// html[data-pw-motion="final"|"initial"] freezes everything without a runtime
// (shot, export without JS, the editor before interaction): final = the pose
// after all animations, initial = the pose before them. A live runtime
// removes the attribute before it plays anything.

const ENTRANCE_BASE =
  '[data-pw-m-in]{animation-duration:var(--pw-dur,220ms);' +
  'animation-delay:calc(var(--pw-delay,0ms) + var(--pw-i,0)*var(--pw-stagger,0ms));' +
  'animation-timing-function:var(--pw-ease,cubic-bezier(0.16,1,0.3,1));' +
  'animation-fill-mode:both;animation-play-state:paused}' +
  '[data-pw-m-in].pw-m-play{animation-play-state:running}' +
  '[data-pw-m-in].pw-m-done{animation:none}'

const ENTRANCE_PRESETS_CSS =
  '[data-pw-m-in="fade"]{animation-name:pw-in-fade}' +
  '[data-pw-m-in="slide-up"]{animation-name:pw-in-slide-up}' +
  '[data-pw-m-in="slide-down"]{animation-name:pw-in-slide-down}' +
  '[data-pw-m-in="slide-left"]{animation-name:pw-in-slide-left}' +
  '[data-pw-m-in="slide-right"]{animation-name:pw-in-slide-right}' +
  '[data-pw-m-in="scale"]{animation-name:pw-in-scale}' +
  '[data-pw-m-in="blur"]{animation-name:pw-in-blur}' +
  '@keyframes pw-in-fade{from{opacity:0}to{opacity:1}}' +
  '@keyframes pw-in-slide-up{from{opacity:0;transform:translateY(var(--pw-dist,24px))}to{opacity:1;transform:none}}' +
  '@keyframes pw-in-slide-down{from{opacity:0;transform:translateY(calc(-1*var(--pw-dist,24px)))}to{opacity:1;transform:none}}' +
  '@keyframes pw-in-slide-left{from{opacity:0;transform:translateX(var(--pw-dist,24px))}to{opacity:1;transform:none}}' +
  '@keyframes pw-in-slide-right{from{opacity:0;transform:translateX(calc(-1*var(--pw-dist,24px)))}to{opacity:1;transform:none}}' +
  '@keyframes pw-in-scale{from{opacity:0;transform:scale(0.92)}to{opacity:1;transform:none}}' +
  '@keyframes pw-in-blur{from{opacity:0;filter:blur(8px)}to{opacity:1;filter:blur(0)}}'

// Hover is pure CSS; --pw-int scales the effect (1 = the preset as designed).
const HOVER_CSS =
  '[data-pw-m-hover]{transition-duration:var(--pw-hdur,160ms);transition-timing-function:var(--pw-hease,cubic-bezier(0.16,1,0.3,1))}' +
  '[data-pw-m-hover="lift"]{transition-property:transform,box-shadow}' +
  '[data-pw-m-hover="lift"]:hover{transform:translateY(calc(-4px*var(--pw-int,1)));box-shadow:0 12px 24px -8px rgba(0,0,0,0.25)}' +
  '[data-pw-m-hover="scale"]{transition-property:transform}' +
  '[data-pw-m-hover="scale"]:hover{transform:scale(calc(1 + 0.04*var(--pw-int,1)))}' +
  '[data-pw-m-hover="glow"]{transition-property:box-shadow}' +
  '[data-pw-m-hover="glow"]:hover{box-shadow:0 0 calc(20px*var(--pw-int,1)) 0 currentColor}' +
  '[data-pw-m-hover="color"]{transition-property:filter}' +
  '[data-pw-m-hover="color"]:hover{filter:brightness(calc(1 + 0.12*var(--pw-int,1)))}'

// Loops run on the node itself, except marquee, which scrolls the children:
// the runtime clones them once (data-pw-clone) and writes --pw-marquee-w (the
// originals' total width) so originals and clones both travel exactly one set.
const LOOP_CSS =
  '[data-pw-m-loop="pulse"]{animation:pw-loop-pulse var(--pw-loop-dur,1800ms) ease-in-out infinite var(--pw-loop-dir,normal)}' +
  '[data-pw-m-loop="float"]{animation:pw-loop-float var(--pw-loop-dur,1800ms) ease-in-out infinite var(--pw-loop-dir,normal)}' +
  '[data-pw-m-loop="spin"]{animation:pw-loop-spin var(--pw-loop-dur,1800ms) linear infinite var(--pw-loop-dir,normal)}' +
  '[data-pw-m-loop="marquee"]{overflow:hidden;white-space:nowrap}' +
  '[data-pw-m-loop="marquee"]>*{display:inline-block;animation:pw-loop-marquee var(--pw-loop-dur,1800ms) linear infinite var(--pw-loop-dir,normal)}' +
  '@keyframes pw-loop-pulse{0%{transform:scale(1)}50%{transform:scale(1.05)}100%{transform:scale(1)}}' +
  '@keyframes pw-loop-float{0%{transform:translateY(0)}50%{transform:translateY(-8px)}100%{transform:translateY(0)}}' +
  '@keyframes pw-loop-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
  '@keyframes pw-loop-marquee{from{transform:translateX(0)}to{transform:translateX(calc(-1*var(--pw-marquee-w,100%)))}}'

// --pw-par-y (px, unitless) is written per scroll by the runtime.
const PARALLAX_CSS =
  '[data-pw-m-par]{will-change:transform;transform:translateY(calc(var(--pw-par-y,0)*1px))}'

const STATIC_CSS =
  'html[data-pw-motion="final"] [data-pw-m-in]{animation:none}' +
  'html[data-pw-motion="initial"] [data-pw-m-in]{animation-play-state:paused;animation-delay:0ms}' +
  'html[data-pw-motion] [data-pw-m-loop],html[data-pw-motion] [data-pw-m-loop]>*{animation:none}' +
  'html[data-pw-motion] [data-pw-m-hover]{transition:none}'

const REDUCED_MOTION_CSS =
  '@media (prefers-reduced-motion:reduce){' +
  '[data-pw-m-in],[data-pw-m-loop],[data-pw-m-loop]>*{animation:none!important}' +
  '[data-pw-m-hover]{transition:none!important}' +
  '[data-pw-m-par]{transform:none!important}' +
  '}'

// View Transitions for the preview player: html[data-pw-vt="push"|"fade"|
// "smart"] + html[data-pw-vt-dir="forward"|"back"], --pw-vt-dur / --pw-vt-ease
// on the root. Smart pairs nodes through view-transition-name (pw-<slug>);
// unpaired nodes cross-fade with the root.
const VIEW_TRANSITION_CSS =
  '::view-transition-old(root),::view-transition-new(root){animation-duration:var(--pw-vt-dur,300ms);animation-timing-function:var(--pw-vt-ease,cubic-bezier(0.16,1,0.3,1))}' +
  'html[data-pw-vt="none"]::view-transition-old(root),html[data-pw-vt="none"]::view-transition-new(root){animation:none}' +
  'html[data-pw-vt="fade"]::view-transition-old(root){animation-name:pw-vt-fade-out}' +
  'html[data-pw-vt="fade"]::view-transition-new(root){animation-name:pw-vt-fade-in}' +
  'html[data-pw-vt="push"]::view-transition-old(root){animation-name:pw-vt-push-out}' +
  'html[data-pw-vt="push"]::view-transition-new(root){animation-name:pw-vt-push-in}' +
  'html[data-pw-vt="push"][data-pw-vt-dir="back"]::view-transition-old(root){animation-name:pw-vt-push-out-back}' +
  'html[data-pw-vt="push"][data-pw-vt-dir="back"]::view-transition-new(root){animation-name:pw-vt-push-in-back}' +
  'html[data-pw-vt="smart"]::view-transition-group(*){animation-duration:var(--pw-vt-dur,300ms);animation-timing-function:var(--pw-vt-ease,cubic-bezier(0.16,1,0.3,1))}' +
  '@keyframes pw-vt-fade-out{to{opacity:0}}' +
  '@keyframes pw-vt-fade-in{from{opacity:0}}' +
  '@keyframes pw-vt-push-out{to{transform:translateX(-30%);opacity:0}}' +
  '@keyframes pw-vt-push-in{from{transform:translateX(100%)}}' +
  '@keyframes pw-vt-push-out-back{to{transform:translateX(100%)}}' +
  '@keyframes pw-vt-push-in-back{from{transform:translateX(-30%);opacity:0}}'

export const MOTION_CSS =
  ENTRANCE_BASE +
  ENTRANCE_PRESETS_CSS +
  HOVER_CSS +
  LOOP_CSS +
  PARALLAX_CSS +
  STATIC_CSS +
  REDUCED_MOTION_CSS +
  VIEW_TRANSITION_CSS

// Progressive enhancement for the standalone export: the document ships as
// data-pw-motion="final" (readable without JS); this script lifts the freeze
// and plays entrances (IntersectionObserver for in-view), builds the marquee
// clones and drives parallax from the page scroll. ES5 on purpose.
export const MOTION_EXPORT_JS = [
  '(function(){',
  'var d=document,h=d.documentElement;',
  "if(!('animate' in h)||!('requestAnimationFrame' in window))return;",
  "h.removeAttribute('data-pw-motion');",
  "var els=[].slice.call(d.querySelectorAll('[data-pw-m-in]'));",
  "function play(el){el.classList.add('pw-m-play')}",
  "els.forEach(function(el){el.addEventListener('animationend',function(){el.classList.add('pw-m-done')})});",
  "var lazy=els.filter(function(el){return el.getAttribute('data-pw-m-trigger')==='in-view'});",
  'els.filter(function(el){return lazy.indexOf(el)<0}).forEach(function(el){requestAnimationFrame(function(){play(el)})});',
  "if(lazy.length){if('IntersectionObserver' in window){",
  'var io=new IntersectionObserver(function(entries){entries.forEach(function(e){if(e.isIntersecting){play(e.target);io.unobserve(e.target)}})},{threshold:0.2});',
  'lazy.forEach(function(el){io.observe(el)})}else lazy.forEach(play)}',
  '[].forEach.call(d.querySelectorAll(\'[data-pw-m-loop="marquee"]\'),function(el){',
  'var w=0,kids=[].slice.call(el.children);',
  'kids.forEach(function(k){w+=k.getBoundingClientRect().width});',
  "el.style.setProperty('--pw-marquee-w',w+'px');",
  "kids.forEach(function(k){var c=k.cloneNode(true);c.setAttribute('data-pw-clone','');c.setAttribute('aria-hidden','true');el.appendChild(c)})});",
  "var pars=[].slice.call(d.querySelectorAll('[data-pw-m-par]'));",
  'if(pars.length){var raf=0;',
  'function upd(){raf=0;var vh=window.innerHeight;pars.forEach(function(el){',
  "var f=parseFloat(el.getAttribute('data-pw-m-par'))||0;",
  "var cur=parseFloat(el.style.getPropertyValue('--pw-par-y'))||0;",
  'var r=el.getBoundingClientRect();var c=r.top-cur+r.height/2-vh/2;',
  "el.style.setProperty('--pw-par-y',String(Math.round(-c*f)))})}",
  "window.addEventListener('scroll',function(){if(!raf)raf=requestAnimationFrame(upd)},{passive:true});upd()}",
  '})();',
].join('')
