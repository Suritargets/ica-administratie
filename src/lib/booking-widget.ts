// Kalender + afspraakformulier voor de landingspagina (draait in de browser van de bezoeker).
// Bewust zonder template-interpolatie, zodat dit letterlijk als script wordt uitgeleverd.
export const BOOKING_CSS = `
.card + .card{margin-top:24px}
.card.book{padding-bottom:28px}
.book .sub{margin:-8px 0 20px;color:var(--mut)}
.bk{display:grid;grid-template-columns:minmax(280px,360px) 1fr;gap:28px}
@media(max-width:760px){.bk{grid-template-columns:1fr}}
.cal-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.cal-h b{font-size:17px;text-transform:capitalize;color:var(--navy)}
.cal-h button{width:36px;height:36px;border-radius:10px;border:1px solid #d5dbe8;background:#fff;cursor:pointer;font-size:18px;color:var(--navy)}
.cal-h button:disabled{opacity:.35;cursor:default}
.cal-g{display:grid;grid-template-columns:repeat(7,1fr);gap:5px}
.cal-g .dn{font-size:11.5px;text-align:center;color:var(--mut);font-weight:600;padding:4px 0;text-transform:uppercase}
.cal-g button,.cal-g span.x{height:42px;border-radius:10px;border:1px solid transparent;font:inherit;font-size:15px;background:none}
.cal-g span.x{color:#b9c1d3;display:grid;place-items:center}
.cal-g button{cursor:pointer;background:#eef3fb;color:var(--navy);font-weight:600}
.cal-g button:hover{border-color:var(--accent)}
.cal-g button.sel{background:var(--navy);color:#fff}
.cal-g button.today{box-shadow:inset 0 0 0 2px var(--accent)}
.cal-g .e{visibility:hidden}
.legend{font-size:12.5px;color:var(--mut);margin-top:10px}
.pick h3{margin:0 0 10px;font-size:16px;color:var(--navy)}
.times{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}
.times button{padding:9px 16px;border-radius:10px;border:1.5px solid #cbd5e8;background:#fff;font:inherit;font-weight:600;cursor:pointer;color:var(--navy)}
.times button:hover{border-color:var(--accent)}.times button.sel{background:var(--accent);border-color:var(--accent);color:#fff}
.hint{color:var(--mut);font-size:14.5px}
.bf{display:grid;gap:12px}
.bf label{font-size:13px;font-weight:600;display:block}
.bf input,.bf textarea{display:block;width:100%;margin-top:4px;padding:10px 12px;border:1px solid #cfd6e4;border-radius:9px;font:inherit;font-weight:400}
.bf input:focus,.bf textarea:focus{outline:2px solid var(--accent);border-color:var(--accent)}
.bf .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:560px){.bf .two{grid-template-columns:1fr}}
.bf .hp{position:absolute;left:-9999px;height:0;overflow:hidden}
.bf button.go{padding:12px 20px;border:0;border-radius:10px;background:var(--navy);color:#fff;font:600 15px inherit;cursor:pointer}
.bf button.go:disabled{opacity:.6;cursor:wait}
.err{color:#b42318;font-size:14px;min-height:20px}
.ok{background:#ecfdf3;border:1px solid #a6e4c1;color:#05603a;border-radius:12px;padding:18px 20px}
.ok b{display:block;font-size:17px;margin-bottom:4px}
`;

export const BOOKING_JS = `
(function(){
var root=document.getElementById('book');if(!root)return;
var MN=['januari','februari','maart','april','mei','juni','juli','augustus','september','oktober','november','december'];
var DN=['ma','di','wo','do','vr','za','zo'];
var pb=new Date(Date.now()-3*3600*1000);
var todayStr=pb.getUTCFullYear()+'-'+p2(pb.getUTCMonth()+1)+'-'+p2(pb.getUTCDate());
var st={y:pb.getUTCFullYear(),m:pb.getUTCMonth(),days:{},date:null,time:null,times:null};
var calEl=root.querySelector('#cal'),pickEl=root.querySelector('#pick');
function p2(n){return n<10?'0'+n:''+n}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function nice(d){var x=new Date(d+'T00:00:00Z');var w=['zondag','maandag','dinsdag','woensdag','donderdag','vrijdag','zaterdag'][x.getUTCDay()];return w+' '+x.getUTCDate()+' '+MN[x.getUTCMonth()]+' '+x.getUTCFullYear()}
function getJ(u){return fetch(u,{cache:'no-store'}).then(function(r){return r.json()})}
function loadMonth(){
  calEl.innerHTML='<div class="hint">Kalender laden…</div>';
  getJ('/api/book?month='+st.y+'-'+p2(st.m+1)).then(function(j){
    if(j.enabled===false){root.style.display='none';return}
    st.days=j.days||{};drawCal();
  }).catch(function(){calEl.innerHTML='<div class="err">Kalender kon niet geladen worden. Ververs de pagina.</div>'});
}
function drawCal(){
  var first=new Date(Date.UTC(st.y,st.m,1)),lead=(first.getUTCDay()+6)%7,dim=new Date(Date.UTC(st.y,st.m+1,0)).getUTCDate();
  var h='<div class="cal-h"><button type="button" id="pm" aria-label="Vorige maand"'+((st.y+'-'+p2(st.m+1))<=todayStr.slice(0,7)?' disabled':'')+'>‹</button><b>'+MN[st.m]+' '+st.y+'</b><button type="button" id="nm" aria-label="Volgende maand">›</button></div><div class="cal-g">';
  DN.forEach(function(d){h+='<div class="dn">'+d+'</div>'});
  for(var i=0;i<lead;i++)h+='<span class="e"></span>';
  for(var d=1;d<=dim;d++){
    var key=st.y+'-'+p2(st.m+1)+'-'+p2(d),free=st.days[key];
    if(free>0)h+='<button type="button" data-d="'+key+'" class="'+(key===st.date?'sel ':'')+(key===todayStr?'today':'')+'">'+d+'</button>';
    else h+='<span class="x">'+d+'</span>';
  }
  h+='</div><div class="legend">Dagen in kleur zijn beschikbaar. Tijden zijn Surinaamse tijd.</div>';
  calEl.innerHTML=h;
  calEl.querySelector('#pm').onclick=function(){st.m--;if(st.m<0){st.m=11;st.y--}loadMonth()};
  calEl.querySelector('#nm').onclick=function(){st.m++;if(st.m>11){st.m=0;st.y++}loadMonth()};
  Array.prototype.forEach.call(calEl.querySelectorAll('[data-d]'),function(b){b.onclick=function(){pickDay(b.getAttribute('data-d'))}});
}
function pickDay(d){
  st.date=d;st.time=null;st.times=null;drawCal();
  pickEl.innerHTML='<h3>'+esc(nice(d))+'</h3><div class="hint">Tijden laden…</div>';
  getJ('/api/book?date='+d).then(function(j){st.times=j.times||[];drawPick()}).catch(function(){pickEl.innerHTML='<div class="err">Tijden konden niet geladen worden.</div>'});
}
function drawPick(){
  var h='<h3>'+esc(nice(st.date))+'</h3>';
  if(!st.times.length){pickEl.innerHTML=h+'<div class="hint">Er zijn geen tijden meer vrij op deze dag. Kies een andere dag.</div>';return}
  h+='<div class="times">'+st.times.map(function(t){return'<button type="button" data-t="'+t+'" class="'+(t===st.time?'sel':'')+'">'+t+'</button>'}).join('')+'</div>';
  if(st.time){
    h+='<form class="bf" id="bf" novalidate><div class="two"><label>Naam *<input name="name" required maxlength="100" autocomplete="name"></label><label>E-mailadres *<input name="email" type="email" required maxlength="150" autocomplete="email"></label></div>'
     +'<div class="two"><label>Telefoon<input name="phone" type="tel" maxlength="30" autocomplete="tel"></label><label>Onderwerp<input name="subject" maxlength="120" placeholder="Bijv. administratie, visum, bedrijf starten"></label></div>'
     +'<label>Bericht (optioneel)<textarea name="message" rows="3" maxlength="1000"></textarea></label>'
     +'<div class="hp" aria-hidden="true"><label>Laat leeg<input name="company_site" tabindex="-1" autocomplete="off"></label></div>'
     +'<div class="err" id="be" role="alert"></div><button class="go" id="bgo">Afspraak aanvragen voor '+st.time+'</button></form>';
  }else h+='<div class="hint">Kies een tijd om door te gaan.</div>';
  pickEl.innerHTML=h;
  Array.prototype.forEach.call(pickEl.querySelectorAll('[data-t]'),function(b){b.onclick=function(){st.time=b.getAttribute('data-t');drawPick();var f=pickEl.querySelector('input[name=name]');if(f)f.focus()}});
  var f=pickEl.querySelector('#bf');if(f)f.onsubmit=submit;
}
function submit(e){
  e.preventDefault();var f=e.target,err=pickEl.querySelector('#be'),btn=pickEl.querySelector('#bgo');err.textContent='';
  if(!f.name.value.trim()){err.textContent='Vul je naam in.';return}
  if(!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(f.email.value.trim())){err.textContent='Vul een geldig e-mailadres in.';return}
  btn.disabled=true;btn.textContent='Bezig…';
  fetch('/api/book',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({date:st.date,time:st.time,name:f.name.value,email:f.email.value,phone:f.phone.value,subject:f.subject.value,message:f.message.value,company_site:f.company_site.value})})
  .then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
  .then(function(x){
    if(x.ok){root.querySelector('.bk').innerHTML='<div class="ok" style="grid-column:1/-1"><b>Bedankt, je aanvraag is ontvangen ✓</b>'+esc(nice(st.date))+' om '+esc(st.time)+' (Surinaamse tijd).<br>We nemen contact met je op via '+esc(f.email.value.trim())+' om de afspraak te bevestigen.</div>';return}
    err.textContent=x.j.error||'Aanvragen mislukt.';btn.disabled=false;btn.textContent='Afspraak aanvragen voor '+st.time;
    if(/bezet|beschikbaar/.test(x.j.error||'')){pickDay(st.date);loadMonth()}
  }).catch(function(){err.textContent='Geen verbinding. Probeer het opnieuw.';btn.disabled=false;btn.textContent='Afspraak aanvragen voor '+st.time});
}
loadMonth();
})();
`;
