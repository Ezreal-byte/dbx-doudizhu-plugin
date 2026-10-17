// Run against an isolated Vite preview: node scripts/audio-acceptance.mjs http://127.0.0.1:5293
// This checks actual Chromium decoding/playback; it does not certify human acting quality.
import { chromium } from '@playwright/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'test-results/audio-v02');
await mkdir(out, {recursive:true});
const manifest = JSON.parse(await readFile(path.join(root, 'assets/audio/voice-manifest.json'), 'utf8'));
const origin = process.argv[2] ?? 'http://127.0.0.1:5293';
const browser = await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe', headless:true});
const page = await browser.newPage({viewport:{width:1366,height:768}});
const failures = [], external = [];
page.on('pageerror', error => failures.push(error.message));
page.on('request', request => {if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) external.push(request.url());});
const report = {at:new Date().toISOString(),status:'running',checks:[],external,failures};
const check = (name, details) => report.checks.push({name,status:'passed',...details});
try {
  await page.addInitScript(() => {
    window.__sources = [];
    const create = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function (...args) {
      const source = create.apply(this,args), ctx=this, start=source.start, stop=source.stop;
      source.start = function (...startArgs) {
        const entry={at:ctx.currentTime,wall:performance.now(),duration:source.buffer?.duration??0,loop:source.loop,stop:null,end:null};
        source.__entry=entry; window.__sources.push(entry);
        source.addEventListener('ended',()=>{entry.end=ctx.currentTime});
        return start.apply(this,startArgs);
      };
      source.stop = function (...stopArgs) {if(source.__entry)source.__entry.stop=ctx.currentTime;return stop.apply(this,stopArgs)};
      return source;
    };
  });
  await page.goto(origin,{waitUntil:'networkidle'});
  await page.mouse.click(10,10);
  await page.evaluate(async () => {
    window.__audio=(await import('/src/game/audio.ts')).audio;
    __audio.configure({id:'acceptance',nickname:'验收',character:0,music:.35,sound:.6,voice:.7,lowMotion:false});
    await __audio.unlock();
    await __audio.musicPreferenceReady();
  });
  const decoded = await page.evaluate(async paths => {
    const ctx = new AudioContext(), results=[];
    for(let i=0;i<paths.length;i+=8) {
      results.push(...await Promise.all(paths.slice(i,i+8).map(async clip => {
        const response=await fetch('/'+clip.file);
        if(!response.ok)throw new Error('Missing '+clip.file);
        const buffer=await ctx.decodeAudioData(await response.arrayBuffer());
        const samples=buffer.getChannelData(0);
        let peak=0,sum=0;for(const sample of samples){peak=Math.max(peak,Math.abs(sample));sum+=sample*sample}
        const durationDelta=Math.abs(buffer.duration-clip.duration);
        if(durationDelta>.035||peak<.05||peak>1.02)throw new Error('Invalid speech '+clip.file+' '+JSON.stringify({peak,durationDelta}));
        return {file:clip.file,duration:buffer.duration,peak,rms:Math.sqrt(sum/samples.length)};
      })));
    }
    await ctx.close();return results;
  },Object.values(manifest.cues).flatMap(role=>Object.values(role).flat()));
  check('All bundled neural clips decode, duration matches, non-silent and no clipped peak',{count:decoded.length,roles:manifest.roles.length});
  const music=await page.evaluate(async()=>{
    const ctx=new AudioContext(),res=await fetch('/assets/audio/garden-table.ogg'),buffer=await ctx.decodeAudioData(await res.arrayBuffer());
    const result={duration:buffer.duration,channels:buffer.numberOfChannels,sampleRate:buffer.sampleRate};await ctx.close();return result;
  });
  if(music.duration<70||music.channels!==2)throw new Error('Music not complete');
  check('Original stereo soundtrack decodes',{music});
  await page.evaluate(()=>{
    const destination=__audio.ctx.createMediaStreamDestination();
    __audio.musicGain.connect(destination);__audio.voiceGain.connect(destination);__audio.effectsGain.connect(destination);
    window.__recorded=[];window.__recorder=new MediaRecorder(destination.stream,{mimeType:'audio/webm;codecs=opus'});
    __recorder.ondataavailable=e=>{if(e.data.size)__recorded.push(e.data)};__recorder.start();
    window.__queueStart=__sources.length;
    __audio.voice({kind:'pass',character:0,eventId:'queue-1'});
    __audio.voice({kind:'pass',character:0,eventId:'queue-1'});
    __audio.voice({kind:'pass',character:0,eventId:'queue-2'});
    __audio.voice({kind:'pass',character:0,eventId:'queue-3'});
  });
  await page.waitForFunction(()=>!__audio.playingVoice&&__audio.queue.length===0,{},{timeout:12000});
  const queue = await page.evaluate(()=>__sources.slice(__queueStart).filter(s=>!s.loop));
  if(queue.length!==3)throw new Error('Expected three unique queued voices, got '+queue.length);
  for(let i=1;i<queue.length;i++)if(queue[i].at+0.01<queue[i-1].at+queue[i-1].duration)throw new Error('Queued voices overlap');
  if(queue.some(s=>s.stop!==null))throw new Error('Normal cue interrupted another voice');
  check('Three pass variants play sequentially; duplicate event ID plays once',{queue});
  await page.evaluate(()=>{window.__resetStart=__sources.length;__audio.voice({kind:'bid',score:3,character:4,eventId:'stale'});__audio.resetVoices();});
  await page.waitForTimeout(300);
  if(await page.evaluate(()=>__sources.slice(__resetStart).some(s=>!s.loop)))throw new Error('Stale async speech played after reset');
  check('Leaving/reset while clip loads does not play old speech',{});
  await page.evaluate(()=>__audio.voice({kind:'bid',score:3,character:3,eventId:'bid-fresh'}));
  await page.waitForFunction(()=>__audio.playingVoice&&__audio.currentVoice);
  await page.waitForTimeout(180);
  const duck=await page.evaluate(()=>__audio.musicGain.gain.value);
  await page.waitForFunction(()=>!__audio.playingVoice&&__audio.queue.length===0);
  await page.waitForTimeout(500);
  const restored=await page.evaluate(()=>__audio.musicGain.gain.value);
  if(duck>=restored*.6)throw new Error('Music did not duck for speech');
  check('Dialogue ducks music and restores it smoothly',{during:duck,after:restored});
  const importResult=await page.evaluate(async()=>{
    const bytes=await(await fetch('/assets/audio/garden-table.ogg')).arrayBuffer();
    await __audio.importMusic(new File([bytes],'我的牌桌.ogg',{type:'audio/ogg'}));
    const name=__audio.importedMusicName;
    const errors=[];
    for(const file of [new File([new Uint8Array(4*1024*1024+1)],'oversize.mp3'),new File(['invalid-audio'],'broken.ogg')]){
      try{await __audio.importMusic(file)}catch(error){errors.push(error.message)}
    }
    await __audio.clearImportedMusic();
    return{name,errors,cleared:__audio.importedMusicName===''};
  });
  if(importResult.name!=='我的牌桌.ogg'||importResult.errors.length!==2||!importResult.cleared)throw new Error('Music import validation failed');
  check('Local audio import, bad/oversized file rejection, original restore',{importResult});
  const recording=await page.evaluate(async()=>{
    const stopped=new Promise(resolve=>__recorder.onstop=resolve);__recorder.stop();await stopped;
    const blob=new Blob(__recorded,{type:'audio/webm'}),bytes=new Uint8Array(await blob.arrayBuffer());
    let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(binary);
  });
  await writeFile(path.join(out,'audio-mix-preview.webm'),Buffer.from(recording,'base64'));
  if(failures.length||external.length)throw new Error('Unexpected browser error or external request');
  report.status='passed';report.recording='audio-mix-preview.webm';
  await writeFile(path.join(out,'decoded-clips.json'),JSON.stringify(decoded,null,2)+'\n');
} catch(error) { report.status='failed';report.error=String(error.stack??error);process.exitCode=1; }
finally {await writeFile(path.join(out,'browser-report.json'),JSON.stringify(report,null,2)+'\n');await browser.close();}
console.log(JSON.stringify(report,null,2));
