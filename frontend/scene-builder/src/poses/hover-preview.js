// A thumbnail preview only; it never changes the scene mannequin or pose history.
export function attachHoverPreview(button,image,source){
 const container=document.createElement('span');container.className='pose-preview';image.replaceWith(container);container.append(image);
 const video=document.createElement('video');video.className='pose-hover-video';video.muted=true;video.loop=true;video.playsInline=true;video.preload='none';video.hidden=true;video.setAttribute('aria-hidden','true');container.append(video);
 let hovered=false,keyboardFocused=false,disposed=false,failed=false,request=0;
 const active=()=>!disposed&&!failed&&!window.sceneSuspended&&(hovered||keyboardFocused);
 function stop(){request++;video.pause();video.hidden=true;try{video.currentTime=0;}catch{ /* Metadata may not have loaded yet. */ }}
 async function start(){
  if(!active())return;const token=++request;
  if(!video.getAttribute('src'))video.src=source;
  try{video.currentTime=0;await video.play();if(token===request&&active())video.hidden=false;}
  catch{if(token===request){failed=true;stop();}}
 }
 const enter=()=>{hovered=true;start();};
 const leave=()=>{hovered=false;if(!keyboardFocused)stop();};
 const focus=()=>{keyboardFocused=button.matches(':focus-visible');if(keyboardFocused)start();};
 const blur=()=>{keyboardFocused=false;if(!hovered)stop();};
 const error=()=>{failed=true;stop();};
 window.addEventListener('scene-suspend',stop);button.addEventListener('mouseenter',enter);button.addEventListener('mouseleave',leave);button.addEventListener('focus',focus);button.addEventListener('blur',blur);video.addEventListener('error',error);
 return ()=>{disposed=true;stop();window.removeEventListener('scene-suspend',stop);button.removeEventListener('mouseenter',enter);button.removeEventListener('mouseleave',leave);button.removeEventListener('focus',focus);button.removeEventListener('blur',blur);video.removeEventListener('error',error);video.removeAttribute('src');video.load();};
}
