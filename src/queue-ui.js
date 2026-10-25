(() => {
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const mb=value=>(Number(value||0)/1048576).toFixed(1)+' MB/s';
 const fraction=job=>job.status==='done'?1:Math.min(.999,Math.max(0,Number(job.progress)||0));
 const percentage=job=>job.status==='done'?'100%':(fraction(job)*100).toFixed(1)+'%';
 let groups=[],dragging=false,grabOffset=0,latestJobs=[],navigation=null,navigationFrame=0,navigationGeneration=0,activeJobId=null;
 const nav=document.createElement('nav');nav.id='seriesNavigator';nav.setAttribute('aria-label','Series progress and queue navigation');
 nav.innerHTML='<button type="button" class="nav-top">Show selection ↑</button><button type="button" class="nav-active" disabled>Find active download</button><p id="activeDownloadStatus" class="nav-active-status" role="status" aria-live="polite">No active downloads</p><div class="nav-caption">Series in your queue</div><div id="seriesTrack"></div><p class="nav-hint">Click a series to jump · drag the marker to scroll</p>';
 document.body.append(nav);
 const activeButton=nav.querySelector('.nav-active'),activeStatus=nav.querySelector('.nav-active-status');
 const jobRowId=id=>'queue-job-'+encodeURIComponent(String(id));
 const targetScrollTop=element=>Math.max(0,Math.min(element.getBoundingClientRect().top+window.scrollY,document.documentElement.scrollHeight-innerHeight));
 function updateActiveControl(){
  const active=latestJobs.filter(job=>job.status==='downloading'),index=active.findIndex(job=>job.id===activeJobId);
  activeButton.disabled=!active.length;
  if(!active.length){activeJobId=null;activeStatus.textContent='No active downloads';return;}
  if(index<0){activeJobId=null;activeStatus.textContent=active.length+' active download'+(active.length===1?'':'s')+' · press to find';return;}
  const job=active[index];activeStatus.textContent='Active download '+(index+1)+' of '+active.length+': '+job.seriesName+' S'+String(job.season).padStart(2,'0')+'E'+String(job.episode).padStart(2,'0');
 }
 function renderQueueNow(jobs,alignTargetId=null){
  const panel=document.getElementById('t');
  const visible=alignTargetId?null:[...panel.querySelectorAll('tr[data-job-id]')].find(row=>row.getBoundingClientRect().bottom>0);
  const anchor=visible&&{id:visible.dataset.jobId,top:visible.getBoundingClientRect().top};
  const map=new Map();
  for(const job of jobs){const key=JSON.stringify([job.kind,job.series||job.seriesName]);if(!map.has(key))map.set(key,{name:job.seriesName,jobs:[]});map.get(key).jobs.push(job);}
  groups=[...map.values()].map((g,i)=>({...g,anchor:'queue-series-'+i,heading:'queue-series-'+i+'-heading',progress:g.jobs.reduce((sum,j)=>sum+fraction(j),0)/g.jobs.length}));
  document.documentElement.classList.toggle('has-series-nav',!!groups.length);
  nav.hidden=!groups.length;
  panel.innerHTML=jobs.length?'<div class="queue-header"><strong>'+jobs.length+' episode'+(jobs.length===1?'':'s')+' queued</strong><button type="button" data-clear-queue>Remove all</button></div><table><thead><tr><th>Episode</th><th>Status</th><th>Progress</th><th>Quality</th><th>Release / note</th></tr></thead>'+groups.map(g=>'<tbody id="'+g.anchor+'"><tr id="'+g.heading+'" class="series-heading"><th colspan="5">'+esc(g.name)+' <span>'+Math.floor(g.progress*1000)/10+'% · '+g.jobs.filter(j=>j.status==='done').length+' / '+g.jobs.length+' queued episodes complete</span></th></tr>'+g.jobs.map(j=>{
   const label=j.status==='needs_attention'?'Needs attention':j.status==='retry_wait'?'Retry scheduled':j.status==='deferred'?'Deferred retry':j.status;
   const pct=percentage(j);
   const active=['resolving','downloading'].includes(j.status);
   const waitSeconds=j.sourceWaitElapsedSeconds??(j.sourceWaitStartedAt?Math.floor((Date.now()-j.sourceWaitStartedAt)/1000):null);
   const waitInfo=active&&waitSeconds!==null?'<p>Source wait: '+waitSeconds+'s / '+(j.waitLimitSeconds||45)+'s'+(j.metadataWaitElapsedSeconds!==null&&j.metadataWaitElapsedSeconds!==undefined?' · metadata '+j.metadataWaitElapsedSeconds+'s / 15s':'')+'</p>':'';
   const search=j.sourceSearch&&!['complete','transferring'].includes(j.sourceSearch.phase)?'<p class="probe-label">Source search: '+(j.sourceSearch.attempted||0)+'/'+(j.sourceSearch.maxSources||5)+' releases · '+(j.sourceSearch.elapsedSeconds||0)+'/'+(j.sourceSearch.limitSeconds||60)+'s'+(j.sourceSearch.phase==='searching'?' · '+(j.sourceSearch.secondsRemaining||0)+'s left':' · '+esc(j.sourceSearch.phase.replaceAll('_',' ')))+'</p>':'';
   const lookup=j.sourceDiscovery&&(j.sourceDiscovery.providerCount||j.sourceDiscovery.suppressedCount)?'<p class="probe-label">Add-on lookup: '+(j.sourceDiscovery.completed||0)+'/'+(j.sourceDiscovery.providerCount||0)+' responses · '+(j.sourceDiscovery.responsive||0)+' responsive · '+(j.sourceDiscovery.empty||0)+' empty · '+(j.sourceDiscovery.timeouts||0)+' timed out · '+(j.sourceDiscovery.errors||0)+' errors · '+(j.sourceDiscovery.suppressedCount||0)+' cooling down · '+(j.sourceDiscovery.releases||0)+' releases</p>':'';
   const comparison=j.comparison?'<p class="probe-label">Checking for a faster source / Testing alternative sources · '+(j.comparison.elapsedSeconds||0)+' / '+(j.comparison.limitSeconds||30)+'s · current '+mb(j.comparison.primaryRate??j.rollingSpeed)+'</p>'+j.comparison.candidates.map((candidate,i)=>'<p>Alternative '+(i+1)+': '+(candidate.bytes/1048576).toFixed(1)+' MiB received (16 MiB limit) · '+(candidate.verifiedBytes/1048576).toFixed(1)+' MiB verified · '+mb(candidate.rate??candidate.score)+' · '+(candidate.elapsedSeconds||0)+' / 30s'+(candidate.reasonCode?' · '+esc(candidate.reasonCode.replaceAll('_',' ')):'')+'</p>').join(''):'';
   return '<tr id="'+esc(jobRowId(j.id))+'" data-job-id="'+esc(j.id)+'">'
    +'<td>'+esc(j.seriesName)+' S'+String(j.season).padStart(2,'0')+'E'+String(j.episode).padStart(2,'0')+'</td>'
    +'<td class="'+esc(j.status)+'">'+esc(label)+(j.status==='downloading'?' · '+mb(j.speed)+' | 30s '+mb(j.rollingSpeed):'')+(j.isProbe?'<p class="probe-label">Trying another episode</p>':'')+'</td>'
    +'<td><div class="download-progress"><div class="bar" role="progressbar" aria-label="'+esc(j.seriesName)+' episode '+j.episode+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+(fraction(j)*100).toFixed(1)+'"><i style="width:'+fraction(j)*100+'%"></i></div><span class="progress-number">'+pct+'</span></div></td>'
    +'<td>'+esc(j.quality||'')+(j.dub?' dub':'')+'</td>'
    +'<td class="'+(j.error?'failed':'')+'">'+esc(j.error||j.release||'')+(j.sourceProviders?.length?'<p>Stremio add-on: '+esc(j.sourceProviders.join(', '))+'</p>':'')+lookup+search+comparison+(j.fallbackReason?'<p>Fallback: '+esc(j.fallbackReason)+'</p>':'')+(j.switchNote?'<p>'+esc(j.switchNote)+'</p>':'')+'<p>'+esc(j.stage||'')+(j.idleSeconds>=1&&j.status==='downloading'?' · '+j.idleSeconds+'s without episode data':'')+' · '+(j.peers||0)+' peers</p>'+waitInfo+(j.nextRetryAt?'<p>'+(j.status==='deferred'?'Deferred retry after ready work: ':'Next retry: ')+esc(new Date(j.nextRetryAt).toLocaleString())+'</p>':'')+(j.status==='downloading'&&j.torrentSpeed?'<p>Shared torrent traffic: '+mb(j.torrentSpeed)+'</p>':'')+'<p>'+esc(j.verification?.audio||'')+'</p><p>'+esc(j.status==='done'?'':j.attempts?.at(-1)?'Previous '+j.attempts.at(-1).source+': '+j.attempts.at(-1).error:'')+'</p><div class="queue-actions">'+['pause','resume','cancel','retry','sources'].map(action=>'<button data-id="'+esc(encodeURIComponent(j.id))+'" data-action="'+action+'">'+action+'</button>').join('')+'<button data-id="'+esc(encodeURIComponent(j.id))+'" data-action="remove"'+(j.canRemove?'':' disabled title="Cancel and wait for this job to stop first"')+'>remove</button></div></td></tr>';
  }).join('')+'</tbody>').join('')+'</table>':'Nothing queued yet.';
  if(alignTargetId){const target=document.getElementById(alignTargetId);if(target)window.scrollTo({top:targetScrollTop(target),behavior:'auto'});}
  else if(anchor){const row=[...panel.querySelectorAll('[data-job-id]')].find(r=>r.dataset.jobId===anchor.id);if(row&&anchor.top<innerHeight)window.scrollBy(0,row.getBoundingClientRect().top-anchor.top);}
  const railScroll=track.scrollTop;
  track.replaceChildren();
  for(const group of groups){
   const button=document.createElement('button');button.type='button';button.dataset.seriesJump=group.anchor;button.className='series-segment';
   const percent=Math.floor(group.progress*1000)/10;
   button.title=group.name+' — '+percent+'% of queued episodes; '+group.jobs.length+' episodes in queue';
   button.style.flexGrow=String(document.getElementById(group.anchor).getBoundingClientRect().height);
   button.innerHTML='<span class="segment-fill" style="height:'+percent+'%"></span><span class="segment-name">'+esc(group.name)+'</span><span class="segment-percent">'+percent+'%</span>';
   button.onclick=()=>startNavigation(group.heading);track.append(button);
  }
  track.append(marker);track.scrollTop=railScroll;updateActiveControl();position();
 }
 function finishNavigation(generation){
  if(!navigation||navigation.generation!==generation)return;
  const targetId=navigation.targetId;
  navigation=null;navigationFrame=0;
  renderQueueNow(latestJobs,targetId);
 }
 function startNavigation(targetId){
  const target=document.getElementById(targetId);if(!target)return;
  if(navigationFrame)cancelAnimationFrame(navigationFrame);
  const generation=++navigationGeneration;
  navigation={targetId,startedAt:performance.now(),generation};
  window.scrollTo({top:targetScrollTop(target),behavior:'smooth'});
  const check=()=>{
   if(!navigation||navigation.generation!==generation)return;
   const current=document.getElementById(targetId);
   if(!current||Math.abs(window.scrollY-targetScrollTop(current))<=1||performance.now()-navigation.startedAt>=5000){finishNavigation(generation);return;}
   navigationFrame=requestAnimationFrame(check);
  };
  navigationFrame=requestAnimationFrame(check);
 }
 function cancelNavigation(repaint=true){
  if(!navigation)return;
  if(navigationFrame)cancelAnimationFrame(navigationFrame);
  navigationFrame=0;navigation=null;navigationGeneration++;
  window.scrollTo({top:window.scrollY,behavior:'auto'});
  if(repaint)renderQueueNow(latestJobs);
 }
 nav.querySelector('.nav-top').onclick=()=>startNavigation('pageTop');
 activeButton.onclick=()=>{
  const active=latestJobs.filter(job=>job.status==='downloading');if(!active.length){updateActiveControl();return;}
  const index=active.findIndex(job=>job.id===activeJobId);
  const next=index>=0?active[(index+1)%active.length]:active.find(job=>{const row=document.getElementById(jobRowId(job.id));return row&&row.getBoundingClientRect().bottom>0;})||active[0];
  activeJobId=next.id;updateActiveControl();startNavigation(jobRowId(next.id));
 };
 const track=nav.querySelector('#seriesTrack');
 const marker=document.createElement('div');marker.className='queue-position';marker.tabIndex=0;marker.setAttribute('role','slider');marker.setAttribute('aria-label','Queue scroll position');marker.setAttribute('aria-valuemin','0');marker.setAttribute('aria-valuemax','100');
 function position(){
  if(!groups.length)return;
  const bounds=document.getElementById('t').getBoundingClientRect(),top=bounds.top+window.scrollY;
  const height=Math.max(1,bounds.height),visible=Math.min(1,innerHeight/height);
  const ratio=Math.max(0,Math.min(1,(scrollY-top)/Math.max(1,height-innerHeight)));
  const extent=track.scrollHeight;
  marker.style.height=Math.max(20,visible*extent)+'px';
  marker.style.top=(ratio*Math.max(0,extent-Math.max(20,visible*extent)))+'px';
  marker.setAttribute('aria-valuenow',String(Math.round(ratio*100)));
  const current=ratio>=.999?groups.at(-1):groups.find(g=>{const r=document.getElementById(g.anchor)?.getBoundingClientRect();return r&&r.bottom>innerHeight*.25;})||groups.at(-1);
  for(const button of track.querySelectorAll('[data-series-jump]'))button.setAttribute('aria-current',button.dataset.seriesJump===current.anchor?'location':'false');
 }
 function seek(y){
  const rect=track.getBoundingClientRect();
  const ratio=Math.max(0,Math.min(1,(y-rect.top+track.scrollTop-grabOffset)/Math.max(1,track.scrollHeight-marker.offsetHeight)));
  const bounds=document.getElementById('t').getBoundingClientRect();
  window.scrollTo({top:bounds.top+scrollY+ratio*Math.max(0,bounds.height-innerHeight)});position();
 }
 marker.onpointerdown=e=>{cancelNavigation(false);dragging=true;grabOffset=e.clientY-marker.getBoundingClientRect().top;marker.setPointerCapture(e.pointerId);e.preventDefault();};
 marker.onpointermove=e=>{if(dragging)seek(e.clientY);};
 marker.onpointerup=marker.onpointercancel=()=>{dragging=false;renderQueueNow(latestJobs);};
 marker.onkeydown=e=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(e.key)){e.preventDefault();cancelNavigation(false);if(e.key==='Home')document.getElementById('t').scrollIntoView();else if(e.key==='End')window.scrollTo(0,document.body.scrollHeight);else window.scrollBy(0,(e.key.endsWith('Down')?1:-1)*(e.key.startsWith('Page')?innerHeight*.8:80));position();}};
 window.addEventListener('scroll',position,{passive:true});window.addEventListener('resize',position);
 window.addEventListener('wheel',e=>{if(!navigation)return;if(nav.contains(e.target)&&!e.target.closest('.queue-position'))return;cancelNavigation(false);},{passive:true});
 window.addEventListener('touchstart',e=>{if(!navigation)return;if(nav.contains(e.target))return;cancelNavigation(false);},{passive:true});
 window.addEventListener('pointerdown',e=>{if(!navigation)return;const target=e.target instanceof Element?e.target:null;if(!target){cancelNavigation(false);return;}if(target.closest('.series-segment'))return;if(target.closest('.queue-position')){cancelNavigation(false);return;}if(!nav.contains(target))cancelNavigation(false);});
 window.addEventListener('keydown',e=>{if(!navigation||!['ArrowDown','ArrowUp','PageDown','PageUp','Home','End',' '].includes(e.key))return;const target=e.target instanceof Element?e.target:null;if(!target||nav.contains(target)||target.matches('input,textarea,select,[contenteditable="true"]'))return;cancelNavigation(false);});
 window.renderQueue=jobs=>{latestJobs=jobs;if(dragging||navigation)return;renderQueueNow(jobs);};
})();
