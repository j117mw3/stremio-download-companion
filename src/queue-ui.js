(() => {
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const mb=value=>(Number(value||0)/1048576).toFixed(1)+' MB/s';
 const fraction=job=>job.status==='done'?1:Math.min(.999,Math.max(0,Number(job.progress)||0));
 const percentage=job=>job.status==='done'?'100%':(fraction(job)*100).toFixed(1)+'%';
 let groups=[],dragging=false,grabOffset=0;
 const nav=document.createElement('nav');nav.id='seriesNavigator';nav.setAttribute('aria-label','Series progress and queue navigation');
 nav.innerHTML='<button type="button" class="nav-top">Show selection ↑</button><div class="nav-caption">Series in your queue</div><div id="seriesTrack"></div><p class="nav-hint">Click a series to jump · drag the marker to scroll</p>';
 document.body.append(nav);
 nav.querySelector('.nav-top').onclick=()=>window.scrollTo({top:0,behavior:'smooth'});
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
 marker.onpointerdown=e=>{dragging=true;grabOffset=e.clientY-marker.getBoundingClientRect().top;marker.setPointerCapture(e.pointerId);e.preventDefault();};
 marker.onpointermove=e=>{if(dragging)seek(e.clientY);};
 marker.onpointerup=marker.onpointercancel=()=>{dragging=false;};
 marker.onkeydown=e=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(e.key)){e.preventDefault();if(e.key==='Home')document.getElementById('t').scrollIntoView();else if(e.key==='End')window.scrollTo(0,document.body.scrollHeight);else window.scrollBy(0,(e.key.endsWith('Down')?1:-1)*(e.key.startsWith('Page')?innerHeight*.8:80));position();}};
 window.addEventListener('scroll',position,{passive:true});window.addEventListener('resize',position);
 window.renderQueue=jobs=>{
  if(dragging)return;
  const panel=document.getElementById('t');
  const visible=[...panel.querySelectorAll('tr[data-job-id]')].find(row=>row.getBoundingClientRect().bottom>0);
  const anchor=visible&&{id:visible.dataset.jobId,top:visible.getBoundingClientRect().top};
  const map=new Map();
  for(const job of jobs){const key=JSON.stringify([job.kind,job.series||job.seriesName]);if(!map.has(key))map.set(key,{name:job.seriesName,jobs:[]});map.get(key).jobs.push(job);}
  groups=[...map.values()].map((g,i)=>({...g,anchor:'queue-series-'+i,progress:g.jobs.reduce((sum,j)=>sum+fraction(j),0)/g.jobs.length}));
  document.documentElement.classList.toggle('has-series-nav',!!groups.length);
  nav.hidden=!groups.length;
  panel.innerHTML=jobs.length?'<div class="queue-header"><strong>'+jobs.length+' episode'+(jobs.length===1?'':'s')+' queued</strong><button type="button" data-clear-queue>Remove all</button></div><table><thead><tr><th>Episode</th><th>Status</th><th>Progress</th><th>Quality</th><th>Release / note</th></tr></thead>'+groups.map(g=>'<tbody id="'+g.anchor+'"><tr class="series-heading"><th colspan="5">'+esc(g.name)+' <span>'+Math.floor(g.progress*1000)/10+'% · '+g.jobs.filter(j=>j.status==='done').length+' / '+g.jobs.length+' queued episodes complete</span></th></tr>'+g.jobs.map(j=>{
   const label=j.status==='needs_attention'?'Needs attention':j.status==='retry_wait'?'Retry scheduled':j.status;
   const pct=percentage(j);
   return '<tr data-job-id="'+esc(j.id)+'"><td>'+esc(j.seriesName)+' S'+String(j.season).padStart(2,'0')+'E'+String(j.episode).padStart(2,'0')+'</td><td class="'+esc(j.status)+'">'+esc(label)+(j.status==='downloading'?' · '+mb(j.speed)+' | 30s '+mb(j.rollingSpeed):'')+(j.isProbe?'<p class="probe-label">Trying another episode</p>':'')+'</td><td><div class="download-progress"><div class="bar" role="progressbar" aria-label="'+esc(j.seriesName)+' episode '+j.episode+'" aria-valuemin="0" aria-valuemax="100" aria-valuenow="'+(fraction(j)*100).toFixed(1)+'"><i style="width:'+fraction(j)*100+'%"></i></div><span class="progress-number">'+pct+'</span></div></td><td>'+esc(j.quality||'')+(j.dub?' dub':'')+'</td><td class="'+(j.error?'failed':'')+'">'+esc(j.error||j.release||'')+(j.sourceProviders?.length?'<p>Stremio add-on: '+esc(j.sourceProviders.join(', '))+'</p>':'')+(j.comparison?'<p class="probe-label">Checking for a faster source / Testing alternative sources / 30s rate '+mb(j.comparison.primaryRate??j.rollingSpeed)+' � '+j.comparison.candidates.length+' tested</p>'+j.comparison.candidates.map((candidate,i)=>'<p>Candidate '+(i+1)+': '+(candidate.bytes/1048576).toFixed(1)+' MiB received � '+(candidate.verifiedBytes/1048576).toFixed(1)+' MiB verified / '+mb(candidate.rate??candidate.score)+'</p>').join(''):'')+(j.switchNote?'<p>'+esc(j.switchNote)+'</p>':'')+'<p>'+esc(j.stage||'')+(j.idleSeconds>=1&&j.status==='downloading'?' · '+j.idleSeconds+'s without episode data':'')+' · '+(j.peers||0)+' peers</p>'+(j.nextRetryAt?'<p>Next retry: '+esc(new Date(j.nextRetryAt).toLocaleString())+'</p>':'')+(j.status==='downloading'&&j.torrentSpeed?'<p>Shared torrent traffic: '+mb(j.torrentSpeed)+'</p>':'')+'<p>'+esc(j.verification?.audio||'')+'</p><p>'+esc(j.status==='done'?'':j.attempts?.at(-1)?'Previous '+j.attempts.at(-1).source+': '+j.attempts.at(-1).error:'')+'</p><div class="queue-actions">'+['pause','resume','cancel','retry','sources'].map(action=>'<button data-id="'+esc(encodeURIComponent(j.id))+'" data-action="'+action+'">'+action+'</button>').join('')+'<button data-id="'+esc(encodeURIComponent(j.id))+'" data-action="remove"'+(j.canRemove?'':' disabled title="Cancel and wait for this job to stop first"')+'>remove</button></div></td></tr>';
  }).join('')+'</tbody>').join('')+'</table>':'Nothing queued yet.';
  if(anchor){const row=[...panel.querySelectorAll('[data-job-id]')].find(r=>r.dataset.jobId===anchor.id);if(row&&anchor.top<innerHeight)window.scrollBy(0,row.getBoundingClientRect().top-anchor.top);}
  const railScroll=track.scrollTop;
  track.replaceChildren();
  for(const group of groups){
   const button=document.createElement('button');button.type='button';button.dataset.seriesJump=group.anchor;button.className='series-segment';
   const percent=Math.floor(group.progress*1000)/10;
   button.title=group.name+' — '+percent+'% of queued episodes; '+group.jobs.length+' episodes in queue';
   button.style.flexGrow=String(document.getElementById(group.anchor).getBoundingClientRect().height);
   button.innerHTML='<span class="segment-fill" style="height:'+percent+'%"></span><span class="segment-name">'+esc(group.name)+'</span><span class="segment-percent">'+percent+'%</span>';
   button.onclick=()=>document.getElementById(group.anchor).scrollIntoView({behavior:'smooth',block:'start'});track.append(button);
  }
  track.append(marker);track.scrollTop=railScroll;position();
 };
})();
